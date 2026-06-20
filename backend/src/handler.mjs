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
import { makeEvaluationRoutes } from "./routes/evaluation.mjs";
import { makeAdminTemplatesRoutes } from "./routes/adminTemplates.mjs";
import { makeAdminProblemsRoutes } from "./routes/adminProblems.mjs";
import { makeAdminContestsRoutes } from "./routes/adminContests.mjs";
import { makeSubmissionEventsRoutes } from "./routes/submissionEvents.mjs";
import { makeAdminStatsRoutes } from "./routes/adminStats.mjs";
import { makeAdminPeopleRoutes } from "./routes/adminPeople.mjs";
import { makeResultsRoutes } from "./routes/results.mjs";
import { makeReviewRoutes } from "./routes/review.mjs";
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

// Injectable epoch-ms clock for the per-session exec rate limiter (mirrors the
// __setClientsForTest seam) so cooldown tests are deterministic. Production
// always uses the real clock; pass null/undefined to restore it.
let _execClock = () => Date.now();
export function __setExecClockForTest(fn) {
  _execClock = fn || (() => Date.now());
}

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
  // Room-gate helpers the invigilator module owns; the still-resident session
  // routes (sessionRoomGate / sessionUnlockGate) reuse gateRoomKey + getRoomGate.
  gateRoomKey, getRoomGate
} = invigilatorRoutes;

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

// Factory seam (decomp B4): the admin contest-lifecycle route domain. ctx closes
// over THIS instance's live-client getter, the auth guard from makeAuth, the http
// transport helpers, the env-captured contests/submissions collection names, the
// scopedQuery chokepoint, the contests/templates/problems domain fns, the
// contest-problems reader, and the resident endAllLiveSessions sweep (by
// reference — it owns raw-where #2 and stays in handler.mjs until B14). The
// returned route handlers are destructured into the SAME names the dispatch table
// uses, so the dispatch lines stay byte-identical (canaryIsolation). The contest
// helpers it owns (instantiateTemplatePayload / requirePublishedProblems /
// enforceContestProblemsEditRules) move with the routes — currently used only here.
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

const uploadConfig = {
  chunk_seconds: 30,
  video_bits_per_second: 400000,
  media_bits_per_second: 180000,
  audio_bits_per_second: 32000,
  max_width: 960,
  max_frame_rate: 4
};

// F10.1: the chunk-upload surface is EXACTLY two kinds — the screen recording
// and the separate low-res camera stream. Everything else under the session
// prefix (events, manifest, merged video) is written server-side, so an
// unknown kind is rejected outright rather than sanitized into a fresh
// folder (path-traversal hardening on top of sanitizeSegment).
const UPLOAD_CHUNK_KINDS = new Set(["screen", "camera"]);

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

async function startSession(req) {
  const body = parseBody(req);
  // Every start now REQUIRES a resolvable person contest (the candidate app
  // always pins ?contest=). resolvePersonContestForStart 400s an absent param
  // (unknown_contest), 400s an unknown slug, and 403s a not-open contest;
  // startPersonSession owns the window gate + identity resolution.
  const personContest = await resolvePersonContestForStart(body);
  return startPersonSession(req, body, personContest);
}

// ---- candidateOf — THE dual-read identity adapter (F9 §1.2) ----------------
// ONE function used by every DTO/export; never writes. Renders whichever
// identity a doc carries, preferring the new candidate_id, then the roster id
// the candidate verified against, then the legacy HR username. Label falls
// back to the S-A interim "Candidate ID" (F9 §4.3 — the word "username" is
// banned from rendered UI, so the F9 §1.2 literal "Username" fallback is
// deliberately not used).
// candidateOf moved to the makeSessionStore factory in lib/sessionStore.mjs
// (decomp B0); destructured at module scope.

// ---- S-C person-mode start (vision §2.4; F9 D2/D4/D6) ----------------------
//
// The identity chain for identity_mode:"person" contests:
//   candidate types unique_id → server resolves college from the CONTEST
//   roster (picker ONLY on genuine ambiguity) → person_id =
//   "{college_norm}~{identityNorm(unique_id)}" (PERSON_ID_SEPARATOR) →
//   session.username_norm = person_id. Everything keyed on (username_norm,
//   contest_slug) — live locks, alert ids, GCS paths — works unchanged; the
//   norm simply gains its college prefix.

// The person contest a start MUST name. An absent param is unknown_contest
// (the candidate app always pins ?contest=); a present-but-bogus slug is the
// same 400, and a not-open contest is 403 (F9 §2.3.1: mandatory resolution
// kills the shared-empty-slug bleed hazard).
async function resolvePersonContestForStart(body) {
  const contest = await resolveContest(String(body?.contest ?? "").trim()); // 400 unknown_contest / 403 contest_not_open
  if (contest.identity_mode !== "person") throw httpError(400, "unknown_contest");
  return contest;
}

// Gate on the CONTEST window (S5 semantics moved per-contest for person
// contests).
function validateContestWindow(contest) {
  if (!contest?.start_at || !contest?.end_at) {
    throw httpError(403, "Proctoring is not configured yet.");
  }
  const now = Date.now();
  const startAt = Date.parse(contest.start_at);
  const endAt = Date.parse(contest.end_at);
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || startAt >= endAt) {
    throw httpError(403, "Proctoring schedule is invalid.");
  }
  if (now < startAt) throw httpError(403, "Proctoring has not started yet.");
  if (now > endAt) throw httpError(403, "Proctoring has ended.");
}

// Resolve the typed unique id against the contest roster: 0 matches → 403,
// 1 → that person, 2+ colleges → body.college picks or 409 college_choices
// (the candidate-side picker payload). Mapped profile fields are server-
// overridden from the roster.
async function resolvePersonRosterIdentity(meta, body) {
  const typed = String(body.roster_unique_id ?? body.candidate_id ?? body.hackerrank_username ?? "").trim();
  if (!typed) throw httpError(403, "roster_id_required");
  const entries = await findContestRosterEntries(meta, typed);
  if (!entries.length) throw httpError(403, "not_on_roster");
  let entry = entries[0];
  if (entries.length > 1) {
    const college = String(body.college ?? "").trim().toLowerCase();
    entry = college ? entries.find((e) => e.college_norm === college) : undefined;
    if (!entry) {
      const names = new Map((await listColleges()).map((c) => [c.college_norm, c.name]));
      throw httpError(409, "college_choices", {
        college_choices: entries.map((e) => ({
          college_norm: e.college_norm,
          name: names.get(e.college_norm) || e.college,
          college: e.college
        }))
      });
    }
  }
  const mapping = meta.column_mapping || {};
  const fromRoster = (field) => (mapping[field] ? String(entry.fields?.[mapping[field]] || "") : "");
  // A MAPPED field is authoritative even when blank (same rule as the legacy
  // roster path); unmapped fields keep the typed value.
  const mappedOrTyped = (field) => (mapping[field] ? fromRoster(field) : String(body[field] ?? "").trim());
  return {
    person_id: entry.person_id,
    college_norm: entry.college_norm,
    candidate_id: entry.unique_id, // display form — the roster is the source of truth
    username_norm: entry.person_id,
    roster_unique_id: entry.unique_id,
    roster_verified: true,
    name: mappedOrTyped("name"),
    email: mappedOrTyped("email"),
    roll_number: mappedOrTyped("roll_number")
  };
}

async function startPersonSession(req, body, contest) {
  if (body.consent_accepted !== true) {
    return badRequest("Consent is required");
  }
  validateContestWindow(contest);

  const meta = await getContestRosterMeta(contest);
  let identity;
  if (meta) {
    identity = await resolvePersonRosterIdentity(meta, body);
  } else {
    // No-roster person contest (vision §2.4): the candidate types id + name +
    // email (F9 §1.4).
    requireFields(body, ["name", "email"]);
    requireValidEmail(body);
    const typed = String(body.candidate_id ?? body.hackerrank_username ?? "").trim();
    if (!typed) return badRequest("candidate_id is required");

    // F-C (KPR 2026-06-12): roster meta absent but the contest HAS an
    // enrollment spine (roster uploaded then cleared) → EXACT normalized match
    // of the typed id against the enrolled persons' unique ids keys the
    // session to the person anyway (username_norm = person_id), so Results
    // and multi-round linking stay correct. No fuzzy matching. body.college
    // disambiguates a multi-college hit exactly like the roster path's picker.
    const { spine, matches } = await resolveEnrollmentSpineMatches(contest, typed);
    let chosen = matches;
    const collegePick = String(body.college ?? "").trim().toLowerCase();
    if (chosen.length > 1 && collegePick) {
      chosen = chosen.filter((match) => match.college_norm === collegePick);
    }
    if (chosen.length === 1) {
      const match = chosen[0];
      identity = {
        person_id: match.person_id,
        college_norm: match.college_norm,
        candidate_id: String(match.person?.unique_id || typed),
        username_norm: match.person_id,
        roster_unique_id: "",
        roster_verified: false, // no ACTIVE roster was consulted — spine match, not roster match
        name: String(match.person?.name || body.name || "").trim(),
        email: String(match.person?.email || body.email || "").trim(),
        roll_number: String(body.roll_number ?? "").trim(),
        identity_source: "enrollment_spine"
      };
    } else {
      // person_id:null — these sessions never participate in multi-round
      // linking (documented limitation). When a spine EXISTS but the typed id
      // didn't match it (or matched ambiguously), flag the session LOUDLY so
      // the admin Sessions list shows the identity never resolved — being
      // unknowingly wrong is not acceptable (KPR 2026-06-12).
      identity = {
        person_id: null,
        college_norm: "",
        candidate_id: typed,
        username_norm: identityNorm(typed),
        roster_unique_id: "",
        roster_verified: false,
        name: String(body.name ?? "").trim(),
        email: String(body.email ?? "").trim(),
        roll_number: String(body.roll_number ?? "").trim(),
        ...(spine ? { identity_unresolved: true } : {})
      };
    }
  }

  const now = new Date().toISOString();
  const clientIp = getClientIp(req);
  const contestSlug = contest.slug;

  // H1 replay/lock mechanics (F9 D6).
  const existingActive = await findLiveSessionFor(identity.username_norm, contestSlug);
  if (body.session_id) {
    const replay = await getSessionOrNull(body.session_id);
    if (replay && replay.username_norm === identity.username_norm && replay.contest_slug === contestSlug) {
      return startResponse(replay, contest);
    }
  }

  const sessionId = randomUUID();
  const room = body.room !== undefined && body.room !== null ? sanitizeRoom(body.room) : "";
  const slot = await acquireLiveSlot(identity.username_norm, contestSlug, sessionId);
  const status = slot.acquired ? "active" : "pending_approval";
  const blockedBy = slot.acquired
    ? null
    : (slot.ownerSessionId || (existingActive && existingActive.session_id) || null);

  const item = {
    session_id: sessionId,
    candidate_id: identity.candidate_id,        // F9 D2: ONE identity field (display form);
    username_norm: identity.username_norm,      //   hackerrank_username is never written here
    person_id: identity.person_id,              // components stored as fields, never parsed
    college_norm: identity.college_norm,
    identity_label: contest.identity_label || "Candidate ID", // F9 D4: denormalized at start
    name: identity.name,
    roll_number: identity.roll_number,
    email: identity.email,
    roster_unique_id: identity.roster_unique_id,
    roster_verified: identity.roster_verified,
    room,
    contest_slug: contestSlug,
    storage_prefix: buildStoragePrefix(contestSlug, identity.username_norm, sessionId),
    start_ip: clientIp,
    current_ip: clientIp,
    ip_change_count: 0,
    consent_accepted: true,
    status,
    blocked_by_session_id: blockedBy,
    created_at: now,
    updated_at: now,
    event_count: 0,
    clipboard_event_count: 0,
    focus_event_count: 0,
    upload_error_count: 0,
    heartbeat_count: 0,
    chunk_count: 0,
    camera_chunk_count: 0,
    enforcement_exemptions: {},
    // F-C (KPR 2026-06-12): conditional keys only — legacy/no-spine session
    // docs keep their exact key set. identity_unresolved marks an anonymous
    // session on a contest that HAS an enrollment spine (typed id matched
    // nothing); identity_source records a spine-resolved keying for forensics.
    ...(identity.identity_unresolved ? { identity_unresolved: true } : {}),
    ...(identity.identity_source ? { identity_source: identity.identity_source } : {})
  };

  await sessionRef(sessionId).create(item);
  await putJsonl(`${item.storage_prefix}events/session.jsonl`, [{
    type: "session_started",
    timestamp: now,
    detail: { user_agent: req.get?.("user-agent") || req.headers?.["user-agent"] || "", start_ip: clientIp }
  }]);

  return startResponse(item, contest);
}

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

// Resume an existing session by its stored token without re-collecting details.
// Used by a browser reload (Epic 2.1/2.2). 404 when the token is unknown or
// does not belong to the supplied username.
//
// S-C (F9 D8): resume is CONTEST-PINNED when the client names a contest (the
// S-D frontend always will; absence is tolerated for legacy clients + one
// transitional release), and the identity check is DUAL-NORM — the legacy
// normalizeUsername leg keeps old norms resuming, identityNorm covers F9-style
// norms, and the candidate_id leg covers person sessions whose username_norm
// is the college-prefixed person_id.
async function resumeSession(req) {
  const body = parseBody(req);
  requireFields(body, ["session_id"]);
  const session = await getSessionOrNull(body.session_id);
  if (!session) throw httpError(404, "Session not found");
  if (body.contest !== undefined && body.contest !== null && String(body.contest).trim() !== "") {
    if ((session.contest_slug || "") !== String(body.contest).trim()) {
      throw httpError(404, "Session not found");
    }
  }
  const idValue = body.candidate_id ?? body.hackerrank_username;
  if (idValue !== undefined && idValue !== null && String(idValue) !== "") {
    const value = String(idValue);
    const matches =
      session.username_norm === normalizeUsername(value) ||  // legacy leg (today's check)
      session.username_norm === identityNorm(value) ||       // F9 identity leg
      (session.candidate_id !== undefined
        && identityNorm(String(session.candidate_id)) === identityNorm(value)); // person leg
    if (!matches) throw httpError(404, "Session not found");
  }
  const contest = await personContestForSession(session);
  return startResponse(session, contest);
}

// Shared start/resume payload so the browser always gets the same shape whether
// it just started, replayed a token, or resumed after reload. S4: async because
// it resolves the assigned problem's candidate-facing view from the bank.
// S-C: the session's PERSON-MODE contest sources the window/gate fields from
// the contest doc. contest = null (an orphaned/old session doc that no longer
// resolves to a current person contest) degrades to the normalized DEFAULTS.
// S-I §3.4: serves the ORDERED problems[] (the real contest doc the session
// belongs to), the per-problem submissions summary (resume restores chips/
// totals) and the submit budget. `problem` stays as a one-release
// compatibility alias = problems[0] minus `order`.
async function startResponse(session, contest = null) {
  const problemSource = contest || await contestForSession(session);
  const problems = await contestProblemsPublic(problemSource);
  let problemAlias = null;
  if (problems.length) {
    const { order: _order, ...alias } = problems[0];
    problemAlias = alias;
  }
  return {
    session_id: session.session_id,
    status: session.status,
    hackerrank_username: session.hackerrank_username !== undefined ? session.hackerrank_username : (session.candidate_id || ""),
    candidate_id: session.candidate_id || session.roster_unique_id || session.hackerrank_username || "",
    identity_label: session.identity_label || "Candidate ID",
    name: session.name,
    room: session.room || "",
    contest_slug: session.contest_slug || "",
    storage_prefix: session.storage_prefix || buildStoragePrefix(session.contest_slug, session.username_norm, session.session_id),
    blocked_by_session_id: session.blocked_by_session_id || null,
    start_ip: session.start_ip || session.current_ip || "",
    // S3: tells the candidate client whether to hold at the room-code screen.
    room_gate_enabled: Boolean(contest?.room_gate_enabled),
    // F5.3/F5.5: enforcement knobs + this session's exemptions + why a locked
    // session is locked (the candidate unlock-code UI keys off the reason).
    // Person contests serve their OWN snapshot enforcement.
    enforcement: enforcementConfigFor(contest),
    enforcement_exemptions: sanitizeExemptions(session.enforcement_exemptions),
    locked_reason: session.locked_reason || null,
    // S-I: the contest serves its OWN problems[] (problemSource above);
    // `problem` is the one-release alias, problems[] the real payload.
    problem: problemAlias,
    problems,
    submissions_summary: await sessionSubmissionsSummary(session.session_id),
    submit_budget: EXEC_MAX_SUBMISSIONS_PER_SESSION,
    // F1 (e2e finding): chunk-index continuation — the recorder resumes its
    // per-kind chunk count from the server's knowledge so a restarted stint
    // (share-drop recovery, refresh-resume, even a new tab after a crash)
    // never reuses indexes and never overwrites the prior stint's GCS objects.
    // counts = issued upload URLs (always >= the highest index with a
    // surviving object); hwm = exact highest issued index (absent on pre-F1
    // sessions). Read-side additions only — older clients ignore them.
    chunk_count: Number(session.chunk_count) || 0,
    camera_chunk_count: Number(session.camera_chunk_count) || 0,
    screen_chunk_index_hwm: Number(session.screen_chunk_index_hwm) || 0,
    camera_chunk_index_hwm: Number(session.camera_chunk_index_hwm) || 0,
    // F7 (e2e finding): the candidate ELAPSED counter anchors on the session's
    // server-side start, not the recorder stint start, so it survives restarts.
    created_at: session.created_at || "",
    // F10.1: the camera-recording knobs ride the same upload_config object the
    // screen constraints use, so the recorder reads ONE authoritative config.
    // Person contests serve their OWN snapshot camera config.
    upload_config: { ...uploadConfig, camera: cameraRecordingConfigFor(contest) },
    // OMR P1 (design §5.2): the start/resume response is the ONLY candidate
    // carrier for the screen-marker flag, and the key rides ONLY when enabled —
    // flag off (the default) keeps this payload byte-identical to today.
    ...(screenMarkersConfigFor(contest).enabled ? { screen_markers: { enabled: true } } : {}),
    heartbeat_interval_seconds: 15,
    // S5: authoritative exam end time + the server clock at response time, so
    // the client shows a skew-corrected countdown from the very first response.
    // Person contests read their OWN window (S5 semantics moved per-contest).
    end_at: contest?.end_at || "",
    server_now: new Date().toISOString()
  };
}

// The candidate-facing view of a contest's problems (S-I §3.4): the shim's
// ordered entries mapped to the public per-problem view — statement, samples
// (non-secret — /api/exec/run echoes them anyway), limits, EFFECTIVE points,
// plus `order`. NEVER hiddenTests, never the lifecycle status. Unpublished/
// missing entries are skipped (the guard prevents; degrade gracefully).
async function contestProblemsPublic(contestOrSettings) {
  const contestLanguages = Array.isArray(contestOrSettings?.languages) && contestOrSettings.languages.length
    ? contestOrSettings.languages
    : null;
  const problems = [];
  for (const entry of contestProblemEntries(contestOrSettings)) {
    const problem = await getProblem(entry.problem_id);
    if (!problem) continue;
    // §1.1: the contest's language allow-list intersects each problem's own
    // languages at serve time; an empty intersection degrades to the
    // problem's list (never serve a problem with zero languages).
    const ownLanguages = problem.languages || [];
    const intersected = contestLanguages
      ? ownLanguages.filter((language) => contestLanguages.includes(language))
      : ownLanguages;
    const stubs = publicStubsFor(problem);
    problems.push({
      id: problem.id,
      title: problem.title,
      statement: problem.statement,
      // W6: the statement's render format rides ONLY when markdown — plain
      // problems (and every pre-W6 doc) keep today's payload byte-for-byte.
      ...(problem.statement_format === "markdown" ? { statement_format: "markdown" } : {}),
      languages: intersected.length ? intersected : ownLanguages,
      points: effectivePoints(entry, problem),
      cpuTimeLimit: problem.cpuTimeLimit,
      memoryLimit: problem.memoryLimit,
      sampleTests: (problem.sampleTests || []).map((t) => ({ input: t.input, expected: t.expected })),
      // F12.2: per-language starter stubs ride the candidate payload (omitted
      // when the problem has none — back-compat for stub-less problems).
      ...(stubs ? { stubs } : {}),
      order: entry.order
    });
  }
  return problems;
}

