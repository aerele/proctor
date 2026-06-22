// backend/test/v11InfraUnits.test.mjs — v1.1 G3/G1 PURE-unit coverage for the
// infra primitives the prior build added without tests:
//   lib/tokenBucket.mjs    — refillTokens / tryConsumeToken / shardFor (pure)
//   lib/ttlCache.mjs       — TTL + LRU + invalidate/clear on a clock seam
//   lib/telemetryLimiter.mjs — per-session per-endpoint token-bucket gate
//   judge0Limiter.mjs      — sharded distributed gate (consume / 429 / fail-open
//                            / disabled bypass) over a fake Firestore
//   dataLifecycle.mjs      — retentionAnchorMs auto exam_end anchor + the
//                            CONSENT_VERSION export
//
// These are the SEAMS that make the live-incident fixes (Judge0-429 #132,
// signed-URL abuse, runaway retention) verifiable without GCP.
import { test } from "node:test";
import assert from "node:assert/strict";

const { refillTokens, tryConsumeToken, shardFor } = await import("../src/lib/tokenBucket.mjs");
const { makeTtlCache } = await import("../src/lib/ttlCache.mjs");
const { makeTelemetryLimiter, TELEMETRY_LIMITS } = await import("../src/lib/telemetryLimiter.mjs");
const { makeJudge0Limiter } = await import("../src/judge0Limiter.mjs");
const { retentionAnchorMs, selectExpiredEvidence, CONSENT_VERSION, DEFAULT_RETENTION_DAYS } =
  await import("../src/dataLifecycle.mjs");

// A 429-shaped error builder matching the handler's makeRateLimited.
function rateLimited(retryAfterSeconds) {
  const e = new Error("rate_limited");
  e.statusCode = 429;
  e.retry_after_seconds = retryAfterSeconds;
  return e;
}

// ---- tokenBucket: refillTokens (pure) --------------------------------------

test("refillTokens: a missing/garbage state starts FULL (never spuriously throttles a fresh shard)", () => {
  assert.equal(refillTokens(null, 1000, { capacity: 40, refillPerSec: 10 }), 40);
  assert.equal(refillTokens({}, 1000, { capacity: 40, refillPerSec: 10 }), 40);
  assert.equal(refillTokens({ tokens: "x", updated_ms: "y" }, 1000, { capacity: 40, refillPerSec: 10 }), 40);
});

test("refillTokens: refills at refillPerSec, capped at capacity, never below 0 elapsed", () => {
  // 5 tokens, 2s later at 10/s → +20 = 25 (under the 40 cap).
  assert.equal(refillTokens({ tokens: 5, updated_ms: 0 }, 2000, { capacity: 40, refillPerSec: 10 }), 25);
  // 35 tokens, 2s later at 10/s → +20 = 55 but CAPPED at 40.
  assert.equal(refillTokens({ tokens: 35, updated_ms: 0 }, 2000, { capacity: 40, refillPerSec: 10 }), 40);
  // 5 tokens, 1s later at 3/s → 8.
  assert.equal(refillTokens({ tokens: 5, updated_ms: 0 }, 1000, { capacity: 40, refillPerSec: 3 }), 8);
  // clock skew (now < prev) clamps elapsed at 0 → unchanged.
  assert.equal(refillTokens({ tokens: 5, updated_ms: 2000 }, 1000, { capacity: 40, refillPerSec: 10 }), 5);
});

// ---- tokenBucket: tryConsumeToken (pure) -----------------------------------

test("tryConsumeToken: allowed when tokens>=cost, decrements, stamps now", () => {
  const r = tryConsumeToken({ tokens: 3, updated_ms: 0 }, 1000, { capacity: 40, refillPerSec: 0 });
  assert.deepEqual(r, { allowed: true, tokens: 2, updated_ms: 1000, retry_after_ms: 0 });
});

test("tryConsumeToken: denied when empty, returns an HONEST retry hint to the next token", () => {
  // 0 tokens, 0 refill in-window, refillPerSec 2 → 1 token in 500ms.
  const r = tryConsumeToken({ tokens: 0, updated_ms: 1000 }, 1000, { capacity: 40, refillPerSec: 2 });
  assert.equal(r.allowed, false);
  assert.equal(r.tokens, 0);
  assert.equal(r.retry_after_ms, 500);
});

