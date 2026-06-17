# S4 — Problem Authoring (question bank + tests + limits + scoring) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** READY (paired with `docs/superpowers/specs/2026-06-09-s4-problem-authoring-design.md`).

**Goal:** Problems live in Firestore (`proctor_problems`) and are authored/published/assigned through a new admin "Problems" tab; candidates receive the assigned problem inside the start/resume response and solve it in the existing CodingWorkspace; `getProblem(id)` stays the exec read interface (now async + Firestore-backed, built-in `sum-two` seed as fallback); submissions get a score (`points` × scoring mode).

**Tech stack / conventions (follow EXACTLY):**
- Backend: Node 20 Cloud Function `backend/src/handler.mjs`; tests = `node:test` + pasted fake Firestore/Storage + `__setClientsForTest`/`__setJudge0AdapterForTest` + env-vars-BEFORE-import + unique `?problems` cache-buster import. NO helpers.mjs. Pure modules get their own test file with NO handler import (the `judge0Adapter.test.mjs` precedent).
- Frontend: React/Vite/TS; pure logic unit-tested with vitest; ALL network calls in `frontend/src/api.ts` with demo-mode branches.
- **Commits are LOCAL only, one per task. NEVER `git push`.**
- **Parallel-build safety:** S2 (roster) and S3 (invigilator) agents may have already edited `handler.mjs`, `api.ts`, `types.ts`, `App.tsx` tonight. Every anchor below was verified against the tree at plan time — if an anchor string moved, find the equivalent landmark by the quoted text and apply the SAME edit. Never duplicate routes/consts. Add fields alongside whatever S2/S3 added; never remove their fields.
- Do NOT touch `backend/src/judge0Adapter.mjs`, `frontend/src/coding/editorEvents.ts`, `frontend/src/coding/MonacoEditor.tsx`, or any monitoring/ code.

---

## File structure

**Backend:**
- Rewrite `backend/src/problems.mjs` — the problem BANK: `PROBLEM_BOUNDS`, `isValidProblemId`, `validateProblemInput`, `scoreSubmission`, `configureProblemStore`, async `getProblem` (Firestore-first, published-only, seed fallback), seed `sum-two` kept.
- Modify `backend/src/handler.mjs` — `PROBLEMS_COLLECTION` const, store wiring, 4 admin CRUD routes/handlers, `problem_id` in settings save/echo, async `startResponse` + `activeProblemPublic`, `await getProblem` + scoring in exec.
- Create `backend/test/problems.test.mjs` (pure, no handler import) and `backend/test/problemAuthoring.test.mjs` (handler, `?problems` buster; grows across Tasks 2–4).
- Modify `backend/test/exec.test.mjs` — ONLY the two `getProblem` shape tests (sync → await; everything else untouched).

**Frontend:**
- Modify `frontend/src/types.ts` — `ProblemDoc`, `ProblemSummary`, `PublicProblem`, `ProblemTest`, scoring/status types; `SessionStartResponse.problem`; `ProctorSettings.problem_id`; `SubmitResult.score`/`max_points`.
- Create `frontend/src/problems/problemDraft.ts` + `frontend/src/problems/problemDraft.test.ts` — pure draft↔doc mapping + client-side validation (vitest).
- Modify `frontend/src/api.ts` — `fetchProblems`/`fetchProblemDetail`/`saveProblem`/`deleteProblem` (+ demo localStorage store), demo settings `problem_id`, `demoSessionResponse.problem`, demo `execSubmit` score.
- Create `frontend/src/admin/ProblemBank.tsx` — self-contained admin section.
- Modify `frontend/src/App.tsx` — admin: import + `AdminView` + tab + render branch + settings "Active problem ID" field; student: delete `SLICE1_PROBLEM`, render from `sessionConfig.problem`, `StudentStepBanner.hasProblem`.
- Modify `frontend/src/coding/CodingWorkspace.tsx` — generic starters, optional sample-tests display, score in verdict box.

---

## Task 1: Problem bank module (pure logic + async `getProblem`)

**Files:**
- Create: `backend/test/problems.test.mjs`
- Rewrite: `backend/src/problems.mjs`

- [ ] **Step 1: Write the failing tests** — create `backend/test/problems.test.mjs`:

> PURE unit tests — no handler import, no env, no GCP (the `judge0Adapter.test.mjs` precedent). Store-backed tests use `configureProblemStore` with an inline fake; that is safe ONLY because `node --test` runs each test file in its own process, so this never clobbers the handler's store wiring used by other files. Store-LESS tests are declared first (the store, once configured, stays configured for the rest of this file).

```javascript
// backend/test/problems.test.mjs
// PURE unit tests of the problem bank module — no handler import, no env, no
// GCP. Store-less tests run FIRST; configureProblemStore is module-global and
// stays set for the rest of this file (own process, so no cross-file leakage).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  configureProblemStore, getProblem, isValidProblemId,
  scoreSubmission, validateProblemInput, LANGUAGE_IDS
} from "../src/problems.mjs";

function makeFakeProblemFirestore(docs) {
  // docs: { "<collection>/<id>": data }
  return {
    collection(name) {
      return {
        doc(id) {
          return {
            async get() {
              const data = docs[`${name}/${id}`];
              return { exists: Boolean(data), data: () => data };
            }
          };
        }
      };
    }
  };
}

function validInput(overrides = {}) {
  return {
    id: "rev-str", title: "Reverse", statement: "Reverse the input line.",
    languages: ["python", "cpp"], cpuTimeLimit: 2, memoryLimit: 64000,
    points: 80, scoring: "per_test", status: "published",
    sampleTests: [{ input: "ab\n", expected: "ba" }],
    hiddenTests: [{ input: "xyz\n", expected: "zyx" }],
    ...overrides
  };
}

// ---- isValidProblemId -------------------------------------------------------

test("isValidProblemId: slugs pass, everything else fails", () => {
  assert.equal(isValidProblemId("sum-two"), true);
  assert.equal(isValidProblemId("a"), true);
  assert.equal(isValidProblemId("Bad_ID"), false);
  assert.equal(isValidProblemId(""), false);
  assert.equal(isValidProblemId("-leading-hyphen"), false);
  assert.equal(isValidProblemId("x".repeat(65)), false);
});

// ---- validateProblemInput ---------------------------------------------------

test("validateProblemInput: valid payload -> normalized allow-listed problem", () => {
  const r = validateProblemInput({ ...validInput(), evil: "dropped" });
  assert.equal(r.ok, true);
  assert.equal(r.problem.id, "rev-str");
  assert.equal(r.problem.evil, undefined); // never spread client input
  assert.deepEqual(r.problem.sampleTests, [{ input: "ab\n", expected: "ba" }]);
  assert.equal(r.problem.status, "published");
});

test("validateProblemInput: defaults applied (points 100, per_test, draft)", () => {
  const r = validateProblemInput(validInput({ points: undefined, scoring: undefined, status: undefined }));
  assert.equal(r.ok, true);
  assert.equal(r.problem.points, 100);
  assert.equal(r.problem.scoring, "per_test");
  assert.equal(r.problem.status, "draft");
});

test("validateProblemInput: languages de-duped, unknown language rejected", () => {
  const ok = validateProblemInput(validInput({ languages: ["python", "python"] }));
  assert.deepEqual(ok.problem.languages, ["python"]);
  const bad = validateProblemInput(validInput({ languages: ["python", "rust"] }));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /unsupported language/);
});

test("validateProblemInput: rejections carry specific errors", () => {
  assert.match(validateProblemInput(validInput({ id: "Bad_ID" })).error, /id/);
  assert.match(validateProblemInput(validInput({ title: "  " })).error, /title/);
  assert.match(validateProblemInput(validInput({ statement: "x".repeat(20001) })).error, /statement/);
  assert.match(validateProblemInput(validInput({ languages: [] })).error, /languages/);
  assert.match(validateProblemInput(validInput({ cpuTimeLimit: 30 })).error, /cpuTimeLimit/);
  assert.match(validateProblemInput(validInput({ memoryLimit: 64000.5 })).error, /memoryLimit/);
  assert.match(validateProblemInput(validInput({ points: -1 })).error, /points/);
  assert.match(validateProblemInput(validInput({ scoring: "bonus" })).error, /scoring/);
  assert.match(validateProblemInput(validInput({ status: "live" })).error, /status/);
  assert.match(validateProblemInput(validInput({ hiddenTests: [] })).error, /hiddenTests/);
  assert.match(validateProblemInput(validInput({ sampleTests: [{ input: "x" }] })).error, /sampleTests\[0\]/);
});

// ---- scoreSubmission --------------------------------------------------------

test("scoreSubmission: per_test is proportional and floored", () => {
  assert.equal(scoreSubmission({ points: 100, scoring: "per_test" }, 3, 4), 75);
  assert.equal(scoreSubmission({ points: 50, scoring: "per_test" }, 1, 3), 16);
  assert.equal(scoreSubmission({ points: 100, scoring: "per_test" }, 0, 4), 0);
});

test("scoreSubmission: all_or_nothing pays only on a clean sweep", () => {
  assert.equal(scoreSubmission({ points: 80, scoring: "all_or_nothing" }, 4, 4), 80);
  assert.equal(scoreSubmission({ points: 80, scoring: "all_or_nothing" }, 3, 4), 0);
});

test("scoreSubmission: defaults (points 100, per_test) and zero-total guard", () => {
  assert.equal(scoreSubmission({}, 2, 4), 50);
  assert.equal(scoreSubmission({ points: 100 }, 0, 0), 0);
});

// ---- getProblem, store-LESS (seeds only) — keep these BEFORE the store tests -

test("getProblem (no store): seed sum-two served; unknown/invalid/prototype ids -> null", async () => {
  const p = await getProblem("sum-two");
  assert.equal(p.id, "sum-two");
  assert.ok(Array.isArray(p.sampleTests) && p.sampleTests.length >= 1);
  assert.ok(Array.isArray(p.hiddenTests) && p.hiddenTests.length >= 3);
  assert.equal(p.status, "published");
  assert.equal(await getProblem("nope"), null);
  assert.equal(await getProblem("Bad_ID"), null);
  assert.equal(await getProblem("constructor"), null); // never a prototype member
  for (const lang of ["python", "cpp", "java", "javascript"]) assert.ok(LANGUAGE_IDS[lang]);
});

// ---- getProblem, store-backed ----------------------------------------------

test("getProblem (store): published bank doc served; draft hidden; bank shadows seed; miss falls back to seed", async () => {
  const published = { ...validInput(), id: "rev-str" };
  const draftSum = { ...validInput(), id: "sum-two", status: "draft" };
  const fake = makeFakeProblemFirestore({
    "bank/rev-str": published,
    "bank/sum-two": draftSum
  });
  configureProblemStore({ getFirestore: () => fake, collection: "bank" });

  const served = await getProblem("rev-str");
  assert.equal(served.title, "Reverse");
  // a DRAFT bank doc owns its id: it hides the published seed entirely
  assert.equal(await getProblem("sum-two"), null);
  // no doc at all -> seed fallback still answers (swap to an empty store)
  configureProblemStore({ getFirestore: () => makeFakeProblemFirestore({}), collection: "bank" });
  assert.equal((await getProblem("sum-two")).id, "sum-two");
  // invalid id never reaches the store (would throw on a real doc path)
  assert.equal(await getProblem("a/b"), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/karthi/arogara/proctor/backend && node --test test/problems.test.mjs`
