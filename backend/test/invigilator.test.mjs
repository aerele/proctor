// backend/test/invigilator.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

// Env MUST be set before importing the handler (it reads env at module load).
// A unique ?invigilator query gives a fresh module instance independent of the
// other test files (which configure different collections).
process.env.EVIDENCE_BUCKET = "invig-bucket";
process.env.SESSION_COLLECTION = "invig_sessions";
process.env.SETTINGS_COLLECTION = "invig_settings";
process.env.ALERTS_COLLECTION = "invig_alerts";
process.env.ROOM_GATES_COLLECTION = "invig_room_gates";
process.env.SUBMISSIONS_COLLECTION = "invig_submissions";
process.env.LIVE_LOCK_COLLECTION = "invig_live_locks";
process.env.ADMIN_PASSWORD = "invig-admin-pass";
process.env.INVIGILATOR_PASSWORD = "invig-pass";

const handler = await import("../src/handler.mjs?invigilator");
const { api, __setClientsForTest, __setJudge0AdapterForTest } = handler;

// Inline req/res mocks + fakes, copied from phase2.test.mjs (NO helpers.mjs).
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

// ---- Fake Firestore (create / update / set / get / where / delete) ---------

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

// ---- Fake Storage (records saves; signs read/write URLs) ------------------

function makeFakeStorage() {
  const saved = new Map();
  return {
    _saved: saved,
    bucket() {
      return {
        file(key) {
          return {
            async save(body) {
              saved.set(key, body);
            },
            async getSignedUrl() {
              return [`https://signed.example/${key}`];
            },
            async getMetadata() {
              return [{ size: 1, updated: "2026-06-05T00:00:00Z" }];
            }
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

// Settings doc id is "active" (SETTINGS_ID). Default: a wide-open window for
// contest kec-2026 with the room gate ENABLED.
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

// An ACTIVE session in Lab A-1 of kec-2026 with a FRESH heartbeat (so it is
// never accidentally "disconnected"); override per test.
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

// ---- Task 1: auth + overview + settings plumbing ---------------------------

test("invigilator endpoints: 401 without a password, 401 with a wrong one", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  const noPass = await call(makeReq({ method: "GET", path: "/api/invigilator/overview" }));
  assert.equal(noPass.statusCode, 401);
  const wrong = await call(makeReq({ method: "GET", path: "/api/invigilator/overview",
    headers: { "x-invigilator-password": "nope" } }));
  assert.equal(wrong.statusCode, 401);
});

test("invigilator endpoints accept the ADMIN credential in either header", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  const viaAdminHeader = await call(makeReq({ method: "GET", path: "/api/invigilator/overview",
    headers: { "x-admin-password": "invig-admin-pass" } }));
  assert.equal(viaAdminHeader.statusCode, 200);
  const viaInvigHeader = await call(makeReq({ method: "GET", path: "/api/invigilator/overview",
    headers: { "x-invigilator-password": "invig-admin-pass" } }));
  assert.equal(viaInvigHeader.statusCode, 200);
});

test("closed-by-default: INVIGILATOR_PASSWORD unset rejects the invigilator header, admin still passes", async () => {
  // A second cache-busted import reads env at ITS load time, so deleting the
  // var here yields a module instance with no invigilator password configured.
  delete process.env.INVIGILATOR_PASSWORD;
  const h2 = await import("../src/handler.mjs?invigilator-nopass");
  process.env.INVIGILATOR_PASSWORD = "invig-pass"; // restore for later tests
  const firestore = makeFakeFirestore();
  h2.__setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  const call2 = async (req) => { const res = makeRes(); await h2.api(req, res); return res; };
  const viaInvig = await call2(makeReq({ method: "GET", path: "/api/invigilator/overview",
    headers: { "x-invigilator-password": "invig-pass" } }));
  assert.equal(viaInvig.statusCode, 401);
  const viaAdmin = await call2(makeReq({ method: "GET", path: "/api/invigilator/overview",
    headers: { "x-admin-password": "invig-admin-pass" } }));
  assert.equal(viaAdmin.statusCode, 200);
});

test("GET /api/invigilator/overview: rooms from the ACTIVE contest's sessions + gate flag", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "s1", { room: "Lab B-2" });
  seedSession(firestore, "s2", { room: "Lab A-1", username_norm: "bob", hackerrank_username: "Bob" });
  seedSession(firestore, "s3", { room: "", username_norm: "carl" });          // unassigned
  seedSession(firestore, "s4", { room: "Lab Z-9", contest_slug: "other" });   // other contest — excluded
  const res = await call(makeReq({ method: "GET", path: "/api/invigilator/overview",
    headers: { "x-invigilator-password": "invig-pass" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.contest_slug, "kec-2026");
  assert.equal(res.body.room_gate_enabled, true);
  assert.deepEqual(res.body.rooms, ["Lab A-1", "Lab B-2"]);
  assert.equal(res.body.has_unassigned, true);
});

test("room_gate_enabled round-trips through admin settings and appears in the start response", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  const save = await call(makeReq({ method: "POST", path: "/api/admin/settings",
    headers: { "x-admin-password": "invig-admin-pass" },
    body: { start_at: "2026-01-01T00:00:00.000Z", end_at: "2099-01-01T00:00:00.000Z",
            contest_url: "https://www.hackerrank.com/contests/kec-2026", room_gate_enabled: true } }));
  assert.equal(save.statusCode, 200);
  assert.equal(save.body.room_gate_enabled, true);
  const get = await call(makeReq({ method: "GET", path: "/api/admin/settings",
    headers: { "x-admin-password": "invig-admin-pass" } }));
  assert.equal(get.body.room_gate_enabled, true);
  // Candidate start response carries the flag → the client knows to show the
  // waiting room.
  const start = await call(makeReq({ method: "POST", path: "/api/session/start",
    body: { hackerrank_username: "Zoe", name: "Zoe Z", roll_number: "R9", email: "z@x.y",
            room: "Lab A-1", consent_accepted: true } }));
  assert.equal(start.statusCode, 200);
  assert.equal(start.body.room_gate_enabled, true);
});

test("CORS allows the x-invigilator-password header", async () => {
  const res = await call(makeReq({ method: "OPTIONS", path: "/api/invigilator/overview" }));
  assert.equal(res.statusCode, 204);
  assert.match(res.headers["access-control-allow-headers"], /x-invigilator-password/);
});

// ---- Task 2: release-code + open-room ---------------------------------------

test("POST /api/invigilator/release-code: 6-digit OTP, idempotent re-display, regenerate mints fresh", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  const first = await call(makeReq({ method: "POST", path: "/api/invigilator/release-code",
    headers: { "x-invigilator-password": "invig-pass" },
    body: { room: "Lab A-1", invigilator_name: "Priya" } }));
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.contest_slug, "kec-2026");
  assert.equal(first.body.gate.mode, "otp");
  assert.match(first.body.gate.otp, /^\d{6}$/);
  assert.equal(first.body.gate.released_by, "Priya");
  // stored under the deterministic gate id
  const gates = firestore._collections.get(process.env.ROOM_GATES_COLLECTION);
  assert.ok(gates.has("gate:kec-2026:Lab A-1"));
  // idempotent: a portal reload re-displays the SAME code
  const second = await call(makeReq({ method: "POST", path: "/api/invigilator/release-code",
    headers: { "x-invigilator-password": "invig-pass" },
    body: { room: "Lab A-1", invigilator_name: "Priya" } }));
  assert.equal(second.body.gate.otp, first.body.gate.otp);
  // regenerate writes a NEW gate doc (released_by proves the rewrite — the new
  // random code itself could collide one-in-a-million, so don't assert on it)
  const regen = await call(makeReq({ method: "POST", path: "/api/invigilator/release-code",
    headers: { "x-invigilator-password": "invig-pass" },
    body: { room: "Lab A-1", invigilator_name: "Asha", regenerate: true } }));
  assert.match(regen.body.gate.otp, /^\d{6}$/);
  assert.equal(regen.body.gate.released_by, "Asha");
});

test("POST /api/invigilator/open-room: start-now marks the room OPEN and keeps prior release info", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  const released = await call(makeReq({ method: "POST", path: "/api/invigilator/release-code",
    headers: { "x-invigilator-password": "invig-pass" },
    body: { room: "Lab A-1", invigilator_name: "Priya" } }));
  const open = await call(makeReq({ method: "POST", path: "/api/invigilator/open-room",
    headers: { "x-invigilator-password": "invig-pass" },
    body: { room: "Lab A-1", invigilator_name: "Asha" } }));
  assert.equal(open.statusCode, 200);
  assert.equal(open.body.gate.mode, "open");
  assert.equal(open.body.gate.opened_by, "Asha");
  assert.equal(open.body.gate.released_by, "Priya");                  // preserved
  assert.equal(open.body.gate.otp, released.body.gate.otp);           // preserved (re-arm support)
});

test("release-code / open-room: 400 room_gate_disabled when the admin toggle is off", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore, { room_gate_enabled: false });
  const release = await call(makeReq({ method: "POST", path: "/api/invigilator/release-code",
    headers: { "x-invigilator-password": "invig-pass" },
    body: { room: "Lab A-1", invigilator_name: "Priya" } }));
  assert.equal(release.statusCode, 400);
  assert.equal(release.body.error, "room_gate_disabled");
  const open = await call(makeReq({ method: "POST", path: "/api/invigilator/open-room",
    headers: { "x-invigilator-password": "invig-pass" },
    body: { room: "Lab A-1", invigilator_name: "Priya" } }));
  assert.equal(open.statusCode, 400);
});

