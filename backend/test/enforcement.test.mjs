// backend/test/enforcement.test.mjs
//
// F5.3-6 — fullscreen enforcement ladder + per-session exemptions + switch-away
// episode alerting:
//   - the contest's enforcement snapshot carries fullscreen_reentry_seconds /
//     fullscreen_exit_limit / mode (NaN-guarded, defaulted), served via
//     exam-config, start/resume, and the heartbeat response.
//   - POST /api/session/enforcement-violation: candidate self-report; server
//     raises the critical alert and (block mode only) LOCKS the session with
//     locked_reason "fullscreen_enforcement".
//   - POST /api/session/unlock-gate: candidate-side release using the room's
//     OTP — enforcement locks ONLY, attempt-capped like the room gate.
//   - session-action "exempt" (admin) + /api/invigilator/exempt set per-session
//     enforcement_exemptions; invigilator room rows expose them.
//   - switch_away_episode events raise threshold-based tab_away alerts carrying
//     duration/count, suppressed by the switch_away exemption.
import { test } from "node:test";
import assert from "node:assert/strict";

// Env MUST be set before importing the handler (it reads env at module load).
process.env.EVIDENCE_BUCKET = "enf-bucket";
process.env.SESSION_COLLECTION = "enf_sessions";
process.env.SETTINGS_COLLECTION = "enf_settings";
process.env.CONTESTS_COLLECTION = "enf_contests";
process.env.ALERTS_COLLECTION = "enf_alerts";
process.env.ROOM_GATES_COLLECTION = "enf_room_gates";
process.env.LIVE_LOCK_COLLECTION = "enf_live_locks";
process.env.ADMIN_PASSWORD = "enf-admin-pass";
process.env.INVIGILATOR_PASSWORD = "enf-invig-pass";

const handler = await import("../src/handler.mjs?enforcement");
const { api, __setClientsForTest, invalidateContestDocCache } = handler;

// Inline req/res mocks + fakes (repo convention: copied per test file, NO helpers.mjs).
function makeReq({ method, path, headers = {}, body, query = {} }) {
  const lowerHeaders = {};
  for (const [k, v] of Object.entries(headers)) lowerHeaders[k.toLowerCase()] = v;
  return { method, path, headers: lowerHeaders, query, body,
    get(name) { return lowerHeaders[String(name).toLowerCase()]; } };
}
function makeRes() {
  return { statusCode: null, body: null, headers: {},
    set(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    send(p) { this.body = p; return this; } };
}
async function call(req) { const res = makeRes(); await api(req, res); return res; }

function isIncrementSentinel(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && typeof value.operand === "number"
    && (value.methodName === undefined || String(value.methodName).includes("increment"));
}

function applyUpdate(existing, patch) {
  const next = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (isIncrementSentinel(value)) {
      next[key] = Number(next[key] || 0) + value.operand;
    } else {
      next[key] = value;
    }
  }
  return next;
}

function makeFakeFirestore() {
  const collections = new Map();

  function getCollection(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  }

  function makeQuery(name, filters) {
    return {
      where(field, op, value) {
        return makeQuery(name, [...filters, { field, op, value }]);
      },
      limit() {
        return this;
      },
      async get() {
        const store = getCollection(name);
        let docs = [...store.values()];
        for (const { field, op, value } of filters) {
          if (op === "in") {
            docs = docs.filter((doc) => Array.isArray(value) && value.includes(doc[field]));
          } else {
            docs = docs.filter((doc) => doc[field] === value);
          }
        }
        return { docs: docs.map((data) => ({ data: () => data })) };
      }
    };
  }

  return {
    _collections: collections,
    collection(name) {
      const store = getCollection(name);
      const query = makeQuery(name, []);
      return {
        where: query.where,
        limit: query.limit,
        get: query.get,
        doc(id) {
          return {
            id,
            async create(value) {
              if (store.has(id)) {
                const err = new Error("ALREADY_EXISTS");
                err.code = 6;
                throw err;
              }
              store.set(id, { ...value });
            },
            async set(value, options) {
              const existing = options?.merge ? store.get(id) || {} : {};
              store.set(id, { ...existing, ...value });
            },
            async update(patch) {
              const existing = store.get(id);
              if (!existing) {
                const err = new Error("NOT_FOUND");
                err.code = 5;
                throw err;
              }
              store.set(id, applyUpdate(existing, patch));
            },
            async delete() {
              store.delete(id);
            },
            async get() {
              const data = store.get(id);
              return { exists: Boolean(data), data: () => data };
            }
          };
        }
      };
    }
  };
}

function makeFakeStorage() {
  const saved = new Map();
  return {
    _saved: saved,
    bucket() {
      return {
        file(key) {
          return {
            async save(body) { saved.set(key, body); },
            async getSignedUrl() { return [`https://signed.example/${key}`]; },
            async getMetadata() { return [{ size: 1, updated: "2026-06-05T00:00:00Z" }]; }
          };
        },
        async getFiles({ prefix } = {}) {
          const files = [...saved.keys()]
            .filter((key) => !prefix || key.startsWith(prefix))
            .map((name) => ({
              name,
              metadata: { size: 1, updated: "2026-06-05T00:00:00Z" },
              async getMetadata() { return [{ size: 1, updated: "2026-06-05T00:00:00Z" }]; },
              async getSignedUrl() { return [`https://signed.example/${name}`]; }
            }));
          return [files];
        }
      };
    }
  };
}

// ---- Seed helpers -----------------------------------------------------------

const CONTEST_SLUG = "kec-2026";

// Seed an OPEN no-roster person contest carrying the enforcement snapshot the
// session-bound serve paths read (enforcementConfigFor(contest)). The flat
// overrides map onto the contest's `enforcement` object (and top-level
// room_gate_enabled), so the call sites keep their pre-change shape.
function seedSettings(firestore, overrides = {}) {
  const {
    fullscreen_reentry_seconds, fullscreen_exit_limit, enforcement_mode,
    simplified_fullscreen_recovery, room_gate_enabled = true, ...rest
  } = overrides;
  const enforcement = {};
  if (fullscreen_reentry_seconds !== undefined) enforcement.fullscreen_reentry_seconds = fullscreen_reentry_seconds;
  if (fullscreen_exit_limit !== undefined) enforcement.fullscreen_exit_limit = fullscreen_exit_limit;
  if (enforcement_mode !== undefined) enforcement.mode = enforcement_mode;
  if (simplified_fullscreen_recovery !== undefined) enforcement.simplified_fullscreen_recovery = simplified_fullscreen_recovery;
  firestore.collection(process.env.CONTESTS_COLLECTION).doc(CONTEST_SLUG).set({
    slug: CONTEST_SLUG, name: CONTEST_SLUG, status: "open", listed: true,
    identity_mode: "person", identity_label: "Candidate ID",
    start_at: "2026-01-01T00:00:00.000Z",
    end_at: "2099-01-01T00:00:00.000Z",
    problems: [{ problem_id: "sum-two", points: null, order: 0 }],
    rooms: [], room_gate_enabled,
    ...(Object.keys(enforcement).length ? { enforcement } : {}),
    ...rest
  });
  // A direct contest-doc seed is the test's stand-in for createContest/
  // updateContest (which invalidate the hot-path read cache in prod). Invalidate
  // here too so a RE-seed within a single test is read fresh (G3 cache must be
  // transparent — D3 invariant). Harmless when the cache is disabled.
  invalidateContestDocCache(CONTEST_SLUG);
}

