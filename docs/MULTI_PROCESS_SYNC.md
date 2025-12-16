# Multi-Process Synchronization

## Overview

`fs-lru-cache` supports multiple Node.js processes sharing the same cache directory through a shared index file and periodic synchronization. This enables use cases like PM2 cluster mode where multiple workers need shared cache access.

**Enable with:**

```typescript
const cache = new FsLruCache({
  dir: "/shared/cache",
  experimentalMultiProcess: true,
  syncInterval: 1000, // optional, default 1000ms
});
```

## Architecture

```
┌─────────────┐        ┌─────────────┐        ┌─────────────┐
│  Process A  │        │  Process B  │        │  Process C  │
│             │        │             │        │             │
│ ┌─────────┐ │        │ ┌─────────┐ │        │ ┌─────────┐ │
│ │In-Memory│ │        │ │In-Memory│ │        │ │In-Memory│ │
│ │  Index  │ │        │ │  Index  │ │        │ │  Index  │ │
│ └────┬────┘ │        │ └────┬────┘ │        │ └────┬────┘ │
│      │      │        │      │      │        │      │      │
│      │ sync │        │      │ sync │        │      │ sync │
│      ▼      │        │      ▼      │        │      ▼      │
└──────┼──────┘        └──────┼──────┘        └──────┼──────┘
       │                      │                      │
       └──────────────────────┼──────────────────────┘
                              ▼
                      ┌───────────────┐
                      │ .index.json   │
                      │ (on disk)     │
                      └───────────────┘
                              │
                              ▼
                      ┌───────────────┐
                      │ Cache Files   │
                      │ (sharded)     │
                      └───────────────┘
```

Each process maintains its own in-memory index and periodically synchronizes with a shared `.index.json` file. This enables:

- Visibility of writes across processes
- Coordinated eviction decisions
- Memory cache invalidation when values change
- Detection of deletions by other processes

## Shared Index Format

The `.index.json` file contains:

```typescript
interface SharedIndex {
  version: number; // Monotonically increasing
  entries: Record<string, SharedIndexEntry>;
}

interface SharedIndexEntry {
  hash: string; // SHA-256 hash of key (used as filename)
  size: number; // Compressed file size in bytes
  expiresAt: number | null; // Expiration timestamp or null
  lastAccessedAt: number; // Last access time (for LRU ordering)
  valueHash?: string; // 16-char SHA-256 of value content
}
```

The `valueHash` field enables detection of value overwrites by other processes, allowing proper memory cache invalidation.

## Consistency Model

This implementation provides **eventual consistency**:

| Guarantee              | Description                                         |
| ---------------------- | --------------------------------------------------- |
| Read Your Own Writes   | Writes immediately visible to the writing process   |
| Eventual Visibility    | Other processes see writes within `syncInterval` ms |
| No Data Corruption     | Atomic writes prevent partial updates               |
| Deletion Propagation   | Deletes eventually visible to all processes         |
| Crash Recovery         | Index rebuilt from files if corrupted               |
| Memory Cache Coherence | Memory cache invalidated when values change         |

**Not guaranteed:**

- Strong consistency (stale reads possible during sync window)
- Guaranteed write acceptance under high contention
- Real-time synchronization
- Total ordering of writes across processes
- Perfect LRU ordering

## Synchronization Flow

### Automatic Sync

When `experimentalMultiProcess: true`, a background timer runs every `syncInterval` ms:

```
sync() called
  │
  ├─► Acquire sync mutex (prevent concurrent syncs)
  │
  ├─► Flush pending async writes
  │   └─► onBeforeSync() callback
  │
  ├─► Wait for debounced index write
  │
  ├─► Write shared index (if dirty)
  │   ├─► Read existing .index.json
  │   ├─► Verify foreign entries exist on disk
  │   ├─► Merge with local index
  │   ├─► Increment version
  │   ├─► Atomic write (temp + rename)
  │   └─► Verify write succeeded (retry if lost)
  │
  └─► Merge shared index
      ├─► Read .index.json
      ├─► Skip if version ≤ local version
      ├─► Filter expired entries
      ├─► Verify foreign entries exist
      ├─► Add/update entries in local index
      ├─► Invalidate memory cache if valueHash changed
      └─► Remove entries deleted by other processes
```

### Manual Sync

Call `forceSync()` for immediate synchronization:

```typescript
// Before critical read - ensure fresh data
await cache.forceSync();
const value = await cache.get("key");

// After batch writes - make visible to other processes
await cache.mset(entries);
await cache.forceSync();
```

## Concurrency Control

### Optimistic Concurrency

Index writes use optimistic concurrency with retry:

```typescript
for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
  // Read-modify-write
  const existingIndex = await readSharedIndex();
  const merged = mergeWithLocal(existingIndex);
  await atomicWrite(merged);

  // Verify not overwritten
  const verify = await readSharedIndex();
  if (verify.version === merged.version) {
    return; // Success
  }

  if (ourKeysPresent(verify)) {
    return; // Merged by another process
  }

  // Retry with backoff
  await delay(exponentialBackoff(attempt));
}
```

| Constant    | Value    | Description                                 |
| ----------- | -------- | ------------------------------------------- |
| MAX_RETRIES | 3        | Attempts before accepting best-effort state |
| Backoff     | 10-100ms | Exponential with jitter                     |

### Sync Mutex

A mutex prevents concurrent syncs within a process:

```typescript
async sync(): Promise<void> {
  if (this.syncInProgress) {
    return this.syncInProgress; // Wait for in-progress sync
  }
  this.syncInProgress = this.doSync();
  // ...
}
```

### Index Write Debouncing

Index writes use true debounce with max-wait to coalesce rapid mutations:

| Parameter  | Value                         | Description                     |
| ---------- | ----------------------------- | ------------------------------- |
| debounceMs | `Math.min(100, syncInterval)` | Reset timer on each mutation    |
| maxWaitMs  | `syncInterval`                | Force write if waiting too long |

## File Verification

### Batched Verification

File existence checks are batched to avoid overwhelming the filesystem:

```typescript
private async filterExistingFiles(entries): Promise<Map<string, T>> {
  const BATCH_SIZE = 100;
  // Process in parallel batches of 100
}
```

### Optimized Verification

Only "foreign" entries (entries we don't have locally) are verified:

- **Local entries**: Known to exist (we wrote them)
- **Foreign entries**: From other processes, may have been deleted

This reduces verification from O(all entries) to O(foreign entries).

## Value Change Detection

When Process B overwrites a key that Process A has in memory cache, the `valueHash` field detects this:

```typescript
// During merge
if (existing.valueHash !== entry.valueHash) {
  // Value was overwritten by another process
  existing.valueHash = entry.valueHash;
  this.onInvalidate?.(key); // Clear memory cache
}
```

The cache layer responds to callbacks:

- `onEvict(key)`: Key removed from disk → clear memory, cancel pending touches
- `onInvalidate(key)`: Value changed but key exists → clear memory only

## Startup Behavior

On startup with `experimentalMultiProcess: true`:

1. Try to load from `.index.json` (fast path)
2. Verify each entry's file exists on disk
3. Filter out expired entries
4. Fall back to full directory scan if index missing/invalid
5. Start periodic sync timer

## Graceful Shutdown

The `close()` method ensures proper shutdown:

1. Stop sync timer (prevent new syncs)
2. Cancel pending debounced writes
3. Wait for in-progress sync to complete
4. Wait for pending index write
5. Final index write if dirty

## Edge Cases

### Concurrent Index Writes

- Atomic writes (temp file + rename) prevent corruption
- Optimistic concurrency detects overwrites
- Retry with exponential backoff
- Accept if entries are present (merged by other process)

### Process Crash During Write

- File becomes "orphaned" (not in any index)
- Discovered when same key is written again
- Files are source of truth, data not lost

### Deleted Files with Stale Index

- During sync, verify files exist via `fs.access()`
- Remove entries from index if file missing
- Call `onEvict` callback to clear memory cache

### Index Corruption

- Try-catch around all index reads
- Fall back to full directory scan
- Rebuild index from actual files on disk

### High Contention

Under high contention (many processes writing simultaneously):

- Some writes may be lost after exhausting retries
- Eventual consistency ensures entries propagate over time
- Consider Redis for high-contention scenarios

## Configuration

```typescript
const cache = new FsLruCache({
  dir: "/shared/cache",
  experimentalMultiProcess: true, // Enable multi-process mode
  syncInterval: 1000, // Sync every 1 second (default)
});
```

| Option                     | Default | Description                       |
| -------------------------- | ------- | --------------------------------- |
| `experimentalMultiProcess` | `false` | Enable multi-process coordination |
| `syncInterval`             | `1000`  | Sync interval in milliseconds     |

## Usage Examples

### PM2 Cluster Mode

```typescript
// In each worker
const cache = new FsLruCache({
  dir: process.env.CACHE_DIR,
  experimentalMultiProcess: true,
  syncInterval: 500, // Fast sync for cluster
});
```

### Critical Reads

```typescript
// Ensure fresh data before important operation
await cache.forceSync();
const config = await cache.get("app:config");
```

### Batch Operations

```typescript
// Write batch then sync
await cache.mset(entries);
await cache.forceSync(); // Make visible to other processes
```

## Performance Characteristics

### Sync Cost

| Entries | Sequential fs.access | Batched (100) | Improvement |
| ------- | -------------------- | ------------- | ----------- |
| 100     | ~100ms               | ~50ms         | 2x          |
| 1,000   | ~1s                  | ~200ms        | 5x          |
| 10,000  | ~30s                 | ~2s           | 15x         |

With foreign-only verification, actual cost depends on key overlap between processes.

### Sync Overhead

- **Fast path**: Version unchanged, no merge (~10ms)
- **Normal path**: Merge + verify ~200 foreign entries (~100ms)
- **Worst case**: Merge + verify 10,000 foreign entries (~2s)

### Recommendations

- Default `syncInterval: 1000` balances consistency vs performance
- Lower for tighter consistency (higher overhead)
- Higher for better performance (looser consistency)
- Use `forceSync()` before critical reads

## Limitations

- **NFS/Network Filesystems**: `fs.rename()` atomicity not guaranteed
- **No GC for Orphaned Files**: Files without index entries persist until overwritten
- **Approximate LRU**: Each process tracks its own access times

## Debugging

### Check Index State

```bash
cat .cache/.index.json | jq '.'
```

### Verify Consistency

```typescript
const cacheA = new FsLruCache({ dir, experimentalMultiProcess: true });
const cacheB = new FsLruCache({ dir, experimentalMultiProcess: true });

await cacheA.forceSync();
await cacheB.forceSync();

console.log(await cacheA.keys()); // Should match
console.log(await cacheB.keys()); // Should match
```