test("release-code for the unassigned pseudo-room ('_') stores key '_' with a blank label", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  const res = await call(makeReq({ method: "POST", path: "/api/invigilator/release-code",
    headers: { "x-invigilator-password": "invig-pass" },
    body: { room: "_", invigilator_name: "Priya" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.gate.room_key, "_");
  assert.equal(res.body.gate.room, "");
  assert.ok(firestore._collections.get(process.env.ROOM_GATES_COLLECTION).has("gate:kec-2026:_"));
});

// ---- Task 3: candidate room-gate poll/unlock + exec enforcement -------------

test("room-gate: gate disabled -> started immediately, no doc writes", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore, { room_gate_enabled: false });
  seedSession(firestore, "s1");
  const res = await call(makeReq({ method: "POST", path: "/api/session/room-gate", body: { session_id: "s1" } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual({ gate_enabled: res.body.gate_enabled, exam_started: res.body.exam_started },
    { gate_enabled: false, exam_started: true });
  assert.equal(firestore._collections.get(process.env.SESSION_COLLECTION).get("s1").exam_started_at, undefined);
});

test("room-gate: waiting before any release; invigilator open-room auto-starts and stamps the session", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "s1");
  const waiting = await call(makeReq({ method: "POST", path: "/api/session/room-gate", body: { session_id: "s1" } }));
  assert.equal(waiting.statusCode, 200);
  assert.equal(waiting.body.exam_started, false);
  await call(makeReq({ method: "POST", path: "/api/invigilator/open-room",
    headers: { "x-invigilator-password": "invig-pass" }, body: { room: "Lab A-1", invigilator_name: "Priya" } }));
  const started = await call(makeReq({ method: "POST", path: "/api/session/room-gate", body: { session_id: "s1" } }));
  assert.equal(started.body.exam_started, true);
  const doc = firestore._collections.get(process.env.SESSION_COLLECTION).get("s1");
  assert.ok(doc.exam_started_at);
  assert.equal(doc.exam_start_method, "room_open");
  // idempotent replay
  const again = await call(makeReq({ method: "POST", path: "/api/session/room-gate", body: { session_id: "s1" } }));
  assert.equal(again.body.exam_started, true);
  assert.equal(again.body.exam_started_at, doc.exam_started_at);
});

test("room-gate: correct OTP starts; wrong OTP -> 403 invalid_code and counts the attempt", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "s1");
  const released = await call(makeReq({ method: "POST", path: "/api/invigilator/release-code",
    headers: { "x-invigilator-password": "invig-pass" }, body: { room: "Lab A-1", invigilator_name: "Priya" } }));
  const otp = released.body.gate.otp;
  const wrong = await call(makeReq({ method: "POST", path: "/api/session/room-gate",
    body: { session_id: "s1", code: "000000" === otp ? "999999" : "000000" } }));
  assert.equal(wrong.statusCode, 403);
  assert.equal(wrong.body.error, "invalid_code");
  assert.equal(firestore._collections.get(process.env.SESSION_COLLECTION).get("s1").gate_attempt_count, 1);
  const right = await call(makeReq({ method: "POST", path: "/api/session/room-gate",
    body: { session_id: "s1", code: otp } }));
  assert.equal(right.statusCode, 200);
  assert.equal(right.body.exam_started, true);
  assert.equal(firestore._collections.get(process.env.SESSION_COLLECTION).get("s1").exam_start_method, "otp");
});

