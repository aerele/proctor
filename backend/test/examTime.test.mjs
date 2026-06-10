// backend/test/examTime.test.mjs — S5: dynamic exam time + end-now.
import { test } from "node:test";
import assert from "node:assert/strict";

// Env MUST be set before importing the handler (it reads env at module load).
// Unique collection names + the ?examtime cache-buster give this file a fresh
// module instance independent of the other test files.
process.env.EVIDENCE_BUCKET = "examtime-bucket";
process.env.SESSION_COLLECTION = "examtime_sessions";
process.env.SETTINGS_COLLECTION = "examtime_settings";
process.env.ALERTS_COLLECTION = "examtime_alerts";
process.env.LIVE_LOCK_COLLECTION = "examtime_live_locks";
process.env.ADMIN_PASSWORD = "examtime-admin-pass";

const handler = await import("../src/handler.mjs?examtime");
const { api, __setClientsForTest } = handler;

// Inline req/res mocks + fakes, copied from phase2.test.mjs / exec.test.mjs
// (NO helpers.mjs — each test file pastes its own).
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

  // Unlike the other test files' pasted fakes, this one HONORS limit(n) and
  // supports orderBy/startAfter so the D3 end-now pagination is actually
  // exercisable (a limit-ignoring fake would pass even without pagination).
  // orderBy treats ANY field argument as doc-id order — the handler only pages
  // by FieldPath.documentId(), and session_id === doc id anyway.
  function makeQuery(name, { filters = [], ordered = false, startAfterId = null, limitN = Infinity } = {}) {
    return {
      where(field, op, value) {
        return makeQuery(name, { filters: [...filters, { field, op, value }], ordered, startAfterId, limitN });
      },
      orderBy() {
        return makeQuery(name, { filters, ordered: true, startAfterId, limitN });
      },
      startAfter(id) {
        return makeQuery(name, { filters, ordered, startAfterId: String(id), limitN });
      },
      limit(n) {
        return makeQuery(name, { filters, ordered, startAfterId, limitN: n });
      },
      async get() {
        const store = getCollection(name);
        let entries = [...store.entries()];
        for (const { field, op, value } of filters) {
          if (op === "in") {
            entries = entries.filter(([, doc]) => Array.isArray(value) && value.includes(doc[field]));
          } else {
            entries = entries.filter(([, doc]) => doc[field] === value);
          }
        }
        if (ordered) entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        if (startAfterId !== null) entries = entries.filter(([id]) => id > startAfterId);
        entries = entries.slice(0, limitN);
        return { docs: entries.map(([id, data]) => ({ id, data: () => data })) };
      }
    };
  }

  return {
    _collections: collections,
    collection(name) {
      const store = getCollection(name);
      const query = makeQuery(name);
      return {
        where: query.where,
        orderBy: query.orderBy,
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

// ---- Shared helpers for this file ------------------------------------------

const ADMIN = { "x-admin-password": "examtime-admin-pass" };

function isoMinutesFromNow(minutes) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function freshFakes() {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  return { firestore, storage };
}

// Seed the active settings doc with an OPEN window (started 60 min ago, ends in
// 60 min) plus extra fields a merge-write must preserve (S2 adds rooms etc.).
async function seedSettings(firestore, overrides = {}) {
  const item = {
    start_at: isoMinutesFromNow(-60),
    end_at: isoMinutesFromNow(60),
    contest_url: "https://www.hackerrank.com/contests/kec-2026",
    contest_slug: "kec-2026",
    rooms: ["Lab A-1"],
    updated_at: new Date().toISOString(),
    ...overrides
  };
  await firestore.collection(process.env.SETTINGS_COLLECTION).doc("active").set(item);
  return item;
}

// ---- Task 1: end_at + server_now on start / resume / heartbeat -------------

test("POST /api/session/start response carries end_at + server_now", async () => {
  const { firestore } = freshFakes();
  const seeded = await seedSettings(firestore);
  const res = await call(makeReq({ method: "POST", path: "/api/session/start", body: {
    hackerrank_username: "alice", name: "Alice", roll_number: "R1",
    email: "a@example.com", consent_accepted: true
  } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.end_at, seeded.end_at);
  assert.ok(Number.isFinite(Date.parse(res.body.server_now)));
});

test("POST /api/session/resume response carries end_at + server_now", async () => {
  const { firestore } = freshFakes();
  const seeded = await seedSettings(firestore);
  await firestore.collection(process.env.SESSION_COLLECTION).doc("s1").set({
    session_id: "s1", status: "active", username_norm: "alice",
    contest_slug: "kec-2026", storage_prefix: "contests/kec-2026/sessions/alice/s1/"
  });
  const res = await call(makeReq({ method: "POST", path: "/api/session/resume", body: { session_id: "s1" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.end_at, seeded.end_at);
  assert.ok(Number.isFinite(Date.parse(res.body.server_now)));
});

test("POST /api/heartbeat response carries end_at + server_now (the student's live channel)", async () => {
  const { firestore } = freshFakes();
  const seeded = await seedSettings(firestore);
  // No start_ip/current_ip on the seed → heartbeat sees no IP change (no alert path).
  await firestore.collection(process.env.SESSION_COLLECTION).doc("s1").set({
    session_id: "s1", status: "active", username_norm: "alice",
    contest_slug: "kec-2026", storage_prefix: "contests/kec-2026/sessions/alice/s1/"
  });
  const res = await call(makeReq({ method: "POST", path: "/api/heartbeat", body: {
    session_id: "s1", recording_state: "combined:recording;screen:recording", visibility_state: "visible"
  } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "active");
  assert.equal(res.body.end_at, seeded.end_at);
  assert.ok(Number.isFinite(Date.parse(res.body.server_now)));
});

// ---- Task 2: POST /api/admin/exam-time + stats end_at -----------------------

test("POST /api/admin/exam-time validation: admin auth, configured schedule, exactly-one field, sane values", async () => {
  const { firestore } = freshFakes();

  // 401 without the admin password
  const noAuth = await call(makeReq({ method: "POST", path: "/api/admin/exam-time", body: { end_now: true } }));
  assert.equal(noAuth.statusCode, 401);

  // 400 when the schedule was never configured
  const unconfigured = await call(makeReq({ method: "POST", path: "/api/admin/exam-time", headers: ADMIN, body: { end_now: true } }));
  assert.equal(unconfigured.statusCode, 400);

  await seedSettings(firestore);
  // exactly ONE of the three fields
  const none = await call(makeReq({ method: "POST", path: "/api/admin/exam-time", headers: ADMIN, body: {} }));
  assert.equal(none.statusCode, 400);
  const two = await call(makeReq({ method: "POST", path: "/api/admin/exam-time", headers: ADMIN, body: { end_now: true, extend_minutes: 5 } }));
  assert.equal(two.statusCode, 400);
  // bad values
  const badIso = await call(makeReq({ method: "POST", path: "/api/admin/exam-time", headers: ADMIN, body: { end_at: "not-a-date" } }));
  assert.equal(badIso.statusCode, 400);
  const zero = await call(makeReq({ method: "POST", path: "/api/admin/exam-time", headers: ADMIN, body: { extend_minutes: 0 } }));
  assert.equal(zero.statusCode, 400);
  const falseEnd = await call(makeReq({ method: "POST", path: "/api/admin/exam-time", headers: ADMIN, body: { end_now: false } }));
  assert.equal(falseEnd.statusCode, 400);
  // window inversion: new end before start
  const beforeStart = await call(makeReq({ method: "POST", path: "/api/admin/exam-time", headers: ADMIN, body: { end_at: isoMinutesFromNow(-120) } }));
  assert.equal(beforeStart.statusCode, 400);
});

test("POST /api/admin/exam-time {end_at}: sets the new end WITHOUT clobbering other settings fields (merge-write)", async () => {
  const { firestore } = freshFakes();
  await seedSettings(firestore);
  const newEnd = isoMinutesFromNow(120);
  const res = await call(makeReq({ method: "POST", path: "/api/admin/exam-time", headers: ADMIN, body: { end_at: newEnd } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.end_at, newEnd);
  assert.equal(res.body.ended_count, 0);
  assert.ok(Number.isFinite(Date.parse(res.body.server_now)));
  const stored = firestore._collections.get(process.env.SETTINGS_COLLECTION).get("active");
  assert.equal(stored.end_at, newEnd);
  assert.ok(stored.end_at_updated_at);
  // merge:true preserved everything else (incl. fields other features add)
  assert.equal(stored.contest_url, "https://www.hackerrank.com/contests/kec-2026");
  assert.deepEqual(stored.rooms, ["Lab A-1"]);
  assert.equal(stored.contest_slug, "kec-2026");
  assert.equal(stored.start_at !== undefined, true);
});

test("POST /api/admin/exam-time {extend_minutes}: positive extends, negative shortens, never inverts the window", async () => {
  const { firestore } = freshFakes();
  const seeded = await seedSettings(firestore);

  const plus = await call(makeReq({ method: "POST", path: "/api/admin/exam-time", headers: ADMIN, body: { extend_minutes: 30 } }));
  assert.equal(plus.statusCode, 200);
  assert.equal(Date.parse(plus.body.end_at), Date.parse(seeded.end_at) + 30 * 60_000);

  // deltas compose against the CURRENT (already-extended) end
  const minus = await call(makeReq({ method: "POST", path: "/api/admin/exam-time", headers: ADMIN, body: { extend_minutes: -45 } }));
  assert.equal(minus.statusCode, 200);
  assert.equal(Date.parse(minus.body.end_at), Date.parse(seeded.end_at) - 15 * 60_000);

  // a shorten that would land before start_at → 400, end unchanged
  const invert = await call(makeReq({ method: "POST", path: "/api/admin/exam-time", headers: ADMIN, body: { extend_minutes: -10000 } }));
  assert.equal(invert.statusCode, 400);
  const stored = firestore._collections.get(process.env.SETTINGS_COLLECTION).get("active");
  assert.equal(Date.parse(stored.end_at), Date.parse(seeded.end_at) - 15 * 60_000);
});

test("POST /api/admin/exam-time {end_now}: ends every non-ended session in the contest scope, releases live locks", async () => {
  const { firestore } = freshFakes();
  await seedSettings(firestore);
  const sessions = firestore.collection(process.env.SESSION_COLLECTION);
  await sessions.doc("s-active").set({ session_id: "s-active", status: "active", username_norm: "alice", contest_slug: "kec-2026" });
  await sessions.doc("s-locked").set({ session_id: "s-locked", status: "locked", username_norm: "bob", contest_slug: "kec-2026" });
  await sessions.doc("s-pending").set({ session_id: "s-pending", status: "pending_approval", username_norm: "cara", contest_slug: "kec-2026" });
  await sessions.doc("s-done").set({ session_id: "s-done", status: "ended", username_norm: "dan", contest_slug: "kec-2026" });
  await sessions.doc("s-other").set({ session_id: "s-other", status: "active", username_norm: "eve", contest_slug: "other-contest" });
  // alice's live-slot lock must be released so a legitimate later start works
  await firestore.collection(process.env.LIVE_LOCK_COLLECTION).doc("live:alice:kec-2026").set({
    username_norm: "alice", contest_slug: "kec-2026", session_id: "s-active", acquired_at: new Date().toISOString()
  });

  const before = Date.now();
  const res = await call(makeReq({ method: "POST", path: "/api/admin/exam-time", headers: ADMIN, body: { end_now: true } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.ended_count, 3);
  // end_at moved to ~now
  const endMs = Date.parse(res.body.end_at);
  assert.ok(endMs >= before && endMs <= Date.now());

  const store = firestore._collections.get(process.env.SESSION_COLLECTION);
  for (const id of ["s-active", "s-locked", "s-pending"]) {
    assert.equal(store.get(id).status, "ended", `${id} force-ended`);
    assert.equal(store.get(id).ended_reason, "exam_ended_by_admin");
    assert.ok(store.get(id).ended_at);
  }
  assert.equal(store.get("s-done").ended_reason, undefined, "already-ended session untouched");
  assert.equal(store.get("s-other").status, "active", "other contest untouched");
  assert.equal(firestore._collections.get(process.env.LIVE_LOCK_COLLECTION).has("live:alice:kec-2026"), false, "live slot released");
});

test("GET /api/admin/stats carries end_at + server_now for the console exam-time card", async () => {
  const { firestore } = freshFakes();
  const seeded = await seedSettings(firestore);
  const res = await call(makeReq({ method: "GET", path: "/api/admin/stats", headers: ADMIN }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.end_at, seeded.end_at);
  assert.ok(Number.isFinite(Date.parse(res.body.server_now)));
});

// ---- D1: a stale Settings-form save must never clobber S5 exam-time state ---

test("D1: stale settings save (same start_at) cannot revert a live exam-time change", async () => {
  const { firestore } = freshFakes();
  const seeded = await seedSettings(firestore);

  // Live adjustment via the S5 endpoint: +30 minutes.
  const extended = await call(makeReq({ method: "POST", path: "/api/admin/exam-time", headers: ADMIN, body: { extend_minutes: 30 } }));
  assert.equal(extended.statusCode, 200);
  const liveEndAt = extended.body.end_at;

  // A Settings form loaded BEFORE the extend posts the original end_at back
  // (same start_at = same exam window) alongside a legitimate rooms edit.
  const res = await call(makeReq({ method: "POST", path: "/api/admin/settings", headers: ADMIN, body: {
    start_at: seeded.start_at, end_at: seeded.end_at,
    contest_url: seeded.contest_url, rooms: ["Lab A-1", "Lab B-2"]
  } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.end_at, liveEndAt, "response reports the preserved live end_at");
  assert.deepEqual(res.body.rooms, ["Lab A-1", "Lab B-2"], "non-exam-time fields still save");

  const stored = firestore._collections.get(process.env.SETTINGS_COLLECTION).get("active");
  assert.equal(stored.end_at, liveEndAt, "live-adjusted end_at survives the stale save");
  assert.ok(stored.end_at_updated_at, "exam-time ownership stamp survives the full set()");
});

test("D1: a settings save with a NEW start_at is a new schedule — submitted end_at applies, stamp clears", async () => {
  const { firestore } = freshFakes();
  await seedSettings(firestore);
  // Take exam-time ownership first (end-now stamps end_at_updated_at).
  const extended = await call(makeReq({ method: "POST", path: "/api/admin/exam-time", headers: ADMIN, body: { extend_minutes: 30 } }));
  assert.equal(extended.statusCode, 200);

  const newStart = isoMinutesFromNow(-10);
  const newEnd = isoMinutesFromNow(200);
  const res = await call(makeReq({ method: "POST", path: "/api/admin/settings", headers: ADMIN, body: {
    start_at: newStart, end_at: newEnd, contest_url: "https://www.hackerrank.com/contests/kec-2026"
  } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.end_at, newEnd, "new schedule takes the submitted end_at");

  const stored = firestore._collections.get(process.env.SETTINGS_COLLECTION).get("active");
  assert.equal(stored.end_at, newEnd);
  assert.equal(stored.end_at_updated_at, undefined, "old exam's live-adjust stamp does not shackle the new schedule");
});

test("D1: with no prior exam-time adjustment the settings save sets end_at normally", async () => {
  const { firestore } = freshFakes();
  const seeded = await seedSettings(firestore);
  const newEnd = isoMinutesFromNow(90);
  const res = await call(makeReq({ method: "POST", path: "/api/admin/settings", headers: ADMIN, body: {
    start_at: seeded.start_at, end_at: newEnd, contest_url: seeded.contest_url
  } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.end_at, newEnd);
  const stored = firestore._collections.get(process.env.SETTINGS_COLLECTION).get("active");
  assert.equal(stored.end_at, newEnd, "form remains the end_at owner until exam-time is used");
});

// ---- D2: bounded grace for the final chunk + manifest after an admin end ----

async function seedEndedSession(firestore, id, { endedAgoMs, endedReason }) {
  const item = {
    session_id: id, status: "ended", username_norm: "alice", contest_slug: "kec-2026",
    storage_prefix: `contests/kec-2026/sessions/alice/${id}/`,
    ended_at: new Date(Date.now() - endedAgoMs).toISOString(),
    chunk_count: 3
  };
  if (endedReason !== undefined) item.ended_reason = endedReason;
  await firestore.collection(process.env.SESSION_COLLECTION).doc(id).set(item);
  return item;
}

test("D2: within the grace window an admin-ended session can still get a final-chunk upload URL", async () => {
  const { firestore } = freshFakes();
  await seedEndedSession(firestore, "s-grace", { endedAgoMs: 60_000, endedReason: "exam_ended_by_admin" });
  const res = await call(makeReq({ method: "POST", path: "/api/upload-url", body: {
    session_id: "s-grace", kind: "screen", chunk_index: 3, content_type: "video/webm"
  } }));
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.upload_url, "signed URL issued for the in-flight final chunk");
  const stored = firestore._collections.get(process.env.SESSION_COLLECTION).get("s-grace");
  assert.equal(stored.status, "ended", "grace never reopens the session");
  assert.equal(stored.chunk_count, 4, "the final chunk still counts");
});

test("D2: within the grace window the session/end manifest is accepted WITHOUT reopening or re-ending", async () => {
  const { firestore, storage } = freshFakes();
  const seeded = await seedEndedSession(firestore, "s-grace", { endedAgoMs: 60_000, endedReason: "exam_ended_by_admin" });
  const res = await call(makeReq({ method: "POST", path: "/api/session/end", body: {
    session_id: "s-grace", assurance_accepted: true,
    manifest: [{ kind: "screen", chunk_index: 3, storage_key: "k" }]
  } }));
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.manifest_key);
  assert.ok(storage._saved.has(res.body.manifest_key), "manifest written to storage");
  const stored = firestore._collections.get(process.env.SESSION_COLLECTION).get("s-grace");
  assert.equal(stored.status, "ended");
  assert.equal(stored.ended_at, seeded.ended_at, "admin's ended_at stays authoritative");
  assert.equal(stored.ended_reason, "exam_ended_by_admin", "admin's ended_reason survives");
  assert.equal(stored.manifest_key, res.body.manifest_key);
  assert.equal(stored.uploaded_manifest_count, 1);
});

test("D2: the per-session admin 'end' action (ended_reason admin_action) gets the same grace", async () => {
  const { firestore } = freshFakes();
  await seedEndedSession(firestore, "s-admin-act", { endedAgoMs: 60_000, endedReason: "admin_action" });
  const res = await call(makeReq({ method: "POST", path: "/api/upload-url", body: {
    session_id: "s-admin-act", kind: "screen", chunk_index: 3, content_type: "video/webm"
  } }));
  assert.equal(res.statusCode, 200);
});

test("D2: heartbeats still 409 during grace (B1 self-stop must keep firing)", async () => {
  const { firestore } = freshFakes();
  await seedEndedSession(firestore, "s-grace", { endedAgoMs: 60_000, endedReason: "exam_ended_by_admin" });
  const res = await call(makeReq({ method: "POST", path: "/api/heartbeat", body: {
    session_id: "s-grace", recording_state: "screen:recording", visibility_state: "visible"
  } }));
  assert.equal(res.statusCode, 409);
});

test("D2: grace is bounded — an admin-ended session older than the window is rejected", async () => {
  const { firestore } = freshFakes();
  await seedEndedSession(firestore, "s-stale", { endedAgoMs: 6 * 60_000, endedReason: "exam_ended_by_admin" });
  const upload = await call(makeReq({ method: "POST", path: "/api/upload-url", body: {
    session_id: "s-stale", kind: "screen", chunk_index: 3, content_type: "video/webm"
  } }));
  assert.equal(upload.statusCode, 409);
  const end = await call(makeReq({ method: "POST", path: "/api/session/end", body: {
    session_id: "s-stale", assurance_accepted: true, manifest: []
  } }));
  assert.equal(end.statusCode, 409);
});

// ---- D3: end-now must reach EVERY live session, past the per-query cap ------

test("D3: end_now paginates past the 2000-doc query cap and ends every live session", async () => {
  const { firestore } = freshFakes();
  await seedSettings(firestore);
  // 2005 live sessions > SESSIONS_QUERY_LIMIT (2000): a single capped query
  // strands the lexicographic tail. Direct store writes keep the seed fast.
  // (collection() materializes the backing Map in _collections.)
  firestore.collection(process.env.SESSION_COLLECTION);
  const TOTAL = 2005;
  const store = firestore._collections.get(process.env.SESSION_COLLECTION);
  for (let i = 0; i < TOTAL; i += 1) {
    const id = `sess-${String(i).padStart(4, "0")}`;
    store.set(id, { session_id: id, status: "active", username_norm: `u${i}`, contest_slug: "kec-2026" });
  }

  const res = await call(makeReq({ method: "POST", path: "/api/admin/exam-time", headers: ADMIN, body: { end_now: true } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ended_count, TOTAL, "every live session ended, not just the first page");
  assert.equal(store.get("sess-2004").status, "ended", "doc beyond the first 2000 reached");
  assert.equal(store.get("sess-0000").status, "ended");
});

test("D2: no grace for a self-ended session — repeated session/end stays a 409", async () => {
  const { firestore } = freshFakes();
  await seedEndedSession(firestore, "s-self", { endedAgoMs: 60_000, endedReason: undefined });
  const upload = await call(makeReq({ method: "POST", path: "/api/upload-url", body: {
    session_id: "s-self", kind: "screen", chunk_index: 3, content_type: "video/webm"
  } }));
  assert.equal(upload.statusCode, 409);
  const end = await call(makeReq({ method: "POST", path: "/api/session/end", body: {
    session_id: "s-self", assurance_accepted: true, manifest: []
  } }));
  assert.equal(end.statusCode, 409);
});
