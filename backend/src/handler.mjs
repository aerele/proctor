import { randomInt, randomUUID } from "node:crypto";
import { FieldValue, FieldPath } from "@google-cloud/firestore";
import { makeExecQueue } from "./execQueue.mjs";
import { bucket, configureClients, getFirestore, judge0, putJsonl, resolveSignedReadUrl } from "./lib/clients.mjs";
import { badRequest, httpError, httpErrorWith, isHttpUrl, isTruthyParam, parseBody, requireFields, requireValidEmail, send, setCors } from "./lib/http.mjs";
import { getClientIp, hashPasscode, isoOrNow, mapWithConcurrency, maskEmail, maskPasscode, normalizeIp, normalizeUsername, safeEqual, sanitizeEditorDetail, sanitizeObject, sanitizeRoom, sanitizeSegment } from "./lib/sanitize.mjs";
import { makeAuth } from "./lib/auth.mjs";
import { makeSessionStore } from "./lib/sessionStore.mjs";
import { makeInvigilatorRoutes } from "./routes/invigilator.mjs";
import { loadConfig } from "./config.mjs";
import { configureProblemStore, getBankProblem, getProblem, isValidProblemId, LANGUAGE_IDS, scoreSubmission, validateProblemInput } from "./problems.mjs";
import { ALL_CONTESTS, applyContestExamTime, configureContestStore, createContest, listContests, regenerateContestSecret, resolveAccessCode, resolveContest, scopedQuery, setContestAccessCode, setContestStatus, slugify, updateContest } from "./contests.mjs";
import { adoptContestIntoPersonModel, applySelectionTransition, configureIdentityStore, findContestRosterEntries, getCollegeNameMap, getContestRosterMeta, getContestRosterSummary, getPersonById, getPersonsByIds, identityNorm, listAllPersons, listColleges, listEnrollments, listEnrollmentsForPerson, rosterMetaIdFor, saveContestRoster, stampSelectionDone, writeAudit } from "./identity.mjs";
import { configureTemplateStore, getTemplate, listTemplates, normalizeProblemEntries, normalizeTemplateCameraRecording, normalizeTemplateEnforcement, structuredCloneTemplate, validateTemplateInput, SEED_TEMPLATES, TEMPLATE_BOUNDS } from "./templates.mjs";
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

// All env-derived configuration is read by config.mjs's loadConfig() and
// destructured here at handler module scope (decomp B0). Because each test
// imports the handler with a fresh ?<buster>, this destructure re-runs per
// instance and captures the env the test set just before that import — the
// capture-at-load contract the ?buster isolation depends on. process.env now
// appears ONLY in handler.mjs (this call) and config.mjs (env-lint guard).
const {
  SESSION_COLLECTION, SETTINGS_COLLECTION, ALERTS_COLLECTION, SUBMISSION_EVENTS_COLLECTION,
  LIVE_LOCK_COLLECTION, REVIEW_STATE_COLLECTION, REVIEW_COLLECTION, REVIEW_CLAIMS_COLLECTION,
  SUBMISSIONS_COLLECTION, PROBLEMS_COLLECTION, EDITOR_EVENTS_COLLECTION, ROSTER_COLLECTION,
  ROOM_GATES_COLLECTION, CONTESTS_COLLECTION, COLLEGES_COLLECTION, PERSONS_COLLECTION,
  ENROLLMENTS_COLLECTION, ADMIN_AUDIT_COLLECTION, TEMPLATES_COLLECTION,
  EVIDENCE_BUCKET, JUDGE0_BASE_URL, JUDGE0_MODE, JUDGE0_API_KEY, JUDGE0_AUTH_TOKEN,
  URL_EXPIRY_SECONDS, ADMIN_PASSWORD, INVIGILATOR_PASSWORD, ALERTS_INGEST_API_KEY,
  RETENTION_SWEEP_API_KEY, EDITOR_EVENTS_INGEST_LIMIT, EXEC_RUN_COOLDOWN_SECONDS,
  EXEC_SUBMIT_COOLDOWN_SECONDS, EXEC_MAX_SUBMISSIONS_PER_SESSION, EXEC_RUN_CONCURRENCY,
  EXEC_SUBMIT_CONCURRENCY, EXEC_POLL_CONCURRENCY, EXEC_MAX_QUEUE, DISCONNECTED_STALENESS_MS,
  PUBLIC_APP_ORIGIN, GATE_ATTEMPT_LIMIT
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
// S2 roster (compulsory roster login). One ACTIVE roster, global (like the
// "active" settings doc). Meta lives in SETTINGS_COLLECTION under a distinct
// doc id (mirrors ALERT_SETTINGS_ID); entries live in ROSTER_COLLECTION, one
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
const SESSIONS_QUERY_LIMIT = 2000;
// S-J: the Results rollup scans a contest's submissions (one doc per submit).
// A heavy multi-problem hall (5000 candidates × N problems × a few submits)
// stays comfortably under this cap; bounded so a pathological contest can't
// blow the request.
const SUBMISSIONS_RESULTS_LIMIT = 50000;
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
const SETTINGS_ID = "active";
// Settings doc id for the per-type proctor alert configuration (enabled +
// severity). Lives in the same SETTINGS_COLLECTION but under a distinct doc id
// so it never collides with the schedule/contest "active" settings doc.
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
  judge0Config: {
    baseUrl: JUDGE0_BASE_URL, mode: JUDGE0_MODE,
    apiKey: JUDGE0_API_KEY, authToken: JUDGE0_AUTH_TOKEN
  }
});

// S4: wire the problem bank to THIS module's Firestore handle. A getter (not
// the instance) so __setClientsForTest fakes propagate to problem reads too.
configureProblemStore({ getFirestore, collection: PROBLEMS_COLLECTION });

// S-B (SHIPS DARK): contests collection + scoping chokepoints. Same getter
// pattern; the settings collection/id let contests.mjs synthesize the
// READ-ONLY legacy contest from the "active" doc (F9 §6). No production
// candidate/session path reads contests yet — only the admin CRUD below.
configureContestStore({
  getFirestore,
  collection: CONTESTS_COLLECTION,
  settingsCollection: SETTINGS_COLLECTION,
  settingsId: SETTINGS_ID,
  // Wave-4 fix: createContest probes these for ORPHANED data carrying a
  // candidate slug (historic legacy contest_slug values from earlier exam
  // runs) and walks to the next suffix instead of adopting the slug.
  dataCollections: [SESSION_COLLECTION, SUBMISSIONS_COLLECTION, ALERTS_COLLECTION]
});

