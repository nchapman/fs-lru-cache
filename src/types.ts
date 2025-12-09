/**
 * Configuration options for FsLruCache
 *
 * @remarks
 * **Known Limitations:**
 * - `null` values cannot be distinguished from cache misses (both return `null`).
 *   Use a sentinel value like `{ notFound: true }` to cache negative lookups.
 * - Values must be JSON-serializable (no functions, undefined, circular refs).
 */
export interface CacheOptions {
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

export interface CacheEntry<T = unknown> {
  /** The cache key */
  key: string;
  /** The stored value */
  value: T;
  /** Expiration timestamp in ms, or null if no expiry */
  expiresAt: number | null;
}

export interface MemoryEntry {
  /** The cache key */
  key: string;
  /** JSON-serialized value */
  serialized: string;
  /** Expiration timestamp in ms, or null if no expiry */
  expiresAt: number | null;
  /** Size in bytes */
  size: number;
}

export interface CacheStats {
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

/**
 * Tracks a pending async disk write.
 * This allows reads to return the correct value before disk write completes,
 * and ensures sequential writes to the same key are properly ordered.
 */
export interface PendingWrite {
  /** JSON-serialized value for immediate reads */
  serialized: string;
  /** Expiration timestamp in ms, or null if no expiry */
  expiresAt: number | null;
  /** Size of the serialized value in bytes */
  size: number;
  /** Promise that resolves when this write (and all prior writes) complete */
  promise: Promise<void>;
}

export const DEFAULT_OPTIONS = {
  dir: ".cache",
  maxMemoryItems: 1000,
  maxMemorySize: 50 * 1024 * 1024, // 50MB
  maxDiskSize: 500 * 1024 * 1024, // 500MB
  shards: 16,
  defaultTtl: undefined as number | undefined,
  namespace: undefined as string | undefined,
  gzip: false,
  pruneInterval: undefined as number | undefined,
  syncWrites: false,
};
