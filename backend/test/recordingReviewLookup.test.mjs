// backend/test/recordingReviewLookup.test.mjs — FIX-B1: the recording-review
// player must resolve PERSON-mode sessions, not just legacy ones.
//
// THE BUG: RecordingReview resolved a session by candidateIdOf (= candidate_id,
// e.g. "TEC001") → GET /api/admin/sessions?username=TEC001 → adminSessions did
// `where("username_norm","==", normalizeUsername("TEC001"))` = "tec001". LEGACY
// docs store username_norm = normalized-candidate, so that matched; but
// PERSON-mode docs store username_norm = person_id =
// "{college_norm}~{uid_norm}" (e.g. "testengineeringcollege~tec001"), which
// normalize("TEC001") NEVER equals → the query returned [] and the whole player
// (playback / timeline / alerts overlay / review queue) was dead for roster
// contests.
//
// THE FIX: adminSessions accepts an EXACT `username_norm` query param (no
// re-normalization) IN ADDITION to the existing `username` (full back-compat),
// and adminRecordingSessions emits each row's stored `username_norm` so the
// picker can resolve by the exact stored key for BOTH session shapes.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.EVIDENCE_BUCKET = "rrl-bucket";
process.env.SESSION_COLLECTION = "rrl_sessions";
process.env.SETTINGS_COLLECTION = "rrl_settings";
process.env.CONTESTS_COLLECTION = "rrl_contests";
process.env.ADMIN_PASSWORD = "rrl-admin-pass";

const handler = await import("../src/handler.mjs?recordingreviewlookup");
const { api, __setClientsForTest } = handler;

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

