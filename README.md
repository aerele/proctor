# Aerele Proctor

Browser-based companion proctoring app for a HackerRank contest. Students open this app before the test, enter their HackerRank username, grant screen sharing permission, and keep the app running while evidence is uploaded to Google Cloud Storage.

## What This Can And Cannot Do

This app can record a user-selected shared screen, detect when this proctor page is hidden or loses focus, detect when screen sharing stops, record copy/cut/paste events inside the proctor app, and upload video chunks plus JSONL event logs to Google Cloud Storage.

Plain browser apps cannot force-close tabs, enumerate other tabs, continuously read the operating-system clipboard, or prove that a user is on the HackerRank tab without a browser extension. Treat this as evidence collection for review, not automatic disqualification.

## Stack

- Frontend: React, Vite, TypeScript, Tailwind CSS
- Backend: Cloud Run HTTP service
- Storage: Google Cloud Storage direct browser uploads through signed URLs
- Metadata/settings: Firestore native mode
- Frontend hosting: Cloud Run over HTTPS

## Local Setup

```bash
npm install
npm run dev
```

Create `frontend/.env.local` for a deployed backend:

```bash
VITE_API_BASE_URL=https://YOUR_BACKEND_CLOUD_RUN_URL
```

For local UI-only testing:

```bash
VITE_DEMO_MODE=true npm run dev
```

Demo mode creates fake sessions and pretends uploads succeed. Use real Google Cloud endpoints before the drive.

## Google Cloud Deployment

The repo includes [.env.deploy.example](.env.deploy.example), a full environment template for a new developer or Codex-assisted setup. Copy it to a local ignored file:

```bash
cp .env.deploy.example .env.deploy.local
```

Fill `.env.deploy.local` with values from the developer's own Google Cloud account. The file explains each variable and includes the `gcloud` commands to discover project IDs, regions, service URLs, and existing resources. Keep `.env.deploy.local` private; it can contain real bucket names and secrets.

Install and authenticate:

```bash
brew install --cask google-cloud-sdk
gcloud auth login
```

Create or choose a Google Cloud project, then load your deployment environment:

```bash
gcloud projects list
gcloud config set project YOUR_PROJECT_ID
set -a
source .env.deploy.local
set +a
```

Deploy backend from the repo root. This enables required APIs, creates Firestore if missing, creates the evidence bucket if missing, creates the Artifact Registry repository if missing, builds the backend image, and deploys the backend Cloud Run service:

```bash
chmod +x backend/deploy-gcp.sh
SERVICE_NAME="$BACKEND_SERVICE_NAME" ./backend/deploy-gcp.sh
```

Copy the printed backend URL into `API_URL` in `.env.deploy.local`, or fetch it automatically:

```bash
export API_URL="$(gcloud run services describe "$BACKEND_SERVICE_NAME" --region "$REGION" --format="value(status.url)")"
```

Deploy the HTTPS frontend from the repo root. This builds the frontend with `VITE_API_BASE_URL` and `VITE_ADMIN_PASSWORD`, then deploys it to Cloud Run:

```bash
chmod +x frontend/deploy-gcp.sh
SERVICE_NAME="$FRONTEND_SERVICE_NAME" ./frontend/deploy-gcp.sh
```

Open the Cloud Run frontend URL printed by the command.

Admin page:

```text
https://YOUR_CLOUD_RUN_FRONTEND_URL/admin
```

Use the `ADMIN_PASSWORD` value that you set before deployment.

Optional: deploy the video merge worker if you want server-side merged review videos. This creates the destination review-video bucket if missing and deploys a protected `/merge` endpoint:

```bash
chmod +x video-worker/deploy-gcp.sh
SERVICE_NAME="$VIDEO_WORKER_SERVICE_NAME" ./video-worker/deploy-gcp.sh
```

Optional: lock backend CORS to the deployed frontend URL. After frontend deployment, set `PUBLIC_APP_ORIGIN` to the frontend Cloud Run URL in `.env.deploy.local`, reload the environment, and redeploy the backend:

```bash
export PUBLIC_APP_ORIGIN="$(gcloud run services describe "$FRONTEND_SERVICE_NAME" --region "$REGION" --format="value(status.url)")"
SERVICE_NAME="$BACKEND_SERVICE_NAME" ./backend/deploy-gcp.sh
```

The frontend URL remains the student URL. The admin page is the same URL with `/admin`.

## Admin Runbook

> **Phase 2 change:** the entry passcode and exit end-code are **removed**. Start
> is gated only by the contest time window; a single active session per
> HackerRank username (per contest) replaces the passcode as the integrity gate.

