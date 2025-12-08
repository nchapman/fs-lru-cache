import { promises as fs } from 'fs';
import { join } from 'path';
import { afterEach } from 'vitest';
import { FsLruCache } from '../src/cache.js';
import { FileStore } from '../src/file-store.js';
import { CacheOptions } from '../src/types.js';

/** Base directory for all test caches */
export const TEST_BASE = process.cwd();

/** Sleep for a given number of milliseconds */
export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Remove a test directory, ignoring errors */
export async function removeDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Create a test directory path with a suffix.
 * The directory will be automatically cleaned up after each test.
 */
export function testDir(name: string): string {
  return join(TEST_BASE, `.test-cache-${name}`);
}

/** Directories to clean up after each test */
const dirsToCleanup: string[] = [];

/** Register a directory for cleanup after each test */
export function registerCleanup(dir: string): void {
  dirsToCleanup.push(dir);
}

/** Setup automatic cleanup after each test */
afterEach(async () => {
  await Promise.all(dirsToCleanup.map(removeDir));
  dirsToCleanup.length = 0;
});

/**
 * Create a FileStore for testing with automatic cleanup.
 */
export function createTestFileStore(
  name: string,
  options: Partial<{ shards: number; maxSize: number }> = {}
): FileStore {
  const dir = testDir(name);
  registerCleanup(dir);
  return new FileStore({
    dir,
    shards: options.shards ?? 4,
    maxSize: options.maxSize ?? 1024 * 1024,
  });
}

/**
 * Create an FsLruCache for testing with automatic cleanup.
 */
export function createTestCache(
  name: string,
  options: Partial<CacheOptions> = {}
): FsLruCache {
  const dir = testDir(name);
  registerCleanup(dir);
  return new FsLruCache({
    dir,
    maxMemoryItems: options.maxMemoryItems ?? 10,
    maxMemorySize: options.maxMemorySize ?? 1024,
    maxDiskSize: options.maxDiskSize ?? 1024 * 1024,
    shards: options.shards ?? 4,
    ...options,
  });
}
