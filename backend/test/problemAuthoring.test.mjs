// backend/test/problemAuthoring.test.mjs — S4: problem bank CRUD, active-problem
// assignment, public problem in start/resume, exec-from-bank + scoring.
import { test } from "node:test";
import assert from "node:assert/strict";

// Env MUST be set before importing the handler (it reads env at module load).
// A unique ?problems query gives a fresh module instance independent of the
// other test files (which configure different collections).
process.env.EVIDENCE_BUCKET = "problems-bucket";
process.env.SESSION_COLLECTION = "problems_sessions";
process.env.SETTINGS_COLLECTION = "problems_settings";
process.env.PROBLEMS_COLLECTION = "problems_bank";
process.env.SUBMISSIONS_COLLECTION = "problems_submissions";
process.env.ADMIN_PASSWORD = "problems-admin-pass";

const handler = await import("../src/handler.mjs?problems");
const { api, __setClientsForTest, __setJudge0AdapterForTest } = handler;

const ADMIN = { "x-admin-password": "problems-admin-pass" };

// ---- Inline req/res + fakes, copied from phase2.test.mjs (NO helpers.mjs) ----

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

function freshClients() {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  return { firestore, storage };
}

function validProblem(overrides = {}) {
  return {
    id: "rev-str", title: "Reverse", statement: "Reverse the input line.",
    languages: ["python", "cpp"], cpuTimeLimit: 2, memoryLimit: 64000,
    points: 80, scoring: "per_test", status: "published",
    sampleTests: [{ input: "ab\n", expected: "ba" }],
    hiddenTests: [
      { input: "abc\n", expected: "cba" },
      { input: "xy\n", expected: "yx" },
      { input: "z\n", expected: "z" },
      { input: "hello\n", expected: "olleh" }
    ],
    ...overrides
  };
}

// ---- Task 2: admin CRUD ------------------------------------------------------

test("problem CRUD endpoints are admin-gated (401 without the password)", async () => {
  freshClients();
  for (const req of [
    makeReq({ method: "GET", path: "/api/admin/problems" }),
    makeReq({ method: "GET", path: "/api/admin/problem", query: { id: "rev-str" } }),
    makeReq({ method: "POST", path: "/api/admin/problems", body: validProblem() }),
    makeReq({ method: "POST", path: "/api/admin/problem-delete", body: { id: "rev-str" } })
  ]) {
    const res = await call(req);
    assert.equal(res.statusCode, 401, `${req.method} ${req.path} must 401`);
  }
});

test("create -> get -> list roundtrip; list carries summaries WITHOUT test contents", async () => {
  freshClients();
  const created = await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem() }));
  assert.equal(created.statusCode, 200);
  assert.equal(created.body.ok, true);
  assert.equal(created.body.problem.id, "rev-str");
  assert.ok(created.body.problem.created_at);
  assert.ok(created.body.problem.updated_at);

  const got = await call(makeReq({ method: "GET", path: "/api/admin/problem", headers: ADMIN, query: { id: "rev-str" } }));
  assert.equal(got.statusCode, 200);
  assert.equal(got.body.problem.hiddenTests.length, 4); // admin sees hidden tests

  const list = await call(makeReq({ method: "GET", path: "/api/admin/problems", headers: ADMIN }));
  assert.equal(list.statusCode, 200);
  assert.equal(list.body.problems.length, 1);
  const row = list.body.problems[0];
  assert.equal(row.sample_count, 1);
  assert.equal(row.hidden_count, 4);
  assert.equal(row.status, "published");
  assert.equal(row.hiddenTests, undefined); // summaries only
  assert.equal(row.sampleTests, undefined);
});

test("upsert preserves created_at and refreshes updated_at", async () => {
  const { firestore } = freshClients();
  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem() }));
  const first = firestore._collections.get("problems_bank").get("rev-str");
  // backdate so the refresh is observable
  firestore._collections.get("problems_bank").set("rev-str", { ...first, created_at: "2020-01-01T00:00:00.000Z", updated_at: "2020-01-01T00:00:00.000Z" });
  const updated = await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem({ title: "Reverse v2" }) }));
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.body.problem.created_at, "2020-01-01T00:00:00.000Z");
  assert.notEqual(updated.body.problem.updated_at, "2020-01-01T00:00:00.000Z");
  assert.equal(updated.body.problem.title, "Reverse v2");
});

test("save validation: bad id and empty hiddenTests -> 400 with the specific error", async () => {
  freshClients();
  const badId = await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem({ id: "Bad_ID" }) }));
  assert.equal(badId.statusCode, 400);
  const noHidden = await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem({ hiddenTests: [] }) }));
  assert.equal(noHidden.statusCode, 400);
  // intentional 4xx httpErrors are serialized as {error: message, detail: message}
  assert.match(noHidden.body.error, /hiddenTests/);
});

test("GET unknown problem -> 404; invalid id -> 400", async () => {
  freshClients();
  assert.equal((await call(makeReq({ method: "GET", path: "/api/admin/problem", headers: ADMIN, query: { id: "ghost" } }))).statusCode, 404);
  assert.equal((await call(makeReq({ method: "GET", path: "/api/admin/problem", headers: ADMIN, query: { id: "a/b" } }))).statusCode, 400);
});

test("delete removes the doc and clears a matching active problem_id from settings", async () => {
  const { firestore } = freshClients();
  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem() }));
  firestore.collection("problems_settings").doc("active").set({
    start_at: "2026-01-01T00:00:00.000Z", end_at: "2027-01-01T00:00:00.000Z", problem_id: "rev-str"
  });
  const res = await call(makeReq({ method: "POST", path: "/api/admin/problem-delete", headers: ADMIN, body: { id: "rev-str" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(firestore._collections.get("problems_bank").has("rev-str"), false);
  assert.equal(firestore._collections.get("problems_settings").get("active").problem_id, "");
});
