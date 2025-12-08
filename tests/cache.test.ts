import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { FsLruCache } from '../src/cache.js';

const TEST_DIR = join(process.cwd(), '.test-cache-integration');

describe('FsLruCache', () => {
  let cache: FsLruCache;

  beforeEach(async () => {
    cache = new FsLruCache({
      dir: TEST_DIR,
      maxMemoryItems: 10,
      maxMemorySize: 1024,
      maxDiskSize: 1024 * 1024,
      shards: 4,
    });
  });

  afterEach(async () => {
    await cache.close();
    try {
      await fs.rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('get/set', () => {
    it('should store and retrieve values', async () => {
      await cache.set('key1', 'value1');
      expect(await cache.get('key1')).toBe('value1');
    });

    it('should return null for non-existent keys', async () => {
      expect(await cache.get('nonexistent')).toBeNull();
    });

    it('should store complex objects', async () => {
      const obj = { name: 'test', nested: { value: 123 }, arr: [1, 2, 3] };
      await cache.set('obj', obj);
      expect(await cache.get('obj')).toEqual(obj);
    });

    it('should support generic types', async () => {
      interface User {
        id: number;
        name: string;
      }
      const user: User = { id: 1, name: 'Alice' };
      await cache.set('user', user);
      const retrieved = await cache.get<User>('user');
      expect(retrieved?.id).toBe(1);
      expect(retrieved?.name).toBe('Alice');
    });

    it('should overwrite existing values', async () => {
      await cache.set('key', 'value1');
      await cache.set('key', 'value2');
      expect(await cache.get('key')).toBe('value2');
    });
  });

  describe('del', () => {
    it('should delete existing keys', async () => {
      await cache.set('key', 'value');
      expect(await cache.del('key')).toBe(true);
      expect(await cache.get('key')).toBeNull();
    });

    it('should return false for non-existent keys', async () => {
      expect(await cache.del('nonexistent')).toBe(false);
    });
  });

  describe('exists', () => {
    it('should return true for existing keys', async () => {
      await cache.set('key', 'value');
      expect(await cache.exists('key')).toBe(true);
    });

    it('should return false for non-existent keys', async () => {
      expect(await cache.exists('nonexistent')).toBe(false);
    });
  });

  describe('keys', () => {
    it('should return all keys', async () => {
      await cache.set('a', 1);
      await cache.set('b', 2);
      await cache.set('c', 3);

      const keys = await cache.keys();
      expect(keys.sort()).toEqual(['a', 'b', 'c']);
    });

    it('should support wildcard pattern', async () => {
      await cache.set('user:1', { id: 1 });
      await cache.set('user:2', { id: 2 });
      await cache.set('post:1', { id: 1 });

      const keys = await cache.keys('user:*');
      expect(keys.sort()).toEqual(['user:1', 'user:2']);
    });

    it('should return all keys with * pattern', async () => {
      await cache.set('a', 1);
      await cache.set('b', 2);
      const keys = await cache.keys('*');
      expect(keys.sort()).toEqual(['a', 'b']);
    });
  });

  describe('TTL', () => {
    it('should set TTL on set()', async () => {
      await cache.set('key', 'value', 1000);
      const ttl = await cache.pttl('key');
      expect(ttl).toBeGreaterThan(900);
      expect(ttl).toBeLessThanOrEqual(1000);
    });

    it('should expire keys after TTL', async () => {
      await cache.set('key', 'value', 50);
      expect(await cache.get('key')).toBe('value');

      await new Promise((r) => setTimeout(r, 60));
      expect(await cache.get('key')).toBeNull();
    });

    it('should support expire() in seconds', async () => {
      await cache.set('key', 'value');
      await cache.expire('key', 2);
      const ttl = await cache.ttl('key');
      expect(ttl).toBeGreaterThanOrEqual(1);
      expect(ttl).toBeLessThanOrEqual(2);
    });

    it('should support pexpire() in milliseconds', async () => {
      await cache.set('key', 'value');
      await cache.pexpire('key', 2000);
      const ttl = await cache.pttl('key');
      expect(ttl).toBeGreaterThan(1900);
      expect(ttl).toBeLessThanOrEqual(2000);
    });

    it('should return -1 for keys without expiry (ttl)', async () => {
      await cache.set('key', 'value');
      expect(await cache.ttl('key')).toBe(-1);
    });

    it('should return -2 for non-existent keys (ttl)', async () => {
      expect(await cache.ttl('nonexistent')).toBe(-2);
    });

    it('should return -1 for keys without expiry (pttl)', async () => {
      await cache.set('key', 'value');
      expect(await cache.pttl('key')).toBe(-1);
    });

    it('should return -2 for non-existent keys (pttl)', async () => {
      expect(await cache.pttl('nonexistent')).toBe(-2);
    });

    it('expire() should return false for non-existent keys', async () => {
      expect(await cache.expire('nonexistent', 10)).toBe(false);
    });

    it('pexpire() should return false for non-existent keys', async () => {
      expect(await cache.pexpire('nonexistent', 10000)).toBe(false);
    });
  });

  describe('clear', () => {
    it('should remove all items', async () => {
      await cache.set('a', 1);
      await cache.set('b', 2);
      await cache.clear();
      expect(await cache.keys()).toEqual([]);
      expect(await cache.get('a')).toBeNull();
      expect(await cache.get('b')).toBeNull();
    });
  });

  describe('persistence', () => {
    it('should persist data across cache instances', async () => {
      await cache.set('persistent', 'data');
      await cache.close();

      // Create new cache instance with same dir
      const newCache = new FsLruCache({
        dir: TEST_DIR,
        shards: 4,
      });

      expect(await newCache.get('persistent')).toBe('data');
      await newCache.close();
    });

    it('should persist TTL across cache instances', async () => {
      await cache.set('expiring', 'data', 5000);
      await cache.close();

      const newCache = new FsLruCache({
        dir: TEST_DIR,
        shards: 4,
      });

      const ttl = await newCache.pttl('expiring');
      expect(ttl).toBeGreaterThan(4000);
      await newCache.close();
    });
  });

  describe('memory/disk interaction', () => {
    it('should serve from memory when available', async () => {
      await cache.set('key', 'value');

      // First get populates memory, subsequent gets use memory
      expect(await cache.get('key')).toBe('value');
      expect(await cache.get('key')).toBe('value');
    });

    it('should promote disk items to memory on access', async () => {
      // Use a cache with very small memory limit
      const smallMemCache = new FsLruCache({
        dir: TEST_DIR + '-small',
        maxMemoryItems: 2,
        shards: 4,
      });

      await smallMemCache.set('a', 'A');
      await smallMemCache.set('b', 'B');
      await smallMemCache.set('c', 'C'); // This should evict 'a' from memory

      // 'a' should still be retrievable from disk
      expect(await smallMemCache.get('a')).toBe('A');

      await smallMemCache.close();
      await fs.rm(TEST_DIR + '-small', { recursive: true, force: true });
    });

    it('should preserve data on disk when memory evicts', async () => {
      const smallMemCache = new FsLruCache({
        dir: TEST_DIR + '-mem-evict',
        maxMemoryItems: 2,
        maxMemorySize: 1024,
        maxDiskSize: 10 * 1024,
        shards: 2,
      });

      // Fill memory
      await smallMemCache.set('first', 'value-first');
      await smallMemCache.set('second', 'value-second');

      // This evicts 'first' from memory
      await smallMemCache.set('third', 'value-third');

      // Stats should show 2 in memory, 3 on disk
      const stats = await smallMemCache.stats();
      expect(stats.memory.items).toBe(2);
      expect(stats.disk.items).toBe(3);

      // 'first' should still be retrievable from disk
      expect(await smallMemCache.get('first')).toBe('value-first');

      // After get, 'first' should be promoted back to memory
      // (evicting another item)
      const statsAfter = await smallMemCache.stats();
      expect(statsAfter.memory.items).toBe(2);

      await smallMemCache.close();
      await fs.rm(TEST_DIR + '-mem-evict', { recursive: true, force: true });
    });

    it('should track hits from memory vs disk correctly', async () => {
      const smallMemCache = new FsLruCache({
        dir: TEST_DIR + '-hit-track',
        maxMemoryItems: 1,
        shards: 2,
      });

      await smallMemCache.set('a', 'A');
      await smallMemCache.set('b', 'B'); // Evicts 'a' from memory

      // Get 'b' - should be memory hit
      await smallMemCache.get('b');

      // Get 'a' - should be disk hit (and promote to memory)
      await smallMemCache.get('a');

      // Get 'a' again - should be memory hit now
      await smallMemCache.get('a');

      // Get 'nonexistent' - should be miss
      await smallMemCache.get('nonexistent');

      const stats = await smallMemCache.stats();
      expect(stats.hits).toBe(3);
      expect(stats.misses).toBe(1);

      await smallMemCache.close();
      await fs.rm(TEST_DIR + '-hit-track', { recursive: true, force: true });
    });

    it('should write to both tiers on set', async () => {
      await cache.set('both-tiers', 'value');

      const stats = await cache.stats();
      expect(stats.memory.items).toBeGreaterThanOrEqual(1);
      expect(stats.disk.items).toBeGreaterThanOrEqual(1);

      // Verify by creating new cache instance (reads from disk)
      await cache.close();
      const newCache = new FsLruCache({ dir: TEST_DIR, shards: 4 });
      expect(await newCache.get('both-tiers')).toBe('value');
      await newCache.close();

      // Recreate original cache for cleanup
      cache = new FsLruCache({
        dir: TEST_DIR,
        maxMemoryItems: 10,
        maxMemorySize: 1024,
        maxDiskSize: 1024 * 1024,
        shards: 4,
      });
    });

    it('should delete from both tiers', async () => {
      const testCache = new FsLruCache({
        dir: TEST_DIR + '-del-both',
        maxMemoryItems: 10,
        shards: 2,
      });

      await testCache.set('to-delete', 'value');

      // Verify it's in both tiers
      const beforeStats = await testCache.stats();
      expect(beforeStats.memory.items).toBe(1);
      expect(beforeStats.disk.items).toBe(1);

      // Delete
      await testCache.del('to-delete');

      // Should be gone from both
      const afterStats = await testCache.stats();
      expect(afterStats.memory.items).toBe(0);
      expect(afterStats.disk.items).toBe(0);

      // Verify truly gone
      expect(await testCache.get('to-delete')).toBeNull();

      await testCache.close();
      await fs.rm(TEST_DIR + '-del-both', { recursive: true, force: true });
    });

    it('should update TTL in both tiers', async () => {
      const testCache = new FsLruCache({
        dir: TEST_DIR + '-ttl-both',
        maxMemoryItems: 10,
        shards: 2,
      });

      // Set without TTL
      await testCache.set('key', 'value');
      expect(await testCache.pttl('key')).toBe(-1);

      // Add TTL
      await testCache.pexpire('key', 5000);

      // TTL should be set
      const ttl = await testCache.pttl('key');
      expect(ttl).toBeGreaterThan(4000);
      expect(ttl).toBeLessThanOrEqual(5000);

      // Verify TTL persists to disk
      await testCache.close();
      const newCache = new FsLruCache({
        dir: TEST_DIR + '-ttl-both',
        shards: 2,
      });

      const persistedTtl = await newCache.pttl('key');
      expect(persistedTtl).toBeGreaterThan(3000); // Some time may have passed

      await newCache.close();
      await fs.rm(TEST_DIR + '-ttl-both', { recursive: true, force: true });
    });

    it('should sync persist() to both tiers', async () => {
      const testCache = new FsLruCache({
        dir: TEST_DIR + '-persist-both',
        maxMemoryItems: 10,
        shards: 2,
      });

      // Set with TTL
      await testCache.set('key', 'value', 5000);
      expect(await testCache.pttl('key')).toBeGreaterThan(0);

      // Remove TTL
      await testCache.persist('key');
      expect(await testCache.pttl('key')).toBe(-1);

      // Verify persist applies to disk
      await testCache.close();
      const newCache = new FsLruCache({
        dir: TEST_DIR + '-persist-both',
        shards: 2,
      });

      expect(await newCache.pttl('key')).toBe(-1);
      expect(await newCache.get('key')).toBe('value');

      await newCache.close();
      await fs.rm(TEST_DIR + '-persist-both', { recursive: true, force: true });
    });

    it('should handle overwrite in both tiers', async () => {
      const testCache = new FsLruCache({
        dir: TEST_DIR + '-overwrite',
        maxMemoryItems: 10,
        shards: 2,
      });

      await testCache.set('key', 'original');
      await testCache.set('key', 'updated');

      // Memory should have updated value
      expect(await testCache.get('key')).toBe('updated');

      // Verify disk also has updated value
      await testCache.close();
      const newCache = new FsLruCache({
        dir: TEST_DIR + '-overwrite',
        shards: 2,
      });

      expect(await newCache.get('key')).toBe('updated');

      await newCache.close();
      await fs.rm(TEST_DIR + '-overwrite', { recursive: true, force: true });
    });

    it('should handle value in disk only after memory eviction', async () => {
      const smallMemCache = new FsLruCache({
        dir: TEST_DIR + '-disk-only',
        maxMemoryItems: 1,
        maxMemorySize: 100,
        shards: 2,
      });

      // Set two values, second evicts first from memory
      await smallMemCache.set('evicted', 'evicted-value');
      await smallMemCache.set('current', 'current-value');

      // 'evicted' is only on disk, 'current' is in both
      const stats = await smallMemCache.stats();
      expect(stats.memory.items).toBe(1);
      expect(stats.disk.items).toBe(2);

      // Getting 'evicted' should work (from disk) and promote it
      expect(await smallMemCache.get('evicted')).toBe('evicted-value');

      // Now 'evicted' is in memory, 'current' might be evicted
      expect(await smallMemCache.get('evicted')).toBe('evicted-value'); // Memory hit

      await smallMemCache.close();
      await fs.rm(TEST_DIR + '-disk-only', { recursive: true, force: true });
    });

    it('should preserve TTL when promoting from disk to memory', async () => {
      const smallMemCache = new FsLruCache({
        dir: TEST_DIR + '-ttl-promote',
        maxMemoryItems: 1,
        shards: 2,
      });

      // Set with TTL, then evict from memory
      await smallMemCache.set('with-ttl', 'value', 5000);
      await smallMemCache.set('other', 'other-value'); // Evicts 'with-ttl' from memory

      // Get should promote and preserve TTL
      expect(await smallMemCache.get('with-ttl')).toBe('value');

      // TTL should still be set
      const ttl = await smallMemCache.pttl('with-ttl');
      expect(ttl).toBeGreaterThan(4000);

      await smallMemCache.close();
      await fs.rm(TEST_DIR + '-ttl-promote', { recursive: true, force: true });
    });

    it('should handle large value that only goes to disk', async () => {
      const smallMemCache = new FsLruCache({
        dir: TEST_DIR + '-large-disk',
        maxMemoryItems: 10,
        maxMemorySize: 50, // Very small memory
        maxDiskSize: 10 * 1024,
        shards: 2,
      });

      // Large value exceeds memory limit
      const largeValue = 'x'.repeat(100);
      await smallMemCache.set('large', largeValue);

      // Should be on disk only
      const stats = await smallMemCache.stats();
      expect(stats.memory.items).toBe(0);
      expect(stats.disk.items).toBe(1);

      // Should still be retrievable
      expect(await smallMemCache.get('large')).toBe(largeValue);

      // After get, still shouldn't be in memory (too large)
      const statsAfter = await smallMemCache.stats();
      expect(statsAfter.memory.items).toBe(0);

      await smallMemCache.close();
      await fs.rm(TEST_DIR + '-large-disk', { recursive: true, force: true });
    });

    it('should handle mixed small and large values', async () => {
      const mixedCache = new FsLruCache({
        dir: TEST_DIR + '-mixed-size',
        maxMemoryItems: 10,
        maxMemorySize: 100,
        maxDiskSize: 10 * 1024,
        shards: 2,
      });

      // Small value goes to both tiers
      await mixedCache.set('small', 'tiny');

      // Large value goes to disk only
      await mixedCache.set('large', 'x'.repeat(200));

      const stats = await mixedCache.stats();
      expect(stats.memory.items).toBe(1); // Only 'small'
      expect(stats.disk.items).toBe(2); // Both

      // Both should be retrievable
      expect(await mixedCache.get('small')).toBe('tiny');
      expect(await mixedCache.get('large')).toBe('x'.repeat(200));

      await mixedCache.close();
      await fs.rm(TEST_DIR + '-mixed-size', { recursive: true, force: true });
    });

    it('should handle exists() checking both tiers', async () => {
      const smallMemCache = new FsLruCache({
        dir: TEST_DIR + '-exists-both',
        maxMemoryItems: 1,
        shards: 2,
      });

      await smallMemCache.set('first', 'value');
      await smallMemCache.set('second', 'value'); // Evicts 'first' from memory

      // 'first' is only on disk, 'second' is in memory
      expect(await smallMemCache.exists('first')).toBe(true); // Disk check
      expect(await smallMemCache.exists('second')).toBe(true); // Memory check
      expect(await smallMemCache.exists('nonexistent')).toBe(false);

      await smallMemCache.close();
      await fs.rm(TEST_DIR + '-exists-both', { recursive: true, force: true });
    });

    it('should handle keys() returning from both tiers', async () => {
      const smallMemCache = new FsLruCache({
        dir: TEST_DIR + '-keys-both',
        maxMemoryItems: 1,
        shards: 2,
      });

      await smallMemCache.set('mem-and-disk', 'value1');
      await smallMemCache.set('only-in-mem', 'value2'); // Evicts first from memory

      // keys() should return both (deduped)
      const keys = await smallMemCache.keys();
      expect(keys.sort()).toEqual(['mem-and-disk', 'only-in-mem']);

      await smallMemCache.close();
      await fs.rm(TEST_DIR + '-keys-both', { recursive: true, force: true });
    });
  });

  describe('edge cases', () => {
    it('should handle empty strings', async () => {
      await cache.set('empty', '');
      expect(await cache.get('empty')).toBe('');
    });

    it('should skip memory for oversized values but still persist to disk', async () => {
      // Create cache with very small memory limit
      const smallCache = new FsLruCache({
        dir: TEST_DIR + '-oversized',
        maxMemoryItems: 10,
        maxMemorySize: 100, // 100 bytes
        shards: 4,
      });

      // Store a value larger than maxMemorySize
      const largeValue = 'x'.repeat(200);
      await smallCache.set('large', largeValue);

      // Value should be retrievable (from disk)
      expect(await smallCache.get('large')).toBe(largeValue);

      // Memory should be empty (value too large)
      const stats = await smallCache.stats();
      expect(stats.memory.items).toBe(0);
      expect(stats.disk.items).toBe(1);

      await smallCache.close();
      await fs.rm(TEST_DIR + '-oversized', { recursive: true, force: true });
    });

    it('should handle null values', async () => {
      await cache.set('null', null);
      expect(await cache.get('null')).toBeNull();
    });

    it('should handle arrays', async () => {
      await cache.set('arr', [1, 2, 3]);
      expect(await cache.get('arr')).toEqual([1, 2, 3]);
    });

    it('should handle boolean values', async () => {
      await cache.set('true', true);
      await cache.set('false', false);
      expect(await cache.get('true')).toBe(true);
      expect(await cache.get('false')).toBe(false);
    });

    it('should handle numeric values', async () => {
      await cache.set('int', 42);
      await cache.set('float', 3.14);
      await cache.set('negative', -100);
      expect(await cache.get('int')).toBe(42);
      expect(await cache.get('float')).toBe(3.14);
      expect(await cache.get('negative')).toBe(-100);
    });

    it('should handle special characters in keys', async () => {
      await cache.set('key:with:colons', 'value1');
      await cache.set('key/with/slashes', 'value2');
      await cache.set('key.with.dots', 'value3');
      expect(await cache.get('key:with:colons')).toBe('value1');
      expect(await cache.get('key/with/slashes')).toBe('value2');
      expect(await cache.get('key.with.dots')).toBe('value3');
    });

    it('should handle unicode keys and values', async () => {
      await cache.set('emoji:🎉', { message: 'Hello 世界' });
      expect(await cache.get('emoji:🎉')).toEqual({ message: 'Hello 世界' });
    });
  });

  describe('mget', () => {
    it('should get multiple values at once', async () => {
      await cache.set('a', 1);
      await cache.set('b', 2);
      await cache.set('c', 3);

      const values = await cache.mget(['a', 'b', 'c']);
      expect(values).toEqual([1, 2, 3]);
    });

    it('should return null for missing keys', async () => {
      await cache.set('a', 1);
      await cache.set('c', 3);

      const values = await cache.mget(['a', 'b', 'c']);
      expect(values).toEqual([1, null, 3]);
    });

    it('should return empty array for empty input', async () => {
      const values = await cache.mget([]);
      expect(values).toEqual([]);
    });

    it('should support generic types', async () => {
      interface Item { id: number }
      await cache.set('item1', { id: 1 });
      await cache.set('item2', { id: 2 });

      const values = await cache.mget<Item>(['item1', 'item2']);
      expect(values[0]?.id).toBe(1);
      expect(values[1]?.id).toBe(2);
    });
  });

  describe('mset', () => {
    it('should set multiple values at once', async () => {
      await cache.mset([
        ['a', 1],
        ['b', 2],
        ['c', 3],
      ]);

      expect(await cache.get('a')).toBe(1);
      expect(await cache.get('b')).toBe(2);
      expect(await cache.get('c')).toBe(3);
    });

    it('should support TTL for individual entries', async () => {
      await cache.mset([
        ['short', 'value', 50],
        ['long', 'value', 5000],
      ]);

      expect(await cache.get('short')).toBe('value');
      expect(await cache.get('long')).toBe('value');

      await new Promise((r) => setTimeout(r, 60));

      expect(await cache.get('short')).toBeNull();
      expect(await cache.get('long')).toBe('value');
    });

    it('should handle empty array', async () => {
      await cache.mset([]);
      expect(await cache.keys()).toEqual([]);
    });

    it('should overwrite existing values', async () => {
      await cache.set('a', 'old');
      await cache.mset([['a', 'new']]);
      expect(await cache.get('a')).toBe('new');
    });
  });

  describe('stats', () => {
    it('should track hits and misses', async () => {
      await cache.set('a', 1);

      await cache.get('a'); // hit
      await cache.get('a'); // hit
      await cache.get('nonexistent'); // miss

      const stats = await cache.stats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBeCloseTo(2 / 3, 2);
    });

    it('should return memory stats', async () => {
      await cache.set('a', 1);
      await cache.set('b', 2);

      const stats = await cache.stats();
      expect(stats.memory.items).toBe(2);
      expect(stats.memory.size).toBeGreaterThan(0);
      expect(stats.memory.maxItems).toBe(10);
      expect(stats.memory.maxSize).toBe(1024);
    });

    it('should return disk stats', async () => {
      await cache.set('a', 1);
      await cache.set('b', 2);

      const stats = await cache.stats();
      expect(stats.disk.items).toBe(2);
      expect(stats.disk.size).toBeGreaterThan(0);
    });

    it('should return 0 hit rate when no gets', async () => {
      const stats = await cache.stats();
      expect(stats.hitRate).toBe(0);
    });

    it('should reset stats', async () => {
      await cache.set('a', 1);
      await cache.get('a');
      await cache.get('b');

      cache.resetStats();

      const stats = await cache.stats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
    });

    it('should track mget hits and misses', async () => {
      await cache.set('a', 1);
      await cache.set('b', 2);

      await cache.mget(['a', 'b', 'c']); // 2 hits, 1 miss

      const stats = await cache.stats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
    });
  });

  describe('setnx', () => {
    it('should set value if key does not exist', async () => {
      const result = await cache.setnx('key', 'value');
      expect(result).toBe(true);
      expect(await cache.get('key')).toBe('value');
    });

    it('should not set value if key exists', async () => {
      await cache.set('key', 'original');
      const result = await cache.setnx('key', 'new');
      expect(result).toBe(false);
      expect(await cache.get('key')).toBe('original');
    });

    it('should support TTL', async () => {
      await cache.setnx('key', 'value', 1000);
      const ttl = await cache.pttl('key');
      expect(ttl).toBeGreaterThan(900);
      expect(ttl).toBeLessThanOrEqual(1000);
    });

    it('should work after key expires', async () => {
      await cache.set('key', 'old', 50);
      await new Promise((r) => setTimeout(r, 60));

      const result = await cache.setnx('key', 'new');
      expect(result).toBe(true);
      expect(await cache.get('key')).toBe('new');
    });

    it('should only allow one concurrent caller to succeed', async () => {
      // Launch 5 concurrent setnx calls for the same key
      const results = await Promise.all([
        cache.setnx('race-key', 'value-1'),
        cache.setnx('race-key', 'value-2'),
        cache.setnx('race-key', 'value-3'),
        cache.setnx('race-key', 'value-4'),
        cache.setnx('race-key', 'value-5'),
      ]);

      // Exactly one should succeed
      const successes = results.filter((r) => r === true).length;
      expect(successes).toBe(1);

      // Key should exist
      expect(await cache.exists('race-key')).toBe(true);
    });
  });

  describe('persist', () => {
    it('should remove TTL from key', async () => {
      await cache.set('key', 'value', 5000);
      expect(await cache.pttl('key')).toBeGreaterThan(0);

      const result = await cache.persist('key');
      expect(result).toBe(true);
      expect(await cache.pttl('key')).toBe(-1);
    });

    it('should return true for key without TTL', async () => {
      await cache.set('key', 'value');
      const result = await cache.persist('key');
      expect(result).toBe(true);
    });

    it('should return false for non-existent key', async () => {
      const result = await cache.persist('nonexistent');
      expect(result).toBe(false);
    });

    it('should keep value after persist', async () => {
      await cache.set('key', { data: 'test' }, 5000);
      await cache.persist('key');
      expect(await cache.get('key')).toEqual({ data: 'test' });
    });
  });

  describe('close', () => {
    it('should throw on get after close', async () => {
      await cache.set('key', 'value');
      await cache.close();
      await expect(cache.get('key')).rejects.toThrow('Cache is closed');
    });

    it('should throw on set after close', async () => {
      await cache.close();
      await expect(cache.set('key', 'value')).rejects.toThrow('Cache is closed');
    });

    it('should throw on del after close', async () => {
      await cache.close();
      await expect(cache.del('key')).rejects.toThrow('Cache is closed');
    });

    it('should throw on exists after close', async () => {
      await cache.close();
      await expect(cache.exists('key')).rejects.toThrow('Cache is closed');
    });

    it('should throw on keys after close', async () => {
      await cache.close();
      await expect(cache.keys()).rejects.toThrow('Cache is closed');
    });

    it('should throw on stats after close', async () => {
      await cache.close();
      await expect(cache.stats()).rejects.toThrow('Cache is closed');
    });

    it('should throw on clear after close', async () => {
      await cache.close();
      await expect(cache.clear()).rejects.toThrow('Cache is closed');
    });

    it('should throw on getOrSet after close', async () => {
      await cache.close();
      await expect(cache.getOrSet('key', () => 'value')).rejects.toThrow('Cache is closed');
    });

    it('should throw on setnx after close', async () => {
      await cache.close();
      await expect(cache.setnx('key', 'value')).rejects.toThrow('Cache is closed');
    });

    it('should throw on pexpire after close', async () => {
      await cache.close();
      await expect(cache.pexpire('key', 1000)).rejects.toThrow('Cache is closed');
    });

    it('should throw on pttl after close', async () => {
      await cache.close();
      await expect(cache.pttl('key')).rejects.toThrow('Cache is closed');
    });

    it('should throw on persist after close', async () => {
      await cache.close();
      await expect(cache.persist('key')).rejects.toThrow('Cache is closed');
    });

    it('should allow close to be called multiple times', async () => {
      await cache.close();
      await expect(cache.close()).resolves.toBeUndefined();
    });
  });

  describe('getOrSet', () => {
    it('should return existing value without calling fn', async () => {
      await cache.set('key', 'existing');
      let fnCalled = false;

      const result = await cache.getOrSet('key', () => {
        fnCalled = true;
        return 'new';
      });

      expect(result).toBe('existing');
      expect(fnCalled).toBe(false);
    });

    it('should call fn and cache result if key does not exist', async () => {
      let fnCalled = false;

      const result = await cache.getOrSet('key', () => {
        fnCalled = true;
        return 'computed';
      });

      expect(result).toBe('computed');
      expect(fnCalled).toBe(true);
      expect(await cache.get('key')).toBe('computed');
    });

    it('should support async fn', async () => {
      const result = await cache.getOrSet('key', async () => {
        await new Promise((r) => setTimeout(r, 10));
        return 'async-value';
      });

      expect(result).toBe('async-value');
      expect(await cache.get('key')).toBe('async-value');
    });

    it('should support TTL', async () => {
      await cache.getOrSet('key', () => 'value', 1000);
      const ttl = await cache.pttl('key');
      expect(ttl).toBeGreaterThan(900);
    });

    it('should work with complex objects', async () => {
      interface User { id: number; name: string }

      const result = await cache.getOrSet<User>('user:1', () => ({
        id: 1,
        name: 'Alice',
      }));

      expect(result.id).toBe(1);
      expect(result.name).toBe('Alice');
    });

    it('should call fn again after key expires', async () => {
      let callCount = 0;

      await cache.getOrSet('key', () => {
        callCount++;
        return `value-${callCount}`;
      }, 50);

      expect(callCount).toBe(1);

      await new Promise((r) => setTimeout(r, 60));

      const result = await cache.getOrSet('key', () => {
        callCount++;
        return `value-${callCount}`;
      });

      expect(callCount).toBe(2);
      expect(result).toBe('value-2');
    });

    it('should provide stampede protection (only call fn once for concurrent requests)', async () => {
      let callCount = 0;

      // Simulate slow computation
      const slowFn = async () => {
        callCount++;
        await new Promise((r) => setTimeout(r, 50));
        return `computed-${callCount}`;
      };

      // Launch 5 concurrent getOrSet calls for the same key
      const results = await Promise.all([
        cache.getOrSet('expensive', slowFn),
        cache.getOrSet('expensive', slowFn),
        cache.getOrSet('expensive', slowFn),
        cache.getOrSet('expensive', slowFn),
        cache.getOrSet('expensive', slowFn),
      ]);

      // fn should only be called once (stampede protection)
      expect(callCount).toBe(1);

      // All results should be the same
      expect(results).toEqual([
        'computed-1',
        'computed-1',
        'computed-1',
        'computed-1',
        'computed-1',
      ]);
    });

    it('should propagate errors from fn', async () => {
      const errorFn = async () => {
        throw new Error('computation failed');
      };

      await expect(cache.getOrSet('error-key', errorFn)).rejects.toThrow('computation failed');
    });

    it('should not cache value when fn throws', async () => {
      let callCount = 0;

      const maybeErrorFn = async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('first call fails');
        }
        return 'success';
      };

      // First call should fail
      await expect(cache.getOrSet('retry-key', maybeErrorFn)).rejects.toThrow('first call fails');

      // Second call should work (key should not be cached)
      const result = await cache.getOrSet('retry-key', maybeErrorFn);
      expect(result).toBe('success');
      expect(callCount).toBe(2);
    });
  });

  describe('expired key behavior', () => {
    it('exists() should return false for expired keys', async () => {
      await cache.set('key', 'value', 50);
      expect(await cache.exists('key')).toBe(true);

      await new Promise((r) => setTimeout(r, 60));
      expect(await cache.exists('key')).toBe(false);
    });

    it('del() should clean up expired keys from disk', async () => {
      await cache.set('key', 'value', 50);
      await new Promise((r) => setTimeout(r, 60));

      // Key is expired but file still exists on disk, del cleans it up
      // and returns true because it successfully removed the file
      expect(await cache.del('key')).toBe(true);

      // Key should now be fully gone
      expect(await cache.exists('key')).toBe(false);
    });

    it('keys() should not return expired keys', async () => {
      await cache.set('short', 'value', 50);
      await cache.set('long', 'value', 5000);

      expect((await cache.keys()).sort()).toEqual(['long', 'short']);

      await new Promise((r) => setTimeout(r, 60));
      expect(await cache.keys()).toEqual(['long']);
    });

    it('persist() should return false for expired keys', async () => {
      await cache.set('key', 'value', 50);
      await new Promise((r) => setTimeout(r, 60));

      expect(await cache.persist('key')).toBe(false);
    });

    it('pexpire() should return false for expired keys', async () => {
      await cache.set('key', 'value', 50);
      await new Promise((r) => setTimeout(r, 60));

      expect(await cache.pexpire('key', 5000)).toBe(false);
    });
  });

  describe('pattern matching', () => {
    it('should match prefix patterns', async () => {
      await cache.set('user:1:name', 'Alice');
      await cache.set('user:1:email', 'alice@test.com');
      await cache.set('user:2:name', 'Bob');
      await cache.set('post:1', 'content');

      expect((await cache.keys('user:1:*')).sort()).toEqual(['user:1:email', 'user:1:name']);
    });

    it('should match suffix patterns', async () => {
      await cache.set('user:1:name', 'Alice');
      await cache.set('user:2:name', 'Bob');
      await cache.set('user:1:email', 'alice@test.com');

      expect((await cache.keys('*:name')).sort()).toEqual(['user:1:name', 'user:2:name']);
    });

    it('should match middle patterns', async () => {
      await cache.set('cache:user:1', 'value1');
      await cache.set('cache:post:1', 'value2');
      await cache.set('store:user:1', 'value3');

      expect((await cache.keys('cache:*:1')).sort()).toEqual(['cache:post:1', 'cache:user:1']);
    });

    it('should match multiple wildcards', async () => {
      await cache.set('a:b:c', 1);
      await cache.set('a:x:c', 2);
      await cache.set('a:b:z', 3);

      expect((await cache.keys('a:*:*')).sort()).toEqual(['a:b:c', 'a:b:z', 'a:x:c']);
    });

    it('should escape regex special characters in patterns', async () => {
      await cache.set('file.txt', 'content');
      await cache.set('file-txt', 'other');

      // The dot should be literal, not regex wildcard
      expect(await cache.keys('file.txt')).toEqual(['file.txt']);
    });

    it('should return empty array when no matches', async () => {
      await cache.set('a', 1);
      await cache.set('b', 2);

      expect(await cache.keys('x*')).toEqual([]);
    });
  });

  describe('disk eviction', () => {
    it('should evict expired entries first when disk is full', async () => {
      const smallCache = new FsLruCache({
        dir: TEST_DIR + '-eviction',
        maxMemoryItems: 100,
        maxMemorySize: 10 * 1024 * 1024,
        maxDiskSize: 500, // Very small disk limit
        shards: 2,
      });

      // Set an entry with TTL
      await smallCache.set('expiring', 'x'.repeat(100), 50);
      // Set entries without TTL
      await smallCache.set('permanent1', 'x'.repeat(100));
      await smallCache.set('permanent2', 'x'.repeat(100));

      // Wait for TTL to expire
      await new Promise((r) => setTimeout(r, 60));

      // This should trigger eviction, preferring the expired entry
      await smallCache.set('new', 'x'.repeat(100));

      // Expired entry should be gone
      expect(await smallCache.get('expiring')).toBeNull();

      // New entry should exist
      expect(await smallCache.get('new')).not.toBeNull();

      await smallCache.close();
      await fs.rm(TEST_DIR + '-eviction', { recursive: true, force: true });
    });

    it('should evict entries when disk size limit exceeded', async () => {
      const smallCache = new FsLruCache({
        dir: TEST_DIR + '-lru-eviction',
        maxMemoryItems: 10,
        maxMemorySize: 10 * 1024,
        maxDiskSize: 180, // Very small disk limit - only fits ~2 entries
        shards: 2,
      });

      // Add entries (each ~80 bytes with JSON overhead)
      await smallCache.set('a', 'x'.repeat(40));
      await smallCache.set('b', 'x'.repeat(40));
      await smallCache.set('c', 'x'.repeat(40));

      // Disk should have evicted at least one entry
      const stats = await smallCache.stats();
      expect(stats.disk.items).toBeLessThan(3);
      expect(stats.disk.size).toBeLessThanOrEqual(180);

      await smallCache.close();
      await fs.rm(TEST_DIR + '-lru-eviction', { recursive: true, force: true });
    });
  });
});