function seedSession(firestore, id, overrides = {}) {
  firestore.collection(process.env.SESSION_COLLECTION).doc(id).set({
    session_id: id, status: "active",
    // candidate_id makes personContestForSession resolve the contest (so the
    // session-bound enforcement serve reads the contest's snapshot); the frozen
    // hackerrank_username stays for the row/response fields that surface it.
    candidate_id: "alice", hackerrank_username: "Alice", username_norm: "alice",
    name: "Alice A", roll_number: "R1", email: "a@x.y", room: "Lab A-1",
    contest_slug: CONTEST_SLUG,
    storage_prefix: `contests/${CONTEST_SLUG}/sessions/alice/${id}/`,
    created_at: "2026-06-09T09:00:00.000Z",
    last_heartbeat_at: new Date().toISOString(),
    ...overrides
  });
}

function alertsIn(firestore) {
  return [...firestore._collections.get(process.env.ALERTS_COLLECTION)?.values() ?? []];
}

function sessionDoc(firestore, id) {
  return firestore._collections.get(process.env.SESSION_COLLECTION).get(id);
}

const adminHeaders = { "x-admin-password": "enf-admin-pass" };
const invigHeaders = { "x-invigilator-password": "enf-invig-pass" };

// ---- 1: enforcement snapshot field (contest doc) ---------------------------

test("public exam-config serves the enforcement block (defaults when the contest never set it)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore); // contest with no enforcement override
  const bare = await call(makeReq({ method: "GET", path: "/api/exam-config", query: { contest: CONTEST_SLUG } }));
  assert.equal(bare.statusCode, 200);
  assert.deepEqual(bare.body.enforcement, { fullscreen_reentry_seconds: 20, fullscreen_exit_limit: 2, mode: "block", simplified_fullscreen_recovery: false });
  seedSettings(firestore, { fullscreen_reentry_seconds: 45, enforcement_mode: "alert_first" });
  const configured = await call(makeReq({ method: "GET", path: "/api/exam-config", query: { contest: CONTEST_SLUG } }));
  assert.deepEqual(configured.body.enforcement, { fullscreen_reentry_seconds: 45, fullscreen_exit_limit: 2, mode: "alert_first", simplified_fullscreen_recovery: false });
});

test("session start: doc gains enforcement_exemptions {}; response carries enforcement + exemptions + locked_reason", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore, { fullscreen_exit_limit: 4 });
  const res = await call(makeReq({ method: "POST", path: "/api/session/start",
    body: { contest: CONTEST_SLUG, candidate_id: "alice", name: "Alice", roll_number: "R1", email: "a@x.y", consent_accepted: true } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.enforcement, { fullscreen_reentry_seconds: 20, fullscreen_exit_limit: 4, mode: "block", simplified_fullscreen_recovery: false });
  assert.deepEqual(res.body.enforcement_exemptions, {});
  assert.equal(res.body.locked_reason, null);
  const doc = sessionDoc(firestore, res.body.session_id);
  assert.deepEqual(doc.enforcement_exemptions, {});
  // v1.1 G1: the consent-text version in force is stamped on the session doc.
  assert.equal(doc.consent_accepted, true);
  assert.ok(typeof doc.consent_version === "string" && doc.consent_version.length > 0,
    `expected a non-empty consent_version, got ${JSON.stringify(doc.consent_version)}`);
});

test("heartbeat response carries enforcement config + the session's exemptions", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore, { enforcement_mode: "alert_first" });
  seedSession(firestore, "hb-1", { enforcement_exemptions: { fullscreen: true } });
  const res = await call(makeReq({ method: "POST", path: "/api/heartbeat",
    body: { session_id: "hb-1", recording_state: "combined:recording;screen:recording", visibility_state: "visible" } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.enforcement, { fullscreen_reentry_seconds: 20, fullscreen_exit_limit: 2, mode: "alert_first", simplified_fullscreen_recovery: false });
  assert.deepEqual(res.body.enforcement_exemptions, { fullscreen: true });
});

// ---- 2: POST /api/session/enforcement-violation ----------------------------

test("violation in block mode LOCKS the session with locked_reason and raises a critical alert", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "v-1");
  const res = await call(makeReq({ method: "POST", path: "/api/session/enforcement-violation",
    body: { session_id: "v-1", phase: "countdown_expired", exit_count: 2 } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.locked, true);
  assert.equal(res.body.locked_reason, "fullscreen_enforcement");
  const doc = sessionDoc(firestore, "v-1");
  assert.equal(doc.status, "locked");
  assert.equal(doc.locked_reason, "fullscreen_enforcement");
  const alerts = alertsIn(firestore);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, "fullscreen_enforcement");
  assert.equal(alerts[0].severity, "critical");
  assert.equal(alerts[0].session_id, "v-1");
  assert.equal(alerts[0].data.phase, "countdown_expired");
  assert.equal(alerts[0].data.exit_count, 2);
});

test("violation in alert_first mode raises the alert but does NOT lock", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore, { enforcement_mode: "alert_first" });
  seedSession(firestore, "v-2");
  const res = await call(makeReq({ method: "POST", path: "/api/session/enforcement-violation",
    body: { session_id: "v-2", phase: "exit_limit", exit_count: 3 } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.locked, false);
  assert.equal(res.body.mode, "alert_first");
  assert.equal(sessionDoc(firestore, "v-2").status, "active");
  assert.equal(alertsIn(firestore).length, 1);
});

test("violation on an exempt session is a no-op (no lock, no alert)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "v-3", { enforcement_exemptions: { fullscreen: true } });
  const res = await call(makeReq({ method: "POST", path: "/api/session/enforcement-violation",
    body: { session_id: "v-3", phase: "countdown_expired" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.locked, false);
  assert.equal(res.body.exempt, true);
  assert.equal(sessionDoc(firestore, "v-3").status, "active");
  assert.equal(alertsIn(firestore).length, 0);
});

test("violation rejects an unknown phase and a missing session", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "v-4");
  const bad = await call(makeReq({ method: "POST", path: "/api/session/enforcement-violation",
    body: { session_id: "v-4", phase: "whatever" } }));
  assert.equal(bad.statusCode, 400);
  const missing = await call(makeReq({ method: "POST", path: "/api/session/enforcement-violation",
    body: { session_id: "nope", phase: "countdown_expired" } }));
  assert.equal(missing.statusCode, 404);
});

// ---- 3: POST /api/session/unlock-gate + the unlock-code namespace -----------
//
// Wave-2 review fix: the unlock code is its OWN OTP (gate.unlock_otp), minted
// via /api/invigilator/unlock-code, NEVER the room START code — every candidate
// in an OTP-gated room personally typed the start code, so accepting it for
// unlocks made the L2 lock self-serve.

async function lockViaViolation(firestore, sessionId) {
  seedSession(firestore, sessionId);
  const res = await call(makeReq({ method: "POST", path: "/api/session/enforcement-violation",
    body: { session_id: sessionId, phase: "countdown_expired" } }));
  assert.equal(res.body.locked, true);
}

async function mintRoomOtp() {
  const res = await call(makeReq({ method: "POST", path: "/api/invigilator/release-code", headers: invigHeaders,
    body: { contest: CONTEST_SLUG, room: "Lab A-1", invigilator_name: "Invy" } }));
  assert.equal(res.statusCode, 200);
  return res.body.gate.otp;
}

async function mintUnlockCode(regenerate = false) {
  const res = await call(makeReq({ method: "POST", path: "/api/invigilator/unlock-code", headers: invigHeaders,
    body: { contest: CONTEST_SLUG, room: "Lab A-1", invigilator_name: "Invy", ...(regenerate ? { regenerate: true } : {}) } }));
  assert.equal(res.statusCode, 200);
  return res.body.gate.unlock_otp;
}

