let crypto = require("crypto");
let fs = require("fs");
let path = require("path");
let zlib = require("zlib");
let util = require("util");

//#region src/types.ts
const DEFAULT_OPTIONS = {
	dir: ".cache",
	maxMemoryItems: 1e3,
	maxMemorySize: 50 * 1024 * 1024,
	maxDiskSize: 500 * 1024 * 1024,
	shards: 16,
	defaultTtl: void 0,
	namespace: void 0,
	gzip: false,
	pruneInterval: void 0
};

//#endregion
//#region src/utils.ts
/**
* Generate a hash for a cache key.
* Returns a 32-character hex string (128 bits - collision resistant to ~2^64 keys)
*/
function hashKey(key) {
	return (0, crypto.createHash)("sha256").update(key).digest("hex").slice(0, 32);
}
/**
* Get the shard index from a hash
*/
function getShardIndex(hash, shardCount) {
	return parseInt(hash.slice(0, 8), 16) % shardCount;
}
/**
* Get shard directory name (2-char hex)
*/
function getShardName(index) {
	return index.toString(16).padStart(2, "0");
}
/**
* Check if a cache entry has expired
*/
function isExpired(expiresAt) {
	return expiresAt !== null && Date.now() > expiresAt;
}
/**
* Compile a glob pattern to a RegExp for efficient reuse.
* Returns null for '*' (match all) as an optimization.
*/
function compilePattern(pattern) {
	if (pattern === "*") return null;
	const escaped = pattern.replace(/\*+/g, "*").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return /* @__PURE__ */ new RegExp(`^${escaped}$`);
}
/**
* Test if a key matches a pattern.
* Accepts a pre-compiled RegExp, a string pattern, or null (match all).
*/
function matchPattern(key, pattern) {
	if (pattern === null || pattern === "*") return true;
	if (pattern instanceof RegExp) return pattern.test(key);
	return compilePattern(pattern).test(key);
}

