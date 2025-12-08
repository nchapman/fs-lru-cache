import { CacheOptions, DEFAULT_OPTIONS } from './types.js';
import { MemoryStore } from './memory-store.js';
import { FileStore } from './file-store.js';

/**
 * FsLruCache - A Redis-like LRU cache with file system persistence
 *
 * Features:
 * - Two-tier storage: hot items in memory, all items on disk
 * - Memory-first reads for fast access to frequently used data
 * - Write-through to disk for durability
 * - LRU eviction in both memory and disk stores
 * - TTL support with lazy expiration
 */
export class FsLruCache {
  private readonly memory: MemoryStore;
  private readonly files: FileStore;

  constructor(options: CacheOptions = {}) {
    const opts = { ...DEFAULT_OPTIONS, ...options };

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
      return memValue;
    }

    // Check disk
    const diskValue = await this.files.get<T>(key);
    if (diskValue !== null) {
      // Promote to memory
      const entry = await this.files.peek(key);
      if (entry) {
        this.memory.set(key, diskValue, entry.expiresAt);
      }
      return diskValue;
    }

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

    // Write to both stores
    this.memory.set(key, value, expiresAt);
    await this.files.set(key, value, expiresAt);
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
    // No resources to clean up currently
    // Future: could flush pending writes, etc.
  }
}
