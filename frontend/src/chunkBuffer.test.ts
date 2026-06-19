// frontend/src/chunkBuffer.test.ts — full coverage of the Tier-1 persistent
// chunk buffer against an in-memory fake IndexedDB (NO real browser, NO jsdom;
// the suite runs in pure node — same injectable style as chunkContinuity.test.ts).
//
// The fake faithfully drives IndexedDB's request/transaction EVENT model
// (onsuccess/onerror/oncomplete/onabort fired on a microtask) so the production
// promise adapters in chunkBuffer.ts are exercised exactly as in the browser —
// including the failure paths (open failure, quota-exceeded put, txn abort) the
// circuit-breaker depends on.
import { beforeEach, describe, expect, it } from "vitest";
import {
  byOldest,
  drainBuffer,
  evictToCapacity,
  isPendingChunk,
  openBuffer,
  overCapReason,
  pendingKey,
  resolveBufferCaps,
  DEFAULT_MAX_BUFFER_BYTES,
  DEFAULT_MAX_BUFFER_COUNT,
  type ChunkBufferDeps,
  type DrainOutcome,
  type IDBCursorLike,
  type IDBDatabaseLike,
  type IDBFactoryLike,
  type IDBIndexLike,
  type IDBKeyRangeLike,
  type IDBObjectStoreLike,
  type IDBOpenDBRequestLike,
  type IDBRequestLike,
  type IDBTransactionLike,
  type PendingChunk
} from "./chunkBuffer";

// ---- A tiny in-memory fake IndexedDB --------------------------------------
//
// Models only the slice chunkBuffer.ts uses. A flag lets a test arm a failure
// (open error, put quota error, txn abort) so the buffer's reject paths run.

type FakeRange =
  | { only: unknown }
  | { lower: unknown; upper: unknown };

const fakeKeyRange: IDBKeyRangeLike = {
  only: (value) => ({ only: value }),
  bound: (lower, upper) => ({ lower, upper })
};

type FailMode = "none" | "open" | "put" | "abort";

class FakeStore implements IDBObjectStoreLike {
  constructor(
    private readonly rows: Map<string, PendingChunk>,
    private readonly txn: FakeTransaction
  ) {}

  put(value: unknown): IDBRequestLike {
    const req = makeRequest();
    queueMicrotask(() => {
      if (this.txn.failMode === "put") {
        req.error = domError("QuotaExceededError", "The quota has been exceeded.");
        this.txn.fail(req.error);
        req.onerror?.call(req, {});
        return;
      }
      const record = value as PendingChunk;
      this.rows.set(record.key, record);
      req.result = record.key as unknown;
      req.onsuccess?.call(req, {});
    });
    return req;
  }

  delete(key: string): IDBRequestLike {
    const req = makeRequest();
    queueMicrotask(() => {
      this.rows.delete(key);
      req.onsuccess?.call(req, {});
    });
    return req;
  }

  get(key: string): IDBRequestLike<unknown> {
    const req = makeRequest();
    queueMicrotask(() => {
      req.result = this.rows.get(key) ?? undefined;
      req.onsuccess?.call(req, {});
    });
    return req;
  }

  index(_name: string): IDBIndexLike {
    return new FakeIndex(this.rows);
  }

  createIndex(): unknown {
    return {};
  }
}

class FakeIndex implements IDBIndexLike {
  constructor(private readonly rows: Map<string, PendingChunk>) {}

  private match(range?: unknown): PendingChunk[] {
    const all = [...this.rows.values()];
    if (!range) return all;
    const r = range as FakeRange;
    if ("only" in r) {
      return all.filter((row) => row.sessionId === r.only);
    }
    // bound([sessionId, -Inf], [sessionId, +Inf]) — the composite-index scan.
    const lower = r.lower as [string, number];
    return all.filter((row) => row.sessionId === lower[0]);
  }

  getAll(range?: unknown): IDBRequestLike<unknown[]> {
    const req = makeRequest<unknown[]>();
    queueMicrotask(() => {
      req.result = this.match(range);
      req.onsuccess?.call(req, {});
    });
    return req;
  }

  count(range?: unknown): IDBRequestLike<number> {
    const req = makeRequest<number>();
    queueMicrotask(() => {
      req.result = this.match(range).length;
      req.onsuccess?.call(req, {});
    });
    return req;
  }

  openCursor(): IDBRequestLike<IDBCursorLike | null> {
    const req = makeRequest<IDBCursorLike | null>();
    queueMicrotask(() => {
      req.result = null;
      req.onsuccess?.call(req, {});
    });
    return req;
  }
}