test("room-gate: attempt cap -> 429 too_many_attempts (even with the right code)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "s1", { gate_attempt_count: 20 });
  const released = await call(makeReq({ method: "POST", path: "/api/invigilator/release-code",
    headers: { "x-invigilator-password": "invig-pass" }, body: { room: "Lab A-1", invigilator_name: "Priya" } }));
  const res = await call(makeReq({ method: "POST", path: "/api/session/room-gate",
    body: { session_id: "s1", code: released.body.gate.otp } }));
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.error, "too_many_attempts");
  // a code-less status poll still works (and start-now can still admit them)
  const poll = await call(makeReq({ method: "POST", path: "/api/session/room-gate", body: { session_id: "s1" } }));
  assert.equal(poll.statusCode, 200);
  assert.equal(poll.body.exam_started, false);
});

test("room-gate: unknown session 404; ended session 409 (ownership gate)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  const unknown = await call(makeReq({ method: "POST", path: "/api/session/room-gate", body: { session_id: "nope" } }));
  assert.equal(unknown.statusCode, 404);
  seedSession(firestore, "s1", { status: "ended" });
  const ended = await call(makeReq({ method: "POST", path: "/api/session/room-gate", body: { session_id: "s1" } }));
  assert.equal(ended.statusCode, 409);
});

