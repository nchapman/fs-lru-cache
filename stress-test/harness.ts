/**
 * Stress test harness for fs-lru-cache
 * Spawns multiple child processes to stress test the cache under concurrent load
 */
import { fork, ChildProcess } from "child_process";
import { join, dirname } from "path";
import { statSync, rmSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import type {
  WorkerResult,
  WorkerConfig,
  AggregateResults,
  WorkerMessage,
  CliOptions,
  RedFlags,
  CacheErrors,
} from "./types.js";
import { getWorkload, listWorkloads } from "./workload.js";
import { printReport } from "./report.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// CLI argument parsing
function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = {
    workload: "balanced",
    workers: 4,
    duration: 30,
    cacheDir: ".stress-test-cache",
    multiProcess: true,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case "-l":
      case "--workload":
        options.workload = next ?? options.workload;
        i++;
        break;
      case "-w":
      case "--workers":
        options.workers = parseInt(next ?? "4", 10);
        i++;
        break;
      case "-d":
      case "--duration":
        options.duration = parseInt(next ?? "30", 10);
        i++;
        break;
      case "-c":
      case "--cacheDir":
        options.cacheDir = next ?? options.cacheDir;
        i++;
        break;
      case "-m":
      case "--multiProcess":
        options.multiProcess = next?.toLowerCase() !== "false";
        i++;
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`
fs-lru-cache Stress Test

Usage: npm run stress-test -- [options]

Options:
  -l, --workload <name>     Workload profile (default: balanced)
                            Options: ${listWorkloads().join(", ")}
  -w, --workers <n>         Number of worker processes (default: 4)
  -d, --duration <seconds>  Test duration in seconds (default: 30)
  -c, --cacheDir <path>     Cache directory (default: .stress-test-cache)
  -m, --multiProcess <bool> Enable multi-process mode (default: true)
  -h, --help                Show this help message

Examples:
  npm run stress-test -- -l read-heavy -w 4 -d 5
  npm run stress-test -- -l balanced -w 16 -d 60
  npm run stress-test -- -l high-contention -w 8 -d 30 -m true
`);
}

async function runMain(): Promise<void> {
  const options = parseArgs();
  const workload = getWorkload(options.workload);

  console.log(`\nStarting stress test...`);
  console.log(`  Workload:      ${workload.name} (${workload.description})`);
  console.log(`  Workers:       ${options.workers}`);
  console.log(`  Duration:      ${options.duration}s`);
  console.log(`  Multi-process: ${options.multiProcess}`);
  console.log(`  Cache dir:     ${options.cacheDir}`);
  console.log();

  // Clean up existing cache directory
  if (existsSync(options.cacheDir)) {
    console.log("Cleaning up existing cache directory...");
    rmSync(options.cacheDir, { recursive: true, force: true });
  }

  // Path to worker script
  const workerScript = join(__dirname, "worker.ts");

  // Spawn workers
  const workers: ChildProcess[] = [];
  const results: WorkerResult[] = [];
  const workerPromises: Promise<void>[] = [];

  const startTime = Date.now();

  for (let i = 0; i < options.workers; i++) {
    const config: WorkerConfig = {
      workerId: i,
      cacheDir: options.cacheDir,
      duration: options.duration,
      workload,
      multiProcess: options.multiProcess,
    };

    // Fork worker process using tsx
    // Pass config as JSON argument
    const worker = fork(workerScript, [JSON.stringify(config)], {
      execArgv: process.execArgv, // Inherit tsx loader
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    });

    workers.push(worker);

    const promise = new Promise<void>((resolve, reject) => {
      worker.on("message", (msg: WorkerMessage) => {
        if (msg.type === "result" && msg.result) {
          results.push(msg.result);
        } else if (msg.type === "error") {
          console.error(`Worker ${msg.workerId} error: ${msg.error}`);
        }
      });

      worker.on("error", (err) => {
        console.error(`Worker ${i} error:`, err);
        reject(err);
      });

      worker.on("exit", (code) => {
        if (code !== 0) {
          reject(new Error(`Worker ${i} exited with code ${code}`));
        } else {
          resolve();
        }
      });
    });

    workerPromises.push(promise);
  }

  // Wait for all workers to complete
  console.log(`Running ${options.workers} workers for ${options.duration} seconds...`);
  await Promise.all(workerPromises);

  const totalDuration = (Date.now() - startTime) / 1000;

  // Calculate aggregate stats
  const totalOps = results.reduce(
    (sum, r) => sum + r.stats.gets + r.stats.sets + r.stats.deletes,
    0,
  );
  const totalHits = results.reduce((sum, r) => sum + r.stats.hits, 0);
  const totalMisses = results.reduce((sum, r) => sum + r.stats.misses, 0);
  const totalBytesWritten = results.reduce((sum, r) => sum + r.stats.bytesWritten, 0);
  const totalBytesRead = results.reduce((sum, r) => sum + r.stats.bytesRead, 0);
  const totalSyncCount = results.reduce((sum, r) => sum + r.stats.syncCount, 0);
  const totalErrors = results.reduce((sum, r) => sum + r.stats.errors, 0);

  // Aggregate red flags
  const totalRedFlags: RedFlags = {
    lostWrites: results.reduce((sum, r) => sum + (r.stats.redFlags?.lostWrites ?? 0), 0),
    dataCorruption: results.reduce((sum, r) => sum + (r.stats.redFlags?.dataCorruption ?? 0), 0),
    malformedData: results.reduce((sum, r) => sum + (r.stats.redFlags?.malformedData ?? 0), 0),
    phantomReads: results.reduce((sum, r) => sum + (r.stats.redFlags?.phantomReads ?? 0), 0),
  };

  // Aggregate cache errors
  const totalCacheErrors: CacheErrors = {
    readErrors: results.reduce((sum, r) => sum + (r.stats.cacheErrors?.readErrors ?? 0), 0),
    parseErrors: results.reduce((sum, r) => sum + (r.stats.cacheErrors?.parseErrors ?? 0), 0),
    writeErrors: results.reduce((sum, r) => sum + (r.stats.cacheErrors?.writeErrors ?? 0), 0),
    syncErrors: results.reduce((sum, r) => sum + (r.stats.cacheErrors?.syncErrors ?? 0), 0),
    integrityErrors: results.reduce(
      (sum, r) => sum + (r.stats.cacheErrors?.integrityErrors ?? 0),
      0,
    ),
  };

  // Get index file size
  let indexSize = 0;
  const indexPath = join(options.cacheDir, ".index.json");
  if (existsSync(indexPath)) {
    try {
      const stat = statSync(indexPath);
      indexSize = stat.size;
    } catch {
      // Ignore if file doesn't exist or can't be read
    }
  }

  const aggregate: AggregateResults = {
    workload: workload.name,
    workers: results.sort((a, b) => a.workerId - b.workerId),
    totalOps,
    totalDuration,
    opsPerSecond: totalOps / totalDuration,
    totalHits,
    totalMisses,
    hitRate: totalHits + totalMisses > 0 ? totalHits / (totalHits + totalMisses) : 0,
    totalBytesWritten,
    totalBytesRead,
    totalSyncCount,
    totalErrors,
    indexSize,
    totalRedFlags,
    totalCacheErrors,
  };

  // Print report
  printReport(aggregate, workload);

  // Cleanup
  console.log("Cleaning up...");
  if (existsSync(options.cacheDir)) {
    rmSync(options.cacheDir, { recursive: true, force: true });
  }
  console.log("Done.\n");
}

// Run main
runMain().catch((err) => {
  console.error("Stress test failed:", err);
  process.exit(1);
});
