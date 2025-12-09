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
  /** Block on disk writes (default: false). When false, writes return immediately after updating memory. */
  syncWrites?: boolean;
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
  /** Number of pending async disk writes */
  pendingWrites: number;
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
  syncWrites: boolean;
};
//#endregion
//#region src/cache.d.ts
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
declare class FsLruCache {
  private readonly memory;
  private readonly files;
  private readonly maxMemorySize;
  private readonly defaultTtl?;
  private readonly namespace?;
  private readonly syncWrites;
  private hits;
  private misses;
  private closed;
  private inFlight;
  /**
   * Pending async disk writes per key.
   * This is the primary source of truth for "intended state" during async writes.
   * Contains the serialized value so reads can return it before disk write completes.
   * Writes are chained: new writes wait for prior writes to the same key.
   */
  private pendingWrites;
  private pruneTimer?;
  private touchTimers;
  private pendingTouches;
  private readonly touchDebounceMs;
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
   * - undefined: use defaultTtl if set
   * - 0: explicitly no TTL
   * - positive number: use that TTL (in seconds)
   * Returns milliseconds for internal use.
   */
  private resolveTtl;
  private assertOpen;
  /**
   * Schedule a debounced touch for the file store.
   * Coalesces frequent accesses to reduce disk I/O.
   */
  private debouncedFileTouch;
  /**
   * Execute a touch and track the promise for flush().
   */
  private executeTouch;
  /**
   * Cancel a pending debounced touch (used on delete/eviction).
   */
  private cancelDebouncedTouch;
  /**
   * Get a pending write if it exists and hasn't expired.
   * Returns null if no pending write or if it's expired.
   */
  private getValidPendingWrite;
  /**
   * Get all pending write keys matching a pattern.
   */
  private getPendingWriteKeys;
  /**
   * Execute an operation with stampede protection.
   * Concurrent calls for the same key will share the same promise.
   */
  private withStampedeProtection;
  /**
   * Get a value from the cache.
   * Checks pending writes first, then memory, then disk.
   * This ensures read-after-write consistency even with async writes.
   */
  get<T = unknown>(key: string): Promise<T | null>;
  /**
   * Set a value in the cache.
   * @param key The cache key
   * @param value The value to store (must be JSON-serializable)
   * @param ttl Optional TTL in seconds (0 to explicitly disable defaultTtl)
   */
  set(key: string, value: unknown, ttl?: number): Promise<void>;
  /**
   * Delete a key from the cache.
   */
  del(key: string): Promise<boolean>;
  /**
   * Check if a key exists in the cache.
   * Checks pending writes first for consistency with async writes.
   */
  exists(key: string): Promise<boolean>;
  /**
   * Get all keys matching a pattern.
   * Includes keys with pending writes for consistency.
   * @param pattern Glob-like pattern (supports * wildcard)
   */
  keys(pattern?: string): Promise<string[]>;
  /**
   * Set expiration time in seconds.
   */
  expire(key: string, seconds: number): Promise<boolean>;
  /**
   * Remove the TTL from a key, making it persistent.
   * @returns true if TTL was removed, false if key doesn't exist
   */
  persist(key: string): Promise<boolean>;
  /**
   * Touch a key: refresh its position in the LRU.
   * This is more efficient than get() when you don't need the value.
   * To update TTL, use expire() or pexpire() instead.
   * @param key The cache key
   * @returns true if key exists, false otherwise
   */
  touch(key: string): Promise<boolean>;
  /**
   * Get TTL in seconds.
   * Returns -1 if no expiry, -2 if key not found.
   * Checks pending writes first for consistency.
   */
  ttl(key: string): Promise<number>;
  /**
   * Get multiple values at once.
   * Returns array in same order as keys (null for missing/expired).
   */
  mget<T = unknown>(keys: string[]): Promise<(T | null)[]>;
  /**
   * Set multiple key-value pairs at once.
   * Optimized to batch serialization and disk writes.
   * @param entries Array of [key, value] or [key, value, ttl?] tuples (ttl in seconds)
   */
  mset(entries: [string, unknown, number?][]): Promise<void>;
  /**
   * Get a value, or compute and set it if it doesn't exist (cache-aside pattern).
   * Includes stampede protection - concurrent calls for the same key
   * will wait for the first call to complete.
   *
   * @param key The cache key
   * @param fn Function that computes the value to cache (can be async)
   * @param ttl Optional TTL in seconds
   */
  getOrSet<T>(key: string, fn: () => T | Promise<T>, ttl?: number): Promise<T>;
  /**
   * Get the total number of items in the cache.
   * Includes items with pending writes that haven't completed yet.
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
   * Note: During async writes, disk stats may lag behind the actual state.
   * Use flush() first if you need accurate post-write statistics.
   */
  stats(): Promise<CacheStats>;
  /**
   * Reset hit/miss counters.
   */
  resetStats(): void;
  /**
   * Wait for all pending async writes and touches to complete.
   * Useful when you need to ensure data is persisted before reading stats or shutting down.
   */
  flush(): Promise<void>;
  /**
   * Clear all entries from the cache.
   */
  clear(): Promise<void>;
  /**
   * Close the cache.
   * Waits for pending writes to complete before closing.
   * After closing, all operations will throw.
   */
  close(): Promise<void>;
}
//#endregion
export { type CacheEntry, type CacheOptions, type CacheStats, DEFAULT_OPTIONS, FsLruCache };
//# sourceMappingURL=index.d.mts.map