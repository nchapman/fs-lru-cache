import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { CacheEntry } from './types.js';
import { hashKey, getShardIndex, getShardName, isExpired, matchPattern } from './utils.js';

export interface FileStoreOptions {
  dir: string;
  shards: number;
  maxSize: number;
}

interface IndexEntry {
  hash: string;
  expiresAt: number | null;
  lastAccessedAt: number;
  size: number;
}

/**
 * File system storage layer with sharding and in-memory index
 */
export class FileStore {
  private readonly dir: string;
  private readonly shards: number;
  private readonly maxSize: number;
  private initialized = false;

  // In-memory index: key -> metadata (no values, just for fast lookups)
  private index: Map<string, IndexEntry> = new Map();
  private totalSize = 0;

  constructor(options: FileStoreOptions) {
    this.dir = options.dir;
    this.shards = options.shards;
    this.maxSize = options.maxSize;
  }

  /**
   * Initialize the cache directory structure and load index
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    await fs.mkdir(this.dir, { recursive: true });

    // Create shard directories
    for (let i = 0; i < this.shards; i++) {
      const shardDir = join(this.dir, getShardName(i));
      await fs.mkdir(shardDir, { recursive: true });
    }

    // Load index from existing files
    await this.loadIndex();

    this.initialized = true;
  }

  /**
   * Load index from disk (scans all files once on startup)
   */
  private async loadIndex(): Promise<void> {
    this.index.clear();
    this.totalSize = 0;

    for (let i = 0; i < this.shards; i++) {
      const shardDir = join(this.dir, getShardName(i));

      try {
        const files = await fs.readdir(shardDir);

        for (const file of files) {
          if (!file.endsWith('.json')) continue;

          const filePath = join(shardDir, file);
          try {
            const [stat, content] = await Promise.all([
              fs.stat(filePath),
              fs.readFile(filePath, 'utf8'),
            ]);
            const data: CacheEntry = JSON.parse(content);

            // Skip expired entries (clean them up)
            if (isExpired(data.expiresAt)) {
              await fs.unlink(filePath).catch(() => {});
              continue;
            }

            const hash = file.replace('.json', '');
            this.index.set(data.key, {
              hash,
              expiresAt: data.expiresAt,
              lastAccessedAt: stat.mtimeMs, // Use mtime for existing files
              size: stat.size,
            });
            this.totalSize += stat.size;
          } catch {
            // Skip invalid files
          }
        }
      } catch {
        // Shard dir doesn't exist yet
      }
    }
  }

  /**
   * Get the file path for a key
   */
  private getFilePath(key: string): string {
    const shardIndex = getShardIndex(key, this.shards);
    const shardName = getShardName(shardIndex);
    const hash = hashKey(key);
    return join(this.dir, shardName, `${hash}.json`);
  }

  /**
   * Get the file path using a hash directly
   */
  private getFilePathFromHash(hash: string, key: string): string {
    const shardIndex = getShardIndex(key, this.shards);
    const shardName = getShardName(shardIndex);
    return join(this.dir, shardName, `${hash}.json`);
  }

  /**
   * Generate a temporary file path for atomic writes
   */
  private getTempPath(): string {
    const id = randomBytes(8).toString('hex');
    return join(tmpdir(), `fslru-${id}.tmp`);
  }

  /**
   * Atomic file write: write to temp, then rename
   */
  private async atomicWrite(filePath: string, content: string): Promise<void> {
    const tempPath = this.getTempPath();
    try {
      await fs.writeFile(tempPath, content, 'utf8');
      await fs.rename(tempPath, filePath);
    } catch (err) {
      // Clean up temp file on failure
      await fs.unlink(tempPath).catch(() => {});
      throw err;
    }
  }

  /**
   * Get a value from disk
   * Returns the full cache entry (key, value, expiresAt) for consistency
   */
  async get<T = unknown>(key: string): Promise<CacheEntry<T> | null> {
    await this.init();

    const indexEntry = this.index.get(key);
    if (!indexEntry) return null;

    // Check expiry from index first (fast path)
    if (isExpired(indexEntry.expiresAt)) {
      await this.delete(key);
      return null;
    }

    const filePath = this.getFilePathFromHash(indexEntry.hash, key);

    try {
      const content = await fs.readFile(filePath, 'utf8');
      const entry: CacheEntry<T> = JSON.parse(content);

      // Verify the key matches (in case of hash collision)
      if (entry.key !== key) {
        // Hash collision - remove from index, file belongs to different key
        this.index.delete(key);
        return null;
      }

      // Update lastAccessedAt in index (for LRU tracking)
      indexEntry.lastAccessedAt = Date.now();

      return entry;
    } catch {
      // File missing or corrupted - remove from index
      this.totalSize -= indexEntry.size;
      this.index.delete(key);
      return null;
    }
  }

