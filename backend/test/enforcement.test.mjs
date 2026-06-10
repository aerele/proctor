// backend/test/enforcement.test.mjs
//
// F5.3-6 — fullscreen enforcement ladder + per-session exemptions + switch-away
// episode alerting:
//   - admin settings gain fullscreen_reentry_seconds / fullscreen_exit_limit /
//     enforcement_mode (NaN-guarded, defaulted), served via exam-config,
//     start/resume, and the heartbeat response.
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
process.env.ALERTS_COLLECTION = "enf_alerts";
process.env.ROOM_GATES_COLLECTION = "enf_room_gates";
process.env.LIVE_LOCK_COLLECTION = "enf_live_locks";
process.env.ADMIN_PASSWORD = "enf-admin-pass";
process.env.INVIGILATOR_PASSWORD = "enf-invig-pass";

const handler = await import("../src/handler.mjs?enforcement");
const { api, __setClientsForTest } = handler;

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

function seedSettings(firestore, overrides = {}) {
  firestore.collection(process.env.SETTINGS_COLLECTION).doc("active").set({
    start_at: "2026-01-01T00:00:00.000Z",
    end_at: "2099-01-01T00:00:00.000Z",
    contest_url: "https://www.hackerrank.com/contests/kec-2026",
    contest_slug: "kec-2026",
    room_gate_enabled: true,
    ...overrides
  });
}

