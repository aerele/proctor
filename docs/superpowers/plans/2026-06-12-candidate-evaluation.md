# Candidate Evaluation — deterministic scorecards + LLM-judgment queue

> **For agentic workers:** execute phase-by-phase with `superpowers:subagent-driven-development` (or `superpowers:executing-plans` in a fresh session). Strict TDD per task. Suite green at every commit. Behavior-preserving everywhere outside the files this plan names.

- **Status:** DRAFT — awaiting owner review. Nothing here is built.
- **Goal:** port the contest-eval methodology (`/home/karthi/arogara/contest-eval/`) onto the own-editor proctor platform: deterministic talent + integrity metrics computed in-platform from the captured session data, an LLM-judgment work-queue API for the signals that genuinely need judgment, and a shortlistable Results view combining both.
- **Architecture:** pure metric modules (`src/evaluation*.mjs`, precedent: `scoreboard.mjs` / `monitoring/contest_eval_core.py`) + a cursor-batched admin evaluate route + a claim/verdict work queue mirroring the existing recording-review queue + Results-tab columns/filters/CSV.
- **Tech stack:** existing — Node 20 ESM `.mjs` backend on Cloud Run, Firestore + GCS, React/TS/Vite frontend, `node --test` + Vitest.

**Sources studied (read before building):**
- Old playbook: `/home/karthi/arogara/contest-eval/{METHODOLOGY.md,ANGLES.md,ADDITIONAL-ANGLES.md,CONVENTIONS.md}`, scripts (`analyze_meta.py`, `clone_detect.py`, `build_profiles.py`, `build_report.py`, `reconcile.py`), run outputs under `KEC-Aerele-06-26/386632-live/`.
- Parameterized pure-function port already in-repo: `monitoring/contest_eval_core.py` (normalization, clone clustering, recurring pairs, tight-gap, artifacts, provenance — keep JS port byte-parity with this).
- Platform capture: `backend/src/handler.mjs` (`ingestEditorEvents` ~:1580, `recordEvents` ~:1210, `recordHeartbeat` ~:1637, `execSubmit` ~:1460, review queue ~:4785–5200), `backend/src/scoreboard.mjs`, `backend/src/identity.mjs`, `docs/features/{architecture-overview,admin-results-people,admin-recording-review,alert-taxonomy}.md`.
- Guards: `backend/test/{scopingLint,routesAuthLint,canaryIsolation,envLint}.test.mjs`.
- Decomposition plan (do not fight it): `docs/superpowers/plans/2026-06-11-architecture-decomposition.md` — new code lands as `routes/<domain>.mjs` factories + flat `src/*.mjs` domain modules, exactly as that plan prescribes.

**Carried-over philosophy (verbatim from the old playbook — load-bearing):**
1. Outputs are **EVIDENCE / flags, not verdicts**; a supervised round (or the owner) is ground truth.
2. **Talent and Integrity are orthogonal axes — never averaged.** Originality **gates** talent (confirmed cheating caps talent to weak).
3. All copy evidence is **difficulty-weighted** (identical easy/convergent code is weak; identical hard code is strong).
4. Recurring pairs (same two people, identical code, ≥2 problems or ≥1 hard) remain the strongest standalone proof.
5. Every candidate gets a `one_line` evidence summary; confidence is explicit.

---

## 1. Signal inventory — every old angle mapped onto the new data

Legend: **DET** = deterministic on the new platform (code in this repo), **DET+** = deterministic *and strictly better than before* (keystrokes/pastes/effort now directly measured), **LLM** = needs LLM judgment (→ §3), **DEAD** = HackerRank-specific, dropped.

### 1.1 Old cheating angles (ANGLES.md A1–A20 + ADDITIONAL-ANGLES)

