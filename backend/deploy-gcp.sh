#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Proctor backend (proctor-api) deploy to Cloud Run.
#
# DEPLOY MODES
# ------------
# DEPLOY_MODE=full      (DEFAULT) From-scratch / config-authoritative deploy.
#                       Builds the image AND sets the COMPLETE env + the signer
#                       secret mount, so the resulting revision is the full,
#                       correct production config — not a partial one.
# DEPLOY_MODE=image-only  Routine redeploy of NEW CODE ONLY. Builds + deploys the
#                       image and PRESERVES the service's existing env + secrets
#                       (no --set-env-vars / --set-secrets, which would replace
#                       them). Use this once the service already holds the full
#                       config and you only want to ship a new build.
#
# WHY THIS SCRIPT SETS *EVERYTHING* (the morning signing incident)
# ----------------------------------------------------------------
# `gcloud run deploy --set-env-vars` REPLACES the entire env map; --set-secrets
# likewise replaces the secret mounts. A previous version of this script set
# only ~8 env vars and NO secret mount. Re-running it against a fully-configured
# live service therefore SILENTLY DROPPED:
#   * the JUDGE0_* keys        -> code execution (/api/exec/*) broke,
#   * INVIGILATOR_PASSWORD     -> invigilator auth (requireInvigilator) 401'd,
#   * RETENTION_SWEEP_API_KEY  -> the daily retention sweep x-api-key path closed,
#   * SIGNER_KEY_FILE + the mounted signer key -> recording-signing fell back to
#     the remote IAM signBlob endpoint, which degrades/fails under real-exam
#     token-endpoint load. That is exactly the failure that broke
#     recording-signing in production one morning.
# So DEPLOY_MODE=full now sets the FULL env AND mounts the signer key in ONE
# atomic deploy, and a pre-flight gate aborts if any required value is missing.
#
# SECRETS ARE NEVER HARDCODED.
# ----------------------------
# Every credential/secret value is read from the environment at deploy time
# (populate it from your gitignored .env.deploy.local — this script sources that
# file if present). This committed script contains NO secret values.
# =============================================================================

DEPLOY_MODE="${DEPLOY_MODE:-full}"

# Source the local (gitignored) deploy env if present, so the script is
# self-sufficient even when not pre-sourced. `set -a` exports what it defines;
# values already set in the environment take precedence (we don't clobber them).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${ENV_DEPLOY_FILE:-${REPO_ROOT}/.env.deploy.local}"
if [ -f "$ENV_FILE" ]; then
  echo "Sourcing deploy env from ${ENV_FILE}"
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID first, for example: export PROJECT_ID=aerele-proctor}"
REGION="${REGION:-asia-south1}"
SERVICE_NAME="${SERVICE_NAME:-proctor-api}"
REPOSITORY="${REPOSITORY:-aerele-proctor}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/api:latest"

# Buckets / collections / non-secret config (have safe defaults).
ALERTS_COLLECTION="${ALERTS_COLLECTION:-proctor_alerts}"
PUBLIC_APP_ORIGIN="${PUBLIC_APP_ORIGIN:-*}"
EVIDENCE_BUCKET="${EVIDENCE_BUCKET:-${PROJECT_ID}-proctor-evidence}"
SESSION_COLLECTION="${SESSION_COLLECTION:-proctor_sessions}"
SETTINGS_COLLECTION="${SETTINGS_COLLECTION:-proctor_settings}"
URL_EXPIRY_SECONDS="${URL_EXPIRY_SECONDS:-900}"

# Judge0 (code execution). JUDGE0_MODE/BASE_URL/HOST default to the RapidAPI
# Judge0 CE endpoint (same defaults as backend/src/config.mjs). JUDGE0_API_KEY
# is a required secret in full mode (see require_var below) — code execution is
# broken without it.
JUDGE0_MODE="${JUDGE0_MODE:-rapidapi}"
JUDGE0_BASE_URL="${JUDGE0_BASE_URL:-https://judge0-ce.p.rapidapi.com}"
JUDGE0_RAPIDAPI_HOST="${JUDGE0_RAPIDAPI_HOST:-judge0-ce.p.rapidapi.com}"

