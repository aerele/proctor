#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID first, for example: export PROJECT_ID=aerele-proctor}"
REGION="${REGION:-asia-south1}"
API_URL="${API_URL:?Set API_URL to the deployed Cloud Function URL}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:?Set ADMIN_PASSWORD first}"
SERVICE_NAME="${SERVICE_NAME:-proctor-web}"
REPOSITORY="${REPOSITORY:-aerele-proctor}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/web:latest"

gcloud config set project "$PROJECT_ID"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

if ! gcloud artifacts repositories describe "$REPOSITORY" --location="$REGION" >/dev/null 2>&1; then
  gcloud artifacts repositories create "$REPOSITORY" \
    --repository-format=docker \
    --location="$REGION"
fi

# C1: never ship the plain admin password in the bundle. Compute its sha256 hex
# and pass it as VITE_ADMIN_PASSWORD_HASH; the unlock gate hashes the typed
# password and compares to this. The plain ADMIN_PASSWORD is NOT passed to the
# build (it stays a backend-only secret).
ADMIN_PASSWORD_HASH="$(printf '%s' "$ADMIN_PASSWORD" | sha256sum | awk '{print $1}')"

VITE_API_BASE_URL="$API_URL" VITE_ADMIN_PASSWORD_HASH="$ADMIN_PASSWORD_HASH" npm --workspace frontend run build
gcloud builds submit frontend --tag "$IMAGE"
gcloud run deploy "$SERVICE_NAME" \
  --image "$IMAGE" \
  --region "$REGION" \
  --allow-unauthenticated \
  --port 8080 \
  --memory 128Mi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 3 \
  --concurrency 1000

echo "Frontend URL:"
gcloud run services describe "$SERVICE_NAME" --region="$REGION" --format="value(status.url)"
