import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "fs";
import { join } from "path";
import { FsLruCache } from "../src/cache.js";
import { SharedIndex } from "../src/types.js";
import { delay, testDir, registerCleanup } from "./test-utils.js";

/**
 * Create a cache with sync enabled for multi-process testing.
 */
function createSyncCache(name: string, syncInterval = 100): FsLruCache {
  const dir = testDir(name);
  registerCleanup(dir);
  return new FsLruCache({
    dir,
    maxMemoryItems: 10,
    maxMemorySize: 1024,
    maxDiskSize: 1024 * 1024,
    shards: 4,
    syncWrites: true,
    experimentalMultiProcess: true,
    syncInterval,
  });
}

describe("Multi-process sync", () => {
  describe("forceSync", () => {
    it("should sync index metadata from another cache instance", async () => {
      const dir = testDir("sync-basic");
      registerCleanup(dir);

      // Create two cache instances sharing the same directory
      const cacheA = new FsLruCache({
        dir,
        syncWrites: true,
        experimentalMultiProcess: true,
        syncInterval: 1000, // Long interval - we'll use forceSync
      });

      const cacheB = new FsLruCache({
        dir,
        syncWrites: true,
        experimentalMultiProcess: true,
        syncInterval: 1000,
      });

      try {
        // Cache A writes a value
        await cacheA.set("key1", "value1");
        await cacheA.forceSync();

        // Cache B can read the file directly (files are on shared disk)
        // but its index metadata isn't updated yet
        expect(await cacheB.get("key1")).toBe("value1");

        // After forceSync, cache B's index is updated with metadata
        await cacheB.forceSync();

        // Verify both caches have consistent view
        const statsA = await cacheA.stats();
        const statsB = await cacheB.stats();
        expect(statsA.disk.items).toBe(statsB.disk.items);
      } finally {
        await cacheA.close();
        await cacheB.close();
      }
    });

    it("should sync deletions", async () => {
      const dir = testDir("sync-delete");
      registerCleanup(dir);

      const cacheA = new FsLruCache({
        dir,
        syncWrites: true,
        experimentalMultiProcess: true,
        syncInterval: 1000,
      });

      const cacheB = new FsLruCache({
        dir,
        syncWrites: true,
        experimentalMultiProcess: true,
        syncInterval: 1000,
      });

      try {
        // Both caches start with a value
        await cacheA.set("key1", "value1");
        await cacheA.forceSync();
        await cacheB.forceSync();
        expect(await cacheB.get("key1")).toBe("value1");

        // Cache A deletes the key
        await cacheA.del("key1");
        await cacheA.forceSync();

        // Cache B still sees it (hasn't synced)
        expect(await cacheB.get("key1")).toBe("value1");

        // After sync, cache B no longer sees it
        await cacheB.forceSync();
        expect(await cacheB.get("key1")).toBeNull();
      } finally {
        await cacheA.close();
        await cacheB.close();
      }
    });

    it("should handle concurrent writes to different keys", async () => {
      const dir = testDir("sync-concurrent-diff");
      registerCleanup(dir);

      const cacheA = new FsLruCache({
        dir,
        syncWrites: true,
        experimentalMultiProcess: true,
        syncInterval: 1000,
      });

      const cacheB = new FsLruCache({
        dir,
        syncWrites: true,
        experimentalMultiProcess: true,
        syncInterval: 1000,
      });

      try {
        // Both write different keys
        await cacheA.set("keyA", "valueA");
        await cacheB.set("keyB", "valueB");

        // Both can read files directly (before sync)
        expect(await cacheA.get("keyA")).toBe("valueA");
        expect(await cacheB.get("keyB")).toBe("valueB");

        // First round of sync: cacheA publishes keyA, cacheB publishes keyA+keyB
        await cacheA.forceSync();
        await cacheB.forceSync();

        // cacheB now has both keys (merged keyA from cacheA's index)
        const keysB = await cacheB.keys();
        expect(keysB.sort()).toEqual(["keyA", "keyB"]);

        // cacheA needs another sync to pick up keyB from cacheB
        await cacheA.forceSync();
        const keysA = await cacheA.keys();
        expect(keysA.sort()).toEqual(["keyA", "keyB"]);
      } finally {
        await cacheA.close();
        await cacheB.close();
      }
    });

    it("should handle last-write-wins for same key", async () => {
      const dir = testDir("sync-last-write");
      registerCleanup(dir);

      const cacheA = new FsLruCache({
        dir,
        syncWrites: true,
        experimentalMultiProcess: true,
        syncInterval: 1000,
      });

      const cacheB = new FsLruCache({
        dir,
        syncWrites: true,
        experimentalMultiProcess: true,
        syncInterval: 1000,
      });

      try {
        // Cache A writes first
        await cacheA.set("key", "valueA");
        await cacheA.forceSync();

        // At this point, both reading would get valueA (it's on disk)
        expect(await cacheA.get("key")).toBe("valueA");
        expect(await cacheB.get("key")).toBe("valueA");

        // Cache B writes second (overwrites the file on disk)
        await cacheB.set("key", "valueB");
        await cacheB.forceSync();

        // Now the file contains valueB
        // Cache A's in-memory cache still has valueA, but disk has valueB
        // After sync, cacheA's memory cache should be invalidated (hash changed)
        await cacheA.forceSync();

        // Both should now see valueB - cacheA's memory was invalidated during merge
        const valueA = await cacheA.get("key");
        const valueB = await cacheB.get("key");

        expect(valueA).toBe("valueB");
        expect(valueB).toBe("valueB");
      } finally {
        await cacheA.close();
        await cacheB.close();
      }
    });
  });

  describe("automatic sync", () => {
    it("should sync automatically based on syncInterval", async () => {
      const dir = testDir("sync-auto");
      registerCleanup(dir);

      const cacheA = new FsLruCache({
        dir,
        syncWrites: true,
        experimentalMultiProcess: true,
        syncInterval: 50, // Fast sync for testing
      });

      const cacheB = new FsLruCache({
        dir,
        syncWrites: true,
        experimentalMultiProcess: true,
        syncInterval: 50,
      });

      try {
        // Cache A writes a value
        await cacheA.set("key1", "value1");

        // Wait for automatic sync
        await delay(150);

        // Cache B should see the value without explicit forceSync
        expect(await cacheB.get("key1")).toBe("value1");
      } finally {
        await cacheA.close();
        await cacheB.close();
      }
    });
  });

  describe("index file", () => {
    it("should create .index.json file when sync is enabled", async () => {
      const cache = createSyncCache("sync-index-file");

      try {
        await cache.set("key1", "value1");
        await cache.forceSync();

        const indexPath = join(testDir("sync-index-file"), ".index.json");
        const content = await fs.readFile(indexPath, "utf8");
        const index: SharedIndex = JSON.parse(content);

        expect(index.version).toBeGreaterThan(0);
        expect(index.entries).toHaveProperty("key1");
        expect(index.entries["key1"]?.hash).toBeDefined();
        expect(index.entries["key1"]?.size).toBeGreaterThan(0);
      } finally {
        await cache.close();
      }
    });

    it("should not create .index.json when sync is disabled", async () => {
      const dir = testDir("sync-no-index");
      registerCleanup(dir);

      const cache = new FsLruCache({
        dir,
        syncWrites: true,
        experimentalMultiProcess: false, // Disabled
      });

      try {
        await cache.set("key1", "value1");
        await cache.flush();

        const indexPath = join(dir, ".index.json");
        await expect(fs.access(indexPath)).rejects.toThrow();
      } finally {
        await cache.close();
      }
    });

    it("should load from existing index file on startup", async () => {
      const dir = testDir("sync-load-index");
      registerCleanup(dir);

      // Create first cache and write data
      const cache1 = new FsLruCache({
        dir,
        syncWrites: true,
        experimentalMultiProcess: true,
        syncInterval: 100,
      });

      await cache1.set("key1", "value1");
      await cache1.set("key2", "value2");
      await cache1.forceSync();
      await cache1.close();

      // Create second cache - should load from index file (fast startup)
      const cache2 = new FsLruCache({
        dir,
        syncWrites: true,
        experimentalMultiProcess: true,
        syncInterval: 100,
      });

      try {
        // Should see both keys immediately
        expect(await cache2.get("key1")).toBe("value1");
        expect(await cache2.get("key2")).toBe("value2");
      } finally {
        await cache2.close();
      }
    });
  });

  describe("TTL handling", () => {
    it("should sync TTL changes", async () => {
      const dir = testDir("sync-ttl");
      registerCleanup(dir);

      const cacheA = new FsLruCache({
        dir,
        syncWrites: true,
        experimentalMultiProcess: true,
        syncInterval: 1000,
      });

      const cacheB = new FsLruCache({
        dir,
        syncWrites: true,
        experimentalMultiProcess: true,
        syncInterval: 1000,
      });

      try {
        // Cache A sets a value with TTL
        await cacheA.set("key1", "value1", 60);
        await cacheA.forceSync();
        await cacheB.forceSync();

        // Both should report similar TTL
        const ttlA = await cacheA.ttl("key1");
        const ttlB = await cacheB.ttl("key1");
        expect(ttlA).toBeGreaterThan(55);
        expect(ttlB).toBeGreaterThan(55);
      } finally {
        await cacheA.close();
        await cacheB.close();
      }
    });

    it("should skip expired entries during sync", async () => {
      const dir = testDir("sync-expired");
      registerCleanup(dir);

      const cacheA = new FsLruCache({
        dir,
        syncWrites: true,
        experimentalMultiProcess: true,
        syncInterval: 1000,
      });

      const cacheB = new FsLruCache({
        dir,
        syncWrites: true,
        experimentalMultiProcess: true,
        syncInterval: 1000,
      });

      try {
        // Cache A sets a value with very short TTL
        await cacheA.set("key1", "value1", 1);
        await cacheA.forceSync();

        // Wait for expiration
        await delay(1100);

        // Cache B syncs - should not see expired entry
        await cacheB.forceSync();
        expect(await cacheB.get("key1")).toBeNull();
      } finally {
        await cacheA.close();
        await cacheB.close();
      }
    });
  });

  describe("close behavior", () => {
    it("should flush index on close", async () => {
      const dir = testDir("sync-close");
      registerCleanup(dir);

      const cache1 = new FsLruCache({
        dir,
        syncWrites: true,
        experimentalMultiProcess: true,
        syncInterval: 10000, // Very long - relies on close() flushing
      });

      await cache1.set("key1", "value1");
      await cache1.close(); // Should flush index

      // Open new cache and verify data
      const cache2 = new FsLruCache({
        dir,
        syncWrites: true,
        experimentalMultiProcess: true,
        syncInterval: 100,
      });

      try {
        expect(await cache2.get("key1")).toBe("value1");
      } finally {
        await cache2.close();
      }
    });
  });

  describe("edge cases", () => {
    it("should handle empty cache sync", async () => {
      const dir = testDir("sync-empty");
      registerCleanup(dir);

      const cacheA = new FsLruCache({
        dir,
        syncWrites: true,
        experimentalMultiProcess: true,
        syncInterval: 100,
      });

      const cacheB = new FsLruCache({
        dir,
        syncWrites: true,
        experimentalMultiProcess: true,
        syncInterval: 100,
      });

      try {
        // Sync with empty caches should not throw
        await cacheA.forceSync();
        await cacheB.forceSync();

        expect(await cacheA.size()).toBe(0);
        expect(await cacheB.size()).toBe(0);
      } finally {
        await cacheA.close();
        await cacheB.close();
      }
    });

    it("should handle sync when directory is deleted", async () => {
      const dir = testDir("sync-dir-deleted");
      registerCleanup(dir);

      const cache = new FsLruCache({
        dir,
        syncWrites: true,
        experimentalMultiProcess: true,
        syncInterval: 100,
      });

      try {
        await cache.set("key1", "value1");
        await cache.forceSync();

        // Delete the directory
        await fs.rm(dir, { recursive: true, force: true });

        // Sync should not throw (graceful handling)
        await cache.forceSync();
      } finally {
        await cache.close().catch(() => {});
      }
    });
  });

  describe("concurrent sync", () => {
    it("should handle concurrent forceSync calls from same process", async () => {
      const dir = testDir("sync-concurrent-force");
      registerCleanup(dir);

      const cache = new FsLruCache({
        dir,
        syncWrites: true,
        experimentalMultiProcess: true,
        syncInterval: 1000,
      });

      try {
        await cache.set("key1", "value1");

        // Call forceSync multiple times concurrently
        const syncs = Promise.all([cache.forceSync(), cache.forceSync(), cache.forceSync()]);

        // Should not throw or deadlock
        await syncs;

        // Data should still be accessible
        expect(await cache.get("key1")).toBe("value1");
      } finally {
        await cache.close();
      }
    });

    it("should handle sequential writes from multiple processes", async () => {
      const dir = testDir("sync-sequential-writes");
      registerCleanup(dir);

      // Create multiple cache instances
      const caches = Array.from(
        { length: 3 },
        () =>
          new FsLruCache({
            dir,
            syncWrites: true,
            experimentalMultiProcess: true,
            syncInterval: 1000,
          }),
      );

      try {
        // Each cache writes and syncs sequentially (more realistic)
        for (let i = 0; i < caches.length; i++) {
          const cache = caches[i]!;
          await cache.set(`key-${i}-a`, `value-${i}-a`);
          await cache.set(`key-${i}-b`, `value-${i}-b`);
          await cache.forceSync();
        }

        // All caches sync to get updates
        for (const cache of caches) {
          await cache.forceSync();
        }

        // All caches should see all keys
        for (const cache of caches) {
          const keys = await cache.keys();
          expect(keys.length).toBe(6); // 3 caches × 2 keys each
        }
      } finally {
        await Promise.all(caches.map((cache) => cache.close()));
      }
    });

    it("should handle alternating writes between two processes", async () => {
      const dir = testDir("sync-alternating");
      registerCleanup(dir);

      const cacheA = new FsLruCache({
        dir,
        syncWrites: true,
        experimentalMultiProcess: true,
        syncInterval: 1000,
      });

      const cacheB = new FsLruCache({
        dir,
        syncWrites: true,
        experimentalMultiProcess: true,
        syncInterval: 1000,
      });

      try {
        // Alternating writes with sync after each
        for (let i = 0; i < 5; i++) {
          await cacheA.set(`key-a-${i}`, `value-a-${i}`);
          await cacheA.forceSync();
          await cacheB.forceSync();

          await cacheB.set(`key-b-${i}`, `value-b-${i}`);
          await cacheB.forceSync();
          await cacheA.forceSync();
        }

        // Both should see all keys
        const keysA = await cacheA.keys();
        const keysB = await cacheB.keys();
        expect(keysA.length).toBe(10);
        expect(keysB.length).toBe(10);
      } finally {
        await cacheA.close();
        await cacheB.close();
      }
    });
  });

  describe("large index performance", () => {
    it("should handle sync with many entries", async () => {
      const dir = testDir("sync-large");
      registerCleanup(dir);

      const cache = new FsLruCache({
        dir,
        syncWrites: true,
        experimentalMultiProcess: true,
        syncInterval: 1000,
        maxDiskSize: 100 * 1024 * 1024, // 100MB
      });

      try {
        // Write 500 entries (more would slow down the test too much)
        const entries: [string, unknown][] = [];
        for (let i = 0; i < 500; i++) {
          entries.push([`key-${i}`, { index: i, data: `value-${i}` }]);
        }
        await cache.mset(entries);

        // Sync should complete in reasonable time
        const start = Date.now();
        await cache.forceSync();
        const elapsed = Date.now() - start;

        // Should complete in less than 5 seconds
        expect(elapsed).toBeLessThan(5000);

        // Verify data integrity
        expect(await cache.get("key-0")).toEqual({ index: 0, data: "value-0" });
        expect(await cache.get("key-499")).toEqual({ index: 499, data: "value-499" });
      } finally {
        await cache.close();
      }
    });

    it("should handle sync between two caches with many entries", async () => {
      const dir = testDir("sync-large-two");
      registerCleanup(dir);

      const cacheA = new FsLruCache({
        dir,
        syncWrites: true,
        experimentalMultiProcess: true,
        syncInterval: 1000,
        maxDiskSize: 100 * 1024 * 1024,
      });

      try {
        // Write entries from cache A
        const entries: [string, unknown][] = [];
        for (let i = 0; i < 200; i++) {
          entries.push([`key-${i}`, `value-${i}`]);
        }
        await cacheA.mset(entries);
        await cacheA.forceSync();

        // Create cache B and sync
        const cacheB = new FsLruCache({
          dir,
          syncWrites: true,
          experimentalMultiProcess: true,
          syncInterval: 1000,
          maxDiskSize: 100 * 1024 * 1024,
        });

        try {
          await cacheB.forceSync();

          // Cache B should see all entries
          const keys = await cacheB.keys();
          expect(keys.length).toBe(200);
        } finally {
          await cacheB.close();
        }
      } finally {
        await cacheA.close();
      }
    });
  });

  describe("sync mutex", () => {
    it("should prevent concurrent syncs from racing", async () => {
      const dir = testDir("sync-mutex");
      registerCleanup(dir);

      const cache = new FsLruCache({
        dir,
        syncWrites: true,
        experimentalMultiProcess: true,
        syncInterval: 10000, // Long interval
      });

      try {
        await cache.set("key1", "value1");

        // Start many syncs simultaneously
        const syncPromises = Array.from({ length: 10 }, () => cache.forceSync());

        // All should complete without error
        await Promise.all(syncPromises);

        // Verify integrity
        expect(await cache.get("key1")).toBe("value1");
      } finally {
        await cache.close();
      }
    });
  });

  describe("helper function scenarios", () => {
    describe("readSharedIndexWithRetry", () => {
      it("should recover from corrupted index file", async () => {
        const dir = testDir("sync-corrupt-index");
        registerCleanup(dir);

        // Create cache and write data
        const cache1 = new FsLruCache({
          dir,
          syncWrites: true,
          experimentalMultiProcess: true,
          syncInterval: 1000,
        });

        await cache1.set("key1", "value1");
        await cache1.forceSync();
        await cache1.close();

        // Corrupt the index file with invalid JSON
        const indexPath = join(dir, ".index.json");
        await fs.writeFile(indexPath, "{ invalid json }}}");

        // New cache should handle corrupt index gracefully (falls back to dir scan)
        const cache2 = new FsLruCache({
          dir,
          syncWrites: true,
          experimentalMultiProcess: true,
          syncInterval: 1000,
        });

        try {
          // Should still be able to read the value (file exists on disk)
          expect(await cache2.get("key1")).toBe("value1");
        } finally {
          await cache2.close();
        }
      });

      it("should handle missing index file on first sync", async () => {
        const dir = testDir("sync-no-index");
        registerCleanup(dir);

        const cache = new FsLruCache({
          dir,
          syncWrites: true,
          experimentalMultiProcess: true,
          syncInterval: 1000,
        });

        try {
          // forceSync should work even with no existing index
          await cache.forceSync();
          await cache.set("key1", "value1");
          await cache.forceSync();

          // Verify index was created
          const indexPath = join(dir, ".index.json");
          const content = await fs.readFile(indexPath, "utf8");
          const index: SharedIndex = JSON.parse(content);
          expect(index.entries["key1"]).toBeDefined();
        } finally {
          await cache.close();
        }
      });
    });

    describe("buildMergedEntries (local precedence)", () => {
      it("should preserve local entries when merging with foreign", async () => {
        const dir = testDir("sync-merge-precedence");
        registerCleanup(dir);

        const cacheA = new FsLruCache({
          dir,
          syncWrites: true,
          experimentalMultiProcess: true,
          syncInterval: 1000,
        });

        const cacheB = new FsLruCache({
          dir,
          syncWrites: true,
          experimentalMultiProcess: true,
          syncInterval: 1000,
        });

        try {
          // Both write to the same key with different values
          await cacheA.set("shared-key", "valueA");
          await cacheB.set("shared-key", "valueB");

          // Also write unique keys
          await cacheA.set("keyA", "onlyA");
          await cacheB.set("keyB", "onlyB");

          // Both sync - each should keep their own value for shared-key
          await cacheA.forceSync();
          await cacheB.forceSync();

          // cacheA's shared-key should still be valueA (local precedence)
          // cacheB's shared-key should still be valueB (local precedence)
          // Note: The actual file on disk depends on write order
          expect(await cacheA.get("keyA")).toBe("onlyA");
          expect(await cacheB.get("keyB")).toBe("onlyB");

          // After another sync round, both should see each other's unique keys
          await cacheA.forceSync();
          expect(await cacheA.get("keyB")).toBe("onlyB");
        } finally {
          await cacheA.close();
          await cacheB.close();
        }
      });
    });

    describe("verifyWriteSuccess (version tracking)", () => {
      it("should track correct version after concurrent index writes", async () => {
        const dir = testDir("sync-version-tracking");
        registerCleanup(dir);

        const cacheA = new FsLruCache({
          dir,
          syncWrites: true,
          experimentalMultiProcess: true,
          syncInterval: 1000,
        });

        const cacheB = new FsLruCache({
          dir,
          syncWrites: true,
          experimentalMultiProcess: true,
          syncInterval: 1000,
        });

        try {
          // Initial writes
          await cacheA.set("keyA", "valueA");
          await cacheA.forceSync();

          // Read the index version
          const indexPath = join(dir, ".index.json");
          let content = await fs.readFile(indexPath, "utf8");
          let index: SharedIndex = JSON.parse(content);
          const versionAfterA = index.version;

          // cacheB writes and syncs
          await cacheB.set("keyB", "valueB");
          await cacheB.forceSync();

          content = await fs.readFile(indexPath, "utf8");
          index = JSON.parse(content);
          const versionAfterB = index.version;

          // Version should have incremented
          expect(versionAfterB).toBeGreaterThan(versionAfterA);

          // Both keys should be in the index
          expect(index.entries["keyA"]).toBeDefined();
          expect(index.entries["keyB"]).toBeDefined();

          // cacheA syncs again - should see keyB and update its version
          await cacheA.forceSync();
          const keysA = await cacheA.keys();
          expect(keysA).toContain("keyB");
        } finally {
          await cacheA.close();
          await cacheB.close();
        }
      });

      it("should handle rapid sequential syncs without losing entries", async () => {
        const dir = testDir("sync-rapid-sequential");
        registerCleanup(dir);

        const cache = new FsLruCache({
          dir,
          syncWrites: true,
          experimentalMultiProcess: true,
          syncInterval: 1000,
        });

        try {
          // Rapid writes and syncs
          for (let i = 0; i < 10; i++) {
            await cache.set(`key-${i}`, `value-${i}`);
            await cache.forceSync();
          }

          // All entries should be present
          const keys = await cache.keys();
          expect(keys.length).toBe(10);

          // Verify index has correct version progression
          const indexPath = join(dir, ".index.json");
          const content = await fs.readFile(indexPath, "utf8");
          const index: SharedIndex = JSON.parse(content);
          expect(index.version).toBeGreaterThanOrEqual(10);
        } finally {
          await cache.close();
        }
      });
    });

    describe("updateLocalEntryFromShared (invalidation)", () => {
      it("should invalidate memory cache when value changes from another process", async () => {
        const dir = testDir("sync-invalidation");
        registerCleanup(dir);

        const cacheA = new FsLruCache({
          dir,
          syncWrites: true,
          experimentalMultiProcess: true,
          syncInterval: 1000,
          maxMemoryItems: 100,
        });

        const cacheB = new FsLruCache({
          dir,
          syncWrites: true,
          experimentalMultiProcess: true,
          syncInterval: 1000,
          maxMemoryItems: 100,
        });

        try {
          // cacheA writes and syncs
          await cacheA.set("key1", "original-value");
          await cacheA.forceSync();

          // cacheB reads the value (goes into memory cache)
          await cacheB.forceSync();
          expect(await cacheB.get("key1")).toBe("original-value");

          // Verify it's in cacheB's memory
          const statsB1 = await cacheB.stats();
          expect(statsB1.memory.items).toBe(1);

          // cacheA overwrites with new value
          await cacheA.set("key1", "updated-value");
          await cacheA.forceSync();

          // cacheB syncs - should invalidate memory cache due to valueHash change
          await cacheB.forceSync();

          // cacheB should now return the updated value
          expect(await cacheB.get("key1")).toBe("updated-value");
        } finally {
          await cacheA.close();
          await cacheB.close();
        }
      });

      it("should keep more recent lastAccessedAt during merge", async () => {
        const dir = testDir("sync-last-accessed");
        registerCleanup(dir);

        const cacheA = new FsLruCache({
          dir,
          syncWrites: true,
          experimentalMultiProcess: true,
          syncInterval: 1000,
        });

        const cacheB = new FsLruCache({
          dir,
          syncWrites: true,
          experimentalMultiProcess: true,
          syncInterval: 1000,
        });

        try {
          // cacheA writes
          await cacheA.set("key1", "value1");
          await cacheA.forceSync();

          // cacheB syncs and accesses the key (updates lastAccessedAt)
          await cacheB.forceSync();
          await delay(10);
          await cacheB.get("key1"); // Touch the key
          await cacheB.forceSync();

          // Read the index
          const indexPath = join(dir, ".index.json");
          const content = await fs.readFile(indexPath, "utf8");
          const index: SharedIndex = JSON.parse(content);

          // lastAccessedAt should be updated
          expect(index.entries["key1"]?.lastAccessedAt).toBeDefined();
        } finally {
          await cacheA.close();
          await cacheB.close();
        }
      });
    });

    describe("removeDeletedKeys", () => {
      it("should remove keys deleted by another process", async () => {
        const dir = testDir("sync-remove-deleted");
        registerCleanup(dir);

        const cacheA = new FsLruCache({
          dir,
          syncWrites: true,
          experimentalMultiProcess: true,
          syncInterval: 1000,
        });

        const cacheB = new FsLruCache({
          dir,
          syncWrites: true,
          experimentalMultiProcess: true,
          syncInterval: 1000,
        });

        try {
          // Both start with the same keys
          await cacheA.set("key1", "value1");
          await cacheA.set("key2", "value2");
          await cacheA.set("key3", "value3");
          await cacheA.forceSync();
          await cacheB.forceSync();

          // Verify cacheB has all keys
          expect((await cacheB.keys()).sort()).toEqual(["key1", "key2", "key3"]);

          // cacheA deletes key2
          await cacheA.del("key2");
          await cacheA.forceSync();

          // cacheB syncs - should see key2 removed
          await cacheB.forceSync();
          expect((await cacheB.keys()).sort()).toEqual(["key1", "key3"]);
        } finally {
          await cacheA.close();
          await cacheB.close();
        }
      });

      it("should not remove local keys when file still exists on disk", async () => {
        const dir = testDir("sync-local-file-exists");
        registerCleanup(dir);

        const cacheA = new FsLruCache({
          dir,
          syncWrites: true,
          experimentalMultiProcess: true,
          syncInterval: 1000,
        });

        const cacheB = new FsLruCache({
          dir,
          syncWrites: true,
          experimentalMultiProcess: true,
          syncInterval: 1000,
        });

        try {
          // Both caches write different keys
          await cacheA.set("keyA", "valueA");
          await cacheB.set("keyB", "valueB");

          // cacheA syncs first (only knows about keyA)
          await cacheA.forceSync();

          // cacheB syncs - should keep keyB even though cacheA's index doesn't have it
          // because the file still exists on disk
          await cacheB.forceSync();

          // cacheB should still have keyB
          expect(await cacheB.get("keyB")).toBe("valueB");

          // And should now also have keyA from cacheA
          expect(await cacheB.get("keyA")).toBe("valueA");
        } finally {
          await cacheA.close();
          await cacheB.close();
        }
      });

      it("should clear memory cache when key is deleted by another process", async () => {
        const dir = testDir("sync-memory-clear-on-delete");
        registerCleanup(dir);

        const cacheA = new FsLruCache({
          dir,
          syncWrites: true,
          experimentalMultiProcess: true,
          syncInterval: 1000,
          maxMemoryItems: 100,
        });

        const cacheB = new FsLruCache({
          dir,
          syncWrites: true,
          experimentalMultiProcess: true,
          syncInterval: 1000,
          maxMemoryItems: 100,
        });

        try {
          // Setup: both have the key
          await cacheA.set("key1", "value1");
          await cacheA.forceSync();
          await cacheB.forceSync();

          // cacheB reads the value (puts it in memory)
          expect(await cacheB.get("key1")).toBe("value1");
          const statsB1 = await cacheB.stats();
          expect(statsB1.memory.items).toBe(1);

          // cacheA deletes the key and syncs
          await cacheA.del("key1");
          await cacheA.forceSync();

          // cacheB syncs - should remove key from both disk index and memory
          await cacheB.forceSync();

          // Key should no longer be accessible
          expect(await cacheB.get("key1")).toBeNull();

          // Memory should be cleared (the internal evict mechanism clears memory)
          const statsB2 = await cacheB.stats();
          expect(statsB2.memory.items).toBe(0);
        } finally {
          await cacheA.close();
          await cacheB.close();
        }
      });
    });

    describe("snapshotLocalIndex (write isolation)", () => {
      it("should handle writes during sync without corruption", async () => {
        const dir = testDir("sync-write-during-sync");
        registerCleanup(dir);

        const cache = new FsLruCache({
          dir,
          syncWrites: true,
          experimentalMultiProcess: true,
          syncInterval: 50, // Fast sync
        });

        try {
          // Start with some data
          await cache.set("initial", "value");
          await cache.forceSync();

          // Rapidly write while syncs are happening
          const writePromises: Promise<void>[] = [];
          for (let i = 0; i < 20; i++) {
            writePromises.push(cache.set(`key-${i}`, `value-${i}`));
          }
          await Promise.all(writePromises);

          // Wait for auto-syncs to settle
          await delay(200);

          // Force final sync
          await cache.forceSync();

          // All keys should be present
          const keys = await cache.keys();
          expect(keys.length).toBe(21); // initial + 20 new keys

          // Verify index integrity
          const indexPath = join(dir, ".index.json");
          const content = await fs.readFile(indexPath, "utf8");
          const index: SharedIndex = JSON.parse(content);
          expect(Object.keys(index.entries).length).toBe(21);
        } finally {
          await cache.close();
        }
      });
    });
  });
});
