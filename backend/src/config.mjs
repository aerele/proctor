// backend/src/config.mjs — the SINGLE place (besides handler.mjs) that reads
// process.env (decomp B0; env-lint guard pins this to exactly these two files).
//
// loadConfig() READS process.env on each call and returns the env-derived
// configuration by value. handler.mjs calls it ONCE at its own module scope —
// and because each test imports the handler with a fresh `?<buster>` query, the
// handler re-evaluates and calls loadConfig() again, capturing the env that the
// test set just before that import. That is the capture-at-load contract the
// `?buster` test isolation (and invigilator.test.mjs's per-instance env probes)
// depends on, so this MUST stay a function — never top-level const reads.
import { positiveIntOr } from "./lib/http.mjs";

// One-time warn latch for the insecure CORS wildcard fallback. We KEEP the `*`
// fallback (the deploy script — backend/deploy-gcp.sh:66 — also defaults
// PUBLIC_APP_ORIGIN to `*` and does NOT require it, so prod can rely on this
// fallback; tightening it to a non-`*` value would break CORS for any deploy
// that doesn't explicitly set the origin). But a silent insecure default is the
// real hazard, so we surface it LOUDLY once: any deploy that means to lock CORS
// down sets PUBLIC_APP_ORIGIN explicitly and never sees this. (Audit C3: with no
// cookies + custom-header auth, `*` is not a credential-leak hole — this is
// defence-in-depth visibility, not a behavior change.)
let warnedWildcardCorsOrigin = false;
function resolveCorsOrigin() {
  const configured = process.env.PUBLIC_APP_ORIGIN;
  if (configured) return configured;
  if (!warnedWildcardCorsOrigin) {
    console.warn(
      "PUBLIC_APP_ORIGIN is not set; defaulting CORS Access-Control-Allow-Origin to '*' " +
      "(any web origin can call the public endpoints). Set PUBLIC_APP_ORIGIN to the " +
      "proctor-web origin to restrict it."
    );
    warnedWildcardCorsOrigin = true;
  }
  return "*";
}