test("unlock-gate with the room's UNLOCK code releases an enforcement lock and clears locked_reason", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  await lockViaViolation(firestore, "u-1");
  const code = await mintUnlockCode();
  assert.match(code, /^\d{6}$/);
  const res = await call(makeReq({ method: "POST", path: "/api/session/unlock-gate",
    body: { session_id: "u-1", code } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "active");
  const doc = sessionDoc(firestore, "u-1");
  assert.equal(doc.status, "active");
  assert.equal(doc.locked_reason, null);
  assert.equal(doc.unlock_method, "room_code");
});

test("unlock-gate REJECTS the room START otp — candidates already know that code", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  await lockViaViolation(firestore, "u-1b");
  const startOtp = await mintRoomOtp();
  await mintUnlockCode(); // an unlock code EXISTS — the start code must still fail
  const res = await call(makeReq({ method: "POST", path: "/api/session/unlock-gate",
    body: { session_id: "u-1b", code: startOtp } }));
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "invalid_code");
  const doc = sessionDoc(firestore, "u-1b");
  assert.equal(doc.status, "locked");
  assert.equal(doc.unlock_attempt_count, 1);
});

test("unlock-gate rejects a wrong code with 403 and counts the attempt", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  await lockViaViolation(firestore, "u-2");
  const code = await mintUnlockCode();
  const wrong = code === "000000" ? "000001" : "000000";
  const res = await call(makeReq({ method: "POST", path: "/api/session/unlock-gate",
    body: { session_id: "u-2", code: wrong } }));
  assert.equal(res.statusCode, 403);
  assert.equal(sessionDoc(firestore, "u-2").unlock_attempt_count, 1);
});

test("unlock-gate refuses ADMIN locks (only enforcement locks are code-releasable)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "u-3", { status: "locked" }); // admin lock: no locked_reason
  const code = await mintUnlockCode();
  const res = await call(makeReq({ method: "POST", path: "/api/session/unlock-gate",
    body: { session_id: "u-3", code } }));
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "not_enforcement_locked");
  assert.equal(sessionDoc(firestore, "u-3").status, "locked");
});

test("unlock-gate attempt cap: capped session stays capped even with the right code; NaN counts as 0", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  await lockViaViolation(firestore, "u-4");
  const code = await mintUnlockCode();
  // Garbage attempt count (NaN guard): treated as 0, so the right code works.
  sessionDoc(firestore, "u-4").unlock_attempt_count = "garbage";
  const okRes = await call(makeReq({ method: "POST", path: "/api/session/unlock-gate",
    body: { session_id: "u-4", code } }));
  assert.equal(okRes.statusCode, 200);
  // Capped: 429 BEFORE the compare, even with the right code.
  await lockViaViolation(firestore, "u-5");
  sessionDoc(firestore, "u-5").unlock_attempt_count = 20;
  const capped = await call(makeReq({ method: "POST", path: "/api/session/unlock-gate",
    body: { session_id: "u-5", code } }));
  assert.equal(capped.statusCode, 429);
});

test("successful unlock RESETS unlock_attempt_count — a re-lock starts with fresh attempts (wave-3 fix)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  await lockViaViolation(firestore, "u-7");
  const code = await mintUnlockCode();
  // One wrong attempt away from the permanent cap when the proctor reads the
  // right code: the unlock must clear the counter, not carry 19 forward.
  sessionDoc(firestore, "u-7").unlock_attempt_count = 19;
  const ok = await call(makeReq({ method: "POST", path: "/api/session/unlock-gate",
    body: { session_id: "u-7", code } }));
  assert.equal(ok.statusCode, 200);
  assert.equal(sessionDoc(firestore, "u-7").unlock_attempt_count, 0);
  // Re-locked later the same exam: a single typo must NOT 429 the candidate.
  const relock = await call(makeReq({ method: "POST", path: "/api/session/enforcement-violation",
    body: { session_id: "u-7", phase: "countdown_expired" } }));
  assert.equal(relock.body.locked, true);
  const wrong = code === "000000" ? "000001" : "000000";
  const res = await call(makeReq({ method: "POST", path: "/api/session/unlock-gate",
    body: { session_id: "u-7", code: wrong } }));
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "invalid_code");
});

test("unlock-gate with NO unlock code minted → 403 no_unlock_code WITHOUT burning an attempt", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  // No gate doc at all.
  await lockViaViolation(firestore, "u-6");
  const noDoc = await call(makeReq({ method: "POST", path: "/api/session/unlock-gate",
    body: { session_id: "u-6", code: "123456" } }));
  assert.equal(noDoc.statusCode, 403);
  assert.equal(noDoc.body.error, "no_unlock_code");
  assert.equal(sessionDoc(firestore, "u-6").unlock_attempt_count, undefined);
  // A gate doc with ONLY a start code is the same: nothing to brute-force, so
  // the candidate's typing must not creep toward the 20-attempt permanent cap.
  await mintRoomOtp();
  const startOnly = await call(makeReq({ method: "POST", path: "/api/session/unlock-gate",
    body: { session_id: "u-6", code: "123456" } }));
  assert.equal(startOnly.statusCode, 403);
  assert.equal(startOnly.body.error, "no_unlock_code");
  assert.equal(sessionDoc(firestore, "u-6").unlock_attempt_count, undefined);
});

// ---- 3b: invigilator unlock-code + per-student unlock (gate-independent) ----
//
// Wave-2 review fix: with the default config (enforcement block + room gate
// DISABLED) every L2 lock used to dead-end on an admin. Both release paths the
// locked screen promises must work independent of the start gate.

test("invigilator unlock-code mints a 6-digit code even with the room gate DISABLED (default deployment)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore, { room_gate_enabled: false });
  // Contrast: the START-gate mint is still (correctly) refused.
  const release = await call(makeReq({ method: "POST", path: "/api/invigilator/release-code", headers: invigHeaders,
    body: { contest: CONTEST_SLUG, room: "Lab A-1", invigilator_name: "Invy" } }));
  assert.equal(release.statusCode, 400);
  assert.equal(release.body.error, "room_gate_disabled");
  // The UNLOCK code mints fine — and the full candidate release loop works.
  const code = await mintUnlockCode();
  assert.match(code, /^\d{6}$/);
  await lockViaViolation(firestore, "ug-1");
  const res = await call(makeReq({ method: "POST", path: "/api/session/unlock-gate",
    body: { session_id: "ug-1", code } }));
  assert.equal(res.statusCode, 200);
  assert.equal(sessionDoc(firestore, "ug-1").status, "active");
});

test("invigilator unlock-code: 401 without auth; idempotent re-display; regenerate mints fresh; START otp untouched", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  const noAuth = await call(makeReq({ method: "POST", path: "/api/invigilator/unlock-code",
    body: { contest: CONTEST_SLUG, room: "Lab A-1" } }));
  assert.equal(noAuth.statusCode, 401);
  const startOtp = await mintRoomOtp();
  const first = await mintUnlockCode();
  const second = await mintUnlockCode();
  assert.equal(second, first); // portal reload re-displays the SAME code
  const gates = firestore._collections.get(process.env.ROOM_GATES_COLLECTION);
  const gateDoc = gates.get("gate:kec-2026:Lab A-1");
  assert.equal(gateDoc.otp, startOtp);          // start code untouched
  assert.equal(gateDoc.unlock_otp, first);
  const regen = await call(makeReq({ method: "POST", path: "/api/invigilator/unlock-code", headers: invigHeaders,
    body: { contest: CONTEST_SLUG, room: "Lab A-1", invigilator_name: "Asha", regenerate: true } }));
  assert.match(regen.body.gate.unlock_otp, /^\d{6}$/);
  assert.equal(regen.body.gate.unlock_released_by, "Asha"); // rewrite proven (random code could collide)
  assert.equal(regen.body.gate.otp, startOtp);  // regenerating the unlock code never touches the start code
});

