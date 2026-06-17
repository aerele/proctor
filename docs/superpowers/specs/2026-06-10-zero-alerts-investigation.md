All evidence gathered. Composing findings.

---

# F8.5 zero-alerts investigation — findings

## TL;DR

The last poller run (mcet-aerele-2, 2026-06-05 16:08–17:26 IST) **worked end-to-end** — detectors ran, 22 alerts were built, POSTed, and are sitting in prod Firestore unarchived right now. They show as ZERO in every console anyone has opened since, for two independent reasons (ranked below). No detector, threshold, API-key, or id-collision failure occurred.

## Ranked root causes

**#1 (prod console shows 0): `adminAlerts` caps the Firestore scan BEFORE in-memory filtering — archived docs crowd out everything.**
`backend/src/handler.mjs:3396-3410`: with no contest filter, the query is `firestore.collection(ALERTS_COLLECTION).limit(500).get()` — **no `orderBy`**, so Firestore returns the first 500 docs by doc id, THEN `.filter(!archived)` runs in memory. All ~500+ KEC alerts (`contest-eval:first_attempt_solve:*` ids sort first alphabetically) were bulk-archived at `2026-06-05T11:58:25Z` (17:28 IST, right after the contest), so the default scan window is 100% archived docs → 0 returned. Empirically verified against the live prod API:
- default view: **0 alerts**
- `?include_archived=true`: **500 alerts, all `contest-eval`/`first_attempt_solve`, all `archived:true`, slug `kec-aerele-coding-contest`**
- `?contest_slug=mcet-aerele-2`: **22 alerts, archived:false** — the last run's output, alive and well, just unreachable by the default scan.
- `?source=proctor&include_archived=true`: **0** — even proctor-source alerts are crowded out. Same bug pattern at `handler.mjs:4101-4108` (invigilator stats).

**#2 (dev console shows 0): the poller has only ever POSTed to the OLD prod deployment.**
`monitoring/.data/session.local` pins `BACKEND_URL=https://aerele-proctor-api-6wcofu4ula-el.a.run.app` (prod). The current dev stack (`proctor-api-ej4cpz43iq-el.a.run.app`, project aerele-proctor-dev) has exactly **3 alerts, all source=proctor, none contest-eval** (queried dev Firestore directly). No poller run has happened since Jun 5 17:26 (newest `cycle-*.json` under `monitoring/.data/`; `pgrep poller.py` empty). Any look at the dev console necessarily shows zero contest-eval alerts.

**#3 (contributor): `first_attempt_solve` id churn inflates the archived pile.**
`monitoring/alerts.py:389` — the dedupe tail is the user's sorted problem list (`firstattempt-<p1>-<p2>...`), so every time a user first-attempt-solves one more problem a NEW doc id is minted and the old doc is orphaned. ~390 participants produced 500+ `first_attempt_solve` docs, which is what saturated the 500-doc scan window in #1. (F10 spec already plans "problem_id partitioning of similarity/dedupe keys".)

**#4 (latent, not triggered): POST failures are swallowed.**
`monitoring/poller.py:177-183` logs `ok=False` and continues; `run_cycle` returns `status:"ok"` regardless (poller.py:185-190). Also `handler.mjs:3310` rejects batches >500 alerts with a 400 — KEC cycles hit 349/POST; one bigger contest would silently drop entire cycles. Didn't cause this incident, but would produce exactly this symptom next time.

## Hypotheses disproved (with evidence)