Expected: FAIL — `isValidProblemId`/`validateProblemInput`/... are not exported (module rewrite not done yet).

- [ ] **Step 3: Write the implementation** — replace the ENTIRE content of `backend/src/problems.mjs` with:

```javascript
// backend/src/problems.mjs
// S4: the problem BANK. Problems are authored into Firestore via the admin
// console; built-in SEED problems remain as a zero-config fallback so dev/demo/
// tests work with an empty collection. getProblem(id) is THE read interface for
// the exec endpoints + start payload — async + Firestore-backed now, same name
// and problem shape as Slice 1 (camelCase fields the exec handlers already read).
//
// NOTE: verify language_ids against the live instance via GET /languages before
// a real run; these are the common Judge0 CE ids.
export const LANGUAGE_IDS = { python: 71, cpp: 54, java: 62, javascript: 63 };

export const SUPPORTED_LANGUAGES = Object.keys(LANGUAGE_IDS);

// Authoring bounds. CPU/memory stay inside the Judge0 CE hard maxima (design
// §11) so an authored limit is never silently clamped by the engine. Hidden
// tests cap at 50 — the adapter already chunks batches to <=20 per request.
export const PROBLEM_BOUNDS = {
  ID_PATTERN: /^[a-z0-9][a-z0-9-]{0,63}$/,
  TITLE_MAX: 200,
  STATEMENT_MAX: 20000,
  TEST_TEXT_MAX: 10000,
  SAMPLE_TESTS_MAX: 10,
  HIDDEN_TESTS_MAX: 50,
  CPU_MIN: 0.5,
  CPU_MAX: 15,
  MEMORY_MIN: 16000,
  MEMORY_MAX: 512000,
  POINTS_MAX: 1000
};

const SCORING_MODES = ["per_test", "all_or_nothing"];
const PROBLEM_STATUSES = ["draft", "published"];

// Slice 1's config problem, now in the seed-bank shape (status/points/scoring
// added). A Firestore doc with the same id SHADOWS this seed entirely.
const SEED_PROBLEMS = {
  "sum-two": {
    id: "sum-two",
    title: "Sum of Two Numbers",
    statement: "Read two integers a and b on one line separated by a space. Print a + b.",
    languages: ["python", "cpp", "java", "javascript"],
    cpuTimeLimit: 5, memoryLimit: 128000,
    points: 100, scoring: "per_test", status: "published",
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

export function isValidProblemId(id) {
  return PROBLEM_BOUNDS.ID_PATTERN.test(String(id || ""));
}

// Wired by handler.mjs at module load with a Firestore GETTER (not the
// instance) so the __setClientsForTest fakes propagate to problem reads too.
// Unconfigured (pure unit tests) -> seeds only.
let store = null;
export function configureProblemStore({ getFirestore, collection }) {
  store = { getFirestore, collection };
}

// THE candidate/exec read path. Published problems only:
//   - invalid id shape -> null BEFORE any Firestore doc path is built
//   - a bank doc OWNS its id: published -> served, draft -> null (hides any seed)
//   - no doc -> built-in seed fallback (own keys only, never prototype members)
export async function getProblem(id) {
  const key = String(id || "");
  if (!isValidProblemId(key)) return null;
  if (store) {
    const doc = await store.getFirestore().collection(store.collection).doc(key).get();
    if (doc.exists) {
      const problem = doc.data();
      return problem?.status === "published" ? problem : null;
    }
  }
  const seed = Object.hasOwn(SEED_PROBLEMS, key) ? SEED_PROBLEMS[key] : null;
  return seed && seed.status === "published" ? seed : null;
}

// Submit-time scoring (stored on the submission + returned with the verdict).
// per_test (default): floor(points * passed/total). all_or_nothing: full
// points only when every hidden test passed.
export function scoreSubmission(problem, passedCount, total) {
  const points = Number.isFinite(problem?.points) ? problem.points : 100;
  const mode = problem?.scoring === "all_or_nothing" ? "all_or_nothing" : "per_test";
  if (!total) return 0;
  if (mode === "all_or_nothing") return passedCount === total ? points : 0;
  return Math.floor((points * passedCount) / total);
}

function invalid(error) {
  return { ok: false, error };
}

function cleanTests(raw, max, label) {
  if (!Array.isArray(raw) || raw.length < 1) return invalid(`${label} must be a non-empty array`);
  if (raw.length > max) return invalid(`${label}: max ${max} tests`);
  const tests = [];
  for (const [index, item] of raw.entries()) {
    if (!item || typeof item !== "object" || item.input === undefined || item.expected === undefined) {
      return invalid(`${label}[${index}] must be an object with input and expected`);
    }
    const input = String(item.input);
    const expected = String(item.expected);
    if (input.length > PROBLEM_BOUNDS.TEST_TEXT_MAX || expected.length > PROBLEM_BOUNDS.TEST_TEXT_MAX) {
      return invalid(`${label}[${index}]: input/expected max ${PROBLEM_BOUNDS.TEST_TEXT_MAX} chars`);
    }
    tests.push({ input, expected });
  }
  return { ok: true, tests };
}

// Validate + NORMALIZE an authoring payload into a brand-new allow-listed
// problem object — client input is never spread into storage (same hardening
// rule as the editor-events ingest). Returns {ok:true, problem}|{ok:false, error}.
export function validateProblemInput(body) {
  const id = String(body?.id || "").trim();
  if (!isValidProblemId(id)) return invalid("id must be 1-64 lowercase letters/digits/hyphens (starting with a letter or digit)");

  const title = String(body?.title || "").trim();
  if (!title) return invalid("title is required");
  if (title.length > PROBLEM_BOUNDS.TITLE_MAX) return invalid(`title: max ${PROBLEM_BOUNDS.TITLE_MAX} chars`);

  const statement = String(body?.statement || "");
  if (!statement.trim()) return invalid("statement is required");
  if (statement.length > PROBLEM_BOUNDS.STATEMENT_MAX) return invalid(`statement: max ${PROBLEM_BOUNDS.STATEMENT_MAX} chars`);

  const rawLanguages = Array.isArray(body?.languages) ? body.languages.map(String) : [];
  const languages = [...new Set(rawLanguages)];
  if (!languages.length) return invalid("languages must be a non-empty array");
  for (const lang of languages) {
    if (!SUPPORTED_LANGUAGES.includes(lang)) return invalid(`unsupported language: ${lang}`);
  }

  const cpuTimeLimit = Number(body?.cpuTimeLimit);
  if (!Number.isFinite(cpuTimeLimit) || cpuTimeLimit < PROBLEM_BOUNDS.CPU_MIN || cpuTimeLimit > PROBLEM_BOUNDS.CPU_MAX) {
    return invalid(`cpuTimeLimit must be ${PROBLEM_BOUNDS.CPU_MIN}-${PROBLEM_BOUNDS.CPU_MAX} seconds`);
  }
  const memoryLimit = Number(body?.memoryLimit);
  if (!Number.isInteger(memoryLimit) || memoryLimit < PROBLEM_BOUNDS.MEMORY_MIN || memoryLimit > PROBLEM_BOUNDS.MEMORY_MAX) {
    return invalid(`memoryLimit must be an integer ${PROBLEM_BOUNDS.MEMORY_MIN}-${PROBLEM_BOUNDS.MEMORY_MAX} KB`);
  }

  const points = body?.points === undefined ? 100 : Number(body.points);
  if (!Number.isInteger(points) || points < 0 || points > PROBLEM_BOUNDS.POINTS_MAX) {
    return invalid(`points must be an integer 0-${PROBLEM_BOUNDS.POINTS_MAX}`);
  }
  const scoring = body?.scoring === undefined ? "per_test" : String(body.scoring);
  if (!SCORING_MODES.includes(scoring)) return invalid(`scoring must be one of ${SCORING_MODES.join(", ")}`);
  const status = body?.status === undefined ? "draft" : String(body.status);
  if (!PROBLEM_STATUSES.includes(status)) return invalid(`status must be one of ${PROBLEM_STATUSES.join(", ")}`);

  const samples = cleanTests(body?.sampleTests, PROBLEM_BOUNDS.SAMPLE_TESTS_MAX, "sampleTests");
  if (!samples.ok) return samples;
  const hidden = cleanTests(body?.hiddenTests, PROBLEM_BOUNDS.HIDDEN_TESTS_MAX, "hiddenTests");
  if (!hidden.ok) return hidden;

  return {
    ok: true,
    problem: {
      id, title, statement, languages,
      cpuTimeLimit, memoryLimit, points, scoring, status,
      sampleTests: samples.tests, hiddenTests: hidden.tests
    }
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /home/karthi/arogara/proctor/backend && node --test test/problems.test.mjs`
Expected: PASS (10 tests).

