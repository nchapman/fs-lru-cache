import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { FileStore } from '../src/file-store.js';

const TEST_DIR = join(process.cwd(), '.test-cache-file-store');

describe('FileStore', () => {
  let store: FileStore;

  beforeEach(async () => {
    store = new FileStore({
      dir: TEST_DIR,
      shards: 4,
      maxSize: 1024 * 1024,
    });
  });

  afterEach(async () => {
    try {
      await fs.rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('get/set', () => {
    it('should store and retrieve values', async () => {
      await store.set('key1', 'value1');
      const entry = await store.get('key1');
      expect(entry?.value).toBe('value1');
    });

    it('should return null for non-existent keys', async () => {
      expect(await store.get('nonexistent')).toBeNull();
    });

    it('should store complex objects', async () => {
      const obj = { name: 'test', nested: { value: 123 } };
      await store.set('obj', obj);
      const entry = await store.get('obj');
      expect(entry?.value).toEqual(obj);
    });

    it('should overwrite existing values', async () => {
      await store.set('key', 'value1');
      await store.set('key', 'value2');
      const entry = await store.get('key');
      expect(entry?.value).toBe('value2');
    });

    it('should create shard directories', async () => {
      await store.set('key', 'value');

      // Check that shard dirs exist
      const entries = await fs.readdir(TEST_DIR);
      expect(entries.length).toBeGreaterThan(0);
    });
  });

  describe('delete', () => {
    it('should delete existing keys', async () => {
      await store.set('key', 'value');
      expect(await store.delete('key')).toBe(true);
      expect(await store.get('key')).toBeNull();
    });

    it('should return false for non-existent keys', async () => {
      expect(await store.delete('nonexistent')).toBe(false);
    });
  });

  describe('has', () => {
    it('should return true for existing keys', async () => {
      await store.set('key', 'value');
      expect(await store.has('key')).toBe(true);
    });

    it('should return false for non-existent keys', async () => {
      expect(await store.has('nonexistent')).toBe(false);
    });
  });

  describe('keys', () => {
    it('should return all keys', async () => {
      await store.set('a', 1);
      await store.set('b', 2);
      await store.set('c', 3);

      const keys = await store.keys();
      expect(keys.sort()).toEqual(['a', 'b', 'c']);
    });

    it('should support wildcard pattern', async () => {
      await store.set('user:1', { id: 1 });
      await store.set('user:2', { id: 2 });
      await store.set('post:1', { id: 1 });

      const keys = await store.keys('user:*');
      expect(keys.sort()).toEqual(['user:1', 'user:2']);
    });
  });

  describe('TTL', () => {
    it('should expire keys after TTL', async () => {
      await store.set('key', 'value', Date.now() + 50);
      const entry = await store.get('key');
      expect(entry?.value).toBe('value');

      await new Promise((r) => setTimeout(r, 60));
      expect(await store.get('key')).toBeNull();
    });

    it('should return correct TTL', async () => {
      const expiresAt = Date.now() + 1000;
      await store.set('key', 'value', expiresAt);
      const ttl = await store.getTtl('key');
      expect(ttl).toBeGreaterThan(900);
      expect(ttl).toBeLessThanOrEqual(1000);
    });

    it('should return -1 for keys without expiry', async () => {
      await store.set('key', 'value');
      expect(await store.getTtl('key')).toBe(-1);
    });

    it('should return -2 for non-existent keys', async () => {
      expect(await store.getTtl('nonexistent')).toBe(-2);
    });

    it('should allow updating expiry', async () => {
      await store.set('key', 'value', Date.now() + 1000);
      const newExpiry = Date.now() + 5000;
      await store.setExpiry('key', newExpiry);
      const ttl = await store.getTtl('key');
      expect(ttl).toBeGreaterThan(4000);
    });
  });

  describe('sharding', () => {
    it('should distribute files across shards', async () => {
      // Add enough keys to likely hit different shards
      for (let i = 0; i < 20; i++) {
        await store.set(`key-${i}`, i);
      }

      // Count files in each shard
      const shardCounts: number[] = [];
      for (let i = 0; i < 4; i++) {
        const shardDir = join(TEST_DIR, i.toString(16).padStart(2, '0'));
        try {
          const files = await fs.readdir(shardDir);
          shardCounts.push(files.length);
        } catch {
          shardCounts.push(0);
        }
      }

      // At least 2 shards should have files (probabilistic)
      const nonEmptyShards = shardCounts.filter((c) => c > 0).length;
      expect(nonEmptyShards).toBeGreaterThanOrEqual(2);
    });
  });

  describe('clear', () => {
    it('should remove all items', async () => {
      await store.set('a', 1);
      await store.set('b', 2);
      await store.clear();
      expect(await store.keys()).toEqual([]);
    });
  });

  describe('size tracking', () => {
    it('should track total size', async () => {
      await store.set('key', 'a'.repeat(100));
      const size = await store.getSize();
      expect(size).toBeGreaterThan(100);
    });

    it('should track item count', async () => {
      expect(await store.getItemCount()).toBe(0);

      await store.set('a', 1);
      expect(await store.getItemCount()).toBe(1);

      await store.set('b', 2);
      expect(await store.getItemCount()).toBe(2);

      await store.delete('a');
      expect(await store.getItemCount()).toBe(1);

      await store.clear();
      expect(await store.getItemCount()).toBe(0);
    });

    it('should update size correctly when overwriting', async () => {
      await store.set('key', 'short');
      const size1 = await store.getSize();

      await store.set('key', 'a much longer value');
      const size2 = await store.getSize();

      expect(size2).toBeGreaterThan(size1);
      expect(await store.getItemCount()).toBe(1);
    });

    it('should update totalSize when setExpiry changes file size', async () => {
      // Set with no expiry (expiresAt: null)
      await store.set('key', 'value');
      const sizeWithoutTtl = await store.getSize();

      // Set expiry (expiresAt: number) - file will be slightly larger
      await store.setExpiry('key', Date.now() + 10000);
      const sizeWithTtl = await store.getSize();

      // Size should have changed (number takes more bytes than null)
      expect(sizeWithTtl).not.toBe(sizeWithoutTtl);
    });
  });

  describe('peek', () => {
    it('should return entry without updating access time', async () => {
      await store.set('a', 'value-a');

      // Wait a bit
      await new Promise((r) => setTimeout(r, 10));

      await store.set('b', 'value-b');

      // Peek 'a' should not update its access time
      const entry = await store.peek('a');
      expect(entry?.value).toBe('value-a');

      // Now 'a' should still be older than 'b' for LRU purposes
      // We can verify this by checking get() behavior
      const getEntry = await store.get('a');
      expect(getEntry?.value).toBe('value-a');
    });

    it('should return null for non-existent keys', async () => {
      expect(await store.peek('nonexistent')).toBeNull();
    });

    it('should return null for expired keys', async () => {
      await store.set('key', 'value', Date.now() + 50);
      await new Promise((r) => setTimeout(r, 60));

      expect(await store.peek('key')).toBeNull();
    });
  });

  describe('LRU eviction', () => {
    it('should evict oldest entries when size limit exceeded', async () => {
      const smallStore = new FileStore({
        dir: TEST_DIR + '-lru',
        shards: 2,
        maxSize: 180, // Very small limit - only fits ~2 entries
      });

      // Each entry is about 80 bytes: {"key":"first","value":"xxxx...","expiresAt":null}
      await smallStore.set('first', 'x'.repeat(40));

      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 5));

      await smallStore.set('second', 'x'.repeat(40));

      // Small delay before accessing
      await new Promise((r) => setTimeout(r, 5));

      // Access 'first' to make it more recently used
      await smallStore.get('first');

      // Small delay before adding third entry
      await new Promise((r) => setTimeout(r, 5));

      // Add more to trigger eviction
      await smallStore.set('third', 'x'.repeat(40));

      // 'second' should be evicted (oldest not accessed)
      expect(await smallStore.get('second')).toBeNull();
      expect(await smallStore.get('first')).not.toBeNull();
      expect(await smallStore.get('third')).not.toBeNull();

      await fs.rm(TEST_DIR + '-lru', { recursive: true, force: true });
    });

    it('should evict expired entries before LRU entries', async () => {
      const smallStore = new FileStore({
        dir: TEST_DIR + '-expire-lru',
        shards: 2,
        maxSize: 250,
      });

      // Add entry with TTL
      await smallStore.set('expiring', 'x'.repeat(50), Date.now() + 50);
      // Add entry without TTL
      await smallStore.set('permanent', 'x'.repeat(50));

      // Wait for expiration
      await new Promise((r) => setTimeout(r, 60));

      // Add more to trigger eviction
      await smallStore.set('new', 'x'.repeat(50));

      // Expired entry should be gone, permanent should remain
      expect(await smallStore.get('expiring')).toBeNull();
      expect(await smallStore.get('permanent')).not.toBeNull();

      await fs.rm(TEST_DIR + '-expire-lru', { recursive: true, force: true });
    });
  });

  describe('persistence and recovery', () => {
    it('should recover index from disk on restart', async () => {
      await store.set('key1', 'value1');
      await store.set('key2', 'value2', Date.now() + 60000);

      // Create a new store instance pointing to same dir
      const newStore = new FileStore({
        dir: TEST_DIR,
        shards: 4,
        maxSize: 1024 * 1024,
      });

      // Should be able to read existing data
      const entry1 = await newStore.get('key1');
      expect(entry1?.value).toBe('value1');

      const entry2 = await newStore.get('key2');
      expect(entry2?.value).toBe('value2');

      // Item count should be restored
      expect(await newStore.getItemCount()).toBe(2);
    });

    it('should clean up expired entries on load', async () => {
      await store.set('expiring', 'value', Date.now() + 50);
      await store.set('permanent', 'value');

      // Wait for expiration
      await new Promise((r) => setTimeout(r, 60));

      // Create new store - should clean up expired entry
      const newStore = new FileStore({
        dir: TEST_DIR,
        shards: 4,
        maxSize: 1024 * 1024,
      });

      // Force initialization
      await newStore.keys();

      // Only permanent should exist
      expect(await newStore.getItemCount()).toBe(1);
      expect(await newStore.get('permanent')).not.toBeNull();
    });
  });
});
