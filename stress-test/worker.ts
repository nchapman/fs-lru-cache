/**
 * Worker process for stress testing
 * This runs in a child process spawned by the harness
 */
import { FsLruCache } from "../src/index.js";
import type { CacheError } from "../src/types.js";
import type {
  WorkerStats,
  WorkerResult,
  WorkerConfig,
  WorkerMessage,
  RedFlags,
  CacheErrors,
} from "./types.js";
import { generateKey, generateValue, pickOperation } from "./workload.js";

// Parse config from command line args (passed as JSON)
const configArg = process.argv[2];
if (!configArg) {
  console.error("Worker: No config provided");
  process.exit(1);
}

const config: WorkerConfig = JSON.parse(configArg);

// Value prefix to identify values written by stress test workers
// Format: "W{workerId}:{timestamp}:{random}:{payload}"
const VALUE_PREFIX = `W${config.workerId}:`;

/**
 * Generate a value with metadata for verification
 */
function generateTrackedValue(minSize: number, maxSize: number): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 10);
  const header = `${VALUE_PREFIX}${timestamp}:${random}:`;

  // Generate payload to reach desired size
  const payloadSize = Math.max(
    0,
    Math.floor(Math.random() * (maxSize - minSize + 1)) + minSize - header.length,
  );
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let payload = "";
  for (let i = 0; i < payloadSize; i++) {
    payload += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return header + payload;
}

/**
 * Check if a value looks like valid stress test data
 */
function isValidStressTestValue(value: string): boolean {
  // Should match pattern: W{digit}:{timestamp}:{random}:{payload}
  return /^W\d+:\d+:[a-z0-9]+:/.test(value);
}

/**
 * Extract worker ID from a stress test value
 */
function getValueWorkerId(value: string): number | null {
  const match = value.match(/^W(\d+):/);
  return match ? parseInt(match[1], 10) : null;
}

