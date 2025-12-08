import { MemoryEntry } from './types.js';
import { estimateSize, isExpired, compilePattern, matchPattern } from './utils.js';

export interface MemoryStoreOptions {
  maxItems: number;
  maxSize: number;
}

/**
 * In-memory LRU cache using Map for O(1) operations.
 * Map maintains insertion order, enabling LRU tracking via re-insertion.
 */
export class MemoryStore {
  private cache = new Map<string, MemoryEntry>();
  private currentSize = 0;
  private readonly maxItems: number;
  private readonly maxSize: number;

  constructor(options: MemoryStoreOptions) {
    this.maxItems = options.maxItems;
    this.maxSize = options.maxSize;
  }

  /**
   * Get entry if it exists and isn't expired, removing expired entries.
   * Returns null if not found or expired.
   */
  private getValidEntry(key: string): MemoryEntry | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (isExpired(entry.expiresAt)) {
      this.delete(key);
      return null;
    }
    return entry;
  }

  /**
   * Get a value from the cache.
   * Promotes the key to most recently used on access.
   */
  get<T = unknown>(key: string): T | null {
    const entry = this.getValidEntry(key);
    if (!entry) return null;

    // Promote to most recently used by re-inserting
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value as T;
  }

  /**
   * Get entry metadata without promoting (peek doesn't affect LRU order)
   */
  peek(key: string): MemoryEntry | null {
    return this.getValidEntry(key);
  }

  /**
   * Set a value in the cache
   */
  set<T = unknown>(key: string, value: T, expiresAt: number | null = null): void {
    if (this.cache.has(key)) {
      this.delete(key);
    }

    const size = estimateSize(value);
    const entry: MemoryEntry<T> = { key, value, expiresAt, size };

    // Evict until we have space
    while (this.needsEviction(size)) {
      this.evictOne();
    }

    this.cache.set(key, entry);
    this.currentSize += size;
  }

  /**
   * Delete a key from the cache
   */
  delete(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    this.cache.delete(key);
    this.currentSize -= entry.size;
    return true;
  }

  /**
   * Check if a key exists (and is not expired)
   */
  has(key: string): boolean {
    return this.getValidEntry(key) !== null;
  }

  /**
   * Get all keys matching a pattern
   */
  keys(pattern = '*'): string[] {
    const compiled = compilePattern(pattern);
    const result: string[] = [];

    for (const [key, entry] of this.cache) {
      if (isExpired(entry.expiresAt)) {
        this.delete(key);
      } else if (matchPattern(key, compiled)) {
        result.push(key);
      }
    }

    return result;
  }

  /**
   * Update expiration time for a key
   */
  setExpiry(key: string, expiresAt: number | null): boolean {
    const entry = this.getValidEntry(key);
    if (!entry) return false;

    entry.expiresAt = expiresAt;
    return true;
  }

  /**
   * Get TTL for a key in milliseconds.
   * Returns -1 if no expiry, -2 if not found.
   */
  getTtl(key: string): number {
    const entry = this.getValidEntry(key);
    if (!entry) return -2;
    if (entry.expiresAt === null) return -1;
    return Math.max(0, entry.expiresAt - Date.now());
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.cache.clear();
    this.currentSize = 0;
  }

  /**
   * Get current stats
   */
  get stats() {
    return {
      items: this.cache.size,
      size: this.currentSize,
      maxItems: this.maxItems,
      maxSize: this.maxSize,
    };
  }

  /**
   * Check if eviction is needed to accommodate new data
   */
  private needsEviction(newSize: number): boolean {
    return this.cache.size > 0 &&
      (this.cache.size >= this.maxItems || this.currentSize + newSize > this.maxSize);
  }

  /**
   * Evict an entry to make room for new data.
   * Priority: expired items first, then LRU (oldest in map).
   */
  private evictOne(): void {
    // First pass: find an expired entry
    for (const [key, entry] of this.cache) {
      if (isExpired(entry.expiresAt)) {
        this.delete(key);
        return;
      }
    }

    // No expired entries: evict LRU (first entry in map)
    const oldest = this.cache.keys().next().value;
    if (oldest !== undefined) {
      this.delete(oldest);
    }
  }
}
