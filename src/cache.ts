import { CacheOptions, CacheEntry, CacheStats, DEFAULT_OPTIONS } from "./types.js";
import { MemoryStore } from "./memory-store.js";
import { FileStore } from "./file-store.js";

/**
 * FsLruCache - An LRU cache with file system persistence.
 *
 * Features:
 * - Two-tier storage: hot items in memory, all items on disk
 * - Memory-first reads for fast access to frequently used data
 * - Write-through to disk for durability
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
  private hits = 0;
  private misses = 0;
  private closed = false;

  // In-flight operations for stampede protection
  private inFlight = new Map<string, Promise<unknown>>();

  // Background prune interval
  private pruneTimer?: ReturnType<typeof setInterval>;

  constructor(options: CacheOptions = {}) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    this.maxMemorySize = opts.maxMemorySize;
    this.defaultTtl = opts.defaultTtl;
    this.namespace = opts.namespace;

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
      onEvict: (key) => this.memory.delete(key),
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
   * - undefined: use defaultTtl if set (converted from seconds to ms)
   * - 0: explicitly no TTL
   * - positive number: use that TTL
   */
  private resolveTtl(ttlMs?: number): number | undefined {
    if (ttlMs === undefined) {
      return this.defaultTtl ? this.defaultTtl * 1000 : undefined;
    }
    return ttlMs === 0 ? undefined : ttlMs;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("Cache is closed");
    }
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
   * Checks memory first, then disk (promoting to memory on hit).
   */
  async get<T = unknown>(key: string): Promise<T | null> {
    this.assertOpen();
    const prefixedKey = this.prefixKey(key);

    // Check memory first (returns JSON string)
    const memSerialized = this.memory.get(prefixedKey);
    if (memSerialized !== null) {
      this.hits++;
      return JSON.parse(memSerialized) as T;
    }

    // Check disk
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
   * @param ttlMs Optional TTL in milliseconds (0 to explicitly disable defaultTtl)
   */
  async set(key: string, value: unknown, ttlMs?: number): Promise<void> {
    this.assertOpen();
    const prefixedKey = this.prefixKey(key);
    const resolvedTtl = this.resolveTtl(ttlMs);

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

    // Write to disk first (ensures durability before memory)
    await this.files.set(prefixedKey, value, expiresAt, entrySerialized);

    // Write to memory if it fits
    if (valueSize <= this.maxMemorySize) {
      this.memory.set(prefixedKey, valueSerialized, expiresAt);
    }
  }

  /**
   * Set a value only if the key does not exist (atomic).
   * @returns true if the key was set, false if it already existed
   */
  async setnx(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    this.assertOpen();
    const prefixedKey = this.prefixKey(key);

    // Check if already in flight - if so, wait and report not set
    const existing = this.inFlight.get(prefixedKey);
    if (existing) {
      await existing;
      return false;
    }

    return this.withStampedeProtection(prefixedKey, async () => {
      if (await this.exists(key)) {
        return false;
      }
      await this.set(key, value, ttlMs);
      return true;
    });
  }

  /**
   * Delete a key from the cache.
   */
  async del(key: string): Promise<boolean> {
    this.assertOpen();
    const prefixedKey = this.prefixKey(key);
    const memDeleted = this.memory.delete(prefixedKey);
    const diskDeleted = await this.files.delete(prefixedKey);
    return memDeleted || diskDeleted;
  }

  /**
   * Check if a key exists in the cache.
   */
  async exists(key: string): Promise<boolean> {
    this.assertOpen();
    const prefixedKey = this.prefixKey(key);
    return this.memory.has(prefixedKey) || (await this.files.has(prefixedKey));
  }

  /**
   * Get all keys matching a pattern.
   * @param pattern Glob-like pattern (supports * wildcard)
   */
  async keys(pattern = "*"): Promise<string[]> {
    this.assertOpen();

    // Prefix the pattern for internal lookup
    const prefixedPattern = this.prefixKey(pattern);

    const [memKeys, diskKeys] = await Promise.all([
      Promise.resolve(this.memory.keys(prefixedPattern)),
      this.files.keys(prefixedPattern),
    ]);

    // Remove prefix from returned keys
    const allKeys = [...new Set([...memKeys, ...diskKeys])];
    return allKeys.map((k) => this.unprefixKey(k));
  }

  /**
   * Set expiration time in seconds.
   */
  async expire(key: string, seconds: number): Promise<boolean> {
    return this.pexpire(key, seconds * 1000);
  }

  /**
   * Set expiration time in milliseconds.
   */
  async pexpire(key: string, ms: number): Promise<boolean> {
    this.assertOpen();
    const prefixedKey = this.prefixKey(key);
    const expiresAt = Date.now() + ms;

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
   * Touch a key: refresh its position in the LRU and optionally update TTL.
   * This is more efficient than get() when you don't need the value.
   * @param key The cache key
   * @param ttlMs Optional new TTL in milliseconds
   * @returns true if key exists, false otherwise
   */
  async touch(key: string, ttlMs?: number): Promise<boolean> {
    this.assertOpen();
    const prefixedKey = this.prefixKey(key);

    const expiresAt = ttlMs !== undefined ? Date.now() + ttlMs : undefined;

    // Disk first - if this fails, don't update memory (keeps them consistent)
    const diskSuccess = await this.files.touch(prefixedKey, expiresAt);
    if (!diskSuccess) {
      return false;
    }

    // Memory second - best effort (memory is just a hot cache)
    this.memory.touch(prefixedKey, expiresAt);
    return true;
  }

  /**
   * Get TTL in seconds.
   * Returns -1 if no expiry, -2 if key not found.
   */
  async ttl(key: string): Promise<number> {
    const pttl = await this.pttl(key);
    return pttl < 0 ? pttl : Math.ceil(pttl / 1000);
  }

  /**
   * Get TTL in milliseconds.
   * Returns -1 if no expiry, -2 if key not found.
   */
  async pttl(key: string): Promise<number> {
    this.assertOpen();
    const prefixedKey = this.prefixKey(key);

    const memTtl = this.memory.getTtl(prefixedKey);
    if (memTtl !== -2) {
      return memTtl;
    }
    return this.files.getTtl(prefixedKey);
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
   * @param entries Array of [key, value] or [key, value, ttlMs] tuples
   */
  async mset(entries: [string, unknown, number?][]): Promise<void> {
    this.assertOpen();
    if (entries.length === 0) return;

    // Phase 1: Prepare all entries (serialization)
    const prepared = entries.map(([key, value, ttlMs]) => {
      const prefixedKey = this.prefixKey(key);
      const resolvedTtl = this.resolveTtl(ttlMs);
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

    // Phase 2: Write all to disk in parallel
    await Promise.all(
      prepared.map((p) => this.files.set(p.prefixedKey, p.value, p.expiresAt, p.entrySerialized)),
    );

    // Phase 3: Update memory (fast, synchronous operations)
    for (const p of prepared) {
      if (p.valueSize <= this.maxMemorySize) {
        this.memory.set(p.prefixedKey, p.valueSerialized, p.expiresAt);
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
   * @param ttlMs Optional TTL in milliseconds
   */
  async getOrSet<T>(key: string, fn: () => T | Promise<T>, ttlMs?: number): Promise<T> {
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
      await this.set(key, value, ttlMs);
      return value;
    });
  }

  /**
   * Get the total number of items in the cache.
   * This is the count of items on disk (source of truth).
   */
  async size(): Promise<number> {
    this.assertOpen();
    return this.files.getItemCount();
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
   * Clear all entries from the cache.
   */
  async clear(): Promise<void> {
    this.assertOpen();
    this.memory.clear();
    await this.files.clear();
  }

  /**
   * Close the cache.
   * After closing, all operations will throw.
   */
  async close(): Promise<void> {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = undefined;
    }
    this.closed = true;
    this.inFlight.clear();
  }
}