test("tryConsumeToken: refillPerSec=0 misconfig cannot divide-by-zero (1s fallback hint)", () => {
  const r = tryConsumeToken({ tokens: 0, updated_ms: 1000 }, 1000, { capacity: 40, refillPerSec: 0 });
  assert.equal(r.allowed, false);
  assert.equal(r.retry_after_ms, 1000);
});

// ---- tokenBucket: shardFor (stable hash) -----------------------------------

test("shardFor: deterministic, in-range, and the same key always lands on one shard", () => {
  for (const key of ["s1", "session-abc", "21cs001", ""]) {
    const a = shardFor(key, 10);
    const b = shardFor(key, 10);
    assert.equal(a, b);
    assert.ok(a >= 0 && a < 10);
  }
  // shardCount<=0 collapses to a single shard (index 0).
  assert.equal(shardFor("x", 0), 0);
});

test("shardFor: spreads keys across shards (not all on one)", () => {
  const counts = new Array(8).fill(0);
  for (let i = 0; i < 400; i++) counts[shardFor("session-" + i, 8)]++;
  // Every shard gets at least one — a degenerate hash would pile onto one.
  assert.ok(counts.every((c) => c > 0), `uneven spread: ${counts}`);
});

// ---- ttlCache --------------------------------------------------------------

test("ttlCache: get/set round-trips, miss returns undefined, size tracks entries", () => {
  const c = makeTtlCache({ ttlMs: 1000 });
  assert.equal(c.get("a"), undefined);
  c.set("a", { v: 1 });
  assert.deepEqual(c.get("a"), { v: 1 });
  assert.equal(c.size(), 1);
});

test("ttlCache: an entry past its TTL is a MISS (staleness self-heals)", () => {
  let now = 1000;
  const c = makeTtlCache({ ttlMs: 500 });
  c.__setClockForTest(() => now);
  c.set("a", 42);
  now = 1499; assert.equal(c.get("a"), 42);   // within TTL
  now = 1500; assert.equal(c.get("a"), undefined); // at/after expiry → miss
});

test("ttlCache: invalidate(key) drops one, clear() drops all", () => {
  const c = makeTtlCache({ ttlMs: 1000 });
  c.set("a", 1); c.set("b", 2);
  c.invalidate("a");
  assert.equal(c.get("a"), undefined);
  assert.equal(c.get("b"), 2);
  c.clear();
  assert.equal(c.get("b"), undefined);
  assert.equal(c.size(), 0);
});

test("ttlCache: LRU eviction at maxEntries drops the least-recently-used", () => {
  const c = makeTtlCache({ ttlMs: 100000, maxEntries: 2 });
  c.set("a", 1); c.set("b", 2);
  c.get("a");        // touch a → b is now LRU
  c.set("c", 3);     // evicts b
  assert.equal(c.get("b"), undefined);
  assert.equal(c.get("a"), 1);
  assert.equal(c.get("c"), 3);
});

test("ttlCache: getOrLoad caches a resolved loader; a rejected loader caches nothing", async () => {
  const c = makeTtlCache({ ttlMs: 1000 });
  let loads = 0;
  const v = await c.getOrLoad("k", async () => { loads++; return 7; });
  assert.equal(v, 7);
  await c.getOrLoad("k", async () => { loads++; return 7; }); // hit, no reload
  assert.equal(loads, 1);
  await assert.rejects(c.getOrLoad("bad", async () => { throw new Error("boom"); }));
  assert.equal(c.get("bad"), undefined); // a rejected loader leaves no entry
});

// ---- telemetryLimiter ------------------------------------------------------

test("telemetryLimiter: never throttles a realistic candidate cadence", () => {
  let now = 0;
  const lim = makeTelemetryLimiter({ rateLimited });
  lim.__setClockForTest(() => now);
  // Heartbeat every 15s for an hour (240 beats) — far under the 60-burst/1-s cap.
  for (let i = 0; i < 240; i++) { lim.check("heartbeat", "s1"); now += 15000; }
  // upload-url: ~2 chunks / 30s for an hour (240) — under 120-burst/2-s.
  now = 0;
  for (let i = 0; i < 240; i++) { lim.check("upload-url", "s1"); if (i % 2) now += 30000; }
});

