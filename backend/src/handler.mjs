// backend/src/handler.mjs — the proctor-api Cloud Run HTTP handler.
//
// COMPOSITION ROOT. This file is now a thin-ish composition root: imports →
// loadConfig() env destructure → non-env constants → the factory-composition
// block (each domain instantiated once at module scope) → the verbatim `api`
// dispatch table → the `corsOrigin` export → a small tail of still-resident
// route bodies (the data-lifecycle selection / export / purge / retention-sweep
// cluster, deliberately resident pending a future routes/dataLifecycle.mjs step).
//
// DECOMPOSITION CONVENTIONS (the decomp B-ladder — read before moving any route):
//   1. Each route domain lives in src/routes/<domain>.mjs as a factory
//      make<Domain>Routes(ctx) (domain/infra modules: flat src/*.mjs / lib/*.mjs).
//      Dependency direction is ONE-WAY: handler.mjs → routes/* → src domain
//      modules → lib/*. Never route→route; never a domain module importing a route.
//   2. Route BODIES move VERBATIM into the factory; ctx supplies every dependency.
//      env consts arrive BY VALUE (reproducing capture-at-?buster-load), the
//      Firestore client as a GETTER (getFirestore — so the fake-Firestore test
//      swap propagates; never capture `firestore` by value), and helper fns BY
//      REFERENCE (single-source, never forked).
//   3. handler.mjs instantiates each factory at module scope and DESTRUCTURES the
//      returns into the EXACT names the dispatch table already uses, so the `api`
//      dispatch table stays BYTE-IDENTICAL (canaryIsolation text-scans it).
//   4. A shared helper consumed by MORE THAN ONE factory is single-sourced: it is
//      RETURNED by its owning factory (or kept resident, hoisted) and passed BY
//      REFERENCE into every other ctx. When a consumer factory is instantiated
//      EARLIER than the owner, the helper stays RESIDENT here (a const factory
//      return would land in the consumer's temporal dead zone).
//   5. Any moved test seam (__set*ForTest / rate-limit checkers) is RETURNED by
//      the factory and RE-EXPORTED from handler.mjs so the handler.mjs?<buster>
//      test imports still resolve. `api` + `corsOrigin` are a cross-service
//      contract (src/eval-server.mjs re-wraps the same `api`) — names/signatures
//      never change.
//   6. The four CI guards bracket every step and MUST stay green: canaryIsolation
//      (byte-identical dispatch), scopingLint (contest_slug filters go through the
//      scopedQuery chokepoint or are pinned in RAW_FILTER_ALLOWLIST in the SAME
//      diff), routesAuthLint (every exported admin*/invigilator* route opens with
//      its require* guard), envLint (process.env only in handler.mjs + config.mjs).
// See docs/superpowers/plans/2026-06-11-architecture-decomposition.md for the
// full design + the B-ladder history.

import { createHash, randomInt, randomUUID } from "node:crypto";
import { FieldValue, FieldPath } from "@google-cloud/firestore";
import { makeExecQueue } from "./execQueue.mjs";
import { bucket, signingBucket, configureClients, getFirestore, judge0, putJsonl, resolveSignedReadUrl } from "./lib/clients.mjs";
import { badRequest, httpError, httpErrorWith, isHttpUrl, isTruthyParam, parseBody, requireFields, requireValidEmail, send, setCors } from "./lib/http.mjs";
import { getClientIp, hashPasscode, isoOrNow, mapWithConcurrency, maskEmail, maskPasscode, normalizeIp, normalizeUsername, safeEqual, sanitizeEditorDetail, sanitizeObject, sanitizeRoom, sanitizeSegment } from "./lib/sanitize.mjs";
import { makeAuth } from "./lib/auth.mjs";
import { makeSessionStore } from "./lib/sessionStore.mjs";
import { makeInvigilatorRoutes } from "./routes/invigilator.mjs";
import { makeEvaluation } from "./evaluation.mjs";
import { makeProctorAlerts } from "./proctorAlerts.mjs";
import { makeEnforcement, sanitizeExemptions, intOrZero } from "./enforcement.mjs";
import { makeEvaluationRoutes } from "./routes/evaluation.mjs";
import { makeAdminTemplatesRoutes } from "./routes/adminTemplates.mjs";
import { makeAdminProblemsRoutes } from "./routes/adminProblems.mjs";
import { makeAdminContestsRoutes } from "./routes/adminContests.mjs";
import { makeSubmissionEventsRoutes } from "./routes/submissionEvents.mjs";
import { makeAdminStatsRoutes } from "./routes/adminStats.mjs";
import { makeAdminPeopleRoutes } from "./routes/adminPeople.mjs";
import { makeResultsRoutes } from "./routes/results.mjs";
import { makeReviewRoutes } from "./routes/review.mjs";
import { makeAlertRoutes } from "./routes/alerts.mjs";
import { makeSessionGateRoutes } from "./routes/sessionGates.mjs";
import { makeSessionTelemetryRoutes } from "./routes/sessionTelemetry.mjs";
import { makeExecRoutes } from "./routes/exec.mjs";
import { makePublicRoutes } from "./routes/public.mjs";
import { makeSessionRoutes } from "./routes/session.mjs";
import { makeAdminSessionsRoutes } from "./routes/adminSessions.mjs";
import { makeHealthCheckRoutes } from "./routes/healthCheck.mjs";
import { loadConfig } from "./config.mjs";
import { composeSqlExecSource, configureProblemStore, getBankProblem, getProblem, isValidProblemId, LANGUAGE_IDS, scoreSubmission, validateProblemInput } from "./problems.mjs";
import { ALL_CONTESTS, applyContestExamTime, configureContestStore, createContest, listContests, regenerateContestSecret, resolveAccessCode, resolveContest, scopedQuery, setContestAccessCode, setContestStatus, slugify, updateContest } from "./contests.mjs";
import { applySelectionTransition, configureIdentityStore, findContestRosterEntries, getCollegeNameMap, getContestRosterMeta, getContestRosterSummary, getPersonById, getPersonsByIds, identityNorm, listAllPersons, listColleges, listEnrollments, listEnrollmentsForPerson, normalizeUniqueId, resolveEnrollmentSpineMatches, rosterMetaIdFor, saveContestRoster, stampSelectionDone, writeAudit } from "./identity.mjs";
import { configureTemplateStore, getTemplate, listTemplates, normalizeProblemEntries, normalizeTemplateCameraRecording, normalizeTemplateEnforcement, normalizeTemplateScreenMarkers, structuredCloneTemplate, validateTemplateInput, SEED_TEMPLATES, TEMPLATE_BOUNDS } from "./templates.mjs";
import { contestProblemEntries, effectivePoints, findProblemReferences } from "./contestProblems.mjs";
import { buildResultsCsv, buildResultsRows, computeScoreboard, computeSessionSummary, summarizeIntegrity } from "./scoreboard.mjs";
import { buildScorecardCsv, buildScorecardRows, filterDirectory } from "./people.mjs";
import { buildIpReport } from "./ipReport.mjs";
import { buildExportBundle, evaluatePurgeGate, exportObjectPath, selectExpiredEvidence, selectExpiredExports } from "./dataLifecycle.mjs";

// The mutable GCP client singletons + their judge0/bucket/jsonl/signed-url
// machinery now live in lib/clients.mjs (decomp B0). Re-export the test seams
// so the handler's public surface (and the test destructure off it) is
// unchanged. handler.mjs configures clients with env values just below.
export { __setClientsForTest, __setJudge0AdapterForTest } from "./lib/clients.mjs";

// The per-session exec rate-limiter clock + its __setExecClockForTest seam moved
// to the makeExecRoutes(ctx) factory in routes/exec.mjs (decomp B12b); the factory
// RETURNS __setExecClockForTest and handler.mjs RE-EXPORTS it below so the
// handler.mjs?<buster> test imports still resolve.

// Injectable epoch-ms clock for the candidate-evaluation orchestrator (same seam
// as __setExecClockForTest) so the per-batch wall-clock budget early break + the
// idempotency-lock lease window are deterministically testable. Production uses
// the real clock; pass null/undefined to restore it. Threaded into
// makeEvaluation(ctx) as ctx.nowMs so evaluation.mjs reads NO global clock.
let _evalClock = () => Date.now();
export function __setEvalClockForTest(fn) {
  _evalClock = fn || (() => Date.now());
}

// All env-derived configuration is read by config.mjs's loadConfig() and
// destructured here at handler module scope (decomp B0). Because each test
// imports the handler with a fresh ?<buster>, this destructure re-runs per
// instance and captures the env the test set just before that import — the
// capture-at-load contract the ?buster isolation depends on. process.env now
// appears ONLY in handler.mjs (this call) and config.mjs (env-lint guard).
const {
  SESSION_COLLECTION, SETTINGS_COLLECTION, ALERTS_COLLECTION, SUBMISSION_EVENTS_COLLECTION,
  LIVE_LOCK_COLLECTION, REVIEW_STATE_COLLECTION, REVIEW_COLLECTION, REVIEW_CLAIMS_COLLECTION,
  SUBMISSIONS_COLLECTION, RUN_EVENTS_COLLECTION, PROBLEMS_COLLECTION, EDITOR_EVENTS_COLLECTION, ROSTER_COLLECTION,
  ROOM_GATES_COLLECTION, CONTESTS_COLLECTION, COLLEGES_COLLECTION, PERSONS_COLLECTION,
  ENROLLMENTS_COLLECTION, ADMIN_AUDIT_COLLECTION, TEMPLATES_COLLECTION, EVALUATIONS_COLLECTION,
  EVIDENCE_BUCKET, SIGNER_KEY_FILE, JUDGE0_BASE_URL, JUDGE0_MODE, JUDGE0_API_KEY, JUDGE0_AUTH_TOKEN,
  URL_EXPIRY_SECONDS, ADMIN_PASSWORD, INVIGILATOR_PASSWORD, ALERTS_INGEST_API_KEY,
  RETENTION_SWEEP_API_KEY, EDITOR_EVENTS_INGEST_LIMIT, EXEC_RUN_COOLDOWN_SECONDS,
  EXEC_SUBMIT_COOLDOWN_SECONDS, EXEC_MAX_SUBMISSIONS_PER_SESSION, EXEC_RUN_CONCURRENCY,
  EXEC_SUBMIT_CONCURRENCY, EXEC_POLL_CONCURRENCY, EXEC_MAX_QUEUE, DISCONNECTED_STALENESS_MS,
  PUBLIC_APP_ORIGIN, PUBLIC_APP_URL, GATE_ATTEMPT_LIMIT, EVALUATE_BATCH_LIMIT,
  EVALUATE_TIME_BUDGET_MS, EVAL_LEASE_MS, EVAL_WRITE_ALLOWLIST
} = loadConfig();

// ---- Non-env code constants (kept local to the handler) ---------------------
// Submission-time markers (poller-sourced) for the recording-review timeline.
// ONE doc per (username_norm, contest_slug) holding the merged, de-duped-by-
// submission_id events array, so a re-post is an idempotent upsert.
// H1: per-(username_norm, contest_slug) live-slot lock. A start atomically
// .create()s the lock doc; exactly one concurrent writer wins the slot and goes
// active, the rest fall to pending_approval. Released when the owning session
// ends so a later legitimate restart can re-acquire it.
// Phase 2 (multi-reviewer recording review). The operator sets a ROSTER of
// usernames; 10 reviewers concurrently pull the next student to review by a
// fixed PRIORITY and submit a binary verdict.
//   REVIEW_STATE_COLLECTION/roster      → the single roster doc (display form +
//                                          order preserved, de-duped by norm).
//   REVIEW_COLLECTION                    → ONE record per (username, reviewer)
//                                          so a reviewer reviews a username at
//                                          most once; id = `<norm>::<reviewerKey>`.
//   REVIEW_CLAIMS_COLLECTION             → at most ONE active claim per username
//                                          (id = username_norm). A claim older
//                                          than CLAIM_TTL_MS is treated as free,
//                                          and a claim is deleted when its
//                                          reviewer submits a verdict.
const REVIEW_ROSTER_ID = "roster";
// A claim this many ms old (or older) is stale — its reviewer is presumed gone,
// so the username becomes claimable again by anyone (mirrors the live-slot
// stale-lock takeover, but TTL-based since reviewers don't emit an "ended").
const CLAIM_TTL_MS = 10 * 60 * 1000;
// Bound the roster the operator can set in one request, and the per-username
// reviews scan, so a pathological payload can't bloat a request.
const REVIEW_ROSTER_LIMIT = 5000;
const REVIEWS_QUERY_LIMIT = 20000;
const PROBLEMS_QUERY_LIMIT = 500;
// S2 roster (compulsory roster login). One ACTIVE roster, global. Meta lives in
// SETTINGS_COLLECTION under a distinct doc id (mirrors ALERT_SETTINGS_ID);
// entries live in ROSTER_COLLECTION, one
// doc per student keyed by the sanitized normalized unique-ID for O(1) login
// lookups. Re-upload is a VERSIONED REPLACE: entries carry roster_version and
// lookups ignore any entry whose version is not the meta's current one, so no
// mass delete is ever needed and a half-failed upload never becomes active.
const ROSTER_META_ID = "roster_meta";
const ROSTER_LIMIT = 5000;          // max rows per upload (mirrors REVIEW_ROSTER_LIMIT)
const ROSTER_COLUMNS_LIMIT = 30;    // max columns kept per row
const ROSTER_CELL_MAX = 200;        // max stored cell length
const CONFIGURED_ROOMS_LIMIT = 50;  // max admin-configured room labels
// The identity fields an admin may map roster columns onto. Mapped fields are
// SERVER-OVERRIDDEN at session start: the roster is the identity source of truth.
const ROSTER_MAPPABLE_FIELDS = ["name", "email", "roll_number", "hackerrank_username", "room"];
const MAX_SOURCE_CODE_LENGTH = 65536; // exec run/submit: cap candidate source size (security review)
// Per-session exec rate limits (security review): the hosted Judge0 key is
// METERED (pay-per-submission), so a leaked or looping session token must not
// be able to drain it. One run per EXEC_RUN_COOLDOWN_SECONDS, one submit per
// EXEC_SUBMIT_COOLDOWN_SECONDS, and at most EXEC_MAX_SUBMISSIONS_PER_SESSION
// stored submissions per session+problem.
// (EXEC_RUN/SUBMIT cooldowns + EXEC_MAX_SUBMISSIONS_PER_SESSION come from config.)
// Backpressure between candidates and the engine (design §11 item 2): ONE
// process-wide queue with independent Run/Submit lanes so a submit storm never
// starves quick sample runs. The lanes are passed to the adapter as GATES: a
// run/submit slot is held only across the submit POSTs, each status GET takes
// a (wide) poll-lane slot, and nothing holds any slot while a batch sleeps
// through its ~90 s poll budget — a few stuck judgings can't starve the lanes.
// Lane saturation queues up to EXEC_MAX_QUEUE (the poll lane has its own
// generous bound), then rejects (QueueFullError -> HTTP 429 below).
// Concurrency is env-tuned to the purchased RapidAPI quota; transient 429/5xx
// from the submit POSTs retry INSIDE the queue with exponential backoff +
// jitter (honoring Retry-After), while poll-phase retries live inside the
// adapter (a queue-level retry would re-submit an already-billed batch).
// (EXEC_*_CONCURRENCY + EXEC_MAX_QUEUE come from config.)
const execQueue = makeExecQueue({
  runConcurrency: EXEC_RUN_CONCURRENCY,
  submitConcurrency: EXEC_SUBMIT_CONCURRENCY,
  pollConcurrency: EXEC_POLL_CONCURRENCY,
  maxQueue: EXEC_MAX_QUEUE
  // pollMaxQueue stays at its generous default (1000).
});
// (PUBLIC_APP_ORIGIN, ADMIN_PASSWORD, INVIGILATOR_PASSWORD, ROOM_GATES_COLLECTION,
// GATE_ATTEMPT_LIMIT, ALERTS_INGEST_API_KEY, RETENTION_SWEEP_API_KEY,
// URL_EXPIRY_SECONDS come from config — see the loadConfig() destructure above.)
// Caps for the invigilator room dashboard payload.
const INVIGILATOR_SESSIONS_LIMIT = 500;
const INVIGILATOR_ALERTS_LIMIT = 100;
const ALERTS_QUERY_LIMIT = 500;
// Exam-eve 2026-06-18: raised 2000→6000 for the ~700-student hall. This is the
// EFFECTIVE production cap — it is passed into makeEvaluation() as
// sessionsQueryLimit (overriding evaluation.mjs's matching default), so the
// candidate-evaluation scan headroom lives HERE, not in the module default.
const SESSIONS_QUERY_LIMIT = 6000;
// S-J: the Results rollup scans a contest's submissions (one doc per submit).
// A heavy multi-problem hall (5000 candidates × N problems × a few submits)
// stays comfortably under this cap; bounded so a pathological contest can't
// blow the request.
// Exam-eve 2026-06-18: raised 50000→120000 for the ~700-student hall — pure
// headroom (700 students' submissions stay far under the old cap; the raise
// only widens the ceiling). DUAL USE: this constant is BOTH the effective
// submissionsQueryLimit passed into makeEvaluation() (overriding evaluation.mjs's
// default) AND the cap on computeContestResults' submissions/evaluations scans
// below — raising it is safe in both (it only widens, never tightens).
const SUBMISSIONS_RESULTS_LIMIT = 120000;
// S-G export/purge: the per-dataset ceiling the dedicated lifecycle readers use
// (F9 D11 — never the capped admin helpers). Generous; a contest beyond it is a
// deploy-time signal, surfaced by the manifest-count cross-check test.
const EXPORT_DATASET_LIMIT = 50000;
// S-J People directory: max persons we fan out per-person enrollment counts for
// in ONE directory response (the admin narrows with search/college first; a
// person page reads ONE person's full cross-round scorecard unbounded by this).
const PEOPLE_DIRECTORY_LIMIT = 500;
// Max rows per sessions-list response page (the drill-down/status-join list).
const SESSIONS_LIST_PAGE_LIMIT = 500;
// Settings doc id for the per-type proctor alert configuration (enabled +
// severity). Lives in SETTINGS_COLLECTION under a distinct doc id.
const ALERT_SETTINGS_ID = "alert_settings";
// A session whose status is still active but whose last liveness signal
// (heartbeat or beacon) is older than this many milliseconds is treated as a
// derived "disconnected" signal for the console. Configurable via env
// (DISCONNECTED_STALENESS_MS comes from config — see loadConfig() above).
// Cap on the distinct rooms list returned to the admin console so a pathological
// number of room labels can never bloat a stats/alerts response.
const ROOMS_LIST_LIMIT = 200;
// F5.6: the fixed locked_reason token for an enforcement (fullscreen) lock. Hoisted
// here from the enforcement section (decomp B1) so the makeInvigilatorRoutes(ctx)
// factory call below can pass it as ctx without a const temporal-dead-zone error.
const ENFORCEMENT_LOCK_REASON = "fullscreen_enforcement";

