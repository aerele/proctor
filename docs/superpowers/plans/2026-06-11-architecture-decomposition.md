# Architecture decomposition plan (2026-06-11) — behavior-preserving god-file split

Karthi-approved (no approval gate; behavior-preserving; suite green at EVERY step). Execute AFTER the E2E green baseline. Goals (priority): (1) easy for AI to code, (2) maintainability, (3) performance, (4) security. Scope = the 3 god-files only; leave the already-organized domain modules/folders alone.

> **READ §AMENDMENTS (v2, Fable-5 review) FIRST — it is AUTHORITATIVE and supersedes the v1 body below wherever they conflict.** v1 (Opus design) is the skeleton; v2 fixes two plan-breaking issues (W1 recursive-lint, W2 factory seam) and adds the real front-end/UI-hierarchy + new guards.

## Load-bearing constraints (the guards that bracket every commit)
1. **Backend tests import `handler.mjs?<buster>` and use ONLY:** `api`, `__setClientsForTest`, `__setJudge0AdapterForTest`, `__setExecClockForTest`, `__setAccessCodeClockForTest`, `__setRosterLookupClockForTest`, `checkRosterLookupRateLimit`, `__resetRosterLookupRateLimitForTest`. No test imports a route handler. → route bodies move freely; these symbols must stay resolvable from `handler.mjs` (re-export from wherever state lands). New modules MUST use `configure*Store({ getFirestore: () => firestore })` getter-injection so the test's fake-Firestore swap propagates (never capture `firestore` by value).
2. **`canaryIsolation.test.mjs` text-scans `handler.mjs`** for `req.method === "GET" && path === "..."` lines → **the dispatch table stays VERBATIM in `handler.mjs`**; only route *bodies* relocate. This makes the wire contract provably identical.
3. **`scopingLint.test.mjs` pins `LEGACY_ALLOWLIST = { "handler.mjs": 4 }`** — the 4 raw `.where("contest_slug")` sites (`findLiveSessionFor`, `endAllLiveSessions`, `resolveActionTargets`, `adminSessionDetails`) + `contests.mjs: 1`. When those functions move (B13/B14), re-pin the allowlist in the SAME commit. Most error-prone interaction; self-describing via the test's assertion.
4. **Frontend**: only `csvField.test.ts` imports `{ csvField }` from `./App`; only `admin/templateForm.test.ts` imports a type from `../api`. `uiStrings.test.ts` AST-bans rendered "username" across all of frontend/src (preserved since text moves verbatim).

## Target structure
### Backend: thin dispatcher + routes/ + lib/
`handler.mjs` stays the entry: env consts + `configure*Store` wiring + the `api()` dispatch table (verbatim) + test-seam re-exports. Route bodies → `routes/{session,exec,publicConfig,adminSettings,adminProblems,adminTemplates,adminContests,roster,adminSessions,adminStats,submissionEvents,results,adminPeople,dataLifecycle,alerts,review,invigilator}.mjs`. Shared helpers → `lib/{http,auth,clients,sanitize,settings,sessionStore}.mjs` + `config.mjs`. Route modules import from `lib/`+`config.mjs` only (no cycle back to handler).

### Frontend: lazy router + per-app entries + ui/ primitives (code-split)
`App.tsx` → tiny lazy router (`React.lazy` each of AdminApp / InvigilatorApp / CandidateRouter — candidate bundle never ships admin code → fixes >500kB chunk). Keeps `export { csvField } from "./ui/csvField"`. New: `candidate/{CandidateRouter,StudentApp}.tsx` + `candidate/panels/*`; `admin/AdminApp.tsx` + `admin/views/*` + `admin/csv.ts`; `ui/{Field,Shell,pills,tooltip,actions,csvField}`. InvigilatorApp/RecordingReview already separate.

