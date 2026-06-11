# PROCTOR — SINGLE SOURCE OF TRUTH (resume anchor)

**This is the ONE place. Read this first after any break/compaction.** Everything else is either the feedback ledger, deploy reference, evidence, or archived history — all linked at the bottom. No other "todo"/"resume"/"status" doc is authoritative.

_Last updated: 2026-06-11 (after F12). Maintainer: keep this current; archive, don't duplicate._

---

## 0. RIGHT NOW (state)
- **Repo** `/home/karthi/arogara/proctor`, branch **master**, HEAD **49af4f1** (= product c762877 + 7 behavior-preserving decomposition commits B0/B1 on top; product behavior identical to the deployed rev 00006). ~156 local commits. **NEVER pushed** (see §4 push gate).
- **Timeline:** the real 700-candidate exam runs on the **OLD proctor (HackerRank)**; THIS platform targets the **2026-06-12 live test** — that readiness is now the priority. **No rush, no rushed deploy.**
- **⏸ Architecture decomposition PAUSED (Karthi TG 1837, 2026-06-11):** B0+B1 DONE + green (backend 705/705, tree clean, HEAD 49af4f1), rest **slated for AFTER the test** — restructuring isn't essential to it. Resume at **B2** (plan doc has a PAUSE/RESUME banner). Memory: `proctor_architecture_decomposition`.
- **▶ NOW — OVERNIGHT AUTONOMOUS RUN (Karthi asleep, TG 1855, 2026-06-11 ~22:25 IST). His order, verbatim priority:**
  (1) **Finish ALL walkthrough fixes** in `night-run/WALKTHROUGH-FIXES.md` (M0, W1–W5) — implemented, tests green, committed locally.
  (2) **Deploy** to Cloud Run dev (`gcloud run deploy --update-env-vars` ONLY — never `--set-env-vars`, it wipes Judge0/invigilator/admin env).
  (3) **Exhaustive browser E2E of the DEPLOYED product** via Chromium **:9222 (Karthi opened the port)** — candidate flow above all (onboarding → fullscreen → problems → editor → run/submit → fullscreen-exit/alert behavior → verify keystroke+event data lands in the backend), plus admin + invigilator sanity. Every bug → fix → verify → commit → redeploy → retest until one full clean pass. "I don't want any surprises."
  (4) **Triple review** (code + UX + security/PII) + **morning summary** in night-run/.
  (5) **Stretch ONLY after 1–4 green:** F2/F2.1 OMR overlay-detection (PRODUCT-BACKLOG.md, task #62).
  F11 docs DONE (committed `eeddfb9`, workflow finished). Keep a **morning-discussion list** of uncertain calls (§1b).
- **Agents in flight:** candidate agent (W1+W2+W5) + admin agent (W3+W4+M0), both relaunched after a 529-Overloaded API incident killed the first attempts (tree was verified clean, zero partial edits). If an agent dies abnormally again: verify via `git status` + JSONL tail, never trust completion claims.
- **Commit rule (active):** coordinator owns commits, serialized; **never push**.
- **Mode:** Karthi ASLEEP since TG 1855. Work autonomously to completion; CLI replies (he'll read terminal in the morning); ping Telegram only for a genuine blocker. No blockers outstanding.
- **Mandate (TG 1789/1791/1795):** finish ALL build, then **persona-driven end-to-end browser test of EVERY feature + screenshot-document each** (= the docs), fix→redeploy→retest until a confidently-shippable product (happy path + obvious flows must obviously work). Truth bar: "if the docs say it works, it works." Full detail in memory `proctor_e2e_test_docs_mandate`.
- **Tests green at HEAD:** backend **703/703**, frontend **625/625**, `npm run build` clean.
- **Deployed (aerele-proctor-dev):** ✅ CURRENT (2026-06-11) — api rev `proctor-api-00006-pjr` + web rev `proctor-web-00006-d66` = HEAD c762877 (build + E2E fixes). Env preserved + `RETENTION_SWEEP_API_KEY` added; gcs-lifecycle (evidence 3d / exports 11d) + CORS applied. Smoke PASSED (web 200; exam-config new fields; Wave6/7 routes /api/admin/{people,contest-results,contest-export,retention-sweep} all 401-live). URLs: web `https://proctor-web-ej4cpz43iq-el.a.run.app` · api `https://proctor-api-ej4cpz43iq-el.a.run.app` (both also reachable at the 238846959672 form). min-instances default 0 (testing); set 1 for the real exam. Exam window set per real contest at seed time.

## 1. EXACT PLAN (ordered — this is the remaining work)
1. **Doc cleanup** — DONE 2026-06-11 (this consolidation; you're reading the result).
2. **Wave 6 — ✅ DONE** (517180c..39bff83; backend 650 / frontend 562; the adversarial review CAUGHT + FIXED a real exam-day bug — the M3 roster-lookup limiter would have 429'd a whole NAT'd hall at login). Built: S-J (Results tab: rank/per-problem/integrity/bulk-select + selection-done; People tab + cross-round scorecard; legacy person backfill) **+ decisions batch #43** (checkpoint REMOVAL; D1 → save-time confirm dialog; invigilator alerts per-type "Share with invigilator" checkbox DEFAULT ALL OFF; M3 roster-lookup rate-limit; M6 verify+close) **+ email-format validation** (F12 review low-finding: candidate email currently unvalidated — add a lightweight regex gate client `candidateFormReady` + server start handler) **+ accumulated review minors** (exec in-flight guard race, resume slug translation, alerts scoped-branch orderBy caveat, roster PII orphans, zero-problem edit guard, demo cross-contamination, language allowlist at exec, F12 orphan-stub one-liner).
3. **Wave 7 — ✅ DONE** (d4e6571..131eeb1; backend 694 / frontend 582; the data-safety review caught + fixed a real PII bug — a blanket 3-day GCS rule would've deleted recovery export zips 7 days early — plus 2 purge crash/staleness hazards). Built: lifecycle backend+UI (export → triple-gated purge → tombstone; retention sweep; 10-day zip delete) + S-E HR cleanup. **S-F contest-eval adapter LAST** (deferred).
   **➡ DONE: deploy (rev 00006 = c762877), E2E persona testing (4 personas — verdict: product works end-to-end; 1 HIGH recording-review bug found+FIXED + Templates-CRUD gap built + clipboard/cosmetics), E2E fix wave (703/625), redeploy + recording-review re-test. NEXT ACTIVE: architecture decomposition (#56) → finale (#57: triple review + docs/runbook + summary). S-F contest-eval (#32) LAST.**
   Real test contest LIVE on the dev stack: `e2e-test-round-1`, access code 2V6CIQ, candidate `…/?contest=e2e-test-round-1`, invigilator `…/invigilator?contest=e2e-test-round-1&key=REDACTED-ALERTS-INGEST-KEY` (Asha Rao/TEC001 has a recorded+locked session). E2E evidence + verdict: `night-run/evidence/e2e/` (E2E-FINDINGS.md).
4. **Deploy + seed a REAL test contest** — build+deploy both images at current HEAD to aerele-proctor-dev with exam env config (#49: EXEC_SUBMIT_COOLDOWN_SECONDS≈20, EXEC_MAX_SUBMISSIONS_PER_SESSION≈200, generous lanes), set a fresh exam window, then template → contest → fabricated roster (with college column) → rooms → access code + invigilator links → author a few real questions with hidden tests (easy+medium).
5. **E2E persona browser testing + docs** — drive the DEPLOYED stack in a real browser as Admin / Candidate / Invigilator (serial — one Chrome on :9222), screenshot + truthfully document EVERY feature (= F11 docs #39). Fix anything broken → redeploy → retest until clean. Personas/flows detailed in memory `proctor_e2e_test_docs_mandate`.
6. **Finale** — triple review (repo code review + independent UX lens + security/PII) + **#40 1-page ops runbook** + **#39 full docs/README** + morning summary to Karthi (incl. judgment calls + the one item needing him: email-autofill confirm on his browser).

## 1b. OPEN QUESTIONS / DECISIONS TO CONFIRM WITH KARTHI (morning list — non-blocking; sensible defaults already shipped)
- **D1 warn-on-save trigger (CONFIRM):** exact trigger wasn't recoverable. SHIPPED: saving an edit to a PUBLISHED problem referenced by an OPEN/active contest → confirm dialog "affects N running contest(s)". Open: (a) wording by live SESSION count vs contest count (shipped: contest count); (b) extend the confirm to contest window/settings saves too (shipped: NOT — those already have S-I guards); (c) a different live condition.
- **Architecture decomposition (AWAITING GO-AHEAD):** I recommended a targeted split of the 3 god-files (handler.mjs 5.9k / App.tsx 5.9k / api.ts 4.2k) + dir regroup + conventions doc — NOT a rewrite — to run AFTER the E2E test pass. Karthi to confirm; I'll hand him a file-by-file target before moving anything. Rationale: it's why parallel builds must run serial today.
- **M6 clipboard primer (FYI):** setup still calls clipboard read ONCE to trigger the browser GRANT (needed for in-exam capture) but now stores NOTHING (no text, no length). Alternative = drop the primer + risk a mid-exam permission prompt (the thing F5.1 avoids). Shipped the privacy-preserving middle path.
- **People/adopt UX (veto-able):** People directory caps fan-out at 500 persons/response (narrow via search first); "Adopt into person model" is a collapsible section under the contest roster, not a top-level button.
- **requireAdmin timing-safe:** ✅ DONE in Wave 7 (switched to safeEqual).
- **Purge typed-confirm = SLUG vs NAME (CONFIRM):** the purge gate makes the admin type the contest SLUG; F9 D12 originally said the NAME. Shipped slug; one-line switch if you prefer name.
- **Export-zip retention = 10 days (CONFIRM):** a purged contest's recovery archive auto-deletes ~10 days after last export (UI says so; GCS backstop at 11d). Confirm 10 stands.
- **Legacy start input (FYI):** now accepts candidate_id OR hackerrank_username (synthesizes the frozen key); did NOT make candidate_id the ONLY accepted input (keeps back-compat). External-HackerRank candidate copy stays (renders ONLY in legacy ownEditor=false mode); fully retiring that legacy external-HR flow is a separate product call.
- **Person-mode reviewer-QUEUE (SCOPE CALL — E2E #1a):** the recording PLAYER (admin picker + Sessions "View recording" deep-link) now resolves person-mode sessions ✅ (fixed in 78dd322). But the distributed reviewer-WORKFLOW QUEUE (serveNext/rewatchReview + the review roster/claims/verdicts pipeline) is still candidate-norm-keyed → person-mode review-queue doesn't resolve. Fixing needs person_id threaded through roster→claims→verdicts→serve. Is the distributed reviewer queue even in scope for person contests, or is the (now-working) picker path enough? Confirm before building.
- **Person-mode submission MARKERS (small follow-up):** the green/red submission dots on the recording timeline don't populate for person mode (adminSubmissionEvents re-normalizes candidate-id; same B1 pattern, ~small fix). Non-blocking; playback/events/alerts all work. Bundle with the reviewer-queue decision.

## 2. WHAT'S DONE (high level; detail in git log + feedback ledger)
- **Day 1 (2026-06-09→10):** own-editor slices S1-S7 — candidate Monaco workspace + Judge0 swap-able adapter (Run/Submit, verdicts) + full event capture to GCS; roster + unique-ID login; fullscreen-first onboarding; invigilator portal (OTP/start-now/room stats/selective alerts); problem authoring; dynamic time + end-now; attendance stats; IP report. Admin-polish batch. First deploy to aerele-proctor-dev + live Judge0 smoke.
- **Day 2 (2026-06-10→11):** F5 exam-shell enforcement rework (permissions-first stages, hard-block ladder, switch-away debounce, status-bound timer); F6 admin batch (bulk select/archive + grouping, session detail card, recordings timeline, action rework); F7 encoding research (discuss-first, deferred); F8 (IP drill-down, roster template CSV, multi-test); F9 invigilator UX + identity/data-lifecycle design; F10 camera recording (separate low-res stream, default ON) + product-vision spec (BUILD TARGET); entity spine **S-A** (candidate-id rename) / **S-B** (contests collection) / **S-C** (person identity: colleges/persons/enrollments, person_id="{college}~{uid}") / **S-D** (Contests tab, global selector, ?contest= routing, access-code landing, tokenized invigilator portal) / **S-I** (multi-problem workspace, per-problem exec/cooldowns/scoring); capacity RESOLVED (stay on RapidAPI, load probe passed $0.99, self-host dead); **F12** (email-autofill→fullscreen fix, per-problem per-language stubs, curated editor autocomplete).

## 3. CAPACITY — RESOLVED (stay on the RapidAPI key)
- Billing EMPIRICALLY per batch CALL ($0.0017; poll GETs free). Real KEC data (700 users): ~13 submits/candidate → event ≈ **$22-60**.
- Load probe RUN+PASSED (580 calls ≈ $0.99): 0 errors at 10/30/60 calls/s; verdict p90 11-19s even at ~720 offered exec/s (2.4× worst burst). SELF-HOST DEAD; no IAM grant needed.
- Deploy-time knobs (env, not code): EXEC_SUBMIT_COOLDOWN_SECONDS≈20, EXEC_MAX_SUBMISSIONS_PER_SESSION≈200, generous lane concurrency; hidden tests ≤12 advised.

## 4. STANDING RULES
- **NO git push EVER** until Karthi runs the PII history scrub (verdict-queue PII in history at acdba86 — see archived `AUDIT-REPORT.md`). Local commits only. Deploy does NOT need push.
- **Deploy is authorized** (proctor-deployer). Deploy when testing requires; no surprise redeploys otherwise.
- Telegram mode = plain prose, no headers/bullets, reference items by bare number.
- Build process: spec → TDD → local commit per slice → adversarial review → browser walkthrough → demo-mode parity. Workflow orchestration with serial builders on hot files (App.tsx, handler.mjs), parallel review fan-out.
- **Email-autofill fix (F12.1) needs Karthi's own browser** (saved autofill data) for definitive confirm — document as fixed+self-verified, pending his one click.

## 5. ENVIRONMENT / FACTS
- gcloud `~/google-cloud-sdk/bin`, authed `proctor-deployer@aerele-proctor-dev.iam.gserviceaccount.com`.
- Secrets (gitignored): `.env.deploy.local` (ADMIN_PASSWORD, INVIGILATOR_PASSWORD, API_URL), `monitoring/.data/judge0.env`, `monitoring/.data/gcp-dev.env`.
- Deployed URLs: web `https://proctor-web-238846959672.asia-south1.run.app`, api `https://proctor-api-238846959672.asia-south1.run.app` (api `/` returns 404 by design; routes are `/api/*`).
- Frontend deploy build needs `VITE_API_BASE_URL` + `VITE_ADMIN_PASSWORD_HASH` + `VITE_INVIGILATOR_PASSWORD_HASH` (sha256 hex lowercase of the two passwords).
- Image build/deploy: `gcloud builds submit backend|frontend --tag asia-south1-docker.pkg.dev/aerele-proctor-dev/proctor/{api|web}:latest --async` then `gcloud run deploy`.
- **Wave-7 deploy additions:** set `RETENTION_SWEEP_API_KEY` (openssl rand -base64 32) on the api; apply `backend/gcs-lifecycle.json` (evidence prefix age 3 / exports prefix age 11); create a daily Cloud Scheduler job → `POST /api/admin/retention-sweep` with header `x-api-key`. Watch for a Firestore composite-index prompt on the first big export/purge.
- Tests: backend `cd backend && npm test`; frontend `cd frontend && npx vitest run && npm run build`.
- Browser testing: chrome-devtools MCP on :9222 (Chrome 149 up); media-API stubs via `navigate_page` initScript; Monaco typing ONLY via `editor.trigger('keyboard','type',{text})`.
- CI guard: `frontend/src/uiStrings.test.ts` bans the rendered word "username".

## 6. LINKS (the rest lives here — not duplicated above)
- **Feedback ledger** (every Karthi feedback round F1-F12, with decisions): [`../TODO-admin-polish.md`](../TODO-admin-polish.md)
- **Product backlog** (deferred work — do later, NOT for the test): [`../PRODUCT-BACKLOG.md`](../PRODUCT-BACKLOG.md)
- **Live walkthrough fixes ledger** (current working mode + protocol): [`WALKTHROUGH-FIXES.md`](WALKTHROUGH-FIXES.md)
- **Build-target spec** (F10 product vision incl §10 answers): `docs/superpowers/specs/2026-06-10-f10-product-vision.md`; identity/lifecycle: `2026-06-10-f9-identity-data-lifecycle-design.md`; S-I detail: `2026-06-10-s-i-multiproblem-detail-spec.md`
- **Deploy / GCP from-scratch setup:** [`GCP-SETUP-INSTRUCTIONS.md`](GCP-SETUP-INSTRUCTIONS.md)
- **Evidence screenshots** (seed for docs): [`evidence/`](evidence/)
- **E2E test+docs mandate** (personas, flows, venue decision): memory `proctor_e2e_test_docs_mandate`
- **GCP dev project facts:** memory `proctor_gcp_dev_project`
- **Archived day-1 (2026-06-09) build docs** (GOAL, TODO checklist, NIGHT-LOG, MORNING-NOTES, root RESUME, consolidated AUDIT-REPORT): [`archive-2026-06-09-build/`](archive-2026-06-09-build/)
- **Unrelated leftover** (different project, ignore): `archive-2026-06-05-sshgate-v12/`
