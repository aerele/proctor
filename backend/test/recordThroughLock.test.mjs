// backend/test/recordThroughLock.test.mjs
//
// B5 / LT-4 (DEC-1) — RECORD-THROUGH-LOCK, the BOUNDED locked-tolerant bypass.
//
// When a session LOCKS, the candidate's recorder is kept ALIVE on the client
// (StudentApp onLocked no longer stops it) so the maintainer can SEE what the
// candidate does during a lock. For that, /api/upload-url and /api/heartbeat must
// accept a `locked` session — but ONLY within a bounded window, never
// unconditionally. The bound (recordingThroughLock: status==="locked" AND within
// LOCK_RECORD_GRACE_MS of locked_at) is the real protection:
//
//   MA-2 — the upload path is authed ONLY by the unguessable session_id token (no
//   ownership/contest scope). An UNBOUNDED `status==="locked"` bypass would let any
//   locked/abandoned/leaked session mint signed write URLs + create GCS objects
//   INDEFINITELY (archival cost = object COUNT). So the TIME BOUND is the defense.
//
//   MA-3 — BOTH lock origins stamp `status:"locked", locked_at:now` identically
//   (enforcement lock enforcement.mjs:104-109; admin lock adminSessions.mjs:987),
//   so both keep recording within the window. The predicate keys on status +
//   locked_at only — origin-agnostic.
//
// A locked session STILL cannot exec or submit (those keep requireWritableSession
// → 403): the bypass is surgical to chunk-upload + heartbeat.
//
// All Firestore/Storage access is mocked through __setClientsForTest — no real GCP.
import { test } from "node:test";
import assert from "node:assert/strict";

// Env MUST be set before importing the handler (it reads env at module load). A
// unique ?recordThroughLock query string gives a fresh module instance.
process.env.EVIDENCE_BUCKET = "rtl-bucket";
process.env.SESSION_COLLECTION = "rtl_sessions";
process.env.SETTINGS_COLLECTION = "rtl_settings";
process.env.CONTESTS_COLLECTION = "rtl_contests";
process.env.ALERTS_COLLECTION = "rtl_alerts";
process.env.ROOM_GATES_COLLECTION = "rtl_room_gates";
process.env.LIVE_LOCK_COLLECTION = "rtl_live_locks";
process.env.SUBMISSIONS_COLLECTION = "rtl_submissions";
process.env.ADMIN_PASSWORD = "rtl-admin-pass";