1. Open `/admin`.
2. Unlock with the configured admin password.
3. Set start time and end time (this time window is now the only start gate).
4. Set the contest URL (its last path segment becomes the storage `contest_slug`).
5. Share the student URL. No passcode to announce.
6. Watch live stats (`/api/admin/stats`) and alerts (`/api/admin/alerts`).
7. When a student logs in on a second device, their new session shows as
   `pending_approval`; approve it (which ends the old one), bypass it, or leave
   it waiting via the remote session actions (`/api/admin/session-action`).
8. Use `lock`/`unlock` for contingencies; `end` to force-finish a session.

## Student Runbook

1. Use latest Chrome or Edge on laptop/desktop.
2. Open the proctor app URL.
3. Enter HackerRank username, name, roll number, email, and room (no passcode).
4. Select `Entire screen` in the browser screen-share picker.
5. Keep recording active while using HackerRank. A reload **resumes** the same
   session (details are not re-collected).
6. After HackerRank submission, click `End test`, accept the assurance, and close
   only after the session ends (no end code).

## Alerts Ingestion API

The backend exposes a shared alerts pipeline so the proctor recorder and the
contest-eval cheating pipeline can push integrity alerts into one place for
admin review.

- `POST /api/alerts` — ingest one alert (a bare alert object) or a batch
  (`{ "alerts": [ ... ] }`). Authenticated with the `x-api-key` header, compared
  against `ALERTS_INGEST_API_KEY` using a timing-safe comparison. **If
  `ALERTS_INGEST_API_KEY` is unset the endpoint rejects every request**
  (closed-by-default). Alerts are written to the `ALERTS_COLLECTION` Firestore
  collection keyed on `alert.id` (idempotent merge), with a server `received_at`
  stamp added. Required fields: `source`, `type`, `severity`, `timestamp`,
  `hackerrank_username`, `title`.
- `GET /api/admin/alerts` — list alerts newest-first (capped at 500), with
  optional `contest_slug`, `severity`, `source`, and `room` query-param filters,
  plus `include_archived` (default excludes archived alerts).
  Authenticated with the `x-admin-password` header (same as `/api/admin/sessions`).
  Alerts that carry a `video_key` get a short-lived signed read `download_url`
  resolved at read time (never stored); signing failures degrade to `null`. Also
  returns a distinct `rooms` array (from session docs, capped) for the console
  room dropdown.
- `POST /api/admin/alert-action` — admin-authenticated. Body
  `{ action: "archive" | "unarchive", ids: [ ... ] }`. Toggles the `archived`
  flag (and stamps/clears `archived_at`) on the named alert docs. Used by the
  frontend to also-archive a session's alerts after an approve. Returns
  `{ ok, action, archived, updated: [ids…], missing: [ids…] }`.
