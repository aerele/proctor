# S4 — Problem Authoring (question bank + tests + limits + scoring) — Design

**Status:** READY (night-run stretch item 4; scope locked in `night-run/MORNING-NOTES.md`).
**Author:** Ram. **Date:** 2026-06-09.
**Parent design:** `docs/superpowers/specs/2026-06-09-own-editor-design.md` (§3 Slice 2, §8 backlog item 4).
**Paired plan:** `docs/superpowers/plans/2026-06-09-s4-problem-authoring.md`.

---

## 1. Vision

Slice 1 ships one hardcoded problem (`sum-two`) as backend config. S4 turns that into a **question bank**: problems live in Firestore, authored through a new **Problems tab** in the existing admin console — statement, allowed languages, sample tests, hidden tests, time/memory limits, points + scoring mode, and a draft/published lifecycle. The admin assigns one published problem as the **active contest problem** (a `problem_id` on the existing settings doc, exactly like `contest_url`); candidates then receive that problem from the server instead of the hardcoded frontend constant. `getProblem(id)` in `backend/src/problems.mjs` **stays the read interface** for the exec endpoints — it becomes async and Firestore-backed, with the built-in seed problem kept as a fallback so dev/demo/tests keep working with zero Firestore docs.

## 2. Locked decisions

1. **Storage:** problems in a Firestore collection (`PROBLEMS_COLLECTION`, default `proctor_problems`), doc id = problem id (slug). Low volume, queryable, mirrors `proctor_submissions`.
2. **Read interface preserved:** exec endpoints keep calling `getProblem(id)`; it becomes `async` (the only handler-side change at the call sites is adding `await`). Field names inside a problem doc stay **exactly the Slice 1 camelCase shape** (`sampleTests`, `hiddenTests`, `cpuTimeLimit`, `memoryLimit`, `languages`, `statement`, `title`, `id`) so `execRun`/`execSubmit` logic is untouched.
3. **Bank doc owns its id:** if a Firestore doc exists for an id, it wins completely — published → served, draft → treated as unknown (hides any same-id seed). Only when **no** doc exists does the built-in seed (`sum-two`, marked `status: "published"`) answer. This is the "replaces the Slice 1 placeholder" path: author a `sum-two` doc and the seed is shadowed; assign a different problem and the seed is simply unused.
4. **Draft/published lifecycle:** candidates (exec endpoints + start/resume payload) can only ever see **published** problems. Drafts are admin-only. The active-problem assignment validates published-ness at save time.
5. **Active problem = settings field:** the existing settings doc (`SETTINGS_COLLECTION/active`) gains `problem_id`. One problem per contest tonight (the Slice 1 workspace is single-problem). The candidate receives the **public view** of it inside the existing start/resume response (`startResponse` gains a `problem` field), so no new candidate-facing endpoint and no client polling.
6. **Public view never leaks hidden tests:** `{id, title, statement, languages, points, cpuTimeLimit, memoryLimit, sampleTests}` only. Hidden tests exist solely in the Firestore doc and the admin GET endpoint (`x-admin-password` gated). Samples are explicitly non-secret (already echoed by `/api/exec/run`).
7. **Scoring:** per-problem `points` (integer, default 100) + `scoring` mode: `"per_test"` (proportional: `floor(points * passed/total)`) or `"all_or_nothing"`. Score is computed at submit time by a pure `scoreSubmission(problem, passedCount, total)`, stored on the submission doc (`score`, `max_points`, `scoring`), and returned to the candidate alongside the §9-locked verdict+counts (a score is derived from counts — it leaks nothing).
8. **Frontend problem becomes server-driven:** the `SLICE1_PROBLEM` constant in `App.tsx` is deleted; `CodingWorkspace` renders from `sessionConfig.problem`. The legacy `contest_url` link flow remains the fallback when no problem is assigned (exactly the fallback the Slice 1 comments promised).
9. **Starter code goes generic:** the Slice 1 starters literally solve `sum-two`; with authored problems they would pre-fill a wrong solution. Replace with neutral read-stdin/print-stdout scaffolds. Per-problem starter code authoring is OUT (see §8).
10. **Admin UI in its own file:** `frontend/src/admin/ProblemBank.tsx` (self-contained section, password prop, own state) to keep the 3k-line `App.tsx` touchpoints minimal (import + tab + render branch) — parallel-build safe.

## 3. Data model

### 3.1 Problem doc (`PROBLEMS_COLLECTION`, doc id = `id`)