const handler = await import("../src/handler.mjs?recordThroughLock");
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
    if (isIncrementSentinel(value)) next[key] = Number(next[key] || 0) + value.operand;
    else next[key] = value;
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
      where(field, op, value) { return makeQuery(name, [...filters, { field, op, value }]); },
      limit() { return this; },
      orderBy() { return this; },
      async get() {
        const store = getCollection(name);
        let docs = [...store.values()];
        for (const { field, op, value } of filters) {
          if (op === "in") docs = docs.filter((doc) => Array.isArray(value) && value.includes(doc[field]));
          else docs = docs.filter((doc) => doc[field] === value);
        }
        return { empty: docs.length === 0, docs: docs.map((data) => ({ data: () => data })) };
      }
    };
  }
  return {
    _collections: collections,
    collection(name) {
      const store = getCollection(name);
      const query = makeQuery(name, []);
      return {
        where: query.where, limit: query.limit, orderBy: query.orderBy, get: query.get,
        doc(id) {
          return {
            id,
            async create(value) {
              if (store.has(id)) { const err = new Error("ALREADY_EXISTS"); err.code = 6; throw err; }
              store.set(id, { ...value });
            },
            async set(value, options) {
              const existing = options?.merge ? store.get(id) || {} : {};
              store.set(id, { ...existing, ...value });
            },
            async update(patch) {
              const existing = store.get(id);
              if (!existing) { const err = new Error("NOT_FOUND"); err.code = 5; throw err; }
              store.set(id, applyUpdate(existing, patch));
            },
            async delete() { store.delete(id); },
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

const CONTEST_SLUG = "rtl-2026";

// LOCK_RECORD_GRACE_MS is 15 min (handler.mjs). "within window" / "past window"
// anchor relative to that bound.
const WITHIN_WINDOW_MS = 5 * 60_000;   // 5 min after lock — well inside 15 min
const PAST_WINDOW_MS = 20 * 60_000;    // 20 min after lock — well past 15 min

function seedContest(firestore) {
  firestore.collection(process.env.CONTESTS_COLLECTION).doc(CONTEST_SLUG).set({
    slug: CONTEST_SLUG, name: CONTEST_SLUG, status: "open", listed: true,
    identity_mode: "person", identity_label: "Candidate ID",
    start_at: "2026-01-01T00:00:00.000Z",
    end_at: "2099-01-01T00:00:00.000Z",
    problems: [{ problem_id: "sum-two", points: null, order: 0 }],
    rooms: [], room_gate_enabled: false,
    // Block-mode enforcement so a stale fullscreen_out_since LOCKS via the
    // heartbeat countdown reconciliation (the real enforcement-lock origin).
    enforcement: { fullscreen_reentry_seconds: 20, fullscreen_exit_limit: 3, mode: "block" }
  });
  invalidateContestDocCache(CONTEST_SLUG);
}

function seedSession(firestore, id, overrides = {}) {
  firestore.collection(process.env.SESSION_COLLECTION).doc(id).set({
    session_id: id, status: "active",
    candidate_id: "alice", hackerrank_username: "Alice", username_norm: "alice",
    name: "Alice A", roll_number: "R1", email: "a@x.y", room: "Lab A-1",
    contest_slug: CONTEST_SLUG,
    storage_prefix: `contests/${CONTEST_SLUG}/sessions/alice/${id}/`,
    created_at: "2026-06-09T09:00:00.000Z",
    chunk_count: 0, camera_chunk_count: 0,
    last_heartbeat_at: new Date().toISOString(),
    ...overrides
  });
}

function sessionDoc(firestore, id) {
  return firestore._collections.get(process.env.SESSION_COLLECTION).get(id);
}

const adminHeaders = { "x-admin-password": "rtl-admin-pass" };

function uploadUrl(sessionId, overrides = {}) {
  return call(makeReq({ method: "POST", path: "/api/upload-url", body: {
    session_id: sessionId, kind: "screen", chunk_index: 1, content_type: "video/webm", ...overrides
  } }));
}
function heartbeat(sessionId, extra = {}) {
  return call(makeReq({ method: "POST", path: "/api/heartbeat", body: {
    session_id: sessionId, recording_state: "combined:recording;screen:recording", visibility_state: "visible", ...extra
  } }));
}

// =====================================================================
// Test 1 — locked WITHIN the window CAN mint an upload URL
// =====================================================================

test("upload-url: a locked session WITHIN the record-through-lock window gets a signed URL", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSession(firestore, "rtl-within", {
    status: "locked", locked_at: new Date(Date.now() - WITHIN_WINDOW_MS).toISOString()
  });
  const res = await uploadUrl("rtl-within");
  assert.equal(res.statusCode, 200, "within-window locked session is tolerated");
  assert.equal(res.body.storage_key, "contests/rtl-2026/sessions/alice/rtl-within/screen/chunk-00001.webm");
  assert.equal(sessionDoc(firestore, "rtl-within").chunk_count, 1, "chunk counted — a real signed write");
});

// =====================================================================
// Test 2 — locked PAST the window CANNOT (403 session_locked)
// =====================================================================

test("upload-url: a locked session PAST the window is refused 403 session_locked (post-lock minting stops)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSession(firestore, "rtl-past", {
    status: "locked", locked_at: new Date(Date.now() - PAST_WINDOW_MS).toISOString()
  });
  const res = await uploadUrl("rtl-past");
  assert.equal(res.statusCode, 403, "past the bound the token-only path can no longer mint objects");
  assert.equal(res.body.error, "session_locked");
  assert.equal(sessionDoc(firestore, "rtl-past").chunk_count, 0, "no chunk counted — nothing signed");
});

test("upload-url: a locked session with a MISSING/garbage locked_at is refused 403 (no unbounded fallback)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSession(firestore, "rtl-nols", { status: "locked" }); // no locked_at
  const noStamp = await uploadUrl("rtl-nols");
  assert.equal(noStamp.statusCode, 403, "an un-stamped locked session is NOT tolerated (fails closed)");
  seedSession(firestore, "rtl-badls", { status: "locked", locked_at: "not-a-date" });
  const badStamp = await uploadUrl("rtl-badls");
  assert.equal(badStamp.statusCode, 403, "an unparseable locked_at is NOT tolerated (fails closed)");
});

// =====================================================================
// Test 3 — the same bounded tolerance applies to heartbeat; status stays honest
// =====================================================================

test("heartbeat: a locked session WITHIN the window is accepted; the response status stays HONEST (locked)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedContest(firestore);
  seedSession(firestore, "rtl-hb-within", {
    status: "locked", locked_at: new Date(Date.now() - WITHIN_WINDOW_MS).toISOString()
  });
  const res = await heartbeat("rtl-hb-within");
  assert.equal(res.statusCode, 200, "within-window locked heartbeat keeps the upload loop alive");
  assert.equal(res.body.status, "locked", "response status is honest — the client still KNOWS it's locked");
  assert.ok(sessionDoc(firestore, "rtl-hb-within").last_heartbeat_at, "heartbeat recorded");
});

test("heartbeat: a locked session PAST the window is refused 403 session_locked", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedContest(firestore);
  seedSession(firestore, "rtl-hb-past", {
    status: "locked", locked_at: new Date(Date.now() - PAST_WINDOW_MS).toISOString()
  });
  const res = await heartbeat("rtl-hb-past");
  assert.equal(res.statusCode, 403, "past the bound the heartbeat goes back through the writable gate");
  assert.equal(res.body.error, "session_locked");
});

