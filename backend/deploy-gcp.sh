#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID first, for example: export PROJECT_ID=aerele-proctor}"
REGION="${REGION:-asia-south1}"
SERVICE_NAME="${SERVICE_NAME:-proctor-api}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:?Set ADMIN_PASSWORD first}"
PUBLIC_APP_ORIGIN="${PUBLIC_APP_ORIGIN:-*}"
EVIDENCE_BUCKET="${EVIDENCE_BUCKET:-${PROJECT_ID}-proctor-evidence}"
REPOSITORY="${REPOSITORY:-aerele-proctor}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/api:latest"

gcloud config set project "$PROJECT_ID"

gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  firestore.googleapis.com \
  storage.googleapis.com \
  iamcredentials.googleapis.com

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
RUNTIME_SERVICE_ACCOUNT="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

if ! gcloud firestore databases describe --database="(default)" >/dev/null 2>&1; then
  gcloud firestore databases create --database="(default)" --location="$REGION"
fi

if ! gcloud storage buckets describe "gs://${EVIDENCE_BUCKET}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${EVIDENCE_BUCKET}" --location="$REGION" --uniform-bucket-level-access
fi

gcloud storage buckets update "gs://${EVIDENCE_BUCKET}" --cors-file=backend/gcs-cors.json
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

gcloud builds submit backend --tag "$IMAGE"

gcloud run deploy "$SERVICE_NAME" \
  --image "$IMAGE" \
  --region "$REGION" \
  --allow-unauthenticated \
  --port 8080 \
  --memory 256Mi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 20 \
  --concurrency 100 \
  --timeout 30s \
  --set-env-vars="EVIDENCE_BUCKET=${EVIDENCE_BUCKET},ADMIN_PASSWORD=${ADMIN_PASSWORD},PUBLIC_APP_ORIGIN=${PUBLIC_APP_ORIGIN},SESSION_COLLECTION=proctor_sessions,SETTINGS_COLLECTION=proctor_settings,URL_EXPIRY_SECONDS=900"

echo "Backend URL:"
gcloud run services describe "$SERVICE_NAME" --region="$REGION" --format="value(status.url)"