// F10.1: the chunk-upload surface is EXACTLY two kinds — the screen recording
// and the separate low-res camera stream. Everything else under the session
// prefix (events, manifest, merged video) is written server-side, so an
// unknown kind is rejected outright rather than sanitized into a fresh
// folder (path-traversal hardening on top of sanitizeSegment). Hoisted here
// (decomp B12a) so the makeSessionTelemetryRoutes(ctx) factory call below can pass
// it as ctx without a const temporal-dead-zone error.
const UPLOAD_CHUNK_KINDS = new Set(["screen", "camera"]);

// The candidate recorder's authoritative chunk/bitrate config. Hoisted UP to
// the non-env constants block (decomp B13) so the makeSessionRoutes(ctx) factory
// call below can pass it by value as ctx without a const temporal-dead-zone
// error (startResponse spreads it into upload_config). Value unchanged.
const uploadConfig = {
  chunk_seconds: 30,
  video_bits_per_second: 400000,
  media_bits_per_second: 180000,
  audio_bits_per_second: 32000,
  max_width: 960,
  max_frame_rate: 4
};

// Inject the env-derived client configuration into lib/clients.mjs (decomp B0):
// the evidence bucket name, signed-URL expiry, and the Judge0 connection params.
// clients.mjs never reads process.env itself, so the "?buster" re-eval semantics
// and the env-lint guard hold.
configureClients({
  evidenceBucket: EVIDENCE_BUCKET,
  urlExpirySeconds: URL_EXPIRY_SECONDS,
  signerKeyFile: SIGNER_KEY_FILE,
  judge0Config: {
    baseUrl: JUDGE0_BASE_URL, mode: JUDGE0_MODE,
    apiKey: JUDGE0_API_KEY, authToken: JUDGE0_AUTH_TOKEN
  },
  // Write-isolation allowlist (proctor-eval only). UNSET on proctor-api → no
  // guard, behavior unchanged. clients.mjs stays env-free: handler.mjs (the
  // env reader) hands the resolved value in here.
  evalWriteAllowlist: EVAL_WRITE_ALLOWLIST
});

// S4: wire the problem bank to THIS module's Firestore handle. A getter (not
// the instance) so __setClientsForTest fakes propagate to problem reads too.
configureProblemStore({ getFirestore, collection: PROBLEMS_COLLECTION });

// S-B (SHIPS DARK): contests collection + scoping chokepoints. Same getter
// pattern. No production candidate/session path reads contests yet — only the
// admin CRUD below.
configureContestStore({
  getFirestore,
  collection: CONTESTS_COLLECTION,
  // Wave-4 fix: createContest probes these for ORPHANED data carrying a
  // candidate slug (historic contest_slug values from earlier exam runs) and
  // walks to the next suffix instead of adopting the slug.
  dataCollections: [SESSION_COLLECTION, SUBMISSIONS_COLLECTION, ALERTS_COLLECTION]
});

// S-C: the identity core (proctor_colleges / proctor_persons /
// proctor_enrollments + the per-contest roster pipeline). Same getter pattern.
// Only identity_mode:"person" contests ever route into it — the global roster
// path below (no-contest / non-person scope) stays bit-for-bit.
configureIdentityStore({
  getFirestore,
  collections: {
    colleges: COLLEGES_COLLECTION,
    persons: PERSONS_COLLECTION,
    enrollments: ENROLLMENTS_COLLECTION,
    audit: ADMIN_AUDIT_COLLECTION,
    roster: ROSTER_COLLECTION,
    sessions: SESSION_COLLECTION,
    submissions: SUBMISSIONS_COLLECTION,
    alerts: ALERTS_COLLECTION,
    settings: SETTINGS_COLLECTION,
    contests: CONTESTS_COLLECTION
  }
});

// S-I §1.1: the proctor_templates collection (same getter pattern). The
// system-check seed preset lives in code; a doc with the same slug shadows it.
configureTemplateStore({ getFirestore, collection: TEMPLATES_COLLECTION });

// Factory seam (decomp B0, A2): build the auth guards + the neutral session
// store from ctx closing over THIS instance's credentials/collection names
// (captured at load — per ?buster) and the live-client getter. Destructure the
// instances at module scope so the route bodies call them byte-identically.
const auth = makeAuth({
  adminPassword: ADMIN_PASSWORD,
  invigilatorPassword: INVIGILATOR_PASSWORD,
  apiKey: ALERTS_INGEST_API_KEY,
  sweepKey: RETENTION_SWEEP_API_KEY
});
const { requireAdmin, requireInvigilator, requireInvigilatorFor, requireApiKey, requireSweepAuth, adminActor } = auth;
const sessionStore = makeSessionStore({
  getFirestore,
  sessionCollection: SESSION_COLLECTION
});
const {
  sessionRef, getSession, getSessionOrNull,
  requireWritableSession, buildStoragePrefix, sessionPrefix, candidateOf
} = sessionStore;

// Factory seam (decomp B9a): the proctor ALERTS DOMAIN — the linchpin domain
// module shared by telemetry (recordEvents/heartbeat), the invigilator feed, the
// alert routes, and (post-B10a) the session-gate enforcement raises. ctx closes
// over THIS instance's live-client getter, the http transport helper, the
// sanitizers / iso clock / session-identity adapter, the cross-domain enforcement
// helpers sanitizeExemptions + intOrZero BY REFERENCE (still resident at B9a;
// src/enforcement.mjs after B10a — hoisted fn declarations, safe to reference
// here), and the env-captured settings + alerts collection names + settings id BY
// VALUE. The returns are destructured into the SAME names the resident telemetry /
// heartbeat / invigilator-ctx / alert-route code already calls, so every call site
// stays byte-identical and the dispatch table is untouched (canaryIsolation). This
// is a pure same-file→module lift; NO routes move at B9a. Instantiated BEFORE
// makeInvigilatorRoutes so its alert-settings helpers are available for that ctx.
const proctorAlerts = makeProctorAlerts({
  getFirestore,
  httpError,
  sanitizeObject,
  normalizeUsername,
  isoOrNow,
  candidateOf,
  sanitizeExemptions,
  intOrZero,
  settingsCollection: SETTINGS_COLLECTION,
  alertsCollection: ALERTS_COLLECTION,
  alertSettingsId: ALERT_SETTINGS_ID
});
const {
  SURE_SHOT_EVENT_TYPES,
  DEFAULT_PROCTOR_ALERT_SETTINGS,
  TAB_AWAY_DEFAULT_THRESHOLD_SECONDS,
  ALERT_SOURCES,
  ALERT_SEVERITIES,
  ALERT_VERDICT_STATUSES,
  ALERT_REQUIRED_FIELDS,
  getAlertSettings,
  mergeAlertSettings,
  alertTypeConfig,
  isAlertShownToInvigilator,
  anyAlertSharedWithInvigilator,
  isRecordingStopped,
  parseRecordingStateSegments,
  parseCaptureState,
  raiseSureShotAlertsFromEvents,
  raiseSwitchAwayAlerts,
  upsertProctorAlert,
  sureShotVideoKey,
  normalizeAlert,
  normalizeVerdict,
  alertRef
} = proctorAlerts;

// Factory seam (decomp B10a): the fullscreen-enforcement DOMAIN — shared by
// telemetry (recordEvents/heartbeat), the session-gate routes, and start/resume
// config snapshots. ctx closes over the session-doc ref, the proctorAlerts raisers
// (alertTypeConfig + upsertProctorAlert) BY REFERENCE, the resident
// personContestForSession resolver (hoisted fn, by reference), the template config
// normalizers, the http/iso helpers, and the ENFORCEMENT_LOCK_REASON non-env const
// BY VALUE. Instantiated AFTER makeProctorAlerts so it can receive that factory's
// alert raisers; the pure cycle-break helpers sanitizeExemptions + intOrZero are
// STANDALONE imports from enforcement.mjs (available at module scope above, fed
// into makeProctorAlerts) so there is no proctorAlerts⇄enforcement reference cycle.
// The returns are destructured into the SAME names the resident telemetry /
// heartbeat / start-resume / gate-route code already calls, so every call site
// stays byte-identical and the dispatch table is untouched (canaryIsolation). This
// is a pure same-file→module lift; NO routes move at B10a.
const enforcement = makeEnforcement({
  sessionRef,
  alertTypeConfig,
  upsertProctorAlert,
  personContestForSession,
  normalizeTemplateEnforcement,
  normalizeTemplateCameraRecording,
  normalizeTemplateScreenMarkers,
  httpError,
  isoOrNow,
  enforcementLockReason: ENFORCEMENT_LOCK_REASON
});
const {
  applyEnforcementViolation,
  reconcileFullscreenEnforcement,
  reconcileEnforcementCountdown,
  requireExamStarted,
  enforcementConfigFor,
  cameraRecordingConfigFor,
  screenMarkersConfigFor
} = enforcement;

// Factory seam (decomp B9): the proctor-alert ROUTES (poller ingest + admin feed
// + archive batch + alert-settings get/save). ctx closes over THIS instance's
// live-client getter, the auth guards (requireApiKey for ingest, requireAdmin for
// the rest), the http transport helpers, the contest-scope resolver + chokepoint,
// the shared room helpers, the signed-url resolver, the proctorAlerts domain
// helpers (normalizeAlert / alertRef / getAlertSettings / mergeAlertSettings) BY
// REFERENCE — single source — the ALL_CONTESTS sentinel BY REFERENCE, and the
// env-captured collection names / caps / settings id BY VALUE. Instantiated AFTER
// makeProctorAlerts so its domain helpers are available. The returned route
// handlers are destructured into the SAME names the dispatch table uses, so the
// dispatch lines stay byte-identical (canaryIsolation).
const alertRoutes = makeAlertRoutes({
  getFirestore,
  requireApiKey,
  requireAdmin,
  parseBody,
  badRequest,
  isTruthyParam,
  contestScopeOf,
  scopedQuery,
  normalizeRoomFilter,
  distinctRooms,
  resolveSignedReadUrl,
  normalizeAlert,
  alertRef,
  getAlertSettings,
  mergeAlertSettings,
  allContests: ALL_CONTESTS,
  alertsCollection: ALERTS_COLLECTION,
  alertsQueryLimit: ALERTS_QUERY_LIMIT,
  sessionCollection: SESSION_COLLECTION,
  sessionsQueryLimit: SESSIONS_QUERY_LIMIT,
  settingsCollection: SETTINGS_COLLECTION,
  alertSettingsId: ALERT_SETTINGS_ID
});
const {
  ingestAlerts, adminAlerts, adminAlertAction, adminGetAlertSettings, adminSaveAlertSettings
} = alertRoutes;

// Factory seam (decomp B1, A2): the invigilator route domain. ctx closes over
// THIS instance's live-client getter, the auth guard from makeAuth, the neutral
// session-store helpers, the env-captured collection names + caps, and the
// handler-resident helper functions the routes still call (all hoisted function
// declarations, so referencing them here is safe). The returned route handlers
// are destructured at module scope so the dispatch lines stay byte-identical
// (canaryIsolation); the room-gate helpers it OWNS come back too because the
// still-resident session routes (sessionRoomGate / sessionUnlockGate) reuse
// gateRoomKey + getRoomGate.
const invigilatorRoutes = makeInvigilatorRoutes({
  getFirestore,
  requireInvigilatorFor,
  sessionRef,
  candidateOf,
  sessionCollection: SESSION_COLLECTION,
  alertsCollection: ALERTS_COLLECTION,
  roomGatesCollection: ROOM_GATES_COLLECTION,
  sessionsQueryLimit: SESSIONS_QUERY_LIMIT,
  alertsQueryLimit: ALERTS_QUERY_LIMIT,
  invigilatorSessionsLimit: INVIGILATOR_SESSIONS_LIMIT,
  invigilatorAlertsLimit: INVIGILATOR_ALERTS_LIMIT,
  disconnectedStalenessMs: DISCONNECTED_STALENESS_MS,
  enforcementLockReason: ENFORCEMENT_LOCK_REASON,
  contestScopeOf,
  normalizeRooms,
  distinctRooms,
  isStaleSession,
  getAlertSettings,
  isAlertShownToInvigilator,
  anyAlertSharedWithInvigilator,
  sanitizeExemptions
});
const {
  invigilatorOverview, invigilatorRoom, invigilatorReleaseCode, invigilatorOpenRoom,
  invigilatorExempt, invigilatorUnlockCode, invigilatorUnlock,
  // Room-gate helpers the invigilator module owns; the session-gate routes
  // (routes/sessionGates.mjs) reuse gateRoomKey + getRoomGate via ctx by reference.
  gateRoomKey, getRoomGate
} = invigilatorRoutes;