class FakeTransaction implements IDBTransactionLike {
  oncomplete: ((this: unknown, ev: unknown) => void) | null = null;
  onerror: ((this: unknown, ev: unknown) => void) | null = null;
  onabort: ((this: unknown, ev: unknown) => void) | null = null;
  error: unknown = null;
  private settled = false;

  constructor(
    private readonly rows: Map<string, PendingChunk>,
    public failMode: FailMode
  ) {
    // Complete on a LATER microtask than the request callbacks (real IDB:
    // oncomplete fires after the last request's onsuccess), unless a request
    // already aborted us.
    queueMicrotask(() => {
      queueMicrotask(() => {
        if (this.settled) return;
        if (this.failMode === "abort") {
          this.error = domError("AbortError", "Transaction aborted.");
          this.settled = true;
          this.onabort?.call(this, {});
          return;
        }
        this.settled = true;
        this.oncomplete?.call(this, {});
      });
    });
  }

  objectStore(_name: string): IDBObjectStoreLike {
    return new FakeStore(this.rows, this);
  }

  fail(error: unknown): void {
    if (this.settled) return;
    this.error = error;
    this.settled = true;
    queueMicrotask(() => this.onabort?.call(this, {}));
  }

  abort(): void {
    this.fail(domError("AbortError", "Transaction aborted."));
  }
}

class FakeDatabase implements IDBDatabaseLike {
  objectStoreNames = { contains: () => true };
  constructor(
    private readonly rows: Map<string, PendingChunk>,
    private readonly failModeRef: { mode: FailMode }
  ) {}
  createObjectStore(): IDBObjectStoreLike {
    return new FakeStore(this.rows, new FakeTransaction(this.rows, "none"));
  }
  transaction(): IDBTransactionLike {
    return new FakeTransaction(this.rows, this.failModeRef.mode);
  }
  close(): void {
    /* no-op */
  }
}

function makeFactory(failModeRef: { mode: FailMode }): IDBFactoryLike {
  const rows = new Map<string, PendingChunk>();
  return {
    open(_name: string, _version?: number): IDBOpenDBRequestLike {
      const req: IDBOpenDBRequestLike = {
        result: undefined as unknown as IDBDatabaseLike,
        error: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
        onblocked: null
      };
      queueMicrotask(() => {
        if (failModeRef.mode === "open") {
          req.error = domError("InvalidStateError", "IndexedDB is disabled.");
          req.onerror?.call(req, {});
          return;
        }
        const db = new FakeDatabase(rows, failModeRef);
        req.result = db;
        req.onupgradeneeded?.call(req, {});
        req.onsuccess?.call(req, {});
      });
      return req;
    }
  };
}

function makeRequest<T = unknown>(): IDBRequestLike<T> {
  return { result: undefined as unknown as T, error: null, onsuccess: null, onerror: null };
}