// F12.2: project a stored problem's stubs into the candidate-safe map — own
// keys only, allow-listed languages, string values. Returns a fresh object or
// null when there's nothing to serve (legacy/stub-less problems → null, so the
// `stubs` field is omitted and the payload stays byte-identical to today).
function publicStubsFor(problem) {
  const raw = problem?.stubs;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const stubs = {};
  for (const language of Object.keys(LANGUAGE_IDS)) {
    if (Object.hasOwn(raw, language) && typeof raw[language] === "string") {
      stubs[language] = raw[language];
    }
  }
  return Object.keys(stubs).length ? stubs : null;
}

// This session's stored submissions -> per-problem summary (≤50×n docs, fine).
const SESSION_SUBMISSIONS_QUERY_LIMIT = 2000;
async function sessionSubmissionsSummary(sessionId) {
  const snapshot = await getFirestore()
    .collection(SUBMISSIONS_COLLECTION)
    .where("session_id", "==", String(sessionId))
    .limit(SESSION_SUBMISSIONS_QUERY_LIMIT)
    .get();
  return computeSessionSummary(snapshot.docs.map((doc) => doc.data()));
}

// Find the session that currently holds the live slot for (username, contest):
// any non-ended session blocks a new active start. active wins over
// locked/pending for the conflict pointer when more than one exists.
async function findLiveSessionFor(usernameNorm, contestSlug) {
  const snapshot = await getFirestore()
    .collection(SESSION_COLLECTION)
    .where("username_norm", "==", usernameNorm)
    .where("contest_slug", "==", contestSlug || "")
    .limit(50)
    .get();
  const live = snapshot.docs
    .map((doc) => doc.data())
    .filter((doc) => doc.status && doc.status !== "ended");
  if (!live.length) return null;
  return live.find((doc) => doc.status === "active") || live[0];
}

// H1: deterministic id for the per-(username, contest) live-slot lock.
function liveLockId(usernameNorm, contestSlug) {
  return `live:${usernameNorm}:${contestSlug || "_"}`;
}

function liveLockRef(usernameNorm, contestSlug) {
  return getFirestore().collection(LIVE_LOCK_COLLECTION).doc(liveLockId(usernameNorm, contestSlug));
}

// H1 — atomically acquire the live slot for (username_norm, contest_slug).
//
// The slot is owned by a lock doc whose id is deterministic, so two
// near-simultaneous starts contend on the SAME doc. `.create()` is atomic in
// Firestore: exactly one concurrent writer succeeds; the rest get ALREADY_EXISTS
// and become pending_approval. The decision is NEVER derived from the racy
// `existingActive` pre-read.
//
// On a create-collision we read the LOCK DOC (not a session collection query,
// which would race with a concurrent winner whose session doc is not yet
// written) to find the current owner, and consult the owner's session by id:
//   - owner session is genuinely live (not ended)  → real conflict → pending.
//   - owner session does not exist yet              → a concurrent winner is
//                                                     mid-flight → yield, pending.
//   - owner session exists and is already `ended`   → stale lock (crash / the
//                                                     previous taker finished) →
//                                                     take the slot over → active.
//
// Returns { acquired: true } on win, or
// { acquired: false, ownerSessionId } when another live session holds the slot.
async function acquireLiveSlot(usernameNorm, contestSlug, sessionId) {
  const ref = liveLockRef(usernameNorm, contestSlug);
  const now = new Date().toISOString();
  const lockBody = { username_norm: usernameNorm, contest_slug: contestSlug || "", session_id: sessionId, acquired_at: now };

  try {
    await ref.create(lockBody);
    return { acquired: true };
  } catch (error) {
    // Anything other than an already-exists collision is unexpected; rethrow.
    if (!isAlreadyExists(error)) throw error;
  }

  // Lock is held — read it to find the current owner.
  const lockDoc = await ref.get();
  const ownerSessionId = lockDoc.exists ? lockDoc.data()?.session_id : null;

  // No owner recorded (shouldn't happen, but be safe): treat the lock as stale.
  if (!ownerSessionId || ownerSessionId === sessionId) {
    await ref.set(lockBody);
    return { acquired: true };
  }

  // Only an OWNER session that already ended makes the lock stale. A missing
  // owner doc means a concurrent winner hasn't persisted yet — we must yield.
  const owner = await getSessionOrNull(ownerSessionId);
  if (owner && owner.status === "ended") {
    await ref.set(lockBody);
    return { acquired: true };
  }

  return { acquired: false, ownerSessionId };
}

function isAlreadyExists(error) {
  // Firestore signals an existing-doc create collision with gRPC code 6
  // (ALREADY_EXISTS); the fake test Firestore mirrors this. Match on code or
  // message so both real and mocked clients are handled.
  return error?.code === 6 || /ALREADY_EXISTS/i.test(String(error?.message || ""));
}

// H1 — release the live slot when its owning session is no longer live, so a
// later legitimate start for the same (username, contest) can re-acquire it.
// Best-effort: a failure here must never break the end/lock flow, and we only
// clear the lock when it still points at THIS session (avoid stomping a lock a
// newer winner already took over).
async function releaseLiveSlot(session) {
  if (!session?.username_norm) return;
  try {
    const ref = liveLockRef(session.username_norm, session.contest_slug);
    const doc = await ref.get();
    if (doc.exists && doc.data()?.session_id === session.session_id) {
      await ref.delete();
    }
  } catch (error) {
    console.warn(`Failed to release live slot for ${session.session_id}: ${error?.message || error}`);
  }
}

// H1 — make `session` the owner of its (username, contest) live slot. Used when
// an admin action (approve/bypass) promotes a session to live outside the
// normal acquire path. Best-effort; overwrites any prior owner.
async function takeOverLiveSlot(session) {
  if (!session?.username_norm) return;
  try {
    await liveLockRef(session.username_norm, session.contest_slug).set({
      username_norm: session.username_norm,
      contest_slug: session.contest_slug || "",
      session_id: session.session_id,
      acquired_at: new Date().toISOString()
    });
  } catch (error) {
    console.warn(`Failed to take over live slot for ${session.session_id}: ${error?.message || error}`);
  }
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

async function createUploadUrl(req) {
  const body = parseBody(req);
  requireFields(body, ["session_id", "kind", "chunk_index", "content_type"]);
  const fetched = await getSession(body.session_id);
  // D2: an admin-ended session may still flush its in-flight final chunk for a
  // bounded window; everything else goes through the normal status gate.
  const session = inAdminEndGrace(fetched) ? fetched : requireWritableSession(fetched);
  // F10.1: only the two known chunk kinds may mint a signed write URL.
  const kind = String(body.kind || "");
  if (!UPLOAD_CHUNK_KINDS.has(kind)) {
    return badRequest("kind must be screen or camera");
  }
  const chunkIndex = Number(body.chunk_index);
  // Security M1 (2026-06-12 review): cap the index — unsafe-integer values (e.g. 1e21)
  // pass Number.isInteger, break the %05d key convention, and push the hwm past 2^53
  // where hwm+1 === hwm, silently re-enabling the very overwrites the guard prevents.
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > 100000) {
    return badRequest("Invalid chunk_index");
  }

  // F1 (e2e finding): chunk indexes must NEVER be reused within a session — a
  // restarted recorder that re-counts from 1 would OVERWRITE the prior stint's
  // GCS objects at the same keys. The session doc tracks a per-kind index
  // high-water mark; a request at/below it (an old/stale client restarting its
  // count) is bumped to hwm+1 so every stint's chunks survive. The fixed
  // frontend resumes its count monotonically and never trips this guard.
  // Storage layout is unchanged (kind/chunk-{index:05d}.ext) — only which
  // index gets used. hwm fields are absent on pre-F1 sessions (-> 0, no bump).
  const hwmField = kind === "camera" ? "camera_chunk_index_hwm" : "screen_chunk_index_hwm";
  const indexHwm = Number(session[hwmField]) || 0;
  const effectiveIndex = chunkIndex <= indexHwm && indexHwm > 0 ? indexHwm + 1 : chunkIndex;

  const extension = String(body.content_type).includes("webm") ? "webm" : "bin";
  const objectKey = `${sessionPrefix(session)}${kind}/chunk-${String(effectiveIndex).padStart(5, "0")}.${extension}`;
  const [uploadUrl] = await signingBucket()
    .file(objectKey)
    .getSignedUrl({
      version: "v4",
      action: "write",
      expires: Date.now() + URL_EXPIRY_SECONDS * 1000,
      contentType: body.content_type
    });

  await sessionRef(session.session_id).update({
    updated_at: new Date().toISOString(),
    // F1: per-kind hwm advances with every issued URL (uploads are serialized
    // per kind client-side; the two kinds write distinct fields, so this
    // read-modify-write never races itself).
    [hwmField]: Math.max(indexHwm, effectiveIndex),
    // F10.1: chunk_count stays the SCREEN counter — the admin UI's recording-
    // duration math (chunks × 30s) and the recordings picker both read it, so
    // camera chunks must never inflate it. The camera stream counts separately.
    ...(kind === "camera"
      ? { camera_chunk_count: FieldValue.increment(1) }
      : { chunk_count: FieldValue.increment(1) })
  });

  return {
    upload_url: uploadUrl,
    storage_key: objectKey,
    expires_in: URL_EXPIRY_SECONDS
  };
}

async function recordEvents(req) {
  const body = parseBody(req);
  requireFields(body, ["session_id", "events"]);
  const session = requireWritableSession(await getSession(body.session_id));
  if (!Array.isArray(body.events)) return badRequest("events must be an array");

  const cleanedEvents = body.events.slice(0, 100).map((item) => ({
    type: String(item.type || "unknown"),
    timestamp: item.timestamp || new Date().toISOString(),
    visibility_state: item.visibility_state || "",
    detail: sanitizeObject(item.detail || {})
  }));

  const eventKey = `${sessionPrefix(session)}events/events-${Date.now()}-${randomUUID()}.jsonl`;
  await putJsonl(eventKey, cleanedEvents);

  const clipboardCount = cleanedEvents.filter((item) => item.type === "clipboard_activity").length;
  const focusCount = cleanedEvents.filter((item) => ["visibility_change", "window_blur", "window_focus", "page_hide", "before_unload"].includes(item.type)).length;
  const uploadErrorCount = cleanedEvents.filter((item) => item.type.includes("upload_error")).length;

  await sessionRef(session.session_id).update({
    updated_at: new Date().toISOString(),
    last_event_at: new Date().toISOString(),
    event_count: FieldValue.increment(cleanedEvents.length),
    clipboard_event_count: FieldValue.increment(clipboardCount),
    focus_event_count: FieldValue.increment(focusCount),
    upload_error_count: FieldValue.increment(uploadErrorCount)
  });

  // Phase 2 (2.3): surface only the SURE-SHOT signals as proctor alerts so the
  // admin console deep-links to them. Noisy events (focus/blur/visibility/
  // clipboard) are intentionally NOT surfaced. One settings read per request is
  // threaded into the upsert so a disabled type is skipped and a configured
  // severity overrides the default.
  const alertSettings = await getAlertSettings();
  await raiseSureShotAlertsFromEvents(session, cleanedEvents, alertSettings);

  // F5.3 wave-2 fix: server-side fullscreen enforcement — derive the exit
  // counter (and the exit-limit escalation) from the event stream itself, so a
  // client that blocks the enforcement-violation URL still gets locked/alerted.
  await reconcileFullscreenEnforcement(session, cleanedEvents, alertSettings);

  return { ok: true, storage_key: eventKey };
}

// ---- Per-session exec rate limiting (security review + S-I §3.1) ------------
// The metered Judge0 key must not be drainable by a looping/scripted session
// token. In-memory, module-level state — fine for the current SINGLE-INSTANCE
// Cloud Run deploy; with N instances each enforces its own window, so the
// effective limit is up to N× looser. Move to Firestore/Redis if we scale out.
// Entries are only created for sessions that passed the ownership gate (real
// session tokens), and the idle sweep below bounds the Map regardless.
//
// S-I: cooldowns are PER (session, problem) — submitting problem A never
// blocks problem B — and a per-session IN-FLIGHT guard serializes exec calls
// so the per-problem windows can't multiply concurrent engine batches.
// Worst-case engine cost per session ≈ 1 concurrent batch + 1 submit/20s per
// problem (≤20 problems) — bounded.
const EXEC_LIMITER_PRUNE_MS = 60 * 60 * 1000;
const EXEC_IN_FLIGHT_RETRY_SECONDS = 2;
// session_id -> { problems: Map(problem_id -> { lastRunMs, lastSubmitMs, submitCount }),
//                 inFlight, lastSeenMs }
const execLimiter = new Map();

function execLimiterEntry(sessionId) {
  const nowMs = _execClock();
  // Cheap sweep on every call: drop sessions idle for over an hour so the Map
  // never grows unboundedly on a long-lived instance. (The submit cap resets
  // with a pruned entry; contest sessions are far shorter than the 1 h idle
  // horizon, so that is acceptable.)
  for (const [key, entry] of execLimiter) {
    if (nowMs - entry.lastSeenMs > EXEC_LIMITER_PRUNE_MS) execLimiter.delete(key);
  }
  let entry = execLimiter.get(sessionId);
  if (!entry) {
    entry = { problems: new Map(), inFlight: false, lastSeenMs: nowMs };
    execLimiter.set(sessionId, entry);
  }
  entry.lastSeenMs = nowMs;
  return entry;
}

// Read-only view for the CHECK phase: no record is created for an id that may
// still fail validation, so a scripted session can't grow the per-problem map
// with garbage ids between sweeps. Records materialize at STAMP time only.
const EMPTY_PROBLEM_LIMITS = Object.freeze({ lastRunMs: -Infinity, lastSubmitMs: -Infinity, submitCount: 0 });

function problemLimiterView(entry, problemId) {
  return entry.problems.get(problemId) || EMPTY_PROBLEM_LIMITS;
}

function problemLimiterRecord(entry, problemId) {
  let record = entry.problems.get(problemId);
  if (!record) {
    record = { lastRunMs: -Infinity, lastSubmitMs: -Infinity, submitCount: 0 };
    entry.problems.set(problemId, record);
  }
  return record;
}

// 429 carrying the machine-readable retry hint the api() catch block forwards
// into the JSON body (mirrors how every other intentional error is sent).
function rateLimited(retryAfterSeconds) {
  const error = httpError(429, "rate_limited");
  error.retry_after_seconds = retryAfterSeconds;
  return error;
}

// Exec-queue overflow -> intentional 429 (same statusCode mapping as
// httpError/badRequest). "queue_full" is distinguishable from the limiter's
// "rate_limited": the server is busy, the candidate did nothing wrong — the
// retry hint just says "back off briefly and try again".
const QUEUE_FULL_RETRY_SECONDS = 2;
function queueFull() {
  const error = httpError(429, "queue_full");
  error.retry_after_seconds = QUEUE_FULL_RETRY_SECONDS;
  return error;
}

// Engine failure -> intentional 503 (review defect 2). Adapter errors carry
// .status (HTTP failures toward Judge0, including retry exhaustion in the
// queue or the adapter's poll budget); they must never surface as a bare 500.
// "judge_unavailable" mirrors queue_full/rate_limited: machine-readable error
// + retry hint in the standard JSON body. Errors WITHOUT .status are genuine
// programming errors and keep propagating as 500.
const JUDGE_UNAVAILABLE_RETRY_SECONDS = 10;
function judgeUnavailable() {
  const error = httpError(503, "judge_unavailable");
  error.retry_after_seconds = JUDGE_UNAVAILABLE_RETRY_SECONDS;
  return error;
}

// Cooldown CHECKS run right after the ownership gate (always before any judge0
// work); the cooldown timestamps are RECORDED only when a request is accepted
// into the exec queue (validation fully passed), so a validation-rejected
// request (400) never consumes a slot — and a queue-full rejection RESTORES
// the slot (server busy, not the candidate's fault).
//
// S-I §3.1: both checks take problemId — the windows apply per (session,
// problem). The IN-FLIGHT guard (any problem, run or submit) rejects first so
// per-problem windows can't stack concurrent engine batches for one session.
function checkExecRunLimit(sessionId, problemId) {
  const entry = execLimiterEntry(sessionId);
  if (entry.inFlight) throw rateLimited(EXEC_IN_FLIGHT_RETRY_SECONDS);
  const limits = problemLimiterView(entry, problemId);
  const waitMs = EXEC_RUN_COOLDOWN_SECONDS * 1000 - (_execClock() - limits.lastRunMs);
  if (waitMs > 0) throw rateLimited(Math.ceil(waitMs / 1000));
  return entry;
}

function checkExecSubmitLimit(sessionId, problemId) {
  const entry = execLimiterEntry(sessionId);
  if (entry.inFlight) throw rateLimited(EXEC_IN_FLIGHT_RETRY_SECONDS);
  const limits = problemLimiterView(entry, problemId);
  const waitMs = EXEC_SUBMIT_COOLDOWN_SECONDS * 1000 - (_execClock() - limits.lastSubmitMs);
  if (waitMs > 0) throw rateLimited(Math.ceil(waitMs / 1000));
  // Hard per-(session, problem) budget on STORED submissions. Only a
  // successful store increments the count, so invalid problem ids can never
  // grow the map. The budget resets only when the idle sweep prunes the whole
  // entry — report that horizon as the retry hint.
  if (limits.submitCount >= EXEC_MAX_SUBMISSIONS_PER_SESSION) {
    throw rateLimited(Math.ceil(EXEC_LIMITER_PRUNE_MS / 1000));
  }
  return entry;
}

// ---- S-I §3.2: contest membership for exec ----------------------------------
// Scope comes from the SESSION (no client `contest` param). A session bound to
// a REAL contest doc may exec ONLY that contest's problems[], scored with the
// entry's effective points. Every other shape — contest_slug "" or a slug with
// no doc — takes the global path: bank read only, bank/seed points.
async function contestForSession(session) {
  const slug = String(session?.contest_slug || "");
  if (!slug) return null;
  const doc = await getFirestore().collection(CONTESTS_COLLECTION).doc(slug).get();
  return doc.exists ? doc.data() : null;
}

async function resolveExecProblem(session, problemIdRaw) {
  const contest = await contestForSession(session);
  if (contest) {
    const entry = contestProblemEntries(contest).find((item) => item.problem_id === problemIdRaw);
    if (!entry) throw httpError(400, "problem_not_in_contest");
    const problem = await getProblem(entry.problem_id);
    if (!problem) return null; // unpublished mid-exam — guard makes this near-impossible
    // Merged effective-points view: scoreSubmission stays untouched (§1.3).
    return { ...problem, points: effectivePoints(entry, problem) };
  }
  return getProblem(problemIdRaw);
}

// Build the per-test Judge0 batch items for BOTH exec endpoints. Every
// language but SQL runs the candidate's source as-is with the test's input on
// stdin — that path stays byte-identical to the pre-SQL shape (pinned by
// test). For SQL (language 82) the stdin field is DEAD on the engine, so each
// test ships the composed script (format prelude + the test's seed SQL +
// the candidate's query) as source_code with an empty stdin — see
// composeSqlExecSource in problems.mjs (the single source of truth shared
// with authoring tooling).
function buildExecItems(problem, tests, language, source) {
  const languageId = LANGUAGE_IDS[language];
  return tests.map((t) => ({
    languageId,
    source: language === "sql" ? composeSqlExecSource(t.input, source) : source,
    stdin: language === "sql" ? "" : t.input,
    expectedOutput: t.expected,
    cpuTimeLimit: problem.cpuTimeLimit, memoryLimit: problem.memoryLimit
  }));
}

