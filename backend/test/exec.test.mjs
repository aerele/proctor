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
// Tiny exec-queue lanes (design §11 item 2) so the queue-full -> 429 wiring is
// testable with three concurrent requests. Every other test in this file runs
// ONE exec call at a time, so 1-deep lanes never interfere with them.
process.env.EXEC_RUN_CONCURRENCY = "1";
process.env.EXEC_SUBMIT_CONCURRENCY = "1";
process.env.EXEC_MAX_QUEUE = "1";
// The poll lane gets its OWN knob: the 1/1/1 lanes above exist to saturate the
// submit-phase gates; polling must stay wide so it never interacts with them.
process.env.EXEC_POLL_CONCURRENCY = "4";

const handler = await import("../src/handler.mjs?exec");
const { api, __setClientsForTest, __setJudge0AdapterForTest, __setExecClockForTest } = handler;

import { getProblem, LANGUAGE_IDS } from "../src/problems.mjs";

// Deterministic clock for the per-session exec rate limiter (the
// __setExecClockForTest seam mirrors __setClientsForTest). All limiter state in
// this module instance reads THIS clock, never Date.now(). Pre-existing exec
// tests reuse session "s1", so they advance the clock (advanceClock) between
// calls to step past cooldowns rather than weakening the limiter.
let nowMs = Date.UTC(2026, 0, 1);
__setExecClockForTest(() => nowMs);
const advanceClock = (ms) => { nowMs += ms; };

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

test("getProblem returns the slice-1 problem with samples, hidden tests, language ids", async () => {
  // S4: getProblem is async + Firestore-backed; an EMPTY fake store falls back
  // to the built-in seed. Fakes must be injected or the real client is hit.
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  const p = await getProblem("sum-two");
  assert.equal(p.id, "sum-two");
  assert.ok(p.statement.length > 0);
  assert.ok(Array.isArray(p.sampleTests) && p.sampleTests.length >= 1);
  assert.ok(Array.isArray(p.hiddenTests) && p.hiddenTests.length >= 3);
  assert.ok(p.sampleTests[0].input !== undefined && p.sampleTests[0].expected !== undefined);
  // language map covers all four
  for (const lang of ["python", "cpp", "java", "javascript"]) assert.ok(LANGUAGE_IDS[lang]);
});

test("getProblem returns null for unknown id", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  assert.equal(await getProblem("nope"), null);
});

test("getProblem rejects prototype keys: 'constructor' is null, not a function", async () => {
  // "constructor"/"hasOwnProperty" are not own keys of the seed bank but index
  // Object.prototype — a truthiness check would return a function and 500 in
  // the handlers. Object.hasOwn must gate the lookup.
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  assert.equal(await getProblem("constructor"), null);
  assert.equal(await getProblem("hasOwnProperty"), null);
  assert.equal(await getProblem("__proto__"), null);
});

test("POST /api/exec/run executes source against SAMPLE tests via the injected adapter", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  // Seed an ACTIVE session so the ownership gate passes (id = "s1").
  firestore.collection(process.env.SESSION_COLLECTION).doc("s1").set({
    session_id: "s1", status: "active", username_norm: "alice", storage_prefix: "sessions/alice/s1/"
  });
  // Inject a stub adapter via the NEW test seam (mirrors __setClientsForTest).
  __setJudge0AdapterForTest({
    runBatch: async (items) => items.map((it) => ({
      status: "accepted", passed: String(it.stdin).trim() === "2 3", stdout: "5",
      stderr: "", compileOutput: "", timeSec: 0.01, memoryKb: 100
    }))
  });
  const res = await call(makeReq({ method: "POST", path: "/api/exec/run",
    body: { session_id: "s1", problem_id: "sum-two", language: "python", source_code: "print(sum(map(int,input().split())))" } }));
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.results));
  assert.equal(res.body.results.length, 2);              // two sample tests
  assert.equal(res.body.results[0].input, "2 3\n");      // sample input echoed for display
  assert.equal(res.body.results[0].passed, true);
  __setJudge0AdapterForTest(null); // reset the seam
});

test("POST /api/exec/run 400 on unknown problem", async () => {
  advanceClock(3600_000); // step past the run cooldown the previous test started for "s1"
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  firestore.collection(process.env.SESSION_COLLECTION).doc("s1").set({ session_id: "s1", status: "active" });
  const res = await call(makeReq({ method: "POST", path: "/api/exec/run",
    body: { session_id: "s1", problem_id: "nope", language: "python", source_code: "x" } }));
  assert.equal(res.statusCode, 400);
});

test("POST /api/exec/run rejects an unknown/ended session (ownership gate)", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  firestore.collection(process.env.SESSION_COLLECTION).doc("s1").set({ session_id: "s1", status: "ended" });
  __setJudge0AdapterForTest({ runBatch: async () => { throw new Error("must not run for an ended session"); } });
  // ended session → requireWritableSession throws 409 BEFORE any adapter call.
  const res = await call(makeReq({ method: "POST", path: "/api/exec/run",
    body: { session_id: "s1", problem_id: "sum-two", language: "python", source_code: "x" } }));
  assert.equal(res.statusCode, 409);
  __setJudge0AdapterForTest(null);
});