| # | Old angle | Fate | On the new data |
|---|---|---|---|
| A1 | Attempt count per problem | DET+ | `proctor_submissions` per (person, problem) + `code_run` editor events — we now see *runs* before submits too. |
| A2 | True vs fake iteration (wrong-before-solve) | DET+ | Submission verdict sequence + edit/run arcs between submits. A copier's "iteration" with zero intervening edits is now visible. |
| A3 | Zero-iteration (corroborator only) | DET+ | Superseded by **zero-effort solve**: accepted submit with < threshold active-editing ms and near-zero typed chars. Far lower FP than the old metadata proxy. |
| A4 | Inter-submission timing gaps | DET | `created_at` (ms ISO) on submission docs. |
| A5 | Silent-start pattern | DET+ | We no longer infer silence — the editor-event timeline shows exactly what happened (idle vs typing vs away). |
| A6 | Difficulty targeting (solver-count hardness) | DET | Port `make_hardness` (≤10 solvers = hard, ≤40 = med) over per-problem accepted counts. |
| A7 | Language usage / one-off switch | DET | `language` on submissions + `code_run`/`code_submit` detail. |
| A8 | Score-vs-behavior mismatch | LLM | → J4 borderline adjudication. |
| A9 | Exact clone (normalized) | DET | Port `core_exact` over `source_code` of accepted submissions. |
| A10 | Difficulty-weighted clone significance | DET | Same hardness tags on clusters, hard-first sort. |
| A11 | Solution diversity per problem | DET | Distinct normalized solutions per problem. |
| A12 | Code-style authenticity tells | LLM | → J3 AI/style dissonance. |
| A13 | Recurring pairs (strongest proof) | DET | Same logic: ≥2 shared problems or ≥1 hard = CONCLUSIVE. |
| A14 | Directionality (author → copier) | DET+ | **Massive upgrade:** old data only had submit order. Now, if candidate B *pastes* text that already existed in candidate A's editor state earlier, direction is proven, not inferred. |
| A15/A16 | Tight-gap (≤300s) / same-minute (≤60s) | DET+ | Same thresholds on submission timestamps, now joined with room + IP for physical-proximity corroboration. |
| A17 | Cluster topology / scope | DET | Pair graph + room/IP join is now mechanical; LLM only narrates. |
| A18 | Web/editorial paste (flag-type-B) | DEAD→reborn | The HackerRank editorial-fetch web-check is dead (own private problems). Reborn as: DET foreign-paste detection (D2) + LLM paste-provenance (J2). |
| A19 | Data-integrity verification (429 placeholders) | DEAD→reborn | The fetch-hygiene problem is gone. Reborn as **coverage + tamper checks** (D16): telemetry gaps, and replayed-editor-state vs submitted-code mismatch. |
| A20 | Confidence tiering | KEPT | Explicit `confidence` on every scorecard and verdict. |
| A21 | Raw-byte paste artifacts (smart quotes, NBSP, zero-width…) | DET | Port `artifacts()` over raw `source_code`. Demoted from "top recommendation" to cross-check — we now *see* pastes directly. |
| A22 | Provenance regexes (LeetCode `class Solution`, GfG banners…) | DET | Port `provenance()` / `PROV`. Cheap, keep. |
| A23 | Skeleton (renamed-variable) clones | DET | Port `skeleton()` tokenizer. |
| A24 | AI-generated submission detection | DET prefilter + LLM | DET: full-solution foreign paste, zero-effort solve, superhuman cadence. LLM (J3): typed-but-AI-shaped dissonance vs cohort norm. |
| A25 | Shared-broken-code / failed-submission clustering | DET (newly unlocked) | Was aspirational — HackerRank only gave us accepted code. We store **every** submission with full `source_code`, so clustering identical *wrong* code (much lower FP) is now implementable. |
| A26 | Within-candidate authorship inconsistency | LLM | → J3 input (`all_code`-style bundle across problems). |
| A27 | Magic-list ordering | DET | Folded into normalization + diversity. |
| — | Paste-velocity (code volume vs authoring time) — *blocked on HackerRank* | DET+ (unlocked) | This is exactly D1 paste-ratio. The single biggest unlock of the new platform. |
| — | Per-testcase score trajectory — *aspirational* | DET (unlocked) | `tests[]` per submission stores per-test pass/fail. |
| — | Cross-problem interleaving — *aspirational* | DET (unlocked) | `problem_switched` events. |
| — | HackerRank native MOSS probe | DEAD | No equivalent needed. |

### 1.2 Old talent angles

| # | Old angle | Fate | On the new data |
|---|---|---|---|
| B1 | Genuine-iteration trajectory / score-climb | DET+ | Run→fail→edit→run→pass arcs with real edit content between attempts. One-shot stays NEUTRAL, never penalized. |
| B2 | Difficulty/rarity of solves | DET | Solver-count hardness; sole-solver bonus. |
| B3 | Asymptotic-complexity grading | LLM | → J5 talent grading (strongest positive signal; gated by originality). |
| B4 | Honest failed reach ("hidden gems") | DET+ triage + LLM verify | The KEC lesson (36/45 "gems" were partial-score gamers) is now largely *deterministic*: stub-delta + active-effort + typed-ratio expose hardcode-stub gaming (D12/D13). LLM (J6) verifies reasoning quality on survivors. |
| B5 | Breadth / language fluency | DET | Per-problem coverage + languages. |
| B6 | Behavioral similarity to known-good | DET | Port `analyze_candidate` composite (0.45·jaccard + 0.25·tries + 0.30·temporal) if needed; P3. |

### 1.3 New signals possible only on this platform (all DET)