async function execRun(req) {
  const body = parseBody(req);
  const sessionId = String(body.session_id || "");
  // Ownership gate: unknown session → 404; ended/locked/pending → 409/403.
  const session = requireWritableSession(await getSession(sessionId));
  await requireExamStarted(session); // S3 room gate
  // Rate-limit check BEFORE any judge0 work (metered key — see the limiter).
  const limiter = checkExecRunLimit(sessionId, String(body.problem_id || ""));
  // S-I §3.2: contest-membership-aware problem resolution (legacy = bank read).
  const problem = await resolveExecProblem(session, String(body.problem_id || ""));
  if (!problem) return badRequest("unknown problem_id");
  // Own-key check first: a prototype key like "constructor" must not pass the
  // truthiness test and reach the executor (security review).
  const language = String(body.language || "");
  if (!Object.hasOwn(LANGUAGE_IDS, language)) return badRequest("unsupported language");
  const languageId = LANGUAGE_IDS[language];
  if (!languageId) return badRequest("unsupported language");
  const source = String(body.source_code || "");
  if (source.length > MAX_SOURCE_CODE_LENGTH) return badRequest(`source_code too large (max ${MAX_SOURCE_CODE_LENGTH} chars)`);
  const items = buildExecItems(problem, problem.sampleTests, language, source);
  // Start the cooldown at ENQUEUE time, once validation has fully passed — a
  // validation-rejected request never consumes the slot, and consuming it on
  // queue ACCEPTANCE (not dispatch) stops a session from stacking queued runs
  // while one is parked in the lane. The in-flight flag is taken at the same
  // point and cleared in finally (S-I §3.1 serialization guard).
  const record = problemLimiterRecord(limiter, problem.id);
  const prevLastRunMs = record.lastRunMs;
  const runStampMs = _execClock();
  record.lastRunMs = runStampMs;
  limiter.inFlight = true;
  let results;
  try {
    // The exec-queue lanes gate the engine phases (design §11 item 2): the
    // run lane bounds (and retries) the submit POSTs, the poll lane bounds
    // each status GET — no slot is parked across the inter-poll waits.
    results = await judge0().runBatch(items, {
      submitGate: (fn) => execQueue.enqueueRun(fn),
      pollGate: (fn) => execQueue.enqueuePoll(fn)
    });
  } catch (error) {
    // ANY failure here is the SERVER's side, never the candidate's: give the
    // cooldown slot back before mapping the error — but ONLY if the limiter
    // still holds the stamp THIS request wrote. A slow failing request must
    // never clobber a newer stamp another request legitimately recorded.
    if (record.lastRunMs === runStampMs) record.lastRunMs = prevLastRunMs;
    if (error?.name === "QueueFullError") throw queueFull();
    if (typeof error?.status === "number") throw judgeUnavailable();
    throw error; // genuine programming error -> bare 500
  } finally {
    limiter.inFlight = false;
  }
  // P3 SIGNAL — persist a RUN event (server-authoritative; a client can't fake
  // the verdict). Mirrors execSubmit's derivation + denormalized-identity store
  // EXACTLY, and its resilient posture: a store failure must NEVER fail the run
  // (the candidate already has their sample results). The run RESPONSE is
  // unchanged — this is a side-channel write placed BEFORE the return.
  const passedCount = results.filter((r) => r.passed).length;
  const verdict = passedCount === results.length
    ? "accepted"
    : (results.some((r) => r.status === "judging_timeout") ? "error" : "wrong_answer");
  // SAMPLE-test per-result detail (no inputs/expected — parallel to submit).
  const tests = results.map((r, i) => ({ index: i, passed: r.passed, status: r.status, timeSec: r.timeSec }));
  try {
    await getFirestore().collection(RUN_EVENTS_COLLECTION).doc(randomUUID()).set({
      // M7: store the VALIDATED language variable (checked against LANGUAGE_IDS),
      // never the raw client body.language.
      session_id: sessionId, problem_id: problem.id, language,
      // Denormalized identity on every NEW doc (same as SUBMISSIONS_COLLECTION).
      contest_slug: session.contest_slug || "",
      username_norm: session.username_norm || "",
      candidate_id: candidateOf(session).id,
      person_id: session.person_id ?? null,
      // The code AT RUN TIME — the P3 progression/debugging-trajectory signal.
      source_code: source,
      kind: "run", // discriminator vs submit
      passed_count: passedCount, total: results.length, verdict,
      tests, // [{index, passed, status, timeSec}] over the SAMPLE tests
      created_at: new Date().toISOString()
    });
  } catch (error) {
    // Await-with-catch (not fire-and-forget) so a cold-start teardown doesn't
    // lose the write, but a store failure is swallowed — the run NEVER fails.
    console.error(`Failed to store run event for session ${sessionId}: ${error?.message || error}`);
  }
  // echo sample input/expected for display (samples are NOT secret)
  return { results: results.map((r, i) => ({ ...r, input: problem.sampleTests[i].input, expected: problem.sampleTests[i].expected })) };
}

async function execSubmit(req) {
  const body = parseBody(req);
  const sessionId = String(body.session_id || "");
  // Ownership gate (same as /api/events): unknown → 404; ended/locked/pending → 409/403.
  const session = requireWritableSession(await getSession(sessionId));
  await requireExamStarted(session); // S3 room gate
  // Rate-limit check BEFORE any judge0 work (metered key — see the limiter).
  // The cap is keyed on the raw problem_id string; only stored submissions
  // increment it, so invalid ids can never grow the per-session count map.
  const limiter = checkExecSubmitLimit(sessionId, String(body.problem_id || ""));
  // S-I §3.2: contest-membership-aware problem resolution (legacy = bank read).
  const problem = await resolveExecProblem(session, String(body.problem_id || ""));
  if (!problem) return badRequest("unknown problem_id");
  // Own-key check first: a prototype key like "constructor" must not pass the
  // truthiness test and reach the executor (security review).
  const language = String(body.language || "");
  if (!Object.hasOwn(LANGUAGE_IDS, language)) return badRequest("unsupported language");
  const languageId = LANGUAGE_IDS[language];
  if (!languageId) return badRequest("unsupported language");
  const source = String(body.source_code || "");
  if (source.length > MAX_SOURCE_CODE_LENGTH) return badRequest(`source_code too large (max ${MAX_SOURCE_CODE_LENGTH} chars)`);

  const items = buildExecItems(problem, problem.hiddenTests, language, source);
  // Start the cooldown at ENQUEUE time, once validation has fully passed — a
  // validation-rejected request never consumes the slot, and consuming it on
  // queue ACCEPTANCE (not dispatch) stops a session from stacking queued
  // submits while one is parked in the lane. The in-flight flag is taken at
  // the same point and cleared in finally (S-I §3.1 serialization guard).
  const record = problemLimiterRecord(limiter, problem.id);
  const prevLastSubmitMs = record.lastSubmitMs;
  const submitStampMs = _execClock();
  record.lastSubmitMs = submitStampMs;
  limiter.inFlight = true;
  let results;
  try {
    // The submit lane (its own lane, so a submit storm never starves the
    // quick sample-run lane) gates the submit POSTs; the shared poll lane
    // bounds each status GET — no slot is parked across inter-poll waits.
    results = await judge0().runBatch(items, {
      submitGate: (fn) => execQueue.enqueueSubmit(fn),
      pollGate: (fn) => execQueue.enqueuePoll(fn)
    });
  } catch (error) {
    // ANY failure here is the SERVER's side, never the candidate's: give the
    // cooldown slot back before mapping the error — but ONLY if the limiter
    // still holds the stamp THIS request wrote. A slow failing request must
    // never clobber a newer stamp another request legitimately recorded.
    if (record.lastSubmitMs === submitStampMs) record.lastSubmitMs = prevLastSubmitMs;
    if (error?.name === "QueueFullError") throw queueFull();
    if (typeof error?.status === "number") throw judgeUnavailable();
    throw error; // genuine programming error -> bare 500
  } finally {
    limiter.inFlight = false;
  }
  const passedCount = results.filter((r) => r.passed).length;
  // Verdict rule: a judging_timeout is an INFRA failure (poll budget exhausted),
  // not the candidate's fault — it must never collapse into "wrong_answer".
  //   all passed            → accepted
  //   any judging_timeout   → error
  //   otherwise             → wrong_answer
  const verdict = passedCount === results.length
    ? "accepted"
    : (results.some((r) => r.status === "judging_timeout") ? "error" : "wrong_answer");

  // S4: submit-time scoring from the problem's points + scoring mode. Derived
  // from counts only, so returning it leaks nothing about hidden tests.
  const score = scoreSubmission(problem, passedCount, results.length);
  const maxPoints = problem.points ?? 100;

  // Per-test results WITHOUT hidden inputs/expected (don't leak the test cases).
  // STORED only — never returned to the candidate (§9 lock below).
  const tests = results.map((r, i) => ({ index: i, passed: r.passed, status: r.status, timeSec: r.timeSec }));

  // Store the submission (low volume -> Firestore). handler.mjs uses inline
  // new Date().toISOString() for timestamps everywhere — match that (no helper).
  // Doc id is a randomUUID — NOT composed from the client-supplied session_id
  // (injection-shaped); session_id/problem_id/created_at stay as FIELDS.
  const createdAt = new Date().toISOString();
  const submissionId = randomUUID();
  try {
    await getFirestore().collection(SUBMISSIONS_COLLECTION).doc(submissionId).set({
      // M7: store the VALIDATED language variable (already checked against
      // LANGUAGE_IDS), never the raw client body.language — a body shaped to
      // coerce to a valid key (e.g. ["python"]) must not land verbatim.
      session_id: sessionId, problem_id: problem.id, language,
      // S-C (F9 D7 + vision §2.11): denormalized identity on every NEW doc at
      // submit time — export/purge/results select by contest_slug directly;
      // OLD docs keep resolving via the session_id join. Doubles as the S-I
      // §3.3 write-time denorm so the scoreboard rollup needs NO joins.
      contest_slug: session.contest_slug || "",
      username_norm: session.username_norm || "",
      candidate_id: candidateOf(session).id,
      person_id: session.person_id ?? null,
      source_code: source, verdict, passed_count: passedCount, total: results.length,
      // max_points is the EFFECTIVE points (contest entry override applied) —
      // the rollup needs no contest join.
      tests, score, max_points: maxPoints, scoring: problem.scoring || "per_test",
      created_at: createdAt
    });
  } catch (error) {
    // The engine run already happened (and was BILLED) — a store failure must
    // not discard the verdict with a 500. Surface it flagged as un-stored (no
    // submission_id), keep the cooldown consumed (the run was real), and do
    // NOT charge the stored-submissions budget (nothing was stored).
    console.error(`Failed to store submission ${submissionId} for session ${sessionId}: ${error?.message || error}`);
    return { verdict, passed_count: passedCount, total: results.length, stored: false };
  }

  // Count the STORED submission against the per-(session, problem) budget
  // (problem.id === the validated problem_id string the cap was checked with).
  record.submitCount += 1;

  // §9 lock: candidates see ONLY pass/fail counts on hidden tests. The stored
  // doc keeps the per-test detail for admin-side analysis; the response doesn't.
  return { verdict, passed_count: passedCount, total: results.length, score, max_points: maxPoints, submission_id: submissionId };
}

async function ingestEditorEvents(req) {
  const body = parseBody(req);
  const sessionId = String(body.session_id || "");
  // Ownership gate (same as /api/events): unknown → 404; ended/locked/pending → 409/403.
  const session = requireWritableSession(await getSession(sessionId));
  const events = Array.isArray(body.events) ? body.events : null;
  if (!events) return badRequest("events[] required");
  if (events.length > EDITOR_EVENTS_INGEST_LIMIT) return badRequest(`max ${EDITOR_EVENTS_INGEST_LIMIT} events per batch`);
  // Security hardening: NEVER spread raw client objects into storage. Build a
  // NEW allow-listed record per event — capped type/timestamp + sanitizeObject'd
  // detail (mirrors recordEvents) — so unexpected keys are dropped by
  // construction and oversized strings are truncated.
  // problem_id is coerced to a bounded string (or null) — never stored verbatim,
  // so an object/array from the client can't land in storage.
  const problemId = String(body.problem_id || "").slice(0, 64) || null;
  const stamped = events.map((e) => ({
    type: String(e.type || "").slice(0, 64),
    timestamp: String(e.timestamp || "").slice(0, 40),
    detail: sanitizeEditorDetail(e.detail),
    session_id: sessionId,
    problem_id: problemId
  }));

  // Per-batch timestamped object under the session prefix (avoids read-modify-
  // write races; the analytics slice concatenates them). Build the key with the
  // existing sessionPrefix() + the same inline ISO-timestamp + randomUUID()
  // pattern recordEvents uses — randomUUID is already imported at the top.
  const key = `${sessionPrefix(session)}${EDITOR_EVENTS_COLLECTION}/${new Date().toISOString()}-${randomUUID()}.ndjson`;
  await putJsonl(key, stamped); // putJsonl already serializes records -> NDJSON via bucket().file(key).save(...)

  return { ok: true, stored: events.length };
}

async function recordReviewFile(req) {
  const body = parseBody(req);
  requireFields(body, ["session_id", "nature", "records"]);
  const session = requireWritableSession(await getSession(body.session_id));
  if (!["clipboard", "tabs", "cookies"].includes(body.nature)) return badRequest("nature must be clipboard, tabs, or cookies");
  if (!Array.isArray(body.records)) return badRequest("records must be an array");

  const now = new Date().toISOString();
  const records = body.records.slice(0, 50).map((record) => sanitizeObject({
    ...record,
    server_received_at: now
  }));
  const key = `${sessionPrefix(session)}review/${body.nature}.jsonl`;
  await putJsonl(key, records);

  await sessionRef(session.session_id).update({
    updated_at: now,
    last_review_file_at: now,
    review_file_count: FieldValue.increment(1)
  });

  return { ok: true, storage_key: key };
}

async function recordHeartbeat(req) {
  const body = parseBody(req);
  requireFields(body, ["session_id", "recording_state", "visibility_state"]);
  const session = requireWritableSession(await getSession(body.session_id));
  const now = new Date().toISOString();
  const currentIp = getClientIp(req);
  const startIp = session.start_ip || currentIp;
  const ipChanged = Boolean(startIp && currentIp && currentIp !== startIp);
  const previousIp = session.current_ip || startIp;
  const newlyChanged = ipChanged && previousIp !== currentIp;

  await sessionRef(session.session_id).update({
    updated_at: now,
    last_heartbeat_at: now,
    recording_state: String(body.recording_state),
    visibility_state: String(body.visibility_state),
    start_ip: startIp,
    current_ip: currentIp,
    last_ip_change_at: newlyChanged ? now : session.last_ip_change_at || null,
    upload_queue_depth: Number(body.upload_queue_depth || 0),
    // Tier-1 chunk buffer: pending-upload depth + bytes persisted for post-exam
    // telemetry (no admin UI yet; Tier-2 renders the per-candidate indicator).
    // Defensive Number() — absent on older clients reads as 0.
    buffer_pending_chunks: Number(body.buffer_pending_chunks || 0),
    buffer_pending_bytes: Number(body.buffer_pending_bytes || 0),
    network_online: Boolean(body.network_online),
    last_seen_at: now,
    heartbeat_count: FieldValue.increment(1),
    ip_change_count: FieldValue.increment(newlyChanged ? 1 : 0)
  });

  // One settings read per request; thread it into both sure-shot upsert sites so
  // a disabled type is skipped and a configured severity overrides the default.
  const alertSettings = await getAlertSettings();

  if (newlyChanged) {
    await putJsonl(`${sessionPrefix(session)}events/ip-change-${Date.now()}-${randomUUID()}.jsonl`, [{
      type: "ip_address_changed",
      timestamp: now,
      detail: {
        hackerrank_username: session.hackerrank_username,
        start_ip: startIp,
        previous_ip: previousIp,
        current_ip: currentIp
      }
    }]);
    // Phase 2 (2.3): server-derived sure-shot — IP changed mid-session.
    const ipConfig = alertTypeConfig(alertSettings, "ip_changed", "warning");
    if (ipConfig.enabled) {
      await upsertProctorAlert(session, {
        type: "ip_changed",
        severity: ipConfig.severity,
        timestamp: now,
        title: "IP address changed",
        detail: `IP changed from ${previousIp} to ${currentIp}`,
        dedupe: currentIp,
        data: { start_ip: startIp, previous_ip: previousIp, current_ip: currentIp }
      });
    }
  }

  // Phase 2 (2.3): a heartbeat reporting the recorder is no longer recording is
  // a sure-shot critical. Deduped per-day so a sustained-stopped state collapses
  // to one alert per session rather than one per heartbeat.
  if (isRecordingStopped(body.recording_state)) {
    const recConfig = alertTypeConfig(alertSettings, "recording_stopped", "critical");
    if (recConfig.enabled) {
      await upsertProctorAlert(session, {
        type: "recording_stopped",
        severity: recConfig.severity,
        timestamp: now,
        title: "Recording stopped",
        detail: `recording_state=${String(body.recording_state)}`,
        dedupe: now.slice(0, 10),
        data: { recording_state: String(body.recording_state) }
      });
    }
  }

  // B1: surface the session lifecycle status so the recorder can self-stop if a
  // proctor locked/ended the session (requireWritableSession already 403/409s a
  // non-active session, but an active heartbeat returns the live status too).
  // S5: ALSO surface the current exam end time + server clock. The heartbeat is
  // the student's only live channel (15 s interval), so an admin's end-time
  // change reaches every student within one interval — no reload.
  // Person-contest sessions source end_at AND enforcement from THEIR contest
  // doc (S-I snapshot fields), matching startResponse; an orphaned session doc
  // (no current person contest) degrades to the normalized defaults.
  const contest = await personContestForSession(session);
  const enforcement = enforcementConfigFor(contest);

  // F5.3 wave-2 fix: the heartbeat closes the server-side fullscreen countdown
  // (events set fullscreen_out_since; the heartbeat's `fullscreen` field is
  // corrective truth). A lock applied HERE is reported on this very response so
  // the recorder self-stops within the same interval.
  const reconciledStatus = await reconcileEnforcementCountdown(session, body, enforcement, alertSettings);
  return {
    ok: true,
    status: reconciledStatus || session.status || "active",
    start_ip: startIp,
    current_ip: currentIp,
    ip_changed: ipChanged,
    newly_changed: newlyChanged,
    end_at: contest?.end_at || "",
    // F5.3/F5.5: the heartbeat is the live channel for enforcement config AND
    // per-session exemptions, so an admin/invigilator exemption (or a settings
    // change) reaches the candidate within one interval — no reload.
    enforcement,
    enforcement_exemptions: sanitizeExemptions(session.enforcement_exemptions),
    server_now: now
  };
}

