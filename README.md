# Aerele Proctor

A **HackerRank companion proctor** (evidence collection + triage, **not** lockdown)
plus a **contest-eval live monitoring tool**. Students open the proctor app before
a contest, register, share their **entire screen**, and keep recording while
evidence streams to Google Cloud Storage. In parallel, a Python poller watches the
live HackerRank contest, runs deterministic cheating analysis each cycle, and feeds
integrity **alerts** into the same admin console the proctor evidence flows into.

## What this is — and the threat model

This is honest, browser-based proctoring. A plain web app can record a
user-selected shared screen, detect when this proctor page is hidden or unfocused,
detect when screen sharing stops, capture copy/paste inside the app, and upload
video chunks + JSONL event logs. It **cannot** force-close tabs, enumerate other
tabs, continuously read the OS clipboard, see a second device, or catch an overlay
on another monitor — no browser app can without a managed extension or endpoint
agent. So the spine of integrity here is **not** the browser: it is the
**live submission-eval** (peer-copy clusters, recurring pairs, web/editorial paste,
first-attempt-on-a-tough-question) plus **human review** of the recorded evidence.
Treat the proctor side as evidence collection and triage for review, never as
automatic disqualification.

Deeper background and the decisions behind this design live in
[`docs/PROCTORING_RESEARCH.md`](docs/PROCTORING_RESEARCH.md),
[`docs/PLATFORM_ALTERNATIVES.md`](docs/PLATFORM_ALTERNATIVES.md), and
[`docs/ROADMAP.md`](docs/ROADMAP.md). Read those rather than expecting this README
to re-derive them.

## Architecture

Four components share one alerts pipeline and one storage convention:

```
                     ┌─────────────────────────────┐
   student browser → │ frontend/  (React + Vite)    │ ← /admin console (same app)
                     │  recorder + admin console    │
                     └──────────────┬──────────────┘
        signed-URL PUT (video chunks)│ JSON (start/heartbeat/events/end,
        + JSONL events to GCS        │       admin stats/alerts/actions)
                                     ▼
                     ┌─────────────────────────────┐        ┌───────────────┐
                     │ backend/  (Cloud Run HTTP)   │◀──────▶│  Firestore    │
                     │  handler.mjs                 │  sessions, settings,
                     │  - session lifecycle         │  alerts, live-locks
                     │  - signed evidence uploads   │        └───────────────┘
                     │  - alerts ingest + admin read│        ┌───────────────┐
                     │  - sure-shot proctor alerts  │◀──────▶│  GCS (evidence│
                     └───┬────────────────────▲─────┘  chunks│  + manifests) │
        POST /api/alerts │  (x-api-key)        │ video_key    └──────┬────────┘
        (shared contract)│                     │ deep-link           │ chunks
                         │                     │                     ▼
   ┌─────────────────────┴───────┐   ┌─────────┴──────────┐   ┌──────────────┐
   │ monitoring/  (Python poller)│   │ tab_away_detector  │   │ video-worker/│
   │  - cdp.py drives Chrome:9222│   │  (S1, local CV on  │   │  merge chunks│
   │  - deterministic analysis   │   │   a recording)     │   │  → review vid│
   │  - 429-safe lazy code fetch │   └────────────────────┘   │  writes back │
   │  - LLM verdict seam (files) │                            │ merged_video_│
   └─────────────────────────────┘                            │ key on doc   │
                                                              └──────────────┘
```

- **frontend/** — React/Vite/TS/Tailwind. `/` is the student recorder; `/admin` is
  the console. Demoable with `VITE_DEMO_MODE` (no backend). → [`frontend/README.md`](frontend/README.md)
- **backend/** — one Cloud Run HTTP handler (`src/handler.mjs`). Owns sessions,
  signed uploads, alerts ingest/read, settings, admin actions. State in Firestore +
  GCS. → [`backend/README.md`](backend/README.md)
- **video-worker/** — optional Cloud Run service that merges screen chunks into one
  review video and writes its key back onto the session. → [`video-worker/README.md`](video-worker/README.md)
- **monitoring/** — standalone Python contest-eval poller + the file-queue LLM
  verdict seam + the tab-away detector. POSTs alerts to `/api/alerts`. → [`monitoring/README.md`](monitoring/README.md)

**How they connect:** every producer (the proctor recorder via the backend, the
contest-eval poller, the tab-away detector) emits the **same shared `Alert` JSON
contract** and they all land in one Firestore collection that the admin console
reads. Ambiguous contest-eval alerts route through a **file-queue verdict seam**
(`night-run/verdict-queue/pending` → `done`) that a Claude Code `/loop` resolves.
Evidence is stored under one **contest-foldered GCS prefix** every component agrees on.

## Features

- **Passcode-free session model** — start is gated by the **contest time window**
  only; end by the **integrity-assurance checkbox** only. A browser reload
  **resumes** the same session without re-collecting details. **Single active
  session** per `(username_norm, contest_slug)` enforced by an atomic Firestore
  live-slot lock; a second device lands in `pending_approval`. Admin actions:
  **approve** (activate pending + end the conflicting one), **lock**/**unlock**,
  **bypass** (activate without ending the other), **end**.
