// frontend/src/chunkBuffer.ts — Tier-1 persistent chunk-upload buffer
// (IndexedDB). The recorder writes every produced chunk to a durable `pending`
// store BEFORE the live upload, deletes it only on a confirmed 2xx, and a
// background drainer (useProctorRecorder.ts) re-uploads anything the live path
// left behind — so a network outage longer than the in-line ~67s retry window
// (chunkUploadRetry.ts) no longer silently drops a chunk.
//
// GOVERNING PRINCIPLE (chunk-buffering-tier1-build-plan.md): buffering is
// STRICTLY ADDITIVE over the direct-upload → bounded-retry → drop-with-marker
// floor. EVERY method here is defensively wrapped so a throw (IDB unavailable,
// private mode, quota exceeded, transaction abort, disk full) is surfaced as a
// rejected promise the recorder's circuit-breaker catches → it latches the
// session to FALLBACK mode and routes through the unchanged floor path. Nothing
// in here may ever let an IndexedDB failure crash or stall recording.
//
// TESTABILITY: mirrors chunkContinuity.ts — the IndexedDB surface is INJECTED
// (an `IDBFactoryLike`), so vitest covers put/listOldest/delete/count/bytes/
// evict/clear/selfTest against a tiny in-memory fake with NO real browser and
// NO jsdom (the suite runs in pure node). Production passes window.indexedDB.

// ---- Record schema (design §1) ---------------------------------------------

export type ChunkBufferKind = "screen" | "camera";

/** One pending (not-yet-confirmed-uploaded) chunk. A record lives here until a
 *  2xx PUT proves it is in GCS — the durability invariant. */
export type PendingChunk = {
  /** `${sessionId}::${kind}::${index}` — unique, stable primary key. */
  key: string;
  sessionId: string;
  kind: ChunkBufferKind;
  index: number;
  /** The chunk bytes (IndexedDB stores Blob natively, off the JS heap). */
  blob: Blob;
  /** blob.size, denormalized for fast cap math without reading every blob. */
  bytes: number;
  contentType: string;
  /** Original chunk START iso (the manifest item needs it for playback order). */
  startedAt: string;
  /** First time this chunk entered the buffer (drain order + eviction order). */
  enqueuedAt: number;
  /** Re-drain attempt count (telemetry + per-chunk backoff). */
  attempts: number;
  /** Last failure string (telemetry). */
  lastError?: string;
  /** A previously-issued signed PUT (idempotent re-PUT target; design §0/§2):
   *  the manifest is the ordering source of truth, so re-PUT to THIS exact URL
   *  when unexpired (same GCS key, same bytes), else re-mint via getUploadUrl. */
  storageKey?: string;
  uploadUrl?: string;
  urlExpiresAt?: number;
};

export const CHUNK_BUFFER_DB_NAME = "proctor-chunk-buffer";
export const CHUNK_BUFFER_STORE = "pending";
const DB_VERSION = 1;
const IDX_BY_SESSION = "by_session";
const IDX_BY_SESSION_ENQUEUED = "by_session_enqueued";

export function pendingKey(sessionId: string, kind: ChunkBufferKind, index: number): string {
  return `${sessionId}::${kind}::${index}`;
}

// ---- Injectable IndexedDB surface (minimal, what we actually use) ----------
//
// We model only the slice of the IndexedDB API the buffer needs. window.indexedDB
// satisfies IDBFactoryLike directly; the vitest fake implements the same shape in
// memory. Keeping this narrow means the fake stays small and the production path
// is a thin, obviously-correct adapter (no behavior in the adapter, just await).

export type IDBFactoryLike = {
  open(name: string, version?: number): IDBOpenDBRequestLike;
};

export type IDBOpenDBRequestLike = {
  result: IDBDatabaseLike;
  error: unknown;
  onsuccess: ((this: unknown, ev: unknown) => void) | null;
  onerror: ((this: unknown, ev: unknown) => void) | null;
  onupgradeneeded: ((this: unknown, ev: unknown) => void) | null;
  onblocked?: ((this: unknown, ev: unknown) => void) | null;
};

