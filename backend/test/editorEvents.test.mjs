// backend/test/editorEvents.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

// Env BEFORE import; unique ?editor cache-buster for a fresh module instance.
process.env.EVIDENCE_BUCKET = "editor-bucket";
process.env.SESSION_COLLECTION = "editor_sessions";
process.env.SETTINGS_COLLECTION = "editor_settings";
process.env.EDITOR_EVENTS_COLLECTION = "editor-events";
process.env.ADMIN_PASSWORD = "editor-admin-pass";

const handler = await import("../src/handler.mjs?editor");
const { api, __setClientsForTest } = handler;

// Inline req/res + fakes, copied from phase2.test.mjs (NO helpers.mjs).
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

// ---- Fake Firestore (supports create / update / set / get / where) --------
// Copied from phase2.test.mjs. The fake storage records every save in
// `storage._saved` (key -> body), which is what we assert against — there is
// NO globalThis.__GCS_APPEND__ seam.

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
          // Mirror the Firestore operators the handler actually uses: scalar
          // equality and the `in` membership test (a small value array).
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
              // H1: live-slot lock release. Idempotent — deleting a missing doc
              // is a no-op, matching Firestore's delete semantics.
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

test("POST /api/editor-events accepts a batch and writes NDJSON to GCS under the session prefix", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  // Seed an ACTIVE session so the ownership gate passes; key uses its storage_prefix.
  firestore.collection(process.env.SESSION_COLLECTION).doc("s1").set({
    session_id: "s1", status: "active", username_norm: "alice", storage_prefix: "sessions/alice/s1/"
  });
  const events = [
    { type: "editor_insert", timestamp: "2026-06-09T10:00:00.000Z", detail: { len: 1, line: 1, col: 2 } },
    { type: "editor_cursor", timestamp: "2026-06-09T10:00:01.000Z", detail: { line: 3, col: 1 } }
  ];
  const res = await call(makeReq({ method: "POST", path: "/api/editor-events",
    body: { session_id: "s1", problem_id: "sum-two", events } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.stored, 2);
  // Exactly one GCS object written, under the session prefix's editor-events/ folder.
  const keys = [...storage._saved.keys()];
  assert.equal(keys.length, 1);
  assert.match(keys[0], /^sessions\/alice\/s1\/editor-events\/.*\.ndjson$/);
  assert.equal(storage._saved.get(keys[0]).trim().split("\n").length, 2);
});

test("POST /api/editor-events rejects an unknown/ended session (ownership gate)", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  firestore.collection(process.env.SESSION_COLLECTION).doc("s1").set({ session_id: "s1", status: "ended" });
  const res = await call(makeReq({ method: "POST", path: "/api/editor-events",
    body: { session_id: "s1", problem_id: "sum-two", events: [{ type: "editor_insert", timestamp: "t", detail: {} }] } }));
  assert.equal(res.statusCode, 409);
  assert.equal(storage._saved.size, 0); // nothing written
});

test("POST /api/editor-events rejects > MAX events with 400", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  firestore.collection(process.env.SESSION_COLLECTION).doc("s1").set({ session_id: "s1", status: "active", storage_prefix: "sessions/alice/s1/" });
  const events = Array.from({ length: 6000 }, () => ({ type: "editor_insert", timestamp: "t", detail: {} }));
  const res = await call(makeReq({ method: "POST", path: "/api/editor-events",
    body: { session_id: "s1", problem_id: "p", events } }));
  assert.equal(res.statusCode, 400);
});
