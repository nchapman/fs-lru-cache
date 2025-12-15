import { promises as fs } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import { gzip, gunzip } from "zlib";
import { promisify } from "util";
import { CacheEntry, SharedIndex, SharedIndexEntry } from "./types.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
import {
  hashKey,
  hashValue,
  getShardIndex,
  getShardName,
  isExpired,
  compilePattern,
  matchPattern,
} from "./utils.js";

/** Gzip magic bytes for detecting compressed files */
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

export interface FileStoreOptions {
  dir: string;
  shards: number;
  maxSize: number;
  gzip?: boolean;
  /**
   * Called synchronously when a key is evicted from disk due to:
   * - Hash collision (another key claims the same hash)
   * - Space pressure (LRU eviction to stay under maxSize)
   * - Deleted by another process (detected during sync)
   *
   * NOT called for explicit delete() operations.
   * This allows the parent to keep other caches in sync.
   */
  onEvict?: (key: string) => void;
  /**
   * Called when a key's value was changed by another process.
   * The file still exists but contains different data.
   * Use this to invalidate memory caches holding stale values.
   */
  onInvalidate?: (key: string) => void;
  /**
   * Enable multi-process mode for sharing cache across processes.
   */
  multiProcess?: boolean;
  /**
   * Interval in ms to sync index with other processes (default: 1000).
   * Only used when multiProcess is true.
   */
  syncInterval?: number;
  /**
   * Called before writing or reading the shared index.
   * Should flush any pending async writes to ensure index consistency.
   */
  onBeforeSync?: () => Promise<void>;
}

interface IndexEntry {
  hash: string;
  expiresAt: number | null;
  lastAccessedAt: number;
  size: number;
  /** Hash of the value content (to detect overwrites by other processes) */
  valueHash?: string;
}

/**
 * File system storage layer with sharding and in-memory index.
 */
export class FileStore {
  private readonly dir: string;
  private readonly shards: number;
  private readonly maxSize: number;
  private readonly gzip: boolean;
  private readonly onEvict?: (key: string) => void;
  private readonly onInvalidate?: (key: string) => void;
  private readonly multiProcess: boolean;
  private readonly syncInterval: number;
  private readonly onBeforeSync?: () => Promise<void>;
  private initialized = false;

  // In-memory index: key -> metadata (no values, just for fast lookups)
  private index = new Map<string, IndexEntry>();
  // Reverse mapping: hash -> key (to detect collisions)
  private hashToKey = new Map<string, string>();
  private totalSize = 0;

  // Multi-process sync state
  private indexVersion = 0;
  private indexDirty = false;
  private syncTimer?: ReturnType<typeof setInterval>;
  private indexWriteTimer?: ReturnType<typeof setTimeout>;
  private pendingIndexWrite?: Promise<void>;
  private syncInProgress?: Promise<void>;

  constructor(options: FileStoreOptions) {
    this.dir = options.dir;
    this.shards = options.shards;
    this.maxSize = options.maxSize;
    this.gzip = options.gzip ?? false;
    this.onEvict = options.onEvict;
    this.onInvalidate = options.onInvalidate;
    this.multiProcess = options.multiProcess ?? false;
    this.syncInterval = options.syncInterval ?? 1000;
    this.onBeforeSync = options.onBeforeSync;
  }

  /**
   * Check if a buffer is gzip compressed by looking for magic bytes.
   */
  private isCompressed(data: Buffer): boolean {
    return data.length >= 2 && data[0] === GZIP_MAGIC[0] && data[1] === GZIP_MAGIC[1];
  }

  /**
   * Compress data if compression is enabled.
   */
  private async compress(data: string): Promise<Buffer> {
    const buffer = Buffer.from(data, "utf8");
    return this.gzip ? gzipAsync(buffer) : buffer;
  }

  /**
   * Decompress data, auto-detecting if it's compressed.
   */
  private async decompress(data: Buffer): Promise<string> {
    if (this.isCompressed(data)) {
      const decompressed = await gunzipAsync(data);
      return decompressed.toString("utf8");
    }
    return data.toString("utf8");
  }