- **Detectors never ran / env missing** — disproved: `.data/mcet-aerele-2/alerts/cycle-0001..0046.json` (43 files, 22 alerts/cycle: 12 recurring_pair, 4 peer_copy_cluster, 6 tough_first_attempt) and `.data/alerts/cycle-0002..0009.json` (KEC, ~300-350/cycle).
- **Thresholds too strict** — disproved: alerts fired; `contest_eval_core.py:368` flag thresholds are loose (any single-attempt-hard, or zero-iteration with ≥3 solves). Note: `alert-config.json` `tough_questions` was reset to `[]` post-contest in c38e623 (2026-06-09) — must be re-populated per contest, else falls back to the noisy ≤10-solver rule.
- **API key mismatch / 401s** — disproved for these runs: alerts are in prod Firestore. `requireApiKey` (handler.mjs:4344-4356) is closed-by-default and dev has `ALERTS_INGEST_API_KEY` set.
- **contest_slug mismatch** — disproved as filed: slugs are correct (`kec-aerele-coding-contest`, `mcet-aerele-2`); slug-filtered views SHOW the alerts. The default (unfiltered) view is the broken one.
- **id collisions deduping everything** — disproved: ids are intentionally idempotent (`alerts.py:192`, `handler.mjs:3315-3316`); merge-on-id is correct behavior. The real id problem is churn (#3), the opposite of collision.

## Fixes (small diffs)

1. **`adminAlerts` scan correctness** (handler.mjs:3396-3410): add `.orderBy("timestamp","desc")` (single-field index, auto) before `.limit()`, and push `archived == false` to the query (or over-fetch with a paged scan until 500 post-filter matches). Same fix at handler.mjs:4101. ~10 LOC.
2. **Poller POST failure loudness** (poller.py:177-190): set cycle `status:"post-failed"` when `ok=False`, exit non-zero in `--once` mode, and chunk POSTs at ≤400 alerts/request to stay under the handler.mjs:3310 cap. ~15 LOC.
3. **first_attempt_solve dedupe** (alerts.py:389): drop the problem-list tail; emit one alert per (user, problem) — `dedupe=_dedupe_segment("firstattempt", ch)` — so ids are stable as solves accrue. ~10 LOC (aligns with F10 problem_id partitioning).
4. **Ops**: unarchive nothing — instead verify with `?contest_slug=` filters after fix 1; rotate the prod ingest key (still flagged TODO in `night-run/archive-2026-06-05-sshgate-v12/RESUME-STATE.md`).

## Startability assessment (what launching the adapter takes today)

Working today: Chromium IS up on :9222 (verified), `monitoring/test_monitoring.py` passes 110/110, `run-demo.sh` gives an offline e2e. But a live launch requires hand-assembling:

1. **Chrome :9222 with HR-moderator login** — running now, but nothing checks/starts it (cdp.py raises → poller logs "metadata unavailable" forever and writes NOTHING, which itself looks like a zero-alerts run).
2. **`--api-base`** — must be the CURRENT deployment URL; `session.local` still pins the old prod URL. Dev is `https://proctor-api-ej4cpz43iq-el.a.run.app`.
3. **`--api-key`** — `ALERTS_INGEST_API_KEY` value; not stored anywhere locally (was only in the dead process's argv; session.local says "re-scrape it from ps"). Recoverable via `gcloud run services describe proctor-api --project aerele-proctor-dev --region asia-south1` with `/home/karthi/proctor-dev-sa.json`.
4. **`ADMIN_PASSWORD`** for enrichment — resolution order CLI > env > `monitoring/.data/session.local` (enrich.py:88-108); session.local holds the PROD password, wrong for dev.
5. **`--slug` + `--contest-id`** — per contest, manual.
6. **`alert-config.json` `tough_questions`** — currently `[]`; must be set per contest or tough_first_attempt degrades to the noisy auto-rule.
7. **`--data-dir`** — should be per-contest (the KEC run reused the default dir and the mcet run reused a stale dir name `mcet-aerele-2`-style confusion).
8. **Verdict seam responder** — optional separate `/loop` session; alerts stay `verdict: pending` without it.

**A one-command wrapper needs**: a per-target env file (`.data/<env>.env`: API_BASE, API_KEY, ADMIN_PASSWORD) + per-contest args (slug, id, tough_questions) → preflight checks (curl :9222/json/version; HEAD api-base; POST a self-test alert and assert 200 + readback via admin API) → derive `--data-dir .data/<slug>/` → launch with log tee to `.data/<slug>/poller.log` → print the verification one-liner. The existing `.data/gcp-dev.env` pattern is the natural place; everything else is already CLI-parameterized in `poller.py:193-239`.

Key paths: `/home/karthi/arogara/proctor/monitoring/poller.py`, `/home/karthi/arogara/proctor/monitoring/alerts.py`, `/home/karthi/arogara/proctor/backend/src/handler.mjs` (lines 3305-3424, 4344), `/home/karthi/arogara/proctor/monitoring/.data/session.local`, `/home/karthi/arogara/proctor/night-run/archive-2026-06-05-sshgate-v12/RESUME-STATE.md` (the KEC run log/runbook).