// backend/src/lib/tokenBucket.mjs — PURE token-bucket math for the Judge0
// distributed rate limiter (G3, v1.1).
//
// WHY: the exec-queue lanes (execQueue.mjs) bound concurrency PER INSTANCE, but
// proctor-api runs `--max-instances 20 --concurrency 100`, so the effective
// Judge0 submit concurrency is up to 20× the per-instance lane cap — the
// structural root cause of the live #132 Judge0-429 storm. A cross-instance cap
// needs SHARED state. We use a Firestore-backed SHARDED token bucket (no new
// infra, scales to zero) rather than Redis/Memorystore (always-on + VPC cost).
//
// This module holds ONLY the pure refill/consume decision on a clock seam, so it
// is unit-tested with no Firestore. The handler/limiter owns the sharded
// Firestore transactions that persist {tokens, updated_ms} per shard and route a
// caller to a shard.
//
// Token-bucket semantics: a shard holds up to `capacity` tokens and refills at
// `refillPerSec` tokens/second up to capacity. A submit POST consumes 1 token.
// Empty bucket → the caller waits (retry) rather than hammering Judge0. Sharding
// spreads contention: a global rate R over S shards is R/S per shard, and a
// caller hashes onto one shard, so the hot single-doc write contention that
// would otherwise serialize every submit is divided by S.

// refill(state, now, {capacity, refillPerSec}) → new token count (capped at
// capacity). Pure: no side effects, no clock read — `now` and the prior state
// are passed in. A missing/garbage prior state starts FULL (capacity) so a fresh
// shard never spuriously throttles the first caller.
export function refillTokens(state, nowMs, { capacity, refillPerSec }) {
  const prevTokens = Number.isFinite(state?.tokens) ? state.tokens : capacity;
  const prevMs = Number.isFinite(state?.updated_ms) ? state.updated_ms : nowMs;
  const elapsedMs = Math.max(0, nowMs - prevMs);
  const refilled = prevTokens + (elapsedMs / 1000) * refillPerSec;
  return Math.min(capacity, refilled);
}

// tryConsume(state, now, opts) → { allowed, tokens, retry_after_ms }.
//   allowed:true  → one token consumed; persist {tokens, updated_ms:now}.
//   allowed:false → not enough tokens; retry_after_ms tells the caller how long
//                   until ONE token refills (so a 429 carries an honest hint).
// PURE — the caller (Firestore transaction) persists the returned `tokens` +
// `now` only when allowed (and always stamps updated_ms so refill stays anchored).
export function tryConsumeToken(state, nowMs, { capacity, refillPerSec, cost = 1 }) {
  const tokens = refillTokens(state, nowMs, { capacity, refillPerSec });
  if (tokens >= cost) {
    return { allowed: true, tokens: tokens - cost, updated_ms: nowMs, retry_after_ms: 0 };
  }
  // Tokens still owed until the bucket reaches `cost`. refillPerSec>0 by config
  // (validated in the limiter); guard anyway so a misconfig can't divide by 0.
  const deficit = cost - tokens;
  const retryAfterMs = refillPerSec > 0 ? Math.ceil((deficit / refillPerSec) * 1000) : 1000;
  return { allowed: false, tokens, updated_ms: nowMs, retry_after_ms: retryAfterMs };
}

// shardFor(key, shardCount) → a stable shard index in [0, shardCount). A simple
// FNV-1a hash over the session id spreads callers evenly across shards without a
// crypto dependency. Same session always lands on the same shard (so its own
// burst contends on one doc, not all S), which is fine: the GLOBAL rate is what
// we cap, and per-session bursts are already bounded by the exec cooldown.
export function shardFor(key, shardCount) {
  const n = Math.max(1, Math.floor(shardCount) || 1);
  let h = 0x811c9dc5;
  const s = String(key ?? "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % n;
}
