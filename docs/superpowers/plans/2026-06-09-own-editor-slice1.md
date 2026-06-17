# Own Editor — Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** DRAFT — awaiting Karthi's review (paired with the design doc `docs/superpowers/specs/2026-06-09-own-editor-design.md`, §4 = Slice 1).

**Goal:** A candidate, inside the existing same-origin proctored page, solves one config-driven problem in our Monaco editor, Runs it against sample tests and Submits against hidden tests (verdict via a hosted-Judge0 adapter), while every keystroke/cursor/selection/paste/focus/run/submit event is captured — all tied to the existing proctor `session_id`.

**Architecture:** Frontend `CodingWorkspace` (Monaco, lazy-loaded) renders inside `StudentApp`; capture hooks map Monaco events → batched `ProctorEvent`s posted to a new `/api/editor-events`. Run/Submit call new backend endpoints `/api/exec/run` + `/api/exec/submit`, which call a **swap-able `judge0Adapter`** (hosted RapidAPI now; key server-side only) and compare outputs to decide a verdict. One problem ships as backend config.

**Tech Stack:** React/Vite/TS/Tailwind frontend; `@monaco-editor/react` + `monaco-editor`; Node 20 GCP Cloud Function backend (`backend/src/handler.mjs`, `node:test`); Firestore + GCS; hosted Judge0 CE (`https://judge0-ce.p.rapidapi.com`).

---

## File Structure

**Backend** (`backend/src`, `backend/test`):
- Create `backend/src/judge0Adapter.mjs` — the engine swap point: `runBatch(items)` → results, config-driven base URL + auth, async token polling. Hosted impl now; self-host is a config flip later.
- Create `backend/src/problems.mjs` — Slice 1's single problem (statement, language→`language_id` map, sample + hidden tests, limits). Exports `getProblem(id)`.
- Modify `backend/src/handler.mjs` — add routes + handlers `execRun`, `execSubmit`, `ingestEditorEvents`; reuse `parseBody`, `badRequest`, `requireWritableSession`, `getSession`, `sessionPrefix`, `bucket()`, `putJsonl`, `send`, Firestore (`firestore`) / GCS, `randomUUID`. Add a NEW test seam `__setJudge0AdapterForTest(adapter)` (mirrors the existing `__setClientsForTest`). Declare the new env consts in the existing const block near `EVIDENCE_BUCKET` (line ~52): `JUDGE0_BASE_URL`, `JUDGE0_MODE`, `JUDGE0_API_KEY`, `JUDGE0_AUTH_TOKEN`, `SUBMISSIONS_COLLECTION`, `EDITOR_EVENTS_COLLECTION`, `EDITOR_EVENTS_INGEST_LIMIT`.
- Create `backend/test/judge0Adapter.test.mjs`, `backend/test/exec.test.mjs`, `backend/test/editorEvents.test.mjs`. The handler-using test files (`exec.test.mjs`, `editorEvents.test.mjs`) set the env vars they need (`EVIDENCE_BUCKET`, `SESSION_COLLECTION`, `SETTINGS_COLLECTION`, `SUBMISSIONS_COLLECTION`, `EDITOR_EVENTS_COLLECTION`, `ADMIN_PASSWORD`) BEFORE importing the handler with a unique cache-buster query (e.g. `import("../src/handler.mjs?exec")`), inline `makeReq`/`makeRes` + paste `makeFakeFirestore`/`makeFakeStorage` exactly like `phase2.test.mjs`, and inject fakes via `__setClientsForTest` / `__setJudge0AdapterForTest`. `judge0Adapter.test.mjs` is a PURE adapter unit test (fake `fetch`, no handler import, no env, no DI seam). There is NO `helpers.mjs`.

**Frontend** (`frontend/src`):
- Create `frontend/src/coding/editorEvents.ts` — pure mappers (Monaco change/cursor/selection → `EditorEvent`), coalescing, batching. No React.
- Create `frontend/src/coding/MonacoEditor.tsx` — thin Monaco wrapper, lazy-loaded; wires capture hooks; exposes value + language.
- Create `frontend/src/coding/CodingWorkspace.tsx` — layout (problem | editor+lang+Run/Submit | output/sample-results) + orchestration + event flushing. Imports `execRun`, `execSubmit`, `sendEditorEvents` from `../api`.
- Modify `frontend/src/types.ts` — add `EditorEvent`, `ExecRequest`, `RunResult`, `SubmitResult`.
- Modify `frontend/src/api.ts` — add `sendEditorEvents`, `execRun`, `execSubmit` (+ demo branches). These live in `api.ts` (not a separate `execClient.ts`) because `wait`/`request`/`demoMode` are already in scope there.
- Modify `frontend/src/App.tsx` — render `<CodingWorkspace>` inside `StudentApp` (replacing the "go to contest_url" surface when a problem is configured).
- Add deps: `@monaco-editor/react`, `monaco-editor`; add `vitest` for the pure-logic unit tests.

**Storage decision (locked for Slice 1):** raw editor events → **GCS NDJSON**, appended per `session_id`, under the session's storage prefix (cheaper for high volume than Firestore; consistent with the screen-chunk GCS pattern). Submissions → a Firestore collection `proctor_submissions` (low volume, queryable). This resolves design §4.4.

---

## Task 1: Judge0 adapter (the swap point)

**Files:**
- Create: `backend/src/judge0Adapter.mjs`
- Test: `backend/test/judge0Adapter.test.mjs`

- [ ] **Step 1: Write the failing test**

> This is a PURE unit test of the adapter — it imports `makeJudge0Adapter` directly and drives it with a fake `fetch`. It does NOT import `handler.mjs` and never touches Firestore/GCS, so (unlike the exec/editorEvents test files) it needs no env vars, no cache-buster import, and no `__setClientsForTest`.

