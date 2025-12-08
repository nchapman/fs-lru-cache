import { promises as fs } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import { gzipSync, gunzipSync } from "zlib";
import { CacheEntry } from "./types.js";
import {
  hashKey,
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
   * Called synchronously when a key is evicted due to:
   * - Hash collision (another key claims the same hash)
   * - Space pressure (LRU eviction to stay under maxSize)
   *
   * NOT called for explicit delete() operations.
   * This allows the parent to keep other caches in sync.
   */
  onEvict?: (key: string) => void;
}

interface IndexEntry {
  hash: string;
  expiresAt: number | null;
  lastAccessedAt: number;
  size: number;
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
  private initialized = false;

  // In-memory index: key -> metadata (no values, just for fast lookups)
  private index = new Map<string, IndexEntry>();
  // Reverse mapping: hash -> key (to detect collisions)
  private hashToKey = new Map<string, string>();
  private totalSize = 0;

  constructor(options: FileStoreOptions) {
    this.dir = options.dir;
    this.shards = options.shards;
    this.maxSize = options.maxSize;
    this.gzip = options.gzip ?? false;
    this.onEvict = options.onEvict;
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
  private compress(data: string): Buffer {
    const buffer = Buffer.from(data, "utf8");
    return this.gzip ? gzipSync(buffer) : buffer;
  }

  /**
   * Decompress data, auto-detecting if it's compressed.
   */
  private decompress(data: Buffer): string {
    if (this.isCompressed(data)) {
      return gunzipSync(data).toString("utf8");
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

    await this.loadIndex();
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
        if (!file.endsWith(".json")) continue;
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
      const content = this.decompress(rawContent);
      const data: CacheEntry = JSON.parse(content);

      if (isExpired(data.expiresAt)) {
        await fs.unlink(filePath).catch(() => {});
        return;
      }

      const hash = file.replace(".json", "");
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
   * Get the file path for a key
   */
  private getFilePath(key: string): string {
    const shardName = getShardName(getShardIndex(key, this.shards));
    return join(this.dir, shardName, `${hashKey(key)}.json`);
  }

  /**
   * Get the file path using a hash directly
   */
  private getFilePathFromHash(hash: string, key: string): string {
    const shardName = getShardName(getShardIndex(key, this.shards));
    return join(this.dir, shardName, `${hash}.json`);
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
    const filePath = this.getFilePathFromHash(indexEntry.hash, key);

    try {
      const rawContent = await fs.readFile(filePath);
      const content = this.decompress(rawContent);
      const entry: CacheEntry<T> = JSON.parse(content);

      // Verify key matches (hash collision check)
      if (entry.key !== key) {
        this.index.delete(key);
        return null;
      }
      return entry;
    } catch {
      // File missing or corrupted
      this.totalSize -= indexEntry.size;
      this.index.delete(key);
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

    const entry: CacheEntry<T> = { key, value, expiresAt };
    const serialized = content ?? JSON.stringify(entry);
    const compressed = this.compress(serialized);
    const size = compressed.length;
    const hash = hashKey(key);
    const filePath = this.getFilePath(key);

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
    });
    this.hashToKey.set(hash, key);
    this.totalSize += size;
  }

  /**
   * Delete a key from disk
   */
  async delete(key: string): Promise<boolean> {
    await this.init();

    const indexEntry = this.index.get(key);
    if (!indexEntry) return false;

    const filePath = this.getFilePathFromHash(indexEntry.hash, key);

    // Update index first (before I/O)
    this.totalSize -= indexEntry.size;
    this.index.delete(key);
    this.hashToKey.delete(indexEntry.hash);

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

    const filePath = this.getFilePathFromHash(indexEntry.hash, key);

    try {
      const rawContent = await fs.readFile(filePath);
      const content = this.decompress(rawContent);
      const entry: CacheEntry = JSON.parse(content);

      if (entry.key !== key) return false;

      entry.expiresAt = expiresAt;
      const serialized = JSON.stringify(entry);
      const compressed = this.compress(serialized);
      await this.atomicWrite(filePath, compressed);

      // Update index
      const newSize = compressed.length;
      this.totalSize += newSize - indexEntry.size;
      indexEntry.expiresAt = expiresAt;
      indexEntry.size = newSize;

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
   * Touch a key: update last accessed time and optionally update TTL.
   * If expiresAt is provided, rewrites the file with new expiry.
   * If not provided, only updates the in-memory index (fast path).
   */
  async touch(key: string, expiresAt?: number | null): Promise<boolean> {
    await this.init();

    const indexEntry = await this.getValidIndexEntry(key);
    if (!indexEntry) return false;

    // Always update last accessed time
    indexEntry.lastAccessedAt = Date.now();

    // If new expiry provided, need to rewrite file
    if (expiresAt !== undefined) {
      const filePath = this.getFilePathFromHash(indexEntry.hash, key);

      try {
        const rawContent = await fs.readFile(filePath);
        const content = this.decompress(rawContent);
        const entry: CacheEntry = JSON.parse(content);

        if (entry.key !== key) return false;

        entry.expiresAt = expiresAt;
        const serialized = JSON.stringify(entry);
        const compressed = this.compress(serialized);
        await this.atomicWrite(filePath, compressed);

        // Update index
        const newSize = compressed.length;
        this.totalSize += newSize - indexEntry.size;
        indexEntry.expiresAt = expiresAt;
        indexEntry.size = newSize;
      } catch {
        return false;
      }
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

    const filePath = this.getFilePathFromHash(entry.hash, key);
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
}