| ID | Signal |
|---|---|
| N1 | **Paste-vs-typed ratio** per problem and overall (D1). |
| N2 | **Foreign-paste detection** — pasted text that never existed in the candidate's own session before (D2). |
| N3 | **Switch-away → paste correlation** — blur/visibility/fullscreen-exit episode followed within seconds by a paste or burst insert (D3). |
| N4 | **Typing cadence** — superhuman sustained rates, metronomic variance (D4). |
| N5 | **Inter-candidate paste-content matching** — B pasted what A had → directed copying (D6). |
| N6 | **Replay-vs-submission tamper check** — submitted `source_code` ≠ replayed editor state at submit time ⇒ telemetry suppressed (D16). |
| N7 | **Active-effort per problem** — gap-capped editing time, idle/away segmentation (D11). |
| N8 | **Stub-delta partial-gamer detection** — partial score with trivial edit distance from stub (D12). |
| N9 | **Room/IP-joined submit clusters** — same-minute accepts within a physical room (D14). |
| N10 | **Entry-clipboard check** — `review/clipboard.jsonl` content vs first pastes (D15). |

**Tally: 24 deterministic signal families (10 of them new-only or materially upgraded), 6 LLM judgment types, 3 dead.**

---

## 2. Deterministic layer

### 2.1 Where it runs

A new **admin-triggered, cursor-batched evaluator** inside the backend (owner: "whatever can be deterministic, we push along with this tool itself as code").

- **Pure logic** in flat domain modules (no I/O, fixture-testable — same discipline as `scoreboard.mjs` and `contest_eval_core.py`):
  - `backend/src/evaluationReplay.mjs` — replay editor-event streams into content states; pair `editor_paste` with its coincident text-carrying change event; build the replay digest; replay-vs-submission check.
  - `backend/src/evaluationClone.mjs` — JS port of `core_exact`, `skeleton`, `artifacts`, `provenance`, `make_hardness`, cluster/recurring-pair/tight-gap logic from `monitoring/contest_eval_core.py`, with **byte-parity fixtures** generated from the Python lib.
  - `backend/src/evaluationMetrics.mjs` — per-candidate metric catalog (D1–D17) + tier derivation.
- **Orchestrator** `backend/src/evaluation.mjs` — gathers data (Firestore via `scopedQuery`, GCS via `getStorage()` listing `<storage_prefix>editor-events/*.ndjson` and `events/*.jsonl` — same pattern as `adminSessionEvents`), runs the pure modules, writes scorecards.
- **Routes** in `backend/src/routes/evaluation.mjs` (factory `makeEvaluationRoutes(ctx)`, guard-first — auto-enforced by routesAuthLint since it lives in `routes/`):
  - `POST /api/admin/contest-evaluate` — body `{ contest, limit?=25, cursor?, force? }`. Evaluates up to `limit` enrollments per call, returns `{ evaluated, skipped, cursor?, done }`. Cursor-batched so a 400-person contest fits Cloud Run request timeouts; idempotent and resumable (skips persons whose scorecard has current `evaluator_version` + unchanged `session_ids`/`submissions_n` unless `force`). Phase order per call: (a) per-person pass, (b) once all persons done, a **cross-candidate pass** (clones, pairs, paste-matching, submit clusters) over the accumulated normalized corpus, writing the meta doc and back-patching per-person refs.
  - `GET /api/admin/contest-evaluations?contest=<slug>` — all scorecards for the contest (and `&person_id=` for one). Scoped GET → categorized in `canaryIsolation.test.mjs`.
- **Storage** (declared in `config.mjs`, env-overridable):
  - `EVALUATIONS_COLLECTION` = `proctor_evaluations` — one doc per person×contest, id `{contest_slug}::{person_id}` (mirrors enrollments).
  - Contest-level artifacts (clusters, pairs, hardness table, cohort norms) in the same collection under id `__meta::{contest_slug}`.
- **Versioning:** `EVALUATOR_VERSION` const + `schema_version` field; bumping the version makes `contest-evaluate` recompute on next run.

### 2.2 Metric catalog (formulas / thresholds — defaults, all constants in one block in `evaluationMetrics.mjs`)

**Integrity metrics**