test("release-code and open-room PRESERVE a minted unlock code (no clobber on full doc rewrite)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  const code = await mintUnlockCode();
  const release = await call(makeReq({ method: "POST", path: "/api/invigilator/release-code", headers: invigHeaders,
    body: { contest: CONTEST_SLUG, room: "Lab A-1", invigilator_name: "Priya" } }));
  assert.equal(release.statusCode, 200);
  assert.equal(release.body.gate.unlock_otp, code);
  const open = await call(makeReq({ method: "POST", path: "/api/invigilator/open-room", headers: invigHeaders,
    body: { contest: CONTEST_SLUG, room: "Lab A-1", invigilator_name: "Asha" } }));
  assert.equal(open.statusCode, 200);
  assert.equal(open.body.gate.unlock_otp, code);
});

test("invigilator room response carries the unlock code fields on the gate projection", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore, { room_gate_enabled: false });
  const code = await mintUnlockCode();
  const res = await call(makeReq({ method: "GET", path: "/api/invigilator/room", headers: invigHeaders,
    query: { contest: CONTEST_SLUG, room: "Lab A-1" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.gate.unlock_otp, code);
  assert.equal(res.body.gate.unlock_released_by, "Invy");
});

test("POST /api/invigilator/unlock releases an ENFORCEMENT-locked student by room+username (gate disabled)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore, { room_gate_enabled: false });
  await lockViaViolation(firestore, "iu-1");
  const noAuth = await call(makeReq({ method: "POST", path: "/api/invigilator/unlock",
    body: { contest: CONTEST_SLUG, room: "Lab A-1", username: "alice" } }));
  assert.equal(noAuth.statusCode, 401);
  const res = await call(makeReq({ method: "POST", path: "/api/invigilator/unlock", headers: invigHeaders,
    body: { contest: CONTEST_SLUG, room: "Lab A-1", username: "alice" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.username, "Alice");
  assert.equal(res.body.status, "active");
  assert.equal(res.body.session_id, undefined); // least privilege: never echo the bearer token
  const doc = sessionDoc(firestore, "iu-1");
  assert.equal(doc.status, "active");
  assert.equal(doc.locked_reason, null);
  assert.equal(doc.unlock_method, "invigilator");
});

test("invigilator unlock refuses ADMIN locks; 404 when no locked session for that student in the room", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "iu-2", { status: "locked" }); // admin lock: no locked_reason
  const adminLock = await call(makeReq({ method: "POST", path: "/api/invigilator/unlock", headers: invigHeaders,
    body: { contest: CONTEST_SLUG, room: "Lab A-1", username: "alice" } }));
  assert.equal(adminLock.statusCode, 403);
  assert.equal(adminLock.body.error, "not_enforcement_locked");
  assert.equal(sessionDoc(firestore, "iu-2").status, "locked");
  const none = await call(makeReq({ method: "POST", path: "/api/invigilator/unlock", headers: invigHeaders,
    body: { contest: CONTEST_SLUG, room: "Lab A-1", username: "nobody" } }));
  assert.equal(none.statusCode, 404);
  assert.equal(none.body.error, "no_locked_session_in_room");
});

test("invigilator room rows carry locked_reason so the portal can offer Unlock only on enforcement locks", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  await lockViaViolation(firestore, "lr-1");
  seedSession(firestore, "lr-2", {
    session_id: "lr-2", status: "locked",
    hackerrank_username: "Bob", username_norm: "bob"
  }); // admin lock
  const res = await call(makeReq({ method: "GET", path: "/api/invigilator/room", headers: invigHeaders,
    query: { contest: CONTEST_SLUG, room: "Lab A-1" } }));
  assert.equal(res.statusCode, 200);
  const alice = res.body.sessions.find((row) => row.hackerrank_username === "Alice");
  const bob = res.body.sessions.find((row) => row.hackerrank_username === "Bob");
  assert.equal(alice.locked_reason, "fullscreen_enforcement");
  assert.equal(bob.locked_reason, null);
});

// ---- 4: exemptions — admin session-action + invigilator endpoint -----------

test("session-action exempt: sets sanitized exemptions (merge semantics, unknown keys dropped)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "x-1");
  const res = await call(makeReq({ method: "POST", path: "/api/admin/session-action", headers: adminHeaders,
    body: { action: "exempt", session_id: "x-1", exemptions: { fullscreen: true, bogus: true, switch_away: "yes" } } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(sessionDoc(firestore, "x-1").enforcement_exemptions, { fullscreen: true });
  // Merge: a later switch_away toggle keeps fullscreen.
  await call(makeReq({ method: "POST", path: "/api/admin/session-action", headers: adminHeaders,
    body: { action: "exempt", session_id: "x-1", exemptions: { switch_away: true } } }));
  assert.deepEqual(sessionDoc(firestore, "x-1").enforcement_exemptions, { fullscreen: true, switch_away: true });
  // Toggling off works too.
  await call(makeReq({ method: "POST", path: "/api/admin/session-action", headers: adminHeaders,
    body: { action: "exempt", session_id: "x-1", exemptions: { fullscreen: false } } }));
  assert.deepEqual(sessionDoc(firestore, "x-1").enforcement_exemptions, { fullscreen: false, switch_away: true });
});

test("session-action unlock clears locked_reason (admin unlock resets the enforcement lock)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  await lockViaViolation(firestore, "x-2");
  const res = await call(makeReq({ method: "POST", path: "/api/admin/session-action", headers: adminHeaders,
    body: { action: "unlock", session_id: "x-2" } }));
  assert.equal(res.statusCode, 200);
  const doc = sessionDoc(firestore, "x-2");
  assert.equal(doc.status, "active");
  assert.equal(doc.locked_reason, null);
});

test("invigilator exempt: requires auth, finds the live session by room+username, sets exemptions", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "x-3");
  const noAuth = await call(makeReq({ method: "POST", path: "/api/invigilator/exempt",
    body: { contest: CONTEST_SLUG, room: "Lab A-1", username: "alice", exemptions: { fullscreen: true } } }));
  assert.equal(noAuth.statusCode, 401);
  const res = await call(makeReq({ method: "POST", path: "/api/invigilator/exempt", headers: invigHeaders,
    body: { contest: CONTEST_SLUG, room: "Lab A-1", username: "alice", exemptions: { fullscreen: true } } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.enforcement_exemptions, { fullscreen: true });
  assert.deepEqual(sessionDoc(firestore, "x-3").enforcement_exemptions, { fullscreen: true });
  // Least privilege: never echo the session token.
  assert.equal(res.body.session_id, undefined);
});

test("invigilator exempt: 404 when no live session for that username in that room", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "x-4", { room: "Lab B-2" }); // different room
  seedSession(firestore, "x-5", { username_norm: "bob", hackerrank_username: "Bob", status: "ended" });
  const wrongRoom = await call(makeReq({ method: "POST", path: "/api/invigilator/exempt", headers: invigHeaders,
    body: { contest: CONTEST_SLUG, room: "Lab A-1", username: "alice", exemptions: { fullscreen: true } } }));
  assert.equal(wrongRoom.statusCode, 404);
  const endedOnly = await call(makeReq({ method: "POST", path: "/api/invigilator/exempt", headers: invigHeaders,
    body: { contest: CONTEST_SLUG, room: "Lab A-1", username: "bob", exemptions: { fullscreen: true } } }));
  assert.equal(endedOnly.statusCode, 404);
});

test("invigilator room rows carry enforcement_exemptions", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "x-6", { enforcement_exemptions: { switch_away: true } });
  const res = await call(makeReq({ method: "GET", path: "/api/invigilator/room", headers: invigHeaders,
    query: { contest: CONTEST_SLUG, room: "Lab A-1" } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.sessions[0].enforcement_exemptions, { switch_away: true });
});

// ---- 5: switch_away_episode → tab_away alert --------------------------------

async function postEpisode(sessionId, detail) {
  return call(makeReq({ method: "POST", path: "/api/events",
    body: { session_id: sessionId, events: [{ type: "switch_away_episode", timestamp: new Date().toISOString(), detail }] } }));
}

