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
    PUBLIC_APP_ORIGIN: process.env.PUBLIC_APP_ORIGIN || "*",
    // S3 nit: a bad env value (Number("abc") -> NaN, or a <=0 value) must NOT
    // silently disable the brute-force cap; fall back to the safe default of 20.
    GATE_ATTEMPT_LIMIT: positiveIntOr(process.env.GATE_ATTEMPT_LIMIT, 20)
  };
}