# Signer key: a JSON service-account key stored as a Secret Manager secret and
# mounted into the container so recording-signing uses LOCAL v4 URL signing
# (no per-request remote signBlob call). SIGNER_KEY_FILE points the backend
# (backend/src/config.mjs) at the mount path. This is the morning-incident fix:
# without it, signing degrades to the flaky remote endpoint under exam load.
SIGNER_SECRET_NAME="${SIGNER_SECRET_NAME:-proctor-signer-key}"
SIGNER_MOUNT_PATH="${SIGNER_MOUNT_PATH:-/secrets/signer-key.json}"
SIGNER_KEY_FILE="${SIGNER_KEY_FILE:-$SIGNER_MOUNT_PATH}"

# --- Pre-flight gate: fail LOUDLY (before any build/deploy) if a required value
# is missing in full mode. Mirrors the frontend's verify_dist_has_hashes
# philosophy: never ship a half-configured exam backend silently. ---------------
require_var() { # <NAME>  -- asserts the named var is set & non-empty
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "ERROR: required env var ${name} is unset/empty." >&2
    echo "       Set it in ${ENV_FILE} (copy from .env.deploy.example) or export it." >&2
    return 1
  fi
}

if [ "$DEPLOY_MODE" = "full" ]; then
  missing=0
  # Secrets / credentials the exam backend cannot run correctly without.
  for v in ADMIN_PASSWORD INVIGILATOR_PASSWORD ALERTS_INGEST_API_KEY \
           RETENTION_SWEEP_API_KEY JUDGE0_API_KEY EVIDENCE_BUCKET; do
    require_var "$v" || missing=1
  done
  if [ "$missing" -ne 0 ]; then
    echo "" >&2
    echo "*****************************************************************" >&2
    echo "* ABORTING DEPLOY (DEPLOY_MODE=full): a required env var is      *" >&2
    echo "* missing. A full deploy uses --set-env-vars, which REPLACES the *" >&2
    echo "* whole env map — deploying now would ship an INCOMPLETE config  *" >&2
    echo "* and break exam-critical features (code exec / invigilator /    *" >&2
    echo "* retention sweep). Fix the env and re-run.                      *" >&2
    echo "* (For a code-only redeploy that PRESERVES the live config, run  *" >&2
    echo "*  with DEPLOY_MODE=image-only.)                                 *" >&2
    echo "*****************************************************************" >&2
    exit 1
  fi
fi

echo "==> Deploy mode: ${DEPLOY_MODE} (service=${SERVICE_NAME}, region=${REGION})"

gcloud config set project "$PROJECT_ID"

gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  firestore.googleapis.com \
  storage.googleapis.com \
  iamcredentials.googleapis.com \
  secretmanager.googleapis.com

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
RUNTIME_SERVICE_ACCOUNT="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

if ! gcloud firestore databases describe --database="(default)" >/dev/null 2>&1; then
  gcloud firestore databases create --database="(default)" --location="$REGION"
fi

# Phase 2 (session model) needs a composite index on the sessions collection so
# the single-session / bulk-action / per-contest-stats queries (which filter on
# username_norm AND contest_slug) work. This MUST NOT block the deploy: the index
# builds in the background (can take minutes), and the deploy/build doesn't depend
# on it. --async returns as soon as the request is submitted (no waiting for the
# build); --quiet avoids any interactive prompt; and the whole call is non-fatal
# (|| true) so "already exists / building / any error" never stops the deploy.
gcloud firestore indexes composite create \
  --collection-group="$SESSION_COLLECTION" \
  --query-scope=COLLECTION \
  --field-config=field-path=username_norm,order=ascending \
  --field-config=field-path=contest_slug,order=ascending \
  --async --quiet >/dev/null 2>&1 \
  || echo "Composite index on ${SESSION_COLLECTION}(username_norm,contest_slug): already exists or is building (non-blocking) — continuing."
