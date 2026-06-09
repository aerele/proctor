// backend/test/roster.test.mjs — S2: roster upload + roster-gated login + rooms.
import { test } from "node:test";
import assert from "node:assert/strict";

// Env BEFORE import; unique ?roster cache-buster for a fresh module instance.
process.env.EVIDENCE_BUCKET = "roster-bucket";
process.env.SESSION_COLLECTION = "roster_sessions";
process.env.SETTINGS_COLLECTION = "roster_settings";
process.env.ROSTER_COLLECTION = "roster_entries";
process.env.ADMIN_PASSWORD = "roster-admin-pass";

const handler = await import("../src/handler.mjs?roster");
const { api, __setClientsForTest } = handler;

// Inline req/res + fakes, copied from editorEvents.test.mjs (NO helpers.mjs).
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
  const saved = new Map(); // key -> body
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

// ---- S2 shared fixtures ----------------------------------------------------

const ADMIN = { "x-admin-password": "roster-admin-pass" };

function freshClients() {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  return { firestore, storage };
}

// Open proctor window so /api/session/start passes the time gate (Task 3).
function seedOpenWindow(firestore, extra = {}) {
  firestore.collection(process.env.SETTINGS_COLLECTION).doc("active").set({
    start_at: new Date(Date.now() - 3600_000).toISOString(),
    end_at: new Date(Date.now() + 3600_000).toISOString(),
    contest_url: "https://example.com/contests/night-run",
    contest_slug: "night-run",
    ...extra
  });
}

const SAMPLE_UPLOAD = {
  unique_id_column: "Roll No",
  columns: ["Roll No", "Student Name", "Email ID", "Phone"],
  // "phone" is NOT a mappable identity field -> must be dropped by the server.
  column_mapping: { name: "Student Name", email: "Email ID", roll_number: "Roll No", phone: "Phone" },
  rows: [
    { "Roll No": "21CS001", "Student Name": "Asha Raman", "Email ID": "asha@example.com", "Phone": "9999999999" },
    { "Roll No": "21CS002", "Student Name": "Vivek Nair", "Email ID": "vivek@example.com", "Phone": "8888888888" },
    { "Roll No": "21cs001", "Student Name": "Dup Row", "Email ID": "dup@example.com", "Phone": "7" },
    { "Roll No": "", "Student Name": "No Id", "Email ID": "noid@example.com", "Phone": "6" }
  ]
};

async function uploadSampleRoster(overrides = {}) {
  return call(makeReq({ method: "POST", path: "/api/admin/roster", headers: ADMIN,
    body: { ...SAMPLE_UPLOAD, ...overrides } }));
}

// ---- Task 1: admin roster store + rooms settings ---------------------------

test("POST /api/admin/roster requires the admin password", async () => {
  freshClients();
  const res = await call(makeReq({ method: "POST", path: "/api/admin/roster", body: SAMPLE_UPLOAD }));
  assert.equal(res.statusCode, 401);
});

test("POST /api/admin/roster stores entries + meta; skips dup/empty ids; drops unknown mapping fields", async () => {
  const { firestore } = freshClients();
  const res = await uploadSampleRoster();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.count, 2);
  assert.deepEqual(res.body.skipped, [
    { row: 2, reason: "duplicate_unique_id" },
    { row: 3, reason: "empty_unique_id" }
  ]);
  // Entries keyed by the normalized unique id.
  const entry = await firestore.collection(process.env.ROSTER_COLLECTION).doc("21cs001").get();
  assert.equal(entry.exists, true);
  assert.equal(entry.data().unique_id, "21CS001");
  assert.equal(entry.data().unique_id_norm, "21cs001");
  assert.equal(entry.data().fields["Student Name"], "Asha Raman");
  // Meta written LAST under the settings collection.
  const meta = await firestore.collection(process.env.SETTINGS_COLLECTION).doc("roster_meta").get();
  assert.equal(meta.data().configured, true);
  assert.equal(meta.data().count, 2);
  assert.equal(meta.data().unique_id_column, "Roll No");
  assert.equal(meta.data().version, entry.data().roster_version);
  // Unknown mapping keys (phone) dropped; known ones kept.
  assert.deepEqual(meta.data().column_mapping, { name: "Student Name", email: "Email ID", roll_number: "Roll No" });
});