| ID | Metric | Definition |
|---|---|---|
| D1 | `paste_ratio` | `pasted_chars / max(1, typed_chars + pasted_chars)` per problem + overall. `pasted_chars` = Σ `insertedLen` of change events paired to an `editor_paste` (pair = same problem, |Δt| ≤ 500ms, matching `len`/position) or any single change with `insertedLen ≥ 40` that isn't a paired paste, autocomplete-shaped (single-line ≤ 60 chars ending in an identifier/bracket — heuristic, document FP), or `stub_reloaded`. `typed_chars` = Σ insertedLen of the rest. |
| D2 | `foreign_pastes[]` | Each paste whose text (≥ 30 chars after whitespace-collapse) is **not** a substring of any prior content state of the candidate's own session (any problem, any earlier time). Self-pastes (moved own code) are benign and excluded. Record `{problem_id, ts, len, preview(200), after_away_ms?}`. Mega-pastes truncated at the 2000-char capture cap still match on prefix; flag `truncated`. |
| D3 | `away_paste_correlations[]` | Foreign paste or burst insert (≥ 80 chars/2s) within `AWAY_PASTE_WINDOW_MS = 10000` after the end of a `switch_away_episode`/`window_blur`/visibility-hidden/fullscreen-exit episode. The single highest-precision live-copy signal. |
| D4 | `cadence` | Over `editor_insert` with `insertedLen == 1`: `{median_ikg_ms, p95_ikg_ms}`; `superhuman_bursts` = runs of ≥ 25 consecutive single-char inserts at ≥ 14 chars/s; `metronomic` = coefficient-of-variation < 0.15 over ≥ 40 keystrokes (script/replayer tell). |
| D5 | Clone clusters | `core_exact` + `skeleton` over accepted `source_code` (min 15 chars), per problem, hardness-tagged, >1 distinct person = cluster. **Plus the newly unlocked failed-submission clustering** (identical normalized *wrong* code across persons — very low FP). |
| D6 | Paste-content matching | Normalized foreign-paste text (≥ 80 chars) matched against all other candidates' content states and submissions ⇒ `{from_person, to_person, problem_id, ts_delta}` — directed edges. |
| D7 | Recurring pairs | Pairs sharing skeleton-identical code on ≥ 2 problems OR ≥ 1 hard ⇒ `CONCLUSIVE` / `single-hard` (verbatim old rule). |
| D8 | Tight-gap / same-minute | On hard-cluster members: Δt ≤ 60s = `SAME-MINUTE`, ≤ 300s = `tight-gap` (verbatim old thresholds), annotated with same-room/same-IP-prefix booleans. |
| D9 | Artifacts + provenance | `artifacts()` raw-byte scan (smart quotes, NBSP, zero-width, BOM, dashes, mixed-indent) + `PROV` regex hits per submission. |
| D10 | Zero-effort solve | Accepted submission on a med+ problem with `active_ms < 120000` AND `typed_chars < 0.15 × |code|`. Replaces old zero-iteration. |
| D16 | Coverage / tamper | (a) heartbeats present while editor-event stream silent > 5 min during active solving; (b) **replay mismatch**: reconstructed editor state at `code_submit` time vs submitted `source_code` — normalized Levenshtein > 0.15 ⇒ `telemetry_tampered` (critical); (c) `upload_error_count`, missing batches ⇒ lowers `confidence`, never raises a cheat flag alone. |
| D17 | Shell rollups | `tab_away_total_ms`, away-episode count, `fullscreen_violations`, `ip_change_count`, locked/enforcement history — lifted from session docs + alerts. |

**Talent metrics**

| ID | Metric | Definition |
|---|---|---|
| D11 | `active_ms` per problem | Editor-event timeline, gaps > 60s excluded; `away` segments excluded. |
| D12 | Stub-delta | Final code vs stub: line-level edit distance. `score > 0 AND delta < 10 lines` ⇒ `partial_gamer` flag (formalizes the KEC gem-gamer lesson). |
| D13 | Honest reach | Unsolved problem with ≥ 2 submits AND `active_ms ≥ 10 min` AND `paste_ratio < 0.3` ⇒ genuine reach. Tiering: best partial ≥ 75% of max ⇒ `strong_gem`; ≥ 50% or ≥ 3 problems reached ⇒ `solid_gem`. |
| D14 | First-attempt / tough-first-attempt | First submit accepted, no prior failed run, per hardness tier — neutral alone, flag only when paired with D1/D2/D10. |
| D15 | Entry-clipboard | First foreign paste matches entry `review/clipboard.jsonl` content ⇒ premeditated-paste flag. |
| — | Iteration arcs | Per problem: `{runs, submits, wrong_before_solve, score_climb[], per_test_progression}` from submissions `tests[]` + `code_run` markers. |
| — | Breadth | `n_solved_full`, `n_medplus_solved`, `hardest_tier_solved`, `languages[]`, time-allocation profile. |

### 2.3 Scorecard schema (`proctor_evaluations/{contest_slug}::{person_id}`)

```json
{
  "schema_version": 1, "evaluator_version": "1", "computed_at": "...",
  "contest_slug": "...", "person_id": "...", "username_norm": "...", "session_ids": ["..."],
  "coverage": { "editor_events_n": 0, "shell_events_n": 0, "submissions_n": 0, "gaps": [], "confidence": "high|medium|low" },
  "talent": { "total_score": 0, "n_solved_full": 0, "n_medplus_solved": 0, "hardest_tier": "easy|med|hard",
              "per_problem": { "<pid>": { "best_score": 0, "active_ms": 0, "runs": 0, "submits": 0,
                                          "wrong_before_solve": 0, "score_climb": [], "paste_ratio": 0 } },
              "honest_reach": [], "first_attempt_solves": [] },
  "integrity": { "typed_chars": 0, "pasted_chars": 0, "paste_ratio": 0,
                 "foreign_pastes": [], "away_paste_correlations": [], "cadence": {},
                 "zero_effort_solves": [], "clone_cluster_refs": [], "recurring_pair_refs": [],
                 "paste_match_edges": [], "artifacts": {}, "provenance_hits": [],
                 "tab_away_total_ms": 0, "fullscreen_violations": 0, "ip_change_count": 0,
                 "telemetry_tampered": false },
  "flags": [ { "code": "foreign_paste_after_away", "severity": "critical|warning|info",
               "problem_id": "...", "evidence": "one-line, human-readable" } ],
  "tiers": { "talent": "strong|moderate|weak", "integrity": "clean|watch|flag|confirmed",
             "one_line": "..." },
  "llm": { "judgments_pending": [], "verdicts": {} },
  "recommended_action": null
}
```

