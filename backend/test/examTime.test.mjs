// backend/test/examTime.test.mjs — S5: dynamic exam time + end-now.
import { test } from "node:test";
import assert from "node:assert/strict";

// Env MUST be set before importing the handler (it reads env at module load).
// Unique collection names + the ?examtime cache-buster give this file a fresh
// module instance independent of the other test files.
process.env.EVIDENCE_BUCKET = "examtime-bucket";
process.env.SESSION_COLLECTION = "examtime_sessions";
process.env.SETTINGS_COLLECTION = "examtime_settings";
process.env.CONTESTS_COLLECTION = "examtime_contests";
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
const CONTEST_SLUG = "kec-2026";

// Seed an OPEN no-roster person contest (slug kec-2026). The window rides on the
// contest doc — every session-bound serve path (start/resume/heartbeat/stats)
// reads end_at from THIS contest.
async function seedSettings(firestore, overrides = {}) {
  const item = {
    slug: CONTEST_SLUG, name: CONTEST_SLUG, status: "open", listed: true,
    identity_mode: "person", identity_label: "Candidate ID",
    start_at: isoMinutesFromNow(-60),
    end_at: isoMinutesFromNow(60),
    problems: [{ problem_id: "sum-two", points: null, order: 0 }],
    rooms: ["Lab A-1"], room_gate_enabled: false,
    updated_at: new Date().toISOString(),
    ...overrides
  };
  await firestore.collection(process.env.CONTESTS_COLLECTION).doc(CONTEST_SLUG).set(item);
  return item;
}

// ---- Task 1: end_at + server_now on start / resume / heartbeat -------------

test("POST /api/session/start response carries end_at + server_now", async () => {
  const { firestore } = freshFakes();
  const seeded = await seedSettings(firestore);
  const res = await call(makeReq({ method: "POST", path: "/api/session/start", body: {
    contest: CONTEST_SLUG, candidate_id: "alice", name: "Alice", roll_number: "R1",
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
    session_id: "s1", status: "active", candidate_id: "alice", username_norm: "alice",
    contest_slug: CONTEST_SLUG, storage_prefix: `contests/${CONTEST_SLUG}/sessions/alice/s1/`
  });
  const res = await call(makeReq({ method: "POST", path: "/api/session/resume", body: { session_id: "s1", contest: CONTEST_SLUG } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.end_at, seeded.end_at);
  assert.ok(Number.isFinite(Date.parse(res.body.server_now)));
});

test("POST /api/heartbeat response carries end_at + server_now (the student's live channel)", async () => {
  const { firestore } = freshFakes();
  const seeded = await seedSettings(firestore);
  // No start_ip/current_ip on the seed → heartbeat sees no IP change (no alert path).
  await firestore.collection(process.env.SESSION_COLLECTION).doc("s1").set({
    session_id: "s1", status: "active", candidate_id: "alice", username_norm: "alice",
    contest_slug: CONTEST_SLUG, storage_prefix: `contests/${CONTEST_SLUG}/sessions/alice/s1/`
  });
  const res = await call(makeReq({ method: "POST", path: "/api/heartbeat", body: {
    session_id: "s1", recording_state: "combined:recording;screen:recording", visibility_state: "visible"
  } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "active");
  assert.equal(res.body.end_at, seeded.end_at);
  assert.ok(Number.isFinite(Date.parse(res.body.server_now)));
});

// ---- Task 2: per-contest exam-time lives in contestAdminSD; here we only
// pin that admin/stats surfaces the (contest-scoped) end_at for the card ------

test("GET /api/admin/stats carries end_at + server_now for the console exam-time card", async () => {
  const { firestore } = freshFakes();
  const seeded = await seedSettings(firestore);
  // The exam-time card reads the CONTEST window — the scoped stats poll reports it.
  const res = await call(makeReq({ method: "GET", path: "/api/admin/stats", headers: ADMIN, query: { contest_slug: CONTEST_SLUG } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.end_at, seeded.end_at);
  assert.ok(Number.isFinite(Date.parse(res.body.server_now)));
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

test("D3: end_now paginates past the query cap and ends every live session", async () => {
  const { firestore } = freshFakes();
  await seedSettings(firestore);
  // 6005 live sessions > SESSIONS_QUERY_LIMIT (raised 2000→6000 on exam-eve
  // 2026-06-18): a single capped query strands the lexicographic tail, so the
  // seed must stay ABOVE the cap to keep exercising the pagination path. Direct
  // store writes keep the seed fast. (collection() materializes the backing Map
  // in _collections.)
  firestore.collection(process.env.SESSION_COLLECTION);
  const TOTAL = 6005;
  const store = firestore._collections.get(process.env.SESSION_COLLECTION);
  for (let i = 0; i < TOTAL; i += 1) {
    const id = `sess-${String(i).padStart(4, "0")}`;
    store.set(id, { session_id: id, status: "active", username_norm: `u${i}`, contest_slug: "kec-2026" });
  }

  const res = await call(makeReq({ method: "POST", path: "/api/admin/contest-exam-time", headers: ADMIN, body: { slug: CONTEST_SLUG, end_now: true } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ended_count, TOTAL, "every live session ended, not just the first page");
  assert.equal(store.get("sess-6004").status, "ended", "doc beyond the first 6000 (the cap) reached");
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