test("POST /api/exec/submit runs HIDDEN tests, returns ONLY verdict + counts (§9 lock: no per-test array), and stores the full submission", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  firestore.collection(process.env.SESSION_COLLECTION).doc("s1").set({ session_id: "s1", status: "active" });
  const seen = [];
  __setJudge0AdapterForTest({ runBatch: async (items) => {
    seen.push(...items);
    return items.map(() => ({ status: "accepted", passed: true, stdout: "", stderr: "", compileOutput: "", timeSec: 0.01, memoryKb: 100 }));
  } });
  const res = await call(makeReq({ method: "POST", path: "/api/exec/submit",
    body: { session_id: "s1", problem_id: "sum-two", language: "python", source_code: "print(sum(map(int,input().split())))" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.verdict, "accepted");
  assert.equal(res.body.total, 4);            // four hidden tests
  assert.equal(res.body.passed_count, 4);
  // §9 lock: the candidate-facing response carries NO per-test array at all —
  // only the verdict + pass/fail counts (+ submission_id). S4 adds score/
  // max_points, derived from counts only, so they leak nothing about hidden tests.
  assert.equal(res.body.tests, undefined);
  assert.deepEqual(
    Object.keys(res.body).sort(),
    ["max_points", "passed_count", "score", "submission_id", "total", "verdict"]
  );
  assert.equal(seen.length, 4);               // judged against the 4 hidden tests
  // The submission was stored in the injected fake Firestore (observable).
  const subs = firestore._collections.get(process.env.SUBMISSIONS_COLLECTION);
  assert.equal(subs.size, 1);
  // Doc id is a randomUUID (NOT a session_id-composed string — injection-shaped).
  const storedId = [...subs.keys()][0];
  assert.match(storedId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.equal(res.body.submission_id, storedId);
  const stored = [...subs.values()][0];
  // session_id/problem_id/created_at remain FIELDS on the stored doc.
  assert.equal(stored.session_id, "s1");
  assert.equal(stored.problem_id, "sum-two");
  assert.equal(stored.verdict, "accepted");
  assert.ok(stored.created_at);
  // The STORED doc keeps the full per-test detail (admin-side analysis), still
  // WITHOUT the hidden inputs/expected.
  assert.ok(Array.isArray(stored.tests));
  assert.equal(stored.tests.length, 4);
  assert.equal(stored.tests[0].passed, true);
  assert.equal(stored.tests[0].status, "accepted");
  assert.equal(stored.tests[0].input, undefined);
  assert.equal(stored.tests[0].expected, undefined);
  __setJudge0AdapterForTest(null);
});

// M7: the STORED submission must record the VALIDATED language variable (the one
// checked against LANGUAGE_IDS), never the raw client body.language. A body
// shaped to coerce to a valid key — e.g. ["python"] (String(["python"]) ===
// "python", so it passes Object.hasOwn) — must land in Firestore as the clean
// primitive "python", not the array.
test("POST /api/exec/submit stores the VALIDATED language, not the raw client body.language", async () => {
  advanceClock(3600_000); // step past any prior submit cooldown for "s1"
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  firestore.collection(process.env.SESSION_COLLECTION).doc("ml-sub").set({ session_id: "ml-sub", status: "active" });
  __setJudge0AdapterForTest({ runBatch: async (items) =>
    items.map(() => ({ status: "accepted", passed: true, stdout: "", stderr: "", compileOutput: "", timeSec: 0, memoryKb: 1 })) });
  const res = await call(makeReq({ method: "POST", path: "/api/exec/submit",
    body: { session_id: "ml-sub", problem_id: "sum-two", language: ["python"], source_code: "x" } }));
  assert.equal(res.statusCode, 200);
  const subs = firestore._collections.get(process.env.SUBMISSIONS_COLLECTION);
  const stored = [...subs.values()].at(-1);
  // The clean validated primitive string is stored — NOT the array body sent.
  assert.equal(stored.language, "python");
  assert.equal(Array.isArray(stored.language), false);
  __setJudge0AdapterForTest(null);
});

test("POST /api/exec/submit: one failing hidden test -> verdict wrong_answer", async () => {
  advanceClock(3600_000); // step past the submit cooldown the previous test started for "s1"
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  firestore.collection(process.env.SESSION_COLLECTION).doc("s1").set({ session_id: "s1", status: "active" });
  __setJudge0AdapterForTest({ runBatch: async (items) => items.map((_, i) => ({ status: i === 2 ? "wrong_answer" : "accepted", passed: i !== 2, stdout: "", stderr: "", compileOutput: "", timeSec: 0, memoryKb: 1 })) });
  const res = await call(makeReq({ method: "POST", path: "/api/exec/submit",
    body: { session_id: "s1", problem_id: "sum-two", language: "python", source_code: "x" } }));
  assert.equal(res.body.verdict, "wrong_answer");
  assert.equal(res.body.passed_count, 3);
  // §9 lock holds on the failing path too: no per-test array in the response.
  assert.equal(res.body.tests, undefined);
  __setJudge0AdapterForTest(null);
});

// Verdict rule (adversarial review): a judging_timeout is an INFRA failure, not
// the candidate's fault — it must surface as "error", never "wrong_answer".
//   all passed                         → accepted
//   any judging_timeout among results  → error
//   otherwise (real failures only)     → wrong_answer
test("POST /api/exec/submit verdict: accepted / error (judging_timeout) / wrong_answer branches", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  firestore.collection(process.env.SESSION_COLLECTION).doc("s1").set({ session_id: "s1", status: "active" });
  // Each branch submits for the SAME session "s1": advance the injected clock
  // past the submit cooldown before every call so the limiter never interferes.
  const submit = () => {
    advanceClock(3600_000);
    return call(makeReq({ method: "POST", path: "/api/exec/submit",
      body: { session_id: "s1", problem_id: "sum-two", language: "python", source_code: "x" } }));
  };

  // Branch 1: every test passed → accepted.
  __setJudge0AdapterForTest({ runBatch: async (items) =>
    items.map(() => ({ status: "accepted", passed: true, stdout: "", stderr: "", compileOutput: "", timeSec: 0, memoryKb: 1 })) });
  let res = await submit();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.verdict, "accepted");

  // Branch 2: ANY judging_timeout (even alongside real failures) → error.
  __setJudge0AdapterForTest({ runBatch: async (items) =>
    items.map((_, i) => ({
      status: i === 1 ? "judging_timeout" : (i === 2 ? "wrong_answer" : "accepted"),
      passed: i !== 1 && i !== 2,
      stdout: "", stderr: "", compileOutput: "", timeSec: null, memoryKb: null
    })) });
  res = await submit();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.verdict, "error");
  // The stored submission carries the same infra-fault verdict (the fake
  // Firestore Map preserves insertion order; the last doc is this submission).
  const subs = firestore._collections.get(process.env.SUBMISSIONS_COLLECTION);
  assert.equal([...subs.values()].at(-1).verdict, "error");

  // Branch 3: failures with NO judging_timeout → wrong_answer.
  __setJudge0AdapterForTest({ runBatch: async (items) =>
    items.map((_, i) => ({ status: i === 0 ? "wrong_answer" : "accepted", passed: i !== 0, stdout: "", stderr: "", compileOutput: "", timeSec: 0, memoryKb: 1 })) });
  res = await submit();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.verdict, "wrong_answer");

  __setJudge0AdapterForTest(null);
});

