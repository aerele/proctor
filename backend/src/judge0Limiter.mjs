// backend/src/judge0Limiter.mjs — the Firestore-backed SHARDED token-bucket
// limiter that caps Judge0 submit throughput ACROSS Cloud Run instances (G3,
// v1.1). This is the structural fix for the live #132 Judge0-429 storm: the
// per-instance execQueue lanes can't bound a 20-instance fleet, so the global
// submit rate is enforced here on SHARED state.
//
// Design (per TAKEHOME-V1.1-DECISIONS §FOLLOW-UP): Firestore sharded token
// bucket — NO new infra, scales to zero (no idle cost, no VPC connector). Redis/
// Memorystore is cleaner at very high concurrency but is always-on + needs a VPC
// connector, contradicting the pay-nothing-between-tests goal. The scale ceiling
// (where Firestore throughput is exceeded and Redis becomes required) is
// documented in docs/JUDGE0-RATE-LIMITER.md.
//
// Mechanism: makeJudge0Limiter(ctx) returns { gate }. gate(key, submitFn) runs a
// Firestore transaction on ONE shard doc (chosen by hashing `key`), refills +
// tries to consume one token (pure math in lib/tokenBucket.mjs), and only then
// runs submitFn (the actual Judge0 POST). An empty bucket → a 429 carrying the
// honest refill-based retry hint, BEFORE any Judge0 call is made. The gate
// COMPOSES with the existing execQueue lane gate: exec.mjs passes
// `submitGate: (fn) => limiter.gate(sessionId, () => execQueue.enqueueSubmit(fn))`
// so per-instance backpressure AND the global cap both apply.
//
// Fail-OPEN by deliberate choice: if Firestore errors (the limiter's own infra
// hiccup), we let the submit through rather than block a real candidate's exam.
// The metered-key DoS surface is already covered by the per-session exec cooldown
// (exec.mjs) + the queue lanes; this limiter is the GLOBAL smoothing layer, and a
// transient Firestore blip must never wall off a live contest.

import { shardFor, tryConsumeToken } from "./lib/tokenBucket.mjs";

export function makeJudge0Limiter(ctx) {
  const {
    getFirestore,
    // env-captured by value at handler load
    collection,            // JUDGE0_LIMITER_COLLECTION
    enabled,               // JUDGE0_LIMITER_ENABLED (bool)
    capacity,              // JUDGE0_LIMITER_CAPACITY  (burst tokens, GLOBAL)
    refillPerSec,          // JUDGE0_LIMITER_REFILL_PER_SEC (GLOBAL sustained rate)
    shards,                // JUDGE0_LIMITER_SHARDS
    // a 429 builder (httpError-based; mirrors exec.mjs rateLimited shape)
    rateLimited
  } = ctx;

  // Per-shard derived caps. The GLOBAL capacity/rate are split evenly across
  // shards so the sum across shards equals the configured global limit; each
  // shard is its own independent bucket (at least 1 token / a positive rate so a
  // single-shard config still flows).
  const shardCount = Math.max(1, Math.floor(shards) || 1);
  const shardCapacity = Math.max(1, capacity / shardCount);
  const shardRefillPerSec = Math.max(0.001, refillPerSec / shardCount);

  // Injectable clock so the transaction's refill math is deterministic in tests.
  let _clock = () => Date.now();
  function __setClockForTest(fn) { _clock = fn || (() => Date.now()); }

  // acquire(key): run the sharded Firestore transaction. Returns when a token is
  // consumed; throws a 429 (rateLimited) when the shard is empty. Fails OPEN on
  // any Firestore error (returns without throwing — see header).
  async function acquire(key) {
    if (!enabled) return;
    const shard = shardFor(key, shardCount);
    const ref = getFirestore().collection(collection).doc(`shard-${shard}`);
    const nowMs = _clock();
    try {
      const decision = await getFirestore().runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const state = snap.exists ? snap.data() : null;
        const result = tryConsumeToken(state, nowMs, {
          capacity: shardCapacity,
          refillPerSec: shardRefillPerSec
        });
        // Always persist the anchored timestamp so refill stays correct; persist
        // the decremented token count only when we actually consumed one.
        tx.set(ref, { tokens: result.tokens, updated_ms: result.updated_ms }, { merge: true });
        return result;
      });
      if (!decision.allowed) {
        throw rateLimited(Math.max(1, Math.ceil(decision.retry_after_ms / 1000)));
      }
    } catch (err) {
      // A 429 we raised is intentional — rethrow it. Anything else is the
      // limiter's OWN infra failing: fail open (let the submit through).
      if (err?.statusCode === 429) throw err;
      console.error(`judge0 limiter fail-open (Firestore error): ${err?.message || err}`);
    }
  }

  // gate(key, submitFn): the submitGate-shaped wrapper exec.mjs composes with the
  // execQueue lane. Acquire a global token FIRST, then run the (lane-gated)
  // submit. A 429 from acquire() never reaches Judge0 — exactly the saved call.
  async function gate(key, submitFn) {
    await acquire(key);
    return submitFn();
  }

  return { gate, acquire, __setClockForTest, _shardCount: shardCount };
}