async function runWorker(): Promise<void> {
  const redFlags: RedFlags = {
    lostWrites: 0,
    dataCorruption: 0,
    malformedData: 0,
    phantomReads: 0,
  };

  const cacheErrors: CacheErrors = {
    readErrors: 0,
    parseErrors: 0,
    writeErrors: 0,
    syncErrors: 0,
    integrityErrors: 0,
  };

  const stats: WorkerStats = {
    gets: 0,
    sets: 0,
    deletes: 0,
    hits: 0,
    misses: 0,
    bytesWritten: 0,
    bytesRead: 0,
    errors: 0,
    syncCount: 0,
    redFlags,
    cacheErrors,
  };

  // Track recent writes by this worker for verification
  // Maps key -> value (limited size to avoid memory issues)
  const recentWrites = new Map<string, string>();
  const MAX_TRACKED_WRITES = 1000;

  // Create cache instance with error tracking
  const cache = new FsLruCache({
    dir: config.cacheDir,
    maxMemoryItems: 1000,
    maxDiskSize: 500 * 1024 * 1024, // 500MB
    defaultTtl: 60 * 60, // 1 hour (longer than test duration)
    shards: 16,
    experimentalMultiProcess: config.multiProcess,
    syncInterval: 1000,
    // Track cache-internal errors via callback
    onError: (err: CacheError) => {
      switch (err.type) {
        case "read_error":
          cacheErrors.readErrors++;
          break;
        case "parse_error":
          cacheErrors.parseErrors++;
          break;
        case "write_error":
          cacheErrors.writeErrors++;
          break;
        case "sync_error":
          cacheErrors.syncErrors++;
          break;
        case "integrity_error":
          cacheErrors.integrityErrors++;
          break;
      }
    },
  });

  // Monkey-patch to count index syncs
  type FileStoreType = { sync: () => Promise<void> };
  const fileStore = (cache as unknown as { files: FileStoreType }).files;
  if (fileStore && typeof fileStore.sync === "function") {
    const originalSync = fileStore.sync.bind(fileStore);
    fileStore.sync = async function () {
      stats.syncCount++;
      return originalSync();
    };
  }

  const { workload } = config;
  const startTime = Date.now();
  const endTime = startTime + config.duration * 1000;

  // Run operations until time expires
  while (Date.now() < endTime) {
    const op = pickOperation(workload);
    const key = generateKey(workload.keySpaceSize);

    try {
      switch (op) {
        case "get": {
          stats.gets++;
          const value = await cache.get<string>(key);

          if (value !== null) {
            stats.hits++;
            stats.bytesRead += Buffer.byteLength(value, "utf8");

            // Validate the value
            if (typeof value !== "string") {
              redFlags.malformedData++;
            } else if (!isValidStressTestValue(value)) {
              // Value doesn't match our format - could be from a previous run
              // or corruption. Only flag if we have recent writes for this key.
              if (recentWrites.has(key)) {
                redFlags.dataCorruption++;
              }
            } else {
              // Check if this was our write and value matches
              const expectedValue = recentWrites.get(key);
              if (expectedValue !== undefined && expectedValue !== value) {
                // We wrote something different - could be overwritten by another
                // worker (expected in multi-process), but track it
                const valueWorkerId = getValueWorkerId(value);
                if (valueWorkerId === config.workerId) {
                  // Same worker wrote a different value? Corruption!
                  redFlags.dataCorruption++;
                }
                // If different worker, that's expected - clear our tracking
                recentWrites.delete(key);
              }
            }
          } else {
            stats.misses++;
          }
          break;
        }

        case "set": {
          stats.sets++;
          const value = generateTrackedValue(workload.minValueSize, workload.maxValueSize);
          stats.bytesWritten += Buffer.byteLength(value, "utf8");

          await cache.set(key, value);

          // Track this write
          recentWrites.set(key, value);

          // Evict old entries if we're tracking too many
          if (recentWrites.size > MAX_TRACKED_WRITES) {
            const firstKey = recentWrites.keys().next().value;
            if (firstKey) recentWrites.delete(firstKey);
          }

          // Verify read-your-own-writes (10% of the time to avoid slowdown)
          if (Math.random() < 0.1) {
            const readBack = await cache.get<string>(key);

            if (readBack === null) {
              // Lost write! This violates read-your-own-writes guarantee
              redFlags.lostWrites++;
            } else if (readBack !== value) {
              // Got a different value back
              const readWorkerId = getValueWorkerId(readBack);
              if (readWorkerId === config.workerId) {
                // Same worker, different value = corruption
                redFlags.dataCorruption++;
              }
              // If different worker overwrote between set and get, that's
              // technically possible but very unlikely in 10% sample window
            }
          }
          break;
        }

        case "delete": {
          stats.deletes++;
          await cache.del(key);
          // Clear from tracking
          recentWrites.delete(key);
          break;
        }
      }
    } catch (err) {
      stats.errors++;
      // Check for specific error types
      if (err instanceof SyntaxError) {
        redFlags.malformedData++;
      }
    }
  }

  const duration = (Date.now() - startTime) / 1000;
  const totalOps = stats.gets + stats.sets + stats.deletes;

  // Close cache properly
  await cache.close();

  // Send result back to main process via IPC
  const result: WorkerResult = {
    workerId: config.workerId,
    stats,
    duration,
    opsPerSecond: totalOps / duration,
  };

  const message: WorkerMessage = {
    type: "result",
    workerId: config.workerId,
    result,
  };

  // Send via process.send (IPC) if available, otherwise stdout
  if (process.send) {
    process.send(message);
  } else {
    console.log(JSON.stringify(message));
  }
}

runWorker().catch((err) => {
  const message: WorkerMessage = {
    type: "error",
    workerId: config.workerId,
    error: String(err),
  };

  if (process.send) {
    process.send(message);
  } else {
    console.log(JSON.stringify(message));
  }
  process.exit(1);
});