// Liveness beacon (Phase 2). Designed for navigator.sendBeacon(), which fires on
// page hide/unload and may deliver the body as text/plain rather than JSON, with
// NO custom headers — so this endpoint is gated ONLY by session_id ownership
// (the unguessable session token), never by admin auth. It accepts either a JSON
// object body or a raw text/plain JSON string.
//
//   kind:'hidden'  → the proctor tab was hidden (visibilitychange)
//   kind:'closing' → the page is unloading (pagehide/beforeunload)
//   kind:'visible' → the tab returned to the foreground
//
// On 'hidden'/'closing' we stamp last_seen_at and (if the tab_hidden alert type
// is enabled in settings) upsert a warning tab_hidden proctor alert carrying
// video_key/room/session_id, using the same idempotent id convention. 'visible'
// only refreshes last_seen_at. The beacon NEVER goes through
// requireWritableSession: a locked/ended/pending session can still emit liveness
// without being rejected (sendBeacon ignores the response anyway).
async function recordBeacon(req) {
  const body = parseBeaconBody(req);
  requireFields(body, ["session_id"]);
  const kind = String(body.kind || "hidden").toLowerCase();
  if (!["hidden", "visible", "closing"].includes(kind)) {
    return badRequest("kind must be hidden, visible, or closing");
  }

  // Ownership gate: an unknown session_id is a 404 (no admin auth involved). The
  // session token is the only credential, matching sendBeacon's constraints.
  const session = await getSession(body.session_id);
  const now = new Date().toISOString();

  await sessionRef(session.session_id).update({
    updated_at: now,
    last_seen_at: now,
    last_beacon_kind: kind
  });

  // Only the away signals (hidden/closing) raise an alert; visible is liveness
  // only. Respect the tab_hidden enable toggle and configured severity.
  if (kind === "hidden" || kind === "closing") {
    const settings = await getAlertSettings();
    const config = alertTypeConfig(settings, "tab_hidden", "warning");
    if (config.enabled) {
      await upsertProctorAlert(session, {
        type: "tab_hidden",
        severity: config.severity,
        timestamp: now,
        title: "Proctor tab hidden",
        detail: `Proctor tab ${kind === "closing" ? "closing/unloading" : "hidden"}`,
        // Per-day dedupe so a flurry of hide/show events collapses to one alert
        // per session per day, matching the other sure-shots.
        dedupe: now.slice(0, 10),
        data: { kind }
      });
    }
  }

  return { ok: true, kind, last_seen_at: now };
}

// sendBeacon may deliver a text/plain string body; parse it leniently as JSON.
// A non-string body (some runtimes parse JSON for us) is returned as-is. A blank
// body becomes {} so requireFields surfaces the missing session_id cleanly.
function parseBeaconBody(req) {
  const raw = req.body;
  if (raw === undefined || raw === null || raw === "") return {};
  if (typeof raw !== "string") return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw httpError(400, "invalid_json");
  }
}

async function validateEndSession(req) {
  // Phase 2 (0.1): the exit passcode is gone. Ending only requires the integrity
  // assurance checkbox. `end_proctor_code`/`end_code` are no longer required.
  const body = parseBody(req);
  requireFields(body, ["session_id"]);
  if (body.assurance_accepted !== true) return badRequest("Integrity assurance is required before ending the test.");
  requireWritableSession(await getSession(body.session_id));
  return { ok: true };
}

async function endSession(req) {
  const body = parseBody(req);
  requireFields(body, ["session_id"]);
  if (body.assurance_accepted !== true) return badRequest("Integrity assurance is required before ending the test.");
  // H3: a locked or pending session cannot be self-ended by the client; only an
  // already-ended session is rejected (idempotency handled below via 409). An
  // active session ends normally (the happy path). D2 exception: for a bounded
  // window after an ADMIN end the client's own end still lands so the manifest
  // isn't lost — accepted WITHOUT touching status/ended_at/ended_reason (the
  // admin's end stays authoritative; nothing reopens).
  const fetched = await getSession(body.session_id);
  const adminEndGrace = inAdminEndGrace(fetched);
  const session = adminEndGrace ? fetched : requireWritableSession(fetched);
  const manifest = Array.isArray(body.manifest) ? body.manifest : [];
  const now = new Date().toISOString();
  const manifestKey = `${sessionPrefix(session)}manifest.json`;

  await bucket().file(manifestKey).save(JSON.stringify({ session_id: session.session_id, ended_at: now, manifest }, null, 2), {
    contentType: "application/json"
  });

  await sessionRef(session.session_id).update({
    updated_at: now,
    manifest_key: manifestKey,
    uploaded_manifest_count: manifest.length,
    // Grace path: the session is ALREADY ended by the admin — keep that
    // ended_at/status; only the manifest bookkeeping above is new.
    ...(adminEndGrace ? {} : { ended_at: now, status: "ended" })
  });

  // H1: the session is over — free its live slot so a later legitimate start for
  // the same (username, contest) can re-acquire it instead of being parked.
  await releaseLiveSlot(session);

  return { ok: true, manifest_key: manifestKey };
}

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

function rosterMetaRef() {
  return getFirestore().collection(SETTINGS_COLLECTION).doc(ROSTER_META_ID);
}

// The ACTIVE roster meta, or null when no roster is configured (never uploaded,
// or cleared). Callers treat null as "roster gate off".
async function getRosterMeta() {
  const doc = await rosterMetaRef().get();
  const meta = doc.exists ? doc.data() : null;
  return meta && meta.configured ? meta : null;
}

// Firestore doc id for a roster entry: roster VERSION + doc-id-safe form of the
// normalized unique id (no "/", never empty or all-dots). The version prefix
// means a re-upload writes onto FRESH doc ids, so ACTIVE-version entries stay
// resolvable for the whole write window and only become invisible when the meta
// flips. Old-version docs are left behind (storage grows by one roster per
// upload; cleanup deliberately deferred). Distinct ids that sanitize to the
// same doc id are detected at upload time (the upload sees every row) and
// reported as duplicate skips; lookup-side collisions are rejected by the exact
// unique_id_norm check in findRosterEntry.
function rosterEntryId(version, uniqueIdNorm) {
  const cleaned = String(uniqueIdNorm).replace(/[^a-z0-9@._-]/g, "_").slice(0, 200);
  const safe = cleaned === "" || /^\.+$/.test(cleaned) ? "_" : cleaned;
  return `v${version}:${safe}`;
}

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

// POST /api/admin/roster — replace the active roster ({clear:true} disables it).
// The client parses the CSV; this endpoint receives structured rows. Entries are
// written first (bounded concurrency), the meta doc LAST, so a crashed upload
// never activates a half-written version.
async function adminSaveRoster(req) {
  requireAdmin(req);
  const body = parseBody(req);
  // S-C: an upload that names a contest goes down the PERSON-layer pipeline
  // (compulsory college column, canonicalization gate, dup hard-reject, person
  // upsert, enrollment minting — identity.mjs). Only real identity_mode:
  // "person" contests qualify; any other scope (absent contest param, or a
  // non-person contest) keeps the global-roster path below BIT-FOR-BIT.
  const personContest = await resolvePersonContestParam(body.contest);
  if (personContest) {
    return saveContestRoster(personContest, body, {
      ip: getClientIp(req),
      userAgent: req.get?.("user-agent") || req.headers?.["user-agent"] || ""
    });
  }
  if (body.clear === true) {
    // M5: a clear must PURGE the roster PII, not merely flip the meta flag.
    // Delete the CURRENT version's entry docs (each holds name/email/roll/etc.).
    // We delete only the active version's docs: orphaned docs from PRIOR
    // re-uploads (the versioned-replace design never mass-deletes them) are left
    // behind and grow storage by one roster per upload — cleanup of those
    // version-orphans is deliberately deferred (matches rosterEntryId's note).
    const currentMeta = await getRosterMeta();
    if (currentMeta?.version) {
      const snapshot = await getFirestore().collection(ROSTER_COLLECTION)
        .where("roster_version", "==", currentMeta.version)
        .limit(ROSTER_LIMIT)
        .get();
      const ids = snapshot.docs.map((doc) => doc.data()).map((entry) => rosterEntryId(currentMeta.version, entry.unique_id_norm));
      await mapWithConcurrency(ids, 20, async (entryId) => {
        await getFirestore().collection(ROSTER_COLLECTION).doc(entryId).delete();
      });
    }
    await rosterMetaRef().set({ configured: false, cleared_at: new Date().toISOString() });
    return { ok: true, configured: false, count: 0, skipped: [] };
  }
  requireFields(body, ["unique_id_column", "columns", "rows"]);
  const columns = Array.isArray(body.columns)
    ? body.columns.map((c) => String(c).trim().slice(0, ROSTER_CELL_MAX)).filter(Boolean)
    : [];
  if (!columns.length) return badRequest("columns must be a non-empty array");
  if (columns.length > ROSTER_COLUMNS_LIMIT) return badRequest(`max ${ROSTER_COLUMNS_LIMIT} columns`);
  const uniqueIdColumn = String(body.unique_id_column).trim();
  if (!columns.includes(uniqueIdColumn)) return badRequest("unique_id_column must be one of columns");
  const rows = Array.isArray(body.rows) ? body.rows : null;
  if (!rows || !rows.length) return badRequest("rows must be a non-empty array");
  if (rows.length > ROSTER_LIMIT) return badRequest(`max ${ROSTER_LIMIT} roster rows`);

  // Only known identity fields may be mapped, and only onto known columns.
  const mapping = {};
  for (const [field, column] of Object.entries(body.column_mapping || {})) {
    if (!ROSTER_MAPPABLE_FIELDS.includes(field)) continue;
    const col = String(column || "").trim();
    if (col && columns.includes(col)) mapping[field] = col;
  }

  const version = randomUUID();
  const now = new Date().toISOString();
  const seen = new Set();
  const entries = [];
  const skipped = [];
  rows.forEach((row, index) => {
    const fields = {};
    for (const column of columns) {
      fields[column] = String(row?.[column] ?? "").trim().slice(0, ROSTER_CELL_MAX);
    }
    const uniqueId = fields[uniqueIdColumn];
    if (!uniqueId) {
      skipped.push({ row: index, reason: "empty_unique_id" });
      return;
    }
    const entryId = rosterEntryId(version, normalizeUniqueId(uniqueId));
    if (seen.has(entryId)) {
      skipped.push({ row: index, reason: "duplicate_unique_id" });
      return;
    }
    seen.add(entryId);
    entries.push({
      entryId,
      item: {
        unique_id: uniqueId,
        unique_id_norm: normalizeUniqueId(uniqueId),
        roster_version: version,
        fields,
        created_at: now
      }
    });
  });
  if (!entries.length) return badRequest("no valid roster rows (every row was skipped)");

  await mapWithConcurrency(entries, 20, async ({ entryId, item }) => {
    await getFirestore().collection(ROSTER_COLLECTION).doc(entryId).set(item);
  });
  await rosterMetaRef().set({
    configured: true,
    version,
    unique_id_column: uniqueIdColumn,
    column_mapping: mapping,
    columns,
    count: entries.length,
    updated_at: now
  });
  return { ok: true, configured: true, count: entries.length, skipped };
}

// Resolve an OPTIONAL contest param to a real person-mode contest doc, or
// null when the param is absent (the global roster path). A param that names
// anything other than a real person contest is a hard 400 — uploads must never
// silently fall back to the global roster when the admin asked for a contest.
async function resolvePersonContestParam(contestParam) {
  if (contestParam === undefined || contestParam === null || String(contestParam).trim() === "") {
    return null;
  }
  const contest = await resolveContest(String(contestParam).trim(), { requireOpen: false });
  if (contest.identity_mode !== "person") {
    throw httpError(400, "per_contest_roster_requires_person_contest");
  }
  return contest;
}

// GET /api/admin/roster — meta summary ONLY (never the rows).
async function adminGetRoster(req) {
  requireAdmin(req);
  // S-C: ?contest= reads that contest's roster meta (roster_meta::{slug}).
  const personContest = await resolvePersonContestParam(req.query?.contest);
  if (personContest) return getContestRosterSummary(personContest);
  const meta = await getRosterMeta();
  if (!meta) return { configured: false };
  return {
    configured: true,
    count: meta.count || 0,
    unique_id_column: meta.unique_id_column || "",
    column_mapping: meta.column_mapping || {},
    columns: meta.columns || [],
    updated_at: meta.updated_at || ""
  };
}

// GET /api/exam-config?contest=<slug> — PUBLIC (the student form renders before
// any session exists). ?contest= is MANDATORY: an absent param is a hard 400
// unknown_contest (the candidate app always pins it). Returns only
// non-sensitive config: whether the roster gate is on, what to call the
// unique-ID field, and the room labels. Fail-open client-side is safe because
// /api/session/start re-enforces the roster gate regardless.
async function publicExamConfig(req) {
  const contestParam = String(req?.query?.contest ?? "").trim();
  if (!contestParam) throw httpError(400, "unknown_contest");
  return contestExamConfig(contestParam);
}

// S-D: per-contest exam-config — 400 unknown_contest / 403 contest_not_open
// (the candidate app turns either into the access-code landing page). Person
// contests serve their OWN snapshot fields.
async function contestExamConfig(slug) {
  const contest = await resolveContest(slug, { requireOpen: true });
  const meta = await getContestRosterMeta(contest);
  return {
    contest_slug: contest.slug,
    contest_name: contest.name || contest.slug,
    identity_label: contest.identity_label || "Candidate ID",
    // The pinned candidate app forks its identity UX on this — always "person".
    identity_mode: contest.identity_mode || "person",
    start_at: contest.start_at || null,
    end_at: contest.end_at || null,
    server_now: new Date().toISOString(),
    roster_required: Boolean(meta),
    // The label-driven identity prompt (F9 §1.5): person contests label the
    // unique-id field from the CONTEST doc, never a roster column name.
    unique_id_label: contest.identity_label || "Candidate ID",
    rooms: normalizeRooms(contest.rooms),
    room_gate_enabled: Boolean(contest.room_gate_enabled),
    enforcement: enforcementConfigFor(contest),
    camera_recording: cameraRecordingConfigFor(contest)
  };
}

// ---- S-D: PUBLIC access-code resolver (vision §10.3) -------------------------
// POST /api/access-code {code} -> {slug, name}. Per-IP fixed-window rate limit
// (in-memory, single-instance — same documented limitation as the exec
// limiter). Only FAILED attempts consume the budget: a successful resolve is
// REFUNDED, because the typed code is built for weak campus labs that NAT a
// whole hall through ONE egress IP (the IP-report cluster detection banks on
// exactly that), so a synchronized hall typing the CORRECT code must never be
// throttled. Anti-enumeration only needs failures capped — at 60 failures/min
// the 34^6 (~1.5B) space still cannot be walked.
const ACCESS_CODE_RATE_LIMIT = 60;
const ACCESS_CODE_RATE_WINDOW_MS = 60_000;
const ACCESS_CODE_RATE_MAP_LIMIT = 10_000;
let _accessCodeClock = () => Date.now();
export function __setAccessCodeClockForTest(fn) {
  _accessCodeClock = fn || (() => Date.now());
}
const accessCodeAttempts = new Map(); // ip -> { count, windowStartMs }

function checkAccessCodeRateLimit(ip) {
  const nowMs = _accessCodeClock();
  // Bounded memory: when the map grows past the cap, sweep expired windows
  // (an attacker rotating spoofed IPs cannot grow it unboundedly between sweeps).
  if (accessCodeAttempts.size >= ACCESS_CODE_RATE_MAP_LIMIT) {
    for (const [key, entry] of accessCodeAttempts) {
      if (nowMs - entry.windowStartMs >= ACCESS_CODE_RATE_WINDOW_MS) accessCodeAttempts.delete(key);
    }
  }
  let entry = accessCodeAttempts.get(ip);
  if (!entry || nowMs - entry.windowStartMs >= ACCESS_CODE_RATE_WINDOW_MS) {
    entry = { count: 0, windowStartMs: nowMs };
    accessCodeAttempts.set(ip, entry);
  }
  entry.count += 1;
  if (entry.count > ACCESS_CODE_RATE_LIMIT) {
    throw rateLimited(Math.max(1, Math.ceil((entry.windowStartMs + ACCESS_CODE_RATE_WINDOW_MS - nowMs) / 1000)));
  }
  // Refund closure: a SUCCESSFUL resolve gives the attempt back, so the cap
  // only ever bites failures. Bound to THIS entry object — if the window
  // rolled over in between, decrementing the detached entry is harmless.
  return () => { if (entry.count > 0) entry.count -= 1; };
}

async function publicAccessCode(req) {
  const refundAttempt = checkAccessCodeRateLimit(getClientIp(req));
  const body = parseBody(req);
  const resolved = await resolveAccessCode(body?.code);
  refundAttempt(); // valid code — only failed attempts consume the budget
  return { ok: true, ...resolved };
}

// The ACTIVE-version roster entry for a unique id, or null. Entries from a
// previous upload (stale roster_version) are invisible.
async function findRosterEntry(meta, uniqueId) {
  const norm = normalizeUniqueId(uniqueId);
  if (!norm) return null;
  const doc = await getFirestore().collection(ROSTER_COLLECTION).doc(rosterEntryId(meta.version, norm)).get();
  const entry = doc.exists ? doc.data() : null;
  // Doc-id sanitization can COLLAPSE distinct normalized ids onto one doc id
  // ("2021#cs#001" and "2021$cs$001" both become "2021_cs_001"), so the fetched
  // entry must also carry the EXACT normalized id that was looked up.
  if (!entry || entry.roster_version !== meta.version || entry.unique_id_norm !== norm) return null;
  return entry;
}

// maskEmail moved to lib/sanitize.mjs (decomp B0); imported at the top.

// ---- M3: roster-lookup enumeration mitigation -------------------------------
// /api/roster/lookup is PUBLIC and ID-enumerable (s2 design §7 accepted it as a
// documented limitation). The product owner wants it mitigated now: a BEST-EFFORT per-IP
// fixed-window rate limiter caps how fast one client can walk the id space, so a
// scraper can no longer harvest the masked confirmation set (name/roll/masked
// email) at machine speed.
//
// SHARED-NAT SAFETY (Wave-6 review fix). Roster lookup is the FIRST step EVERY
// candidate performs (the unique-id-confirm login), and a campus lab NATs the
// whole hall through ONE egress IP — exactly the property the IP-report cluster
// detection banks on, and exactly the hazard the sibling access-code limiter
// (above) was designed around. So this limiter MIRRORS that design instead of
// charging every attempt:
//   1. A SUCCESSFUL (found-id) lookup is REFUNDED — a legitimate candidate's
//      single confirm never accrues budget, so a synchronized hall of 30-60+
//      real logins behind one NAT IP is never throttled. Only 404 MISSES (the
//      enumeration signal) consume the budget.
//   2. The cap is hall-sized (matches the access-code limiter's 60/min for the
//      same shared-IP population) with headroom, so even the brief pre-refund
//      window of a concurrent-login burst on one instance's bucket stays clear.
// Anti-enumeration is still achieved: one attacker walking the id space from one
// IP sees mostly misses, and 60 misses/min cannot meaningfully harvest a roster.
//
// BEST-EFFORT, PER-INSTANCE: the counter lives in this process's memory. Cloud
// Run runs MANY instances and does NOT share memory across them, so an attacker
// whose requests fan out across instances gets a higher effective ceiling, and a
// cold start resets the map. This is an acceptable mitigation that raises the
// cost of bulk enumeration — NOT a global guarantee. A hard guarantee would need
// a shared store (Firestore/Redis counter) or fronting WAF, which is out of
// scope for this slice.
const ROSTER_LOOKUP_RATE_LIMIT = 60;
const ROSTER_LOOKUP_RATE_WINDOW_MS = 60_000;
const ROSTER_LOOKUP_RATE_MAP_LIMIT = 10_000;
let _rosterLookupClock = () => Date.now();
export function __setRosterLookupClockForTest(fn) {
  _rosterLookupClock = fn || (() => Date.now());
}
const rosterLookupAttempts = new Map(); // ip -> { count, windowStartMs }
// Test seam: the limiter map is module-global (it survives across tests in a
// suite). Clear it between tests so unrelated lookups don't accumulate toward
// the cap. Production never calls this.
export function __resetRosterLookupRateLimitForTest() {
  rosterLookupAttempts.clear();
}

