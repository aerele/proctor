# Architecture decomposition plan (2026-06-11) — behavior-preserving god-file split

Karthi-approved (no approval gate; behavior-preserving; suite green at EVERY step). Execute AFTER the E2E green baseline. Goals (priority): (1) easy for AI to code, (2) maintainability, (3) performance, (4) security. Scope = the 3 god-files only; leave the already-organized domain modules/folders alone.

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
