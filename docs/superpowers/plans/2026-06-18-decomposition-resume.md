# Architecture Decomposition — Resume Reconciliation (2026-06-18)

Companion to `2026-06-11-architecture-decomposition.md` (the original plan). This reconciles that plan against the current code after the exam-eve work, per Karthi's instruction (re-read → reconcile → update → only then execute, behavior-preserving + product-usable at each step). Branch: `refactor/decomp-resume` (cut from deployed master `f7a59ff`).

## Baseline (verified green)
backend **863/863**, frontend **779/779**, build OK. Guards intact: `canaryIsolation`, `scopingLint` (`{handler.mjs:4, contests.mjs:1}`, recursive), `routesAuthLint`, `envLint`.

## Done-state
- **B0 done** (e44ff44, 294b77f, 943430a, 9d8d875, 29da74a, 0dc1ae6): `lib/http.mjs`, `lib/sanitize.mjs`, `lib/clients.mjs`, `lib/auth.mjs` (makeAuth factory), `lib/sessionStore.mjs` (makeSessionStore factory), `config.mjs` (loadConfig), recursive scopingLint + envLint.
- **B1 done** (ff88c91): `routes/invigilator.mjs` (makeInvigilatorRoutes) + routesAuthLint.
- **EVAL domain already extracted by the exam work** (good drift): `routes/evaluation.mjs` (makeEvaluationRoutes) + `evaluation.mjs`/`evaluationMetrics.mjs`/`evaluationReplay.mjs`/`evaluationClone.mjs`. Treat as a COMPLETED B-phase; do not re-plan.
- **Stale doc-banner hashes** in the original plan (pre-rewrite) — bookkeeping only; live anchors above.
- Drift: handler.mjs 6162→**6486**, App.tsx→**6516**, api.ts→**5195**, build 573kB→**766kB** (raises F6/F6a leverage). AdminApp is PRE-SHRUNK (admin/ panels already extracted → F4/F5 smaller).

## Extraction pattern (every backend phase; proven by B1/eval)
`routes/<domain>.mjs` exporting `make<Domain>Routes(ctx)`; move route bodies VERBATIM; deps via ctx (env consts by value, `getFirestore` as getter, helpers by reference); instantiate at handler module scope; destructure so dispatch lines stay BYTE-IDENTICAL (canary META test scans them); re-export any `__set*ForTest` seams from handler.mjs. **Verify each phase:** full `node --test` + all 4 guards green; commit only on green; product provably usable (dispatch + wiring unchanged). Serialize (no concurrent worktrees — git index race).

## Updated B2+ ladder
| Phase | Scope (handler lines → module) | Risk | Tonight? |
|---|---|---|---|
| B2 | adminTemplates 2196-2379 → `routes/adminTemplates.mjs` | Low | **YES** |
| B3 | adminProblems 2062-2195 → `routes/adminProblems.mjs` | Low | **YES** |
| B5 | submissionEvents 3360-3495 → `routes/submissionEvents.mjs` | Low | **YES** |
| B6 | adminStats 3496-3570 → `routes/adminStats.mjs` | Low | **YES** |
| B7 | adminPeople 4672-4803 → `routes/adminPeople.mjs` | Low | **YES** |
| B4 | adminContests 2380-2564 + instantiateTemplatePayload | Low-med | morning (many ctx deps) |
| B8 | results 3985-4133 (read/compute trio ONLY; keep selection/adopt/export cluster) | Med | morning (helper-graph boundary) |
| B9 | `src/proctorAlerts.mjs` + `routes/alerts.mjs` (5489-5957) | **Med-high** | **MORNING — shared w/ heartbeat; live-exam-critical** |
| B10 | `src/enforcement.mjs` + `routes/sessionGates.mjs` (5958-6230) | **Med-high** | **MORNING — live-exam-critical** |
| B11 | review 5026-5488 → `routes/review.mjs` | Med | morning |
| B12 | public/exec/roster (carry clock seams — re-export) | Med | morning (seam discipline) |
| B13 | session lifecycle 480-1230 split + raw-where `findLiveSessionFor` + scopingLint re-pin | **High** | **MORNING — riskiest** |
| B14 | adminSessions 3023-3359 + 3 raw-where + final scopingLint re-pin to `{}` | **Highest** | **MORNING — Karthi's call on end-state** |
| B15 | mop-up (handler → dispatcher + wiring + conventions doc) | Low | after B14 |
| Frontend F0-F6 + api A0-A9 | separate session; F6/F6a lazy-load = perf win but **product-risk near live exam** | — | **MORNING (F6 needs Karthi: no live exam window)** |