**Tier derivation (fixed deterministic rules, in `evaluationMetrics.mjs`):**
- `integrity = confirmed` iff CONCLUSIVE recurring pair, OR telemetry_tampered, OR foreign-paste-after-away of a full solution that then passed.
- `integrity = flag` iff any critical flag (zero-effort med+ solve, hard clone cluster, paste_ratio > 0.6 on scoring problems, directed paste-match edge).
- `integrity = watch` iff warning flags only. Else `clean`.
- `talent = strong` iff ≥ 1 hard or ≥ 2 med solved with genuine arcs (typed-majority, iteration or clean one-shot); `moderate` iff ≥ 1 med+ genuine or strong_gem; else `weak`. **Confirmed integrity caps talent at weak** (the gate).
- These rules are v1 defaults; LLM layer (§3) adjudicates the borderline middle.

### 2.4 Landing in the UI + CSV

- `backend/src/scoreboard.mjs:buildResultsRows` joins `proctor_evaluations` (same enrollment-spine join as alerts) → each `ResultRow` gains `evaluation: { talent_tier, integrity_tier, paste_ratio, flags_by_severity {critical,warning,info}, confidence, one_line, recommended_action }` (null until evaluated — behavior-preserving for unevaluated contests).
- `frontend/src/results/computeResults.ts`: `ResultRow` type + filters gain `evalIntegrity`, `evalTalent`, `evalAction`; `buildResultsCsv` (both copies — client and `scoreboard.mjs` server `?format=csv`) gains columns `talent_tier, integrity_tier, paste_pct, eval_flags, recommended_action, eval_one_line`.
- `frontend/src/admin/ResultsPanel.tsx`: three new columns (Talent badge, Eval-Integrity badge with flag counts, Action chip), an "Evaluate contest" button driving the cursor loop with progress, and a per-row expandable evidence drawer (flags + one_line + links to the recording-review player for the flagged session).
- Purge survival: `identity.mjs:stampSelectionDone` adds `{talent_tier, integrity_tier, recommended_action, flags_by_severity, one_line}` to `final_snapshot`.

---

## 3. LLM-judgment layer

### 3.1 Judgment catalog (each = one rubric doc + one work-item type)

Work items are **generated by the deterministic pass** — only candidates/problems in the grey zone get items (the cheap-first funnel from the old playbook). Verdict enums keep the old vocabulary.

| Type | Question | Generated when (deterministic trigger) | Input bundle | Decision enum |
|---|---|---|---|---|
| `evolution-organic` (J1) | Is this problem's code evolution organic or transplanted? | paste_ratio 0.25–0.6 on a scoring problem, or large self-paste chains, or burst anomalies without foreign-paste proof | replay digest (typed/paste/idle/away segments + run/submit markers w/ verdicts), final code, stub, problem statement | `organic \| assisted \| transplanted \| inconclusive` |
| `paste-provenance` (J2) | What is this pasted content? | any foreign paste ≥ 80 chars not already `confirmed` | paste text(s) + timestamps, candidate's typed code elsewhere, entry-clipboard snapshot, problem statement | `own_work_moved \| reference_snippet \| ai_generated \| external_solution \| inconclusive` |
| `ai-dissonance` (J3) | Typed-but-AI-shaped? (old A24, cohort-calibrated) | zero-effort or pristine first-attempt med+ solve with low paste_ratio, or style dissonance candidates from D9 | candidate's full per-problem code (`all_code` style), cohort style digest (naming/idiom norms from `__meta`), per-problem iteration stats | `ai_likelihood: none\|low\|medium\|high` + `verdict: genuine\|possible-ai\|likely-ai` |
| `borderline-integrity` (J4) | Adjudicate grey-zone flag stack | `integrity == watch\|flag` and not confirmed | scorecard flags + the specific evidence excerpts (cluster code side-by-side, timing table, room/IP) | `clean \| suspect \| confirmed` |
| `talent-grade` (J5) | Complexity/quality beyond tests-passed | every candidate with `integrity ∈ {clean, watch}` and ≥ 1 med+ solve (this is the positive-talent pass) | per-problem final code + problem statement + intended-difficulty + tests[] outcome + cohort solve stats | per-problem `optimal \| acceptable \| brute_force \| hack` + overall `strong \| moderate \| weak` |
| `gem-verify` (J6) | Honest reach genuine? (KEC lesson) | D13 gem candidates surviving D12 stub-delta filter | unsolved-problem code + replay digest + partial-score breakdown | `real_reasoning \| partial_gamer \| inconclusive` |