test("a LONG switch-away episode raises a tab_away alert with duration/count detail", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "sw-1");
  const res = await postEpisode("sw-1", { count: 1, duration_ms: 13_000 });
  assert.equal(res.statusCode, 200);
  const alerts = alertsIn(firestore).filter((a) => a.type === "tab_away");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, "warning");
  assert.equal(alerts[0].data.count, 1);
  assert.equal(alerts[0].data.duration_ms, 13_000);
});

test("a FREQUENT episode (3+ switches) alerts even when short; a short single switch does not", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "sw-2");
  await postEpisode("sw-2", { count: 1, duration_ms: 2_000 });
  assert.equal(alertsIn(firestore).filter((a) => a.type === "tab_away").length, 0);
  await postEpisode("sw-2", { count: 3, duration_ms: 2_000 });
  assert.equal(alertsIn(firestore).filter((a) => a.type === "tab_away").length, 1);
});

test("tab_away dedupe keys off SERVER time, never the client-supplied event timestamp (wave-3 fix)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "sw-5");
  // Two long episodes whose SPOOFED client timestamps sit days apart: with
  // client-keyed dedupe each minted its own alert (and a PINNED timestamp
  // could collapse every future episode into one, silencing the feed).
  // Server-minute keying folds this same-instant pair into ONE alert whose id
  // carries the server minute, not the spoofed 2020 stamps.
  const res = await call(makeReq({ method: "POST", path: "/api/events",
    body: { session_id: "sw-5", events: [
      { type: "switch_away_episode", timestamp: "2020-01-01T00:00:00.000Z", detail: { count: 1, duration_ms: 13_000 } },
      { type: "switch_away_episode", timestamp: "2020-01-02T00:00:00.000Z", detail: { count: 1, duration_ms: 14_000 } }
    ] } }));
  assert.equal(res.statusCode, 200);
  const alerts = alertsIn(firestore).filter((a) => a.type === "tab_away");
  assert.equal(alerts.length, 1);
  assert.ok(!alerts[0].id.includes("2020-01"), `dedupe key must not echo the client timestamp (got ${alerts[0].id})`);
});

test("the tab_away threshold_seconds setting governs the duration trigger", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  firestore.collection(process.env.SETTINGS_COLLECTION).doc("alert_settings").set({
    proctor: { tab_away: { enabled: true, severity: "warning", threshold_seconds: 60 } }
  });
  seedSession(firestore, "sw-3");
  await postEpisode("sw-3", { count: 1, duration_ms: 30_000 }); // below the 60s threshold
  assert.equal(alertsIn(firestore).filter((a) => a.type === "tab_away").length, 0);
  await postEpisode("sw-3", { count: 1, duration_ms: 61_000 });
  assert.equal(alertsIn(firestore).filter((a) => a.type === "tab_away").length, 1);
});

test("switch_away exemption suppresses the alert (episode still logs as an event)", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  seedSettings(firestore);
  seedSession(firestore, "sw-4", { enforcement_exemptions: { switch_away: true } });
  const res = await postEpisode("sw-4", { count: 5, duration_ms: 120_000 });
  assert.equal(res.statusCode, 200);
  assert.equal(alertsIn(firestore).filter((a) => a.type === "tab_away").length, 0);
  // The raw event still lands in evidence storage.
  const eventKeys = [...storage._saved.keys()].filter((k) => k.includes("events/events-"));
  assert.equal(eventKeys.length, 1);
});

test("fullscreen_enforcement appears in the proctor alert-settings catalog (admin-configurable)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  const res = await call(makeReq({ method: "GET", path: "/api/admin/alert-settings", headers: adminHeaders }));
  assert.equal(res.statusCode, 200);
  // Wave6 (product owner): show_to_invigilator DEFAULTS OFF — the admin opts each type in.
  assert.deepEqual(res.body.proctor.fullscreen_enforcement,
    { enabled: true, severity: "critical", show_to_invigilator: false });
});

test("a disabled fullscreen_enforcement alert type still locks in block mode (alert is display-only)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  firestore.collection(process.env.SETTINGS_COLLECTION).doc("alert_settings").set({
    proctor: { fullscreen_enforcement: { enabled: false, severity: "critical" } }
  });
  seedSession(firestore, "v-7");
  const res = await call(makeReq({ method: "POST", path: "/api/session/enforcement-violation",
    body: { session_id: "v-7", phase: "exit_limit", exit_count: 3 } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.locked, true);
  assert.equal(sessionDoc(firestore, "v-7").status, "locked");
  assert.equal(alertsIn(firestore).length, 0);
});

// ---- 6: SERVER-SIDE enforcement reconciliation -------------------------------
//
// Wave-2 review fix: the hard block used to exist only as a client self-report
// (one blocked URL or a cleared localStorage key neutralized F5.3 silently).
// The server now reconciles from the evidence it already receives: fullscreen
// exit/enter events drive a server-side exit counter + open-exit timestamp, and
// the heartbeat closes the countdown — the client POST is just the fast path.

function fsEvent(type, timestamp, detail) {
  return { type, timestamp, ...(detail ? { detail } : {}) };
}

async function postFsEvents(sessionId, events) {
  return call(makeReq({ method: "POST", path: "/api/events",
    body: { session_id: sessionId, events } }));
}

test("events: unexpected fullscreen exits past the limit lock the session server-side (no client report)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore); // defaults: limit 2, block mode
  seedSession(firestore, "fs-1");
  const res = await postFsEvents("fs-1", [
    fsEvent("fullscreen_exit", "2026-06-10T10:00:00.000Z"),
    fsEvent("fullscreen_enter", "2026-06-10T10:00:10.000Z"),
    fsEvent("fullscreen_exit", "2026-06-10T10:01:00.000Z"),
    fsEvent("fullscreen_enter", "2026-06-10T10:01:10.000Z"),
    fsEvent("fullscreen_exit", "2026-06-10T10:02:00.000Z")
  ]);
  assert.equal(res.statusCode, 200);
  const doc = sessionDoc(firestore, "fs-1");
  assert.equal(doc.status, "locked");
  assert.equal(doc.locked_reason, "fullscreen_enforcement");
  assert.equal(doc.fullscreen_exit_count, 3);
  const alerts = alertsIn(firestore).filter((a) => a.type === "fullscreen_enforcement");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].data.phase, "exit_limit");
  assert.equal(alerts[0].data.derived, "server");
});

test("events: expected exits don't count; the counter accumulates across batches and locks only past the limit", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "fs-2");
  await postFsEvents("fs-2", [
    fsEvent("fullscreen_exit", "2026-06-10T10:00:00.000Z", { expected: true }),
    fsEvent("fullscreen_exit", "2026-06-10T10:00:30.000Z")
  ]);
  let doc = sessionDoc(firestore, "fs-2");
  assert.equal(doc.fullscreen_exit_count, 1);
  assert.equal(doc.status, "active");
  await postFsEvents("fs-2", [fsEvent("fullscreen_exit", "2026-06-10T10:05:00.000Z")]);
  doc = sessionDoc(firestore, "fs-2");
  assert.equal(doc.fullscreen_exit_count, 2); // AT the limit — not past it
  assert.equal(doc.status, "active");
  await postFsEvents("fs-2", [fsEvent("fullscreen_exit", "2026-06-10T10:10:00.000Z")]);
  doc = sessionDoc(firestore, "fs-2");
  assert.equal(doc.fullscreen_exit_count, 3);
  assert.equal(doc.status, "locked");
});

test("events: fullscreen_out_since tracks the open exit and clears on re-enter", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "fs-3");
  await postFsEvents("fs-3", [fsEvent("fullscreen_exit", "2026-06-10T10:00:00.000Z")]);
  assert.equal(sessionDoc(firestore, "fs-3").fullscreen_out_since, "2026-06-10T10:00:00.000Z");
  await postFsEvents("fs-3", [fsEvent("fullscreen_enter", "2026-06-10T10:00:05.000Z")]);
  assert.equal(sessionDoc(firestore, "fs-3").fullscreen_out_since, null);
});