  /**
   * Initialize the cache directory structure and load index
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    await fs.mkdir(this.dir, { recursive: true });

    // Create shard directories
    const shardPromises = Array.from({ length: this.shards }, (_, i) =>
      fs.mkdir(join(this.dir, getShardName(i)), { recursive: true }),
    );
    await Promise.all(shardPromises);

    // Try to load from shared index first (faster), fall back to file scan
    const loadedFromSharedIndex = await this.loadSharedIndex();
    if (!loadedFromSharedIndex) {
      await this.loadIndex();
    }

    // Start sync timer if multi-process mode is enabled
    if (this.multiProcess) {
      this.syncTimer = setInterval(() => {
        this.sync().catch(() => {});
      }, this.syncInterval);
      this.syncTimer.unref();
    }

    this.initialized = true;
  }

  /**
   * Load index from disk (scans all files once on startup)
   */
  private async loadIndex(): Promise<void> {
    this.index.clear();
    this.hashToKey.clear();
    this.totalSize = 0;

    const loadShard = async (shardIndex: number) => {
      const shardDir = join(this.dir, getShardName(shardIndex));
      let files: string[];

      try {
        files = await fs.readdir(shardDir);
      } catch {
        return; // Shard doesn't exist yet
      }

      for (const file of files) {
        if (!file.endsWith(".dat")) continue;
        await this.loadFile(shardDir, file);
      }
    };

    await Promise.all(Array.from({ length: this.shards }, (_, i) => loadShard(i)));
  }

  /**
   * Load a single cache file into the index
   */
  private async loadFile(shardDir: string, file: string): Promise<void> {
    const filePath = join(shardDir, file);

    try {
      const [stat, rawContent] = await Promise.all([fs.stat(filePath), fs.readFile(filePath)]);
      const content = await this.decompress(rawContent);
      const data: CacheEntry = JSON.parse(content);

      if (isExpired(data.expiresAt)) {
        await fs.unlink(filePath).catch(() => {});
        return;
      }

      const hash = file.replace(".dat", "");
      this.index.set(data.key, {
        hash,
        expiresAt: data.expiresAt,
        lastAccessedAt: stat.mtimeMs,
        size: stat.size,
      });
      this.hashToKey.set(hash, data.key);
      this.totalSize += stat.size;
    } catch {
      // Skip invalid files
    }
  }

  /**
   * Get the file path for a hash
   */
  private getFilePath(hash: string): string {
    const shardName = getShardName(getShardIndex(hash, this.shards));
    return join(this.dir, shardName, `${hash}.dat`);
  }

  /**
   * Generate a temporary file path for atomic writes
   */
  private getTempPath(): string {
    return join(this.dir, `.tmp-${randomBytes(8).toString("hex")}`);
  }

  /**
   * Atomic file write: write to temp, then rename
   */
  private async atomicWrite(filePath: string, content: Buffer): Promise<void> {
    const tempPath = this.getTempPath();
    try {
      await fs.writeFile(tempPath, content);
      await fs.rename(tempPath, filePath);
    } catch (err) {
      await fs.unlink(tempPath).catch(() => {});
      throw err;
    }
  }

  /**
   * Get a valid index entry, removing it if expired
   */
  private async getValidIndexEntry(key: string): Promise<IndexEntry | null> {
    const entry = this.index.get(key);
    if (!entry) return null;

    if (isExpired(entry.expiresAt)) {
      await this.delete(key);
      return null;
    }
    return entry;
  }

  /**
   * Read and parse a cache file, handling errors and key mismatches
   */
  private async readCacheFile<T>(
    key: string,
    indexEntry: IndexEntry,
  ): Promise<CacheEntry<T> | null> {
    const filePath = this.getFilePath(indexEntry.hash);

    try {
      const rawContent = await fs.readFile(filePath);
      const content = await this.decompress(rawContent);
      const entry: CacheEntry<T> = JSON.parse(content);

      // Verify key matches (hash collision check)
      if (entry.key !== key) {
        this.index.delete(key);
        return null;
      }
      return entry;
    } catch {
      // File missing or corrupted - clean up index
      this.totalSize -= indexEntry.size;
      this.index.delete(key);
      this.hashToKey.delete(indexEntry.hash);
      return null;
    }
  }

  /**
   * Get a value from disk.
   * Returns the full cache entry for consistency with memory store.
   */
  async get<T = unknown>(key: string): Promise<CacheEntry<T> | null> {
    await this.init();

    const indexEntry = await this.getValidIndexEntry(key);
    if (!indexEntry) return null;

    const entry = await this.readCacheFile<T>(key, indexEntry);
    if (entry) {
      indexEntry.lastAccessedAt = Date.now();
    }
    return entry;
  }