// Factory seam (decomp B10): the candidate-side session GATE routes (room-gate
// poll/unlock + the L1 enforcement-violation self-report + the L2 code unlock).
// ctx closes over the session-doc helpers, the http transport helpers, the
// resident personContestForSession resolver, the invigilator-owned room-gate
// helpers gateRoomKey + getRoomGate BY REFERENCE, the enforcement domain
// (sanitizeExemptions / intOrZero / enforcementConfigFor / applyEnforcementViolation)
// + the proctorAlerts domain (getAlertSettings) BY REFERENCE — single source — plus
// FieldValue / safeEqual and the env-captured GATE_ATTEMPT_LIMIT +
// ENFORCEMENT_LOCK_REASON BY VALUE. Instantiated AFTER makeInvigilatorRoutes (room-
// gate helpers) and after makeEnforcement/makeProctorAlerts (domain helpers). The
// returned handlers are destructured into the SAME names the dispatch table uses,
// so the dispatch lines stay byte-identical (canaryIsolation).
const sessionGateRoutes = makeSessionGateRoutes({
  getSession,
  requireWritableSession,
  sessionRef,
  personContestForSession,
  gateRoomKey,
  getRoomGate,
  parseBody,
  requireFields,
  badRequest,
  httpError,
  safeEqual,
  FieldValue,
  sanitizeExemptions,
  intOrZero,
  enforcementConfigFor,
  applyEnforcementViolation,
  getAlertSettings,
  gateAttemptLimit: GATE_ATTEMPT_LIMIT,
  enforcementLockReason: ENFORCEMENT_LOCK_REASON
});
const { sessionRoomGate, sessionEnforcementViolation, sessionUnlockGate } = sessionGateRoutes;

// Factory seam (decomp B12a): the candidate-side session TELEMETRY routes (chunk
// upload-url + events + editor-events + review-file + heartbeat + beacon) — the
// HEAVIEST consumer of the proctorAlerts + enforcement domains. ctx closes over the
// session-doc helpers + prefix builder, the http transport helpers, the sanitizers
// + client-ip reader, the storage writers, FieldValue + randomUUID, the resident
// inAdminEndGrace + personContestForSession by reference, the proctorAlerts domain
// (getAlertSettings / raiseSureShotAlertsFromEvents / alertTypeConfig /
// upsertProctorAlert / isRecordingStopped) + the enforcement domain
// (reconcileFullscreenEnforcement / reconcileEnforcementCountdown /
// enforcementConfigFor / sanitizeExemptions) BY REFERENCE — single source — plus
// the env-captured upload-chunk-kinds set / url-expiry / editor-events caps +
// collection name BY VALUE. Instantiated AFTER makeProctorAlerts + makeEnforcement
// so their helpers are available. The returned handlers are destructured into the
// SAME names the dispatch table uses, so the dispatch lines stay byte-identical
// (canaryIsolation).
const sessionTelemetryRoutes = makeSessionTelemetryRoutes({
  getSession,
  requireWritableSession,
  sessionRef,
  sessionPrefix,
  inAdminEndGrace,
  personContestForSession,
  parseBody,
  requireFields,
  badRequest,
  httpError,
  sanitizeObject,
  sanitizeEditorDetail,
  getClientIp,
  putJsonl,
  signingBucket,
  FieldValue,
  randomUUID,
  getAlertSettings,
  raiseSureShotAlertsFromEvents,
  alertTypeConfig,
  upsertProctorAlert,
  isRecordingStopped,
  reconcileFullscreenEnforcement,
  reconcileEnforcementCountdown,
  enforcementConfigFor,
  sanitizeExemptions,
  uploadChunkKinds: UPLOAD_CHUNK_KINDS,
  urlExpirySeconds: URL_EXPIRY_SECONDS,
  editorEventsIngestLimit: EDITOR_EVENTS_INGEST_LIMIT,
  editorEventsCollection: EDITOR_EVENTS_COLLECTION
});
const {
  createUploadUrl, recordEvents, ingestEditorEvents, recordReviewFile, recordHeartbeat, recordBeacon
} = sessionTelemetryRoutes;

// Factory seam (decomp B12b): the candidate code-execution routes (run + submit)
// + the per-session exec rate limiter (the execLimiter Map + cooldown/in-flight
// machinery + the _execClock seam) + the contest-membership problem resolver. ctx
// closes over the live Firestore getter, the http transport helpers, the session-
// doc helpers, the resident requireExamStarted gate (enforcement domain) +
// candidateOf adapter, the problem/contest domain fns, the judge0 engine getter +
// the process-wide execQueue, randomUUID, and the env-captured collection names /
// caps / cooldowns BY VALUE. Instantiated AFTER makeEnforcement (requireExamStarted).
// The returned route handlers are destructured into the SAME names the dispatch
// table uses (canaryIsolation). The factory RETURNS __setExecClockForTest (RE-
// EXPORTED below so handler.mjs?<buster> test imports resolve), plus rateLimited
// (the public/roster rate limiters reuse it, B12c) and contestForSession (the
// resident startResponse reuses it, B13) — both single-source, by reference.
const execRoutes = makeExecRoutes({
  getFirestore,
  parseBody,
  badRequest,
  httpError,
  getSession,
  requireWritableSession,
  requireExamStarted,
  candidateOf,
  contestProblemEntries,
  getProblem,
  effectivePoints,
  languageIds: LANGUAGE_IDS,
  composeSqlExecSource,
  scoreSubmission,
  judge0,
  execQueue,
  randomUUID,
  contestsCollection: CONTESTS_COLLECTION,
  runEventsCollection: RUN_EVENTS_COLLECTION,
  submissionsCollection: SUBMISSIONS_COLLECTION,
  maxSourceCodeLength: MAX_SOURCE_CODE_LENGTH,
  execRunCooldownSeconds: EXEC_RUN_COOLDOWN_SECONDS,
  execSubmitCooldownSeconds: EXEC_SUBMIT_COOLDOWN_SECONDS,
  execMaxSubmissionsPerSession: EXEC_MAX_SUBMISSIONS_PER_SESSION
});
const { execRun, execSubmit, rateLimited, contestForSession } = execRoutes;
// Re-export the exec clock test seam so handler.mjs?<buster> imports still resolve
// (decomp B12b — the seam moved into makeExecRoutes; this preserves the contract).
export const { __setExecClockForTest } = execRoutes;

// Factory seam (decomp B12c): the PUBLIC config + access-code + roster-lookup
// routes + the admin roster CRUD. Carries the two per-IP rate-limiter Maps
// (accessCodeAttempts / rosterLookupAttempts) + their clocks/checkers + test
// seams. ctx closes over the live Firestore getter, the http transport helpers,
// the admin auth guard, the client-ip/sanitize/mask/concurrency helpers, the
// contest/identity/access-code domain fns, the resident normalizeRooms + the exec
// factory's rateLimited BY REFERENCE, the enforcement config readers BY REFERENCE,
// randomUUID, and the env-captured collection names / ids / caps + rate-limit
// windows BY VALUE. Instantiated AFTER makeExecRoutes (rateLimited) + makeEnforcement
// (config readers). The returned route handlers are destructured into the SAME
// names the dispatch table uses (canaryIsolation). The factory RETURNS getRosterMeta
// + findRosterEntry (resident session-start/attendance reuse them) and RE-EXPORTS
// the four rate-limiter test seams below (constraint #3) so handler.mjs?<buster>
// imports resolve.
const publicRoutes = makePublicRoutes({
  getFirestore,
  requireAdmin,
  parseBody,
  requireFields,
  badRequest,
  httpError,
  getClientIp,
  normalizeUniqueId,
  maskEmail,
  mapWithConcurrency,
  randomUUID,
  resolveContest,
  resolveAccessCode,
  saveContestRoster,
  getContestRosterSummary,
  getContestRosterMeta,
  normalizeRooms,
  rateLimited,
  enforcementConfigFor,
  cameraRecordingConfigFor,
  settingsCollection: SETTINGS_COLLECTION,
  rosterMetaId: ROSTER_META_ID,
  rosterCollection: ROSTER_COLLECTION,
  rosterLimit: ROSTER_LIMIT,
  rosterCellMax: ROSTER_CELL_MAX,
  rosterColumnsLimit: ROSTER_COLUMNS_LIMIT,
  rosterMappableFields: ROSTER_MAPPABLE_FIELDS
});
const {
  publicExamConfig, publicAccessCode, rosterLookup, adminGetRoster, adminSaveRoster,
  getRosterMeta, findRosterEntry
} = publicRoutes;
// Re-export the rate-limiter test seams so handler.mjs?<buster> imports still
// resolve (decomp B12c — the seams + their Maps moved into makePublicRoutes;
// constraint #3 preserves the contract).
export const {
  __setAccessCodeClockForTest, __setRosterLookupClockForTest,
  __resetRosterLookupRateLimitForTest, checkRosterLookupRateLimit
} = publicRoutes;

// Factory seam (decomp B13): the candidate SESSION-LIFECYCLE routes (start /
// resume / validate-end / end) + the live-slot lock machinery. Carries raw-where
// site #1 (findLiveSessionFor — scopingLint allowlist re-pinned to
// { "routes/session.mjs": 1 } in this same commit). ctx closes over the live
// Firestore getter, the http transport helpers, the neutral session-store
// helpers, the client-ip reader + room/email sanitizers, the storage writers, the
// contest/identity/roster domain fns, the exec factory's contestForSession BY
// REFERENCE (startResponse resolves the problems[] payload), the enforcement
// config readers BY REFERENCE, the resident personContestForSession +
// inAdminEndGrace BY REFERENCE (still hoisted in handler.mjs because the EARLIER
// enforcement / sessionGates / sessionTelemetry factories already consume them —
// a const return would land in their temporal dead zone), randomUUID, and the
// env-captured collection names / caps + the hoisted uploadConfig BY VALUE.
// Instantiated AFTER makeExecRoutes (contestForSession) + makeEnforcement (config
// readers). The returned route handlers are destructured into the SAME names the
// dispatch table uses, so the dispatch lines stay byte-identical (canaryIsolation).
// The factory RETURNS releaseLiveSlot + takeOverLiveSlot as single-source
// references (the canary teardown ctx + the admin end/approve paths in
// adminSessions reuse them, B14) — never forked.
const sessionRoutes = makeSessionRoutes({
  getFirestore,
  parseBody,
  requireFields,
  badRequest,
  httpError,
  sessionRef,
  getSession,
  getSessionOrNull,
  requireWritableSession,
  buildStoragePrefix,
  sessionPrefix,
  getClientIp,
  sanitizeRoom,
  requireValidEmail,
  normalizeUsername,
  bucket,
  putJsonl,
  randomUUID,
  resolveContest,
  getContestRosterMeta,
  findContestRosterEntries,
  listColleges,
  identityNorm,
  resolveEnrollmentSpineMatches,
  contestProblemEntries,
  effectivePoints,
  getProblem,
  languageIds: LANGUAGE_IDS,
  computeSessionSummary,
  contestForSession,
  enforcementConfigFor,
  cameraRecordingConfigFor,
  screenMarkersConfigFor,
  sanitizeExemptions,
  personContestForSession,
  inAdminEndGrace,
  isAlreadyExists,
  sessionCollection: SESSION_COLLECTION,
  liveLockCollection: LIVE_LOCK_COLLECTION,
  submissionsCollection: SUBMISSIONS_COLLECTION,
  uploadConfig,
  execMaxSubmissionsPerSession: EXEC_MAX_SUBMISSIONS_PER_SESSION
});
const {
  startSession, resumeSession, validateEndSession, endSession,
  // shared live-slot helpers the canary teardown ctx + adminSessions (B14) reuse
  // by reference — single source, never forked.
  releaseLiveSlot, takeOverLiveSlot
} = sessionRoutes;

// Factory seam (P1): the candidate-evaluation orchestrator + its admin routes.
// makeEvaluation gathers contest-scoped Firestore docs (ALL reads through the
// scopedQuery chokepoint) + GCS editor/shell/clipboard evidence, runs the pure
// metric modules, and writes one scorecard per contest×identity (+ a __meta::
// doc from the cross-candidate pass). The routes are auth-first (routesAuthLint).
const evaluation = makeEvaluation({
  getFirestore,
  bucket,
  scopedQuery,
  resolveContest,
  contestProblemEntries,
  getProblem,
  listEnrollments,
  collections: {
    evaluations: EVALUATIONS_COLLECTION,
    submissions: SUBMISSIONS_COLLECTION,
    sessions: SESSION_COLLECTION
  },
  editorEventsLabel: EDITOR_EVENTS_COLLECTION,
  evaluateBatchLimit: EVALUATE_BATCH_LIMIT,
  sessionsQueryLimit: SESSIONS_QUERY_LIMIT,
  submissionsQueryLimit: SUBMISSIONS_RESULTS_LIMIT,
  // Orchestration knobs (eval-batch-progress-idempotent): the per-batch
  // wall-clock budget + idempotency-lock lease, plus the injectable clock (the
  // __setEvalClockForTest seam) so both are deterministically testable.
  evalTimeBudgetMs: EVALUATE_TIME_BUDGET_MS,
  evalLeaseMs: EVAL_LEASE_MS,
  nowMs: () => _evalClock()
});
const evaluationRoutes = makeEvaluationRoutes({
  requireAdmin,
  parseBody,
  badRequest,
  resolveContest,
  evaluation
});
const { adminContestEvaluate, adminContestEvaluations, adminContestEvaluateStatus } = evaluationRoutes;

// Factory seam (decomp B2): the proctor-template admin CRUD route domain. ctx
// closes over THIS instance's live-client getter, the auth guard from makeAuth,
// the http transport helpers, the env-captured collection names + caps, the
// template-domain store/validation fns (+ slugify/getBankProblem), and the
// shared handler-resident isAlreadyExists (single source). The returned route
// handlers are destructured into the SAME names the dispatch table uses, so the
// dispatch lines stay byte-identical (canaryIsolation). The template-block
// helpers it owns (templateRef / requireKnownProblems / createTemplateDoc /
// bankProblemPoints) come back too — currently used only by these routes.
const adminTemplatesRoutes = makeAdminTemplatesRoutes({
  getFirestore,
  requireAdmin,
  parseBody,
  badRequest,
  requireFields,
  httpError,
  httpErrorWith,
  templatesCollection: TEMPLATES_COLLECTION,
  problemsCollection: PROBLEMS_COLLECTION,
  problemsQueryLimit: PROBLEMS_QUERY_LIMIT,
  getTemplate,
  listTemplates,
  validateTemplateInput,
  structuredCloneTemplate,
  SEED_TEMPLATES,
  TEMPLATE_BOUNDS,
  slugify,
  getBankProblem,
  isAlreadyExists
});
const {
  adminListTemplates, adminGetTemplate, adminCreateTemplate, adminUpdateTemplate,
  adminArchiveTemplate, adminCloneTemplate, adminDeleteTemplate
} = adminTemplatesRoutes;

// Factory seam (decomp B3): the problem-bank admin authoring route domain. ctx
// closes over THIS instance's live-client getter, the auth guard from makeAuth,
// the http transport helpers, the env-captured collection names + caps, the
// problem-domain store/validation fns (isValidProblemId/validateProblemInput/
// getBankProblem), and the pure contest-reference finder (+ the template lister
// it reads through). The returned route handlers are destructured into the SAME
// names the dispatch table uses, so the dispatch lines stay byte-identical
// (canaryIsolation). The problem-bank helpers it owns (problemRef /
// problemReferenceUniverse) come back too — currently used only by these routes.
const adminProblemsRoutes = makeAdminProblemsRoutes({
  getFirestore,
  requireAdmin,
  parseBody,
  badRequest,
  httpError,
  httpErrorWith,
  problemsCollection: PROBLEMS_COLLECTION,
  problemsQueryLimit: PROBLEMS_QUERY_LIMIT,
  contestsCollection: CONTESTS_COLLECTION,
  isValidProblemId,
  validateProblemInput,
  getBankProblem,
  findProblemReferences,
  listTemplates
});
const {
  adminListProblems, adminGetProblem, adminSaveProblem, adminDeleteProblem
} = adminProblemsRoutes;

