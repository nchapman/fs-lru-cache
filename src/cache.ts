import { CacheOptions, CacheEntry, CacheStats, DEFAULT_OPTIONS } from './types.js';
import { MemoryStore } from './memory-store.js';
import { FileStore } from './file-store.js';
import { estimateSize } from './utils.js';

/**
 * FsLruCache - A Redis-like LRU cache with file system persistence
 *
 * Features:
 * - Two-tier storage: hot items in memory, all items on disk
 * - Memory-first reads for fast access to frequently used data
 * - Write-through to disk for durability
 * - LRU eviction in both memory and disk stores
 * - TTL support with lazy expiration
 * - Stampede protection for getOrSet
 */
export class FsLruCache {
  private readonly memory: MemoryStore;
  private readonly files: FileStore;
  private readonly maxMemorySize: number;
  private hits = 0;
  private misses = 0;

  // In-flight operations for stampede protection
  private inFlight: Map<string, Promise<unknown>> = new Map();

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

  /**
   * Get a value from the cache
   * Checks memory first, then disk (promoting to memory on hit)
   */
  async get<T = unknown>(key: string): Promise<T | null> {
    // Check memory first
    const memValue = this.memory.get<T>(key);
    if (memValue !== null) {
      this.hits++;
      return memValue;
    }

    // Check disk - now returns full entry with expiresAt
    const diskEntry = await this.files.get<T>(key);
    if (diskEntry !== null) {
      this.hits++;
      // Promote to memory (skip if too large for memory)
      const size = estimateSize(diskEntry.value);
      if (size <= this.maxMemorySize) {
        this.memory.set(key, diskEntry.value, diskEntry.expiresAt);
      }
      return diskEntry.value;
    }

    this.misses++;
    return null;
  }

  /**
   * Set a value in the cache
   * @param key The cache key
   * @param value The value to store (must be JSON-serializable)
   * @param ttlMs Optional TTL in milliseconds
   */
  async set(key: string, value: unknown, ttlMs?: number): Promise<void> {
    const expiresAt = ttlMs ? Date.now() + ttlMs : null;

    // Serialize once for both stores
    const entry: CacheEntry = { key, value, expiresAt };
    const serialized = JSON.stringify(entry);
    const size = Buffer.byteLength(serialized, 'utf8');

    // Write to memory (skip if too large)
    if (size <= this.maxMemorySize) {
      this.memory.set(key, value, expiresAt);
    }

    // Write to disk (atomic write, will throw on failure)
    await this.files.set(key, value, expiresAt, serialized);
  }