test("POST /api/exec/submit rejects an unknown/ended session (ownership gate)", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  firestore.collection(process.env.SESSION_COLLECTION).doc("s1").set({ session_id: "s1", status: "ended" });
  __setJudge0AdapterForTest({ runBatch: async () => { throw new Error("must not run for an ended session"); } });
  const res = await call(makeReq({ method: "POST", path: "/api/exec/submit",
    body: { session_id: "s1", problem_id: "sum-two", language: "python", source_code: "x" } }));
  assert.equal(res.statusCode, 409);
  assert.equal(firestore._collections.get(process.env.SUBMISSIONS_COLLECTION)?.size || 0, 0); // nothing stored
  __setJudge0AdapterForTest(null);
});

// ---- Per-session exec rate limiting (security review) ----------------------
// The hosted Judge0 key is METERED — a leaked or looping session token must not
// be able to drain it. Defaults under test: one run / 5 s, one submit / 20 s,
// at most 50 stored submissions per session+problem. Violations are 429s that
// carry a machine-readable retry_after_seconds in the standard JSON error body.
// Every test below uses its own session id so limiter state never leaks across
// tests; cooldown stepping uses the injected clock (advanceClock), never sleeps.

// Seed an active session + a counting always-pass adapter for the limiter tests.
function seedLimiterFixture(sessionId) {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  firestore.collection(process.env.SESSION_COLLECTION).doc(sessionId).set({ session_id: sessionId, status: "active" });
  const counter = { batches: 0 };
  __setJudge0AdapterForTest({ runBatch: async (items) => {
    counter.batches += 1;
    return items.map(() => ({ status: "accepted", passed: true, stdout: "", stderr: "", compileOutput: "", timeSec: 0, memoryKb: 1 }));
  } });
  return { firestore, counter };
}
const execReq = (path, sessionId) => makeReq({ method: "POST", path,
  body: { session_id: sessionId, problem_id: "sum-two", language: "python", source_code: "x" } });

test("exec rate limit: second /api/exec/run within the cooldown -> 429 + retry_after_seconds, no judge0 call; allowed after the clock passes the cooldown", async () => {
  const { counter } = seedLimiterFixture("rl-run");
  const run = () => call(execReq("/api/exec/run", "rl-run"));

  let res = await run();
  assert.equal(res.statusCode, 200);
  assert.equal(counter.batches, 1);

  // Immediately again (fake clock unmoved): rate-limited, judge0 NOT touched,
  // and the body mirrors the standard error shape plus the retry hint.
  res = await run();
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.error, "rate_limited");
  assert.equal(typeof res.body.retry_after_seconds, "number");
  assert.ok(res.body.retry_after_seconds >= 1 && res.body.retry_after_seconds <= 5);
  assert.equal(counter.batches, 1);

  // Advance the injected clock past the 5 s default cooldown: allowed again.
  advanceClock(5_000);
  res = await run();
  assert.equal(res.statusCode, 200);
  assert.equal(counter.batches, 2);
  __setJudge0AdapterForTest(null);
});