- **Contest-foldered GCS storage** — every per-session object is keyed off one
  persisted `storage_prefix`: `contests/<slug>/sessions/<username_norm>/<session_id>/…`
  (legacy `sessions/<username_norm>/<session_id>/…` when no contest URL). Built once
  at start; upload/signing/evidence-listing/merge all reuse it with zero extra reads.
- **Sure-shot proctor alerts** — selected high-signal proctor events become
  idempotent `source:"proctor"` alerts (recording stopped, screen-share stopped,
  recording error, IP changed, proctor tab hidden) with a `video_key` deep-link.
  Noisy focus/blur/visibility/clipboard events are intentionally not surfaced.
- **Alerts ingestion API + admin Live Alerts Console** — `POST /api/alerts`
  (x-api-key, closed-by-default) ingests one or a batch; the console lists them
  newest-first with **archive**, **room/severity/source filters**, and **video
  deep-links** (short-lived signed read URLs resolved at read time, never stored).
- **Live stats dashboard + near-live signal** — `/api/admin/stats` counts by status
  (live/locked/pending/finished + a derived **disconnected** count) with a room
  dropdown; the console **auto-polls every 5s**. Near-live disconnection comes from a
  **tab-close beacon** (`navigator.sendBeacon`) + **heartbeat-staleness** detection.
- **Contest-eval poller** — unattended live polling: `cdp.py` drives an
  already-logged-in Chrome on `:9222`, opening and closing **its own** background
  tab. Deterministic metadata analysis each cycle; **lazy, 429-safe** code fetch for
  flagged candidates only (hardest-first, never stores a failed fetch).
- **LLM verdict seam** — ambiguous alerts route to a file-queue a Claude Code
  `/loop` responder drains (subscription only, no paid API). Interface is swappable
  (a future **C3** transport can replace the filesystem without touching the poller).
- **Tab-away (S1) detector** — local image-recognition over a screen recording:
  flags continuous spans where the HackerRank header logo is absent as `tab_away`
  alerts deep-linked to the recording. → [`monitoring/tab-away-README.md`](monitoring/tab-away-README.md)
- **Student guided UX + recovery** — step banner, identity confirmation, periodic
  integrity checkpoints, blocked-screen self-service re-check, and inline recovery
  for **invalid share surface** (the recorder refuses anything but Entire Screen),
  cancelled share, and a failed end-submit — never a forced reload.
- **Admin password hashing** — the frontend ships only a **sha256 hash**
  (`VITE_ADMIN_PASSWORD_HASH`) and the unlock gate hashes the typed password to
  compare; the plain password is no longer baked into the bundle.

## HTTP API reference