// S-C: the identity core (proctor_colleges / proctor_persons /
// proctor_enrollments + the per-contest roster pipeline). Same getter pattern.
// Only identity_mode:"person" contests ever route into it — the legacy global
// roster path below stays bit-for-bit.
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
  sessionCollection: SESSION_COLLECTION,
  settingsCollection: SETTINGS_COLLECTION,
  settingsId: SETTINGS_ID
});
const {
  sessionRef, settingsRef, getSession, getSessionOrNull, getSettings,
  requireWritableSession, contestSlugFromUrl, buildStoragePrefix, sessionPrefix, candidateOf
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
  getSettings,
  sessionRef,
  candidateOf,
  contestSlugFromUrl,
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
    if (req.method === "GET" && path === "/api/candidate-route") return send(res, 200, await publicCandidateRoute());
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
    if (req.method === "GET" && path === "/api/admin/settings") return send(res, 200, await adminGetSettings(req));
    if (req.method === "POST" && path === "/api/admin/settings") return send(res, 200, await adminSaveSettings(req));
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
    if (req.method === "POST" && path === "/api/admin/contest-selection") return send(res, 200, await adminContestSelection(req));
    if (req.method === "POST" && path === "/api/admin/contest-selection-done") return send(res, 200, await adminContestSelectionDone(req));
    if (req.method === "POST" && path === "/api/admin/contest-adopt") return send(res, 200, await adminContestAdopt(req));
    if (req.method === "POST" && path === "/api/admin/contest-export") return send(res, 200, await adminContestExport(req));
    if (req.method === "POST" && path === "/api/admin/contest-purge") return send(res, 200, await adminContestPurge(req));
    if (req.method === "POST" && path === "/api/admin/retention-sweep") return send(res, 200, await adminRetentionSweep(req));
    if (req.method === "GET" && path === "/api/admin/people") return send(res, 200, await adminPeople(req));
    if (req.method === "GET" && path === "/api/admin/person") return send(res, 200, await adminPerson(req));
    if (req.method === "POST" && path === "/api/admin/exam-time") return send(res, 200, await adminExamTime(req));
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

async function startSession(req) {
  let body = parseBody(req);
  // S-C: a start that names a REAL person-mode contest takes the person-layer
  // path (username_norm = person_id, server-side college resolution). Anything
  // else — no contest param, or the synthesized legacy contest — keeps today's
  // path below BIT-FOR-BIT (the S-C canary). The candidate-facing routing that
  // sends `contest` lands at S-D; until then only direct callers reach this.
  const personContest = await resolvePersonContestForStart(body);
  if (personContest) return startPersonSession(req, body, personContest);

  // Phase 2 (0.1): the entry passcode is gone. Start is gated only by the
  // contest time window + complete details. `proctor_passcode` is no longer
  // required (a client may still send it harmlessly; it is ignored).
  //
  // S-E (F8.2): the candidate identifier is no longer named "hackerrank_username"
  // as a REQUIRED input. The modern client sends `candidate_id`; older callers
  // still send `hackerrank_username`. We accept EITHER and synthesize the FROZEN
  // `hackerrank_username` field (vision §234: legacy read-only, never renamed —
  // it is the session key embedded in doc ids and GCS paths) from candidate_id
  // when only the modern field is present. This keeps legacy back-compat reads
  // intact while dropping HackerRank as user-facing required terminology.
  if ((body.hackerrank_username === undefined || body.hackerrank_username === null || body.hackerrank_username === "")
    && body.candidate_id !== undefined && body.candidate_id !== null && body.candidate_id !== "") {
    body = { ...body, hackerrank_username: body.candidate_id };
  }
  requireFields(body, ["hackerrank_username", "name", "roll_number"]);
  if (body.consent_accepted !== true) {
    return badRequest("Consent is required");
  }
  const settings = await validateProctorGate();

  // S2 roster gate: when a roster is configured, starting REQUIRES a roster
  // match, and mapped identity fields are overridden server-side from the
  // matched entry — client-typed values are ignored for those fields, so a
  // candidate can never start under an identity that is not on the roster.
  // (Runs before the session_id replay check too: a replayed start must still
  // carry a valid roster id; the client keeps it in form state.)
  const rosterMeta = await getRosterMeta();
  let rosterIdentity = null;
  let emailIsRosterMapped = false;
  if (rosterMeta) {
    if (!body.roster_unique_id) throw httpError(403, "roster_id_required");
    const entry = await findRosterEntry(rosterMeta, String(body.roster_unique_id));
    if (!entry) throw httpError(403, "not_on_roster");
    const mapping = rosterMeta.column_mapping || {};
    emailIsRosterMapped = Boolean(mapping.email);
    const fromRoster = (field) => (mapping[field] ? String(entry.fields?.[mapping[field]] || "") : "");
    // Spec §2.5: a MAPPED field is authoritative even when the student's cell
    // is blank — the client-typed value is IGNORED (empty string stored), never
    // silently substituted. Unmapped fields keep the typed value.
    const mappedOrTyped = (field) => (mapping[field] ? fromRoster(field) : String(body[field] ?? ""));
    rosterIdentity = {
      unique_id: entry.unique_id,
      name: mappedOrTyped("name"),
      email: mappedOrTyped("email"),
      roll_number: mappedOrTyped("roll_number"),
      // DELIBERATE EXCEPTION (on the morning-review list): hackerrank_username
      // keeps the typed fallback even when mapped-but-blank, because it is the
      // session key — storing "" would strand the candidate mid-exam with a
      // session no proctor tooling can match to a contest user.
      hackerrank_username: fromRoster("hackerrank_username") || String(body.hackerrank_username ?? "")
    };
  }

  // Wave-6 review (M2): the TYPED email is only validated when it is what gets
  // stored. On the roster path with a MAPPED email column the typed value is
  // discarded and replaced by the roster cell (spec §2.5 above), so gating its
  // format would 400 a non-official/replayed client over a field about to be
  // ignored — mirroring the client, which gates the typed email only in legacy/
  // person_open, never person_roster. Require + format-check the typed email
  // ONLY when it is the effective email (no roster, or email column unmapped).
  if (!emailIsRosterMapped) {
    requireFields(body, ["email"]);
    requireValidEmail(body);
  }

  // With a roster match the rosterIdentity value is used AS-IS (it may
  // legitimately be "" for a mapped-but-blank cell); otherwise the typed value.
  const identityOf = (field) => String((rosterIdentity ? rosterIdentity[field] : body[field]) ?? "").trim();

  const now = new Date().toISOString();
  const username = identityOf("hackerrank_username");
  const usernameNorm = normalizeUsername(username);
  const contestSlug = contestSlugFromUrl(settings.contest_url);
  const clientIp = getClientIp(req);

  // Resume / single-session reconciliation (Epic 2 + 0.3). A session token the
  // browser already holds wins: if the SAME session_id is replayed we return it
  // verbatim (idempotent resume, no re-collection of details). If a DIFFERENT
  // start arrives for a username_norm+contest_slug that already has an active
  // (or locked/pending) session, the new one is created as pending_approval so
  // two live sessions never run at once.
  const existingActive = await findLiveSessionFor(usernameNorm, contestSlug);

  if (body.session_id) {
    const replay = await getSessionOrNull(body.session_id);
    if (replay && replay.username_norm === usernameNorm && replay.contest_slug === (contestSlug || "")) {
      // Idempotent resume of a session this browser already owns.
      return startResponse(replay, settings);
    }
  }

  const sessionId = randomUUID();
  const room = body.room !== undefined && body.room !== null ? sanitizeRoom(body.room) : "";

  // H1 (TOCTOU fix): decide active-vs-pending ATOMICALLY by acquiring the
  // live-slot lock rather than trusting the `existingActive` pre-read (which is
  // racy: two concurrent starts can both read "no active session" and both go
  // active). acquireLiveSlot re-reads live sessions INSIDE the lock decision, so
  // exactly one concurrent start wins the slot. existingActive is still used as
  // a best-effort hint for the conflict pointer, but the authoritative
  // blocked_by id comes from the lock owner.
  const slot = await acquireLiveSlot(usernameNorm, contestSlug, sessionId);
  const status = slot.acquired ? "active" : "pending_approval";
  const blockedBy = slot.acquired
    ? null
    : (slot.ownerSessionId || (existingActive && existingActive.session_id) || null);

  const item = {
    session_id: sessionId,
    hackerrank_username: username,
    username_norm: usernameNorm,
    name: identityOf("name"),
    roll_number: identityOf("roll_number"),
    email: identityOf("email"),
    roster_unique_id: rosterIdentity ? rosterIdentity.unique_id : "",
    roster_verified: Boolean(rosterIdentity),
    room,
    contest_slug: contestSlug || "",
    // storage_prefix is the single source of truth for every per-session GCS
    // key. Persisting it here means per-chunk sites build keys with ZERO extra
    // Firestore reads (they already fetch the session doc).
    storage_prefix: buildStoragePrefix(contestSlug, usernameNorm, sessionId),
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
    // F10.1: the separate low-res camera stream's chunk counter (chunk_count
    // stays screen-only — the admin duration math depends on that).
    camera_chunk_count: 0,
    // F5.5: per-session enforcement exemptions — empty by default; set via the
    // admin session-action "exempt" or the invigilator exempt endpoint.
    enforcement_exemptions: {}
  };

  await sessionRef(sessionId).create(item);
  await putJsonl(`${item.storage_prefix}events/session.jsonl`, [{
    type: "session_started",
    timestamp: now,
    detail: { user_agent: req.get?.("user-agent") || req.headers?.["user-agent"] || "", start_ip: clientIp }
  }]);

  return startResponse(item, settings);
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

// The person-mode contest for a start body, or null → legacy path. A present-
// but-bogus contest is a HARD error (F9 §2.3.1: mandatory resolution kills the
// shared-empty-slug bleed hazard); the synthesized legacy contest falls through
// to the legacy path so today's exams are untouched.
async function resolvePersonContestForStart(body) {
  if (body.contest === undefined || body.contest === null || String(body.contest).trim() === "") {
    return null;
  }
  const contest = await resolveContest(String(body.contest).trim()); // 400 unknown_contest / 403 contest_not_open
  if (contest.legacy || contest.identity_mode !== "person") return null;
  return contest;
}

// Mirrors validateProctorGate, reading the CONTEST window (S5 semantics moved
// per-contest for person contests; the legacy settings window never gates them).
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
// overridden from the roster exactly like the legacy path's rosterIdentity.
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
    // No-roster person contest (vision §2.4): person_id:null — these sessions
    // never participate in multi-round linking (documented limitation). The
    // candidate types id + name + email (F9 §1.4).
    requireFields(body, ["name", "email"]);
    requireValidEmail(body);
    const typed = String(body.candidate_id ?? body.hackerrank_username ?? "").trim();
    if (!typed) return badRequest("candidate_id is required");
    identity = {
      person_id: null,
      college_norm: "",
      candidate_id: typed,
      username_norm: identityNorm(typed),
      roster_unique_id: "",
      roster_verified: false,
      name: String(body.name ?? "").trim(),
      email: String(body.email ?? "").trim(),
      roll_number: String(body.roll_number ?? "").trim()
    };
  }

  const now = new Date().toISOString();
  const clientIp = getClientIp(req);
  const contestSlug = contest.slug;
  const settings = await getSettings();

  // Same replay/lock mechanics as the legacy path (H1 unchanged, F9 D6).
  const existingActive = await findLiveSessionFor(identity.username_norm, contestSlug);
  if (body.session_id) {
    const replay = await getSessionOrNull(body.session_id);
    if (replay && replay.username_norm === identity.username_norm && replay.contest_slug === contestSlug) {
      return startResponse(replay, settings || {}, contest);
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
    enforcement_exemptions: {}
  };

  await sessionRef(sessionId).create(item);
  await putJsonl(`${item.storage_prefix}events/session.jsonl`, [{
    type: "session_started",
    timestamp: now,
    detail: { user_agent: req.get?.("user-agent") || req.headers?.["user-agent"] || "", start_ip: clientIp }
  }]);

  return startResponse(item, settings || {}, contest);
}

// The person-mode contest a stored session belongs to, or null → the response
// stays settings-driven (legacy sessions keep today's payload bit-for-bit).
// Only person-path docs (they carry candidate_id) ever resolve a contest here.
// NOT the same as contestForSession (S-I §3.2) below, which resolves ANY real
// contest doc for exec membership + the problems[] payload.
async function personContestForSession(session) {
  if (!session?.contest_slug || session.candidate_id === undefined) return null;
  try {
    const contest = await resolveContest(session.contest_slug, { requireOpen: false });
    return contest.legacy || contest.identity_mode !== "person" ? null : contest;
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
  const settings = await getSettings();
  const contest = await personContestForSession(session);
  return startResponse(session, settings || {}, contest);
}

// Shared start/resume payload so the browser always gets the same shape whether
// it just started, replayed a token, or resumed after reload. S4: async because
// it resolves the assigned problem's candidate-facing view from the bank.
// S-C: pass the session's PERSON-MODE contest to source the window/gate fields
// from the contest doc instead of the legacy settings doc (contest = null keeps
// every legacy payload bit-for-bit; the added candidate_id/identity_label keys
// are read-side additions the S-A frontend already accepts).
// S-I §3.4: serves the ORDERED problems[] (real contest doc when the session
// belongs to one — person-mode or not — else the legacy settings shim), the
// per-problem submissions summary (resume restores chips/totals) and the
// submit budget. `problem` stays as a one-release compatibility alias =
// problems[0] minus `order` (bit-for-bit with the pre-S-I shape for cached
// bundles).
async function startResponse(session, settings, contest = null) {
  const problemSource = contest || await contestForSession(session) || settings;
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
    // contest_url is DEAD for person contests (vision §2.7: URLs are derived).
    contest_url: contest ? "" : (settings?.contest_url || ""),
    // S3: tells the candidate client whether to hold at the room-code screen.
    room_gate_enabled: contest ? Boolean(contest.room_gate_enabled) : Boolean(settings?.room_gate_enabled),
    // F5.3/F5.5: enforcement knobs + this session's exemptions + why a locked
    // session is locked (the candidate unlock-code UI keys off the reason).
    // Wave-4 fix: person contests serve their OWN snapshot enforcement.
    enforcement: enforcementConfigFor(contest, settings),
    enforcement_exemptions: sanitizeExemptions(session.enforcement_exemptions),
    locked_reason: session.locked_reason || null,
    // S-I: person/real contests serve their OWN problems[] (the legacy
    // settings problem_id never leaks into them — problemSource above);
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
    // Wave-4 fix: person contests serve their OWN snapshot camera config.
    upload_config: { ...uploadConfig, camera: cameraRecordingConfigFor(contest, settings) },
    heartbeat_interval_seconds: 15,
    // S5: authoritative exam end time + the server clock at response time, so
    // the client shows a skew-corrected countdown from the very first response.
    // Person contests read their OWN window (S5 semantics moved per-contest).
    end_at: contest ? (contest.end_at || "") : (settings?.end_at || ""),
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

async function validateProctorGate() {
  const settings = await getSettings();
  if (!settings?.start_at || !settings?.end_at) {
    throw httpError(403, "Proctoring is not configured yet.");
  }

  const now = Date.now();
  const startAt = Date.parse(settings.start_at);
  const endAt = Date.parse(settings.end_at);
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || startAt >= endAt) {
    throw httpError(403, "Proctoring schedule is invalid.");
  }
  if (now < startAt) throw httpError(403, "Proctoring has not started yet.");
  if (now > endAt) throw httpError(403, "Proctoring has ended.");
  return settings;
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
  const [uploadUrl] = await bucket()
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
// entry's effective points. Every legacy shape — contest_slug "", the
// synthesized legacy contest, or a slug with no doc — takes today's path
// bit-for-bit: bank read only, bank/seed points (the legacy canary).
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
  const items = problem.sampleTests.map((t) => ({
    languageId, source, stdin: t.input, expectedOutput: t.expected,
    cpuTimeLimit: problem.cpuTimeLimit, memoryLimit: problem.memoryLimit
  }));
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

  const items = problem.hiddenTests.map((t) => ({
    languageId, source, stdin: t.input, expectedOutput: t.expected,
    cpuTimeLimit: problem.cpuTimeLimit, memoryLimit: problem.memoryLimit
  }));
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
  // change reaches every student within one interval — no reload. Costs one
  // extra settings read per heartbeat (the same doc the start gate reads).
  // Wave-4 fix: person-contest sessions source end_at AND enforcement from
  // THEIR contest doc (S-I snapshot fields), matching startResponse — the
  // global settings doc stays authoritative for legacy sessions only.
  const settings = await getSettings();
  const contest = await personContestForSession(session);
  const enforcement = enforcementConfigFor(contest, settings);

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
    end_at: contest ? (contest.end_at || "") : (settings?.end_at || ""),
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

async function adminGetSettings(req) {
  requireAdmin(req);
  return publicSettings(await getSettings());
}

async function adminSaveSettings(req) {
  requireAdmin(req);
  const body = parseBody(req);
  requireFields(body, ["start_at", "end_at"]);

  const startAt = new Date(body.start_at);
  const endAt = new Date(body.end_at);
  if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime()) || startAt.getTime() >= endAt.getTime()) {
    return badRequest("Start time must be before end time.");
  }

  const existing = await getSettings();
  const contestUrl = String(body.contest_url || "").trim();
  if (contestUrl && !isHttpUrl(contestUrl)) return badRequest("Contest URL must start with http:// or https://.");

  // S4: optional active-problem assignment ("" clears it). A non-empty id must
  // be servable to candidates RIGHT NOW (published bank doc or built-in seed),
  // so start/resume never advertise a dead problem id.
  const problemId = String(body.problem_id || "").trim();
  if (problemId && !(await getProblem(problemId))) {
    return badRequest("problem_id must reference a published problem");
  }

  // Phase 2 (0.1): passcodes are removed. They are no longer REQUIRED to save
  // settings, and start/end are gated only by the time window. We still persist
  // any passcode/end_code an older admin UI happens to send so the stored doc is
  // backward-compatible, but nothing reads the hashes anymore.
  const now = new Date().toISOString();
  const passcode = String(body.passcode || "");
  const endCode = String(body.end_code || "");
  if (passcode && passcode.length < 4) return badRequest("Passcode must be at least 4 characters.");
  if (endCode && endCode.length < 4) return badRequest("End code must be at least 4 characters.");

  // D1: once POST /api/admin/exam-time has adjusted the end time (stamped via
  // end_at_updated_at), the S5 endpoint OWNS end_at for the current exam
  // window. A Settings-form save posts back whatever end_at the form LOADED —
  // possibly minutes stale — so honoring it here would silently revert a live
  // extend/shorten/end-now. Rule: same start_at (same exam) + stamp present →
  // keep the stored end_at and the stamp, ignore body.end_at. A CHANGED
  // start_at is a new schedule: body.end_at applies and the stamp resets so
  // the next exam isn't shackled to the old exam's live adjustments.
  const sameWindowStart = Boolean(existing?.start_at) && Date.parse(existing.start_at) === startAt.getTime();
  const examTimeOwnsEnd = sameWindowStart && Boolean(existing?.end_at_updated_at);

  const item = {
    start_at: startAt.toISOString(),
    end_at: examTimeOwnsEnd ? existing.end_at : endAt.toISOString(),
    ...(examTimeOwnsEnd ? { end_at_updated_at: existing.end_at_updated_at } : {}),
    contest_url: contestUrl,
    contest_slug: contestSlugFromUrl(contestUrl),
    problem_id: problemId,
    // S3: opt-in room start gate (invigilator OTP / start-now). Default false.
    room_gate_enabled: body.room_gate_enabled === true,
    // F5.3: fullscreen enforcement knobs — NaN-guarded to their defaults so a
    // bad payload can never persist a value that strands candidates. Same rule
    // as rooms: an older admin UI that doesn't SEND a field preserves the
    // stored value rather than resetting it.
    fullscreen_reentry_seconds: intSettingOr(
      body.fullscreen_reentry_seconds !== undefined ? body.fullscreen_reentry_seconds : existing?.fullscreen_reentry_seconds,
      FULLSCREEN_REENTRY_DEFAULT_SECONDS, 1),
    fullscreen_exit_limit: intSettingOr(
      body.fullscreen_exit_limit !== undefined ? body.fullscreen_exit_limit : existing?.fullscreen_exit_limit,
      FULLSCREEN_EXIT_LIMIT_DEFAULT, 0),
    enforcement_mode: resolveEnforcementMode(
      body.enforcement_mode !== undefined ? body.enforcement_mode : existing?.enforcement_mode),
    // F10.1: camera-recording knobs — same rules as the enforcement fields:
    // invalid values fall back to the defaults (enabled / 10 fps / 640 w,
    // never 0), and an older admin UI that doesn't SEND the field preserves
    // the stored value rather than resetting it.
    camera_recording: normalizeCameraRecording(
      body.camera_recording !== undefined ? body.camera_recording : existing?.camera_recording),
    passcode_hash: passcode ? hashPasscode(passcode) : (existing?.passcode_hash || ""),
    passcode_preview: passcode ? maskPasscode(passcode) : (existing?.passcode_preview || ""),
    end_code_hash: endCode ? hashPasscode(endCode) : (existing?.end_code_hash || ""),
    end_code_preview: endCode ? maskPasscode(endCode) : (existing?.end_code_preview || ""),
    // S2: room labels for the student room dropdown. An older admin UI that
    // doesn't send rooms preserves the stored list.
    rooms: normalizeRooms(Array.isArray(body.rooms) ? body.rooms : existing?.rooms),
    updated_at: now
  };

  await settingsRef().set(item);
  return publicSettings(item);
}

// ---- S4: problem bank (admin authoring) ------------------------------------

function problemRef(id) {
  return getFirestore().collection(PROBLEMS_COLLECTION).doc(id);
}

async function adminListProblems(req) {
  requireAdmin(req);
  const snapshot = await getFirestore().collection(PROBLEMS_COLLECTION).limit(PROBLEMS_QUERY_LIMIT).get();
  const problems = snapshot.docs
    .map((doc) => doc.data())
    .map((p) => ({
      id: p.id,
      title: p.title || "",
      status: p.status || "draft",
      points: p.points ?? 100,
      scoring: p.scoring || "per_test",
      languages: p.languages || [],
      tags: Array.isArray(p.tags) ? p.tags : [], // S-I §1.2 (legacy docs → [])
      sample_count: (p.sampleTests || []).length,
      hidden_count: (p.hiddenTests || []).length,
      updated_at: p.updated_at || ""
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { problems };
}

async function adminGetProblem(req) {
  requireAdmin(req);
  const id = String(req.query?.id || "");
  if (!isValidProblemId(id)) return badRequest("invalid id");
  const doc = await problemRef(id).get();
  if (!doc.exists) throw httpError(404, "Problem not found");
  // S-I §5.3: surface what references this problem so the editor can render
  // the "Referenced by" line and pre-warn before delete/unpublish.
  const refs = findProblemReferences(id, await problemReferenceUniverse());
  // Full doc INCLUDING hiddenTests — admin-only surface.
  return {
    problem: doc.data(),
    references: {
      contests: refs.contests.map((contest) => contest.slug),
      templates: refs.templates.map((template) => template.slug)
    }
  };
}

// ---- S-I §1.4.3: live-reference guard ----------------------------------------
// Problem CONTENT stays live on contests (exec/start read the bank at serve
// time), so destructive bank edits must be guarded:
//   delete while referenced                  -> 409 problem_referenced
//   unpublish while CONTEST-referenced       -> 409 problem_referenced
//     (template-only references allow it — instantiation re-validates)
//   hiddenTests edit while an OPEN contest references it -> typed confirm
//     (body.confirm_live_edit === the problem id), else 409.

// Bounded pre-fetch for findProblemReferences: real contest docs (limit 500;
// archived filtered by the pure function) + templates with seeds merged. The
// synthesized LEGACY contest is deliberately absent — its settings doc keeps
// the original silent-clear branch below instead of a 409.
async function problemReferenceUniverse() {
  const [contestSnapshot, templates] = await Promise.all([
    getFirestore().collection(CONTESTS_COLLECTION).limit(CONTESTS_REFERENCE_LIMIT).get(),
    listTemplates()
  ]);
  return { contests: contestSnapshot.docs.map((doc) => doc.data()), templates };
}
const CONTESTS_REFERENCE_LIMIT = 500;

async function adminSaveProblem(req) {
  requireAdmin(req);
  const body = parseBody(req);
  const checked = validateProblemInput(body);
  if (!checked.ok) return badRequest(checked.error);
  const existing = await problemRef(checked.problem.id).get();
  // Guard comparisons run against doc-or-seed (a draft doc shadowing a
  // published seed IS an unpublish); created_at preservation stays doc-only.
  const current = existing.exists ? existing.data() : await getBankProblem(checked.problem.id);
  if (current) {
    const unpublishing = current.status === "published" && checked.problem.status === "draft";
    const hiddenChanged = JSON.stringify(current.hiddenTests || []) !== JSON.stringify(checked.problem.hiddenTests);
    if (unpublishing || hiddenChanged) {
      const refs = findProblemReferences(checked.problem.id, await problemReferenceUniverse());
      if (unpublishing && refs.contests.length) {
        throw httpErrorWith(409, "problem_referenced", {
          contests: refs.contests.map((contest) => contest.slug),
          templates: refs.templates.map((template) => template.slug)
        });
      }
      const openContests = refs.contests.filter((contest) => contest.status === "open");
      if (hiddenChanged && openContests.length && body.confirm_live_edit !== checked.problem.id) {
        throw httpErrorWith(409, "live_edit_confirmation_required", {
          contests: openContests.map((contest) => contest.slug)
        });
      }
    }
  }
  const now = new Date().toISOString();
  const item = {
    ...checked.problem,
    created_at: existing.exists ? (existing.data().created_at || now) : now,
    updated_at: now
  };
  await problemRef(item.id).set(item);
  return { ok: true, problem: item };
}

async function adminDeleteProblem(req) {
  requireAdmin(req);
  const body = parseBody(req);
  const id = String(body.id || "");
  if (!isValidProblemId(id)) return badRequest("invalid id");
  // S-I §1.4.3: references found -> 409, NO silent clearing of contest or
  // template assignments. (Replaces the old delete-clears-assignment rule.)
  const refs = findProblemReferences(id, await problemReferenceUniverse());
  if (refs.contests.length || refs.templates.length) {
    throw httpErrorWith(409, "problem_referenced", {
      contests: refs.contests.map((contest) => contest.slug),
      templates: refs.templates.map((template) => template.slug)
    });
  }
  await problemRef(id).delete();
  // LEGACY contest path only (spec §1.4.3): the SETTINGS doc assignment is
  // still silently cleared so legacy start/resume stop advertising a dead id.
  const settings = await getSettings();
  if (settings?.problem_id === id) {
    await settingsRef().set({ ...settings, problem_id: "", updated_at: new Date().toISOString() });
  }
  return { ok: true };
}

// ---- S-I §1.1/§2: proctor templates (admin CRUD) -----------------------------
// Thin glue over src/templates.mjs (validation + seed shadowing live there).
// Slug rules are the contest rules verbatim (slugify + -2 suffix, atomic
// .create() decides ownership); SEED slugs are skipped at create so a new
// template can never silently shadow the system-check preset.

function templateRef(slug) {
  return getFirestore().collection(TEMPLATES_COLLECTION).doc(slug);
}

const TEMPLATE_SLUG_COLLISION_LIMIT = 50;

// Every template problem entry must reference an EXISTING bank problem at save
// time. Drafts are fine in a template (spec §1.1) — instantiation re-validates
// published — so this reads through getBankProblem, never getProblem.
async function requireKnownProblems(entries) {
  const unknown = [];
  for (const entry of entries) {
    if (!(await getBankProblem(entry.problem_id))) unknown.push(entry.problem_id);
  }
  if (unknown.length) throw httpErrorWith(400, "unknown_problems", { problems: unknown });
}

async function createTemplateDoc(template) {
  const baseSlug = slugify(template.name);
  if (!baseSlug) throw httpError(400, "name must contain letters or digits");
  const now = new Date().toISOString();
  for (let n = 1; n <= TEMPLATE_SLUG_COLLISION_LIMIT; n++) {
    const slug = n === 1 ? baseSlug : `${baseSlug}-${n}`;
    if (Object.hasOwn(SEED_TEMPLATES, slug)) continue; // presets keep their slug
    const item = { slug, ...template, archived: false, created_at: now, updated_at: now };
    try {
      await templateRef(slug).create(item);
      return item;
    } catch (error) {
      if (isAlreadyExists(error)) continue;
      throw error;
    }
  }
  throw httpError(409, "slug_collision_limit");
}

// points per bank problem id for the list totals: one bounded collection read;
// per-id getBankProblem fallback catches seed problems (e.g. sum-two).
async function bankProblemPoints() {
  const points = new Map();
  const snapshot = await getFirestore().collection(PROBLEMS_COLLECTION).limit(PROBLEMS_QUERY_LIMIT).get();
  for (const doc of snapshot.docs) {
    const p = doc.data();
    points.set(p.id, p.points ?? 100);
  }
  return {
    async effectiveFor(entry) {
      if (entry.points !== null && entry.points !== undefined) return entry.points;
      if (points.has(entry.problem_id)) return points.get(entry.problem_id);
      const fallback = await getBankProblem(entry.problem_id);
      const value = fallback ? (fallback.points ?? 100) : 0; // dangling ref counts 0
      points.set(entry.problem_id, value);
      return value;
    }
  };
}

async function adminListTemplates(req) {
  requireAdmin(req);
  const [templates, bank] = await Promise.all([listTemplates(), bankProblemPoints()]);
  const rows = [];
  for (const template of templates) {
    const entries = template.problems || [];
    let totalPoints = 0;
    for (const entry of entries) totalPoints += await bank.effectiveFor(entry);
    rows.push({
      slug: template.slug,
      name: template.name,
      archived: Boolean(template.archived),
      preset: Boolean(template.preset),
      problem_count: entries.length,
      total_points: totalPoints,
      updated_at: template.updated_at || ""
    });
  }
  return { templates: rows };
}

async function adminGetTemplate(req) {
  requireAdmin(req);
  const template = await getTemplate(req.query?.slug);
  if (!template) throw httpError(404, "template_not_found");
  return { template };
}

async function adminCreateTemplate(req) {
  requireAdmin(req);
  const body = parseBody(req);
  const checked = validateTemplateInput(body);
  if (!checked.ok) return badRequest(checked.error);
  await requireKnownProblems(checked.template.problems);
  return { ok: true, template: await createTemplateDoc(checked.template) };
}

// Partial update. THE rule (same as contests): a rename NEVER re-slugs — the
// slug is referenced from contest provenance the moment one instantiates.
// Updating a seed slug MATERIALIZES a shadow doc (customize-the-preset flow).
async function adminUpdateTemplate(req) {
  requireAdmin(req);
  const body = parseBody(req);
  requireFields(body, ["slug"]);
  const existing = await getTemplate(body.slug);
  if (!existing) throw httpError(404, "template_not_found");
  const merged = {
    name: body.name !== undefined ? body.name : existing.name,
    description: body.description !== undefined ? body.description : existing.description,
    problems: body.problems !== undefined ? body.problems : existing.problems,
    defaults: {
      ...existing.defaults,
      ...(body.defaults && typeof body.defaults === "object" && !Array.isArray(body.defaults) ? body.defaults : {})
    }
  };
  const checked = validateTemplateInput(merged);
  if (!checked.ok) return badRequest(checked.error);
  if (body.problems !== undefined) await requireKnownProblems(checked.template.problems);
  const now = new Date().toISOString();
  const item = {
    slug: existing.slug,
    ...checked.template,
    archived: Boolean(existing.archived),
    created_at: existing.created_at || now,
    updated_at: now
  };
  await templateRef(item.slug).set(item);
  return { ok: true, template: item };
}

// Archived templates disappear from the instantiate picker but stay listed
// behind the UI toggle. Archiving a seed materializes its shadow doc too.
async function adminArchiveTemplate(req) {
  requireAdmin(req);
  const body = parseBody(req);
  requireFields(body, ["slug"]);
  if (typeof body.archived !== "boolean") return badRequest("archived must be a boolean");
  const existing = await getTemplate(body.slug);
  if (!existing) throw httpError(404, "template_not_found");
  const now = new Date().toISOString();
  const { preset: _preset, ...rest } = existing;
  const item = { ...rest, archived: body.archived, created_at: existing.created_at || now, updated_at: now };
  await templateRef(item.slug).set(item);
  return { ok: true, template: item };
}

// Clone verb = the §1.4 snapshot copy onto a NEW template doc: deep copy of
// problems + defaults, fresh slug from the (default "Copy of …") name, fresh
// timestamps, archived reset.
async function adminCloneTemplate(req) {
  requireAdmin(req);
  const body = parseBody(req);
  requireFields(body, ["slug"]);
  const existing = await getTemplate(body.slug);
  if (!existing) throw httpError(404, "template_not_found");
  const name = (String(body.name ?? "").trim() || `Copy of ${existing.name}`).slice(0, TEMPLATE_BOUNDS.NAME_MAX);
  const copy = structuredCloneTemplate(existing);
  const checked = validateTemplateInput({
    name, description: copy.description, problems: copy.problems, defaults: copy.defaults
  });
  if (!checked.ok) return badRequest(checked.error);
  return { ok: true, template: await createTemplateDoc(checked.template) };
}

// Hard delete (FIX-B2 #58): permanently removes an author-owned template doc.
// Archive is the soft-delete (the picker hides it but it stays listed); this is
// the explicit "remove it for good" verb the Templates tab needs. A BARE seed
// preset (no shadow doc — getTemplate returns preset:true) cannot be deleted —
// it has no doc and would just reappear in the list; deleting a MATERIALIZED
// shadow doc is allowed and simply restores the preset to its original form.
async function adminDeleteTemplate(req) {
  requireAdmin(req);
  const body = parseBody(req);
  requireFields(body, ["slug"]);
  const existing = await getTemplate(body.slug);
  if (!existing) throw httpError(404, "template_not_found");
  if (existing.preset) throw httpError(400, "template_preset_undeletable");
  await templateRef(existing.slug).delete();
  return { ok: true };
}

// ---- S-B: contests (F9 §2 / F10 §2.7) — SHIPS DARK ---------------------------
// Thin admin glue over src/contests.mjs (validation + slug/access-code minting
// + legacy synthesis live there). The synthesized legacy contest appears in
// the LIST only — the write endpoints 404 on it by construction. No candidate
// path is routed through any of this yet.

async function adminListContests(req) {
  requireAdmin(req);
  const includeArchived = ["1", "true"].includes(String(req.query?.include_archived ?? "").toLowerCase());
  return { contests: await listContests({ includeArchived }) };
}

async function adminCreateContest(req) {
  requireAdmin(req);
  const body = parseBody(req);
  let payload = body;
  if (body.template_slug !== undefined && body.template_slug !== null && String(body.template_slug).trim() !== "") {
    payload = await instantiateTemplatePayload(body);
  } else if (body.problems !== undefined && Array.isArray(body.problems) && body.problems.length) {
    // Direct problems[] (no template): same published-right-now rule.
    const checked = normalizeProblemEntries(body.problems);
    if (!checked.ok) return badRequest(checked.error);
    await requirePublishedProblems(checked.entries, "problems_unavailable");
  }
  return { ok: true, contest: await createContest(payload) };
}

// S-I §1.4.1: snapshot-on-instantiate — copy the template's problems[] and
// every defaults.* field onto the contest doc AS THE CONTEST'S OWN FIELDS.
// Body values win over template defaults (the create form pre-fills, the admin
// may edit before posting). duration_minutes only PREFILLS end_at; an explicit
// end_at always wins. Template edits after this moment change nothing.
async function instantiateTemplatePayload(body) {
  const template = await getTemplate(body.template_slug);
  if (!template) throw httpError(404, "template_not_found");
  if (template.archived) throw httpError(400, "template_archived");

  let entries = template.problems || [];
  if (body.problems !== undefined) {
    const checked = normalizeProblemEntries(body.problems);
    if (!checked.ok) return badRequest(checked.error);
    entries = checked.entries;
  }
  // §1.4.4: every entry must reference an existing PUBLISHED problem right now.
  await requirePublishedProblems(entries, "template_problems_unavailable");

  const defaults = template.defaults || {};
  let endAt = body.end_at;
  if ((endAt === undefined || endAt === null || endAt === "") && body.start_at) {
    const startMs = Date.parse(String(body.start_at));
    if (Number.isFinite(startMs)) {
      endAt = new Date(startMs + (defaults.duration_minutes ?? 120) * 60_000).toISOString();
    }
  }
  const pick = (bodyValue, templateValue) => (bodyValue !== undefined ? bodyValue : templateValue);
  return {
    name: body.name,
    listed: body.listed,
    start_at: body.start_at,
    end_at: endAt,
    problems: entries.map((entry) => ({ ...entry })), // the contest's own copy
    template_slug: template.slug,                      // display-only provenance
    identity_label: pick(body.identity_label, defaults.identity_label),
    room_gate_enabled: pick(body.room_gate_enabled, defaults.room_gate_enabled),
    camera_recording: pick(body.camera_recording, defaults.camera_recording),
    enforcement: pick(body.enforcement, defaults.enforcement),
    evidence_retention_days: pick(body.evidence_retention_days, defaults.evidence_retention_days),
    languages: pick(body.languages, defaults.languages)
  };
}

// Contest problems must be servable to candidates the moment the contest can
// open: existing published bank/seed docs only. Reasons: draft|missing.
async function requirePublishedProblems(entries, errorName) {
  const unavailable = [];
  for (const entry of entries) {
    if (await getProblem(entry.problem_id)) continue;
    const bank = await getBankProblem(entry.problem_id);
    unavailable.push({ problem_id: entry.problem_id, reason: bank ? "draft" : "missing" });
  }
  if (unavailable.length) throw httpErrorWith(400, errorName, { problems: unavailable });
}

async function adminUpdateContest(req) {
  requireAdmin(req);
  const body = parseBody(req);
  requireFields(body, ["slug"]);
  if (body.problems !== undefined) await enforceContestProblemsEditRules(String(body.slug), body);
  return { ok: true, contest: await updateContest(String(body.slug), body) };
}

// S-I §1.4.5 (veto-able defaults): contest problems[] edits are free while
// draft; once OPEN —
//   adding an entry            -> requires body.confirm === true
//   removing an entry that has stored submissions in THIS contest -> 409
//   changing an entry's points -> typed contest-slug confirmation (best scores
//     are computed live, so the change applies retroactively)
async function enforceContestProblemsEditRules(slug, body) {
  const doc = await getFirestore().collection(CONTESTS_COLLECTION).doc(slug).get();
  if (!doc.exists) throw httpError(404, "contest_not_found");
  const existing = doc.data();

  const checked = normalizeProblemEntries(Array.isArray(body.problems) && body.problems.length ? body.problems : []);
  const entries = checked.ok ? checked.entries : [];
  if (Array.isArray(body.problems) && body.problems.length && !checked.ok) return badRequest(checked.error);
  await requirePublishedProblems(entries, "problems_unavailable");

  if (existing.status !== "open") return; // draft/archived edits are free

  const oldEntries = contestProblemEntries(existing);
  const oldById = new Map(oldEntries.map((entry) => [entry.problem_id, entry]));
  const newById = new Map(entries.map((entry) => [entry.problem_id, entry]));

  const added = entries.filter((entry) => !oldById.has(entry.problem_id));
  if (added.length && body.confirm !== true) {
    throw httpErrorWith(409, "problem_add_requires_confirm", {
      problems: added.map((entry) => entry.problem_id)
    });
  }

  for (const entry of oldEntries) {
    if (newById.has(entry.problem_id)) continue;
    // Removal: blocked when this contest already stored submissions for it.
    const snapshot = await scopedQuery(getFirestore().collection(SUBMISSIONS_COLLECTION), existing)
      .where("problem_id", "==", entry.problem_id)
      .limit(1)
      .get();
    if (snapshot.docs.length) {
      throw httpErrorWith(409, "problem_has_submissions", { problem_id: entry.problem_id });
    }
  }

  const pointsEdited = entries.filter((entry) =>
    oldById.has(entry.problem_id)
    && (oldById.get(entry.problem_id).points ?? null) !== (entry.points ?? null));
  if (pointsEdited.length && body.confirm_points_edit !== existing.slug) {
    throw httpErrorWith(409, "points_edit_confirmation_required", {
      contest: existing.slug,
      problems: pointsEdited.map((entry) => entry.problem_id)
    });
  }
}

async function adminContestStatus(req) {
  requireAdmin(req);
  const body = parseBody(req);
  requireFields(body, ["slug", "status"]);
  return { ok: true, contest: await setContestStatus(String(body.slug), String(body.status)) };
}

// S-D: POST /api/admin/contest-regenerate {slug, field} — mint a fresh
// access_code or invigilator_key (vision §2.7: both are regenerate-able).
async function adminContestRegenerate(req) {
  requireAdmin(req);
  const body = parseBody(req);
  requireFields(body, ["slug", "field"]);
  return { ok: true, contest: await regenerateContestSecret(String(body.slug), String(body.field)) };
}

// W4: POST /api/admin/contest-set-code {slug, access_code} — set a CUSTOM test
// code. contests.mjs owns the format rule (6 chars, mint alphabet) and the
// unique-among-OPEN-contests check.
async function adminContestSetCode(req) {
  requireAdmin(req);
  const body = parseBody(req);
  requireFields(body, ["slug", "access_code"]);
  return { ok: true, contest: await setContestAccessCode(String(body.slug), String(body.access_code)) };
}

// S-D: POST /api/admin/contest-exam-time {slug, end_at|extend_minutes|end_now}
// — the legacy S5 exam-time card, per contest. contests.mjs owns the doc write;
// end_now additionally ends every live session in THIS contest's scope (same
// paginated sweep as the legacy endpoint).
async function adminContestExamTime(req) {
  requireAdmin(req);
  const body = parseBody(req);
  requireFields(body, ["slug"]);
  const { contest, field, now } = await applyContestExamTime(String(body.slug), body);
  let endedCount = 0;
  if (field === "end_now") {
    endedCount = await endAllLiveSessions(contest.slug, now);
  }
  return { ok: true, start_at: contest.start_at, end_at: contest.end_at, server_now: now, ended_count: endedCount };
}

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

// Unique-ID normalization: trim + lowercase + strip ALL whitespace, because
// colleges format roll numbers inconsistently ("21 CS 001" ≡ "21CS001").
function normalizeUniqueId(value) {
  return String(value).trim().toLowerCase().replace(/\s+/g, "");
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
  // "person" contests qualify; the synthesized legacy contest (and any absent
  // contest param) keeps today's global-roster path below BIT-FOR-BIT.
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
// null when the param is absent (legacy path). A param that names anything
// other than a real person contest is a hard 400 — uploads must never silently
// fall back to the global roster when the admin asked for a contest.
async function resolvePersonContestParam(contestParam) {
  if (contestParam === undefined || contestParam === null || String(contestParam).trim() === "") {
    return null;
  }
  const contest = await resolveContest(String(contestParam).trim(), { requireOpen: false });
  if (contest.legacy || contest.identity_mode !== "person") {
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

// GET /api/exam-config — PUBLIC (the student form renders before any session
// exists). Returns only non-sensitive config: whether the roster gate is on,
// what to call the unique-ID field, and the room labels. Fail-open client-side
// is safe because /api/session/start re-enforces the roster gate regardless.
async function publicExamConfig(req) {
  // S-D: ?contest= switches this pre-session endpoint to the CONTEST-owned
  // config (vision C1/C4). Without the param, today's settings-driven payload
  // stays bit-for-bit — the legacy deployment keeps working unchanged.
  const contestParam = String(req?.query?.contest ?? "").trim();
  if (contestParam) return contestExamConfig(contestParam);
  const [settings, meta] = await Promise.all([getSettings(), getRosterMeta()]);
  return {
    roster_required: Boolean(meta),
    unique_id_label: meta?.unique_id_column || "",
    rooms: normalizeRooms(settings?.rooms),
    // F5.3: the candidate runtime needs the enforcement knobs before a session
    // exists (the heartbeat keeps them fresh afterwards).
    enforcement: enforcementConfig(settings),
    // F10.1: the consent disclosure + camera capture labels render BEFORE a
    // session exists, so the candidate must know pre-session whether the
    // camera is recorded or live-monitored only.
    camera_recording: cameraRecordingConfig(settings)
  };
}

// S-D: per-contest exam-config — 400 unknown_contest / 403 contest_not_open
// (the candidate app turns either into the access-code landing page). Person
// contests serve their OWN snapshot fields; the synthesized legacy contest
// serves the settings-driven values under the same contest-shaped envelope.
async function contestExamConfig(slug) {
  const contest = await resolveContest(slug, { requireOpen: true });
  const envelope = {
    contest_slug: contest.slug,
    contest_name: contest.name || contest.slug,
    identity_label: contest.identity_label || "Candidate ID",
    // The pinned candidate app forks its identity UX on this: "person" =
    // server-resolved id (college picker on 409), "legacy_username" = today's
    // roster-lookup confirm flow. The two branches below are shape-identical
    // otherwise, so the payload must say which one it is.
    identity_mode: contest.identity_mode || (contest.legacy ? "legacy_username" : "person"),
    start_at: contest.start_at || null,
    end_at: contest.end_at || null,
    server_now: new Date().toISOString()
  };
  if (contest.legacy) {
    const [settings, meta] = await Promise.all([getSettings(), getRosterMeta()]);
    return {
      ...envelope,
      roster_required: Boolean(meta),
      unique_id_label: meta?.unique_id_column || "",
      rooms: normalizeRooms(settings?.rooms),
      room_gate_enabled: Boolean(settings?.room_gate_enabled),
      enforcement: enforcementConfig(settings),
      camera_recording: cameraRecordingConfig(settings)
    };
  }
  const meta = await getContestRosterMeta(contest);
  return {
    ...envelope,
    roster_required: Boolean(meta),
    // The label-driven identity prompt (F9 §1.5): person contests label the
    // unique-id field from the CONTEST doc, never a roster column name.
    unique_id_label: envelope.identity_label,
    rooms: normalizeRooms(contest.rooms),
    room_gate_enabled: Boolean(contest.room_gate_enabled),
    enforcement: enforcementConfigFor(contest, null),
    camera_recording: cameraRecordingConfigFor(contest, null)
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

// GET /api/candidate-route — PUBLIC, one boolean: does the LEGACY settings-
// driven exam still exist? The no-?contest= candidate URL keeps serving today's
// form while it does (bit-for-bit deployment guarantee) and shows the
// access-code landing page once it doesn't. This lives on its OWN endpoint
// because the no-param /api/exam-config payload is a locked contract (its key
// set is asserted bit-for-bit) and must not grow routing fields. Reveals
// nothing sensitive: only whether a settings doc exists at all.
async function publicCandidateRoute() {
  const settings = await getSettings();
  return { legacy_configured: Boolean(settings) };
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
// documented limitation). Karthi wants it mitigated now: a BEST-EFFORT per-IP
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
// today's behavior, explicit sentinel); a known contest → its resolved doc
// (the synthesized legacy contest TRANSLATES to the `contest_slug == ""`
// filter, F9 §6 — selecting the legacy entry now actually matches legacy
// sessions); an unknown slug filters literally (today's raw-where semantics:
// an empty result set, never an error — admin GET signatures stay unchanged,
// F9 D10).
async function contestScopeOf(slugRaw) {
  const slug = slugRaw === undefined || slugRaw === null ? "" : String(slugRaw).trim();
  if (!slug) return ALL_CONTESTS;
  try {
    return await resolveContest(slug, { requireOpen: false });
  } catch {
    return { slug, legacy: false, legacy_empty_slug: false };
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
        const [downloadUrl] = await file.getSignedUrl({
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
      status: doc.status || ""
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
//
// The contest-eval poller POSTs every code submission a student made (valid =
// Accepted, invalid = a terminal failure; transient Processing/Queued are
// skipped poller-side). They are stored as ONE doc per (username_norm,
// contest_slug) holding a merged, de-duped-by-submission_id events array so a
// re-post is idempotent. The admin recording-review timeline reads them back to
// overlay GREEN (valid) / RED (invalid) markers at each submission's real time.

const SUBMISSION_EVENTS_INGEST_LIMIT = 5000;

// Deterministic doc id for a (username_norm, contest_slug) submission-events doc.
function submissionEventsDocId(usernameNorm, contestSlug) {
  return `${usernameNorm}:${contestSlug || "_"}`;
}

function submissionEventsRef(usernameNorm, contestSlug) {
  return getFirestore().collection(SUBMISSION_EVENTS_COLLECTION).doc(submissionEventsDocId(usernameNorm, contestSlug));
}

// Validate + normalize one inbound submission event. submission_id is coerced to
// a string so it is a stable de-dupe key whether the poller sends an int or str.
function normalizeSubmissionEvent(event, index) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw httpError(400, `events[${index}] must be an object`);
  }
  // S-C (F9 §1.2): candidate_id accepted as an alias FOREVER (lazy poller fleet).
  if ((event.hackerrank_username === undefined || event.hackerrank_username === null || event.hackerrank_username === "")
      && event.candidate_id !== undefined && event.candidate_id !== null && event.candidate_id !== "") {
    event = { ...event, hackerrank_username: event.candidate_id };
  }
  for (const field of ["hackerrank_username", "submission_id", "submitted_at"]) {
    const value = event[field];
    if (value === undefined || value === null || value === "") {
      throw httpError(400, `events[${index}].${field} is required`);
    }
  }
  if (Number.isNaN(Date.parse(event.submitted_at))) {
    throw httpError(400, `events[${index}].submitted_at must be a valid ISO 8601 date`);
  }
  const item = {
    submission_id: String(event.submission_id),
    hackerrank_username: String(event.hackerrank_username),
    valid: event.valid === true,
    submitted_at: new Date(event.submitted_at).toISOString()
  };
  if (event.contest_slug) item.contest_slug = String(event.contest_slug);
  if (event.challenge_slug) item.challenge_slug = String(event.challenge_slug);
  if (event.challenge_name) item.challenge_name = String(event.challenge_name);
  if (event.lang) item.lang = String(event.lang);
  if (event.status) item.status = String(event.status);
  return item;
}

// Merge new events into an existing array, de-duping by submission_id (a later
// post for the same id overwrites — e.g. a Processing→Accepted re-classification),
// and keep the result sorted by submitted_at ascending.
function mergeSubmissionEvents(existing, incoming) {
  const byId = new Map();
  for (const event of existing || []) {
    if (event && event.submission_id !== undefined) byId.set(String(event.submission_id), event);
  }
  for (const event of incoming) byId.set(event.submission_id, event);
  return [...byId.values()].sort((a, b) =>
    String(a.submitted_at || "").localeCompare(String(b.submitted_at || ""))
  );
}

// POST /api/submission-events — poller ingest, authenticated with the SAME
// x-api-key mechanism as the alerts ingest. Groups the inbound events by
// (username_norm, contest_slug) and upserts each group's doc with the merged,
// de-duped array. Returns { ok, stored } = the count of events accepted.
async function ingestSubmissionEvents(req) {
  requireApiKey(req);
  const body = parseBody(req);
  const rawEvents = Array.isArray(body?.events) ? body.events : [];
  if (!rawEvents.length) return badRequest("No events provided");
  if (rawEvents.length > SUBMISSION_EVENTS_INGEST_LIMIT) {
    return badRequest(`Too many events in one request (max ${SUBMISSION_EVENTS_INGEST_LIMIT})`);
  }

  const normalized = rawEvents.map((event, index) => normalizeSubmissionEvent(event, index));

  // Group by the doc key so each (username_norm, contest_slug) doc is read +
  // upserted exactly once even when a batch spans many users.
  const groups = new Map();
  for (const event of normalized) {
    const usernameNorm = normalizeUsername(event.hackerrank_username);
    const contestSlug = event.contest_slug || "";
    const key = submissionEventsDocId(usernameNorm, contestSlug);
    if (!groups.has(key)) groups.set(key, { usernameNorm, contestSlug, events: [] });
    groups.get(key).events.push(event);
  }

  const now = new Date().toISOString();
  await Promise.all([...groups.values()].map(async ({ usernameNorm, contestSlug, events }) => {
    const ref = submissionEventsRef(usernameNorm, contestSlug);
    const doc = await ref.get();
    const existing = doc.exists ? (doc.data()?.events || []) : [];
    const merged = mergeSubmissionEvents(existing, events);
    await ref.set({
      username_norm: usernameNorm,
      contest_slug: contestSlug,
      events: merged,
      updated_at: now
    }, { merge: true });
  }));

  return { ok: true, stored: normalized.length };
}

// GET /api/admin/submission-events?username=<u>&contest_slug=<optional> — admin
// read for the recording-review timeline. When contest_slug is omitted, merges
// events across every contest doc for that user. Always returns the events
// sorted by submitted_at ascending.
async function adminSubmissionEvents(req) {
  requireAdmin(req);
  const username = req.query?.username;
  if (!username) return badRequest("username is required");
  const usernameNorm = normalizeUsername(username);
  const contestSlug = req.query?.contest_slug;

  let docs;
  if (contestSlug !== undefined && contestSlug !== null && contestSlug !== "") {
    const doc = await submissionEventsRef(usernameNorm, String(contestSlug)).get();
    docs = doc.exists ? [doc.data()] : [];
  } else {
    // No contest specified — gather every doc for this user and merge.
    const snapshot = await getFirestore()
      .collection(SUBMISSION_EVENTS_COLLECTION)
      .where("username_norm", "==", usernameNorm)
      .limit(50)
      .get();
    docs = snapshot.docs.map((doc) => doc.data());
  }

  const merged = mergeSubmissionEvents([], docs.flatMap((doc) => doc?.events || []));
  return { events: merged };
}

// Phase 2 (2.4 / Epic 6.4 / 4.4): live counts by status for the admin dashboard.
// Counts are derived from the session docs; an optional ?contest_slug filters to
// one contest, and an optional ?room scopes counts to a single room. "finished"
// == ended; "live" == active; plus locked + pending. A derived `disconnected`
// count flags active sessions whose last liveness signal (heartbeat or beacon)
// is older than the staleness threshold. The distinct `rooms` list (computed
// over the contest scope, BEFORE the room filter, so the dropdown stays full) is
// returned so the console can populate a room dropdown.
async function adminStats(req) {
  requireAdmin(req);
  const contestSlug = req.query?.contest_slug;
  const scope = await contestScopeOf(contestSlug);
  const room = normalizeRoomFilter(req.query?.room);

  const snapshot = await scopedQuery(getFirestore().collection(SESSION_COLLECTION), scope)
    .limit(SESSIONS_QUERY_LIMIT)
    .get();
  const allDocs = snapshot.docs.map((doc) => doc.data());

  // Distinct rooms come from the full contest scope (NOT the room-filtered set)
  // so the dropdown always lists every room even while one is selected.
  const rooms = distinctRooms(allDocs);

  // Apply the room filter to the docs the counts are computed over.
  const docs = room ? allDocs.filter((doc) => String(doc.room || "") === room) : allDocs;

  const nowMs = Date.now();
  const stats = { live: 0, locked: 0, pending_approval: 0, finished: 0, disconnected: 0, total: 0 };
  for (const doc of docs) {
    stats.total += 1;
    if (doc.status === "active") {
      stats.live += 1;
      // Derived disconnected signal: an active session whose last heartbeat /
      // beacon is older than the staleness threshold (default 45s).
      if (isStaleSession(doc, nowMs)) stats.disconnected += 1;
    } else if (doc.status === "locked") stats.locked += 1;
    else if (doc.status === "pending_approval") stats.pending_approval += 1;
    else if (doc.status === "ended") stats.finished += 1;
  }
  // "not started or total": with no roster the backend can't know who hasn't
  // started, so we report total session docs as the closest defensible number
  // (the frontend can subtract the started states to estimate yet-to-start once
  // a roster exists).
  stats.not_started_or_total = stats.total;

  // S5: the console exam-time card rides on the existing 5 s stats poll, so the
  // current end time + a server clock stamp come back with every poll.
  // F3 (E2E live): a contest-scoped stats poll reports THAT contest's window —
  // the legacy settings end_at said "time is up" while the scoped contest had
  // hours left. ALL_CONTESTS keeps today's legacy schedule; the synthesized
  // legacy contest mirrors the settings doc so its value is identical; an
  // unknown slug (contestScopeOf's literal fallback carries no window) reports
  // "" → the card renders "no schedule" instead of the wrong clock.
  const settings = await getSettings();
  return {
    contest_slug: contestSlug ? String(contestSlug) : null,
    room: room || null,
    stats,
    rooms,
    disconnected_staleness_ms: DISCONNECTED_STALENESS_MS,
    end_at: scope === ALL_CONTESTS ? (settings?.end_at || "") : (scope.end_at || ""),
    server_now: new Date().toISOString()
  };
}

// ---- S5: dynamic exam time + end-now (admin) -------------------------------
//
// POST /api/admin/exam-time — live control over the exam END time. Deliberately
// NOT part of adminSaveSettings: a merge-write touches ONLY the end-time fields,
// so settings keys other features own (rooms, gate flags, contest_url) are never
// clobbered, and the endpoint stays a single, small, testable concern.
//
// Body carries EXACTLY ONE of:
//   { end_at: "<ISO>" }     → set an absolute new end time
//   { extend_minutes: N }   → shift the CURRENT end by N minutes (negative shortens)
//   { end_now: true }       → end_at := now AND force-end every non-ended session
//                             in the current contest scope. Their next heartbeat
//                             409s session_ended → the recorder self-stops (B1).
//
// Students pick a new end time up via the heartbeat response (≤15 s) — no
// reload. A plain end_at/extend change NEVER force-ends sessions: recording
// keeps running so candidates end their own test (manifest upload intact);
// end_now is the explicit hard stop.
async function adminExamTime(req) {
  requireAdmin(req);
  const body = parseBody(req);

  const provided = ["end_at", "extend_minutes", "end_now"].filter(
    (key) => body[key] !== undefined && body[key] !== null && body[key] !== ""
  );
  if (provided.length !== 1) {
    return badRequest("Provide exactly one of end_at, extend_minutes, end_now");
  }
  const field = provided[0];

  const settings = await getSettings();
  if (!settings?.start_at || !settings?.end_at) {
    return badRequest("Proctoring schedule is not configured yet.");
  }
  const startMs = Date.parse(settings.start_at);
  const currentEndMs = Date.parse(settings.end_at);
  const now = new Date().toISOString();

  let newEndMs;
  if (field === "end_now") {
    if (body.end_now !== true) return badRequest("end_now must be true");
    newEndMs = Date.parse(now);
  } else if (field === "end_at") {
    newEndMs = Date.parse(String(body.end_at));
    if (!Number.isFinite(newEndMs)) return badRequest("end_at must be a valid ISO 8601 date");
  } else {
    const delta = Number(body.extend_minutes);
    if (!Number.isFinite(delta) || delta === 0) return badRequest("extend_minutes must be a non-zero number");
    if (!Number.isFinite(currentEndMs)) return badRequest("Stored end time is invalid; set an absolute end_at instead.");
    newEndMs = currentEndMs + delta * 60_000;
  }

  // Window sanity: the end must stay after the start (also rejects an end-now
  // pressed before the exam ever started).
  if (!Number.isFinite(startMs) || newEndMs <= startMs) {
    return badRequest("End time must be after the start time.");
  }
  const newEndAt = new Date(newEndMs).toISOString();

  // merge:true → ONLY the end-time fields change; everything else on the
  // settings doc survives (parallel features add their own keys to this doc).
  await settingsRef().set({ end_at: newEndAt, end_at_updated_at: now, updated_at: now }, { merge: true });

  let endedCount = 0;
  if (field === "end_now") {
    const contestSlug = settings.contest_slug || contestSlugFromUrl(settings.contest_url);
    endedCount = await endAllLiveSessions(contestSlug, now);
  }

  return { ok: true, start_at: settings.start_at, end_at: newEndAt, server_now: now, ended_count: endedCount };
}

// S5: end every non-ended session in the given contest scope ("" matches
// legacy/no-contest sessions). Mirrors applySessionAction("end") — status:ended
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

// The real person-mode contest behind an optional admin filter value, or null →
// the caller keeps its legacy behavior. NEVER throws: admin GET signatures stay
// unchanged (F9 D10), so an unknown/legacy slug filters exactly as today.
async function personContestForFilter(contestSlug) {
  if (contestSlug === undefined || contestSlug === null || String(contestSlug).trim() === "") return null;
  try {
    const contest = await resolveContest(String(contestSlug).trim(), { requireOpen: false });
    return contest.legacy || contest.identity_mode !== "person" ? null : contest;
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
  if (!meta) return { configured: false, contest_slug: contest.slug };

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

// ---- S-J §2.14 Results tab (the post-exam admin rollup) --------------------
//
// GET /api/admin/contest-results?contest=slug — ADMIN-ONLY (candidates never
// see others' scores, vision §2.14). For every ACTIVE enrollment in the
// contest: rank + label-driven id/name/college + total + per-problem best +
// the integrity column (alerts-by-severity + review verdict) + selection_status.
// Reuses computeScoreboard/computeSessionSummary via scoreboard.buildResultsRows
// (best-per-problem default). The F9 no-bleed invariant holds: every Firestore
// read goes through scopedQuery on the RESOLVED contest. CSV export rides the
// same builder when format=csv.
async function adminContestResults(req) {
  requireAdmin(req);
  const contest = await personContestForFilter(req.query?.contest ?? req.query?.contest_slug);
  if (!contest) {
    // Results is a person-layer surface: legacy/unknown/global has no enrollment
    // spine. Degrade to a clean "not available" rather than 500 or leak global.
    return { configured: false };
  }
  const data = await computeContestResults(contest);
  if (String(req.query?.format || "").toLowerCase() === "csv") {
    return { csv: buildResultsCsv(data.rows, data.problems) };
  }
  return data;
}

// The shared rollup: ONE enrollment scan + ONE submissions scan + ONE alerts
// scan + ONE reviews scan, all contest-scoped, joined in memory by the pure
// scoreboard module. Purged contests (no live submissions) fall back to each
// enrollment's final_snapshot (vision §2.9 purge-survivor; the per-row
// from_snapshot flag tells the UI to mark it).
async function computeContestResults(contest) {
  const enrollments = await listEnrollments(contest);
  const problemEntries = contestProblemEntries(contest);
  const problemOrder = problemEntries.map((entry) => entry.problem_id);

  const submissionsSnap = await scopedQuery(getFirestore().collection(SUBMISSIONS_COLLECTION), contest)
    .limit(SUBMISSIONS_RESULTS_LIMIT)
    .get();
  const submissions = submissionsSnap.docs.map((doc) => doc.data());

  // Purge-survivor: with no live submissions but stamped snapshots, read from
  // the frozen enrollment.final_snapshot instead of the (deleted) heavy data.
  const purged = submissions.length === 0
    && enrollments.some((enrollment) => enrollment.status !== "removed" && enrollment.final_snapshot);

  const activeIds = enrollments.filter((e) => e.status !== "removed").map((e) => e.person_id);
  const [persons, collegeNames, integrityByPerson] = await Promise.all([
    purged ? new Map() : getPersonsByIds(activeIds),
    getCollegeNameMap(),
    purged ? new Map() : integrityByPersonFor(contest, activeIds)
  ]);

  const multiCollege = Array.isArray(contest.colleges) && contest.colleges.length > 1;
  const rows = buildResultsRows({
    submissions, enrollments, persons, integrityByPerson, collegeNames,
    problemOrder, multiCollege, purged
  });

  // Per-problem column titles (contest order) for the table header + CSV.
  const problems = await Promise.all(problemEntries.map(async (entry) => {
    const problem = await getProblem(entry.problem_id).catch(() => null);
    return { problem_id: entry.problem_id, title: problem?.title || entry.problem_id, points: entry.points };
  }));

  return {
    configured: true,
    contest_slug: contest.slug,
    multi_college: multiCollege,
    selection_done_at: contest.selection_done_at || null,
    problems,
    rows,
    generated_at: new Date().toISOString()
  };
}

// Per-candidate integrity inputs: this contest's alerts grouped by username_norm
// (= person_id under person mode) + this contest's review records grouped the
// same way. ONE bounded scan each, scoped to the contest. summarizeIntegrity
// (pure) folds them in buildResultsRows.
async function integrityByPersonFor(contest, activeIds) {
  const activeSet = new Set(activeIds);
  const out = new Map();
  const ensure = (id) => {
    if (!out.has(id)) out.set(id, { alerts: [], reviews: [] });
    return out.get(id);
  };

  const alertsSnap = await scopedQuery(getFirestore().collection(ALERTS_COLLECTION), contest)
    .limit(ALERTS_QUERY_LIMIT)
    .get();
  for (const doc of alertsSnap.docs) {
    const alert = doc.data();
    if (alert.archived) continue; // archived = triaged-away, not an open integrity signal
    const personId = String(alert.username_norm || "");
    if (!activeSet.has(personId)) continue;
    ensure(personId).alerts.push({ severity: alert.severity });
  }

  // Reviews are stored per (username, reviewer, contest-slug); reuse the S-C
  // scope helper so a person-contest reads its OWN review set (not the legacy
  // slugless pile). Bounded scan + in-memory scope filter (mirrors getAllReviews).
  const reviews = await getAllReviews(contest.slug);
  for (const review of reviews) {
    const personId = String(review.username_norm || "");
    if (!activeSet.has(personId)) continue;
    ensure(personId).reviews.push({ verdict: review.verdict, reviewer_name: review.reviewer_name });
  }
  return out;
}

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
    const perProblem = {};
    for (const cell of row.per_problem) perProblem[cell.problem_id] = cell.best_score;
    snapshotByPerson.set(row.person_id, {
      total_score: row.total,
      per_problem: perProblem,
      integrity: {
        alerts_by_severity: row.integrity.alerts_by_severity,
        review_verdict: row.integrity.review_verdict
      },
      unique_id: row.candidate_id,
      name: row.name,
      session_status: ""
    });
  }
  return stampSelectionDone(contest, snapshotByPerson, adminActor(req, body));
}

// POST /api/admin/contest-adopt — legacy "Adopt into person model" (vision
// §2.15). Re-upload this contest's roster WITH the college column; the identity
// module mints persons/colleges/enrollments and stamps person_id onto the
// contest's existing sessions/submissions (username_norm + all keys FROZEN).
// The college-confirmation preview rides straight back to the admin UI. The
// target may be a legacy/F9-era contest, so we resolve it WITHOUT the
// person-mode filter (resolveContest, not personContestForFilter).
async function adminContestAdopt(req) {
  requireAdmin(req);
  const body = parseBody(req);
  const slug = body.contest ?? body.contest_slug;
  if (slug === undefined || slug === null || String(slug).trim() === "") {
    return badRequest("contest is required");
  }
  let contest;
  try {
    contest = await resolveContest(String(slug).trim(), { requireOpen: false });
  } catch {
    return badRequest("unknown contest");
  }
  return adoptContestIntoPersonModel(contest, body, adminActor(req, body));
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
    const [url] = await bucket().file(gcsKey).getSignedUrl({
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
// The People tab is the ONE sanctioned cross-contest surface. The directory +
// the per-person enrollment scan use the explicit ALL_CONTESTS sentinel
// (listAllPersons / listEnrollmentsForPerson, identity.mjs). The per-contest
// score/integrity reads the scorecard fans out are EACH contest-scoped through
// scopedQuery on the RESOLVED contest — so the F9 no-bleed invariant holds (the
// sentinel is for the person/enrollment axis only, never contest evidence).

// GET /api/admin/people?search=&college= — the directory. ADMIN-ONLY. Returns
// the (capped) person list filtered by college/id/name, each with a contest
// count, plus the college options for the filter dropdown.
async function adminPeople(req) {
  requireAdmin(req);
  const people = await listAllPersons();
  const collegeNames = await getCollegeNameMap();
  const filtered = filterDirectory(people, {
    search: req.query?.search ?? "",
    college: req.query?.college ?? ""
  });

  // Per-person contest count: ONE bounded cross-contest enrollment scan, grouped
  // by person_id (the directory needs the "attempted N rounds" badge). Capped to
  // the filtered set so an empty search doesn't fan out unboundedly.
  const rows = await mapWithConcurrency(filtered.slice(0, PEOPLE_DIRECTORY_LIMIT), 20, async (person) => {
    const enrollments = await listEnrollmentsForPerson(person.person_id);
    const active = enrollments.filter((e) => String(e.status || "active") !== "removed");
    return {
      person_id: person.person_id,
      unique_id: person.unique_id || "",
      name: person.name || "",
      college_norm: person.college_norm || "",
      college: collegeNames.get(person.college_norm) || person.college_norm || "",
      contest_count: active.length
    };
  });
  rows.sort((a, b) => String(a.college_norm).localeCompare(String(b.college_norm)) || String(a.unique_id).localeCompare(String(b.unique_id)));

  return {
    configured: true,
    people: rows,
    colleges: [...collegeNames.entries()].map(([college_norm, name]) => ({ college_norm, name }))
      .sort((a, b) => a.college_norm.localeCompare(b.college_norm)),
    total: rows.length
  };
}

// GET /api/admin/person?person_id=&format= — one person's cross-round scorecard.
// ADMIN-ONLY. Reads LIVE data per contest where it exists, falls back to the
// frozen enrollment.final_snapshot after purge (vision §2.9 purge-survivor;
// §10.2 snapshot scores VISIBLE, marked from a purged contest). CSV export when
// format=csv.
async function adminPerson(req) {
  requireAdmin(req);
  const personId = String(req.query?.person_id ?? req.query?.id ?? "").trim();
  if (!personId) return badRequest("person_id is required");
  const person = await getPersonById(personId);
  if (!person) return { configured: false };

  const data = await computePersonScorecard(person);
  if (String(req.query?.format || "").toLowerCase() === "csv") {
    return { csv: buildScorecardCsv(data.person, data.rows) };
  }
  return data;
}

// The cross-round join. ONE sanctioned cross-contest enrollment scan (sentinel)
// gives the contests this person attempted; for EACH contest we resolve the
// contest doc and read its LIVE submissions/alerts/reviews SCOPED to that
// contest (the no-bleed guarantee — the sentinel never touches contest
// evidence). buildScorecardRows (pure) does the live-vs-snapshot fallback.
async function computePersonScorecard(person) {
  const personId = person.person_id;
  const enrollments = await listEnrollmentsForPerson(personId);
  const activeEnrollments = enrollments.filter((e) => String(e.status || "active") !== "removed");

  const liveByContest = {};
  const liveIntegrityByContest = {};
  const contests = {};
  const collegeNames = await getCollegeNameMap();

  await mapWithConcurrency(activeEnrollments, 8, async (enrollment) => {
    const slug = String(enrollment.contest_slug || "");
    if (!slug) return;
    let contest;
    try {
      contest = await resolveContest(slug, { requireOpen: false });
    } catch {
      contest = { slug, name: slug };
    }
    contests[slug] = contest;

    // A purged contest has no live data — skip the per-contest reads entirely
    // (the pure builder reads its final_snapshot). Otherwise read this person's
    // LIVE score + integrity, each SCOPED to this contest.
    if (contest.db_purged_at) return;

    const problemEntries = contestProblemEntries(contest);
    const problemOrder = problemEntries.map((entry) => entry.problem_id);

    const submissionsSnap = await scopedQuery(getFirestore().collection(SUBMISSIONS_COLLECTION), contest)
      .where("person_id", "==", personId)
      .limit(SUBMISSIONS_RESULTS_LIMIT)
      .get();
    const submissions = submissionsSnap.docs.map((doc) => doc.data());
    liveByContest[slug] = computeScoreboard(submissions, problemOrder);

    const integrity = await integrityByPersonFor(contest, [personId]);
    const summary = integrity.get(personId);
    liveIntegrityByContest[slug] = { [personId]: summarizeScorecardIntegrity(summary) };
  });

  const rows = buildScorecardRows({ enrollments: activeEnrollments, liveByContest, liveIntegrityByContest, contests });

  return {
    configured: true,
    person: {
      person_id: personId,
      unique_id: person.unique_id || "",
      name: person.name || "",
      college_norm: person.college_norm || "",
      college: collegeNames.get(person.college_norm) || person.college_norm || "",
      email: person.email || ""
    },
    rows,
    generated_at: new Date().toISOString()
  };
}

// integrityByPersonFor returns raw { alerts:[], reviews:[] } per person; the
// scorecard builder wants the SAME folded shape the Results table uses. Reuse
// the pure summarizer so a person's integrity reads identically on both surfaces.
function summarizeScorecardIntegrity(raw) {
  const folded = summarizeIntegrity(raw || {});
  return { alerts_by_severity: folded.alerts_by_severity, review_verdict: folded.review_verdict };
}

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

// S-C (F9 D17): per-contest review state for NEW data — ids gain a ::{slug}
// suffix (roster doc: roster::{slug}); SLUGLESS ids stay the legacy set and
// keep working untouched. contestSlug = "" everywhere means "the legacy set".
function reviewRosterRef(contestSlug = "") {
  return getFirestore().collection(REVIEW_STATE_COLLECTION)
    .doc(contestSlug ? `${REVIEW_ROSTER_ID}::${contestSlug}` : REVIEW_ROSTER_ID);
}

function reviewRecordId(usernameNorm, reviewerKey, contestSlug = "") {
  const base = `${usernameNorm}::${reviewerKey}`;
  return contestSlug ? `${base}::${contestSlug}` : base;
}

function reviewRecordRef(usernameNorm, reviewerKey, contestSlug = "") {
  return getFirestore().collection(REVIEW_COLLECTION).doc(reviewRecordId(usernameNorm, reviewerKey, contestSlug));
}

function reviewClaimRef(usernameNorm, contestSlug = "") {
  return getFirestore().collection(REVIEW_CLAIMS_COLLECTION)
    .doc(contestSlug ? `${usernameNorm}::${contestSlug}` : usernameNorm);
}

// Resolve the optional review-scope contest param: absent → "" (the legacy
// slugless set); the synthesized legacy contest → "" too (its review data IS
// the legacy set); a real contest → its slug; unknown → 400 (typo safety).
async function reviewContestSlugOf(param) {
  if (param === undefined || param === null || String(param).trim() === "") return "";
  const contest = await resolveContest(String(param).trim(), { requireOpen: false });
  return contest.legacy ? "" : contest.slug;
}

// A review/claim doc belongs to scope `contestSlug` when its contest_slug field
// matches ("" matches docs WITHOUT the field — the legacy set). New scoped
// writes always stamp the field; legacy docs never get rewritten.
function inReviewScope(doc, contestSlug) {
  return String(doc?.contest_slug || "") === contestSlug;
}

// A reviewer name is normalized to a key the same way usernames are (lowercased,
// path-safe) so `${username_norm}::${reviewerKey}` is a stable, idempotent doc id
// and review-mine/claim-owner comparisons are case-insensitive.
function reviewerKeyFor(reviewerName) {
  return normalizeUsername(reviewerName);
}

// Normalize an operator-supplied roster: trim each entry, drop blanks, and
// de-dupe by username_norm while KEEPING the first-seen original display form
// and the roster ORDER. Returns [{ username, username_norm }] in roster order.
function normalizeRoster(usernames) {
  const out = [];
  const seen = new Set();
  for (const raw of usernames) {
    if (raw === undefined || raw === null) continue;
    const display = String(raw).trim();
    if (!display) continue;
    const norm = normalizeUsername(display);
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push({ username: display, username_norm: norm });
  }
  return out;
}

// POST /api/admin/review-roster — replace the roster wholesale.
async function adminSetReviewRoster(req) {
  requireAdmin(req);
  const body = parseBody(req);
  const contestSlug = await reviewContestSlugOf(body.contest);
  if (!Array.isArray(body.usernames)) return badRequest("usernames must be an array");
  if (body.usernames.length > REVIEW_ROSTER_LIMIT) {
    return badRequest(`Too many usernames in one request (max ${REVIEW_ROSTER_LIMIT})`);
  }
  const entries = normalizeRoster(body.usernames);
  const now = new Date().toISOString();
  // .set() (no merge) REPLACES the roster — a removed username is gone, matching
  // "replace the roster" rather than "append".
  await reviewRosterRef(contestSlug).set({
    entries,
    updated_at: now,
    ...(contestSlug ? { contest_slug: contestSlug } : {})
  });
  return { ok: true, count: entries.length };
}

// Read the persisted roster as [{ username, username_norm }] in roster order.
async function getReviewRoster(contestSlug = "") {
  const doc = await reviewRosterRef(contestSlug).get();
  if (!doc.exists) return [];
  const entries = doc.data()?.entries;
  return Array.isArray(entries) ? entries : [];
}

// All review records IN SCOPE (S-C: contest slug or the legacy slugless set).
// Capped so a pathological collection can't bloat a request.
async function getAllReviews(contestSlug = "") {
  const snapshot = await getFirestore().collection(REVIEW_COLLECTION).limit(REVIEWS_QUERY_LIMIT).get();
  return snapshot.docs.map((doc) => doc.data()).filter((review) => inReviewScope(review, contestSlug));
}

// Index reviews by username_norm → { records:[...] }. Each record is one
// reviewer's verdict for that username.
function indexReviewsByUsername(reviews) {
  const byUsername = new Map();
  for (const review of reviews) {
    const norm = review?.username_norm;
    if (!norm) continue;
    if (!byUsername.has(norm)) byUsername.set(norm, []);
    byUsername.get(norm).push(review);
  }
  return byUsername;
}

// GET /api/admin/review-roster — the roster plus summary counts derived from the
// reviews + claims collections.
async function adminGetReviewRoster(req) {
  requireAdmin(req);
  const contestSlug = await reviewContestSlugOf(req.query?.contest);
  const roster = await getReviewRoster(contestSlug);
  const reviews = await getAllReviews(contestSlug);
  const claims = await getActiveClaims(contestSlug);

  const byUsername = indexReviewsByUsername(reviews);
  let with0 = 0;
  let with1 = 0;
  let with2plus = 0;
  for (const entry of roster) {
    const count = (byUsername.get(entry.username_norm) || []).length;
    if (count === 0) with0 += 1;
    else if (count === 1) with1 += 1;
    else with2plus += 1;
  }

  // active_claims counts only NON-expired claims that point at a roster username
  // (a stale claim is logically free; a claim for a since-removed username is not
  // part of this roster's working set).
  const rosterNorms = new Set(roster.map((entry) => entry.username_norm));
  const activeClaims = claims.filter((claim) => rosterNorms.has(claim.username_norm)).length;

  return {
    usernames: roster.map((entry) => entry.username),
    total: roster.length,
    with_0_reviews: with0,
    with_1_review: with1,
    with_2plus_reviews: with2plus,
    active_claims: activeClaims
  };
}

// A claim is ACTIVE (blocks a different reviewer) when its claimed_at is newer
// than CLAIM_TTL_MS ago. An unparseable/missing claimed_at is treated as stale
// (free) so a malformed claim can never permanently wedge a username.
function isClaimActive(claim, nowMs) {
  if (!claim) return false;
  const claimedMs = claim.claimed_at ? Date.parse(claim.claimed_at) : NaN;
  if (!Number.isFinite(claimedMs)) return false;
  return nowMs - claimedMs < CLAIM_TTL_MS;
}

// Every currently-active (non-expired) claim IN SCOPE.
async function getActiveClaims(contestSlug = "") {
  const snapshot = await getFirestore().collection(REVIEW_CLAIMS_COLLECTION).limit(REVIEW_ROSTER_LIMIT).get();
  const nowMs = Date.now();
  return snapshot.docs.map((doc) => doc.data())
    .filter((claim) => inReviewScope(claim, contestSlug))
    .filter((claim) => isClaimActive(claim, nowMs));
}

// POST /api/admin/review-next — serve reviewer R the next student to review by
// PRIORITY, claiming it atomically so two reviewers never get the same username.
//
// candidates = roster usernames U where R has NOT already reviewed U AND U is not
// currently claimed by a DIFFERENT reviewer with a non-expired claim. For each U,
// r(U) = total completed reviews, pos(U) = count of verdict==1 reviews. Buckets,
// lowest first:
//   0: r == 0                      (every student gets at least 1 review)
//   1: r == 1 AND pos == 1         (positively-reviewed students reach 2)
//   2: r == 1 AND pos == 0         (negatively-reviewed students reach 2)
//   3: r >= 2                      (all at 2 → keep reviewing the TOP candidates)
// Within 0/1/2 by roster order; bucket 3 by pos DESC, tiebreak r ASC, then roster
// order. We claim the top candidate atomically; if another reviewer won the race
// we retry with the next candidate. {username} | {done:true}.
async function adminReviewNext(req) {
  requireAdmin(req);
  const body = parseBody(req);
  requireFields(body, ["reviewer_name"]);
  const contestSlug = await reviewContestSlugOf(body.contest);
  const reviewerName = String(body.reviewer_name).trim();
  if (!reviewerName) return badRequest("reviewer_name is required");
  const reviewerKey = reviewerKeyFor(reviewerName);

  const roster = await getReviewRoster(contestSlug);
  if (!roster.length) return { done: true };

  const reviews = await getAllReviews(contestSlug);
  const byUsername = indexReviewsByUsername(reviews);
  const claimsByNorm = await loadClaimsByNorm(contestSlug);

  const candidates = rankReviewCandidates(roster, byUsername, reviewerKey, Date.now(), claimsByNorm);

  // Walk candidates best-first; the first one we can atomically claim wins. A
  // lost claim race falls through to the next candidate.
  for (const candidate of candidates) {
    const claimed = await claimReviewUsername(candidate.username_norm, reviewerName, contestSlug);
    if (claimed) return { username: candidate.username };
  }
  return { done: true };
}

// Load every IN-SCOPE claim doc keyed by username_norm (raw, including stale
// ones) so the ranking pass can decide claimable-ness with a single read. Stale
// claims are filtered in rankReviewCandidates so they don't exclude a username.
async function loadClaimsByNorm(contestSlug = "") {
  const snapshot = await getFirestore().collection(REVIEW_CLAIMS_COLLECTION).limit(REVIEW_ROSTER_LIMIT).get();
  const byNorm = new Map();
  for (const doc of snapshot.docs) {
    const claim = doc.data();
    if (claim?.username_norm && inReviewScope(claim, contestSlug)) byNorm.set(claim.username_norm, claim);
  }
  return byNorm;
}

// Pure ranking: produce the ordered candidate list for reviewer `reviewerKey`.
// Exported-ish for the unit tests via the priority behavior; kept pure (no I/O)
// so the bucket logic is deterministic and testable.
function rankReviewCandidates(roster, byUsername, reviewerKey, nowMs, claimsByNorm) {
  const candidates = [];
  roster.forEach((entry, rosterIndex) => {
    const records = byUsername.get(entry.username_norm) || [];
    // Skip a username this reviewer already reviewed (idempotent: a reviewer
    // reviews a username at most once, so they're never re-served it).
    const alreadyMine = records.some((rec) => reviewerKeyFor(rec.reviewer_name) === reviewerKey);
    if (alreadyMine) return;

    // Skip a username actively claimed by a DIFFERENT reviewer. A claim by THIS
    // reviewer (e.g. a re-pull after a crash) does not exclude — they may re-take
    // it. A stale claim is ignored entirely.
    const claim = claimsByNorm.get(entry.username_norm);
    if (claim && isClaimActive(claim, nowMs) && reviewerKeyFor(claim.reviewer_name) !== reviewerKey) {
      return;
    }

    const r = records.length;
    const pos = records.filter((rec) => Number(rec.verdict) === 1).length;
    let bucket;
    if (r === 0) bucket = 0;
    else if (r === 1 && pos === 1) bucket = 1;
    else if (r === 1 && pos === 0) bucket = 2;
    else bucket = 3;

    candidates.push({ username: entry.username, username_norm: entry.username_norm, rosterIndex, r, pos, bucket });
  });

  candidates.sort((a, b) => {
    if (a.bucket !== b.bucket) return a.bucket - b.bucket; // lowest bucket first
    if (a.bucket === 3) {
      // TOP candidates first: highest positive-score, then fewest reviews, then
      // roster order.
      if (a.pos !== b.pos) return b.pos - a.pos;
      if (a.r !== b.r) return a.r - b.r;
    }
    return a.rosterIndex - b.rosterIndex; // buckets 0/1/2 (and final tiebreak) by roster order
  });

  return candidates;
}

// Atomically claim `usernameNorm` for `reviewerName`, mirroring the live-slot
// lock pattern (acquireLiveSlot): the claim doc id is the username_norm, so two
// concurrent review-next calls contend on the SAME doc. `.create()` is atomic —
// exactly one concurrent writer wins. On an ALREADY_EXISTS collision we read the
// existing claim:
//   - active claim held by ANOTHER reviewer  → lost the race → return false (the
//                                              caller tries the next candidate).
//   - active claim already held by US         → idempotent re-claim → refresh +
//                                              return true.
//   - stale/expired claim                      → take it over (.set) → true.
// Returns true on a successful claim, false when another reviewer holds it live.
async function claimReviewUsername(usernameNorm, reviewerName, contestSlug = "") {
  const ref = reviewClaimRef(usernameNorm, contestSlug);
  const now = new Date().toISOString();
  const claimBody = {
    username_norm: usernameNorm, reviewer_name: reviewerName, claimed_at: now,
    ...(contestSlug ? { contest_slug: contestSlug } : {})
  };

  try {
    await ref.create(claimBody);
    return true;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }

  // The doc exists — re-read it INSIDE the contention path (it may be a stale
  // claim, our own claim, or a live claim by someone else).
  const doc = await ref.get();
  const existing = doc.exists ? doc.data() : null;
  const nowMs = Date.now();

  if (!existing || !isClaimActive(existing, nowMs)) {
    // Absent (raced-away) or expired → take it over.
    await ref.set(claimBody);
    return true;
  }
  if (reviewerKeyFor(existing.reviewer_name) === reviewerKeyFor(reviewerName)) {
    // We already hold it — refresh the timestamp and keep serving it to us.
    await ref.set(claimBody);
    return true;
  }
  // Held live by a different reviewer — lost the race.
  return false;
}

// POST /api/admin/review-verdict — record reviewer R's binary verdict for a
// roster username, then release (delete) that username's claim. Idempotent: a
// re-verdict overwrites the same (username, reviewer) doc; created_at is set only
// on the first write.
async function adminReviewVerdict(req) {
  requireAdmin(req);
  const body = parseBody(req);
  requireFields(body, ["username", "reviewer_name"]);
  if (body.verdict === undefined || body.verdict === null) return badRequest("verdict is required");
  const reviewerName = String(body.reviewer_name).trim();
  if (!reviewerName) return badRequest("reviewer_name is required");

  const verdict = Number(body.verdict);
  if (verdict !== 0 && verdict !== 1) return badRequest("verdict must be 0 or 1");

  const contestSlug = await reviewContestSlugOf(body.contest);
  const usernameNorm = normalizeUsername(body.username);
  // Roster-only: a verdict may only be recorded for a username currently on the
  // roster, so a typo / stale username can't create an orphan review record.
  const roster = await getReviewRoster(contestSlug);
  const rosterEntry = roster.find((entry) => entry.username_norm === usernameNorm);
  if (!rosterEntry) return badRequest("username is not on the review roster");

  const reviewerKey = reviewerKeyFor(reviewerName);
  const ref = reviewRecordRef(usernameNorm, reviewerKey, contestSlug);
  const now = new Date().toISOString();

  // Preserve created_at on the first write; a re-verdict only bumps updated_at +
  // verdict. We store the roster's display form for the username + the reviewer's
  // supplied display name.
  const existing = await ref.get();
  const createdAt = existing.exists ? (existing.data()?.created_at || now) : now;
  await ref.set({
    username: rosterEntry.username,
    username_norm: usernameNorm,
    reviewer_name: reviewerName,
    verdict,
    created_at: createdAt,
    updated_at: now,
    ...(contestSlug ? { contest_slug: contestSlug } : {})
  });

  // Release the claim so the username is immediately free for the next reviewer.
  // Best-effort + idempotent (delete of a missing doc is a no-op).
  await reviewClaimRef(usernameNorm, contestSlug).delete();

  return { ok: true };
}

// GET /api/admin/review-mine?reviewer_name=X — every review this reviewer
// completed, newest first.
async function adminReviewMine(req) {
  requireAdmin(req);
  const reviewerName = req.query?.reviewer_name;
  if (reviewerName === undefined || reviewerName === null || String(reviewerName).trim() === "") {
    return badRequest("reviewer_name is required");
  }
  const contestSlug = await reviewContestSlugOf(req.query?.contest);
  const reviewerKey = reviewerKeyFor(reviewerName);
  const reviews = (await getAllReviews(contestSlug))
    .filter((review) => reviewerKeyFor(review.reviewer_name) === reviewerKey)
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));

  return {
    count: reviews.length,
    reviews: reviews.map((review) => ({
      username: review.username,
      verdict: Number(review.verdict),
      created_at: review.created_at || ""
    }))
  };
}

// GET /api/admin/reviews?username=<optional> — ALL review records (multiple rows
// per username allowed), used to build the CSV username,reviewer_name,verdict.
async function adminReviews(req) {
  requireAdmin(req);
  const usernameFilter = req.query?.username;
  const contestSlug = await reviewContestSlugOf(req.query?.contest);
  let reviews = await getAllReviews(contestSlug);
  if (usernameFilter !== undefined && usernameFilter !== null && String(usernameFilter).trim() !== "") {
    const norm = normalizeUsername(usernameFilter);
    reviews = reviews.filter((review) => review.username_norm === norm);
  }
  reviews.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  return {
    reviews: reviews.map((review) => ({
      username: review.username,
      reviewer_name: review.reviewer_name,
      verdict: Number(review.verdict),
      created_at: review.created_at || ""
    }))
  };
}

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
// F9.3 (Karthi decision, Wave6): show_to_invigilator gates each type's appearance
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

// F9.3 (Karthi decision, Wave6): does this STORED alert appear on the invigilator
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
// requireInvigilator. Scope is ALWAYS the active contest from the settings doc;
// invigilators never pick a contest. Least privilege: these endpoints expose NO
// emails, NO IP addresses, NO signed media URLs.

// invigilatorOverview + the room-gate helpers (gateRoomKey/roomGateRef/
// getRoomGate/generateRoomOtp/publicRoomGate/requireGateEnabledSettings) +
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
  // Wave-4 fix: the gate FLAG follows the session's contest (person contests
  // own room_gate_enabled as an S-I snapshot field); the gate DOC below was
  // already per-(contest_slug, room). Legacy sessions keep the settings flag.
  const contest = await personContestForSession(session);
  const gateEnabled = contest
    ? Boolean(contest.room_gate_enabled)
    : Boolean((await getSettings())?.room_gate_enabled);
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

  // Wave-4 fix: the consequence follows the SESSION's config source — its
  // person contest's snapshot enforcement when it has one, else the global
  // settings doc (legacy parity).
  const contest = await personContestForSession(session);
  const enforcement = enforcementConfigFor(contest, contest ? null : await getSettings());
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

  // Wave-4 fix: same config-source rule as the self-report path — the
  // session's person contest wins over the global settings doc.
  const contest = await personContestForSession(session);
  const enforcement = enforcementConfigFor(contest, contest ? null : await getSettings());
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
async function requireExamStarted(session, settings) {
  // S3 nit: avoid the extra Firestore settings read on the exec HOT PATH. Once a
  // session has been released (exam_started_at stamped), the gate can never
  // reject it regardless of settings — so short-circuit BEFORE any read. The
  // settings read only happens for a not-yet-started session (the rare waiting
  // case). A caller that already holds settings may pass them through to skip the
  // read entirely. Behavior is identical: reject iff gate enabled AND not started.
  // Wave-4 fix: a person-contest session is gated by ITS contest's
  // room_gate_enabled (S-I snapshot field), never the global settings doc —
  // legacy sessions (no person contest) keep today's settings-driven gate.
  if (session.exam_started_at) return;
  const contest = await personContestForSession(session);
  const gateEnabled = contest
    ? Boolean(contest.room_gate_enabled)
    : Boolean((settings !== undefined ? settings : await getSettings())?.room_gate_enabled);
  if (gateEnabled) {
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

// getSession/getSessionOrNull/getSettings/requireWritableSession/sessionRef/
// settingsRef + the GCS-prefix builders (contestSlugFromUrl/buildStoragePrefix/
// sessionPrefix) + candidateOf moved to the makeSessionStore factory in
// lib/sessionStore.mjs (decomp B0); the instances are destructured at module
// scope (see the makeSessionStore(storeCtx) call near the top).

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

// ---- F5.3/F5.5: fullscreen enforcement config + per-session exemptions -----
//
// Three admin-tunable settings drive the candidate-side enforcement ladder:
//   fullscreen_reentry_seconds — L1 countdown to re-enter fullscreen (default 20)
//   fullscreen_exit_limit      — exits beyond this count escalate to L2 (default 2;
//                                0 = the first exit escalates immediately)
//   enforcement_mode           — "block" locks the session on violation;
//                                "alert_first" only raises the critical alert.
// All three are NaN-guarded to their defaults so a corrupt settings doc can
// never strand candidates, and they ride exam-config / start / heartbeat so
// the client applies changes live.
const FULLSCREEN_REENTRY_DEFAULT_SECONDS = 20;
const FULLSCREEN_EXIT_LIMIT_DEFAULT = 2;
const ENFORCEMENT_MODES = ["block", "alert_first"];

function intSettingOr(raw, fallback, minimum) {
  const num = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num < minimum) return fallback;
  return num;
}

function resolveEnforcementMode(candidate) {
  return ENFORCEMENT_MODES.includes(candidate) ? candidate : "block";
}

function enforcementConfig(settings) {
  return {
    fullscreen_reentry_seconds: intSettingOr(settings?.fullscreen_reentry_seconds, FULLSCREEN_REENTRY_DEFAULT_SECONDS, 1),
    fullscreen_exit_limit: intSettingOr(settings?.fullscreen_exit_limit, FULLSCREEN_EXIT_LIMIT_DEFAULT, 0),
    mode: resolveEnforcementMode(settings?.enforcement_mode)
  };
}

// F10.1 — separate low-res CAMERA recording stream. Defaults target Karthi's
// eye-movement bar (catch a candidate repeatedly glancing down at notes/a
// phone): ~10 fps, and just enough width to read eye direction. Admin-tunable
// within tight bounds; an invalid/blank value falls back to its DEFAULT
// (never 0 — the wave-2 blank-saves-0 hazard) so a bad payload can never
// persist an unusable camera config. Default ENABLED: only an explicit
// boolean false turns the camera stream off.
const CAMERA_RECORDING_DEFAULTS = { enabled: true, fps: 10, width: 640 };
const CAMERA_FPS_MIN = 1;
const CAMERA_FPS_MAX = 15;
const CAMERA_WIDTH_MIN = 320;
const CAMERA_WIDTH_MAX = 1280;

// intSettingOr with an upper bound too: out-of-range → fallback (not clamped),
// matching the existing "garbage falls back to the default" settings rule.
function boundedIntOr(raw, fallback, minimum, maximum) {
  const num = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num < minimum || num > maximum) return fallback;
  return num;
}

function normalizeCameraRecording(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : CAMERA_RECORDING_DEFAULTS.enabled,
    fps: boundedIntOr(source.fps, CAMERA_RECORDING_DEFAULTS.fps, CAMERA_FPS_MIN, CAMERA_FPS_MAX),
    width: boundedIntOr(source.width, CAMERA_RECORDING_DEFAULTS.width, CAMERA_WIDTH_MIN, CAMERA_WIDTH_MAX)
  };
}

function cameraRecordingConfig(settings) {
  return normalizeCameraRecording(settings?.camera_recording);
}

// ---- wave-4 fix: contest-owned enforcement/camera (S-I §1.4 snapshot) -------
// A session bound to a person contest serves the CONTEST's snapshot-copied
// enforcement/camera_recording fields; legacy sessions keep the global
// settings doc bit-for-bit. `contest` is the resolved person contest (or
// null). The template normalizers produce the exact same shape (and NaN
// guards) as the settings normalizers above, so a corrupt contest doc can
// never strand candidates either.
function enforcementConfigFor(contest, settings) {
  return contest ? normalizeTemplateEnforcement(contest.enforcement) : enforcementConfig(settings);
}

function cameraRecordingConfigFor(contest, settings) {
  return contest ? normalizeTemplateCameraRecording(contest.camera_recording) : cameraRecordingConfig(settings);
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

function publicSettings(settings) {
  const enforcement = enforcementConfig(settings);
  return {
    fullscreen_reentry_seconds: enforcement.fullscreen_reentry_seconds,
    fullscreen_exit_limit: enforcement.fullscreen_exit_limit,
    enforcement_mode: enforcement.mode,
    // F10.1: always normalized on read, so a legacy doc (no stored block)
    // reports the defaults (enabled / 10 fps / 640 w).
    camera_recording: cameraRecordingConfig(settings),
    start_at: settings?.start_at || "",
    end_at: settings?.end_at || "",
    contest_url: settings?.contest_url || "",
    // contest_slug is derived from contest_url and persisted at save time; we
    // recompute on read so an older settings doc (no stored slug) still reports
    // the right value. This is the slug all sure-shot alerts/sessions join on.
    contest_slug: settings?.contest_slug || contestSlugFromUrl(settings?.contest_url),
    problem_id: settings?.problem_id || "",
    room_gate_enabled: Boolean(settings?.room_gate_enabled),
    // S2: admin-configured room labels (student dropdown; later the invigilator
    // portal). Sanitized + deduped on read as well as on save.
    rooms: normalizeRooms(settings?.rooms),
    // Passcodes are removed (Phase 2, 0.1). These flags remain for backward
    // compatibility with any older admin UI; the backend no longer enforces them.
    passcode_set: Boolean(settings?.passcode_hash),
    passcode_preview: settings?.passcode_preview || "",
    end_code_set: Boolean(settings?.end_code_hash),
    end_code_preview: settings?.end_code_preview || "",
    updated_at: settings?.updated_at || ""
  };
}

// isHttpUrl moved to lib/http.mjs; normalizeUsername/sanitizeSegment/
// sanitizeObject/sanitizeEditorDetail/getClientIp/normalizeIp/hashPasscode/
// maskPasscode moved to lib/sanitize.mjs (decomp B0); imported at the top.

// http transport helpers (badRequest/httpError/httpErrorWith/positiveIntOr/
// setCors/send) moved to lib/http.mjs (decomp B0); imported at the top.