# Note: the index is also declared in backend/firestore.indexes.json; you can
# alternatively deploy it out-of-band with: gcloud firestore indexes create-from-file.

if ! gcloud storage buckets describe "gs://${EVIDENCE_BUCKET}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${EVIDENCE_BUCKET}" --location="$REGION" --uniform-bucket-level-access
fi

gcloud storage buckets update "gs://${EVIDENCE_BUCKET}" --cors-file=backend/gcs-cors.json
# gcs-lifecycle.json has TWO prefix-scoped rules (GCS lifecycle supports
# matchesPrefix): per-session evidence under contests/ + sessions/ deletes at 3
# days; export zips under exports/ delete at 11 days. The split is load-bearing —
# exports/ are the recovery anchor for an irreversible purge and the
# retention-sweep endpoint owns their canonical 10-day deletion, so the GCS rule
# is only a backstop (age:11) just past that window. A single blanket age:3 rule
# would delete the export recovery archives 7 days early (Wave-7 review finding).
gcloud storage buckets update "gs://${EVIDENCE_BUCKET}" --lifecycle-file=backend/gcs-lifecycle.json

if ! gcloud artifacts repositories describe "$REPOSITORY" --location="$REGION" >/dev/null 2>&1; then
  gcloud artifacts repositories create "$REPOSITORY" \
    --repository-format=docker \
    --location="$REGION"
fi

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SERVICE_ACCOUNT}" \
  --role="roles/datastore.user" \
  --condition=None >/dev/null

gcloud storage buckets add-iam-policy-binding "gs://${EVIDENCE_BUCKET}" \
  --member="serviceAccount:${RUNTIME_SERVICE_ACCOUNT}" \
  --role="roles/storage.objectAdmin" >/dev/null

gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SERVICE_ACCOUNT" \
  --member="serviceAccount:${RUNTIME_SERVICE_ACCOUNT}" \
  --role="roles/iam.serviceAccountTokenCreator" \
  --project="$PROJECT_ID" >/dev/null

# In full mode, confirm the signer-key secret exists and the runtime SA can read
# it BEFORE deploying — otherwise the --set-secrets mount fails the deploy (and a
# missing accessor binding silently leaves signing without its key). The secret
# itself (the SA JSON key) is created out-of-band; see docs/DEPLOY.md. We never
# create/print the secret value here.
if [ "$DEPLOY_MODE" = "full" ]; then
  if ! gcloud secrets describe "$SIGNER_SECRET_NAME" >/dev/null 2>&1; then
    echo "ERROR: signer-key secret '${SIGNER_SECRET_NAME}' not found in project ${PROJECT_ID}." >&2
    echo "       Create it once (out-of-band, never committed):" >&2
    echo "         gcloud secrets create ${SIGNER_SECRET_NAME} --replication-policy=automatic" >&2
    echo "         gcloud secrets versions add ${SIGNER_SECRET_NAME} --data-file=<path-to-signer-sa-key.json>" >&2
    echo "       Recording-signing needs this mounted (the morning signing incident)." >&2
    exit 1
  fi
  gcloud secrets add-iam-policy-binding "$SIGNER_SECRET_NAME" \
    --member="serviceAccount:${RUNTIME_SERVICE_ACCOUNT}" \
    --role="roles/secretmanager.secretAccessor" \
    --project="$PROJECT_ID" >/dev/null
fi

gcloud builds submit backend --tag "$IMAGE"

# --timeout 120s: /api/exec/* requests block while the Judge0 adapter polls for
# results (up to ~90s); a 30s request timeout killed them mid-poll.
COMMON_RUN_ARGS=(
  --image "$IMAGE"
  --region "$REGION"
  --allow-unauthenticated
  --port 8080
  --memory 256Mi
  --cpu 1
  --min-instances 0
  --max-instances 20
  --concurrency 100
  --timeout 120s
)

if [ "$DEPLOY_MODE" = "image-only" ]; then
  # Routine code-only redeploy: ship the new image, PRESERVE existing env +
  # secrets (no --set-env-vars / --set-secrets, which would replace them).
  echo "==> image-only deploy: preserving the service's existing env + secret mounts."
  gcloud run deploy "$SERVICE_NAME" "${COMMON_RUN_ARGS[@]}"