function domError(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

function blob(size: number): Blob {
  // node has Blob globally (vitest 4 / node 18+); fall back to a stand-in.
  try {
    return new Blob([new Uint8Array(size)], { type: "video/webm" });
  } catch {
    return { size, type: "video/webm" } as unknown as Blob;
  }
}

function chunk(
  sessionId: string,
  kind: "screen" | "camera",
  index: number,
  overrides: Partial<PendingChunk> = {}
): PendingChunk {
  return {
    key: pendingKey(sessionId, kind, index),
    sessionId,
    kind,
    index,
    blob: blob(overrides.bytes ?? 1000),
    bytes: overrides.bytes ?? 1000,
    contentType: "video/webm",
    startedAt: "2026-06-19T09:00:00.000Z",
    enqueuedAt: overrides.enqueuedAt ?? index,
    attempts: 0,
    ...overrides
  };
}

function makeDeps(mode: FailMode = "none"): { deps: ChunkBufferDeps; ref: { mode: FailMode } } {
  const ref = { mode };
  return { deps: { indexedDB: makeFactory(ref), keyRange: fakeKeyRange }, ref };
}

// ---- Tests ----------------------------------------------------------------

describe("pendingKey", () => {
  it("is a stable, unique, sortable composite", () => {
    expect(pendingKey("s1", "screen", 7)).toBe("s1::screen::7");
    expect(pendingKey("s1", "camera", 7)).toBe("s1::camera::7");
  });
});

describe("byOldest ordering", () => {
  it("orders by enqueuedAt, then index, then key (total order)", () => {
    const a = chunk("s1", "screen", 2, { enqueuedAt: 100 });
    const b = chunk("s1", "screen", 1, { enqueuedAt: 100 }); // same time, lower index first
    const c = chunk("s1", "screen", 3, { enqueuedAt: 50 }); // earliest time wins
    expect([a, b, c].sort(byOldest).map((r) => r.index)).toEqual([3, 1, 2]);
  });
});

describe("isPendingChunk", () => {
  it("accepts a well-formed record and rejects garbage", () => {
    expect(isPendingChunk(chunk("s1", "screen", 1))).toBe(true);
    expect(isPendingChunk(null)).toBe(false);
    expect(isPendingChunk({ key: "x" })).toBe(false);
    expect(isPendingChunk({ ...chunk("s1", "screen", 1), kind: "bogus" })).toBe(false);
  });
});

describe("openBuffer + CRUD", () => {
  let deps: ChunkBufferDeps;
  beforeEach(() => {
    deps = makeDeps().deps;
  });

  it("put → count → bytes → delete round-trips per session", async () => {
    const buf = await openBuffer(deps);
    await buf.put(chunk("s1", "screen", 1, { bytes: 1000 }));
    await buf.put(chunk("s1", "screen", 2, { bytes: 2000 }));
    await buf.put(chunk("s2", "screen", 1, { bytes: 9999 })); // other session, isolated

    expect(await buf.count("s1")).toBe(2);
    expect(await buf.bytes("s1")).toBe(3000);
    expect(await buf.count("s2")).toBe(1);

    await buf.delete(pendingKey("s1", "screen", 1));
    expect(await buf.count("s1")).toBe(1);
    expect(await buf.bytes("s1")).toBe(2000);
    // s2 untouched.
    expect(await buf.count("s2")).toBe(1);
  });

  it("listOldest returns oldest-first, bounded by n, scoped to the session", async () => {
    const buf = await openBuffer(deps);
    await buf.put(chunk("s1", "screen", 3, { enqueuedAt: 30 }));
    await buf.put(chunk("s1", "screen", 1, { enqueuedAt: 10 }));
    await buf.put(chunk("s1", "camera", 2, { enqueuedAt: 20 }));
    await buf.put(chunk("s2", "screen", 1, { enqueuedAt: 5 })); // other session

    const oldest2 = await buf.listOldest("s1", 2);
    expect(oldest2.map((r) => r.key)).toEqual([
      pendingKey("s1", "screen", 1),
      pendingKey("s1", "camera", 2)
    ]);
    expect(await buf.listOldest("s1", 0)).toEqual([]);
    expect((await buf.listOldest("s1", 99)).length).toBe(3);
  });

  it("evictOldest removes and returns the single oldest; null when empty", async () => {
    const buf = await openBuffer(deps);
    expect(await buf.evictOldest("s1")).toBeNull();
    await buf.put(chunk("s1", "screen", 2, { enqueuedAt: 200 }));
    await buf.put(chunk("s1", "screen", 1, { enqueuedAt: 100 }));
    const evicted = await buf.evictOldest("s1");
    expect(evicted?.key).toBe(pendingKey("s1", "screen", 1));
    expect(await buf.count("s1")).toBe(1);
    expect((await buf.listOldest("s1", 9))[0].key).toBe(pendingKey("s1", "screen", 2));
  });

  it("clear drops only the session's chunks", async () => {
    const buf = await openBuffer(deps);
    await buf.put(chunk("s1", "screen", 1));
    await buf.put(chunk("s1", "camera", 1));
    await buf.put(chunk("s2", "screen", 1));
    await buf.clear("s1");
    expect(await buf.count("s1")).toBe(0);
    expect(await buf.count("s2")).toBe(1);
    // clear on an already-empty session is a no-op, never throws.
    await expect(buf.clear("s1")).resolves.toBeUndefined();
  });

  it("normalizes a put with a re-PUT target (storageKey/uploadUrl preserved)", async () => {
    const buf = await openBuffer(deps);
    await buf.put(
      chunk("s1", "screen", 1, {
        storageKey: "sessions/s1/screen/chunk-00001.webm",
        uploadUrl: "https://signed.example/put",
        urlExpiresAt: 9_999_999_999_999
      })
    );
    const [row] = await buf.listOldest("s1", 1);
    expect(row.storageKey).toBe("sessions/s1/screen/chunk-00001.webm");
    expect(row.uploadUrl).toBe("https://signed.example/put");
  });
});

describe("selfTest (capability gate)", () => {
  it("returns true when write→read→delete works", async () => {
    const buf = await openBuffer(makeDeps().deps);
    expect(await buf.selfTest()).toBe(true);
  });

  it("returns false (never throws) when a put hits quota", async () => {
    const buf = await openBuffer(makeDeps("put").deps);
    await expect(buf.selfTest()).resolves.toBe(false);
  });

  it("returns false when the transaction aborts", async () => {
    const buf = await openBuffer(makeDeps("abort").deps);
    await expect(buf.selfTest()).resolves.toBe(false);
  });

  it("leaves no probe row behind on success", async () => {
    const buf = await openBuffer(makeDeps().deps);
    await buf.selfTest();
    expect(await buf.count("__selftest__")).toBe(0);
  });
});

describe("open failure → circuit-breaker can fall back", () => {
  it("openBuffer rejects (catchable) when IndexedDB.open errors", async () => {
    const { deps } = makeDeps("open");
    await expect(openBuffer(deps)).rejects.toThrow();
  });

  it("a put that hits quota rejects (catchable) so the breaker latches fallback", async () => {
    const buf = await openBuffer(makeDeps("put").deps);
    await expect(buf.put(chunk("s1", "screen", 1))).rejects.toThrow();
  });

  it("a put on an aborting transaction rejects", async () => {
    const buf = await openBuffer(makeDeps("abort").deps);
    await expect(buf.put(chunk("s1", "screen", 1))).rejects.toThrow();
  });
});

describe("resolveBufferCaps", () => {
  it("defaults to the weak-lab-PC caps when config absent", () => {
    expect(resolveBufferCaps()).toEqual({
      maxBytes: DEFAULT_MAX_BUFFER_BYTES,
      maxCount: DEFAULT_MAX_BUFFER_COUNT
    });
  });

  it("honors server-tunable positive overrides", () => {
    expect(resolveBufferCaps({ buffer_max_bytes: 50_000_000, buffer_max_chunks: 100 })).toEqual({
      maxBytes: 50_000_000,
      maxCount: 100
    });
  });

  it("ignores zero/negative/garbage (never a 0 cap that would evict everything)", () => {
    expect(resolveBufferCaps({ buffer_max_bytes: 0, buffer_max_chunks: -5 })).toEqual({
      maxBytes: DEFAULT_MAX_BUFFER_BYTES,
      maxCount: DEFAULT_MAX_BUFFER_COUNT
    });
    expect(resolveBufferCaps({ buffer_max_bytes: NaN as unknown as number })).toEqual({
      maxBytes: DEFAULT_MAX_BUFFER_BYTES,
      maxCount: DEFAULT_MAX_BUFFER_COUNT
    });
  });
});

describe("overCapReason (cap / evict policy)", () => {
  const caps = { maxBytes: 1000, maxCount: 3 };
  it("is null under both caps", () => {
    expect(overCapReason(900, 2, caps)).toBeNull();
  });
  it("reports over_byte_cap when bytes exceed (first, even if count also over)", () => {
    expect(overCapReason(1001, 2, caps)).toBe("over_byte_cap");
    expect(overCapReason(1001, 99, caps)).toBe("over_byte_cap");
  });
  it("reports over_count_cap when only count exceeds", () => {
    expect(overCapReason(500, 4, caps)).toBe("over_count_cap");
  });
});

describe("evictToCapacity (cap → evict OLDEST)", () => {
  it("evicts oldest until UNDER the BYTE cap and emits over_byte_cap", async () => {
    const buf = await openBuffer(makeDeps().deps);
    // 5 chunks × 1000 bytes = 5000; cap 2500 → must evict the 3 oldest.
    for (let i = 1; i <= 5; i += 1) await buf.put(chunk("s1", "screen", i, { bytes: 1000, enqueuedAt: i }));
    const events: Array<{ index: number; reason: string }> = [];
    const n = await evictToCapacity(buf, "s1", { maxBytes: 2500, maxCount: 999 }, (rec, reason) =>
      events.push({ index: rec.index, reason })
    );
    expect(n).toBe(3);
    expect(events.map((e) => e.index)).toEqual([1, 2, 3]); // OLDEST first
    expect(events.every((e) => e.reason === "over_byte_cap")).toBe(true);
    expect(await buf.bytes("s1")).toBe(2000); // chunks 4,5 survive (latest kept)
  });

  it("evicts oldest until UNDER the COUNT cap and emits over_count_cap", async () => {
    const buf = await openBuffer(makeDeps().deps);
    for (let i = 1; i <= 5; i += 1) await buf.put(chunk("s1", "screen", i, { bytes: 10, enqueuedAt: i }));
    const events: Array<{ index: number; reason: string }> = [];
    const n = await evictToCapacity(buf, "s1", { maxBytes: 1_000_000, maxCount: 2 }, (rec, reason) =>
      events.push({ index: rec.index, reason })
    );
    expect(n).toBe(3);
    expect(events.map((e) => e.index)).toEqual([1, 2, 3]);
    expect(events.every((e) => e.reason === "over_count_cap")).toBe(true);
    expect(await buf.count("s1")).toBe(2);
  });

  it("is a no-op under cap", async () => {
    const buf = await openBuffer(makeDeps().deps);
    await buf.put(chunk("s1", "screen", 1, { bytes: 10 }));
    const n = await evictToCapacity(buf, "s1", { maxBytes: 1_000_000, maxCount: 999 }, () => {});
    expect(n).toBe(0);
    expect(await buf.count("s1")).toBe(1);
  });
});

describe("drainBuffer (oldest-first, fatal-stop)", () => {
  it("drains OLDEST-first when every upload succeeds", async () => {
    const buf = await openBuffer(makeDeps().deps);
    await buf.put(chunk("s1", "screen", 3, { enqueuedAt: 30 }));
    await buf.put(chunk("s1", "screen", 1, { enqueuedAt: 10 }));
    await buf.put(chunk("s1", "camera", 2, { enqueuedAt: 20 }));
    const order: number[] = [];
    const uploadOne = async (rec: PendingChunk): Promise<DrainOutcome> => {
      order.push(rec.index);
      await buf.delete(rec.key); // production deletes on confirmed 2xx
      return "ok";
    };
    const drained = await drainBuffer(buf, "s1", uploadOne);
    expect(order).toEqual([1, 2, 3]); // chronological by enqueuedAt
    expect(drained).toBe(3);
    expect(await buf.count("s1")).toBe(0);
  });

  it("STOPS immediately on a fatal status (401/403/409)", async () => {
    const buf = await openBuffer(makeDeps().deps);
    for (let i = 1; i <= 4; i += 1) await buf.put(chunk("s1", "screen", i, { enqueuedAt: i }));
    const seen: number[] = [];
    const uploadOne = async (rec: PendingChunk): Promise<DrainOutcome> => {
      seen.push(rec.index);
      if (rec.index === 2) return "fatal"; // session ended/locked mid-drain
      await buf.delete(rec.key);
      return "ok";
    };
    const drained = await drainBuffer(buf, "s1", uploadOne);
    expect(seen).toEqual([1, 2]); // stopped at the fatal one — never tried 3,4
    expect(drained).toBe(1); // only chunk 1 confirmed
    expect(await buf.count("s1")).toBe(3); // 2,3,4 remain pending
  });

  it("leaves a 'retry' chunk in pending and does not hot-loop forever", async () => {
    const buf = await openBuffer(makeDeps().deps);
    await buf.put(chunk("s1", "screen", 1, { enqueuedAt: 1 }));
    await buf.put(chunk("s1", "screen", 2, { enqueuedAt: 2 }));
    let attempts = 0;
    const uploadOne = async (rec: PendingChunk): Promise<DrainOutcome> => {
      attempts += 1;
      if (rec.index === 1) return "retry"; // persistently failing — stays pending
      await buf.delete(rec.key);
      return "ok";
    };
    const drained = await drainBuffer(buf, "s1", uploadOne);
    // chunk 2 drains; chunk 1 stays. A 2nd pass made progress (chunk 2) then a
    // 3rd pass over only chunk 1 makes NO progress → loop terminates.
    expect(drained).toBe(1);
    expect(await buf.count("s1")).toBe(1);
    expect((await buf.listOldest("s1", 9))[0].index).toBe(1);
    expect(attempts).toBeLessThan(20); // bounded — no hot loop
  });

  it("aborts when shouldContinue() flips false (mode flip / dispose)", async () => {
    const buf = await openBuffer(makeDeps().deps);
    for (let i = 1; i <= 3; i += 1) await buf.put(chunk("s1", "screen", i, { enqueuedAt: i }));
    let healthy = true;
    const seen: number[] = [];
    const uploadOne = async (rec: PendingChunk): Promise<DrainOutcome> => {
      seen.push(rec.index);
      healthy = false; // a buffer error degraded us mid-drain
      await buf.delete(rec.key);
      return "ok";
    };
    const drained = await drainBuffer(buf, "s1", uploadOne, () => healthy);
    expect(seen).toEqual([1]); // stopped after the first because the latch flipped
    expect(drained).toBe(1);
  });
});

describe("buffer.get (drain re-check before re-mint)", () => {
  it("returns the record when present, null when gone", async () => {
    const buf = await openBuffer(makeDeps().deps);
    expect(await buf.get(pendingKey("s1", "screen", 1))).toBeNull();
    await buf.put(chunk("s1", "screen", 1, { bytes: 1234 }));
    const got = await buf.get(pendingKey("s1", "screen", 1));
    expect(got?.key).toBe(pendingKey("s1", "screen", 1));
    expect(got?.bytes).toBe(1234);
    await buf.delete(pendingKey("s1", "screen", 1));
    expect(await buf.get(pendingKey("s1", "screen", 1))).toBeNull();
  });

  // Models the drain doUpload re-check (useProctorRecorder.ts): the drainer's
  // listOldest is a standalone read, so it can pick up a record whose LIVE
  // upload is still in-flight. The live run deletes the key on its 2xx BEFORE
  // the chained drain doUpload runs (shared per-kind serial chain). The fix:
  // doUpload re-checks buffer.get(record.key) first; if GONE → no-op (no
  // getUploadUrl, no upload, no manifest push), else upload + delete once.
  const makeDoUpload = (
    buf: Awaited<ReturnType<typeof openBuffer>>,
    spies: { getUploadUrl: number; uploads: number; manifest: number[]; drainedEmits: number[] }
  ) => {
    return async (record: PendingChunk): Promise<DrainOutcome> => {
      // Re-check FIRST — closes the double-upload window.
      const stillPending = await buf.get(record.key);
      if (!stillPending) return "ok"; // live upload already finished it → no-op
      spies.getUploadUrl += 1; // stand-in for getUploadUrl()
      spies.uploads += 1; // stand-in for uploadBlob()
      spies.manifest.push(record.index); // stand-in for manifest.push(...)
      spies.drainedEmits.push(record.index); // stand-in for emit("chunk_drained")
      await buf.delete(record.key);
      return "ok";
    };
  };

  it("a drain of a record deleted by a concurrent live upload is a NO-OP (no re-mint/upload/manifest)", async () => {
    const buf = await openBuffer(makeDeps().deps);
    const rec = chunk("s1", "screen", 5, { enqueuedAt: 5 });
    await buf.put(rec);
    const spies = { getUploadUrl: 0, uploads: 0, manifest: [] as number[], drainedEmits: [] as number[] };
    const doUpload = makeDoUpload(buf, spies);

    // listOldest snapshots the still-pending record...
    const [listed] = await buf.listOldest("s1", 5);
    expect(listed.key).toBe(rec.key);
    // ...then the concurrent LIVE upload completes + deletes the key BEFORE the
    // chained drain doUpload runs.
    await buf.delete(rec.key);

    const outcome = await doUpload(listed);
    expect(outcome).toBe("ok"); // resolves as a no-op success (NOT a failure)
    expect(spies.getUploadUrl).toBe(0); // never re-minted a signed URL
    expect(spies.uploads).toBe(0); // never re-uploaded the bytes (no duplicate)
    expect(spies.manifest).toEqual([]); // never pushed a duplicate manifest entry
    expect(spies.drainedEmits).toEqual([]); // never emitted chunk_drained
    // attempts unchanged (the no-op path never re-puts with attempts+1).
    expect(await buf.count("s1")).toBe(0);
  });

  it("the normal drain path (record still present) uploads + deletes exactly once", async () => {
    const buf = await openBuffer(makeDeps().deps);
    const rec = chunk("s1", "screen", 7, { enqueuedAt: 7 });
    await buf.put(rec);
    const spies = { getUploadUrl: 0, uploads: 0, manifest: [] as number[], drainedEmits: [] as number[] };
    const doUpload = makeDoUpload(buf, spies);

    const [listed] = await buf.listOldest("s1", 5);
    const outcome = await doUpload(listed); // record still present → real upload
    expect(outcome).toBe("ok");
    expect(spies.getUploadUrl).toBe(1); // minted exactly once
    expect(spies.uploads).toBe(1); // uploaded exactly once
    expect(spies.manifest).toEqual([7]); // one manifest entry
    expect(spies.drainedEmits).toEqual([7]); // one chunk_drained
    expect(await buf.get(rec.key)).toBeNull(); // deleted after the 2xx
    expect(await buf.count("s1")).toBe(0);
  });
});
