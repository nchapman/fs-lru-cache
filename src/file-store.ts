import { promises as fs } from 'fs';
import { join } from 'path';
import { CacheEntry } from './types.js';
import { hashKey, getShardIndex, getShardName, isExpired, matchPattern } from './utils.js';

export interface FileStoreOptions {
  dir: string;
  shards: number;
  maxSize: number;
}

interface FileInfo {
  path: string;
  key: string;
  size: number;
  mtime: number;
}

/**
 * File system storage layer with sharding
 */
export class FileStore {
  private readonly dir: string;
  private readonly shards: number;
  private readonly maxSize: number;
  private initialized = false;

  constructor(options: FileStoreOptions) {
    this.dir = options.dir;
    this.shards = options.shards;
    this.maxSize = options.maxSize;
  }

  /**
   * Initialize the cache directory structure
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    await fs.mkdir(this.dir, { recursive: true });

    // Create shard directories
    for (let i = 0; i < this.shards; i++) {
      const shardDir = join(this.dir, getShardName(i));
      await fs.mkdir(shardDir, { recursive: true });
    }

    this.initialized = true;
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
   * Get a value from disk
   */
  async get<T = unknown>(key: string): Promise<T | null> {
    await this.init();

    const filePath = this.getFilePath(key);

    try {
      const content = await fs.readFile(filePath, 'utf8');
      const entry: CacheEntry<T> = JSON.parse(content);

      // Verify the key matches (in case of hash collision)
      if (entry.key !== key) return null;

      if (isExpired(entry.expiresAt)) {
        await this.delete(key);
        return null;
      }

      // Update mtime for LRU tracking
      const now = new Date();
      await fs.utimes(filePath, now, now).catch(() => {});

      return entry.value;
    } catch {
      return null;
    }
  }

  /**
   * Get entry metadata without updating mtime
   */
  async peek(key: string): Promise<CacheEntry | null> {
    await this.init();

    const filePath = this.getFilePath(key);

    try {
      const content = await fs.readFile(filePath, 'utf8');
      const entry: CacheEntry = JSON.parse(content);

      if (entry.key !== key) return null;

      if (isExpired(entry.expiresAt)) {
        await this.delete(key);
        return null;
      }

      return entry;
    } catch {
      return null;
    }
  }

  /**
   * Set a value on disk
   */
  async set<T = unknown>(key: string, value: T, expiresAt: number | null = null): Promise<void> {
    await this.init();

    const entry: CacheEntry<T> = { key, value, expiresAt };
    const content = JSON.stringify(entry);
    const filePath = this.getFilePath(key);

    // Check if we need to evict
    await this.ensureSpace(Buffer.byteLength(content, 'utf8'));

    await fs.writeFile(filePath, content, 'utf8');
  }

  /**
   * Delete a key from disk
   */
  async delete(key: string): Promise<boolean> {
    await this.init();

    const filePath = this.getFilePath(key);

    try {
      await fs.unlink(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if a key exists on disk
   */
  async has(key: string): Promise<boolean> {
    await this.init();

    const entry = await this.peek(key);
    return entry !== null;
  }

  /**
   * Get all keys matching a pattern
   */
  async keys(pattern = '*'): Promise<string[]> {
    await this.init();

    const result: string[] = [];

    for (let i = 0; i < this.shards; i++) {
      const shardDir = join(this.dir, getShardName(i));

      try {
        const files = await fs.readdir(shardDir);

        for (const file of files) {
          if (!file.endsWith('.json')) continue;

          const filePath = join(shardDir, file);
          try {
            const content = await fs.readFile(filePath, 'utf8');
            const entry: CacheEntry = JSON.parse(content);

            if (isExpired(entry.expiresAt)) {
              await fs.unlink(filePath).catch(() => {});
              continue;
            }

            if (matchPattern(entry.key, pattern)) {
              result.push(entry.key);
            }
          } catch {
            // Skip invalid files
          }
        }
      } catch {
        // Skip if shard dir doesn't exist
      }
    }

    return result;
  }

  /**
   * Update expiration time for a key
   */
  async setExpiry(key: string, expiresAt: number | null): Promise<boolean> {
    await this.init();

    const filePath = this.getFilePath(key);

    try {
      const content = await fs.readFile(filePath, 'utf8');
      const entry: CacheEntry = JSON.parse(content);

      if (entry.key !== key) return false;

      if (isExpired(entry.expiresAt)) {
        await this.delete(key);
        return false;
      }

      entry.expiresAt = expiresAt;
      await fs.writeFile(filePath, JSON.stringify(entry), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get TTL for a key in milliseconds
   */
  async getTtl(key: string): Promise<number> {
    const entry = await this.peek(key);
    if (!entry) return -2;
    if (entry.expiresAt === null) return -1;
    return Math.max(0, entry.expiresAt - Date.now());
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
  }

  /**
   * Get total size of cache on disk
   */
  async getSize(): Promise<number> {
    await this.init();

    let total = 0;

    for (let i = 0; i < this.shards; i++) {
      const shardDir = join(this.dir, getShardName(i));

      try {
        const files = await fs.readdir(shardDir);

        for (const file of files) {
          try {
            const stat = await fs.stat(join(shardDir, file));
            total += stat.size;
          } catch {
            // Ignore
          }
        }
      } catch {
        // Ignore
      }
    }

    return total;
  }

  /**
   * Ensure we have space for new data by evicting LRU entries
   */
  private async ensureSpace(needed: number): Promise<void> {
    const currentSize = await this.getSize();
    if (currentSize + needed <= this.maxSize) return;

    // Get all files sorted by mtime (oldest first)
    const files = await this.getAllFiles();
    files.sort((a, b) => a.mtime - b.mtime);

    let freed = 0;
    const target = currentSize + needed - this.maxSize;

    for (const file of files) {
      if (freed >= target) break;

      try {
        await fs.unlink(file.path);
        freed += file.size;
      } catch {
        // Ignore
      }
    }
  }

  /**
   * Get info about all cache files
   */
  private async getAllFiles(): Promise<FileInfo[]> {
    const files: FileInfo[] = [];

    for (let i = 0; i < this.shards; i++) {
      const shardDir = join(this.dir, getShardName(i));

      try {
        const entries = await fs.readdir(shardDir);

        for (const entry of entries) {
          if (!entry.endsWith('.json')) continue;

          const filePath = join(shardDir, entry);
          try {
            const [stat, content] = await Promise.all([
              fs.stat(filePath),
              fs.readFile(filePath, 'utf8'),
            ]);
            const data: CacheEntry = JSON.parse(content);

            files.push({
              path: filePath,
              key: data.key,
              size: stat.size,
              mtime: stat.mtimeMs,
            });
          } catch {
            // Skip invalid files
          }
        }
      } catch {
        // Ignore
      }
    }

    return files;
  }
}