else
  # FULL deploy: set the COMPLETE env map + mount the signer key, atomically.
  # NOTE: --set-env-vars REPLACES the whole env map and --set-secrets REPLACES
  # all secret mounts, so EVERY required value MUST be listed here. Adding a new
  # backend env var? Add it here too (and to .env.deploy.example), or a full
  # deploy will drop it.
  #
  # We build the list as a bash array of KEY=VALUE pairs and join it with a
  # CUSTOM gcloud delimiter (^@^) instead of the default comma. gcloud's
  # ^DELIM^ syntax means "the separator between pairs is DELIM, not comma", so a
  # secret VALUE that itself contains a comma can't corrupt the parse. We pick @
  # because it never appears in our keys and is not used inside any value here.
  ENV_PAIRS=(
    "EVIDENCE_BUCKET=${EVIDENCE_BUCKET}"
    "ADMIN_PASSWORD=${ADMIN_PASSWORD}"
    "INVIGILATOR_PASSWORD=${INVIGILATOR_PASSWORD}"
    "ALERTS_INGEST_API_KEY=${ALERTS_INGEST_API_KEY}"
    "ALERTS_COLLECTION=${ALERTS_COLLECTION}"
    "RETENTION_SWEEP_API_KEY=${RETENTION_SWEEP_API_KEY}"
    "PUBLIC_APP_ORIGIN=${PUBLIC_APP_ORIGIN}"
    "SESSION_COLLECTION=${SESSION_COLLECTION}"
    "SETTINGS_COLLECTION=${SETTINGS_COLLECTION}"
    "URL_EXPIRY_SECONDS=${URL_EXPIRY_SECONDS}"
    "JUDGE0_MODE=${JUDGE0_MODE}"
    "JUDGE0_BASE_URL=${JUDGE0_BASE_URL}"
    "JUDGE0_RAPIDAPI_HOST=${JUDGE0_RAPIDAPI_HOST}"
    "JUDGE0_API_KEY=${JUDGE0_API_KEY}"
    "SIGNER_KEY_FILE=${SIGNER_KEY_FILE}"
  )
  # Optional EXEC_* / eval tunables: passed through ONLY when set, so a full
  # deploy never silently resets a tuned limit back to a code default.
  for opt in EXEC_RUN_COOLDOWN_SECONDS EXEC_SUBMIT_COOLDOWN_SECONDS \
             EXEC_MAX_SUBMISSIONS_PER_SESSION EXEC_RUN_CONCURRENCY \
             EXEC_SUBMIT_CONCURRENCY EXEC_POLL_CONCURRENCY EXEC_MAX_QUEUE \
             EVALUATE_BATCH_LIMIT EVALUATE_TIME_BUDGET_MS EVAL_LEASE_MS \
             JUDGE0_AUTH_TOKEN; do
    if [ -n "${!opt:-}" ]; then
      ENV_PAIRS+=("${opt}=${!opt}")
    fi
  done
  # Join with the ^@^ delimiter: "^@^pair1@pair2@pair3".
  ENV_DELIM="@"
  ENV_VARS="^${ENV_DELIM}^"
  for i in "${!ENV_PAIRS[@]}"; do
    if [ "$i" -eq 0 ]; then
      ENV_VARS+="${ENV_PAIRS[$i]}"
    else
      ENV_VARS+="${ENV_DELIM}${ENV_PAIRS[$i]}"
    fi
  done

  echo "==> full deploy: setting the complete env + mounting the signer key (${SIGNER_SECRET_NAME})."
  gcloud run deploy "$SERVICE_NAME" "${COMMON_RUN_ARGS[@]}" \
    --set-env-vars="$ENV_VARS" \
    --set-secrets="${SIGNER_MOUNT_PATH}=${SIGNER_SECRET_NAME}:latest"
fi

echo "Backend URL:"
gcloud run services describe "$SERVICE_NAME" --region="$REGION" --format="value(status.url)"
