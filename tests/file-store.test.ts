import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs } from "fs";
import { FileStore } from "../src/file-store.js";
import { delay, testDir, createTestFileStore, registerCleanup } from "./test-utils.js";

describe("FileStore", () => {
  let store: FileStore;

  beforeEach(() => {
    store = createTestFileStore("file-store");
  });

  describe("get/set", () => {
    it("should store and retrieve values", async () => {
      await store.set("key1", "value1");
      const entry = await store.get("key1");
      expect(entry?.value).toBe("value1");
    });

    it("should return null for non-existent keys", async () => {
      expect(await store.get("nonexistent")).toBeNull();
    });

    it("should store complex objects", async () => {
      const obj = { name: "test", nested: { value: 123 } };
      await store.set("obj", obj);
      const entry = await store.get("obj");
      expect(entry?.value).toEqual(obj);
    });

    it("should overwrite existing values", async () => {
      await store.set("key", "value1");
      await store.set("key", "value2");
      const entry = await store.get("key");
      expect(entry?.value).toBe("value2");
    });

    it("should create shard directories", async () => {
      await store.set("key", "value");
      const dir = testDir("file-store");
      const entries = await fs.readdir(dir);
      expect(entries.length).toBeGreaterThan(0);
    });
  });

  describe("delete", () => {
    it("should delete existing keys", async () => {
      await store.set("key", "value");
      expect(await store.delete("key")).toBe(true);
      expect(await store.get("key")).toBeNull();
    });

    it("should return false for non-existent keys", async () => {
      expect(await store.delete("nonexistent")).toBe(false);
    });
  });

  describe("has", () => {
    it("should return true for existing keys", async () => {
      await store.set("key", "value");
      expect(await store.has("key")).toBe(true);
    });

    it("should return false for non-existent keys", async () => {
      expect(await store.has("nonexistent")).toBe(false);
    });
  });

  describe("keys", () => {
    it("should return all keys", async () => {
      await store.set("a", 1);
      await store.set("b", 2);
      await store.set("c", 3);
      expect((await store.keys()).sort()).toEqual(["a", "b", "c"]);
    });

    it("should support wildcard pattern", async () => {
      await store.set("user:1", { id: 1 });
      await store.set("user:2", { id: 2 });
      await store.set("post:1", { id: 1 });
      expect((await store.keys("user:*")).sort()).toEqual(["user:1", "user:2"]);
    });
  });

  describe("TTL", () => {
    it("should expire keys after TTL", async () => {
      await store.set("key", "value", Date.now() + 50);
      expect((await store.get("key"))?.value).toBe("value");

      await delay(60);
      expect(await store.get("key")).toBeNull();
    });

    it("should return correct TTL", async () => {
      const expiresAt = Date.now() + 1000;
      await store.set("key", "value", expiresAt);
      const ttl = await store.getTtl("key");
      expect(ttl).toBeGreaterThan(900);
      expect(ttl).toBeLessThanOrEqual(1000);
    });

    it("should return -1 for keys without expiry", async () => {
      await store.set("key", "value");
      expect(await store.getTtl("key")).toBe(-1);
    });

    it("should return -2 for non-existent keys", async () => {
      expect(await store.getTtl("nonexistent")).toBe(-2);
    });

    it("should allow updating expiry", async () => {
      await store.set("key", "value", Date.now() + 1000);
      await store.setExpiry("key", Date.now() + 5000);
      expect(await store.getTtl("key")).toBeGreaterThan(4000);
    });
  });

  describe("sharding", () => {
    it("should distribute files across shards", async () => {
      for (let i = 0; i < 20; i++) {
        await store.set(`key-${i}`, i);
      }

      const dir = testDir("file-store");
      const shardCounts: number[] = [];
      for (let i = 0; i < 4; i++) {
        const shardDir = `${dir}/${i.toString(16).padStart(2, "0")}`;
        try {
          const files = await fs.readdir(shardDir);
          shardCounts.push(files.length);
        } catch {
          shardCounts.push(0);
        }
      }

      const nonEmptyShards = shardCounts.filter((c) => c > 0).length;
      expect(nonEmptyShards).toBeGreaterThanOrEqual(2);
    });
  });

  describe("clear", () => {
    it("should remove all items", async () => {
      await store.set("a", 1);
      await store.set("b", 2);
      await store.clear();
      expect(await store.keys()).toEqual([]);
    });
  });

  describe("size tracking", () => {
    it("should track total size", async () => {
      await store.set("key", "a".repeat(100));
      expect(await store.getSize()).toBeGreaterThan(100);
    });

    it("should track item count", async () => {
      expect(await store.getItemCount()).toBe(0);
      await store.set("a", 1);
      expect(await store.getItemCount()).toBe(1);
      await store.set("b", 2);
      expect(await store.getItemCount()).toBe(2);
      await store.delete("a");
      expect(await store.getItemCount()).toBe(1);
      await store.clear();
      expect(await store.getItemCount()).toBe(0);
    });

    it("should update size correctly when overwriting", async () => {
      await store.set("key", "short");
      const size1 = await store.getSize();
      await store.set("key", "a much longer value");
      const size2 = await store.getSize();

      expect(size2).toBeGreaterThan(size1);
      expect(await store.getItemCount()).toBe(1);
    });

    it("should update totalSize when setExpiry changes file size", async () => {
      await store.set("key", "value");
      const sizeWithoutTtl = await store.getSize();

      await store.setExpiry("key", Date.now() + 10000);
      const sizeWithTtl = await store.getSize();

      expect(sizeWithTtl).not.toBe(sizeWithoutTtl);
    });
  });

  describe("peek", () => {
    it("should return entry without updating access time", async () => {
      await store.set("a", "value-a");
      await delay(10);
      await store.set("b", "value-b");

      const entry = await store.peek("a");
      expect(entry?.value).toBe("value-a");

      const getEntry = await store.get("a");
      expect(getEntry?.value).toBe("value-a");
    });

    it("should return null for non-existent keys", async () => {
      expect(await store.peek("nonexistent")).toBeNull();
    });

    it("should return null for expired keys", async () => {
      await store.set("key", "value", Date.now() + 50);
      await delay(60);
      expect(await store.peek("key")).toBeNull();
    });
  });

  describe("LRU eviction", () => {
    it("should evict oldest entries when size limit exceeded", async () => {
      const dir = testDir("lru");
      registerCleanup(dir);
      const smallStore = new FileStore({ dir, shards: 2, maxSize: 180 });

      await smallStore.set("first", "x".repeat(40));
      await delay(5);
      await smallStore.set("second", "x".repeat(40));
      await delay(5);
      await smallStore.get("first"); // Promote 'first'
      await delay(5);
      await smallStore.set("third", "x".repeat(40));

      expect(await smallStore.get("second")).toBeNull();
      expect(await smallStore.get("first")).not.toBeNull();
      expect(await smallStore.get("third")).not.toBeNull();
    });

    it("should evict expired entries before LRU entries", async () => {
      const dir = testDir("expire-lru");
      registerCleanup(dir);
      const smallStore = new FileStore({ dir, shards: 2, maxSize: 250 });

      await smallStore.set("expiring", "x".repeat(50), Date.now() + 50);
      await smallStore.set("permanent", "x".repeat(50));
      await delay(60);
      await smallStore.set("new", "x".repeat(50));

      expect(await smallStore.get("expiring")).toBeNull();
      expect(await smallStore.get("permanent")).not.toBeNull();
    });
  });

  describe("persistence and recovery", () => {
    it("should recover index from disk on restart", async () => {
      await store.set("key1", "value1");
      await store.set("key2", "value2", Date.now() + 60000);

      const dir = testDir("file-store");
      const newStore = new FileStore({ dir, shards: 4, maxSize: 1024 * 1024 });

      expect((await newStore.get("key1"))?.value).toBe("value1");
      expect((await newStore.get("key2"))?.value).toBe("value2");
      expect(await newStore.getItemCount()).toBe(2);
    });

    it("should clean up expired entries on load", async () => {
      await store.set("expiring", "value", Date.now() + 50);
      await store.set("permanent", "value");
      await delay(60);

      const dir = testDir("file-store");
      const newStore = new FileStore({ dir, shards: 4, maxSize: 1024 * 1024 });
      await newStore.keys(); // Force initialization

      expect(await newStore.getItemCount()).toBe(1);
      expect(await newStore.get("permanent")).not.toBeNull();
    });
  });

  describe("onEvict callback", () => {
    it("should call onEvict when LRU eviction occurs", async () => {
      const evictedKeys: string[] = [];
      const dir = testDir("evict-callback-lru");
      registerCleanup(dir);

      const smallStore = new FileStore({
        dir,
        shards: 2,
        maxSize: 200,
        onEvict: (key) => evictedKeys.push(key),
      });

      // Fill up the store
      await smallStore.set("first", "x".repeat(50));
      await delay(5);
      await smallStore.set("second", "x".repeat(50));
      await delay(5);

      // This should trigger eviction of "first"
      await smallStore.set("third", "x".repeat(50));

      // Verify callback was called
      expect(evictedKeys.length).toBeGreaterThan(0);
      expect(evictedKeys).toContain("first");
    });

    it("should call onEvict when expired entries are evicted during space check", async () => {
      const evictedKeys: string[] = [];
      const dir = testDir("evict-callback-expire");
      registerCleanup(dir);

      const smallStore = new FileStore({
        dir,
        shards: 2,
        maxSize: 200,
        onEvict: (key) => evictedKeys.push(key),
      });

      // Set an expiring key
      await smallStore.set("expiring", "x".repeat(50), Date.now() + 50);
      await smallStore.set("permanent", "x".repeat(50));

      // Wait for expiration
      await delay(60);

      // This should trigger eviction of expired "expiring" key
      await smallStore.set("new", "x".repeat(50));

      expect(evictedKeys).toContain("expiring");
    });

    it("should NOT call onEvict for explicit delete operations", async () => {
      const evictedKeys: string[] = [];
      const dir = testDir("evict-callback-delete");
      registerCleanup(dir);

      const storeWithCallback = new FileStore({
        dir,
        shards: 2,
        maxSize: 1024 * 1024,
        onEvict: (key) => evictedKeys.push(key),
      });

      await storeWithCallback.set("key", "value");
      await storeWithCallback.delete("key");

      // delete() is explicit, not eviction - should NOT trigger callback
      expect(evictedKeys).not.toContain("key");
    });

    it("should work correctly without onEvict callback", async () => {
      const dir = testDir("no-callback");
      registerCleanup(dir);

      // No callback - should not throw
      const storeNoCallback = new FileStore({
        dir,
        shards: 2,
        maxSize: 150,
      });

      await storeNoCallback.set("a", "x".repeat(40));
      await storeNoCallback.set("b", "x".repeat(40));
      await storeNoCallback.set("c", "x".repeat(40)); // Triggers eviction

      expect(await storeNoCallback.getItemCount()).toBeLessThan(3);
    });
  });
});