- [ ] **Step 5: Make the exec call sites async-aware (the interface change forces exactly two `await`s + two test updates — fold them into THIS task so every commit stays green)**

In `backend/src/handler.mjs`, function `execRun` (~line 517), change:
```javascript
  const problem = getProblem(String(body.problem_id || ""));
```
to:
```javascript
  const problem = await getProblem(String(body.problem_id || ""));
```
and the identical line in `execSubmit` (~line 541) the same way.

In `backend/test/exec.test.mjs`, REPLACE the two problem-shape tests (find them by their exact names) with:

```javascript
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
```

> NOTE: this is the ONLY edit to existing test files in the whole plan, forced by the interface change. The store wiring (`configureProblemStore`) does not exist in handler.mjs until Task 2 — until then `getProblem` is store-less and these tests pass even without fakes, but inject them anyway so the tests stay valid after Task 2.

- [ ] **Step 6: Run the FULL backend suite**

Run: `cd /home/karthi/arogara/proctor/backend && npm test`
Expected: ALL tests pass (exec endpoint tests work because `await getProblem` resolves the seed exactly as before). If anything beyond `exec.test.mjs` fails, STOP and investigate — that would mean another module calls `getProblem` synchronously.

- [ ] **Step 7: Commit**

```bash
cd /home/karthi/arogara/proctor
git add backend/src/problems.mjs backend/src/handler.mjs backend/test/problems.test.mjs backend/test/exec.test.mjs
git commit -m "feat(problems): Firestore-backed problem bank module — validation, scoring, async getProblem with seed fallback"
```

---

## Task 2: Admin problem CRUD endpoints

**Files:**
- Create: `backend/test/problemAuthoring.test.mjs`
- Modify: `backend/src/handler.mjs`

- [ ] **Step 1: Write the failing tests** — create `backend/test/problemAuthoring.test.mjs` with EXACTLY this content (the fakes are copied from `backend/test/phase2.test.mjs` — same code, do not improvise; this header is written ONCE here, Tasks 3–4 only APPEND tests):

```javascript
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/karthi/arogara/proctor/backend && node --test test/problemAuthoring.test.mjs`
Expected: FAIL — the CRUD routes 404 (handlers don't exist).

- [ ] **Step 3: Write the implementation** — in `backend/src/handler.mjs`:

(a) Update the problems import (line ~5) to:
```javascript
import { configureProblemStore, getProblem, isValidProblemId, LANGUAGE_IDS, scoreSubmission, validateProblemInput } from "./problems.mjs";
```

(b) In the const block, next to `const SUBMISSIONS_COLLECTION = ...` (~line 77), add:
```javascript
const PROBLEMS_COLLECTION = process.env.PROBLEMS_COLLECTION || "proctor_problems";
const PROBLEMS_QUERY_LIMIT = 500;
```

(c) Immediately AFTER the const block (right before the `const SESSION_STATUSES = [...]` declaration and its comment, ~line 100), add:
```javascript
// S4: wire the problem bank to THIS module's Firestore handle. A getter (not
// the instance) so __setClientsForTest fakes propagate to problem reads too.
configureProblemStore({ getFirestore: () => firestore, collection: PROBLEMS_COLLECTION });
```

(d) Register the routes next to the existing `/api/admin/settings` routes (~line 139):
```javascript
    if (req.method === "GET" && path === "/api/admin/problems") return send(res, 200, await adminListProblems(req));
    if (req.method === "GET" && path === "/api/admin/problem") return send(res, 200, await adminGetProblem(req));
    if (req.method === "POST" && path === "/api/admin/problems") return send(res, 200, await adminSaveProblem(req));
    if (req.method === "POST" && path === "/api/admin/problem-delete") return send(res, 200, await adminDeleteProblem(req));
```

(e) Add the handlers right after `adminSaveSettings` (~line 873):
```javascript
// ---- S4: problem bank (admin authoring) ------------------------------------

function problemRef(id) {
  return firestore.collection(PROBLEMS_COLLECTION).doc(id);
}

async function adminListProblems(req) {
  requireAdmin(req);
  const snapshot = await firestore.collection(PROBLEMS_COLLECTION).limit(PROBLEMS_QUERY_LIMIT).get();
  const problems = snapshot.docs
    .map((doc) => doc.data())
    .map((p) => ({
      id: p.id,
      title: p.title || "",
      status: p.status || "draft",
      points: p.points ?? 100,
      scoring: p.scoring || "per_test",
      languages: p.languages || [],
      sample_count: (p.sampleTests || []).length,
      hidden_count: (p.hiddenTests || []).length,
      updated_at: p.updated_at || ""
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { problems };
}

async function adminGetProblem(req) {
  requireAdmin(req);
  const id = String(req.query?.id || "");
  if (!isValidProblemId(id)) return badRequest("invalid id");
  const doc = await problemRef(id).get();
  if (!doc.exists) throw httpError(404, "Problem not found");
  // Full doc INCLUDING hiddenTests — admin-only surface.
  return { problem: doc.data() };
}

async function adminSaveProblem(req) {
  requireAdmin(req);
  const body = parseBody(req);
  const checked = validateProblemInput(body);
  if (!checked.ok) return badRequest(checked.error);
  const existing = await problemRef(checked.problem.id).get();
  const now = new Date().toISOString();
  const item = {
    ...checked.problem,
    created_at: existing.exists ? (existing.data().created_at || now) : now,
    updated_at: now
  };
  await problemRef(item.id).set(item);
  return { ok: true, problem: item };
}

async function adminDeleteProblem(req) {
  requireAdmin(req);
  const body = parseBody(req);
  const id = String(body.id || "");
  if (!isValidProblemId(id)) return badRequest("invalid id");
  await problemRef(id).delete();
  // If the deleted problem was the assigned contest problem, clear the
  // assignment so start/resume stop advertising a dead id (link-flow fallback).
  const settings = await getSettings();
  if (settings?.problem_id === id) {
    await settingsRef().set({ ...settings, problem_id: "", updated_at: new Date().toISOString() });
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /home/karthi/arogara/proctor/backend && node --test test/problemAuthoring.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Full suite + commit**

```bash
cd /home/karthi/arogara/proctor/backend && npm test   # all pass
cd /home/karthi/arogara/proctor
git add backend/src/handler.mjs backend/test/problemAuthoring.test.mjs
git commit -m "feat(problems): admin problem CRUD endpoints (list/get/upsert/delete) + bank store wiring"
```

---

## Task 3: Active-problem assignment + public problem in start/resume

**Files:**
- Modify: `backend/src/handler.mjs`
- Test: `backend/test/problemAuthoring.test.mjs` (append)

- [ ] **Step 1: Write the failing tests** — APPEND to `backend/test/problemAuthoring.test.mjs`:

```javascript
// ---- Task 3: settings problem_id + public problem in start/resume -----------

const GATE = { start_at: "2026-01-01T00:00:00.000Z", end_at: "2027-01-01T00:00:00.000Z" };

test("settings save validates problem_id: unknown/draft -> 400; published bank doc or built-in seed -> saved + echoed", async () => {
  freshClients();
  const unknown = await call(makeReq({ method: "POST", path: "/api/admin/settings", headers: ADMIN,
    body: { ...GATE, problem_id: "ghost" } }));
  assert.equal(unknown.statusCode, 400);

  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem({ id: "draft-one", status: "draft" }) }));
  const draft = await call(makeReq({ method: "POST", path: "/api/admin/settings", headers: ADMIN,
    body: { ...GATE, problem_id: "draft-one" } }));
  assert.equal(draft.statusCode, 400);

  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem() }));
  const published = await call(makeReq({ method: "POST", path: "/api/admin/settings", headers: ADMIN,
    body: { ...GATE, problem_id: "rev-str" } }));
  assert.equal(published.statusCode, 200);
  assert.equal(published.body.problem_id, "rev-str");

  // built-in seed counts as assignable even with no Firestore doc
  const seed = await call(makeReq({ method: "POST", path: "/api/admin/settings", headers: ADMIN,
    body: { ...GATE, problem_id: "sum-two" } }));
  assert.equal(seed.statusCode, 200);

  const echoed = await call(makeReq({ method: "GET", path: "/api/admin/settings", headers: ADMIN }));
  assert.equal(echoed.body.problem_id, "sum-two");
});

