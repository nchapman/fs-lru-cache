import { FsLruCache } from "./src/index.js";
import { rm } from "fs/promises";
import { performance } from "perf_hooks";

const BENCH_DIR = ".bench-cache";

interface BenchResult {
  name: string;
  ops: number;
  totalMs: number;
  opsPerSec: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
}

async function cleanup() {
  await rm(BENCH_DIR, { recursive: true, force: true });
}

async function runBench(
  name: string,
  iterations: number,
  fn: () => Promise<void>
): Promise<BenchResult> {
  const times: number[] = [];

  // Warmup
  for (let i = 0; i < Math.min(10, iterations / 10); i++) {
    await fn();
  }

  // Actual benchmark
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }

  const totalMs = times.reduce((a, b) => a + b, 0);
  const avgMs = totalMs / iterations;
  const opsPerSec = 1000 / avgMs;

  return {
    name,
    ops: iterations,
    totalMs,
    opsPerSec,
    avgMs,
    minMs: Math.min(...times),
    maxMs: Math.max(...times),
  };
}

function formatResult(r: BenchResult): string {
  return `${r.name.padEnd(45)} ${r.opsPerSec.toFixed(0).padStart(10)} ops/s | avg: ${r.avgMs.toFixed(3).padStart(8)}ms | min: ${r.minMs.toFixed(3).padStart(8)}ms | max: ${r.maxMs.toFixed(3).padStart(8)}ms`;
}

async function benchmarkCoreOps() {
  console.log("\n=== Core Operations ===\n");

  await cleanup();
  const cache = new FsLruCache({
    dir: BENCH_DIR,
    maxMemoryItems: 10000,
    maxMemorySize: 100 * 1024 * 1024,
    maxDiskSize: 500 * 1024 * 1024,
  });

  // Pre-populate cache
  const smallValue = { id: 1, name: "test", data: "x".repeat(100) };
  const mediumValue = { id: 1, name: "test", data: "x".repeat(1000) };
  const largeValue = { id: 1, name: "test", data: "x".repeat(10000) };

  for (let i = 0; i < 1000; i++) {
    await cache.set(`key:${i}`, smallValue);
  }

  // Memory hit (hot cache)
  let hitIdx = 0;
  const memHit = await runBench("get() - memory hit", 10000, async () => {
    await cache.get(`key:${hitIdx++ % 1000}`);
  });
  console.log(formatResult(memHit));

  // Create cold cache (disk only)
  await cache.close();
  await cleanup();
  const coldCache = new FsLruCache({
    dir: BENCH_DIR,
    maxMemoryItems: 0, // Force disk-only
    maxMemorySize: 0,
  });

  for (let i = 0; i < 500; i++) {
    await coldCache.set(`cold:${i}`, smallValue);
  }

  // Clear memory by recreating
  await coldCache.close();
  const diskCache = new FsLruCache({
    dir: BENCH_DIR,
    maxMemoryItems: 0,
    maxMemorySize: 0,
  });

  let diskIdx = 0;
  const diskHit = await runBench("get() - disk read", 1000, async () => {
    await diskCache.get(`cold:${diskIdx++ % 500}`);
  });
  console.log(formatResult(diskHit));
  await diskCache.close();

  // Set operations
  await cleanup();
  const setCache = new FsLruCache({ dir: BENCH_DIR });

  let setSmallIdx = 0;
  const setSmall = await runBench("set() - small value (100B)", 1000, async () => {
    await setCache.set(`small:${setSmallIdx++}`, smallValue);
  });
  console.log(formatResult(setSmall));

  let setMedIdx = 0;
  const setMedium = await runBench("set() - medium value (1KB)", 1000, async () => {
    await setCache.set(`medium:${setMedIdx++}`, mediumValue);
  });
  console.log(formatResult(setMedium));

  let setLargeIdx = 0;
  const setLarge = await runBench("set() - large value (10KB)", 500, async () => {
    await setCache.set(`large:${setLargeIdx++}`, largeValue);
  });
  console.log(formatResult(setLarge));

  await setCache.close();
}