test("exec rate limit: second /api/exec/submit within the cooldown -> 429 + retry_after_seconds, nothing stored; allowed after the cooldown", async () => {
  const { firestore, counter } = seedLimiterFixture("rl-sub");
  const submit = () => call(execReq("/api/exec/submit", "rl-sub"));
  const subs = () => firestore._collections.get(process.env.SUBMISSIONS_COLLECTION)?.size || 0;

  let res = await submit();
  assert.equal(res.statusCode, 200);
  assert.equal(subs(), 1);

  res = await submit();
  assert.equal(res.statusCode, 429);
  assert.equal(typeof res.body.retry_after_seconds, "number");
  assert.ok(res.body.retry_after_seconds >= 1 && res.body.retry_after_seconds <= 20);
  assert.equal(counter.batches, 1); // judge0 untouched on the limited call
  assert.equal(subs(), 1);          // nothing extra stored

  // Past the 20 s default submit cooldown: allowed again.
  advanceClock(20_000);
  res = await submit();
  assert.equal(res.statusCode, 200);
  assert.equal(subs(), 2);
  __setJudge0AdapterForTest(null);
});

test("exec rate limit: 50-stored-submissions cap per session+problem -> 429 even after the cooldown has elapsed", async () => {
  const { firestore, counter } = seedLimiterFixture("rl-cap");
  // Step 21 s (> the 20 s cooldown, << the 1 h prune horizon) before each
  // submit so ONLY the cap can reject.
  const submit = () => { advanceClock(21_000); return call(execReq("/api/exec/submit", "rl-cap")); };
  const subs = () => firestore._collections.get(process.env.SUBMISSIONS_COLLECTION)?.size || 0;

  for (let i = 0; i < 50; i++) {
    const res = await submit();
    assert.equal(res.statusCode, 200, `submission ${i + 1} of 50 should be allowed`);
  }
  assert.equal(subs(), 50);
  assert.equal(counter.batches, 50);

  // 51st: cooldown fully elapsed, but the per-session+problem budget holds.
  let res = await submit();
  assert.equal(res.statusCode, 429);
  assert.equal(typeof res.body.retry_after_seconds, "number");
  assert.equal(subs(), 50);
  assert.equal(counter.batches, 50); // judge0 never reached

  // Still capped after another minute — it's a budget, not a cooldown.
  advanceClock(60_000);
  res = await submit();
  assert.equal(res.statusCode, 429);
  assert.equal(subs(), 50);
  __setJudge0AdapterForTest(null);
});

test("exec rate limit: different sessions are limited independently", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  for (const id of ["rl-ind-a", "rl-ind-b"]) {
    firestore.collection(process.env.SESSION_COLLECTION).doc(id).set({ session_id: id, status: "active" });
  }
  __setJudge0AdapterForTest({ runBatch: async (items) =>
    items.map(() => ({ status: "accepted", passed: true, stdout: "", stderr: "", compileOutput: "", timeSec: 0, memoryKb: 1 })) });

  let res = await call(execReq("/api/exec/run", "rl-ind-a"));
  assert.equal(res.statusCode, 200);
  // A different session at the SAME instant is not blocked by a's cooldown...
  res = await call(execReq("/api/exec/run", "rl-ind-b"));
  assert.equal(res.statusCode, 200);
  // ...while a itself still is.
  res = await call(execReq("/api/exec/run", "rl-ind-a"));
  assert.equal(res.statusCode, 429);
  __setJudge0AdapterForTest(null);
});

test("exec rate limit: a validation-rejected request does not consume the cooldown slot", async () => {
  const { counter } = seedLimiterFixture("rl-val");
  // Unknown problem -> 400 BEFORE any judge0 dispatch; must not start a cooldown.
  let res = await call(makeReq({ method: "POST", path: "/api/exec/run",
    body: { session_id: "rl-val", problem_id: "nope", language: "python", source_code: "x" } }));
  assert.equal(res.statusCode, 400);
  // An immediate VALID run is therefore still allowed.
  res = await call(execReq("/api/exec/run", "rl-val"));
  assert.equal(res.statusCode, 200);
  assert.equal(counter.batches, 1);
  __setJudge0AdapterForTest(null);
});

// ---- Exec queue wiring (design §11 item 2) ----------------------------------
// A module-level queue sits between the handlers and judge0(): the run lane
// here is 1-wide with 1 queued slot (env at the top of this file), so a THIRD
// concurrent run must be rejected by the queue as an HTTP 429 "queue_full" —
// distinguishable from the limiter's "rate_limited". Three different sessions
// are used so the per-session rate limiter never fires.

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((r) => setImmediate(r));

