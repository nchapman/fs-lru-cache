# fs-lru-cache

A fast file system LRU cache with in-memory acceleration for Node.js.

## Install

```bash
npm install github:nchapman/fs-lru-cache
```

## Usage

```typescript
import { FsLruCache } from "fs-lru-cache";

const cache = new FsLruCache();

await cache.set("key", { any: "value" });
await cache.get("key"); // { any: "value" }

// With TTL (seconds)
await cache.set("session", data, 3600);

// Cache-aside pattern
const user = await cache.getOrSet("user:1", () => db.fetchUser(1), 60);
```

## API

```typescript
// Basic
get<T>(key): Promise<T | null>
set(key, value, ttl?): Promise<void>
del(key): Promise<boolean>
exists(key): Promise<boolean>
keys(pattern?): Promise<string[]>      // Supports * wildcard
clear(): Promise<void>

// TTL (all in seconds)
expire(key, seconds): Promise<boolean>
ttl(key): Promise<number>              // -1 = no expiry, -2 = not found
persist(key): Promise<boolean>

// Batch
mget(keys): Promise<(T | null)[]>
mset(entries): Promise<void>           // entries: [key, value, ttl?][]

// Utilities
getOrSet(key, fn, ttl?): Promise<T>    // With stampede protection
touch(key): Promise<boolean>
prune(): Promise<number>
size(): Promise<number>
stats(): Promise<CacheStats>
flush(): Promise<void>                 // Wait for pending writes
close(): Promise<void>
```

## Configuration

```typescript
new FsLruCache({
  dir: ".cache", // Cache directory
  maxMemoryItems: 1000, // Max items in memory
  maxMemorySize: 50_000_000, // Max memory bytes (50MB)
  maxDiskSize: 500_000_000, // Max disk bytes (500MB)
  shards: 16, // Subdirectories for performance
  defaultTtl: 300, // Default TTL in seconds
  namespace: "myapp", // Key prefix
  gzip: true, // Compress disk storage
  pruneInterval: 60000, // Auto-prune interval (ms)
  syncWrites: false, // Block on disk writes (default: false)
});
```

## Notes

- Values must be JSON-serializable
- `null` values are indistinguishable from cache misses
- Requires Node.js >= 22

## Performance

Benchmarks on Apple M4 Max, Node.js v22. These numbers are rough estimates—your mileage will vary based on hardware, value sizes, and access patterns. The point isn't to compete with Redis (which is a full-featured networked data store), but to show that fs-lru-cache is fast enough for most caching needs without requiring a separate service.

| Operation | fs-lru-cache | Redis (localhost) |
|-----------|-------------|-------------------|
| get (memory hit) | ~1,500,000 ops/s | ~40,000 ops/s |
| set (100B) | ~75,000 ops/s | ~23,000 ops/s |
| set (1KB) | ~53,000 ops/s | ~28,000 ops/s |
| mixed 80/20 r/w | ~1,500,000 ops/s | ~38,000 ops/s |

Key tradeoffs vs Redis:
- **Faster for hot data**: No network overhead for memory hits
- **No server required**: Just a library, no ops burden
- **Single-node only**: Not distributed, no pub/sub
- **Async writes by default**: Writes return immediately after updating memory; disk persistence happens in the background

Run `npm run bench` to test on your hardware.

## License

MIT
