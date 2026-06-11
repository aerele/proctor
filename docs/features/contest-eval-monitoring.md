# Optional — Contest-Eval Monitoring Poller (externally-hosted HackerRank)

This page documents an **optional, secondary** add-on to the Aerele proctor platform: a standalone Python poller (under `monitoring/`) that live-watches an **externally-hosted HackerRank contest** and emits cheating/integrity **alerts into the same alerts pipeline** the proctor admin console already shows. The primary product is the own-editor exam platform (React + Monaco + Judge0 Run/Submit); this poller is **not** part of the candidate path and is **not required** to run an exam. Use it only when a contest is hosted on HackerRank and you want its integrity signals to land alongside the platform's own proctoring alerts.

> **Standard of truth.** Everything below is described from the code in this repo. Behaviors that the source asserts but that this doc could not independently verify are marked `(unverified)`.

---

## Where this fits

| | Primary platform | This optional poller |
|---|---|---|
| Candidate UX | Own React + Monaco editor, Judge0 Run/Submit, fullscreen-enforcement ladder | None — candidates take the contest on HackerRank, externally |
| Integrity signals | Browser proctoring events (`source: proctor`) | Deterministic + LLM-assisted contest-eval analysis (`source: contest-eval`) |
| Where alerts land | Admin **Live alerts** console (`/api/alerts`) | The **same** Admin Live alerts console (`/api/alerts`) |
| Code | `backend/`, `frontend/` | `monitoring/*.py` + `night-run/verdict-queue/` |

Because both sources POST to the same ingest, the admin Live alerts console shows them together. Its subtitle reads "Proctoring **and contest-eval** signals across all rooms," and the **SOURCE** filter lets an admin narrow to `contest-eval` vs `proctor`.

![Admin Live alerts console — the shared pipeline both proctoring and contest-eval alerts feed into; note the SOURCE / SEVERITY / ROOM filters and the contest-slug filter](../assets/wave2-08-admin-alerts-console.png)

![Live alerts console grouped by alert type](../assets/wave2-09b-admin-alerts-grouped-type.png)

> The two screenshots above show real proctoring alerts (`ip_changed`) in the shared console. The repo's evidence set does not include a screenshot of `contest-eval`-sourced alerts in this console, so the contest-eval rows are not pictured here — see [Gaps](#gaps-unverified).

**Backing code (admin side):** the ingest route `POST /api/alerts` and the console-read routes live in `backend/src/handler.mjs` (`ingestAlerts`, `normalizeAlert`); the console UI is the Admin Live alerts surface (see [admin-live-monitoring.md](admin-live-monitoring.md)).

---

## The shared alert contract (ingest)

Both the poller and the platform POST to **`POST /api/alerts`** with an `x-api-key` header that must equal the backend env **`ALERTS_INGEST_API_KEY`** (gate: `requireApiKey` in `handler.mjs`).

Required-on-ingest fields (enforced by `normalizeAlert` in `handler.mjs`, mirrored client-side by `alerts.validate_alert`):

| Field | Notes |
|---|---|
| `source` | must be `proctor` or `contest-eval` |
| `type` | alert type (see below) |
| `severity` | `critical` \| `warning` \| `info` |
| `timestamp` | valid ISO-8601 |
| `hackerrank_username` | raw candidate id (`candidate_id` is also accepted as an alias) |
| `title` | headline |

The alert `id` is **deterministic and idempotent** — `"<source>:<type>:<username_norm>:<contest_slug>:<dedupe>"`. The backend upserts with `{ merge: true }` keyed on `id`, so re-running a poll cycle (or retrying a delivery) **merges** instead of duplicating. The ingest caps **500 alerts per request**. `username_norm` matches the backend `normalizeUsername` (trim, lowercase, non-`[a-z0-9._-]` → `_`).

---

## One poll cycle (`poller.py`)

`poller.py` is the live poller CLI. Each cycle does, in order (see `run_cycle`):