test("events: exempt sessions never lock server-side; alert_first mode alerts without locking", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "fs-4", { enforcement_exemptions: { fullscreen: true } });
  await postFsEvents("fs-4", [
    fsEvent("fullscreen_exit", "2026-06-10T10:00:00.000Z"),
    fsEvent("fullscreen_exit", "2026-06-10T10:01:00.000Z"),
    fsEvent("fullscreen_exit", "2026-06-10T10:02:00.000Z")
  ]);
  assert.equal(sessionDoc(firestore, "fs-4").status, "active");
  assert.equal(alertsIn(firestore).length, 0);

  const firestore2 = makeFakeFirestore();
  __setClientsForTest({ firestore: firestore2, storage: makeFakeStorage() });
  seedSettings(firestore2, { enforcement_mode: "alert_first" });
  seedSession(firestore2, "fs-5");
  await postFsEvents("fs-5", [
    fsEvent("fullscreen_exit", "2026-06-10T10:00:00.000Z"),
    fsEvent("fullscreen_exit", "2026-06-10T10:01:00.000Z"),
    fsEvent("fullscreen_exit", "2026-06-10T10:02:00.000Z")
  ]);
  assert.equal(sessionDoc(firestore2, "fs-5").status, "active");
  const alerts = alertsIn(firestore2).filter((a) => a.type === "fullscreen_enforcement");
  assert.equal(alerts.length, 1);
});

async function postHeartbeat(sessionId, extra = {}) {
  return call(makeReq({ method: "POST", path: "/api/heartbeat",
    body: { session_id: sessionId, recording_state: "combined:recording;screen:recording", visibility_state: "visible", ...extra } }));
}

test("heartbeat: a stale fullscreen_out_since locks (countdown reconciliation) and reports the locked status", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore); // reentry 20s; server grace 15s
  seedSession(firestore, "hb-fs-1", { fullscreen_out_since: new Date(Date.now() - 60_000).toISOString() });
  const res = await postHeartbeat("hb-fs-1", { fullscreen: false });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "locked");
  const doc = sessionDoc(firestore, "hb-fs-1");
  assert.equal(doc.status, "locked");
  assert.equal(doc.locked_reason, "fullscreen_enforcement");
  const alerts = alertsIn(firestore).filter((a) => a.type === "fullscreen_enforcement");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].data.phase, "countdown_expired");
  assert.equal(alerts[0].data.derived, "server");
});

test("heartbeat: an out_since still inside reentry+grace does NOT lock (honest client races win)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "hb-fs-2", { fullscreen_out_since: new Date(Date.now() - 10_000).toISOString() });
  const res = await postHeartbeat("hb-fs-2", { fullscreen: false });
  assert.equal(res.body.status, "active");
  assert.equal(sessionDoc(firestore, "hb-fs-2").status, "active");
});

test("heartbeat: fullscreen:true clears a stale out_since (lost enter event) — no lock", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "hb-fs-3", { fullscreen_out_since: new Date(Date.now() - 60_000).toISOString() });
  const res = await postHeartbeat("hb-fs-3", { fullscreen: true });
  assert.equal(res.body.status, "active");
  const doc = sessionDoc(firestore, "hb-fs-3");
  assert.equal(doc.status, "active");
  assert.equal(doc.fullscreen_out_since, null);
});

test("heartbeat: fullscreen:false STARTS the clock when no out_since (lost exit event) — no lock yet", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "hb-fs-4");
  const before = Date.now();
  const res = await postHeartbeat("hb-fs-4", { fullscreen: false });
  assert.equal(res.body.status, "active");
  const doc = sessionDoc(firestore, "hb-fs-4");
  assert.equal(doc.status, "active");
  const stamped = Date.parse(doc.fullscreen_out_since);
  assert.ok(stamped >= before && stamped <= Date.now());
});

test("heartbeat: countdown reconciliation respects the fullscreen exemption and alert_first mode", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "hb-fs-5", {
    enforcement_exemptions: { fullscreen: true },
    fullscreen_out_since: new Date(Date.now() - 600_000).toISOString()
  });
  const exempt = await postHeartbeat("hb-fs-5", { fullscreen: false });
  assert.equal(exempt.body.status, "active");
  assert.equal(sessionDoc(firestore, "hb-fs-5").status, "active");
  assert.equal(alertsIn(firestore).length, 0);

  const firestore2 = makeFakeFirestore();
  __setClientsForTest({ firestore: firestore2, storage: makeFakeStorage() });
  seedSettings(firestore2, { enforcement_mode: "alert_first" });
  seedSession(firestore2, "hb-fs-6", { fullscreen_out_since: new Date(Date.now() - 60_000).toISOString() });
  const held = await postHeartbeat("hb-fs-6", { fullscreen: false });
  assert.equal(held.body.status, "active");
  assert.equal(sessionDoc(firestore2, "hb-fs-6").status, "active");
  const alerts = alertsIn(firestore2).filter((a) => a.type === "fullscreen_enforcement");
  assert.equal(alerts.length, 1);
});

test("every unlock path RESETS the server-side exit counter — one later accident is L1 again, not an instant relock", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);

  // (a) admin session-action unlock
  seedSession(firestore, "rs-1", { status: "locked", locked_reason: "fullscreen_enforcement", fullscreen_exit_count: 3, fullscreen_out_since: "2026-06-10T10:00:00.000Z" });
  await call(makeReq({ method: "POST", path: "/api/admin/session-action", headers: adminHeaders,
    body: { action: "unlock", session_id: "rs-1" } }));
  let doc = sessionDoc(firestore, "rs-1");
  assert.equal(doc.fullscreen_exit_count, 0);
  assert.equal(doc.fullscreen_out_since, null);
  // A single accidental exit afterwards stays an L1 episode (no server lock).
  await postFsEvents("rs-1", [fsEvent("fullscreen_exit", "2026-06-10T11:00:00.000Z")]);
  doc = sessionDoc(firestore, "rs-1");
  assert.equal(doc.status, "active");
  assert.equal(doc.fullscreen_exit_count, 1);

  // (b) candidate unlock-gate with the unlock code
  seedSession(firestore, "rs-2", { status: "locked", locked_reason: "fullscreen_enforcement", fullscreen_exit_count: 3, fullscreen_out_since: "2026-06-10T10:00:00.000Z" });
  const code = await mintUnlockCode();
  await call(makeReq({ method: "POST", path: "/api/session/unlock-gate", body: { session_id: "rs-2", code } }));
  doc = sessionDoc(firestore, "rs-2");
  assert.equal(doc.status, "active");
  assert.equal(doc.fullscreen_exit_count, 0);
  assert.equal(doc.fullscreen_out_since, null);

  // (c) invigilator per-student unlock
  seedSession(firestore, "rs-3", { status: "locked", locked_reason: "fullscreen_enforcement", fullscreen_exit_count: 3, fullscreen_out_since: "2026-06-10T10:00:00.000Z",
    hackerrank_username: "Cara", username_norm: "cara" });
  await call(makeReq({ method: "POST", path: "/api/invigilator/unlock", headers: invigHeaders,
    body: { contest: CONTEST_SLUG, room: "Lab A-1", username: "cara" } }));
  doc = sessionDoc(firestore, "rs-3");
  assert.equal(doc.status, "active");
  assert.equal(doc.fullscreen_exit_count, 0);
  assert.equal(doc.fullscreen_out_since, null);
});