test("exec queue wiring: run-lane overflow -> immediate 429 queue_full; queued runs + submits still complete; the rejection consumes no cooldown", async () => {
  advanceClock(3600_000); // fresh cooldown horizon for the sessions below
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  for (const id of ["qf-a", "qf-b", "qf-c", "qf-d"]) {
    firestore.collection(process.env.SESSION_COLLECTION).doc(id).set({ session_id: id, status: "active" });
  }
  const gate = deferred();
  let batches = 0;
  // Gate-aware stub (defect 3 wiring): the handler passes the lanes as
  // gates, so the stub holds its "submit POST" INSIDE the submitGate — that
  // is what parks a lane slot and makes the 1-deep run lane overflow.
  __setJudge0AdapterForTest({ runBatch: async (items, gates = {}) => {
    const submitGate = gates.submitGate ?? ((fn) => fn());
    await submitGate(async () => {
      batches++;
      await gate.promise; // hold the lane until the test releases it
    });
    return items.map(() => ({ status: "accepted", passed: true, stdout: "", stderr: "", compileOutput: "", timeSec: 0, memoryKb: 1 }));
  } });

  // Two concurrent runs: A dispatches (active), B parks in the 1-deep queue.
  const pA = call(execReq("/api/exec/run", "qf-a"));
  const pB = call(execReq("/api/exec/run", "qf-b"));
  await tick(); await tick();
  assert.equal(batches, 1); // only A reached judge0; B is queued, not dropped

  // Third concurrent run: the queue is full -> rejected IMMEDIATELY (no
  // waiting on the gate), as a 429 with the machine-readable queue_full error.
  const pC = call(execReq("/api/exec/run", "qf-c"));
  let cSettled = false;
  pC.then(() => { cSettled = true; });
  await tick(); await tick();
  assert.equal(cSettled, true, "queue-full rejection must not wait for a lane slot");

  // The submit lane is INDEPENDENT: a submit is accepted (parks/dispatches in
  // its own lane) even while the run lane is saturated. A FOURTH session is
  // used — qf-a still has its run in flight, and the S-I per-session
  // serialization guard would 429 a same-session submit.
  const pSubmit = call(execReq("/api/exec/submit", "qf-d"));

  gate.resolve();
  const [resA, resB, resC, resSubmit] = await Promise.all([pA, pB, pC, pSubmit]);
  assert.equal(resA.statusCode, 200);
  assert.equal(resB.statusCode, 200); // queued, never dropped
  assert.equal(resSubmit.statusCode, 200);
  assert.equal(resC.statusCode, 429);
  assert.equal(resC.body.error, "queue_full"); // NOT the limiter's "rate_limited"
  assert.equal(typeof resC.body.retry_after_seconds, "number");
  assert.equal(batches, 3); // A + B + submit dispatched; C never reached judge0

  // A queue-full rejection is the SERVER being busy — it must not consume the
  // session's run cooldown: with the lane idle again (clock unmoved), an
  // immediate retry for qf-c succeeds instead of 429 rate_limited.
  const retry = await call(execReq("/api/exec/run", "qf-c"));
  assert.equal(retry.statusCode, 200);
  assert.equal(batches, 4);
  __setJudge0AdapterForTest(null);
});

// ---- Engine-failure mapping + cooldown restore (review defect 2) ------------
// Any failure of the queued judge0 call is the SERVER's fault, never the
// candidate's: the cooldown slot must always be given back, and engine
// failures (errors carrying .status — adapter HTTP errors, retry exhaustion)
// must surface as an intentional 503 "judge_unavailable" with a retry hint,
// not as a bare 500. Genuine programming errors (no .status) stay 500.

test("exec engine failure on /api/exec/run: .status error -> 503 judge_unavailable + retry_after_seconds; cooldown NOT consumed", async () => {
  advanceClock(3600_000);
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  firestore.collection(process.env.SESSION_COLLECTION).doc("ef-run").set({ session_id: "ef-run", status: "active" });
  let failNext = true;
  let batches = 0;
  __setJudge0AdapterForTest({ runBatch: async (items) => {
    if (failNext) {
      // What the real adapter throws after its poll-retry budget is exhausted.
      const err = new Error("judge0 fetch failed: 503");
      err.status = 503;
      err.retryable = false;
      throw err;
    }
    batches++;
    return items.map(() => ({ status: "accepted", passed: true, stdout: "", stderr: "", compileOutput: "", timeSec: 0, memoryKb: 1 }));
  } });

  let res = await call(execReq("/api/exec/run", "ef-run"));
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, "judge_unavailable");
  assert.equal(typeof res.body.retry_after_seconds, "number");

  // The burned cooldown was restored: an IMMEDIATE retry (clock unmoved)
  // passes the limiter and reaches judge0.
  failNext = false;
  res = await call(execReq("/api/exec/run", "ef-run"));
  assert.equal(res.statusCode, 200);
  assert.equal(batches, 1);
  __setJudge0AdapterForTest(null);
});

test("exec engine failure on /api/exec/submit: .status error -> 503 judge_unavailable; cooldown NOT consumed, nothing stored", async () => {
  advanceClock(3600_000);
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  firestore.collection(process.env.SESSION_COLLECTION).doc("ef-sub").set({ session_id: "ef-sub", status: "active" });
  const subs = () => firestore._collections.get(process.env.SUBMISSIONS_COLLECTION)?.size || 0;
  let failNext = true;
  __setJudge0AdapterForTest({ runBatch: async (items) => {
    if (failNext) {
      const err = new Error("judge0 submit failed: 429");
      err.status = 429;
      throw err;
    }
    return items.map(() => ({ status: "accepted", passed: true, stdout: "", stderr: "", compileOutput: "", timeSec: 0, memoryKb: 1 }));
  } });

  let res = await call(execReq("/api/exec/submit", "ef-sub"));
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, "judge_unavailable");
  assert.equal(typeof res.body.retry_after_seconds, "number");
  assert.equal(subs(), 0); // nothing stored on an engine failure

  failNext = false;
  res = await call(execReq("/api/exec/submit", "ef-sub"));
  assert.equal(res.statusCode, 200);
  assert.equal(subs(), 1);
  __setJudge0AdapterForTest(null);
});