//#endregion
//#region src/memory-store.ts
/**
* In-memory LRU cache using Map for O(1) operations.
* Map maintains insertion order, enabling LRU tracking via re-insertion.
*/
var MemoryStore = class {
	cache = /* @__PURE__ */ new Map();
	currentSize = 0;
	maxItems;
	maxSize;
	constructor(options) {
		this.maxItems = options.maxItems;
		this.maxSize = options.maxSize;
	}
	/**
	* Get entry if it exists and isn't expired, removing expired entries.
	* Returns null if not found or expired.
	*/
	getValidEntry(key) {
		const entry = this.cache.get(key);
		if (!entry) return null;
		if (isExpired(entry.expiresAt)) {
			this.delete(key);
			return null;
		}
		return entry;
	}
	/**
	* Get a serialized value from the cache.
	* Promotes the key to most recently used on access.
	* @returns The JSON-serialized value string, or null if not found
	*/
	get(key) {
		const entry = this.getValidEntry(key);
		if (!entry) return null;
		this.cache.delete(key);
		this.cache.set(key, entry);
		return entry.serialized;
	}
	/**
	* Get entry metadata without promoting (peek doesn't affect LRU order)
	*/
	peek(key) {
		return this.getValidEntry(key);
	}
	/**
	* Set a serialized value in the cache
	* @param key The cache key
	* @param serialized The JSON-serialized value string
	* @param expiresAt Expiration timestamp or null
	*/
	set(key, serialized, expiresAt = null) {
		if (this.cache.has(key)) this.delete(key);
		const size = Buffer.byteLength(serialized, "utf8");
		const entry = {
			key,
			serialized,
			expiresAt,
			size
		};
		while (this.needsEviction(size)) this.evictOne();
		this.cache.set(key, entry);
		this.currentSize += size;
	}
	/**
	* Delete a key from the cache
	*/
	delete(key) {
		const entry = this.cache.get(key);
		if (!entry) return false;
		this.cache.delete(key);
		this.currentSize -= entry.size;
		return true;
	}
	/**
	* Check if a key exists (and is not expired)
	*/
	has(key) {
		return this.getValidEntry(key) !== null;
	}
	/**
	* Get all keys matching a pattern
	*/
	keys(pattern = "*") {
		const compiled = compilePattern(pattern);
		const result = [];
		for (const [key, entry] of this.cache) if (isExpired(entry.expiresAt)) this.delete(key);
		else if (matchPattern(key, compiled)) result.push(key);
		return result;
	}
	/**
	* Update expiration time for a key
	*/
	setExpiry(key, expiresAt) {
		const entry = this.getValidEntry(key);
		if (!entry) return false;
		entry.expiresAt = expiresAt;
		return true;
	}
	/**
	* Touch a key: promote to most recently used.
	* Does not read or return the value.
	*/
	touch(key) {
		const entry = this.getValidEntry(key);
		if (!entry) return false;
		this.cache.delete(key);
		this.cache.set(key, entry);
		return true;
	}
	/**
	* Get TTL for a key in milliseconds.
	* Returns -1 if no expiry, -2 if not found.
	*/
	getTtl(key) {
		const entry = this.getValidEntry(key);
		if (!entry) return -2;
		if (entry.expiresAt === null) return -1;
		return Math.max(0, entry.expiresAt - Date.now());
	}
	/**
	* Clear all entries
	*/
	clear() {
		this.cache.clear();
		this.currentSize = 0;
	}
	/**
	* Remove all expired entries from the cache.
	* @returns Number of entries removed
	*/
	prune() {
		const now = Date.now();
		let count = 0;
		for (const [key, entry] of this.cache) if (entry.expiresAt !== null && entry.expiresAt <= now) {
			this.delete(key);
			count++;
		}
		return count;
	}
	/**
	* Get current stats
	*/
	get stats() {
		return {
			items: this.cache.size,
			size: this.currentSize,
			maxItems: this.maxItems,
			maxSize: this.maxSize
		};
	}
	/**
	* Check if eviction is needed to accommodate new data
	*/
	needsEviction(newSize) {
		return this.cache.size > 0 && (this.cache.size >= this.maxItems || this.currentSize + newSize > this.maxSize);
	}
	/**
	* Evict an entry to make room for new data.
	* Priority: expired items first, then LRU (oldest in map).
	*/
	evictOne() {
		for (const [key, entry] of this.cache) if (isExpired(entry.expiresAt)) {
			this.delete(key);
			return;
		}
		const oldest = this.cache.keys().next().value;
		if (oldest !== void 0) this.delete(oldest);
	}
};