Every verdict body: `{ decision, confidence: high|medium|low, rationale (≤2000 chars), extras? }` — `rationale` is mandatory (it becomes the audit trail and the owner-facing one_line refinement).

### 3.2 Rubric documents

One page each at `docs/evaluation/rubrics/<type>.md`, version-stamped (`rubric_version: 1` in frontmatter; items record the version they were judged under). Fixed template:

1. **Question** (one sentence) and what the verdict gates downstream.
2. **Input bundle** — exact JSON fields the API returns, with semantics.
3. **Decision options** — definitions + boundary examples.
4. **Calibration notes** — ported verbatim from the old playbook where applicable: convergent-problem warning (identical easy code is weak), the `class Solution` template FP, AI counter-signals (Python-2 dialect, debug cruft, magic constants), cohort-norm anchoring, "one-shot is neutral".
5. **Output schema** — the exact verdict JSON to POST.

Plus `docs/evaluation/JUDGE-PROTOCOL.md` — the owner's agent-facing runbook (precedent: `monitoring/verdict-responder-prompt.md`): the pull→bundle→judge→post loop with literal `curl` examples, auth header, and the rule *never invent fields; inconclusive is an acceptable answer*.

### 3.3 API contract (mirrors the recording-review queue, person-keyed from day one)

**Collections** (in `config.mjs`): `EVAL_JUDGMENTS_COLLECTION` = `proctor_eval_judgments` (item id `{contest_slug}::{person_id}::{type}[::{problem_id}]`), `EVAL_CLAIMS_COLLECTION` = `proctor_eval_claims` (claim id = item id; atomic `.create()`, ALREADY_EXISTS → stale-takeover after `EVAL_CLAIM_TTL_MS` default 10 min — byte-for-byte the `claimReviewUsername` pattern at `handler.mjs:5075`).

**Item doc:** `{ item_id, contest_slug, person_id, judgment_type, problem_id?, status: "pending"|"done", rubric_version, created_at, verdict?, judged_by?, judged_at?, updated_at }`. (Claimed-ness is derived from the claims collection, not a status value — same as reviews.)

**Routes** — all in `backend/src/routes/evalJudgments.mjs` (`makeEvalJudgmentRoutes(ctx)`), all `requireAdmin(req)` first (header `x-admin-password`, same as the review queue — see Open Question 2 for a dedicated worker key):

| Method | Path | Body / query | Returns | Semantics |
|---|---|---|---|---|
| POST | `/api/admin/eval-judgments-generate` | `{ contest, types? }` | `{ created, existing, by_type }` | Scans scorecards, `.create()`s missing items (idempotent; re-run safe; never resets `done` items). |
| POST | `/api/admin/eval-next` | `{ worker_name, contest?, types? }` | `{ item_id, judgment_type, rubric_version, person_id, problem_id? }` or `{ done: true }` | Ranks pending items (critical-flag persons first, then by type priority J4→J2→J1→J3→J6→J5), skips items actively claimed by another worker, claims atomically. |
| GET | `/api/admin/eval-bundle?item_id=` | — | `{ item, rubric_version, bundle }` | Assembles the **self-contained** bundle on demand (Firestore + GCS), size-capped with `truncated` flags. The judging agent needs **no other endpoint**. |
| POST | `/api/admin/eval-verdict` | `{ item_id, worker_name, verdict: { decision, confidence, rationale, extras? } }` | `{ ok: true }` | Validates `decision` against the type's enum (400 otherwise), upserts verdict (re-post overwrites, preserves `created_at` — idempotent), sets `status: "done"`, deletes claim (best-effort), and **merges the verdict into the person's scorecard** `llm.verdicts[type]` + recomputes `recommended_action`. |
| GET | `/api/admin/eval-judgments?contest=&status=&type=` | — | `{ items, counts }` | Queue progress / audit. |

Guard compliance: 2 new scoped GETs → add to `SCOPED_GET_REQUESTS` + canary requests in `canaryIsolation.test.mjs`; all contest-filtered reads via `scopedQuery`; doc-id-suffix scoping (`::{slug}` embedded in item ids) for direct gets.

**Non-blocking contract** (from `monitoring/verdict_seam.py`, kept): the platform never calls an LLM, never blocks, never spends money. Pending items stay pending until the owner points an agent at the queue. Absence of verdicts degrades gracefully — `recommended_action` is computed from whatever exists.

### 3.4 Combining verdicts → `recommended_action`

Pure function `computeRecommendedAction(scorecard)` in `evaluationMetrics.mjs`, KEC vocabulary and precedence (copy > AI > talent):