// Pure decision: record one attempt for `ip` and throw a 429 (rate_limited, with
// a retry_after_seconds hint the api() catch forwards) once the per-window cap is
// exceeded. Bounded memory: a full map is swept of expired windows before insert
// so spoofed-IP rotation cannot grow it without bound.
//
// Returns a REFUND closure (mirrors checkAccessCodeRateLimit): the caller invokes
// it on a SUCCESSFUL (found-id) lookup to give the attempt back, so a legitimate
// candidate's single confirm never accrues budget and a NAT'd hall is never
// throttled. Only 404 misses (the enumeration signal) end up consuming budget.
export function checkRosterLookupRateLimit(ip) {
  const nowMs = _rosterLookupClock();
  if (rosterLookupAttempts.size >= ROSTER_LOOKUP_RATE_MAP_LIMIT) {
    for (const [key, entry] of rosterLookupAttempts) {
      if (nowMs - entry.windowStartMs >= ROSTER_LOOKUP_RATE_WINDOW_MS) rosterLookupAttempts.delete(key);
    }
  }
  let entry = rosterLookupAttempts.get(ip);
  if (!entry || nowMs - entry.windowStartMs >= ROSTER_LOOKUP_RATE_WINDOW_MS) {
    entry = { count: 0, windowStartMs: nowMs };
    rosterLookupAttempts.set(ip, entry);
  }
  entry.count += 1;
  if (entry.count > ROSTER_LOOKUP_RATE_LIMIT) {
    throw rateLimited(Math.max(1, Math.ceil((entry.windowStartMs + ROSTER_LOOKUP_RATE_WINDOW_MS - nowMs) / 1000)));
  }
  // Refund closure bound to THIS entry: a found-id lookup gives the attempt back.
  // If the window rolled over before the refund fires, decrementing the detached
  // entry is harmless.
  return () => { if (entry.count > 0) entry.count -= 1; };
}

// POST /api/roster/lookup — PUBLIC unique-ID-confirm login, step 1. Returns the
// MINIMUM confirmation set: mapped name/roll/room/username + MASKED email.
// Unmapped extra columns (phone numbers, ...) and the raw email NEVER leave via
// this route — the raw email reaches the session doc only through the
// server-side override at /api/session/start. Enumeration risk is MITIGATED by
// the best-effort per-IP rate limit above (M3); see its comment for the
// per-instance caveat.
async function rosterLookup(req) {
  // M3: throttle BEFORE any roster read — a rejected caller learns nothing about
  // the roster (the 429 body is minimal: error + retry hint, no lookup fields).
  // A SUCCESSFUL (found-id) lookup is refunded below so a NAT'd hall of real
  // logins never accrues budget; only 404 misses (enumeration) consume it.
  const refundLookup = checkRosterLookupRateLimit(getClientIp(req));
  const body = parseBody(req);
  requireFields(body, ["unique_id"]);
  const meta = await getRosterMeta();
  if (!meta) throw httpError(404, "roster_not_configured");
  const entry = await findRosterEntry(meta, String(body.unique_id));
  if (!entry) throw httpError(404, "not_on_roster");
  refundLookup(); // a real candidate's confirm — only enumeration misses pay
  const mapping = meta.column_mapping || {};
  const field = (name) => (mapping[name] ? String(entry.fields?.[mapping[name]] || "") : "");
  return {
    found: true,
    unique_id: entry.unique_id,
    name: field("name"),
    roll_number: field("roll_number"),
    room: field("room"),
    hackerrank_username: field("hackerrank_username"),
    email_masked: maskEmail(field("email"))
  };
}

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

async function adminSessions(req) {
  requireAdmin(req);
  // FIX-B1: the recording-review player resolves a session by its STORED key.
  // An EXACT `username_norm` (no re-normalization) is the authoritative lookup —
  // it matches BOTH legacy docs (username_norm = normalized candidate) AND
  // person-mode docs (username_norm = person_id = "{college_norm}~{uid_norm}").
  // The legacy `username` param re-normalizes the value and is kept for full
  // back-compat (older callers, manual candidate-id entry). When both are sent,
  // the exact `username_norm` wins. A normalized `username` can NEVER equal a
  // college-prefixed person_id, which is exactly why person sessions were dead.
  const usernameNormExact = req.query?.username_norm;
  const username = req.query?.username;
  if (!usernameNormExact && !username) return badRequest("username is required");

  // S-D (A1: "selector scopes every tab"): the review search honours the
  // OPTIONAL global contest filter like every other admin GET. Under person
  // identity the same person_id recurs across rounds BY DESIGN, so an unscoped
  // username search would interleave Round-1 sessions into a Round-2 review.
  const scope = await contestScopeOf(req.query?.contest_slug);
  const usernameNorm = usernameNormExact
    ? String(usernameNormExact)
    : normalizeUsername(username);
  const snapshot = await scopedQuery(getFirestore().collection(SESSION_COLLECTION), scope)
    .where("username_norm", "==", usernameNorm)
    .limit(50)
    .get();

  const sessions = await Promise.all(snapshot.docs
    .map((doc) => doc.data())
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))
    .slice(0, 20)
    .map(async (item) => {
      // Admin-evidence listing MUST use the same prefix the upload sites wrote
      // to, or it lists nothing. sessionPrefix() reads the persisted
      // storage_prefix (legacy docs fall back to the reconstructed legacy path).
      const prefix = sessionPrefix(item);
      const [files] = await bucket().getFiles({ prefix, maxResults: 1000 });
      // Sign read URLs with BOUNDED concurrency and WITHOUT a redundant per-file
      // getMetadata() call — getFiles already populates file.metadata. Heavy
      // recordings have 200+ chunk files; the previous code fired 2 calls per file
      // (getMetadata + getSignedUrl) all at once, so a single request fanned out
      // into ~400 simultaneous GCS/IAM calls and 500'd on the small Cloud Run
      // instance. Capping concurrency keeps a heavy session well under the timeout.
      const evidence = await mapWithConcurrency(files, 12, async (file) => {
        // Listing fanned out via the main client above (getFiles); sign each
        // chunk's read URL through the signing client (local crypto off the key,
        // no token) so playback URLs don't hit the flaky external token endpoint.
        const [downloadUrl] = await signingBucket().file(file.name).getSignedUrl({
          version: "v4",
          action: "read",
          expires: Date.now() + 3600 * 1000
        });
        const meta = file.metadata || {};
        return {
          key: file.name,
          size: Number(meta.size || 0),
          last_modified: meta.updated,
          download_url: downloadUrl
        };
      });
      // F6.6: structured per-source capture state so the recordings-review
      // header can say what the loaded recording contains (screen video +
      // mic audio? camera live-monitor only?) without re-parsing the raw
      // composite recording_state client-side.
      return { ...item, evidence, capture_state: parseCaptureState(item.recording_state) };
    }));

  return { sessions };
}

// Screen-recording playback picker (admin): a LIGHTWEIGHT list of sessions that
// actually have recorded chunks, so the console can present a username/session
// picker WITHOUT a GCS listing or any signed URLs (those are resolved lazily via
// adminSessions when one is chosen). We query the session collection, prefer docs
// with chunk_count > 0, optionally scope to a contest, sort newest-first, and cap
// the result. If the chunk_count filter would return nothing (e.g. legacy docs
// that never tracked chunk_count), we fall back to ALL sessions so the picker is
// never empty against older data.
async function adminRecordingSessions(req) {
  requireAdmin(req);
  const scope = await contestScopeOf(req.query?.contest_slug);
  const snapshot = await scopedQuery(getFirestore().collection(SESSION_COLLECTION), scope)
    .limit(SESSIONS_QUERY_LIMIT)
    .get();
  const allDocs = snapshot.docs.map((doc) => doc.data());

  // Prefer sessions with recorded chunks; fall back to ALL when none report a
  // positive chunk_count (legacy docs) so the picker still lists something.
  const withChunks = allDocs.filter((doc) => Number(doc.chunk_count || 0) > 0);
  const source = withChunks.length ? withChunks : allDocs;

  const sessions = source
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))
    .slice(0, 500)
    .map((doc) => ({
      session_id: doc.session_id,
      hackerrank_username: doc.hackerrank_username || "",
      candidate_id: candidateOf(doc).id, // S-C dual-read adapter (F9 §1.2)
      // FIX-B1: the EXACT stored lookup key. The player keys loadUser on this
      // (NOT candidate_id) so person-mode rows — username_norm = person_id =
      // "{college_norm}~{uid_norm}" — resolve via adminSessions; candidate_id
      // remains the human display label only.
      username_norm: doc.username_norm || "",
      name: doc.name || "",
      room: doc.room || "",
      contest_slug: doc.contest_slug || "",
      chunk_count: Number(doc.chunk_count || 0),
      camera_chunk_count: Number(doc.camera_chunk_count || 0),
      created_at: doc.created_at || "",
      status: doc.status || ""
    }));

  return { sessions };
}

// Sessions drill-down (admin): the ALL-DOCS (including zero-chunk) counterpart
// to adminRecordingSessions. adminRecordingSessions intentionally lists only
// sessions that actually recorded chunks (the playback picker), so it CANNOT
// back the stat-card drill-down — a pending_approval second-device session has
// chunk_count:0 and would be filtered out, hiding the very rows the
// pending_approval Approve action needs to reach. This endpoint lists EVERY
// session doc, classifies each by the SAME rules as adminStats (so the row
// counts match the stat-card counts exactly), and supports room filtering, so
// the console's per-stat-card drill-down lands on the right sessions.
async function adminSessionsList(req) {
  requireAdmin(req);
  const scope = await contestScopeOf(req.query?.contest_slug);
  const room = normalizeRoomFilter(req.query?.room);
  const status = String(req.query?.status || "");
  const snapshot = await scopedQuery(getFirestore().collection(SESSION_COLLECTION), scope)
    .limit(SESSIONS_QUERY_LIMIT)
    .get();
  let docs = snapshot.docs.map((doc) => doc.data());
  if (room) docs = docs.filter((doc) => String(doc.room || "") === room);
  const nowMs = Date.now();
  const matchesStatus = (doc) => {
    switch (status) {
      case "": return true;
      case "active": return doc.status === "active";
      case "disconnected": return doc.status === "active" && isStaleSession(doc, nowMs);
      case "locked": return doc.status === "locked";
      case "pending_approval": return doc.status === "pending_approval";
      case "ended": return doc.status === "ended";
      default: return false;
    }
  };
  const matched = docs.filter(matchesStatus);
  const byNewest = (a, b) => String(b.created_at || "").localeCompare(String(a.created_at || ""));
  // F6 review: the page is capped, but LIVE (non-ended) rows must never be
  // displaced by newer ended rows — the alerts-console status join (F6.4)
  // reads this list to decide which actions a live candidate gets, and cutting
  // a live row would silently hide their Lock/End. Select every live row first
  // (they are the actionable ones), fill the remainder with the newest ended
  // rows, then present the final page newest-first as before.
  const live = matched.filter((doc) => doc.status !== "ended").sort(byNewest);
  const ended = matched.filter((doc) => doc.status === "ended").sort(byNewest);
  const page = live.slice(0, SESSIONS_LIST_PAGE_LIMIT)
    .concat(ended.slice(0, Math.max(0, SESSIONS_LIST_PAGE_LIMIT - live.length)))
    .sort(byNewest);
  // truncated = live coverage may be incomplete: the raw query hit its cap (it
  // has no orderBy, so ARBITRARY docs — live ones included — may be missing
  // from the snapshot) or more live rows matched than the page holds. Status-
  // join consumers must treat a truncated list like no list at all and fall
  // back to the full action set; ended rows cut by the cap don't matter (an
  // ended session takes no session action anyway).
  const truncated = snapshot.docs.length >= SESSIONS_QUERY_LIMIT || live.length > SESSIONS_LIST_PAGE_LIMIT;
  const sessions = page
    .map((doc) => ({
      session_id: doc.session_id,
      hackerrank_username: doc.hackerrank_username || "",
      candidate_id: candidateOf(doc).id, // S-C dual-read adapter (F9 §1.2)
      // FIX-B1: stored lookup key so the "View recording" deep link from this
      // drill-down can resolve person-mode sessions (username_norm = person_id).
      username_norm: doc.username_norm || "",
      name: doc.name || "",
      room: doc.room || "",
      contest_slug: doc.contest_slug || "",
      chunk_count: Number(doc.chunk_count || 0),
      camera_chunk_count: Number(doc.camera_chunk_count || 0),
      created_at: doc.created_at || "",
      status: doc.status || "",
      // F-C (KPR 2026-06-12): loud admin-visible signal — this session started
      // anonymously on a contest that HAS an enrollment spine (typed id
      // resolved to no person). False/absent everywhere else.
      identity_unresolved: doc.identity_unresolved === true
    }));
  return { sessions, truncated };
}

// Session detail (admin) — F6.3: ONE session doc for the Sessions detail card,
// projected to the least-privilege fields the card actually shows: identity
// (incl. the roster id the candidate verified against), status, the IP block
// (start/current + mid-exam change count), and the doc's own activity counters
// (events/heartbeats/chunks — all already maintained on the doc, zero extra
// reads). Deliberately NO email, NO storage_prefix/keys, NO evidence/signed
// URLs (the recordings view resolves those itself when the admin jumps there).
async function adminSessionDetail(req) {
  requireAdmin(req);
  const sessionId = String(req.query?.session_id || "");
  if (!sessionId) return badRequest("session_id required");
  const session = await getSessionOrNull(sessionId);
  if (!session) throw httpError(404, "Session not found");
  return {
    session: {
      session_id: session.session_id,
      hackerrank_username: session.hackerrank_username || "",
      // S-C: dual-read identity (F9 §1.2) + the person components so the card
      // can link to the person and disambiguate multi-college contests.
      candidate_id: candidateOf(session).id,
      identity_label: candidateOf(session).label,
      person_id: session.person_id ?? null,
      college_norm: session.college_norm || "",
      name: session.name || "",
      roll_number: session.roll_number || "",
      roster_unique_id: session.roster_unique_id || "",
      room: session.room || "",
      contest_slug: session.contest_slug || "",
      status: session.status || "",
      created_at: session.created_at || "",
      updated_at: session.updated_at || "",
      blocked_by_session_id: session.blocked_by_session_id || null,
      start_ip: session.start_ip || "",
      current_ip: session.current_ip || session.start_ip || "",
      ip_change_count: Number(session.ip_change_count || 0),
      chunk_count: Number(session.chunk_count || 0),
      camera_chunk_count: Number(session.camera_chunk_count || 0),
      event_count: Number(session.event_count || 0),
      clipboard_event_count: Number(session.clipboard_event_count || 0),
      focus_event_count: Number(session.focus_event_count || 0),
      heartbeat_count: Number(session.heartbeat_count || 0),
      // F6.6: last-reported per-source capture state (null until a composite
      // heartbeat arrives) — the card's screen/camera/mic rows.
      capture_state: parseCaptureState(session.recording_state),
      // F5.3/F5.5: why a locked session is locked (enforcement vs admin) +
      // the per-session exemption toggles the card renders.
      locked_reason: session.locked_reason || null,
      enforcement_exemptions: sanitizeExemptions(session.enforcement_exemptions)
    }
  };
}

// Session event log (admin) — F6.7: the per-session candidate event stream for
// the recordings timeline overlay. Events are NOT in Firestore — every batch is
// a JSONL object under the session's GCS prefix: events/events-*.jsonl (client
// batches via /api/events), events/session.jsonl (the session_started record),
// and events/ip-change-*.jsonl (heartbeat-detected IP changes). This lists +
// parses them all, projects each record to the LEAST-PRIVILEGE shape the
// timeline needs ({type, timestamp, small scalar detail}), sorts by time and
// caps the merged list so a pathological session can't return megabytes.
const SESSION_EVENTS_LIMIT = 2000;
const SESSION_EVENT_DETAIL_STRING_MAX = 200;
const SESSION_EVENT_DETAIL_KEY_MAX = 8;
// GCS object keys inside detail (chunk_uploaded carries storage_key) stay
// server-side — the admin evidence listing is the sanctioned path to keys.
const SESSION_EVENT_DETAIL_EXCLUDED_KEYS = new Set(["storage_key"]);

// Project a stored event detail to a SMALL flat object: scalar values only
// (strings truncated), excluded keys dropped, bounded key count. Never throws.
function projectSessionEventDetail(detail) {
  const out = {};
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return out;
  let kept = 0;
  for (const [key, value] of Object.entries(detail)) {
    if (kept >= SESSION_EVENT_DETAIL_KEY_MAX) break;
    if (SESSION_EVENT_DETAIL_EXCLUDED_KEYS.has(key)) continue;
    if (typeof value === "string") out[key] = value.slice(0, SESSION_EVENT_DETAIL_STRING_MAX);
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else continue; // nested objects/arrays/null: dropped, scalars only
    kept += 1;
  }
  return out;
}

async function adminSessionEvents(req) {
  requireAdmin(req);
  const sessionId = String(req.query?.session_id || "");
  if (!sessionId) return badRequest("session_id required");
  const session = await getSessionOrNull(sessionId);
  if (!session) throw httpError(404, "Session not found");

  const prefix = `${sessionPrefix(session)}events/`;
  const [files] = await bucket().getFiles({ prefix, maxResults: 1000 });
  // Download + parse with bounded concurrency (same rationale as the evidence
  // listing). A malformed line or unreadable object is skipped, never fatal.
  const batches = await mapWithConcurrency(files, 12, async (file) => {
    try {
      const [contents] = await file.download();
      return String(contents)
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter((record) => record && typeof record === "object");
    } catch {
      return [];
    }
  });

  const events = batches
    .flat()
    .map((record) => ({
      type: String(record.type || "unknown"),
      timestamp: String(record.timestamp || ""),
      detail: projectSessionEventDetail(record.detail)
    }))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return {
    events: events.slice(0, SESSION_EVENTS_LIMIT),
    truncated: events.length > SESSION_EVENTS_LIMIT
  };
}

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

// S5: end every non-ended session in the given contest scope. Mirrors
// applySessionAction("end") — status:ended
// + ended_at + live-slot release — with a distinct ended_reason for the audit
// trail, applied with bounded concurrency so an 800-session end-now never fans
// out unbounded. Returns the number of sessions ended.
//
// D3: paginated by document id — a single SESSIONS_QUERY_LIMIT-capped query
// silently stranded live sessions past the first 2000 docs (multi-day slug
// reuse). orderBy(documentId) + startAfter rides the automatic single-field
// index on contest_slug (every index ends with __name__), so no composite
// index is needed.
async function endAllLiveSessions(contestSlug, now) {
  let endedCount = 0;
  let cursor = null;
  for (;;) {
    let query = getFirestore()
      .collection(SESSION_COLLECTION)
      .where("contest_slug", "==", contestSlug || "")
      .orderBy(FieldPath.documentId())
      .limit(SESSIONS_QUERY_LIMIT);
    if (cursor !== null) query = query.startAfter(cursor);
    const snapshot = await query.get();
    const live = snapshot.docs.map((doc) => doc.data()).filter((doc) => doc.status !== "ended");
    await mapWithConcurrency(live, 12, async (session) => {
      await sessionRef(session.session_id).update({
        status: "ended", ended_at: now, updated_at: now, ended_reason: "exam_ended_by_admin"
      });
      await releaseLiveSlot(session);
    });
    endedCount += live.length;
    if (snapshot.docs.length < SESSIONS_QUERY_LIMIT) break;
    cursor = snapshot.docs[snapshot.docs.length - 1].id;
  }
  return endedCount;
}

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

