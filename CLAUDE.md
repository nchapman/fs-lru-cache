# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build        # Build with tsdown (outputs CJS, ESM, and .d.ts to dist/)
npm run typecheck    # Run TypeScript type checking
npm run test         # Run all tests with vitest
npm run test:watch   # Run tests in watch mode
npm run format       # Format code with prettier
npm run format:check # Check formatting
npm run bench        # Run benchmarks (tsx benchmark.ts)
```

To run a single test file:

```bash
npx vitest run tests/cache.test.ts
```

To run a specific test by name:

```bash
npx vitest run -t "test name pattern"
```

## Architecture

This is a two-tier LRU cache with file system persistence. The cache maintains hot data in memory while persisting everything to disk.

### Core Components

- **FsLruCache** (`src/cache.ts`) - Main public API. Coordinates between memory and file stores. Implements stampede protection for concurrent operations and debounced file touches to reduce disk I/O.

- **MemoryStore** (`src/memory-store.ts`) - In-memory LRU cache using Map (insertion order = LRU order). Stores JSON-serialized values. Evicts expired items first, then LRU.

- **FileStore** (`src/file-store.ts`) - Disk storage with sharding. Maintains an in-memory index for fast lookups without disk reads. Uses atomic writes (temp file + rename). Supports optional gzip compression with auto-detection for seamless migration.

- **Utils** (`src/utils.ts`) - Key hashing (SHA-256, truncated to 32 chars), shard index calculation, expiration checks, glob pattern matching.

### Data Flow

1. **Writes**: Disk first (durability), then memory if value fits
2. **Reads**: Memory first, then disk (promoting hits to memory)
3. **Eviction**: When disk evicts a key (space pressure), it notifies cache via `onEvict` callback to also remove from memory

### Key Design Decisions

- Memory is always a subset of disk (disk is source of truth)
- File store uses sharded directories (configurable, default 16) for filesystem performance
- Hash collisions are handled by evicting the colliding key
- Lazy expiration by default; optional automatic pruning with `pruneInterval`
- `null` values cannot be distinguished from cache misses (use sentinel values for negative caching)

## TypeScript Configuration

Uses strict TypeScript with additional quality checks:

- `noUncheckedIndexedAccess: true`
- `noPropertyAccessFromIndexSignature: true`
- Target: ES2023, requires Node.js >= 22
