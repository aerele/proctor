#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID first, for example: export PROJECT_ID=aerele-proctor}"
REGION="${REGION:-asia-south1}"
SERVICE_NAME="${SERVICE_NAME:-proctor-api}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:?Set ADMIN_PASSWORD first}"
ALERTS_INGEST_API_KEY="${ALERTS_INGEST_API_KEY:?Set ALERTS_INGEST_API_KEY first (generate with: openssl rand -base64 32)}"
ALERTS_COLLECTION="${ALERTS_COLLECTION:-proctor_alerts}"
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

# Phase 2 (session model) needs a composite index on the sessions collection so
# the single-session / bulk-action / per-contest-stats queries (which filter on
# username_norm AND contest_slug) work. This MUST NOT block the deploy: the index
# builds in the background (can take minutes), and the deploy/build doesn't depend
# on it. --async returns as soon as the request is submitted (no waiting for the
# build); --quiet avoids any interactive prompt; and the whole call is non-fatal
# (|| true) so "already exists / building / any error" never stops the deploy.
SESSION_COLLECTION="${SESSION_COLLECTION:-proctor_sessions}"
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

gcloud builds submit backend --tag "$IMAGE"

# --timeout 120s: /api/exec/* requests block while the Judge0 adapter polls for
# results (up to ~90s); a 30s request timeout killed them mid-poll.
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
  --timeout 120s \
  --set-env-vars="EVIDENCE_BUCKET=${EVIDENCE_BUCKET},ADMIN_PASSWORD=${ADMIN_PASSWORD},ALERTS_INGEST_API_KEY=${ALERTS_INGEST_API_KEY},ALERTS_COLLECTION=${ALERTS_COLLECTION},PUBLIC_APP_ORIGIN=${PUBLIC_APP_ORIGIN},SESSION_COLLECTION=${SESSION_COLLECTION},SETTINGS_COLLECTION=proctor_settings,URL_EXPIRY_SECONDS=900"

echo "Backend URL:"
gcloud run services describe "$SERVICE_NAME" --region="$REGION" --format="value(status.url)"
