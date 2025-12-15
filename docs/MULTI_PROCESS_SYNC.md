# Multi-Process Sync Implementation

## Overview

This document describes how `fs-lru-cache` enables multiple Node.js processes to share the same cache directory while maintaining reasonable consistency guarantees.

## The Problem

In single-process mode, each cache instance maintains an in-memory index that tracks:
- Which keys exist on disk
- File metadata (size, hash, expiration, last access time)
- Total disk usage

When multiple processes share a cache directory without coordination:
- **Index divergence**: Each process has a different view of what's on disk
- **Lost writes**: Process A's writes are invisible to Process B's index
- **Inconsistent evictions**: Processes make eviction decisions based on incomplete information
- **Size limit violations**: Total disk usage can exceed limits (each process only knows its own writes)
- **Stale reads**: Memory cache may contain deleted or overwritten keys

## The Solution: Shared Index File

### Architecture

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

### Shared Index Format

The `.index.json` file contains:

```typescript
{
  "version": 123,           // Monotonically increasing
  "entries": {
    "user:1": {
      "hash": "a1b2c3...",  // SHA-256 hash of key (filename)
      "size": 4096,          // File size in bytes
      "expiresAt": null,     // Expiration timestamp or null
      "lastAccessedAt": 1704067200000,  // Last access time
      "valueHash": "d4e5f6..." // SHA-256 hash of value (change detection)
    },
    // ... more entries
  }
}
```

The `valueHash` field is a 16-character truncated SHA-256 hash of the serialized value content. It enables detection of value overwrites by other processes, allowing proper memory cache invalidation.

### Sync Mechanism

When `multiProcess: true` is configured:

1. **Periodic Timer**: Every `syncInterval` ms, each process:
   - Flushes pending async writes
   - Writes its local index to `.index.json` (merged with existing)
   - Reads `.index.json` and merges changes from other processes

2. **Manual Sync**: `forceSync()` triggers immediate sync

3. **Startup**: When loading from `.index.json`:
   - Verify files exist on disk (handles crashes during deletion)
   - Skip entries whose files are missing
   - Filter out expired entries

4. **Sync Flow**:
   ```
   sync() called
     │
     ├─► Check syncInProgress mutex
     │   └─► Wait if sync already running
     │
     ├─► Flush pending writes
     │   └─► onBeforeSync() callback
     │
     ├─► Write shared index
     │   ├─► Read existing .index.json
     │   ├─► Verify foreign entries exist (entries we don't have locally)
     │   ├─► Merge with local index
     │   ├─► Increment version
     │   ├─► Atomic write (temp + rename)
     │   └─► Verify write succeeded (retry if lost)
     │
     └─► Merge shared index
         ├─► Read .index.json
         ├─► Skip if version ≤ local version
         ├─► Verify foreign entries exist
         ├─► Add/update entries in local index
         ├─► Invalidate memory cache if valueHash changed
         └─► Remove entries not on disk
   ```

## Key Design Decisions

### 1. Eventual Consistency Model

**Decision**: Eventual consistency instead of strong consistency

**Rationale**:
- Strong consistency requires distributed locks (complex, slower)
- Caches are ephemeral by nature - occasional stale reads are acceptable
- Better availability and performance

**Implications**:
- Writes visible to writer immediately
- Other processes see writes within `syncInterval` ms
- LRU ordering is approximate
- Size limits may temporarily exceed

### 2. Optimistic Concurrency Control

**Decision**: Retry on conflict instead of locking