```javascript
// backend/test/judge0Adapter.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeJudge0Adapter } from "../src/judge0Adapter.mjs";

// A fake fetch that records calls and returns scripted responses.
function fakeFetch(script) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const next = script.shift();
    return { ok: true, status: 200, json: async () => next };
  };
  fn.calls = calls;
  return fn;
}

test("runBatch: base64-encodes source/stdin, submits async, polls token, normalizes result", async () => {
  const fetch = fakeFetch([
    [{ token: "tok-1" }],                                   // POST /submissions/batch -> tokens
    { submissions: [{ token: "tok-1", status: { id: 3, description: "Accepted" },
                      stdout: Buffer.from("ok\n").toString("base64"),
                      stderr: null, compile_output: null, time: "0.01", memory: 256 }] } // GET batch -> done
  ]);
  const adapter = makeJudge0Adapter({
    baseUrl: "https://judge0-ce.p.rapidapi.com",
    mode: "rapidapi", apiKey: "K", fetchImpl: fetch, pollIntervalMs: 0
  });
  const results = await adapter.runBatch([
    { languageId: 71, source: "print('ok')", stdin: "", expectedOutput: "ok" }
  ]);
  // submit call was base64 + async
  const submit = fetch.calls[0];
  assert.match(submit.url, /\/submissions\/batch\?base64_encoded=true/);
  assert.equal(submit.opts.headers["X-RapidAPI-Key"], "K");
  const body = JSON.parse(submit.opts.body);
  assert.equal(body.submissions[0].source_code, Buffer.from("print('ok')").toString("base64"));
  // normalized result
  assert.equal(results[0].status, "accepted");
  assert.equal(results[0].stdout, "ok\n");
  assert.equal(results[0].passed, true); // stdout trimmed === expectedOutput trimmed
});

test("runBatch: wrong output -> passed:false, status wrong_answer", async () => {
  const fetch = fakeFetch([
    [{ token: "t" }],
    { submissions: [{ token: "t", status: { id: 4, description: "Wrong Answer" },
                      stdout: Buffer.from("nope\n").toString("base64"), stderr: null,
                      compile_output: null, time: "0.01", memory: 256 }] }
  ]);
  const adapter = makeJudge0Adapter({ baseUrl: "u", mode: "rapidapi", apiKey: "K", fetchImpl: fetch, pollIntervalMs: 0 });
  const r = await adapter.runBatch([{ languageId: 71, source: "x", stdin: "", expectedOutput: "ok" }]);
  assert.equal(r[0].passed, false);
  assert.equal(r[0].status, "wrong_answer");
});

test("runBatch: compile error surfaces compile_output and status compile_error", async () => {
  const fetch = fakeFetch([
    [{ token: "t" }],
    { submissions: [{ token: "t", status: { id: 6, description: "Compilation Error" },
                      stdout: null, stderr: null,
                      compile_output: Buffer.from("err: bad").toString("base64"), time: null, memory: null }] }
  ]);
  const adapter = makeJudge0Adapter({ baseUrl: "u", mode: "rapidapi", apiKey: "K", fetchImpl: fetch, pollIntervalMs: 0 });
  const r = await adapter.runBatch([{ languageId: 54, source: "bad", stdin: "", expectedOutput: "x" }]);
  assert.equal(r[0].status, "compile_error");
  assert.equal(r[0].compileOutput, "err: bad");
  assert.equal(r[0].passed, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/karthi/arogara/proctor/backend && node --test test/judge0Adapter.test.mjs`
Expected: FAIL — `Cannot find module '../src/judge0Adapter.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// backend/src/judge0Adapter.mjs
// Swap-able Judge0 engine. mode: "rapidapi" (hosted now) | "selfhosted" (later, config flip).
// The rest of the app only knows runBatch(); base URL + auth come from config.

const b64 = (s) => Buffer.from(s ?? "", "utf8").toString("base64");
const unb64 = (s) => (s ? Buffer.from(s, "base64").toString("utf8") : "");

// Judge0 status.id -> our normalized status. 1/2 = In Queue/Processing (not done).
function normalizeStatus(id) {
  if (id === 3) return "accepted";
  if (id === 4) return "wrong_answer";
  if (id === 5) return "time_limit";
  if (id === 6) return "compile_error";
  if (id >= 7 && id <= 12) return "runtime_error";
  return "error";
}

export function makeJudge0Adapter({ baseUrl, mode, apiKey, authToken, fetchImpl = fetch, pollIntervalMs = 400, maxPolls = 40 }) {
  const headers = mode === "rapidapi"
    ? { "Content-Type": "application/json", "X-RapidAPI-Key": apiKey, "X-RapidAPI-Host": "judge0-ce.p.rapidapi.com" }
    : { "Content-Type": "application/json", "X-Auth-Token": authToken };

  async function submitBatch(items) {
    const submissions = items.map((it) => ({
      language_id: it.languageId,
      source_code: b64(it.source),
      stdin: b64(it.stdin),
      cpu_time_limit: it.cpuTimeLimit, memory_limit: it.memoryLimit
    }));
    const res = await fetchImpl(`${baseUrl}/submissions/batch?base64_encoded=true&wait=false`, {
      method: "POST", headers, body: JSON.stringify({ submissions })
    });
    if (!res.ok) throw new Error(`judge0 submit failed: ${res.status}`);
    const tokens = await res.json(); // [{token}, ...]
    return tokens.map((t) => t.token);
  }

  async function fetchBatch(tokens) {
    const q = tokens.join(",");
    const res = await fetchImpl(`${baseUrl}/submissions/batch?base64_encoded=true&tokens=${q}`, { headers });
    if (!res.ok) throw new Error(`judge0 fetch failed: ${res.status}`);
    const data = await res.json();
    return data.submissions;
  }

  async function sleep(ms) { if (ms > 0) await new Promise((r) => setTimeout(r, ms)); }

  return {
    async runBatch(items) {
      const tokens = await submitBatch(items);
      let subs = [];
      for (let i = 0; i < maxPolls; i++) {
        subs = await fetchBatch(tokens);
        if (subs.every((s) => s.status && s.status.id >= 3)) break; // all done
        await sleep(pollIntervalMs);
      }
      return subs.map((s, idx) => {
        const status = normalizeStatus(s.status?.id);
        const stdout = unb64(s.stdout);
        const expected = items[idx].expectedOutput ?? "";
        const passed = status === "accepted" && stdout.trim() === String(expected).trim();
        return {
          status: passed ? "accepted" : (status === "accepted" ? "wrong_answer" : status),
          passed,
          stdout,
          stderr: unb64(s.stderr),
          compileOutput: unb64(s.compile_output),
          timeSec: s.time ? Number(s.time) : null,
          memoryKb: s.memory ?? null
        };
      });
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/karthi/arogara/proctor/backend && node --test test/judge0Adapter.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/karthi/arogara/proctor
git add backend/src/judge0Adapter.mjs backend/test/judge0Adapter.test.mjs
git commit -m "feat(exec): swap-able Judge0 adapter (hosted RapidAPI, async token polling)"
```

---

## Task 2: Slice 1 problem config

