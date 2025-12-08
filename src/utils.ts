import { createHash } from 'crypto';

/**
 * Generate a hash for a cache key
 * Returns a 16-character hex string
 */
export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * Get the shard index for a key
 */
export function getShardIndex(key: string, shardCount: number): number {
  const hash = hashKey(key);
  const num = parseInt(hash.slice(0, 8), 16);
  return num % shardCount;
}

/**
 * Get shard directory name (2-char hex)
 */
export function getShardName(index: number): string {
  return index.toString(16).padStart(2, '0');
}

/**
 * Estimate byte size of a JSON-serializable value
 */
export function estimateSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * Check if a cache entry has expired
 */
export function isExpired(expiresAt: number | null): boolean {
  if (expiresAt === null) return false;
  return Date.now() > expiresAt;
}

/**
 * Simple glob pattern matching for keys
 * Supports * as wildcard
 */
export function matchPattern(key: string, pattern: string): boolean {
  if (pattern === '*') return true;

  const regex = new RegExp(
    '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
  );
  return regex.test(key);
}
