#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# THE ONLY SANCTIONED WAY TO DEPLOY THE PROCTOR FRONTEND.
#
# Do NOT deploy via ad-hoc `npm run build` + `gcloud builds submit`. Those
# bypass the password-hash bake and the post-build verification gate below,
# which is exactly how a production deploy once shipped an EMPTY
# VITE_ADMIN_PASSWORD_HASH and broke admin/invigilator login right before a
# ~700-student exam (every login fails when the baked hash is empty, because
# the unlock gate hashes the typed password and compares to the baked value).
#
# This script:
#   * asserts ADMIN_PASSWORD and INVIGILATOR_PASSWORD are set,
#   * bakes sha256(ADMIN_PASSWORD)     -> VITE_ADMIN_PASSWORD_HASH,
#   * bakes sha256(INVIGILATOR_PASSWORD) -> VITE_INVIGILATOR_PASSWORD_HASH,
#   * VERIFIES both hashes are actually present in the built bundle and ABORTS
#     the deploy (exit 1) if either is missing — without the password hashes
#     baked in, it must never deploy.
# The plain passwords are NEVER passed to the build; only their hashes are.
# =============================================================================

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID first, for example: export PROJECT_ID=aerele-proctor}"
REGION="${REGION:-asia-south1}"
API_URL="${API_URL:?Set API_URL to the deployed Cloud Function URL}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:?Set ADMIN_PASSWORD first (its sha256 is baked as VITE_ADMIN_PASSWORD_HASH)}"
INVIGILATOR_PASSWORD="${INVIGILATOR_PASSWORD:?Set INVIGILATOR_PASSWORD first (its sha256 is baked as VITE_INVIGILATOR_PASSWORD_HASH)}"
SERVICE_NAME="${SERVICE_NAME:-proctor-web}"
REPOSITORY="${REPOSITORY:-proctor}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/web:latest"

# verify_dist_has_hashes <dist_dir> <admin_hash> <invig_hash>
# Returns 0 only if BOTH hash strings are found somewhere in the built assets.
# Returns nonzero (and prints a loud error) if EITHER hash is missing — this is
# the gate that prevents shipping a bundle that would break login.
verify_dist_has_hashes() {
  local dist_dir="$1" admin_hash="$2" invig_hash="$3" rc=0

  if [ ! -d "$dist_dir" ]; then
    echo "ERROR: build output directory not found: $dist_dir" >&2
    return 1
  fi

  if ! grep -rqF -- "$admin_hash" "$dist_dir"; then
    echo "ERROR: VITE_ADMIN_PASSWORD_HASH was NOT baked into the bundle ($dist_dir)." >&2
    rc=1
  fi
  if ! grep -rqF -- "$invig_hash" "$dist_dir"; then
    echo "ERROR: VITE_INVIGILATOR_PASSWORD_HASH was NOT baked into the bundle ($dist_dir)." >&2
    rc=1
  fi

  if [ "$rc" -ne 0 ]; then
    echo "" >&2
    echo "*****************************************************************" >&2
    echo "* ABORTING DEPLOY: the built frontend is missing a password     *" >&2
    echo "* hash. Deploying it would make every admin/invigilator login   *" >&2
    echo "* FAIL (the unlock gate compares against an empty hash). This is *" >&2
    echo "* the exact failure that broke login before a ~700-student exam. *" >&2
    echo "* Fix the build env (ADMIN_PASSWORD / INVIGILATOR_PASSWORD) and  *" >&2
    echo "* re-run this script — do NOT deploy by hand.                    *" >&2
    echo "*****************************************************************" >&2
  fi
  return "$rc"
}

# When sourced (e.g. by the guard test), define the function and stop here so
# the test can exercise verify_dist_has_hashes without running a real deploy.
if [ "${BASH_SOURCE[0]}" != "${0}" ]; then
  return 0 2>/dev/null || true
fi

gcloud config set project "$PROJECT_ID"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

if ! gcloud artifacts repositories describe "$REPOSITORY" --location="$REGION" >/dev/null 2>&1; then
  gcloud artifacts repositories create "$REPOSITORY" \
    --repository-format=docker \
    --location="$REGION"
fi

# C1: never ship the plain passwords in the bundle. Compute their sha256 hex and
# pass them as VITE_ADMIN_PASSWORD_HASH / VITE_INVIGILATOR_PASSWORD_HASH; the
# unlock gates hash the typed password and compare to these. The plain passwords
# are NOT passed to the build (they stay backend-only secrets).
ADMIN_PASSWORD_HASH="$(printf '%s' "$ADMIN_PASSWORD" | sha256sum | awk '{print $1}')"
INVIGILATOR_PASSWORD_HASH="$(printf '%s' "$INVIGILATOR_PASSWORD" | sha256sum | awk '{print $1}')"

# VITE_EVAL_API_URL routes ONLY the admin eval calls (contest-evaluate*) to the
# separate proctor-eval service when set; UNSET = empty = the frontend falls back
# to the same-origin proctor-api eval routes (backward-compatible). Optional.
VITE_API_BASE_URL="$API_URL" \
  VITE_EVAL_API_URL="${VITE_EVAL_API_URL:-}" \
  VITE_ADMIN_PASSWORD_HASH="$ADMIN_PASSWORD_HASH" \
  VITE_INVIGILATOR_PASSWORD_HASH="$INVIGILATOR_PASSWORD_HASH" \
  npm --workspace frontend run build

# POST-BUILD VERIFICATION GATE — runs after the build and BEFORE any upload.
# If either hash is absent from frontend/dist, this aborts the deploy.
DIST_DIR="$(dirname "${BASH_SOURCE[0]}")/dist"
verify_dist_has_hashes "$DIST_DIR" "$ADMIN_PASSWORD_HASH" "$INVIGILATOR_PASSWORD_HASH"
echo "OK: both password hashes verified in $DIST_DIR — proceeding to deploy."

gcloud builds submit frontend --tag "$IMAGE"

# Staged zero-downtime option: set DEPLOY_NO_TRAFFIC=1 to deploy a new revision
# WITHOUT taking traffic (tagged for verification on its tag URL); cut over later
# with `gcloud run services update-traffic "$SERVICE_NAME" --to-revisions=<rev>=100`.
# Unset = normal deploy (new healthy revision serves 100%).
TRAFFIC_ARGS=()
if [ -n "${DEPLOY_NO_TRAFFIC:-}" ]; then
  TRAFFIC_ARGS=(--no-traffic --tag "${DEPLOY_TAG:-stg}")
fi
gcloud run deploy "$SERVICE_NAME" \
  --image "$IMAGE" \
  --region "$REGION" \
  --allow-unauthenticated \
  --port 8080 \
  --memory 128Mi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 3 \
  --concurrency 1000 \
  "${TRAFFIC_ARGS[@]}"

echo "Frontend URL:"
gcloud run services describe "$SERVICE_NAME" --region="$REGION" --format="value(status.url)"