**Files:**
- Create: `backend/src/problems.mjs`
- Test: covered indirectly in Task 4; add a tiny shape test here.

- [ ] **Step 1: Write the failing test** — append to `backend/test/exec.test.mjs` (created here, expanded in Tasks 3–4):

Create `backend/test/exec.test.mjs` with the FULL header (used by Tasks 3 & 4): set env BEFORE importing the handler, import with the `?exec` cache-buster, inline `makeReq`/`makeRes`/`call`, and paste `makeFakeFirestore` + `makeFakeStorage` from `phase2.test.mjs`. This header is added ONCE here; Tasks 3 & 4 only append tests.

```javascript
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
// Paste makeFakeFirestore + makeFakeStorage from phase2.test.mjs here (they back
// the __setClientsForTest seam used by Tasks 3 & 4). The problem-shape tests
// below don't need them, but the exec tests do.

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/karthi/arogara/proctor/backend && node --test test/exec.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```javascript
// backend/src/problems.mjs
// Slice 1 ships ONE problem as config. Problem authoring is Slice 2.
// NOTE: verify language_ids against the live instance via GET /languages before a real run;
// these are the common Judge0 CE ids.
export const LANGUAGE_IDS = { python: 71, cpp: 54, java: 62, javascript: 63 };

const PROBLEMS = {
  "sum-two": {
    id: "sum-two",
    title: "Sum of Two Numbers",
    statement: "Read two integers a and b on one line separated by a space. Print a + b.",
    languages: ["python", "cpp", "java", "javascript"],
    cpuTimeLimit: 5, memoryLimit: 128000,
    sampleTests: [
      { input: "2 3\n", expected: "5" },
      { input: "10 20\n", expected: "30" }
    ],
    hiddenTests: [
      { input: "0 0\n", expected: "0" },
      { input: "-5 5\n", expected: "0" },
      { input: "1000000 1\n", expected: "1000001" },
      { input: "-100 -200\n", expected: "-300" }
    ]
  }
};