test("exec engine failure: a plain programming Error (no .status) stays a bare 500 — but the cooldown is still restored", async () => {
  advanceClock(3600_000);
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  firestore.collection(process.env.SESSION_COLLECTION).doc("ef-bug").set({ session_id: "ef-bug", status: "active" });
  let failNext = true;
  __setJudge0AdapterForTest({ runBatch: async (items) => {
    if (failNext) throw new Error("TypeError: cannot read properties of undefined");
    return items.map(() => ({ status: "accepted", passed: true, stdout: "", stderr: "", compileOutput: "", timeSec: 0, memoryKb: 1 }));
  } });

  let res = await call(execReq("/api/exec/run", "ef-bug"));
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, "Internal server error"); // generic — no detail leaked

  // Cooldown restored even for the 500 path (server-side fault either way).
  failNext = false;
  res = await call(execReq("/api/exec/run", "ef-bug"));
  assert.equal(res.statusCode, 200);
  __setJudge0AdapterForTest(null);
});

// ---- Narrowed lane gating (review defect 3) ---------------------------------
// The lanes gate only the submit POSTs; the ~90 s poll budget holds NO lane
// slot. With the 1-wide run lane of this file, a second session's run must
// reach its submit POST while the first batch is still polling.

test("exec wiring: the run-lane slot is released after the submit phase — a second run proceeds while the first is still polling", async () => {
  advanceClock(3600_000);
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  for (const id of ["pw-a", "pw-b"]) {
    firestore.collection(process.env.SESSION_COLLECTION).doc(id).set({ session_id: id, status: "active" });
  }
  const pollPark = deferred();
  let submits = 0;
  __setJudge0AdapterForTest({ runBatch: async (items, gates = {}) => {
    const submitGate = gates.submitGate ?? ((fn) => fn());
    await submitGate(async () => { submits++; }); // quick submit POST
    await pollPark.promise;                       // long poll phase, OUTSIDE the gate
    return items.map(() => ({ status: "accepted", passed: true, stdout: "", stderr: "", compileOutput: "", timeSec: 0, memoryKb: 1 }));
  } });

  const pA = call(execReq("/api/exec/run", "pw-a"));
  await tick(); await tick();
  assert.equal(submits, 1);

  // A is now "polling" (parked) — B's submit POST must go through the SAME
  // 1-wide run lane right now, not after A's poll budget ends.
  const pB = call(execReq("/api/exec/run", "pw-b"));
  await tick(); await tick();
  assert.equal(submits, 2, "the run-lane slot was parked across the poll phase");

  pollPark.resolve();
  const [resA, resB] = await Promise.all([pA, pB]);
  assert.equal(resA.statusCode, 200);
  assert.equal(resB.statusCode, 200);
  __setJudge0AdapterForTest(null);
});

// ---- S-I §3.1: per-session serialization guard --------------------------------
// With per-PROBLEM cooldowns, one session could otherwise stack a concurrent
// engine batch per problem. The in-flight flag serializes exec calls (run or
// submit, ANY problem): a second call while one is in flight gets 429
// rate_limited with retry_after_seconds 2. The conditional compare-and-restore
// on the cooldown stamp stays in the code as defense for the tiny window
// between the limiter check and the stamp (the guard makes the old
// deterministic restore-race unreachable through the public API).

test("exec serialization guard: a second exec call while one is in flight -> 429 retry 2s; failure restore still frees the slot", async () => {
  advanceClock(3600_000);
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  firestore.collection(process.env.SESSION_COLLECTION).doc("race-run").set({ session_id: "race-run", status: "active" });
  const hangA = deferred();
  let batches = 0;
  __setJudge0AdapterForTest({ runBatch: async (items) => {
    batches++;
    if (batches === 1) await hangA.promise; // A parks inside the engine, then fails
    return items.map(() => ({ status: "accepted", passed: true, stdout: "", stderr: "", compileOutput: "", timeSec: 0, memoryKb: 1 }));
  } });

  // A consumes the run cooldown at t0 and parks in the engine (in flight).
  const pA = call(execReq("/api/exec/run", "race-run"));
  await tick(); await tick();
  assert.equal(batches, 1);

  // 6 s later — past the 5 s run cooldown, so ONLY the in-flight guard can
  // reject — a second run for the SAME session is serialized away.
  advanceClock(6_000);
  const resB = await call(execReq("/api/exec/run", "race-run"));
  assert.equal(resB.statusCode, 429);
  assert.equal(resB.body.error, "rate_limited");
  assert.equal(resB.body.retry_after_seconds, 2);
  assert.equal(batches, 1); // never reached the engine

  // A submit for the same session is serialized too (any problem, any lane).
  const resBSub = await call(execReq("/api/exec/submit", "race-run"));
  assert.equal(resBSub.statusCode, 429);
  assert.equal(resBSub.body.retry_after_seconds, 2);

  // A fails server-side: its stamp is restored AND the in-flight flag clears,
  // so the session is immediately runnable again (clock unmoved).
  hangA.reject(Object.assign(new Error("judge0 fetch failed: 503"), { status: 503, retryable: false }));
  const resA = await pA;
  assert.equal(resA.statusCode, 503);

  const resC = await call(execReq("/api/exec/run", "race-run"));
  assert.equal(resC.statusCode, 200);
  assert.equal(batches, 2);

  // After a SUCCESSFUL call completes, the flag is clear as well — only the
  // normal cooldown applies (still 429, but with the cooldown's hint, not 2 s).
  const resD = await call(execReq("/api/exec/run", "race-run"));
  assert.equal(resD.statusCode, 429);
  assert.ok(resD.body.retry_after_seconds >= 4);
  __setJudge0AdapterForTest(null);
});

