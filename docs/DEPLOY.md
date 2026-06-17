# DEPLOY — Aerele Proctor build + deploy runbook

End-to-end runbook to build both container images and deploy the Aerele Proctor
platform to Google Cloud Platform (Cloud Run + Cloud Storage + Firestore + Cloud
Build + Artifact Registry) from scratch.

**Standard of truth:** every command and behavior below is verified against the
actual repo — `backend/deploy-gcp.sh`, `frontend/deploy-gcp.sh`,
`video-worker/deploy-gcp.sh`, `backend/src/config.mjs`, `backend/src/handler.mjs`,
`backend/src/lib/auth.mjs`, `frontend/src/api.ts`, `.env.deploy.example`,
`backend/gcs-lifecycle.json`, `backend/gcs-cors.json`, `README.md`, and
`night-run/GCP-SETUP-INSTRUCTIONS.md` / `night-run/RESUME-ANCHOR.md`. Anything not
directly verifiable in code or an existing screenshot is marked **(unverified)**.

> **The committed deploy scripts are a correct base but PARTIALLY STALE.**
> `backend/deploy-gcp.sh` sets only eight env vars
> (`EVIDENCE_BUCKET, ADMIN_PASSWORD, ALERTS_INGEST_API_KEY, ALERTS_COLLECTION,
> PUBLIC_APP_ORIGIN, SESSION_COLLECTION, SETTINGS_COLLECTION, URL_EXPIRY_SECONDS`).
> It does **not** set `INVIGILATOR_PASSWORD`, the `JUDGE0_*` keys,
> `RETENTION_SWEEP_API_KEY`, or the `EXEC_*` tuning. `frontend/deploy-gcp.sh`
> computes `VITE_ADMIN_PASSWORD_HASH` but **not** `VITE_INVIGILATOR_PASSWORD_HASH`.
> For a real exam you must add those — see the call-outs in each section and the
> [Required additions the scripts do NOT set](#required-additions-the-scripts-do-not-set)
> table. The live dev stack (`aerele-proctor-dev`, api rev `proctor-api-00006-pjr`
> / web rev `proctor-web-00006-d66`) was deployed via direct `gcloud builds submit`
> + `gcloud run deploy` with those extra env vars added/preserved (per
> `night-run/RESUME-ANCHOR.md` §0/§5).

---

## 0. Prerequisites and project isolation

The canonical from-scratch GCP bootstrap (project create → billing → enable APIs →
deployer SA → key → handoff env file) is **`night-run/GCP-SETUP-INSTRUCTIONS.md`**.
Run that first if the project does not yet exist. Summary of its hard rules:

- `gcloud` installed and authenticated as a user who can create projects and link
  billing.
- **Brand-new ISOLATED project.** Do NOT reuse any existing or production project.
- The deployer service account is a member of **only that one project** —
  `roles/owner` on the isolated, deletable project (or the tighter role list in the
  doc: `run.admin`, `cloudbuild.builds.editor`, `artifactregistry.admin`,
  `storage.admin`, `datastore.owner`, `serviceusage.serviceUsageAdmin`,
  `iam.serviceAccountAdmin`, `iam.serviceAccountUser`,
  `resourcemanager.projectIamAdmin`).
- **No org-level or folder-level roles.** Budget-capped and deletable.

The APIs the platform needs (also enabled idempotently by the deploy scripts):
`run`, `cloudbuild`, `artifactregistry`, `firestore`, `storage`, `iamcredentials`
(the setup doc additionally enables `cloudresourcemanager`).

### Dev project facts (current live stack)

| Fact | Value |
| --- | --- |
| Project | `aerele-proctor-dev` |
| Region | `asia-south1` |
| Deployer SA | `proctor-deployer@aerele-proctor-dev.iam.gserviceaccount.com` |
| SA key + GCP env | `monitoring/.data/gcp-dev.env` (gitignored: `GCP_PROJECT_ID` / `GCP_REGION` / `GOOGLE_APPLICATION_CREDENTIALS`) |
| gcloud binaries | `~/google-cloud-sdk/bin` |

To deploy as the scoped deployer (instead of an interactive login):

```bash
source monitoring/.data/gcp-dev.env
gcloud auth activate-service-account --key-file="$GOOGLE_APPLICATION_CREDENTIALS"
gcloud config set project "$GCP_PROJECT_ID"
```

> **Standing rule (`RESUME-ANCHOR.md` §4):** **NO `git push` EVER** until Karthi
> runs a PII history scrub (verdict-queue PII in history). Local commits only —
> **deploy does not require push**. Deploy itself is authorized (the
> `proctor-deployer` SA); deploy only when testing requires it.

---

## 1. Fill the deploy env template

```bash
cp .env.deploy.example .env.deploy.local   # gitignored — keep it private
# edit .env.deploy.local, then source it for the deploy scripts:
set -a; source .env.deploy.local; set +a
```

Fields in `.env.deploy.example` (verified):

| Field | Notes |
| --- | --- |
| `PROJECT_ID` | GCP project ID (not display name). |
| `REGION` | One region for everything (e.g. `asia-south1`). |
| `REPOSITORY` | Artifact Registry repo. Template default `proctor`. **Note:** the deploy scripts default to `aerele-proctor` when unset, so set this explicitly. |
| `ADMIN_PASSWORD` | `/admin` password. `openssl rand -base64 24`. Backend secret AND its sha256 is embedded in the frontend bundle (plain value never shipped). |
| `ALERTS_INGEST_API_KEY` | Shared secret for `POST /api/alerts`. `openssl rand -base64 32`. **Closed-by-default:** unset ⇒ ingest rejects everything. |
| `RETENTION_SWEEP_API_KEY` | Daily retention sweep key. `openssl rand -base64 32`. **Closed-by-default:** unset ⇒ `/api/admin/retention-sweep` rejects the `x-api-key` path (the admin password still triggers a manual sweep). |
| `ALERTS_COLLECTION` | Firestore alerts collection. Default `proctor_alerts`. |
| `PUBLIC_APP_ORIGIN` | CORS origin. Start `*`; tighten to the frontend URL later (§5). |
| `EVIDENCE_BUCKET` | Globally-unique GCS bucket for evidence. |
| `SOURCE_BUCKET` | Video-worker source — usually equal to `EVIDENCE_BUCKET`. |
| `DEST_BUCKET` | Merged-review-video bucket (video-worker only). |
| `BACKEND_SERVICE_NAME` | `proctor-api`. |
| `FRONTEND_SERVICE_NAME` | `proctor-web`. |
| `VIDEO_WORKER_SERVICE_NAME` | `proctor-video-worker`. |
| `API_URL` | Backend Cloud Run URL — fill AFTER the backend deploy (§2). |
| `WORKER_TOKEN` | Protects the video-worker `/merge` endpoint. `openssl rand -base64 32`. |
| `MAX_USERNAMES_PER_REQUEST` | Local merge-helper batch cap. Default `25`. |

### Required for a real exam but NOT in the template

These are read by `backend/src/config.mjs` / the frontend but are absent from
`.env.deploy.example`. Add them to `.env.deploy.local` and pass them at deploy time
(see §2/§3):

| Var | Why |
| --- | --- |
| `INVIGILATOR_PASSWORD` | Backend invigilator auth (`requireInvigilator` → 401 when wrong/unset). Also needs a frontend hash (below). |
| `JUDGE0_API_KEY` | RapidAPI key for live Run/Submit. `config.mjs` defaults `JUDGE0_MODE=rapidapi`, `JUDGE0_BASE_URL=https://judge0-ce.p.rapidapi.com`. The dev secret lives in gitignored `monitoring/.data/judge0.env` (`RESUME-ANCHOR.md` §5). |
| `EXEC_SUBMIT_COOLDOWN_SECONDS` | ≈ `20` for a real exam (default `20`). |
| `EXEC_MAX_SUBMISSIONS_PER_SESSION` | ≈ `200` for a real exam (default `50`). |
| `EXEC_RUN_CONCURRENCY` / `EXEC_SUBMIT_CONCURRENCY` / `EXEC_POLL_CONCURRENCY` / `EXEC_MAX_QUEUE` | Generous lane concurrency for capacity (defaults `2`/`4`/`16`/`200`; capacity decision in `RESUME-ANCHOR.md` §3). |

---

## 2. Deploy the backend

```bash
set -a; source .env.deploy.local; set +a
SERVICE_NAME="$BACKEND_SERVICE_NAME" ./backend/deploy-gcp.sh
```

`backend/deploy-gcp.sh` does, idempotently (verified):

1. `gcloud services enable run cloudbuild artifactregistry firestore storage iamcredentials`.
2. Creates Firestore `(default)` in `$REGION` if missing.
3. Creates the composite index on
   `proctor_sessions(username_norm ASC, contest_slug ASC)` `--async` (non-blocking;
   also declared in `backend/firestore.indexes.json`). The index builds in the
   background and never blocks the deploy.
4. Creates `EVIDENCE_BUCKET` (uniform bucket-level access) if missing.
5. Applies `backend/gcs-cors.json` (browser PUT/GET/HEAD, origin `*`) and
   `backend/gcs-lifecycle.json` (the two-rule retention split — see §2b).
6. Creates the Artifact Registry Docker repo if missing.
7. Grants the runtime SA (`<projectNumber>-compute@developer.gserviceaccount.com`):
   project `roles/datastore.user`, bucket `roles/storage.objectAdmin`, and
   `roles/iam.serviceAccountTokenCreator` on itself (needed to sign GCS URLs).
8. `gcloud builds submit backend --tag $IMAGE`.
9. `gcloud run deploy` — port `8080`, `256Mi`, cpu `1`, `--min-instances 0`,
   `--max-instances 20`, `--concurrency 100`, **`--timeout 120s`**
   (`/api/exec/*` blocks while the Judge0 adapter polls — a 30s timeout killed
   requests mid-poll).

Then capture the backend URL into `API_URL` for the frontend build:

```bash
export API_URL="$(gcloud run services describe "$BACKEND_SERVICE_NAME" \
  --region "$REGION" --format='value(status.url)')"
```

> **The script's `gcloud run deploy` `--set-env-vars` only sets eight vars**
> (`EVIDENCE_BUCKET, ADMIN_PASSWORD, ALERTS_INGEST_API_KEY, ALERTS_COLLECTION,
> PUBLIC_APP_ORIGIN, SESSION_COLLECTION, SETTINGS_COLLECTION, URL_EXPIRY_SECONDS`).
> For a real exam you must additionally set `INVIGILATOR_PASSWORD`, `JUDGE0_API_KEY`,
> `RETENTION_SWEEP_API_KEY`, and the `EXEC_*` tuning. The script uses
> `--set-env-vars` (which **replaces** the whole env map), so either (a) edit the
> script's `--set-env-vars` line to include them, or (b) run the deploy and then
> **`--update-env-vars`** the extras (`--update-env-vars` MERGES — see
> [Redeploy](#redeploy-merge-never-wipe-the-env)):
>
> ```bash
> gcloud run services update "$BACKEND_SERVICE_NAME" --region "$REGION" \
>   --update-env-vars="INVIGILATOR_PASSWORD=${INVIGILATOR_PASSWORD},JUDGE0_API_KEY=${JUDGE0_API_KEY},JUDGE0_MODE=rapidapi,RETENTION_SWEEP_API_KEY=${RETENTION_SWEEP_API_KEY},EXEC_SUBMIT_COOLDOWN_SECONDS=20,EXEC_MAX_SUBMISSIONS_PER_SESSION=200"
> ```

### Backend env var reference (verified `backend/src/config.mjs`)

`config.mjs` is the single env source besides `handler.mjs`. Unset collections fall
back to `proctor_*` defaults; the four credentials are closed-by-default when unset.

**Collections** (Firestore collection-name overrides; all default to the value shown):
`SESSION_COLLECTION` (`proctor_sessions`), `SETTINGS_COLLECTION` (`proctor_settings`),
`ALERTS_COLLECTION` (`proctor_alerts`),
`SUBMISSION_EVENTS_COLLECTION` (`proctor_submission_events`),
`LIVE_LOCK_COLLECTION` (`proctor_live_locks`),
`REVIEW_STATE_COLLECTION` (`proctor_review_state`),
`REVIEW_COLLECTION` (`proctor_reviews`),
`REVIEW_CLAIMS_COLLECTION` (`proctor_review_claims`),
`SUBMISSIONS_COLLECTION` (`proctor_submissions`),
`PROBLEMS_COLLECTION` (`proctor_problems`),
`EDITOR_EVENTS_COLLECTION` (`editor-events`, a GCS sub-prefix label),
`ROSTER_COLLECTION` (`proctor_roster`),
`ROOM_GATES_COLLECTION` (`proctor_room_gates`),
`CONTESTS_COLLECTION` (`proctor_contests`),
`COLLEGES_COLLECTION` (`proctor_colleges`),
`PERSONS_COLLECTION` (`proctor_persons`),
`ENROLLMENTS_COLLECTION` (`proctor_enrollments`),
`ADMIN_AUDIT_COLLECTION` (`proctor_admin_audit`),
`TEMPLATES_COLLECTION` (`proctor_templates`).

**Storage / Judge0:**

| Var | Default | Notes |
| --- | --- | --- |
| `EVIDENCE_BUCKET` | (none) | Required for evidence uploads + signed URLs. |
| `JUDGE0_BASE_URL` | `https://judge0-ce.p.rapidapi.com` | |
| `JUDGE0_MODE` | `rapidapi` | |
| `JUDGE0_API_KEY` | (none) | RapidAPI key — required for live Run/Submit. |
| `JUDGE0_AUTH_TOKEN` | (none) | Alternate auth (self-host token mode). |
| `URL_EXPIRY_SECONDS` | `900` | Signed-URL TTL. |

**Credentials (closed-by-default when unset):**

| Var | Effect when unset |
| --- | --- |
| `ADMIN_PASSWORD` | `requireAdmin` → 401 (admin routes inaccessible). |
| `INVIGILATOR_PASSWORD` | `requireInvigilator` → 401. |
| `ALERTS_INGEST_API_KEY` | `POST /api/alerts` rejects all. |
| `RETENTION_SWEEP_API_KEY` | `/api/admin/retention-sweep` rejects the `x-api-key` path (admin password still works). |

**Tunables:** `EDITOR_EVENTS_INGEST_LIMIT` (`5000`),
`EXEC_RUN_COOLDOWN_SECONDS` (`5`), `EXEC_SUBMIT_COOLDOWN_SECONDS` (`20`),
`EXEC_MAX_SUBMISSIONS_PER_SESSION` (`50`),
`EXEC_RUN_CONCURRENCY` (`2`), `EXEC_SUBMIT_CONCURRENCY` (`4`),
`EXEC_POLL_CONCURRENCY` (`16`), `EXEC_MAX_QUEUE` (`200`),
`DISCONNECTED_STALENESS_MS` (`45000`), `PUBLIC_APP_ORIGIN` (`*`),
`GATE_ATTEMPT_LIMIT` (`20`).

### 2b. Retention lifecycle + daily sweep (Wave-7)

`backend/gcs-lifecycle.json` is **two prefix-scoped rules** (verified):

- Delete objects under `contests/` and `sessions/` at **age 3 days** (per-session evidence).
- Delete objects under `exports/` at **age 11 days** (export recovery zips).

The split is load-bearing: a single blanket `age:3` rule would delete export
recovery archives 7 days early. The `/api/admin/retention-sweep` endpoint owns the
canonical 10-day deletion of export zips; the GCS `age:11` rule is only a backstop
just past that window.

To run the sweep daily, create a Cloud Scheduler job that POSTs to the endpoint with
the sweep key in the `x-api-key` header (the handler's `requireSweepAuth` accepts
the `x-api-key` **or** the admin password):

```bash
gcloud scheduler jobs create http proctor-retention-sweep \
  --location "$REGION" \
  --schedule "0 3 * * *" \
  --uri "${API_URL}/api/admin/retention-sweep" \
  --http-method POST \
  --headers "x-api-key=${RETENTION_SWEEP_API_KEY}"
```

> Watch for a Firestore composite-index prompt the first time a big export/purge
> runs (`RESUME-ANCHOR.md` §5). **(Cloud Scheduler API enablement / job creation is
> not exercised by the repo scripts — unverified against this GCP project.)**

---

## 3. Deploy the frontend

```bash
# API_URL must already be exported from §2
SERVICE_NAME="$FRONTEND_SERVICE_NAME" ./frontend/deploy-gcp.sh
```

`frontend/deploy-gcp.sh` (verified):

1. Enables `run`, `cloudbuild`, `artifactregistry`; creates the Artifact Registry repo if missing.
2. Computes `ADMIN_PASSWORD_HASH = sha256hex(ADMIN_PASSWORD)` — the **plain
   `ADMIN_PASSWORD` is never put in the bundle**; the unlock gate hashes the typed
   password and compares to the embedded hash (`frontend/src/api.ts`).
3. Builds: `VITE_API_BASE_URL=$API_URL VITE_ADMIN_PASSWORD_HASH=$ADMIN_PASSWORD_HASH npm --workspace frontend run build`.
4. `gcloud builds submit frontend --tag $IMAGE`.
5. `gcloud run deploy` — port `8080`, `128Mi`, cpu `1`, `--min-instances 0`,
   `--max-instances 3`, `--concurrency 1000`.

The admin console is the **same frontend URL** at `/admin`; the invigilator portal
is at `/invigilator` (routed in `frontend/src/App.tsx`).

> **Gap — the invigilator portal needs `VITE_INVIGILATOR_PASSWORD_HASH`.** The
> invigilator unlock compares the typed password's sha256 hex (lowercase) against
> `VITE_INVIGILATOR_PASSWORD_HASH` (`frontend/src/api.ts`:
> `invigilatorPasswordHash`). **`frontend/deploy-gcp.sh` does NOT compute or pass
> it.** For an exam where invigilators sign in with their own password, build with
> it added:
>
> ```bash
> export ADMIN_PASSWORD_HASH="$(printf '%s' "$ADMIN_PASSWORD" | sha256sum | awk '{print $1}')"
> export VITE_INVIGILATOR_PASSWORD_HASH="$(printf '%s' "$INVIGILATOR_PASSWORD" | sha256sum | awk '{print $1}')"
> VITE_API_BASE_URL="$API_URL" \
>   VITE_ADMIN_PASSWORD_HASH="$ADMIN_PASSWORD_HASH" \
>   VITE_INVIGILATOR_PASSWORD_HASH="$VITE_INVIGILATOR_PASSWORD_HASH" \
>   npm --workspace frontend run build
> gcloud builds submit frontend --tag "${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/web:latest"
> gcloud run deploy "$FRONTEND_SERVICE_NAME" \
>   --image "${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/web:latest" \
>   --region "$REGION" --allow-unauthenticated --port 8080 \
>   --memory 128Mi --cpu 1 --min-instances 0 --max-instances 3 --concurrency 1000
> ```
>
> (The invigilator portal can also be entered via a tokenized `?contest=…&key=…`
> link, and the admin password also unlocks it — `InvigilatorApp.tsx` accepts the
> admin hash as a fallback.)

### Frontend build vars (verified `frontend/src/api.ts`)

| Var | Purpose |
| --- | --- |
| `VITE_API_BASE_URL` | Backend base URL the app calls (= `API_URL`). |
| `VITE_ADMIN_PASSWORD_HASH` | sha256 hex of `ADMIN_PASSWORD`; admin unlock gate compares against it. |
| `VITE_INVIGILATOR_PASSWORD_HASH` | sha256 hex (lowercase) of `INVIGILATOR_PASSWORD`; invigilator unlock gate. **Not set by the script.** |
| `VITE_ADMIN_PASSWORD` / `VITE_INVIGILATOR_PASSWORD` | Plain passwords — used only by demo-mode local builds; do NOT pass for production. |
| `VITE_DEMO_MODE` | `true` runs the whole UI on a localStorage fake (no backend) — local demo only. |

---

## 4. (Optional) Deploy the video-worker

```bash
SERVICE_NAME="$VIDEO_WORKER_SERVICE_NAME" ./video-worker/deploy-gcp.sh
```

`video-worker/deploy-gcp.sh` (verified): creates `DEST_BUCKET` + applies
`backend/gcs-lifecycle.json`; grants the runtime SA `storage.objectViewer` on
`SOURCE_BUCKET`, `storage.objectAdmin` on `DEST_BUCKET`, and project
`datastore.user` (the worker writes `merged_video_key` back to the session doc);
deploys with `1Gi`, `--concurrency 1`, **`--timeout 3600s`** (ffmpeg/ffprobe come
from its Dockerfile). Env set by the script: `SOURCE_BUCKET`, `DEST_BUCKET`,
`SESSION_COLLECTION`, `MAX_USERNAMES_PER_REQUEST`, `WORKER_TOKEN`.

> **CAVEAT (`video-worker/README.md`, untested vs real GCP):** if
> `DEST_BUCKET` ≠ `EVIDENCE_BUCKET`, the backend signs the alert `video_key`
> against the evidence bucket and the deep-link can 404. **The video-worker is NOT
> deployed on the dev stack** — `RESUME-ANCHOR.md` notes the alert→recording
> deep-link currently has no merged video; admin recording review plays raw chunks
> directly (the player builds a playlist from `screen/chunk-*.webm`). **(unverified
> against a real GCP run.)**

---

## 5. (Optional) Lock CORS to the frontend origin

After the frontend is up, tighten `PUBLIC_APP_ORIGIN` from `*` to the exact
frontend URL and redeploy the backend:

```bash
export PUBLIC_APP_ORIGIN="$(gcloud run services describe "$FRONTEND_SERVICE_NAME" \
  --region "$REGION" --format='value(status.url)')"
SERVICE_NAME="$BACKEND_SERVICE_NAME" ./backend/deploy-gcp.sh
```

> Re-running `backend/deploy-gcp.sh` uses `--set-env-vars` (REPLACES the env map),
> so any extras you added via `--update-env-vars` in §2 will be **wiped** unless you
> re-add them. Prefer instead: `gcloud run services update "$BACKEND_SERVICE_NAME"
> --region "$REGION" --update-env-vars="PUBLIC_APP_ORIGIN=${PUBLIC_APP_ORIGIN}"` —
> a merge that preserves Judge0/invigilator/sweep env.

---

## Redeploy: MERGE, never wipe the env

For an already-deployed service, **`--update-env-vars` MERGES** (adds/overwrites
only the listed keys; everything else is preserved). **`--set-env-vars` REPLACES the
entire env map** — using it on a redeploy WIPES `JUDGE0_API_KEY`,
`INVIGILATOR_PASSWORD`, `RETENTION_SWEEP_API_KEY`, the `EXEC_*` tuning, and any
other previously-set var that is not in the new list.

```bash
# Build a fresh image and roll the backend forward, keeping all existing env:
gcloud builds submit backend \
  --tag "${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/api:latest" --async
gcloud run deploy "$BACKEND_SERVICE_NAME" \
  --image "${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/api:latest" \
  --region "$REGION"
# Change one var without disturbing the rest:
gcloud run services update "$BACKEND_SERVICE_NAME" --region "$REGION" \
  --update-env-vars="EXEC_SUBMIT_COOLDOWN_SECONDS=20"
```

Note: the committed `backend/deploy-gcp.sh` uses `--set-env-vars`. Running it as-is
against the live service resets the env to only its eight vars — re-apply the
[required additions](#required-additions-the-scripts-do-not-set) afterward (or edit
the script's `--set-env-vars` line to include them).

### Required additions the scripts do NOT set

| Where | Var(s) | Action |
| --- | --- | --- |
| Backend service | `INVIGILATOR_PASSWORD`, `JUDGE0_API_KEY`, `JUDGE0_MODE`, `RETENTION_SWEEP_API_KEY`, `EXEC_SUBMIT_COOLDOWN_SECONDS`, `EXEC_MAX_SUBMISSIONS_PER_SESSION`, generous `EXEC_*_CONCURRENCY` / `EXEC_MAX_QUEUE` | Pass via `--update-env-vars` after `backend/deploy-gcp.sh`, or edit its `--set-env-vars` line. |
| Frontend build | `VITE_INVIGILATOR_PASSWORD_HASH` | Compute sha256 hex of `INVIGILATOR_PASSWORD` and pass to the build (see §3 snippet). |
| Cloud Scheduler | retention-sweep daily job | Create manually (§2b). |

---

## Image build one-liner (live dev stack form)

From `RESUME-ANCHOR.md` §5 (verified pattern), build+tag then deploy directly:

```bash
gcloud builds submit backend  --tag asia-south1-docker.pkg.dev/aerele-proctor-dev/proctor/api:latest --async
gcloud builds submit frontend --tag asia-south1-docker.pkg.dev/aerele-proctor-dev/proctor/web:latest --async
# then: gcloud run deploy proctor-api … / gcloud run deploy proctor-web …
```

---

## Live dev stack reference (`RESUME-ANCHOR.md` §0/§5)

| | |
| --- | --- |
| Project / region | `aerele-proctor-dev` / `asia-south1` |
| Backend rev | `proctor-api-00006-pjr` |
| Frontend rev | `proctor-web-00006-d66` |
| Web URL | `https://proctor-web-ej4cpz43iq-el.a.run.app` (also `https://proctor-web-238846959672.asia-south1.run.app`) |
| API URL | `https://proctor-api-ej4cpz43iq-el.a.run.app` (also `https://proctor-api-238846959672.asia-south1.run.app`) |
| API root `/` | Returns **404 by design** — all routes are `/api/*`. |
| min-instances | `0` for testing; set `1` for a real exam (cold-start avoidance). |

---

## Verify the deploy (smoke test)

Run after both services are up. All three checks are verified against
`handler.mjs` / `auth.mjs`.

```bash
WEB_URL="$(gcloud run services describe "$FRONTEND_SERVICE_NAME" --region "$REGION" --format='value(status.url)')"
API_URL="$(gcloud run services describe "$BACKEND_SERVICE_NAME" --region "$REGION" --format='value(status.url)')"

# 1. Frontend serves (expect 200):
curl -s -o /dev/null -w '%{http_code}\n' "$WEB_URL"

# 2. Public exam-config responds with JSON (no auth — student form renders pre-session):
curl -s "$API_URL/api/exam-config"
#    -> JSON with roster_required, unique_id_label, rooms, enforcement, camera_recording

# 3. An admin route rejects with no/invalid password (expect 401 "Unauthorized"):
curl -s -o /dev/null -w '%{http_code}\n' "$API_URL/api/admin/roster"
#    -> 401 (requireAdmin checks the x-admin-password header; missing => 401)

# (sanity) API root returns 404 by design:
curl -s -o /dev/null -w '%{http_code}\n' "$API_URL/"
#    -> 404
```

Expected: `200`, a JSON exam-config body, `401`, `404`. The live dev-stack smoke
(`RESUME-ANCHOR.md` §0) also confirmed the Wave-6/7 admin routes
`/api/admin/{people,contest-results,contest-export,retention-sweep}` all return 401
unauthenticated.

> For a real exam, also drive the deployed stack in a browser as Admin /
> Candidate / Invigilator and confirm the happy path. Screenshot evidence from the
> persona E2E pass lives under `night-run/evidence/` (e.g.
> `deployed-in-exam-capture-verified.png`, the `s1-*` / `s2-verify-*` / `s3-verify-*`
> / `wave2-*` series) and `night-run/evidence/e2e/`.