export function getProblem(id) {
  return PROBLEMS[id] || null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/karthi/arogara/proctor/backend && node --test test/exec.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/problems.mjs backend/test/exec.test.mjs
git commit -m "feat(exec): slice-1 problem config (sum-two) + language id map"
```

---

## Task 3: `POST /api/exec/run` (sample tests)

**Files:**
- Modify: `backend/src/handler.mjs` (add `execRun` + route near the other route registrations, ~line 110–127)
- Test: `backend/test/exec.test.mjs` (append)

- [ ] **Step 1: Write the failing test** — APPEND to `backend/test/exec.test.mjs` (the header that sets env, imports the handler with the `?exec` cache-buster, and defines `makeReq`/`makeRes`/`call` + `makeFakeFirestore`/`makeFakeStorage` was already added in Task 2 — do NOT repeat it). Append these tests:

```javascript
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
```

> Implementer note: copy `makeFakeFirestore` + `makeFakeStorage` from `backend/test/phase2.test.mjs` verbatim into the header block. The ownership gate (`requireWritableSession(await getSession(...))`) needs a seeded session doc; an unknown session id throws 404 and an `ended`/`locked`/`pending_approval` one throws 409/403.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/karthi/arogara/proctor/backend && node --test test/exec.test.mjs`
Expected: FAIL — route returns 404 / `execRun` undefined.

- [ ] **Step 3: Write minimal implementation** — in `backend/src/handler.mjs`:

Add near the top imports:
```javascript
import { makeJudge0Adapter } from "./judge0Adapter.mjs";
import { getProblem, LANGUAGE_IDS } from "./problems.mjs";
```

Declare the new env consts in the existing const block (next to `EVIDENCE_BUCKET`, ~line 52):
```javascript
const JUDGE0_BASE_URL = process.env.JUDGE0_BASE_URL || "https://judge0-ce.p.rapidapi.com";
const JUDGE0_MODE = process.env.JUDGE0_MODE || "rapidapi";
const JUDGE0_API_KEY = process.env.JUDGE0_API_KEY;
const JUDGE0_AUTH_TOKEN = process.env.JUDGE0_AUTH_TOKEN;
const SUBMISSIONS_COLLECTION = process.env.SUBMISSIONS_COLLECTION || "proctor_submissions";
const EDITOR_EVENTS_COLLECTION = process.env.EDITOR_EVENTS_COLLECTION || "editor-events"; // GCS sub-prefix label
const EDITOR_EVENTS_INGEST_LIMIT = Number(process.env.EDITOR_EVENTS_INGEST_LIMIT || "5000");
```

Add a lazily-built adapter with a NEW DI test seam that MIRRORS the existing `__setClientsForTest` (place it right after `__setClientsForTest` near line 10):
```javascript
// Single adapter, built from env on first use. Tests inject a stub via
// __setJudge0AdapterForTest (mirrors __setClientsForTest). Pass null to reset.
let _judge0 = null;
let _judge0Override = null;
export function __setJudge0AdapterForTest(adapter) {
  _judge0Override = adapter || null;
}
function judge0() {
  if (_judge0Override) return _judge0Override;
  if (!_judge0) {
    _judge0 = makeJudge0Adapter({
      baseUrl: JUDGE0_BASE_URL, mode: JUDGE0_MODE,
      apiKey: JUDGE0_API_KEY, authToken: JUDGE0_AUTH_TOKEN
    });
  }
  return _judge0;
}
```

Add the handler. It GATES on session ownership (`requireWritableSession(await getSession(...))`) exactly like `/api/events` does, BEFORE doing any work:
```javascript
async function execRun(req) {
  const body = parseBody(req);
  // Ownership gate: unknown session → 404; ended/locked/pending → 409/403.
  const session = requireWritableSession(await getSession(String(body.session_id || "")));
  const problem = getProblem(String(body.problem_id || ""));
  if (!problem) return badRequest("unknown problem_id");
  const languageId = LANGUAGE_IDS[String(body.language || "")];
  if (!languageId) return badRequest("unsupported language");
  const source = String(body.source_code || "");
  const items = problem.sampleTests.map((t) => ({
    languageId, source, stdin: t.input, expectedOutput: t.expected,
    cpuTimeLimit: problem.cpuTimeLimit, memoryLimit: problem.memoryLimit
  }));
  const results = await judge0().runBatch(items);
  // echo sample input/expected for display (samples are NOT secret)
  return { results: results.map((r, i) => ({ ...r, input: problem.sampleTests[i].input, expected: problem.sampleTests[i].expected })) };
}
```

Register the route (next to the other `POST /api/...` routes, ~line 110–127):
```javascript
if (req.method === "POST" && path === "/api/exec/run") return send(res, 200, await execRun(req));
```

> `badRequest`, `parseBody`, `send`, `getSession`, `requireWritableSession` already exist in handler.mjs — reuse them. `getSession` throws a 404 `httpError` for an unknown id; `requireWritableSession` throws 409/403 for ended/locked/pending — both surface as the right status via the existing top-level catch.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/karthi/arogara/proctor/backend && node --test test/exec.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the FULL suite (no regressions)**

Run: `cd /home/karthi/arogara/proctor/backend && npm test`
Expected: all prior tests still pass + new ones.

- [ ] **Step 6: Commit**

```bash
git add backend/src/handler.mjs backend/test/exec.test.mjs
git commit -m "feat(exec): POST /api/exec/run against sample tests via Judge0 adapter"
```

---

## Task 4: `POST /api/exec/submit` (hidden tests → verdict + store)

**Files:**
- Modify: `backend/src/handler.mjs` (add `execSubmit` + route)
- Test: `backend/test/exec.test.mjs` (append)

- [ ] **Step 1: Write the failing test**

Append to `backend/test/exec.test.mjs` (reuses the header's `makeReq`/`makeRes`/`call`/`makeFakeFirestore`/`makeFakeStorage` and the `__set*ForTest` seams):

```javascript
test("POST /api/exec/submit runs HIDDEN tests, returns verdict + per-test pass/fail WITHOUT leaking inputs, and stores the submission", async () => {
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
  // per-test results must NOT include the hidden input/expected
  assert.equal(res.body.tests[0].input, undefined);
  assert.equal(res.body.tests[0].expected, undefined);
  assert.equal(res.body.tests[0].passed, true);
  assert.equal(seen.length, 4);               // judged against the 4 hidden tests
  // The submission was stored in the injected fake Firestore (observable).
  const subs = firestore._collections.get(process.env.SUBMISSIONS_COLLECTION);
  assert.equal(subs.size, 1);
  const stored = [...subs.values()][0];
  assert.equal(stored.session_id, "s1");
  assert.equal(stored.problem_id, "sum-two");
  assert.equal(stored.verdict, "accepted");
  __setJudge0AdapterForTest(null);
});

test("POST /api/exec/submit: one failing hidden test -> verdict wrong_answer", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  firestore.collection(process.env.SESSION_COLLECTION).doc("s1").set({ session_id: "s1", status: "active" });
  __setJudge0AdapterForTest({ runBatch: async (items) => items.map((_, i) => ({ status: i === 2 ? "wrong_answer" : "accepted", passed: i !== 2, stdout: "", stderr: "", compileOutput: "", timeSec: 0, memoryKb: 1 })) });
  const res = await call(makeReq({ method: "POST", path: "/api/exec/submit",
    body: { session_id: "s1", problem_id: "sum-two", language: "python", source_code: "x" } }));
  assert.equal(res.body.verdict, "wrong_answer");
  assert.equal(res.body.passed_count, 3);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/karthi/arogara/proctor/backend && node --test test/exec.test.mjs`
Expected: FAIL — route 404.

- [ ] **Step 3: Write minimal implementation** — `backend/src/handler.mjs`:

`SUBMISSIONS_COLLECTION` was already declared in the const block in Task 3 — do NOT redeclare it here.

```javascript
async function execSubmit(req) {
  const body = parseBody(req);
  const sessionId = String(body.session_id || "");
  // Ownership gate (same as /api/events): unknown → 404; ended/locked/pending → 409/403.
  const session = requireWritableSession(await getSession(sessionId));
  const problem = getProblem(String(body.problem_id || ""));
  if (!problem) return badRequest("unknown problem_id");
  const languageId = LANGUAGE_IDS[String(body.language || "")];
  if (!languageId) return badRequest("unsupported language");
  const source = String(body.source_code || "");

  const items = problem.hiddenTests.map((t) => ({
    languageId, source, stdin: t.input, expectedOutput: t.expected,
    cpuTimeLimit: problem.cpuTimeLimit, memoryLimit: problem.memoryLimit
  }));
  const results = await judge0().runBatch(items);
  const passedCount = results.filter((r) => r.passed).length;
  const verdict = passedCount === results.length ? "accepted" : "wrong_answer";

  // Per-test results WITHOUT hidden inputs/expected (don't leak the test cases).
  const tests = results.map((r, i) => ({ index: i, passed: r.passed, status: r.status, timeSec: r.timeSec }));

  // Store the submission (low volume -> Firestore). handler.mjs uses inline
  // new Date().toISOString() for timestamps everywhere — match that (no helper).
  const createdAt = new Date().toISOString();
  const submissionId = `${sessionId}:${problem.id}:${createdAt}`;
  await firestore.collection(SUBMISSIONS_COLLECTION).doc(submissionId).set({
    session_id: sessionId, problem_id: problem.id, language: body.language,
    source_code: source, verdict, passed_count: passedCount, total: results.length,
    tests, created_at: createdAt
  });

  return { verdict, passed_count: passedCount, total: results.length, tests, submission_id: submissionId };
}
```

Register route:
```javascript
if (req.method === "POST" && path === "/api/exec/submit") return send(res, 200, await execSubmit(req));
```

> `firestore` is the module-level handle (swapped by `__setClientsForTest` in tests) — use it directly, exactly as the existing handlers do.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/karthi/arogara/proctor/backend && node --test test/exec.test.mjs`
Expected: PASS.

- [ ] **Step 5: Full suite**

Run: `cd /home/karthi/arogara/proctor/backend && npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/handler.mjs backend/test/exec.test.mjs
git commit -m "feat(exec): POST /api/exec/submit -> hidden-test verdict + stored submission"
```

---

## Task 5: `POST /api/editor-events` (raw capture ingest → GCS NDJSON)

**Files:**
- Modify: `backend/src/handler.mjs` (add `ingestEditorEvents` + route)
- Test: `backend/test/editorEvents.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
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
// Paste makeFakeFirestore + makeFakeStorage from phase2.test.mjs here. The fake
// storage records every save in `storage._saved` (key -> body), which is what we
// assert against — there is NO globalThis.__GCS_APPEND__ seam.

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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/karthi/arogara/proctor/backend && node --test test/editorEvents.test.mjs`
Expected: FAIL — 404.

- [ ] **Step 3: Write minimal implementation** — `backend/src/handler.mjs`:

`EDITOR_EVENTS_INGEST_LIMIT` + `EDITOR_EVENTS_COLLECTION` were already declared in the const block in Task 3 — do NOT redeclare them here.

```javascript
async function ingestEditorEvents(req) {
  const body = parseBody(req);
  const sessionId = String(body.session_id || "");
  // Ownership gate (same as /api/events): unknown → 404; ended/locked/pending → 409/403.
  const session = requireWritableSession(await getSession(sessionId));
  const events = Array.isArray(body.events) ? body.events : null;
  if (!events) return badRequest("events[] required");
  if (events.length > EDITOR_EVENTS_INGEST_LIMIT) return badRequest(`max ${EDITOR_EVENTS_INGEST_LIMIT} events per batch`);
  const stamped = events.map((e) => ({ ...e, session_id: sessionId, problem_id: body.problem_id || null }));

  // Per-batch timestamped object under the session prefix (avoids read-modify-
  // write races; the analytics slice concatenates them). Build the key with the
  // existing sessionPrefix() + the same inline ISO-timestamp + randomUUID()
  // pattern recordEvents uses — randomUUID is already imported at the top.
  const key = `${sessionPrefix(session)}${EDITOR_EVENTS_COLLECTION}/${new Date().toISOString()}-${randomUUID()}.ndjson`;
  await putJsonl(key, stamped); // putJsonl already serializes records -> NDJSON via bucket().file(key).save(...)

  return { ok: true, stored: events.length };
}
```

Register route:
```javascript
if (req.method === "POST" && path === "/api/editor-events") return send(res, 200, await ingestEditorEvents(req));
```

> Reuse the EXISTING helpers: `getSession`, `requireWritableSession`, `sessionPrefix`, `putJsonl`, `randomUUID`. `putJsonl(key, records)` (line ~2230) already does `bucket().file(key).save(records.map(JSON.stringify).join("\n") + "\n", { contentType: "application/x-ndjson" })` — note `bucket()` is a FUNCTION (called with parens), never `bucket.file`. Per-batch timestamped objects avoid the read-modify-write race noted in design §4.4.

- [ ] **Step 4: Run to verify it passes**

Run: `cd /home/karthi/arogara/proctor/backend && node --test test/editorEvents.test.mjs`
Expected: PASS.

- [ ] **Step 5: Full suite + commit**

```bash
cd /home/karthi/arogara/proctor/backend && npm test   # all pass
cd /home/karthi/arogara/proctor
git add backend/src/handler.mjs backend/test/editorEvents.test.mjs
git commit -m "feat(capture): POST /api/editor-events -> per-session GCS NDJSON"
```

---

## Task 6: Frontend types

**Files:**
- Modify: `frontend/src/types.ts`

- [ ] **Step 1: Add the types** (no test; consumed by tasks 7–11):

```typescript
// frontend/src/types.ts (append)
export type EditorEventType =
  | "editor_insert" | "editor_delete" | "editor_replace" | "editor_paste"
  | "editor_cursor" | "editor_selection" | "editor_focus" | "editor_blur"
  | "code_run" | "code_submit";

export type EditorEvent = {
  type: EditorEventType;
  timestamp: string;             // ISO
  detail?: Record<string, unknown>;
};

export type ExecRequest = {
  session_id: string;
  problem_id: string;
  language: "python" | "cpp" | "java" | "javascript";
  source_code: string;
};

export type RunCaseResult = {
  input: string; expected: string; passed: boolean;
  status: string; stdout: string; stderr: string; compileOutput: string;
};
export type RunResult = { results: RunCaseResult[] };

export type SubmitTest = { index: number; passed: boolean; status: string; timeSec: number | null };
export type SubmitResult = { verdict: "accepted" | "wrong_answer"; passed_count: number; total: number; tests: SubmitTest[]; submission_id: string };
```

- [ ] **Step 2: Typecheck**

Run: `cd /home/karthi/arogara/proctor/frontend && npx tsc --noEmit`
Expected: PASS (exit 0).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/types.ts
git commit -m "feat(coding): editor-event + exec types"
```

---

## Task 7: Pure editor-event mappers + coalescing (TDD with vitest)

**Files:**
- Modify: `frontend/package.json` (add `vitest`), create `frontend/vitest.config.ts` (or rely on default)
- Create: `frontend/src/coding/editorEvents.ts`
- Test: `frontend/src/coding/editorEvents.test.ts`

- [ ] **Step 1: Add vitest**

Run: `cd /home/karthi/arogara/proctor/frontend && npm i -D vitest`
Add to `package.json` scripts: `"test": "vitest run"`.

- [ ] **Step 2: Write the failing test**

```typescript
// frontend/src/coding/editorEvents.test.ts
import { describe, it, expect } from "vitest";
import { mapContentChange, coalesceCursor, EventBatcher } from "./editorEvents";

const ts = () => "2026-06-09T10:00:00.000Z";

describe("mapContentChange", () => {
  it("maps a single-char insert to editor_insert with length + position", () => {
    const ev = mapContentChange({ rangeLength: 0, text: "a", rangeStartLine: 1, rangeStartCol: 1 }, ts());
    expect(ev.type).toBe("editor_insert");
    expect(ev.detail).toMatchObject({ insertedLen: 1, deletedLen: 0, line: 1, col: 1 });
  });
  it("maps a deletion (text empty, rangeLength>0) to editor_delete", () => {
    const ev = mapContentChange({ rangeLength: 3, text: "", rangeStartLine: 2, rangeStartCol: 4 }, ts());
    expect(ev.type).toBe("editor_delete");
    expect(ev.detail).toMatchObject({ deletedLen: 3 });
  });
  it("maps a replace (both > 0) to editor_replace", () => {
    const ev = mapContentChange({ rangeLength: 2, text: "xy", rangeStartLine: 1, rangeStartCol: 1 }, ts());
    expect(ev.type).toBe("editor_replace");
  });
  it("flags a large paste-like insert via mapPaste separately", () => {
    // paste is mapped by its own helper; see mapPaste in impl
  });
});

describe("coalesceCursor", () => {
  it("drops a cursor event that lands on the same line/col as the previous within the window", () => {
    const a = { line: 5, col: 2 }; const b = { line: 5, col: 2 };
    expect(coalesceCursor(a, b)).toBe(true); // true => should be dropped/coalesced
  });
  it("keeps a cursor move to a different line", () => {
    expect(coalesceCursor({ line: 5, col: 2 }, { line: 8, col: 1 })).toBe(false);
  });
});

describe("EventBatcher", () => {
  it("flushes when batch reaches maxSize", async () => {
    const flushed: any[][] = [];
    const b = new EventBatcher({ maxSize: 2, maxMs: 100000, onFlush: (evs) => flushed.push(evs) });
    b.add({ type: "editor_insert", timestamp: ts() });
    b.add({ type: "editor_insert", timestamp: ts() });
    expect(flushed.length).toBe(1);
    expect(flushed[0].length).toBe(2);
    b.dispose();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd /home/karthi/arogara/proctor/frontend && npx vitest run src/coding/editorEvents.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Write minimal implementation**

```typescript
// frontend/src/coding/editorEvents.ts
import type { EditorEvent } from "../types";

export type ContentChange = { rangeLength: number; text: string; rangeStartLine: number; rangeStartCol: number };

export function mapContentChange(c: ContentChange, timestamp: string): EditorEvent {
  const insertedLen = c.text.length;
  const deletedLen = c.rangeLength;
  let type: EditorEvent["type"];
  if (insertedLen > 0 && deletedLen > 0) type = "editor_replace";
  else if (deletedLen > 0) type = "editor_delete";
  else type = "editor_insert";
  return { type, timestamp, detail: { insertedLen, deletedLen, line: c.rangeStartLine, col: c.rangeStartCol } };
}

export function mapPaste(p: { len: number; line: number; col: number }, timestamp: string): EditorEvent {
  return { type: "editor_paste", timestamp, detail: { len: p.len, line: p.line, col: p.col } };
}

export function mapCursor(pos: { line: number; col: number }, timestamp: string): EditorEvent {
  return { type: "editor_cursor", timestamp, detail: { line: pos.line, col: pos.col } };
}

export function mapSelection(sel: { startLine: number; startCol: number; endLine: number; endCol: number }, timestamp: string): EditorEvent {
  return { type: "editor_selection", timestamp, detail: sel };
}

// Returns true if `next` cursor should be coalesced (dropped) because it equals `prev`.
export function coalesceCursor(prev: { line: number; col: number } | null, next: { line: number; col: number }): boolean {
  return !!prev && prev.line === next.line && prev.col === next.col;
}

export class EventBatcher {
  private buf: EditorEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private opts: { maxSize: number; maxMs: number; onFlush: (events: EditorEvent[]) => void }) {}
  add(e: EditorEvent) {
    this.buf.push(e);
    if (this.buf.length >= this.opts.maxSize) return this.flush();
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.opts.maxMs);
  }
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.buf.length) return;
    const batch = this.buf; this.buf = [];
    this.opts.onFlush(batch);
  }
  dispose() { this.flush(); }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd /home/karthi/arogara/proctor/frontend && npx vitest run src/coding/editorEvents.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/coding/editorEvents.ts frontend/src/coding/editorEvents.test.ts