// =====================================================================
// Test 4 — bound covers BOTH lock origins (admin lock + enforcement lock),
// both of which stamp locked_at
// =====================================================================

test("MA-3: an ADMIN lock stamps locked_at and is then tolerated for upload within the window", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSession(firestore, "rtl-admin");
  // Drive the REAL admin lock action (adminSessions.mjs:987 → status locked + locked_at).
  const lockRes = await call(makeReq({
    method: "POST", path: "/api/admin/session-action", headers: adminHeaders,
    body: { session_id: "rtl-admin", action: "lock" }
  }));
  assert.equal(lockRes.statusCode, 200);
  const doc = sessionDoc(firestore, "rtl-admin");
  assert.equal(doc.status, "locked");
  assert.ok(Number.isFinite(Date.parse(doc.locked_at)), "admin lock stamped a parseable locked_at");
  // Just-locked → inside the window → upload tolerated.
  const res = await uploadUrl("rtl-admin");
  assert.equal(res.statusCode, 200, "an admin-locked session keeps recording within the window");
});

test("MA-3: an ENFORCEMENT lock (heartbeat countdown) stamps locked_at and is then tolerated for upload within the window", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedContest(firestore);
  // A stale fullscreen_out_since past reentry+grace → the heartbeat reconciliation
  // LOCKS (enforcement.mjs:104-109 → status locked + locked_at + locked_reason).
  seedSession(firestore, "rtl-enf", {
    fullscreen_out_since: new Date(Date.now() - 60_000).toISOString()
  });
  const lockHb = await heartbeat("rtl-enf", { fullscreen: false });
  assert.equal(lockHb.body.status, "locked", "the stale out_since locked the session");
  const doc = sessionDoc(firestore, "rtl-enf");
  assert.equal(doc.status, "locked");
  assert.equal(doc.locked_reason, "fullscreen_enforcement", "enforcement origin");
  assert.ok(Number.isFinite(Date.parse(doc.locked_at)), "enforcement lock stamped a parseable locked_at");
  // Just-locked → inside the window → upload tolerated (the origin doesn't matter,
  // the predicate keys on status + locked_at only).
  const res = await uploadUrl("rtl-enf");
  assert.equal(res.statusCode, 200, "an enforcement-locked session keeps recording within the window");
});

// =====================================================================
// Test 5 — a locked session still CANNOT exec or submit (stay 403)
// =====================================================================

test("exec/submit: a locked session (even within the record-through-lock window) STILL gets 403 — the bypass is upload/heartbeat ONLY", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  // Within the window — upload would be tolerated, but exec/submit must NOT be.
  seedSession(firestore, "rtl-exec", {
    status: "locked", locked_at: new Date(Date.now() - WITHIN_WINDOW_MS).toISOString()
  });

  const runRes = await call(makeReq({ method: "POST", path: "/api/exec/run", body: {
    session_id: "rtl-exec", problem_id: "sum-two", language: "python", source_code: "print(1)"
  } }));
  assert.equal(runRes.statusCode, 403, "exec/run keeps requireWritableSession → 403 while locked");
  assert.equal(runRes.body.error, "session_locked");

  const submitRes = await call(makeReq({ method: "POST", path: "/api/exec/submit", body: {
    session_id: "rtl-exec", problem_id: "sum-two", language: "python", source_code: "print(1)"
  } }));
  assert.equal(submitRes.statusCode, 403, "exec/submit keeps requireWritableSession → 403 while locked");
  assert.equal(submitRes.body.error, "session_locked");

  // Sanity: the SAME within-window session DOES mint an upload URL — proving the
  // bypass is surgical to upload, not a blanket unlock.
  const up = await uploadUrl("rtl-exec");
  assert.equal(up.statusCode, 200, "upload is tolerated for the very same locked session");
});

// =====================================================================
// Test 6 — inAdminEndGrace behaviour is unchanged (new predicate is OR-ed, not replaced)
// =====================================================================

test("regression: inAdminEndGrace still tolerates a freshly admin-ended session for upload (record-through-lock is ADDITIVE)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  // status ended + an admin-end reason + recent ended_at → inAdminEndGrace true.
  seedSession(firestore, "rtl-endgrace", {
    status: "ended", ended_reason: "exam_ended_by_admin",
    ended_at: new Date(Date.now() - 60_000).toISOString()
  });
  const res = await uploadUrl("rtl-endgrace");
  assert.equal(res.statusCode, 200, "the admin-end grace path is untouched (OR-ed alongside record-through-lock)");

  // And a STUDENT-ended session (no admin reason) is still refused 409 — the
  // record-through-lock change does not loosen the ended path.
  seedSession(firestore, "rtl-studentend", {
    status: "ended", ended_reason: "student_submitted",
    ended_at: new Date(Date.now() - 60_000).toISOString()
  });
  const refused = await uploadUrl("rtl-studentend");
  assert.equal(refused.statusCode, 409, "a non-admin ended session is still refused (session_ended)");
});
