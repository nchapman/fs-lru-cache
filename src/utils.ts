import { createHash } from "crypto";

/**
 * A compiled pattern for efficient repeated matching.
 * null means "match all" (*), RegExp is the compiled pattern.
 */
export type CompiledPattern = RegExp | null;

/**
 * Generate a hash for a cache key.
 * Returns a 32-character hex string (128 bits - collision resistant to ~2^64 keys)
 */
export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

/**
 * Get the shard index from a hash
 */
export function getShardIndex(hash: string, shardCount: number): number {
  return parseInt(hash.slice(0, 8), 16) % shardCount;
}

/**
 * Get shard directory name (2-char hex)
 */
export function getShardName(index: number): string {
  return index.toString(16).padStart(2, "0");
}

/**
 * Check if a cache entry has expired
 */
export function isExpired(expiresAt: number | null): boolean {
  return expiresAt !== null && Date.now() > expiresAt;
}

/**
 * Compile a glob pattern to a RegExp for efficient reuse.
 * Returns null for '*' (match all) as an optimization.
 */
export function compilePattern(pattern: string): CompiledPattern {
  if (pattern === "*") return null;
  const collapsed = pattern.replace(/\*+/g, "*");
  const escaped = collapsed.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/**
 * Test if a key matches a pattern.
 * Accepts a pre-compiled RegExp, a string pattern, or null (match all).
 */
export function matchPattern(key: string, pattern: string | RegExp | null): boolean {
  if (pattern === null || pattern === "*") return true;
  if (pattern instanceof RegExp) return pattern.test(key);
  return compilePattern(pattern)!.test(key);
}