git commit -m "feat(capture): pure editor-event mappers + coalescing + batcher (vitest)"
```

---

## Task 8: API client (`sendEditorEvents`, `execRun`, `execSubmit`)

**Files:**
- Modify: `frontend/src/api.ts`

- [ ] **Step 1: Implement** (follow the existing `sendEvents`/`request` patterns + demo-mode branch):

```typescript
// frontend/src/api.ts (append; mirror existing request() + demoMode patterns)
import type { EditorEvent, ExecRequest, RunResult, SubmitResult } from "./types";

export async function sendEditorEvents(sessionId: string, problemId: string, events: EditorEvent[]): Promise<void> {
  if (demoMode) return;                       // demo: don't post
  await request<{ ok: boolean }>("/api/editor-events", {
    method: "POST",
    body: JSON.stringify({ session_id: sessionId, problem_id: problemId, events })
  });
}

export async function execRun(req: ExecRequest): Promise<RunResult> {
  if (demoMode) {
    await wait(300);
    // The sum-two problem has TWO samples; return both so the demo matches the
    // real /api/exec/run shape (Task 3 asserts results.length === 2).
    return { results: [
      { input: "2 3\n", expected: "5", passed: true, status: "accepted", stdout: "5", stderr: "", compileOutput: "" },
      { input: "10 20\n", expected: "30", passed: true, status: "accepted", stdout: "30", stderr: "", compileOutput: "" }
    ] };
  }
  return request<RunResult>("/api/exec/run", { method: "POST", body: JSON.stringify(req) });
}