```jsonc
{
  "id": "reverse-words",            // ^[a-z0-9][a-z0-9-]{0,63}$  (doc id == field)
  "title": "Reverse the Words",     // 1..200 chars
  "statement": "…",                 // 1..20000 chars, plain text (rendered pre-wrap)
  "languages": ["python", "cpp"],   // non-empty subset of python|cpp|java|javascript, de-duped
  "cpuTimeLimit": 5,                // seconds, 0.5..15 (Judge0 CE max, design §11)
  "memoryLimit": 128000,            // KB, integer 16000..512000 (Judge0 CE max)
  "points": 100,                    // integer 0..1000, default 100
  "scoring": "per_test",            // "per_test" | "all_or_nothing", default "per_test"
  "status": "draft",                // "draft" | "published", default "draft"
  "sampleTests": [ { "input": "a b\n", "expected": "b a" } ],   // 1..10, strings ≤ 10000 chars each
  "hiddenTests": [ { "input": "…", "expected": "…" } ],          // 1..50 (adapter chunks ≤20/batch)
  "created_at": "2026-06-10T01:00:00.000Z",   // server-set, preserved on update
  "updated_at": "2026-06-10T01:00:00.000Z"    // server-set on every save
}
```

Validation is one pure function, `validateProblemInput(body)` in `problems.mjs` → `{ok:true, problem}` (a **newly built, allow-listed** object — client input is never spread into storage, matching the editor-events hardening) or `{ok:false, error}`. `input` may be empty (no-stdin problems); `expected` may be empty (must-print-nothing tests); both must be **present** on every test.

### 3.2 Settings doc additions
- `problem_id: string` (`""` = none). Saved by `adminSaveSettings`, echoed by `publicSettings`. Non-empty values must pass `await getProblem(problem_id)` (i.e. published bank doc or built-in seed) at save time.

### 3.3 Submission doc additions (`SUBMISSIONS_COLLECTION`)
- `score` (int), `max_points` (int), `scoring` (mode used) — alongside the existing fields.

## 4. API surface

### Admin (all `requireAdmin` via `x-admin-password`)
| Route | Method | Body / query | Returns |
|---|---|---|---|
| `/api/admin/problems` | GET | — | `{problems: [{id,title,status,points,scoring,languages,sample_count,hidden_count,updated_at}]}` sorted by id (summaries only — no test contents) |
| `/api/admin/problem` | GET | `?id=` | `{problem: <full doc incl. hiddenTests>}`; 404 unknown; 400 invalid id |
| `/api/admin/problems` | POST | full problem fields | validate → upsert (create sets `created_at`; update preserves it) → `{ok, problem}`; 400 with the specific validation error |
| `/api/admin/problem-delete` | POST | `{id}` | delete (idempotent); if it was the active `problem_id`, clears the assignment; `{ok:true}` |

### Candidate-facing (existing endpoints, extended)
- `POST /api/session/start` + `/api/session/resume` → response gains `problem: PublicProblem | null` (via `startResponse`, shared by both).
- `POST /api/exec/run` / `/api/exec/submit` → unchanged contracts; `problem_id` now resolves through the Firestore-backed `getProblem` (draft/unknown → existing 400 `unknown problem_id`). Submit response gains `score` + `max_points`.

### `problems.mjs` module interface
- `configureProblemStore({getFirestore, collection})` — called once by `handler.mjs` at module load with `() => firestore` (a **getter**, so `__setClientsForTest` fakes propagate to problem reads).
- `getProblem(id)` → async; invalid-shape id → `null` (never reaches a Firestore doc path); bank doc wins; published-only; seed fallback (via `Object.hasOwn`, never prototype keys).
- `validateProblemInput(body)`, `scoreSubmission(problem, passedCount, total)`, `isValidProblemId(id)` — pure.
- `LANGUAGE_IDS` unchanged.

## 5. UI behavior