async function benchmarkGetOrSet() {
  console.log("\n=== getOrSet() Stampede Protection ===\n");

  await cleanup();
  const cache = new FsLruCache({ dir: BENCH_DIR });

  // Pre-populate some keys
  for (let i = 0; i < 100; i++) {
    await cache.set(`existing:${i}`, { cached: true, i });
  }

  // Cache hit path
  let hitIdx = 0;
  const gosHit = await runBench("getOrSet() - cache hit", 5000, async () => {
    await cache.getOrSet(`existing:${hitIdx++ % 100}`, async () => {
      throw new Error("Should not compute");
    });
  });
  console.log(formatResult(gosHit));

  // Cache miss path (compute)
  let missIdx = 0;
  const gosMiss = await runBench("getOrSet() - cache miss (compute)", 1000, async () => {
    await cache.getOrSet(`new:${missIdx++}`, async () => {
      return { computed: true, ts: Date.now() };
    });
  });
  console.log(formatResult(gosMiss));

  // Concurrent requests (stampede)
  let concurrentIdx = 0;
  const gosConcurrent = await runBench(
    "getOrSet() - 10 concurrent same key",
    100,
    async () => {
      const key = `concurrent:${concurrentIdx++}`;
      let computeCount = 0;
      await Promise.all(
        Array(10)
          .fill(null)
          .map(() =>
            cache.getOrSet(key, async () => {
              computeCount++;
              await new Promise((r) => setTimeout(r, 1));
              return { computed: true };
            })
          )
      );
      if (computeCount > 1) {
        console.warn(`  Warning: Key ${key} computed ${computeCount} times (expected 1)`);
      }
    }
  );
  console.log(formatResult(gosConcurrent));

  await cache.close();
}

async function benchmarkBatch() {
  console.log("\n=== Batch Operations ===\n");

  await cleanup();
  const cache = new FsLruCache({ dir: BENCH_DIR });

  const value = { id: 1, data: "x".repeat(100) };

  // mset
  let msetIdx = 0;
  const mset10 = await runBench("mset() - 10 items", 500, async () => {
    const entries: [string, unknown][] = [];
    for (let i = 0; i < 10; i++) {
      entries.push([`batch:${msetIdx++}`, value]);
    }
    await cache.mset(entries);
  });
  console.log(formatResult(mset10));

  // mget - cache hits
  const mget10 = await runBench("mget() - 10 items (memory)", 1000, async () => {
    const keys = Array(10)
      .fill(null)
      .map((_, i) => `batch:${i}`);
    await cache.mget(keys);
  });
  console.log(formatResult(mget10));

  await cache.close();
}

async function benchmarkCompression() {
  console.log("\n=== Compression Impact ===\n");

  const compressibleValue = {
    id: 1,
    data: "hello world ".repeat(500), // Highly compressible
  };

  // Without compression
  await cleanup();
  const noGzip = new FsLruCache({ dir: BENCH_DIR, gzip: false });

  let noGzipIdx = 0;
  const setNoGzip = await runBench("set() - no compression (6KB)", 500, async () => {
    await noGzip.set(`nogzip:${noGzipIdx++}`, compressibleValue);
  });
  console.log(formatResult(setNoGzip));

  let getNoGzipIdx = 0;
  const getNoGzip = await runBench("get() - no compression", 1000, async () => {
    await noGzip.get(`nogzip:${getNoGzipIdx++ % 500}`);
  });
  console.log(formatResult(getNoGzip));

  const noGzipStats = await noGzip.stats();
  console.log(`  Disk size (no gzip): ${(noGzipStats.disk.size / 1024).toFixed(1)} KB`);
  await noGzip.close();

  // With compression
  await cleanup();
  const withGzip = new FsLruCache({ dir: BENCH_DIR, gzip: true });

  let gzipIdx = 0;
  const setGzip = await runBench("set() - with gzip compression", 500, async () => {
    await withGzip.set(`gzip:${gzipIdx++}`, compressibleValue);
  });
  console.log(formatResult(setGzip));

  let getGzipIdx = 0;
  const getGzip = await runBench("get() - with gzip decompression", 500, async () => {
    await withGzip.get(`gzip:${getGzipIdx++ % 500}`);
  });
  console.log(formatResult(getGzip));

  const gzipStats = await withGzip.stats();
  console.log(`  Disk size (gzip): ${(gzipStats.disk.size / 1024).toFixed(1)} KB`);
  console.log(
    `  Compression ratio: ${((1 - gzipStats.disk.size / noGzipStats.disk.size) * 100).toFixed(1)}% smaller`
  );
  await withGzip.close();
}