- `REJECT-CHEAT` — deterministic `confirmed`, or J4 `confirmed`.
- `PEN-PAPER` — J4 `suspect`, or deterministic `flag` with no J4 verdict yet.
- `AI-SUSPECT` — J3 `likely-ai`; J3 `possible-ai` on an otherwise-ADVANCE → `VERIFY-DESK`.
- `ADVANCE` — integrity clean/cleared AND (J5 strong/moderate, or deterministic strong with no J5 yet).
- `VERIFY-DESK` — conflicting verdicts (deterministic vs LLM disagree → conservative, per the old dual-workflow rule), or possible-ai, or gem-verify `real_reasoning` on a weak-scorer.
- `REJECT` — clean but weak with no genuine-effort signal; `NOT-ADVANCED` — easy-only depth.

---

## 4. Shortlisting UX

Workflow stays inside the existing Results tab — no new tab in P1/P2:

1. Admin runs **Evaluate contest** (button → cursor loop → progress bar). Today's contest data is evaluable the moment P1 lands — evaluation reads only persisted session evidence + submissions, nothing exam-time.
2. Results rows now carry Talent / Eval-Integrity / Action columns; sort by rank (unchanged) or by talent tier; filters: Action, Eval-integrity tier, existing min-score/college/room/no-critical.
3. Admin filters to `ADVANCE` (+ optionally `VERIFY-DESK`), box-selects, hits the existing **Shortlist** bulk action — `selection_status` machinery (`applySelectionTransition`, audit rows, `from_status` race guard) is untouched.
4. Evidence drawer per row answers "why this tier?" without leaving the tab (flags, one_line, LLM rationales, deep-link to the recording player at the flagged timestamp — deep-link part is P3).
5. CSV export carries every new column for offline reconciliation. `Mark selection done` freezes eval summary into `final_snapshot` so the shortlist survives purge.
6. People tab (cross-round): person scorecard gains a per-round evaluation summary line (P3).

---

## 5. Phasing

### P1 — Deterministic core (ship first; today's contest evaluable)

**Files:**
- Create: `backend/src/evaluationReplay.mjs`, `backend/src/evaluationClone.mjs`, `backend/src/evaluationMetrics.mjs`, `backend/src/evaluation.mjs`, `backend/src/routes/evaluation.mjs`.
- Create tests: `backend/test/evaluationReplay.test.mjs`, `backend/test/evaluationClone.test.mjs` (+ `backend/test/fixtures/clone-parity/*.json`), `backend/test/evaluationMetrics.test.mjs`, `backend/test/evaluationRoutes.test.mjs`.
- Modify: `backend/src/config.mjs` (`EVALUATIONS_COLLECTION`, `EVALUATOR_*` tunables), `backend/src/handler.mjs` (wire factory + 3 dispatch lines in the exact `req.method === "..." && path === "..."` format), `backend/test/canaryIsolation.test.mjs` (categorize `GET /api/admin/contest-evaluations`), `backend/src/scoreboard.mjs` (+ its test), `backend/src/identity.mjs` (`final_snapshot` extension).
- Frontend: modify `frontend/src/results/computeResults.ts` (+ test), `frontend/src/admin/ResultsPanel.tsx`, `frontend/src/api.ts` (+ demo branches), `frontend/src/types.ts`.
- Docs: create `docs/features/candidate-evaluation.md`.

**Tasks (each = failing test first, then implement, then green; exact commands: `npm --workspace backend run test`, `npm --workspace frontend run test`):**
1. Config + collection plumbing (smallest possible diff; envLint stays green).
2. `evaluationClone.mjs` port. Test: parity fixtures — run `monitoring/contest_eval_core.py` once over 6–8 crafted inputs (exact clone, renamed-var skeleton, artifacts, provenance, recurring pair, tight-gap), commit input+expected JSON, assert the JS port reproduces them byte-for-byte.
3. `evaluationReplay.mjs`. Tests: synthetic NDJSON streams → content-state replay correctness, paste pairing (paste+replace coincidence), truncated mega-paste handling, replay-vs-submission mismatch detection, digest segmentation (typed/paste/idle/away).
4. `evaluationMetrics.mjs` D1–D17 + tier rules. Tests: one fixture stream per metric family with hand-computed expected values; gate test (confirmed caps talent).
5. `evaluation.mjs` orchestrator + `routes/evaluation.mjs` + dispatch + canary. Tests: fake Firestore + fake Storage (reuse the `adminSessionEvents` fake-GCS pattern); cursor resume; idempotent re-run skips; `force` recomputes; cross-candidate pass writes `__meta::{slug}`; routesAuthLint auto-passes (functions named `adminContestEvaluate`/`adminContestEvaluations`, guard-first).
6. `scoreboard.mjs` join + server CSV. Test: existing `contestResults.test.mjs` untouched assertions stay green (behavior-preserving for unevaluated contests = `evaluation: null`); new assertions for joined rows.
7. Frontend columns/filters/CSV/evaluate-button/evidence drawer + demo-mode data.
8. Feature doc + exam-day-ops runbook addendum ("after contest end: run Evaluate").

