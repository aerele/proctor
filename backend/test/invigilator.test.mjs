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