export function loadConfig() {
  return {
    // ---- Firestore collection names -------------------------------------------
    SESSION_COLLECTION: process.env.SESSION_COLLECTION || "proctor_sessions",
    SETTINGS_COLLECTION: process.env.SETTINGS_COLLECTION || "proctor_settings",
    ALERTS_COLLECTION: process.env.ALERTS_COLLECTION || "proctor_alerts",
    SUBMISSION_EVENTS_COLLECTION: process.env.SUBMISSION_EVENTS_COLLECTION || "proctor_submission_events",
    LIVE_LOCK_COLLECTION: process.env.LIVE_LOCK_COLLECTION || "proctor_live_locks",
    REVIEW_STATE_COLLECTION: process.env.REVIEW_STATE_COLLECTION || "proctor_review_state",
    REVIEW_COLLECTION: process.env.REVIEW_COLLECTION || "proctor_reviews",
    REVIEW_CLAIMS_COLLECTION: process.env.REVIEW_CLAIMS_COLLECTION || "proctor_review_claims",
    SUBMISSIONS_COLLECTION: process.env.SUBMISSIONS_COLLECTION || "proctor_submissions",
    // RUN events (execRun → Judge0 against SAMPLE tests): the P3 genuine-effort
    // signal. Mirrors SUBMISSIONS_COLLECTION's denormalized-identity shape.
    RUN_EVENTS_COLLECTION: process.env.RUN_EVENTS_COLLECTION || "proctor_run_events",
    PROBLEMS_COLLECTION: process.env.PROBLEMS_COLLECTION || "proctor_problems",
    EDITOR_EVENTS_COLLECTION: process.env.EDITOR_EVENTS_COLLECTION || "editor-events", // GCS sub-prefix label
    ROSTER_COLLECTION: process.env.ROSTER_COLLECTION || "proctor_roster",
    ROOM_GATES_COLLECTION: process.env.ROOM_GATES_COLLECTION || "proctor_room_gates",
    CONTESTS_COLLECTION: process.env.CONTESTS_COLLECTION || "proctor_contests",
    COLLEGES_COLLECTION: process.env.COLLEGES_COLLECTION || "proctor_colleges",
    PERSONS_COLLECTION: process.env.PERSONS_COLLECTION || "proctor_persons",
    ENROLLMENTS_COLLECTION: process.env.ENROLLMENTS_COLLECTION || "proctor_enrollments",
    ADMIN_AUDIT_COLLECTION: process.env.ADMIN_AUDIT_COLLECTION || "proctor_admin_audit",
    TEMPLATES_COLLECTION: process.env.TEMPLATES_COLLECTION || "proctor_templates",
    EVALUATIONS_COLLECTION: process.env.EVALUATIONS_COLLECTION || "proctor_evaluations",

    // ---- Storage / Judge0 -----------------------------------------------------
    EVIDENCE_BUCKET: process.env.EVIDENCE_BUCKET,
    JUDGE0_BASE_URL: process.env.JUDGE0_BASE_URL || "https://judge0-ce.p.rapidapi.com",
    JUDGE0_MODE: process.env.JUDGE0_MODE || "rapidapi",
    JUDGE0_API_KEY: process.env.JUDGE0_API_KEY,
    JUDGE0_AUTH_TOKEN: process.env.JUDGE0_AUTH_TOKEN,
    URL_EXPIRY_SECONDS: Number(process.env.URL_EXPIRY_SECONDS || "900"),
    // Signer key file used ONLY for local v4 URL signing (no token/network).
    // When set, tokens still come from the reliable metadata-server ADC; only
    // signing uses the key. Undefined → all clients fall back to the main ADC
    // client (current behavior).
    SIGNER_KEY_FILE: process.env.SIGNER_KEY_FILE,

    // ---- Credentials / API keys (closed-by-default when unset) -----------------
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    INVIGILATOR_PASSWORD: process.env.INVIGILATOR_PASSWORD,
    ALERTS_INGEST_API_KEY: process.env.ALERTS_INGEST_API_KEY,
    RETENTION_SWEEP_API_KEY: process.env.RETENTION_SWEEP_API_KEY,

    // ---- Tunable numeric limits -----------------------------------------------
    EDITOR_EVENTS_INGEST_LIMIT: Number(process.env.EDITOR_EVENTS_INGEST_LIMIT || "5000"),
    EXEC_RUN_COOLDOWN_SECONDS: Number(process.env.EXEC_RUN_COOLDOWN_SECONDS || "5"),
    EXEC_SUBMIT_COOLDOWN_SECONDS: Number(process.env.EXEC_SUBMIT_COOLDOWN_SECONDS || "20"),
    EXEC_MAX_SUBMISSIONS_PER_SESSION: Number(process.env.EXEC_MAX_SUBMISSIONS_PER_SESSION || "50"),
    EXEC_RUN_CONCURRENCY: Number(process.env.EXEC_RUN_CONCURRENCY || "2"),
    EXEC_SUBMIT_CONCURRENCY: Number(process.env.EXEC_SUBMIT_CONCURRENCY || "4"),
    EXEC_POLL_CONCURRENCY: Number(process.env.EXEC_POLL_CONCURRENCY || "16"),
    EXEC_MAX_QUEUE: Number(process.env.EXEC_MAX_QUEUE || "200"),
    DISCONNECTED_STALENESS_MS: Number(process.env.DISCONNECTED_STALENESS_MS || "45000"),
    EVALUATE_BATCH_LIMIT: Number(process.env.EVALUATE_BATCH_LIMIT || "25"),
    // Per-batch wall-clock budget: evaluateContestBatch breaks its per-identity
    // loop early (returns cursor + done:false) once elapsed exceeds this, so each
    // HTTP batch returns well under the Cloud Run 120s request timeout regardless
    // of one heavy candidate's GCS gather. Default 90s (< 120s with headroom).
    EVALUATE_TIME_BUDGET_MS: positiveIntOr(process.env.EVALUATE_TIME_BUDGET_MS, 90000),
    // Idempotency lease: a `__job::{slug}` doc whose status is "running" and whose
    // heartbeat is within this window locks out a concurrent contest-evaluate POST
    // (409 eval_in_progress); a staler heartbeat is reclaimable so a crashed run
    // never wedges the button. Default 180s.
    EVAL_LEASE_MS: positiveIntOr(process.env.EVAL_LEASE_MS, 180000),
    PUBLIC_APP_ORIGIN: resolveCorsOrigin(),
    PUBLIC_APP_URL: process.env.PUBLIC_APP_URL || "",
    // Write-isolation for the proctor-eval service. When set (comma-separated
    // collection names), the Firestore client guard rejects any WRITE to a
    // collection NOT in this list — so a runaway/compromised eval deploy can
    // only ever mutate its OWN collection(s), never the test-taking data. UNSET
    // (proctor-api) = no guard at all, behavior completely unchanged. Reads are
    // always allowed. The expected value for proctor-eval is the EVALUATIONS
    // collection name (default "proctor_evaluations"), the only collection the
    // eval routes write to.
    EVAL_WRITE_ALLOWLIST: process.env.EVAL_WRITE_ALLOWLIST || "",
    // S3 nit: a bad env value (Number("abc") -> NaN, or a <=0 value) must NOT
    // silently disable the brute-force cap; fall back to the safe default of 20.
    GATE_ATTEMPT_LIMIT: positiveIntOr(process.env.GATE_ATTEMPT_LIMIT, 20),

    // ---- v1.1 G3 infra hardening ----------------------------------------------
    // Request body-size cap (audit #9): reject oversized JSON with a 413 BEFORE
    // parsing it into memory. 2 MiB comfortably exceeds the largest legit body
    // (a roster CSV upload / editor-events batch) while bounding a low-mem
    // instance's parse cost. Tunable for a friend's larger-roster deploy.
    MAX_REQUEST_BODY_BYTES: positiveIntOr(process.env.MAX_REQUEST_BODY_BYTES, 2 * 1024 * 1024),
    // Signed chunk-upload size cap (audit #7): the v4 WRITE URL is signed with an
    // x-goog-content-length-range condition so a valid token can't PUT an
    // arbitrarily large object. 64 MiB headroom: a 30 s screen+camera HD webm
    // chunk is single-digit MB even at high bitrate, so a legit HD recording is
    // NEVER blocked; only a multi-GB abuse PUT is. Tunable.
    MAX_UPLOAD_CHUNK_BYTES: positiveIntOr(process.env.MAX_UPLOAD_CHUNK_BYTES, 64 * 1024 * 1024),

    // ---- v1.1 G3 hot-path caches (audit #5) -----------------------------------
    // Short TTL (seconds) for the hot single-doc reads (contest doc + alert
    // settings). Staleness self-heals within the TTL even if an invalidation is
    // missed; writes invalidate explicitly. 0 disables (always read fresh).
    CONTEST_CACHE_TTL_MS: positiveIntOr(process.env.CONTEST_CACHE_TTL_MS, 10000),
    ALERT_SETTINGS_CACHE_TTL_MS: positiveIntOr(process.env.ALERT_SETTINGS_CACHE_TTL_MS, 10000),

    // ---- v1.1 G3 Judge0 distributed limiter (#3 — the #132 root-cause fix) -----
    // A Firestore-backed SHARDED token bucket caps GLOBAL Judge0 submit throughput
    // across all Cloud Run instances (the per-instance execQueue lanes cannot).
    // Defaults sized to the hosted RapidAPI tier: ~10 submit-POSTs/sec sustained
    // with a 40-burst, spread over 10 shards. See docs/JUDGE0-RATE-LIMITER.md for
    // the scale-ceiling note. Disabled by default-off ENABLED flag would regress
    // the fix, so it ships ENABLED; set JUDGE0_LIMITER_ENABLED=false to bypass.
    JUDGE0_LIMITER_ENABLED: (process.env.JUDGE0_LIMITER_ENABLED || "true").toLowerCase() !== "false",
    JUDGE0_LIMITER_COLLECTION: process.env.JUDGE0_LIMITER_COLLECTION || "proctor_judge0_ratelimit",
    JUDGE0_LIMITER_CAPACITY: positiveIntOr(process.env.JUDGE0_LIMITER_CAPACITY, 40),
    JUDGE0_LIMITER_REFILL_PER_SEC: Number(process.env.JUDGE0_LIMITER_REFILL_PER_SEC || "10"),
    JUDGE0_LIMITER_SHARDS: positiveIntOr(process.env.JUDGE0_LIMITER_SHARDS, 10),

    // ---- v1.1 G3 candidate-telemetry rate limit (#4) --------------------------
    // Per-session per-endpoint token-bucket cap on the six telemetry endpoints.
    // Tuned to NEVER throttle real candidate data (caps are ~15-60x the real
    // client rate, see lib/telemetryLimiter.mjs). Ships ENABLED; set
    // TELEMETRY_LIMITER_ENABLED=false to bypass.
    TELEMETRY_LIMITER_ENABLED: (process.env.TELEMETRY_LIMITER_ENABLED || "true").toLowerCase() !== "false"
  };
}