test("telemetryLimiter: a same-instant flood past the burst throws 429 with a retry hint", () => {
  let now = 0;
  const lim = makeTelemetryLimiter({ rateLimited });
  lim.__setClockForTest(() => now);
  const cap = TELEMETRY_LIMITS["heartbeat"].capacity; // 60
  for (let i = 0; i < cap; i++) lim.check("heartbeat", "flood"); // drains the burst
  let thrown;
  try { lim.check("heartbeat", "flood"); } catch (e) { thrown = e; }
  assert.ok(thrown, "expected a 429 after the burst is drained");
  assert.equal(thrown.statusCode, 429);
  assert.ok(thrown.retry_after_seconds >= 1);
});

test("telemetryLimiter: buckets are independent per session AND per endpoint", () => {
  let now = 0;
  const lim = makeTelemetryLimiter({ rateLimited });
  lim.__setClockForTest(() => now);
  const cap = TELEMETRY_LIMITS["heartbeat"].capacity;
  for (let i = 0; i < cap; i++) lim.check("heartbeat", "s1");
  // s1/heartbeat is drained, but s2/heartbeat and s1/events are untouched.
  assert.doesNotThrow(() => lim.check("heartbeat", "s2"));
  assert.doesNotThrow(() => lim.check("events", "s1"));
});

test("telemetryLimiter: an unknown endpoint is never limited (defensive)", () => {
  const lim = makeTelemetryLimiter({ rateLimited });
  for (let i = 0; i < 1000; i++) lim.check("not-a-real-endpoint", "s1");
});

// ---- judge0Limiter (sharded distributed gate over a fake Firestore) --------

function makeFakeFirestore() {
  const docs = new Map();
  function ref(collection, id) {
    const key = `${collection}/${id}`;
    return {
      async get() { return { exists: docs.has(key), data: () => docs.get(key) }; },
      set(value, opts) { docs.set(key, opts?.merge ? { ...(docs.get(key) || {}), ...value } : { ...value }); }
    };
  }
  return {
    _docs: docs,
    collection(name) { return { doc(id) { return ref(name, id); } }; },
    async runTransaction(fn) {
      // Single-threaded fake: a tx.get/tx.set pair runs to completion atomically.
      const tx = {
        async get(r) { return r.get(); },
        set(r, value, opts) { r.set(value, opts); }
      };
      return fn(tx);
    }
  };
}

function makeLimiter(firestore, overrides = {}) {
  return makeJudge0Limiter({
    getFirestore: () => firestore,
    collection: "proctor_judge0_ratelimit",
    enabled: true,
    capacity: 4,        // tiny so the burst is easy to drain in a test
    refillPerSec: 1,
    shards: 1,          // one shard → one bucket, deterministic
    rateLimited,
    ...overrides
  });
}

test("judge0Limiter: gate runs the submitFn while tokens remain, then 429s when drained", async () => {
  let now = 0;
  const fs = makeFakeFirestore();
  const lim = makeLimiter(fs);
  lim.__setClockForTest(() => now);
  let ran = 0;
  const submit = async () => { ran++; return "ok"; };
  // capacity 4 on 1 shard → 4 submits, then the 5th is rejected.
  for (let i = 0; i < 4; i++) assert.equal(await lim.gate("s1", submit), "ok");
  assert.equal(ran, 4);
  await assert.rejects(() => lim.gate("s1", submit), (e) => e.statusCode === 429);
  assert.equal(ran, 4, "a rejected gate NEVER reaches Judge0 (the saved call)");
});

test("judge0Limiter: a refilled token lets the next submit through", async () => {
  let now = 0;
  const fs = makeFakeFirestore();
  const lim = makeLimiter(fs);
  lim.__setClockForTest(() => now);
  const submit = async () => "ok";
  for (let i = 0; i < 4; i++) await lim.gate("s1", submit);
  await assert.rejects(() => lim.gate("s1", submit)); // drained
  now += 1000; // 1s @ 1/s → +1 token
  assert.equal(await lim.gate("s1", submit), "ok");
});

