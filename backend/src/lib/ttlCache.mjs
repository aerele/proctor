// backend/src/lib/ttlCache.mjs — a tiny in-process TTL + LRU-ish cache for the
// hot single-doc reads (G3 / audit #5, v1.1).
//
// WHY: every heartbeat (15 s/candidate), every events/beacon, and the room-gate/
// enforcement paths re-read config docs that NEVER change mid-request — the
// contest doc and the alert-settings doc. At ~1000 candidates that is 130+
// reads/sec funneled at TWO documents. A short TTL collapses that to near-zero
// Firestore reads with a staleness bound of at most the TTL.
//
// CORRECTNESS over cleverness (Karthi's decision #5 — "CORRECT invalidation"):
//   1. Bounded TTL: an entry older than ttlMs is a miss (re-read). So even if an
//      invalidation is somehow missed, staleness self-heals within ttlMs.
//   2. EXPLICIT invalidation: every WRITE to a cached doc calls invalidate(key)
//      (or clear() for settings) so a config change is visible immediately on the
//      writing instance. Cross-instance, the TTL bound (1) caps staleness.
//   3. Per-instance: this is a read cache, not a source of truth. Writes always
//      go to Firestore; the cache only short-circuits reads.
//
// The cache is deliberately conservative on TTL (seconds, not minutes) because
// the safety property is "config edits reach a live exam fast" — a 5 s contest
// TTL means an admin's end-time change is honored within 5 s even on an instance
// that didn't serve the write, on TOP of the existing per-request heartbeat fan-
// out. Caching here is a cost optimization, never a correctness shortcut.

export function makeTtlCache({ ttlMs, maxEntries = 5000 } = {}) {
  if (!(ttlMs > 0)) throw new Error("makeTtlCache: ttlMs must be > 0");
  const map = new Map(); // key -> { value, expiresMs }
  let _clock = () => Date.now();
  function __setClockForTest(fn) { _clock = fn || (() => Date.now()); }

  function get(key) {
    const entry = map.get(key);
    if (!entry) return undefined;
    if (_clock() >= entry.expiresMs) { map.delete(key); return undefined; }
    // refresh recency: re-insert so iteration order tracks LRU for eviction.
    map.delete(key);
    map.set(key, entry);
    return entry.value;
  }

  function set(key, value) {
    if (map.has(key)) map.delete(key);
    else if (map.size >= maxEntries) {
      // Evict the least-recently-used (first inserted/touched) entry.
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    map.set(key, { value, expiresMs: _clock() + ttlMs });
    return value;
  }

  // getOrLoad: cache-aside. On a miss (or expiry) run loader(), cache, return.
  // loader may be async; the value is cached only after it resolves (a rejected
  // loader caches nothing). Concurrent misses for the same key may each load —
  // acceptable for these idempotent single-doc reads (no dedupe needed, and
  // de-duping would add a promise-tracking surface for negligible gain).
  async function getOrLoad(key, loader) {
    const hit = get(key);
    if (hit !== undefined) return hit;
    const value = await loader();
    return set(key, value);
  }

  function invalidate(key) { map.delete(key); }
  function clear() { map.clear(); }
  function size() { return map.size; }

  return { get, set, getOrLoad, invalidate, clear, size, __setClockForTest };
}
