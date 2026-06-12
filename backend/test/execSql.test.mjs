// backend/test/execSql.test.mjs
// SQL (language 82) exec assembly. Judge0's run command for 82 redirects the
// SCRIPT FILE into `sqlite3 /box/db.sqlite` — the stdin field is DEAD on the
// engine (verified empirically on the production instance). These tests pin
// the server-side composition both exec endpoints must perform for SQL:
//   source_code = SQL_FORMAT_PRELUDE + test.input (seed SQL) + "\n" + query
//   stdin       = ""
// …and, just as load-bearing, that every NON-sql language's items stay
// byte-identical to the pre-SQL shape (source as-is, test input on stdin).
import { test } from "node:test";
import assert from "node:assert/strict";

// Env MUST be set before importing the handler (it reads env at module load).
// A unique ?execsql query gives a fresh module instance independent of the
// other test files (which configure different collections).
process.env.EVIDENCE_BUCKET = "execsql-bucket";
process.env.SESSION_COLLECTION = "execsql_sessions";
process.env.SETTINGS_COLLECTION = "execsql_settings";
process.env.SUBMISSIONS_COLLECTION = "execsql_submissions";
process.env.PROBLEMS_COLLECTION = "execsql_problems";
process.env.ADMIN_PASSWORD = "execsql-admin-pass";

const handler = await import("../src/handler.mjs?execsql");
const { api, __setClientsForTest, __setJudge0AdapterForTest, __setExecClockForTest } = handler;

import {
  composeSqlExecSource,
  LANGUAGE_IDS,
  SQL_FORMAT_PRELUDE,
  SUPPORTED_LANGUAGES,
  cleanStubs,
  validateProblemInput
} from "../src/problems.mjs";

// Deterministic clock for the per-session exec rate limiter (mirrors
// exec.test.mjs). Tests use distinct sessions, so stepping is rarely needed.
let nowMs = Date.UTC(2026, 0, 1);
__setExecClockForTest(() => nowMs);
const advanceClock = (ms) => { nowMs += ms; };

// Inline req/res mocks + fakes, copied from exec.test.mjs (NO helpers.mjs).
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
  return {
    _collections: collections,
    collection(name) {
      const store = getCollection(name);
      return {
        doc(id) {
          return {
            id,
            async set(value) { store.set(id, { ...value }); },
            async get() {
              const data = store.get(id);
              return { exists: Boolean(data), data: () => data };
            },
            async delete() { store.delete(id); }
          };
        }
      };
    }
  };
}

function makeFakeStorage() {
  return { bucket() { return { file() { return { async save() {}, async getSignedUrl() { return ["https://signed.example/x"]; } }; } }; } };
}

// The published SQL problem under test. Test `input` holds the hidden seed SQL
// (CREATE+INSERT); `expected` is what sqlite3 prints after the format prelude.
const SQL_SEED_SAMPLE = "CREATE TABLE T (A INTEGER, B TEXT);\nINSERT INTO T VALUES (1,'x'),(2,'y');";
const SQL_SEED_HIDDEN_1 = "CREATE TABLE T (A INTEGER, B TEXT);\nINSERT INTO T VALUES (3,'z');";
const SQL_SEED_HIDDEN_2 = "CREATE TABLE T (A INTEGER, B TEXT);\nINSERT INTO T VALUES (4,NULL),(5,'w');";
function seedSqlProblem(firestore) {
  firestore.collection(process.env.PROBLEMS_COLLECTION).doc("pick-rows").set({
    id: "pick-rows", title: "Pick Rows", statement: "Select every row of T.",
    languages: ["sql"], cpuTimeLimit: 5, memoryLimit: 128000,
    points: 100, scoring: "per_test", status: "published",
    sampleTests: [{ input: SQL_SEED_SAMPLE, expected: "1 x\n2 y" }],
    hiddenTests: [
      { input: SQL_SEED_HIDDEN_1, expected: "3 z" },
      { input: SQL_SEED_HIDDEN_2, expected: "4 NULL\n5 w" }
    ]
  });
}