// S7 — IP-wise report of logged-in users (proxy-detection signal). Groups the
// contest's session docs by the IP we already capture (current_ip, refreshed by
// every heartbeat; start_ip fallback) and returns counts + a bounded candidate
// sample per IP — see backend/src/ipReport.mjs. scope=live (default) reports
// non-ended sessions ("logged-in users"); scope=all adds ended sessions for
// after-the-exam forensics. Query/filter pattern mirrors adminSessionsList.
async function adminIpReport(req) {
  requireAdmin(req);
  const contestSlug = req.query?.contest_slug;
  const contestScope = await contestScopeOf(contestSlug);
  const room = normalizeRoomFilter(req.query?.room);
  const scope = String(req.query?.scope || "live");
  if (scope !== "live" && scope !== "all") return badRequest("scope must be live or all");

  const snapshot = await scopedQuery(getFirestore().collection(SESSION_COLLECTION), contestScope)
    .limit(SESSIONS_QUERY_LIMIT)
    .get();
  let docs = snapshot.docs.map((doc) => doc.data());
  if (room) docs = docs.filter((doc) => String(doc.room || "") === room);
  if (scope === "live") docs = docs.filter((doc) => doc.status && doc.status !== "ended");

  return {
    contest_slug: contestSlug ? String(contestSlug) : null,
    room: room || null,
    scope,
    ...buildIpReport(docs)
  };
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

// ---- S6 attendance (spec: docs/superpowers/specs/2026-06-09-s6-attendance-stats-design.md)

// GET /api/admin/attendance?contest_slug=<optional> — roster-based attendance:
// taken / not-taken counts + the absentee list. "Taken" = the roster student has
// AT LEAST ONE session doc whose roster_unique_id matches their ACTIVE-version
// roster entry (any status — pending_approval/locked still means they showed
// up); "in_progress" = any of their sessions is non-ended; "completed" = all
// ended. Sessions that can't be tied to the active roster (legacy pre-roster,
// blank id, replaced-roster ids) are surfaced as unmatched_sessions — never
// silently dropped, never counted as attendance. Absentee rows carry ONLY the
// mapped identity fields (unique_id, name, roll_number, room) — no email, no
// raw roster fields (PII minimization). Computed on demand: one version-
// filtered roster scan + one session scan, joined in memory (no new state, no
// composite index — both filters are single-field equalities). The admin UI
// loads this on tab-open + manual refresh only (NO auto-poll).
async function adminAttendance(req) {
  requireAdmin(req);
  const contestSlug = req.query?.contest_slug;
  // S-C: a contest_slug naming a real person contest reads ITS OWN roster
  // (roster_meta::{slug}) and joins sessions by person_id; any other filter
  // value keeps today's global-roster path bit-for-bit.
  const personContest = await personContestForFilter(contestSlug);
  if (personContest) return personContestAttendance(personContest);
  const meta = await getRosterMeta();
  if (!meta) return { configured: false };

  // Active-version roster entries (stale versions are invisible — S2 invariant).
  const entriesSnap = await getFirestore()
    .collection(ROSTER_COLLECTION)
    .where("roster_version", "==", meta.version)
    .limit(ROSTER_LIMIT)
    .get();
  const entries = entriesSnap.docs.map((doc) => doc.data());

  // Session docs, optionally contest-scoped (same pattern as adminStats).
  const sessionsSnap = await scopedQuery(getFirestore().collection(SESSION_COLLECTION), await contestScopeOf(contestSlug))
    .limit(SESSIONS_QUERY_LIMIT)
    .get();
  const sessions = sessionsSnap.docs.map((doc) => doc.data());

  // norm unique id -> true when ANY of that student's sessions is still live.
  const knownNorms = new Set(entries.map((entry) => String(entry.unique_id_norm || "")));
  const liveByNorm = new Map();
  let unmatched = 0;
  for (const session of sessions) {
    const idNorm = normalizeUniqueId(String(session.roster_unique_id || ""));
    if (!idNorm || !knownNorms.has(idNorm)) {
      unmatched += 1;
      continue;
    }
    const live = session.status !== "ended";
    liveByNorm.set(idNorm, Boolean(liveByNorm.get(idNorm)) || live);
  }

  const mapping = meta.column_mapping || {};
  const mappedField = (entry, name) =>
    (mapping[name] ? String(entry.fields?.[mapping[name]] || "") : "");
  const taken = { total: 0, in_progress: 0, completed: 0 };
  const absentees = [];
  for (const entry of entries) {
    const idNorm = String(entry.unique_id_norm || "");
    if (liveByNorm.has(idNorm)) {
      taken.total += 1;
      if (liveByNorm.get(idNorm)) taken.in_progress += 1;
      else taken.completed += 1;
    } else {
      absentees.push({
        unique_id: String(entry.unique_id || ""),
        name: mappedField(entry, "name"),
        roll_number: mappedField(entry, "roll_number"),
        room: mappedField(entry, "room")
      });
    }
  }
  absentees.sort((a, b) => a.unique_id.localeCompare(b.unique_id));

  return {
    configured: true,
    contest_slug: contestSlug ? String(contestSlug) : null,
    roster_total: entries.length,
    taken,
    not_taken: absentees.length,
    absentees,
    unmatched_sessions: unmatched,
    generated_at: new Date().toISOString()
  };
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

// S-C attendance for a person contest: ITS roster (roster_meta::{slug}) joined
// to ITS sessions by person_id (the only join that survives two colleges
// sharing a roll number). Absentee rows gain the college (vision A11) — still
// PII-minimized: mapped identity fields + college, no email, no raw fields.
async function personContestAttendance(contest) {
  const meta = await getContestRosterMeta(contest);
  // KPR 2026-06-12: a CLEARED roster used to collapse attendance to
  // "not configured" even though the enrollment spine (persons minted by the
  // last upload) survives the clear — fall back to it instead of hiding.
  if (!meta) return personEnrollmentAttendance(contest);

  const entriesSnap = await getFirestore()
    .collection(ROSTER_COLLECTION)
    .where("roster_version", "==", meta.version)
    .limit(ROSTER_LIMIT)
    .get();
  const entries = entriesSnap.docs.map((doc) => doc.data());

  const sessionsSnap = await scopedQuery(getFirestore().collection(SESSION_COLLECTION), contest)
    .limit(SESSIONS_QUERY_LIMIT)
    .get();
  const sessions = sessionsSnap.docs.map((doc) => doc.data());

  const knownPersons = new Set(entries.map((entry) => String(entry.person_id || "")));
  const liveByPerson = new Map();
  let unmatched = 0;
  for (const session of sessions) {
    const personId = String(session.person_id || "");
    if (!personId || !knownPersons.has(personId)) {
      unmatched += 1;
      continue;
    }
    const live = session.status !== "ended";
    liveByPerson.set(personId, Boolean(liveByPerson.get(personId)) || live);
  }

  const mapping = meta.column_mapping || {};
  const mappedField = (entry, name) =>
    (mapping[name] ? String(entry.fields?.[mapping[name]] || "") : "");
  const taken = { total: 0, in_progress: 0, completed: 0 };
  const absentees = [];
  for (const entry of entries) {
    const personId = String(entry.person_id || "");
    if (liveByPerson.has(personId)) {
      taken.total += 1;
      if (liveByPerson.get(personId)) taken.in_progress += 1;
      else taken.completed += 1;
    } else {
      absentees.push({
        unique_id: String(entry.unique_id || ""),
        name: mappedField(entry, "name"),
        roll_number: mappedField(entry, "roll_number"),
        room: mappedField(entry, "room"),
        college: String(entry.college || "")
      });
    }
  }
  absentees.sort((a, b) => a.unique_id.localeCompare(b.unique_id) || a.college.localeCompare(b.college));

  return {
    configured: true,
    contest_slug: contest.slug,
    roster_total: entries.length,
    taken,
    not_taken: absentees.length,
    absentees,
    unmatched_sessions: unmatched,
    generated_at: new Date().toISOString()
  };
}

// KPR 2026-06-12: attendance from the ENROLLMENT SPINE when the roster was
// cleared (roster_meta off) but the durable enrollments survive. Same shape as
// the roster-driven report plus source:"enrollments" + an explicit note, so
// the admin knows exactly what they are looking at — never a silent blank.
// Absentee identity comes from the person docs (unique_id + name; roster
// column mapping is gone with the meta, so roll_number/room are blank).
async function personEnrollmentAttendance(contest) {
  const enrollments = (await listEnrollments(contest)).filter((e) => e.status !== "removed");
  if (!enrollments.length) return { configured: false, contest_slug: contest.slug };

  const sessionsSnap = await scopedQuery(getFirestore().collection(SESSION_COLLECTION), contest)
    .limit(SESSIONS_QUERY_LIMIT)
    .get();
  const sessions = sessionsSnap.docs.map((doc) => doc.data());

  const knownPersons = new Set(enrollments.map((e) => String(e.person_id || "")));
  const liveByPerson = new Map();
  let unmatched = 0;
  for (const session of sessions) {
    const personId = String(session.person_id || "");
    if (!personId || !knownPersons.has(personId)) {
      unmatched += 1;
      continue;
    }
    const live = session.status !== "ended";
    liveByPerson.set(personId, Boolean(liveByPerson.get(personId)) || live);
  }

  const [persons, collegeNames] = await Promise.all([
    getPersonsByIds([...knownPersons]),
    getCollegeNameMap()
  ]);
  const taken = { total: 0, in_progress: 0, completed: 0 };
  const absentees = [];
  for (const enrollment of enrollments) {
    const personId = String(enrollment.person_id || "");
    if (liveByPerson.has(personId)) {
      taken.total += 1;
      if (liveByPerson.get(personId)) taken.in_progress += 1;
      else taken.completed += 1;
    } else {
      const person = persons.get(personId) || null;
      const collegeNorm = String(enrollment.college_norm || person?.college_norm || "");
      absentees.push({
        unique_id: String(person?.unique_id || ""),
        name: String(person?.name || ""),
        roll_number: "",
        room: "",
        college: collegeNames.get(collegeNorm) || collegeNorm
      });
    }
  }
  absentees.sort((a, b) => a.unique_id.localeCompare(b.unique_id) || a.college.localeCompare(b.college));

  return {
    configured: true,
    contest_slug: contest.slug,
    source: "enrollments",
    note: "The roster for this contest was cleared, so attendance is computed from the surviving enrollments "
      + "(the persons minted by the last roster upload). Sessions not keyed to a person are counted as unmatched, "
      + "never as attendance.",
    roster_total: enrollments.length,
    taken,
    not_taken: absentees.length,
    absentees,
    unmatched_sessions: unmatched,
    generated_at: new Date().toISOString()
  };
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

// Phase 2 (2.4 / Epic 4.3): remote admin actions, per-session (session_id) or in
// bulk (usernames[] within a contest). Returns the updated docs so the console
// can reflect the new state immediately.
async function adminSessionAction(req) {
  requireAdmin(req);
  const body = parseBody(req);
  const action = String(body.action || "");
  const VALID_ACTIONS = ["approve", "lock", "unlock", "bypass", "end", "exempt"];
  if (!VALID_ACTIONS.includes(action)) {
    return badRequest(`action must be one of ${VALID_ACTIONS.join(", ")}`);
  }

  const targets = await resolveActionTargets(body);
  if (!targets.length) return badRequest("Provide session_id or a non-empty usernames[]");

  const updated = [];
  for (const session of targets) {
    const result = await applySessionAction(action, session, { exemptions: body.exemptions });
    if (Array.isArray(result)) updated.push(...result);
    else if (result) updated.push(result);
  }
  return { ok: true, action, updated };
}

// Resolve which session docs an action applies to: a single session_id, or all
// non-ended sessions for each username in usernames[] (optionally scoped to a
// contest_slug). For bulk we operate on the live (non-ended) doc per username.
async function resolveActionTargets(body) {
  if (body.session_id) {
    const session = await getSessionOrNull(body.session_id);
    return session ? [session] : [];
  }
  if (Array.isArray(body.usernames) && body.usernames.length) {
    const contestSlug = body.contest_slug !== undefined && body.contest_slug !== null
      ? String(body.contest_slug)
      : null;
    const out = [];
    for (const username of body.usernames) {
      const usernameNorm = normalizeUsername(username);
      let query = getFirestore()
        .collection(SESSION_COLLECTION)
        .where("username_norm", "==", usernameNorm);
      if (contestSlug !== null) query = query.where("contest_slug", "==", contestSlug);
      const snapshot = await query.limit(50).get();
      const live = snapshot.docs
        .map((doc) => doc.data())
        .filter((doc) => doc.status && doc.status !== "ended")
        .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
      if (live.length) out.push(live[0]);
    }
    return out;
  }
  return [];
}

async function applySessionAction(action, session, options = {}) {
  const now = new Date().toISOString();

  if (action === "approve") {
    // Activate a pending session and END the conflicting active one it was
    // waiting behind, so exactly one session is live afterward.
    const out = [];
    if (session.blocked_by_session_id) {
      const conflict = await getSessionOrNull(session.blocked_by_session_id);
      if (conflict && conflict.status !== "ended") {
        await sessionRef(conflict.session_id).update({ status: "ended", ended_at: now, updated_at: now, ended_reason: "superseded_by_approval" });
        // H1: the conflicting session no longer holds the live slot.
        await releaseLiveSlot(conflict);
        out.push({ ...conflict, status: "ended", ended_at: now, updated_at: now, ended_reason: "superseded_by_approval" });
      }
    }
    await sessionRef(session.session_id).update({ status: "active", blocked_by_session_id: null, approved_at: now, updated_at: now });
    // H1: the approved session now OWNS the live slot — point the lock at it.
    await takeOverLiveSlot(session);
    out.push({ ...session, status: "active", blocked_by_session_id: null, approved_at: now, updated_at: now });
    return out;
  }

  if (action === "lock") {
    await sessionRef(session.session_id).update({ status: "locked", locked_at: now, updated_at: now });
    return { ...session, status: "locked", locked_at: now, updated_at: now };
  }

  if (action === "unlock") {
    // F5.3: clearing locked_reason matters — an enforcement lock released by an
    // admin must not leave the session looking code-releasable forever.
    // Wave-2: the SERVER-SIDE exit ladder resets too (mirrors the client's
    // post-release reset) — one later accident is an L1 episode again, not an
    // instant server-side relock.
    const patch = { status: "active", unlocked_at: now, locked_reason: null, fullscreen_exit_count: 0, fullscreen_out_since: null, updated_at: now };
    await sessionRef(session.session_id).update(patch);
    return { ...session, ...patch };
  }

  if (action === "exempt") {
    // F5.5: per-session enforcement exemptions. MERGE semantics so toggling one
    // anomaly never silently clears the other; sanitize drops unknown keys and
    // non-boolean values.
    const merged = { ...sanitizeExemptions(session.enforcement_exemptions), ...sanitizeExemptions(options.exemptions) };
    await sessionRef(session.session_id).update({ enforcement_exemptions: merged, updated_at: now });
    return { ...session, enforcement_exemptions: merged, updated_at: now };
  }

  if (action === "bypass") {
    // Clear a pending/locked block: make the session live and drop the conflict
    // pointer WITHOUT ending the other session (contingency override).
    await sessionRef(session.session_id).update({ status: "active", blocked_by_session_id: null, bypassed_at: now, updated_at: now });
    // H1: this session is now live by override — point the slot lock at it so a
    // later fresh start sees a coherent owner.
    await takeOverLiveSlot(session);
    return { ...session, status: "active", blocked_by_session_id: null, bypassed_at: now, updated_at: now };
  }

  if (action === "end") {
    await sessionRef(session.session_id).update({ status: "ended", ended_at: now, updated_at: now, ended_reason: "admin_action" });
    // H1: free the live slot so a legitimate restart can re-acquire it.
    await releaseLiveSlot(session);
    return { ...session, status: "ended", ended_at: now, updated_at: now, ended_reason: "admin_action" };
  }

  return null;
}

// POST /api/admin/session-details — bulk-resolve student details for a list of
// usernames, projected STRAIGHT from the session doc with ZERO GCS access. The
// frontend roster view calls this with up to REVIEW_ROSTER_LIMIT usernames at
// once, so it MUST NOT touch the bucket: a per-username endpoint that lists or
// signs GCS objects (like adminSessions) re-creates the Cloud Run 500 fan-out.
// adminRecordingSessions is unusable here because it omits email + roll_number.
//
// Response `details` preserves the INPUT order one-to-one; each input username
// echoes back as `username` whether or not a session was found.
async function adminSessionDetails(req) {
  requireAdmin(req);
  const body = parseBody(req);
  if (!Array.isArray(body.usernames)) return badRequest("usernames must be an array");
  if (body.usernames.length > REVIEW_ROSTER_LIMIT) {
    return badRequest(`Too many usernames in one request (max ${REVIEW_ROSTER_LIMIT})`);
  }
  const contestSlug = body.contest_slug !== undefined && body.contest_slug !== null
    ? String(body.contest_slug)
    : null;

  // Bounded concurrency is SAFE here precisely because there is ZERO GCS — each
  // worker does a single Firestore query — so a 5000-username call stays a
  // reasonable fan-out of Firestore reads, never a GCS/IAM storm.
  const details = await mapWithConcurrency(body.usernames, 12, async (u) => {
    const blank = {
      username: u,
      hackerrank_username: "",
      candidate_id: "",
      name: "",
      email: "",
      roll_number: "",
      room: "",
      contest_slug: "",
      status: "",
      found: false
    };
    const norm = normalizeUsername(u);
    // A degenerate norm ('_') comes from a blank/'@'/'..'-style input that carries
    // NO real username (sanitizeSegment collapses it). Querying username_norm=='_'
    // would mass-match every such doc and project a wrong student, so don't query —
    // emit the blank found:false record for that input.
    if (norm === "_") return blank;
    // normalizeUsername does NOT strip a leading '@' (sanitizeSegment maps it to
    // '_'), so an '@alice' input normalizes to '_alice' while the student started
    // as plain 'alice'. ONLY when the RAW input begins with '@' do we ALSO query
    // the de-@ form, so '@alice' resolves to stored 'alice'. We must NOT derive the
    // alt form from norm's leading '_' (that would conflate a GENUINE '_alice'
    // username with 'alice').
    const trimmed = String(u).trim();
    const usernames = [norm];
    if (trimmed.startsWith("@")) {
      const deAt = normalizeUsername(trimmed.slice(1));
      if (deAt !== "_" && !usernames.includes(deAt)) usernames.push(deAt);
    }
    let query = getFirestore()
      .collection(SESSION_COLLECTION)
      .where("username_norm", "in", usernames);
    if (contestSlug !== null) query = query.where("contest_slug", "==", contestSlug);
    const snapshot = await query.limit(50).get();
    const docs = snapshot.docs
      .map((doc) => doc.data())
      .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    if (!docs.length) return blank;
    const doc = docs[0];
    return {
      username: u,
      hackerrank_username: doc.hackerrank_username || "",
      candidate_id: candidateOf(doc).id, // S-C dual-read adapter (F9 §1.2)
      name: doc.name || "",
      email: doc.email || "",
      roll_number: doc.roll_number || "",
      room: doc.room || "",
      contest_slug: doc.contest_slug || "",
      status: doc.status || "",
      found: true
    };
  });

  return { details };
}

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

// SURE-SHOT client event types: when one of these arrives via /api/events we
// raise an idempotent proctor alert. Everything else (focus/blur/visibility/
// clipboard) is intentionally NOT surfaced — it is noisy.
const SURE_SHOT_EVENT_TYPES = {
  recording_stopped: { severity: "critical", title: "Recording stopped" },
  screen_share_stopped: { severity: "critical", title: "Screen sharing stopped" },
  // invalid_share_surface is intentionally absent: the recorder now REFUSES to
  // record on a non-monitor share surface (tab/window), so this event can never
  // fire. Removed from the catalog so it is no longer raised or configurable.
  // Existing stored alerts of this type still DISPLAY (see ALLOWED_ALERT_TYPES /
  // alert normalization) for backward compatibility.
  recording_error: { severity: "critical", title: "Recording error" }
};

// ---- Proctor alert settings (enabled + severity per sure-shot type) --------
//
// The admin console can disable a sure-shot type or override its severity. The
// full set of proctor-controllable types and their DEFAULTS live here; the
// settings doc only stores deltas, but adminGetAlertSettings always returns the
// full set (defaults merged with any stored overrides) so the console renders a
// complete toggle list.
//
// recording_stopped / screen_share_stopped / recording_error  → critical
// ip_changed / tab_hidden / tab_away / disconnected → warning
// NOTE: invalid_share_surface was REMOVED from the catalog — the recorder now
// refuses to record on an invalid share surface, so the event can never fire.
// tab_away additionally carries a numeric threshold_seconds (default 12): the
// minimum continuous "HackerRank not visible" span the monitoring tab-away
// detector must observe before raising an alert. This is the source of truth for
// the detector's --min-gap-seconds.
// F9.3 (product-owner decision, Wave6): show_to_invigilator gates each type's appearance
// on the INVIGILATOR room dashboard's alert feed (server-side filter in
// invigilatorRoom; the admin console always sees everything). The admin OPTS IN
// per type — DEFAULT ALL OFF: nothing is shared with invigilators until the admin
// explicitly ticks "Share with invigilator" for a type. An empty/absent stored
// config therefore shares NOTHING (back-compat: a doc saved before this flag
// existed had no show_to_invigilator, which merges to the default → false → not
// shared, so no historical doc silently leaks alerts to invigilators).
const TAB_AWAY_DEFAULT_THRESHOLD_SECONDS = 12;
const DEFAULT_PROCTOR_ALERT_SETTINGS = {
  recording_stopped: { enabled: true, severity: "critical", show_to_invigilator: false },
  screen_share_stopped: { enabled: true, severity: "critical", show_to_invigilator: false },
  recording_error: { enabled: true, severity: "critical", show_to_invigilator: false },
  // F5.3: the fullscreen enforcement ladder tripped (countdown expired / exit
  // limit exceeded). Disabling this hides the ALERT only — the block-mode lock
  // itself is policy, not alerting, and is governed by enforcement_mode.
  fullscreen_enforcement: { enabled: true, severity: "critical", show_to_invigilator: false },
  ip_changed: { enabled: true, severity: "warning", show_to_invigilator: false },
  tab_hidden: { enabled: true, severity: "warning", show_to_invigilator: false },
  tab_away: { enabled: true, severity: "warning", show_to_invigilator: false, threshold_seconds: TAB_AWAY_DEFAULT_THRESHOLD_SECONDS },
  disconnected: { enabled: true, severity: "warning", show_to_invigilator: false }
};

// Read the stored alert-settings doc and merge it over the defaults so callers
// always see a complete, well-formed per-type config. One Firestore read; call
// once per request and thread the result into the sure-shot upsert sites so a
// single request never re-reads it.
async function getAlertSettings() {
  const doc = await getFirestore().collection(SETTINGS_COLLECTION).doc(ALERT_SETTINGS_ID).get();
  const stored = doc.exists ? (doc.data()?.proctor || {}) : {};
  return mergeAlertSettings(stored);
}

function mergeAlertSettings(stored) {
  const proctor = {};
  for (const [type, def] of Object.entries(DEFAULT_PROCTOR_ALERT_SETTINGS)) {
    const override = stored && typeof stored === "object" ? stored[type] : undefined;
    const entry = {
      enabled: override && typeof override.enabled === "boolean" ? override.enabled : def.enabled,
      severity: override && ALERT_SEVERITIES.includes(override.severity) ? override.severity : def.severity,
      // F9.3: invigilator visibility — only an explicit boolean overrides the default.
      show_to_invigilator: override && typeof override.show_to_invigilator === "boolean"
        ? override.show_to_invigilator
        : def.show_to_invigilator
    };
    // tab_away alone carries a numeric threshold_seconds (minimum continuous
    // absence the tab-away detector flags). Validate it's a positive finite
    // number; otherwise fall back to the default (12). Other types don't have it.
    if ("threshold_seconds" in def) {
      const raw = override ? override.threshold_seconds : undefined;
      const num = typeof raw === "number" ? raw : Number(raw);
      entry.threshold_seconds = Number.isFinite(num) && num > 0 ? num : def.threshold_seconds;
    }
    proctor[type] = entry;
  }
  return { proctor };
}

// Resolve the effective config for one alert type from a (already-read)
// settings object. Falls back to a default-enabled/configured-severity entry for
// any type not present in DEFAULT_PROCTOR_ALERT_SETTINGS (defensive).
function alertTypeConfig(settings, type, fallbackSeverity) {
  const entry = settings?.proctor?.[type];
  if (entry) return entry;
  return { enabled: true, severity: fallbackSeverity };
}

// F9.3 (product-owner decision, Wave6): does this STORED alert appear on the invigilator
// room dashboard? Catalog types follow their explicit show_to_invigilator config;
// catalog-UNKNOWN types (legacy invalid_share_surface, future ingest types) are
// NOT shared — the admin can only opt in types the catalog actually exposes, so
// an unknown type has no opt-in switch and stays admin-only (matches the new
// default-all-off contract: nothing is surfaced to invigilators unless an
// explicit boolean flag says so).
function isAlertShownToInvigilator(settings, alert) {
  const entry = settings?.proctor?.[alert?.type];
  if (entry) return entry.show_to_invigilator === true;
  return false;
}

// FIX-B3 #6: does ANY proctor alert type have show_to_invigilator on? Drives the
// invigilator empty-feed copy: when nothing is shared, the empty alerts panel
// says so explicitly ("No alert types are shared…") instead of a bare "No open
// alerts" that reads as broken. Pure projection over the merged alert settings.
function anyAlertSharedWithInvigilator(settings) {
  const proctor = settings?.proctor || {};
  return Object.values(proctor).some((entry) => entry && entry.show_to_invigilator === true);
}

// Recorder states that mean "not recording" for the heartbeat sure-shot.
const STOPPED_RECORDING_STATES = new Set(["stopped", "inactive", "ended", "error"]);

// B2: the recorder sends a COMPOSITE recording_state like
//   "combined:inactive;screen:stopped;camera:recording;microphone:stopped"
// (one segment per media track). The sure-shot fires when the CORE capture
// (the combined MediaRecorder or the screen track) is not recording — a stopped
// camera/microphone alone is not a recording_stopped signal. A bare legacy
// string ("stopped") is still honoured for backward compatibility.
function isRecordingStopped(recordingState) {
  const raw = String(recordingState || "").toLowerCase().trim();
  if (!raw) return false;
  if (raw.includes(":")) {
    const segments = parseRecordingStateSegments(raw);
    // Only the core capture tracks gate the sure-shot. If the payload doesn't
    // name them (unexpected shape), fall back to "any segment stopped".
    const core = ["combined", "screen"].filter((key) => key in segments);
    const gates = core.length ? core.map((key) => segments[key]) : Object.values(segments);
    return gates.some((state) => STOPPED_RECORDING_STATES.has(state));
  }
  return STOPPED_RECORDING_STATES.has(raw);
}

function parseRecordingStateSegments(raw) {
  const segments = {};
  for (const part of raw.split(";")) {
    const [key, value] = part.split(":");
    if (key && value !== undefined) segments[key.trim()] = value.trim();
  }
  return segments;
}

// F6.6: project the persisted composite recording_state (the heartbeat already
// stores the recorder's "combined:X;screen:Y;camera:Z;microphone:W" on the
// session doc) into a STRUCTURED per-source capture state for the admin
// surfaces — the session detail card and the recordings-review header. Camera
// and microphone matter here because the recorded webm is the DIRECT screen
// stream + mixed mic audio; the camera is live-monitor only and is never part
// of the recorded video, so the admin needs the per-source truth to know what
// a recording contains. Returns null for legacy bare strings ("recording") or
// missing state; an unexpected segment value projects as "unknown" so raw
// client input never leaks through.
const CAPTURE_SOURCES = ["screen", "camera", "microphone"];
const CAPTURE_SOURCE_STATES = new Set(["inactive", "recording", "stopped", "error", "permission_denied", "unavailable"]);

function parseCaptureState(recordingState) {
  const raw = String(recordingState || "").toLowerCase().trim();
  if (!raw.includes(":")) return null;
  const segments = parseRecordingStateSegments(raw);
  if (!CAPTURE_SOURCES.some((source) => source in segments)) return null;
  const state = {};
  for (const source of CAPTURE_SOURCES) {
    const value = segments[source];
    state[source] = CAPTURE_SOURCE_STATES.has(value) ? value : "unknown";
  }
  return state;
}

// F5.4: a debounced switch-away episode is alert-worthy when it is LONG
// (>= the admin-configurable tab_away threshold) or FREQUENT (this many
// distinct switch-away excursions inside one rolling episode window — the
// client reducer counts not-away → away transitions, so one tab switch's
// blur+hidden signal pair is ONE, wave-3 fix).
const SWITCH_AWAY_FREQUENT_COUNT = 3;

async function raiseSureShotAlertsFromEvents(session, events, settings) {
  // Collapse repeats within this single batch: one alert per sure-shot type per
  // batch (the per-day dedupe in upsertProctorAlert keeps it stable across
  // batches too). Walk in order so we keep the latest timestamp for the type.
  const seen = new Map();
  for (const event of events) {
    const spec = SURE_SHOT_EVENT_TYPES[event.type];
    if (!spec) continue;
    seen.set(event.type, { event, spec });
  }
  for (const { event, spec } of seen.values()) {
    // Consult the per-type proctor alert settings: skip a disabled type and use
    // the configured severity (default = the spec's built-in severity).
    const config = alertTypeConfig(settings, event.type, spec.severity);
    if (!config.enabled) continue;
    const timestamp = isoOrNow(event.timestamp);
    await upsertProctorAlert(session, {
      type: event.type,
      severity: config.severity,
      timestamp,
      title: spec.title,
      detail: detailFromEvent(event),
      dedupe: timestamp.slice(0, 10),
      data: event.detail && typeof event.detail === "object" ? event.detail : undefined
    });
  }

  await raiseSwitchAwayAlerts(session, events, settings);
}

// F5.4: switch_away_episode events (the client's debounced window_blur /
// visibility runs) surface through the EXISTING threshold-based tab_away alert
// so proctors review the video and decide — switch-away NEVER auto-blocks.
// The per-session switch_away exemption suppresses the alert only; the raw
// episode event still lands in evidence storage (recordEvents already wrote it).
async function raiseSwitchAwayAlerts(session, events, settings) {
  if (sanitizeExemptions(session.enforcement_exemptions).switch_away === true) return;
  const config = alertTypeConfig(settings, "tab_away", "warning");
  if (!config.enabled) return;
  const thresholdMs = (config.threshold_seconds || TAB_AWAY_DEFAULT_THRESHOLD_SECONDS) * 1000;
  for (const event of events) {
    if (event.type !== "switch_away_episode") continue;
    const detail = event.detail && typeof event.detail === "object" ? event.detail : {};
    const durationMs = Math.max(0, intOrZero(detail.duration_ms));
    const count = Math.max(0, intOrZero(detail.count));
    if (durationMs < thresholdMs && count < SWITCH_AWAY_FREQUENT_COUNT) continue;
    await upsertProctorAlert(session, {
      type: "tab_away",
      severity: config.severity,
      timestamp: isoOrNow(event.timestamp),
      title: "Switched away from the exam",
      detail: `Away ~${Math.round(durationMs / 1000)}s across ${count} switch(es)`,
      // Per-minute dedupe (not per-day): distinct long episodes should each be
      // visible; same-minute retries still collapse. Wave-3 fix: keyed on
      // SERVER time — the event timestamp is client-supplied, so a pinned
      // stamp could silence every future episode (or spoofed ones could fan
      // a single batch into many alerts).
      dedupe: new Date().toISOString().slice(0, 16),
      data: { count, duration_ms: durationMs }
    });
  }
}

function detailFromEvent(event) {
  if (event.detail && typeof event.detail === "object") {
    const reason = event.detail.reason || event.detail.message || event.detail.surface;
    if (reason) return String(reason).slice(0, 2000);
  }
  return undefined;
}

// Upsert a source:'proctor' alert into ALERTS_COLLECTION using the same
// idempotent id convention as Phase-1 ingest:
//   <source>:<type>:<username_norm>:<contest_slug>:<dedupe>
// so retries / repeated heartbeats collapse to one document. Attaches video_key
// (merged output if present, else the raw screen chunk prefix) for deep-linking.
async function upsertProctorAlert(session, { type, severity, timestamp, title, detail, dedupe, data }) {
  const usernameNorm = session.username_norm;
  const contestSlug = session.contest_slug || "_";
  const id = `proctor:${type}:${usernameNorm}:${contestSlug}:${dedupe}`;
  const now = new Date().toISOString();

  // S-C: person-path sessions carry candidate_id instead of
  // hackerrank_username — the dual-read adapter keeps the frozen field
  // populated with the display id either way (never undefined).
  const displayId = candidateOf(session).id;
  const item = {
    id,
    source: "proctor",
    type,
    severity,
    timestamp: isoOrNow(timestamp),
    hackerrank_username: session.hackerrank_username !== undefined ? session.hackerrank_username : displayId,
    candidate_id: displayId,
    username_norm: usernameNorm,
    title,
    session_id: session.session_id,
    received_at: now
  };
  if (session.contest_slug) item.contest_slug = session.contest_slug;
  if (session.room) item.room = session.room;
  if (detail) item.detail = String(detail).slice(0, 2000);
  if (data && typeof data === "object") item.data = sanitizeObject(data);

  const videoKey = sureShotVideoKey(session);
  if (videoKey) item.video_key = videoKey;

  await alertRef(id).set(item, { merge: true });
  return item;
}

// Deep-link target for a sure-shot alert: the merged review video the worker
// wrote back onto the session doc (merged_video_key) once a merge succeeded.
// B4: if no merged video exists yet, return null rather than a `…/screen/`
// FOLDER prefix — a folder prefix signs a nonexistent object and renders a
// broken link. With null, the console simply hides the link until the merge
// runs and merged_video_key is populated.
function sureShotVideoKey(session) {
  return session.merged_video_key || null;
}

// isoOrNow moved to lib/sanitize.mjs (decomp B0); imported at the top.

const ALERT_SOURCES = ["proctor", "contest-eval"];
const ALERT_SEVERITIES = ["critical", "warning", "info"];
const ALERT_VERDICT_STATUSES = ["pending", "real", "false_positive", "inconclusive"];
const ALERT_REQUIRED_FIELDS = ["source", "type", "severity", "timestamp", "hackerrank_username", "title"];

async function ingestAlerts(req) {
  requireApiKey(req);
  const body = parseBody(req);
  const rawAlerts = Array.isArray(body?.alerts) ? body.alerts : [body];
  if (!rawAlerts.length) return badRequest("No alerts provided");
  if (rawAlerts.length > 500) return badRequest("Too many alerts in one request (max 500)");

  const now = new Date().toISOString();
  const normalized = rawAlerts.map((alert, index) => normalizeAlert(alert, index, now));

  // Idempotent merge keyed on alert.id so retried deliveries do not duplicate.
  await Promise.all(normalized.map((alert) => alertRef(alert.id).set(alert, { merge: true })));

  return { ok: true, ingested: normalized.length, ids: normalized.map((alert) => alert.id) };
}

function normalizeAlert(alert, index, receivedAt) {
  if (!alert || typeof alert !== "object" || Array.isArray(alert)) {
    throw httpError(400, `alerts[${index}] must be an object`);
  }
  // S-C (F9 §1.2): ingest accepts candidate_id as an alias for the frozen
  // hackerrank_username field FOREVER — the poller fleet upgrades lazily.
  if ((alert.hackerrank_username === undefined || alert.hackerrank_username === null || alert.hackerrank_username === "")
      && alert.candidate_id !== undefined && alert.candidate_id !== null && alert.candidate_id !== "") {
    alert = { ...alert, hackerrank_username: alert.candidate_id };
  }
  for (const field of ALERT_REQUIRED_FIELDS) {
    const value = alert[field];
    if (value === undefined || value === null || value === "") {
      throw httpError(400, `alerts[${index}].${field} is required`);
    }
  }
  if (!ALERT_SOURCES.includes(alert.source)) {
    throw httpError(400, `alerts[${index}].source must be one of ${ALERT_SOURCES.join(", ")}`);
  }
  if (!ALERT_SEVERITIES.includes(alert.severity)) {
    throw httpError(400, `alerts[${index}].severity must be one of ${ALERT_SEVERITIES.join(", ")}`);
  }
  if (Number.isNaN(Date.parse(alert.timestamp))) {
    throw httpError(400, `alerts[${index}].timestamp must be a valid ISO 8601 date`);
  }

  const username = String(alert.hackerrank_username).trim();
  const usernameNorm = alert.username_norm ? normalizeUsername(alert.username_norm) : normalizeUsername(username);
  // Derive a stable, deterministic id when the client did not supply one so the
  // doc id stays idempotent across retries instead of minting a random UUID.
  const id = alert.id !== undefined && alert.id !== null && alert.id !== ""
    ? String(alert.id)
    : `${alert.source}:${alert.type}:${usernameNorm}:${alert.contest_slug || "_"}:${alert.timestamp}`;

  const item = {
    id,
    source: String(alert.source),
    type: String(alert.type),
    severity: String(alert.severity),
    timestamp: String(alert.timestamp),
    hackerrank_username: username,
    candidate_id: username, // S-C dual-field: same display id under both names
    username_norm: usernameNorm,
    title: String(alert.title),
    received_at: receivedAt
  };

  if (alert.contest_slug) item.contest_slug = String(alert.contest_slug);
  if (alert.session_id) item.session_id = String(alert.session_id);
  if (alert.room) item.room = String(alert.room);
  if (alert.detail) item.detail = String(alert.detail);
  if (alert.data && typeof alert.data === "object") item.data = sanitizeObject(alert.data);
  if (alert.video_key) item.video_key = String(alert.video_key);
  if (alert.verdict && typeof alert.verdict === "object") {
    item.verdict = normalizeVerdict(alert.verdict);
  }

  // download_url is resolved on read and never persisted.
  return item;
}

function normalizeVerdict(verdict) {
  const status = ALERT_VERDICT_STATUSES.includes(verdict.status) ? verdict.status : "pending";
  const out = { status };
  if (verdict.reason) out.reason = String(verdict.reason).slice(0, 2000);
  if (verdict.by) out.by = String(verdict.by).slice(0, 200);
  return out;
}

async function adminAlerts(req) {
  requireAdmin(req);
  const scope = await contestScopeOf(req.query?.contest_slug);
  const severity = req.query?.severity;
  const source = req.query?.source;
  const room = normalizeRoomFilter(req.query?.room);
  const includeArchived = isTruthyParam(req.query?.include_archived);

  // B6: applying ALL THREE equality filters server-side (contest_slug + severity
  // + source) would need a composite Firestore index that doesn't exist. To stay
  // index-free (lower risk than relying on a deployed composite index), we push
  // AT MOST ONE equality filter to Firestore — the most selective, contest_slug —
  // and filter the remaining fields in memory. ALERTS_QUERY_LIMIT bounds the scan.
  let query = getFirestore().collection(ALERTS_COLLECTION);
  if (scope !== ALL_CONTESTS) {
    query = scopedQuery(query, scope);
  } else {
    // Zero-alerts bug (2026-06-10 investigation, root cause #1): without an
    // orderBy, Firestore fills the limit() window in DOC-ID order, so a
    // bulk-archived pile whose ids sort first (contest-eval:first_attempt_solve:*)
    // crowds every live alert out of the scan BEFORE the in-memory archived
    // filter runs. Order newest-first so the window always holds the most
    // recent docs. The archived filter STAYS in memory: legacy docs omit the
    // field, so an `archived == false` equality would drop live legacy alerts.
    // Single-field orderBy rides the automatic index; combining it with the
    // contest_slug equality filter above WOULD need a composite index, so the
    // contest-scoped branch keeps the bare (index-free) scan.
    query = query.orderBy("timestamp", "desc");
  }

  const snapshot = await query.limit(ALERTS_QUERY_LIMIT).get();
  const alerts = snapshot.docs
    .map((doc) => doc.data())
    .filter((alert) => !severity || alert.severity === String(severity))
    .filter((alert) => !source || alert.source === String(source))
    .filter((alert) => !room || String(alert.room || "") === room)
    // Archive: exclude archived alerts by default; include them only when the
    // caller opts in with include_archived=true. A missing `archived` field on a
    // legacy doc is treated as not-archived.
    .filter((alert) => includeArchived || !alert.archived)
    .sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")))
    .slice(0, ALERTS_QUERY_LIMIT);

  const withUrls = await Promise.all(alerts.map(async (alert) => {
    if (!alert.video_key) return { ...alert, download_url: null };
    const downloadUrl = await resolveSignedReadUrl(alert.video_key);
    return { ...alert, download_url: downloadUrl };
  }));

  // Distinct rooms come from the SESSION docs (capped) so the console dropdown
  // lists every room, not just rooms that happen to have an alert. Scoped to the
  // same contest as the alerts query.
  const rooms = await listSessionRooms(scope);

  return { alerts: withUrls, rooms };
}

// Distinct room labels across session docs in the given RESOLVED contest scope
// (ALL_CONTESTS for unscoped), capped. Shared by adminAlerts so its room
// dropdown matches adminStats'.
async function listSessionRooms(scope) {
  const snapshot = await scopedQuery(getFirestore().collection(SESSION_COLLECTION), scope)
    .limit(SESSIONS_QUERY_LIMIT)
    .get();
  return distinctRooms(snapshot.docs.map((doc) => doc.data()));
}

// isTruthyParam moved to lib/http.mjs (decomp B0); imported at the top.

// ---- Alert archive (admin) -------------------------------------------------
//
// Toggle the `archived` flag on a set of alert docs. The frontend calls this
// after a session approve to also-archive that session's alerts, and from a
// manual archive/unarchive control. archived alerts are hidden from
// GET /api/admin/alerts unless include_archived=true.
async function adminAlertAction(req) {
  requireAdmin(req);
  const body = parseBody(req);
  const action = String(body.action || "");
  if (!["archive", "unarchive"].includes(action)) {
    return badRequest("action must be archive or unarchive");
  }
  const ids = Array.isArray(body.ids) ? body.ids.filter((id) => id !== undefined && id !== null && id !== "") : [];
  if (!ids.length) return badRequest("ids[] must be a non-empty array of alert ids");

  const archived = action === "archive";
  const now = new Date().toISOString();
  const updated = [];
  const missing = [];
  for (const rawId of ids) {
    const id = String(rawId);
    // merge:true so we only touch the archive fields and never clobber the rest
    // of the alert doc. Skip ids that don't exist so a stale id can't 500 the
    // whole batch — report them back so the console can surface it.
    const ref = alertRef(id);
    const doc = await ref.get();
    if (!doc.exists) {
      missing.push(id);
      continue;
    }
    await ref.set({ archived, archived_at: archived ? now : null }, { merge: true });
    updated.push(id);
  }

  return { ok: true, action, archived, updated, missing };
}

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
// the top); gateRoomKey + getRoomGate come back too so the still-resident
// session routes (sessionRoomGate / sessionUnlockGate) reuse them.

// POST /api/session/room-gate — candidate-side gate poll/unlock. Auth = the
// unguessable session token (like /api/events), never admin auth. With no
// `code` it is a cheap status poll (the client re-polls ~5 s, so an invigilator
// start-now admits candidates with ZERO typing); with a `code` it attempts the
// room OTP. Recording/events/heartbeats are deliberately NOT gated — a
// candidate "waiting" is still recorded. The attempt cap is checked BEFORE the
// compare so a capped session stays capped even with the right code.
async function sessionRoomGate(req) {
  const body = parseBody(req);
  requireFields(body, ["session_id"]);
  const session = requireWritableSession(await getSession(String(body.session_id)));
  // The gate FLAG follows the session's contest (person contests own
  // room_gate_enabled as an S-I snapshot field); the gate DOC below is
  // per-(contest_slug, room). An orphaned session (no current contest) is
  // ungated.
  const contest = await personContestForSession(session);
  const gateEnabled = Boolean(contest?.room_gate_enabled);
  if (!gateEnabled) {
    return { gate_enabled: false, exam_started: true, exam_started_at: session.exam_started_at || null };
  }
  if (session.exam_started_at) {
    return { gate_enabled: true, exam_started: true, exam_started_at: session.exam_started_at };
  }
  const contestSlug = session.contest_slug || "";
  const roomKey = gateRoomKey(session.room);
  const gate = await getRoomGate(contestSlug, roomKey);
  const now = new Date().toISOString();

  if (gate && gate.mode === "open") {
    await sessionRef(session.session_id).update({ exam_started_at: now, exam_start_method: "room_open", updated_at: now });
    return { gate_enabled: true, exam_started: true, exam_started_at: now };
  }

  const code = body.code === undefined || body.code === null ? "" : String(body.code).trim();
  if (!code) {
    return { gate_enabled: true, exam_started: false, room: session.room || "" };
  }

  if (Number(session.gate_attempt_count || 0) >= GATE_ATTEMPT_LIMIT) {
    throw httpError(429, "too_many_attempts");
  }
  if (gate && gate.mode === "otp" && gate.otp && safeEqual(code, gate.otp)) {
    await sessionRef(session.session_id).update({ exam_started_at: now, exam_start_method: "otp", updated_at: now });
    return { gate_enabled: true, exam_started: true, exam_started_at: now };
  }
  await sessionRef(session.session_id).update({ gate_attempt_count: FieldValue.increment(1), updated_at: now });
  throw httpError(403, "invalid_code");
}

// ---- F5.3/F5.6: fullscreen enforcement violation + candidate unlock --------

const ENFORCEMENT_VIOLATION_PHASES = ["countdown_expired", "exit_limit"];
// ENFORCEMENT_LOCK_REASON moved UP to the non-env constants block (decomp B1) so
// the makeInvigilatorRoutes(ctx) factory call at module scope can pass it without
// hitting the const's temporal dead zone. Value unchanged.

// POST /api/session/enforcement-violation — the candidate client reports that
// the L1 ladder tripped (ack countdown expired, or the exit limit was
// exceeded). Auth = the unguessable session token, like /api/events. The
// SERVER decides the consequence from its own settings (never the client):
//   - exempt session            → no-op (the client raced a fresh exemption)
//   - always                    → critical fullscreen_enforcement alert
//   - enforcement_mode "block"  → lock the session (locked_reason
//     "fullscreen_enforcement"; release = room code via /api/session/unlock-gate
//     or an admin/invigilator unlock)
//   - "alert_first"             → alert only; the client holds the ack overlay.
async function sessionEnforcementViolation(req) {
  const body = parseBody(req);
  requireFields(body, ["session_id"]);
  const phase = String(body.phase || "");
  if (!ENFORCEMENT_VIOLATION_PHASES.includes(phase)) {
    return badRequest(`phase must be one of ${ENFORCEMENT_VIOLATION_PHASES.join(", ")}`);
  }
  const session = requireWritableSession(await getSession(String(body.session_id)));

  // Server-side exemption check is authoritative — a stale client that missed
  // the heartbeat exemption update can never lock an exempted candidate.
  const exemptions = sanitizeExemptions(session.enforcement_exemptions);
  if (exemptions.fullscreen === true) {
    return { ok: true, locked: false, exempt: true };
  }

  // The consequence follows the SESSION's config source — its person contest's
  // snapshot enforcement, or the normalized defaults for an orphaned session.
  const contest = await personContestForSession(session);
  const enforcement = enforcementConfigFor(contest);
  const exitCount = Math.max(0, intOrZero(body.exit_count));
  const alertSettings = await getAlertSettings();
  const { locked } = await applyEnforcementViolation(session, { phase, exitCount, enforcement, alertSettings });
  if (!locked) {
    return { ok: true, locked: false, mode: "alert_first" };
  }
  return { ok: true, locked: true, locked_reason: ENFORCEMENT_LOCK_REASON, mode: "block" };
}

// The single consequence of a tripped enforcement ladder — shared by the
// candidate's self-report (sessionEnforcementViolation) and the SERVER-SIDE
// reconciliation paths (recordEvents exit counting + heartbeat countdown).
// The alert is admin-configurable DISPLAY; disabling it never disables the
// block-mode lock (policy lives in enforcement_mode). Deduped per minute so a
// violate→unlock→violate sequence stays visible as distinct alerts — and so
// the honest client's report and the server's own derivation collapse into one.
async function applyEnforcementViolation(session, { phase, exitCount, enforcement, alertSettings, derived = false }) {
  const now = new Date().toISOString();
  const alertConfig = alertTypeConfig(alertSettings, "fullscreen_enforcement", "critical");
  if (alertConfig.enabled) {
    await upsertProctorAlert(session, {
      type: "fullscreen_enforcement",
      severity: alertConfig.severity,
      timestamp: now,
      title: "Fullscreen enforcement triggered",
      detail: phase === "exit_limit"
        ? `Exceeded the fullscreen exit limit (${exitCount} exits; limit ${enforcement.fullscreen_exit_limit})`
        : `Did not re-enter fullscreen within ${enforcement.fullscreen_reentry_seconds}s`,
      dedupe: now.slice(0, 16),
      data: { phase, exit_count: exitCount, mode: enforcement.mode, ...(derived ? { derived: "server" } : {}) }
    });
  }

  if (enforcement.mode === "alert_first") {
    return { locked: false };
  }

  await sessionRef(session.session_id).update({
    status: "locked",
    locked_at: now,
    locked_reason: ENFORCEMENT_LOCK_REASON,
    updated_at: now
  });
  return { locked: true };
}

// ---- F5.3 wave-2 review fix: SERVER-SIDE enforcement reconciliation ---------
//
// The candidate's enforcement-violation POST is only the FAST PATH: a client
// that blocks that single URL (or clears the localStorage ladder state) used to
// neutralize the hard block with zero server-side signal. The server now
// derives the same violations from evidence it already receives:
//   - recordEvents counts unexpected fullscreen_exit events per session
//     (fullscreen_exit_count) and tracks the open exit (fullscreen_out_since,
//     cleared by fullscreen_enter) → exceeding the exit limit escalates here;
//   - recordHeartbeat closes the countdown: an out-of-fullscreen span older
//     than reentry + grace escalates even when no further events arrive. The
//     heartbeat's `fullscreen` field is corrective truth — `true` clears a
//     stale out_since (lost enter event), `false` starts the clock when the
//     exit event itself was lost.
// Exempt sessions are skipped entirely; alert_first mode alerts without
// locking (policy parity with the self-report path).
const ENFORCEMENT_COUNTDOWN_GRACE_SECONDS = 15;

async function reconcileFullscreenEnforcement(session, events, alertSettings) {
  if (sanitizeExemptions(session.enforcement_exemptions).fullscreen === true) return;
  if (session.status !== "active") return;

  let unexpectedExits = 0;
  let outSince = session.fullscreen_out_since || null;
  let sawFullscreenEvent = false;
  for (const event of events) {
    if (event.type === "fullscreen_exit") {
      if (event.detail?.expected === true) continue;
      unexpectedExits += 1;
      if (!outSince) outSince = isoOrNow(event.timestamp);
      sawFullscreenEvent = true;
    } else if (event.type === "fullscreen_enter") {
      outSince = null;
      sawFullscreenEvent = true;
    }
  }
  if (!sawFullscreenEvent) return;

  const newCount = intOrZero(session.fullscreen_exit_count) + unexpectedExits;
  await sessionRef(session.session_id).update({
    fullscreen_exit_count: newCount,
    fullscreen_out_since: outSince,
    updated_at: new Date().toISOString()
  });
  if (!unexpectedExits) return;

  // Same config-source rule as the self-report path — the session's person
  // contest, or the normalized defaults for an orphaned session.
  const contest = await personContestForSession(session);
  const enforcement = enforcementConfigFor(contest);
  if (newCount > enforcement.fullscreen_exit_limit) {
    await applyEnforcementViolation(session, {
      phase: "exit_limit", exitCount: newCount, enforcement, alertSettings, derived: true
    });
  }
}

// Heartbeat-side countdown reconciliation. Returns "locked" when this call
// locked the session (so the heartbeat response reports the new status and the
// recorder self-stops on THIS interval), null otherwise. Takes the RESOLVED
// enforcement config (wave-4: contest-sourced for person sessions; the caller
// already resolved the session's config source).
async function reconcileEnforcementCountdown(session, body, enforcement, alertSettings) {
  if (sanitizeExemptions(session.enforcement_exemptions).fullscreen === true) return null;
  if (session.status && session.status !== "active") return null;
  const now = new Date().toISOString();
  const outSince = session.fullscreen_out_since || null;

  if (body.fullscreen === true) {
    // Corrective truth: back in fullscreen — clear a stale open exit.
    if (outSince) await sessionRef(session.session_id).update({ fullscreen_out_since: null, updated_at: now });
    return null;
  }
  if (body.fullscreen === false && !outSince) {
    // The exit event itself was lost — start the clock from heartbeat truth.
    await sessionRef(session.session_id).update({ fullscreen_out_since: now, updated_at: now });
    return null;
  }
  if (!outSince) return null;

  const deadlineMs = Date.parse(outSince)
    + (enforcement.fullscreen_reentry_seconds + ENFORCEMENT_COUNTDOWN_GRACE_SECONDS) * 1000;
  if (!Number.isFinite(deadlineMs) || Date.now() <= deadlineMs) return null;
  const { locked } = await applyEnforcementViolation(session, {
    phase: "countdown_expired",
    exitCount: intOrZero(session.fullscreen_exit_count),
    enforcement, alertSettings, derived: true
  });
  return locked ? "locked" : null;
}

// POST /api/session/unlock-gate — candidate-side release of an ENFORCEMENT
// lock using the room's dedicated UNLOCK code (gate.unlock_otp, minted via
// /api/invigilator/unlock-code — "call your room proctor"). Wave-2 review fix:
// NEVER the start OTP — every candidate in an OTP-gated room typed that code
// to begin, so accepting it here made the L2 lock self-serve. Admin locks
// (no/different locked_reason) are NOT code-releasable: they need an
// admin/invigilator unlock. Mirrors the room-gate attempt-cap pattern:
// NaN-guarded counter, checked BEFORE the compare so a capped session stays
// capped even with the right code. When NO unlock code has been minted there
// is nothing to brute-force, so the attempt does NOT burn toward the cap
// (distinct no_unlock_code error → the candidate UI says "ask your proctor").
// Deliberately consults the gate DOC regardless of room_gate_enabled — the
// unlock code releases a lock, it does not gate a start.
async function sessionUnlockGate(req) {
  const body = parseBody(req);
  requireFields(body, ["session_id", "code"]);
  const session = await getSession(String(body.session_id));
  if (session.status !== "locked" || session.locked_reason !== ENFORCEMENT_LOCK_REASON) {
    throw httpError(403, "not_enforcement_locked");
  }
  if (intOrZero(session.unlock_attempt_count) >= GATE_ATTEMPT_LIMIT) {
    throw httpError(429, "too_many_attempts");
  }
  const code = String(body.code).trim();
  const now = new Date().toISOString();
  const gate = await getRoomGate(session.contest_slug || "", gateRoomKey(session.room));
  if (!gate || !gate.unlock_otp) {
    throw httpError(403, "no_unlock_code");
  }
  if (code && safeEqual(code, gate.unlock_otp)) {
    await sessionRef(session.session_id).update({
      status: "active",
      unlocked_at: now,
      locked_reason: null,
      unlock_method: "room_code",
      // Wave-2: reset the server-side exit ladder (mirrors the client's
      // post-release reset — a later accident is L1 again, not an instant relock).
      fullscreen_exit_count: 0,
      fullscreen_out_since: null,
      // Wave-3: a successful unlock also clears the brute-force counter — wrong
      // tries from THIS lock must not creep a later re-lock toward the
      // permanent 429 cap (the proctor was in the loop; the slate is clean).
      unlock_attempt_count: 0,
      updated_at: now
    });
    return { ok: true, status: "active" };
  }
  await sessionRef(session.session_id).update({ unlock_attempt_count: FieldValue.increment(1), updated_at: now });
  throw httpError(403, "invalid_code");
}

// S3 gate enforcement for code execution: with the gate enabled, Run/Submit are
// blocked until the session was released (OTP / room open / admin turning the
// gate off). Deliberately NOT inside requireWritableSession — evidence writes
// (events, uploads, heartbeats) must keep flowing while the candidate waits.
async function requireExamStarted(session) {
  // S3 nit: once a session has been released (exam_started_at stamped) the gate
  // can never reject it — short-circuit BEFORE any contest read.
  // A person-contest session is gated by ITS contest's room_gate_enabled (S-I
  // snapshot field); an orphaned session (no current contest) is never gated.
  if (session.exam_started_at) return;
  const contest = await personContestForSession(session);
  if (Boolean(contest?.room_gate_enabled)) {
    throw httpError(403, "exam_not_started");
  }
}

// invigilatorRoom moved VERBATIM to the makeInvigilatorRoutes(ctx) factory in
// routes/invigilator.mjs (decomp B1); destructured at module scope so its
// dispatch line stays byte-identical (canaryIsolation).

// ---- Proctor alert settings (admin) ----------------------------------------
//
// GET returns the full per-type config (defaults merged with stored overrides)
// so the console can render a complete toggle list. POST upserts the doc; only
// known types and valid severities are persisted, and a missing/blank `enabled`
// falls back to the default so a partial payload can't corrupt the config.
async function adminGetAlertSettings(req) {
  requireAdmin(req);
  return await getAlertSettings();
}

async function adminSaveAlertSettings(req) {
  requireAdmin(req);
  const body = parseBody(req);
  const incoming = body && typeof body.proctor === "object" && body.proctor !== null ? body.proctor : {};

  // Normalize against the known type set + defaults so a bad/partial payload
  // can never persist an unknown type or an invalid severity.
  const merged = mergeAlertSettings(incoming);
  const now = new Date().toISOString();
  await getFirestore().collection(SETTINGS_COLLECTION).doc(ALERT_SETTINGS_ID).set({
    proctor: merged.proctor,
    updated_at: now
  });
  return merged;
}

// resolveSignedReadUrl moved to lib/clients.mjs (decomp B0); imported at the top.

function alertRef(alertId) {
  return getFirestore().collection(ALERTS_COLLECTION).doc(String(alertId));
}

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
// A session bound to a person contest serves the CONTEST's snapshot-copied
// enforcement/camera_recording/screen_markers fields. `contest` is the resolved
// person contest, or null for an orphaned session doc that no longer resolves to
// a current contest — in which case the template normalizers produce the
// NORMALIZED DEFAULTS (their NaN guards keep a corrupt contest doc from ever
// stranding candidates either).
function enforcementConfigFor(contest) {
  return normalizeTemplateEnforcement(contest?.enforcement);
}

function cameraRecordingConfigFor(contest) {
  return normalizeTemplateCameraRecording(contest?.camera_recording);
}

function screenMarkersConfigFor(contest) {
  return normalizeTemplateScreenMarkers(contest?.screen_markers);
}

// Per-session enforcement exemptions (F5.5): ONLY the known keys, ONLY real
// booleans — everything else is dropped so client/admin payloads can never
// stash arbitrary data on the session doc.
const ENFORCEMENT_EXEMPTION_KEYS = ["fullscreen", "switch_away"];

function sanitizeExemptions(input) {
  const out = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  for (const key of ENFORCEMENT_EXEMPTION_KEYS) {
    if (typeof input[key] === "boolean") out[key] = input[key];
  }
  return out;
}

// NaN-guarded attempt counter read (room-gate + unlock-gate cap pattern): a
// corrupt stored value reads as 0 — the cap can then re-accumulate, but a
// legitimate candidate is never spuriously locked out by bad data.
function intOrZero(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

// isHttpUrl moved to lib/http.mjs; normalizeUsername/sanitizeSegment/
// sanitizeObject/sanitizeEditorDetail/getClientIp/normalizeIp/hashPasscode/
// maskPasscode moved to lib/sanitize.mjs (decomp B0); imported at the top.

// http transport helpers (badRequest/httpError/httpErrorWith/positiveIntOr/
// setCors/send) moved to lib/http.mjs (decomp B0); imported at the top.
