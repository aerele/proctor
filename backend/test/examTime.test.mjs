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