- `GET` / `POST /api/admin/alert-settings` — admin-authenticated per-type proctor
  alert configuration; see [Proctor alert settings](#proctor-alert-settings)
  below.

Shared alert shape (all producers and the backend must agree):

```json
{
  "id": "<source>:<type>:<username_norm>:<contest_slug>:<dedupe>",
  "source": "proctor | contest-eval",
  "type": "recording_stopped | screen_share_stopped | invalid_share_surface | recording_error | ip_changed | tab_hidden | tab_away | disconnected | peer_copy_cluster | recurring_pair | web_paste | fast_solve",
  "severity": "critical | warning | info",
  "timestamp": "ISO 8601",
  "contest_slug": "optional",
  "hackerrank_username": "required",
  "username_norm": "optional lowercase/sanitized",
  "session_id": "optional",
  "room": "optional",
  "title": "short headline",
  "detail": "optional human-readable explanation",
  "data": { "optional": "structured payload" },
  "video_key": "optional GCS object key; resolved to download_url on read",
  "verdict": { "status": "pending | real | false_positive | inconclusive", "reason": "optional", "by": "optional" }
}
```

`download_url` is filled by `GET /api/admin/alerts` and is never persisted.

### Alerts env vars

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `ALERTS_INGEST_API_KEY` | Yes | none | Shared secret for `POST /api/alerts` (`x-api-key`). Unset = reject all ingest. Karthi sets the real value at deploy time; the test suite uses a throwaway placeholder. Generate with `openssl rand -base64 32`. |
| `ALERTS_COLLECTION` | No | `proctor_alerts` | Firestore collection for ingested alerts. |
| `DISCONNECTED_STALENESS_MS` | No | `45000` | An `active` session whose newest liveness signal (heartbeat or beacon) is older than this is counted as `disconnected` in `/api/admin/stats`. |

> Never commit a real `ALERTS_INGEST_API_KEY`. The deploy script and
> `.env.deploy.example` carry placeholders only; Karthi supplies the real key
> via the deployment environment.

## Session Model & Admin Controls (Phase 2)

### Storage layout — contest foldering

Every per-session GCS object is keyed off a single persisted `storage_prefix`.
With a contest URL configured, the slug is the **last path segment** of
`contest_url` (passed through the same `sanitizeSegment` as usernames):

```
contests/<contest_slug>/sessions/<username_norm>/<session_id>/...
```

When `contest_url` is empty/invalid the backend falls back to the **legacy**
layout (no double `contests//`):

```
sessions/<username_norm>/<session_id>/...
```

`contest_slug` and `storage_prefix` are written to the session doc at start, so
upload, signing, admin-evidence listing, and the video worker all build keys
from the same prefix with **zero extra Firestore reads**. The change is
backward-compatible: legacy session docs (no `storage_prefix`) resolve to their
original legacy path. The `video-worker` scans **both** layouts.

### Session document shape

```json
{
  "session_id": "uuid",
  "hackerrank_username": "Alice",
  "username_norm": "alice",
  "name": "Alice Example",
  "roll_number": "R-1",
  "email": "alice@example.com",
  "room": "optional display label",
  "contest_slug": "coding-contest-... | \"\"",
  "storage_prefix": "contests/<slug>/sessions/<user>/<sid>/ | sessions/<user>/<sid>/",
  "status": "active | pending_approval | locked | ended",
  "blocked_by_session_id": "uuid | null (set when pending_approval)",
  "start_ip": "x.x.x.x", "current_ip": "x.x.x.x", "ip_change_count": 0,
  "created_at": "ISO", "updated_at": "ISO", "ended_at": "ISO?",
  "last_heartbeat_at": "ISO?", "last_seen_at": "ISO? (heartbeat or beacon)",
  "last_beacon_kind": "hidden | visible | closing (last beacon)",
  "event_count": 0, "heartbeat_count": 0, "chunk_count": 0,
  "manifest_key": "…/manifest.json (after end)"
}
```

### Endpoints (changed / new)

- `POST /api/session/start` — body `{ hackerrank_username, name, roll_number,
  email, consent_accepted:true, room?, session_id? }`. **No passcode.** Gated by
  the contest time window only. Behaviour:
  - Replaying the **same** `session_id` (browser already owns it) → returns that
    session verbatim (idempotent resume, no duplicate doc).
  - First start for `(username_norm, contest_slug)` → `status:"active"`.
  - A start with **no/other** `session_id` while an active session already
    exists for that `(username_norm, contest_slug)` → new doc created
    `status:"pending_approval"` with `blocked_by_session_id` pointing at the live
    one. Two `active` sessions never coexist.
  - Response: `{ session_id, status, hackerrank_username, name, room,
    contest_slug, storage_prefix, blocked_by_session_id, start_ip, contest_url,
    upload_config, heartbeat_interval_seconds }`.
- `POST /api/session/resume` — body `{ session_id, hackerrank_username? }`.
  Returns the live session (same response shape as start) without re-collecting
  details. `404` if the token is unknown or (when `hackerrank_username` is
  supplied) does not belong to that user. Used by a browser reload.
- `POST /api/session/validate-end` / `POST /api/session/end` — body
  `{ session_id, assurance_accepted:true, manifest? }`. **No end code.** Only the
  integrity-assurance checkbox is required. `end` marks the session `ended` and
  writes `manifest.json` under `storage_prefix`.
- `POST /api/session/beacon` — liveness beacon, designed for
  `navigator.sendBeacon()` (fires on page hide/unload). Accepts a JSON object
  body **or** a raw `text/plain` JSON string (sendBeacon can't set custom
  headers). Gated **only** by `session_id` ownership — **no admin auth**, and it
  is **not** `requireWritableSession`-gated, so a locked/ended session can still
  emit liveness. Body `{ session_id, kind: "hidden" | "visible" | "closing" }`.
  Every kind refreshes `last_seen_at`; `hidden`/`closing` additionally upsert a
  `warning` `tab_hidden` proctor alert (carrying `video_key`/`room`/`session_id`,
  same idempotent id convention) **if** the `tab_hidden` type is enabled in the
  alert settings. Unknown `session_id` → `404`; missing `session_id` → `400`.
  Returns `{ ok, kind, last_seen_at }`.
- `GET /api/admin/stats?contest_slug=&room=` *(admin)* — counts by status:
  `{ contest_slug, room, stats: { live, locked, pending_approval, finished,
  disconnected, total, not_started_or_total }, rooms: [ ... ],
  disconnected_staleness_ms }`. `?room=` scopes the **counts** to one room (the
  `rooms` list itself stays full so the dropdown still lists every room).
  `disconnected` counts `active` sessions whose newest liveness signal
  (`last_heartbeat_at` or `last_seen_at`, falling back to `created_at` only when
  neither exists) is older than `disconnected_staleness_ms` (default `45000`,
  override via the `DISCONNECTED_STALENESS_MS` env var). `not_started_or_total`
  equals `total` (no roster is stored, so yet-to-start cannot be derived
  server-side; the frontend can estimate it once a roster exists).
- `POST /api/admin/session-action` *(admin)* — body
  `{ action, session_id?, usernames?: string[], contest_slug? }` where `action ∈
  approve | lock | unlock | bypass | end`. Targets one session (`session_id`) or
  the live session of each username in `usernames[]` (optionally scoped to a
  `contest_slug`). Semantics:
  - `approve` → activate a pending session **and** end the conflicting active
    one it was blocked behind (exactly one live afterward).
  - `lock` / `unlock` → toggle `locked` ↔ `active`.
  - `bypass` → clear a pending/locked block (set `active`, drop the conflict
    pointer) **without** ending the other session.
  - `end` → mark `ended`.
  - Returns `{ ok, action, updated: [ …updated docs… ] }`.

### Sure-shot proctor alerts

Selected proctor signals are upserted as `source:"proctor"` alerts into
`proctor_alerts` (same idempotent-id convention as ingested alerts:
`proctor:<type>:<username_norm>:<contest_slug>:<dedupe>`), so they show up in
`GET /api/admin/alerts` automatically with a `video_key` deep-link:

| Signal | Source | Default severity |
|---|---|---|
| `recording_stopped` / `screen_share_stopped` / `invalid_share_surface` / `recording_error` | `/api/events` event types | `critical` |
| `recording_stopped` | `/api/heartbeat` with a stopped `recording_state` | `critical` |
| `ip_changed` | server-derived on `/api/heartbeat` | `warning` |
| `tab_hidden` | `/api/session/beacon` with `kind:"hidden"`/`"closing"` | `warning` |

Noisy events (`focus` / `blur` / `visibility` / `clipboard`) are intentionally
**not** surfaced. `video_key` is the merged review video if one exists (else the
field is omitted — never a broken `…/screen/` folder link). `tab_away` and
`disconnected` are reserved proctor alert types (configurable in the settings
below; `disconnected` is also surfaced as a derived count in `/api/admin/stats`).

Each sure-shot upsert **consults the proctor alert settings** (one Firestore read
per request): a **disabled** type is skipped, and the **configured severity**
overrides the default in the table above.

### Proctor alert settings

- `GET /api/admin/alert-settings` *(admin)* — returns the full per-type config
  (defaults merged with any stored overrides) so the console can render a
  complete toggle list:
  `{ proctor: { <type>: { enabled: boolean, severity: "critical"|"warning"|"info" } } }`.
  Types and their defaults:
  `recording_stopped`, `screen_share_stopped`, `invalid_share_surface`,
  `recording_error` → `critical`; `ip_changed`, `tab_hidden`, `tab_away`,
  `disconnected` → `warning` (all enabled by default).
- `POST /api/admin/alert-settings` *(admin)* — upserts the same shape. Unknown
  types are dropped and invalid severities fall back to the default, so a partial
  or malformed payload can never corrupt the config. Stored as a dedicated
  `alert_settings` doc in `SETTINGS_COLLECTION` (never collides with the
  `active` schedule/contest settings doc).

### Alert archive

Alert docs carry a boolean `archived` (+ `archived_at` timestamp). A missing
`archived` field is treated as not-archived (legacy-safe).
`GET /api/admin/alerts` **excludes archived alerts by default**; pass
`?include_archived=true` to include them. `POST /api/admin/alert-action`
(`{ action, ids }`) toggles the flag. A re-firing sure-shot does **not**
un-archive an already-archived alert (the archive flag is only ever written by
`alert-action`, never by the sure-shot upsert path).

### Firestore composite index

The single-session reconciliation, bulk session-action, and per-contest stats
queries filter on **`username_norm` AND `contest_slug`**, which Firestore serves
only with a composite index. `backend/firestore.indexes.json` declares it and
`backend/deploy-gcp.sh` creates it idempotently. Without it the first such query
returns an error containing a one-click console URL to create the index.

## Capacity Notes

The default deployment is tuned for cost: Cloud Functions and Cloud Run use zero minimum instances, recordings use low-bitrate screen capture, chunks are 30 seconds, and evidence objects auto-delete after 3 days. At 800 students for 90 minutes, still expect meaningful Google Cloud Storage usage because video is inherently large. Test with 20-30 devices before the drive.