**Implementation**:
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

  if (ourEntriesPresent(verify)) {
    return; // Merged by another process
  }

  // Retry with backoff
  await delay(exponentialBackoff(attempt));
}
```

**Verification Logic**: We only verify key presence, not `valueHash`, because:
1. Same key = same file path (hash is based on key, not value)
2. If another process wrote a different value for our key, that's expected last-write-wins behavior at the file system level
3. The goal is to ensure our keys weren't completely lost from the index

**Benefits**:
- No lock files to manage
- No deadlock risk
- Better performance when contention is low

**Drawbacks**:
- Under high contention, some writes may be lost after retries
- Not suitable for scenarios requiring guaranteed writes

### 3. Value Change Detection via valueHash

**Decision**: Track content hash to detect value overwrites

**Problem**: When Process B overwrites a key that Process A has in memory cache, Process A's memory cache becomes stale. Without change detection, reads would return stale data.

**Solution**:
```typescript
// During merge, detect if value changed
if (existing.valueHash !== entry.valueHash) {
  // Value was overwritten by another process
  existing.valueHash = entry.valueHash;
  // Notify parent to invalidate stale memory cache
  this.onInvalidate?.(key);
}
```

**Callback Separation**: The implementation uses two distinct callbacks:
- `onEvict`: Called when a key is removed from disk (LRU eviction, collision, deletion by another process)
- `onInvalidate`: Called when a key's value changed but the key still exists (overwritten by another process)

This separation provides clearer semantics and allows different handling (e.g., `onEvict` cancels pending touches, `onInvalidate` only clears memory).

**Benefits**:
- Memory cache automatically invalidated when values change
- Reads after `forceSync()` return fresh data
- Low overhead (16-char hash per entry)
- Clear semantic distinction between eviction and invalidation

### 4. Optimized File Verification

**Decision**: Only verify "foreign" entries (entries we don't have locally)

**Problem**: Verifying all entries on every sync is expensive. With 10,000 entries, batch verification takes ~2 seconds.

**Solution**:
- **During write**: Only verify entries from other processes that we don't have locally
- **During merge**: Only verify entries from shared index that we don't have locally
- **Local entries**: Known to exist (either our version or another process's version at the same file path)

**Performance**: Reduces verification from O(all entries) to O(foreign entries), typically much smaller.

### 5. Batched File Verification

**Decision**: Verify file existence in batches of 100

**Problem**: With 10,000 entries, sequential `fs.access()` calls are slow

**Solution**:
```typescript
async filterExistingFiles(entries) {
  const BATCH_SIZE = 100;
  const existing = new Map();

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const checks = batch.map(([key, entry]) =>
      fs.access(getFilePath(entry.hash))
        .then(() => [key, entry])
        .catch(() => null)
    );

    const results = await Promise.all(checks);
    // ... collect results
  }

  return existing;
}
```

**Performance**: 10,000 entries in ~2 seconds vs ~30 seconds sequential

### 6. Sync Mutex

**Decision**: Prevent concurrent syncs within a process

**Problem**: `forceSync()` + automatic timer could run simultaneously

**Solution**:
```typescript
private syncInProgress?: Promise<void>;