test("exec run/submit blocked with 403 exam_not_started until released; allowed after", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "s1");
  __setJudge0AdapterForTest({ runBatch: async (items) => items.map(() => (
    { status: "accepted", passed: true, stdout: "", stderr: "", compileOutput: "", timeSec: 0, memoryKb: 1 })) });
  const blockedRun = await call(makeReq({ method: "POST", path: "/api/exec/run",
    body: { session_id: "s1", problem_id: "sum-two", language: "python", source_code: "x" } }));
  assert.equal(blockedRun.statusCode, 403);
  assert.equal(blockedRun.body.error, "exam_not_started");
  const blockedSubmit = await call(makeReq({ method: "POST", path: "/api/exec/submit",
    body: { session_id: "s1", problem_id: "sum-two", language: "python", source_code: "x" } }));
  assert.equal(blockedSubmit.statusCode, 403);
  // release via start-now, then run again
  await call(makeReq({ method: "POST", path: "/api/invigilator/open-room",
    headers: { "x-invigilator-password": "invig-pass" }, body: { room: "Lab A-1", invigilator_name: "Priya" } }));
  await call(makeReq({ method: "POST", path: "/api/session/room-gate", body: { session_id: "s1" } }));
  const allowed = await call(makeReq({ method: "POST", path: "/api/exec/run",
    body: { session_id: "s1", problem_id: "sum-two", language: "python", source_code: "x" } }));
  assert.equal(allowed.statusCode, 200);
  __setJudge0AdapterForTest(null);
});

