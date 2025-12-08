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
});
