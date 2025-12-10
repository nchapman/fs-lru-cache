# fs-lru-cache

A two-tier LRU cache with file system persistence and in-memory acceleration. Disk is the source of truth; memory acts as a hot cache for frequently accessed items.

## Quick Start

```bash
npm install github:nchapman/fs-lru-cache
```

```typescript
import { FsLruCache } from "fs-lru-cache";

const cache = new FsLruCache();

await cache.set("key", { any: "value" });
await cache.get("key"); // { any: "value" }

// With TTL (seconds)
await cache.set("session", userData, 3600);

// Cache-aside pattern with stampede protection
const user = await cache.getOrSet("user:1", () => db.fetchUser(1), 60);
```

## How It Works

### Architecture

**Two-tier storage:** Hot items live in memory, all items persist to disk. Reads check memory first, then disk. Writes update memory immediately if the value fits, then persist to disk asynchronously.

**Disk layer:** Sharded file system storage with an in-memory index. Default is 16 shards. The index maps keys to metadata—hash, size, expiry, last access time—so reads don't require filesystem scans. Files are written atomically using temp file + rename. Keys are hashed using SHA-256 truncated to 32 characters to avoid filesystem limitations.

**Memory layer:** Simple LRU cache using JavaScript Map. Insertion order tracks LRU order. Stores JSON-serialized values as strings. Reads deserialize with `JSON.parse()`. When memory is full, expired items are evicted first, then the least recently used.

**Consistency:** Disk is always the source of truth. Memory is a subset of disk. When disk evicts a key due to space pressure or hash collision, it notifies the cache to also remove it from memory.

### Async Writes

By default, writes are asynchronous. `set()` returns immediately after updating memory; disk persistence happens in background. This provides Redis-like performance for writes while maintaining durability.

Pending writes are tracked in memory with their serialized values, so reads return the correct value even before the disk write completes. This ensures read-after-write consistency. Writes to the same key are chained to prevent race conditions.

If a disk write fails, the value is evicted from memory to maintain consistency. Use `flush()` to wait for all pending writes to complete.

### Stampede Protection

`getOrSet()` includes stampede protection. If multiple concurrent calls request the same uncached key, only the first call executes the compute function. Other calls wait for the result. This prevents thundering herd problems when cache misses occur under load.

### LRU Tracking

**Memory:** Tracked via Map insertion order. Reading a key removes and re-inserts it.

**Disk:** Tracked via `lastAccessedAt` timestamp in the in-memory index. Reading a key schedules a debounced file touch to update mtime. Touch operations are debounced with a 5 second window to reduce disk I/O. Multiple accesses to the same key within the window result in a single disk write.

### Eviction

**Memory eviction:** Happens when memory limits are reached. Expired items are evicted first, then the LRU item.

**Disk eviction:** Happens when disk space limit is reached or on hash collision. Expired items are evicted first, then the oldest by `lastAccessedAt` timestamp.

**Hash collisions:** When two keys hash to the same value, the newer key evicts the older one. The collision victim is removed from both disk and memory.

### TTL and Expiration

TTL is tracked as an `expiresAt` timestamp. Expiration is lazy—items aren't removed until accessed or explicitly pruned. This avoids background scanning overhead.

Enable `pruneInterval` for automatic background pruning at a specified interval in milliseconds.

## API Reference

### Core Operations

```typescript
// Get a value from cache
get<T>(key: string): Promise<T | null>

// Set a value with optional TTL (in seconds)
set(key: string, value: unknown, ttl?: number): Promise<void>

// Delete a key
del(key: string): Promise<boolean>

// Check if key exists
exists(key: string): Promise<boolean>

// Get all keys matching glob pattern with * wildcard support
keys(pattern?: string): Promise<string[]>

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

### Cache-Aside Pattern

```typescript
// Get value or compute and cache it if missing
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

## Advanced Features

### Pattern Matching

The `keys()` method supports glob patterns with `*` wildcards:

```typescript
await cache.set("user:1:profile", { name: "Alice" });
await cache.set("user:1:settings", { theme: "dark" });
await cache.set("user:2:profile", { name: "Bob" });

await cache.keys("user:*"); // ["user:1:profile", "user:1:settings", "user:2:profile"]
await cache.keys("user:1:*"); // ["user:1:profile", "user:1:settings"]
await cache.keys("*:profile"); // ["user:1:profile", "user:2:profile"]
```

Patterns are compiled to RegExp for efficient reuse. The special pattern `*` matches all keys without regex overhead.

### Compression

When `gzip: true`, all disk writes are compressed. Reads auto-detect compression by checking for gzip magic bytes, so you can enable compression on an existing cache without migration—old uncompressed files and new compressed files coexist.

Compression trades CPU for disk space. Benchmarks show ~70% disk space reduction for typical JSON data, with a ~30% write performance penalty and ~50% read performance penalty.

