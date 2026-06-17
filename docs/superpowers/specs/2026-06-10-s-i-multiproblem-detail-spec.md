I have everything I need. Composing the spec now.

# S-I Build Spec — Templates + Multi-Problem (Aerele Proctor)

**Date:** 2026-06-10 · **Status:** BUILD-READY (read-only design output; no code touched)
**Sources:** F10 vision `docs/superpowers/specs/2026-06-10-f10-product-vision.md` §2.5, §2.6, §2.7, §2.11, §5 (C6/A4/A6/S4/S6), §7 S-I row, §10.1 (**FULL multi-problem confirmed by Karthi**); F9 design §2.1–2.4; existing code: `backend/src/problems.mjs`, `backend/src/handler.mjs` (start/resume `startResponse`+`activeProblemPublic` :439–489, exec limiter :740–825, `execRun`/`execSubmit` :826–980, `ingestEditorEvents` :982–1013, problem CRUD :1354–1419), `backend/src/execQueue.mjs`, `frontend/src/coding/CodingWorkspace.tsx`, `frontend/src/App.tsx` (workspace mount :1520–1530, admin tabs :1675, settings `problem_id` field :2748), `frontend/src/api.ts` (demo store, exec fns :2686–2715, `demoActiveProblem` :3151).

## 0. Preconditions & boundaries

S-I lands **after S-A…S-E** (per §7): `proctor_contests` exists (F9 §2.1 doc, single `problem_id` field), `resolveContest`/`scopedQuery`/canary suite exist, Contests tab + contest detail exist (S-D), submissions already denormed with `contest_slug`/`username_norm`/`candidate_id`/`person_id` (S-C/S-E, F9 D7 + §2.11). Where this spec says "contest doc" it means the F9 doc; the **legacy global settings doc** (`SETTINGS_ID="active"`, `settings.problem_id`) keeps its current read path **bit-for-bit** for the synthesized legacy contest.

**Out of scope (explicit):** Results tab UI + selection (S-J — S-I only delivers the scoreboard module + denorm contract it consumes); alert/similarity `problem_id` partitioning (S-F, §2.13); enrollment `final_snapshot` stamping (S-J/S-G); camera track (parallel); code-replay scrubber (post-spine). `ExamTopBar.tsx` (S1 dark chrome) is **not modified** — per-problem chips and score sum live in the C6 workspace per vision C6 ("multi-problem sidebar, per-problem submit state/budgets, score sum"); C7 stays frozen.

---

## 1. Data model

### 1.1 `proctor_templates` (NEW collection, doc id = template slug)

```js
{
  slug,                        // contest slugify rules reused verbatim (lowercase, trim, spaces→-, strip non [a-z0-9-], collision → -2 suffix, reject empty)
  name,                        // required, ≤120 chars
  description: "",             // ≤2000 chars
  archived: false,             // archived templates hidden from instantiate picker, kept in list behind a toggle
  problems: [                  // ORDERED, 1..20 entries, unique problem_ids
    { problem_id,              // must reference an EXISTING bank problem at save time (draft OK in a template)
      points: null,            // null = use bank problem.points at instantiate; else int 0..1000 override
      order: 0 }               // explicit int; normalized to 0..n-1 on every save
  ],
  defaults: {                  // snapshot-copied onto the contest at instantiation (§2.6)
    duration_minutes: 120,             // int 5..600; prefills end_at = start_at + duration at contest create
    identity_label: "Roll Number",     // ≤40 chars
    room_gate_enabled: true,
    camera_recording: { enabled: true, fps: 10, width: 320 },   // existing F10.1 normalizer reused
    enforcement: { mode, fullscreen_reentry_seconds, fullscreen_exit_limit },  // existing F5.3 normalizer reused
    evidence_retention_days: 4,        // clamp 1..30 (F9)
    languages: ["python","cpp","java","javascript"]  // non-empty subset of SUPPORTED_LANGUAGES; intersected with per-problem languages at serve time
  },
  created_at, updated_at
}
```