//#endregion
//#region src/file-store.ts
const gzipAsync = (0, util.promisify)(zlib.gzip);
const gunzipAsync = (0, util.promisify)(zlib.gunzip);
/** Gzip magic bytes for detecting compressed files */
const GZIP_MAGIC = Buffer.from([31, 139]);
/**
* File system storage layer with sharding and in-memory index.
*/
var FileStore = class {
	dir;
	shards;
	maxSize;
	gzip;
	onEvict;
	initialized = false;
	index = /* @__PURE__ */ new Map();
	hashToKey = /* @__PURE__ */ new Map();
	totalSize = 0;
	constructor(options) {
		this.dir = options.dir;
		this.shards = options.shards;
		this.maxSize = options.maxSize;
		this.gzip = options.gzip ?? false;
		this.onEvict = options.onEvict;
	}
	/**
	* Check if a buffer is gzip compressed by looking for magic bytes.
	*/
	isCompressed(data) {
		return data.length >= 2 && data[0] === GZIP_MAGIC[0] && data[1] === GZIP_MAGIC[1];
	}
	/**
	* Compress data if compression is enabled.
	*/
	async compress(data) {
		const buffer = Buffer.from(data, "utf8");
		return this.gzip ? gzipAsync(buffer) : buffer;
	}
	/**
	* Decompress data, auto-detecting if it's compressed.
	*/
	async decompress(data) {
		if (this.isCompressed(data)) return (await gunzipAsync(data)).toString("utf8");
		return data.toString("utf8");
	}
	/**
	* Initialize the cache directory structure and load index
	*/
	async init() {
		if (this.initialized) return;
		await fs.promises.mkdir(this.dir, { recursive: true });
		const shardPromises = Array.from({ length: this.shards }, (_, i) => fs.promises.mkdir((0, path.join)(this.dir, getShardName(i)), { recursive: true }));
		await Promise.all(shardPromises);
		await this.loadIndex();
		this.initialized = true;
	}
	/**
	* Load index from disk (scans all files once on startup)
	*/
	async loadIndex() {
		this.index.clear();
		this.hashToKey.clear();
		this.totalSize = 0;
		const loadShard = async (shardIndex) => {
			const shardDir = (0, path.join)(this.dir, getShardName(shardIndex));
			let files;
			try {
				files = await fs.promises.readdir(shardDir);
			} catch {
				return;
			}
			for (const file of files) {
				if (!file.endsWith(".json")) continue;
				await this.loadFile(shardDir, file);
			}
		};
		await Promise.all(Array.from({ length: this.shards }, (_, i) => loadShard(i)));
	}
	/**
	* Load a single cache file into the index
	*/
	async loadFile(shardDir, file) {
		const filePath = (0, path.join)(shardDir, file);
		try {
			const [stat, rawContent] = await Promise.all([fs.promises.stat(filePath), fs.promises.readFile(filePath)]);
			const content = await this.decompress(rawContent);
			const data = JSON.parse(content);
			if (isExpired(data.expiresAt)) {
				await fs.promises.unlink(filePath).catch(() => {});
				return;
			}
			const hash = file.replace(".json", "");
			this.index.set(data.key, {
				hash,
				expiresAt: data.expiresAt,
				lastAccessedAt: stat.mtimeMs,
				size: stat.size
			});
			this.hashToKey.set(hash, data.key);
			this.totalSize += stat.size;
		} catch {}
	}
	/**
	* Get the file path for a hash
	*/
	getFilePath(hash) {
		const shardName = getShardName(getShardIndex(hash, this.shards));
		return (0, path.join)(this.dir, shardName, `${hash}.json`);
	}
	/**
	* Generate a temporary file path for atomic writes
	*/
	getTempPath() {
		return (0, path.join)(this.dir, `.tmp-${(0, crypto.randomBytes)(8).toString("hex")}`);
	}
	/**
	* Atomic file write: write to temp, then rename
	*/
	async atomicWrite(filePath, content) {
		const tempPath = this.getTempPath();
		try {
			await fs.promises.writeFile(tempPath, content);
			await fs.promises.rename(tempPath, filePath);
		} catch (err) {
			await fs.promises.unlink(tempPath).catch(() => {});
			throw err;
		}
	}
	/**
	* Get a valid index entry, removing it if expired
	*/
	async getValidIndexEntry(key) {
		const entry = this.index.get(key);
		if (!entry) return null;
		if (isExpired(entry.expiresAt)) {
			await this.delete(key);
			return null;
		}
		return entry;
	}
	/**
	* Read and parse a cache file, handling errors and key mismatches
	*/
	async readCacheFile(key, indexEntry) {
		const filePath = this.getFilePath(indexEntry.hash);
		try {
			const rawContent = await fs.promises.readFile(filePath);
			const content = await this.decompress(rawContent);
			const entry = JSON.parse(content);
			if (entry.key !== key) {
				this.index.delete(key);
				return null;
			}
			return entry;
		} catch {
			this.totalSize -= indexEntry.size;
			this.index.delete(key);
			this.hashToKey.delete(indexEntry.hash);
			return null;
		}
	}
	/**
	* Get a value from disk.
	* Returns the full cache entry for consistency with memory store.
	*/
	async get(key) {
		await this.init();
		const indexEntry = await this.getValidIndexEntry(key);
		if (!indexEntry) return null;
		const entry = await this.readCacheFile(key, indexEntry);
		if (entry) indexEntry.lastAccessedAt = Date.now();
		return entry;
	}
	/**
	* Get entry metadata without updating access time
	*/
	async peek(key) {
		await this.init();
		const indexEntry = await this.getValidIndexEntry(key);
		if (!indexEntry) return null;
		return this.readCacheFile(key, indexEntry);
	}
	/**
	* Set a value on disk with atomic write
	* @param content Optional pre-serialized content (to avoid double serialization)
	*/
	async set(key, value, expiresAt = null, content) {
		await this.init();
		const serialized = content ?? JSON.stringify({
			key,
			value,
			expiresAt
		});
		const compressed = await this.compress(serialized);
		const size = compressed.length;
		const hash = hashKey(key);
		const filePath = this.getFilePath(hash);
		const existing = this.index.get(key);
		if (existing) {
			this.totalSize -= existing.size;
			this.hashToKey.delete(existing.hash);
		}
		const collidingKey = this.hashToKey.get(hash);
		if (collidingKey && collidingKey !== key) {
			const collidingEntry = this.index.get(collidingKey);
			if (collidingEntry) {
				this.totalSize -= collidingEntry.size;
				this.index.delete(collidingKey);
				try {
					this.onEvict?.(collidingKey);
				} catch {}
			}
		}
		await this.ensureSpace(size);
		await this.atomicWrite(filePath, compressed);
		this.index.set(key, {
			hash,
			expiresAt,
			lastAccessedAt: Date.now(),
			size
		});
		this.hashToKey.set(hash, key);
		this.totalSize += size;
	}
	/**
	* Delete a key from disk
	*/
	async delete(key) {
		await this.init();
		const indexEntry = this.index.get(key);
		if (!indexEntry) return false;
		const filePath = this.getFilePath(indexEntry.hash);
		this.totalSize -= indexEntry.size;
		this.index.delete(key);
		this.hashToKey.delete(indexEntry.hash);
		try {
			await fs.promises.unlink(filePath);
			return true;
		} catch {
			return false;
		}
	}
	/**
	* Check if a key exists on disk (fast - uses index)
	*/
	async has(key) {
		await this.init();
		return await this.getValidIndexEntry(key) !== null;
	}
	/**
	* Get all keys matching a pattern (fast - uses index)
	*/
	async keys(pattern = "*") {
		await this.init();
		const compiled = compilePattern(pattern);
		const result = [];
		const expiredKeys = [];
		for (const [key, entry] of this.index) if (isExpired(entry.expiresAt)) expiredKeys.push(key);
		else if (matchPattern(key, compiled)) result.push(key);
		if (expiredKeys.length > 0) await Promise.all(expiredKeys.map((key) => this.delete(key)));
		return result;
	}
	/**
	* Update expiration time for a key
	*/
	async setExpiry(key, expiresAt) {
		await this.init();
		const indexEntry = await this.getValidIndexEntry(key);
		if (!indexEntry) return false;
		const filePath = this.getFilePath(indexEntry.hash);
		try {
			const rawContent = await fs.promises.readFile(filePath);
			const content = await this.decompress(rawContent);
			const entry = JSON.parse(content);
			if (entry.key !== key) return false;
			entry.expiresAt = expiresAt;
			const serialized = JSON.stringify(entry);
			const compressed = await this.compress(serialized);
			await this.atomicWrite(filePath, compressed);
			const newSize = compressed.length;
			this.totalSize += newSize - indexEntry.size;
			indexEntry.expiresAt = expiresAt;
			indexEntry.size = newSize;
			return true;
		} catch {
			return false;
		}
	}
	/**
	* Get TTL for a key in milliseconds (fast - uses index).
	* Returns -1 if no expiry, -2 if not found.
	*/
	async getTtl(key) {
		await this.init();
		const indexEntry = await this.getValidIndexEntry(key);
		if (!indexEntry) return -2;
		if (indexEntry.expiresAt === null) return -1;
		return Math.max(0, indexEntry.expiresAt - Date.now());
	}
	/**
	* Touch a key: update last accessed time for LRU tracking.
	* Updates both the in-memory index and file mtime (for restart persistence).
	*/
	async touch(key) {
		await this.init();
		const indexEntry = await this.getValidIndexEntry(key);
		if (!indexEntry) return false;
		const filePath = this.getFilePath(indexEntry.hash);
		const now = Date.now();
		indexEntry.lastAccessedAt = now;
		try {
			const nowDate = new Date(now);
			await fs.promises.utimes(filePath, nowDate, nowDate);
		} catch {}
		return true;
	}
	/**
	* Clear all entries
	*/
	async clear() {
		await this.init();
		const clearShard = async (shardIndex) => {
			const shardDir = (0, path.join)(this.dir, getShardName(shardIndex));
			try {
				const files = await fs.promises.readdir(shardDir);
				await Promise.all(files.map((file) => fs.promises.unlink((0, path.join)(shardDir, file)).catch(() => {})));
			} catch {}
		};
		await Promise.all(Array.from({ length: this.shards }, (_, i) => clearShard(i)));
		this.index.clear();
		this.hashToKey.clear();
		this.totalSize = 0;
	}
	/**
	* Get total size of cache on disk (fast - uses index)
	*/
	async getSize() {
		await this.init();
		return this.totalSize;
	}
	/**
	* Get number of items in cache (fast - uses index)
	*/
	async getItemCount() {
		await this.init();
		return this.index.size;
	}
	/**
	* Remove all expired entries from disk.
	* Uses the in-memory index for efficient lookup (no filesystem scan).
	* @returns Number of entries removed
	*/
	async prune() {
		await this.init();
		const now = Date.now();
		const expired = [];
		for (const [key, entry] of this.index) if (entry.expiresAt !== null && entry.expiresAt <= now) expired.push(key);
		await Promise.all(expired.map((key) => this.delete(key)));
		return expired.length;
	}
	/**
	* Ensure we have space for new data by evicting entries.
	* Priority: expired items first, then LRU (oldest lastAccessedAt).
	*/
	async ensureSpace(needed) {
		if (this.totalSize + needed <= this.maxSize) return;
		const target = this.totalSize + needed - this.maxSize;
		let freed = 0;
		const now = Date.now();
		const expiredKeys = Array.from(this.index.entries()).filter(([, entry]) => entry.expiresAt !== null && entry.expiresAt <= now).map(([key]) => key);
		for (const key of expiredKeys) {
			if (freed >= target) return;
			freed += await this.evictKey(key);
		}
		while (freed < target && this.index.size > 0) {
			const oldestKey = this.findOldestKey();
			if (!oldestKey) break;
			freed += await this.evictKey(oldestKey);
		}
	}
	/**
	* Find the key with the oldest lastAccessedAt
	*/
	findOldestKey() {
		let oldestKey = null;
		let oldestTime = Infinity;
		for (const [key, entry] of this.index) if (entry.lastAccessedAt < oldestTime) {
			oldestTime = entry.lastAccessedAt;
			oldestKey = key;
		}
		return oldestKey;
	}
	/**
	* Evict a single key and return the freed size.
	* Calls onEvict callback to notify parent of the eviction.
	*/
	async evictKey(key) {
		const entry = this.index.get(key);
		if (!entry) return 0;
		const filePath = this.getFilePath(entry.hash);
		const freedSize = entry.size;
		this.totalSize -= entry.size;
		this.index.delete(key);
		this.hashToKey.delete(entry.hash);
		try {
			this.onEvict?.(key);
		} catch {}
		try {
			await fs.promises.unlink(filePath);
		} catch {}
		return freedSize;
	}
};

