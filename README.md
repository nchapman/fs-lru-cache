# fs-lru-cache

A fast, Redis-like LRU cache for Node.js with file system persistence.

- **Two-tier storage**: Hot data in memory, everything persisted to disk
- **Redis-like API**: Familiar commands like `get`, `set`, `expire`, `mget`
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
});
```

## Examples

### Session Store

```typescript
const sessions = new FsLruCache({ dir: ".sessions" });

// Create session
await sessions.setnx(`session:${id}`, { userId, createdAt: Date.now() }, 86400000);

// Get session
const session = await sessions.get(`session:${id}`);

// Extend session
await sessions.expire(`session:${id}`, 86400);
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
const stats = await cache.stats();
console.log(`Hit rate: ${(stats.hitRate * 100).toFixed(1)}%`);
console.log(`Memory: ${stats.memory.items} items, ${stats.memory.size} bytes`);
console.log(`Disk: ${stats.disk.items} items, ${stats.disk.size} bytes`);
```

## How It Works

1. **Writes** go to both memory and disk (write-through)
2. **Reads** check memory first, then disk (promoting hits to memory)
3. **LRU eviction** in both tiers when limits are exceeded
4. **Lazy expiration** - TTL checked on access, not via background jobs
5. **Sharded storage** - Files distributed across subdirectories for performance

## License

MIT