- New pure module **`backend/src/templates.mjs`** (mirrors `problems.mjs`): `TEMPLATE_BOUNDS`, `validateTemplateInput(body)` → allow-listed normalized object (same never-spread-client-input hardening as `validateProblemInput`), `normalizeProblemEntries(list)` (dedupe ids, re-number order), plus the seed below.
- **Seed preset (system-check, vision S6/J1.5):** code-level `SEED_TEMPLATES = { "system-check": { slug:"system-check", name:"System check", problems:[{problem_id:"sum-two", points:null, order:0}], defaults:{ duration_minutes:30, room_gate_enabled:false, camera_recording:{enabled:true,fps:10,width:320}, enforcement: <current defaults>, evidence_retention_days:1, identity_label:"Roll Number", languages:[all four] } } }` — same shadow rule as `SEED_PROBLEMS`: a Firestore doc with the same slug shadows the seed; list endpoint merges seeds + docs. Instantiating it (+ explicit no-roster ack at publish, §2.4) gives the always-open day-before lab-check contest. Docs note in README/admin help text is part of the task.

### 1.2 Problem bank — `tags` (vision §2.5)

`validateProblemInput` gains: `tags` optional array → trimmed, lowercased, deduped strings, each 1..30 chars `[a-z0-9-]`, max 10; default `[]`. `adminListProblems` summary adds `tags`. No other shape change; `scoreSubmission` unchanged.

### 1.3 Contest `problems[]` + legacy shim (vision §2.7)

Contest doc replaces `problem_id` with:

```js
problems: [{ problem_id, points, order }],   // same entry shape + validation as template entries
template_slug: "aptitude-r1" | null          // display-only provenance
```

New pure module **`backend/src/contestProblems.mjs`**:

- `contestProblemEntries(contestOrSettings)` — THE shim, the only reader:
  - non-empty `problems[]` → sorted by `order`, returned;
  - else legacy `problem_id` truthy → `[{ problem_id, points: null, order: 0 }]`;
  - else `[]`.
  Every site that reads `problem_id` today (`activeProblemPublic`, problem-delete clearing, demo) is rewritten through this shim. Legacy contests and the legacy settings doc therefore work unchanged with zero migration.
- `effectivePoints(entry, problem)` → `entry.points ?? problem.points ?? 100`. Scoring passes a merged view: `{...problem, points: effectivePoints(entry, problem)}` into the existing `scoreSubmission` — **no change to `problems.mjs` scoring**.
- `findProblemReferences(problemId, {contests, templates})` — pure filter over pre-fetched docs: non-archived contests matching `problems[].problem_id` OR legacy `problem_id`; non-archived templates matching `problems[]`. Handler wrapper fetches `proctor_contests` where `status != "archived"` and `proctor_templates` where `archived == false` (bounded `limit(500)` queries; both collections are low-cardinality — **no** denormalized `problem_ids` index field, deliberately).

### 1.4 Snapshot-on-instantiate + live refs + guard — the exact mechanism (vision §2.6/§2.5)

The vision's answer, spelled out: **the LIST is frozen, the CONTENT is live, the guard makes live safe.**

