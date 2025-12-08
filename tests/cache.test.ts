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
  });

  describe('edge cases', () => {
    it('should handle empty strings', async () => {
      await cache.set('empty', '');
      expect(await cache.get('empty')).toBe('');
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
  });
});