async sync() {
  if (this.syncInProgress) {
    return this.syncInProgress; // Wait for in-progress sync
  }

  this.syncInProgress = this.doSync();
  try {
    await this.syncInProgress;
  } finally {
    this.syncInProgress = undefined;
  }
}
```

### 7. File Existence as Source of Truth

**Decision**: Files on disk are authoritative, not the index

**Rationale**:
- Processes can crash mid-operation
- Index can become stale
- Files are what users care about

**Implementation**:
- On startup, verify each entry's file exists before loading
- During merge, verify foreign entries' files exist
- Skip entries whose files are missing
- Remove from local index if file deleted by another process

### 8. True Debounce with Max Wait

**Decision**: Index writes use true debounce (reset timer on each mutation) with a maximum wait time

**Problem**: Original implementation used throttle-like behavior where continuous writes could starve index updates.

**Solution**:
```typescript
private scheduleIndexWrite(): void {
  const debounceMs = Math.min(100, this.syncInterval);
  const maxWaitMs = this.syncInterval;

  // Track when we started debouncing
  if (!this.debounceStartTime) {
    this.debounceStartTime = Date.now();
  }

  // Check if we've waited too long - write immediately
  const elapsed = Date.now() - this.debounceStartTime;
  if (elapsed >= maxWaitMs) {
    this.executeIndexWrite();
    return;
  }

  // Reset timer on each write (true debounce)
  if (this.indexWriteTimer) {
    clearTimeout(this.indexWriteTimer);
  }

  this.indexWriteTimer = setTimeout(() => {
    this.executeIndexWrite();
  }, debounceMs);
}
```

**Benefits**:
- Coalesces rapid mutations (reduces disk I/O)
- Guarantees index is written within `syncInterval` ms
- Prevents starvation under continuous load

## Edge Cases and Handling

### 1. Concurrent Index Writes

**Scenario**: Process A and B both write `.index.json` simultaneously

**Handling**:
- Atomic writes (temp file + rename) prevent corruption
- Optimistic concurrency detects overwrites
- Retry with exponential backoff
- Accept if entries are present (merged by other process)

### 2. Process Crash During Write

**Scenario**: Process crashes after writing file but before updating index

**Handling**:
- File becomes "orphaned" - not in any index
- Eventually discovered when:
  - Same key is written again
  - Full directory scan (restart with missing index)
  - Manual repair (not implemented)

**Mitigation**: Files are the source of truth, so data isn't lost

### 3. Deleted Files with Stale Index

**Scenario**: Process A deletes file, Process B's index still has it

**Handling**:
- During sync, verify files exist via `fs.access()`
- Remove entries from index if file missing
- Call `onEvict` callback to clear memory cache

### 4. Value Overwritten by Another Process

**Scenario**: Process A has key in memory, Process B overwrites same key with different value

**Handling**:
- During merge, compare `valueHash` fields
- If `valueHash` differs, call `onInvalidate` to invalidate memory cache
- Next read fetches fresh value from disk

### 5. Index Corruption

**Scenario**: Disk error, invalid JSON, partial write

**Handling**:
- Try-catch around all index reads
- Fall back to full directory scan (`loadIndex()`)
- Rebuild index from actual files on disk

### 6. High Contention

**Scenario**: 10 processes writing simultaneously

**Behavior**:
- Optimistic concurrency retries (max 3 attempts)
- Some writes may be lost after exhausting retries
- Eventual consistency - entries propagate over time

**Recommendation**: Use strong consistency system (Redis) for high contention

### 7. Graceful Shutdown

**Scenario**: `close()` called while sync is in progress

**Handling**:
- Set `closed = true` immediately to prevent new operations from starting
- Wait for any `syncInProgress` to complete
- Wait for any `pendingIndexWrite` to complete
- Perform final index write if dirty

## Performance Characteristics

### Sync Cost

| Entries | Sequential `fs.access` | Batched (100) | Improvement |
|---------|------------------------|---------------|-------------|
| 100     | ~100ms                | ~50ms         | 2x          |
| 1,000   | ~1s                   | ~200ms        | 5x          |
| 10,000  | ~30s                  | ~2s           | 15x         |

### Optimized Verification

With foreign-only verification, actual sync cost depends on overlap:
- **High overlap** (processes share most keys): Very fast, minimal verification
- **Low overlap** (processes have unique keys): Proportional to foreign entries
- **Typical case**: 50-90% faster than verifying all entries

### Sync Overhead

- **Fast path**: Version unchanged, no merge (~10ms)
- **Normal path**: Merge + verify ~200 foreign entries (~100ms)
- **Worst case**: Merge + verify 10,000 foreign entries (~2s)

### Recommendations

- Default `syncInterval: 1000` (1 second) balances consistency vs performance
- Lower `syncInterval` for tighter consistency (higher overhead)
- Higher `syncInterval` for better performance (looser consistency)
- Use `forceSync()` before critical reads

## Consistency Guarantees

### What You Get

- **Read Your Own Writes**: Writes immediately visible to writing process

- **Eventual Visibility**: Other processes see writes within `syncInterval` ms

- **No Data Corruption**: Atomic writes prevent partial updates

- **Deletion Propagation**: Deletes eventually visible to all processes

- **Crash Recovery**: Index rebuilt from files if corrupted

- **Memory Cache Coherence**: Memory cache invalidated when values change (via `valueHash`)

### What You Don't Get

- **Strong Consistency**: Stale reads possible during sync window

- **Guaranteed Write Acceptance**: High contention can lose writes

- **Real-time Synchronization**: Bounded by `syncInterval`

- **Total Ordering**: No global order of writes across processes

- **Perfect LRU**: Each process tracks own access times

## Implementation Details

### File Store Changes

**src/file-store.ts**:
- `writeSharedIndex()`: Write local index to disk (with merge + retry)
- `mergeSharedIndex()`: Read shared index and update local, invalidate memory on value change
- `filterExistingFiles()`: Batch verify file existence
- `loadSharedIndex()`: Load from shared index on startup with file verification
- `sync()`: Orchestrate sync with mutex
- `scheduleIndexWrite()`: True debounce with max wait time
- `markIndexDirty()`: Schedule debounced index write
- `close()`: Wait for in-progress operations, flush index on shutdown

### Cache Layer Changes

**src/cache.ts**:
- `forceSync()`: Public API for manual sync
- `flushPendingWrites()`: Ensure writes on disk before index sync
- `onBeforeSync` callback: Wire FileStore to cache for flush
- `onEvict` callback: Clear memory cache and cancel touches when key removed from disk
- `onInvalidate` callback: Clear memory cache when value changed by another process

### Type Definitions

**src/types.ts**:
- `SharedIndex`: Index file structure
- `SharedIndexEntry`: Per-key metadata including `valueHash`
- `multiProcess` option: Enable multi-process mode
- `syncInterval` option: Configure sync frequency (only used when `multiProcess: true`)

### Utility Functions

**src/utils.ts**:
- `hashValue()`: Compute 16-char content hash for change detection

## Usage Examples

### Basic Setup

```typescript
const cache = new FsLruCache({
  dir: '/shared/cache',
  multiProcess: true,  // Enable multi-process mode
  syncInterval: 1000,  // Sync every 1 second (default)
});