const QUERY = "SELECT A, B FROM T ORDER BY A;";

function captureAdapter(seen) {
  return { runBatch: async (items) => {
    seen.push(...items);
    return items.map(() => ({ status: "accepted", passed: true, stdout: "", stderr: "", compileOutput: "", timeSec: 0.005, memoryKb: 100 }));
  } };
}

// ---- the language registration + its validation cascade ---------------------

test("sql is a first-class language: id 82, SUPPORTED_LANGUAGES, authoring + stub validation cascade", () => {
  assert.equal(LANGUAGE_IDS.sql, 82);
  assert.ok(SUPPORTED_LANGUAGES.includes("sql"));
  // validateProblemInput accepts languages:["sql"] + a sql stub (the allowlist
  // is derived from LANGUAGE_IDS — no second list to update).
  const result = validateProblemInput({
    id: "sql-only", title: "T", statement: "S",
    languages: ["sql"], cpuTimeLimit: 5, memoryLimit: 128000,
    sampleTests: [{ input: "CREATE TABLE T (A INT);", expected: "" }],
    hiddenTests: [{ input: "CREATE TABLE T (A INT);", expected: "" }],
    stubs: { sql: "-- Write your SQL query below.\n" }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.problem.languages, ["sql"]);
  assert.equal(result.problem.stubs.sql, "-- Write your SQL query below.\n");
  // cleanStubs itself accepts the sql key too (cascade, not a parallel list).
  assert.equal(cleanStubs({ sql: "-- q" }).ok, true);
});

// ---- the authoring-rule helper ----------------------------------------------

test("composeSqlExecSource pins the prelude constant and the concat order (prelude + seed + newline + query)", () => {
  // The prelude is part of the judged byte stream — a change here changes
  // every SQL expected output, so it is pinned verbatim.
  assert.equal(SQL_FORMAT_PRELUDE, '.separator " "\n.nullvalue NULL\n');
  assert.equal(
    composeSqlExecSource("CREATE TABLE T (A INT);", "SELECT * FROM T;"),
    '.separator " "\n.nullvalue NULL\nCREATE TABLE T (A INT);\nSELECT * FROM T;'
  );
});

// ---- /api/exec/run -----------------------------------------------------------

test("POST /api/exec/run (sql): each sample item ships the composed script as source with EMPTY stdin", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSqlProblem(firestore);
  firestore.collection(process.env.SESSION_COLLECTION).doc("sql-run").set({ session_id: "sql-run", status: "active" });
  const seen = [];
  __setJudge0AdapterForTest(captureAdapter(seen));

  const res = await call(makeReq({ method: "POST", path: "/api/exec/run",
    body: { session_id: "sql-run", problem_id: "pick-rows", language: "sql", source_code: QUERY } }));
  assert.equal(res.statusCode, 200);
  assert.equal(seen.length, 1);
  // THE assembly: prelude + seed SQL (the test's input) + "\n" + candidate query.
  assert.deepEqual(seen[0], {
    languageId: 82,
    source: SQL_FORMAT_PRELUDE + SQL_SEED_SAMPLE + "\n" + QUERY,
    stdin: "",
    expectedOutput: "1 x\n2 y",
    cpuTimeLimit: 5,
    memoryLimit: 128000
  });
  // Samples are not secret: the echoed input is the sample's seed SQL.
  assert.equal(res.body.results[0].input, SQL_SEED_SAMPLE);
  assert.equal(res.body.results[0].expected, "1 x\n2 y");
  __setJudge0AdapterForTest(null);
});

// ---- /api/exec/submit ----------------------------------------------------------