All routes live in `backend/src/handler.mjs`. Auth columns: **x-api-key** =
`ALERTS_INGEST_API_KEY` (timing-safe); **x-admin-password** = `ADMIN_PASSWORD`;
**session** = knowing the `session_id` (no header). CORS allows
`GET,POST,OPTIONS`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/session/start` | none (time-window gate) | Register/start a session, or idempotently replay an owned `session_id`. Second device for an active `(user, contest)` → `pending_approval`. |
| POST | `/api/session/resume` | session | Return an existing session verbatim after a reload (no re-collection). 404 on unknown/mismatched token. |
| POST | `/api/upload-url` | session (writable) | Mint a v4 signed **write** URL for a video chunk under the session prefix. |
| POST | `/api/events` | session (writable) | Append a JSONL batch of client events; raise sure-shot alerts for high-signal types. |
| POST | `/api/review-file` | session (writable) | Store a review record set (`clipboard` / `tabs` / `cookies`). |
| POST | `/api/heartbeat` | session (writable) | Liveness + recording state + IP; raises `recording_stopped` / `ip_changed` sure-shots; returns live status. |
| POST | `/api/session/beacon` | session (no admin auth; sendBeacon-friendly) | Liveness beacon (`hidden`/`visible`/`closing`); `hidden`/`closing` raise the `tab_hidden` sure-shot. Not writable-gated (locked/ended can still report liveness). |
| POST | `/api/session/validate-end` | session (writable) | Pre-flight the end: requires `assurance_accepted:true`. |
| POST | `/api/session/end` | session (writable) | End the session, write `manifest.json`, release the live slot. Requires `assurance_accepted:true`. |
| GET | `/api/admin/settings` | x-admin-password | Read the schedule + contest URL (public/sanitized view). |
| POST | `/api/admin/settings` | x-admin-password | Save `start_at`/`end_at` (+ optional `contest_url`); derives `contest_slug`. |
| GET | `/api/admin/sessions?username=` | x-admin-password | One user's recent sessions + their evidence objects with signed read URLs. |
| GET | `/api/admin/stats?contest_slug=&room=` | x-admin-password | Counts by status (live/locked/pending/finished/disconnected/total) + the rooms list. |
| POST | `/api/admin/session-action` | x-admin-password | `approve`\|`lock`\|`unlock`\|`bypass`\|`end` one `session_id` or each of `usernames[]`. |
| POST | `/api/alerts` | x-api-key | Ingest one alert (bare object) or a batch (`{alerts:[…]}`, max 500); idempotent merge on `alert.id`. Rejects all if the key is unset. |
| GET | `/api/admin/alerts` | x-admin-password | List alerts newest-first (≤500); filters `contest_slug`/`severity`/`source`/`room` + `include_archived`; fills `download_url` from `video_key`; returns `rooms`. |
| POST | `/api/admin/alert-action` | x-admin-password | `archive`\|`unarchive` a set of alert `ids`. |
| GET | `/api/admin/alert-settings` | x-admin-password | Full per-type proctor alert config (defaults merged with overrides). |
| POST | `/api/admin/alert-settings` | x-admin-password | Upsert per-type proctor alert config (unknown types dropped, bad severities defaulted). |

Any other path → `404`. Intentional 4xx errors echo a `detail` message; unexpected
errors return a generic `500` with no internal detail.

### Templates + multi-problem contests (S-I, backend)

Contests carry an **ordered `problems[]`** (`{problem_id, points, order}`;
`points: null` = use the bank problem's points). Legacy single-problem reads
(`settings.problem_id`) keep working unchanged through the
`contestProblemEntries` shim — zero migration. **Templates**
(`/api/admin/templates`, `template`, `template-update`, `template-archive`,
`template-clone`) are reusable contest blueprints: instantiating one
(`POST /api/admin/contests` with `template_slug`) **snapshot-copies** the
problem list + defaults onto the contest — later template edits change
nothing — while problem **content** stays live from the bank, made safe by the
live-reference guard (delete/unpublish of a referenced problem → `409`
`problem_referenced`; hidden-test edits against an open contest demand a typed
`confirm_live_edit`). The built-in **`system-check` preset** instantiates the
always-open day-before lab-check contest (one trivial problem, no room gate,
1-day evidence retention); a Firestore template doc with the same slug shadows
it. Exec cooldowns are **per (session, problem)** with a
one-in-flight-per-session guard; `session/start`/`resume` serve `problems[]` +
`submissions_summary` + `submit_budget` (the single `problem` field remains
for one release as `problems[0]`).

### Shared alert contract

Every producer and the backend agree on this shape (required on ingest: `source`,
`type`, `severity`, `timestamp`, `hackerrank_username`, `title`):

```jsonc
{
  "id": "<source>:<type>:<username_norm>:<contest_slug>:<dedupe>", // stable + idempotent
  "source": "proctor | contest-eval",
  "type":   "<see alert taxonomy below>",
  "severity": "critical | warning | info",
  "timestamp": "<ISO 8601>",
  "contest_slug": "<optional>",
  "hackerrank_username": "<required>",
  "username_norm": "<lowercase/sanitized>",
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

Two producers, two config surfaces. Verified against the code as of this writing.

### Proctor alerts — configured in admin **Settings** (`/api/admin/alert-settings`)

`source:"proctor"`. The configurable catalog and defaults (`DEFAULT_PROCTOR_ALERT_SETTINGS`
in `handler.mjs`) — every type enabled by default; a disabled type is skipped and a
configured severity overrides the default:

| Type | Default severity | Raised by |
|---|---|---|
| `recording_stopped` | critical | `/api/events` event **or** `/api/heartbeat` with a stopped composite `recording_state` |
| `screen_share_stopped` | critical | `/api/events` event |
| `recording_error` | critical | `/api/events` event |
| `ip_changed` | warning | server-derived on `/api/heartbeat` |
| `tab_hidden` | warning | `/api/session/beacon` `kind:"hidden"`/`"closing"` |
| `tab_away` | warning (+ `threshold_seconds`, default **12**) | the monitoring tab-away detector; `threshold_seconds` is the source of truth for its `--min-gap-seconds` |
| `disconnected` | warning | reserved type; also surfaced as a derived count in `/api/admin/stats` |

> `invalid_share_surface` was **removed** from the catalog — the recorder now
> **refuses** to record on any non-`monitor` share surface (throws before
> recording), so the event can never fire. Existing stored alerts of that type
> still display, but it is no longer raised or configurable.

### Contest-eval alerts — configured in `monitoring/alert-config.json`

`source:"contest-eval"`, built in `monitoring/alerts.py`. `enabled` gates whether a
type is produced; `severity` (non-null) overrides the dynamic severity (which also
drives verdict-seam routing):

| Type | Default severity | Meaning |
|---|---|---|
| `peer_copy_cluster` | critical (config); dynamic critical on HARD / warning on MED | >1 distinct user with identical (skeleton) code on one MED/HARD problem (EASY/SQL dropped) |
| `recurring_pair` | critical (config); dynamic critical if 2+ shared / warning if single-hard | a pair sharing identical code; the most conclusive signal |
| `web_paste` | warning | strong web/editorial provenance signature in fetched accepted code (Java `class Solution` template FP suppressed) |
| `first_attempt_solve` | info | problem ACCEPTED on the candidate's first attempt, **normal** problem — a corroborator, never a standalone flag |
| `tough_first_attempt` | critical | a first-attempt solve on a **tough** problem (operator-marked in `tough_questions` OR data-derived hard, ≤10 solvers) — the real flag |

> `fast_solve` is a **deprecated alias** of `first_attempt_solve`: it still loads
> from `alert-config.json` (seeding the `first_attempt_solve` defaults when that key
> is absent), but no alerts are emitted under that name anymore.

## Environment variables

### backend (`backend/src/handler.mjs`, set by `backend/deploy-gcp.sh`)

| Variable | Default | Purpose |
|---|---|---|
| `EVIDENCE_BUCKET` | (required) | GCS bucket for evidence chunks, event JSONL, manifests, and the signing target for alert `video_key`. |
| `ADMIN_PASSWORD` | (required) | Secret for all `/api/admin/*` (`x-admin-password`). |
| `ALERTS_INGEST_API_KEY` | none → **reject all** | Shared secret for `POST /api/alerts` (`x-api-key`, timing-safe). Unset = closed. Generate with `openssl rand -base64 32`. |
| `ALERTS_COLLECTION` | `proctor_alerts` | Firestore collection for alerts. |
| `SESSION_COLLECTION` | `proctor_sessions` | Firestore collection for session docs. |
| `SETTINGS_COLLECTION` | `proctor_settings` | Firestore collection for schedule + alert settings docs. |
| `LIVE_LOCK_COLLECTION` | `proctor_live_locks` | Firestore collection for the single-active-session live-slot locks. |
| `PUBLIC_APP_ORIGIN` | `*` | CORS `access-control-allow-origin`. Lock to the frontend URL in production. |
| `URL_EXPIRY_SECONDS` | `900` | Lifetime of signed upload/read URLs (seconds). |
| `DISCONNECTED_STALENESS_MS` | `45000` | An active session whose newest liveness signal is older than this counts as `disconnected` in stats. |

### frontend (`frontend/`, set at build by `frontend/deploy-gcp.sh`)

| Variable | Purpose |
|---|---|
| `VITE_API_BASE_URL` | Backend base URL the app calls. |
| `VITE_DEMO_MODE` | `true` runs the entire UI on a localStorage fake (no backend). |
| `VITE_ADMIN_PASSWORD` | Plain admin password (used only by demo-mode local builds). |
| `VITE_ADMIN_PASSWORD_HASH` | sha256 of `ADMIN_PASSWORD` shipped in production builds; the unlock gate hashes the typed password to compare. The plain password is **not** put in the bundle by `deploy-gcp.sh`. |

### video-worker (`video-worker/`, set by `video-worker/deploy-gcp.sh`)

| Variable | Default | Purpose |
|---|---|---|
| `SOURCE_BUCKET` | `${PROJECT_ID}-proctor-evidence` | Bucket holding screen chunks (usually the evidence bucket). |
| `DEST_BUCKET` | `${PROJECT_ID}-proctor-review-videos` | Bucket for merged review videos + manifests. |
| `WORKER_TOKEN` | (required) | Bearer/`x-worker-token` secret for `POST /merge`. |
| `SESSION_COLLECTION` | `proctor_sessions` | Must match the backend so `merged_video_key` write-back hits the right doc. |
| `MAX_USERNAMES_PER_REQUEST` | `25` | Cap on usernames merged in one request. |

### deploy template (`.env.deploy.example` → `.env.deploy.local`)

Carries `PROJECT_ID`, `REGION`, `REPOSITORY`, the secrets above, the three
bucket names, the three Cloud Run `*_SERVICE_NAME`s, and `API_URL`. See the file
for the `gcloud` commands that discover each value.

## Run it

**Local UI-only demo (no backend, no GCP):**
```bash
npm install
VITE_DEMO_MODE=true VITE_ADMIN_PASSWORD=dev npm run dev
# student: http://localhost:5173/   ·   admin: http://localhost:5173/admin (unlock: dev)
```

**Against a deployed/local backend:** set `frontend/.env.local` with
`VITE_API_BASE_URL=<backend url>` (and `VITE_ADMIN_PASSWORD` = the backend
`ADMIN_PASSWORD`), then `npm run dev`.

**Monitoring tool (poller + verdict responder + tab-away):** the full runbook —
backend locally, admin console, fixtures + live poller, and the `/loop` verdict
responder — is in **[`night-run/HOW-TO-RUN.md`](night-run/HOW-TO-RUN.md)**. Fastest
check: `bash monitoring/run-demo.sh` (offline end-to-end, self-cleaning).

**GCP deploy:** copy `.env.deploy.example` → `.env.deploy.local`, fill it, then run
the deploy scripts from the repo root in order:
`backend/deploy-gcp.sh` → `frontend/deploy-gcp.sh` → (optional) `video-worker/deploy-gcp.sh`.
The scripts enable APIs and create missing buckets/repos/indexes idempotently. Full
step-by-step (including locking CORS to the frontend origin) is below in
[Deploy details](#deploy-details).

## Repo map / where to edit

| Path | What lives here |
|---|---|
| `backend/` | The one HTTP handler (`src/handler.mjs`) — sessions, uploads, alerts, settings, admin actions — its deploy script, Firestore index, and mocked-GCP tests. |
| `frontend/` | The React app (`src/App.tsx` student + admin; `src/useProctorRecorder.ts` recorder; `src/api.ts` incl. demo shim; `src/types.ts` shared contract). |
| `video-worker/` | Optional Cloud Run merge service (`src/server.mjs`). |
| `monitoring/` | Python poller (`poller.py`), analysis core (`contest_eval_core.py`), alert builder (`alerts.py`) + `alert-config.json`, CDP driver (`cdp.py`), verdict seam (`verdict_seam.py`) + responder prompt, tab-away detector (`tab_away_detector.py`), tests, and several deep READMEs. |
| `night-run/` | The overnight build's runbook (`HOW-TO-RUN.md`), open-items review (`MORNING-REVIEW.md`), log, goal, PR body, and the `verdict-queue/`. |
| `docs/` | Background research: `ROADMAP.md`, `PROCTORING_RESEARCH.md`, `PLATFORM_ALTERNATIVES.md`. |
| `scripts/` | `merge-gcs-videos.mjs` — local one-shot video-merge helper. |
| `spike/` | Throwaway iframe + MV3-extension spikes (not part of the running system). |
| `.env.deploy.example` | The full deployment env template. |

**Key files to start from:** `backend/src/handler.mjs` (every route + env var),
`frontend/src/App.tsx` + `frontend/src/api.ts`, `monitoring/poller.py` +
`monitoring/alerts.py`, `video-worker/src/server.mjs`.

**Test / verify commands:**

| Command | Covers |
|---|---|
| `npm run backend:test` | Backend handler (mocked Firestore/Storage) — **111 tests**. |
| `python3 monitoring/test_monitoring.py` | Contest-eval core, verdict seam, alert build/idempotency — **60 tests**. |
| `python3 monitoring/test_tab_away.py` | Tab-away pipeline + contract (synthesizes its own clip). |
| `python3 monitoring/validate_fixtures.py` | Byte-for-byte reproduction of `clone_analysis.json`. |
| `npm run lint` | Frontend type-check (`tsc -b`). |
| `npm run build` | Frontend production build. |
| `bash monitoring/run-demo.sh` | Offline poller → ingest → admin-read end-to-end. |

## Status & caveats

This repo was built out heavily overnight. The current open items — what is **done**
(e.g. **C1**, the admin-password hashing, is now done — the frontend ships only the
hash), what is **untested against real GCP** (the contest-folder upload path, a real
POST→Firestore→GET round-trip, the cross-bucket `video_key` deep-link, the
video-worker merge + Firestore write-back, the composite index), and the **deferred
hardening** (the admin-auth architecture call, the `session_id`-as-sole-bearer
hardening, and other escalated findings) — are tracked in
**[`night-run/MORNING-REVIEW.md`](night-run/MORNING-REVIEW.md)**. Read it before a
real contest.

---

## Deploy details

The deploy scripts assume `gcloud` is authenticated and `.env.deploy.local` is
sourced. Each script is idempotent (re-running is safe).

```bash
brew install --cask google-cloud-sdk   # or your platform's gcloud install
gcloud auth login
cp .env.deploy.example .env.deploy.local   # then fill it in (keep it private)
gcloud config set project YOUR_PROJECT_ID
set -a; source .env.deploy.local; set +a
```

**1. Backend** (enables APIs; creates Firestore, the evidence bucket, the Artifact
Registry repo, and the `username_norm`+`contest_slug` composite index; grants IAM;
builds + deploys):
```bash
SERVICE_NAME="$BACKEND_SERVICE_NAME" ./backend/deploy-gcp.sh
export API_URL="$(gcloud run services describe "$BACKEND_SERVICE_NAME" --region "$REGION" --format='value(status.url)')"
```

**2. Frontend** (builds with `VITE_API_BASE_URL` + `VITE_ADMIN_PASSWORD_HASH`,
deploys to Cloud Run). Admin page is the same URL with `/admin`:
```bash
SERVICE_NAME="$FRONTEND_SERVICE_NAME" ./frontend/deploy-gcp.sh
```

**3. (Optional) Video worker** (creates the review-video bucket, deploys the
protected `/merge` endpoint):
```bash
SERVICE_NAME="$VIDEO_WORKER_SERVICE_NAME" ./video-worker/deploy-gcp.sh
```

**4. (Optional) Lock backend CORS to the frontend origin** and redeploy:
```bash
export PUBLIC_APP_ORIGIN="$(gcloud run services describe "$FRONTEND_SERVICE_NAME" --region "$REGION" --format='value(status.url)')"
SERVICE_NAME="$BACKEND_SERVICE_NAME" ./backend/deploy-gcp.sh
```

### Storage layout

Per-session GCS objects key off one persisted `storage_prefix`:
```
contests/<contest_slug>/sessions/<username_norm>/<session_id>/...   # contest URL set
sessions/<username_norm>/<session_id>/...                           # legacy fallback
```
`contest_slug` is the **last path segment** of the configured contest URL (run
through the same `sanitizeSegment` as usernames). The video-worker scans both
layouts.

### Capacity notes

Tuned for cost: zero min instances, low-bitrate 30s screen chunks, 3-day evidence
auto-delete. Video is inherently large — at ~800 students × 90 min expect
meaningful GCS usage. Test with 20–30 devices before a real drive.
