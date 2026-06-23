// backend/src/lib/telemetryLimiter.mjs — per-session candidate-telemetry rate
// limiter (G3 / audit #4, v1.1).
//
// WHY: the six candidate telemetry endpoints (upload-url / events / editor-events
// / review-file / heartbeat / beacon) are gated ONLY by requireWritableSession (a
// pure status check). A scripted-but-valid session token could mint unlimited
// signed write URLs (burning the v4-signing path — the live-incident path),
// create unbounded GCS objects, and amplify Firestore writes. This limiter caps
// each session's per-endpoint request rate.
//
// TUNING PRINCIPLE (product decision): a sane DEFAULT that NEVER throttles
// real candidate data, but blocks a DoS. Caps are derived from the ACTUAL client
// emission rates with generous burst headroom, so a legitimate candidate — even
// one reconnecting and flushing a backlog — never trips them; only a scripted
// flood does. Defaults (per-session, per-endpoint), as token buckets:
//
//   endpoint       client rate (real)            burst / refill-per-sec   rationale
//   ------------   --------------------------     ----------------------   ------------------------------
//   upload-url     ~1 screen + ~1 camera / 30 s   120 / 2.0                a reconnect can flush a long
//                                                                          backlog of buffered chunks at
//                                                                          once; 120-burst covers ~1 h of
//                                                                          buffered 30 s chunks, 2/s sustained
//   events         a few batches / min            120 / 1.0                focus/visibility bursts on tab
//                                                                          churn; one batch carries ≤100 events
//   editor-events  keystroke batches              120 / 2.0                fast typist flushing analytics
//   review-file    clipboard/tabs snapshots       60 / 0.5                 occasional, snapshot-driven
//   heartbeat      1 / 15 s (+ retries)           60 / 1.0                 15 s cadence = 0.067/s; 1/s + 60
//                                                                          burst is ~15× headroom
//   beacon         page hide/show/unload          60 / 1.0                 visibility flapping
//
// These are intentionally ~15–60× the real client rate. A real session sits far
// below them for the whole exam; the cap only catches a token that is being
// driven programmatically thousands of times.
//
// In-process per-instance state (same documented caveat as the exec limiter +
// access-code limiter — it degrades toward N× looser across N instances but
// every instance still caps a single session's flood; the abuse vector is one
// session token hammering, which any single instance handling that session
// throttles). The 429 it raises carries an honest retry hint.

import { refillTokens, tryConsumeToken } from "./tokenBucket.mjs";

// Default bucket config per endpoint: { capacity (burst), refillPerSec (sustained) }.
export const TELEMETRY_LIMITS = Object.freeze({
  "upload-url":   { capacity: 120, refillPerSec: 2.0 },
  "events":       { capacity: 120, refillPerSec: 1.0 },
  "editor-events":{ capacity: 120, refillPerSec: 2.0 },
  "review-file":  { capacity: 60,  refillPerSec: 0.5 },
  "heartbeat":    { capacity: 60,  refillPerSec: 1.0 },
  "beacon":       { capacity: 60,  refillPerSec: 1.0 }
});

// Drop a session's buckets after this idle horizon so the Map can't grow
// unboundedly on a long-lived instance (mirrors the exec limiter's prune).
const PRUNE_MS = 60 * 60 * 1000;
// Hard cap on tracked sessions so a spoofed-id flood can't grow the Map between
// prunes; when exceeded we sweep idle entries first, then (if still full) the
// new session is allowed WITHOUT a bucket (fail-open on memory pressure — the
// exec limiter + queue still bound the metered surface).
const MAP_SESSION_LIMIT = 50_000;

// makeTelemetryLimiter({ rateLimited }) → { check(endpoint, sessionId) }.
// `rateLimited(retryAfterSeconds)` builds the 429 (injected so it matches the
// route domain's existing error shape exactly). check() throws on overflow,
// returns silently when allowed.
export function makeTelemetryLimiter({ rateLimited, limits = TELEMETRY_LIMITS } = {}) {
  // sessionId -> Map(endpoint -> { tokens, updated_ms })
  const sessions = new Map();
  let _clock = () => Date.now();
  function __setClockForTest(fn) { _clock = fn || (() => Date.now()); }

  function pruneIdle(nowMs) {
    for (const [sid, buckets] of sessions) {
      let newest = -Infinity;
      for (const b of buckets.values()) if (b.updated_ms > newest) newest = b.updated_ms;
      if (nowMs - newest > PRUNE_MS) sessions.delete(sid);
    }
  }

  function check(endpoint, sessionId) {
    const cfg = limits[endpoint];
    if (!cfg) return; // unknown endpoint → no limit (defensive; never blocks)
    const nowMs = _clock();

    if (sessions.size >= MAP_SESSION_LIMIT && !sessions.has(sessionId)) {
      pruneIdle(nowMs);
      if (sessions.size >= MAP_SESSION_LIMIT) return; // memory pressure → fail open
    }

    let buckets = sessions.get(sessionId);
    if (!buckets) {
      buckets = new Map();
      sessions.set(sessionId, buckets);
    }
    const state = buckets.get(endpoint) || null;
    const result = tryConsumeToken(state, nowMs, cfg);
    buckets.set(endpoint, { tokens: result.tokens, updated_ms: result.updated_ms });
    if (!result.allowed) {
      throw rateLimited(Math.max(1, Math.ceil(result.retry_after_ms / 1000)));
    }
  }

  // Read-only peek (tokens remaining) — used by tests; never mutates.
  function peek(endpoint, sessionId) {
    const cfg = limits[endpoint];
    if (!cfg) return Infinity;
    const buckets = sessions.get(sessionId);
    const state = buckets?.get(endpoint) || null;
    return refillTokens(state, _clock(), cfg);
  }

  return { check, peek, __setClockForTest, _sessionCount: () => sessions.size };
}
