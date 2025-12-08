import { describe, it, expect, beforeEach } from "vitest";
import { MemoryStore } from "../src/memory-store.js";
import { delay } from "./test-utils.js";

describe("MemoryStore", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore({ maxItems: 100, maxSize: 1024 * 1024 });
  });

  describe("get/set", () => {
    it("should store and retrieve values", () => {
      store.set("key1", "value1");
      expect(store.get("key1")).toBe("value1");
    });

    it("should return null for non-existent keys", () => {
      expect(store.get("nonexistent")).toBeNull();
    });

    it("should store complex objects", () => {
      const obj = { name: "test", nested: { value: 123 } };
      store.set("obj", obj);
      expect(store.get("obj")).toEqual(obj);
    });

    it("should overwrite existing values", () => {
      store.set("key", "value1");
      store.set("key", "value2");
      expect(store.get("key")).toBe("value2");
    });
  });

  describe("delete", () => {
    it("should delete existing keys", () => {
      store.set("key", "value");
      expect(store.delete("key")).toBe(true);
      expect(store.get("key")).toBeNull();
    });

    it("should return false for non-existent keys", () => {
      expect(store.delete("nonexistent")).toBe(false);
    });
  });

  describe("has", () => {
    it("should return true for existing keys", () => {
      store.set("key", "value");
      expect(store.has("key")).toBe(true);
    });

    it("should return false for non-existent keys", () => {
      expect(store.has("nonexistent")).toBe(false);
    });
  });

  describe("keys", () => {
    it("should return all keys", () => {
      store.set("a", 1);
      store.set("b", 2);
      store.set("c", 3);
      expect(store.keys()).toEqual(["a", "b", "c"]);
    });

    it("should support wildcard pattern", () => {
      store.set("user:1", { id: 1 });
      store.set("user:2", { id: 2 });
      store.set("post:1", { id: 1 });
      expect(store.keys("user:*")).toEqual(["user:1", "user:2"]);
    });
  });

  describe("TTL", () => {
    it("should expire keys after TTL", async () => {
      store.set("key", "value", Date.now() + 50);
      expect(store.get("key")).toBe("value");

      await delay(60);
      expect(store.get("key")).toBeNull();
    });

    it("should return correct TTL", () => {
      const expiresAt = Date.now() + 1000;
      store.set("key", "value", expiresAt);
      const ttl = store.getTtl("key");
      expect(ttl).toBeGreaterThan(900);
      expect(ttl).toBeLessThanOrEqual(1000);
    });

    it("should return -1 for keys without expiry", () => {
      store.set("key", "value");
      expect(store.getTtl("key")).toBe(-1);
    });

    it("should return -2 for non-existent keys", () => {
      expect(store.getTtl("nonexistent")).toBe(-2);
    });

    it("should allow updating expiry", () => {
      store.set("key", "value", Date.now() + 1000);
      store.setExpiry("key", Date.now() + 5000);
      expect(store.getTtl("key")).toBeGreaterThan(4000);
    });
  });

  describe("LRU eviction", () => {
    it("should evict oldest items when max items exceeded", () => {
      const smallStore = new MemoryStore({ maxItems: 3, maxSize: 1024 * 1024 });

      smallStore.set("a", 1);
      smallStore.set("b", 2);
      smallStore.set("c", 3);
      smallStore.set("d", 4);

      expect(smallStore.get("a")).toBeNull(); // evicted
      expect(smallStore.get("b")).toBe(2);
      expect(smallStore.get("c")).toBe(3);
      expect(smallStore.get("d")).toBe(4);
    });

    it("should promote accessed items to most recent", () => {
      const smallStore = new MemoryStore({ maxItems: 3, maxSize: 1024 * 1024 });

      smallStore.set("a", 1);
      smallStore.set("b", 2);
      smallStore.set("c", 3);

      smallStore.get("a"); // Promote 'a'
      smallStore.set("d", 4); // Evicts 'b' (oldest)

      expect(smallStore.get("a")).toBe(1);
      expect(smallStore.get("b")).toBeNull();
      expect(smallStore.get("c")).toBe(3);
      expect(smallStore.get("d")).toBe(4);
    });

    it("should evict expired entries before LRU entries", async () => {
      const smallStore = new MemoryStore({ maxItems: 3, maxSize: 1024 * 1024 });

      smallStore.set("expiring", "value", Date.now() + 50);
      smallStore.set("permanent1", "value");
      smallStore.set("permanent2", "value");

      await delay(60);
      smallStore.set("new", "value");

      expect(smallStore.get("expiring")).toBeNull();
      expect(smallStore.get("permanent1")).toBe("value");
    });
  });

  describe("size limits", () => {
    it("should evict when size exceeded", () => {
      const smallStore = new MemoryStore({ maxItems: 1000, maxSize: 100 });

      smallStore.set("a", "aaaaaaaaaa");
      smallStore.set("b", "bbbbbbbbbb");
      smallStore.set("c", "cccccccccc");
      smallStore.set("d", "dddddddddd");
      smallStore.set("e", "eeeeeeeeee");

      expect(smallStore.stats.size).toBeLessThanOrEqual(100);
    });
  });

  describe("clear", () => {
    it("should remove all items", () => {
      store.set("a", 1);
      store.set("b", 2);
      store.clear();
      expect(store.keys()).toEqual([]);
      expect(store.stats.items).toBe(0);
      expect(store.stats.size).toBe(0);
    });
  });

  describe("peek", () => {
    it("should return entry without promoting to MRU", () => {
      const smallStore = new MemoryStore({ maxItems: 3, maxSize: 1024 * 1024 });

      smallStore.set("a", 1);
      smallStore.set("b", 2);
      smallStore.set("c", 3);

      expect(smallStore.peek("a")?.value).toBe(1);
      smallStore.set("d", 4); // Evicts 'a' since peek didn't promote it

      expect(smallStore.get("a")).toBeNull();
      expect(smallStore.get("b")).toBe(2);
    });

    it("should return null for non-existent keys", () => {
      expect(store.peek("nonexistent")).toBeNull();
    });

    it("should return null for expired keys", async () => {
      store.set("key", "value", Date.now() + 50);
      await delay(60);
      expect(store.peek("key")).toBeNull();
    });
  });

  describe("has with expired entries", () => {
    it("should return false and clean up expired entries", async () => {
      store.set("key", "value", Date.now() + 50);
      expect(store.has("key")).toBe(true);

      await delay(60);
      expect(store.has("key")).toBe(false);
      expect(store.stats.items).toBe(0);
    });
  });

  describe("setExpiry", () => {
    it("should return false for non-existent keys", () => {
      expect(store.setExpiry("nonexistent", Date.now() + 1000)).toBe(false);
    });

    it("should return false for expired keys", async () => {
      store.set("key", "value", Date.now() + 50);
      await delay(60);
      expect(store.setExpiry("key", Date.now() + 1000)).toBe(false);
    });

    it("should allow removing expiry", () => {
      store.set("key", "value", Date.now() + 1000);
      expect(store.getTtl("key")).toBeGreaterThan(0);

      store.setExpiry("key", null);
      expect(store.getTtl("key")).toBe(-1);
    });
  });

  describe("keys with expired entries", () => {
    it("should clean up expired entries when listing keys", async () => {
      store.set("expiring", "value", Date.now() + 50);
      store.set("permanent", "value");

      expect(store.keys().sort()).toEqual(["expiring", "permanent"]);

      await delay(60);
      expect(store.keys()).toEqual(["permanent"]);
      expect(store.stats.items).toBe(1);
    });
  });
});