### Sharding

Files are distributed across subdirectories (shards) based on hash. This improves filesystem performance since many filesystems degrade with large numbers of files in a single directory.

Shard index is computed as `parseInt(hash.slice(0, 8), 16) % shardCount`. Shard directories are named with 2-character hex: 00, 01, up to 0f for 16 shards.

### Atomic Writes

Disk writes use atomic rename: write to a temporary file, then rename to the target path. This prevents corruption from crashes mid-write and ensures readers never see partial data.

### In-Memory Index

The file store maintains an in-memory index mapping keys to metadata (hash, size, expiry, access time). This allows:

- Fast `has()` checks without disk I/O
- Fast `keys()` filtering without filesystem scans
- Efficient LRU eviction (find oldest by `lastAccessedAt`)
- Fast size calculations for space pressure checks

The index is rebuilt on startup by scanning all shard directories once.

### Namespace

Setting a `namespace` prefixes all keys internally. This allows multiple caches to share a directory without key collisions:

```typescript
const userCache = new FsLruCache({ dir: ".cache", namespace: "users" });
const postCache = new FsLruCache({ dir: ".cache", namespace: "posts" });

await userCache.set("123", userData); // Stored as "users:123"
await postCache.set("123", postData); // Stored as "posts:123"
```

The `keys()` method strips the namespace from returned keys.

### Debounced Touches

Reading a key updates its LRU position in both tiers. Memory updates are instant (map re-insertion). Disk updates are debounced: the first read schedules a touch 5 seconds later. Additional reads within that window are ignored. This coalesces frequent accesses into a single disk write.

Pending touches are tracked and awaited by `flush()` and `close()`.

### Hash Collision Handling

Keys are hashed to 32-character hex strings, which provides 128 bits from SHA-256. With a good hash function, collisions are unlikely until around 2^64 keys due to the birthday paradox.

When a collision occurs, the new key evicts the old one. The evicted key is removed from disk and memory, and the `onEvict` callback fires if configured.

## Performance

Benchmarks on Apple M4 Max, Node.js v22. Numbers vary with hardware, value sizes, and access patterns.

| Operation                  | fs-lru-cache   | Redis (localhost) |
| -------------------------- | -------------- | ----------------- |
| get (memory hit)           | ~1.5M ops/s    | ~40K ops/s        |
| get (disk hit)             | ~7K ops/s      | ~40K ops/s        |
| set (100B value)           | ~75K ops/s     | ~23K ops/s        |
| set (1KB value)            | ~53K ops/s     | ~28K ops/s        |
| mset (10 items)            | ~35K ops/s     | ~18K ops/s        |
| getOrSet (hit)             | ~200K ops/s    | N/A               |
| getOrSet (miss)            | ~1K ops/s      | N/A               |
| mixed workload (80/20 r/w) | ~1.5M ops/s    | ~38K ops/s        |

**Key characteristics:**

- Memory hits are fast with no I/O, only JSON.parse deserialization
- Async writes provide low latency by returning after memory update while disk write happens in background
- Disk reads are slower but still reasonable at around 7K ops/s
- No network overhead compared to Redis
- Single-process and single-node only, not distributed

Run `npm run bench` to benchmark on your hardware.

### When to Use This vs Redis

**Use fs-lru-cache when:**

- You need a simple embedded cache with no separate server
- Your cache fits on local disk and doesn't need distribution
- You want durability without running infrastructure
- You're caching on a single application server

**Use Redis when:**

- You need distributed caching across multiple servers
- You need pub/sub or other Redis data structures
- You need networked access to the cache
- You already have Redis infrastructure

**Use both when:**

- fs-lru-cache as an L1 per-instance cache
- Redis as an L2 shared cache across instances

## TypeScript Support

Fully typed with strict TypeScript. Generic type parameters for stored values:

```typescript
interface User {
  id: number;
  name: string;
}

const cache = new FsLruCache();

await cache.set<User>("user:1", { id: 1, name: "Alice" });
const user = await cache.get<User>("user:1");
// user is typed as User | null
```

## Limitations

- **Values must be JSON-serializable.** No functions, undefined, symbols, or circular references. These throw `TypeError` on `set()`.

- **`null` values cannot be distinguished from cache misses.** Both `get()` calls return `null`. Use `exists()` to differentiate, or use a sentinel value like `{ notFound: true }` for negative caching.

- **Single process only.** No locking or coordination between processes. Running multiple instances against the same cache directory will cause corruption.

- **Hash collisions evict the old key.** With 128-bit hashes this is unlikely until around 2^64 keys, but possible. The evicted key is silently removed.

- **No transactions.** Operations are not atomic across multiple keys.

- **Disk space is not pre-allocated.** The cache checks size limits before writes, but other processes writing to the same filesystem could cause disk full errors.

## Requirements

Node.js >= 22. Uses modern ES2023 features.

## License

MIT