// Factory seam (decomp B14): the ADMIN session-management route domain (sessions
// search / recording-sessions picker / sessions-list drill-down / session-detail /
// session-events / ip-report / attendance / session-action / session-details bulk
// lookup). Carries raw-where sites #2/#3/#4 (endAllLiveSessions / resolveActionTargets
// / adminSessionDetails — scopingLint allowlist re-pinned to { "routes/session.mjs": 1,
// "routes/adminSessions.mjs": 3 } in this same commit). ctx closes over the live
// Firestore getter + FieldPath, the http transport helpers, the admin auth guard,
// the neutral session-store helpers, the storage clients, the sanitizers + client
// helpers, the candidateOf adapter + parseCaptureState (proctorAlerts) + sanitize-
// Exemptions (enforcement), the contest/identity/roster domain fns, the ip-report
// builder, the session-lifecycle factory's releaseLiveSlot + takeOverLiveSlot BY
// REFERENCE, the resident contestScopeOf / normalizeRoomFilter / isStaleSession /
// personContestForFilter BY REFERENCE (single source — shared with earlier factories
// + the resident selection cluster), and the env-captured collection names / caps BY
// VALUE. Instantiated BEFORE makeAdminContestsRoutes so its endAllLiveSessions return
// is available for that ctx (by reference — the end_now path; never forked). The
// returned route handlers are destructured into the SAME names the dispatch table
// uses, so the dispatch lines stay byte-identical (canaryIsolation).
const adminSessionsRoutes = makeAdminSessionsRoutes({
  getFirestore,
  FieldPath,
  parseBody,
  badRequest,
  httpError,
  requireAdmin,
  sessionRef,
  getSessionOrNull,
  sessionPrefix,
  candidateOf,
  bucket,
  signingBucket,
  mapWithConcurrency,
  normalizeUsername,
  normalizeUniqueId,
  scopedQuery,
  resolveContest,
  getRosterMeta,
  getContestRosterMeta,
  listEnrollments,
  getPersonsByIds,
  getCollegeNameMap,
  buildIpReport,
  parseCaptureState,
  sanitizeExemptions,
  releaseLiveSlot,
  takeOverLiveSlot,
  contestScopeOf,
  normalizeRoomFilter,
  isStaleSession,
  personContestForFilter,
  sessionCollection: SESSION_COLLECTION,
  rosterCollection: ROSTER_COLLECTION,
  sessionsQueryLimit: SESSIONS_QUERY_LIMIT,
  sessionsListPageLimit: SESSIONS_LIST_PAGE_LIMIT,
  rosterLimit: ROSTER_LIMIT,
  reviewRosterLimit: REVIEW_ROSTER_LIMIT
});
const {
  adminSessions, adminRecordingSessions, adminSessionsList, adminSessionDetail,
  adminSessionEvents, adminIpReport, adminAttendance, adminSessionAction, adminSessionDetails,
  // end-now sweep RETURNED for single-source reuse by the adminContests end_now
  // path (B4 ctx) — passed by reference below; never forked.
  endAllLiveSessions
} = adminSessionsRoutes;

// Factory seam (decomp B4): the admin contest-lifecycle route domain. ctx closes
// over THIS instance's live-client getter, the auth guard from makeAuth, the http
// transport helpers, the env-captured contests/submissions collection names, the
// scopedQuery chokepoint, the contests/templates/problems domain fns, the
// contest-problems reader, and the adminSessions factory's endAllLiveSessions sweep
// (by reference — it owns raw-where #2 and lives in routes/adminSessions.mjs since
// B14). The returned route handlers are destructured into the SAME names the
// dispatch table uses, so the dispatch lines stay byte-identical (canaryIsolation).
// The contest helpers it owns (instantiateTemplatePayload / requirePublishedProblems
// / enforceContestProblemsEditRules) move with the routes — currently used only here.
const adminContestsRoutes = makeAdminContestsRoutes({
  getFirestore,
  requireAdmin,
  parseBody,
  requireFields,
  badRequest,
  httpError,
  httpErrorWith,
  contestsCollection: CONTESTS_COLLECTION,
  submissionsCollection: SUBMISSIONS_COLLECTION,
  scopedQuery,
  listContests,
  createContest,
  updateContest,
  setContestStatus,
  regenerateContestSecret,
  setContestAccessCode,
  applyContestExamTime,
  getTemplate,
  normalizeProblemEntries,
  getProblem,
  getBankProblem,
  contestProblemEntries,
  endAllLiveSessions
});
const {
  adminListContests, adminCreateContest, adminUpdateContest, adminContestStatus,
  adminContestRegenerate, adminContestSetCode, adminContestExamTime
} = adminContestsRoutes;

// Factory seam (decomp B5): the poller-sourced submission-time markers route
// domain. ctx closes over THIS instance's live-client getter, the env-captured
// submission-events collection name, the http transport helpers, and the
// username normalizer. The two routes keep their DIFFERENT auth guards: the
// poller ingest uses requireApiKey (the x-api-key mechanism, like alerts
// ingest); the admin recording-review read is auth-first with requireAdmin
// (routesAuthLint). The returned route handlers are destructured into the SAME
// names the dispatch table uses, so the dispatch lines stay byte-identical
// (canaryIsolation). The submission-events helpers it owns (submissionEventsDocId
// / submissionEventsRef / normalizeSubmissionEvent / mergeSubmissionEvents) come
// back too — currently used only by these routes.
const submissionEventsRoutes = makeSubmissionEventsRoutes({
  getFirestore,
  requireApiKey,
  requireAdmin,
  parseBody,
  badRequest,
  httpError,
  normalizeUsername,
  // The contest_slug-filter chokepoint, for the native-submission fallback scope.
  scopedQuery,
  submissionEventsCollection: SUBMISSION_EVENTS_COLLECTION,
  // FALLBACK store for proctor-native contests: the in-app submissions the exam
  // app writes (proctor_submission_events is the HackerRank-poller mirror only).
  submissionsCollection: SUBMISSIONS_COLLECTION,
  // RUN events (execRun → SAMPLE tests): merged into the recording-review
  // timeline as distinct kind:"run" events alongside the submits.
  runEventsCollection: RUN_EVENTS_COLLECTION
});
const { ingestSubmissionEvents, adminSubmissionEvents } = submissionEventsRoutes;

// Factory seam (decomp B6): the admin live-counts dashboard route domain. ctx
// closes over THIS instance's live-client getter, the auth guard from makeAuth,
// the contest-scope resolver + scopedQuery chokepoint, the
// env-captured session collection name / query cap / disconnected-staleness
// threshold, the ALL_CONTESTS identity sentinel (passed BY REFERENCE so
// adminStats's `scope === ALL_CONTESTS` identity check holds), and the SHARED
// room/staleness helpers (normalizeRoomFilter / distinctRooms / isStaleSession)
// which stay RESIDENT in handler.mjs because adminSessionsList / adminIpReport /
// the review-rooms helper (and routes/invigilator.mjs, via its own ctx) reuse
// them. The returned route handler is destructured into the SAME name the
// dispatch table uses, so the dispatch line stays byte-identical
// (canaryIsolation). adminStats is auth-first (routesAuthLint) and a SCOPED GET
// (canaryIsolation's SCOPED_GET_REQUESTS); all session reads go through
// scopedQuery, so this move adds no raw contest_slug filter (scopingLint).
const adminStatsRoutes = makeAdminStatsRoutes({
  getFirestore,
  requireAdmin,
  contestScopeOf,
  scopedQuery,
  normalizeRoomFilter,
  distinctRooms,
  isStaleSession,
  sessionCollection: SESSION_COLLECTION,
  sessionsQueryLimit: SESSIONS_QUERY_LIMIT,
  disconnectedStalenessMs: DISCONNECTED_STALENESS_MS,
  allContests: ALL_CONTESTS
});
const { adminStats } = adminStatsRoutes;

// Factory seam (decomp B11): the pen-and-paper review cluster (roster + claims +
// the priority-ranked next/verdict/mine/reviews routes). ctx closes over THIS
// instance's live-client getter, the auth guard from makeAuth, the http transport
// helpers, the contest resolver + username normalizer + already-exists predicate
// BY REFERENCE, and the env-captured review collection names / ids / caps / claim
// TTL BY VALUE. The returned route handlers are destructured into the SAME names
// the dispatch table uses, so the dispatch lines stay byte-identical
// (canaryIsolation). The factory ALSO returns getAllReviews / reviewRecordId /
// reviewerKeyFor / reviewContestSlugOf / getActiveClaims so the still-resident
// dataLifecycle purge gatherer AND makeResultsRoutes (the integrity column) reuse
// the SAME single-source implementations by reference. Instantiated BEFORE
// makeResultsRoutes so its getAllReviews return is available for that factory's ctx.
const reviewRoutes = makeReviewRoutes({
  getFirestore,
  requireAdmin,
  parseBody,
  requireFields,
  badRequest,
  resolveContest,
  normalizeUsername,
  isAlreadyExists,
  reviewStateCollection: REVIEW_STATE_COLLECTION,
  reviewRosterId: REVIEW_ROSTER_ID,
  reviewCollection: REVIEW_COLLECTION,
  reviewClaimsCollection: REVIEW_CLAIMS_COLLECTION,
  reviewsQueryLimit: REVIEWS_QUERY_LIMIT,
  reviewRosterLimit: REVIEW_ROSTER_LIMIT,
  claimTtlMs: CLAIM_TTL_MS
});
const {
  adminSetReviewRoster, adminGetReviewRoster, adminReviewNext, adminReviewVerdict,
  adminReviewMine, adminReviews,
  getAllReviews, reviewRecordId, reviewerKeyFor, reviewContestSlugOf, getActiveClaims, reviewRosterRef
} = reviewRoutes;

// Factory seam (decomp B8): the post-exam Results-tab READ/COMPUTE trio. ctx
// closes over THIS instance's live-client getter, the auth guard from makeAuth,
// the scopedQuery chokepoint, the scoreboard builders, the enrollment / person /
// college / problem / roster domain fns, the env-captured collection names + scan
// caps BY VALUE, and the two RESIDENT helpers personContestForFilter +
// getAllReviews BY REFERENCE (single source — shared with the still-resident
// person / selection / export cluster). The returned route handler is
// destructured into the SAME name the dispatch table uses, so the dispatch line
// stays byte-identical (canaryIsolation). adminContestResults is auth-first
// (routesAuthLint) and a SCOPED GET. The factory ALSO returns computeContestResults
// (the resident selection-done / export / purge code calls it) and
// integrityByPersonFor (the makeAdminPeopleRoutes ctx below consumes it) — both
// kept SINGLE-SOURCE, passed by reference downstream, never forked (constraint #5).
// Instantiated BEFORE makeAdminPeopleRoutes so its integrityByPersonFor return is
// available for that factory's ctx.
const resultsRoutes = makeResultsRoutes({
  getFirestore,
  requireAdmin,
  scopedQuery,
  buildResultsRows,
  buildResultsCsv,
  listEnrollments,
  contestProblemEntries,
  getContestRosterMeta,
  getPersonsByIds,
  getCollegeNameMap,
  getProblem,
  personContestForFilter,
  getAllReviews,
  submissionsCollection: SUBMISSIONS_COLLECTION,
  submissionsResultsLimit: SUBMISSIONS_RESULTS_LIMIT,
  sessionCollection: SESSION_COLLECTION,
  sessionsQueryLimit: SESSIONS_QUERY_LIMIT,
  evaluationsCollection: EVALUATIONS_COLLECTION,
  alertsCollection: ALERTS_COLLECTION,
  alertsQueryLimit: ALERTS_QUERY_LIMIT
});
const { adminContestResults, computeContestResults, integrityByPersonFor } = resultsRoutes;

// Factory seam (decomp B7): the S-J §2.14 People tab route domain (the
// cross-contest directory + the per-person cross-round scorecard). ctx closes
// over THIS instance's live-client getter, the auth guard from makeAuth, the
// badRequest transport helper, the identity-store fns (listAllPersons /
// getCollegeNameMap / getPersonById / listEnrollmentsForPerson), the people.mjs
// PURE helpers (filterDirectory / buildScorecardRows / buildScorecardCsv), the
// shared utilities the scorecard join reuses (mapWithConcurrency / resolveContest
// / scopedQuery / contestProblemEntries / computeScoreboard / summarizeIntegrity
// and integrityByPersonFor returned from makeResultsRoutes above — all BY
// REFERENCE so the SAME implementations the Results table uses are shared, not
// forked), and the
// env-captured directory cap / submissions collection name + query cap BY VALUE.
// The returned route handlers are destructured into the SAME names the dispatch
// table uses, so the dispatch lines stay byte-identical (canaryIsolation). Both
// routes are auth-first (routesAuthLint) and SCOPED GETs (SCOPED_GET_REQUESTS):
// the only raw .where() inside is on person_id over a scopedQuery handle (never a
// raw contest_slug filter), so scopingLint's allowlist stays {handler.mjs: 4}.
const adminPeopleRoutes = makeAdminPeopleRoutes({
  getFirestore,
  requireAdmin,
  badRequest,
  listAllPersons,
  getCollegeNameMap,
  getPersonById,
  listEnrollmentsForPerson,
  filterDirectory,
  buildScorecardRows,
  buildScorecardCsv,
  mapWithConcurrency,
  resolveContest,
  scopedQuery,
  contestProblemEntries,
  computeScoreboard,
  summarizeIntegrity,
  integrityByPersonFor,
  peopleDirectoryLimit: PEOPLE_DIRECTORY_LIMIT,
  submissionsCollection: SUBMISSIONS_COLLECTION,
  submissionsResultsLimit: SUBMISSIONS_RESULTS_LIMIT
});
const { adminPeople, adminPerson } = adminPeopleRoutes;

// Factory seam: the admin pre-flight health-check route domain. ctx closes over
// THIS instance's live-client getters (bucket/signingBucket/putJsonl/judge0 +
// the Firestore getter), the auth guard, the http transport helpers, the
// session-start reuse (so the canary genuinely exercises the candidate-auth
// path), the contest/session/teardown domain fns (resolveContest / listContests
// / scopedQuery / releaseLiveSlot / deleteEvidencePrefix / deleteDocsByIds —
// ALL by reference so the SAME implementations are shared, never forked), the
// sessionPrefix builder, and the env-captured collection names / bucket / origin
// / Judge0 connection params + the LANGUAGE_IDS map BY VALUE. The returned
// handler is destructured into the SAME name the dispatch table uses, so the
// dispatch line stays byte-identical (canaryIsolation). It is auth-first
// (routesAuthLint) and a NON-contest-scoped meta endpoint — it stands up its OWN
// ephemeral __healthcheck-* canary and tears it down ALWAYS, so it is EXEMPT in
// canaryIsolation (it is POST, and reads no real contest's data).
const healthCheckRoutes = makeHealthCheckRoutes({
  getFirestore,
  requireAdmin,
  parseBody,
  badRequest,
  startSession,
  sessionPrefix,
  resolveContest,
  listContests,
  scopedQuery,
  releaseLiveSlot,
  deleteEvidencePrefix,
  deleteDocsByIds,
  bucket,
  signingBucket,
  putJsonl,
  judge0,
  contestsCollection: CONTESTS_COLLECTION,
  sessionCollection: SESSION_COLLECTION,
  submissionsCollection: SUBMISSIONS_COLLECTION,
  liveLockCollection: LIVE_LOCK_COLLECTION,
  evidenceBucket: EVIDENCE_BUCKET,
  urlExpirySeconds: URL_EXPIRY_SECONDS,
  publicAppOrigin: PUBLIC_APP_ORIGIN,
  publicAppUrl: PUBLIC_APP_URL,
  // Pre-compute sha256(password) for the bundle_hashes pre-flight probe so the
  // probe can assert the served frontend bundle carries the expected gate hashes
  // WITHOUT ever seeing the raw passwords (label-only from here down). Any unset
  // password is skipped so the probe degrades to a clean "skip", not a false red.
  expectedBundleHashes: [
    { label: "admin", password: ADMIN_PASSWORD },
    { label: "invigilator", password: INVIGILATOR_PASSWORD }
  ]
    .filter((e) => typeof e.password === "string" && e.password.length > 0)
    .map((e) => ({ label: e.label, hash: createHash("sha256").update(e.password, "utf8").digest("hex") })),
  judge0BaseUrl: JUDGE0_BASE_URL,
  judge0Mode: JUDGE0_MODE,
  judge0ApiKey: JUDGE0_API_KEY,
  judge0AuthToken: JUDGE0_AUTH_TOKEN,
  languageIds: LANGUAGE_IDS
});
const { healthCheck } = healthCheckRoutes;

