# DEPLOY — Aerele Proctor build + deploy runbook

End-to-end runbook to build both container images and deploy the Aerele Proctor
platform to Google Cloud Platform (Cloud Run + Cloud Storage + Firestore + Cloud
Build + Artifact Registry) from scratch.

**Standard of truth:** every command and behavior below is verified against the
actual repo — `backend/deploy-gcp.sh`, `frontend/deploy-gcp.sh`,
`video-worker/deploy-gcp.sh`, `backend/src/config.mjs`, `backend/src/handler.mjs`,
`backend/src/lib/clients.mjs`, `backend/src/lib/auth.mjs`,
`backend/src/routes/healthCheck.mjs`, `frontend/src/api.ts`, `.env.deploy.example`,
`backend/gcs-lifecycle.json`, `backend/gcs-cors.json`, `README.md`, and
`night-run/GCP-SETUP-INSTRUCTIONS.md` / `night-run/RESUME-ANCHOR.md`. Anything not
directly verifiable in code or an existing screenshot is marked **(unverified)**.

> **The committed deploy scripts now reproduce the COMPLETE live config.** This is
> the most important recent change to internalize:
> - `backend/deploy-gcp.sh` has two modes (`DEPLOY_MODE=full` / `image-only` — see
>   [§Deploy modes](#deploy-modes-full-vs-image-only)). In **`full`** mode (the
>   default) it sets the **entire** env map — `ADMIN_PASSWORD`,
>   `INVIGILATOR_PASSWORD`, `ALERTS_INGEST_API_KEY`, `RETENTION_SWEEP_API_KEY`, the
>   `JUDGE0_*` keys, optional `EXEC_*` tuning — **and** mounts the recording-signing
>   key from Secret Manager (`proctor-signer-key` → `/secrets/signer-key.json`,
>   `SIGNER_KEY_FILE`), all in **one atomic deploy**. A pre-flight gate aborts
>   loudly if any required secret is missing. **`image-only`** mode ships a new
>   image while **preserving** the live env + secret mounts.
> - `frontend/deploy-gcp.sh` bakes **both** `VITE_ADMIN_PASSWORD_HASH` and
>   `VITE_INVIGILATOR_PASSWORD_HASH` and **verifies** them post-build
>   (`verify_dist_has_hashes`) — it is the **only** sanctioned frontend deploy path;
>   do not build/submit the frontend by hand.
>
> **The standard operator workflow is the STAGED ZERO-DOWNTIME DEPLOY** in
> [§Staged zero-downtime deploy](#staged-zero-downtime-deploy-the-standard-workflow):
> build → deploy as a **no-traffic tagged revision** → verify on the tag URL (admin
> pre-flight health-check + smoke) → only then cut traffic → keep the previous
> revision at 0% for **instant rollback**. See also the
> [2026-06-19 incident learnings](#2026-06-19-incident-learnings).

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
| Project | `${PROJECT_ID}` |
| Region | `asia-south1` |
| Deployer SA | `proctor-deployer@${PROJECT_ID}.iam.gserviceaccount.com` |
| SA key + GCP env | `monitoring/.data/gcp-dev.env` (gitignored: `GCP_PROJECT_ID` / `GCP_REGION` / `GOOGLE_APPLICATION_CREDENTIALS`) |
| gcloud binaries | `~/google-cloud-sdk/bin` |

To deploy as the scoped deployer (instead of an interactive login):

```bash
source monitoring/.data/gcp-dev.env
gcloud auth activate-service-account --key-file="$GOOGLE_APPLICATION_CREDENTIALS"
gcloud config set project "$GCP_PROJECT_ID"
```

> **Standing rule (`RESUME-ANCHOR.md` §4):** **NO `git push` EVER** until the operator
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

### Read by the backend but NOT yet in `.env.deploy.example`

These are read by `backend/src/config.mjs` / the deploy script but are absent from
the committed `.env.deploy.example` template. **A `full` backend deploy DOES set
them** — but only if they are present in your environment / `.env.deploy.local`, so
add them there. (`INVIGILATOR_PASSWORD`, `ALERTS_INGEST_API_KEY`,
`RETENTION_SWEEP_API_KEY`, `ADMIN_PASSWORD`, `EVIDENCE_BUCKET`, and `JUDGE0_API_KEY`
are the **required** secrets the full-mode pre-flight gate enforces.)

| Var | Why |
| --- | --- |
| `INVIGILATOR_PASSWORD` | Backend invigilator auth (`requireInvigilator` → 401 when wrong/unset). Also baked as a frontend hash by `frontend/deploy-gcp.sh`. **Required** (full-mode gate). |
| `JUDGE0_API_KEY` | RapidAPI key for live Run/Submit. The script defaults `JUDGE0_MODE=rapidapi`, `JUDGE0_BASE_URL=https://judge0-ce.p.rapidapi.com`, `JUDGE0_RAPIDAPI_HOST=judge0-ce.p.rapidapi.com`. The dev secret lives in gitignored `monitoring/.data/judge0.env` (`RESUME-ANCHOR.md` §5). **Required** (full-mode gate). |
| `EXEC_SUBMIT_COOLDOWN_SECONDS` | ≈ `20` for a real exam (default `20`). Passed through only when set. |
| `EXEC_MAX_SUBMISSIONS_PER_SESSION` | ≈ `200` for a real exam (default `50`). Passed through only when set. |
| `EXEC_RUN_CONCURRENCY` / `EXEC_SUBMIT_CONCURRENCY` / `EXEC_POLL_CONCURRENCY` / `EXEC_MAX_QUEUE` | Generous lane concurrency for capacity (defaults `2`/`4`/`16`/`200`; capacity decision in `RESUME-ANCHOR.md` §3). Passed through only when set. |

---

## 2. Deploy the backend

```bash
set -a; source .env.deploy.local; set +a
# DEPLOY_MODE defaults to `full`; the script also sources .env.deploy.local itself.
SERVICE_NAME="$BACKEND_SERVICE_NAME" ./backend/deploy-gcp.sh
```

`backend/deploy-gcp.sh` does, idempotently (verified):

0. **Sources `.env.deploy.local`** if present (env you already exported wins), then
   selects the deploy mode from `DEPLOY_MODE` (default `full`).
1. **Pre-flight gate (full mode only):** asserts every exam-critical secret is set —
   `ADMIN_PASSWORD`, `INVIGILATOR_PASSWORD`, `ALERTS_INGEST_API_KEY`,
   `RETENTION_SWEEP_API_KEY`, `JUDGE0_API_KEY`, `EVIDENCE_BUCKET` — and **aborts
   before any build** if one is missing (mirrors the frontend hash gate; never ship
   a half-configured exam backend silently).
2. `gcloud services enable run cloudbuild artifactregistry firestore storage iamcredentials secretmanager`.
3. Creates Firestore `(default)` in `$REGION` if missing.
4. Creates the composite index on
   `proctor_sessions(username_norm ASC, contest_slug ASC)` `--async` (non-blocking;
   also declared in `backend/firestore.indexes.json`). The index builds in the
   background and never blocks the deploy.
5. Creates `EVIDENCE_BUCKET` (uniform bucket-level access) if missing.
6. Applies `backend/gcs-cors.json` (browser PUT/GET/HEAD, origin `*`) and
   `backend/gcs-lifecycle.json` (the two-rule retention split — see §2b).
7. Creates the Artifact Registry Docker repo if missing.
8. Grants the runtime SA (`<projectNumber>-compute@developer.gserviceaccount.com`):
   project `roles/datastore.user`, bucket `roles/storage.objectAdmin`, and
   `roles/iam.serviceAccountTokenCreator` on itself (needed to sign GCS URLs).
9. **Signer key (full mode only):** verifies the Secret Manager secret
   `proctor-signer-key` exists and grants the runtime SA
   `roles/secretmanager.secretAccessor` on it — see [§2c](#2c-recording-signing-key-the-signer-secret).
10. `gcloud builds submit backend --tag $IMAGE`.
11. `gcloud run deploy` — port `8080`, `256Mi`, cpu `1`, `--min-instances 0`,
   `--max-instances 20`, `--concurrency 100`, **`--timeout 120s`**
   (`/api/exec/*` blocks while the Judge0 adapter polls — a 30s timeout killed
   requests mid-poll). In **full** mode this carries `--set-env-vars` (the complete
   env map) **and** `--set-secrets=/secrets/signer-key.json=proctor-signer-key:latest`;
   in **image-only** mode it carries neither (preserving the live config).

Then capture the backend URL into `API_URL` for the frontend build:

```bash
export API_URL="$(gcloud run services describe "$BACKEND_SERVICE_NAME" \
  --region "$REGION" --format='value(status.url)')"
```

> **`full` mode sets the ENTIRE env map + mounts the signer key — atomically.**
> The script builds the full `--set-env-vars` list itself (using gcloud's `^@^`
> custom-delimiter form so a secret value containing a comma can't corrupt the
> parse): `EVIDENCE_BUCKET, ADMIN_PASSWORD, INVIGILATOR_PASSWORD,
> ALERTS_INGEST_API_KEY, ALERTS_COLLECTION, RETENTION_SWEEP_API_KEY,
> PUBLIC_APP_ORIGIN, SESSION_COLLECTION, SETTINGS_COLLECTION, URL_EXPIRY_SECONDS,
> JUDGE0_MODE, JUDGE0_BASE_URL, JUDGE0_RAPIDAPI_HOST, JUDGE0_API_KEY,
> SIGNER_KEY_FILE`. The optional tunables `EXEC_RUN_COOLDOWN_SECONDS,
> EXEC_SUBMIT_COOLDOWN_SECONDS, EXEC_MAX_SUBMISSIONS_PER_SESSION,
> EXEC_RUN_CONCURRENCY, EXEC_SUBMIT_CONCURRENCY, EXEC_POLL_CONCURRENCY,
> EXEC_MAX_QUEUE, EVALUATE_BATCH_LIMIT, EVALUATE_TIME_BUDGET_MS, EVAL_LEASE_MS,
> JUDGE0_AUTH_TOKEN` are added **only when set**, so a full deploy never silently
> resets a tuned limit to a code default. You no longer hand-`--update-env-vars`
> the Judge0/invigilator/sweep keys — set them in `.env.deploy.local` and run the
> script.

### 2c. Recording-signing key (the signer secret)

Recording-signing **must** sign GCS v4 URLs **locally** off a mounted service-account
key. The mechanism (verified `backend/src/lib/clients.mjs`):

- The backend keeps a **main** Storage client on metadata ADC for all token-bearing
  work (`getFiles`, `save`, Firestore, every API call).
- It builds a **separate signing client** **only** when `SIGNER_KEY_FILE` points at a
  mounted key (`new Storage({ keyFilename: SIGNER_KEY_FILE })`). v4 signing off that
  key is a **local crypto** operation — no token, no network.
- If `SIGNER_KEY_FILE` is unset, `signingBucket()` **falls back to the main client**,
  which then has to sign via the remote IAM `signBlob` token endpoint — the flaky
  path that **degrades/fails under real-exam token-endpoint load**. That fallback is
  exactly the **2026-06-19 recording-signing outage** (see
  [§incident learnings](#2026-06-19-incident-learnings)).

So a deploy **must** keep the signer key mounted. The wiring:

| Piece | Value |
| --- | --- |
| Secret Manager secret | `proctor-signer-key` (the signer SA JSON key; created out-of-band, never committed) |
| Mount path | `/secrets/signer-key.json` (`--set-secrets=/secrets/signer-key.json=proctor-signer-key:latest`) |
| Backend env | `SIGNER_KEY_FILE=/secrets/signer-key.json` (read by `config.mjs` → `configureClients`) |

`DEPLOY_MODE=full` **sets** all three (and grants the runtime SA
`secretmanager.secretAccessor`); `DEPLOY_MODE=image-only` **preserves** the mount
(it passes neither `--set-secrets` nor `--set-env-vars`). The signer secret itself
is created once, out of band — the deploy script never creates or prints it:

```bash
# One-time, out-of-band (NOT in the repo; the SA key value is a secret):
gcloud secrets create proctor-signer-key --replication-policy=automatic
gcloud secrets versions add proctor-signer-key --data-file=<path-to-signer-sa-key.json>
```

The full-mode script aborts with that exact hint if `proctor-signer-key` is absent.

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

> **`frontend/deploy-gcp.sh` is the ONLY sanctioned frontend deploy path.**
> Ad-hoc `npm run build` + `gcloud builds submit` are **forbidden** — they skip
> the password-hash bake and the post-build verification gate, which is exactly
> how a deploy once shipped an empty `VITE_ADMIN_PASSWORD_HASH` and broke admin
> /invigilator login before a ~700-student exam. Always run the script.

`frontend/deploy-gcp.sh`:

1. Enables `run`, `cloudbuild`, `artifactregistry`; creates the Artifact Registry repo if missing.
2. Asserts `PROJECT_ID`, `API_URL`, **`ADMIN_PASSWORD`, and `INVIGILATOR_PASSWORD`**
   are set (fails fast otherwise).
3. Computes `sha256hex` of **both** passwords — the **plain passwords are never
   put in the bundle**; the unlock gates hash the typed password and compare to the
   embedded hash (`frontend/src/api.ts`).
4. Builds: `VITE_API_BASE_URL=$API_URL VITE_ADMIN_PASSWORD_HASH=… VITE_INVIGILATOR_PASSWORD_HASH=… npm --workspace frontend run build`.
5. **Post-build verification gate:** greps `frontend/dist` for **both** expected
   hash strings; if either is missing it prints a loud error and `exit 1` to
   **abort the deploy** (so a hash-less bundle can never ship).
6. `gcloud builds submit frontend --tag $IMAGE`.
7. `gcloud run deploy` — port `8080`, `128Mi`, cpu `1`, `--min-instances 0`,
   `--max-instances 3`, `--concurrency 1000`.

The admin console is the **same frontend URL** at `/admin`; the invigilator portal
is at `/invigilator` (routed in `frontend/src/App.tsx`). The invigilator portal can
also be entered via a tokenized `?contest=…&key=…` link, and the admin password
also unlocks it — `InvigilatorApp.tsx` accepts the admin hash as a fallback.

### Frontend build vars (verified `frontend/src/api.ts`)

| Var | Purpose |
| --- | --- |
| `VITE_API_BASE_URL` | Backend base URL the app calls (= `API_URL`). |
| `VITE_ADMIN_PASSWORD_HASH` | sha256 hex of `ADMIN_PASSWORD`; admin unlock gate compares against it. |
| `VITE_INVIGILATOR_PASSWORD_HASH` | sha256 hex (lowercase) of `INVIGILATOR_PASSWORD`; invigilator unlock gate. Baked + verified by the script. |
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

> Set `PUBLIC_APP_ORIGIN` in `.env.deploy.local` to the frontend URL and re-run the
> backend in **`full`** mode — it rebuilds the complete env (so the locked CORS
> origin ships alongside every other live var, no merge gymnastics). If you only
> want to flip CORS without a rebuild, a one-key merge still works:
> `gcloud run services update "$BACKEND_SERVICE_NAME" --region "$REGION"
> --update-env-vars="PUBLIC_APP_ORIGIN=${PUBLIC_APP_ORIGIN}"` (merge preserves the
> other env, but does NOT touch the signer secret mount).

---

## Deploy modes: `full` vs `image-only`

`backend/deploy-gcp.sh` is governed by `DEPLOY_MODE` (default `full`).

| Mode | When to use | What it does |
| --- | --- | --- |
| `full` (default) | **From-scratch deploys** and any **config-authoritative** deploy where the env/secrets are the thing you're changing (new secret, rotated password, locked CORS, tuned `EXEC_*`). | Builds the image **and** sets the **complete** env map **and** mounts the signer key (`--set-env-vars` + `--set-secrets`), atomically. Runs the pre-flight gate first. The resulting revision is the full, correct production config. |
| `image-only` | **Routine code redeploys** — you changed app code, the live service already holds the full env + signer mount, and you only want to ship the new build. | Builds + deploys the image **only** (no `--set-env-vars`, no `--set-secrets`), so Cloud Run **preserves** the existing env + secret mounts. Skips the secret-existence pre-flight. |

```bash
# From-scratch / config change (default):
SERVICE_NAME="$BACKEND_SERVICE_NAME" ./backend/deploy-gcp.sh
# Routine new-code redeploy that preserves the live env + signer mount:
DEPLOY_MODE=image-only SERVICE_NAME="$BACKEND_SERVICE_NAME" ./backend/deploy-gcp.sh
```

> **Why this matters (the morning incident):** `gcloud run deploy --set-env-vars`
> REPLACES the whole env map and `--set-secrets` REPLACES all secret mounts. An
> older script that set only ~8 env vars and **no** secret mount silently dropped
> the Judge0 keys, `INVIGILATOR_PASSWORD`, `RETENTION_SWEEP_API_KEY`, and the signer
> key on every re-run. The mode split is the fix: `full` reproduces **everything**,
> `image-only` touches **nothing** but the image. Do not hand-craft a partial
> `--set-env-vars` deploy.

---

## Staged zero-downtime deploy (the STANDARD workflow)

**This is how every production backend (and ideally frontend) change should go
out.** Build the image, deploy it as a **no-traffic tagged revision**, verify on the
tag URL, and only then cut traffic — keeping the previous revision live at 0% so a
rollback is instant. The current `deploy-gcp.sh` deploys with live traffic by
default; for a staged cut, build the image with the script's pre-flight + full env
intent, then drive the traffic split explicitly with the commands below.

### Step 1 — build + deploy a NO-TRAFFIC tagged revision

Run the normal full deploy but with `--no-traffic --tag`. The tag must be ≥3 chars,
lowercase alphanumerics/dashes (e.g. a short date or change id):

```bash
set -a; source .env.deploy.local; set +a
TAG="rel0619"          # ≥3 chars; pick a date/change id
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/api:latest"

gcloud builds submit backend --tag "$IMAGE"     # see the build-gotcha note below

# Deploy as a tagged revision that takes NO traffic yet. In full mode also pass
# the complete env + signer mount so the staged revision is the real config:
gcloud run deploy "$BACKEND_SERVICE_NAME" \
  --image "$IMAGE" --region "$REGION" \
  --no-traffic --tag "$TAG" \
  --allow-unauthenticated --port 8080 --memory 256Mi --cpu 1 \
  --min-instances 0 --max-instances 20 --concurrency 100 --timeout 120s \
  --set-secrets="/secrets/signer-key.json=proctor-signer-key:latest" \
  --set-env-vars="<the full env map — easiest: run ./backend/deploy-gcp.sh once to a tagged rev, or reuse the env from .env.deploy.local>"
```

Cloud Run gives the tagged revision its own URL: `https://<TAG>---<service>-<hash>.a.run.app`.
Capture it:

```bash
TAG_URL="$(gcloud run services describe "$BACKEND_SERVICE_NAME" --region "$REGION" \
  --format="value(status.traffic[].url)" | grep -i "$TAG" || true)"
# (also visible in: gcloud run services describe ... --format='yaml(status.traffic)')
```

### Step 2 — VERIFY on the tag URL (before any traffic)

Run the **admin pre-flight health-check** (the standard stack probe — see
[§Admin pre-flight health check](#admin-pre-flight-health-check)) against the **tag
URL**, plus a quick smoke:

```bash
# 1. Pre-flight health-check (light mode is safe; admin password required):
curl -s -X POST "$TAG_URL/api/admin/health-check" \
  -H "x-admin-password: $ADMIN_PASSWORD" \
  -H 'Content-Type: application/json' -d '{"mode":"light"}' | jq '.overall, .checks[].status'
#    -> overall must be "green" (every non-skip check green)

# 2. Public exam-config responds 200 with JSON:
curl -s -o /dev/null -w '%{http_code}\n' "$TAG_URL/api/exam-config"   # -> 200

# 3. Admin login works on the staged revision (an admin route returns 200 with the
#    right password, 401 without):
curl -s -o /dev/null -w '%{http_code}\n' "$TAG_URL/api/admin/roster" \
  -H "x-admin-password: $ADMIN_PASSWORD"                              # -> 200
curl -s -o /dev/null -w '%{http_code}\n' "$TAG_URL/api/admin/roster"  # -> 401

# 4. (frontend staged rev) the served bundle carries the password-hash gate:
curl -s "$FRONTEND_TAG_URL/" | grep -o 'src="[^"]*\.js"'   # then grep the JS for
#    VITE_ADMIN_PASSWORD_HASH / VITE_INVIGILATOR_PASSWORD_HASH (the health-check's
#    bundle_hashes probe does this automatically when PUBLIC_APP_ORIGIN is concrete)
```

Only proceed if the health-check `overall` is **green** and the smoke passes.

### Step 3 — cut traffic to the verified revision

Find the verified revision name, then send it 100% of traffic:

```bash
REV="$(gcloud run services describe "$BACKEND_SERVICE_NAME" --region "$REGION" \
  --format='value(status.latestCreatedRevisionName)')"   # or pick by the tag
gcloud run services update-traffic "$BACKEND_SERVICE_NAME" --region "$REGION" \
  --to-revisions="${REV}=100"
```

The previously-serving revision stays deployed at **0%** — that is your instant
rollback.

### Step 4 — INSTANT ROLLBACK (if anything regresses)

```bash
# List revisions + their current traffic split:
gcloud run revisions list --service "$BACKEND_SERVICE_NAME" --region "$REGION"
# Send 100% back to the previous (known-good) revision — instant, no rebuild:
gcloud run services update-traffic "$BACKEND_SERVICE_NAME" --region "$REGION" \
  --to-revisions="<PREVIOUS_GOOD_REVISION>=100"
```

Because the old revision was never deleted, rollback is a single traffic flip
(seconds), not a rebuild.

---

## Controlled build: the VPC-SC log-streaming exit-1 gotcha

`gcloud builds submit` can **exit 1** while the **build itself SUCCEEDED**. The
common cause is a benign **VPC-SC / log-streaming** error — `gcloud` fails to tail
the build log (e.g. logs sink behind a service-perimeter) and returns nonzero even
though Cloud Build finished the image. **Do not assume the build failed on a
nonzero exit.** Confirm via `gcloud builds describe` and deploy the resolved
**digest** (`sha256:…`), never a moving `:latest` tag:

```bash
# 1. Find the build and confirm it actually succeeded:
BUILD_ID="$(gcloud builds list --limit=1 --format='value(id)')"
gcloud builds describe "$BUILD_ID" --format='value(status)'     # -> SUCCESS

# 2. Resolve the immutable digest the build produced and deploy THAT (not :latest):
DIGEST="$(gcloud builds describe "$BUILD_ID" \
  --format='value(results.images[0].digest)')"                  # sha256:...
IMAGE_BY_DIGEST="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/api@${DIGEST}"
gcloud run deploy "$BACKEND_SERVICE_NAME" --image "$IMAGE_BY_DIGEST" --region "$REGION" ...
```

Deploying the digest guarantees you ship the exact image the build produced and
verified — immune to a `:latest` tag being moved by a concurrent build.

> **Frontend:** never use a bare `gcloud builds submit frontend` / hand-deploy. It
> skips the password-hash bake + `verify_dist_has_hashes` gate and is what broke
> admin login before a ~700-student exam. Always deploy the frontend via
> `frontend/deploy-gcp.sh` (§3); apply the staged-traffic flip (above) on the
> resulting `proctor-web` revisions if you want a zero-downtime frontend cut.

---

## Admin pre-flight health check

`POST /api/admin/health-check` (admin-only, `x-admin-password` header) is the
**standard pre-deploy / pre-exam stack verification** — one button that proves every
load-bearing dependency works from **this** deployment's runtime. Verified against
`backend/src/routes/healthCheck.mjs`.

It stands up its **own ephemeral, fully-namespaced canary** contest + session, runs
the probes against that canary, and **always tears the canary down** — it never
touches real contest data.

| Mode | Cost | What it probes |
| --- | --- | --- |
| `light` (default) | **No Judge0 billing — safe mid-exam.** | Firestore write/read/delete; GCS signed write/read (signer + bucket); served-bundle password-hash gate; admin auth + candidate session-start; exam-config for the canary; signed chunk-upload PUT; recordings list + signed read; telemetry `.jsonl` write; Judge0 reachability (`/languages`, no submission). |
| `full` | 2 metered Judge0 submissions (one `sum-two` 2-case batch). | Everything in `light` **plus** a real Judge0 execution of the seed problem. |

```bash
# Light pre-flight (safe to run any time, including during an exam):
curl -s -X POST "$API_URL/api/admin/health-check" \
  -H "x-admin-password: $ADMIN_PASSWORD" \
  -H 'Content-Type: application/json' -d '{"mode":"light"}' \
  | jq '{overall, checks: [.checks[] | {id, status, detail}], cleanup}'
# overall == "green" means the whole stack (signing, upload, read, telemetry,
# bundle gate, Judge0, Firestore) is healthy from this deployment.
```

Response: `{ overall, mode, ran_at, duration_ms, checks[], cleanup }`. `overall` is
`"red"` if **any** non-skip check is red. The `bundle_hashes` probe is `skip` unless
`PUBLIC_APP_ORIGIN` is a concrete origin (not `*`). The admin console exposes the
same probe as a one-button "pre-flight" action. **Run light pre-flight on the tag
URL before every traffic cut, and again before every exam.**

---

## 2026-06-19 incident learnings

A real-exam morning, **recording-signing went down**. Root cause: a backend deploy
re-ran an older `deploy-gcp.sh` that set only a subset of env vars and **no signer
secret mount**. Without `SIGNER_KEY_FILE` + the mounted `proctor-signer-key`, the
backend's signing client fell back to the main metadata-ADC client, which signs v4
URLs via the remote IAM `signBlob` token endpoint — a path that **degrades/fails
under real-exam token-endpoint load**. The same partial re-run also risked dropping
the Judge0 keys, `INVIGILATOR_PASSWORD`, and `RETENTION_SWEEP_API_KEY`.

What changed, and is now the standing practice:

1. **Signing is LOCAL.** The signer key lives in Secret Manager
   (`proctor-signer-key`), is mounted at `/secrets/signer-key.json`, and
   `SIGNER_KEY_FILE` points the backend at it so v4 signing is a local crypto op
   (no per-request remote `signBlob`). A deploy must keep it mounted — `full` sets
   it; `image-only` preserves it. See [§2c](#2c-recording-signing-key-the-signer-secret).
2. **The deploy script reproduces the COMPLETE live config.** `full` mode sets the
   entire env map + the signer mount atomically, with a pre-flight gate that aborts
   before build if any required secret is missing. No more partial `--set-env-vars`.
3. **Staged deploy + instant rollback is the standard.** Build → no-traffic tagged
   revision → verify on the tag URL → cut traffic → keep the prior revision at 0%
   for an instant traffic-flip rollback. See
   [§Staged zero-downtime deploy](#staged-zero-downtime-deploy-the-standard-workflow).
4. **Pre-flight before every exam (and every cut).** Run `POST
   /api/admin/health-check` (light) — it exercises exactly the paths that broke
   (local signing, chunk upload, recordings read, telemetry, bundle hash-gate,
   Judge0 reachability) from the live runtime. Green before you cut traffic; green
   again before the exam opens.

---

## Live dev stack reference (`RESUME-ANCHOR.md` §0/§5)

> Revision names are **point-in-time** — they roll forward on every deploy. Verify
> the current revisions and traffic split with
> `gcloud run revisions list --service proctor-api --region "$REGION"` rather than
> trusting the values below.

| | |
| --- | --- |
| Project / region | `${PROJECT_ID}` / `asia-south1` |
| Backend rev | `proctor-api-…` (point-in-time; `…-00006-pjr` at first deploy, later `…-00030-sit`) |
| Frontend rev | `proctor-web-…` (point-in-time) |
| Web URL | `<cloud-run-url>` (also `<cloud-run-url>`) |
| API URL | `<cloud-run-url>` (also `<cloud-run-url>`) |
| API root `/` | Returns **404 by design** — all routes are `/api/*`. |
| min-instances | `0` for testing; set `1` for a real exam (cold-start avoidance). |

---

## Verify the deploy (smoke test)

> **First, run the admin pre-flight health-check** — it is the canonical full-stack
> probe (see [§Admin pre-flight health check](#admin-pre-flight-health-check)). The
> curl smoke below is the lightweight no-auth complement. In the staged workflow,
> run both against the **tag URL** before cutting traffic.

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