**Size:** ~2.4k LOC backend + ~0.7k frontend + fixtures. 8 tasks, ~1–1.5 builder-days with subagents.

### P2 — LLM-judgment queue + rubrics

**Files:**
- Create: `backend/src/evalJudgments.mjs` (item generation + verdict merge + `computeRecommendedAction`), `backend/src/evalBundles.mjs` (per-type bundle assembly), `backend/src/routes/evalJudgments.mjs`; tests `backend/test/evalJudgments.test.mjs`, `backend/test/evalBundles.test.mjs`, `backend/test/evalJudgmentRoutes.test.mjs`.
- Create docs: `docs/evaluation/rubrics/{evolution-organic,paste-provenance,ai-dissonance,borderline-integrity,talent-grade,gem-verify}.md`, `docs/evaluation/JUDGE-PROTOCOL.md`.
- Modify: `config.mjs` (2 collections + TTL), `handler.mjs` (5 dispatch lines), `canaryIsolation.test.mjs` (2 new GETs), `scoreboard.mjs` + frontend (Action column + LLM rationale in drawer).

**Tasks:**
1. Item generation from scorecards (idempotent `.create()`; trigger rules from §3.1 table).
2. Claim/next/verdict routes — port the review-queue claim race tests (fake Firestore `.create()` throws `ALREADY_EXISTS` code 6; stale-takeover; idempotent re-verdict preserves `created_at`; enum validation 400s).
3. Bundle builder per type with size caps + truncation flags.
4. Verdict merge → scorecard + `computeRecommendedAction` (precedence tests: copy > AI > talent; conflict → VERIFY-DESK).
5. Rubric docs + JUDGE-PROTOCOL (curl-literal; verified by actually running one item end-to-end against dev with a live agent).
6. Results Action column + filter + CSV.

**Size:** ~1.3k LOC + 7 docs. 6 tasks, ~1 builder-day.

### P3 — Niceties (separately approvable)

- Code-evolution **replay scrubber** in the recording-review player (the editor-events capture was explicitly designed for this) + deep-links from evidence drawer to player timestamps.
- Submission markers for own-editor exams on the review timeline (today only the external poller feeds `proctor_submission_events`).
- People-tab cross-round evaluation rollup; B6 behavioral-similarity port.
- Optional mirroring of conclusive flags as `proctor_alerts` (`source: contest-eval`, existing types `peer_copy_cluster`/`recurring_pair`) for invigilator-visible flows.
- Auto-evaluate on contest end; threshold settings UI (per-contest overrides, alert-settings pattern).

**Size:** ~1.5k LOC, only after P1+P2 prove out.

### Test/guard compliance summary (applies to every phase)

- **scopingLint:** all contest reads via `contests.mjs:scopedQuery`; no new raw `.where("contest_slug")` anywhere; allowlist untouched.
- **routesAuthLint:** new route modules live in `routes/`, exported functions named `admin*`, `requireAdmin(req)` as first statement (one sanctioned `*ContestOf` preamble max).
- **canary:** every new GET added to `SCOPED_GET_REQUESTS` with a canary request (none qualify for `EXEMPT_GETS`); dispatch-table lines follow the exact scanned string format.
- **envLint:** all new env via `config.mjs:loadConfig()`; zero `process.env` elsewhere.
- **Behavior-preserving elsewhere:** existing route bodies, Results semantics for unevaluated contests, selection machinery, and the recording-review queue are untouched; existing tests must pass unmodified.
- Full suite green at every commit; commits per task.

---

## 6. Open questions for the owner

1. **Action vocabulary.** Keep KEC's 7-action set (`REJECT-CHEAT / PEN-PAPER / AI-SUSPECT / ADVANCE / VERIFY-DESK / REJECT / NOT-ADVANCED`)? Is there still a pen-and-paper / desk-verify round in the new pipeline, or should those collapse into a single `INVESTIGATE`?
2. **Judge auth.** The plan reuses `x-admin-password` (consistent with the review queue). Want a dedicated revocable `EVAL_WORKER_API_KEY` instead, so a judging agent never holds the admin password?
3. **Numeric talent score?** The old playbook deliberately used tiers, never a blended number. Do you want an additional sortable 0–100 talent composite column, or tiers only?
4. **Trigger.** Evaluate strictly on demand (button), or auto-run at contest end / selection-done as well?
5. **Thresholds.** D1–D17 constants ship as fixed defaults in v1 (documented in the feature doc). Per-contest admin-configurable thresholds (alert-settings pattern): P3 or never?
6. **J5 coverage cost.** `talent-grade` generates one judgment per clean candidate with a med+ solve — the largest queue by far (~hundreds of items). Run it for everyone, only for shortlist-margin candidates, or skip in v1?