function seedSession(firestore, id, overrides = {}) {
  firestore.collection(process.env.SESSION_COLLECTION).doc(id).set({
    session_id: id, status: "active",
    hackerrank_username: "Alice", username_norm: "alice",
    name: "Alice A", roll_number: "R1", email: "a@x.y", room: "Lab A-1",
    contest_slug: "kec-2026",
    storage_prefix: `contests/kec-2026/sessions/alice/${id}/`,
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

// ---- 1: settings fields (defaults, validation, NaN guard) ------------------

test("admin settings: enforcement fields persist and round-trip", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  const res = await call(makeReq({ method: "POST", path: "/api/admin/settings", headers: adminHeaders,
    body: {
      start_at: "2026-06-10T03:00:00.000Z", end_at: "2026-06-10T08:00:00.000Z",
      fullscreen_reentry_seconds: 30, fullscreen_exit_limit: 5, enforcement_mode: "alert_first"
    } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.fullscreen_reentry_seconds, 30);
  assert.equal(res.body.fullscreen_exit_limit, 5);
  assert.equal(res.body.enforcement_mode, "alert_first");
  const get = await call(makeReq({ method: "GET", path: "/api/admin/settings", headers: adminHeaders }));
  assert.equal(get.body.fullscreen_reentry_seconds, 30);
  assert.equal(get.body.fullscreen_exit_limit, 5);
  assert.equal(get.body.enforcement_mode, "alert_first");
});

test("admin settings: an older payload WITHOUT enforcement fields preserves the stored values", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore, { fullscreen_reentry_seconds: 45, fullscreen_exit_limit: 0, enforcement_mode: "alert_first" });
  // Same rooms-style rule: a stale admin UI that doesn't know these fields
  // must not silently reset them to defaults.
  const res = await call(makeReq({ method: "POST", path: "/api/admin/settings", headers: adminHeaders,
    body: { start_at: "2026-01-01T00:00:00.000Z", end_at: "2099-01-01T00:00:00.000Z" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.fullscreen_reentry_seconds, 45);
  assert.equal(res.body.fullscreen_exit_limit, 0);
  assert.equal(res.body.enforcement_mode, "alert_first");
});

test("admin settings: garbage enforcement values fall back to defaults (NaN guard)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  const res = await call(makeReq({ method: "POST", path: "/api/admin/settings", headers: adminHeaders,
    body: {
      start_at: "2026-06-10T03:00:00.000Z", end_at: "2026-06-10T08:00:00.000Z",
      fullscreen_reentry_seconds: "garbage", fullscreen_exit_limit: -3, enforcement_mode: "explode"
    } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.fullscreen_reentry_seconds, 20);
  assert.equal(res.body.fullscreen_exit_limit, 2);
  assert.equal(res.body.enforcement_mode, "block");
});

test("public exam-config serves the enforcement block (defaults with no settings doc)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  const bare = await call(makeReq({ method: "GET", path: "/api/exam-config" }));
  assert.equal(bare.statusCode, 200);
  assert.deepEqual(bare.body.enforcement, { fullscreen_reentry_seconds: 20, fullscreen_exit_limit: 2, mode: "block" });
  seedSettings(firestore, { fullscreen_reentry_seconds: 45, enforcement_mode: "alert_first" });
  const configured = await call(makeReq({ method: "GET", path: "/api/exam-config" }));
  assert.deepEqual(configured.body.enforcement, { fullscreen_reentry_seconds: 45, fullscreen_exit_limit: 2, mode: "alert_first" });
});

test("session start: doc gains enforcement_exemptions {}; response carries enforcement + exemptions + locked_reason", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore, { fullscreen_exit_limit: 4 });
  const res = await call(makeReq({ method: "POST", path: "/api/session/start",
    body: { hackerrank_username: "alice", name: "Alice", roll_number: "R1", email: "a@x.y", consent_accepted: true } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.enforcement, { fullscreen_reentry_seconds: 20, fullscreen_exit_limit: 4, mode: "block" });
  assert.deepEqual(res.body.enforcement_exemptions, {});
  assert.equal(res.body.locked_reason, null);
  const doc = sessionDoc(firestore, res.body.session_id);
  assert.deepEqual(doc.enforcement_exemptions, {});
});

test("heartbeat response carries enforcement config + the session's exemptions", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore, { enforcement_mode: "alert_first" });
  seedSession(firestore, "hb-1", { enforcement_exemptions: { fullscreen: true } });
  const res = await call(makeReq({ method: "POST", path: "/api/heartbeat",
    body: { session_id: "hb-1", recording_state: "combined:recording;screen:recording", visibility_state: "visible" } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.enforcement, { fullscreen_reentry_seconds: 20, fullscreen_exit_limit: 2, mode: "alert_first" });
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

// ---- 3: POST /api/session/unlock-gate ---------------------------------------

async function lockViaViolation(firestore, sessionId) {
  seedSession(firestore, sessionId);
  const res = await call(makeReq({ method: "POST", path: "/api/session/enforcement-violation",
    body: { session_id: sessionId, phase: "countdown_expired" } }));
  assert.equal(res.body.locked, true);
}

async function mintRoomOtp() {
  const res = await call(makeReq({ method: "POST", path: "/api/invigilator/release-code", headers: invigHeaders,
    body: { room: "Lab A-1", invigilator_name: "Invy" } }));
  assert.equal(res.statusCode, 200);
  return res.body.gate.otp;
}

test("unlock-gate with the room OTP releases an enforcement lock and clears locked_reason", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  await lockViaViolation(firestore, "u-1");
  const otp = await mintRoomOtp();
  const res = await call(makeReq({ method: "POST", path: "/api/session/unlock-gate",
    body: { session_id: "u-1", code: otp } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "active");
  const doc = sessionDoc(firestore, "u-1");
  assert.equal(doc.status, "active");
  assert.equal(doc.locked_reason, null);
});

test("unlock-gate rejects a wrong code with 403 and counts the attempt", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  await lockViaViolation(firestore, "u-2");
  await mintRoomOtp();
  const res = await call(makeReq({ method: "POST", path: "/api/session/unlock-gate",
    body: { session_id: "u-2", code: "000000" } }));
  assert.equal(res.statusCode, 403);
  assert.equal(sessionDoc(firestore, "u-2").unlock_attempt_count, 1);
});

test("unlock-gate refuses ADMIN locks (only enforcement locks are code-releasable)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "u-3", { status: "locked" }); // admin lock: no locked_reason
  const otp = await mintRoomOtp();
  const res = await call(makeReq({ method: "POST", path: "/api/session/unlock-gate",
    body: { session_id: "u-3", code: otp } }));
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "not_enforcement_locked");
  assert.equal(sessionDoc(firestore, "u-3").status, "locked");
});

test("unlock-gate attempt cap: capped session stays capped even with the right code; NaN counts as 0", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  await lockViaViolation(firestore, "u-4");
  const otp = await mintRoomOtp();
  // Garbage attempt count (NaN guard): treated as 0, so the right code works.
  sessionDoc(firestore, "u-4").unlock_attempt_count = "garbage";
  const okRes = await call(makeReq({ method: "POST", path: "/api/session/unlock-gate",
    body: { session_id: "u-4", code: otp } }));
  assert.equal(okRes.statusCode, 200);
  // Capped: 429 BEFORE the compare, even with the right code.
  await lockViaViolation(firestore, "u-5");
  sessionDoc(firestore, "u-5").unlock_attempt_count = 20;
  const capped = await call(makeReq({ method: "POST", path: "/api/session/unlock-gate",
    body: { session_id: "u-5", code: otp } }));
  assert.equal(capped.statusCode, 429);
});

test("unlock-gate with no gate doc minted yet rejects as invalid_code", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  await lockViaViolation(firestore, "u-6");
  const res = await call(makeReq({ method: "POST", path: "/api/session/unlock-gate",
    body: { session_id: "u-6", code: "123456" } }));
  assert.equal(res.statusCode, 403);
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
    body: { room: "Lab A-1", username: "alice", exemptions: { fullscreen: true } } }));
  assert.equal(noAuth.statusCode, 401);
  const res = await call(makeReq({ method: "POST", path: "/api/invigilator/exempt", headers: invigHeaders,
    body: { room: "Lab A-1", username: "alice", exemptions: { fullscreen: true } } }));
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
    body: { room: "Lab A-1", username: "alice", exemptions: { fullscreen: true } } }));
  assert.equal(wrongRoom.statusCode, 404);
  const endedOnly = await call(makeReq({ method: "POST", path: "/api/invigilator/exempt", headers: invigHeaders,
    body: { room: "Lab A-1", username: "bob", exemptions: { fullscreen: true } } }));
  assert.equal(endedOnly.statusCode, 404);
});

test("invigilator room rows carry enforcement_exemptions", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "x-6", { enforcement_exemptions: { switch_away: true } });
  const res = await call(makeReq({ method: "GET", path: "/api/invigilator/room", headers: invigHeaders,
    query: { room: "Lab A-1" } }));
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
  assert.deepEqual(res.body.proctor.fullscreen_enforcement,
    { enabled: true, severity: "critical", show_to_invigilator: true });
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