// Lifecycle states for a session doc (Phase 2 — Epic 2 / 0.3):
//   active          → the one live session for (username_norm, contest_slug)
//   pending_approval → a second start arrived for an already-active username;
//                      waits for admin approval or a takeover before going live
//   locked          → admin locked it (or a contingency lock); needs unlock
//   ended           → finished (manifest uploaded or admin-ended)
const SESSION_STATUSES = ["active", "pending_approval", "locked", "ended"];

// uploadConfig hoisted UP to the non-env constants block (decomp B13) so the
// makeSessionRoutes(ctx) factory call can pass it by value without a const
// temporal-dead-zone error. Value unchanged.

// UPLOAD_CHUNK_KINDS hoisted UP to the non-env constants block (decomp B12a) so
// the makeSessionTelemetryRoutes(ctx) factory call can pass it without hitting the
// const temporal dead zone. Value unchanged.

export const api = async (req, res) => {
  try {
    setCors(res, PUBLIC_APP_ORIGIN);
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    const path = req.path || new URL(req.url, "http://localhost").pathname;
    if (req.method === "POST" && path === "/api/session/start") return send(res, 200, await startSession(req));
    if (req.method === "POST" && path === "/api/session/resume") return send(res, 200, await resumeSession(req));
    if (req.method === "POST" && path === "/api/upload-url") return send(res, 200, await createUploadUrl(req));
    if (req.method === "POST" && path === "/api/events") return send(res, 200, await recordEvents(req));
    if (req.method === "POST" && path === "/api/exec/run") return send(res, 200, await execRun(req));
    if (req.method === "POST" && path === "/api/exec/submit") return send(res, 200, await execSubmit(req));
    if (req.method === "POST" && path === "/api/editor-events") return send(res, 200, await ingestEditorEvents(req));
    if (req.method === "GET" && path === "/api/exam-config") return send(res, 200, await publicExamConfig(req));
    if (req.method === "POST" && path === "/api/access-code") return send(res, 200, await publicAccessCode(req));
    if (req.method === "POST" && path === "/api/roster/lookup") return send(res, 200, await rosterLookup(req));
    if (req.method === "GET" && path === "/api/admin/roster") return send(res, 200, await adminGetRoster(req));
    if (req.method === "POST" && path === "/api/admin/roster") return send(res, 200, await adminSaveRoster(req));
    if (req.method === "POST" && path === "/api/review-file") return send(res, 200, await recordReviewFile(req));
    if (req.method === "POST" && path === "/api/heartbeat") return send(res, 200, await recordHeartbeat(req));
    if (req.method === "POST" && path === "/api/session/beacon") return send(res, 200, await recordBeacon(req));
    if (req.method === "POST" && path === "/api/session/validate-end") return send(res, 200, await validateEndSession(req));
    if (req.method === "POST" && path === "/api/session/end") return send(res, 200, await endSession(req));
    if (req.method === "POST" && path === "/api/session/room-gate") return send(res, 200, await sessionRoomGate(req));
    if (req.method === "POST" && path === "/api/session/enforcement-violation") return send(res, 200, await sessionEnforcementViolation(req));
    if (req.method === "POST" && path === "/api/session/unlock-gate") return send(res, 200, await sessionUnlockGate(req));
    if (req.method === "GET" && path === "/api/admin/contests") return send(res, 200, await adminListContests(req));
    if (req.method === "POST" && path === "/api/admin/contests") return send(res, 200, await adminCreateContest(req));
    if (req.method === "POST" && path === "/api/admin/contest-update") return send(res, 200, await adminUpdateContest(req));
    if (req.method === "POST" && path === "/api/admin/contest-status") return send(res, 200, await adminContestStatus(req));
    if (req.method === "POST" && path === "/api/admin/contest-regenerate") return send(res, 200, await adminContestRegenerate(req));
    if (req.method === "POST" && path === "/api/admin/contest-set-code") return send(res, 200, await adminContestSetCode(req));
    if (req.method === "POST" && path === "/api/admin/contest-exam-time") return send(res, 200, await adminContestExamTime(req));
    if (req.method === "GET" && path === "/api/admin/templates") return send(res, 200, await adminListTemplates(req));
    if (req.method === "GET" && path === "/api/admin/template") return send(res, 200, await adminGetTemplate(req));
    if (req.method === "POST" && path === "/api/admin/templates") return send(res, 200, await adminCreateTemplate(req));
    if (req.method === "POST" && path === "/api/admin/template-update") return send(res, 200, await adminUpdateTemplate(req));
    if (req.method === "POST" && path === "/api/admin/template-archive") return send(res, 200, await adminArchiveTemplate(req));
    if (req.method === "POST" && path === "/api/admin/template-clone") return send(res, 200, await adminCloneTemplate(req));
    if (req.method === "POST" && path === "/api/admin/template-delete") return send(res, 200, await adminDeleteTemplate(req));
    if (req.method === "GET" && path === "/api/admin/problems") return send(res, 200, await adminListProblems(req));
    if (req.method === "GET" && path === "/api/admin/problem") return send(res, 200, await adminGetProblem(req));
    if (req.method === "POST" && path === "/api/admin/problems") return send(res, 200, await adminSaveProblem(req));
    if (req.method === "POST" && path === "/api/admin/problem-delete") return send(res, 200, await adminDeleteProblem(req));
    if (req.method === "GET" && path === "/api/admin/sessions") return send(res, 200, await adminSessions(req));
    if (req.method === "GET" && path === "/api/admin/recording-sessions") return send(res, 200, await adminRecordingSessions(req));
    if (req.method === "GET" && path === "/api/admin/sessions-list") return send(res, 200, await adminSessionsList(req));
    if (req.method === "GET" && path === "/api/admin/session-detail") return send(res, 200, await adminSessionDetail(req));
    if (req.method === "GET" && path === "/api/admin/session-events") return send(res, 200, await adminSessionEvents(req));
    if (req.method === "POST" && path === "/api/submission-events") return send(res, 200, await ingestSubmissionEvents(req));
    if (req.method === "GET" && path === "/api/admin/submission-events") return send(res, 200, await adminSubmissionEvents(req));
    if (req.method === "GET" && path === "/api/admin/stats") return send(res, 200, await adminStats(req));
    if (req.method === "GET" && path === "/api/admin/ip-report") return send(res, 200, await adminIpReport(req));
    if (req.method === "GET" && path === "/api/admin/attendance") return send(res, 200, await adminAttendance(req));
    if (req.method === "GET" && path === "/api/admin/contest-results") return send(res, 200, await adminContestResults(req));
    if (req.method === "POST" && path === "/api/admin/contest-evaluate") return send(res, 200, await adminContestEvaluate(req));
    if (req.method === "GET" && path === "/api/admin/contest-evaluations") return send(res, 200, await adminContestEvaluations(req));
    if (req.method === "GET" && path === "/api/admin/contest-evaluate-status") return send(res, 200, await adminContestEvaluateStatus(req));
    if (req.method === "POST" && path === "/api/admin/contest-selection") return send(res, 200, await adminContestSelection(req));
    if (req.method === "POST" && path === "/api/admin/contest-selection-done") return send(res, 200, await adminContestSelectionDone(req));
    if (req.method === "POST" && path === "/api/admin/contest-export") return send(res, 200, await adminContestExport(req));
    if (req.method === "POST" && path === "/api/admin/contest-purge") return send(res, 200, await adminContestPurge(req));
    if (req.method === "POST" && path === "/api/admin/retention-sweep") return send(res, 200, await adminRetentionSweep(req));
    if (req.method === "GET" && path === "/api/admin/people") return send(res, 200, await adminPeople(req));
    if (req.method === "GET" && path === "/api/admin/person") return send(res, 200, await adminPerson(req));
    if (req.method === "POST" && path === "/api/admin/health-check") return send(res, 200, await healthCheck(req));
    if (req.method === "POST" && path === "/api/admin/session-action") return send(res, 200, await adminSessionAction(req));
    if (req.method === "POST" && path === "/api/admin/session-details") return send(res, 200, await adminSessionDetails(req));
    if (req.method === "POST" && path === "/api/alerts") return send(res, 200, await ingestAlerts(req));
    if (req.method === "GET" && path === "/api/admin/alerts") return send(res, 200, await adminAlerts(req));
    if (req.method === "POST" && path === "/api/admin/alert-action") return send(res, 200, await adminAlertAction(req));
    if (req.method === "GET" && path === "/api/admin/alert-settings") return send(res, 200, await adminGetAlertSettings(req));
    if (req.method === "POST" && path === "/api/admin/alert-settings") return send(res, 200, await adminSaveAlertSettings(req));
    if (req.method === "POST" && path === "/api/admin/review-roster") return send(res, 200, await adminSetReviewRoster(req));
    if (req.method === "GET" && path === "/api/admin/review-roster") return send(res, 200, await adminGetReviewRoster(req));
    if (req.method === "POST" && path === "/api/admin/review-next") return send(res, 200, await adminReviewNext(req));
    if (req.method === "POST" && path === "/api/admin/review-verdict") return send(res, 200, await adminReviewVerdict(req));
    if (req.method === "GET" && path === "/api/admin/review-mine") return send(res, 200, await adminReviewMine(req));
    if (req.method === "GET" && path === "/api/admin/reviews") return send(res, 200, await adminReviews(req));
    if (req.method === "GET" && path === "/api/invigilator/overview") return send(res, 200, await invigilatorOverview(req));
    if (req.method === "GET" && path === "/api/invigilator/room") return send(res, 200, await invigilatorRoom(req));
    if (req.method === "POST" && path === "/api/invigilator/release-code") return send(res, 200, await invigilatorReleaseCode(req));
    if (req.method === "POST" && path === "/api/invigilator/open-room") return send(res, 200, await invigilatorOpenRoom(req));
    if (req.method === "POST" && path === "/api/invigilator/exempt") return send(res, 200, await invigilatorExempt(req));
    if (req.method === "POST" && path === "/api/invigilator/unlock-code") return send(res, 200, await invigilatorUnlockCode(req));
    if (req.method === "POST" && path === "/api/invigilator/unlock") return send(res, 200, await invigilatorUnlock(req));

    return send(res, 404, { error: "Not found" });
  } catch (error) {
    // Always log the real error server-side for debugging.
    console.error(error);
    const statusCode = error?.statusCode || 500;
    // M3: only intentional 4xx httpError cases (those carrying an explicit
    // statusCode) get their message echoed to the client via `detail`.
    // Unexpected 500s return a generic body with NO `detail`, so an internal
    // stack/message (DB names, paths, library internals) never leaks to callers.
    const isIntentional = Boolean(error?.statusCode);
    if (isIntentional) {
      const message = String(error?.message || error);
      const body = { error: message, detail: message };
      // Rate-limit rejections (429, exec limiter) carry a machine-readable
      // retry hint inside the same JSON error shape as every other error.
      if (error.retry_after_seconds !== undefined) body.retry_after_seconds = error.retry_after_seconds;
      // S-C: structured reject payloads (duplicate_unique_ids row lists,
      // college_required rows, college_choices for the ambiguity picker) ride
      // the same JSON error shape; `error`/`detail` always win the spread.
      if (error.payload && typeof error.payload === "object") Object.assign(body, error.payload, { error: message, detail: message });
      // S-I guard errors carry structured context (referencing contest/template
      // slugs, unavailable problem ids) — merged into the same JSON error shape.
      // Server-controlled fields only (httpErrorWith call sites), never client
      // echo; `error`/`detail` still always win the spread.
      if (error.extra && typeof error.extra === "object") Object.assign(body, error.extra, { error: message, detail: message });
      return send(res, statusCode, body);
    }
    return send(res, 500, { error: "Internal server error" });
  }
};

// The CORS origin this handler instance was configured with (PUBLIC_APP_ORIGIN,
// captured at module load like every other env value). Re-exported ADDITIVELY so
// the proctor-eval entry (src/eval-server.mjs) can apply the SAME CORS header to
// its own short-circuit 404s without reading process.env itself (keeping the
// env-lint allowlist at handler.mjs + config.mjs). This export does not alter the
// `api` dispatcher in any way — proctor-api's behavior is unchanged.
export const corsOrigin = PUBLIC_APP_ORIGIN;

// ---- candidate SESSION-LIFECYCLE routes (start / resume / validate-end / end)
// The session-lifecycle route bodies (startSession / resumeSession /
// validateEndSession / endSession) + their owned helpers (resolvePersonContestForStart
// / validateContestWindow / resolvePersonRosterIdentity / startPersonSession /
// startResponse / contestProblemsPublic / publicStubsFor / sessionSubmissionsSummary)
// + the live-slot lock machinery (findLiveSessionFor [raw-where #1] / liveLockId /
// liveLockRef / acquireLiveSlot / releaseLiveSlot / takeOverLiveSlot) moved VERBATIM
// to the makeSessionRoutes(ctx) factory in routes/session.mjs (decomp B13);
// destructured at module scope above so the dispatch lines stay byte-identical
// (canaryIsolation). startResponse consumes the exec factory's contestForSession +
// the enforcement config readers via the factory ctx; releaseLiveSlot +
// takeOverLiveSlot come back as single-source references (the canary teardown ctx +
// the admin end/approve paths in adminSessions reuse them, B14). personContestForSession
// + inAdminEndGrace + isAlreadyExists stay RESIDENT below (single source) because
// EARLIER factories (enforcement / sessionGates / sessionTelemetry / adminTemplates /
// review) consume them via their own ctxs — a const return would land in their
// temporal dead zone; they are passed BY REFERENCE into makeSessionRoutes.

// The person-mode contest a stored session belongs to, or null when it resolves
// to no current person contest (e.g. an old/orphaned session doc). Only
// person-path docs (they carry candidate_id) ever resolve a contest here.
// NOT the same as contestForSession (S-I §3.2) below, which resolves ANY real
// contest doc for exec membership + the problems[] payload.
async function personContestForSession(session) {
  if (!session?.contest_slug || session.candidate_id === undefined) return null;
  try {
    const contest = await resolveContest(session.contest_slug, { requireOpen: false });
    return contest.identity_mode !== "person" ? null : contest;
  } catch {
    return null;
  }
}

function isAlreadyExists(error) {
  // Firestore signals an existing-doc create collision with gRPC code 6
  // (ALREADY_EXISTS); the fake test Firestore mirrors this. Match on code or
  // message so both real and mocked clients are handled.
  return error?.code === 6 || /ALREADY_EXISTS/i.test(String(error?.message || ""));
}

// D2 — post-admin-end grace. An admin end (end-now / per-session end / the
// approve-supersede path) flips the session to "ended" SERVER-side while the
// candidate's recorder is still flushing: the B1 self-stop fires on the next
// 409 heartbeat and then uploads the FINAL chunk + the session/end manifest —
// which a hard status gate would reject, losing the last seconds of evidence.
// So for a short bounded window after an ADMIN-initiated end (never a student
// self-end), /api/upload-url and /api/session/end still accept the session.
// Nothing reopens: status/ended_at/ended_reason stay exactly as the admin set
// them. 5 minutes comfortably covers a 409→stop→flush cycle on a slow uplink
// while keeping the post-end write surface tightly bounded.
const ADMIN_END_GRACE_MS = 5 * 60_000;
const ADMIN_END_GRACE_REASONS = new Set(["exam_ended_by_admin", "admin_action", "superseded_by_approval"]);