// Writes immediately visible locally
await cache.set('key1', 'value1');

// Other processes see it within 1 second
```

### Manual Sync

```typescript
// Before critical read
await cache.forceSync();
const value = await cache.get('key1'); // Fresh from other processes

// After batch writes
await cache.mset(entries);
await cache.forceSync(); // Make visible to others
```

### PM2 Cluster Mode

```typescript
// In each worker
const cache = new FsLruCache({
  dir: process.env.CACHE_DIR,
  multiProcess: true,
  syncInterval: 500, // Fast sync for cluster
});

// Each worker maintains own instance
// Shared via .index.json
```

## Testing

### Test Coverage

- Sync between two processes
- Deletion sync
- Concurrent writes to different keys
- Last-write-wins conflicts (with memory cache invalidation)
- Automatic sync via interval
- Index file creation/loading
- TTL handling across processes
- Large index performance (500 entries)
- Concurrent `forceSync()` calls
- Sync mutex behavior

### Integration Tests

**tests/sync.test.ts**: 19 tests covering multi-process scenarios

Run tests:
```bash
npm test tests/sync.test.ts
```

## Debugging

### Check Index State

```bash
cat .cache/.index.json | jq '.'
```

### Monitor Sync Activity

```typescript
// Log sync events (not implemented, but could add)
cache.on('sync', ({ added, removed, version }) => {
  console.log(`Synced to v${version}: +${added.length} -${removed.length}`);
});
```

### Verify Consistency

```typescript
// Compare multiple processes
const cacheA = new FsLruCache({ dir, multiProcess: true });
const cacheB = new FsLruCache({ dir, multiProcess: true });

await cacheA.forceSync();
await cacheB.forceSync();

console.log(await cacheA.keys()); // Should match
console.log(await cacheB.keys()); // Should match
```

## Future Improvements

### Potential Enhancements

1. **Sync Events**: Emit events on sync completion with change summary
2. **Conflict Resolution Callbacks**: Let users handle write conflicts
3. **Configurable Batch Size**: Tune `filterExistingFiles` batch size
4. **Index Checksums**: Detect corruption explicitly
5. **Partial Sync**: Only sync changed entries (delta updates)
6. **Lock File Option**: Advisory locks for strong consistency
7. **Sync Stats**: Track sync performance, retry rate, conflicts

### Known Limitations

- **NFS/Network Filesystems**: `fs.rename()` atomicity not guaranteed
- **Version Overflow**: `Number.MAX_SAFE_INTEGER` limit (unlikely)
- **No GC for Orphaned Files**: Files without index entries persist
- **Memory Pressure During Sync**: Large merges increase memory usage

## References

- **Eventual Consistency**: https://en.wikipedia.org/wiki/Eventual_consistency
- **Optimistic Concurrency**: https://en.wikipedia.org/wiki/Optimistic_concurrency_control
- **Atomic File Operations**: Node.js `fs.rename()` guarantees
- **LRU Cache Design**: Two-tier storage with persistence

## Summary

The multi-process sync implementation enables multiple Node.js processes to share a cache directory through a shared index file, periodic synchronization, and optimistic concurrency control. It prioritizes availability and performance over strong consistency, making it suitable for cache workloads where eventual consistency is acceptable.

Key innovations:
- **Value change detection** via `valueHash` for memory cache coherence
- **Optimized file verification** (foreign entries only) for performance
- **True debounce with max wait** for index writes
- **Batched file verification** for performance at scale
- **Optimistic concurrency with retry** to handle conflicts
- **Sync mutex** to prevent internal races
- **File-based source of truth** for crash recovery
- **Graceful shutdown** with proper synchronization

The implementation maintains backward compatibility (`multiProcess: false` by default, no overhead for single-process usage).