//#endregion
//#region src/cache.ts
/**
* FsLruCache - An LRU cache with file system persistence.
*
* Features:
* - Two-tier storage: hot items in memory, all items on disk
* - Memory-first reads for fast access to frequently used data
* - Write-through to disk for durability
* - LRU eviction in both memory and disk stores
* - TTL support with lazy expiration
* - Stampede protection for concurrent operations
*/
var FsLruCache = class {
	memory;
	files;
	maxMemorySize;
	defaultTtl;
	namespace;
	hits = 0;
	misses = 0;
	closed = false;
	inFlight = /* @__PURE__ */ new Map();
	pruneTimer;
	touchTimers = /* @__PURE__ */ new Map();
	touchDebounceMs = 5e3;
	constructor(options = {}) {
		const opts = {
			...DEFAULT_OPTIONS,
			...options
		};
		this.maxMemorySize = opts.maxMemorySize;
		this.defaultTtl = opts.defaultTtl;
		this.namespace = opts.namespace;
		this.memory = new MemoryStore({
			maxItems: opts.maxMemoryItems,
			maxSize: opts.maxMemorySize
		});
		this.files = new FileStore({
			dir: opts.dir,
			shards: opts.shards,
			maxSize: opts.maxDiskSize,
			gzip: opts.gzip,
			onEvict: (key) => {
				this.memory.delete(key);
				this.cancelDebouncedTouch(key);
			}
		});
		if (opts.pruneInterval && opts.pruneInterval > 0) {
			this.pruneTimer = setInterval(() => {
				this.prune().catch(() => {});
			}, opts.pruneInterval);
			this.pruneTimer.unref();
		}
	}
	/**
	* Prefix a key with the namespace if configured.
	*/
	prefixKey(key) {
		return this.namespace ? `${this.namespace}:${key}` : key;
	}
	/**
	* Remove the namespace prefix from a key.
	*/
	unprefixKey(key) {
		if (this.namespace && key.startsWith(`${this.namespace}:`)) return key.slice(this.namespace.length + 1);
		return key;
	}
	/**
	* Resolve the TTL to use: explicit value, defaultTtl, or none.
	* - undefined: use defaultTtl if set
	* - 0: explicitly no TTL
	* - positive number: use that TTL (in seconds)
	* Returns milliseconds for internal use.
	*/
	resolveTtl(ttlSeconds) {
		if (ttlSeconds === void 0) return this.defaultTtl ? this.defaultTtl * 1e3 : void 0;
		return ttlSeconds === 0 ? void 0 : ttlSeconds * 1e3;
	}
	assertOpen() {
		if (this.closed) throw new Error("Cache is closed");
	}
	/**
	* Schedule a debounced touch for the file store.
	* Coalesces frequent accesses to reduce disk I/O.
	*/
	debouncedFileTouch(key) {
		if (this.touchTimers.has(key)) return;
		const timer = setTimeout(() => {
			this.touchTimers.delete(key);
			if (!this.closed) this.files.touch(key).catch(() => {});
		}, this.touchDebounceMs);
		timer.unref();
		this.touchTimers.set(key, timer);
	}
	/**
	* Cancel a pending debounced touch (used on delete/eviction).
	*/
	cancelDebouncedTouch(key) {
		const timer = this.touchTimers.get(key);
		if (timer) {
			clearTimeout(timer);
			this.touchTimers.delete(key);
		}
	}
	/**
	* Execute an operation with stampede protection.
	* Concurrent calls for the same key will share the same promise.
	*/
	async withStampedeProtection(key, operation) {
		const existing = this.inFlight.get(key);
		if (existing) return existing;
		const promise = operation();
		this.inFlight.set(key, promise);
		try {
			return await promise;
		} finally {
			this.inFlight.delete(key);
		}
	}
	/**
	* Get a value from the cache.
	* Checks memory first, then disk (promoting to memory on hit).
	*/
	async get(key) {
		this.assertOpen();
		const prefixedKey = this.prefixKey(key);
		const memSerialized = this.memory.get(prefixedKey);
		if (memSerialized !== null) {
			this.hits++;
			this.debouncedFileTouch(prefixedKey);
			return JSON.parse(memSerialized);
		}
		const diskEntry = await this.files.get(prefixedKey);
		if (diskEntry !== null) {
			this.hits++;
			const serialized = JSON.stringify(diskEntry.value);
			if (Buffer.byteLength(serialized, "utf8") <= this.maxMemorySize) this.memory.set(prefixedKey, serialized, diskEntry.expiresAt);
			return diskEntry.value;
		}
		this.misses++;
		return null;
	}
	/**
	* Set a value in the cache.
	* @param key The cache key
	* @param value The value to store (must be JSON-serializable)
	* @param ttl Optional TTL in seconds (0 to explicitly disable defaultTtl)
	*/
	async set(key, value, ttl) {
		this.assertOpen();
		const prefixedKey = this.prefixKey(key);
		const resolvedTtl = this.resolveTtl(ttl);
		const expiresAt = resolvedTtl ? Date.now() + resolvedTtl : null;
		const valueSerialized = JSON.stringify(value);
		if (valueSerialized === void 0) throw new TypeError(`Cannot cache value of type ${typeof value}. Value must be JSON-serializable.`);
		const valueSize = Buffer.byteLength(valueSerialized, "utf8");
		const entrySerialized = `{"key":${JSON.stringify(prefixedKey)},"value":${valueSerialized},"expiresAt":${expiresAt}}`;
		await this.files.set(prefixedKey, value, expiresAt, entrySerialized);
		if (valueSize <= this.maxMemorySize) this.memory.set(prefixedKey, valueSerialized, expiresAt);
	}
	/**
	* Delete a key from the cache.
	*/
	async del(key) {
		this.assertOpen();
		const prefixedKey = this.prefixKey(key);
		this.cancelDebouncedTouch(prefixedKey);
		const memDeleted = this.memory.delete(prefixedKey);
		const diskDeleted = await this.files.delete(prefixedKey);
		return memDeleted || diskDeleted;
	}
	/**
	* Check if a key exists in the cache.
	*/
	async exists(key) {
		this.assertOpen();
		const prefixedKey = this.prefixKey(key);
		return this.memory.has(prefixedKey) || await this.files.has(prefixedKey);
	}
	/**
	* Get all keys matching a pattern.
	* @param pattern Glob-like pattern (supports * wildcard)
	*/
	async keys(pattern = "*") {
		this.assertOpen();
		const prefixedPattern = this.prefixKey(pattern);
		const [memKeys, diskKeys] = await Promise.all([Promise.resolve(this.memory.keys(prefixedPattern)), this.files.keys(prefixedPattern)]);
		return [...new Set([...memKeys, ...diskKeys])].map((k) => this.unprefixKey(k));
	}
	/**
	* Set expiration time in seconds.
	*/
	async expire(key, seconds) {
		this.assertOpen();
		const prefixedKey = this.prefixKey(key);
		const expiresAt = Date.now() + seconds * 1e3;
		if (!await this.files.setExpiry(prefixedKey, expiresAt)) return false;
		this.memory.setExpiry(prefixedKey, expiresAt);
		return true;
	}
	/**
	* Remove the TTL from a key, making it persistent.
	* @returns true if TTL was removed, false if key doesn't exist
	*/
	async persist(key) {
		this.assertOpen();
		const prefixedKey = this.prefixKey(key);
		if (!await this.files.setExpiry(prefixedKey, null)) return false;
		this.memory.setExpiry(prefixedKey, null);
		return true;
	}
	/**
	* Touch a key: refresh its position in the LRU.
	* This is more efficient than get() when you don't need the value.
	* To update TTL, use expire() or pexpire() instead.
	* @param key The cache key
	* @returns true if key exists, false otherwise
	*/
	async touch(key) {
		this.assertOpen();
		const prefixedKey = this.prefixKey(key);
		if (!await this.files.touch(prefixedKey)) return false;
		this.memory.touch(prefixedKey);
		return true;
	}
	/**
	* Get TTL in seconds.
	* Returns -1 if no expiry, -2 if key not found.
	*/
	async ttl(key) {
		this.assertOpen();
		const prefixedKey = this.prefixKey(key);
		const memTtlMs = this.memory.getTtl(prefixedKey);
		if (memTtlMs !== -2) return memTtlMs < 0 ? memTtlMs : Math.ceil(memTtlMs / 1e3);
		const fileTtlMs = await this.files.getTtl(prefixedKey);
		return fileTtlMs < 0 ? fileTtlMs : Math.ceil(fileTtlMs / 1e3);
	}
	/**
	* Get multiple values at once.
	* Returns array in same order as keys (null for missing/expired).
	*/
	async mget(keys) {
		return Promise.all(keys.map((key) => this.get(key)));
	}
	/**
	* Set multiple key-value pairs at once.
	* Optimized to batch serialization and disk writes.
	* @param entries Array of [key, value] or [key, value, ttl?] tuples (ttl in seconds)
	*/
	async mset(entries) {
		this.assertOpen();
		if (entries.length === 0) return;
		const prepared = entries.map(([key, value, ttl]) => {
			const prefixedKey = this.prefixKey(key);
			const resolvedTtl = this.resolveTtl(ttl);
			const expiresAt = resolvedTtl ? Date.now() + resolvedTtl : null;
			const valueSerialized = JSON.stringify(value);
			if (valueSerialized === void 0) throw new TypeError(`Cannot cache value of type ${typeof value} for key "${key}". Value must be JSON-serializable.`);
			return {
				prefixedKey,
				value,
				expiresAt,
				valueSerialized,
				valueSize: Buffer.byteLength(valueSerialized, "utf8"),
				entrySerialized: `{"key":${JSON.stringify(prefixedKey)},"value":${valueSerialized},"expiresAt":${expiresAt}}`
			};
		});
		await Promise.all(prepared.map((p) => this.files.set(p.prefixedKey, p.value, p.expiresAt, p.entrySerialized)));
		for (const p of prepared) if (p.valueSize <= this.maxMemorySize) this.memory.set(p.prefixedKey, p.valueSerialized, p.expiresAt);
	}
	/**
	* Get a value, or compute and set it if it doesn't exist (cache-aside pattern).
	* Includes stampede protection - concurrent calls for the same key
	* will wait for the first call to complete.
	*
	* @param key The cache key
	* @param fn Function that computes the value to cache (can be async)
	* @param ttl Optional TTL in seconds
	*/
	async getOrSet(key, fn, ttl) {
		this.assertOpen();
		const prefixedKey = this.prefixKey(key);
		const cached = await this.get(key);
		if (cached !== null) return cached;
		return this.withStampedeProtection(prefixedKey, async () => {
			const recheck = await this.get(key);
			if (recheck !== null) return recheck;
			const value = await fn();
			await this.set(key, value, ttl);
			return value;
		});
	}
	/**
	* Get the total number of items in the cache.
	* This is the count of items on disk (source of truth).
	*/
	async size() {
		this.assertOpen();
		return this.files.getItemCount();
	}
	/**
	* Remove all expired entries from the cache.
	* This is called automatically if pruneInterval is configured.
	* @returns Number of entries removed
	*/
	async prune() {
		this.assertOpen();
		this.memory.prune();
		return this.files.prune();
	}
	/**
	* Get cache statistics.
	*/
	async stats() {
		this.assertOpen();
		const memStats = this.memory.stats;
		const [diskSize, diskItemCount] = await Promise.all([this.files.getSize(), this.files.getItemCount()]);
		const total = this.hits + this.misses;
		return {
			hits: this.hits,
			misses: this.misses,
			hitRate: total > 0 ? this.hits / total : 0,
			memory: {
				items: memStats.items,
				size: memStats.size,
				maxItems: memStats.maxItems,
				maxSize: memStats.maxSize
			},
			disk: {
				items: diskItemCount,
				size: diskSize
			}
		};
	}
	/**
	* Reset hit/miss counters.
	*/
	resetStats() {
		this.hits = 0;
		this.misses = 0;
	}
	/**
	* Clear all entries from the cache.
	*/
	async clear() {
		this.assertOpen();
		for (const timer of this.touchTimers.values()) clearTimeout(timer);
		this.touchTimers.clear();
		this.memory.clear();
		await this.files.clear();
	}
	/**
	* Close the cache.
	* After closing, all operations will throw.
	*/
	async close() {
		if (this.pruneTimer) {
			clearInterval(this.pruneTimer);
			this.pruneTimer = void 0;
		}
		for (const timer of this.touchTimers.values()) clearTimeout(timer);
		this.touchTimers.clear();
		this.closed = true;
		this.inFlight.clear();
	}
};

//#endregion
exports.DEFAULT_OPTIONS = DEFAULT_OPTIONS;
exports.FsLruCache = FsLruCache;
//# sourceMappingURL=index.cjs.map