1. **Snapshot (deep copy of definition):** at contest create with `template_slug`, the server copies `template.problems[]` (array copy, entries copied) and every `defaults.*` field **onto the contest doc as the contest's own fields** (`problems`, `room_gate_enabled`, `camera_recording`, `enforcement`, `evidence_retention_days`, `identity_label`, languages → per-contest `languages`; `duration_minutes` → prefilled `end_at` shown editable in the create form). `template_slug` is stored for display only. Template edits/archival/deletion after this moment have **zero effect** on the contest (assert in tests). Clone verb = same copy onto a new template doc.
2. **Live problem content:** statement/tests/limits are **not** copied — exec and `startResponse` call `getProblem(entry.problem_id)` at serve time, so a typo fix in a statement reaches candidates immediately.
3. **Live-reference guard** makes (2) safe (vision §2.5, replaces today's delete-clears-assignment at `handler.mjs:1406–1419`):
   - `adminDeleteProblem`: references found → `409 { error: "problem_referenced", contests: [slugs], templates: [slugs] }`. No silent clearing. (The legacy-settings clearing branch survives only for the legacy contest path.)
   - `adminSaveProblem` transition published→draft ("unpublish") while referenced by a non-archived **contest** → same 409. (Unpublish while only template-referenced is allowed; instantiation re-validates.)
   - `adminSaveProblem` that **changes `hiddenTests`** (deep-compare against the existing doc) of a problem referenced by an **open** contest → require typed confirmation: body `confirm_live_edit` must equal the problem id, else `409 { error: "live_edit_confirmation_required", contests: [...] }`. Frontend renders the typed-confirm dialog (same pattern as the purge modal).
4. **Instantiate-time validation:** every template entry must reference an existing **published** problem → else `400 { error: "template_problems_unavailable", problems: [{problem_id, reason: "missing"|"draft"}] }` and no contest is created.
5. **Contest `problems[]` edit rules** *(veto-able defaults)*: free while `status:"draft"`; once `open` — adding a problem requires `confirm:true`; **removing** an entry whose problem has stored submissions in this contest → `409 problem_has_submissions`; editing an entry's `points` after open requires typed contest-slug confirmation (rescoring implications — best scores are computed live so the change applies retroactively; the dialog says so).

---

## 2. Endpoint surface (delta)

```
# admin — templates (all requireAdmin)
GET  /api/admin/templates                      → { templates: [{slug,name,archived,problem_count,total_points,updated_at}] }  (seeds merged, shadowed)
GET  /api/admin/template?slug=                 → { template }  (full doc)
POST /api/admin/templates                      { name, description?, problems, defaults }  → derives slug, creates
POST /api/admin/template-update                { slug, ...fields }   (name change does NOT re-slug)
POST /api/admin/template-archive               { slug, archived: bool }
POST /api/admin/template-clone                 { slug, name? }       → deep copy, new slug from name (default "Copy of {name}"), archived:false, fresh timestamps

# admin — contests (S-D endpoints amended)
POST /api/admin/contests                       gains optional template_slug  → snapshot-instantiate per §1.4
POST /api/admin/contest-update                 accepts problems[] (validated per §1.3/§1.4.5)

# admin — problems
POST /api/admin/problems                       gains tags + the §1.4.3 guard checks (confirm_live_edit)
POST /api/admin/problem-delete                 guard per §1.4.3

# candidate (no new routes — payload deltas)
POST /api/session/start | resume               startResponse gains problems[] + submissions_summary + submit_budget (§3.4); legacy `problem` field kept = problems[0] ?? null for one release
POST /api/exec/run | /api/exec/submit          problem_id now validated against the session's contest membership (§3.2); per-problem cooldowns (§3.1)
POST /api/editor-events                        unchanged contract (problem_id per batch already exists)
```

---

## 3. Exec path & scoring

### 3.1 Per-problem cooldown/budget — exact limiter changes (`handler.mjs:740–825`)

**`execQueue.mjs` requires ZERO changes** — lanes are engine-global backpressure and stay session/problem-agnostic. All changes live in the handler's limiter:

```js
// execLimiter: session_id -> {
//   problems: Map(problem_id -> { lastRunMs: -Infinity, lastSubmitMs: -Infinity, submitCount: 0 }),
//   inFlight: false,
//   lastSeenMs }
```

- `checkExecRunLimit(sessionId, problemId)` / `checkExecSubmitLimit(sessionId, problemId)` — both now take `problemId`; cooldown windows (`EXEC_RUN_COOLDOWN_SECONDS`=5, `EXEC_SUBMIT_COOLDOWN_SECONDS`=20, env names unchanged) apply **per (session, problem)**: submitting problem A never blocks problem B. The stored-submission budget `EXEC_MAX_SUBMISSIONS_PER_SESSION`=50 is **already per (session, problem)** (`submitCounts` keyed by problem_id) — it just moves inside the per-problem record; semantics identical.
- **New per-session serialization guard** (bounds metered-key drain now that cooldowns are per-problem): `entry.inFlight` set `true` at queue-acceptance (same point the cooldown stamp is taken), cleared in `finally`; a second exec call (run or submit, any problem) while `inFlight` → `429 rate_limited, retry_after_seconds: 2`. Worst-case engine cost per session ≈ 1 concurrent batch + 1 submit/20s/problem (≤20 problems) — bounded and documented in the limiter comment.
- The give-back-on-server-failure stamp logic (`prevLastRunMs`/`runStampMs` compare-and-restore, :848–873/:903–928) is preserved verbatim per per-problem record. Budget increments only on successful store, as today (:973–975).
- Idle sweep + 1h prune unchanged (single-instance caveat comment stays).

### 3.2 Contest membership validation in `execRun`/`execSubmit`

After the ownership gate, resolve scope from the session (as today — no client `contest` param):

- `session.contest_slug` non-empty → load contest → `contestProblemEntries(contest)` → find entry for `body.problem_id`; missing → `400 { error: "problem_not_in_contest" }`. Found → `getProblem(entry.problem_id)` (must still be published — guard makes this near-impossible to violate, but keep the null→400 path) → score against the **merged effective-points view** (§1.3).
- `session.contest_slug === ""` (legacy contest) → **today's path bit-for-bit**: `getProblem(body.problem_id)` only, no membership check, bank/seed points. This is the legacy canary.

### 3.3 Submission doc — target shape (denorm at write time; vision §2.11)

```js
{ session_id, contest_slug, username_norm, person_id, candidate_id,   // identity denorm (S-C/S-E; S-I asserts presence in tests)
  problem_id, language, source_code,
  verdict, passed_count, total, tests,
  score, max_points,            // max_points = EFFECTIVE points (contest entry override applied) — the rollup needs no contest join
  scoring, created_at }
```

**The scoring storage decision (vision asked: denorm vs computed):** identity/problem/effective-points fields are **denormed at submission time** (immutable facts, one write); per-problem best, contest total, rank, tie-break are **computed at read time** by a pure module — never stored on person/enrollment/session in S-I (vision §2.11 "computed, never stored"; the only ever-stored copy is `enrollment.final_snapshot` at selection-done, which is S-J/S-G and calls this same module).

New pure module **`backend/src/scoreboard.mjs`**:

- `computeScoreboard(submissions, problemOrder)` → rows keyed by candidate (`username_norm`, carrying `person_id`): for each problem `best_score = max(score)` and `attempts`; `total = Σ best-per-problem`; **tie-break (exact algorithm):** sort the candidate's submissions by `created_at` asc; walk them maintaining per-problem best-so-far and running total; every submission that strictly increases the running total updates `last_improvement_at = created_at`; rank order = `total` desc, then `last_improvement_at` asc (earlier wins), then `username_norm` asc (deterministic). Zero-submission candidates rank after all scorers.
- `computeSessionSummary(submissions)` → `{ [problem_id]: { best_score, max_points, attempts, best_verdict, last_verdict, last_submitted_at } }` for one session.
- **S-J contract:** Results endpoint = paginated read of `proctor_submissions` where `contest_slug == X` (scopedQuery) → `computeScoreboard` → columns ordered by `contestProblemEntries(contest)`. S-I ships the module + denorm so S-J is a thin wrapper; this contract line is the S-J handoff.

### 3.4 `startResponse` / `activeProblemPublic` (handler :439–489)

- `activeProblemPublic(settings)` → `contestProblemsPublic(contestOrSettings)`: maps `contestProblemEntries` → existing public view per problem (id/title/statement/languages/points/limits/sampleTests — never hiddenTests/status) with `points` = effective points, plus `order`. Unpublished/missing entries are skipped (guard prevents; degrade gracefully).
- Response adds: `problems: [...]` (ordered), `submissions_summary: computeSessionSummary(query submissions where session_id == this)` (resume restores chips/totals; ≤50×n docs, fine), `submit_budget: EXEC_MAX_SUBMISSIONS_PER_SESSION`. Keep `problem: problems[0] ?? null` as a one-release compatibility alias (cached bundles).

### 3.5 Editor events — per-problem NDJSON tagging

Ingest (`handler.mjs:982–1013`) already stores a per-batch `problem_id` — **no backend change**. Frontend rules (the actual delta): one `EventBatcher` per problem (created lazily, keyed by problem id — the existing `useMemo([sessionId, problem.id])` already gives this when the editor is mounted per problem, §4.2); batches stay problem-homogeneous by construction; **flush the outgoing problem's batcher on every switch**; new event type `problem_switched` `{ detail: { from_problem_id, to_problem_id } }` sent in the incoming problem's batch. The post-spine code-replay scrubber consumes these tags as-is.

---

## 4. Candidate workspace (C6 rework)

### 4.1 Layout

`CodingWorkspace` splits into `MultiProblemWorkspace` (container) + `ProblemPane` (≈ today's `CodingWorkspace` body):

- **Left sidebar (the switcher):** ordered problem list — `Q1 · Two Sum · 100 pts` + per-problem **status chip**: `—` (no submission) / `↻ 40/100` (partial best, amber) / `✓ 100/100` (full best, green) / `✗ 0/100` (attempted, zero, red-muted). Chip state derives ONLY from submit outcomes (summary + live responses), never Run. Collapses to a horizontal tab strip under `lg:`.
- **Workspace header:** `Total: 140 / 300` — Σ best per problem, client-computed from `submissions_summary` merged with live submit responses (vision C6 "score sum"). **`ExamTopBar` untouched.**
- **Center/right:** statement + Monaco panes exactly as today, for the active problem only. Free switching at any time, including while a request is in flight (§4.3).

### 4.2 Per-problem editor state (preserved across switches AND reloads)

- In-memory: `Map(problem_id → { language, code, run, submit, judgeError, cooldownUntil })` lifted into the container; `ProblemPane` is mounted **per active problem** (keyed `key={problem.id}` so the per-problem `EventBatcher` lifecycle from §3.5 falls out of the existing `useMemo`), state hydrated from the map on mount, written back on change/unmount.
- **localStorage drafts:** key `proctor-draft::{session_id}::{problem_id}` → `{ language, code, updated_at }`, debounce-written (~2s), capped at `MAX_SOURCE_CODE_LENGTH`. Restore on mount: stored language must be in `problem.languages` (else fall back to `languages[0]` + starter). Language switch keeps today's only-replace-if-untouched starter rule, per problem. `clearSessionDrafts(sessionId)` (prefix scan) called at every existing `sessionStorageKey` removal site in `App.tsx` (:524, :528, :828, :997, :1033, :1173, :1203 — end/expire/replay-invalid paths).
- Pure helpers + reducer in new **`frontend/src/coding/problemSwitch.ts`** (chip derivation, total computation, draft serialize/restore guards) — unit-tested like the existing `*.test.ts` siblings.

### 4.3 Per-problem Run/Submit, cooldowns, budgets in the UI

- Run/Submit buttons act on the active problem; **all** exec buttons disable while any exec is in flight (mirrors the server `inFlight` guard honestly — a switch during flight shows the other problem with buttons disabled + "Running Q2…" note; the response lands in the originating problem's state slot).
- 429 `rate_limited` → per-problem countdown on that problem's button ("Submit (12s)") from `retry_after_seconds`; `queue_full`/`judge_unavailable` keep today's inline `judgeError` treatment, scoped per problem.
- Attempts meter per problem: "Attempt 3 / 50" from `submissions_summary.attempts` + live increments vs `submit_budget`; at cap, Submit disables with explanatory text.
- Submit verdict banner (`presentSubmitResult`) stays per problem; a successful submit updates that problem's chip + the total immediately.

---

## 5. Admin UI

### 5.1 Templates tab (A4, NEW) — `frontend/src/admin/Templates.tsx`

- `AdminView` union (App.tsx:1675) + tab row (:2591) gain `"templates"`.
- **List:** name, slug, #problems, total points (Σ effective using bank points for null overrides — fetched problem summaries), updated_at, archived badge; "show archived" toggle; Clone + Archive row actions; seed rows marked "preset".
- **Editor:** name/description; **ordered problem builder** — add via bank picker modal (search by id/title + tag chip filter, from `fetchProblems`), per-row points-override input (blank = bank default shown ghosted), ↑/↓ reorder (no drag library), remove; **defaults form** reusing the existing Settings/contest field components (enforcement knobs, camera toggle+fps+width, room gate, retention days, identity label, duration, language checkboxes).
- Patterns copied from `ProblemBank.tsx` (list+drawer editing, draft-vs-saved dirty state).

### 5.2 Contests tab / detail (A2/A3 amendments)

- **Create dialog:** template picker (non-archived templates + presets; or "Blank") → on pick, problems + settings preview render pre-filled/editable; `end_at` prefilled from `duration_minutes`; create posts `template_slug`.
- **Contest detail:** "Problems" card replaces any single-problem field — snapshot list (order, title, effective points, link to bank problem), editable per §1.4.5 rules with the confirm dialogs; provenance line "from template {name}".
- Publish gate (S-D) now enforces **≥1 problem** (vision §2.7) — server-side check in `contest-status` open transition + UI hint.

### 5.3 Problems tab (A14) + Settings residue

- Tag chips on rows + tag filter; tags field in the editor (`problemDraft.ts` extended).
- "Referenced by" line on each problem (from the guard's reference data — add `references` to `adminGetProblem` response); delete/unpublish surfaces the 409 list; hidden-test live-edit shows the typed-confirm dialog.
- **Settings tab:** the global "Active problem ID" field (App.tsx:2748) is **removed**; assignment lives only on contests/templates. The legacy settings doc keeps serving the legacy contest read-only via the shim.

### 5.4 Results tab note (S-J consumer)

Not built in S-I. S-I freezes the contract: per-problem score columns = `contestProblemEntries(contest)` order; row data = `computeScoreboard` output (`per_problem[pid].best_score`, `total`, `last_improvement_at`, rank). S-J adds only the endpoint + table + integrity column.

## 6. Demo parity (S4 — non-negotiable acceptance bar)

In `api.ts` demo branch: new `aerele-proctor-demo-templates` store (seeded with the system-check preset) + demo CRUD for every §2 template endpoint; demo contest create honors `template_slug` snapshot-copy; `demoActiveProblem()` → `demoContestProblems()` via the same shim logic (demo settings store gains `problems[]`, legacy `problem_id` fallback kept); demo `execRun`/`execSubmit` keyed per problem (per-problem fake verdicts + a localStorage demo-submissions list so `submissions_summary`, chips, totals, attempts and the Results contract all work offline); demo `sendEditorEvents` stays no-op. Demo seed: 2–3 published problems with tags so the multi-problem workspace demos meaningfully.

## 7. TDD plan

**Pure modules first (node:test / vitest, no Firestore):**
1. `templates.mjs` — `validateTemplateInput` (bounds, dedupe, order normalization, defaults normalization reusing enforcement/camera normalizers), seed shadowing, clone copy.
2. `contestProblems.mjs` — shim precedence (problems[] > legacy problem_id > []), ordering, `effectivePoints` matrix (entry/bank/default), `findProblemReferences` (contest problems[], legacy field, templates, archived exclusion).
3. `scoreboard.mjs` — best-per-problem, totals, **tie-break goldens** (equal totals, earlier-last-improvement wins; improvement = strict total increase; deterministic final key), zero-submission rows, `computeSessionSummary`.
4. `frontend/src/coding/problemSwitch.ts` — chip states, total math, draft restore guards (bad language, oversize, corrupt JSON).

**Handler tests (existing `__setClientsForTest` + `_execClock` fakes):** template CRUD + slug collision + archive/clone; instantiate snapshot (template edit after create does NOT change contest — the snapshot canary); instantiate validation 400 on draft/missing problems; live-reference guard 409s (delete, unpublish, hidden-test edit confirm path) and that delete no longer silently clears assignments; exec membership 400 `problem_not_in_contest`; **per-problem limiter:** A-then-B submit inside 20s passes, A-then-A 429s, `inFlight` serialization 429, failure-restore per problem, per-problem budget cap; effective-points scoring on stored doc + response; `startResponse` `problems[]` order + `submissions_summary` + alias `problem`; editor-events batch problem_id storage (existing test extended); **legacy canaries:** legacy contest (settings `problem_id`) start/exec/score byte-identical to today; F9 bleed-canary suite extended with a contest-B problems[] case.

## 8. File-touch list

**Backend:** `backend/src/templates.mjs` (NEW), `backend/src/contestProblems.mjs` (NEW), `backend/src/scoreboard.mjs` (NEW), `backend/src/problems.mjs` (tags only), `backend/src/handler.mjs` (routes; limiter §3.1; exec §3.2; submission denorm assert §3.3; startResponse §3.4; problem CRUD guard §1.4; contest create/update §1.4/§2; publish gate), `backend/test/templates.test.mjs` (NEW), `backend/test/contestProblems.test.mjs` (NEW), `backend/test/scoreboard.test.mjs` (NEW), `backend/test/handler.test.mjs`/`problemAuthoring.test.mjs`/`execQueue` callers (extend). **`backend/src/execQueue.mjs`: untouched.**
**Frontend:** `frontend/src/coding/MultiProblemWorkspace.tsx` (NEW), `frontend/src/coding/CodingWorkspace.tsx` (→ ProblemPane), `frontend/src/coding/problemSwitch.ts` + `.test.ts` (NEW), `frontend/src/coding/editorEvents.ts` (switch-flush helper), `frontend/src/admin/Templates.tsx` (NEW), `frontend/src/admin/ProblemBank.tsx` (tags, references, confirm dialogs), `frontend/src/problems/problemDraft.ts` (tags), `frontend/src/App.tsx` (workspace mount, AdminView/tabs, contest create/detail problems card, settings field removal, draft-clear sites), `frontend/src/api.ts` (template endpoints + demo parity + types), `frontend/src/types.ts`.

## 9. Build task slicing (sequenced; each = spec section refs + TDD-first + local commit, no push)

| # | Task | Contents | Size |
|---|---|---|---|
| B1 | **Backend templates + guard** | `templates.mjs` + CRUD endpoints + seed preset; problem `tags`; live-reference guard (§1.1, 1.2, 1.4.3, 2) | ~M (≈700 LOC w/ tests) |
| B2 | **Backend multi-problem core** | `contestProblems.mjs` shim; instantiate-on-create; `startResponse problems[]`+summary; exec membership + per-problem limiter; submission denorm; `scoreboard.mjs` (§1.3, 1.4.1/4/5, 3.x) — depends B1 | ~L (≈800 LOC w/ tests) |
| B3 | **Candidate workspace** | MultiProblemWorkspace + sidebar chips + drafts + per-problem state/cooldowns + editor-event switching + demo exec parity (§4, §6 candidate half) — depends B2 | ~L (≈800 LOC) |
| B4 | **Admin UI** | Templates tab; contest create-from-template + problems card; Problems tab tags/references/confirms; settings field removal; demo parity admin half (§5, §6) — depends B1/B2, parallel with B3 | ~L (≈900 LOC) |
| B5 | **Integration + acceptance** | e2e local run (multi-problem contest end-to-end incl. resume-restores-chips), legacy-contest regression canary, demo full-journey check, README/docs, review pass | ~S (≈250 LOC) |

## 10. Acceptance criteria

1. Template → instantiate → contest with 3 problems; candidate solves/switches freely; per-problem Run/Submit with independent cooldowns; reload restores drafts, chips, total. 2. Editing/archiving the template after instantiation changes nothing on the contest. 3. Deleting/unpublishing a referenced problem 409s with the contest list; hidden-test edit on an open contest demands typed confirm. 4. Submitting problem B 1s after problem A succeeds; resubmitting A inside 20s 429s; concurrent exec 429s. 5. `computeScoreboard` goldens pass incl. earlier-last-improvement tie-break. 6. Legacy contest (settings `problem_id`) runs bit-for-bit (canary). 7. Editor-event NDJSON batches are problem-homogeneous with `problem_switched` markers. 8. Demo mode exercises every new surface offline. 9. CI greps (no "username" render) + bleed-canary suite still green. 10. System-check preset instantiates to a working no-roster contest.

**Veto-able defaults taken in this spec** (flag to Karthi, don't block): per-(session, problem) cooldowns + 1-in-flight-per-session serialization guard; contest `problems[]` edit rules after open (§1.4.5); chips/score-sum in workspace not ExamTopBar; templates also block problem deletion (not just contests); one-release `problem` alias in startResponse.