export type IDBDatabaseLike = {
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string, options?: { keyPath?: string }): IDBObjectStoreLike;
  transaction(storeNames: string | string[], mode?: "readonly" | "readwrite"): IDBTransactionLike;
  close(): void;
};

export type IDBTransactionLike = {
  objectStore(name: string): IDBObjectStoreLike;
  oncomplete: ((this: unknown, ev: unknown) => void) | null;
  onerror: ((this: unknown, ev: unknown) => void) | null;
  onabort: ((this: unknown, ev: unknown) => void) | null;
  error: unknown;
  abort(): void;
};

export type IDBRequestLike<T = unknown> = {
  result: T;
  error: unknown;
  onsuccess: ((this: unknown, ev: unknown) => void) | null;
  onerror: ((this: unknown, ev: unknown) => void) | null;
};

export type IDBIndexLike = {
  openCursor(range?: unknown, direction?: "next" | "prev"): IDBRequestLike<IDBCursorLike | null>;
  getAll(range?: unknown): IDBRequestLike<unknown[]>;
  count(range?: unknown): IDBRequestLike<number>;
};

export type IDBObjectStoreLike = {
  put(value: unknown): IDBRequestLike;
  delete(key: string): IDBRequestLike;
  get(key: string): IDBRequestLike<unknown>;
  index(name: string): IDBIndexLike;
  createIndex(name: string, keyPath: string | string[], options?: { unique?: boolean }): unknown;
};

export type IDBCursorLike = {
  value: unknown;
  continue(): void;
};

/** A "key range" factory — IDBKeyRange in the browser, a tiny shim in tests.
 *  Only `only` and `bound` are used (single-session lookups + the composite
 *  [sessionId, enqueuedAt] ordered scan). */
export type IDBKeyRangeLike = {
  only(value: unknown): unknown;
  bound(lower: unknown, upper: unknown, lowerOpen?: boolean, upperOpen?: boolean): unknown;
};

export type ChunkBufferDeps = {
  indexedDB: IDBFactoryLike;
  keyRange: IDBKeyRangeLike;
};

/** Resolve the real browser deps, or null when IndexedDB is unavailable
 *  (server render, private-mode block, ancient browser). A null here means the
 *  recorder starts in FALLBACK mode — never a thrown error at module load. */
export function browserChunkBufferDeps(): ChunkBufferDeps | null {
  try {
    const idb = (globalThis as { indexedDB?: IDBFactoryLike }).indexedDB;
    const range = (globalThis as { IDBKeyRange?: IDBKeyRangeLike }).IDBKeyRange;
    if (!idb || !range) return null;
    return { indexedDB: idb, keyRange: range };
  } catch {
    return null;
  }
}

// ---- Promise adapters over the request/transaction event model -------------

function promisifyRequest<T>(request: IDBRequestLike<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("idb_request_failed"));
  });
}

function promisifyTxn(txn: IDBTransactionLike): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    txn.oncomplete = () => resolve();
    txn.onerror = () => reject(txn.error ?? new Error("idb_txn_error"));
    txn.onabort = () => reject(txn.error ?? new Error("idb_txn_abort"));
  });
}

// ---- The buffer handle ------------------------------------------------------

/** A live, opened buffer. Every method is async + may reject; the recorder's
 *  circuit-breaker wraps each call. The handle owns one IDBDatabase connection. */
export type ChunkBuffer = {
  selfTest(): Promise<boolean>;
  put(record: PendingChunk): Promise<void>;
  /** The N oldest pending chunks for a session, ascending by enqueuedAt then
   *  index — the drain order (oldest-first) AND the eviction order. */
  listOldest(sessionId: string, n: number): Promise<PendingChunk[]>;
  delete(key: string): Promise<void>;
  count(sessionId: string): Promise<number>;
  bytes(sessionId: string): Promise<number>;
  /** Evict (delete) the single oldest pending chunk for the session; returns
   *  the evicted record (for the loud chunk_buffer_evicted audit) or null when
   *  the session's buffer is already empty. */
  evictOldest(sessionId: string): Promise<PendingChunk | null>;
  clear(sessionId: string): Promise<void>;
  close(): void;
};