1. **Metadata fetch (untrottled)** — leaderboard + judge submissions + challenges, via the acquirer (`acquire.py`). No code is fetched yet.
2. **Deterministic analysis** — `contest_eval_core.analyze_meta` profiles every participant's iteration behavior (first-attempt solves, zero-iteration, never-solved, accept gaps) from metadata alone; `metadata_flag_candidates` produces a conservative **code-fetch shortlist**.
3. **Lazy, 429-safe code fetch for flagged-only** — only the **flagged** candidates' **Accepted** submissions are fetched, **hardest-first** (`select_code_targets`). Failed fetches are never stored (`code fetched: N subs (429-safe: failed fetches not stored)`).
4. **Clone / web-paste detection** — `contest_eval_core.analyze_clones` runs exact + skeleton clustering, recurring-pair, tight-gap, and raw-byte provenance passes over whatever code was actually fetched.
5. **Build alerts** — `alerts.build_alerts` produces shared-contract alerts; `alert-config.json` gates which types fire and can override severity.
6. **Route ambiguous to the verdict seam** — `is_ambiguous(alert)` decides which alerts go through the LLM verdict seam; resolved verdicts (if any) are attached. The seam **never blocks** the cycle.
7. **POST** — alerts are written to the gitignored `.data/alerts/cycle-NNNN.json` and, unless `--no-post`/`--dry-run`, POSTed to `<api-base>/api/alerts`.

A per-cycle reload of `alert-config.json` lets you enable/disable a type or edit `tough_questions` **without restarting the poller**; a malformed mid-save edit keeps the last-good config and never crashes the loop.

### Modes & key flags

| Flag | Default | Effect |
|---|---|---|
| `--fixtures DIR` | — | **Offline** mode: read a committed contest-eval run dir; no browser, no HR network. |
| `--live` | (implicit when `--fixtures` absent) | **Unattended** live mode via `cdp.py` (see below); requires `--slug`. |
| `--live-bridge` | off | Legacy agent-driven file-drop path instead of `cdp.py`. |
| `--once` | off (loops) | Single cycle then exit. |
| `--interval` | `60` (s) | Seconds between cycles in loop mode. |
| `--api-base` | `http://127.0.0.1:8080` | Backend base URL for the POST. |
| `--api-key` | `""` | `x-api-key` (must equal `ALERTS_INGEST_API_KEY`). |
| `--no-post` / `--dry-run` | off | Skip the POST; alerts still written to `.data/`. |
| `--alert-config` | `monitoring/alert-config.json` | Per-type toggle/severity catalog. Missing file ⇒ all types enabled, dynamic severity. |
| `--verdict-queue` | `night-run/verdict-queue` | File-queue dir for the LLM verdict seam. |
| `--verdict-max-cycles` | `8` | Cycles to wait for a verdict before timing out (stays `pending`). |
| `--no-enrich` | off | Skip candidate name+room enrichment. |
| `--admin-password` | env `ADMIN_PASSWORD`, else `.data/session.local`, else none | Enables name+room enrichment via `GET /api/admin/sessions`. If none found, enrichment is **disabled** and the poller still runs (alerts stay username-only). |
| `--enrich-max-per-cycle` | `20` | Cap on new admin/sessions lookups per cycle. |
| `--enrich-rate-limit` | `0.3` (s) | Seconds between admin/sessions lookups. |

> **Enrichment** (`enrich.py`, poller-only): looks up each flagged candidate's name + room from the live admin `GET /api/admin/sessions` and bakes them into the alert so the **frozen** frontend shows them with no redeploy. It is forever-cached, rate-limited, capped per cycle, and a no-op when no admin password is available — it **never** breaks a cycle on error.

### Contest-eval alert types

Defined in `alerts.py` (`ALERT_TYPES`) and the shipped `alert-config.json`. Severity below is the **default in the shipped config**; when a type's config `severity` is `null`/absent the poller keeps a dynamic HARD/MED mapping instead.

| Type | Shipped severity | Meaning |
|---|---|---|
| `peer_copy_cluster` | `critical` | >1 distinct user with identical (skeleton) code on a MED/HARD problem. EASY/SQL clusters are dropped (weak evidence). |
| `recurring_pair` | `critical` | A pair sharing identical code across 2+ problems **or** 1+ hard problem — the most conclusive signal. |
| `web_paste` | `warning` | Strong web/editorial provenance signature (GfG/LeetCode/smart-quotes/NBSP/zero-width/BOM/etc.) in fetched accepted code. The Java `class Solution` template false positive is suppressed. |
| `first_attempt_solve` | `info` | Accepted on the candidate's **first** attempt (zero prior wrong) on a **normal** problem. A corroborator, never a standalone accusation. |
| `tough_first_attempt` | `critical` | A first-attempt accepted solve on a **tough** problem — the real "solved a tough question on the first try" flag, emitted **instead of** `first_attempt_solve` for tough problems. |

> **Marking tough questions.** `alert-config.json` carries a top-level `"tough_questions": []`. When **non-empty** it is authoritative: only those slugs/ids are "tough." When **empty**, the poller falls back to the data-derived rule (≤10 solvers = hard). The shipped config ships it **empty**. `fast_solve` is retained only as a deprecated config **alias** of `first_attempt_solve`; no alerts are emitted under that name.