test("resume payload carries the PUBLIC problem view — never hiddenTests; null when unassigned", async () => {
  const { firestore } = freshClients();
  firestore.collection("problems_sessions").doc("s1").set({
    session_id: "s1", status: "active", username_norm: "alice", contest_slug: "", storage_prefix: "sessions/alice/s1/"
  });
  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem() }));
  firestore.collection("problems_settings").doc("active").set({ ...GATE, problem_id: "rev-str" });

  const res = await call(makeReq({ method: "POST", path: "/api/session/resume", body: { session_id: "s1" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.problem.id, "rev-str");
  assert.equal(res.body.problem.title, "Reverse");
  assert.equal(res.body.problem.points, 80);
  assert.equal(res.body.problem.cpuTimeLimit, 2);
  assert.deepEqual(res.body.problem.sampleTests, [{ input: "ab\n", expected: "ba" }]);
  assert.equal(res.body.problem.hiddenTests, undefined); // the §9 lock extends to the bank
  assert.equal(res.body.problem.status, undefined);      // lifecycle is admin-only

  // unassigned -> problem: null (legacy link-flow fallback)
  firestore.collection("problems_settings").doc("active").set({ ...GATE });
  const bare = await call(makeReq({ method: "POST", path: "/api/session/resume", body: { session_id: "s1" } }));
  assert.equal(bare.body.problem, null);
});

test("a problem UNPUBLISHED after assignment degrades to problem: null (no dead payloads)", async () => {
  const { firestore } = freshClients();
  firestore.collection("problems_sessions").doc("s1").set({
    session_id: "s1", status: "active", username_norm: "alice", contest_slug: "", storage_prefix: "sessions/alice/s1/"
  });
  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem() }));
  firestore.collection("problems_settings").doc("active").set({ ...GATE, problem_id: "rev-str" });
  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem({ status: "draft" }) }));
  const res = await call(makeReq({ method: "POST", path: "/api/session/resume", body: { session_id: "s1" } }));
  assert.equal(res.body.problem, null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/karthi/arogara/proctor/backend && node --test test/problemAuthoring.test.mjs`
Expected: the three new tests FAIL (`problem_id` not validated/echoed; `problem` missing from the resume body).

- [ ] **Step 3: Write the implementation** — in `backend/src/handler.mjs`:

(a) In `adminSaveSettings`, right AFTER the contest-URL validation line
```javascript
  if (contestUrl && !isHttpUrl(contestUrl)) return badRequest("Contest URL must start with http:// or https://.");
```
add:
```javascript
  // S4: optional active-problem assignment ("" clears it). A non-empty id must
  // be servable to candidates RIGHT NOW (published bank doc or built-in seed),
  // so start/resume never advertise a dead problem id.
  const problemId = String(body.problem_id || "").trim();
  if (problemId && !(await getProblem(problemId))) {
    return badRequest("problem_id must reference a published problem");
  }
```
and inside the `item = {` object, right after the `contest_slug: contestSlugFromUrl(contestUrl),` line, add:
```javascript
    problem_id: problemId,
```
> If S2/S3 already added fields (e.g. `rooms`, `room_gate_enabled`) to this function, add `problem_id` ALONGSIDE them — never remove theirs.

(b) In `publicSettings` (~line 2426), right after the `contest_slug:` line, add:
```javascript
    problem_id: settings?.problem_id || "",
```

(c) Replace the `startResponse` function with an async version (the change is: `async` keyword + ONE new `problem:` field + the new helper below — if S2/S3 added fields to it, keep theirs and add only the `problem:` line + `async`):
```javascript
// Shared start/resume payload so the browser always gets the same shape whether
// it just started, replayed a token, or resumed after reload. S4: async because
// it resolves the assigned problem's candidate-facing view from the bank.
async function startResponse(session, settings) {
  return {
    session_id: session.session_id,
    status: session.status,
    hackerrank_username: session.hackerrank_username,
    name: session.name,
    room: session.room || "",
    contest_slug: session.contest_slug || "",
    storage_prefix: session.storage_prefix || buildStoragePrefix(session.contest_slug, session.username_norm, session.session_id),
    blocked_by_session_id: session.blocked_by_session_id || null,
    start_ip: session.start_ip || session.current_ip || "",
    contest_url: settings?.contest_url || "",
    problem: await activeProblemPublic(settings),
    upload_config: uploadConfig,
    heartbeat_interval_seconds: 15
  };
}

// The candidate-facing view of the assigned contest problem: statement, samples
// (non-secret — /api/exec/run echoes them anyway), limits, points. NEVER
// hiddenTests, never the lifecycle status. null when nothing is assigned or the
// assignment is no longer published (degrade to the link-flow fallback).
async function activeProblemPublic(settings) {
  const problemId = String(settings?.problem_id || "");
  if (!problemId) return null;
  const problem = await getProblem(problemId);
  if (!problem) return null;
  return {
    id: problem.id,
    title: problem.title,
    statement: problem.statement,
    languages: problem.languages || [],
    points: problem.points ?? 100,
    cpuTimeLimit: problem.cpuTimeLimit,
    memoryLimit: problem.memoryLimit,
    sampleTests: (problem.sampleTests || []).map((t) => ({ input: t.input, expected: t.expected }))
  };
}
```
> The three call sites (`return startResponse(replay, settings)`, `return startResponse(item, settings)`, `return startResponse(session, settings || {})`) need NO edits — they already `return` from async functions, so the promise resolves through the route's `await`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd /home/karthi/arogara/proctor/backend && node --test test/problemAuthoring.test.mjs`
Expected: PASS (9 tests).

- [ ] **Step 5: Full suite + commit** (phase2/phase2b start-session tests must stay green — they assert fields, not the whole body, so the added `problem: null` is inert; if any deep-equality assertion trips, fix the TEST expectation is NOT allowed — instead re-check your edit kept every existing field.)

```bash
cd /home/karthi/arogara/proctor/backend && npm test   # all pass
cd /home/karthi/arogara/proctor
git add backend/src/handler.mjs backend/test/problemAuthoring.test.mjs
git commit -m "feat(problems): active-problem assignment in settings + public problem in start/resume payload"
```

---

## Task 4: Exec endpoints read the bank + submit-time scoring

**Files:**
- Modify: `backend/src/handler.mjs` (`execSubmit` only — the `await getProblem` lines were already done in Task 1)
- Test: `backend/test/problemAuthoring.test.mjs` (append)

- [ ] **Step 1: Write the failing tests** — APPEND to `backend/test/problemAuthoring.test.mjs`:

```javascript
// ---- Task 4: exec-from-bank + scoring ----------------------------------------

function seedExecFixture() {
  const clients = freshClients();
  clients.firestore.collection("problems_sessions").doc("s1").set({
    session_id: "s1", status: "active", username_norm: "alice", storage_prefix: "sessions/alice/s1/"
  });
  return clients;
}

test("exec/run resolves the problem from the BANK: adapter sees the doc's sample tests + limits", async () => {
  seedExecFixture();
  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem() }));
  const seen = [];
  __setJudge0AdapterForTest({
    runBatch: async (items) => {
      seen.push(...items);
      return items.map(() => ({ status: "accepted", passed: true, stdout: "ba", stderr: "", compileOutput: "", timeSec: 0.01, memoryKb: 100 }));
    }
  });
  const res = await call(makeReq({ method: "POST", path: "/api/exec/run",
    body: { session_id: "s1", problem_id: "rev-str", language: "python", source_code: "print(input()[::-1])" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.results.length, 1);          // rev-str has ONE sample
  assert.equal(res.body.results[0].input, "ab\n");   // the BANK's sample, not the seed's
  assert.equal(seen.length, 1);
  assert.equal(seen[0].stdin, "ab\n");
  assert.equal(seen[0].cpuTimeLimit, 2);             // the BANK's limit
  assert.equal(seen[0].memoryLimit, 64000);
  __setJudge0AdapterForTest(null);
});

test("exec/run on a DRAFT problem -> 400 unknown problem_id (drafts are not executable)", async () => {
  seedExecFixture();
  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem({ status: "draft" }) }));
  __setJudge0AdapterForTest({ runBatch: async () => { throw new Error("must not run a draft"); } });
  const res = await call(makeReq({ method: "POST", path: "/api/exec/run",
    body: { session_id: "s1", problem_id: "rev-str", language: "python", source_code: "x" } }));
  assert.equal(res.statusCode, 400);
  __setJudge0AdapterForTest(null);
});

test("exec/run seed fallback: sum-two still works with an empty bank", async () => {
  seedExecFixture();
  __setJudge0AdapterForTest({
    runBatch: async (items) => items.map(() => ({ status: "accepted", passed: true, stdout: "5", stderr: "", compileOutput: "", timeSec: 0.01, memoryKb: 100 }))
  });
  const res = await call(makeReq({ method: "POST", path: "/api/exec/run",
    body: { session_id: "s1", problem_id: "sum-two", language: "python", source_code: "print(sum(map(int,input().split())))" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.results.length, 2); // the seed's two samples
  __setJudge0AdapterForTest(null);
});

test("exec/submit scores per_test: 3/4 hidden passed on an 80-point problem -> score 60, stored + returned", async () => {
  const { firestore } = seedExecFixture();
  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem() })); // 80 pts, per_test, 4 hidden
  __setJudge0AdapterForTest({
    runBatch: async (items) => items.map((_, i) => ({ status: i === 2 ? "wrong_answer" : "accepted", passed: i !== 2, stdout: "", stderr: "", compileOutput: "", timeSec: 0, memoryKb: 1 }))
  });
  const res = await call(makeReq({ method: "POST", path: "/api/exec/submit",
    body: { session_id: "s1", problem_id: "rev-str", language: "python", source_code: "x" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.verdict, "wrong_answer");
  assert.equal(res.body.passed_count, 3);
  assert.equal(res.body.score, 60);
  assert.equal(res.body.max_points, 80);
  const stored = [...firestore._collections.get("problems_submissions").values()][0];
  assert.equal(stored.score, 60);
  assert.equal(stored.max_points, 80);
  assert.equal(stored.scoring, "per_test");
  __setJudge0AdapterForTest(null);
});

test("exec/submit scores all_or_nothing: full sweep pays, partial pays zero", async () => {
  seedExecFixture();
  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem({ scoring: "all_or_nothing" }) }));
  __setJudge0AdapterForTest({
    runBatch: async (items) => items.map(() => ({ status: "accepted", passed: true, stdout: "", stderr: "", compileOutput: "", timeSec: 0, memoryKb: 1 }))
  });
  const sweep = await call(makeReq({ method: "POST", path: "/api/exec/submit",
    body: { session_id: "s1", problem_id: "rev-str", language: "python", source_code: "x" } }));
  assert.equal(sweep.body.score, 80);

  __setJudge0AdapterForTest({
    runBatch: async (items) => items.map((_, i) => ({ status: i === 0 ? "wrong_answer" : "accepted", passed: i !== 0, stdout: "", stderr: "", compileOutput: "", timeSec: 0, memoryKb: 1 }))
  });
  const partial = await call(makeReq({ method: "POST", path: "/api/exec/submit",
    body: { session_id: "s1", problem_id: "rev-str", language: "python", source_code: "x" } }));
  assert.equal(partial.body.score, 0);
  __setJudge0AdapterForTest(null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/karthi/arogara/proctor/backend && node --test test/problemAuthoring.test.mjs`
Expected: the run-from-bank tests PASS already (Task 1's `await` + Task 2's wiring did that); the two SCORING tests FAIL (`score`/`max_points` undefined). If the run-from-bank tests fail, debug Tasks 1–2 before proceeding.

- [ ] **Step 3: Write the implementation** — in `backend/src/handler.mjs`, function `execSubmit`:

After the verdict line
```javascript
  const verdict = passedCount === results.length ? "accepted" : "wrong_answer";
```
add:
```javascript
  // S4: submit-time scoring from the problem's points + scoring mode. Derived
  // from counts only, so returning it leaks nothing about hidden tests.
  const score = scoreSubmission(problem, passedCount, results.length);
  const maxPoints = problem.points ?? 100;
```
In the stored submission object, after the `tests,` line add:
```javascript
    score, max_points: maxPoints, scoring: problem.scoring || "per_test",
```
And change the return line to:
```javascript
  return { verdict, passed_count: passedCount, total: results.length, score, max_points: maxPoints, submission_id: submissionId };
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /home/karthi/arogara/proctor/backend && node --test test/problemAuthoring.test.mjs`
Expected: PASS (14 tests).

- [ ] **Step 5: Full suite + commit**

```bash
cd /home/karthi/arogara/proctor/backend && npm test   # ALL backend tests pass
cd /home/karthi/arogara/proctor
git add backend/src/handler.mjs backend/test/problemAuthoring.test.mjs
git commit -m "feat(problems): exec endpoints read the bank + submit-time scoring (per_test / all_or_nothing)"
```

---

## Task 5: Frontend types + pure problem-draft logic (vitest)

**Files:**
- Modify: `frontend/src/types.ts`
- Create: `frontend/src/problems/problemDraft.ts`, `frontend/src/problems/problemDraft.test.ts`

- [ ] **Step 1: Add the types** — append to `frontend/src/types.ts`:

```typescript
// ---- S4: problem bank (admin authoring) -------------------------------------
export type ProblemLanguage = "python" | "cpp" | "java" | "javascript";
export type ProblemTest = { input: string; expected: string };
export type ProblemScoring = "per_test" | "all_or_nothing";
export type ProblemStatus = "draft" | "published";

// Full authored problem (admin-only surfaces; includes hidden tests).
export type ProblemDoc = {
  id: string;
  title: string;
  statement: string;
  languages: ProblemLanguage[];
  cpuTimeLimit: number;
  memoryLimit: number;
  points: number;
  scoring: ProblemScoring;
  status: ProblemStatus;
  sampleTests: ProblemTest[];
  hiddenTests: ProblemTest[];
  created_at?: string;
  updated_at?: string;
};

// One row from GET /api/admin/problems (summaries only — no test contents).
export type ProblemSummary = {
  id: string;
  title: string;
  status: ProblemStatus;
  points: number;
  scoring: ProblemScoring;
  languages: string[];
  sample_count: number;
  hidden_count: number;
  updated_at: string;
};

// Candidate-facing view delivered inside the start/resume response. NEVER
// carries hidden tests.
export type PublicProblem = {
  id: string;
  title: string;
  statement: string;
  languages: ProblemLanguage[];
  points: number;
  cpuTimeLimit: number;
  memoryLimit: number;
  sampleTests: ProblemTest[];
};
```

Then three in-place edits to EXISTING types:
1. `SessionStartResponse` — after the `contest_url?: string;` line add:
```typescript
  problem?: PublicProblem | null;
```
2. `ProctorSettings` — after the `contest_url?: string;` line add:
```typescript
  problem_id?: string;
```
3. `SubmitResult` — replace the whole line with:
```typescript
export type SubmitResult = { verdict: "accepted" | "wrong_answer"; passed_count: number; total: number; score: number; max_points: number; submission_id: string };
```

- [ ] **Step 2: Write the failing vitest** — create `frontend/src/problems/problemDraft.test.ts`:

```typescript
// frontend/src/problems/problemDraft.test.ts
import { describe, expect, it } from "vitest";
import { draftFromDoc, draftToDoc, emptyProblemDraft, validateProblemDraft } from "./problemDraft";
import type { ProblemDoc } from "../types";

const DOC: ProblemDoc = {
  id: "rev-str", title: "Reverse", statement: "Reverse it.",
  languages: ["python"], cpuTimeLimit: 2, memoryLimit: 64000,
  points: 80, scoring: "per_test", status: "published",
  sampleTests: [{ input: "ab\n", expected: "ba" }],
  hiddenTests: [{ input: "xyz\n", expected: "zyx" }]
};

const validDraft = () => draftFromDoc(DOC);

describe("emptyProblemDraft", () => {
  it("starts with sane defaults and one empty test row each", () => {
    const d = emptyProblemDraft();
    expect(d.cpuTimeLimit).toBe("5");
    expect(d.memoryLimit).toBe("128000");
    expect(d.points).toBe("100");
    expect(d.status).toBe("draft");
    expect(d.sampleTests).toHaveLength(1);
    expect(d.hiddenTests).toHaveLength(1);
    expect(validateProblemDraft(d)).not.toBeNull(); // empty id/title/statement
  });
});

describe("validateProblemDraft (mirrors backend bounds)", () => {
  it("accepts a valid draft", () => expect(validateProblemDraft(validDraft())).toBeNull());
  it("rejects a bad id", () => expect(validateProblemDraft({ ...validDraft(), id: "Bad_ID" })).toMatch(/ID/));
  it("rejects a missing title", () => expect(validateProblemDraft({ ...validDraft(), title: " " })).toMatch(/Title/));
  it("rejects a missing statement", () => expect(validateProblemDraft({ ...validDraft(), statement: "" })).toMatch(/Statement/));
  it("rejects no languages", () => expect(validateProblemDraft({ ...validDraft(), languages: [] })).toMatch(/language/));
  it("rejects out-of-range cpu", () => expect(validateProblemDraft({ ...validDraft(), cpuTimeLimit: "30" })).toMatch(/CPU/));
  it("rejects non-integer memory", () => expect(validateProblemDraft({ ...validDraft(), memoryLimit: "64000.5" })).toMatch(/Memory/));
  it("rejects out-of-range points", () => expect(validateProblemDraft({ ...validDraft(), points: "5000" })).toMatch(/Points/));
  it("rejects empty hidden tests", () => expect(validateProblemDraft({ ...validDraft(), hiddenTests: [] })).toMatch(/Hidden/));
});

describe("draft <-> doc round trip", () => {
  it("doc -> draft -> doc preserves every field", () => {
    expect(draftToDoc(draftFromDoc(DOC))).toEqual(DOC);
  });
});
```

Run: `cd /home/karthi/arogara/proctor/frontend && npx vitest run src/problems/problemDraft.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write the implementation** — create `frontend/src/problems/problemDraft.ts`:

```typescript
// frontend/src/problems/problemDraft.ts
// Pure form-state logic for the admin problem editor: draft <-> doc mapping and
// client-side validation MIRRORING backend validateProblemInput bounds (the
// backend stays the authority). No React; vitest-covered.
import type { ProblemDoc, ProblemLanguage, ProblemScoring, ProblemStatus, ProblemTest } from "../types";

export const PROBLEM_LANGUAGES: ProblemLanguage[] = ["python", "cpp", "java", "javascript"];
export const PROBLEM_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Numeric fields are kept as STRINGS in the draft (raw <input> values) and
// parsed at validate/serialize time.
export type ProblemDraft = {
  id: string;
  title: string;
  statement: string;
  languages: ProblemLanguage[];
  cpuTimeLimit: string;
  memoryLimit: string;
  points: string;
  scoring: ProblemScoring;
  status: ProblemStatus;
  sampleTests: ProblemTest[];
  hiddenTests: ProblemTest[];
};

export function emptyProblemDraft(): ProblemDraft {
  return {
    id: "", title: "", statement: "",
    languages: [...PROBLEM_LANGUAGES],
    cpuTimeLimit: "5", memoryLimit: "128000", points: "100",
    scoring: "per_test", status: "draft",
    sampleTests: [{ input: "", expected: "" }],
    hiddenTests: [{ input: "", expected: "" }]
  };
}

export function draftFromDoc(doc: ProblemDoc): ProblemDraft {
  return {
    id: doc.id, title: doc.title, statement: doc.statement,
    languages: [...doc.languages],
    cpuTimeLimit: String(doc.cpuTimeLimit), memoryLimit: String(doc.memoryLimit), points: String(doc.points),
    scoring: doc.scoring, status: doc.status,
    sampleTests: doc.sampleTests.map((t) => ({ ...t })),
    hiddenTests: doc.hiddenTests.map((t) => ({ ...t }))
  };
}

function validateTests(tests: ProblemTest[], max: number, label: string): string | null {
  if (!tests.length) return `${label} tests: add at least one.`;
  if (tests.length > max) return `${label} tests: max ${max}.`;
  for (const [index, t] of tests.entries()) {
    if (t.input.length > 10000 || t.expected.length > 10000) {
      return `${label} test ${index + 1}: input/expected max 10000 characters.`;
    }
  }
  return null;
}

// First validation error, or null when the draft is saveable.
export function validateProblemDraft(d: ProblemDraft): string | null {
  if (!PROBLEM_ID_PATTERN.test(d.id)) return "ID must be 1-64 lowercase letters/digits/hyphens.";
  if (!d.title.trim()) return "Title is required.";
  if (d.title.trim().length > 200) return "Title: max 200 characters.";
  if (!d.statement.trim()) return "Statement is required.";
  if (d.statement.length > 20000) return "Statement: max 20000 characters.";
  if (!d.languages.length) return "Pick at least one language.";
  const cpu = Number(d.cpuTimeLimit);
  if (!Number.isFinite(cpu) || cpu < 0.5 || cpu > 15) return "CPU time limit must be 0.5-15 seconds.";
  const mem = Number(d.memoryLimit);
  if (!Number.isInteger(mem) || mem < 16000 || mem > 512000) return "Memory limit must be an integer 16000-512000 KB.";
  const points = Number(d.points);
  if (!Number.isInteger(points) || points < 0 || points > 1000) return "Points must be an integer 0-1000.";
  const sampleError = validateTests(d.sampleTests, 10, "Sample");
  if (sampleError) return sampleError;
  return validateTests(d.hiddenTests, 50, "Hidden");
}

// Serialize a VALIDATED draft into the API payload.
export function draftToDoc(d: ProblemDraft): ProblemDoc {
  return {
    id: d.id, title: d.title.trim(), statement: d.statement,
    languages: [...d.languages],
    cpuTimeLimit: Number(d.cpuTimeLimit), memoryLimit: Number(d.memoryLimit), points: Number(d.points),
    scoring: d.scoring, status: d.status,
    sampleTests: d.sampleTests.map((t) => ({ ...t })),
    hiddenTests: d.hiddenTests.map((t) => ({ ...t }))
  };
}
```

- [ ] **Step 4: Run to verify it passes + typecheck**

Run: `cd /home/karthi/arogara/proctor/frontend && npx vitest run src/problems/problemDraft.test.ts && npx tsc --noEmit`
Expected: vitest PASS (11 tests); tsc FAILS if `SubmitResult` consumers broke — the demo `execSubmit` in `api.ts` now misses `score`/`max_points`. Fix it NOW (it belongs with this type change): in `frontend/src/api.ts`, demo branch of `execSubmit`, replace the return with:
```typescript
    return { verdict: "accepted", passed_count: 4, total: 4, score: 100, max_points: 100, submission_id: "demo" };
```
Re-run `npx tsc --noEmit` → exit 0.

- [ ] **Step 5: Commit**

```bash
cd /home/karthi/arogara/proctor
git add frontend/src/types.ts frontend/src/problems/problemDraft.ts frontend/src/problems/problemDraft.test.ts frontend/src/api.ts
git commit -m "feat(problems): frontend types + pure problem-draft form logic (vitest)"
```

---

## Task 6: API client (problem CRUD + demo store + demo active problem)

**Files:**
- Modify: `frontend/src/api.ts`

- [ ] **Step 1: Implement** (no unit test — network/localStorage glue; covered by tsc + the Task 9 browser walkthrough):

(a) Extend the type import at the top of `api.ts` (the existing `import type { ... } from "./types";` block) with `ProblemDoc`, `ProblemSummary`, `PublicProblem`.

(b) In `demoSessionResponse`, after the `contest_url: contestUrl,` line add:
```typescript
    problem: demoActiveProblem(),
```

(c) In the DEMO branch of `saveProctorSettings`, inside the `next = {` object after the `contest_url: ...` line, add:
```typescript
      problem_id: settings.problem_id || "",
```

(d) Append this block at the END of `api.ts`:

```typescript
// ---- S4: problem bank (admin authoring) -------------------------------------

const demoProblemsKey = "aerele-proctor-demo-problems";

// Demo mirror of the backend's built-in seed (problems.mjs SEED_PROBLEMS).
const DEMO_SEED_PROBLEMS: ProblemDoc[] = [{
  id: "sum-two",
  title: "Sum of Two Numbers",
  statement: "Read two integers a and b on one line separated by a space. Print a + b.",
  languages: ["python", "cpp", "java", "javascript"],
  cpuTimeLimit: 5, memoryLimit: 128000, points: 100,
  scoring: "per_test", status: "published",
  sampleTests: [{ input: "2 3\n", expected: "5" }, { input: "10 20\n", expected: "30" }],
  hiddenTests: [
    { input: "0 0\n", expected: "0" }, { input: "-5 5\n", expected: "0" },
    { input: "1000000 1\n", expected: "1000001" }, { input: "-100 -200\n", expected: "-300" }
  ]
}];

function readDemoProblems(): ProblemDoc[] {
  try {
    const raw = window.localStorage.getItem(demoProblemsKey);
    return raw ? (JSON.parse(raw) as ProblemDoc[]) : [];
  } catch {
    return [];
  }
}

function writeDemoProblems(problems: ProblemDoc[]): void {
  window.localStorage.setItem(demoProblemsKey, JSON.stringify(problems));
}

// Demo id resolution: an authored demo problem wins; the seed answers only when
// no demo doc exists (mirrors the backend bank-shadows-seed rule).
function findDemoProblem(id: string): ProblemDoc | null {
  return readDemoProblems().find((p) => p.id === id)
    ?? DEMO_SEED_PROBLEMS.find((p) => p.id === id)
    ?? null;
}

// Candidate view of the demo active problem — published only, never hiddenTests.
function demoActiveProblem(): PublicProblem | null {
  const problemId = getDemoSettings()?.problem_id || "";
  if (!problemId) return null;
  const p = findDemoProblem(problemId);
  if (!p || p.status !== "published") return null;
  return {
    id: p.id, title: p.title, statement: p.statement, languages: p.languages,
    points: p.points, cpuTimeLimit: p.cpuTimeLimit, memoryLimit: p.memoryLimit,
    sampleTests: p.sampleTests
  };
}

export async function fetchProblems(password: string): Promise<ProblemSummary[]> {
  if (demoMode) {
    await wait(120);
    assertDemoAdmin(password);
    return readDemoProblems()
      .map((p) => ({
        id: p.id, title: p.title, status: p.status, points: p.points, scoring: p.scoring,
        languages: p.languages, sample_count: p.sampleTests.length, hidden_count: p.hiddenTests.length,
        updated_at: p.updated_at || ""
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  const response = await request<{ problems: ProblemSummary[] }>("/api/admin/problems", {
    method: "GET",
    headers: { "x-admin-password": password }
  });
  return response.problems;
}

export async function fetchProblemDetail(password: string, id: string): Promise<ProblemDoc> {
  if (demoMode) {
    await wait(120);
    assertDemoAdmin(password);
    const found = readDemoProblems().find((p) => p.id === id);
    if (!found) throw new Error("Problem not found");
    return found;
  }
  const response = await request<{ problem: ProblemDoc }>(`/api/admin/problem?id=${encodeURIComponent(id)}`, {
    method: "GET",
    headers: { "x-admin-password": password }
  });
  return response.problem;
}

export async function saveProblem(password: string, problem: ProblemDoc): Promise<ProblemDoc> {
  if (demoMode) {
    await wait(150);
    assertDemoAdmin(password);
    const now = new Date().toISOString();
    const all = readDemoProblems();
    const existing = all.find((p) => p.id === problem.id);
    const item: ProblemDoc = { ...problem, created_at: existing?.created_at || now, updated_at: now };
    writeDemoProblems([...all.filter((p) => p.id !== problem.id), item]);
    return item;
  }
  const response = await request<{ ok: boolean; problem: ProblemDoc }>("/api/admin/problems", {
    method: "POST",
    headers: { "x-admin-password": password },
    body: JSON.stringify(problem)
  });
  return response.problem;
}

export async function deleteProblem(password: string, id: string): Promise<void> {
  if (demoMode) {
    await wait(120);
    assertDemoAdmin(password);
    writeDemoProblems(readDemoProblems().filter((p) => p.id !== id));
    const settings = getDemoSettings();
    if (settings && settings.problem_id === id) {
      window.localStorage.setItem(demoSettingsKey, JSON.stringify({ ...settings, problem_id: "" }));
    }
    return;
  }
  await request<{ ok: boolean }>("/api/admin/problem-delete", {
    method: "POST",
    headers: { "x-admin-password": password },
    body: JSON.stringify({ id })
  });
}
```

> `demoActiveProblem` is referenced by `demoSessionResponse` ABOVE its definition — both are function declarations, hoisting makes that fine (same pattern as the existing file layout).

- [ ] **Step 2: Typecheck + commit**

```bash
cd /home/karthi/arogara/proctor/frontend && npx tsc --noEmit   # exit 0
cd /home/karthi/arogara/proctor
git add frontend/src/api.ts
git commit -m "feat(problems): api client for problem bank (+ demo-mode store, demo active problem)"
```

---

## Task 7: Admin "Problems" tab

**Files:**
- Create: `frontend/src/admin/ProblemBank.tsx`
- Modify: `frontend/src/App.tsx` (admin wiring only)

- [ ] **Step 1: Create `frontend/src/admin/ProblemBank.tsx`:**

```tsx
// frontend/src/admin/ProblemBank.tsx
// S4: admin question bank — list/author/publish problems and assign the active
// contest problem. Self-contained section (own state, password prop) so the
// App.tsx touchpoints stay minimal: import + tab + render branch.
import { ClipboardList, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { deleteProblem, fetchProblemDetail, fetchProblems, fetchProctorSettings, saveProblem, saveProctorSettings } from "../api";
import { draftFromDoc, draftToDoc, emptyProblemDraft, PROBLEM_LANGUAGES, validateProblemDraft, type ProblemDraft } from "../problems/problemDraft";
import type { ProblemSummary, ProblemTest } from "../types";

export function ProblemBankSection({ password }: { password: string }) {
  const [problems, setProblems] = useState<ProblemSummary[]>([]);
  const [activeProblemId, setActiveProblemId] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<ProblemDraft | null>(null);
  const [editingExisting, setEditingExisting] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const [list, settings] = await Promise.all([
        fetchProblems(password),
        fetchProctorSettings(password).catch(() => null)
      ]);
      setProblems(list);
      setActiveProblemId(settings?.problem_id || "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openEdit = async (id: string) => {
    setError("");
    setMessage("");
    try {
      setDraft(draftFromDoc(await fetchProblemDetail(password, id)));
      setEditingExisting(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const save = async () => {
    if (!draft) return;
    const invalid = validateProblemDraft(draft);
    if (invalid) {
      setError(invalid);
      return;
    }
    setSaving(true);
    setError("");
    try {
      await saveProblem(password, draftToDoc(draft));
      setMessage(`Saved "${draft.id}".`);
      setDraft(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm(`Delete problem "${id}"? This cannot be undone.`)) return;
    setError("");
    try {
      await deleteProblem(password, id);
      setMessage(`Deleted "${id}".`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  // Assign/clear the active contest problem by patching the EXISTING settings
  // doc (problem_id rides next to contest_url). Requires the schedule gate to
  // be configured first — surfaced as a plain error message if it is not.
  const setActive = async (id: string) => {
    setError("");
    try {
      const settings = await fetchProctorSettings(password);
      if (!settings.start_at || !settings.end_at) {
        setError("Configure the proctoring schedule (Settings tab) before assigning a problem.");
        return;
      }
      await saveProctorSettings(password, { ...settings, problem_id: id });
      setActiveProblemId(id);
      setMessage(id ? `"${id}" is now the active contest problem.` : "Active problem cleared — candidates fall back to the contest link.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <section className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <ClipboardList size={20} />
          <div>
            <h1 className="text-2xl font-semibold">Problem bank</h1>
            <p className="mt-1 text-sm text-muted">
              Author problems with sample + hidden tests, limits, and scoring. Publish, then set one as the active contest problem — candidates get it inside the proctored workspace.
            </p>
          </div>
        </div>
        {!draft ? (
          <div className="flex gap-2">
            <button className="focus-ring inline-flex h-10 items-center gap-2 rounded-md border border-line px-4 text-sm font-medium" onClick={() => void load()} disabled={loading}>
              <RefreshCw size={16} /> Reload
            </button>
            <button className="focus-ring inline-flex h-10 items-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white" onClick={() => { setDraft(emptyProblemDraft()); setEditingExisting(false); setMessage(""); }}>
              <Plus size={16} /> New problem
            </button>
          </div>
        ) : null}
      </div>

      {error ? <div className="mb-4 rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{error}</div> : null}
      {message ? <div className="mb-4 rounded-lg border border-accent/30 bg-accent/10 p-3 text-sm text-accent">{message}</div> : null}

      {draft ? (
        <ProblemEditor
          draft={draft}
          editingExisting={editingExisting}
          saving={saving}
          onChange={setDraft}
          onSave={() => void save()}
          onCancel={() => setDraft(null)}
        />
      ) : (
        <div className="space-y-2">
          {loading ? <p className="text-sm text-muted">Loading…</p> : null}
          {!loading && !problems.length ? (
            <p className="text-sm text-muted">No problems yet. The built-in seed "sum-two" remains available until you author one (assign it by setting the active problem ID to sum-two in Settings).</p>
          ) : null}
          {problems.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-white p-3 text-sm">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-semibold">{p.id}</span>
                  <span className="text-muted">{p.title}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${p.status === "published" ? "bg-accent/10 text-accent" : "bg-ink/10 text-ink"}`}>{p.status}</span>
                  {p.id === activeProblemId ? <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700">Active</span> : null}
                </div>
                <div className="mt-1 text-xs text-muted">
                  {p.points} pts · {p.scoring} · {p.languages.join(", ")} · {p.sample_count} sample / {p.hidden_count} hidden
                  {p.updated_at ? ` · updated ${new Date(p.updated_at).toLocaleString()}` : ""}
                </div>
              </div>
              <div className="flex gap-2">
                {p.id === activeProblemId ? (
                  <button className="focus-ring rounded-md border border-line px-3 py-1.5 text-xs font-medium" onClick={() => void setActive("")}>Clear active</button>
                ) : p.status === "published" ? (
                  <button className="focus-ring rounded-md border border-line px-3 py-1.5 text-xs font-medium" onClick={() => void setActive(p.id)}>Set active</button>
                ) : null}
                <button className="focus-ring rounded-md border border-line px-3 py-1.5 text-xs font-medium" onClick={() => void openEdit(p.id)}>Edit</button>
                <button className="focus-ring inline-flex items-center gap-1 rounded-md border border-danger/40 px-3 py-1.5 text-xs font-medium text-danger" onClick={() => void remove(p.id)}>
                  <Trash2 size={12} /> Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ProblemEditor({ draft, editingExisting, saving, onChange, onSave, onCancel }: {
  draft: ProblemDraft;
  editingExisting: boolean;
  saving: boolean;
  onChange: (d: ProblemDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = (patch: Partial<ProblemDraft>) => onChange({ ...draft, ...patch });
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-3">
        <label className="block">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">ID (slug — locked after create)</span>
          <input className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-3 font-mono text-sm disabled:bg-neutral-100" value={draft.id} disabled={editingExisting} onChange={(e) => set({ id: e.target.value })} />
        </label>
        <label className="block md:col-span-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Title</span>
          <input className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-3 text-sm" value={draft.title} onChange={(e) => set({ title: e.target.value })} />
        </label>
      </div>
      <label className="block">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">Statement (plain text, shown pre-wrapped)</span>
        <textarea className="focus-ring mt-1 w-full rounded-md border border-line bg-white px-3 py-2 text-sm" rows={8} value={draft.statement} onChange={(e) => set({ statement: e.target.value })} />
      </label>
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Languages</span>
          <div className="mt-1 flex gap-3">
            {PROBLEM_LANGUAGES.map((lang) => (
              <label key={lang} className="inline-flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  checked={draft.languages.includes(lang)}
                  onChange={(e) => set({ languages: e.target.checked ? [...draft.languages, lang] : draft.languages.filter((l) => l !== lang) })}
                />
                {lang}
              </label>
            ))}
          </div>
        </div>
        <label className="block w-32">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">CPU limit (s)</span>
          <input className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-3 text-sm" value={draft.cpuTimeLimit} onChange={(e) => set({ cpuTimeLimit: e.target.value })} />
        </label>
        <label className="block w-36">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Memory (KB)</span>
          <input className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-3 text-sm" value={draft.memoryLimit} onChange={(e) => set({ memoryLimit: e.target.value })} />
        </label>
        <label className="block w-28">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Points</span>
          <input className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-3 text-sm" value={draft.points} onChange={(e) => set({ points: e.target.value })} />
        </label>
        <label className="block w-44">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Scoring</span>
          <select className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-2 text-sm" value={draft.scoring} onChange={(e) => set({ scoring: e.target.value as ProblemDraft["scoring"] })}>
            <option value="per_test">Per test (proportional)</option>
            <option value="all_or_nothing">All or nothing</option>
          </select>
        </label>
        <label className="block w-36">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Status</span>
          <select className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-2 text-sm" value={draft.status} onChange={(e) => set({ status: e.target.value as ProblemDraft["status"] })}>
            <option value="draft">Draft (hidden from candidates)</option>
            <option value="published">Published</option>
          </select>
        </label>
      </div>
      <TestsEditor label="Sample tests (shown to candidates, echoed by Run)" tests={draft.sampleTests} max={10} onChange={(tests) => set({ sampleTests: tests })} />
      <TestsEditor label="Hidden tests (graded on Submit — never shown)" tests={draft.hiddenTests} max={50} onChange={(tests) => set({ hiddenTests: tests })} />
      <div className="flex gap-3">
        <button className="focus-ring inline-flex h-10 items-center justify-center rounded-md bg-ink px-4 text-sm font-medium text-white disabled:opacity-50" onClick={onSave} disabled={saving}>
          {saving ? "Saving…" : "Save problem"}
        </button>
        <button className="focus-ring inline-flex h-10 items-center justify-center rounded-md border border-line px-4 text-sm font-medium" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function TestsEditor({ label, tests, max, onChange }: {
  label: string;
  tests: ProblemTest[];
  max: number;
  onChange: (tests: ProblemTest[]) => void;
}) {
  const setTest = (index: number, patch: Partial<ProblemTest>) =>
    onChange(tests.map((t, i) => (i === index ? { ...t, ...patch } : t)));
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
        <button
          className="focus-ring rounded-md border border-line px-3 py-1 text-xs font-medium disabled:opacity-50"
          onClick={() => onChange([...tests, { input: "", expected: "" }])}
          disabled={tests.length >= max}
        >
          + Add test
        </button>
      </div>
      <div className="space-y-2">
        {tests.map((t, index) => (
          <div key={index} className="flex items-start gap-2">
            <span className="mt-2 w-6 text-right font-mono text-xs text-muted">{index + 1}.</span>
            <textarea className="focus-ring w-full rounded-md border border-line bg-white px-2 py-1 font-mono text-xs" rows={2} placeholder="stdin" value={t.input} onChange={(e) => setTest(index, { input: e.target.value })} />
            <textarea className="focus-ring w-full rounded-md border border-line bg-white px-2 py-1 font-mono text-xs" rows={2} placeholder="expected stdout" value={t.expected} onChange={(e) => setTest(index, { expected: e.target.value })} />
            <button className="focus-ring mt-1 rounded-md border border-danger/40 px-2 py-1 text-xs text-danger" onClick={() => onChange(tests.filter((_, i) => i !== index))} title="Remove test">
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire it into `App.tsx` (4 small edits):**

1. Add the import next to the `RecordingReview` import:
```tsx
import { ProblemBankSection } from "./admin/ProblemBank";
```
2. Extend the `AdminView` union (line ~1111):
```tsx
type AdminView = "stats" | "alerts" | "sessions" | "review" | "recordings" | "problems" | "settings";
```
3. Add the tab in the admin nav, between the Recordings and Settings tabs:
```tsx
        <AdminTab active={view === "problems"} onClick={() => setView("problems")} icon={<ClipboardList size={16} />} label="Problems" />
```
(`ClipboardList` is already imported at the top of App.tsx.)
4. Add the render branch next to the `{view === "settings" ? (` branch:
```tsx
      {view === "problems" ? <ProblemBankSection password={password} /> : null}
```
5. In the Settings tab's "Proctoring gate" grid, after the `Contest URL` `Field`, add:
```tsx
          <Field label="Active problem ID" value={settings.problem_id ?? ""} onChange={(value) => setSettings({ ...settings, problem_id: value })} />
```
(The Problems tab's Set-active buttons are the convenient path; this field is the visibility/manual override and saves with the same "Save gate" button.)

- [ ] **Step 3: Typecheck + build + commit**

```bash
cd /home/karthi/arogara/proctor/frontend && npx tsc --noEmit && npm run build   # both clean
cd /home/karthi/arogara/proctor
git add frontend/src/admin/ProblemBank.tsx frontend/src/App.tsx
git commit -m "feat(problems): admin Problems tab — author/publish/delete + active-problem assignment"
```

---

## Task 8: Server-driven candidate problem (replaces SLICE1_PROBLEM)

**Files:**
- Modify: `frontend/src/App.tsx` (student side)
- Modify: `frontend/src/coding/CodingWorkspace.tsx`

- [ ] **Step 1: Delete the placeholder constant** — in `App.tsx`, remove the whole `Slice1Problem` type + `SLICE1_PROBLEM` const block (lines ~9–24, the block starting `// Slice 1: the single config-driven problem...` and ending with the `};` after `languages: [...]`). Replace it with:
```tsx
// S4: the contest problem is SERVER-DRIVEN — it arrives as `problem` inside the
// start/resume response (admin assigns settings.problem_id → public view; see
// docs/superpowers/specs/2026-06-09-s4-problem-authoring-design.md). No problem
// assigned → the legacy contest_url link flow renders instead.
```

- [ ] **Step 2: Derive the problem from the session config** — inside `StudentApp`, immediately BEFORE the `const recorderRef = useRef<ReturnType<typeof createProctorRecorder> | null>(null);` line, add:
```tsx
  const activeProblem = sessionConfig?.problem ?? null;
```

- [ ] **Step 3: Replace every `SLICE1_PROBLEM` usage in `StudentApp`** (run `grep -n "SLICE1_PROBLEM" frontend/src/App.tsx` and fix ALL hits; current sites and their replacements):
1. Header `<h1>` ternary: `SLICE1_PROBLEM ? "Proctored coding test" : "HackerRank companion recording"` → `activeProblem ? "Proctored coding test" : "HackerRank companion recording"`.
2. Header `<p>` ternary: `: SLICE1_PROBLEM` → `: activeProblem`.
3. Legacy link gate: `{!SLICE1_PROBLEM && status === "recording" && ...}` → `{!activeProblem && status === "recording" && ...}` (and update its comment to say "no SERVER problem assigned").
4. Workspace render:
```tsx
      {/* S4: own coding workspace (Monaco + Run/Submit), live only while
          recording so every editor event is tied to an actively recorded
          session. The problem comes from the server (settings.problem_id);
          when assigned it REPLACES the contest_url Start-test surface. */}
      {activeProblem && sessionId && status === "recording" && (
        <div className="mt-5">
          <CodingWorkspace sessionId={sessionId} problem={activeProblem} />
        </div>
      )}
```
5. `StudentStepBanner`: change its signature to
```tsx
function StudentStepBanner({ gate, status, hasProblem = false }: { gate: StudentGate; status: SessionStatus; hasProblem?: boolean }) {
```
and the hint line `hint = SLICE1_PROBLEM ? ... : ...` → `hint = hasProblem ? ... : ...`. Update ALL FOUR call sites (`grep -n "<StudentStepBanner" frontend/src/App.tsx`) to pass `hasProblem={Boolean(sessionConfig?.problem)}`.

After this step `grep -c "SLICE1_PROBLEM" frontend/src/App.tsx` must print `0`.

- [ ] **Step 4: CodingWorkspace — generic starters + samples + score** — in `frontend/src/coding/CodingWorkspace.tsx`:

1. Replace the `STARTERS` const (its current values literally solve sum-two — wrong for authored problems) with:
```tsx
// Generic read-stdin/print-stdout scaffolds. Problem-specific starter code is
// deliberately NOT a thing yet (see the S4 spec, OUT of scope).
const STARTERS: Record<string, string> = {
  python: "# Read from standard input, print the answer to standard output.\n",
  cpp: "#include <bits/stdc++.h>\nusing namespace std;\nint main() {\n    // Read from stdin, print the answer to stdout.\n    return 0;\n}\n",
  java: "import java.util.*;\npublic class Main {\n    public static void main(String[] args) {\n        // Read from System.in, print the answer to System.out.\n    }\n}\n",
  javascript: "// Read from stdin, print the answer to stdout.\nconst input = require(\"fs\").readFileSync(0, \"utf8\");\n"
};
```
2. Extend the `problem` prop type (add the optional sample tests — `PublicProblem` is structurally compatible):
```tsx
  problem: {
    id: string; title: string; statement: string;
    languages: readonly ("python"|"cpp"|"java"|"javascript")[];
    sampleTests?: readonly { input: string; expected: string }[];
  };
```
3. In the problem-statement `<section>`, after the statement `<p>`, add:
```tsx
        {problem.sampleTests?.length ? (
          <div className="mt-4 space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted">Sample tests</div>
            {problem.sampleTests.map((t, i) => (
              <div key={i} className="rounded-md border border-line bg-white p-2 text-xs">
                <div className="font-medium text-muted">Input</div>
                <pre className="whitespace-pre-wrap font-mono">{t.input}</pre>
                <div className="mt-1 font-medium text-muted">Expected output</div>
                <pre className="whitespace-pre-wrap font-mono">{t.expected}</pre>
              </div>
            ))}
          </div>
        ) : null}
```
4. In the submit-verdict box, extend the line to show the score:
```tsx
            Verdict: <span className="font-semibold">{submit.verdict}</span> — {submit.passed_count}/{submit.total} hidden tests passed. Score: {submit.score}/{submit.max_points}.
```

- [ ] **Step 5: Typecheck + tests + build + commit**

```bash
cd /home/karthi/arogara/proctor/frontend && npx tsc --noEmit && npx vitest run && npm run build   # all clean
cd /home/karthi/arogara/proctor
git add frontend/src/App.tsx frontend/src/coding/CodingWorkspace.tsx
git commit -m "feat(problems): server-driven candidate problem replaces SLICE1_PROBLEM; generic starters, samples, score display"
```

---

## Task 9: End-to-end verification (suites + demo-mode browser walkthrough)

**Files:** none (verification only; fixes get their own focused commits).

- [ ] **Step 1: Full suites green**

```bash
cd /home/karthi/arogara/proctor/backend && npm test          # every backend file passes
cd /home/karthi/arogara/proctor/frontend && npx vitest run   # editorEvents + problemDraft (+ any S2/S3 suites)
cd /home/karthi/arogara/proctor/frontend && npm run build    # clean build
```

- [ ] **Step 2: Demo-mode browser walkthrough** (no GCP, no Judge0 key) — start the dev server:

```bash
cd /home/karthi/arogara/proctor/frontend && VITE_DEMO_MODE=true VITE_ADMIN_PASSWORD=dev npm run dev
```

Drive the `:9222` Chromium (chrome-devtools MCP, as in the Slice 1 / admin-polish verifications) through the FULL loop:
1. `/admin` → unlock with `dev` → **Settings**: set a window spanning now (start = today 00:00, end = tomorrow) → Save gate.
2. **Problems** tab → New problem → id `reverse-line`, title `Reverse the Line`, statement `Read one line and print it reversed.`, languages python+javascript, CPU 2, memory 64000, points 50, scoring per_test, status **published**, sample `hello` → `olleh`, two hidden tests (`abc`→`cba`, `xy`→`yx`) → Save → row appears with badges → **Set active** → "Active" badge shows.
3. Student page `/` → register (any details + consent) → start → screen-share prompt (demo still records) → confirm the workspace shows **Reverse the Line**, the statement, the SAMPLE TESTS block, and the generic starter (NOT the sum-two solution).
4. Run → demo sample results render; Submit → verdict box shows verdict + counts + `Score: 100/100` (demo stub values).
5. Problems tab → edit the problem → status draft → Save → reload the student page → resume → workspace gone, contest-link fallback shown (publish it back afterwards if continuing).
6. Screenshot the Problems tab and the student workspace; verify them YOURSELF before reporting (validate-before-send).

- [ ] **Step 3: Real-backend smoke (ONLY if the night's local-backend harness is already running for another item — do not stand up GCP for this):** author a problem via `curl -X POST .../api/admin/problems -H "x-admin-password: ..."`, set `problem_id` via the settings endpoint, hit `/api/session/resume` for an active session and confirm `problem` appears without `hiddenTests`. Otherwise mark this as deferred-to-morning in the night log.

- [ ] **Step 4: Record evidence** in `night-run/MORNING-NOTES.md` §1 (built/tested/committed + screenshots) per the run guardrails. Do NOT push.

---

## Self-review (against the S4 spec)

- **Scope coverage:** question bank in Firestore ✔ (T1–T2); sample/hidden tests + limits ✔ (validation, T1); scoring ✔ (`scoreSubmission`, T4); admin authoring UI ✔ (T7); replaces the Slice 1 placeholder ✔ (T8 deletes `SLICE1_PROBLEM`; seed remains only as zero-config fallback); `getProblem(id)` stays the exec read interface ✔ (async, two `await`s in T1 — endpoint contracts unchanged); hidden tests never candidate-visible ✔ (public view + summaries + §9 lock tests).
- **Placeholder scan:** every step carries complete code; the only copy-from instruction (fakes) embeds the full text anyway.
- **Green-commit discipline:** Task 1 folds the `await` + exec-test fix into its commit so no commit leaves the suite red.
- **Parallel-safety:** all `handler.mjs`/`App.tsx`/`api.ts` edits are anchored to quoted landmark lines with "add alongside, never remove" instructions; admin UI is a new file.
- **Known judgment calls for the morning:** score returned to candidates (derived from counts — judged §9-safe); `problem_id` lives on the settings doc rather than a "published == active" rule; generic starters replace the sum-two ones inside `CodingWorkspace.tsx` (a Slice 1 file — edited because its starters ARE part of the placeholder being replaced).

## Execution options
1. **Subagent-driven (recommended)** — fresh subagent per task, review between tasks.
2. **Inline execution** — batch with checkpoints.
