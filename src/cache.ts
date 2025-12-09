import { CacheOptions, CacheStats, PendingWrite, DEFAULT_OPTIONS } from "./types.js";
import { MemoryStore } from "./memory-store.js";
import { FileStore } from "./file-store.js";
import { isExpired, compilePattern, matchPattern, CompiledPattern } from "./utils.js";

/**
 * FsLruCache - An LRU cache with file system persistence.
 *
 * Features:
 * - Two-tier storage: hot items in memory, all items on disk
 * - Memory-first reads for fast access to frequently used data
 * - Async writes by default (memory updated immediately, disk in background)
 * - LRU eviction in both memory and disk stores
 * - TTL support with lazy expiration
 * - Stampede protection for concurrent operations
 */
export class FsLruCache {
  private readonly memory: MemoryStore;
  private readonly files: FileStore;
  private readonly maxMemorySize: number;
  private readonly defaultTtl?: number;
  private readonly namespace?: string;
  private readonly syncWrites: boolean;
  private hits = 0;
  private misses = 0;
  private closed = false;

  // In-flight operations for stampede protection
  private inFlight = new Map<string, Promise<unknown>>();

  /**
   * Pending async disk writes per key.
   * This is the primary source of truth for "intended state" during async writes.
   * Contains the serialized value so reads can return it before disk write completes.
   * Writes are chained: new writes wait for prior writes to the same key.
   */
  private pendingWrites = new Map<string, PendingWrite>();

  // Background prune interval
  private pruneTimer?: ReturnType<typeof setInterval>;

  // Debounced touch timers for file store LRU updates
  private touchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingTouches = new Set<Promise<void>>();
  private readonly touchDebounceMs = 5000;

  constructor(options: CacheOptions = {}) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    this.maxMemorySize = opts.maxMemorySize;
    this.defaultTtl = opts.defaultTtl;
    this.namespace = opts.namespace;
    this.syncWrites = opts.syncWrites;

    this.memory = new MemoryStore({
      maxItems: opts.maxMemoryItems,
      maxSize: opts.maxMemorySize,
    });

    this.files = new FileStore({
      dir: opts.dir,
      shards: opts.shards,
      maxSize: opts.maxDiskSize,
      gzip: opts.gzip,
      // Keep memory in sync: when disk evicts a key, remove from memory too.
      // This ensures memory is always a subset of disk (source of truth).
      onEvict: (key) => {
        this.memory.delete(key);
        this.cancelDebouncedTouch(key);
      },
    });

