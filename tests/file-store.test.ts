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
  });
});