function inAdminEndGrace(session) {
  if (session?.status !== "ended") return false;
  if (!ADMIN_END_GRACE_REASONS.has(session.ended_reason)) return false;
  const endedMs = Date.parse(session.ended_at || "");
  return Number.isFinite(endedMs) && Date.now() - endedMs <= ADMIN_END_GRACE_MS;
}

// createUploadUrl (signed chunk-write URL) + recordEvents (evidence batch +
// sure-shot raising + fullscreen-exit reconciliation) moved VERBATIM to the
// makeSessionTelemetryRoutes(ctx) factory in routes/sessionTelemetry.mjs
// (decomp B12a); destructured at module scope above so the dispatch lines stay
// byte-identical (canaryIsolation). They consume the proctorAlerts + enforcement
// domains via the factory ctx, and the resident inAdminEndGrace by reference.

// ---- Per-session exec rate limiting + the exec routes (S-I §3.1/§3.2) --------
// The execLimiter Map + cooldown/in-flight machinery (execLimiterEntry /
// problemLimiterView / problemLimiterRecord / rateLimited / queueFull /
// judgeUnavailable / checkExecRunLimit / checkExecSubmitLimit) + the contest-
// membership problem resolver (contestForSession / resolveExecProblem /
// buildExecItems) + the execRun / execSubmit routes + the _execClock seam moved
// VERBATIM to the makeExecRoutes(ctx) factory in routes/exec.mjs (decomp B12b);
// destructured at module scope above so the dispatch lines stay byte-identical
// (canaryIsolation). __setExecClockForTest is RE-EXPORTED above; rateLimited
// (public/roster limiters) + contestForSession (startResponse) come back too as
// single-source references.

// ingestEditorEvents + recordReviewFile + recordHeartbeat + recordBeacon + the
// parseBeaconBody helper moved VERBATIM to the makeSessionTelemetryRoutes(ctx)
// factory in routes/sessionTelemetry.mjs (decomp B12a); destructured at module
// scope above so the dispatch lines stay byte-identical (canaryIsolation). The
// heartbeat/beacon sure-shots + countdown reconciliation consume the proctorAlerts
// + enforcement domains via the factory ctx.


// ---- S4: problem bank (admin authoring) ------------------------------------
// The four admin problem-bank route bodies (adminListProblems / adminGetProblem
// / adminSaveProblem / adminDeleteProblem) + their owned helpers (problemRef /
// problemReferenceUniverse, with the CONTESTS_REFERENCE_LIMIT cap) moved VERBATIM
// to the makeAdminProblemsRoutes(ctx) factory in routes/adminProblems.mjs
// (decomp B3); destructured at module scope above so the dispatch lines stay
// byte-identical (canaryIsolation). The §1.4.3 live-reference guard rules live
// alongside the route bodies there.

// ---- S-I §1.1/§2: proctor templates (admin CRUD) -----------------------------
// The seven admin template route bodies + their owned helpers (templateRef /
// requireKnownProblems / createTemplateDoc / bankProblemPoints) moved VERBATIM
// to the makeAdminTemplatesRoutes(ctx) factory in routes/adminTemplates.mjs
// (decomp B2); destructured at module scope above so the dispatch lines stay
// byte-identical (canaryIsolation). Thin glue over src/templates.mjs as before.

// ---- S-B: contests (F9 §2 / F10 §2.7) ----------------------------------------
// The seven admin contest-lifecycle route bodies (adminListContests /
// adminCreateContest / adminUpdateContest / adminContestStatus /
// adminContestRegenerate / adminContestSetCode / adminContestExamTime) + their
// owned helpers (instantiateTemplatePayload / requirePublishedProblems /
// enforceContestProblemsEditRules) moved VERBATIM to the makeAdminContestsRoutes(ctx)
// factory in routes/adminContests.mjs (decomp B4); destructured at module scope
// above so the dispatch lines stay byte-identical (canaryIsolation). Thin admin
// glue over src/contests.mjs (validation + slug/access-code minting live there);
// the resident endAllLiveSessions sweep is passed by reference for the end_now path.

// ---- S2 roster store (spec: docs/superpowers/specs/2026-06-09-s2-roster-login-design.md)
// The roster store helpers (rosterMetaRef / getRosterMeta / rosterEntryId) +
// the roster CRUD routes (adminSaveRoster / adminGetRoster + resolvePersonContestParam)
// + the public config / access-code / roster-lookup routes + their two per-IP
// rate-limiter Maps + clock seams moved to the makePublicRoutes(ctx) factory in
// routes/public.mjs (decomp B12c); destructured at module scope above so the
// dispatch lines stay byte-identical (canaryIsolation). getRosterMeta +
// findRosterEntry come back as single-source references (resident session-start +
// attendance reuse them); the four rate-limiter test seams are RE-EXPORTED above.
// normalizeRooms STAYS resident below — it is shared with the invigilator ctx.

// Admin-configured room labels: sanitizeRoom each, drop empties, dedupe
// case-insensitively preserving first-seen casing, cap the list.
function normalizeRooms(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const room = sanitizeRoom(item);
    if (!room || seen.has(room.toLowerCase())) continue;
    seen.add(room.toLowerCase());
    out.push(room);
    if (out.length >= CONFIGURED_ROOMS_LIMIT) break;
  }
  return out;
}

// adminSaveRoster / resolvePersonContestParam / adminGetRoster + publicExamConfig /
// contestExamConfig + the PUBLIC access-code resolver (checkAccessCodeRateLimit +
// publicAccessCode, with the accessCodeAttempts Map + ACCESS_CODE_RATE_* consts +
// the __setAccessCodeClockForTest seam) + findRosterEntry + the roster-lookup
// limiter (checkRosterLookupRateLimit + rosterLookup, with the rosterLookupAttempts
// Map + ROSTER_LOOKUP_RATE_* consts + the __setRosterLookupClockForTest /
// __resetRosterLookupRateLimitForTest seams) moved VERBATIM to the
// makePublicRoutes(ctx) factory in routes/public.mjs (decomp B12c); destructured at
// module scope above so the dispatch lines stay byte-identical (canaryIsolation).
// The four rate-limiter test seams are RE-EXPORTED from handler above (constraint #3).

// mapWithConcurrency moved to lib/sanitize.mjs (decomp B0); imported at the top.

// S-C: route an OPTIONAL admin/invigilator contest filter through the
// scopedQuery chokepoint (F9 §2.3.2). Absent/"" → ALL_CONTESTS (no filter —
// explicit sentinel); a known contest → its resolved doc; an unknown slug
// filters literally (raw-where semantics: an empty result set, never an error —
// admin GET signatures stay unchanged, F9 D10 — and it keeps any
// orphaned/historic data browsable by its literal slug).
async function contestScopeOf(slugRaw) {
  const slug = slugRaw === undefined || slugRaw === null ? "" : String(slugRaw).trim();
  if (!slug) return ALL_CONTESTS;
  try {
    return await resolveContest(slug, { requireOpen: false });
  } catch {
    return { slug };
  }
}

// ---- ADMIN session-management routes (sessions / recordings / drill-down /
// detail / events / ip-report / attendance / session-action / session-details)
// The nine admin session-management route bodies (adminSessions /
// adminRecordingSessions / adminSessionsList / adminSessionDetail /
// adminSessionEvents / adminIpReport / adminAttendance / adminSessionAction /
// adminSessionDetails) + their owned helpers (projectSessionEventDetail + the
// SESSION_EVENT_DETAIL_* caps / endAllLiveSessions [raw-where #2] /
// resolveActionTargets [raw-where #3] / applySessionAction / personContestAttendance
// / personEnrollmentAttendance; adminSessionDetails carries raw-where #4) moved
// VERBATIM to the makeAdminSessionsRoutes(ctx) factory in routes/adminSessions.mjs
// (decomp B14); destructured at module scope above so the dispatch lines stay
// byte-identical (canaryIsolation). endAllLiveSessions comes back as a single-source
// reference (the adminContests end_now path reuses it). The shared room/staleness
// helpers normalizeRoomFilter / distinctRooms / isStaleSession + the contestScopeOf
// scope resolver + personContestForFilter STAY RESIDENT here (single source — earlier
// factories + the resident selection cluster reuse them) and are passed BY REFERENCE
// into makeAdminSessionsRoutes.

// ---- Submission-time markers (poller-sourced) -----------------------------
// The two submission-events route bodies (ingestSubmissionEvents [requireApiKey
// poller ingest] / adminSubmissionEvents [requireAdmin recording-review read,
// scoped GET]) + their owned helpers (submissionEventsDocId / submissionEventsRef
// / normalizeSubmissionEvent / mergeSubmissionEvents, with the
// SUBMISSION_EVENTS_INGEST_LIMIT cap) moved VERBATIM to the
// makeSubmissionEventsRoutes(ctx) factory in routes/submissionEvents.mjs (decomp
// B5); destructured at module scope above so the dispatch lines stay
// byte-identical (canaryIsolation). Each route keeps its DIFFERENT auth guard.

// Phase 2 (2.4 / Epic 6.4 / 4.4): the admin live-counts dashboard route
// (adminStats, GET /api/admin/stats — by-status session counts + derived
// disconnected + the contest-scope rooms list) moved VERBATIM to the
// makeAdminStatsRoutes(ctx) factory in routes/adminStats.mjs (decomp B6);
// destructured at module scope above so the dispatch line stays byte-identical
// (canaryIsolation). The shared room/staleness helpers it uses
// (normalizeRoomFilter / distinctRooms / isStaleSession) stay RESIDENT here —
// other handler code reuses them — and are passed in via ctx by reference.

// Normalize a ?room query param to the same sanitized form rooms are stored in,
// so the filter matches a session's stored room label exactly. Empty/absent →
// null (no filter).
function normalizeRoomFilter(value) {
  if (value === undefined || value === null || value === "") return null;
  const cleaned = sanitizeRoom(value);
  return cleaned || null;
}

// Distinct, sorted room labels across the given session docs, capped so a
// pathological number of labels can't bloat the response. Blank rooms are
// excluded (they don't belong in a dropdown).
function distinctRooms(docs) {
  const set = new Set();
  for (const doc of docs) {
    const room = String(doc.room || "").trim();
    if (room) set.add(room);
  }
  return [...set].sort((a, b) => a.localeCompare(b)).slice(0, ROOMS_LIST_LIMIT);
}

// An active session is "stale" (a derived disconnected signal) when its most
// recent LIVENESS signal — last_heartbeat_at OR last_seen_at (beacon), whichever
// is newer — is older than DISCONNECTED_STALENESS_MS. Only when NEITHER liveness
// stamp exists do we fall back to created_at, so a session that started but never
// sent a heartbeat still ages into disconnected rather than looking permanently
// fresh. created_at is NOT mixed in when a liveness stamp exists (a fresh
// created_at would otherwise mask a genuinely stale heartbeat).
function isStaleSession(doc, nowMs) {
  const liveness = [doc.last_heartbeat_at, doc.last_seen_at]
    .map((value) => (value ? Date.parse(value) : NaN))
    .filter((ms) => Number.isFinite(ms));
  let newest;
  if (liveness.length) {
    newest = Math.max(...liveness);
  } else {
    const created = doc.created_at ? Date.parse(doc.created_at) : NaN;
    if (!Number.isFinite(created)) return false;
    newest = created;
  }
  return nowMs - newest > DISCONNECTED_STALENESS_MS;
}

// The real person-mode contest behind an optional admin filter value, or null
// when absent/unknown. NEVER throws: admin GET signatures stay unchanged
// (F9 D10), so an unknown slug filters exactly as today.
async function personContestForFilter(contestSlug) {
  if (contestSlug === undefined || contestSlug === null || String(contestSlug).trim() === "") return null;
  try {
    const contest = await resolveContest(String(contestSlug).trim(), { requireOpen: false });
    return contest.identity_mode !== "person" ? null : contest;
  } catch {
    return null;
  }
}

// ---- S-J §2.14 Results tab (the post-exam admin rollup) --------------------
// The Results-tab READ/COMPUTE trio (adminContestResults route +
// computeContestResults + integrityByPersonFor) moved VERBATIM to the
// makeResultsRoutes(ctx) factory in routes/results.mjs (decomp B8); destructured
// at module scope above so the dispatch line stays byte-identical (canaryIsolation).
// The factory is instantiated BEFORE makeAdminPeopleRoutes and RETURNS
// computeContestResults + integrityByPersonFor so the still-resident selection /
// selection-done / export / purge cluster (and the makeAdminPeopleRoutes ctx)
// keep using the SAME single-source implementations by reference. The
// selection/adopt/export/purge cluster DELIBERATELY stays resident here (B8 note).

// POST /api/admin/contest-selection — bulk selection transition on enrollment
// rows (shortlisted / selected / rejected / none) with a from_status race
// guard. ADMIN-ONLY. Drives the Results-tab bulk-selection UI.
async function adminContestSelection(req) {
  requireAdmin(req);
  const body = parseBody(req);
  const contest = await personContestForFilter(body.contest ?? body.contest_slug);
  if (!contest) return badRequest("contest must name a person-mode contest");
  const toStatus = String(body.selection_status || "");
  const fromStatus = body.from_status === undefined || body.from_status === null ? "" : String(body.from_status);
  return applySelectionTransition(contest, body.person_ids, fromStatus, toStatus, adminActor(req, body));
}

// POST /api/admin/contest-selection-done — "Mark selection done": freeze each
// active enrollment's final_snapshot from the current rollup + stamp the
// retention clock (selection_done_at on the contest). ADMIN-ONLY. The retention
// SWEEP itself is Wave 7 (see stampSelectionDone's TODO marker).
async function adminContestSelectionDone(req) {
  requireAdmin(req);
  const body = parseBody(req);
  const contest = await personContestForFilter(body.contest ?? body.contest_slug);
  if (!contest) return badRequest("contest must name a person-mode contest");
  const data = await computeContestResults(contest);
  // Build the per-person snapshot map the enrollment store freezes. We snapshot
  // the SAME numbers the Results table shows (single source of truth).
  const snapshotByPerson = new Map();
  for (const row of data.rows) {
    if (row.unmatched) continue; // no enrollment to stamp (KPR 2026-06-12 rows)
    const perProblem = {};
    for (const cell of row.per_problem) perProblem[cell.problem_id] = cell.best_score;
    snapshotByPerson.set(row.person_id, {
      total_score: row.total,
      per_problem: perProblem,
      integrity: {
        alerts_by_severity: row.integrity.alerts_by_severity,
        review_verdict: row.integrity.review_verdict
      },
      evaluation: row.evaluation || null, // P1 (E): freeze the projected evaluation so the purged path can resurface it
      unique_id: row.candidate_id,
      name: row.name,
      session_status: ""
    });
  }
  return stampSelectionDone(contest, snapshotByPerson, adminActor(req, body));
}

// ---- Wave7-G data lifecycle (S-G/S-H): export → triple-gated purge → sweep ----
//
// SENSITIVE: irreversible deletion. The pure decision/assembly/selection logic
// lives in dataLifecycle.mjs (unit-tested on a clock seam); THIS layer owns the
// Firestore reads, GCS object writes/deletes, tombstone writes and audit rows,
// and never deletes a contest's heavy data unless evaluatePurgeGate() returns
// ok:true. resolveContest/scopedQuery keep the F9 no-bleed invariant intact —
// every read is scoped to the RESOLVED contest; persons/colleges/other contests
// are never touched.

// The per-contest datasets a purge deletes, in delete order. Each is keyed by a
// `contest_slug` field on its docs (denormalized on every NEW write) so a
// scopedQuery on the resolved contest selects exactly this contest's docs.
const PURGE_DATASETS = [
  { key: "alerts", collection: () => ALERTS_COLLECTION },
  { key: "submission_events", collection: () => SUBMISSION_EVENTS_COLLECTION },
  // run_events: execRun writes candidate source_code + denormalized identity
  // (contest_slug/username_norm/candidate_id/person_id) on every run, so it is
  // PII that MUST be erased on purge and included in an export. Each doc carries
  // contest_slug, so the scopedQuery/readContestDataset/deleteDocsByIds spine
  // selects exactly this contest's run docs — same as submission_events.
  { key: "run_events", collection: () => RUN_EVENTS_COLLECTION },
  { key: "live_locks", collection: () => LIVE_LOCK_COLLECTION },
  { key: "room_gates", collection: () => ROOM_GATES_COLLECTION }
];