async function benchmarkEviction() {
  console.log("\n=== Eviction Performance ===\n");

  await cleanup();
  const cache = new FsLruCache({
    dir: BENCH_DIR,
    maxMemoryItems: 100, // Small memory to trigger eviction
    maxMemorySize: 50 * 1024, // 50KB
  });

  const value = { data: "x".repeat(100) };

  // Fill cache and trigger evictions
  let evictIdx = 0;
  const setWithEviction = await runBench(
    "set() - with memory eviction (100 item limit)",
    1000,
    async () => {
      await cache.set(`evict:${evictIdx++}`, value);
    }
  );
  console.log(formatResult(setWithEviction));

  const stats = await cache.stats();
  console.log(`  Memory items: ${stats.memory.items}/${stats.memory.maxItems}`);
  console.log(`  Disk items: ${stats.disk.items}`);

  await cache.close();
}

async function benchmarkTTL() {
  console.log("\n=== TTL Operations ===\n");

  await cleanup();
  const cache = new FsLruCache({ dir: BENCH_DIR });

  const value = { data: "test" };

  // Set with TTL
  let ttlIdx = 0;
  const setTtl = await runBench("set() - with TTL", 1000, async () => {
    await cache.set(`ttl:${ttlIdx++}`, value, 60000);
  });
  console.log(formatResult(setTtl));

  // Check TTL
  const ttlCheck = await runBench("ttl() - check expiry", 5000, async () => {
    await cache.ttl("ttl:0");
  });
  console.log(formatResult(ttlCheck));

  // Expire
  let expireIdx = 0;
  const expire = await runBench("expire() - set new TTL", 1000, async () => {
    await cache.expire(`ttl:${expireIdx++ % 1000}`, 120);
  });
  console.log(formatResult(expire));

  await cache.close();
}

async function benchmarkPatternMatching() {
  console.log("\n=== Pattern Matching (keys) ===\n");

  await cleanup();
  const cache = new FsLruCache({ dir: BENCH_DIR });

  // Create diverse keys
  for (let i = 0; i < 1000; i++) {
    await cache.set(`user:${i}:profile`, { name: `User ${i}` });
    await cache.set(`user:${i}:settings`, { theme: "dark" });
    await cache.set(`session:${i}`, { active: true });
  }

  const keysAll = await runBench("keys('*') - all 3000 keys", 100, async () => {
    await cache.keys("*");
  });
  console.log(formatResult(keysAll));

  const keysPrefix = await runBench("keys('user:*') - 2000 keys", 100, async () => {
    await cache.keys("user:*");
  });
  console.log(formatResult(keysPrefix));

  const keysPattern = await runBench("keys('user:*:profile') - 1000 keys", 100, async () => {
    await cache.keys("user:*:profile");
  });
  console.log(formatResult(keysPattern));

  await cache.close();
}

async function benchmarkMixedWorkload() {
  console.log("\n=== Mixed Workload (80% read, 20% write) ===\n");

  await cleanup();
  const cache = new FsLruCache({
    dir: BENCH_DIR,
    maxMemoryItems: 500,
  });

  // Pre-populate
  for (let i = 0; i < 500; i++) {
    await cache.set(`mixed:${i}`, { id: i, data: "x".repeat(100) });
  }

  let readCount = 0;
  let writeCount = 0;
  let totalIdx = 0;

  const mixed = await runBench("mixed workload (80/20 read/write)", 5000, async () => {
    const isWrite = Math.random() < 0.2;
    const key = `mixed:${totalIdx++ % 500}`;

    if (isWrite) {
      writeCount++;
      await cache.set(key, { id: totalIdx, data: "x".repeat(100), ts: Date.now() });
    } else {
      readCount++;
      await cache.get(key);
    }
  });
  console.log(formatResult(mixed));
  console.log(`  Reads: ${readCount}, Writes: ${writeCount}`);

  const stats = await cache.stats();
  console.log(`  Hit rate: ${(stats.hitRate * 100).toFixed(1)}%`);

  await cache.close();
}

async function main() {
  console.log("╔════════════════════════════════════════════════════════════════╗");
  console.log("║           fs-lru-cache Benchmark Suite                         ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  console.log(`\nNode.js ${process.version}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);
  console.log(`Date: ${new Date().toISOString()}\n`);

  try {
    await benchmarkCoreOps();
    await benchmarkGetOrSet();
    await benchmarkBatch();
    await benchmarkCompression();
    await benchmarkEviction();
    await benchmarkTTL();
    await benchmarkPatternMatching();
    await benchmarkMixedWorkload();

    console.log("\n=== Benchmark Complete ===\n");
  } finally {
    await cleanup();
  }
}

main().catch(console.error);
