/**
 * Red flags - events that indicate potential problems
 */
export interface RedFlags {
  /** Write then immediate read returns null (violates read-your-own-writes) */
  lostWrites: number;
  /** Read returns different value than what was written (data corruption) */
  dataCorruption: number;
  /** Value failed JSON parse or was malformed */
  malformedData: number;
  /** Read returned a value we never wrote (phantom read) */
  phantomReads: number;
}

/**
 * Cache-internal error counters (mirrors ErrorStats from src)
 */
export interface CacheErrors {
  /** File read failures */
  readErrors: number;
  /** JSON parse failures */
  parseErrors: number;
  /** File write failures */
  writeErrors: number;
  /** Index sync failures */
  syncErrors: number;
  /** Value integrity failures */
  integrityErrors: number;
}

/**
 * Statistics tracked by each worker during the stress test
 */
export interface WorkerStats {
  gets: number;
  sets: number;
  deletes: number;
  hits: number;
  misses: number;
  bytesWritten: number;
  bytesRead: number;
  errors: number;
  syncCount: number;
  redFlags: RedFlags;
  cacheErrors: CacheErrors;
}

/**
 * Results reported by a worker after the test completes
 */
export interface WorkerResult {
  workerId: number;
  stats: WorkerStats;
  duration: number;
  opsPerSecond: number;
}

/**
 * Aggregated results from all workers
 */
export interface AggregateResults {
  workload: string;
  workers: WorkerResult[];
  totalOps: number;
  totalDuration: number;
  opsPerSecond: number;
  totalHits: number;
  totalMisses: number;
  hitRate: number;
  totalBytesWritten: number;
  totalBytesRead: number;
  totalSyncCount: number;
  totalErrors: number;
  indexSize: number;
  totalRedFlags: RedFlags;
  totalCacheErrors: CacheErrors;
}

/**
 * Configuration for a workload profile
 */
export interface WorkloadConfig {
  name: string;
  readPercent: number;
  writePercent: number;
  deletePercent: number;
  keySpaceSize: number;
  minValueSize: number;
  maxValueSize: number;
  description: string;
}

/**
 * Configuration passed to workers
 */
export interface WorkerConfig {
  workerId: number;
  cacheDir: string;
  duration: number;
  workload: WorkloadConfig;
  multiProcess: boolean;
}

/**
 * Message sent from worker to main thread
 */
export interface WorkerMessage {
  type: "result" | "error";
  workerId: number;
  result?: WorkerResult;
  error?: string;
}

/**
 * Message sent from main thread to worker
 */
export interface MainMessage {
  type: "start" | "stop";
}

/**
 * CLI options for the stress test
 */
export interface CliOptions {
  workload: string;
  workers: number;
  duration: number;
  cacheDir: string;
  multiProcess: boolean;
}
