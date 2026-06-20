# backend/ — proctor HTTP API (Cloud Run / functions-framework)

A stateless HTTP handler (`src/handler.mjs`, exported function `api`) that
runs on Cloud Run via `@google-cloud/functions-framework` (`npm start` →
`functions-framework --target=api`). It is the spine of the whole system: it owns
the **session lifecycle**, **signed-URL evidence uploads** to Google Cloud
Storage, the **shared alerts pipeline** (ingest + admin read), the **per-type
proctor alert settings**, the **admin session/stats/alert actions**, and the
**integrity + talent evaluation** routes. State lives in **Firestore** (sessions,
settings, alerts, live-slot locks, evaluations, …) and **GCS** (evidence chunks,
event JSONL, manifests, merged review videos). The same source also exports a
second entrypoint, `evalApi` in `src/eval-server.mjs`, deployed as the separate
**proctor-eval** service (it serves the `/eval-ui` Evaluation tab pages and forwards
the evaluation API routes; see `Dockerfile.eval`).

- `src/handler.mjs` — the **composition root**: it loads config, instantiates the
  per-domain route factories, and owns the central **dispatch table** (the flat
  `if (method && path === "…") return …` list). It is **no longer** the home of
  every route body — those were decomposed into `src/routes/*.mjs` factory modules
  (18 of them: `invigilator`, `public`, `exec`, `session`, `sessionGates`,
  `sessionTelemetry`, `alerts`, `submissionEvents`, `review`, `results`,
  `evaluation`, `healthCheck`, `adminContests`, `adminProblems`, `adminTemplates`,
  `adminStats`, `adminPeople`, `adminSessions`) plus the `src/lib/*.mjs` helpers,
  `src/config.mjs`, and the feature/domain modules (`contests.mjs`, `problems.mjs`,
  `identity.mjs`, `templates.mjs`, the `evaluation*.mjs` engine, …). See the HTTP
  API table in the top-level [`README.md`](../README.md) and the architecture tour
  in [`../docs/features/architecture-overview.md`](../docs/features/architecture-overview.md).
- `index.js` — functions-framework entry that re-exports `api`.
- `deploy-gcp.sh` — idempotent deploy: enables APIs, creates Firestore + evidence
  bucket + Artifact Registry repo + the **composite index** (`username_norm` +
  `contest_slug`), grants IAM, builds the image, deploys the Cloud Run service.
- `Dockerfile` / `Dockerfile.eval` — the proctor-api Cloud Run image, and the
  proctor-eval image (same source, `--target` the eval entrypoint `evalApi` in
  `src/eval-server.mjs`).
- `firestore.indexes.json` — declares the required composite index.
- `gcs-cors.json` / `gcs-lifecycle.json` — bucket CORS (browser PUT uploads) and
  the evidence auto-delete lifecycle: **two** rules — age **3** days for
  `contests/` + `sessions/` (recordings/events), and age **11** days for
  `exports/` (the longer-lived export zips).
- `test/` — `node --test` suites (mocked Firestore/Storage via
  `__setClientsForTest`; **no real GCP touched**). Run `npm run backend:test`
  from the repo root (or `npm test` from `backend/`) — the suite count is in the
  test runner output; don't hard-code it.

Key env vars: `EVIDENCE_BUCKET`, `ADMIN_PASSWORD`, `ALERTS_INGEST_API_KEY`,
`INVIGILATOR_PASSWORD`, `RETENTION_SWEEP_API_KEY`, the `JUDGE0_*` and `EXEC_*`
tuning, `EVAL_WRITE_ALLOWLIST`, `PUBLIC_APP_ORIGIN`, `URL_EXPIRY_SECONDS`,
`DISCONNECTED_STALENESS_MS`, and the 21 `*_COLLECTION` overrides. The canonical,
fullest list with defaults is **[`.env.example`](.env.example)** (also referenced
by the top-level README).
