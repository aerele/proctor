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

1. Open `/admin`.
2. Unlock with the configured admin password.
3. Set start time and end time.
4. Set the contest URL.
5. Set proctoring passcode for students to start.
6. Set proctoring end code for students to finish.
7. Share the student URL and start passcode.
8. At the end, give the end code only after HackerRank submission.

## Student Runbook

1. Use latest Chrome or Edge on laptop/desktop.
2. Open the proctor app URL.
3. Enter proctoring passcode, HackerRank username, name, roll number, and email.
4. Select `Entire screen` in the browser screen-share picker.
5. Keep recording active while using HackerRank.
6. After HackerRank submission, click `End test`, accept the assurance, enter the end code, and close only after the session ends.

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
  optional `contest_slug`, `severity`, and `source` query-param filters.
  Authenticated with the `x-admin-password` header (same as `/api/admin/sessions`).
  Alerts that carry a `video_key` get a short-lived signed read `download_url`
  resolved at read time (never stored); signing failures degrade to `null`.

Shared alert shape (all producers and the backend must agree):

```json
{
  "id": "<source>:<type>:<username_norm>:<contest_slug>:<dedupe>",
  "source": "proctor | contest-eval",
  "type": "recording_stopped | screen_share_stopped | invalid_share_surface | recording_error | ip_changed | peer_copy_cluster | recurring_pair | web_paste | fast_solve",
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

> Never commit a real `ALERTS_INGEST_API_KEY`. The deploy script and
> `.env.deploy.example` carry placeholders only; Karthi supplies the real key
> via the deployment environment.

## Capacity Notes

The default deployment is tuned for cost: Cloud Functions and Cloud Run use zero minimum instances, recordings use low-bitrate screen capture, chunks are 30 seconds, and evidence objects auto-delete after 3 days. At 800 students for 90 minutes, still expect meaningful Google Cloud Storage usage because video is inherently large. Test with 20-30 devices before the drive.
