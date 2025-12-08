import { CacheOptions, CacheEntry, CacheStats, DEFAULT_OPTIONS } from "./types.js";
import { MemoryStore } from "./memory-store.js";
import { FileStore } from "./file-store.js";
import { estimateSize } from "./utils.js";

/**
 * FsLruCache - A Redis-like LRU cache with file system persistence.
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
  private hits = 0;
  private misses = 0;
  private closed = false;

  // In-flight operations for stampede protection
  private inFlight = new Map<string, Promise<unknown>>();

  constructor(options: CacheOptions = {}) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    this.maxMemorySize = opts.maxMemorySize;

    this.memory = new MemoryStore({
      maxItems: opts.maxMemoryItems,
      maxSize: opts.maxMemorySize,
    });

    this.files = new FileStore({
      dir: opts.dir,
      shards: opts.shards,
      maxSize: opts.maxDiskSize,
    });
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

    // Check memory first
    const memValue = this.memory.get<T>(key);
    if (memValue !== null) {
      this.hits++;
      return memValue;
    }

    // Check disk
    const diskEntry = await this.files.get<T>(key);
    if (diskEntry !== null) {
      this.hits++;
      // Promote to memory if it fits
      if (estimateSize(diskEntry.value) <= this.maxMemorySize) {
        this.memory.set(key, diskEntry.value, diskEntry.expiresAt);
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
   * @param ttlMs Optional TTL in milliseconds
   */
  async set(key: string, value: unknown, ttlMs?: number): Promise<void> {
    this.assertOpen();

    const expiresAt = ttlMs ? Date.now() + ttlMs : null;

    // Serialize once for both stores
    const entry: CacheEntry = { key, value, expiresAt };
    const serialized = JSON.stringify(entry);
    const size = Buffer.byteLength(serialized, "utf8");

    // Write to disk first (ensures durability before memory)
    await this.files.set(key, value, expiresAt, serialized);

    // Write to memory if it fits
    if (size <= this.maxMemorySize) {
      this.memory.set(key, value, expiresAt);
    }
  }

  /**
   * Set a value only if the key does not exist (atomic).
   * @returns true if the key was set, false if it already existed
   */
  async setnx(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    this.assertOpen();

    // Check if already in flight - if so, wait and report not set
    const existing = this.inFlight.get(key);
    if (existing) {
      await existing;
      return false;
    }

    return this.withStampedeProtection(key, async () => {
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
    const memDeleted = this.memory.delete(key);
    const diskDeleted = await this.files.delete(key);
    return memDeleted || diskDeleted;
  }

  /**
   * Check if a key exists in the cache.
   */
  async exists(key: string): Promise<boolean> {
    this.assertOpen();
    return this.memory.has(key) || (await this.files.has(key));
  }

  /**
   * Get all keys matching a pattern.
   * @param pattern Glob-like pattern (supports * wildcard)
   */
  async keys(pattern = "*"): Promise<string[]> {
    this.assertOpen();

    const [memKeys, diskKeys] = await Promise.all([
      Promise.resolve(this.memory.keys(pattern)),
      this.files.keys(pattern),
    ]);

    return [...new Set([...memKeys, ...diskKeys])];
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
    const expiresAt = Date.now() + ms;

    const memSuccess = this.memory.setExpiry(key, expiresAt);
    const diskSuccess = await this.files.setExpiry(key, expiresAt);

    return memSuccess || diskSuccess;
  }

  /**
   * Remove the TTL from a key, making it persistent.
   * @returns true if TTL was removed, false if key doesn't exist
   */
  async persist(key: string): Promise<boolean> {
    this.assertOpen();

    const memSuccess = this.memory.setExpiry(key, null);
    const diskSuccess = await this.files.setExpiry(key, null);

    return memSuccess || diskSuccess;
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

    const memTtl = this.memory.getTtl(key);
    if (memTtl !== -2) {
      return memTtl;
    }
    return this.files.getTtl(key);
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
   * @param entries Array of [key, value] or [key, value, ttlMs] tuples
   */
  async mset(entries: [string, unknown, number?][]): Promise<void> {
    await Promise.all(entries.map(([key, value, ttlMs]) => this.set(key, value, ttlMs)));
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

    // Fast path: check cache first
    const cached = await this.get<T>(key);
    if (cached !== null) {
      return cached;
    }

    return this.withStampedeProtection(key, async () => {
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
    this.closed = true;
    this.inFlight.clear();
  }
}