  /**
   * Get entry metadata without updating access time
   */
  async peek(key: string): Promise<CacheEntry | null> {
    await this.init();

    const indexEntry = await this.getValidIndexEntry(key);
    if (!indexEntry) return null;

    return this.readCacheFile(key, indexEntry);
  }

  /**
   * Set a value on disk with atomic write
   * @param content Optional pre-serialized content (to avoid double serialization)
   */
  async set<T = unknown>(
    key: string,
    value: T,
    expiresAt: number | null = null,
    content?: string,
  ): Promise<void> {
    await this.init();

    // Use pre-serialized content if provided, otherwise serialize now
    const serialized = content ?? JSON.stringify({ key, value, expiresAt } as CacheEntry<T>);
    const compressed = await this.compress(serialized);
    const size = compressed.length;
    const hash = hashKey(key);
    const filePath = this.getFilePath(hash);

    // Remove old entry if exists
    const existing = this.index.get(key);
    if (existing) {
      this.totalSize -= existing.size;
      this.hashToKey.delete(existing.hash);
    }

    // Handle hash collision: if another key owns this hash, remove it
    const collidingKey = this.hashToKey.get(hash);
    if (collidingKey && collidingKey !== key) {
      const collidingEntry = this.index.get(collidingKey);
      if (collidingEntry) {
        this.totalSize -= collidingEntry.size;
        this.index.delete(collidingKey);
        // Notify parent about the collision eviction (wrapped to ensure set() completes)
        try {
          this.onEvict?.(collidingKey);
        } catch {
          // Callback errors shouldn't fail the set operation
        }
      }
    }

    await this.ensureSpace(size);
    await this.atomicWrite(filePath, compressed);

    this.index.set(key, {
      hash,
      expiresAt,
      lastAccessedAt: Date.now(),
      size,
      valueHash: this.multiProcess ? hashValue(serialized) : undefined,
    });
    this.hashToKey.set(hash, key);
    this.totalSize += size;
    this.markIndexDirty();
  }