  /**
   * Get entry metadata without updating access time
   */
  async peek(key: string): Promise<CacheEntry | null> {
    await this.init();

    const indexEntry = this.index.get(key);
    if (!indexEntry) return null;

    if (isExpired(indexEntry.expiresAt)) {
      await this.delete(key);
      return null;
    }

    const filePath = this.getFilePathFromHash(indexEntry.hash, key);

    try {
      const content = await fs.readFile(filePath, 'utf8');
      const entry: CacheEntry = JSON.parse(content);

      if (entry.key !== key) return null;

      return entry;
    } catch {
      this.totalSize -= indexEntry.size;
      this.index.delete(key);
      return null;
    }
  }

  /**
   * Set a value on disk with atomic write
   * @param content Optional pre-serialized content (to avoid double serialization)
   */
  async set<T = unknown>(
    key: string,
    value: T,
    expiresAt: number | null = null,
    content?: string
  ): Promise<void> {
    await this.init();

    const entry: CacheEntry<T> = { key, value, expiresAt };
    const serialized = content ?? JSON.stringify(entry);
    const size = Buffer.byteLength(serialized, 'utf8');
    const hash = hashKey(key);
    const filePath = this.getFilePath(key);

    // Remove old entry size from total if exists
    const existing = this.index.get(key);
    if (existing) {
      this.totalSize -= existing.size;
    }

    // Check if we need to evict
    await this.ensureSpace(size);

    // Atomic write
    await this.atomicWrite(filePath, serialized);

    // Update index
    this.index.set(key, {
      hash,
      expiresAt,
      lastAccessedAt: Date.now(),
      size,
    });
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

    // Update index first
    this.totalSize -= indexEntry.size;
    this.index.delete(key);

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

    const indexEntry = this.index.get(key);
    if (!indexEntry) return false;

    if (isExpired(indexEntry.expiresAt)) {
      await this.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Get all keys matching a pattern (fast - uses index)
   */
  async keys(pattern = '*'): Promise<string[]> {
    await this.init();

    const result: string[] = [];
    const toDelete: string[] = [];

    for (const [key, entry] of this.index) {
      if (isExpired(entry.expiresAt)) {
        toDelete.push(key);
        continue;
      }
      if (matchPattern(key, pattern)) {
        result.push(key);
      }
    }

    // Clean up expired entries
    for (const key of toDelete) {
      await this.delete(key);
    }

    return result;
  }

  /**
   * Update expiration time for a key
   */
  async setExpiry(key: string, expiresAt: number | null): Promise<boolean> {
    await this.init();

    const indexEntry = this.index.get(key);
    if (!indexEntry) return false;

    if (isExpired(indexEntry.expiresAt)) {
      await this.delete(key);
      return false;
    }

    const filePath = this.getFilePathFromHash(indexEntry.hash, key);

    try {
      const content = await fs.readFile(filePath, 'utf8');
      const entry: CacheEntry = JSON.parse(content);

      if (entry.key !== key) return false;

      entry.expiresAt = expiresAt;
      const serialized = JSON.stringify(entry);

      await this.atomicWrite(filePath, serialized);

      // Update index
      indexEntry.expiresAt = expiresAt;
      indexEntry.size = Buffer.byteLength(serialized, 'utf8');

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get TTL for a key in milliseconds (fast - uses index)
   */
  async getTtl(key: string): Promise<number> {
    await this.init();

    const indexEntry = this.index.get(key);
    if (!indexEntry) return -2;

    if (isExpired(indexEntry.expiresAt)) {
      await this.delete(key);
      return -2;
    }

    if (indexEntry.expiresAt === null) return -1;
    return Math.max(0, indexEntry.expiresAt - Date.now());
  }

  /**
   * Clear all entries
   */
  async clear(): Promise<void> {
    await this.init();

    for (let i = 0; i < this.shards; i++) {
      const shardDir = join(this.dir, getShardName(i));

      try {
        const files = await fs.readdir(shardDir);
        await Promise.all(
          files.map((file) => fs.unlink(join(shardDir, file)).catch(() => {}))
        );
      } catch {
        // Ignore errors
      }
    }

    this.index.clear();
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
   * Ensure we have space for new data by evicting entries
   * Priority: expired items first, then LRU (oldest lastAccessedAt)
   */
  private async ensureSpace(needed: number): Promise<void> {
    if (this.totalSize + needed <= this.maxSize) return;

    const now = Date.now();

    // Sort entries: expired first, then by lastAccessedAt (oldest first)
    const entries = Array.from(this.index.entries()).sort(([, a], [, b]) => {
      const aExpired = a.expiresAt !== null && a.expiresAt <= now;
      const bExpired = b.expiresAt !== null && b.expiresAt <= now;

      if (aExpired && !bExpired) return -1;
      if (!aExpired && bExpired) return 1;

      return a.lastAccessedAt - b.lastAccessedAt;
    });

    let freed = 0;
    const target = this.totalSize + needed - this.maxSize;

    for (const [key] of entries) {
      if (freed >= target) break;

      const entry = this.index.get(key);
      if (!entry) continue;

      const filePath = this.getFilePathFromHash(entry.hash, key);

      try {
        await fs.unlink(filePath);
        freed += entry.size;
        this.totalSize -= entry.size;
        this.index.delete(key);
      } catch {
        // Ignore deletion errors
      }
    }
  }
}