// ---- Task 4: room dashboard --------------------------------------------------

function seedAlert(firestore, id, overrides = {}) {
  firestore.collection(process.env.ALERTS_COLLECTION).doc(id).set({
    id, source: "proctor", type: "recording_stopped", severity: "critical",
    timestamp: "2026-06-09T10:00:00.000Z", hackerrank_username: "Alice", username_norm: "alice",
    title: "Recording stopped", contest_slug: "kec-2026", room: "Lab A-1", session_id: "a1",
    video_key: "contests/kec-2026/sessions/alice/a1/screen/merged.webm",
    ...overrides
  });
}

test("GET /api/invigilator/room: room-scoped stats + least-privilege rows + gate + filtered alerts", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  const fresh = new Date().toISOString();
  seedSession(firestore, "a1");                                                            // live
  seedSession(firestore, "a2", { username_norm: "bob", hackerrank_username: "Bob", name: "Bob B",
    last_heartbeat_at: "2026-06-09T00:00:00.000Z" });                                      // live, stale -> disconnected
  seedSession(firestore, "a3", { username_norm: "carl", name: "Carl C", status: "locked" });
  seedSession(firestore, "a4", { username_norm: "dan", name: "Dan D", status: "ended", exam_started_at: fresh });
  seedSession(firestore, "b1", { username_norm: "eve", room: "Lab B-2" });                 // other room — excluded
  await call(makeReq({ method: "POST", path: "/api/invigilator/release-code",
    headers: { "x-invigilator-password": "invig-pass" }, body: { room: "Lab A-1", invigilator_name: "Priya" } }));
  seedAlert(firestore, "al1");
  seedAlert(firestore, "al2", { id: "al2", archived: true });                              // archived — excluded
  seedAlert(firestore, "al3", { id: "al3", room: "Lab B-2" });                             // other room — excluded
  const res = await call(makeReq({ method: "GET", path: "/api/invigilator/room",
    query: { room: "Lab A-1" }, headers: { "x-invigilator-password": "invig-pass" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.room, "Lab A-1");
  assert.deepEqual(res.body.stats,
    { live: 2, locked: 1, pending_approval: 0, finished: 1, disconnected: 1, started: 1, total: 4 });
  assert.equal(res.body.sessions.length, 4);
  const row = res.body.sessions.find((r) => r.session_id === "a1");
  assert.equal(row.name, "Alice A");
  assert.equal(row.roll_number, "R1");
  // least-privilege: NO email / IP / storage fields on rows
  assert.ok(!("email" in row) && !("start_ip" in row) && !("current_ip" in row) && !("storage_prefix" in row));
  assert.equal(res.body.sessions.find((r) => r.session_id === "a2").stale, true);
  assert.equal(res.body.sessions.find((r) => r.session_id === "a4").exam_started_at, fresh);
  // gate present with the released OTP
  assert.match(res.body.gate.otp, /^\d{6}$/);
  // alerts: room-scoped, archived excluded, NO media fields
  assert.deepEqual(res.body.alerts.map((a) => a.id), ["al1"]);
  assert.ok(!("video_key" in res.body.alerts[0]) && !("download_url" in res.body.alerts[0]));
});

test("GET /api/invigilator/room: room=_ selects blank-room sessions; room param required", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "u1", { room: "" });
  seedSession(firestore, "a1");
  const res = await call(makeReq({ method: "GET", path: "/api/invigilator/room",
    query: { room: "_" }, headers: { "x-invigilator-password": "invig-pass" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.room_key, "_");
  assert.deepEqual(res.body.sessions.map((r) => r.session_id), ["u1"]);
  const missing = await call(makeReq({ method: "GET", path: "/api/invigilator/room",
    headers: { "x-invigilator-password": "invig-pass" } }));
  assert.equal(missing.statusCode, 400);
});