function makeFakeFirestore() {
  const collections = new Map();
  function getCollection(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  }
  function makeQuery(name, filters) {
    return {
      where(field, op, value) { return makeQuery(name, [...filters, { field, op, value }]); },
      orderBy() { return this; },
      limit() { return this; },
      async get() {
        let docs = [...getCollection(name).values()];
        for (const { field, op, value } of filters) {
          if (op === "in") docs = docs.filter((doc) => Array.isArray(value) && value.includes(doc[field]));
          else docs = docs.filter((doc) => doc[field] === value);
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
        where: query.where, orderBy: query.orderBy, limit: query.limit, get: query.get,
        doc(id) {
          return {
            id,
            async create(value) { if (store.has(id)) { const e = new Error("ALREADY_EXISTS"); e.code = 6; throw e; } store.set(id, { ...value }); },
            async set(value, options) { const existing = options?.merge ? store.get(id) || {} : {}; store.set(id, { ...existing, ...value }); },
            async update(value) { const existing = store.get(id); if (!existing) throw new Error(`missing ${id}`); store.set(id, { ...existing, ...value }); },
            async delete() { store.delete(id); },
            async get() { const data = store.get(id); return { exists: Boolean(data), data: () => data }; }
          };
        }
      };
    }
  };
}

// Storage whose getFiles({prefix}) returns the seeded objects whose key starts
// with that prefix — so a session's evidence listing (and events listing) work.
function makeFakeStorage(objects) {
  return {
    bucket() {
      return {
        file(key) {
          return {
            async save() {},
            async getSignedUrl() { return [`https://signed.example/${key}`]; },
            async download() { return [objects.get(key) ?? ""]; }
          };
        },
        async getFiles({ prefix } = {}) {
          const matched = [...objects.keys()]
            .filter((key) => !prefix || key.startsWith(prefix))
            .map((key) => ({
              name: key,
              metadata: { size: 100, updated: "2026-06-10T00:00:00.000Z" },
              async getSignedUrl() { return [`https://signed.example/${key}`]; },
              async download() { return [objects.get(key) ?? ""]; }
            }));
          return [matched];
        }
      };
    }
  };
}

const ADMIN_HEADERS = { "x-admin-password": "rrl-admin-pass" };

// A PERSON-mode session: username_norm = person_id (college~uid), candidate_id =
// the roster display id "TEC001". This is the doc the bug failed to resolve.
const PERSON_PREFIX = "contests/tec-2026/sessions/testengineeringcollege~tec001/sess-person/";
const PERSON_SESSION = {
  session_id: "sess-person",
  username_norm: "testengineeringcollege~tec001",
  candidate_id: "TEC001",
  hackerrank_username: "",
  name: "Test Person",
  room: "Lab A",
  contest_slug: "tec-2026",
  status: "ended",
  chunk_count: 2,
  storage_prefix: PERSON_PREFIX,
  created_at: "2026-06-10T09:00:00.000Z",
  recording_state: ""
};

// A LEGACY session: username_norm = normalizeUsername(candidate) = "leg001".
const LEGACY_PREFIX = "sessions/leg001/sess-legacy/";
const LEGACY_SESSION = {
  session_id: "sess-legacy",
  username_norm: "leg001",
  hackerrank_username: "LEG001",
  name: "Legacy Person",
  room: "Lab B",
  contest_slug: "",
  status: "ended",
  chunk_count: 2,
  storage_prefix: LEGACY_PREFIX,
  created_at: "2026-06-09T09:00:00.000Z",
  recording_state: ""
};

function seed() {
  const firestore = makeFakeFirestore();
  const objects = new Map([
    [`${PERSON_PREFIX}screen-0.webm`, "p0"],
    [`${PERSON_PREFIX}screen-1.webm`, "p1"],
    [`${PERSON_PREFIX}events/0.jsonl`, JSON.stringify({ type: "visibility_hidden", timestamp: "2026-06-10T09:01:00.000Z", detail: {} })],
    [`${LEGACY_PREFIX}screen-0.webm`, "l0"],
    [`${LEGACY_PREFIX}screen-1.webm`, "l1"]
  ]);
  const storage = makeFakeStorage(objects);
  __setClientsForTest({ firestore, storage });
  firestore._collections.set("rrl_sessions", new Map([
    [PERSON_SESSION.session_id, { ...PERSON_SESSION }],
    [LEGACY_SESSION.session_id, { ...LEGACY_SESSION }]
  ]));
  return { firestore, objects };
}

// ---- THE BUG REPRODUCTION + FIX -------------------------------------------

test("adminSessions: candidate_id lookup (the old path) does NOT resolve a person-mode session", async () => {
  seed();
  // This is exactly what the player used to send: ?username=TEC001. It normalizes
  // to "tec001", which never equals the stored person_id "...~tec001".
  const res = await call(makeReq({ method: "GET", path: "/api/admin/sessions", headers: ADMIN_HEADERS, query: { username: "TEC001" } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.sessions.length, 0, "candidate_id-keyed lookup must miss the person session (the bug)");
});

test("adminSessions: EXACT username_norm resolves the PERSON-mode session + its chunks/events", async () => {
  seed();
  const res = await call(makeReq({
    method: "GET", path: "/api/admin/sessions", headers: ADMIN_HEADERS,
    query: { username_norm: "testengineeringcollege~tec001" }
  }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.sessions.length, 1, "person session must resolve by its stored username_norm");
  const session = res.body.sessions[0];
  assert.equal(session.session_id, "sess-person");
  assert.equal(session.candidate_id, "TEC001", "display identity is preserved on the resolved doc");
  // The chunk evidence (screen-0, screen-1) is listed + signed.
  const chunks = session.evidence.filter((e) => e.key.endsWith(".webm"));
  assert.equal(chunks.length, 2, "both screen chunks resolve for the person session");
  assert.ok(chunks.every((e) => typeof e.download_url === "string" && e.download_url.length));
});

test("adminSessionEvents: the resolved person session's events stream reads by session_id", async () => {
  seed();
  // Once the player resolves the session (above), the events overlay reads by
  // session_id directly — verify that cascade is alive for the person session.
  const res = await call(makeReq({
    method: "GET", path: "/api/admin/session-events", headers: ADMIN_HEADERS,
    query: { session_id: "sess-person" }
  }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.events.length, 1);
  assert.equal(res.body.events[0].type, "visibility_hidden");
});

test("adminSessions: EXACT username_norm still resolves a LEGACY session (back-compat for the new param)", async () => {
  seed();
  const res = await call(makeReq({
    method: "GET", path: "/api/admin/sessions", headers: ADMIN_HEADERS,
    query: { username_norm: "leg001" }
  }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.sessions.length, 1);
  assert.equal(res.body.sessions[0].session_id, "sess-legacy");
});

test("adminSessions: the legacy ?username path is UNCHANGED (full back-compat)", async () => {
  seed();
  // The existing call shape — ?username=LEG001 → normalize → "leg001" → matches
  // the legacy doc exactly as before. This must not regress.
  const res = await call(makeReq({ method: "GET", path: "/api/admin/sessions", headers: ADMIN_HEADERS, query: { username: "LEG001" } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.sessions.length, 1);
  assert.equal(res.body.sessions[0].session_id, "sess-legacy");
});

test("adminSessions: neither username nor username_norm → 400", async () => {
  seed();
  const res = await call(makeReq({ method: "GET", path: "/api/admin/sessions", headers: ADMIN_HEADERS, query: {} }));
  assert.equal(res.statusCode, 400, JSON.stringify(res.body));
});

// ---- recording-sessions picker carries the stored key ----------------------

test("adminRecordingSessions: picker rows carry the stored username_norm + session_id for BOTH shapes", async () => {
  seed();
  const res = await call(makeReq({ method: "GET", path: "/api/admin/recording-sessions", headers: ADMIN_HEADERS, query: {} }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const byId = new Map(res.body.sessions.map((s) => [s.session_id, s]));
  assert.equal(byId.get("sess-person").username_norm, "testengineeringcollege~tec001",
    "the picker row exposes the EXACT stored key the player must look up by");
  assert.equal(byId.get("sess-person").candidate_id, "TEC001", "display id still present for the label");
  assert.equal(byId.get("sess-legacy").username_norm, "leg001");
});