---

## Unattended CDP driver (`cdp.py`)

`cdp.py` is what makes the live poller **unattended** — no browser-automation framework, no chrome-devtools MCP, no agent in the loop. It is pure stdlib: a hand-rolled minimal RFC-6455 WebSocket over `socket` speaking the Chrome DevTools Protocol to a Chromium already running with `--remote-debugging-port=9222`.

Per cycle, `run_fetch(...)`:

- connects to the **browser-level** DevTools endpoint (`http://127.0.0.1:9222/json/version`),
- **creates its own background tab** (`Target.createTarget` with `background:true`) on `hackerrank.com` so it does **not** steal focus,
- waits for the tab to actually reach the real HR origin (not `about:blank`) so a credentialed same-origin `fetch()` carries the moderator session cookies,
- runs the fetch JS via `Runtime.evaluate` (`awaitPromise` + `returnByValue`) and returns parsed JSON,
- **closes only the tab it created** (`Target.closeTarget` on the remembered `targetId`).

**Non-disruptive guarantees (hard requirements in the code):** it never enumerates, navigates, activates, or closes any pre-existing tab, and it never closes the browser. If `:9222` is unreachable or the tab never reaches the HR origin, it raises `CDPError`, which the acquirer turns into `LiveUnavailable` so the poller falls back to `--fixtures`. A reachability probe `is_devtools_up()` exists for a cheap check (no tab created).

> The 429-safe code fetch (the JS run inside that tab) detects HTTP 429 explicitly, **never stores a failed fetch**, throttles between fetches, backs off on 429, goes hardest-accepted-first, and accumulates results so a tool-timeout doesn't lose progress. (The exact JS lives in `acquire.py`'s `LiveAcquirer`; this doc verified the contract from `cdp.py` + the poller, not every JS line — `(unverified)` on the precise sleep/back-off constants.)

---

## LLM verdict seam (`verdict_seam.py`)

Ambiguous alerts are routed to a **file-queue** judgment seam that a human-driven Claude Code `/loop` drains. It **never** makes a network call, **never** spends money, and **never** blocks the poller.

- **Which alerts route** (`is_ambiguous`): `web_paste` (any), `recurring_pair` at `warning` (single-hard), and `peer_copy_cluster` at `warning` (MED). Decisive signals — a conclusive `recurring_pair` (critical) and `tough_first_attempt` (critical) — go straight to the dashboard. `first_attempt_solve` (info) is a corroborator and is not routed alone.
- **Flow:** `seam.request(alert)` writes `night-run/verdict-queue/pending/<id>.json` (atomic, idempotent). The `/loop` in `monitoring/verdict-responder-prompt.md` reads the actual code, applies the difficulty-weighting + Java-template rules, and writes `night-run/verdict-queue/done/<id>.json` with `status ∈ {real, false_positive, inconclusive}` (the responder must **not** write `pending`).
- **Polling:** `seam.poll(alert)` reads `done/` each cycle and attaches the verdict, clearing `pending/` when resolved. If no verdict appears within `--verdict-max-cycles` (default **8**), the verdict stays `{status: "pending"}` — the alert is never blocked.
- **Swappable transport:** `VerdictSeam`'s `request`/`poll` are the only contract the poller depends on; a future C3 transport can plug in without touching `poller.py`. C3 is intentionally **not** built here.

---

## Tab-away (S1) detector (`tab_away_detector.py`)

A separate, **fully local** image-recognition detector (Stretch 1) that flags when a candidate navigated **away** from HackerRank during a screen recording. No cloud vision API.

How it works (`analyze_recording`):

1. **Sample frames** every `--interval` seconds (default **5**) from a `.webm` screen recording via **ffmpeg** into a temp dir under the gitignored `monitoring/.data/`.
2. **Template-match** the HackerRank header logo in a configurable region (default `top-left`) → a score in `[0,1]`. Imaging backend is auto-detected: OpenCV `cv2.matchTemplate` if present, else a pure **numpy + Pillow** normalized cross-correlation (the README states numpy+Pillow is the active backend in this env), else a documented stub that raises with `pip install` guidance.
3. **Detect absent runs** — continuous frames scoring below `--threshold` (default **0.6**) for longer than `--min-gap-seconds`.
4. **Build + POST one `tab_away` alert per run** — `source: proctor`, `severity: warning`, with the gap start mapped to a wall-clock offset, structured `data` (offsets, per-frame scores), a `video_key`, and a `#t=<seconds>` **W3C Media Fragment** deep-link to the recording at the gap start.