test("heartbeat: a legacy client WITHOUT the fullscreen field still gets the events-derived countdown", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "hb-fs-7", { fullscreen_out_since: new Date(Date.now() - 60_000).toISOString() });
  const res = await postHeartbeat("hb-fs-7"); // no fullscreen field at all
  assert.equal(res.body.status, "locked");
  assert.equal(sessionDoc(firestore, "hb-fs-7").status, "locked");
});

// ---- ALERT-1: candidate dispute + per-(user, test, type) alert suppression --
//
// The dispute POST is a candidate-authed self-report (sibling of
// enforcement-violation) that raises a distinct info-severity dispute_raised
// alert. The admin suppression list is the per-(user, test, alert-type)
// generalization of the per-session enforcement_exemption: a suppressed tuple is
// skipped at the upsertProctorAlert chokepoint, survives a fresh session, and is
// contest-scoped so it cannot bleed across tests.

function suppressionsDoc(firestore) {
  return firestore._collections.get(process.env.SETTINGS_COLLECTION)?.get("alert_suppressions");
}

async function suppress(body) {
  return call(makeReq({ method: "POST", path: "/api/admin/alert-suppression", headers: adminHeaders, body }));
}

test("dispute-alert raises a DISTINCT dispute_raised alert (info), idempotent per type per day", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "d-1");
  const res = await call(makeReq({ method: "POST", path: "/api/session/dispute-alert",
    body: { session_id: "d-1", disputed_type: "fullscreen_enforcement", note: "screen reader pulled focus" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.raised, true);
  const alerts = alertsIn(firestore);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, "dispute_raised");
  assert.equal(alerts[0].severity, "info");
  assert.equal(alerts[0].session_id, "d-1");
  assert.equal(alerts[0].data.disputed_type, "fullscreen_enforcement");
  assert.equal(alerts[0].data.note, "screen reader pulled focus");
  // Idempotent: a second click the same day collapses to ONE alert.
  await call(makeReq({ method: "POST", path: "/api/session/dispute-alert",
    body: { session_id: "d-1", disputed_type: "fullscreen_enforcement", note: "again" } }));
  assert.equal(alertsIn(firestore).length, 1, "same type+day dedupes to one dispute alert");
});

test("dispute-alert requires a valid, non-ended session (candidate-token auth, not admin)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  const missing = await call(makeReq({ method: "POST", path: "/api/session/dispute-alert",
    body: { session_id: "nope", disputed_type: "tab_away" } }));
  assert.equal(missing.statusCode, 404);
});

// B1 regression: the PRIMARY dispute case — a candidate disputing a block-mode
// fullscreen LOCK from the lock overlay. requireWritableSession would 403 a
// locked session (the frontend then falsely shows "Reported"); the dispute MUST
// succeed and raise the alert.
test("dispute-alert WORKS when the session is LOCKED (block-mode lock dispute — B1)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "d-locked", { status: "locked" });
  const res = await call(makeReq({ method: "POST", path: "/api/session/dispute-alert",
    body: { session_id: "d-locked", disputed_type: "fullscreen_enforcement", note: "locked by mistake" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.raised, true);
  const alerts = alertsIn(firestore);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, "dispute_raised");
});

// ...but an ENDED session cannot be disputed (the test is over → nothing actionable).
test("dispute-alert rejects an ENDED session (409)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "d-ended", { status: "ended" });
  const res = await call(makeReq({ method: "POST", path: "/api/session/dispute-alert",
    body: { session_id: "d-ended", disputed_type: "tab_away" } }));
  assert.equal(res.statusCode, 409);
});

test("dispute-alert honours the GLOBAL dispute_raised disable (spam control) — raises nothing", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "d-2");
  // Disable the dispute_raised type globally via alert-settings.
  const save = await call(makeReq({ method: "POST", path: "/api/admin/alert-settings", headers: adminHeaders,
    body: { proctor: { dispute_raised: { enabled: false, severity: "info" } } } }));
  assert.equal(save.statusCode, 200);
  const res = await call(makeReq({ method: "POST", path: "/api/session/dispute-alert",
    body: { session_id: "d-2", disputed_type: "tab_away" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.raised, false);
  assert.equal(alertsIn(firestore).length, 0);
});

test("admin suppress + list round-trip; a suppressed (user,test,type) is NOT raised at the chokepoint", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore); // enforcement mode "block" by default

  // 401 without admin auth (auth-first).
  const noAuth = await call(makeReq({ method: "POST", path: "/api/admin/alert-suppression",
    body: { action: "suppress", username_norm: "alice", contest_slug: CONTEST_SLUG, alert_type: "fullscreen_enforcement" } }));
  assert.equal(noAuth.statusCode, 401);

  // Suppress fullscreen_enforcement for alice in THIS contest.
  const s = await suppress({ action: "suppress", candidate_id: "alice", contest_slug: CONTEST_SLUG, alert_type: "fullscreen_enforcement", reason: "VPN flagged as IP change" });
  assert.equal(s.statusCode, 200);
  assert.equal(s.body.ok, true);
  assert.equal(s.body.entries.length, 1);
  assert.equal(s.body.entries[0].username_norm, "alice");
  assert.equal(s.body.entries[0].alert_type, "fullscreen_enforcement");
  assert.equal(s.body.entries[0].contest_slug, CONTEST_SLUG);

  // The list endpoint returns the same entry.
  const list = await call(makeReq({ method: "GET", path: "/api/admin/alert-suppressions", headers: adminHeaders }));
  assert.equal(list.statusCode, 200);
  assert.equal(list.body.entries.length, 1);

  // Now an enforcement violation that WOULD raise fullscreen_enforcement raises
  // NO alert (the chokepoint guard short-circuits) — but the lock still applies
  // (suppression hides the alert, never the enforcement: design §6).
  seedSession(firestore, "sup-1");
  const res = await call(makeReq({ method: "POST", path: "/api/session/enforcement-violation",
    body: { session_id: "sup-1", phase: "countdown_expired", exit_count: 2 } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.locked, true, "lock still applies; suppression hides the ALERT only");
  assert.equal(sessionDoc(firestore, "sup-1").status, "locked");
  assert.equal(alertsIn(firestore).length, 0, "the fullscreen_enforcement alert is suppressed");

  // Unsuppress restores the alert on the NEXT raise.
  const u = await suppress({ action: "unsuppress", candidate_id: "alice", contest_slug: CONTEST_SLUG, alert_type: "fullscreen_enforcement" });
  assert.equal(u.body.entries.length, 0);
  seedSession(firestore, "sup-2");
  await call(makeReq({ method: "POST", path: "/api/session/enforcement-violation",
    body: { session_id: "sup-2", phase: "countdown_expired", exit_count: 2 } }));
  assert.equal(alertsIn(firestore).length, 1, "after unsuppress the alert is raised again");
  assert.equal(alertsIn(firestore)[0].type, "fullscreen_enforcement");
});

test("suppress is idempotent and contest-scoped — cannot bleed across tests", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);

  // Double-suppress the same tuple → ONE entry (idempotent).
  await suppress({ action: "suppress", candidate_id: "alice", contest_slug: CONTEST_SLUG, alert_type: "fullscreen_enforcement" });
  const again = await suppress({ action: "suppress", candidate_id: "alice", contest_slug: CONTEST_SLUG, alert_type: "fullscreen_enforcement" });
  assert.equal(again.body.entries.length, 1, "re-suppressing the same tuple does not duplicate");

  // A suppression scoped to a DIFFERENT contest must NOT suppress this contest's
  // alert. alice is suppressed only in "other-contest".
  await suppress({ action: "unsuppress", candidate_id: "alice", contest_slug: CONTEST_SLUG, alert_type: "fullscreen_enforcement" });
  await suppress({ action: "suppress", candidate_id: "alice", contest_slug: "other-contest", alert_type: "fullscreen_enforcement" });
  seedSession(firestore, "scope-1"); // session is in CONTEST_SLUG (kec-2026)
  await call(makeReq({ method: "POST", path: "/api/session/enforcement-violation",
    body: { session_id: "scope-1", phase: "countdown_expired", exit_count: 2 } }));
  assert.equal(alertsIn(firestore).length, 1, "a suppression for another contest does NOT bleed into this one");
  assert.equal(alertsIn(firestore)[0].contest_slug, CONTEST_SLUG);
});

