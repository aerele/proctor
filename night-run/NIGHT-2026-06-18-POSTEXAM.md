# Night run — 2026-06-18 (post-exam) — Proctor

**Goal:** execute the ordered list below to completion. Don't stop until done or genuinely blocked on Karthi.

**Operating model:** Fable 5 coordinates (plans / dispatches / verifies); subagents do the reading/coding/testing (Opus floor for judgment work). I stand in Karthi's place — the bar is that things actually work end-to-end, not that work was dispatched.

**Baseline:** `origin/master` = `4b2be10` (after the conductor one-pager, PR #6). All work branches off `origin/master`.

**Gates (every item):**
- Spec before code. Commit + push via **PR** (classifier blocks direct master push; no force-push to the public repo).
- **PII scan** (`~/arogara/pii-audit/scan.sh /home/karthi/arogara/proctor`) before every push; review the report.
- Deploy **image-only** (`gcloud run deploy --image …`, NO `--set-env-vars`) to preserve env; use `--update-env-vars KEY=…` only to change a specific key.
- **Never** put real secrets in a committed file or commit message.
- Don't expose the raw-capture term in UI / commits — use "detailed test data" / "interaction analytics".
- Finish with a **triple review** (code-review-repo + an independent lens + a security pass).

---

## Order of work (strict sequence unless noted)

### 1. Rotate credentials (post-exam hygiene)
The frontend bakes a sha256 of the password into the bundle (`VITE_ADMIN_PASSWORD_HASH` / `VITE_INVIGILATOR_PASSWORD_HASH`), so rotating a password requires **both** an env update on `proctor-api` **and** a frontend rebuild+deploy.
- **ADMIN_PASSWORD:** generate a new strong value → update `.env.deploy.local` → `gcloud run services update proctor-api --update-env-vars ADMIN_PASSWORD=…` → rebuild frontend with the new `VITE_ADMIN_PASSWORD_HASH` (via the hardened deploy from item 2) → deploy → **verify login end-to-end** (frontend gate + an authed admin API call). Report the new value to Karthi (CLI).
- **INVIGILATOR_PASSWORD:** same flow (api env + `VITE_INVIGILATOR_PASSWORD_HASH` rebuild) → verify the invigilator unlock path. Report the new value.
- **JUDGE0_API_KEY — BLOCKED on Karthi:** he will hand over a NEW key. When provided: update `.env.deploy.local` + `proctor-api` env, redeploy backend, verify a test submission runs. Old key: Karthi revokes it himself at the RapidAPI dashboard (Judge0 CE → app keys) — surface the exact spot.
- **Other keys** that surfaced during the fix (`ALERTS_INGEST_API_KEY`, `RETENTION_SWEEP_API_KEY`, `WORKER_TOKEN`): do **not** auto-rotate — add to the morning list for Karthi's call (rotating them means coordinated redeploys of the ingest/worker paths).

### 2. Harden the deploy (full root cause + permanent guard)
- **Root cause:** deployed frontend bundles shipped with an **empty** `VITE_ADMIN_PASSWORD_HASH`, so admin login was silently broken on the live site. Confirm the exact history — ad-hoc `gcloud builds submit` / `npm run build` invocations that bypassed `deploy-gcp.sh`'s hash-bake step (line ~25-27). Document the real cause.
- **Permanent fix — "without passwords it should never deploy at all":**
  - `frontend/deploy-gcp.sh` must assert `ADMIN_PASSWORD` **and** `INVIGILATOR_PASSWORD` are set, and bake **both** hashes.
  - Add a **post-build verification gate**: `grep` the freshly built `dist` for the expected hashes; **abort the deploy** if either is missing.
  - Make `deploy-gcp.sh` the **only** sanctioned deploy path; document it (README/AGENTS); forbid ad-hoc build commands.
  - **Test the guard:** simulate a missing hash → confirm the deploy aborts loudly.

### 3. Conductor one-pager — DONE (pre-run)
Committed via PR #6 (credentials moved out of the printed guide; shared separately). No action.

### 4. Archive the legacy `challenges` contest
- Archive directly: `POST /api/admin/contest-status` `{slug:"challenges", status:"archived"}` with admin auth. If the classifier blocks the production write, hand Karthi the one-liner (he'll run it).
- Verify it shows `status=archived` and drops off the default Contests list.

### 5. Drop web service to 0 idle instances
- `gcloud run services update proctor-web --min-instances 0` (post-exam cost). Confirm the change.

### 6. Merge the refactor branch into master
- Branch: `refactor/decomp-resume` (was 9 commits ahead of the old master; master has since gained the exam fixes, hide-archived, the password-hash rebuild, and the one-pager → reconcile required).
- Follow the resume plan: `docs/superpowers/plans/2026-06-18-decomposition-resume.md` **"ON RESUME"** — run a commit-by-commit diff of master since baseline `f6887df`, rebase/reconcile `refactor/decomp-resume` onto current `origin/master`, re-review only the changed parts.
- Behavior-preserving; pass guards (canaryIsolation / scopingLint / routesAuthLint / envLint), `tsc`, backend + frontend test suites.
- Merge to master via **PR** (no force-push). Deploy **once** (image-only, preserve env). Smoke test. "Make sure everything works."

### 7. MAJOR FIX — Run-evaluation: batching + progress + idempotency
- **Symptom:** contest **`tristridots`** (~360 students). Clicking **Run evaluation** evaluates only a **partial** subset — the Extra Talent + integrity verdicts/tags appear for some students, not all. Likely a synchronous eval hitting the Cloud Run request timeout / internal limits with large data.
- **Fix requirements (all three):**
  1. **Batch** the evaluation so **every** student is processed (chunked, not one synchronous pass).
  2. **Progress visibility** in the frontend — show it's processing / in-progress (e.g. "evaluating X / N", spinner/progress).
  3. **Idempotent button** — if a run is already in progress, say so / disable the button; repeat clicks must not double-process or corrupt results.
- **Approach:** investigate the current eval flow (`backend/src/evaluation.mjs`, the run-eval route in `handler.mjs`, the frontend Results-panel button). Recall the earlier triple-review note: handler-level scan caps (`SESSIONS_QUERY_LIMIT` / `SUBMISSIONS_RESULTS_LIMIT`) were raised to 6000 / 120000 — confirm whether 360 students still exceed a limit or time out. Design a batched/async job + status polling (or chunked server-side processing). Verify against the `tristridots` data **carefully** (don't unsafely mutate real verdicts).

### 8. Continue + COMPLETE the decomposition refactor
- After 1-7: resume the god-file decomposition for the **remaining** phases (beyond the 5 already done) and **finish** it. Diff-driven per the resume plan. Behavior-preserving. PR + deploy + triple-review.

---

## Blocked / need from Karthi
- **Judge0 new key** (item 1) — paste when ready; everything else proceeds without it.
- **Decision:** rotate the other ingest keys too? (item 1, last bullet) — morning.

## Morning-discussion list (uncertain calls — fill as they arise)
- (to be appended during the run)

## Progress log (append as items complete)
- 2026-06-18 pre-run: item 3 (one-pager) done; folder cleaned; this plan written.
