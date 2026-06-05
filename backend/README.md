# backend/ — proctor HTTP API (Cloud Run / functions-framework)

A single stateless HTTP handler (`src/handler.mjs`, exported function `api`) that
runs on Cloud Run via `@google-cloud/functions-framework` (`npm start` →
`functions-framework --target=api`). It is the spine of the whole system: it owns
the **session lifecycle**, **signed-URL evidence uploads** to Google Cloud
Storage, the **shared alerts pipeline** (ingest + admin read), the **per-type
proctor alert settings**, and the **admin session/stats/alert actions**. State
lives in **Firestore** (sessions, settings, alerts, live-slot locks) and **GCS**
(evidence chunks, event JSONL, manifests, merged review videos).

- `src/handler.mjs` — every route + all business logic (see the HTTP API table in
  the top-level [`README.md`](../README.md)). Pure functions for path building,
  sanitization, alert normalization, and the sure-shot alert upsert.
- `index.js` — functions-framework entry that re-exports `api`.
- `deploy-gcp.sh` — idempotent deploy: enables APIs, creates Firestore + evidence
  bucket + Artifact Registry repo + the **composite index** (`username_norm` +
  `contest_slug`), grants IAM, builds the image, deploys the Cloud Run service.
- `firestore.indexes.json` — declares the required composite index.
- `gcs-cors.json` / `gcs-lifecycle.json` — bucket CORS (browser PUT uploads) and
  the 3-day evidence auto-delete lifecycle.
- `Dockerfile` — the Cloud Run image.
- `test/` — `node --test` suites (mocked Firestore/Storage via
  `__setClientsForTest`; **no real GCP touched**). Run `npm run backend:test`
  from the repo root → **111 tests**.

Key env vars: `EVIDENCE_BUCKET`, `ADMIN_PASSWORD`, `ALERTS_INGEST_API_KEY`,
`ALERTS_COLLECTION`, `SESSION_COLLECTION`, `SETTINGS_COLLECTION`,
`PUBLIC_APP_ORIGIN`, `URL_EXPIRY_SECONDS`, `DISCONNECTED_STALENESS_MS`,
`LIVE_LOCK_COLLECTION`. Full table in the top-level README.