/** Open (and lazily upgrade) the buffer DB. Rejects on any open/upgrade error
 *  so the caller can fall back. Never throws synchronously. */
export async function openBuffer(deps: ChunkBufferDeps): Promise<ChunkBuffer> {
  const db = await openDatabase(deps.indexedDB);
  const { keyRange } = deps;

  const sessionRange = (sessionId: string) =>
    keyRange.bound([sessionId, -Infinity], [sessionId, Infinity]);

  const withStore = async <T>(
    mode: "readonly" | "readwrite",
    run: (store: IDBObjectStoreLike) => Promise<T>
  ): Promise<T> => {
    const txn = db.transaction(CHUNK_BUFFER_STORE, mode);
    const store = txn.objectStore(CHUNK_BUFFER_STORE);
    // Run the request(s) and the txn completion together: a quota/abort failure
    // rejects whichever settles first, so the caller always sees the error.
    const work = run(store);
    const done = promisifyTxn(txn);
    const [value] = await Promise.all([work, done]);
    return value;
  };

  const buffer: ChunkBuffer = {
    async selfTest() {
      // Write → read → delete a tiny blob under a throwaway key. ANY failure
      // (quota, abort, disabled store) resolves false — the gate then starts the
      // session in fallback mode. Never throws.
      const probeKey = pendingKey("__selftest__", "screen", Date.now());
      try {
        const probe: PendingChunk = {
          key: probeKey,
          sessionId: "__selftest__",
          kind: "screen",
          index: 0,
          blob: makeProbeBlob(),
          bytes: 1,
          contentType: "application/octet-stream",
          startedAt: new Date().toISOString(),
          enqueuedAt: Date.now(),
          attempts: 0
        };
        await withStore("readwrite", async (store) => {
          await promisifyRequest(store.put(probe));
        });
        const read = await withStore("readonly", (store) =>
          promisifyRequest<unknown>(store.get(probeKey))
        );
        await withStore("readwrite", async (store) => {
          await promisifyRequest(store.delete(probeKey));
        });
        return Boolean(read);
      } catch {
        // Best-effort cleanup so a half-written probe never lingers.
        try {
          await withStore("readwrite", async (store) => {
            await promisifyRequest(store.delete(probeKey));
          });
        } catch {
          /* ignore */
        }
        return false;
      }
    },

    async put(record) {
      await withStore("readwrite", async (store) => {
        await promisifyRequest(store.put(normalizeRecord(record)));
      });
    },

    async listOldest(sessionId, n) {
      if (!Number.isFinite(n) || n <= 0) return [];
      const rows = await withStore("readonly", (store) =>
        promisifyRequest<unknown[]>(store.index(IDX_BY_SESSION_ENQUEUED).getAll(sessionRange(sessionId)))
      );
      return (rows as PendingChunk[])
        .filter(isPendingChunk)
        .sort(byOldest)
        .slice(0, Math.floor(n));
    },

    async delete(key) {
      await withStore("readwrite", async (store) => {
        await promisifyRequest(store.delete(key));
      });
    },

    async count(sessionId) {
      return withStore("readonly", (store) =>
        promisifyRequest<number>(store.index(IDX_BY_SESSION).count(keyRange.only(sessionId)))
      );
    },

    async bytes(sessionId) {
      const rows = await withStore("readonly", (store) =>
        promisifyRequest<unknown[]>(store.index(IDX_BY_SESSION).getAll(keyRange.only(sessionId)))
      );
      return (rows as PendingChunk[])
        .filter(isPendingChunk)
        .reduce((sum, row) => sum + (Number.isFinite(row.bytes) ? row.bytes : 0), 0);
    },

    async evictOldest(sessionId) {
      const [oldest] = await buffer.listOldest(sessionId, 1);
      if (!oldest) return null;
      await buffer.delete(oldest.key);
      return oldest;
    },

    async clear(sessionId) {
      const rows = await withStore("readonly", (store) =>
        promisifyRequest<unknown[]>(store.index(IDX_BY_SESSION).getAll(keyRange.only(sessionId)))
      );
      const keys = (rows as PendingChunk[]).filter(isPendingChunk).map((row) => row.key);
      if (!keys.length) return;
      await withStore("readwrite", async (store) => {
        for (const key of keys) {
          await promisifyRequest(store.delete(key));
        }
      });
    },

    close() {
      try {
        db.close();
      } catch {
        /* best-effort */
      }
    }
  };

  return buffer;
}

