# fs-lru-cache

A two-tier LRU cache for JSON-serializable values with file system persistence and in-memory acceleration. Disk is the source of truth; memory acts as a hot cache for frequently accessed items.

## Quick Start

```bash
npm install github:nchapman/fs-lru-cache
```

```typescript
import { FsLruCache } from "fs-lru-cache";

const cache = new FsLruCache();

await cache.set("user:1", { name: "Alice", email: "alice@example.com" });
await cache.get("user:1"); // { name: "Alice", email: "alice@example.com" }

// With TTL (seconds)
await cache.set("session:abc", { userId: 1, role: "admin" }, 3600);

// Fetch and cache with stampede protection
const user = await cache.getOrSet(
  "user:1",
  async () => {
    const res = await fetch("https://api.example.com/users/1");
    return res.json();
  },
  60,
);
```

## API Reference

### Core Operations

```typescript
// Get a value from cache (returns null if not found or if null was stored)
get<T>(key: string): Promise<T | null>

// Set a value with optional TTL (in seconds)
set(key: string, value: unknown, ttl?: number): Promise<void>

// Delete a key
del(key: string): Promise<boolean>

// Check if key exists
exists(key: string): Promise<boolean>

// Get all keys matching glob pattern with * wildcard support
keys(pattern?: string): Promise<string[]>
// Examples:
//   keys("user:*")    → ["user:1:profile", "user:1:settings", "user:2:profile"]
//   keys("user:1:*")  → ["user:1:profile", "user:1:settings"]
//   keys("*:profile") → ["user:1:profile", "user:2:profile"]

// Remove all entries
clear(): Promise<void>
```

### TTL Operations

```typescript
// Set/update TTL in seconds
expire(key: string, seconds: number): Promise<boolean>

// Get remaining TTL in seconds. Returns -1 if no expiry, -2 if not found
ttl(key: string): Promise<number>

// Remove TTL (make key persistent)
persist(key: string): Promise<boolean>
```

### Batch Operations

```typescript
// Get multiple values. Returns array in same order as keys
mget<T>(keys: string[]): Promise<(T | null)[]>

// Set multiple key-value pairs. Entries are [key, value] or [key, value, ttl] tuples
mset(entries: [string, unknown, number?][]): Promise<void>
```

### Fetch and Cache

```typescript
// Get value, or compute and cache it if missing
// Includes stampede protection for concurrent calls
getOrSet<T>(
  key: string,
  fn: () => T | Promise<T>,
  ttl?: number
): Promise<T>
```

### Utilities

```typescript
// Refresh key's position in LRU without reading value
touch(key: string): Promise<boolean>

// Remove all expired entries. Returns count removed
prune(): Promise<number>

// Get total number of cached items
size(): Promise<number>

// Get cache statistics
stats(): Promise<CacheStats>

// Wait for all pending async writes and touches to complete
flush(): Promise<void>

// Close the cache and wait for pending operations
close(): Promise<void>
```

### CacheStats

```typescript
interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number; // 0 to 1
  memory: {
    items: number;
    size: number; // in bytes
    maxItems: number;
    maxSize: number;
  };
  disk: {
    items: number;
    size: number; // in bytes
  };
  pendingWrites: number; // async writes in flight
}
```

## Configuration

```typescript
new FsLruCache({
  // Cache directory. Default: ".cache"
  dir: ".cache",

  // Maximum items in memory. Default: 1000
  maxMemoryItems: 1000,

  // Maximum memory usage in bytes. Default: 50MB
  // Values larger than this skip the memory tier
  maxMemorySize: 50_000_000,

  // Maximum disk usage in bytes. Default: 500MB
  maxDiskSize: 500_000_000,

  // Number of shard subdirectories. Default: 16
  // More shards improve filesystem performance with many files
  shards: 16,

  // Default TTL in seconds for all entries. Default: none
  // Use ttl=0 in set() to explicitly disable for a specific key
  defaultTtl: 300,

  // Namespace prefix for all keys. Default: none
  // Keys are stored as `${namespace}:${key}`
  namespace: "myapp",

  // Enable gzip compression for disk storage. Default: false
  // Reduces disk usage at the cost of CPU. Auto-detects compressed files for seamless migration
  gzip: true,

  // Interval in milliseconds for automatic pruning. Default: disabled
  // Background task to remove expired items
  pruneInterval: 60000,

  // Block on disk writes. Default: false
  // When false, writes return immediately after updating memory. When true, writes wait for disk persistence
  syncWrites: false,
});
```