export async function execSubmit(req: ExecRequest): Promise<SubmitResult> {
  if (demoMode) {
    await wait(500);
    return { verdict: "accepted", passed_count: 4, total: 4, tests: [0,1,2,3].map((i)=>({index:i,passed:true,status:"accepted",timeSec:0.01})), submission_id: "demo" };
  }
  return request<SubmitResult>("/api/exec/submit", { method: "POST", body: JSON.stringify(req) });
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
cd /home/karthi/arogara/proctor/frontend && npx tsc --noEmit   # exit 0
git add frontend/src/api.ts
git commit -m "feat(coding): api client for editor-events + exec run/submit (+ demo)"
```

---

## Task 9: Monaco editor wrapper with capture hooks

**Files:**
- Add deps; Create `frontend/src/coding/MonacoEditor.tsx`

- [ ] **Step 1: Add Monaco**

Run: `cd /home/karthi/arogara/proctor/frontend && npm i @monaco-editor/react monaco-editor`

- [ ] **Step 2: Implement the wrapper** (lazy-loaded by CodingWorkspace; emits mapped EditorEvents via callbacks):

```tsx
// frontend/src/coding/MonacoEditor.tsx
import Editor, { type OnMount } from "@monaco-editor/react";
import { mapContentChange, mapPaste, mapCursor, mapSelection, coalesceCursor } from "./editorEvents";
import type { EditorEvent } from "../types";

const MONACO_LANG: Record<string, string> = { python: "python", cpp: "cpp", java: "java", javascript: "javascript" };

export function MonacoEditor({ language, value, onChange, onEvent }: {
  language: "python" | "cpp" | "java" | "javascript";
  value: string;
  onChange: (v: string) => void;
  onEvent: (e: EditorEvent) => void;
}) {
  let lastCursor: { line: number; col: number } | null = null;

  const handleMount: OnMount = (editor) => {
    editor.onDidChangeModelContent((ev) => {
      for (const c of ev.changes) {
        onEvent(mapContentChange(
          { rangeLength: c.rangeLength, text: c.text, rangeStartLine: c.range.startLineNumber, rangeStartCol: c.range.startColumn },
          new Date().toISOString()
        ));
      }
    });
    editor.onDidPaste((ev) => {
      const len = editor.getModel()?.getValueLengthInRange(ev.range) ?? 0;
      onEvent(mapPaste({ len, line: ev.range.startLineNumber, col: ev.range.startColumn }, new Date().toISOString()));
    });
    editor.onDidChangeCursorPosition((ev) => {
      const pos = { line: ev.position.lineNumber, col: ev.position.column };
      if (coalesceCursor(lastCursor, pos)) return;
      lastCursor = pos;
      onEvent(mapCursor(pos, new Date().toISOString()));
    });
    editor.onDidChangeCursorSelection((ev) => {
      const s = ev.selection;
      if (s.isEmpty()) return; // empty selection == cursor; already captured
      onEvent(mapSelection({ startLine: s.startLineNumber, startCol: s.startColumn, endLine: s.endLineNumber, endCol: s.endColumn }, new Date().toISOString()));
    });
    editor.onDidFocusEditorText(() => onEvent({ type: "editor_focus", timestamp: new Date().toISOString() }));
    editor.onDidBlurEditorText(() => onEvent({ type: "editor_blur", timestamp: new Date().toISOString() }));
  };

  return (
    <Editor
      height="60vh"
      language={MONACO_LANG[language]}
      value={value}
      onChange={(v) => onChange(v ?? "")}
      onMount={handleMount}
      options={{ minimap: { enabled: false }, fontSize: 14, automaticLayout: true, contextmenu: false }}
    />
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `cd /home/karthi/arogara/proctor/frontend && npx tsc --noEmit`
Expected: exit 0. (If `@monaco-editor/react` types complain about the worker env, add `vite-plugin-monaco-editor` or the standard Vite worker config — see its README; document any vite.config change in the commit.)

- [ ] **Step 4: Build (confirm Monaco bundles under Vite)**

Run: `cd /home/karthi/arogara/proctor/frontend && npm run build`
Expected: build succeeds (Monaco workers emitted). If it fails on workers, configure `@monaco-editor/react`'s `loader` or add the vite monaco plugin.

> **Offline/locked-exam follow-up (FLAG):** by default `@monaco-editor/react` does NOT bundle Monaco — its `loader` CDN-loads the `monaco-editor` assets from jsDelivr at runtime. For a locked/offline proctored exam (and to avoid an external runtime dependency / network egress during a test), wire `loader.config({ monaco })` to use the locally-installed `monaco-editor` package so everything is bundled by Vite. Track this as a Slice-1 follow-up; it is required before any real exam run, but the demo/dev build works without it.

- [ ] **Step 5: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/coding/MonacoEditor.tsx frontend/vite.config.* 2>/dev/null
git commit -m "feat(coding): Monaco editor wrapper with keystroke/cursor/selection/paste/focus capture"
```

---

## Task 10: CodingWorkspace (layout + orchestration) + render in StudentApp

**Files:**
- Create `frontend/src/coding/CodingWorkspace.tsx`
- Modify `frontend/src/App.tsx` (render it in `StudentApp`)

- [ ] **Step 1: Implement CodingWorkspace**

```tsx
// frontend/src/coding/CodingWorkspace.tsx
import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { execRun, execSubmit, sendEditorEvents } from "../api";
import { EventBatcher } from "./editorEvents";
import type { EditorEvent, RunResult, SubmitResult } from "../types";

const MonacoEditor = lazy(() => import("./MonacoEditor").then((m) => ({ default: m.MonacoEditor })));

const STARTERS: Record<string, string> = {
  python: "a, b = map(int, input().split())\nprint(a + b)\n",
  cpp: "#include <bits/stdc++.h>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a+b;}\n",
  java: "import java.util.*;\npublic class Main{public static void main(String[] a){Scanner s=new Scanner(System.in);System.out.print(s.nextLong()+s.nextLong());}}\n",
  javascript: "const [a,b]=require('fs').readFileSync(0,'utf8').trim().split(' ').map(Number);console.log(a+b);\n"
};

export function CodingWorkspace({ sessionId, problem }: {
  sessionId: string;
  problem: { id: string; title: string; statement: string; languages: ("python"|"cpp"|"java"|"javascript")[] };
}) {
  const [language, setLanguage] = useState(problem.languages[0]);
  const [code, setCode] = useState(STARTERS[language]);
  const [run, setRun] = useState<RunResult | null>(null);
  const [submit, setSubmit] = useState<SubmitResult | null>(null);
  const [busy, setBusy] = useState<"" | "run" | "submit">("");

  const batcher = useMemo(() => new EventBatcher({
    maxSize: 40, maxMs: 4000,
    onFlush: (events: EditorEvent[]) => { void sendEditorEvents(sessionId, problem.id, events); }
  }), [sessionId, problem.id]);
  const lastCode = useRef(code);

  const onEvent = (e: EditorEvent) => batcher.add(e);

  const doRun = async () => {
    setBusy("run"); onEvent({ type: "code_run", timestamp: new Date().toISOString(), detail: { language } }); batcher.flush();
    try { setRun(await execRun({ session_id: sessionId, problem_id: problem.id, language, source_code: code })); }
    finally { setBusy(""); }
  };
  const doSubmit = async () => {
    setBusy("submit"); onEvent({ type: "code_submit", timestamp: new Date().toISOString(), detail: { language } }); batcher.flush();
    try { setSubmit(await execSubmit({ session_id: sessionId, problem_id: problem.id, language, source_code: code })); }
    finally { setBusy(""); }
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <section className="rounded-lg border border-line bg-panel p-5">
        <h2 className="text-lg font-semibold">{problem.title}</h2>
        <p className="mt-2 whitespace-pre-wrap text-sm text-muted">{problem.statement}</p>
      </section>
      <section className="space-y-3">
        <div className="flex items-center gap-3">
          <select value={language} onChange={(e) => { const l = e.target.value as typeof language; setLanguage(l); if (lastCode.current === STARTERS[language]) { setCode(STARTERS[l]); lastCode.current = STARTERS[l]; } }}
                  className="rounded-md border border-line px-2 py-1 text-sm">
            {problem.languages.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
          <button onClick={doRun} disabled={!!busy} className="rounded-md border border-line px-3 py-1.5 text-sm">{busy==="run"?"Running…":"Run"}</button>
          <button onClick={doSubmit} disabled={!!busy} className="rounded-md bg-ink px-3 py-1.5 text-sm text-white">{busy==="submit"?"Submitting…":"Submit"}</button>
        </div>
        <Suspense fallback={<div className="text-sm text-muted">Loading editor…</div>}>
          <MonacoEditor language={language} value={code} onChange={(v) => { setCode(v); lastCode.current = v; }} onEvent={onEvent} />
        </Suspense>
        {run && (
          <div className="rounded-md border border-line bg-panel p-3 text-sm">
            <div className="font-medium">Sample results</div>
            {run.results.map((r, i) => (
              <div key={i} className={r.passed ? "text-green-700" : "text-red-700"}>
                Test {i+1}: {r.passed ? "passed" : "failed"} — got <span className="font-mono">{r.stdout.trim() || "(none)"}</span>{r.compileOutput ? ` · ${r.compileOutput}` : ""}
              </div>
            ))}
          </div>
        )}
        {submit && (
          <div className={`rounded-md border p-3 text-sm ${submit.verdict==="accepted" ? "border-green-300 bg-green-50" : "border-red-300 bg-red-50"}`}>
            Verdict: <span className="font-semibold">{submit.verdict}</span> — {submit.passed_count}/{submit.total} hidden tests passed.
          </div>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Render in StudentApp** — `frontend/src/App.tsx`:

In `StudentApp`, where the candidate currently sees the `contest_url` link (search for `contest_url` usage in the recording/active state), render the workspace instead when a Slice-1 problem is configured and the session is active. Minimal wiring:

```tsx
// near the top of App.tsx imports
import { CodingWorkspace } from "./coding/CodingWorkspace";
const SLICE1_PROBLEM = {
  id: "sum-two", title: "Sum of Two Numbers",
  statement: "Read two integers a and b on one line separated by a space. Print a + b.",
  languages: ["python","cpp","java","javascript"] as const
};
```

Inside `StudentApp`'s active/recording render branch (where `sessionId` is set and recording is live), add:
```tsx
{sessionId && status === "recording" && (
  <CodingWorkspace sessionId={sessionId} problem={SLICE1_PROBLEM} />
)}
```
> Keep the existing `contest_url` UI behind a fallback for now (Slice 1 is additive; do not delete the HackerRank path until Slice 3 cuts over). Match the exact `status`/`sessionId` variable names already in `StudentApp`.

- [ ] **Step 3: Typecheck + build**

Run: `cd /home/karthi/arogara/proctor/frontend && npx tsc --noEmit && npm run build`
Expected: both succeed.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/coding/CodingWorkspace.tsx frontend/src/App.tsx
git commit -m "feat(coding): CodingWorkspace (problem+editor+run/submit+results), rendered in StudentApp"
```

---

## Task 11: End-to-end verification (manual + visual)

**Files:** none (verification only).

- [ ] **Step 1: Backend full suite green**

Run: `cd /home/karthi/arogara/proctor/backend && npm test`
Expected: all pass (including the new exec + editor-events tests).

- [ ] **Step 2: Frontend unit + build green**

Run: `cd /home/karthi/arogara/proctor/frontend && npx vitest run && npm run build`
Expected: vitest passes, build clean.

- [ ] **Step 3: Demo-mode visual run-through** (no Judge0 key needed — `VITE_DEMO_MODE=true`)

Run: `cd /home/karthi/arogara/proctor/frontend && VITE_DEMO_MODE=true VITE_ADMIN_PASSWORD=dev npm run dev`
Then drive a headless Chromium (as in the admin-polish review) to the student flow: confirm the editor loads, typing works, Run shows sample results, Submit shows a verdict, and (in non-demo) `/api/editor-events` receives batches. Screenshot the workspace.

- [ ] **Step 4: Live smoke (when Karthi provides the Judge0 key)** — set `JUDGE0_API_KEY` + `JUDGE0_MODE=rapidapi` on the backend, deploy to a test project, run one real submission per language, confirm verdicts and that captured events land in GCS. (Verify `language_id`s via `GET /languages` first.)

- [ ] **Step 5: Final commit / PR** — per Karthi's standing instruction, commit locally and DO NOT push unless he says so.

---

## Self-Review (run against the design doc §4)

- **Spec coverage:** same-origin Monaco in StudentApp ✔ (T9–T10); language selector all 4 ✔ (T2/T9/T10); Run sample / Submit hidden via adapter ✔ (T1/T3/T4); capture keystrokes/cursor/selection/paste/focus/run/submit ✔ (T7/T9); batched → storage ✔ (T5/T7/T8); submissions stored ✔ (T4); tied to proctor session_id ✔ (workspace takes sessionId); ownership-gated on the session (`requireWritableSession(await getSession(...))` on /api/exec/run, /api/exec/submit, /api/editor-events — same as /api/events) ✔ (T3/T4/T5); Judge0 key server-side ✔ (T3 env, client calls our backend); swap-able adapter ✔ (T1, injected in tests via `__setJudge0AdapterForTest`); demo mode ✔ (T8/T11). Fullscreen-first / roster / leaderboard correctly **excluded** (Slice 3).
- **Placeholder scan:** no TBD/"handle errors" hand-waves; each code step has real code. Test files inline `makeReq`/`makeRes` + paste `makeFakeFirestore`/`makeFakeStorage` from `phase2.test.mjs` (there is no `helpers.mjs`), set env before a cache-buster handler import, and inject fakes via `__setClientsForTest` / `__setJudge0AdapterForTest`. The remaining implementer notes (copy the `phase2.test.mjs` fakes verbatim; confirm Monaco/Vite worker config; bundle Monaco locally for offline exams) point at concrete existing patterns, not missing content.
- **Type consistency:** `EditorEvent`, `ExecRequest`, `RunResult`, `SubmitResult` defined in T6 and used unchanged in T7–T10; backend `runBatch` result shape (status/passed/stdout/...) consistent across T1/T3/T4; `LANGUAGE_IDS` keys match the frontend language union.
- **Open items deferred to Karthi/plan-time (not blockers):** exact Judge0 `language_id`s (verify via `GET /languages`); whether to show candidates which hidden test failed (currently pass/fail counts only — matches "don't leak inputs").

---

## Execution options (after Karthi approves)
1. **Subagent-driven (recommended)** — fresh subagent per task, review between tasks.
2. **Inline execution** — batch with checkpoints.
Do NOT start execution until Karthi reviews this plan + the design doc.
