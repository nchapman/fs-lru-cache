//#region src/types.d.ts
/**
 * Configuration options for FsLruCache
 *
 * @remarks
 * **Known Limitations:**
 * - `null` values cannot be distinguished from cache misses (both return `null`).
 *   Use a sentinel value like `{ notFound: true }` to cache negative lookups.
 * - Values must be JSON-serializable (no functions, undefined, circular refs).
 */
interface CacheOptions {
  /** Cache directory path (default: ./.cache) */
  dir?: string;
  /** Maximum number of items in memory (default: 1000) */
  maxMemoryItems?: number;
  /** Maximum memory usage in bytes (default: 50MB). Values larger than this skip the memory tier. */
  maxMemorySize?: number;
  /** Maximum disk usage in bytes (default: 500MB) */
  maxDiskSize?: number;
  /** Number of shard directories (default: 16) */
  shards?: number;
  /** Default TTL in seconds for all entries (default: none). Use 0 to explicitly disable TTL on a specific set(). */
  defaultTtl?: number;
  /** Namespace prefix for all keys (default: none). Keys are stored as `${namespace}:${key}`. */
  namespace?: string;
  /** Enable gzip compression for disk storage (default: false). Reduces disk usage at the cost of CPU. */
  gzip?: boolean;
  /** Interval in milliseconds for automatic pruning of expired items (default: disabled). */
  pruneInterval?: number;
}
interface CacheEntry<T = unknown> {
  /** The cache key */
  key: string;
  /** The stored value */
  value: T;
  /** Expiration timestamp in ms, or null if no expiry */
  expiresAt: number | null;
}
interface CacheStats {
  /** Total cache hits */
  hits: number;
  /** Total cache misses */
  misses: number;
  /** Hit rate (0-1) */
  hitRate: number;
  /** Memory store statistics */
  memory: {
    items: number;
    size: number;
    maxItems: number;
    maxSize: number;
  };
  /** Disk store statistics */
  disk: {
    items: number;
    size: number;
  };
}
declare const DEFAULT_OPTIONS: {
  dir: string;
  maxMemoryItems: number;
  maxMemorySize: number;
  maxDiskSize: number;
  shards: number;
  defaultTtl: number | undefined;
  namespace: string | undefined;
  gzip: boolean;
  pruneInterval: number | undefined;
};
//#endregion
//#region src/cache.d.ts
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
declare class FsLruCache {
  private readonly memory;
  private readonly files;
  private readonly maxMemorySize;
  private readonly defaultTtl?;
  private readonly namespace?;
  private hits;
  private misses;
  private closed;
  private inFlight;
  private pruneTimer?;
  constructor(options?: CacheOptions);
  /**
   * Prefix a key with the namespace if configured.
   */
  private prefixKey;
  /**
   * Remove the namespace prefix from a key.
   */
  private unprefixKey;
  /**
   * Resolve the TTL to use: explicit value, defaultTtl, or none.
   * - undefined: use defaultTtl if set (converted from seconds to ms)
   * - 0: explicitly no TTL
   * - positive number: use that TTL
   */
  private resolveTtl;
  private assertOpen;
  /**
   * Execute an operation with stampede protection.
   * Concurrent calls for the same key will share the same promise.
   */
  private withStampedeProtection;
  /**
   * Get a value from the cache.
   * Checks memory first, then disk (promoting to memory on hit).
   */
  get<T = unknown>(key: string): Promise<T | null>;
  /**
   * Set a value in the cache.
   * @param key The cache key
   * @param value The value to store (must be JSON-serializable)
   * @param ttlMs Optional TTL in milliseconds (0 to explicitly disable defaultTtl)
   */
  set(key: string, value: unknown, ttlMs?: number): Promise<void>;
  /**
   * Set a value only if the key does not exist (atomic).
   * @returns true if the key was set, false if it already existed
   */
  setnx(key: string, value: unknown, ttlMs?: number): Promise<boolean>;
  /**
   * Delete a key from the cache.
   */
  del(key: string): Promise<boolean>;
  /**
   * Check if a key exists in the cache.
   */
  exists(key: string): Promise<boolean>;
  /**
   * Get all keys matching a pattern.
   * @param pattern Glob-like pattern (supports * wildcard)
   */
  keys(pattern?: string): Promise<string[]>;
  /**
   * Set expiration time in seconds.
   */
  expire(key: string, seconds: number): Promise<boolean>;
  /**
   * Set expiration time in milliseconds.
   */
  pexpire(key: string, ms: number): Promise<boolean>;
  /**
   * Remove the TTL from a key, making it persistent.
   * @returns true if TTL was removed, false if key doesn't exist
   */
  persist(key: string): Promise<boolean>;
  /**
   * Touch a key: refresh its position in the LRU and optionally update TTL.
   * This is more efficient than get() when you don't need the value.
   * @param key The cache key
   * @param ttlMs Optional new TTL in milliseconds
   * @returns true if key exists, false otherwise
   */
  touch(key: string, ttlMs?: number): Promise<boolean>;
  /**
   * Get TTL in seconds.
   * Returns -1 if no expiry, -2 if key not found.
   */
  ttl(key: string): Promise<number>;
  /**
   * Get TTL in milliseconds.
   * Returns -1 if no expiry, -2 if key not found.
   */
  pttl(key: string): Promise<number>;
  /**
   * Get multiple values at once.
   * Returns array in same order as keys (null for missing/expired).
   */
  mget<T = unknown>(keys: string[]): Promise<(T | null)[]>;
  /**
   * Set multiple key-value pairs at once.
   * Optimized to batch serialization and disk writes.
   * @param entries Array of [key, value] or [key, value, ttlMs] tuples
   */
  mset(entries: [string, unknown, number?][]): Promise<void>;
  /**
   * Get a value, or compute and set it if it doesn't exist (cache-aside pattern).
   * Includes stampede protection - concurrent calls for the same key
   * will wait for the first call to complete.
   *
   * @param key The cache key
   * @param fn Function that computes the value to cache (can be async)
   * @param ttlMs Optional TTL in milliseconds
   */
  getOrSet<T>(key: string, fn: () => T | Promise<T>, ttlMs?: number): Promise<T>;
  /**
   * Get the total number of items in the cache.
   * This is the count of items on disk (source of truth).
   */
  size(): Promise<number>;
  /**
   * Remove all expired entries from the cache.
   * This is called automatically if pruneInterval is configured.
   * @returns Number of entries removed
   */
  prune(): Promise<number>;
  /**
   * Get cache statistics.
   */
  stats(): Promise<CacheStats>;
  /**
   * Reset hit/miss counters.
   */
  resetStats(): void;
  /**
   * Clear all entries from the cache.
   */
  clear(): Promise<void>;
  /**
   * Close the cache.
   * After closing, all operations will throw.
   */
  close(): Promise<void>;
}
//#endregion
export { type CacheEntry, type CacheOptions, type CacheStats, DEFAULT_OPTIONS, FsLruCache };
//# sourceMappingURL=index.d.mts.map