// Dedicated reader for a contest-scoped dataset (F9 D11 — deliberately NOT the
// capped SESSIONS_QUERY_LIMIT/REVIEWS_QUERY_LIMIT admin helpers, which would
// silently truncate a big contest). Bounded by the generous export ceiling
// (50k) and scoped through the scopedQuery chokepoint so the no-bleed invariant
// holds. A contest exceeding this ceiling is a deploy-time signal, not a silent
// data-loss bug — the manifest counts cross-check in tests pin truncation-free.
async function readContestDataset(collectionName, contest) {
  const snap = await scopedQuery(getFirestore().collection(collectionName), contest)
    .limit(EXPORT_DATASET_LIMIT)
    .get();
  return snap.docs.map((doc) => ({ _id: doc.id, ...doc.data() }));
}

// Submissions need the legacy session-join leg too (F9 D7): NEW docs carry
// contest_slug, but legacy docs only carry session_id. We read the contest's
// sessions first, then union (scoped-by-contest_slug submissions) with (any
// submission whose session_id belongs to this contest).
async function readContestSubmissions(contest, sessionIds) {
  const byField = await readContestDataset(SUBMISSIONS_COLLECTION, contest);
  const seen = new Set(byField.map((s) => s._id));
  if (sessionIds.size) {
    const allSnap = await getFirestore().collection(SUBMISSIONS_COLLECTION).limit(EXPORT_DATASET_LIMIT).get();
    for (const doc of allSnap.docs) {
      const data = doc.data();
      if (seen.has(doc.id)) continue;
      if (sessionIds.has(String(data.session_id || ""))) {
        byField.push({ _id: doc.id, ...data });
        seen.add(doc.id);
      }
    }
  }
  return byField;
}

// Gather every per-contest dataset for export/purge. ONE place so export and
// purge agree on exactly what a contest's data IS.
async function gatherContestDatasets(contest) {
  const sessions = await readContestDataset(SESSION_COLLECTION, contest);
  const sessionIds = new Set(sessions.map((s) => String(s.session_id || s._id)));
  const submissions = await readContestSubmissions(contest, sessionIds);
  const enrollments = (await listEnrollments(contest)).map((e) => ({ _id: enrollmentIdOfHandler(contest.slug, e.person_id), ...e }));
  const personIds = [...new Set(enrollments.map((e) => String(e.person_id || "")).filter(Boolean))];
  const personsMap = await getPersonsByIds(personIds);
  const persons = [...personsMap.entries()].map(([id, p]) => ({ _id: id, ...p }));
  const colleges = (await listColleges()).map((c) => ({ _id: c.college_norm, ...c }));
  // Review docs carry no `id` field; their doc id is deterministic from the
  // stored (username_norm, reviewer_name, contest_slug) — reconstruct it so the
  // purge delete-by-id targets the REAL doc (a legacy slugless review carries
  // contest_slug:"" and its id is slugless — reconstruct that form too).
  const reviews = (await getAllReviews(contest.slug)).map((r) => ({
    _id: reviewRecordId(String(r.username_norm || ""), reviewerKeyFor(String(r.reviewer_name || "")), String(r.contest_slug || "")),
    ...r
  }));
  // Review claims (at most one per username/contest); doc id is
  // {usernameNorm}::{slug} (slugless = legacy). reviewContestSlugOf maps a
  // legacy/synth contest to "" so getActiveClaims reads the right scope.
  const reviewScopeSlug = await reviewContestSlugOf(contest.slug).catch(() => contest.slug);
  const claims = await getActiveClaims(reviewScopeSlug);
  const review_claims = claims.map((c) => ({
    _id: reviewScopeSlug ? `${String(c.username_norm || "")}::${reviewScopeSlug}` : String(c.username_norm || ""),
    ...c
  }));

  const datasets = { sessions, submissions, enrollments, persons, colleges, reviews, review_claims };
  for (const ds of PURGE_DATASETS) {
    datasets[ds.key] = await readContestDataset(ds.collection(), contest);
  }
  // roster_entries: this contest's active-version entries (keyed by version).
  datasets.roster_entries = await readContestRosterEntries(contest);
  return datasets;
}

function enrollmentIdOfHandler(slug, personId) {
  return `${slug}::${personId}`;
}

async function readContestRosterEntries(contest) {
  const meta = await getContestRosterMeta(contest);
  if (!meta) return [];
  const snap = await getFirestore().collection(ROSTER_COLLECTION)
    .where("roster_version", "==", meta.version)
    .limit(ROSTER_LIMIT)
    .get();
  return snap.docs.map((doc) => ({ _id: doc.id, ...doc.data() }));
}

// POST /api/admin/contest-export {contest} — assemble a self-contained archive
// of the contest's data + the Results rollup, write it to GCS under the
// contest's exports/ prefix, stamp last_export_at + the export object path on
// the contest doc, and audit it. Returns a reference/temp (signed) URL. The
// heavy video is NOT in the archive (GCS-native; F9 §3.1).
async function adminContestExport(req) {
  requireAdmin(req);
  const body = parseBody(req);
  const contest = await personContestForFilter(body.contest ?? body.contest_slug);
  if (!contest) return badRequest("contest must name a person-mode contest");

  const exportedAt = new Date().toISOString();
  const datasets = await gatherContestDatasets(contest);
  // The Results rollup is the human-facing scores snapshot; reuse the SAME
  // computation the Results tab serves (single source of truth).
  const results = await computeContestResults(contest).catch(() => null);
  const bundle = buildExportBundle({ contest, datasets, results, exportedAt });

  // Serialize the bundle as ONE newline-delimited object (no heavy zip dep — a
  // self-describing text bundle: each file is a `=== name ===` section). The
  // manifest counts + per-section bodies make it losslessly re-importable.
  const archiveBody = bundle.entries
    .map((entry) => `=== ${entry.name} ===\n${entry.body}`)
    .join("\n\n");
  const gcsKey = exportObjectPath(contest.slug, exportedAt);
  // The storage call goes through the existing bucket() client so tests stub it.
  await bucket().file(gcsKey).save(archiveBody, { contentType: "application/x-ndjson" });
  let signedUrl = "";
  try {
    const [url] = await signingBucket().file(gcsKey).getSignedUrl({
      version: "v4", action: "read", expires: Date.now() + URL_EXPIRY_SECONDS * 1000
    });
    signedUrl = url;
  } catch (err) {
    // A signing failure must not lose the export — the object is already written.
    console.error(`export signed-url failed for ${gcsKey}: ${err?.message || err}`);
  }

  const lastExport = { at: exportedAt, gcs_key: gcsKey, counts: bundle.manifest.counts };
  await getFirestore().collection(CONTESTS_COLLECTION).doc(contest.slug).set({
    last_export: lastExport,
    last_export_at: exportedAt,
    updated_at: exportedAt
  }, { merge: true });

  await writeAudit({
    action: "contest_export",
    contest_slug: contest.slug,
    gcs_key: gcsKey,
    counts: bundle.manifest.counts
  }, adminActor(req, body), exportedAt);

  return { ok: true, gcs_key: gcsKey, signed_url: signedUrl, counts: bundle.manifest.counts, exported_at: exportedAt };
}

// POST /api/admin/contest-purge {contest, confirm, slug, include_evidence} —
// the TRIPLE-GATED, server-enforced, irreversible purge (F9 §3.2 / D12).
// Gates: a prior successful export (last_export_at), an explicit confirm flag,
// and the typed contest slug echoed in the body. Deletes the heavy data,
// RETAINS enrollments + final_snapshot (purge-survivor, vision §2.9), NEVER
// touches persons/colleges/other contests, and stamps a tombstone. Idempotent.
async function adminContestPurge(req) {
  requireAdmin(req);
  const body = parseBody(req);
  const contest = await personContestForFilter(body.contest ?? body.contest_slug);
  if (!contest) return badRequest("contest must name a person-mode contest");

  // SERVER-ENFORCED triple gate (the UI mirrors this; it is not the authority).
  const gate = evaluatePurgeGate({
    contest,
    confirm: body.confirm,
    typedSlug: body.slug ?? body.confirm_name
  });
  if (!gate.ok) throw httpError(400, gate.code);
  if (gate.already_purged) {
    return { ok: true, already_purged: true, contest: contest.slug };
  }

  // EXPORT-IS-THE-RECOVERY-PATH (F9 D12): the gate proved a `last_export_at`
  // stamp exists, but a stamp is not an artifact. The retention-sweep deletes
  // export zips after 10 days WITHOUT clearing the stamp on a slow path, and a
  // GCS lifecycle backstop can remove them at day 11 — so a stale stamp can
  // outlive the only recovery archive for this IRREVERSIBLE purge. Re-verify the
  // backing object still LIVES in GCS before deleting anything; if it is gone,
  // refuse (the admin must re-export to restore a real recovery anchor).
  const exportKey = contest.last_export?.gcs_key || "";
  if (!(await exportObjectExists(exportKey))) {
    throw httpError(400, "export_missing");
  }

  const includeEvidence = body.include_evidence === true;
  const now = new Date().toISOString();

  // Read everything FIRST so the tombstone records accurate counts + evidence
  // prefixes, and so the purge-survivor snapshot is computed from live data.
  const datasets = await gatherContestDatasets(contest);
  const sessions = datasets.sessions;
  const evidencePrefixes = [...new Set(sessions.map((s) => sessionPrefix(s)).filter(Boolean))];

  // PURGE-SURVIVOR: refresh each active enrollment's final_snapshot from the
  // current Results rollup BEFORE deleting the heavy data it was computed from
  // (vision §2.9). stampSelectionDone freezes the snapshot; it also (re)stamps
  // selection_done_at, which is harmless/correct at purge time.
  const results = await computeContestResults(contest).catch(() => null);
  if (results && Array.isArray(results.rows)) {
    const snapshotByPerson = new Map();
    for (const row of results.rows) {
      if (row.unmatched) continue; // no enrollment to stamp (KPR 2026-06-12 rows)
      const perProblem = {};
      for (const cell of row.per_problem || []) perProblem[cell.problem_id] = cell.best_score;
      snapshotByPerson.set(row.person_id, {
        total_score: row.total,
        per_problem: perProblem,
        integrity: { alerts_by_severity: row.integrity.alerts_by_severity, review_verdict: row.integrity.review_verdict },
        unique_id: row.candidate_id, name: row.name, session_status: ""
      });
    }
    await stampSelectionDone(contest, snapshotByPerson, adminActor(req, body));
  }

  // Write the tombstone audit row BEFORE deletion starts (F9 §3.2).
  await writeAudit({ action: "contest_purge_start", contest_slug: contest.slug, include_evidence: includeEvidence }, adminActor(req, body), now);

  // CRASH BARRIER (F9 §3.2): persist the tombstone SCAFFOLD before any
  // destructive delete. This stamps `purged_at`/`db_purged_at` (so a mid-purge
  // crash — timeout/OOM/GCS throttle on a 50k-doc contest — lands on a
  // tombstoned contest that the gate's idempotent re-purge picks up and
  // finishes) and ALWAYS records `evidence_prefixes` up-front (so the later
  // sweep can finish evidence cleanup even if the run dies before sessions are
  // deleted, when the per-session prefixes would no longer be derivable). The
  // counts and the evidence-handled stamp are filled in AFTER the deletes.
  await getFirestore().collection(CONTESTS_COLLECTION).doc(contest.slug).set({
    db_purged_at: now,
    purged_at: now,
    evidence_prefixes: evidencePrefixes,
    updated_at: now
  }, { merge: true });

  // Evidence: if include_evidence, delete the GCS objects NOW via per-session
  // storage_prefix iteration (the only legacy-correct path; exports/ excluded).
  // Otherwise the prefixes already persisted on the scaffold drive the later
  // sweep (D13).
  let evidenceDeleted = 0;
  if (includeEvidence) {
    for (const prefix of evidencePrefixes) {
      evidenceDeleted += await deleteEvidencePrefix(prefix);
    }
  }

  // Delete the heavy Firestore data (idempotent per-doc deletes). Enrollments
  // are KEPT. Persons/colleges are KEPT.
  const counts = {};
  counts.submissions = await deleteDocsByIds(SUBMISSIONS_COLLECTION, datasets.submissions);
  counts.reviews = await deleteDocsByIds(REVIEW_COLLECTION, datasets.reviews);
  counts.review_claims = await deleteDocsByIds(REVIEW_CLAIMS_COLLECTION, datasets.review_claims);
  counts.roster_entries = await deleteDocsByIds(ROSTER_COLLECTION, datasets.roster_entries);
  for (const ds of PURGE_DATASETS) {
    counts[ds.key] = await deleteDocsByIds(ds.collection(), datasets[ds.key]);
  }
  // Roster meta doc (settings collection, keyed roster_meta::{slug}) + the
  // review roster doc (review_state, keyed review_roster::{slug}).
  await getFirestore().collection(SETTINGS_COLLECTION).doc(rosterMetaIdFor(contest.slug)).delete().catch(() => {});
  await reviewRosterRef(contest.slug).delete().catch(() => {});
  // Sessions LAST (so evidence-prefix capture above already happened).
  counts.sessions = await deleteDocsByIds(SESSION_COLLECTION, sessions);

  // TOMBSTONE FINALIZE: record the removed counts and (when evidence was deleted
  // inline) stamp evidence_purged_at + clear the now-consumed prefix list. The
  // scaffold above already stamped db_purged_at/purged_at/evidence_prefixes.
  const tombstone = {
    purge_counts: counts,
    updated_at: new Date().toISOString()
  };
  if (includeEvidence) {
    tombstone.evidence_purged_at = now;
    tombstone.evidence_prefixes = null;
  }
  await getFirestore().collection(CONTESTS_COLLECTION).doc(contest.slug).set(tombstone, { merge: true });

  await writeAudit({
    action: "contest_purge_done",
    contest_slug: contest.slug,
    counts,
    evidence_deleted: includeEvidence ? evidenceDeleted : 0,
    evidence_retained: !includeEvidence
  }, adminActor(req, body), new Date().toISOString());

  return {
    ok: true,
    contest: contest.slug,
    counts,
    evidence_deleted: includeEvidence ? evidenceDeleted : 0,
    evidence_retained: !includeEvidence,
    enrollments_retained: true
  };
}

// Does the export recovery archive still LIVE in GCS? The purge gate proves a
// `last_export_at` stamp exists; this proves the artifact behind it does too
// (the stamp can outlive the zip after the 10-day sweep / day-11 lifecycle
// backstop). Lists the exact object key as a prefix — keys are unique zip names,
// so a non-empty listing == the object exists. A blank key (legacy/garbage
// stamp with no recorded path) is treated as MISSING — fail closed: an
// irreversible purge must never proceed on an unverifiable recovery anchor.
async function exportObjectExists(gcsKey) {
  const key = String(gcsKey || "").trim();
  if (!key) return false;
  try {
    const [files] = await bucket().getFiles({ prefix: key, maxResults: 1 });
    return Array.isArray(files) && files.some((f) => f.name === key);
  } catch (err) {
    // A listing error is NOT proof of existence — fail closed (refuse the purge)
    // so a transient GCS error can never green-light deleting the only backup.
    console.error(`export existence check failed for ${key}: ${err?.message || err}`);
    return false;
  }
}

// Idempotent per-doc deletes for a list of {_id, ...} docs in a collection.
// Bounded concurrency; a missing doc delete is a no-op (resume-safe).
async function deleteDocsByIds(collectionName, docs) {
  const ids = (Array.isArray(docs) ? docs : []).map((d) => d._id).filter(Boolean);
  await mapWithConcurrency(ids, 20, async (id) => {
    await getFirestore().collection(collectionName).doc(id).delete().catch(() => {});
  });
  return ids.length;
}

