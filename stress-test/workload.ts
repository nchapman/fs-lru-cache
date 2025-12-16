import type { WorkloadConfig } from "./types.js";

/**
 * Predefined workload profiles for stress testing
 */
export const workloads: Record<string, WorkloadConfig> = {
  "read-heavy": {
    name: "read-heavy",
    readPercent: 80,
    writePercent: 15,
    deletePercent: 5,
    keySpaceSize: 10000,
    minValueSize: 100,
    maxValueSize: 1000,
    description: "Simulates typical cache usage with hot data",
  },

  balanced: {
    name: "balanced",
    readPercent: 50,
    writePercent: 40,
    deletePercent: 10,
    keySpaceSize: 10000,
    minValueSize: 100,
    maxValueSize: 1000,
    description: "Mixed workload with frequent updates",
  },

  "write-heavy": {
    name: "write-heavy",
    readPercent: 20,
    writePercent: 70,
    deletePercent: 10,
    keySpaceSize: 10000,
    minValueSize: 100,
    maxValueSize: 1000,
    description: "Cache as write-through store",
  },

  "small-values": {
    name: "small-values",
    readPercent: 50,
    writePercent: 40,
    deletePercent: 10,
    keySpaceSize: 10000,
    minValueSize: 10,
    maxValueSize: 100,
    description: "Metadata caching",
  },

  "large-values": {
    name: "large-values",
    readPercent: 50,
    writePercent: 40,
    deletePercent: 10,
    keySpaceSize: 5000,
    minValueSize: 10 * 1024, // 10KB
    maxValueSize: 50 * 1024, // 50KB
    description: "Document/blob caching",
  },

  "high-contention": {
    name: "high-contention",
    readPercent: 60,
    writePercent: 30,
    deletePercent: 10,
    keySpaceSize: 100, // Very small key space!
    minValueSize: 100,
    maxValueSize: 1000,
    description: "Tests synchronization under extreme contention",
  },
};

/**
 * Get a workload by name, with validation
 */
export function getWorkload(name: string): WorkloadConfig {
  const workload = workloads[name];
  if (!workload) {
    const available = Object.keys(workloads).join(", ");
    throw new Error(`Unknown workload: ${name}. Available: ${available}`);
  }
  return workload;
}

/**
 * List all available workload names
 */
export function listWorkloads(): string[] {
  return Object.keys(workloads);
}

/**
 * Generate a random value of specified size
 */
export function generateValue(minSize: number, maxSize: number): string {
  const size = Math.floor(Math.random() * (maxSize - minSize + 1)) + minSize;
  // Generate a string of random characters
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < size; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Generate a random key within the key space
 */
export function generateKey(keySpaceSize: number): string {
  const keyIndex = Math.floor(Math.random() * keySpaceSize);
  return `stress-key-${keyIndex}`;
}

/**
 * Pick an operation type based on workload percentages
 */
export function pickOperation(workload: WorkloadConfig): "get" | "set" | "delete" {
  const rand = Math.random() * 100;
  if (rand < workload.readPercent) {
    return "get";
  } else if (rand < workload.readPercent + workload.writePercent) {
    return "set";
  } else {
    return "delete";
  }
}
