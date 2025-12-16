import type { AggregateResults, WorkloadConfig } from "./types.js";

// ANSI color codes
const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
};

/**
 * Format bytes into human-readable string
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

/**
 * Format a number with commas
 */
function formatNumber(n: number): string {
  return n.toLocaleString();
}

/**
 * Format a percentage
 */
function formatPercent(n: number): string {
  return (n * 100).toFixed(1) + "%";
}

/**
 * Create a horizontal line
 */
function line(char: string = "═", width: number = 67): string {
  return char.repeat(width);
}

/**
 * Create a section header
 */
function header(title: string): string {
  const padding = 67 - title.length - 6;
  return `${colors.cyan}${colors.bold}═══ ${title} ${line("═", padding)}${colors.reset}`;
}

/**
 * Print the stress test report
 */
export function printReport(results: AggregateResults, workload: WorkloadConfig): void {
  const { cyan, green, yellow, bold, dim, reset, magenta, blue, red } = colors;

  console.log();
  console.log(`${cyan}${bold}${line()}${reset}`);
  console.log(`${cyan}${bold}  Stress Test Report: ${yellow}${results.workload}${reset}`);
  console.log(`${cyan}${bold}${line()}${reset}`);
  console.log();

  // Workload Configuration
  console.log(header("Workload Configuration"));
  console.log();
  console.log(`  ${bold}Operations:${reset}`);
  console.log(`    Read:           ${green}${workload.readPercent}%${reset}`);
  console.log(`    Write:          ${yellow}${workload.writePercent}%${reset}`);
  console.log(`    Delete:         ${red}${workload.deletePercent}%${reset}`);
  console.log(`  ${bold}Data:${reset}`);
  console.log(`    Key Space:      ${formatNumber(workload.keySpaceSize)} keys`);
  console.log(
    `    Value Size:     ${formatBytes(workload.minValueSize)} - ${formatBytes(workload.maxValueSize)}`,
  );
  console.log();

  // Performance Metrics
  console.log(header("Performance Metrics"));
  console.log();
  console.log(`  ${bold}Throughput:${reset}`);
  console.log(`    Total Ops:      ${green}${formatNumber(results.totalOps)}${reset}`);
  console.log(`    Duration:       ${results.totalDuration.toFixed(2)}s`);
  console.log(
    `    Ops/Second:     ${green}${bold}${formatNumber(Math.round(results.opsPerSecond))}${reset}`,
  );
  console.log();

  // Operations breakdown
  const totalGets = results.workers.reduce((sum, w) => sum + w.stats.gets, 0);
  const totalSets = results.workers.reduce((sum, w) => sum + w.stats.sets, 0);
  const totalDeletes = results.workers.reduce((sum, w) => sum + w.stats.deletes, 0);

  console.log(`  ${bold}Operations Breakdown:${reset}`);
  console.log(`    Gets:           ${formatNumber(totalGets)}`);
  console.log(`    Sets:           ${formatNumber(totalSets)}`);
  console.log(`    Deletes:        ${formatNumber(totalDeletes)}`);
  console.log();

  // Cache Performance
  console.log(`  ${bold}Cache Performance:${reset}`);
  console.log(
    `    Hits:           ${green}${formatNumber(results.totalHits)}${reset} (${formatPercent(results.hitRate)})`,
  );
  console.log(
    `    Misses:         ${yellow}${formatNumber(results.totalMisses)}${reset} (${formatPercent(1 - results.hitRate)})`,
  );
  console.log();

  // Disk I/O Estimation
  console.log(header("Disk I/O (Estimated)"));
  console.log();

  const missRate = 1 - results.hitRate;
  const estimatedDiskReads = results.totalBytesRead * missRate;

  console.log(`  ${bold}Value Data (Disk):${reset}`);
  console.log(
    `    Written:        ${magenta}${formatBytes(results.totalBytesWritten)}${reset} ${dim}(all writes go to disk)${reset}`,
  );
  console.log(
    `    Read (est):     ${blue}${formatBytes(estimatedDiskReads)}${reset} ${dim}(${formatPercent(missRate)} miss rate)${reset}`,
  );
  console.log(
    `    Read (total):   ${formatBytes(results.totalBytesRead)} ${dim}(${formatPercent(results.hitRate)} from memory)${reset}`,
  );
  console.log();

  // Index Sync I/O
  const indexIOPerSync = results.indexSize * 2; // read + write
  const totalIndexIO = results.totalSyncCount * indexIOPerSync;
  const avgSyncsPerWorker = Math.round(results.totalSyncCount / results.workers.length);

  console.log(`  ${bold}Index Sync:${reset}`);
  console.log(`    Index Size:     ${formatBytes(results.indexSize)}`);
  console.log(
    `    Syncs:          ~${formatNumber(results.totalSyncCount)} ${dim}(${results.workers.length} workers x ${avgSyncsPerWorker} syncs)${reset}`,
  );
  console.log(
    `    Index I/O:      ${formatBytes(totalIndexIO)} ${dim}(read + write per sync)${reset}`,
  );
  console.log();

  // Application-level I/O (what the cache sees)
  const totalDiskWritten = results.totalBytesWritten + totalIndexIO / 2;
  const totalDiskRead = estimatedDiskReads + totalIndexIO / 2;
  const totalAppIO = totalDiskWritten + totalDiskRead;
  const appThroughput = totalAppIO / results.totalDuration;

  console.log(`  ${bold}Application-Level I/O:${reset}`);
  console.log(`    Written:        ${formatBytes(totalDiskWritten)}`);
  console.log(`    Read:           ${formatBytes(totalDiskRead)}`);
  console.log(`    Total:          ${formatBytes(totalAppIO)}`);
  console.log(`    Throughput:     ${formatBytes(appThroughput)}/s`);
  console.log();

  // Estimated actual disk I/O (with filesystem overhead)
  // Based on benchmarks: ~3x overhead for typical workloads due to:
  // - Atomic writes (temp file + rename)
  // - Filesystem journaling (APFS, ext4, etc.)
  // - Metadata updates (directory entries, timestamps)
  // - fsync operations
  // Note: small-values/high-contention may see 5-7x, large-values may see <1x
  const overheadMultiplier = 3;
  const estimatedActualIO = totalAppIO * overheadMultiplier;
  const estimatedActualThroughput = estimatedActualIO / results.totalDuration;

  console.log(
    `  ${bold}Estimated Actual Disk I/O:${reset} ${dim}(~${overheadMultiplier}x overhead)${reset}`,
  );
  console.log(`    Total:          ${yellow}${formatBytes(estimatedActualIO)}${reset}`);
  console.log(`    Throughput:     ${yellow}${formatBytes(estimatedActualThroughput)}/s${reset}`);
  console.log(`    ${dim}(includes atomic writes, journaling, metadata)${reset}`);
  console.log();

  // Operations size stats
  const avgWriteSize = totalSets > 0 ? results.totalBytesWritten / totalSets : 0;
  const avgReadSize = totalGets > 0 ? results.totalBytesRead / totalGets : 0;

  console.log(`  ${bold}Avg Operation Size:${reset}`);
  console.log(`    Write:          ${formatBytes(avgWriteSize)}`);
  console.log(`    Read:           ${formatBytes(avgReadSize)}`);
  console.log();

  // Worker Breakdown
  console.log(header("Worker Breakdown"));
  console.log();
  console.log(`  ${bold}Per-Worker Stats:${reset}`);
  console.log();

  // Table header
  const tableHeader = `    ${dim}Worker  Ops        Ops/s      Hits       Misses     Errors${reset}`;
  const tableLine = `    ${dim}${line("─", 58)}${reset}`;
  console.log(tableHeader);
  console.log(tableLine);

  // Worker rows
  for (const worker of results.workers) {
    const ops = worker.stats.gets + worker.stats.sets + worker.stats.deletes;
    const opsStr = formatNumber(ops).padEnd(10);
    const opsPerSecStr = formatNumber(Math.round(worker.opsPerSecond)).padEnd(10);
    const hitsStr = formatNumber(worker.stats.hits).padEnd(10);
    const missesStr = formatNumber(worker.stats.misses).padEnd(10);
    const errorsStr =
      worker.stats.errors > 0 ? `${red}${worker.stats.errors}${reset}` : `${green}0${reset}`;

    console.log(
      `    #${worker.workerId.toString().padEnd(5)} ${opsStr} ${opsPerSecStr} ${hitsStr} ${missesStr} ${errorsStr}`,
    );
  }

  console.log();

  // Red Flags Section (actual data integrity issues)
  const rf = results.totalRedFlags;
  const totalRedFlagCount = rf.lostWrites + rf.dataCorruption + rf.malformedData + rf.phantomReads;

  // Cache Errors Section (expected race conditions in multi-process mode)
  const ce = results.totalCacheErrors;
  const totalCacheErrorCount =
    ce.readErrors + ce.parseErrors + ce.writeErrors + ce.syncErrors + ce.integrityErrors;

  // Only show "PROBLEMS DETECTED" for actual red flags (data integrity issues)
  if (totalRedFlagCount > 0) {
    console.log(header("Red Flags (PROBLEMS DETECTED)"));
    console.log();
    console.log(`  ${red}${bold}WARNING: Data integrity issues detected!${reset}`);
    console.log();

    if (rf.lostWrites > 0) {
      console.log(
        `    ${red}Lost Writes:      ${rf.lostWrites}${reset} ${dim}(read-your-own-writes violation)${reset}`,
      );
    }
    if (rf.dataCorruption > 0) {
      console.log(
        `    ${red}Data Corruption:  ${rf.dataCorruption}${reset} ${dim}(value mismatch after write)${reset}`,
      );
    }
    if (rf.malformedData > 0) {
      console.log(
        `    ${yellow}Malformed Data:   ${rf.malformedData}${reset} ${dim}(invalid value format)${reset}`,
      );
    }
    if (rf.phantomReads > 0) {
      console.log(
        `    ${yellow}Phantom Reads:    ${rf.phantomReads}${reset} ${dim}(unexpected value source)${reset}`,
      );
    }
    console.log();
  } else {
    console.log(header("Data Integrity"));
    console.log();
    console.log(
      `  ${green}${bold}All checks passed${reset} ${dim}(no data integrity issues)${reset}`,
    );
    console.log();
  }

  // Show cache-internal errors separately (these are expected in multi-process mode)
  if (totalCacheErrorCount > 0) {
    console.log(
      `  ${bold}Cache I/O Events:${reset} ${dim}(expected in multi-process mode)${reset}`,
    );
    if (ce.readErrors > 0) {
      console.log(
        `    Read errors:      ${dim}${ce.readErrors}${reset} ${dim}(file missing or inaccessible)${reset}`,
      );
    }
    if (ce.parseErrors > 0) {
      console.log(
        `    ${yellow}Parse errors:     ${ce.parseErrors}${reset} ${dim}(JSON parse failures)${reset}`,
      );
    }
    if (ce.writeErrors > 0) {
      console.log(
        `    ${red}Write errors:     ${ce.writeErrors}${reset} ${dim}(file write failures)${reset}`,
      );
    }
    if (ce.syncErrors > 0) {
      console.log(
        `    Sync retries:     ${dim}${ce.syncErrors}${reset} ${dim}(index sync contention)${reset}`,
      );
    }
    if (ce.integrityErrors > 0) {
      console.log(
        `    ${red}Integrity errors: ${ce.integrityErrors}${reset} ${dim}(value hash mismatches)${reset}`,
      );
    }
    console.log();
  }

  console.log(`${cyan}${bold}${line()}${reset}`);
  console.log();

  // Error summary if any
  if (results.totalErrors > 0) {
    console.log(
      `${yellow}${bold}NOTE: ${results.totalErrors} caught exceptions during the test${reset}`,
    );
    console.log();
  }
}
