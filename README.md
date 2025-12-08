# fs-lru-cache

A fast LRU cache for Node.js with file system persistence.

- **Two-tier storage**: Hot data in memory, everything persisted to disk
- **Familiar API**: Common commands like `get`, `set`, `expire`, `mget`
- **Zero dependencies**: Uses only Node.js built-ins
- **TypeScript**: Full type definitions included

## Installation

```bash
npm install fs-lru-cache
```

## Quick Start

```typescript
import { FsLruCache } from "fs-lru-cache";

const cache = new FsLruCache();

// Basic operations
await cache.set("user:1", { name: "Alice", email: "alice@example.com" });
const user = await cache.get("user:1");

// With TTL (milliseconds)
await cache.set("session:abc", { userId: 1 }, 3600000); // 1 hour

// Cache-aside pattern
const data = await cache.getOrSet(
  "expensive:query",
  async () => {
    return await database.runExpensiveQuery();
  },
  60000,
); // Cache for 1 minute
```

## API

### Basic Operations

```typescript
await cache.get<T>(key)                    // Get value (null if missing)
await cache.set(key, value, ttlMs?)        // Set value with optional TTL
await cache.del(key)                       // Delete key
await cache.exists(key)                    // Check if key exists
await cache.keys(pattern?)                 // Get keys matching pattern (supports *)
await cache.clear()                        // Delete all keys
```

### TTL Operations

```typescript
await cache.expire(key, seconds); // Set TTL in seconds
await cache.pexpire(key, ms); // Set TTL in milliseconds
await cache.ttl(key); // Get TTL in seconds (-1 = no expiry, -2 = not found)
await cache.pttl(key); // Get TTL in milliseconds
await cache.persist(key); // Remove TTL from key
```

### Batch Operations

```typescript
await cache.mget(["key1", "key2", "key3"]); // Get multiple values
await cache.mset([
  // Set multiple values
  ["key1", "value1"],
  ["key2", "value2", 5000], // With TTL
]);
```

### Utilities

```typescript
await cache.setnx(key, value, ttlMs?)      // Set only if not exists
await cache.getOrSet(key, fn, ttlMs?)      // Get or compute and cache
await cache.touch(key, ttlMs?)             // Refresh LRU position, optionally update TTL
await cache.prune()                        // Remove all expired entries
await cache.size()                         // Get total number of items
await cache.stats()                        // Get cache statistics
cache.resetStats()                         // Reset hit/miss counters
await cache.close()                        // Cleanup (call when done)
```

## Configuration

```typescript
const cache = new FsLruCache({
  dir: ".cache", // Cache directory (default: '.cache')
  maxMemoryItems: 1000, // Max items in memory (default: 1000)
  maxMemorySize: 50_000_000, // Max memory in bytes (default: 50MB)
  maxDiskSize: 500_000_000, // Max disk usage in bytes (default: 500MB)
  shards: 16, // Number of subdirectories (default: 16)
  defaultTtl: 300, // Default TTL in seconds for all entries (default: none)
  namespace: "myapp", // Key prefix for multi-tenant apps (default: none)
  gzip: true, // Enable gzip compression for disk (default: false)
  pruneInterval: 60000, // Auto-prune expired items every 60s (default: disabled)
});
```

### Default TTL

Set a default expiration for all entries:

```typescript
// All items expire after 5 minutes unless overridden
const cache = new FsLruCache({ defaultTtl: 300 });

await cache.set("key", "value"); // Expires in 5 minutes
await cache.set("key2", "value", 60_000); // Override: expires in 1 minute
await cache.set("key3", "value", 0); // Override: never expires
```

### Namespace

Isolate cache entries with automatic key prefixing:

```typescript
const userCache = new FsLruCache({ namespace: "users", dir: ".cache" });
const postCache = new FsLruCache({ namespace: "posts", dir: ".cache" });

// Keys are automatically prefixed (stored as "users:123" and "posts:456")
await userCache.set("123", { name: "Alice" });
await postCache.set("456", { title: "Hello" });

// No conflicts - each namespace is isolated
await userCache.get("123"); // { name: "Alice" }
await postCache.get("123"); // null
```

### Gzip Compression

Enable gzip compression to reduce disk usage:

```typescript
const cache = new FsLruCache({ gzip: true });

// Data is compressed on disk, transparent to your code
await cache.set("key", "x".repeat(10000)); // Stored compressed
await cache.get("key"); // Returns original string
```

Features:

- Uses Node.js built-in zlib (no dependencies)
- Auto-detects compressed vs uncompressed files
- Seamless migration: enable compression anytime, old files still readable
- Best for compressible data (text, JSON); less benefit for already-compressed data

### Automatic Pruning

By default, expired items are cleaned up lazily (on access or when disk is full). Enable automatic background pruning for proactive cleanup:

```typescript
const cache = new FsLruCache({ pruneInterval: 60000 }); // Every 60 seconds

// Or prune manually
const removed = await cache.prune();
console.log(`Removed ${removed} expired items`);
```

## Examples

### Session Store

```typescript
const sessions = new FsLruCache({ dir: ".sessions" });

// Create session (24 hour TTL)
await sessions.setnx(`session:${id}`, { userId, createdAt: Date.now() }, 86400000);

// Get session
const session = await sessions.get(`session:${id}`);

// Keep session alive on activity (refresh TTL without reading value)
await sessions.touch(`session:${id}`, 86400000);
```

### Caching Database Queries

```typescript
const cache = new FsLruCache();

async function getUser(id: number) {
  return cache.getOrSet(
    `user:${id}`,
    async () => {
      return await db.users.findById(id);
    },
    300000,
  ); // Cache for 5 minutes
}
```

### Statistics

```typescript
// Quick item count
console.log(`Cache has ${await cache.size()} items`);

// Detailed stats
const stats = await cache.stats();
console.log(`Hit rate: ${(stats.hitRate * 100).toFixed(1)}%`);
console.log(`Memory: ${stats.memory.items} items, ${stats.memory.size} bytes`);
console.log(`Disk: ${stats.disk.items} items, ${stats.disk.size} bytes`);
```

## How It Works

1. **Writes** go to both memory and disk (write-through)
2. **Reads** check memory first, then disk (promoting hits to memory)
3. **LRU eviction** in both tiers when limits are exceeded
4. **Expiration** - Lazy by default, or automatic with `pruneInterval`
5. **Sharded storage** - Files distributed across subdirectories for performance

## License

MIT