// Delete every GCS object under one session storage_prefix (evidence/recordings).
// The exports/ subtree can never sit under a session prefix, so it is excluded
// by construction. Returns the count deleted.
async function deleteEvidencePrefix(prefix) {
  if (!prefix || prefix.startsWith("exports/")) return 0;
  let deleted = 0;
  const [files] = await bucket().getFiles({ prefix });
  await mapWithConcurrency(files, 20, async (file) => {
    try { await file.delete(); deleted += 1; } catch { /* resume-safe: retried next sweep */ }
  });
  return deleted;
}

// POST /api/admin/retention-sweep — the daily Cloud Scheduler job (S-H / F9
// §3.4, Decision 14). Authed by the scheduler key (x-api-key) OR the admin
// password (manual "run now"). Closed-by-default: no key configured AND no admin
// password => reject. For each contest whose retention window elapsed it deletes
// the EVIDENCE (keeping results/snapshots) and stamps evidence_purged_at only
// when a final listing returns empty (resume-safe). It ALSO deletes export zips
// older than 10 days (vision §10.4). Reports what it purged.
async function adminRetentionSweep(req) {
  requireSweepAuth(req);
  const body = parseBody(req);
  const now = new Date().toISOString();
  const actor = adminActor(req, body);

  // All real contests (archived included — a purged/archived contest may still
  // hold evidence due for deletion). Cross-contest read is the deliberate sweep.
  const contestsSnap = await getFirestore().collection(CONTESTS_COLLECTION).limit(2000).get();
  const contests = contestsSnap.docs.map((doc) => doc.data());
  const due = selectExpiredEvidence(contests, now);

  const evidencePurged = [];
  for (const contest of due) {
    const result = await sweepContestEvidence(contest, actor);
    evidencePurged.push(result);
  }

  // Export-zip retention (vision §10.4): list every exports/ object, delete the
  // ones older than 10 days. ONE bucket listing under the shared exports/ prefix.
  let exportsDeleted = 0;
  const deletedExportKeys = new Set();
  try {
    const [files] = await bucket().getFiles({ prefix: "exports/" });
    const listed = files.map((file) => ({
      name: file.name,
      created_at: file.metadata?.timeCreated || file.metadata?.updated || "",
      _file: file
    }));
    const expired = selectExpiredExports(listed, now);
    await mapWithConcurrency(expired, 20, async (item) => {
      try { await item._file.delete(); exportsDeleted += 1; deletedExportKeys.add(item.name); } catch { /* retried next sweep */ }
    });
  } catch (err) {
    console.error(`export-zip sweep failed: ${err?.message || err}`);
  }

  // STAMP NEVER OUTLIVES ITS ARTIFACT (data-safety): when we delete the very zip
  // a contest's `last_export` points at, clear that contest's export stamp so the
  // purge gate can't later pass on a recovery anchor that no longer exists. The
  // contests were already read for the evidence sweep above — no extra listing.
  if (deletedExportKeys.size) {
    for (const contest of contests) {
      const key = contest?.last_export?.gcs_key;
      if (key && deletedExportKeys.has(key)) {
        await getFirestore().collection(CONTESTS_COLLECTION).doc(contest.slug).set({
          last_export: null,
          last_export_at: null,
          updated_at: now
        }, { merge: true }).catch(() => {});
      }
    }
  }

  await writeAudit({
    action: "retention_sweep",
    contests_swept: evidencePurged.length,
    exports_deleted: exportsDeleted
  }, actor, now);

  return { ok: true, swept_at: now, evidence_purged: evidencePurged, exports_deleted: exportsDeleted };
}

// Delete one contest's evidence and stamp evidence_purged_at ONLY if the final
// listing is empty (resume-safe; a scheduler retry finishes a timed-out run).
// Uses the tombstone evidence_prefixes list when present (DB already purged), a
// per-session storage_prefix pass otherwise, PLUS the reconstructed
// contests/{slug}/sessions/ prefix as belt-and-braces (D13).
async function sweepContestEvidence(contest, actor) {
  const prefixes = new Set();
  if (Array.isArray(contest.evidence_prefixes)) {
    for (const p of contest.evidence_prefixes) if (p) prefixes.add(p);
  } else {
    // DB not purged yet — derive prefixes from the live sessions.
    const sessions = await readContestDataset(SESSION_COLLECTION, contest);
    for (const s of sessions) { const p = sessionPrefix(s); if (p) prefixes.add(p); }
  }
  // Belt-and-braces reconstructed prefix (catches anything the per-session list
  // missed; legacy slugless paths still rely on the explicit list above).
  prefixes.add(`contests/${contest.slug}/sessions/`);

  let deleted = 0;
  for (const prefix of prefixes) deleted += await deleteEvidencePrefix(prefix);

  // Stamp ONLY when a final listing of the reconstructed prefix is empty.
  const [remaining] = await bucket().getFiles({ prefix: `contests/${contest.slug}/sessions/` });
  const stampable = (remaining || []).length === 0;
  const now = new Date().toISOString();
  const patch = { evidence_prefixes: null, updated_at: now };
  if (stampable) patch.evidence_purged_at = now;
  await getFirestore().collection(CONTESTS_COLLECTION).doc(contest.slug).set(patch, { merge: true });

  await writeAudit({
    action: "evidence_sweep",
    contest_slug: contest.slug,
    objects_deleted: deleted,
    completed: stampable
  }, actor, now);

  return { contest: contest.slug, objects_deleted: deleted, completed: stampable };
}

// Sweep auth: the scheduler key (x-api-key === RETENTION_SWEEP_API_KEY) OR the
// admin password. Closed-by-default — with neither configured nothing passes.
// requireSweepAuth moved to the makeAuth factory in lib/auth.mjs (decomp B0).

// ---- S-J §2.14 People tab (directory + cross-round scorecard) ----------------
//
// adminPeople (GET /api/admin/people) + adminPerson (GET /api/admin/person), the
// cross-round join computePersonScorecard, and the integrity folder
// summarizeScorecardIntegrity moved to the makeAdminPeopleRoutes(ctx) factory in
// routes/adminPeople.mjs (decomp B7); instantiated at module scope above. The
// People tab is the ONE sanctioned cross-contest surface — the directory + the
// per-person enrollment scan use the ALL_CONTESTS sentinel (identity.mjs), while
// the per-contest score/integrity reads the scorecard fans out are EACH
// contest-scoped through scopedQuery on the RESOLVED contest (F9 no-bleed holds).

// Honor-system admin actor for audit + selection_by attribution (the admin
// console may send actor_name; ip/ua are captured automatically).
// adminActor moved to the makeAuth factory in lib/auth.mjs (decomp B0).

// ---- Multi-reviewer recording review (Phase 2) ----------------------------
//
// 10 reviewers concurrently review students' screen recordings and give a
// binary verdict. The system serves each reviewer the NEXT student to review by
// a fixed PRIORITY, never double-serves a student to two reviewers at once, and
// never serves a student to a reviewer who already reviewed them.
//
//   ROSTER   — REVIEW_STATE_COLLECTION/roster, the operator-set list of
//              usernames. Display form + roster order are preserved; entries are
//              de-duped by username_norm.
//   REVIEWS  — REVIEW_COLLECTION, ONE doc per (username, reviewer); id =
//              `<username_norm>::<reviewerKey>` so a reviewer reviews a given
//              username AT MOST once (idempotent upsert). MULTIPLE reviewers
//              review the same username — that is intended.
//   CLAIMS   — REVIEW_CLAIMS_COLLECTION, at most ONE active claim per username;
//              id = username_norm. A claim older than CLAIM_TTL_MS is free.
//              Submitting a verdict deletes (releases) the claim.
//
// The whole review cluster — the six admin routes (review-roster set/get,
// review-next, review-verdict, review-mine, reviews) + every roster/claim/ranking
// helper (reviewRosterRef / reviewRecordId / reviewRecordRef / reviewClaimRef /
// reviewContestSlugOf / inReviewScope / reviewerKeyFor / normalizeRoster /
// getReviewRoster / getAllReviews / indexReviewsByUsername / isClaimActive /
// getActiveClaims / loadClaimsByNorm / rankReviewCandidates / claimReviewUsername)
// — moved VERBATIM to the makeReviewRoutes(ctx) factory in routes/review.mjs
// (decomp B11); destructured at module scope above so the dispatch lines stay
// byte-identical (canaryIsolation). The factory is instantiated BEFORE
// makeResultsRoutes and returns getAllReviews / reviewRecordId / reviewerKeyFor /
// reviewContestSlugOf / getActiveClaims so the still-resident dataLifecycle purge
// gatherer and the Results-tab integrity column reuse the SAME single-source
// implementations by reference.

// ---- Sure-shot proctor alerts (Phase 2, 2.3 / Epic 4) ---------------------
// The proctor ALERTS DOMAIN — the sure-shot event catalog + default settings, the
// settings reader/merger/projectors (getAlertSettings / mergeAlertSettings /
// alertTypeConfig / isAlertShownToInvigilator / anyAlertSharedWithInvigilator),
// the recording-state / capture-state parsers (isRecordingStopped /
// parseRecordingStateSegments / parseCaptureState), the sure-shot raisers
// (raiseSureShotAlertsFromEvents / raiseSwitchAwayAlerts / detailFromEvent /
// upsertProctorAlert / sureShotVideoKey), the alerts doc ref (alertRef), the
// ingest normalizers (normalizeAlert / normalizeVerdict), and the ALERT_* /
// SURE_SHOT_* / capture-source constants — moved VERBATIM to the
// makeProctorAlerts(ctx) factory in src/proctorAlerts.mjs (decomp B9a, the
// linchpin domain extraction that precedes the alerts/enforcement/telemetry route
// splits). Destructured at module scope above so every resident telemetry /
// heartbeat / invigilator-ctx / alert-route call site stays byte-identical
// (canaryIsolation). The cross-domain enforcement helpers sanitizeExemptions +
// intOrZero are passed into the factory by reference (single source).

// The proctor-alert ROUTES — ingestAlerts (poller ingest) + adminAlerts (admin
// feed) + the alerts-only listSessionRooms helper — moved VERBATIM to the
// makeAlertRoutes(ctx) factory in routes/alerts.mjs (decomp B9); destructured at
// module scope above so the dispatch lines stay byte-identical (canaryIsolation).
// They consume the proctorAlerts domain helpers (normalizeAlert / alertRef /
// getAlertSettings / mergeAlertSettings) threaded through the factory ctx.

// isTruthyParam moved to lib/http.mjs (decomp B0); imported at the top.

// ---- Alert archive (admin) -------------------------------------------------
// adminAlertAction (archive/unarchive a batch of alert docs) moved VERBATIM to the
// makeAlertRoutes(ctx) factory in routes/alerts.mjs (decomp B9); destructured at
// module scope above so the dispatch line stays byte-identical (canaryIsolation).

// ---- S3: invigilator portal + room start gate -------------------------------
//
// Room-scoped console (NO signed-QR verification — deferred by design). Auth =
// requireInvigilator. Scope is the contest named by ?contest= (the global
// password falls back to a no-contest staff view across ALL contests). Least
// privilege: these endpoints expose NO emails, NO IP addresses, NO signed media
// URLs.

// invigilatorOverview + the room-gate helpers (gateRoomKey/roomGateRef/
// getRoomGate/generateRoomOtp/publicRoomGate/requireGateEnabledFor) +
// invigilatorReleaseCode/OpenRoom/UnlockCode/Unlock/Exempt moved VERBATIM to
// the makeInvigilatorRoutes(ctx) factory in routes/invigilator.mjs (decomp B1).
// The route handlers are destructured at module scope (see the factory call near
// the top); gateRoomKey + getRoomGate come back too so the session-gate routes
// (routes/sessionGates.mjs) reuse them via ctx.

// The candidate-side session GATE routes — sessionRoomGate (room-gate poll/unlock)
// + sessionEnforcementViolation (the L1 self-report, with ENFORCEMENT_VIOLATION_PHASES)
// + sessionUnlockGate (the L2 code release) — moved VERBATIM to the
// makeSessionGateRoutes(ctx) factory in routes/sessionGates.mjs (decomp B10);
// destructured at module scope above so the dispatch lines stay byte-identical
// (canaryIsolation). They consume the enforcement + proctorAlerts domains and the
// invigilator-owned room-gate helpers (gateRoomKey/getRoomGate) via the factory ctx.

// requireExamStarted (the S3 exec gate enforcement check) moved to the
// makeEnforcement(ctx) factory in src/enforcement.mjs (decomp B10a); destructured
// at module scope above and consumed by the resident exec routes.

// invigilatorRoom moved VERBATIM to the makeInvigilatorRoutes(ctx) factory in
// routes/invigilator.mjs (decomp B1); destructured at module scope so its
// dispatch line stays byte-identical (canaryIsolation).

// ---- Proctor alert settings (admin) ----------------------------------------
// adminGetAlertSettings + adminSaveAlertSettings moved VERBATIM to the
// makeAlertRoutes(ctx) factory in routes/alerts.mjs (decomp B9); destructured at
// module scope above so the dispatch lines stay byte-identical (canaryIsolation).
// They read/write the alert-settings doc via the proctorAlerts domain helpers
// (getAlertSettings / mergeAlertSettings) threaded through the factory ctx.

// resolveSignedReadUrl moved to lib/clients.mjs (decomp B0); imported at the top.

// alertRef moved to the makeProctorAlerts(ctx) factory in src/proctorAlerts.mjs
// (decomp B9a); destructured at module scope above.

// getSession/getSessionOrNull/requireWritableSession/sessionRef + the
// GCS-prefix builders (buildStoragePrefix/sessionPrefix) + candidateOf moved to
// the makeSessionStore factory in lib/sessionStore.mjs (decomp B0); the
// instances are destructured at module scope (see the makeSessionStore(storeCtx)
// call near the top).

// sanitizeRoom moved to lib/sanitize.mjs (decomp B0); imported at the top.

// putJsonl/bucket moved to lib/clients.mjs (decomp B0); imported at the top.

// parseBody/requireFields/requireValidEmail(+EMAIL_FORMAT) moved to lib/http.mjs
// (decomp B0); imported at the top.

// requireAdmin/requireInvigilator/requireInvigilatorFor moved to the makeAuth
// factory in lib/auth.mjs (decomp B0); the instances are destructured at module
// scope (see the makeAuth(authCtx) call near the top).

// invigilatorContestOf / invigilatorContestSlug / requireGateEnabledFor moved
// VERBATIM to the makeInvigilatorRoutes(ctx) factory in routes/invigilator.mjs
// (decomp B1) — they are internal helpers of the invigilator routes.

// requireApiKey moved to the makeAuth factory in lib/auth.mjs (decomp B0).

// safeEqual moved to lib/sanitize.mjs (decomp B0); imported at the top.

// ---- contest-owned enforcement/camera/screen-markers (S-I §1.4 snapshot) ----
// enforcementConfigFor / cameraRecordingConfigFor / screenMarkersConfigFor +
// ENFORCEMENT_EXEMPTION_KEYS / sanitizeExemptions / intOrZero moved to
// src/enforcement.mjs (decomp B10a). The three config readers come back through
// makeEnforcement(ctx) (destructured at module scope above); sanitizeExemptions +
// intOrZero are STANDALONE pure exports imported at the top (the cycle-break with
// proctorAlerts) — single source either way.

// isHttpUrl moved to lib/http.mjs; normalizeUsername/sanitizeSegment/
// sanitizeObject/sanitizeEditorDetail/getClientIp/normalizeIp/hashPasscode/
// maskPasscode moved to lib/sanitize.mjs (decomp B0); imported at the top.

// http transport helpers (badRequest/httpError/httpErrorWith/positiveIntOr/
// setCors/send) moved to lib/http.mjs (decomp B0); imported at the top.