## Tonight's autonomous scope
Execute **B2, B3, B5, B6, B7** on this branch (behavior-preserving, leaf, own test files, no raw-where, no exam-critical helpers; "obvious fixes: just do"). One at a time, full suite + 4 guards green per phase, commit each. Everything else → morning ratification + merge (Karthi's calls flagged above). The branch stays UNMERGED (does not touch the deployed/exam code) until Karthi ratifies.

## ✅ TONIGHT'S PROGRESS (2026-06-18, autonomous)
ALL 5 safe phases DONE — behavior-preserving, each independently green (backend 863/0, frontend 779/779, tsc clean) + committed on this branch:
- **B2** adminTemplates → `routes/adminTemplates.mjs` (b8c9cea)
- **B3** adminProblems → `routes/adminProblems.mjs` (5703975)
- **B5** submissionEvents → `routes/submissionEvents.mjs` (62febda)
- **B6** adminStats → `routes/adminStats.mjs` (3e12243)
- **B7** adminPeople → `routes/adminPeople.mjs` (9277a58)

handler.mjs: **6486 → 6041 lines** (≈445 extracted into 5 focused route factories mirroring invigilator/evaluation). Dispatch table byte-identical throughout; all guards (canary/scopingLint/routesAuthLint/envLint) green every phase; shared helpers kept single-source (passed via ctx, never duplicated).

Branch `refactor/decomp-resume` pushed to origin, UNMERGED — for Karthi's morning ratification + merge.

REMAINING (need Karthi's input — see Open questions): **B4**, **B8–B15** (esp. B9/B10 enforcement+alerts shared-helper threading; B13/B14 raw-where migration + scopingLint re-pin end-state), frontend **F0–F6**, api **A0–A9**.

## 🔁 ON RESUME (Karthi instruction, 2026-06-18 — refactor SLATED, likely tomorrow after the test, before release)

The codebase WILL have moved since this reconciliation. Do NOT re-review the whole plan/codebase from scratch each time. Instead:
1. **Marked baseline = master `f6887df`** (the tip this reconciliation read; safe phases B2/B3/B5/B6/B7 sit on top in `refactor/decomp-resume`). The exam-fix code deployed today is this state.
2. On resume: run `git log f6887df..<then-current-master>` and do a **commit-by-commit diff analysis** of what changed since the baseline. Update THIS plan (B-ladder line ranges, new god-file growth, new domains, any new code that landed inside the targeted blocks) from the DIFF ONLY. Re-run the deep review only for the parts the diff actually touched — not the whole codebase.
3. Re-verify the guards + full suite are green on the new base before continuing the next phase.
This keeps resume cheap (diff-driven) instead of a full re-review every time.

## Open questions for Karthi (morning)
1. B9/B10/F6 touch enforcement/recording/lazy-load — confirm no live-exam window before merging+deploying them.
2. B8 boundary: extract only read/compute results; keep selection/adopt/export cluster together — confirm.
3. B13/B14 scopingLint end-state: do the 4 raw-where sites migrate THROUGH scopedQuery, or move-with-their-pin? (target allowlist `{}` vs `{routes/...:n}`).
4. Confirm eval-routes = a completed phase (not re-planned).
5. Update the ORIGINAL plan doc's stale banner hashes + B-ladder line ranges when convenient (not done — kept original intact; this file is the live addendum).