// ---- S-I §3.1: per-(session, problem) cooldowns --------------------------------
// Submitting problem A never blocks problem B for the same session; only a
// repeat on the SAME problem inside its window is rejected. (The old
// same-session restore-race is unreachable now — the serialization guard
// above rejects any concurrent same-session call; the conditional restore is
// covered by the engine-failure tests.)

// A second published problem so one session can exec two problems. Stored in
// the DEFAULT problems collection this module instance reads.
function seedSecondProblem(firestore) {
  firestore.collection("proctor_problems").doc("echo-one").set({
    id: "echo-one", title: "Echo", statement: "Echo the line.",
    languages: ["python"], cpuTimeLimit: 2, memoryLimit: 64000,
    points: 80, scoring: "per_test", status: "published",
    sampleTests: [{ input: "hi\n", expected: "hi" }],
    hiddenTests: [{ input: "a\n", expected: "a" }, { input: "b\n", expected: "b" }]
  });
}
const execProblemReq = (path, sessionId, problemId) => makeReq({ method: "POST", path,
  body: { session_id: sessionId, problem_id: problemId, language: "python", source_code: "x" } });

test("per-problem cooldowns: submit B right after submit A passes; resubmitting A inside 20s 429s (S-I §3.1)", async () => {
  advanceClock(3600_000);
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSecondProblem(firestore);
  firestore.collection(process.env.SESSION_COLLECTION).doc("pp-sub").set({ session_id: "pp-sub", status: "active" });
  __setJudge0AdapterForTest({ runBatch: async (items) =>
    items.map(() => ({ status: "accepted", passed: true, stdout: "", stderr: "", compileOutput: "", timeSec: 0, memoryKb: 1 })) });

  let res = await call(execProblemReq("/api/exec/submit", "pp-sub", "sum-two"));
  assert.equal(res.statusCode, 200);

  // 1 s later: problem B is FREE — A's window never blocks B.
  advanceClock(1_000);
  res = await call(execProblemReq("/api/exec/submit", "pp-sub", "echo-one"));
  assert.equal(res.statusCode, 200);

  // …but problem A itself is still inside its own 20 s window.
  advanceClock(1_000);
  res = await call(execProblemReq("/api/exec/submit", "pp-sub", "sum-two"));
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.error, "rate_limited");

  // Runs are per-problem too.
  res = await call(execProblemReq("/api/exec/run", "pp-sub", "sum-two"));
  assert.equal(res.statusCode, 200);
  res = await call(execProblemReq("/api/exec/run", "pp-sub", "echo-one"));
  assert.equal(res.statusCode, 200);
  res = await call(execProblemReq("/api/exec/run", "pp-sub", "sum-two"));
  assert.equal(res.statusCode, 429);
  __setJudge0AdapterForTest(null);
});

// ---- S-I §3.2/§3.3: contest membership + effective points + denorm -------------

test("exec membership: a session bound to a REAL contest may exec only that contest's problems; effective points apply", async () => {
  advanceClock(3600_000);
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSecondProblem(firestore);
  // Real contest doc: sum-two only, with a 40-point override (seed default 100).
  firestore.collection("proctor_contests").doc("kec-r1").set({
    slug: "kec-r1", status: "open",
    problems: [{ problem_id: "sum-two", points: 40, order: 0 }]
  });
  firestore.collection(process.env.SESSION_COLLECTION).doc("mem-1").set({
    session_id: "mem-1", status: "active", username_norm: "alice", contest_slug: "kec-r1"
  });
  __setJudge0AdapterForTest({ runBatch: async (items) =>
    items.map(() => ({ status: "accepted", passed: true, stdout: "", stderr: "", compileOutput: "", timeSec: 0, memoryKb: 1 })) });

  // echo-one is PUBLISHED but not in this contest -> 400 problem_not_in_contest.
  let res = await call(execProblemReq("/api/exec/run", "mem-1", "echo-one"));
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "problem_not_in_contest");
  res = await call(execProblemReq("/api/exec/submit", "mem-1", "echo-one"));
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "problem_not_in_contest");

  // The contest problem submits fine and scores with the EFFECTIVE points.
  res = await call(execProblemReq("/api/exec/submit", "mem-1", "sum-two"));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.score, 40);       // 4/4 hidden on a 40-point entry
  assert.equal(res.body.max_points, 40);  // entry override, not the bank's 100

  // §3.3 denorm: identity facts ride the stored doc (no joins for the rollup).
  const stored = [...firestore._collections.get(process.env.SUBMISSIONS_COLLECTION).values()].at(-1);
  assert.equal(stored.contest_slug, "kec-r1");
  assert.equal(stored.username_norm, "alice");
  assert.equal(stored.person_id, null);    // S-E stamps this later
  // S-C (landed at merge): candidate_id is stamped write-time via candidateOf —
  // "" (not null) when the session carries no identity fields at all.
  assert.equal(stored.candidate_id, "");
  assert.equal(stored.max_points, 40);
  __setJudge0AdapterForTest(null);
});