test("POST /api/admin/roster 400s when unique_id_column is not one of columns", async () => {
  freshClients();
  const res = await uploadSampleRoster({ unique_id_column: "Nope" });
  assert.equal(res.statusCode, 400);
});

test("GET /api/admin/roster: configured:false before, meta summary after upload", async () => {
  freshClients();
  const before = await call(makeReq({ method: "GET", path: "/api/admin/roster", headers: ADMIN }));
  assert.equal(before.statusCode, 200);
  assert.equal(before.body.configured, false);
  await uploadSampleRoster();
  const after = await call(makeReq({ method: "GET", path: "/api/admin/roster", headers: ADMIN }));
  assert.equal(after.body.configured, true);
  assert.equal(after.body.count, 2);
  assert.equal(after.body.unique_id_column, "Roll No");
  assert.deepEqual(after.body.columns, ["Roll No", "Student Name", "Email ID", "Phone"]);
  assert.equal("rows" in after.body, false); // meta only, never the rows
});

test("POST /api/admin/roster {clear:true} disables the roster", async () => {
  freshClients();
  await uploadSampleRoster();
  const res = await call(makeReq({ method: "POST", path: "/api/admin/roster", headers: ADMIN, body: { clear: true } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.configured, false);
  const status = await call(makeReq({ method: "GET", path: "/api/admin/roster", headers: ADMIN }));
  assert.equal(status.body.configured, false);
});

test("settings rooms: sanitized + deduped on save and returned by GET", async () => {
  freshClients();
  const save = await call(makeReq({ method: "POST", path: "/api/admin/settings", headers: ADMIN, body: {
    start_at: "2026-06-10T09:00:00.000Z", end_at: "2026-06-10T12:00:00.000Z",
    rooms: ["Lab A-1", "Lab A-1", "  Lab B-2  ", "Bad<>Room!"]
  } }));
  assert.equal(save.statusCode, 200);
  assert.deepEqual(save.body.rooms, ["Lab A-1", "Lab B-2", "BadRoom"]);
  const get = await call(makeReq({ method: "GET", path: "/api/admin/settings", headers: ADMIN }));
  assert.deepEqual(get.body.rooms, ["Lab A-1", "Lab B-2", "BadRoom"]);
});

// ---- Task 2: public exam-config + lookup -----------------------------------

test("GET /api/exam-config: roster off + no rooms -> all-empty config", async () => {
  freshClients();
  const res = await call(makeReq({ method: "GET", path: "/api/exam-config" }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { roster_required: false, unique_id_label: "", rooms: [] });
});

test("GET /api/exam-config reflects the roster label + configured rooms", async () => {
  const { firestore } = freshClients();
  seedOpenWindow(firestore, { rooms: ["Lab A-1", "Lab B-2"] });
  await uploadSampleRoster();
  const res = await call(makeReq({ method: "GET", path: "/api/exam-config" }));
  assert.deepEqual(res.body, { roster_required: true, unique_id_label: "Roll No", rooms: ["Lab A-1", "Lab B-2"] });
});

test("POST /api/roster/lookup returns ONLY confirmation-safe fields (masked email, no extra columns)", async () => {
  freshClients();
  await uploadSampleRoster();
  const res = await call(makeReq({ method: "POST", path: "/api/roster/lookup", body: { unique_id: "21CS001" } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    found: true,
    unique_id: "21CS001",
    name: "Asha Raman",
    roll_number: "21CS001",
    room: "",
    hackerrank_username: "",
    email_masked: "as**@example.com"
  });
  const raw = JSON.stringify(res.body);
  assert.equal(raw.includes("asha@example.com"), false); // raw email never leaves
  assert.equal(raw.includes("9999999999"), false);       // unmapped Phone never leaves
});

test("POST /api/roster/lookup normalizes case + whitespace", async () => {
  freshClients();
  await uploadSampleRoster();
  const res = await call(makeReq({ method: "POST", path: "/api/roster/lookup", body: { unique_id: "  21 cs 001 " } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.unique_id, "21CS001");
});

test("POST /api/roster/lookup: unknown id -> 404; no roster -> 404", async () => {
  freshClients();
  const noRoster = await call(makeReq({ method: "POST", path: "/api/roster/lookup", body: { unique_id: "x" } }));
  assert.equal(noRoster.statusCode, 404);
  assert.equal(noRoster.body.error, "roster_not_configured");
  await uploadSampleRoster();
  const unknown = await call(makeReq({ method: "POST", path: "/api/roster/lookup", body: { unique_id: "99XX999" } }));
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.body.error, "not_on_roster");
});

test("POST /api/roster/lookup ignores entries from a previous roster version", async () => {
  freshClients();
  await uploadSampleRoster();
  // A second upload REPLACES the first: old-version entries become invisible.
  await uploadSampleRoster({
    rows: [{ "Roll No": "99ZZ999", "Student Name": "Only One", "Email ID": "o@example.com", "Phone": "" }]
  });
  const stale = await call(makeReq({ method: "POST", path: "/api/roster/lookup", body: { unique_id: "21CS001" } }));
  assert.equal(stale.statusCode, 404);
  const fresh = await call(makeReq({ method: "POST", path: "/api/roster/lookup", body: { unique_id: "99zz999" } }));
  assert.equal(fresh.statusCode, 200);
  assert.equal(fresh.body.name, "Only One");
});

// ---- Task 3: roster gate on /api/session/start ------------------------------

function startBody(overrides = {}) {
  return {
    hackerrank_username: "typed_user", name: "Typed Name", roll_number: "TYPED-1",
    email: "typed@example.com", room: "Lab A-1", consent_accepted: true, ...overrides
  };
}

test("start: roster configured + missing roster_unique_id -> 403 roster_id_required", async () => {
  const { firestore } = freshClients();
  seedOpenWindow(firestore);
  await uploadSampleRoster();
  const res = await call(makeReq({ method: "POST", path: "/api/session/start", body: startBody() }));
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "roster_id_required");
});

test("start: unknown roster id -> 403 not_on_roster", async () => {
  const { firestore } = freshClients();
  seedOpenWindow(firestore);
  await uploadSampleRoster();
  const res = await call(makeReq({ method: "POST", path: "/api/session/start",
    body: startBody({ roster_unique_id: "99XX999" }) }));
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "not_on_roster");
});

test("start: valid roster id -> session created with roster-overridden identity", async () => {
  const { firestore } = freshClients();
  seedOpenWindow(firestore);
  await uploadSampleRoster();
  const res = await call(makeReq({ method: "POST", path: "/api/session/start",
    body: startBody({ roster_unique_id: "21cs001" }) }));
  assert.equal(res.statusCode, 200);
  const doc = await firestore.collection(process.env.SESSION_COLLECTION).doc(res.body.session_id).get();
  const session = doc.data();
  assert.equal(session.name, "Asha Raman");              // roster wins over "Typed Name"
  assert.equal(session.email, "asha@example.com");       // raw roster email, not the typed/masked one
  assert.equal(session.roll_number, "21CS001");
  assert.equal(session.roster_unique_id, "21CS001");
  assert.equal(session.roster_verified, true);
  assert.equal(session.hackerrank_username, "typed_user"); // not mapped -> typed value kept
});

test("start: roster-mapped hackerrank_username overrides the typed one", async () => {
  const { firestore } = freshClients();
  seedOpenWindow(firestore);
  await uploadSampleRoster({
    columns: ["Roll No", "Student Name", "HR Handle"],
    column_mapping: { name: "Student Name", hackerrank_username: "HR Handle", roll_number: "Roll No" },
    rows: [{ "Roll No": "21CS001", "Student Name": "Asha Raman", "HR Handle": "asha_hr" }]
  });
  const res = await call(makeReq({ method: "POST", path: "/api/session/start",
    body: startBody({ roster_unique_id: "21CS001" }) }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.hackerrank_username, "asha_hr");
  const doc = await firestore.collection(process.env.SESSION_COLLECTION).doc(res.body.session_id).get();
  assert.equal(doc.data().username_norm, "asha_hr");
});

test("start: NO roster configured -> legacy flow unchanged (regression)", async () => {
  const { firestore } = freshClients();
  seedOpenWindow(firestore);
  const res = await call(makeReq({ method: "POST", path: "/api/session/start", body: startBody() }));
  assert.equal(res.statusCode, 200);
  const doc = await firestore.collection(process.env.SESSION_COLLECTION).doc(res.body.session_id).get();
  assert.equal(doc.data().name, "Typed Name");
  assert.equal(doc.data().roster_verified, false);
  assert.equal(doc.data().roster_unique_id, "");
});
