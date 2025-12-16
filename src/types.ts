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
  /**
   * Enable experimental multi-process mode for sharing cache across processes (default: false).
   * When enabled, the cache coordinates with other processes via a shared index file.
   *
   * @remarks
   * **Experimental multi-process behavior:**
   * - Writes are immediately visible to the writing process
   * - Other processes see writes within syncInterval ms
   * - LRU ordering is approximate (each process tracks its own access times)
   * - Size limits are approximate (may temporarily exceed by ~N×maxSize where N = process count)
   * - Stampede protection works within a process only
   */
  experimentalMultiProcess?: boolean;
  /**
   * Interval in ms to sync index with other processes (default: 1000).
   * Only used when experimentalMultiProcess is true.
   */
  syncInterval?: number;
  /**
   * Callback for error events.
   * Called when recoverable errors occur during cache operations.
   * Useful for logging, monitoring, and alerting on potential problems.
   *
   * @example
   * ```ts
   * const cache = new FsLruCache({
   *   onError: (err) => {
   *     console.error(`Cache ${err.type}: ${err.message}`, err.error);
   *     metrics.increment(`cache.errors.${err.type}`);
   *   }
   * });
   * ```
   */
  onError?: ErrorCallback;
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

/**
 * Error counters by type.
 */
export interface ErrorStats {
  /** File read failures */
  readErrors: number;
  /** JSON parse failures */
  parseErrors: number;
  /** File write failures */
  writeErrors: number;
  /** Index sync failures (multi-process mode) */
  syncErrors: number;
  /** Value integrity failures */
  integrityErrors: number;
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
  /** Error counters by type */
  errors: ErrorStats;
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

/**
 * Error categories for cache operations.
 * Used with the onError callback to classify error types.
 */
export type CacheErrorType =
  /** File read failed (I/O error, permission denied, etc.) */
  | "read_error"
  /** JSON parse failed (corrupted data, partial write, etc.) */
  | "parse_error"
  /** File write failed (disk full, permission denied, etc.) */
  | "write_error"
  /** Index sync failed in multi-process mode */
  | "sync_error"
  /** Value hash mismatch (potential data corruption) */
  | "integrity_error";

/**
 * Error event emitted by the cache.
 * Contains the error type, original error, and context about the operation.
 */
export interface CacheError {
  /** Category of error */
  type: CacheErrorType;
  /** The underlying error */
  error: Error;
  /** Cache key involved (if applicable) */
  key?: string;
  /** Operation that failed */
  operation: "get" | "set" | "delete" | "sync" | "prune" | "init" | "touch" | "expire";
  /** Additional context */
  message: string;
}

/**
 * Callback for error events.
 * Called when recoverable errors occur during cache operations.
 * The cache will continue operating after these errors.
 */
export type ErrorCallback = (error: CacheError) => void;

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
  experimentalMultiProcess: false,
  syncInterval: 1000,
};

/**
 * Entry in the shared index file for multi-process coordination.
 */
export interface SharedIndexEntry {
  /** Hash of the key (used as filename) */
  hash: string;
  /** Size of the compressed file in bytes */
  size: number;
  /** Expiration timestamp in ms, or null if no expiry */
  expiresAt: number | null;
  /** Last access timestamp in ms (for LRU ordering) */
  lastAccessedAt: number;
  /** Hash of the value content (to detect overwrites by other processes) */
  valueHash?: string;
}

/**
 * Shared index file format for multi-process coordination.
 * Written to {cacheDir}/.index.json
 */
export interface SharedIndex {
  /** Version number, incremented on every write */
  version: number;
  /** Map of key -> metadata */
  entries: Record<string, SharedIndexEntry>;
}