### api.ts: real client by domain + isolated demo layer, behind a barrel
`api.ts` → barrel re-exporting `api/{core,session,admin,alerts,review,contests,templates,problems,roster,settings,results,invigilator}.ts` + `demo/{core,sessions,contests,templates,problems,alerts,review,roster,results,invigilator}.ts`. Consumers keep importing from `"./api"` (zero churn). Each client fn: `if (demoMode) return demoX(...); return request(...)`. Shared demo primitives in `demo/core.ts`.

## Sequenced moves (each = move verbatim → add imports → run suite → commit green)
**Backend** (order = safe leaves first, dispatch/raw-where last):
- B0 prep `lib/*` + `config.mjs` (move pure helpers; re-export `__setClientsForTest`/`__setJudge0AdapterForTest`; verify getter-injection). 
- B1 `routes/invigilator.mjs` (leaf, own tests) — proves the pattern incl. canary.
- B2–B12 one domain/commit: adminTemplates, adminProblems, adminContests, submissionEvents, results, adminPeople, alerts, review, publicConfig, exec, roster (re-export seams for exec/publicConfig/roster).
- B13 `routes/session.mjs` + `lib/sessionStore.mjs` (raw-where #1) — re-pin scopingLint SAME commit.
- B14 `routes/adminSessions.mjs` (raw-where #2,#3,#4) — re-pin scopingLint SAME commit.
- B15 mop-up + shrink `handler.mjs` to the thin dispatcher.
Run `canaryIsolation.test.mjs` after every backend step as the canary; full `npm test` each commit.

**Frontend** (independent; AFTER backend, or in a separate session to avoid same-repo commit races):
- F0 `ui/*` + `ui/csvField.ts` (re-export csvField from App.tsx). 
- F1 `candidate/panels/*` → F2 `candidate/StudentApp.tsx` → F3 `candidate/CandidateRouter.tsx`.
- F4 `admin/views/*` + `admin/csv.ts` → F5 `admin/AdminApp.tsx`.
- F6 collapse `App.tsx` to the lazy router (PERF + riskiest; keep pathname branch identical, wrap targets in lazy()+Suspense; `npm run build` confirms chunk split + tsc).

**api.ts** (independent): A0 `api/core.ts` → A1 `demo/core.ts` → A2–A8 per-domain demo+client pairs → A9 thin the barrel. `npx vitest run` each (esp. templateForm.test.ts when templates/types move).

## Riskiest moves + de-risk
- B13/B14 raw-where allowlist drift → caught by scopingLint; re-pin same commit, run it first.
- Dispatch table → never moves (canary text-scan protects it); run canary every backend step.
- `?<buster>` test isolation → getter-injection convention (B0).
- Circular imports → one-directional layering (lib/config → routes; barrel only re-exports).
- F6 lazy router (only runtime-composition change) → keep pathname logic identical; vitest + build + 3-route smoke.
- "username" CI gate → verbatim text moves can't introduce it.

## Conventions doc (write at the end)
Backend: handler.mjs = only HTTP entry (dispatch table never leaves it); route body per `routes/<domain>.mjs` calling its auth guard first; auth only in `lib/auth.mjs`; contest reads only via the resolveContest/scopedQuery chokepoint (raw `.where("contest_slug")` forbidden outside the pinned sites — re-pin scopingLint in the same diff); new state via getter-injection; new GET route → dispatch line + canary categorization.
Frontend: App.tsx = lazy router only; `ui/` = shared primitives; app-specific components under that app's folder; pure logic stays in shell/coding/roster/admin/results/people; no rendered "username".
api: `api.ts` = public barrel (consumers import only from it); real client `api/<domain>.ts`, demo `demo/<domain>.ts`; shared demo primitives in `demo/core.ts`.

(Full design rationale: agent task output ac405188 in this session's transcript dir.)

---

# AMENDMENTS (v2 — Fable-5 review, AUTHORITATIVE; supersedes v1 where conflicting)

Measured reality: handler.mjs ~6.9k LOC, App.tsx ~6.0k LOC, api.ts ~4.9k LOC; build today = one 573 kB `index.js`. Four amendments are mandatory before execution.

## A1 (CRITICAL) — make `scopingLint` recursive BEFORE any file moves
`scopingLint.test.mjs` scans only top-level `backend/src/*.mjs` (`readdirSync(SRC_DIR)`). The moment routes move into `routes/`, the contest-scope guard goes BLIND (passes while ignoring every raw `.where("contest_slug")` under `routes/`). **In B0, first change the lint to walk subdirectories recursively.** Then B13/B14 re-pin `LEGACY_ALLOWLIST = { "routes/session.mjs": 1, "routes/adminSessions.mjs": 3 }` (final counts decided by where `endAllLiveSessions` — called from `adminExamTime` — lands).

## A2 (CRITICAL) — route modules are FACTORIES, not configure-mutated singletons
`backend/test/invigilator.test.mjs` imports the handler 3× in one process (`?invigilator`, `?invigilator-nopass`, `?invigilator-badcap`) to prove env-capture-at-load, and KEEPS USING the first instance (`h1`) after `h3` evaluates. A `configure*Store(...)` call mutates SHARED module state → after h3, h1 reads h3's config + fake Firestore → later tests fail. **Pattern:** each route module exports `export function makeXRoutes(ctx){ const {requireInvigilatorFor, getFirestore, getSettings, ...} = ctx; async function routeA(req){...} return { routeA, ... } }`. handler.mjs (re-evaluated per buster) reads env → builds `ctx` (env consts by value to reproduce capture-at-load; `getFirestore: () => firestore` for the mutable client; judge0/execQueue/clocks as getters) → instantiates every factory at module scope → dispatch lines stay byte-identical (`await routeA(req)` resolves the destructured instance). Seams in moved state come back as factory returns + are re-exported (`export const { checkRosterLookupRateLimit, __resetRosterLookupRateLimitForTest } = rosterRoutes`). The ONLY systematic non-verbatim edit is `firestore.`→`getFirestore().` (~56) + storage (~18), already implied. **`lib/auth.mjs` and `lib/sessionStore.mjs` are ALSO factories** (`makeAuth({adminPassword,invigilatorPassword,gateAttemptLimit})`, `makeSessionStore(ctx)`) — they close over env/firestore/collections. Only genuinely stateless helpers are plain imports: `lib/http.mjs` (send/setCors/httpError/badRequest/parseBody/requireFields), `lib/sanitize.mjs` (sanitizeObject/normalizeUsername/normalizeIp/maskEmail/safeEqual/hashPasscode/mapWithConcurrency).

## A3 — three new cheap CI guards (turn the reshuffle into a measurable win)
- **`routesAuthLint.test.mjs`** — text-scan `routes/*.mjs`: every exported `admin*`/`invigilator*` route body begins with its `require*` guard (auth-first by CI, not convention). Add after B1.
- **env-lint** — assert `process.env` appears nowhere under `routes/`/`lib/` (env reads stay in handler.mjs/config.mjs — this is what keeps the `?buster` semantics permanent). Add in B0.
- **candidate-bundle credential grep** (frontend, per F-commit + CI): the built candidate chunk must NOT contain `x-admin-password` / `x-invigilator-password` (proves admin code + creds never ship to candidates — serves goals 3 & 4; the frontend analogue of the canary).

## A4 — backend granularity refinements
- `routes/session.mjs` (~2k LOC) is still a god-file → split THREE ways: `routes/session.mjs` (start/resume/end/validate-end + person resolution + live-slot locks), `routes/sessionTelemetry.mjs` (upload-url/events/editor-events/review-file/heartbeat/beacon), `routes/sessionGates.mjs` (room-gate/enforcement-violation/unlock-gate).
- Shared DOMAIN logic (not transport): `reconcileFullscreenEnforcement`/`applyEnforcementViolation` (heartbeat + violation routes) → new flat `src/enforcement.mjs`; `raiseSureShotAlertsFromEvents`/`upsertProctorAlert`/`mergeAlertSettings` (events/heartbeat/alerts) → new flat `src/proctorAlerts.mjs`. These join the EXISTING domain layer (next to contests.mjs/identity.mjs) as factories/pure-fns — NOT `lib/` (lib = infra only).
- Rename `routes/publicConfig.mjs` → `routes/public.mjs`. Keep the if-chain dispatcher (canary makes it the provably-stable contract). Deliberately **NO** service layer / shared-contracts package / auth-middleware (each is a rewrite or edits the canary-protected table for zero gain). Dependency direction (write into conventions): `handler.mjs → routes/* → (src domain modules, lib/*)`; routes never import routes; domain modules never import routes/lib-http.

## A5 — api.ts refinements
- KEEP barrel + per-domain client + `if (demoMode) return demoX(...)`. **REJECT a runtime adapter interface** — `demoMode` is a build-time constant (`import.meta.env.VITE_DEMO_MODE`), so the static per-fn `if` is what lets Rollup tree-shake the ~1.8k-LOC demo layer out of the candidate bundle; an interface object would ship it always. Enforce a **mirror-signature convention** (each `demo/<domain>.ts` export = identical signature/return as its real counterpart; each real fn's demo branch is exactly one line).
- Demo internal design: `demo/core.ts` (store accessors/keys, demoApiError, assertDemoAdmin, normalizers) + **`demo/seeds.ts`** (ALL `DEMO_*` constants in one place — they're interrelated; per-domain splitting creates cycles) + `demo/<domain>.ts` importing core+seeds + a DECLARED one-way DAG (contests←session; sessions←stats/attendance/recordings). No top-level localStorage reads (keep side-effect-free for tree-shaking).
- A0 carries `api/types.ts` (move api-defined DTOs: ApiError/ContestTemplateDetail/ReviewRecord/…) + barrel re-exports the types (the `templateForm.test.ts` `import type … from "../api"` pin). `request`/`apiBaseUrl`/`adminPassword(Hash)`/`sha256Hex`/`uploadBlob`/`sendSessionBeacon` → `api/core.ts`. No backend type-sharing now (future contracts bridge — leave a marker comment).

## A6 — FRONT-END architecture (supersedes v1 §1B; this is the real story)
- **Candidate side STAYS EAGER.** Only `React.lazy` `AdminApp` + `InvigilatorApp`. `CandidateRouter` may be its own chunk but everything candidate-side inside it (StudentApp, MultiProblemWorkspace, panels) is STATICALLY imported — no nested lazy on the candidate path. Reason: a mid-exam lazy-chunk 404 (flaky lab net, or a redeploy invalidating hashed chunk names against a stale index.html) cascades into enforcement violations + locks. Load-once-offline-tolerant is a feature here.
- **F6a (do BEFORE F6, biggest single win):** `React.lazy` `RecordingReview.tsx` (2.1k LOC, eagerly imported, admin-Recordings-tab-only) INSIDE AdminApp. Router split + this likely cuts candidate first-load ~45-55%; record actual before/after `vite build` chunk sizes in the commit.
- F6 mechanics: Suspense fallback must replicate the exact existing `<main className="flex min-h-screen items-center justify-center"><p className="text-sm text-muted">Loading…</p></main>`; keep `App()`'s pathname branch a pure pre-hooks expression. Frontend has near-zero component-test coverage → **the build + a 5-route manual smoke (`/`, `/?contest=slug`, bad `?contest=`, `/admin`, `/invigilator`) ARE the safety net** (say so honestly). Review every F-move with `git diff --color-moved=dimmed-zebra`.
- Container/presentational: candidate panels are already props-driven (clean moves). DON'T extract logic out of StudentApp (effect-ordering risk) — only NAME the sanctioned future shrink hooks in conventions (`useSessionLifecycle`/`useIdentityLookup`/`usePermissionAcquisition`, continuing useExamShell/useEnforcement). Admin: move old hoisted-state tabs as presentational `admin/views/*` keeping state in AdminApp; declare the end-state convention = every tab converges on the smart-panel contract `{password, contestSlug, ...callbacks}`. Introduce NO React context during the move; sanction one FUTURE `AdminScope` context (password+contestSlug+contests) in conventions.

## A7 — UI HIERARCHY (the explicit ask) — layer + per-app trees
```
frontend/src/
  ui/                 # domain-free, NO api calls
    tokens.ts         # Tone type ("accent|danger|warning|muted|ink") + tone→class maps; documented recipe constants
    primitives/       # Field, FilterSelect, StatusPill, SeverityPill, StatCard, Metric, Tooltip(=ActionTooltip)
    layout/           # Shell
    composites/       # starts EMPTY — only provably-shared multi-primitive assemblies
  lib/ csv.ts         # csvField (M8 escaper) — NOT ui/. App.tsx re-exports for csvField.test.ts
  candidate/  CandidateRouter, AccessCodeLanding, StudentApp, panels/*(IdentityCard, IdentityLookupPanel, RoomField, RoomCodePanel, UnlockCodePanel, EndTestPanel, EndRetryPanel, ScreenShareErrorPanel, CameraSelfView, HealthPanel, EntryReviewPanel, PreStartRules, RulesPanel, WhatIsRecordedPanel, BlockedScreen, EventRow)
  admin/      AdminApp, AdminTab, ContestSelectorBar, csv.ts, actions.tsx(ActionButtons/ActionGroup/SessionActionButton/BulkActionButtons — admin-domain, NOT ui/), views/*(StatsDashboard, ExamTimeCard, SessionsView, SessionDetailCard, AlertsConsole(+AlertRow,AlertField), IpReportView(+IpCandidateRow,RoomFilter), AttendancePanel, SettingsView(+CandidateRosterSection,ReviewRosterSection,ProctorAlertTypesSection,ContestEvalAlertTypesSection))
  invigilator/ AdminApp-symmetry: move InvigilatorApp.tsx in (1 import edit)
  shell/ coding/ roster/ results/ people/ attendance/ problems/  # UNTOUCHED
```
Two misfiles corrected: `csvField`→`lib/csv.ts`; action buttons→`admin/actions.tsx`. Design tokens already healthy (tailwind ink/muted/panel/line/accent/warning/danger, Inter/JetBrains, focus-ring) — **do NOT touch values**; only document recurring recipes (card `rounded-lg border border-line bg-panel p-5 shadow-subtle`, overline `text-xs font-semibold uppercase tracking-wide`, body `text-sm leading-6 text-muted`, button primary, the Tone status vocabulary) + adopt in NEW code only (no consistency sweep over live exam UI). Follow-up backlog (NOT during the move): consolidate the 4 drifted `csvField` copies (App.tsx/attendance/people/results) into `lib/csv.ts`; rename cross-app near-dupes apart (Shell vs PortalShell; StatCard/StatTile/SummaryStat; the two AlertRows).

## A8 — sequencing fixes
- **B0 carries** (in order): (a) recursive scopingLint (A1) BEFORE any move; (b) factory/ctx seam + makeAuth (A2); (c) move `lib/sessionStore` (factory) UP from B13 — getSession/sessionRef/getSettings/requireWritableSession are used by nearly every route, so moving them late forces re-touching B1-B12. `findLiveSessionFor`'s raw-where still moves at B13 with its re-pin; only the neutral store helpers move early. (d) env-lint guard.
- **B1 = invigilator** — not the "safe leaf" but the HARDEST test file (only 3-buster instance-reuse); the right pattern-prover GIVEN the factory seam. Run `node --test test/invigilator.test.mjs` explicitly in B0+B1 verification.
- Backend then frontend then api, each as its own phase; do NOT run two phases as concurrent workflows (same-repo git index races) — serialize.
- Conventions doc (write at end) adds: factory/ctx rule + "no process.env outside handler/config"; routes dependency direction; demo mirror+DAG; ui import rules + tone/recipe catalogue; named future hooks + smart-panel target; the follow-up backlog.