  /**
   * Delete a key from disk
   */
  async delete(key: string): Promise<boolean> {
    await this.init();

    const indexEntry = this.index.get(key);
    if (!indexEntry) return false;

    const filePath = this.getFilePath(indexEntry.hash);

    // Update index first (before I/O)
    this.totalSize -= indexEntry.size;
    this.index.delete(key);
    this.hashToKey.delete(indexEntry.hash);
    this.markIndexDirty();

    try {
      await fs.unlink(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if a key exists on disk (fast - uses index)
   */
  async has(key: string): Promise<boolean> {
    await this.init();
    return (await this.getValidIndexEntry(key)) !== null;
  }

  /**
   * Get all keys matching a pattern (fast - uses index)
   */
  async keys(pattern = "*"): Promise<string[]> {
    await this.init();

    const compiled = compilePattern(pattern);
    const result: string[] = [];
    const expiredKeys: string[] = [];

    for (const [key, entry] of this.index) {
      if (isExpired(entry.expiresAt)) {
        expiredKeys.push(key);
      } else if (matchPattern(key, compiled)) {
        result.push(key);
      }
    }

    // Clean up expired entries in parallel
    if (expiredKeys.length > 0) {
      await Promise.all(expiredKeys.map((key) => this.delete(key)));
    }

    return result;
  }

  /**
   * Update expiration time for a key
   */
  async setExpiry(key: string, expiresAt: number | null): Promise<boolean> {
    await this.init();

    const indexEntry = await this.getValidIndexEntry(key);
    if (!indexEntry) return false;

    const filePath = this.getFilePath(indexEntry.hash);

    try {
      const rawContent = await fs.readFile(filePath);
      const content = await this.decompress(rawContent);
      const entry: CacheEntry = JSON.parse(content);

      if (entry.key !== key) return false;

      entry.expiresAt = expiresAt;
      const serialized = JSON.stringify(entry);
      const compressed = await this.compress(serialized);
      await this.atomicWrite(filePath, compressed);

      // Update index
      const newSize = compressed.length;
      this.totalSize += newSize - indexEntry.size;
      indexEntry.expiresAt = expiresAt;
      indexEntry.size = newSize;
      if (this.multiProcess) {
        indexEntry.valueHash = hashValue(serialized);
      }
      this.markIndexDirty();

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get TTL for a key in milliseconds (fast - uses index).
   * Returns -1 if no expiry, -2 if not found.
   */
  async getTtl(key: string): Promise<number> {
    await this.init();

    const indexEntry = await this.getValidIndexEntry(key);
    if (!indexEntry) return -2;
    if (indexEntry.expiresAt === null) return -1;
    return Math.max(0, indexEntry.expiresAt - Date.now());
  }

  /**
   * Touch a key: update last accessed time for LRU tracking.
   * Updates both the in-memory index and file mtime (for restart persistence).
   */
  async touch(key: string): Promise<boolean> {
    await this.init();

    const indexEntry = await this.getValidIndexEntry(key);
    if (!indexEntry) return false;

    const filePath = this.getFilePath(indexEntry.hash);
    const now = Date.now();

    indexEntry.lastAccessedAt = now;
    this.markIndexDirty();

    try {
      const nowDate = new Date(now);
      await fs.utimes(filePath, nowDate, nowDate);
    } catch {
      // File may be gone, but index update still valid for this session
    }

    return true;
  }

  /**
   * Clear all entries
   */
  async clear(): Promise<void> {
    await this.init();

    const clearShard = async (shardIndex: number) => {
      const shardDir = join(this.dir, getShardName(shardIndex));
      try {
        const files = await fs.readdir(shardDir);
        await Promise.all(files.map((file) => fs.unlink(join(shardDir, file)).catch(() => {})));
      } catch {
        // Ignore errors
      }
    };

    await Promise.all(Array.from({ length: this.shards }, (_, i) => clearShard(i)));

    this.index.clear();
    this.hashToKey.clear();
    this.totalSize = 0;
    this.markIndexDirty();
  }

  /**
   * Get total size of cache on disk (fast - uses index)
   */
  async getSize(): Promise<number> {
    await this.init();
    return this.totalSize;
  }

  /**
   * Get number of items in cache (fast - uses index)
   */
  async getItemCount(): Promise<number> {
    await this.init();
    return this.index.size;
  }

  /**
   * Remove all expired entries from disk.
   * Uses the in-memory index for efficient lookup (no filesystem scan).
   * @returns Number of entries removed
   */
  async prune(): Promise<number> {
    await this.init();

    const now = Date.now();
    const expired: string[] = [];

    // Collect expired keys from index
    for (const [key, entry] of this.index) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) {
        expired.push(key);
      }
    }

    // Delete expired entries
    await Promise.all(expired.map((key) => this.delete(key)));

    return expired.length;
  }

  /**
   * Ensure we have space for new data by evicting entries.
   * Priority: expired items first, then LRU (oldest lastAccessedAt).
   */
  private async ensureSpace(needed: number): Promise<void> {
    if (this.totalSize + needed <= this.maxSize) return;

    const target = this.totalSize + needed - this.maxSize;
    let freed = 0;
    const now = Date.now();

    // First pass: collect and delete all expired entries
    const expiredKeys = Array.from(this.index.entries())
      .filter(([, entry]) => entry.expiresAt !== null && entry.expiresAt <= now)
      .map(([key]) => key);

    for (const key of expiredKeys) {
      if (freed >= target) return;
      freed += await this.evictKey(key);
    }

    // Second pass: evict oldest entries until we have enough space
    while (freed < target && this.index.size > 0) {
      const oldestKey = this.findOldestKey();
      if (!oldestKey) break;
      freed += await this.evictKey(oldestKey);
    }
  }

  /**
   * Find the key with the oldest lastAccessedAt
   */
  private findOldestKey(): string | null {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.index) {
      if (entry.lastAccessedAt < oldestTime) {
        oldestTime = entry.lastAccessedAt;
        oldestKey = key;
      }
    }
    return oldestKey;
  }

  /**
   * Evict a single key and return the freed size.
   * Calls onEvict callback to notify parent of the eviction.
   */
  private async evictKey(key: string): Promise<number> {
    const entry = this.index.get(key);
    if (!entry) return 0;

    const filePath = this.getFilePath(entry.hash);
    const freedSize = entry.size;

    this.totalSize -= entry.size;
    this.index.delete(key);
    this.hashToKey.delete(entry.hash);

    // Notify parent before disk I/O (wrapped to ensure cleanup completes)
    try {
      this.onEvict?.(key);
    } catch {
      // Callback errors shouldn't fail the eviction
    }

    try {
      await fs.unlink(filePath);
    } catch {
      // File may already be gone
    }

    return freedSize;
  }

  // ============================================
  // Multi-process sync methods
  // ============================================

  /**
   * Get the path to the shared index file
   */
  private getSharedIndexPath(): string {
    return join(this.dir, ".index.json");
  }

  /**
   * Load index from the shared .index.json file.
   * Returns true if successfully loaded, false if file doesn't exist or is invalid.
   * Verifies that files exist on disk to handle crashes during deletion.
   */
  private async loadSharedIndex(): Promise<boolean> {
    if (!this.multiProcess) return false;

    try {
      const content = await fs.readFile(this.getSharedIndexPath(), "utf8");
      const sharedIndex: SharedIndex = JSON.parse(content);

      // Filter out expired entries
      const now = Date.now();
      const nonExpiredEntries = Object.entries(sharedIndex.entries).filter(
        ([, entry]) => entry.expiresAt === null || entry.expiresAt > now,
      );

      // Verify files exist on disk (handles crashes during deletion)
      const verifiedEntries = await this.filterExistingFiles(nonExpiredEntries);

      this.index.clear();
      this.hashToKey.clear();
      this.totalSize = 0;

      for (const [key, entry] of verifiedEntries) {
        const indexEntry: IndexEntry = {
          hash: entry.hash,
          size: entry.size,
          expiresAt: entry.expiresAt,
          lastAccessedAt: entry.lastAccessedAt,
          valueHash: entry.valueHash,
        };

        this.index.set(key, indexEntry);
        this.hashToKey.set(entry.hash, key);
        this.totalSize += entry.size;
      }

      this.indexVersion = sharedIndex.version;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Batch check file existence for multiple entries.
   * Returns entries whose files exist on disk.
   * Processes in batches to avoid overwhelming the filesystem.
   */
  private async filterExistingFiles<T extends { hash: string }>(
    entries: [string, T][],
  ): Promise<Map<string, T>> {
    const BATCH_SIZE = 100;
    const existing = new Map<string, T>();

    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE);
      const checks = batch.map(async ([key, entry]) => {
        const filePath = this.getFilePath(entry.hash);
        try {
          await fs.access(filePath);
          return [key, entry] as const;
        } catch {
          return null;
        }
      });

      const results = await Promise.all(checks);
      for (const result of results) {
        if (result) {
          existing.set(result[0], result[1]);
        }
      }
    }

    return existing;
  }

  /**
   * Write the current index to the shared .index.json file.
   * Merges with existing shared index to preserve entries from other processes.
   * Uses optimistic concurrency with retry to handle concurrent writers.
   */
  private async writeSharedIndex(): Promise<void> {
    const MAX_RETRIES = 3;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      // Read existing shared index to merge with
      let existingIndex: SharedIndex | null = null;
      try {
        const content = await fs.readFile(this.getSharedIndexPath(), "utf8");
        existingIndex = JSON.parse(content);
      } catch {
        // No existing index or invalid JSON - start fresh
      }

      // Start with existing entries, then overlay our local index
      const entries: Record<string, SharedIndexEntry> = {};

      // Add existing entries from other processes (entries we don't have locally)
      // Only verify foreign entries - our local entries are known to exist
      if (existingIndex) {
        const foreignEntries = Object.entries(existingIndex.entries).filter(
          ([key]) => !this.index.has(key),
        );
        const verified = await this.filterExistingFiles(foreignEntries);
        for (const [key, entry] of verified) {
          entries[key] = entry;
        }
      }

      // Add/update our entries (these are known to be current, no verification needed)
      for (const [key, entry] of this.index) {
        entries[key] = {
          hash: entry.hash,
          size: entry.size,
          expiresAt: entry.expiresAt,
          lastAccessedAt: entry.lastAccessedAt,
          valueHash: entry.valueHash,
        };
      }

      const newVersion = (existingIndex?.version ?? 0) + 1;

      const sharedIndex: SharedIndex = {
        version: newVersion,
        entries,
      };

      const content = JSON.stringify(sharedIndex);
      await this.atomicWrite(this.getSharedIndexPath(), Buffer.from(content, "utf8"));

      // Verify our write wasn't immediately overwritten by another process
      try {
        const verifyContent = await fs.readFile(this.getSharedIndexPath(), "utf8");
        const verifyIndex: SharedIndex = JSON.parse(verifyContent);

        if (verifyIndex.version === newVersion) {
          // Success - our write persisted
          this.indexVersion = newVersion;
          this.indexDirty = false;
          return;
        }

        // Another process overwrote our changes - check if our entries are present.
        // We only verify key presence, not valueHash, because:
        // 1. Same key = same file path (hash is based on key, not value)
        // 2. If another process wrote a different value for our key, that's expected
        //    last-write-wins behavior at the file system level
        // 3. The goal is to ensure our keys weren't completely lost from the index
        const ourKeysPresent = Array.from(this.index.keys()).every(
          (key) => verifyIndex.entries[key] !== undefined,
        );

        if (ourKeysPresent) {
          // Our keys are in the index (possibly with updated valueHash from another process)
          // Accept the merged state - next sync will reconcile any differences
          this.indexVersion = verifyIndex.version;
          this.indexDirty = false;
          return;
        }

        // Our entries were lost - retry
        if (attempt < MAX_RETRIES - 1) {
          // Exponential backoff with jitter
          const backoffMs = Math.min(10 * Math.pow(2, attempt) + Math.random() * 10, 100);
          await new Promise((r) => setTimeout(r, backoffMs));
        }
      } catch {
        // Verify read failed - assume success (best effort)
        this.indexVersion = newVersion;
        this.indexDirty = false;
        return;
      }
    }

    // Exhausted retries - accept current state (best effort)
    this.indexDirty = false;
  }

  // Track when debouncing started for max wait enforcement
  private debounceStartTime?: number;

  /**
   * Schedule a debounced index write.
   * Writes are debounced to reduce disk I/O when many mutations happen quickly.
   * Uses true debounce (resets timer on each write) with a max wait time.
   */
  private scheduleIndexWrite(): void {
    if (!this.multiProcess) return;

    this.indexDirty = true;

    const debounceMs = Math.min(100, this.syncInterval);
    const maxWaitMs = this.syncInterval;

    // Track when we started debouncing (for max wait enforcement)
    if (!this.debounceStartTime) {
      this.debounceStartTime = Date.now();
    }

    // Check if we've waited too long - if so, write immediately
    const elapsed = Date.now() - this.debounceStartTime;
    if (elapsed >= maxWaitMs) {
      if (this.indexWriteTimer) {
        clearTimeout(this.indexWriteTimer);
        this.indexWriteTimer = undefined;
      }
      this.debounceStartTime = undefined;
      this.pendingIndexWrite = this.executeIndexWrite();
      return;
    }

    // Reset the timer on each write (true debounce behavior)
    if (this.indexWriteTimer) {
      clearTimeout(this.indexWriteTimer);
    }

    this.indexWriteTimer = setTimeout(() => {
      this.indexWriteTimer = undefined;
      this.debounceStartTime = undefined;
      this.pendingIndexWrite = this.executeIndexWrite();
    }, debounceMs);
    this.indexWriteTimer.unref();
  }

  /**
   * Execute the actual index write, calling onBeforeSync first to flush pending writes.
   */
  private async executeIndexWrite(): Promise<void> {
    if (!this.indexDirty) return;

    try {
      // Flush pending writes first to ensure index reflects disk state
      await this.onBeforeSync?.();
      await this.writeSharedIndex();
    } catch {
      // Index write failures are non-fatal
    }
  }

  /**
   * Sync with the shared index file.
   * Uses a mutex to prevent concurrent syncs from racing.
   */
  async sync(): Promise<void> {
    // If a sync is already in progress, wait for it instead of starting another
    if (this.syncInProgress) {
      return this.syncInProgress;
    }

    this.syncInProgress = this.doSync();
    try {
      await this.syncInProgress;
    } finally {
      this.syncInProgress = undefined;
    }
  }

  /**
   * Internal sync implementation.
   * 1. Flush pending writes
   * 2. Write local changes if dirty
   * 3. Read and merge changes from other processes
   */
  private async doSync(): Promise<void> {
    await this.init();

    // Flush pending writes from cache layer
    await this.onBeforeSync?.();

    // Wait for any pending index write
    if (this.pendingIndexWrite) {
      await this.pendingIndexWrite;
    }

    // Write our changes if dirty
    if (this.indexDirty) {
      await this.writeSharedIndex();
    }

    // Read and merge changes from other processes
    await this.mergeSharedIndex();
  }

  /**
   * Read the shared index and merge changes from other processes.
   */
  private async mergeSharedIndex(): Promise<void> {
    try {
      const content = await fs.readFile(this.getSharedIndexPath(), "utf8");
      const sharedIndex: SharedIndex = JSON.parse(content);

      // If our version is current, nothing to merge
      if (sharedIndex.version <= this.indexVersion) return;

      const sharedKeys = new Set(Object.keys(sharedIndex.entries));
      const now = Date.now();

      // Filter out expired entries
      const nonExpiredEntries = Object.entries(sharedIndex.entries).filter(
        ([, entry]) => entry.expiresAt === null || entry.expiresAt > now,
      );

      // Only verify foreign entries - entries we have locally are known to exist
      // (either our version or another process's version at the same path)
      const foreignEntries = nonExpiredEntries.filter(([key]) => !this.index.has(key));
      const localEntries = nonExpiredEntries.filter(([key]) => this.index.has(key));
      const verifiedForeignEntries = await this.filterExistingFiles(foreignEntries);

      // Combine verified foreign entries with local entries (no verification needed)
      const allEntries = new Map<string, SharedIndexEntry>([
        ...verifiedForeignEntries,
        ...localEntries.map(([key, entry]) => [key, entry] as const),
      ]);

      // Add/update entries from shared index
      for (const [key, entry] of allEntries) {
        const existing = this.index.get(key);
        if (!existing) {
          // New key from another process
          const indexEntry: IndexEntry = {
            hash: entry.hash,
            size: entry.size,
            expiresAt: entry.expiresAt,
            lastAccessedAt: entry.lastAccessedAt,
            valueHash: entry.valueHash,
          };
          this.index.set(key, indexEntry);
          this.hashToKey.set(entry.hash, key);
          this.totalSize += entry.size;
        } else {
          // Key exists - check if the value changed (different valueHash)
          const valueChanged = entry.valueHash && existing.valueHash !== entry.valueHash;
          if (valueChanged) {
            // Value was overwritten by another process - invalidate memory cache
            existing.valueHash = entry.valueHash;
            // Notify parent to invalidate stale memory cache
            try {
              this.onInvalidate?.(key);
            } catch {
              // Callback errors shouldn't fail the merge
            }
          }
          // Update metadata from shared index
          this.totalSize -= existing.size;
          this.totalSize += entry.size;
          existing.size = entry.size;
          existing.expiresAt = entry.expiresAt;
          // Keep local lastAccessedAt if more recent
          if (entry.lastAccessedAt > existing.lastAccessedAt) {
            existing.lastAccessedAt = entry.lastAccessedAt;
          }
        }
      }

      // Remove keys from local index if they're not in shared index
      // and the file doesn't exist on disk (deleted by another process)
      const keysNotInShared: [string, IndexEntry][] = [];
      for (const [key, entry] of this.index) {
        if (!sharedKeys.has(key)) {
          keysNotInShared.push([key, entry]);
        }
      }

      // Batch check which files still exist
      const stillExisting = await this.filterExistingFiles(keysNotInShared);
      const keysToRemove = keysNotInShared
        .filter(([key]) => !stillExisting.has(key))
        .map(([key]) => key);

      for (const key of keysToRemove) {
        const entry = this.index.get(key);
        if (entry) {
          this.totalSize -= entry.size;
          this.index.delete(key);
          this.hashToKey.delete(entry.hash);
          // Notify parent about the removal
          try {
            this.onEvict?.(key);
          } catch {
            // Callback errors shouldn't fail the merge
          }
        }
      }

      this.indexVersion = sharedIndex.version;
    } catch {
      // Merge failures are non-fatal - we'll try again on next sync
    }
  }

  /**
   * Mark the index as dirty, scheduling a write if sync is enabled.
   */
  markIndexDirty(): void {
    this.scheduleIndexWrite();
  }

  /**
   * Stop sync timer and flush pending index writes.
   */
  async close(): Promise<void> {
    // Stop timers first to prevent new syncs from starting
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = undefined;
    }

    if (this.indexWriteTimer) {
      clearTimeout(this.indexWriteTimer);
      this.indexWriteTimer = undefined;
    }

    // Wait for any in-progress sync to complete before final write
    if (this.syncInProgress) {
      await this.syncInProgress;
    }

    // Wait for any pending index write to complete
    if (this.pendingIndexWrite) {
      await this.pendingIndexWrite;
    }

    // Final index write if still dirty after waiting
    if (this.indexDirty && this.multiProcess) {
      await this.onBeforeSync?.();
      await this.writeSharedIndex();
    }
  }
}