test("dispute_raised is NEVER suppressed at raise time — the dispute channel stays open", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "d-3");
  // An admin CAN add dispute_raised to the suppression list (it is a suppressible
  // type for list management), but the raise-time guard ALWAYS skips it: even with
  // a stale dispute_raised entry, a candidate can still flag a genuine mistake
  // (design §4.3). Suppressing it must NOT silence the dispute channel.
  const onList = await suppress({ action: "suppress", candidate_id: "alice", contest_slug: CONTEST_SLUG, alert_type: "dispute_raised" });
  assert.equal(onList.statusCode, 200, "dispute_raised is a valid suppressible type for the list");
  const res = await call(makeReq({ method: "POST", path: "/api/session/dispute-alert",
    body: { session_id: "d-3", disputed_type: "tab_away" } }));
  assert.equal(res.body.raised, true, "the dispute still raises despite a dispute_raised suppression entry");
  assert.equal(alertsIn(firestore).filter((a) => a.type === "dispute_raised").length, 1);
});

test("suppression POST rejects an unknown alert_type and a missing user (sanitizer allow-list)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  const badType = await suppress({ action: "suppress", candidate_id: "alice", contest_slug: CONTEST_SLUG, alert_type: "not_a_real_type" });
  assert.equal(badType.statusCode, 400);
  const noUser = await suppress({ action: "suppress", alert_type: "tab_away", contest_slug: CONTEST_SLUG });
  assert.equal(noUser.statusCode, 400);
  const badAction = await suppress({ action: "delete", candidate_id: "alice", alert_type: "tab_away" });
  assert.equal(badAction.statusCode, 400);
  assert.equal(suppressionsDoc(firestore), undefined, "no doc written on a rejected payload");
});

test("suppression survives a fresh session (per user+test, not per session doc)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  await suppress({ action: "suppress", candidate_id: "alice", contest_slug: CONTEST_SLUG, alert_type: "fullscreen_enforcement" });
  // A brand-new session doc for the same candidate+contest is still suppressed.
  seedSession(firestore, "fresh-session-id");
  await call(makeReq({ method: "POST", path: "/api/session/enforcement-violation",
    body: { session_id: "fresh-session-id", phase: "countdown_expired", exit_count: 2 } }));
  assert.equal(alertsIn(firestore).length, 0, "suppression carries across a new session (unlike a per-session exemption)");
});

// ---- LT-11: the canonical alert_type round-trip (raise → dispute → suppress →
// match all key on ONE type). The live bug: the candidate AnomalyPanel disputes
// with the RAW client reason "window_blur", but the alert the proctor saw was
// raised as "tab_away" (the switch-away episode). The dispute used to store the
// raw reason, so the admin's one-click Suppress sent a NON-catalog alert_type
// (rejected) and even a matching entry never hit the tab_away raise. We now
// canonicalize server-side so the candidate client is untouched.

// (i) Round-trip: a dispute raised with the raw client reason stores the CANONICAL
// catalog type the alert was actually raised under (window_blur → tab_away).
test("LT-11 (a): dispute window_blur is canonicalized to tab_away in data.disputed_type + dedupe", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "lt11-1");
  const res = await call(makeReq({ method: "POST", path: "/api/session/dispute-alert",
    body: { session_id: "lt11-1", disputed_type: "window_blur", note: "I only alt-tabbed to the clock" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.raised, true);
  const dispute = alertsIn(firestore).find((a) => a.type === "dispute_raised");
  assert.ok(dispute, "a dispute_raised alert was raised");
  assert.equal(dispute.data.disputed_type, "tab_away", "raw window_blur is stored as the canonical tab_away");
  assert.ok(dispute.id.includes("tab_away"), `dedupe key keys on the canonical type (got ${dispute.id})`);
  // page_hide → tab_hidden, fullscreen_exit → fullscreen_enforcement, and an
  // already-canonical / unknown type passes through unchanged.
  seedSession(firestore, "lt11-1b");
  await call(makeReq({ method: "POST", path: "/api/session/dispute-alert",
    body: { session_id: "lt11-1b", disputed_type: "page_hide" } }));
  assert.equal(alertsIn(firestore).find((a) => a.session_id === "lt11-1b").data.disputed_type, "tab_hidden");
  seedSession(firestore, "lt11-1c");
  await call(makeReq({ method: "POST", path: "/api/session/dispute-alert",
    body: { session_id: "lt11-1c", disputed_type: "fullscreen_enforcement" } }));
  assert.equal(alertsIn(firestore).find((a) => a.session_id === "lt11-1c").data.disputed_type, "fullscreen_enforcement");
});

// (ii) Suppress payload contract: the alert_type the admin console now sends for a
// window_blur dispute (the canonicalized tab_away) is a VALID catalog type and is
// accepted — where the raw client reason was rejected with the live error.
test("LT-11 (b): the canonical tab_away suppress payload is accepted; the raw window_blur was rejected", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  // What the console used to send (the disputed_type echoed raw) → 400, the live bug.
  const rawReason = await suppress({ action: "suppress", candidate_id: "alice", contest_slug: CONTEST_SLUG, alert_type: "window_blur" });
  assert.equal(rawReason.statusCode, 400, "a raw client reason is NOT a suppressible catalog type");
  // What it sends now (server canonicalized disputed_type → tab_away) → accepted.
  const canonical = await suppress({ action: "suppress", candidate_id: "alice", contest_slug: CONTEST_SLUG, alert_type: "tab_away" });
  assert.equal(canonical.statusCode, 200);
  assert.equal(canonical.body.entries.length, 1);
  assert.equal(canonical.body.entries[0].alert_type, "tab_away");
  assert.equal(canonical.body.entries[0].username_norm, "alice", "the user resolves from candidate_id");
});

// (iii) Match drop at the chokepoint: a (user, test, tab_away) suppression — the
// natural product of disputing a window_blur and clicking Suppress — actually
// drops the tab_away alert the switch-away episode raises. (iv) control: an
// un-suppressed candidate in the SAME contest still fires.
test("LT-11 (c)+(d): a tab_away suppression drops the switch-away raise; a non-suppressed candidate still fires", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  // Suppress tab_away for alice in this contest (what the fixed dispute→Suppress
  // flow produces from a window_blur dispute).
  await suppress({ action: "suppress", candidate_id: "alice", contest_slug: CONTEST_SLUG, alert_type: "tab_away" });
  // A long switch-away episode for alice WOULD raise tab_away — but it is dropped.
  seedSession(firestore, "lt11-sup", { candidate_id: "alice", username_norm: "alice" });
  await postEpisode("lt11-sup", { count: 1, duration_ms: 13_000 });
  assert.equal(alertsIn(firestore).filter((a) => a.type === "tab_away").length, 0, "the suppressed tab_away is dropped at the upsert chokepoint");
  // (iv) A DIFFERENT candidate in the same contest is NOT suppressed → still fires.
  seedSession(firestore, "lt11-other", { candidate_id: "bob", username_norm: "bob", hackerrank_username: "Bob",
    storage_prefix: `contests/${CONTEST_SLUG}/sessions/bob/lt11-other/` });
  await postEpisode("lt11-other", { count: 1, duration_ms: 13_000 });
  assert.equal(alertsIn(firestore).filter((a) => a.type === "tab_away" && a.username_norm === "bob").length, 1,
    "a non-suppressed candidate's tab_away still fires");
});