    // Start background pruning if configured
    if (opts.pruneInterval && opts.pruneInterval > 0) {
      this.pruneTimer = setInterval(() => {
        this.prune().catch(() => {});
      }, opts.pruneInterval);
      // Don't keep the process alive just for pruning
      this.pruneTimer.unref();
    }
  }

  /**
   * Prefix a key with the namespace if configured.
   */
  private prefixKey(key: string): string {
    return this.namespace ? `${this.namespace}:${key}` : key;
  }

  /**
   * Remove the namespace prefix from a key.
   */
  private unprefixKey(key: string): string {
    if (this.namespace && key.startsWith(`${this.namespace}:`)) {
      return key.slice(this.namespace.length + 1);
    }
    return key;
  }

  /**
   * Resolve the TTL to use: explicit value, defaultTtl, or none.
   * - undefined: use defaultTtl if set
   * - 0: explicitly no TTL
   * - positive number: use that TTL (in seconds)
   * Returns milliseconds for internal use.
   */
  private resolveTtl(ttlSeconds?: number): number | undefined {
    if (ttlSeconds === undefined) {
      return this.defaultTtl ? this.defaultTtl * 1000 : undefined;
    }
    return ttlSeconds === 0 ? undefined : ttlSeconds * 1000;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("Cache is closed");
    }
  }

  /**
   * Schedule a debounced touch for the file store.
   * Coalesces frequent accesses to reduce disk I/O.
   */
  private debouncedFileTouch(key: string): void {
    if (this.touchTimers.has(key)) return;

    const timer = setTimeout(() => {
      this.touchTimers.delete(key);
      if (!this.closed) {
        this.executeTouch(key);
      }
    }, this.touchDebounceMs);

    timer.unref();
    this.touchTimers.set(key, timer);
  }

  /**
   * Execute a touch and track the promise for flush().
   */
  private executeTouch(key: string): void {
    const touchPromise: Promise<void> = this.files
      .touch(key)
      .then(() => {})
      .catch(() => {})
      .finally(() => {
        this.pendingTouches.delete(touchPromise);
      });
    this.pendingTouches.add(touchPromise);
  }

  /**
   * Cancel a pending debounced touch (used on delete/eviction).
   */
  private cancelDebouncedTouch(key: string): void {
    const timer = this.touchTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.touchTimers.delete(key);
    }
  }

  /**
   * Get a pending write if it exists and hasn't expired.
   * Returns null if no pending write or if it's expired.
   */
  private getValidPendingWrite(key: string): PendingWrite | null {
    const pending = this.pendingWrites.get(key);
    if (!pending) return null;
    if (isExpired(pending.expiresAt)) {
      // Don't delete here - let the write complete and clean up naturally
      return null;
    }
    return pending;
  }

  /**
   * Get all pending write keys matching a pattern.
   */
  private getPendingWriteKeys(compiled: CompiledPattern): string[] {
    const keys: string[] = [];
    for (const [key, pending] of this.pendingWrites) {
      if (!isExpired(pending.expiresAt) && matchPattern(key, compiled)) {
        keys.push(key);
      }
    }
    return keys;
  }

  /**
   * Execute an operation with stampede protection.
   * Concurrent calls for the same key will share the same promise.
   */
  private async withStampedeProtection<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const promise = operation();
    this.inFlight.set(key, promise);

    try {
      return await promise;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * Get a value from the cache.
   * Checks pending writes first, then memory, then disk.
   * This ensures read-after-write consistency even with async writes.
   */
  async get<T = unknown>(key: string): Promise<T | null> {
    this.assertOpen();
    const prefixedKey = this.prefixKey(key);

    // Check pending writes first (most recent intended state)
    const pending = this.getValidPendingWrite(prefixedKey);
    if (pending) {
      this.hits++;
      // Schedule debounced touch since this key will be on disk soon
      this.debouncedFileTouch(prefixedKey);
      return JSON.parse(pending.serialized) as T;
    }

    // Check memory (returns JSON string)
    const memSerialized = this.memory.get(prefixedKey);
    if (memSerialized !== null) {
      this.hits++;
      // Update file store LRU (debounced to reduce I/O)
      this.debouncedFileTouch(prefixedKey);
      return JSON.parse(memSerialized) as T;
    }

    // Check disk (file store updates its own LRU on get)
    const diskEntry = await this.files.get<T>(prefixedKey);
    if (diskEntry !== null) {
      this.hits++;
      // Promote to memory if it fits
      const serialized = JSON.stringify(diskEntry.value);
      if (Buffer.byteLength(serialized, "utf8") <= this.maxMemorySize) {
        this.memory.set(prefixedKey, serialized, diskEntry.expiresAt);
      }
      return diskEntry.value;
    }

    this.misses++;
    return null;
  }

  /**
   * Set a value in the cache.
   * @param key The cache key
   * @param value The value to store (must be JSON-serializable)
   * @param ttl Optional TTL in seconds (0 to explicitly disable defaultTtl)
   */
  async set(key: string, value: unknown, ttl?: number): Promise<void> {
    this.assertOpen();
    const prefixedKey = this.prefixKey(key);
    const resolvedTtl = this.resolveTtl(ttl);

    const expiresAt = resolvedTtl ? Date.now() + resolvedTtl : null;

    // Serialize value once, reuse for both memory and disk
    const valueSerialized = JSON.stringify(value);

    // Guard against non-JSON-serializable values (undefined, functions, symbols)
    // JSON.stringify returns undefined for these, which would produce invalid JSON
    if (valueSerialized === undefined) {
      throw new TypeError(
        `Cannot cache value of type ${typeof value}. Value must be JSON-serializable.`,
      );
    }

    const valueSize = Buffer.byteLength(valueSerialized, "utf8");

    // Build disk entry JSON using already-serialized value (avoids double serialization)
    const entrySerialized = `{"key":${JSON.stringify(prefixedKey)},"value":${valueSerialized},"expiresAt":${expiresAt}}`;

    // Write to memory if it fits (fast path for subsequent reads)
    if (valueSize <= this.maxMemorySize) {
      this.memory.set(prefixedKey, valueSerialized, expiresAt);
    }

    // Write to disk (async by default, sync if configured)
    if (this.syncWrites) {
      await this.files.set(prefixedKey, value, expiresAt, entrySerialized);
    } else {
      // Chain this write after any existing pending write for the same key.
      // This ensures sequential writes complete in order (no race conditions).
      const existingPending = this.pendingWrites.get(prefixedKey);
      const priorPromise = existingPending?.promise ?? Promise.resolve();

      // Create the chained disk write
      const diskWrite = priorPromise.then(() =>
        this.files.set(prefixedKey, value, expiresAt, entrySerialized),
      );

      // Create pending write entry with value metadata for immediate reads
      const pendingWrite: PendingWrite = {
        serialized: valueSerialized,
        expiresAt,
        size: valueSize,
        promise: diskWrite
          .catch(() => {
            // Evict from memory if disk write fails
            this.memory.delete(prefixedKey);
          })
          .then(() => {
            // Only delete if this is still the current pending write for this key
            if (this.pendingWrites.get(prefixedKey) === pendingWrite) {
              this.pendingWrites.delete(prefixedKey);
            }
          }),
      };

      this.pendingWrites.set(prefixedKey, pendingWrite);
    }
  }

  /**
   * Delete a key from the cache.
   */
  async del(key: string): Promise<boolean> {
    this.assertOpen();
    const prefixedKey = this.prefixKey(key);
    this.cancelDebouncedTouch(prefixedKey);

    // Check if key exists in pending writes (for return value)
    const pending = this.pendingWrites.get(prefixedKey);
    const hadPending = pending !== undefined && !isExpired(pending.expiresAt);

    // Cancel the pending write intent immediately.
    // This ensures get() returns null right away, even if disk write is in-flight.
    // The disk write will complete harmlessly (cleanup is identity-checked).
    this.pendingWrites.delete(prefixedKey);

    // Remove from memory immediately
    const memDeleted = this.memory.delete(prefixedKey);

    // Wait for any in-flight disk write to complete before deleting.
    // This ensures the file exists on disk before we try to delete it.
    if (pending) {
      await pending.promise;
    }

    const diskDeleted = await this.files.delete(prefixedKey);
    return hadPending || memDeleted || diskDeleted;
  }

  /**
   * Check if a key exists in the cache.
   * Checks pending writes first for consistency with async writes.
   */
  async exists(key: string): Promise<boolean> {
    this.assertOpen();
    const prefixedKey = this.prefixKey(key);

    // Check pending writes first (most recent intended state)
    if (this.getValidPendingWrite(prefixedKey)) {
      return true;
    }

    return this.memory.has(prefixedKey) || (await this.files.has(prefixedKey));
  }

  /**
   * Get all keys matching a pattern.
   * Includes keys with pending writes for consistency.
   * @param pattern Glob-like pattern (supports * wildcard)
   */
  async keys(pattern = "*"): Promise<string[]> {
    this.assertOpen();

    // Prefix the pattern for internal lookup
    const prefixedPattern = this.prefixKey(pattern);
    const compiled = compilePattern(prefixedPattern);

    // Get keys from all sources: pending writes, memory, disk
    const pendingKeys = this.getPendingWriteKeys(compiled);
    const [memKeys, diskKeys] = await Promise.all([
      Promise.resolve(this.memory.keys(prefixedPattern)),
      this.files.keys(prefixedPattern),
    ]);

    // Remove prefix from returned keys (deduplicated)
    const allKeys = [...new Set([...pendingKeys, ...memKeys, ...diskKeys])];
    return allKeys.map((k) => this.unprefixKey(k));
  }

  /**
   * Set expiration time in seconds.
   */
  async expire(key: string, seconds: number): Promise<boolean> {
    this.assertOpen();
    const prefixedKey = this.prefixKey(key);
    const expiresAt = Date.now() + seconds * 1000;

    // If there's a pending write, wait for it to complete first.
    // We can't modify expiry until the key exists on disk.
    const pending = this.pendingWrites.get(prefixedKey);
    if (pending) {
      await pending.promise;
    }

    // Disk first - if this fails, don't update memory (keeps them consistent)
    const diskSuccess = await this.files.setExpiry(prefixedKey, expiresAt);
    if (!diskSuccess) {
      return false;
    }

    // Memory second - best effort (memory is just a hot cache)
    this.memory.setExpiry(prefixedKey, expiresAt);
    return true;
  }

  /**
   * Remove the TTL from a key, making it persistent.
   * @returns true if TTL was removed, false if key doesn't exist
   */
  async persist(key: string): Promise<boolean> {
    this.assertOpen();
    const prefixedKey = this.prefixKey(key);

    // If there's a pending write, wait for it to complete first.
    // We can't modify expiry until the key exists on disk.
    const pending = this.pendingWrites.get(prefixedKey);
    if (pending) {
      await pending.promise;
    }

    // Disk first - if this fails, don't update memory (keeps them consistent)
    const diskSuccess = await this.files.setExpiry(prefixedKey, null);
    if (!diskSuccess) {
      return false;
    }

    // Memory second - best effort (memory is just a hot cache)
    this.memory.setExpiry(prefixedKey, null);
    return true;
  }

  /**
   * Touch a key: refresh its position in the LRU.
   * This is more efficient than get() when you don't need the value.
   * To update TTL, use expire() or pexpire() instead.
   * @param key The cache key
   * @returns true if key exists, false otherwise
   */
  async touch(key: string): Promise<boolean> {
    this.assertOpen();
    const prefixedKey = this.prefixKey(key);

    // Check pending writes first - key exists if there's a valid pending write
    const pending = this.getValidPendingWrite(prefixedKey);
    if (pending) {
      // Schedule debounced touch for when the write completes
      this.debouncedFileTouch(prefixedKey);
      this.memory.touch(prefixedKey);
      return true;
    }

    // Disk first - if this fails, key doesn't exist
    const diskSuccess = await this.files.touch(prefixedKey);
    if (!diskSuccess) {
      return false;
    }

    // Memory second - best effort (memory is just a hot cache)
    this.memory.touch(prefixedKey);
    return true;
  }

  /**
   * Get TTL in seconds.
   * Returns -1 if no expiry, -2 if key not found.
   * Checks pending writes first for consistency.
   */
  async ttl(key: string): Promise<number> {
    this.assertOpen();
    const prefixedKey = this.prefixKey(key);

    // Check pending writes first
    const pending = this.getValidPendingWrite(prefixedKey);
    if (pending) {
      if (pending.expiresAt === null) return -1;
      return Math.max(0, Math.ceil((pending.expiresAt - Date.now()) / 1000));
    }

    const memTtlMs = this.memory.getTtl(prefixedKey);
    if (memTtlMs !== -2) {
      return memTtlMs < 0 ? memTtlMs : Math.ceil(memTtlMs / 1000);
    }
    const fileTtlMs = await this.files.getTtl(prefixedKey);
    return fileTtlMs < 0 ? fileTtlMs : Math.ceil(fileTtlMs / 1000);
  }

  /**
   * Get multiple values at once.
   * Returns array in same order as keys (null for missing/expired).
   */
  async mget<T = unknown>(keys: string[]): Promise<(T | null)[]> {
    return Promise.all(keys.map((key) => this.get<T>(key)));
  }

  /**
   * Set multiple key-value pairs at once.
   * Optimized to batch serialization and disk writes.
   * @param entries Array of [key, value] or [key, value, ttl?] tuples (ttl in seconds)
   */
  async mset(entries: [string, unknown, number?][]): Promise<void> {
    this.assertOpen();
    if (entries.length === 0) return;

    // Phase 1: Prepare all entries (serialization)
    const prepared = entries.map(([key, value, ttl]) => {
      const prefixedKey = this.prefixKey(key);
      const resolvedTtl = this.resolveTtl(ttl);
      const expiresAt = resolvedTtl ? Date.now() + resolvedTtl : null;

      const valueSerialized = JSON.stringify(value);

      // Guard against non-JSON-serializable values
      if (valueSerialized === undefined) {
        throw new TypeError(
          `Cannot cache value of type ${typeof value} for key "${key}". Value must be JSON-serializable.`,
        );
      }

      const valueSize = Buffer.byteLength(valueSerialized, "utf8");
      const entrySerialized = `{"key":${JSON.stringify(prefixedKey)},"value":${valueSerialized},"expiresAt":${expiresAt}}`;

      return { prefixedKey, value, expiresAt, valueSerialized, valueSize, entrySerialized };
    });

    // Phase 2: Update memory (fast, synchronous operations)
    for (const p of prepared) {
      if (p.valueSize <= this.maxMemorySize) {
        this.memory.set(p.prefixedKey, p.valueSerialized, p.expiresAt);
      }
    }

    // Phase 3: Write all to disk (async by default, with proper chaining)
    if (this.syncWrites) {
      await Promise.all(
        prepared.map((p) => this.files.set(p.prefixedKey, p.value, p.expiresAt, p.entrySerialized)),
      );
    } else {
      // Track each write individually with proper chaining for same-key writes
      for (const p of prepared) {
        // Chain this write after any existing pending write for the same key
        const existingPending = this.pendingWrites.get(p.prefixedKey);
        const priorPromise = existingPending?.promise ?? Promise.resolve();

        // Create the chained disk write
        const diskWrite = priorPromise.then(() =>
          this.files.set(p.prefixedKey, p.value, p.expiresAt, p.entrySerialized),
        );

        // Create pending write entry with value metadata for immediate reads
        const pendingWrite: PendingWrite = {
          serialized: p.valueSerialized,
          expiresAt: p.expiresAt,
          size: p.valueSize,
          promise: diskWrite
            .catch(() => {
              // Evict only this key from memory if its write fails
              this.memory.delete(p.prefixedKey);
            })
            .then(() => {
              // Only delete if this is still the current pending write for this key
              if (this.pendingWrites.get(p.prefixedKey) === pendingWrite) {
                this.pendingWrites.delete(p.prefixedKey);
              }
            }),
        };

        this.pendingWrites.set(p.prefixedKey, pendingWrite);
      }
    }
  }

  /**
   * Get a value, or compute and set it if it doesn't exist (cache-aside pattern).
   * Includes stampede protection - concurrent calls for the same key
   * will wait for the first call to complete.
   *
   * @param key The cache key
   * @param fn Function that computes the value to cache (can be async)
   * @param ttl Optional TTL in seconds
   */
  async getOrSet<T>(key: string, fn: () => T | Promise<T>, ttl?: number): Promise<T> {
    this.assertOpen();
    const prefixedKey = this.prefixKey(key);

    // Fast path: check cache first
    const cached = await this.get<T>(key);
    if (cached !== null) {
      return cached;
    }

    return this.withStampedeProtection(prefixedKey, async () => {
      // Double-check after acquiring "lock"
      const recheck = await this.get<T>(key);
      if (recheck !== null) {
        return recheck;
      }

      const value = await fn();
      await this.set(key, value, ttl);
      return value;
    });
  }

  /**
   * Get the total number of items in the cache.
   * Includes items with pending writes that haven't completed yet.
   */
  async size(): Promise<number> {
    this.assertOpen();

    // Count unique keys across pending writes and disk
    // Pending writes may include keys not yet on disk (disk-only large values)
    const diskKeys = await this.files.keys();
    const diskKeySet = new Set(diskKeys);

    // Add pending write keys that aren't on disk yet
    let count = diskKeySet.size;
    for (const [key, pending] of this.pendingWrites) {
      if (!isExpired(pending.expiresAt) && !diskKeySet.has(key)) {
        count++;
      }
    }

    return count;
  }

  /**
   * Remove all expired entries from the cache.
   * This is called automatically if pruneInterval is configured.
   * @returns Number of entries removed
   */
  async prune(): Promise<number> {
    this.assertOpen();
    // Prune both stores, but return disk count as source of truth
    // (memory may have fewer items due to LRU eviction)
    this.memory.prune();
    return this.files.prune();
  }

  /**
   * Get cache statistics.
   * Note: During async writes, disk stats may lag behind the actual state.
   * Use flush() first if you need accurate post-write statistics.
   */
  async stats(): Promise<CacheStats> {
    this.assertOpen();

    const memStats = this.memory.stats;
    const [diskSize, diskItemCount] = await Promise.all([
      this.files.getSize(),
      this.files.getItemCount(),
    ]);

    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
      memory: {
        items: memStats.items,
        size: memStats.size,
        maxItems: memStats.maxItems,
        maxSize: memStats.maxSize,
      },
      disk: {
        items: diskItemCount,
        size: diskSize,
      },
      pendingWrites: this.pendingWrites.size,
    };
  }

  /**
   * Reset hit/miss counters.
   */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Wait for all pending async writes and touches to complete.
   * Useful when you need to ensure data is persisted before reading stats or shutting down.
   */
  async flush(): Promise<void> {
    // Fire all pending debounced touches immediately
    for (const [key, timer] of this.touchTimers) {
      clearTimeout(timer);
      this.touchTimers.delete(key);
      this.executeTouch(key);
    }

    // Wait for all pending writes and touches
    const pendingWritePromises = [...this.pendingWrites.values()].map((pw) => pw.promise);
    await Promise.all([...pendingWritePromises, ...this.pendingTouches]);
  }

  /**
   * Clear all entries from the cache.
   */
  async clear(): Promise<void> {
    this.assertOpen();

    // Cancel all pending debounced touches (don't need to execute them since we're clearing)
    for (const timer of this.touchTimers.values()) {
      clearTimeout(timer);
    }
    this.touchTimers.clear();

    // Capture pending write promises before clearing the map.
    // We need to wait for in-flight disk writes to complete before clearing disk,
    // otherwise they could re-add data after the clear.
    const pendingWritePromises = [...this.pendingWrites.values()].map((pw) => pw.promise);

    // Cancel all pending write intents immediately.
    // This ensures get() returns null right away for all keys.
    this.pendingWrites.clear();

    // Clear memory immediately
    this.memory.clear();

    // Wait for in-flight disk writes and touches to complete
    await Promise.all([...pendingWritePromises, ...this.pendingTouches]);

    // Now clear disk (all in-flight writes have landed)
    await this.files.clear();
  }

  /**
   * Close the cache.
   * Waits for pending writes to complete before closing.
   * After closing, all operations will throw.
   */
  async close(): Promise<void> {
    // Wait for all pending async writes and touches to complete
    await this.flush();

    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = undefined;
    }
    this.closed = true;
    this.inFlight.clear();
  }
}