/** Standalone end-of-session cleanup (host side, mirrors clearChunkContinuity):
 *  open → clear(sessionId) → close, independent of any live recorder handle.
 *  Best-effort and NEVER throws — called at the App.tsx end sites ONLY after a
 *  confirmed-empty drain + successful endSession, so a residual record is
 *  already impossible; this just reclaims the store. */
export async function clearChunkBuffer(
  sessionId: string,
  deps: ChunkBufferDeps | null = browserChunkBufferDeps()
): Promise<void> {
  if (!deps) return;
  let buffer: ChunkBuffer | null = null;
  try {
    buffer = await openBuffer(deps);
    await buffer.clear(sessionId);
  } catch {
    // best-effort — the buffer being unavailable means there is nothing to clear
  } finally {
    buffer?.close();
  }
}

function openDatabase(factory: IDBFactoryLike): Promise<IDBDatabaseLike> {
  return new Promise<IDBDatabaseLike>((resolve, reject) => {
    let request: IDBOpenDBRequestLike;
    try {
      request = factory.open(CHUNK_BUFFER_DB_NAME, DB_VERSION);
    } catch (error) {
      reject(error ?? new Error("idb_open_threw"));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CHUNK_BUFFER_STORE)) {
        const store = db.createObjectStore(CHUNK_BUFFER_STORE, { keyPath: "key" });
        store.createIndex(IDX_BY_SESSION, "sessionId", { unique: false });
        store.createIndex(IDX_BY_SESSION_ENQUEUED, ["sessionId", "enqueuedAt"], { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("idb_open_failed"));
    if ("onblocked" in request) {
      request.onblocked = () => reject(new Error("idb_open_blocked"));
    }
  });
}

// ---- Pure helpers (vitest-covered directly) --------------------------------

/** Order: oldest enqueuedAt first; ties broken by lower index then key — a
 *  TOTAL order so drain + eviction are deterministic across reloads. */
export function byOldest(a: PendingChunk, b: PendingChunk): number {
  if (a.enqueuedAt !== b.enqueuedAt) return a.enqueuedAt - b.enqueuedAt;
  if (a.index !== b.index) return a.index - b.index;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

export function isPendingChunk(value: unknown): value is PendingChunk {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<PendingChunk>;
  return (
    typeof v.key === "string" &&
    typeof v.sessionId === "string" &&
    (v.kind === "screen" || v.kind === "camera") &&
    Number.isFinite(v.index) &&
    Number.isFinite(v.bytes)
  );
}

/** Normalize a record before persisting: clamp the numeric fields and default
 *  attempts so a malformed caller value can never poison the ordered scan. */
function normalizeRecord(record: PendingChunk): PendingChunk {
  return {
    ...record,
    index: Math.max(0, Math.floor(Number(record.index) || 0)),
    bytes: Math.max(0, Math.floor(Number(record.bytes) || 0)),
    enqueuedAt: Number.isFinite(record.enqueuedAt) ? record.enqueuedAt : Date.now(),
    attempts: Math.max(0, Math.floor(Number(record.attempts) || 0))
  };
}

// A 1-byte blob for the self-test. Blob exists in the browser; in node tests the
// fake provides its own probe value, but selfTest there exercises the real path
// against the fake store, so we guard the constructor.
function makeProbeBlob(): Blob {
  try {
    return new Blob([new Uint8Array([1])], { type: "application/octet-stream" });
  } catch {
    // Node without Blob — return a minimal stand-in the fake store accepts.
    return { size: 1, type: "application/octet-stream" } as unknown as Blob;
  }
}

// ---- Cap / evict policy (pure decision logic) ------------------------------

export const DEFAULT_MAX_BUFFER_BYTES = 200 * 1024 * 1024; // 200 MB
export const DEFAULT_MAX_BUFFER_COUNT = 400;

export type BufferCaps = {
  maxBytes: number;
  maxCount: number;
};

/** Resolve the server-tunable caps from upload_config, defaulting to the
 *  weak-lab-PC values when absent/garbage (never 0 — a 0 cap would evict every
 *  chunk instantly, defeating the buffer). */
export function resolveBufferCaps(config?: {
  buffer_max_bytes?: number;
  buffer_max_chunks?: number;
}): BufferCaps {
  const maxBytes = positiveIntOr(config?.buffer_max_bytes, DEFAULT_MAX_BUFFER_BYTES);
  const maxCount = positiveIntOr(config?.buffer_max_chunks, DEFAULT_MAX_BUFFER_COUNT);
  return { maxBytes, maxCount };
}

function positiveIntOr(raw: unknown, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export type OverCapReason = "over_byte_cap" | "over_count_cap" | null;

/** Is the buffer over cap, and which limit tripped first? Bytes is reported
 *  first when BOTH trip (the more evidentially-meaningful limit). null = under
 *  cap, nothing to evict. */
export function overCapReason(currentBytes: number, currentCount: number, caps: BufferCaps): OverCapReason {
  if (currentBytes > caps.maxBytes) return "over_byte_cap";
  if (currentCount > caps.maxCount) return "over_count_cap";
  return null;
}

// ---- Pure drain + evict orchestration (injectable, vitest-covered directly) -
//
// The recorder delegates its drainer + cap-eviction to these so the ALGORITHM
// (oldest-first, fatal-stop, evict-oldest-on-over-cap) is unit-tested without a
// browser/MediaRecorder. The recorder supplies the side-effecting callbacks
// (the actual upload, the audit emits); these helpers own only the control flow.

export type DrainOutcome = "ok" | "retry" | "fatal";

/** Evict the OLDEST pending chunk while the session is over EITHER cap. Emits
 *  via onEvict (kind/index/bytes/reason) for the loud chunk_buffer_evicted
 *  audit. Returns the number evicted. Throws are the caller's (circuit-breaker)
 *  job — they propagate so a buffer failure degrades to fallback. */
export async function evictToCapacity(
  buffer: Pick<ChunkBuffer, "count" | "bytes" | "evictOldest">,
  sessionId: string,
  caps: BufferCaps,
  onEvict: (evicted: PendingChunk, reason: Exclude<OverCapReason, null>) => void
): Promise<number> {
  let evicted = 0;
  for (let guard = 0; guard < 100_000; guard += 1) {
    const [count, bytes] = await Promise.all([buffer.count(sessionId), buffer.bytes(sessionId)]);
    const reason = overCapReason(bytes, count, caps);
    if (!reason) break;
    const record = await buffer.evictOldest(sessionId);
    if (!record) break;
    onEvict(record, reason);
    evicted += 1;
  }
  return evicted;
}

/** Drain a session's buffer OLDEST-FIRST. For each record `uploadOne` returns
 *  "ok" (uploaded — already deleted by the caller), "retry" (left in pending),
 *  or "fatal" (stop draining immediately — session no longer writable). Loops
 *  in oldest-first batches until a pass makes no progress or the buffer empties.
 *  `shouldContinue` lets the recorder abort on a mode flip / dispose. Returns
 *  the number drained. Throws propagate (circuit-breaker → fallback). */
export async function drainBuffer(
  buffer: Pick<ChunkBuffer, "listOldest">,
  sessionId: string,
  uploadOne: (record: PendingChunk) => Promise<DrainOutcome>,
  shouldContinue: () => boolean = () => true,
  batchSize = 5
): Promise<number> {
  let drained = 0;
  let madeProgress = true;
  while (madeProgress && shouldContinue()) {
    madeProgress = false;
    const batch = await buffer.listOldest(sessionId, batchSize);
    if (!batch.length) break;
    for (const record of batch) {
      if (!shouldContinue()) return drained;
      const outcome = await uploadOne(record);
      if (outcome === "fatal") return drained;
      if (outcome === "ok") {
        drained += 1;
        madeProgress = true;
      }
      // "retry" → leave it; the next wake handles it.
    }
  }
  return drained;
}
