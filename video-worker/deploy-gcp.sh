#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID first, for example: export PROJECT_ID=your-gcp-project-id}"
REGION="${REGION:-asia-south1}"
SOURCE_BUCKET="${SOURCE_BUCKET:-${PROJECT_ID}-proctor-evidence}"
DEST_BUCKET="${DEST_BUCKET:-${PROJECT_ID}-proctor-review-videos}"
REPOSITORY="${REPOSITORY:-aerele-proctor}"
SERVICE_NAME="${SERVICE_NAME:-proctor-video-worker}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/video-worker:latest"
WORKER_TOKEN="${WORKER_TOKEN:?Set WORKER_TOKEN to a strong secret before deploying}"

gcloud config set project "$PROJECT_ID"

gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  storage.googleapis.com

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
RUNTIME_SERVICE_ACCOUNT="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

if ! gcloud storage buckets describe "gs://${DEST_BUCKET}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${DEST_BUCKET}" --location="$REGION" --uniform-bucket-level-access
fi

gcloud storage buckets update "gs://${DEST_BUCKET}" --lifecycle-file=backend/gcs-lifecycle.json

if ! gcloud artifacts repositories describe "$REPOSITORY" --location="$REGION" >/dev/null 2>&1; then
  gcloud artifacts repositories create "$REPOSITORY" \
    --repository-format=docker \
    --location="$REGION"
fi

gcloud storage buckets add-iam-policy-binding "gs://${SOURCE_BUCKET}" \
  --member="serviceAccount:${RUNTIME_SERVICE_ACCOUNT}" \
  --role="roles/storage.objectViewer" >/dev/null

gcloud storage buckets add-iam-policy-binding "gs://${DEST_BUCKET}" \
  --member="serviceAccount:${RUNTIME_SERVICE_ACCOUNT}" \
  --role="roles/storage.objectAdmin" >/dev/null

# B4: the worker writes merged_video_key back onto the session doc in Firestore.
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SERVICE_ACCOUNT}" \
  --role="roles/datastore.user" >/dev/null

gcloud builds submit video-worker --tag "$IMAGE"

gcloud run deploy "$SERVICE_NAME" \
  --image "$IMAGE" \
  --region "$REGION" \
  --allow-unauthenticated \
  --port 8080 \
  --memory 1Gi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 2 \
  --concurrency 1 \
  --timeout 3600s \
  --set-env-vars="SOURCE_BUCKET=${SOURCE_BUCKET},DEST_BUCKET=${DEST_BUCKET},SESSION_COLLECTION=${SESSION_COLLECTION:-proctor_sessions},MAX_USERNAMES_PER_REQUEST=25,WORKER_TOKEN=${WORKER_TOKEN}"

echo "Video worker URL:"
gcloud run services describe "$SERVICE_NAME" --region="$REGION" --format="value(status.url)"
