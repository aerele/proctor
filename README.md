# Aerele Proctor

A **standalone own-editor exam platform**: candidates register, share their
**entire screen**, and solve coding problems entirely inside our own
**React + Monaco** workspace, with **Judge0-backed Run/Submit**. Admins run the
exam from a single console (contests, problems, roster/people, live stats,
alerts, results, recording review, data lifecycle); invigilators work a
tokenized per-room portal. Evidence (screen video + a separate low-res camera
stream + JSONL event logs) streams to Google Cloud Storage; integrity **alerts**
land in one console.

**HackerRank was dropped from the candidate path (F8.2).** Candidates no longer
open HackerRank — everything happens in our editor. A clearly-labelled,
**optional** secondary component still exists: a Python **contest-eval
monitoring poller** (`monitoring/`) that live-watches an *externally-hosted*
HackerRank contest and feeds cheating alerts into the **same** alerts pipeline.
That component is not part of the candidate experience and is not required to run
an exam — see [Optional: contest-eval monitoring](#optional-contest-eval-monitoring-poller).

> **Standard of truth.** This README documents only behavior verified by reading
> the code/UI in this repo or an existing screenshot under `night-run/evidence/`.
> Anything not independently confirmed is marked **(unverified)**. The product
> owner's rule: *if the docs say it works, it works.*

## What this is — and the threat model

This is honest, browser-based proctoring — **evidence collection + triage, not
lockdown**. Even though candidates now code inside our own editor, a plain web
app still **cannot** force-close tabs, enumerate other tabs, continuously read
the OS clipboard, see a second device, or catch an overlay on another monitor —
no browser app can without a managed extension or endpoint agent. What it *can*
do: hold the candidate in fullscreen and run an **enforcement ladder**
(re-entry countdown → lock) on exits, record the user-selected **Entire Screen**
(it refuses anything else), capture a separate low-res **camera** stream for live
monitoring, detect when this tab is hidden/recording stops/screen-share stops,
track IP changes, and stream video chunks + JSONL events to GCS. So the spine of
integrity is **human review of recorded evidence** plus the live signal feed —
treat alerts as triage for review, never as automatic disqualification. The
optional contest-eval poller adds a submission-analysis signal (peer-copy
clusters, web/editorial paste, first-attempt-on-a-tough-question) for
externally-hosted HackerRank contests only.

Deeper background and the decisions behind the design live in
[`docs/PROCTORING_RESEARCH.md`](docs/PROCTORING_RESEARCH.md),
[`docs/PLATFORM_ALTERNATIVES.md`](docs/PLATFORM_ALTERNATIVES.md), and
[`docs/ROADMAP.md`](docs/ROADMAP.md). Read those rather than expecting this README
to re-derive them.

## Architecture

```
                          three path-routed surfaces, one React/Vite app
       candidate  /  ───┐
       admin    /admin ─┼─▶ ┌──────────────────────────────┐
       invig /invigilator┘  │ frontend/ (React+Vite+TS)     │
                            │  • candidate recorder +       │
                            │    Monaco workspace (Run/Submit)│
                            │  • admin console              │
                            │  • invigilator portal         │
                            └───────────────┬──────────────┘
   signed-URL PUT (screen + camera chunks)  │ JSON: session lifecycle, exec
   + JSONL events to GCS                     │ run/submit, editor events,
                                             │ admin/invigilator reads + actions
                                             ▼
                            ┌──────────────────────────────┐        ┌────────────┐
                            │ backend/ (one Cloud Run       │◀──────▶│ Firestore  │
                            │  handler: src/handler.mjs)    │ sessions, contests,
                            │  • dispatch table (~70 routes)│ problems, roster,
                            │  • most route bodies          │ persons, alerts,
                            │  • partial split → lib/*.mjs, │ live-locks, reviews…
                            │    routes/invigilator.mjs,    │        └────────────┘
                            │    config.mjs, feature modules│        ┌────────────┐
                            │  • Judge0 adapter (Run/Submit)│◀──────▶│ GCS        │
                            └───┬───────────────▲───────────┘ evidence│ (chunks +  │
        POST /api/alerts        │  (x-api-key)  │ video_key   chunks   │ manifests) │
        (shared contract)       │               │ deep-link            └─────┬──────┘
                                │               │                            │ chunks
   ┌────────────────────────────┴──┐   ┌────────┴──────────┐   ┌─────────────▼──────┐
   │ monitoring/ (OPTIONAL Python  │   │ Judge0 (RapidAPI) │   │ video-worker/      │
   │  contest-eval poller)         │   │  Run/Submit exec  │   │  (OPTIONAL merge   │
   │  • externally-hosted HR only  │   └───────────────────┘   │  service; NOT      │
   │  • POSTs source:contest-eval  │                           │  deployed on dev)  │
   │    alerts to /api/alerts      │                           └────────────────────┘
   └───────────────────────────────┘
```

- **frontend/** — React/Vite/TS/Tailwind, **three surfaces selected by URL path**
  (no router library; literal prefix check in `src/App.tsx`):
  `/` = candidate recorder + Monaco workspace, `/admin` = admin console,
  `/invigilator` = invigilator portal. Demoable with `VITE_DEMO_MODE` (no
  backend). → [`frontend/README.md`](frontend/README.md)
- **backend/** — one Cloud Run HTTP handler (`src/handler.mjs`) that still holds
  the **dispatch table (~70 routes)** and most route bodies. A **partial, paused**
  behavior-preserving decomposition (B0/B1) has split out `config.mjs`,
  `lib/*.mjs` (`auth`, `clients`, `http`, `sanitize`, `sessionStore`),
  `routes/invigilator.mjs`, plus pre-existing feature modules
  (`contests`, `templates`, `problems`, `contestProblems`, `identity`, `people`,
  `scoreboard`, `dataLifecycle`, `ipReport`, `judge0Adapter`, `execQueue`); the
  rest is slated for after the live test. State in Firestore + GCS.
  → [`backend/README.md`](backend/README.md)
- **video-worker/** — **optional** Cloud Run service that merges screen chunks
  into one review video and writes its key back onto the session. **NOT deployed
  on dev** (unverified against real GCP). → [`video-worker/README.md`](video-worker/README.md)
- **monitoring/** — **optional** standalone Python contest-eval poller (+ file-queue
  LLM verdict seam + tab-away detector) for **externally-hosted HackerRank
  contests**. POSTs `source:"contest-eval"` alerts to `/api/alerts`.
  → [`monitoring/README.md`](monitoring/README.md)

**How they connect:** every producer (the proctor recorder via the backend, the
enforcement ladder, and — optionally — the contest-eval poller / tab-away
detector) emits the **same shared `Alert` JSON contract**, and they all land in
one Firestore collection that the admin console reads. Evidence is stored under
one **contest-foldered GCS prefix** every component agrees on.

## Features

- **Contests + Templates** — a Contests tab (create/update/archive, regenerate
  access code + invigilator key, set exam window, rooms) and reusable **Templates**
  that **snapshot-copy** a problem list + defaults onto a new contest. A built-in
  `system-check` preset gives an always-open day-before lab check.
- **Person identity `{college_norm}~{uid_norm}`** — person-mode contests use a
  durable person id **stable across contests** (the multi-round spine): a roster
  upload runs a locked validation order (compulsory college column → college
  canonicalization gate → duplicate-id hard-reject → blank skip), and enrollments
  (`{contest_slug}::{person_id}`) carry scores/selection so a person's results
  join across rounds. Legacy contests use `username_norm` with a one-time
  **"Adopt into person model"** backfill.
- **Candidate own-editor workspace** — permissions-first onboarding (screen-share
  required, Entire Screen only; clipboard optional, never blocks) → fullscreen
  enforcement → roster unique-ID identity confirm (person-mode college picker) →
  optional room start gate → **multi-problem Monaco workspace** with an ordered
  `problems[]`, **per-language starter stubs**, and a **curated autocomplete**.
- **Run / Submit on live Judge0** — `POST /api/exec/run` (sample tests, visible
  results) and `POST /api/exec/submit` (hidden tests; verdict + pass/fail counts
  only, no per-test array). Per-`(session, problem)` cooldowns + a submit budget,
  one-in-flight-per-session.
- **Fullscreen-enforcement ladder (L1/L2)** — server-validated re-entry countdown
  (default 20s) and exit limit (default 2) → lock (`locked_reason:
  "fullscreen_enforcement"`); per-session **exemptions** (`fullscreen`,
  `switch_away`) grantable by admin or invigilator; release via invigilator unlock
  code.
- **Recording** — the recorded `.webm` is the **direct screen stream + mixed mic
  audio**; a **separate low-res camera stream** (default **ON**, 10 fps, 640 px)
  is captured for live monitoring but is never part of the recorded video.
- **Admin console** — Live stats (status counts + derived disconnected, room
  dropdown, auto-poll), Sessions + detail card + event stream + bulk actions,
  **Alerts console** (filters/archive/video deep-links + per-type config),
  **IP report** drill-down (proxy/NAT clustering), **Attendance**, live **Exam
  time** control (extend/force-end-now), **Results + People** (per-contest
  scoreboard with rank/per-problem/integrity + selection; cross-round person
  scorecards), **Recording review** (screen + camera playback with
  events/alerts/submission timeline; multi-reviewer queue), and **Data lifecycle**
  (export → triple-gated purge → tombstone; retention sweep).
- **Invigilator portal** — tokenized, **name-only** per-room console: room stats,
  release the 6-digit room **start** code / "Start now", per-student enforcement
  **exemption** toggle, mint/release fullscreen **unlock** codes, and **selective
  alerts** (default OFF; an admin opts each alert type in via `show_to_invigilator`).
- **Shared alerts pipeline** — `POST /api/alerts` (x-api-key, closed-by-default)
  ingests one or a batch; the console lists them newest-first with archive,
  room/severity/source filters, and short-lived signed `video_key` deep-links
  resolved at read time (never stored).
- **Admin/invigilator password hashing** — the frontend ships only sha256 hashes
  (`VITE_ADMIN_PASSWORD_HASH`, `VITE_INVIGILATOR_PASSWORD_HASH`) and hashes the
  typed password to compare; the plain passwords are not baked into the bundle.

## Documentation

The full, categorized index is **[`docs/README.md`](docs/README.md)** — start
there. Per-area, code-verified feature pages live under
[`docs/features/`](docs/features/):

| Doc | Covers |
|---|---|
| [`docs/README.md`](docs/README.md) | **Documentation index** — categorized links to every page below (getting started, feature guides, reference). |
| [`docs/features/architecture-overview.md`](docs/features/architecture-overview.md) | The fullest single-page tour (surfaces, backend split, state, identity, env). **Read this first.** |
| [`docs/features/candidate-flow.md`](docs/features/candidate-flow.md) | Candidate onboarding → workspace → Run/Submit. |
| [`docs/features/candidate-enforcement-ladder.md`](docs/features/candidate-enforcement-ladder.md) | Fullscreen enforcement L1/L2 + exemptions. |
| [`docs/features/admin-contests-templates.md`](docs/features/admin-contests-templates.md) | Contests + Templates CRUD + snapshot semantics. |
| [`docs/features/admin-problems-stubs-autocomplete.md`](docs/features/admin-problems-stubs-autocomplete.md) | Problem bank, hidden tests, stubs, curated autocomplete. |
| [`docs/features/admin-roster-rooms-identity.md`](docs/features/admin-roster-rooms-identity.md) | Roster, rooms, colleges/persons identity. |
| [`docs/features/admin-live-monitoring.md`](docs/features/admin-live-monitoring.md) | Live stats, Sessions, Alerts console, IP report, Attendance. |
| [`docs/features/admin-results-people.md`](docs/features/admin-results-people.md) | Results + selection; cross-round People scorecards. |
| [`docs/features/admin-recording-review.md`](docs/features/admin-recording-review.md) | Recording review (screen + camera + timeline + reviewer queue). |
| [`docs/features/admin-data-lifecycle.md`](docs/features/admin-data-lifecycle.md) | Export → purge → tombstone; retention sweep. |
| [`docs/features/invigilator-portal.md`](docs/features/invigilator-portal.md) | Tokenized room portal + selective alerts. |
| [`docs/features/alert-taxonomy.md`](docs/features/alert-taxonomy.md) | Full proctor + contest-eval alert catalog. |
| [`docs/features/contest-eval-monitoring.md`](docs/features/contest-eval-monitoring.md) | The OPTIONAL poller (externally-hosted HackerRank). |
| [`docs/features/deploy-runbook.md`](docs/features/deploy-runbook.md) · [`docs/DEPLOY.md`](docs/DEPLOY.md) | Deploy to GCP (from-scratch + redeploy). |
| [`docs/features/exam-day-ops-runbook.md`](docs/features/exam-day-ops-runbook.md) | Exam-day operations one-pager. |

The **live single-source-of-truth** for repo status / open items is
[`night-run/RESUME-ANCHOR.md`](night-run/RESUME-ANCHOR.md) — read it before a real
contest.

## HTTP API reference

All routes are dispatched from the `api` handler in `backend/src/handler.mjs`
(dispatch table at `handler.mjs:321-400`; ~70 routes). Auth (all timing-safe via
`safeEqual`, all **closed-by-default** when the secret is unset):

- **admin** = `x-admin-password` vs `ADMIN_PASSWORD`
- **invig** = `x-invigilator-password` vs the contest's `invigilator_key` OR
  `INVIGILATOR_PASSWORD` (admin password also accepted)
- **api-key** = `x-api-key` vs `ALERTS_INGEST_API_KEY`
- **sweep** = `x-api-key` vs `RETENTION_SWEEP_API_KEY` (or admin)
- **session** = knowing the `session_id` (no header) — the candidate write bearer

Any unmatched path → `404`. Intentional 4xx echo a `detail` message; unexpected
errors return a generic `500` with no internal detail. CORS allows
`GET,POST,OPTIONS` (`PUBLIC_APP_ORIGIN`, default `*`).

### Candidate / public

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/exam-config` | none | Public sanitized exam config for a contest/slug. |
| GET | `/api/candidate-route` | none | Probe whether a legacy settings doc is configured (router fail-open). |
| POST | `/api/access-code` | none | Resolve a typed 6-char access code → contest slug. |
| POST | `/api/roster/lookup` | none (rate-limited) | Verify a candidate's roster unique ID (person-mode may return a college picker). |
| POST | `/api/session/start` | time-window gate | Register/start a session, or idempotently replay an owned `session_id`. Serves `problems[]` + `submissions_summary` + `submit_budget`. |
| POST | `/api/session/resume` | session | Return an existing session verbatim after a reload (no re-collection). |
| POST | `/api/upload-url` | session (writable) | Mint a v4 signed **write** URL for a `screen` or `camera` chunk. |
| POST | `/api/events` | session (writable) | Append a JSONL event batch; raise sure-shot alerts for high-signal types. |
| POST | `/api/editor-events` | session (writable) | Ingest editor (keystroke/paste) events (cap `EDITOR_EVENTS_INGEST_LIMIT`). |
| POST | `/api/exec/run` | session (writable) | Run code against **sample** tests on Judge0 (visible results). |
| POST | `/api/exec/submit` | session (writable) | Submit against **hidden** tests (verdict + pass/fail counts only). |
| POST | `/api/review-file` | session (writable) | Store a review record set (`clipboard`/`tabs`/`cookies`). |
| POST | `/api/heartbeat` | session (writable) | Liveness + recording state + IP; raises `recording_stopped`/`ip_changed`; serves live enforcement config. |
| POST | `/api/session/beacon` | session (sendBeacon-friendly) | Liveness beacon (`hidden`/`visible`/`closing`); `hidden`/`closing` raise `tab_hidden`. |
| POST | `/api/session/room-gate` | session | Submit the invigilator room start code. |
| POST | `/api/session/enforcement-violation` | session | Report a fullscreen exit; server decides lock vs alert. |
| POST | `/api/session/unlock-gate` | session | Submit an invigilator unlock code to release a fullscreen lock. |
| POST | `/api/session/validate-end` | session (writable) | Pre-flight the end (requires `assurance_accepted:true`). |
| POST | `/api/session/end` | session (writable) | End the session, write `manifest.json`, release the live slot. |
| POST | `/api/submission-events` | session (writable) | Append submission-time timeline markers. |

### Admin — contests, templates, problems, roster

| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/api/admin/settings` | Read/save schedule + contest URL (legacy single-contest settings). |
| GET/POST | `/api/admin/contests` | List / create contests (create may use `template_slug`). |
| POST | `/api/admin/contest-update` · `contest-status` · `contest-regenerate` · `contest-exam-time` | Update fields / status / regenerate codes / set exam time. |
| GET | `/api/admin/templates` · `/api/admin/template` | List / read templates. |
| POST | `/api/admin/templates` · `template-update` · `template-archive` · `template-clone` · `template-delete` | Template CRUD. |
| GET | `/api/admin/problems` · `/api/admin/problem` | List / read problems (with hidden tests). |
| POST | `/api/admin/problems` · `problem-delete` | Save / delete a problem (live-reference guard). |
| GET/POST | `/api/admin/roster` | Read / upload a per-contest roster (college column → identity pipeline). |

### Admin — live monitoring, sessions, alerts

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/sessions` · `recording-sessions` · `sessions-list` · `session-detail` · `session-events` | Per-user sessions + evidence / recording picker / list / one-session detail / event stream. |
| POST | `/api/admin/session-action` · `session-details` | Bulk action (`approve`/`lock`/`unlock`/`bypass`/`end`/`exempt`) / per-user detail CSV. |
| GET | `/api/admin/submission-events` | Submission timeline markers for a session. |
| GET | `/api/admin/stats` | Counts by status (live/locked/pending/finished/disconnected) + rooms. |
| GET | `/api/admin/ip-report` · `attendance` | IP clustering drill-down / roster taken–not-taken. |
| POST | `/api/admin/exam-time` | Live end-time control (absolute / extend / force-end-now). |
| POST | `/api/alerts` | Ingest one alert or a batch (`{alerts:[…]}`, idempotent on `alert.id`). |
| GET | `/api/admin/alerts` | List alerts newest-first with filters + `download_url` from `video_key`. |
| POST | `/api/admin/alert-action` | `archive`/`unarchive` a set of alert ids. |
| GET/POST | `/api/admin/alert-settings` | Read / upsert per-type proctor alert config. |

### Admin — results, people, recording review, lifecycle

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/contest-results` | Per-contest scoreboard (rank / per-problem / integrity). |
| POST | `/api/admin/contest-selection` · `contest-selection-done` · `contest-adopt` | Bulk-select shortlist / finalize / adopt into person model. |
| GET | `/api/admin/people` · `/api/admin/person` | People directory (capped fan-out) / one person's cross-round scorecard. |
| POST | `/api/admin/contest-export` · `contest-purge` · `retention-sweep` | Export zip / triple-gated purge → tombstone / scheduled retention sweep. |
| POST/GET | `/api/admin/review-roster` · `review-next` · `review-verdict` · `review-mine` · `reviews` | Multi-reviewer recording-review queue (set roster / serve next / verdict / mine / list). |

> **(partial / unverified)** The distributed reviewer **queue**
> (`review-roster`/`review-next`/`review-verdict`) is still candidate-norm-keyed,
> so person-mode queue serving does not resolve (the recording **player** path
> does). Person-mode submission-timeline markers are a pending follow-up. See
> `night-run/RESUME-ANCHOR.md` §1b.

### Invigilator (`backend/src/routes/invigilator.mjs` via `makeInvigilatorRoutes`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/invigilator/overview` | Which rooms exist, gate on/off. |
| GET | `/api/invigilator/room` | Room stats + session rows + shared alerts. |
| POST | `/api/invigilator/release-code` · `open-room` | Release the 6-digit room start code / open the whole room. |
| POST | `/api/invigilator/exempt` | Per-student enforcement exemption toggle. |
| POST | `/api/invigilator/unlock-code` · `unlock` | Mint a fullscreen unlock code / unlock a specific session. |

### Shared alert contract

Every producer and the backend agree on this shape (required on ingest: `source`,
`type`, `severity`, `timestamp`, `hackerrank_username`, `title` — the wire field
name `hackerrank_username` is **frozen for back-compat**; the candidate-facing
label is "Candidate ID"):

```jsonc
{
  "id": "<source>:<type>:<username_norm>:<contest_slug>:<dedupe>", // stable + idempotent
  "source": "proctor | contest-eval",
  "type":   "<see alert taxonomy below>",
  "severity": "critical | warning | info",
  "timestamp": "<ISO 8601>",
  "contest_slug": "<optional>",
  "hackerrank_username": "<required (frozen wire name)>",
  "username_norm": "<lowercase/sanitized>",
  "person_id": "<optional; person-mode>",
  "session_id": "<optional>",
  "room": "<optional>",
  "title": "<headline>",
  "detail": "<optional explanation>",
  "data": { /* optional structured payload */ },
  "video_key": "<optional GCS key; resolved to download_url on READ, never stored>",
  "verdict": { "status": "pending | real | false_positive | inconclusive" }
}
```

## Alert taxonomy

Two producers, two config surfaces. Verified against the code as of this writing;
the fuller catalog (with severity rules) is in
[`docs/features/alert-taxonomy.md`](docs/features/alert-taxonomy.md).

### Proctor alerts — admin **Settings** (`/api/admin/alert-settings`)

`source:"proctor"`. Catalog + defaults are `DEFAULT_PROCTOR_ALERT_SETTINGS`
(`handler.mjs:5180-5192`): every type enabled by default; a disabled type is
skipped, a configured severity overrides, and `show_to_invigilator` defaults
**false** for every type.

| Type | Default severity | Raised by |
|---|---|---|
| `recording_stopped` | critical | `/api/events` event **or** `/api/heartbeat` stopped composite `recording_state` |
| `screen_share_stopped` | critical | `/api/events` event |
| `recording_error` | critical | `/api/events` event |
| `fullscreen_enforcement` | critical | `/api/session/enforcement-violation` (server-decided) |
| `ip_changed` | warning | server-derived on `/api/heartbeat` |
| `tab_hidden` | warning | `/api/session/beacon` `kind:"hidden"`/`"closing"` |
| `tab_away` | warning (+ `threshold_seconds`, default **12**) | the optional monitoring tab-away detector |
| `disconnected` | warning | reserved type; also a derived count in `/api/admin/stats` |

> `invalid_share_surface` was **removed** — the recorder now **refuses** any
> non-`monitor` share surface (throws before recording), so the event can never
> fire. Stored alerts of that type still display, but it is no longer raised or
> configurable.

### Contest-eval alerts — OPTIONAL poller (`monitoring/alert-config.json`)

`source:"contest-eval"`, built in `monitoring/alerts.py`. Only relevant when the
optional poller runs against an externally-hosted HackerRank contest. `enabled`
gates production; a non-null `severity` overrides the dynamic severity (which
also drives verdict-seam routing):

| Type | Default severity | Meaning |
|---|---|---|
| `peer_copy_cluster` | dynamic critical (HARD) / warning (MED) | >1 distinct user with identical (skeleton) code on one MED/HARD problem |
| `recurring_pair` | dynamic critical if 2+ shared / warning if single-hard | a pair sharing identical code; the most conclusive signal |
| `web_paste` | warning | strong web/editorial provenance in fetched accepted code (Java `class Solution` FP suppressed) |
| `first_attempt_solve` | info | ACCEPTED on first attempt, **normal** problem — a corroborator, never a standalone flag |
| `tough_first_attempt` | critical | first-attempt solve on a **tough** problem (operator-marked or data-derived hard) — the real flag |

> `fast_solve` is a **deprecated alias** of `first_attempt_solve` (still loaded to
> seed defaults; no alerts emitted under that name).

## Environment variables

### backend (`backend/src/config.mjs` `loadConfig()`)

All env reads live in `config.mjs` (the env-lint guard pins env access to it +
`handler.mjs`). Note: `backend/deploy-gcp.sh` only sets a **subset** of these
(`EVIDENCE_BUCKET`, `ADMIN_PASSWORD`, `ALERTS_INGEST_API_KEY`, `ALERTS_COLLECTION`,
`PUBLIC_APP_ORIGIN`, `SESSION_COLLECTION`, `SETTINGS_COLLECTION`,
`URL_EXPIRY_SECONDS`); the rest (Judge0, `INVIGILATOR_PASSWORD`,
`RETENTION_SWEEP_API_KEY`, the `EXEC_*` tuning, `GATE_ATTEMPT_LIMIT`, the extra
collection names) are applied **manually post-deploy** per `RESUME-ANCHOR.md` §5.

| Variable | Default | Purpose |
|---|---|---|
| `EVIDENCE_BUCKET` | (required) | GCS bucket for chunks, event JSONL, manifests; signing target for alert `video_key`. |
| `ADMIN_PASSWORD` | (required) | Secret for all `/api/admin/*` (`x-admin-password`, timing-safe). |
| `INVIGILATOR_PASSWORD` | none → reject | Global invigilator fallback secret (a contest `invigilator_key` or the admin password also pass). |
| `ALERTS_INGEST_API_KEY` | none → **reject all** | Shared secret for `POST /api/alerts` (`x-api-key`). Unset = closed. |
| `RETENTION_SWEEP_API_KEY` | none → reject | Secret for `POST /api/admin/retention-sweep` (`x-api-key`; admin also passes). |
| `JUDGE0_BASE_URL` | `https://judge0-ce.p.rapidapi.com` | Judge0 endpoint for Run/Submit. |
| `JUDGE0_MODE` | `rapidapi` | `rapidapi` vs self-host auth style. |
| `JUDGE0_API_KEY` | none | RapidAPI key (rapidapi mode). |
| `JUDGE0_AUTH_TOKEN` | none | `X-Auth-Token` (self-host mode). |
| `URL_EXPIRY_SECONDS` | `900` | Lifetime of signed upload/read URLs. |
| `PUBLIC_APP_ORIGIN` | `*` | CORS allow-origin. Lock to the frontend URL in production. |
| `DISCONNECTED_STALENESS_MS` | `45000` | Active session staler than this counts as `disconnected`. |
| `EDITOR_EVENTS_INGEST_LIMIT` | `5000` | Cap on editor events per ingest call. |
| `EXEC_RUN_COOLDOWN_SECONDS` | `5` | Min seconds between Run calls per (session, problem). |
| `EXEC_SUBMIT_COOLDOWN_SECONDS` | `20` | Min seconds between Submit calls. |
| `EXEC_MAX_SUBMISSIONS_PER_SESSION` | `50` | Submit budget per session. |
| `EXEC_RUN_CONCURRENCY` · `EXEC_SUBMIT_CONCURRENCY` · `EXEC_POLL_CONCURRENCY` | `2` · `4` · `16` | Judge0 lane concurrency. |
| `EXEC_MAX_QUEUE` | `200` | Exec queue cap. |
| `GATE_ATTEMPT_LIMIT` | `20` | Room-gate brute-force cap (safe-defaulted on bad env). |
| Collection names | see below | `SESSION_COLLECTION`=`proctor_sessions`, `SETTINGS_COLLECTION`=`proctor_settings`, `ALERTS_COLLECTION`=`proctor_alerts`, `SUBMISSION_EVENTS_COLLECTION`=`proctor_submission_events`, `LIVE_LOCK_COLLECTION`=`proctor_live_locks`, `REVIEW_STATE_COLLECTION`=`proctor_review_state`, `REVIEW_COLLECTION`=`proctor_reviews`, `REVIEW_CLAIMS_COLLECTION`=`proctor_review_claims`, `SUBMISSIONS_COLLECTION`=`proctor_submissions`, `PROBLEMS_COLLECTION`=`proctor_problems`, `EDITOR_EVENTS_COLLECTION`=`editor-events` (GCS sub-prefix), `ROSTER_COLLECTION`=`proctor_roster`, `ROOM_GATES_COLLECTION`=`proctor_room_gates`, `CONTESTS_COLLECTION`=`proctor_contests`, `COLLEGES_COLLECTION`=`proctor_colleges`, `PERSONS_COLLECTION`=`proctor_persons`, `ENROLLMENTS_COLLECTION`=`proctor_enrollments`, `ADMIN_AUDIT_COLLECTION`=`proctor_admin_audit`, `TEMPLATES_COLLECTION`=`proctor_templates`. |

### frontend (`frontend/`, set at build by `frontend/deploy-gcp.sh`)

| Variable | Purpose |
|---|---|
| `VITE_API_BASE_URL` | Backend base URL the app calls. |
| `VITE_DEMO_MODE` | `true` runs the entire UI on a localStorage fake (no backend). |
| `VITE_ADMIN_PASSWORD` | Plain admin password (demo-mode local builds only). |
| `VITE_ADMIN_PASSWORD_HASH` | sha256 of `ADMIN_PASSWORD` shipped in production by `deploy-gcp.sh`; the unlock gate hashes the typed password to compare. |
| `VITE_INVIGILATOR_PASSWORD_HASH` | sha256 of `INVIGILATOR_PASSWORD` for the invigilator gate. **Note:** `RESUME-ANCHOR.md` §5 says the build needs this, but the committed `frontend/deploy-gcp.sh` only passes `VITE_ADMIN_PASSWORD_HASH` — pass this one alongside it at build time. |

### video-worker (`video-worker/`, OPTIONAL — not deployed on dev)

| Variable | Default | Purpose |
|---|---|---|
| `SOURCE_BUCKET` | `${PROJECT_ID}-proctor-evidence` | Bucket holding screen chunks. |
| `DEST_BUCKET` | `${PROJECT_ID}-proctor-review-videos` | Bucket for merged review videos + manifests. |
| `WORKER_TOKEN` | (required) | Bearer/`x-worker-token` secret for `POST /merge`. |
| `SESSION_COLLECTION` | `proctor_sessions` | Must match the backend for `merged_video_key` write-back. |
| `MAX_USERNAMES_PER_REQUEST` | `25` | Cap on usernames merged in one request. |

## Run it

**Local UI-only demo (no backend, no GCP):**
```bash
npm install
VITE_DEMO_MODE=true VITE_ADMIN_PASSWORD=dev npm run dev
# candidate: http://localhost:5173/   ·   admin: http://localhost:5173/admin (unlock: dev)
# invigilator: http://localhost:5173/invigilator
```

**Against a deployed/local backend:** set `frontend/.env.local` with
`VITE_API_BASE_URL=<backend url>` (and `VITE_ADMIN_PASSWORD` = the backend
`ADMIN_PASSWORD`), then `npm run dev`. See [`LOCAL_DEV.md`](LOCAL_DEV.md).

**GCP deploy:** see [`docs/DEPLOY.md`](docs/DEPLOY.md) /
[`docs/features/deploy-runbook.md`](docs/features/deploy-runbook.md). Briefly:
copy `.env.deploy.example` → `.env.deploy.local`, fill it, then run the deploy
scripts from the repo root in order: `backend/deploy-gcp.sh` →
`frontend/deploy-gcp.sh` → (optional) `video-worker/deploy-gcp.sh`. The scripts
enable APIs and create missing buckets/repos/indexes idempotently. **Note:** the
backend script does not set every env var (see the env table above) — Judge0, the
invigilator/sweep secrets, and the `EXEC_*` tuning are applied manually after the
first deploy.

### Optional: contest-eval monitoring poller

For **externally-hosted HackerRank** contests only. The poller, the file-queue
LLM verdict seam, and the tab-away detector live under `monitoring/`; the docs are
[`docs/features/contest-eval-monitoring.md`](docs/features/contest-eval-monitoring.md),
[`monitoring/README.md`](monitoring/README.md), and
[`monitoring/tab-away-README.md`](monitoring/tab-away-README.md). Fastest check:
`bash monitoring/run-demo.sh` (offline end-to-end, self-cleaning). Whether the
live poll runs against real HackerRank is **(unverified against real GCP)** — see
`night-run/RESUME-ANCHOR.md`.

## Repo map / where to edit

| Path | What lives here |
|---|---|
| `backend/` | The HTTP handler `src/handler.mjs` (dispatch table + most route bodies) **plus** the partial/paused decomposition: `src/config.mjs`, `src/lib/*.mjs` (`auth`, `clients`, `http`, `sanitize`, `sessionStore`), `src/routes/invigilator.mjs`, and feature modules (`contests`, `templates`, `problems`, `contestProblems`, `identity`, `people`, `scoreboard`, `dataLifecycle`, `ipReport`, `judge0Adapter`, `execQueue`). Deploy script, Firestore index, mocked-GCP tests. |
| `frontend/` | The React app: `src/App.tsx` (candidate + admin), `src/InvigilatorApp.tsx`, `src/RecordingReview.tsx`, `src/useProctorRecorder.ts`, `src/api.ts` (incl. demo shim), `src/types.ts` (shared contract), and per-area folders (`admin/`, `coding/`, `shell/`, `roster/`, `results/`, `people/`, `problems/`, `invigilator/`, `attendance/`). |
| `video-worker/` | Optional Cloud Run merge service (`src/server.mjs`). |
| `monitoring/` | Optional Python contest-eval poller (`poller.py`), analysis core (`contest_eval_core.py`), alert builder (`alerts.py`) + `alert-config.json`, CDP driver (`cdp.py`), verdict seam (`verdict_seam.py`), tab-away detector (`tab_away_detector.py`), tests, deep READMEs. |
| `docs/` | Per-area feature pages (`features/`), `DEPLOY.md`, and background research (`ROADMAP.md`, `PROCTORING_RESEARCH.md`, `PLATFORM_ALTERNATIVES.md`). |
| `night-run/` | `RESUME-ANCHOR.md` (live single-source-of-truth), walkthrough/ops docs, evidence screenshots, archives. |
| `scripts/` | `merge-gcs-videos.mjs` — local one-shot video-merge helper. |
| `spike/` | Throwaway iframe + MV3-extension spikes (not part of the running system). |
| `.env.deploy.example` | The full deployment env template. |

**Key files to start from:** `backend/src/handler.mjs` (dispatch table + most
routes) + `backend/src/config.mjs` (every env var), `frontend/src/App.tsx` +
`frontend/src/api.ts` + `frontend/src/types.ts`, and (optional)
`monitoring/poller.py` + `monitoring/alerts.py`.

**Test / verify commands:**

| Command | Covers |
|---|---|
| `cd backend && npm test` | Backend handler (mocked Firestore/Storage). |
| `cd frontend && npx vitest run` | Frontend unit suite. |
| `cd frontend && npm run build` | Frontend production build. |
| `python3 monitoring/test_monitoring.py` | Contest-eval core, verdict seam, alert build/idempotency. |
| `python3 monitoring/test_tab_away.py` | Tab-away pipeline + contract (synthesizes its own clip). |
| `python3 monitoring/validate_fixtures.py` | Byte-for-byte reproduction of `clone_analysis.json`. |
| `bash monitoring/run-demo.sh` | Offline poller → ingest → admin-read end-to-end. |

> Exact passing test counts drift commit-to-commit; `night-run/RESUME-ANCHOR.md`
> carries the current numbers. Run the suites for the truth rather than trusting a
> number here.

## Status & caveats

The live single-source-of-truth for repo status, deployed revisions, and open
items is **[`night-run/RESUME-ANCHOR.md`](night-run/RESUME-ANCHOR.md)** — read it
before a real contest. Known partial / unverified surfaces (see §1b + the E2E
findings there): the **video-worker** merge path is not deployed on dev; the
contest-eval **live** poll against real HackerRank is unverified against real GCP;
and the **person-mode distributed reviewer queue** does not resolve (the recording
**player** does). The architecture decomposition is **paused** mid-way — the
dispatch table + most route bodies still live in `handler.mjs`.

### Storage layout

Per-session GCS objects key off one persisted `storage_prefix`:
```
contests/<contest_slug>/sessions/<username_norm>/<session_id>/...   # contest URL set
sessions/<username_norm>/<session_id>/...                           # legacy fallback
```
`contest_slug` is the **last path segment** of the configured contest URL (run
through the same `sanitizeSegment` as usernames).

### Capacity notes

Tuned for cost: zero min instances (set 1 for the real exam), low-bitrate screen
chunks, 3-day evidence auto-delete (export zips kept ~10–11 days). Video is
inherently large — at ~800 candidates × 90 min expect meaningful GCS usage. Judge0
runs on the RapidAPI key (a load probe passed; self-host was ruled out). Test with
20–30 devices before a real drive.