## How It Works

### Architecture

**Two-tier storage:** Hot items live in memory, all items persist to disk. Reads check memory first, then disk. Writes update memory immediately if the value fits, then persist to disk asynchronously.

**Disk layer:** Sharded file system storage with an in-memory index. Default is 16 shards. The index maps keys to metadata—hash, size, expiry, last access time—so reads don't require filesystem scans. Files are written atomically using temp file + rename. Keys are hashed using SHA-256 truncated to 32 characters to avoid filesystem limitations.

**Memory layer:** LRU cache that stores serialized values. When memory is full, expired items are evicted first, then the least recently used.

**Consistency:** Disk is always the source of truth. Memory is a subset of disk. When disk evicts a key due to space pressure or hash collision, it notifies the cache to also remove it from memory.

### Async Writes

By default, writes are asynchronous. `set()` returns immediately after updating memory; disk persistence happens in background. This keeps write latency low while still ensuring durability.

Pending writes are tracked in memory with their serialized values, so reads return the correct value even before the disk write completes. This ensures read-after-write consistency. Writes to the same key are chained to prevent race conditions.

If a disk write fails, the value is evicted from memory to maintain consistency. Use `flush()` to wait for all pending writes to complete.

### Stampede Protection

`getOrSet()` includes stampede protection. If multiple concurrent calls request the same uncached key, only the first call executes the compute function. Other calls wait for the result. This prevents thundering herd problems when cache misses occur under load.

### LRU Tracking

**Memory:** Tracked via Map insertion order. Reading a key removes and re-inserts it.

**Disk:** Tracked via `lastAccessedAt` timestamp in the index. File access times are updated in batches to reduce disk I/O.

### Eviction

**Memory eviction:** Happens when memory limits are reached. Expired items are evicted first, then the LRU item.

**Disk eviction:** Happens when disk space limit is reached or on hash collision. Expired items are evicted first, then the oldest by `lastAccessedAt` timestamp.

**Hash collisions:** When two keys hash to the same value, the newer key evicts the older one. The collision victim is removed from both disk and memory.

### TTL and Expiration

TTL is tracked as an `expiresAt` timestamp. Expiration is lazy—items aren't removed until accessed or explicitly pruned. This avoids background scanning overhead.

Enable `pruneInterval` for automatic background pruning at a specified interval in milliseconds.

## Performance

Benchmarks on Apple M4 Max, Node.js v22. Numbers vary with hardware, value sizes, and access patterns.

| Operation                  | fs-lru-cache | Redis (localhost) |
| -------------------------- | ------------ | ----------------- |
| get (memory hit)           | ~1.5M ops/s  | ~40K ops/s        |
| get (disk hit)             | ~7K ops/s    | ~40K ops/s        |
| set (100B value)           | ~75K ops/s   | ~23K ops/s        |
| set (1KB value)            | ~53K ops/s   | ~28K ops/s        |
| mset (10 items)            | ~35K ops/s   | ~18K ops/s        |
| getOrSet (hit)             | ~200K ops/s  | N/A               |
| getOrSet (miss)            | ~1K ops/s    | N/A               |
| mixed workload (80/20 r/w) | ~1.5M ops/s  | ~38K ops/s        |

**Key characteristics:**

- Memory hits are fast—no I/O, just deserialization
- Async writes return immediately; disk persistence happens in background
- Disk reads are slower but avoid network overhead
- Single-process only

Run `npm run bench` to benchmark on your hardware.

## Requirements

Node.js >= 22. Uses modern ES2023 features.

## License

MIT