test("judge0Limiter: disabled → pure pass-through, no Firestore touched", async () => {
  const fs = makeFakeFirestore();
  const lim = makeLimiter(fs, { enabled: false });
  let ran = 0;
  for (let i = 0; i < 100; i++) await lim.gate("s1", async () => { ran++; });
  assert.equal(ran, 100);
  assert.equal(fs._docs.size, 0, "disabled limiter must not write any shard doc");
});

test("judge0Limiter: FAILS OPEN on a Firestore error (never walls off a live exam)", async () => {
  const fs = {
    collection() { return { doc() { return {}; } }; },
    async runTransaction() { throw new Error("firestore unavailable"); }
  };
  const lim = makeLimiter(fs);
  let ran = 0;
  // Despite the transaction throwing, the submit still runs (fail-open).
  assert.equal(await lim.gate("s1", async () => { ran++; return "ok"; }), "ok");
  assert.equal(ran, 1);
});

// ---- dataLifecycle: retentionAnchorMs auto exam_end anchor + CONSENT_VERSION

test("CONSENT_VERSION is exported as a non-empty version string", () => {
  assert.equal(typeof CONSENT_VERSION, "string");
  assert.ok(CONSENT_VERSION.length > 0);
});

test("retentionAnchorMs: retention_started_at wins over everything (pinned anchor)", () => {
  const ms = retentionAnchorMs({
    retention_started_at: "2026-06-10T00:00:00.000Z",
    selection_done_at: "2026-06-01T00:00:00.000Z",
    end_at: "2026-06-05T00:00:00.000Z"
  });
  assert.equal(ms, Date.parse("2026-06-10T00:00:00.000Z"));
});

test("retentionAnchorMs: exam_end anchor DERIVES from end_at when nothing is stamped", () => {
  const ms = retentionAnchorMs({ end_at: "2026-06-05T00:00:00.000Z" }); // default anchor = exam_end
  assert.equal(ms, Date.parse("2026-06-05T00:00:00.000Z"));
});

test("retentionAnchorMs: selection_done anchor NEVER falls back to end_at", () => {
  // A contest that opted into the manual clock: no selection stamp yet → no anchor,
  // even though end_at is in the past. Protects the manual-selection workflow.
  assert.ok(Number.isNaN(retentionAnchorMs({ retention_anchor: "selection_done", end_at: "2020-01-01T00:00:00.000Z" })));
  // With the manual stamp present, that is the anchor.
  assert.equal(
    retentionAnchorMs({ retention_anchor: "selection_done", selection_done_at: "2026-06-02T00:00:00.000Z", end_at: "2020-01-01T00:00:00.000Z" }),
    Date.parse("2026-06-02T00:00:00.000Z")
  );
});

test("retentionAnchorMs: a contest with NO anchor fields resolves to NaN (never swept — KPR safety)", () => {
  assert.ok(Number.isNaN(retentionAnchorMs({})));
  assert.ok(Number.isNaN(retentionAnchorMs({ retention_anchor: "exam_end" })));
});

test("selectExpiredEvidence: an exam_end-anchored contest is now self-starting (no manual click needed)", () => {
  const NOW = "2026-06-20T00:00:00.000Z";
  // end_at 06-10, default 4-day retention → expires 06-14 < NOW, no selection_done_at.
  const due = selectExpiredEvidence(
    [{ slug: "auto", end_at: "2026-06-10T00:00:00.000Z", evidence_retention_days: 4, evidence_purged_at: null }],
    NOW
  );
  assert.deepEqual(due.map((c) => c.slug), ["auto"]);
  // The same contest, manual-anchored, is NOT due (no stamp) — the regression guard.
  const held = selectExpiredEvidence(
    [{ slug: "manual", retention_anchor: "selection_done", end_at: "2026-06-10T00:00:00.000Z", evidence_purged_at: null }],
    NOW
  );
  assert.equal(held.length, 0);
});

test("DEFAULT_RETENTION_DAYS is 4 (F9 Q2)", () => {
  assert.equal(DEFAULT_RETENTION_DAYS, 4);
});
