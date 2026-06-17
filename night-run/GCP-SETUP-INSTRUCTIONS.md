# GCP setup brief — for the agent with full gcloud auth

## Objective
Create an **isolated** Google Cloud project + a **scoped service-account key** so the proctor *build* agent can deploy and live-test the **Aerele Proctor** app (Cloud Run + Cloud Storage + Firestore + Cloud Build + Artifact Registry) — WITHOUT giving the build agent any access to Karthi's other projects, VMs, or production.

## HARD REQUIREMENT — isolation (read first)
- Create a **brand-new** project dedicated to this. **Do NOT reuse any existing or production project.**
- The deployer service account must be a member of **ONLY this new project** (GCP IAM is per-project; a SA scoped here cannot see or touch any other project/VM).
- **Do NOT** grant any org-level or folder-level roles. **Do NOT** hand over Karthi's personal user credentials — produce a **service-account key** scoped to this project only.
- The result must be **budget-capped and deletable**.

## Prereqs (you, the setup agent)
- `gcloud` authenticated as Karthi with rights to create projects + link billing.
- Karthi's billing account id: `gcloud billing accounts list`.

## Steps
```bash
# --- variables ---
PROJECT_ID="aerele-proctor-dev"            # IDs are GLOBALLY unique, 6-30 chars, lowercase/digits/hyphen.
                                           # If taken, append a short suffix, e.g. aerele-proctor-dev-7k2.
REGION="asia-south1"                       # keep ALL resources in one region
SA="proctor-deployer"
KEY_PATH="$HOME/proctor-dev-sa.json"

# --- 1. create the isolated project ---
gcloud projects create "$PROJECT_ID" --name="Aerele Proctor Dev"

# --- 2. link billing (required for Cloud Run/Build/etc.) ---
BILLING=$(gcloud billing accounts list --format='value(name)' --filter='open=true' | head -1)
gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING"
# RECOMMENDED: set a small budget + alert on this project (Console → Billing → Budgets & alerts,
# e.g. $20 with 50/90/100% email alerts) so an overnight run cannot run up cost.

# --- 3. enable the APIs the app + deploy scripts use ---
gcloud services enable \
  run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  firestore.googleapis.com storage.googleapis.com iamcredentials.googleapis.com \
  cloudresourcemanager.googleapis.com --project="$PROJECT_ID"

# --- 4. dedicated deployer SA, OWNER on THIS project ONLY ---
gcloud iam service-accounts create "$SA" --project="$PROJECT_ID" \
  --display-name="Proctor deployer (build agent)"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/owner" --condition=None
# (Tighter alternative to roles/owner, if preferred — grant each instead:
#  roles/run.admin roles/cloudbuild.builds.editor roles/artifactregistry.admin
#  roles/storage.admin roles/datastore.owner roles/serviceusage.serviceUsageAdmin
#  roles/iam.serviceAccountAdmin roles/iam.serviceAccountUser roles/resourcemanager.projectIamAdmin
#  Owner-on-an-isolated-deletable-project gives the same isolation with less fuss.)

# --- 5. create the key the build agent will use ---
gcloud iam service-accounts keys create "$KEY_PATH" \
  --iam-account="${SA}@${PROJECT_ID}.iam.gserviceaccount.com"
chmod 600 "$KEY_PATH"

# --- 6. Cloud Build permission (fresh-project gotcha; harmless if redundant) ---
PNUM=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${PNUM}@cloudbuild.gserviceaccount.com" \
  --role="roles/cloudbuild.builds.builder" --condition=None || true

# --- 7. verify the KEY works on its own (not via Karthi's login) ---
gcloud auth activate-service-account --key-file="$KEY_PATH"
gcloud config set project "$PROJECT_ID"
gcloud projects describe "$PROJECT_ID" --format='value(projectId)'   # should print the project id
```

## Deliverable / handoff to the build agent
The build agent reads its GCP config from the proctor repo. On the **same machine as the proctor repo / build agent**, write:
```bash
cd /home/karthi/arogara/proctor          # the proctor repo on the build machine
mkdir -p monitoring/.data                # this dir is gitignored
cat > monitoring/.data/gcp-dev.env <<EOF
GCP_PROJECT_ID=$PROJECT_ID
GCP_REGION=$REGION
GOOGLE_APPLICATION_CREDENTIALS=$KEY_PATH
EOF
chmod 600 monitoring/.data/gcp-dev.env
```
- If you ran this on a **different machine** than the proctor build, copy `$KEY_PATH` onto the build machine and set `GOOGLE_APPLICATION_CREDENTIALS` to its path there.
- Also ensure the **`gcloud` CLI is installed on the build machine** (https://cloud.google.com/sdk/docs/install) — the build agent needs it to `gcloud auth activate-service-account --key-file=$GOOGLE_APPLICATION_CREDENTIALS` and run the app's `*/deploy-gcp.sh` scripts.
- Report back to Karthi: the `PROJECT_ID`, `REGION`, and that `monitoring/.data/gcp-dev.env` + the key file are in place.

## What you should NOT do
- Do not run the app's deploy scripts or create app secrets — the build agent does that (it generates `ADMIN_PASSWORD`/`ALERTS_INGEST_API_KEY` and lets `deploy-gcp.sh` create the buckets/Firestore). Your job is only: project + billing + APIs + SA + key + handoff.
- Do not grant org/folder roles, reuse a prod project, or expose Karthi's user credentials.

## Cleanup (after we're done)
```bash
gcloud iam service-accounts keys list --iam-account="${SA}@${PROJECT_ID}.iam.gserviceaccount.com"
gcloud iam service-accounts keys delete <KEY_ID> --iam-account="${SA}@${PROJECT_ID}.iam.gserviceaccount.com"
gcloud projects delete "$PROJECT_ID"
```
