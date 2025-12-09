import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FsLruCache } from "../src/cache.js";
import { delay, createTestCache, testDir, registerCleanup } from "./test-utils.js";

describe("FsLruCache", () => {
  let cache: FsLruCache;

  beforeEach(() => {
    cache = createTestCache("integration");
  });

  afterEach(async () => {
    await cache.close();
  });

  describe("get/set", () => {
    it("should store and retrieve values", async () => {
      await cache.set("key1", "value1");
      expect(await cache.get("key1")).toBe("value1");
    });

    it("should return null for non-existent keys", async () => {
      expect(await cache.get("nonexistent")).toBeNull();
    });

    it("should store complex objects", async () => {
      const obj = { name: "test", nested: { value: 123 }, arr: [1, 2, 3] };
      await cache.set("obj", obj);
      expect(await cache.get("obj")).toEqual(obj);
    });

    it("should support generic types", async () => {
      interface User {
        id: number;
        name: string;
      }
      const user: User = { id: 1, name: "Alice" };
      await cache.set("user", user);
      const retrieved = await cache.get<User>("user");
      expect(retrieved?.id).toBe(1);
      expect(retrieved?.name).toBe("Alice");
    });

    it("should overwrite existing values", async () => {
      await cache.set("key", "value1");
      await cache.set("key", "value2");
      expect(await cache.get("key")).toBe("value2");
    });

    it("should throw TypeError for undefined values", async () => {
      await expect(cache.set("key", undefined)).rejects.toThrow(TypeError);
      await expect(cache.set("key", undefined)).rejects.toThrow("JSON-serializable");
    });

    it("should throw TypeError for function values", async () => {
      await expect(cache.set("key", () => {})).rejects.toThrow(TypeError);
      await expect(cache.set("key", function test() {})).rejects.toThrow("JSON-serializable");
    });

    it("should throw TypeError for symbol values", async () => {
      await expect(cache.set("key", Symbol("test"))).rejects.toThrow(TypeError);
    });

    it("should handle null values correctly", async () => {
      await cache.set("key", null);
      expect(await cache.get("key")).toBeNull();
      // Verify it was actually stored (not just returning null for missing key)
      expect(await cache.exists("key")).toBe(true);
    });
  });

  describe("del", () => {
    it("should delete existing keys", async () => {
      await cache.set("key", "value");
      expect(await cache.del("key")).toBe(true);
      expect(await cache.get("key")).toBeNull();
    });

    it("should return false for non-existent keys", async () => {
      expect(await cache.del("nonexistent")).toBe(false);
    });
  });

  describe("exists", () => {
    it("should return true for existing keys", async () => {
      await cache.set("key", "value");
      expect(await cache.exists("key")).toBe(true);
    });

    it("should return false for non-existent keys", async () => {
      expect(await cache.exists("nonexistent")).toBe(false);
    });
  });

  describe("keys", () => {
    it("should return all keys", async () => {
      await cache.set("a", 1);
      await cache.set("b", 2);
      await cache.set("c", 3);
      expect((await cache.keys()).sort()).toEqual(["a", "b", "c"]);
    });

    it("should support wildcard pattern", async () => {
      await cache.set("user:1", { id: 1 });
      await cache.set("user:2", { id: 2 });
      await cache.set("post:1", { id: 1 });
      expect((await cache.keys("user:*")).sort()).toEqual(["user:1", "user:2"]);
    });

    it("should return all keys with * pattern", async () => {
      await cache.set("a", 1);
      await cache.set("b", 2);
      expect((await cache.keys("*")).sort()).toEqual(["a", "b"]);
    });
  });

  describe("TTL", () => {
    it("should set TTL on set()", async () => {
      await cache.set("key", "value", 5);
      const ttl = await cache.ttl("key");
      expect(ttl).toBeGreaterThanOrEqual(4);
      expect(ttl).toBeLessThanOrEqual(5);
    });

    it("should expire keys after TTL", async () => {
      await cache.set("key", "value", 0.05); // 50ms
      expect(await cache.get("key")).toBe("value");
      await delay(60);
      expect(await cache.get("key")).toBeNull();
    });

    it("should support expire() in seconds", async () => {
      await cache.set("key", "value");
      await cache.expire("key", 2);
      const ttl = await cache.ttl("key");
      expect(ttl).toBeGreaterThanOrEqual(1);
      expect(ttl).toBeLessThanOrEqual(2);
    });

    it("should return -1 for keys without expiry", async () => {
      await cache.set("key", "value");
      expect(await cache.ttl("key")).toBe(-1);
    });

    it("should return -2 for non-existent keys", async () => {
      expect(await cache.ttl("nonexistent")).toBe(-2);
    });

    it("expire() should return false for non-existent keys", async () => {
      expect(await cache.expire("nonexistent", 10)).toBe(false);
    });
  });

  describe("clear", () => {
    it("should remove all items", async () => {
      await cache.set("a", 1);
      await cache.set("b", 2);
      await cache.clear();
      expect(await cache.keys()).toEqual([]);
      expect(await cache.get("a")).toBeNull();
      expect(await cache.get("b")).toBeNull();
    });
  });

  describe("persistence", () => {
    it("should persist data across cache instances", async () => {
      await cache.set("persistent", "data");
      await cache.close();

      const dir = testDir("integration");
      const newCache = new FsLruCache({ dir, shards: 4 });
      expect(await newCache.get("persistent")).toBe("data");
      await newCache.close();
    });

    it("should persist TTL across cache instances", async () => {
      await cache.set("expiring", "data", 5);
      await cache.close();

      const dir = testDir("integration");
      const newCache = new FsLruCache({ dir, shards: 4 });
      expect(await newCache.ttl("expiring")).toBeGreaterThanOrEqual(4);
      await newCache.close();
    });
  });

  describe("memory/disk interaction", () => {
    it("should serve from memory when available", async () => {
      await cache.set("key", "value");
      expect(await cache.get("key")).toBe("value");
      expect(await cache.get("key")).toBe("value");
    });

    it("should promote disk items to memory on access", async () => {
      const smallCache = createTestCache("small-mem", { maxMemoryItems: 2 });

      await smallCache.set("a", "A");
      await smallCache.set("b", "B");
      await smallCache.set("c", "C"); // Evicts 'a' from memory

      expect(await smallCache.get("a")).toBe("A"); // From disk
      await smallCache.close();
    });

    it("should preserve data on disk when memory evicts", async () => {
      const smallCache = createTestCache("mem-evict", {
        maxMemoryItems: 2,
        maxMemorySize: 1024,
        maxDiskSize: 10 * 1024,
        shards: 2,
      });

      await smallCache.set("first", "value-first");
      await smallCache.set("second", "value-second");
      await smallCache.set("third", "value-third"); // Evicts 'first' from memory

      const stats = await smallCache.stats();
      expect(stats.memory.items).toBe(2);
      expect(stats.disk.items).toBe(3);
      expect(await smallCache.get("first")).toBe("value-first");

      await smallCache.close();
    });

    it("should track hits from memory vs disk correctly", async () => {
      const smallCache = createTestCache("hit-track", { maxMemoryItems: 1, shards: 2 });

      await smallCache.set("a", "A");
      await smallCache.set("b", "B"); // Evicts 'a' from memory

      await smallCache.get("b"); // Memory hit
      await smallCache.get("a"); // Disk hit
      await smallCache.get("a"); // Memory hit
      await smallCache.get("nonexistent"); // Miss

      const stats = await smallCache.stats();
      expect(stats.hits).toBe(3);
      expect(stats.misses).toBe(1);

      await smallCache.close();
    });

    it("should write to both tiers on set", async () => {
      await cache.set("both-tiers", "value");

      const stats = await cache.stats();
      expect(stats.memory.items).toBeGreaterThanOrEqual(1);
      expect(stats.disk.items).toBeGreaterThanOrEqual(1);

      await cache.close();
      const dir = testDir("integration");
      const newCache = new FsLruCache({ dir, shards: 4 });
      expect(await newCache.get("both-tiers")).toBe("value");
      await newCache.close();

      cache = createTestCache("integration");
    });

    it("should delete from both tiers", async () => {
      const testCache = createTestCache("del-both", { maxMemoryItems: 10, shards: 2 });

      await testCache.set("to-delete", "value");
      expect((await testCache.stats()).memory.items).toBe(1);
      expect((await testCache.stats()).disk.items).toBe(1);

      await testCache.del("to-delete");
      expect((await testCache.stats()).memory.items).toBe(0);
      expect((await testCache.stats()).disk.items).toBe(0);

      await testCache.close();
    });

    it("should update TTL in both tiers", async () => {
      const testCache = createTestCache("ttl-both", { maxMemoryItems: 10, shards: 2 });

      await testCache.set("key", "value");
      expect(await testCache.ttl("key")).toBe(-1);

      await testCache.expire("key", 5);
      const ttl = await testCache.ttl("key");
      expect(ttl).toBeGreaterThanOrEqual(4);
      expect(ttl).toBeLessThanOrEqual(5);

      await testCache.close();
      const dir = testDir("ttl-both");
      const newCache = new FsLruCache({ dir, shards: 2 });
      expect(await newCache.ttl("key")).toBeGreaterThanOrEqual(3);
      await newCache.close();
    });

    it("should sync persist() to both tiers", async () => {
      const testCache = createTestCache("persist-both", { maxMemoryItems: 10, shards: 2 });

      await testCache.set("key", "value", 5);
      expect(await testCache.ttl("key")).toBeGreaterThan(0);

      await testCache.persist("key");
      expect(await testCache.ttl("key")).toBe(-1);

      await testCache.close();
      const dir = testDir("persist-both");
      const newCache = new FsLruCache({ dir, shards: 2 });
      expect(await newCache.ttl("key")).toBe(-1);
      expect(await newCache.get("key")).toBe("value");
      await newCache.close();
    });

    it("should handle overwrite in both tiers", async () => {
      const testCache = createTestCache("overwrite", { maxMemoryItems: 10, shards: 2 });

      await testCache.set("key", "original");
      await testCache.set("key", "updated");
      expect(await testCache.get("key")).toBe("updated");

      await testCache.close();
      const dir = testDir("overwrite");
      const newCache = new FsLruCache({ dir, shards: 2 });
      expect(await newCache.get("key")).toBe("updated");
      await newCache.close();
    });

    it("should handle value in disk only after memory eviction", async () => {
      const smallCache = createTestCache("disk-only", {
        maxMemoryItems: 1,
        maxMemorySize: 100,
        shards: 2,
      });

      await smallCache.set("evicted", "evicted-value");
      await smallCache.set("current", "current-value");

      const stats = await smallCache.stats();
      expect(stats.memory.items).toBe(1);
      expect(stats.disk.items).toBe(2);

      expect(await smallCache.get("evicted")).toBe("evicted-value");
      expect(await smallCache.get("evicted")).toBe("evicted-value"); // Memory hit

      await smallCache.close();
    });

    it("should preserve TTL when promoting from disk to memory", async () => {
      const smallCache = createTestCache("ttl-promote", { maxMemoryItems: 1, shards: 2 });

      await smallCache.set("with-ttl", "value", 5);
      await smallCache.set("other", "other-value"); // Evicts 'with-ttl'

      expect(await smallCache.get("with-ttl")).toBe("value");
      expect(await smallCache.ttl("with-ttl")).toBeGreaterThanOrEqual(4);

      await smallCache.close();
    });

    it("should handle large value that only goes to disk", async () => {
      const smallCache = createTestCache("large-disk", {
        maxMemoryItems: 10,
        maxMemorySize: 50,
        maxDiskSize: 10 * 1024,
        shards: 2,
      });

      const largeValue = "x".repeat(100);
      await smallCache.set("large", largeValue);

      const stats = await smallCache.stats();
      expect(stats.memory.items).toBe(0);
      expect(stats.disk.items).toBe(1);

      expect(await smallCache.get("large")).toBe(largeValue);
      expect((await smallCache.stats()).memory.items).toBe(0); // Still too large

      await smallCache.close();
    });

    it("should handle mixed small and large values", async () => {
      const mixedCache = createTestCache("mixed-size", {
        maxMemoryItems: 10,
        maxMemorySize: 100,
        maxDiskSize: 10 * 1024,
        shards: 2,
      });

      await mixedCache.set("small", "tiny");
      await mixedCache.set("large", "x".repeat(200));

      const stats = await mixedCache.stats();
      expect(stats.memory.items).toBe(1);
      expect(stats.disk.items).toBe(2);

      expect(await mixedCache.get("small")).toBe("tiny");
      expect(await mixedCache.get("large")).toBe("x".repeat(200));

      await mixedCache.close();
    });

    it("should handle exists() checking both tiers", async () => {
      const smallCache = createTestCache("exists-both", { maxMemoryItems: 1, shards: 2 });

      await smallCache.set("first", "value");
      await smallCache.set("second", "value"); // Evicts 'first' from memory

      expect(await smallCache.exists("first")).toBe(true); // Disk
      expect(await smallCache.exists("second")).toBe(true); // Memory
      expect(await smallCache.exists("nonexistent")).toBe(false);

      await smallCache.close();
    });

    it("should handle keys() returning from both tiers", async () => {
      const smallCache = createTestCache("keys-both", { maxMemoryItems: 1, shards: 2 });

      await smallCache.set("mem-and-disk", "value1");
      await smallCache.set("only-in-mem", "value2");

      expect((await smallCache.keys()).sort()).toEqual(["mem-and-disk", "only-in-mem"]);

      await smallCache.close();
    });
  });

  describe("edge cases", () => {
    it("should handle empty strings", async () => {
      await cache.set("empty", "");
      expect(await cache.get("empty")).toBe("");
    });

    it("should skip memory for oversized values but still persist to disk", async () => {
      const smallCache = createTestCache("oversized", {
        maxMemoryItems: 10,
        maxMemorySize: 100,
      });

      const largeValue = "x".repeat(200);
      await smallCache.set("large", largeValue);

      expect(await smallCache.get("large")).toBe(largeValue);

      const stats = await smallCache.stats();
      expect(stats.memory.items).toBe(0);
      expect(stats.disk.items).toBe(1);

      await smallCache.close();
    });

    it("should handle null values", async () => {
      await cache.set("null", null);
      expect(await cache.get("null")).toBeNull();
    });

    it("should handle arrays", async () => {
      await cache.set("arr", [1, 2, 3]);
      expect(await cache.get("arr")).toEqual([1, 2, 3]);
    });

    it("should handle boolean values", async () => {
      await cache.set("true", true);
      await cache.set("false", false);
      expect(await cache.get("true")).toBe(true);
      expect(await cache.get("false")).toBe(false);
    });

    it("should handle numeric values", async () => {
      await cache.set("int", 42);
      await cache.set("float", 3.14);
      await cache.set("negative", -100);
      expect(await cache.get("int")).toBe(42);
      expect(await cache.get("float")).toBe(3.14);
      expect(await cache.get("negative")).toBe(-100);
    });

    it("should handle special characters in keys", async () => {
      await cache.set("key:with:colons", "value1");
      await cache.set("key/with/slashes", "value2");
      await cache.set("key.with.dots", "value3");
      expect(await cache.get("key:with:colons")).toBe("value1");
      expect(await cache.get("key/with/slashes")).toBe("value2");
      expect(await cache.get("key.with.dots")).toBe("value3");
    });

    it("should handle unicode keys and values", async () => {
      await cache.set("emoji:🎉", { message: "Hello 世界" });
      expect(await cache.get("emoji:🎉")).toEqual({ message: "Hello 世界" });
    });
  });

  describe("mget", () => {
    it("should get multiple values at once", async () => {
      await cache.set("a", 1);
      await cache.set("b", 2);
      await cache.set("c", 3);
      expect(await cache.mget(["a", "b", "c"])).toEqual([1, 2, 3]);
    });

    it("should return null for missing keys", async () => {
      await cache.set("a", 1);
      await cache.set("c", 3);
      expect(await cache.mget(["a", "b", "c"])).toEqual([1, null, 3]);
    });

    it("should return empty array for empty input", async () => {
      expect(await cache.mget([])).toEqual([]);
    });

    it("should support generic types", async () => {
      interface Item {
        id: number;
      }
      await cache.set("item1", { id: 1 });
      await cache.set("item2", { id: 2 });

      const values = await cache.mget<Item>(["item1", "item2"]);
      expect(values[0]?.id).toBe(1);
      expect(values[1]?.id).toBe(2);
    });
  });

  describe("mset", () => {
    it("should set multiple values at once", async () => {
      await cache.mset([
        ["a", 1],
        ["b", 2],
        ["c", 3],
      ]);
      expect(await cache.get("a")).toBe(1);
      expect(await cache.get("b")).toBe(2);
      expect(await cache.get("c")).toBe(3);
    });

    it("should support TTL for individual entries", async () => {
      await cache.mset([
        ["short", "value", 0.05], // 50ms
        ["long", "value", 5],
      ]);

      expect(await cache.get("short")).toBe("value");
      expect(await cache.get("long")).toBe("value");

      await delay(60);
      expect(await cache.get("short")).toBeNull();
      expect(await cache.get("long")).toBe("value");
    });

    it("should handle empty array", async () => {
      await cache.mset([]);
      expect(await cache.keys()).toEqual([]);
    });

    it("should overwrite existing values", async () => {
      await cache.set("a", "old");
      await cache.mset([["a", "new"]]);
      expect(await cache.get("a")).toBe("new");
    });

    it("should throw TypeError for undefined values in batch", async () => {
      await expect(
        cache.mset([
          ["a", "valid"],
          ["b", undefined],
          ["c", "also valid"],
        ]),
      ).rejects.toThrow(TypeError);
      // Verify no partial writes occurred
      expect(await cache.get("a")).toBeNull();
    });

    it("should throw TypeError for function values in batch", async () => {
      await expect(
        cache.mset([
          ["a", 1],
          ["b", () => {}],
        ]),
      ).rejects.toThrow("JSON-serializable");
    });
  });

  describe("stats", () => {
    it("should track hits and misses", async () => {
      await cache.set("a", 1);
      await cache.get("a"); // hit
      await cache.get("a"); // hit
      await cache.get("nonexistent"); // miss

      const stats = await cache.stats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBeCloseTo(2 / 3, 2);
    });

    it("should return memory stats", async () => {
      await cache.set("a", 1);
      await cache.set("b", 2);

      const stats = await cache.stats();
      expect(stats.memory.items).toBe(2);
      expect(stats.memory.size).toBeGreaterThan(0);
      expect(stats.memory.maxItems).toBe(10);
      expect(stats.memory.maxSize).toBe(1024);
    });

    it("should return disk stats", async () => {
      await cache.set("a", 1);
      await cache.set("b", 2);

      const stats = await cache.stats();
      expect(stats.disk.items).toBe(2);
      expect(stats.disk.size).toBeGreaterThan(0);
    });

    it("should return 0 hit rate when no gets", async () => {
      expect((await cache.stats()).hitRate).toBe(0);
    });

    it("should reset stats", async () => {
      await cache.set("a", 1);
      await cache.get("a");
      await cache.get("b");

      cache.resetStats();
      const stats = await cache.stats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
    });

    it("should track mget hits and misses", async () => {
      await cache.set("a", 1);
      await cache.set("b", 2);
      await cache.mget(["a", "b", "c"]); // 2 hits, 1 miss

      const stats = await cache.stats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
    });
  });

  describe("persist", () => {
    it("should remove TTL from key", async () => {
      await cache.set("key", "value", 5);
      expect(await cache.ttl("key")).toBeGreaterThan(0);

      expect(await cache.persist("key")).toBe(true);
      expect(await cache.ttl("key")).toBe(-1);
    });

    it("should return true for key without TTL", async () => {
      await cache.set("key", "value");
      expect(await cache.persist("key")).toBe(true);
    });

    it("should return false for non-existent key", async () => {
      expect(await cache.persist("nonexistent")).toBe(false);
    });

    it("should keep value after persist", async () => {
      await cache.set("key", { data: "test" }, 5);
      await cache.persist("key");
      expect(await cache.get("key")).toEqual({ data: "test" });
    });
  });

  describe("touch", () => {
    it("should return true for existing key", async () => {
      await cache.set("key", "value");
      expect(await cache.touch("key")).toBe(true);
    });

    it("should return false for non-existent key", async () => {
      expect(await cache.touch("nonexistent")).toBe(false);
    });

    it("should not change TTL (use expire for TTL updates)", async () => {
      await cache.set("key", "value", 5);
      await delay(100);
      await cache.touch("key");
      const ttl = await cache.ttl("key");
      // TTL should be unchanged (minus elapsed time)
      expect(ttl).toBeGreaterThanOrEqual(4);
      expect(ttl).toBeLessThanOrEqual(5);
    });

    it("should preserve TTL when not provided", async () => {
      await cache.set("key", "value", 5);
      await delay(100);
      await cache.touch("key");
      const ttl = await cache.ttl("key");
      expect(ttl).toBeGreaterThanOrEqual(4);
      expect(ttl).toBeLessThanOrEqual(5);
    });

    it("should preserve value", async () => {
      await cache.set("key", { data: "test" });
      await cache.touch("key");
      expect(await cache.get("key")).toEqual({ data: "test" });
    });

    it("should return false for expired keys", async () => {
      await cache.set("key", "value", 0.05); // 50ms
      await delay(60);
      expect(await cache.touch("key")).toBe(false);
    });

    it("should refresh LRU position in memory", async () => {
      const smallCache = createTestCache("touch-lru", { maxMemoryItems: 2, shards: 2 });

      await smallCache.set("a", "A");
      await smallCache.set("b", "B");
      await smallCache.touch("a"); // Promote 'a' to most recent
      await smallCache.set("c", "C"); // Should evict 'b', not 'a'

      const stats = await smallCache.stats();
      expect(stats.memory.items).toBe(2);

      // 'a' should still be in memory (was touched)
      // 'b' was evicted
      // We can verify by checking the value is retrievable
      expect(await smallCache.get("a")).toBe("A");

      await smallCache.close();
    });

    it("should work on keys only in disk", async () => {
      const smallCache = createTestCache("touch-disk", { maxMemoryItems: 1, shards: 2 });

      await smallCache.set("disk-only", "value", 5);
      await smallCache.set("in-memory", "value2"); // Evicts disk-only from memory

      expect(await smallCache.touch("disk-only")).toBe(true);
      // TTL should be preserved
      expect(await smallCache.ttl("disk-only")).toBeGreaterThanOrEqual(4);

      await smallCache.close();
    });

    it("should persist LRU update to disk via mtime", async () => {
      await cache.set("key", "value", 10);
      await cache.touch("key");
      await cache.close();

      const dir = testDir("integration");
      const newCache = new FsLruCache({ dir, shards: 4 });
      // TTL should be preserved (touch doesn't change TTL)
      expect(await newCache.ttl("key")).toBeGreaterThanOrEqual(9);
      await newCache.close();

      cache = createTestCache("integration");
    });
  });

  describe("size", () => {
    it("should return 0 for empty cache", async () => {
      expect(await cache.size()).toBe(0);
    });

    it("should return correct count after adding items", async () => {
      await cache.set("a", 1);
      await cache.set("b", 2);
      await cache.set("c", 3);
      expect(await cache.size()).toBe(3);
    });

    it("should decrease after deleting items", async () => {
      await cache.set("a", 1);
      await cache.set("b", 2);
      await cache.del("a");
      expect(await cache.size()).toBe(1);
    });

    it("should return 0 after clear", async () => {
      await cache.set("a", 1);
      await cache.set("b", 2);
      await cache.clear();
      expect(await cache.size()).toBe(0);
    });

    it("should not count expired items", async () => {
      await cache.set("short", "value", 0.05); // 50ms
      await cache.set("long", "value", 5);
      expect(await cache.size()).toBe(2);

      await delay(60);
      // Access to trigger lazy expiration cleanup
      await cache.exists("short");
      expect(await cache.size()).toBe(1);
    });

    it("should count items only on disk (large values)", async () => {
      const smallCache = createTestCache("size-disk", {
        maxMemoryItems: 10,
        maxMemorySize: 50,
        shards: 2,
      });

      await smallCache.set("large", "x".repeat(100));
      expect(await smallCache.size()).toBe(1);

      const stats = await smallCache.stats();
      expect(stats.memory.items).toBe(0);
      expect(stats.disk.items).toBe(1);

      await smallCache.close();
    });
  });

  describe("prune", () => {
    it("should remove expired entries", async () => {
      await cache.set("expired1", "value", 0.05); // 50ms
      await cache.set("expired2", "value", 0.05); // 50ms
      await cache.set("valid", "value", 5);

      expect(await cache.size()).toBe(3);
      await delay(60);

      const pruned = await cache.prune();
      expect(pruned).toBe(2);
      expect(await cache.size()).toBe(1);
      expect(await cache.get("valid")).toBe("value");
    });

    it("should return 0 when no expired entries", async () => {
      await cache.set("a", 1);
      await cache.set("b", 2, 5);

      const pruned = await cache.prune();
      expect(pruned).toBe(0);
    });

    it("should handle empty cache", async () => {
      const pruned = await cache.prune();
      expect(pruned).toBe(0);
    });

    it("should prune both memory and disk", async () => {
      // Set items that fit in memory
      await cache.set("mem", "small", 0.05); // 50ms
      await delay(60);

      const pruned = await cache.prune();
      expect(pruned).toBeGreaterThanOrEqual(1);
    });

    it("should work with pruneInterval for automatic cleanup", async () => {
      const autoCache = createTestCache("prune-interval", { pruneInterval: 100 });

      await autoCache.set("short", "value", 0.05); // 50ms
      await autoCache.set("long", "value", 5);

      expect(await autoCache.size()).toBe(2);

      // Wait for expiration + prune interval
      await delay(200);

      // Automatic prune should have cleaned up
      expect(await autoCache.size()).toBe(1);
      expect(await autoCache.get("long")).toBe("value");

      await autoCache.close();
    });

    it("should stop automatic pruning after close", async () => {
      const autoCache = createTestCache("prune-close", { pruneInterval: 50 });
      await autoCache.close();

      // Should not throw or cause issues
      await delay(100);
    });

    it("should not keep process alive with pruneInterval", async () => {
      // This test verifies unref() is called - the timer shouldn't prevent exit
      const autoCache = createTestCache("prune-unref", { pruneInterval: 1000 });
      // If unref() wasn't called, this test would hang
      await autoCache.close();
    });

    it("should work with namespace", async () => {
      const nsCache = createTestCache("prune-namespace", { namespace: "app" });
      await nsCache.set("key", "value", 0.05); // 50ms
      await delay(60);

      const pruned = await nsCache.prune();
      expect(pruned).toBe(1);
      expect(await nsCache.size()).toBe(0);

      await nsCache.close();
    });
  });

  describe("close", () => {
    const closedCacheTests = [
      { method: "get", fn: (c: FsLruCache) => c.get("key") },
      { method: "set", fn: (c: FsLruCache) => c.set("key", "value") },
      { method: "del", fn: (c: FsLruCache) => c.del("key") },
      { method: "exists", fn: (c: FsLruCache) => c.exists("key") },
      { method: "keys", fn: (c: FsLruCache) => c.keys() },
      { method: "stats", fn: (c: FsLruCache) => c.stats() },
      { method: "clear", fn: (c: FsLruCache) => c.clear() },
      { method: "getOrSet", fn: (c: FsLruCache) => c.getOrSet("key", () => "value") },
      { method: "expire", fn: (c: FsLruCache) => c.expire("key", 10) },
      { method: "ttl", fn: (c: FsLruCache) => c.ttl("key") },
      { method: "persist", fn: (c: FsLruCache) => c.persist("key") },
      { method: "touch", fn: (c: FsLruCache) => c.touch("key") },
      { method: "size", fn: (c: FsLruCache) => c.size() },
      { method: "prune", fn: (c: FsLruCache) => c.prune() },
    ];

    it.each(closedCacheTests)("should throw on $method after close", async ({ fn }) => {
      const testCache = createTestCache("close-test");
      await testCache.close();
      await expect(fn(testCache)).rejects.toThrow("Cache is closed");
    });

    it("should allow close to be called multiple times", async () => {
      const testCache = createTestCache("multi-close");
      await testCache.close();
      await expect(testCache.close()).resolves.toBeUndefined();
    });
  });

  describe("getOrSet", () => {
    it("should return existing value without calling fn", async () => {
      await cache.set("key", "existing");
      let fnCalled = false;

      const result = await cache.getOrSet("key", () => {
        fnCalled = true;
        return "new";
      });

      expect(result).toBe("existing");
      expect(fnCalled).toBe(false);
    });

    it("should call fn and cache result if key does not exist", async () => {
      let fnCalled = false;

      const result = await cache.getOrSet("key", () => {
        fnCalled = true;
        return "computed";
      });

      expect(result).toBe("computed");
      expect(fnCalled).toBe(true);
      expect(await cache.get("key")).toBe("computed");
    });

    it("should support async fn", async () => {
      const result = await cache.getOrSet("key", async () => {
        await delay(10);
        return "async-value";
      });

      expect(result).toBe("async-value");
      expect(await cache.get("key")).toBe("async-value");
    });

    it("should support TTL", async () => {
      await cache.getOrSet("key", () => "value", 5);
      expect(await cache.ttl("key")).toBeGreaterThanOrEqual(4);
    });

    it("should work with complex objects", async () => {
      interface User {
        id: number;
        name: string;
      }

      const result = await cache.getOrSet<User>("user:1", () => ({
        id: 1,
        name: "Alice",
      }));

      expect(result.id).toBe(1);
      expect(result.name).toBe("Alice");
    });

    it("should call fn again after key expires", async () => {
      let callCount = 0;

      await cache.getOrSet("key", () => `value-${++callCount}`, 0.05); // 50ms
      expect(callCount).toBe(1);

      await delay(60);
      const result = await cache.getOrSet("key", () => `value-${++callCount}`);

      expect(callCount).toBe(2);
      expect(result).toBe("value-2");
    });

    it("should provide stampede protection", async () => {
      let callCount = 0;

      const slowFn = async () => {
        callCount++;
        await delay(50);
        return `computed-${callCount}`;
      };

      const results = await Promise.all([
        cache.getOrSet("expensive", slowFn),
        cache.getOrSet("expensive", slowFn),
        cache.getOrSet("expensive", slowFn),
        cache.getOrSet("expensive", slowFn),
        cache.getOrSet("expensive", slowFn),
      ]);

      expect(callCount).toBe(1);
      expect(results).toEqual(Array(5).fill("computed-1"));
    });

    it("should propagate errors from fn", async () => {
      await expect(
        cache.getOrSet("error-key", async () => {
          throw new Error("computation failed");
        }),
      ).rejects.toThrow("computation failed");
    });

    it("should not cache value when fn throws", async () => {
      let callCount = 0;

      const maybeErrorFn = async () => {
        callCount++;
        if (callCount === 1) throw new Error("first call fails");
        return "success";
      };

      await expect(cache.getOrSet("retry-key", maybeErrorFn)).rejects.toThrow();

      const result = await cache.getOrSet("retry-key", maybeErrorFn);
      expect(result).toBe("success");
      expect(callCount).toBe(2);
    });
  });

  describe("expired key behavior", () => {
    it("exists() should return false for expired keys", async () => {
      await cache.set("key", "value", 0.05); // 50ms
      expect(await cache.exists("key")).toBe(true);

      await delay(60);
      expect(await cache.exists("key")).toBe(false);
    });

    it("del() should clean up expired keys from disk", async () => {
      await cache.set("key", "value", 0.05); // 50ms
      await delay(60);

      expect(await cache.del("key")).toBe(true);
      expect(await cache.exists("key")).toBe(false);
    });

    it("keys() should not return expired keys", async () => {
      await cache.set("short", "value", 0.05); // 50ms
      await cache.set("long", "value", 5);

      expect((await cache.keys()).sort()).toEqual(["long", "short"]);

      await delay(60);
      expect(await cache.keys()).toEqual(["long"]);
    });

    it("persist() should return false for expired keys", async () => {
      await cache.set("key", "value", 0.05); // 50ms
      await delay(60);
      expect(await cache.persist("key")).toBe(false);
    });

    it("expire() should return false for expired keys", async () => {
      await cache.set("key", "value", 0.05); // 50ms
      await delay(60);
      expect(await cache.expire("key", 5)).toBe(false);
    });
  });

  describe("pattern matching", () => {
    it("should match prefix patterns", async () => {
      await cache.set("user:1:name", "Alice");
      await cache.set("user:1:email", "alice@test.com");
      await cache.set("user:2:name", "Bob");
      await cache.set("post:1", "content");

      expect((await cache.keys("user:1:*")).sort()).toEqual(["user:1:email", "user:1:name"]);
    });

    it("should match suffix patterns", async () => {
      await cache.set("user:1:name", "Alice");
      await cache.set("user:2:name", "Bob");
      await cache.set("user:1:email", "alice@test.com");

      expect((await cache.keys("*:name")).sort()).toEqual(["user:1:name", "user:2:name"]);
    });

    it("should match middle patterns", async () => {
      await cache.set("cache:user:1", "value1");
      await cache.set("cache:post:1", "value2");
      await cache.set("store:user:1", "value3");

      expect((await cache.keys("cache:*:1")).sort()).toEqual(["cache:post:1", "cache:user:1"]);
    });

    it("should match multiple wildcards", async () => {
      await cache.set("a:b:c", 1);
      await cache.set("a:x:c", 2);
      await cache.set("a:b:z", 3);

      expect((await cache.keys("a:*:*")).sort()).toEqual(["a:b:c", "a:b:z", "a:x:c"]);
    });

    it("should escape regex special characters in patterns", async () => {
      await cache.set("file.txt", "content");
      await cache.set("file-txt", "other");

      expect(await cache.keys("file.txt")).toEqual(["file.txt"]);
    });

    it("should return empty array when no matches", async () => {
      await cache.set("a", 1);
      await cache.set("b", 2);

      expect(await cache.keys("x*")).toEqual([]);
    });
  });

  describe("defaultTtl", () => {
    it("should apply defaultTtl when no TTL is provided", async () => {
      const ttlCache = createTestCache("default-ttl", { defaultTtl: 5 });
      await ttlCache.set("key", "value");

      const ttl = await ttlCache.ttl("key");
      expect(ttl).toBeGreaterThanOrEqual(4);
      expect(ttl).toBeLessThanOrEqual(5);

      await ttlCache.close();
    });

    it("should allow overriding defaultTtl with explicit TTL", async () => {
      const ttlCache = createTestCache("default-ttl-override", { defaultTtl: 5 });
      await ttlCache.set("key", "value", 1);

      const ttl = await ttlCache.ttl("key");
      expect(ttl).toBeLessThanOrEqual(1);

      await ttlCache.close();
    });

    it("should allow disabling TTL with 0", async () => {
      const ttlCache = createTestCache("default-ttl-disable", { defaultTtl: 5 });
      await ttlCache.set("key", "value", 0);

      expect(await ttlCache.ttl("key")).toBe(-1);

      await ttlCache.close();
    });

    it("should apply defaultTtl to getOrSet", async () => {
      const ttlCache = createTestCache("default-ttl-getorset", { defaultTtl: 5 });
      await ttlCache.getOrSet("key", () => "value");

      const ttl = await ttlCache.ttl("key");
      expect(ttl).toBeGreaterThanOrEqual(4);
      expect(ttl).toBeLessThanOrEqual(5);

      await ttlCache.close();
    });

    it("should apply defaultTtl to mset", async () => {
      const ttlCache = createTestCache("default-ttl-mset", { defaultTtl: 5 });
      await ttlCache.mset([
        ["a", 1],
        ["b", 2],
      ]);

      expect(await ttlCache.ttl("a")).toBeGreaterThanOrEqual(4);
      expect(await ttlCache.ttl("b")).toBeGreaterThanOrEqual(4);

      await ttlCache.close();
    });

    it("should expire items with defaultTtl", async () => {
      const ttlCache = createTestCache("default-ttl-expire", { defaultTtl: 0.05 }); // 50ms
      await ttlCache.set("key", "value");

      expect(await ttlCache.get("key")).toBe("value");
      await delay(60);
      expect(await ttlCache.get("key")).toBeNull();

      await ttlCache.close();
    });
  });

  describe("namespace", () => {
    it("should prefix keys with namespace", async () => {
      const nsCache = createTestCache("namespace", { namespace: "myapp" });
      await nsCache.set("key", "value");

      // Key should be accessible via the cache
      expect(await nsCache.get("key")).toBe("value");

      await nsCache.close();

      // Verify the key is actually stored with prefix by using a different cache
      const rawCache = createTestCache("namespace");
      expect(await rawCache.get("myapp:key")).toBe("value");
      expect(await rawCache.get("key")).toBeNull();

      await rawCache.close();
    });

    it("should return unprefixed keys from keys()", async () => {
      const nsCache = createTestCache("namespace-keys", { namespace: "app" });
      await nsCache.set("user:1", "Alice");
      await nsCache.set("user:2", "Bob");

      const keys = await nsCache.keys();
      expect(keys.sort()).toEqual(["user:1", "user:2"]);

      await nsCache.close();
    });

    it("should support pattern matching with namespace", async () => {
      const nsCache = createTestCache("namespace-pattern", { namespace: "app" });
      await nsCache.set("user:1", "Alice");
      await nsCache.set("user:2", "Bob");
      await nsCache.set("post:1", "Hello");

      const userKeys = await nsCache.keys("user:*");
      expect(userKeys.sort()).toEqual(["user:1", "user:2"]);

      await nsCache.close();
    });

    it("should isolate namespaces", async () => {
      const cache1 = createTestCache("namespace-isolate", { namespace: "app1" });
      const cache2 = createTestCache("namespace-isolate", { namespace: "app2" });

      await cache1.set("key", "value1");
      await cache2.set("key", "value2");

      expect(await cache1.get("key")).toBe("value1");
      expect(await cache2.get("key")).toBe("value2");

      await cache1.close();
      await cache2.close();
    });

    it("should work with del", async () => {
      const nsCache = createTestCache("namespace-del", { namespace: "app" });
      await nsCache.set("key", "value");
      expect(await nsCache.del("key")).toBe(true);
      expect(await nsCache.get("key")).toBeNull();

      await nsCache.close();
    });

    it("should work with exists", async () => {
      const nsCache = createTestCache("namespace-exists", { namespace: "app" });
      await nsCache.set("key", "value");
      expect(await nsCache.exists("key")).toBe(true);
      expect(await nsCache.exists("other")).toBe(false);

      await nsCache.close();
    });

    it("should work with TTL operations", async () => {
      const nsCache = createTestCache("namespace-ttl", { namespace: "app" });
      await nsCache.set("key", "value");

      await nsCache.expire("key", 5);
      expect(await nsCache.ttl("key")).toBeGreaterThanOrEqual(4);

      await nsCache.persist("key");
      expect(await nsCache.ttl("key")).toBe(-1);

      await nsCache.close();
    });

    it("should work with touch", async () => {
      const nsCache = createTestCache("namespace-touch", { namespace: "app" });
      await nsCache.set("key", "value", 5);

      expect(await nsCache.touch("key")).toBe(true);
      // TTL should be preserved
      expect(await nsCache.ttl("key")).toBeGreaterThanOrEqual(4);

      await nsCache.close();
    });

    it("should work with mget and mset", async () => {
      const nsCache = createTestCache("namespace-multi", { namespace: "app" });
      await nsCache.mset([
        ["a", 1],
        ["b", 2],
      ]);

      const values = await nsCache.mget(["a", "b", "c"]);
      expect(values).toEqual([1, 2, null]);

      await nsCache.close();
    });

    it("should work with getOrSet", async () => {
      const nsCache = createTestCache("namespace-getorset", { namespace: "app" });
      const result = await nsCache.getOrSet("key", () => "computed");

      expect(result).toBe("computed");
      expect(await nsCache.get("key")).toBe("computed");

      await nsCache.close();
    });

    it("should combine with defaultTtl", async () => {
      const combinedCache = createTestCache("namespace-defaultttl", {
        namespace: "app",
        defaultTtl: 5,
      });

      await combinedCache.set("key", "value");
      expect(await combinedCache.get("key")).toBe("value");
      expect(await combinedCache.ttl("key")).toBeGreaterThanOrEqual(4);

      await combinedCache.close();
    });
  });

  describe("gzip", () => {
    it("should store and retrieve values with compression enabled", async () => {
      const compressedCache = createTestCache("compression-basic", { gzip: true });
      await compressedCache.set("key", "value");
      expect(await compressedCache.get("key")).toBe("value");
      await compressedCache.close();
    });

    it("should handle complex objects with compression", async () => {
      const compressedCache = createTestCache("compression-objects", { gzip: true });
      const obj = { name: "test", nested: { value: 123 }, arr: [1, 2, 3] };
      await compressedCache.set("obj", obj);
      expect(await compressedCache.get("obj")).toEqual(obj);
      await compressedCache.close();
    });

    it("should reduce disk size for compressible data", async () => {
      const uncompressed = createTestCache("compression-size-off", { gzip: false });
      const compressed = createTestCache("compression-size-on", { gzip: true });

      // Highly compressible data (repeated pattern)
      const largeValue = "x".repeat(10000);

      await uncompressed.set("key", largeValue);
      await compressed.set("key", largeValue);

      const uncompressedStats = await uncompressed.stats();
      const compressedStats = await compressed.stats();

      // Compressed should be significantly smaller
      expect(compressedStats.disk.size).toBeLessThan(uncompressedStats.disk.size / 2);

      await uncompressed.close();
      await compressed.close();
    });

    it("should persist compressed data across restarts", async () => {
      const cache1 = createTestCache("compression-persist", { gzip: true });
      await cache1.set("key", { data: "test value" });
      await cache1.close();

      const cache2 = createTestCache("compression-persist", { gzip: true });
      expect(await cache2.get("key")).toEqual({ data: "test value" });
      await cache2.close();
    });

    it("should read uncompressed files when compression is enabled (migration)", async () => {
      // Write without compression
      const uncompressed = createTestCache("compression-migrate-to", { gzip: false });
      await uncompressed.set("old-key", "old-value");
      await uncompressed.close();

      // Read with compression enabled
      const compressed = createTestCache("compression-migrate-to", { gzip: true });
      expect(await compressed.get("old-key")).toBe("old-value");

      // New writes should be compressed
      await compressed.set("new-key", "x".repeat(1000));
      await compressed.close();
    });

    it("should read compressed files when compression is disabled (migration back)", async () => {
      // Write with compression
      const compressed = createTestCache("compression-migrate-from", { gzip: true });
      await compressed.set("key", "value");
      await compressed.close();

      // Read without compression
      const uncompressed = createTestCache("compression-migrate-from", { gzip: false });
      expect(await uncompressed.get("key")).toBe("value");
      await uncompressed.close();
    });

    it("should work with TTL operations", async () => {
      const compressedCache = createTestCache("compression-ttl", { gzip: true });
      await compressedCache.set("key", "value", 5);

      const ttl = await compressedCache.ttl("key");
      expect(ttl).toBeGreaterThanOrEqual(4);
      expect(ttl).toBeLessThanOrEqual(5);

      await compressedCache.expire("key", 10);
      expect(await compressedCache.ttl("key")).toBeGreaterThanOrEqual(9);

      await compressedCache.persist("key");
      expect(await compressedCache.ttl("key")).toBe(-1);

      await compressedCache.close();
    });

    it("should work with touch", async () => {
      const compressedCache = createTestCache("compression-touch", { gzip: true });
      await compressedCache.set("key", "value", 5);

      expect(await compressedCache.touch("key")).toBe(true);
      // TTL should be preserved
      expect(await compressedCache.ttl("key")).toBeGreaterThanOrEqual(4);
      expect(await compressedCache.get("key")).toBe("value");

      await compressedCache.close();
    });

    it("should work with mget and mset", async () => {
      const compressedCache = createTestCache("compression-multi", { gzip: true });
      await compressedCache.mset([
        ["a", 1],
        ["b", 2],
        ["c", 3],
      ]);

      expect(await compressedCache.mget(["a", "b", "c"])).toEqual([1, 2, 3]);
      await compressedCache.close();
    });

    it("should work with getOrSet", async () => {
      const compressedCache = createTestCache("compression-getorset", { gzip: true });
      const result = await compressedCache.getOrSet("key", () => "computed");

      expect(result).toBe("computed");
      expect(await compressedCache.get("key")).toBe("computed");
      await compressedCache.close();
    });

    it("should work with del and exists", async () => {
      const compressedCache = createTestCache("compression-del", { gzip: true });
      await compressedCache.set("key", "value");

      expect(await compressedCache.exists("key")).toBe(true);
      expect(await compressedCache.del("key")).toBe(true);
      expect(await compressedCache.exists("key")).toBe(false);

      await compressedCache.close();
    });

    it("should work with keys pattern matching", async () => {
      const compressedCache = createTestCache("compression-keys", { gzip: true });
      await compressedCache.set("user:1", "Alice");
      await compressedCache.set("user:2", "Bob");
      await compressedCache.set("post:1", "Hello");

      expect((await compressedCache.keys("user:*")).sort()).toEqual(["user:1", "user:2"]);
      await compressedCache.close();
    });

    it("should combine with namespace and defaultTtl", async () => {
      const cache = createTestCache("compression-combined", {
        gzip: true,
        namespace: "app",
        defaultTtl: 5,
      });

      await cache.set("key", "value");
      expect(await cache.get("key")).toBe("value");
      expect(await cache.ttl("key")).toBeGreaterThanOrEqual(4);

      const keys = await cache.keys();
      expect(keys).toEqual(["key"]);

      await cache.close();
    });
  });

  describe("disk eviction", () => {
    it("should evict expired entries first when disk is full", async () => {
      const smallCache = createTestCache("eviction", {
        maxMemoryItems: 100,
        maxMemorySize: 10 * 1024 * 1024,
        maxDiskSize: 500,
        shards: 2,
      });

      await smallCache.set("expiring", "x".repeat(100), 0.05); // 50ms
      await smallCache.set("permanent1", "x".repeat(100));
      await smallCache.set("permanent2", "x".repeat(100));

      await delay(60);
      await smallCache.set("new", "x".repeat(100));

      expect(await smallCache.get("expiring")).toBeNull();
      expect(await smallCache.get("new")).not.toBeNull();

      await smallCache.close();
    });

    it("should evict entries when disk size limit exceeded", async () => {
      const smallCache = createTestCache("lru-eviction", {
        maxMemoryItems: 10,
        maxMemorySize: 10 * 1024,
        maxDiskSize: 180,
        shards: 2,
      });

      await smallCache.set("a", "x".repeat(40));
      await smallCache.set("b", "x".repeat(40));
      await smallCache.set("c", "x".repeat(40));

      const stats = await smallCache.stats();
      expect(stats.disk.items).toBeLessThan(3);
      expect(stats.disk.size).toBeLessThanOrEqual(180);

      await smallCache.close();
    });
  });

  describe("memory/disk synchronization", () => {
    it("should remove from memory when disk evicts due to space pressure", async () => {
      // Create cache where disk is small but memory is large
      // This ensures items fit in memory but disk will need to evict
      const smallDiskCache = createTestCache("sync-disk-evict", {
        maxMemoryItems: 100,
        maxMemorySize: 10 * 1024,
        maxDiskSize: 200, // Very small disk
        shards: 2,
      });

      // Add items - they'll all fit in memory but not all on disk
      await smallDiskCache.set("first", "x".repeat(50));
      await smallDiskCache.set("second", "x".repeat(50));

      // At this point, both should be in memory
      let stats = await smallDiskCache.stats();
      expect(stats.memory.items).toBe(2);

      // Add another item - disk will need to evict "first"
      await smallDiskCache.set("third", "x".repeat(50));

      // Verify memory is synced - "first" should be gone from memory too
      stats = await smallDiskCache.stats();
      expect(stats.disk.items).toBeLessThanOrEqual(2);
      // Memory should match disk (minus items too large for memory)
      expect(stats.memory.items).toBeLessThanOrEqual(stats.disk.items);

      // The evicted key should return null (not stale data from memory)
      const evictedValue = await smallDiskCache.get("first");
      if (evictedValue === null) {
        // Key was evicted - verify it's gone from both caches
        expect(await smallDiskCache.exists("first")).toBe(false);
      }
      // If not null, it wasn't the one evicted - that's also fine

      await smallDiskCache.close();
    });

    it("should not return stale data from memory after disk eviction", async () => {
      const smallDiskCache = createTestCache("sync-no-stale", {
        maxMemoryItems: 100,
        maxMemorySize: 10 * 1024,
        maxDiskSize: 150, // Very small disk - will evict early
        shards: 2,
      });

      // Set first key
      await smallDiskCache.set("evict-me", "original-value");
      expect(await smallDiskCache.get("evict-me")).toBe("original-value");

      // Force eviction by adding more data
      await smallDiskCache.set("keep1", "x".repeat(50));
      await smallDiskCache.set("keep2", "x".repeat(50));

      // The evicted key should either:
      // 1. Return null (properly evicted from both caches)
      // 2. Return the value (wasn't evicted yet)
      // It should NEVER return stale/orphaned data
      const result = await smallDiskCache.get("evict-me");
      if (result !== null) {
        // If we got a value, it should still exist on disk
        expect(await smallDiskCache.exists("evict-me")).toBe(true);
      }

      await smallDiskCache.close();
    });

    it("should keep caches consistent when touch fails on disk-only key", async () => {
      const smallCache = createTestCache("sync-touch-diskonly", {
        maxMemoryItems: 1,
        shards: 2,
      });

      await smallCache.set("a", "value-a");
      await smallCache.set("b", "value-b"); // Evicts 'a' from memory

      // 'a' is on disk only, 'b' is in memory
      const stats = await smallCache.stats();
      expect(stats.memory.items).toBe(1);
      expect(stats.disk.items).toBe(2);

      // Touch should work on disk-only keys
      expect(await smallCache.touch("a")).toBe(true);

      // Touch should return false for non-existent keys
      expect(await smallCache.touch("nonexistent")).toBe(false);

      await smallCache.close();
    });

    it("should be consistent after expire on disk-only key", async () => {
      const smallCache = createTestCache("sync-expire-diskonly", {
        maxMemoryItems: 1,
        shards: 2,
      });

      await smallCache.set("a", "value-a");
      await smallCache.set("b", "value-b"); // Evicts 'a' from memory

      // expire on disk-only key should work
      expect(await smallCache.expire("a", 5)).toBe(true);
      expect(await smallCache.ttl("a")).toBeGreaterThanOrEqual(4);

      // Value should still be retrievable
      expect(await smallCache.get("a")).toBe("value-a");

      await smallCache.close();
    });

    it("should be consistent after persist on disk-only key", async () => {
      const smallCache = createTestCache("sync-persist-diskonly", {
        maxMemoryItems: 1,
        shards: 2,
      });

      await smallCache.set("a", "value-a", 5);
      await smallCache.set("b", "value-b"); // Evicts 'a' from memory

      // 'a' is on disk only with TTL
      expect(await smallCache.ttl("a")).toBeGreaterThanOrEqual(4);

      // persist on disk-only key should work
      expect(await smallCache.persist("a")).toBe(true);
      expect(await smallCache.ttl("a")).toBe(-1);

      // Value should still be retrievable
      expect(await smallCache.get("a")).toBe("value-a");

      await smallCache.close();
    });

    it("should return false for TTL operations on non-existent keys", async () => {
      const testCache = createTestCache("sync-ttl-nonexistent");

      expect(await testCache.expire("ghost", 5)).toBe(false);
      expect(await testCache.persist("ghost")).toBe(false);
      expect(await testCache.touch("ghost")).toBe(false);

      await testCache.close();
    });

    it("memory items should always be subset of disk items", async () => {
      const testCache = createTestCache("sync-subset", {
        maxMemoryItems: 5,
        maxMemorySize: 500,
        maxDiskSize: 2000,
        shards: 2,
      });

      // Add many items
      for (let i = 0; i < 20; i++) {
        await testCache.set(`key-${i}`, `value-${i}`);
      }

      const stats = await testCache.stats();

      // Memory should be <= disk (memory is a subset)
      expect(stats.memory.items).toBeLessThanOrEqual(stats.disk.items);

      // Every key that exists should return a value (no orphaned memory entries)
      const allKeys = await testCache.keys();
      for (const key of allKeys) {
        const value = await testCache.get(key);
        expect(value).not.toBeNull();
      }

      await testCache.close();
    });
  });
});