### Admin — new "Problems" tab (`frontend/src/admin/ProblemBank.tsx`)
- **List:** table of summaries (id, title, status badge, points, scoring, languages, #samples, #hidden, updated) + Reload + "New problem". The active problem row shows an **Active** badge; published rows get "Set active", the active row gets "Clear active" (both patch `problem_id` via the existing `fetchProctorSettings`/`saveProctorSettings` — requires the schedule gate to already be configured, with a clear error otherwise).
- **Editor:** id (locked when editing an existing problem), title, statement textarea, language checkboxes, CPU/memory/points number fields, scoring + status selects, and two test-list editors (input/expected textarea pairs, add/remove). Client-side validation (`validateProblemDraft`, mirroring backend rules) gives instant feedback; the backend remains the authority. Save → upsert → back to list. Delete (from list) behind `window.confirm`.
- **Settings tab:** one extra `Field` "Active problem ID" beside Contest URL (visibility + manual override; the Problems tab buttons are the convenient path).

### Candidate (`StudentApp`)
- `applyServerStatus` already stores the start/resume response in `sessionConfig`; the workspace renders when `sessionConfig.problem` is set and recording is live — identical gating to Slice 1, minus the constant.
- Header copy / step-banner hints keyed off `Boolean(sessionConfig?.problem)` (`StudentStepBanner` gains a `hasProblem` prop).
- `CodingWorkspace` problem pane additionally renders the sample tests (input → expected, monospace) since authored statements and samples are now separate fields; verdict box shows `Score: X/Y`.
- No problem assigned → legacy HackerRank `contest_url` link flow, unchanged.

### Demo mode (`VITE_DEMO_MODE=true`)
- Problems CRUD against `localStorage` (`aerele-proctor-demo-problems`); demo settings carry `problem_id`; `demoSessionResponse` resolves the demo active problem (published-only, with a built-in demo `sum-two` seed) so the full author → assign → solve loop is browser-testable offline. Demo `execSubmit` returns `score`/`max_points` to match the new shape.

## 6. Error handling
- All validation failures are 400s with the specific message from `validateProblemInput` (existing `badRequest`/`httpError` plumbing).
- Admin GET of an unknown problem → 404; invalid id shapes → 400 **before** any Firestore doc path is built (no path-injection via doc ids; same reasoning as the submission-id hardening in `aea48b2`).
- Candidate paths degrade to the Slice 1 behavior: unknown/draft/unassigned problem → exec 400 `unknown problem_id` / `problem: null` in start payload → link-flow fallback.
- Firestore failures surface as 500 through the existing top-level catch (no new retry machinery).
- Deleting the active problem clears the assignment in the same request (candidates fall back to the link flow rather than seeing a dead problem id).

## 7. Testing
- **Backend pure** (`backend/test/problems.test.mjs`, no handler import — the `judge0Adapter.test.mjs` precedent): `validateProblemInput` accept/reject matrix, `scoreSubmission` both modes + edge cases, `isValidProblemId`, `getProblem` store-less seed fallback + store-backed (published served / draft hidden / bank-overrides-seed / invalid id short-circuits).
- **Backend handler** (`backend/test/problemAuthoring.test.mjs`, `?problems` cache-buster, env-before-import, pasted fakes, `__setClientsForTest` + `__setJudge0AdapterForTest`): admin CRUD + auth + validation 400s; settings `problem_id` validation; resume payload carries the public problem and **never** `hiddenTests`; exec run/submit against a Firestore problem (stub adapter sees the doc's tests); draft → 400; seed fallback; submit stores + returns score for both scoring modes.
- **Existing-test update:** the two synchronous `getProblem` shape tests in `backend/test/exec.test.mjs` become `await`-based (interface change), seeding fakes first.
- **Frontend:** vitest on the pure `problemDraft.ts`; `tsc --noEmit` + `vite build` for UI; demo-mode browser walkthrough (author → publish → set active → student solves) via the `:9222` MCP per the night-run done-bar.

## 8. OUT of scope (do not build tonight)
- Multi-problem contests / problem sets / problem navigation + leaderboard (Slice 3 orchestration).
- Per-problem starter-code authoring (generic scaffolds only); markdown/rich-text statement rendering (plain text, pre-wrap).
- Per-test-case weights or custom checkers/validators (exact trimmed-output match stays).
- Problem import/export, versioning, edit-conflict handling (last-write-wins), authoring audit log.
- Any Judge0 changes (adapter, backpressure, self-host) — untouched.
- Migrating the built-in seed out of code (it stays as the zero-config fallback).
- An in-memory `getProblem` cache (read volume tonight is trivial; noted as a future optimization if exam-scale Firestore reads ever matter).

## 9. Guardrails (do not revisit)
- Hidden tests never appear in any candidate-facing response (Slice 1 §9 lock extends to the bank).
- Judge0 key stays server-side; exec endpoint contracts stay stable.
- Don't touch `judge0Adapter.mjs`, `editorEvents` capture, or the session/recording model.
- Commits LOCAL only, per task; **never push** (Karthi pushes in the morning).
