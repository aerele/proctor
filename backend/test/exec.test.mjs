// backend/test/exec.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

// Env MUST be set before importing the handler (it reads env at module load).
// A unique ?exec query gives a fresh module instance independent of the other
// test files (which configure different collections).
process.env.EVIDENCE_BUCKET = "exec-bucket";
process.env.SESSION_COLLECTION = "exec_sessions";
process.env.SETTINGS_COLLECTION = "exec_settings";
process.env.SUBMISSIONS_COLLECTION = "exec_submissions";
process.env.ADMIN_PASSWORD = "exec-admin-pass";

const handler = await import("../src/handler.mjs?exec");
const { api, __setClientsForTest, __setJudge0AdapterForTest } = handler;

import { getProblem, LANGUAGE_IDS } from "../src/problems.mjs";

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

// ---- Fake Firestore (supports create / update / set / get / where) --------
// Pasted verbatim from phase2.test.mjs (backs the __setClientsForTest seam
// used by Tasks 3 & 4). The problem-shape tests below don't need them, but
// the exec tests do.

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

test("getProblem returns the slice-1 problem with samples, hidden tests, language ids", () => {
  const p = getProblem("sum-two");
  assert.equal(p.id, "sum-two");
  assert.ok(p.statement.length > 0);
  assert.ok(Array.isArray(p.sampleTests) && p.sampleTests.length >= 1);
  assert.ok(Array.isArray(p.hiddenTests) && p.hiddenTests.length >= 3);
  assert.ok(p.sampleTests[0].input !== undefined && p.sampleTests[0].expected !== undefined);
  // language map covers all four
  for (const lang of ["python", "cpp", "java", "javascript"]) assert.ok(LANGUAGE_IDS[lang]);
});

test("getProblem returns null for unknown id", () => {
  assert.equal(getProblem("nope"), null);
});