test("legacy canary: contest_slug with NO real doc (synthesized legacy) keeps today's bank-only path", async () => {
  advanceClock(3600_000);
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSecondProblem(firestore);
  // No contest doc for this slug — the legacy deployment shape (slug derived
  // from contest_url). Membership must NOT be enforced; bank/seed points apply.
  firestore.collection(process.env.SESSION_COLLECTION).doc("leg-1").set({
    session_id: "leg-1", status: "active", username_norm: "bob", contest_slug: "kec-aerele-2026"
  });
  __setJudge0AdapterForTest({ runBatch: async (items) =>
    items.map(() => ({ status: "accepted", passed: true, stdout: "", stderr: "", compileOutput: "", timeSec: 0, memoryKb: 1 })) });

  let res = await call(execProblemReq("/api/exec/run", "leg-1", "echo-one"));
  assert.equal(res.statusCode, 200);
  advanceClock(6_000);
  res = await call(execProblemReq("/api/exec/submit", "leg-1", "sum-two"));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.max_points, 100); // the seed's own points — no override
  // The denorm fields still ride the stored doc (S-C joins use them later).
  const stored = [...firestore._collections.get(process.env.SUBMISSIONS_COLLECTION).values()].at(-1);
  assert.equal(stored.contest_slug, "kec-aerele-2026");
  assert.equal(stored.username_norm, "bob");
  __setJudge0AdapterForTest(null);
});

// ---- Store failure AFTER a successful (billed) engine run ---------------------
// The hidden-test batch already ran — and was BILLED — by the time the
// submission doc is stored. A Firestore failure at that point must not discard
// the computed verdict with a 500: the candidate gets the verdict back with
// stored:false (no submission_id), the cooldown stays consumed (the engine run
// happened), and the stored-submissions budget is NOT charged (nothing stored).

test("exec submit: Firestore store fails after a successful engine run -> 200 with verdict + stored:false, no submission_id; cooldown consumed; budget not charged", async () => {
  advanceClock(3600_000);
  const firestore = makeFakeFirestore();
  // Wrap the fake so set() throws for the SUBMISSIONS collection only — every
  // other collection (sessions gate) keeps working.
  let storeFails = true;
  const realCollection = firestore.collection.bind(firestore);
  firestore.collection = (name) => {
    const col = realCollection(name);
    if (name !== process.env.SUBMISSIONS_COLLECTION) return col;
    const realDoc = col.doc.bind(col);
    return {
      ...col,
      doc(id) {
        const d = realDoc(id);
        return {
          ...d,
          async set(...args) {
            if (storeFails) throw new Error("firestore unavailable");
            return d.set(...args);
          }
        };
      }
    };
  };
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  firestore.collection(process.env.SESSION_COLLECTION).doc("sf-sub").set({ session_id: "sf-sub", status: "active" });
  __setJudge0AdapterForTest({ runBatch: async (items) =>
    items.map(() => ({ status: "accepted", passed: true, stdout: "", stderr: "", compileOutput: "", timeSec: 0, memoryKb: 1 })) });
  const subs = () => firestore._collections.get(process.env.SUBMISSIONS_COLLECTION)?.size || 0;

  const res = await call(execReq("/api/exec/submit", "sf-sub"));
  // The billed verdict comes back instead of a 500 — flagged as un-stored.
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.verdict, "accepted");
  assert.equal(res.body.passed_count, 4);
  assert.equal(res.body.total, 4);
  assert.equal(res.body.stored, false);
  assert.equal(res.body.submission_id, undefined);
  assert.deepEqual(Object.keys(res.body).sort(), ["passed_count", "stored", "total", "verdict"]);
  assert.equal(subs(), 0); // nothing made it into Firestore

  // The cooldown stays CONSUMED — the engine run was billed, so an immediate
  // retry (clock unmoved) is rate-limited like any other back-to-back submit.
  const retry = await call(execReq("/api/exec/submit", "sf-sub"));
  assert.equal(retry.statusCode, 429);
  assert.equal(retry.body.error, "rate_limited");

  // The un-stored submission did NOT count against the 50-stored budget: with
  // the store healthy again, the session still has its FULL budget of 50.
  storeFails = false;
  for (let i = 0; i < 50; i++) {
    advanceClock(21_000);
    const ok = await call(execReq("/api/exec/submit", "sf-sub"));
    assert.equal(ok.statusCode, 200, `stored submission ${i + 1} of 50 should be allowed`);
    assert.equal(ok.body.submission_id !== undefined, true);
  }
  assert.equal(subs(), 50);
  // ...and the 51st stored one is capped as usual.
  advanceClock(21_000);
  const capped = await call(execReq("/api/exec/submit", "sf-sub"));
  assert.equal(capped.statusCode, 429);
  __setJudge0AdapterForTest(null);
});