**Threshold source of truth.** The minimum-gap threshold's source of truth is the **admin console** (Settings → Proctor alert types → `tab_away` → threshold seconds), default **12**, round-tripped as `proctor.tab_away.threshold_seconds` through `GET`/`POST /api/admin/alert-settings` (`adminGetAlertSettings` / `adminSaveAlertSettings` in `handler.mjs`; default constant `TAB_AWAY_DEFAULT_THRESHOLD_SECONDS`). Precedence: explicit `--min-gap-seconds` → live admin-console value (when `--admin-password` + `--api-base` given) → built-in default `12`.

> **Held for real-world accuracy tuning.** The detector requires a real `--logo` crop (a tight PNG of the HackerRank wordmark) and a real recording to tune `--region`/`--threshold`/`--interval`. The code raises a clear error if `--logo` is not provided. The synthetic self-test (`test_tab_away.py`) proves the pipeline + contract, not real-world accuracy. See `monitoring/tab-away-README.md`.

---

## Submission-events markers (related runbook)

A sibling two-step flow (`download_submission_events.sh` → `upload_submission_events.sh`, runbook at `monitoring/SUBMISSION-EVENTS-RUNBOOK.md`) reuses the **same** poller CDP fetch to snapshot a contest's submission metadata, then POSTs **submission-time markers** (GREEN Accepted / RED failure) to `POST /api/submission-events` (handler: `ingestSubmissionEvents`, same `x-api-key` as `/api/alerts`). The admin recording-review timeline reads them back by `username_norm:contest_slug`. Two cautions called out in the runbook: the `--contest-slug` must equal the proctor sessions' `contest_slug` (else the timeline silently shows nothing), and on 429/empty-leaderboard you **wait and retry**, never tight-loop.

---

## Offline run, tests, and validation

| Command | What it does |
|---|---|
| `monitoring/run-demo.sh` | One-command **offline** end-to-end demo: poller → in-memory ingest → admin read, self-cleaning (uses `mock_alert_server.py`; the real backend needs Firestore). |
| `python3 monitoring/test_monitoring.py` | Unit suite: core reproduces `clone_analysis.json`, verdict-seam round-trip, alert idempotency + id format. |
| `python3 monitoring/validate_fixtures.py` | Proves the parameterized core reproduces the committed `clone_analysis.json` byte-for-byte and the poller runs end-to-end via `--fixtures`. |
| `python3 monitoring/test_tab_away.py` | Synthesizes a PRESENT/ABSENT/PRESENT clip and asserts the detector flags exactly the middle gap; negative control flags nothing. |

> **F8.5 deferred.** Per the build backlog, "F8.5 — an easily-startable adapter + investigate a zero-alerts run" is **deferred** (task #32). This deferral comes from the project task tracker, not from a marker in the repo source, so treat it as a planning note: `(unverified from repo source)`.

---

## PII / git hygiene

Live alerts carry candidate usernames and submission code, so the following are **gitignored** (confirmed in `proctor/.gitignore`):

- `monitoring/.data/` — live alerts + fetched code + enrichment session file
- `night-run/verdict-queue/` — pending/done verdict files
- `monitoring/**/data/raw/`, `monitoring/**/data/processed/`, `monitoring/**/code_*.json`, `monitoring/**/contest_*_meta.json` — fixtures and any pulled candidate code/meta

The poller does **no** deploy of its own; it only POSTs to whatever `--api-base` you pass.

---

## Why a parameterized copy (wrapper-over-fork)

`contest_eval_core.py` is a **parameterized copy** of only the analysis functions from the canonical `contest-eval/` scripts (which hardcode input paths and run as side-effecting `__main__` scripts, so they are not importable as a library, and editing them is forbidden). The logic is kept byte-for-byte equivalent so results reproduce the committed `clone_analysis.json` (proven by `validate_fixtures.py`). The originals are never modified.

---

## Related

- [admin-live-monitoring.md](admin-live-monitoring.md) — the admin **Live alerts** console these contest-eval alerts land in
- [candidate-enforcement-ladder.md](candidate-enforcement-ladder.md) — the platform's own (`source: proctor`) enforcement alerts that share the same pipeline
- [admin-recording-review.md](admin-recording-review.md) — recording timeline that consumes `tab_away` deep-links and submission-event markers
- [invigilator-portal.md](invigilator-portal.md) — selective alert visibility per room
- [architecture-overview.md](architecture-overview.md) — how the backend, frontend, and `monitoring/` fit together