  /**
   * Set a value only if the key does not exist (atomic)
   * Uses in-flight tracking to prevent race conditions
   * @returns true if the key was set, false if it already existed
   */
  async setnx(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    // Check if operation is already in flight
    const existing = this.inFlight.get(key);
    if (existing) {
      await existing;
      return false; // Someone else set it
    }

    // Use IIFE pattern so inFlight is set BEFORE first await (prevents race)
    const operation = (async () => {
      if (await this.exists(key)) {
        return false;
      }
      await this.set(key, value, ttlMs);
      return true;
    })();

    this.inFlight.set(key, operation);

    try {
      return await operation;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * Delete a key from the cache
   */
  async del(key: string): Promise<boolean> {
    const memDeleted = this.memory.delete(key);
    const diskDeleted = await this.files.delete(key);
    return memDeleted || diskDeleted;
  }

  /**
   * Check if a key exists in the cache
   */
  async exists(key: string): Promise<boolean> {
    if (this.memory.has(key)) {
      return true;
    }
    return await this.files.has(key);
  }

  /**
   * Get all keys matching a pattern
   * @param pattern Glob-like pattern (supports * wildcard)
   */
  async keys(pattern = '*'): Promise<string[]> {
    // Get keys from both stores and deduplicate
    const memKeys = this.memory.keys(pattern);
    const diskKeys = await this.files.keys(pattern);

    const allKeys = new Set([...memKeys, ...diskKeys]);
    return Array.from(allKeys);
  }

  /**
   * Set expiration time in seconds
   */
  async expire(key: string, seconds: number): Promise<boolean> {
    return this.pexpire(key, seconds * 1000);
  }

  /**
   * Set expiration time in milliseconds
   */
  async pexpire(key: string, ms: number): Promise<boolean> {
    const expiresAt = Date.now() + ms;

    const memSuccess = this.memory.setExpiry(key, expiresAt);
    const diskSuccess = await this.files.setExpiry(key, expiresAt);

    return memSuccess || diskSuccess;
  }

  /**
   * Remove the TTL from a key, making it persistent
   * @returns true if TTL was removed, false if key doesn't exist
   */
  async persist(key: string): Promise<boolean> {
    const memSuccess = this.memory.setExpiry(key, null);
    const diskSuccess = await this.files.setExpiry(key, null);

    return memSuccess || diskSuccess;
  }

  /**
   * Get TTL in seconds
   * Returns -1 if no expiry, -2 if key not found
   */
  async ttl(key: string): Promise<number> {
    const pttl = await this.pttl(key);
    if (pttl < 0) return pttl;
    return Math.ceil(pttl / 1000);
  }

  /**
   * Get TTL in milliseconds
   * Returns -1 if no expiry, -2 if key not found
   */
  async pttl(key: string): Promise<number> {
    // Check memory first
    const memTtl = this.memory.getTtl(key);
    if (memTtl !== -2) {
      return memTtl;
    }

    // Check disk
    return await this.files.getTtl(key);
  }

  /**
   * Get multiple values at once
   * Returns array in same order as keys (null for missing/expired)
   */
  async mget<T = unknown>(keys: string[]): Promise<(T | null)[]> {
    return Promise.all(keys.map((key) => this.get<T>(key)));
  }

  /**
   * Set multiple key-value pairs at once
   * @param entries Array of [key, value] or [key, value, ttlMs] tuples
   */
  async mset(entries: [string, unknown, number?][]): Promise<void> {
    await Promise.all(
      entries.map(([key, value, ttlMs]) => this.set(key, value, ttlMs))
    );
  }

  /**
   * Get a value, or set it if it doesn't exist (cache-aside pattern)
   * Includes stampede protection - concurrent calls for the same key
   * will wait for the first call to complete instead of all executing fn()
   *
   * @param key The cache key
   * @param fn Function that returns the value to cache (can be async)
   * @param ttlMs Optional TTL in milliseconds
   */
  async getOrSet<T>(
    key: string,
    fn: () => T | Promise<T>,
    ttlMs?: number
  ): Promise<T> {
    // Check cache first
    const existing = await this.get<T>(key);
    if (existing !== null) {
      return existing;
    }

    // Check if computation is already in flight
    const inFlightPromise = this.inFlight.get(key);
    if (inFlightPromise) {
      return inFlightPromise as Promise<T>;
    }

    // Compute value with stampede protection
    const computePromise = (async () => {
      // Double-check after acquiring "lock"
      const recheck = await this.get<T>(key);
      if (recheck !== null) {
        return recheck;
      }

      const value = await fn();
      await this.set(key, value, ttlMs);
      return value;
    })();

    this.inFlight.set(key, computePromise);

    try {
      return await computePromise;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * Get cache statistics
   */
  async stats(): Promise<CacheStats> {
    const memStats = this.memory.stats;
    const diskSize = await this.files.getSize();
    const diskKeys = await this.files.keys();

    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: this.hits + this.misses > 0
        ? this.hits / (this.hits + this.misses)
        : 0,
      memory: {
        items: memStats.items,
        size: memStats.size,
        maxItems: memStats.maxItems,
        maxSize: memStats.maxSize,
      },
      disk: {
        items: diskKeys.length,
        size: diskSize,
      },
    };
  }

  /**
   * Reset hit/miss counters
   */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Clear all entries from the cache
   */
  async clear(): Promise<void> {
    this.memory.clear();
    await this.files.clear();
  }

  /**
   * Close the cache (cleanup)
   * Currently a no-op but included for API completeness
   */
  async close(): Promise<void> {
    // Clear in-flight operations
    this.inFlight.clear();
  }
}