test("POST /api/exec/submit (sql): every hidden item is composed per-test (own seed, empty stdin); stored language is sql", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSqlProblem(firestore);
  firestore.collection(process.env.SESSION_COLLECTION).doc("sql-sub").set({ session_id: "sql-sub", status: "active" });
  const seen = [];
  __setJudge0AdapterForTest(captureAdapter(seen));

  const res = await call(makeReq({ method: "POST", path: "/api/exec/submit",
    body: { session_id: "sql-sub", problem_id: "pick-rows", language: "sql", source_code: QUERY } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.verdict, "accepted");
  assert.equal(seen.length, 2); // both hidden tests
  assert.deepEqual(seen.map((item) => item.source), [
    SQL_FORMAT_PRELUDE + SQL_SEED_HIDDEN_1 + "\n" + QUERY,
    SQL_FORMAT_PRELUDE + SQL_SEED_HIDDEN_2 + "\n" + QUERY
  ]);
  assert.deepEqual(seen.map((item) => item.stdin), ["", ""]);
  assert.deepEqual(seen.map((item) => item.languageId), [82, 82]);
  assert.deepEqual(seen.map((item) => item.expectedOutput), ["3 z", "4 NULL\n5 w"]);
  // The stored submission records the candidate's RAW query (their work), not
  // the composed script — and the validated language "sql".
  const stored = [...firestore._collections.get(process.env.SUBMISSIONS_COLLECTION).values()].at(-1);
  assert.equal(stored.language, "sql");
  assert.equal(stored.source_code, QUERY);
  __setJudge0AdapterForTest(null);
});

// ---- the non-sql pin -----------------------------------------------------------

test("non-sql languages stay byte-identical: python items carry the source as-is with the test input on stdin (run + submit)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  firestore.collection(process.env.SESSION_COLLECTION).doc("py-pin").set({ session_id: "py-pin", status: "active" });
  const seen = [];
  __setJudge0AdapterForTest(captureAdapter(seen));
  const source = "print(sum(map(int,input().split())))";

  // Run: items judged against the seed problem's two sample tests.
  let res = await call(makeReq({ method: "POST", path: "/api/exec/run",
    body: { session_id: "py-pin", problem_id: "sum-two", language: "python", source_code: source } }));
  assert.equal(res.statusCode, 200);
  assert.equal(seen.length, 2);
  // The EXACT pre-SQL item shape — no composition, no stdin blanking.
  assert.deepEqual(seen[0], {
    languageId: 71, source, stdin: "2 3\n", expectedOutput: "5",
    cpuTimeLimit: 5, memoryLimit: 128000
  });
  assert.deepEqual(seen[1], {
    languageId: 71, source, stdin: "10 20\n", expectedOutput: "30",
    cpuTimeLimit: 5, memoryLimit: 128000
  });

  // Submit: same pin across the hidden-test path.
  seen.length = 0;
  advanceClock(3600_000);
  res = await call(makeReq({ method: "POST", path: "/api/exec/submit",
    body: { session_id: "py-pin", problem_id: "sum-two", language: "python", source_code: source } }));
  assert.equal(res.statusCode, 200);
  assert.equal(seen.length, 4); // sum-two's four hidden tests
  assert.deepEqual(seen[0], {
    languageId: 71, source, stdin: "0 0\n", expectedOutput: "0",
    cpuTimeLimit: 5, memoryLimit: 128000
  });
  for (const item of seen) {
    assert.equal(item.source, source);        // never composed
    assert.notEqual(item.stdin, "");          // never blanked
  }
  __setJudge0AdapterForTest(null);
});

// ---- sql problems reject non-sql languages exactly like any other mismatch ----

test("a sql-only problem still 400s an unsupported language string (allowlist unchanged)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSqlProblem(firestore);
  firestore.collection(process.env.SESSION_COLLECTION).doc("sql-bad").set({ session_id: "sql-bad", status: "active" });
  __setJudge0AdapterForTest({ runBatch: async () => { throw new Error("must not reach the engine"); } });
  const res = await call(makeReq({ method: "POST", path: "/api/exec/run",
    body: { session_id: "sql-bad", problem_id: "pick-rows", language: "plsql", source_code: QUERY } }));
  assert.equal(res.statusCode, 400);
  __setJudge0AdapterForTest(null);
});
