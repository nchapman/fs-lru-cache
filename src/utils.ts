import { createHash } from 'crypto';

/**
 * Generate a hash for a cache key
 * Returns a 32-character hex string (128 bits - collision resistant to ~2^64 keys)
 */
export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
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
 * Compile a glob pattern to a RegExp for efficient reuse
 */
export function compilePattern(pattern: string): RegExp | null {
  if (pattern === '*') return null; // null means "match all"
  return new RegExp(
    '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
  );
}

/**
 * Simple glob pattern matching for keys
 * Supports * as wildcard
 * For bulk operations, use compilePattern() and pass the regex to avoid recompilation
 */
export function matchPattern(key: string, pattern: string | RegExp | null): boolean {
  if (pattern === '*' || pattern === null) return true;
  if (pattern instanceof RegExp) return pattern.test(key);

  const regex = new RegExp(
    '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
  );
  return regex.test(key);
}
