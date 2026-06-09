import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Firestore, FieldValue } from "@google-cloud/firestore";
import { Storage } from "@google-cloud/storage";
import { makeJudge0Adapter } from "./judge0Adapter.mjs";
import { makeExecQueue } from "./execQueue.mjs";
import { getProblem, LANGUAGE_IDS } from "./problems.mjs";

let firestore = new Firestore();
let storage = new Storage();

// Dependency-injection seam for unit tests only. Production code never calls
// these; tests inject fake Firestore/Storage objects so no real GCP is touched.
export function __setClientsForTest({ firestore: fakeFirestore, storage: fakeStorage } = {}) {
  if (fakeFirestore) firestore = fakeFirestore;
  if (fakeStorage) storage = fakeStorage;
}

// Single adapter, built from env on first use. Tests inject a stub via
// __setJudge0AdapterForTest (mirrors __setClientsForTest). Pass null to reset.
let _judge0 = null;
let _judge0Override = null;
export function __setJudge0AdapterForTest(adapter) {
  _judge0Override = adapter || null;
}
function judge0() {
  if (_judge0Override) return _judge0Override;
  if (!_judge0) {
    _judge0 = makeJudge0Adapter({
      baseUrl: JUDGE0_BASE_URL, mode: JUDGE0_MODE,
      apiKey: JUDGE0_API_KEY, authToken: JUDGE0_AUTH_TOKEN
    });
  }
  return _judge0;
}

// Injectable epoch-ms clock for the per-session exec rate limiter (mirrors the
// __setClientsForTest seam) so cooldown tests are deterministic. Production
// always uses the real clock; pass null/undefined to restore it.
let _execClock = () => Date.now();
export function __setExecClockForTest(fn) {
  _execClock = fn || (() => Date.now());
}

const SESSION_COLLECTION = process.env.SESSION_COLLECTION || "proctor_sessions";
const SETTINGS_COLLECTION = process.env.SETTINGS_COLLECTION || "proctor_settings";
const ALERTS_COLLECTION = process.env.ALERTS_COLLECTION || "proctor_alerts";
// Submission-time markers (poller-sourced) for the recording-review timeline.
// ONE doc per (username_norm, contest_slug) holding the merged, de-duped-by-
// submission_id events array, so a re-post is an idempotent upsert.
const SUBMISSION_EVENTS_COLLECTION = process.env.SUBMISSION_EVENTS_COLLECTION || "proctor_submission_events";
// H1: per-(username_norm, contest_slug) live-slot lock. A start atomically
// .create()s the lock doc; exactly one concurrent writer wins the slot and goes
// active, the rest fall to pending_approval. Released when the owning session
// ends so a later legitimate restart can re-acquire it.
const LIVE_LOCK_COLLECTION = process.env.LIVE_LOCK_COLLECTION || "proctor_live_locks";
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
const REVIEW_STATE_COLLECTION = process.env.REVIEW_STATE_COLLECTION || "proctor_review_state";
const REVIEW_COLLECTION = process.env.REVIEW_COLLECTION || "proctor_reviews";
const REVIEW_CLAIMS_COLLECTION = process.env.REVIEW_CLAIMS_COLLECTION || "proctor_review_claims";
const REVIEW_ROSTER_ID = "roster";
// A claim this many ms old (or older) is stale — its reviewer is presumed gone,
// so the username becomes claimable again by anyone (mirrors the live-slot
// stale-lock takeover, but TTL-based since reviewers don't emit an "ended").
const CLAIM_TTL_MS = 10 * 60 * 1000;
// Bound the roster the operator can set in one request, and the per-username
// reviews scan, so a pathological payload can't bloat a request.
const REVIEW_ROSTER_LIMIT = 5000;
const REVIEWS_QUERY_LIMIT = 20000;
const EVIDENCE_BUCKET = process.env.EVIDENCE_BUCKET;
const JUDGE0_BASE_URL = process.env.JUDGE0_BASE_URL || "https://judge0-ce.p.rapidapi.com";
const JUDGE0_MODE = process.env.JUDGE0_MODE || "rapidapi";
const JUDGE0_API_KEY = process.env.JUDGE0_API_KEY;
const JUDGE0_AUTH_TOKEN = process.env.JUDGE0_AUTH_TOKEN;
const SUBMISSIONS_COLLECTION = process.env.SUBMISSIONS_COLLECTION || "proctor_submissions";
const EDITOR_EVENTS_COLLECTION = process.env.EDITOR_EVENTS_COLLECTION || "editor-events"; // GCS sub-prefix label
const EDITOR_EVENTS_INGEST_LIMIT = Number(process.env.EDITOR_EVENTS_INGEST_LIMIT || "5000");
const MAX_SOURCE_CODE_LENGTH = 65536; // exec run/submit: cap candidate source size (security review)
// Per-session exec rate limits (security review): the hosted Judge0 key is
// METERED (pay-per-submission), so a leaked or looping session token must not
// be able to drain it. One run per EXEC_RUN_COOLDOWN_SECONDS, one submit per
// EXEC_SUBMIT_COOLDOWN_SECONDS, and at most EXEC_MAX_SUBMISSIONS_PER_SESSION
// stored submissions per session+problem.
const EXEC_RUN_COOLDOWN_SECONDS = Number(process.env.EXEC_RUN_COOLDOWN_SECONDS || "5");
const EXEC_SUBMIT_COOLDOWN_SECONDS = Number(process.env.EXEC_SUBMIT_COOLDOWN_SECONDS || "20");
const EXEC_MAX_SUBMISSIONS_PER_SESSION = Number(process.env.EXEC_MAX_SUBMISSIONS_PER_SESSION || "50");
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
const EXEC_RUN_CONCURRENCY = Number(process.env.EXEC_RUN_CONCURRENCY || "2");
const EXEC_SUBMIT_CONCURRENCY = Number(process.env.EXEC_SUBMIT_CONCURRENCY || "4");
const EXEC_POLL_CONCURRENCY = Number(process.env.EXEC_POLL_CONCURRENCY || "16");
const EXEC_MAX_QUEUE = Number(process.env.EXEC_MAX_QUEUE || "200");
const execQueue = makeExecQueue({
  runConcurrency: EXEC_RUN_CONCURRENCY,
  submitConcurrency: EXEC_SUBMIT_CONCURRENCY,
  pollConcurrency: EXEC_POLL_CONCURRENCY,
  maxQueue: EXEC_MAX_QUEUE
  // pollMaxQueue stays at its generous default (1000).
});
const PUBLIC_APP_ORIGIN = process.env.PUBLIC_APP_ORIGIN || "*";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ALERTS_INGEST_API_KEY = process.env.ALERTS_INGEST_API_KEY;
const URL_EXPIRY_SECONDS = Number(process.env.URL_EXPIRY_SECONDS || "900");
const ALERTS_QUERY_LIMIT = 500;
const SESSIONS_QUERY_LIMIT = 2000;
const SETTINGS_ID = "active";
// Settings doc id for the per-type proctor alert configuration (enabled +
// severity). Lives in the same SETTINGS_COLLECTION but under a distinct doc id
// so it never collides with the schedule/contest "active" settings doc.
const ALERT_SETTINGS_ID = "alert_settings";
// A session whose status is still active but whose last liveness signal
// (heartbeat or beacon) is older than this many milliseconds is treated as a
// derived "disconnected" signal for the console. Configurable via env.
const DISCONNECTED_STALENESS_MS = Number(process.env.DISCONNECTED_STALENESS_MS || "45000");
// Cap on the distinct rooms list returned to the admin console so a pathological
// number of room labels can never bloat a stats/alerts response.
const ROOMS_LIST_LIMIT = 200;

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

export const api = async (req, res) => {
  try {
    setCors(res);
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
    if (req.method === "POST" && path === "/api/review-file") return send(res, 200, await recordReviewFile(req));
    if (req.method === "POST" && path === "/api/heartbeat") return send(res, 200, await recordHeartbeat(req));
    if (req.method === "POST" && path === "/api/session/beacon") return send(res, 200, await recordBeacon(req));
    if (req.method === "POST" && path === "/api/session/validate-end") return send(res, 200, await validateEndSession(req));
    if (req.method === "POST" && path === "/api/session/end") return send(res, 200, await endSession(req));
    if (req.method === "GET" && path === "/api/admin/settings") return send(res, 200, await adminGetSettings(req));
    if (req.method === "POST" && path === "/api/admin/settings") return send(res, 200, await adminSaveSettings(req));
    if (req.method === "GET" && path === "/api/admin/sessions") return send(res, 200, await adminSessions(req));
    if (req.method === "GET" && path === "/api/admin/recording-sessions") return send(res, 200, await adminRecordingSessions(req));
    if (req.method === "GET" && path === "/api/admin/sessions-list") return send(res, 200, await adminSessionsList(req));
    if (req.method === "POST" && path === "/api/submission-events") return send(res, 200, await ingestSubmissionEvents(req));
    if (req.method === "GET" && path === "/api/admin/submission-events") return send(res, 200, await adminSubmissionEvents(req));
    if (req.method === "GET" && path === "/api/admin/stats") return send(res, 200, await adminStats(req));
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
      return send(res, statusCode, body);
    }
    return send(res, 500, { error: "Internal server error" });
  }
};

async function startSession(req) {
  const body = parseBody(req);
  // Phase 2 (0.1): the entry passcode is gone. Start is gated only by the
  // contest time window + complete details. `proctor_passcode` is no longer
  // required (a client may still send it harmlessly; it is ignored).
  requireFields(body, ["hackerrank_username", "name", "roll_number", "email"]);
  if (body.consent_accepted !== true) {
    return badRequest("Consent is required");
  }
  const settings = await validateProctorGate();

  const now = new Date().toISOString();
  const username = String(body.hackerrank_username).trim();
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
    name: String(body.name).trim(),
    roll_number: String(body.roll_number).trim(),
    email: String(body.email).trim(),
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
    chunk_count: 0
  };

  await sessionRef(sessionId).create(item);
  await putJsonl(`${item.storage_prefix}events/session.jsonl`, [{
    type: "session_started",
    timestamp: now,
    detail: { user_agent: req.get?.("user-agent") || req.headers?.["user-agent"] || "", start_ip: clientIp }
  }]);

  return startResponse(item, settings);
}

// Resume an existing session by its stored token without re-collecting details.
// Used by a browser reload (Epic 2.1/2.2). 404 when the token is unknown or
// does not belong to the supplied username.
async function resumeSession(req) {
  const body = parseBody(req);
  requireFields(body, ["session_id"]);
  const session = await getSessionOrNull(body.session_id);
  if (!session) throw httpError(404, "Session not found");
  if (body.hackerrank_username) {
    const usernameNorm = normalizeUsername(body.hackerrank_username);
    if (session.username_norm !== usernameNorm) throw httpError(404, "Session not found");
  }
  const settings = await getSettings();
  return startResponse(session, settings || {});
}

// Shared start/resume payload so the browser always gets the same shape whether
// it just started, replayed a token, or resumed after reload.
function startResponse(session, settings) {
  return {
    session_id: session.session_id,
    status: session.status,
    hackerrank_username: session.hackerrank_username,
    name: session.name,
    room: session.room || "",
    contest_slug: session.contest_slug || "",
    storage_prefix: session.storage_prefix || buildStoragePrefix(session.contest_slug, session.username_norm, session.session_id),
    blocked_by_session_id: session.blocked_by_session_id || null,
    start_ip: session.start_ip || session.current_ip || "",
    contest_url: settings?.contest_url || "",
    upload_config: uploadConfig,
    heartbeat_interval_seconds: 15
  };
}

// Find the session that currently holds the live slot for (username, contest):
// any non-ended session blocks a new active start. active wins over
// locked/pending for the conflict pointer when more than one exists.
async function findLiveSessionFor(usernameNorm, contestSlug) {
  const snapshot = await firestore
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
  return firestore.collection(LIVE_LOCK_COLLECTION).doc(liveLockId(usernameNorm, contestSlug));
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

async function createUploadUrl(req) {
  const body = parseBody(req);
  requireFields(body, ["session_id", "kind", "chunk_index", "content_type"]);
  const session = requireWritableSession(await getSession(body.session_id));
  const kind = sanitizeSegment(body.kind);
  const chunkIndex = Number(body.chunk_index);
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
    return badRequest("Invalid chunk_index");
  }

  const extension = String(body.content_type).includes("webm") ? "webm" : "bin";
  const objectKey = `${sessionPrefix(session)}${kind}/chunk-${String(chunkIndex).padStart(5, "0")}.${extension}`;
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
    chunk_count: FieldValue.increment(1)
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

  return { ok: true, storage_key: eventKey };
}

// ---- Per-session exec rate limiting (security review) ----------------------
// The metered Judge0 key must not be drainable by a looping/scripted session
// token. In-memory, module-level state — fine for the current SINGLE-INSTANCE
// Cloud Run deploy; with N instances each enforces its own window, so the
// effective limit is up to N× looser. Move to Firestore/Redis if we scale out.
// Entries are only created for sessions that passed the ownership gate (real
// session tokens), and the idle sweep below bounds the Map regardless.
const EXEC_LIMITER_PRUNE_MS = 60 * 60 * 1000;
const execLimiter = new Map(); // session_id -> { lastRunMs, lastSubmitMs, submitCounts: Map(problem_id -> n), lastSeenMs }

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
    entry = { lastRunMs: -Infinity, lastSubmitMs: -Infinity, submitCounts: new Map(), lastSeenMs: nowMs };
    execLimiter.set(sessionId, entry);
  }
  entry.lastSeenMs = nowMs;
  return entry;
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
function checkExecRunLimit(sessionId) {
  const entry = execLimiterEntry(sessionId);
  const waitMs = EXEC_RUN_COOLDOWN_SECONDS * 1000 - (_execClock() - entry.lastRunMs);
  if (waitMs > 0) throw rateLimited(Math.ceil(waitMs / 1000));
  return entry;
}

function checkExecSubmitLimit(sessionId, problemId) {
  const entry = execLimiterEntry(sessionId);
  const waitMs = EXEC_SUBMIT_COOLDOWN_SECONDS * 1000 - (_execClock() - entry.lastSubmitMs);
  if (waitMs > 0) throw rateLimited(Math.ceil(waitMs / 1000));
  // Hard per-session+problem budget on STORED submissions. Only a successful
  // store increments the count, so invalid problem ids can never grow the map.
  // The budget resets only when the idle sweep prunes the whole entry — report
  // that horizon as the retry hint.
  if ((entry.submitCounts.get(problemId) || 0) >= EXEC_MAX_SUBMISSIONS_PER_SESSION) {
    throw rateLimited(Math.ceil(EXEC_LIMITER_PRUNE_MS / 1000));
  }
  return entry;
}

async function execRun(req) {
  const body = parseBody(req);
  const sessionId = String(body.session_id || "");
  // Ownership gate: unknown session → 404; ended/locked/pending → 409/403.
  requireWritableSession(await getSession(sessionId));
  // Rate-limit check BEFORE any judge0 work (metered key — see the limiter).
  const limiter = checkExecRunLimit(sessionId);
  const problem = getProblem(String(body.problem_id || ""));
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
  // while one is parked in the lane.
  const prevLastRunMs = limiter.lastRunMs;
  const runStampMs = _execClock();
  limiter.lastRunMs = runStampMs;
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
    // never clobber the newer stamp a later request legitimately recorded.
    if (limiter.lastRunMs === runStampMs) limiter.lastRunMs = prevLastRunMs;
    if (error?.name === "QueueFullError") throw queueFull();
    if (typeof error?.status === "number") throw judgeUnavailable();
    throw error; // genuine programming error -> bare 500
  }
  // echo sample input/expected for display (samples are NOT secret)
  return { results: results.map((r, i) => ({ ...r, input: problem.sampleTests[i].input, expected: problem.sampleTests[i].expected })) };
}

async function execSubmit(req) {
  const body = parseBody(req);
  const sessionId = String(body.session_id || "");
  // Ownership gate (same as /api/events): unknown → 404; ended/locked/pending → 409/403.
  requireWritableSession(await getSession(sessionId));
  // Rate-limit check BEFORE any judge0 work (metered key — see the limiter).
  // The cap is keyed on the raw problem_id string; only stored submissions
  // increment it, so invalid ids can never grow the per-session count map.
  const limiter = checkExecSubmitLimit(sessionId, String(body.problem_id || ""));
  const problem = getProblem(String(body.problem_id || ""));
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
  // submits while one is parked in the lane.
  const prevLastSubmitMs = limiter.lastSubmitMs;
  const submitStampMs = _execClock();
  limiter.lastSubmitMs = submitStampMs;
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
    // never clobber the newer stamp a later request legitimately recorded.
    if (limiter.lastSubmitMs === submitStampMs) limiter.lastSubmitMs = prevLastSubmitMs;
    if (error?.name === "QueueFullError") throw queueFull();
    if (typeof error?.status === "number") throw judgeUnavailable();
    throw error; // genuine programming error -> bare 500
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
    await firestore.collection(SUBMISSIONS_COLLECTION).doc(submissionId).set({
      session_id: sessionId, problem_id: problem.id, language: body.language,
      source_code: source, verdict, passed_count: passedCount, total: results.length,
      tests, created_at: createdAt
    });
  } catch (error) {
    // The engine run already happened (and was BILLED) — a store failure must
    // not discard the verdict with a 500. Surface it flagged as un-stored (no
    // submission_id), keep the cooldown consumed (the run was real), and do
    // NOT charge the stored-submissions budget (nothing was stored).
    console.error(`Failed to store submission ${submissionId} for session ${sessionId}: ${error?.message || error}`);
    return { verdict, passed_count: passedCount, total: results.length, stored: false };
  }

  // Count the STORED submission against the per-session+problem budget
  // (problem.id === the validated problem_id string the cap was checked with).
  limiter.submitCounts.set(problem.id, (limiter.submitCounts.get(problem.id) || 0) + 1);

  // §9 lock: candidates see ONLY pass/fail counts on hidden tests. The stored
  // doc keeps the per-test detail for admin-side analysis; the response doesn't.
  return { verdict, passed_count: passedCount, total: results.length, submission_id: submissionId };
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
  return { ok: true, status: session.status || "active", start_ip: startIp, current_ip: currentIp, ip_changed: ipChanged, newly_changed: newlyChanged };
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
  // active session ends normally (the happy path).
  const session = requireWritableSession(await getSession(body.session_id));
  const manifest = Array.isArray(body.manifest) ? body.manifest : [];
  const now = new Date().toISOString();
  const manifestKey = `${sessionPrefix(session)}manifest.json`;

  await bucket().file(manifestKey).save(JSON.stringify({ session_id: session.session_id, ended_at: now, manifest }, null, 2), {
    contentType: "application/json"
  });

  await sessionRef(session.session_id).update({
    updated_at: now,
    ended_at: now,
    status: "ended",
    manifest_key: manifestKey,
    uploaded_manifest_count: manifest.length
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

  // Phase 2 (0.1): passcodes are removed. They are no longer REQUIRED to save
  // settings, and start/end are gated only by the time window. We still persist
  // any passcode/end_code an older admin UI happens to send so the stored doc is
  // backward-compatible, but nothing reads the hashes anymore.
  const now = new Date().toISOString();
  const passcode = String(body.passcode || "");
  const endCode = String(body.end_code || "");
  if (passcode && passcode.length < 4) return badRequest("Passcode must be at least 4 characters.");
  if (endCode && endCode.length < 4) return badRequest("End code must be at least 4 characters.");

  const item = {
    start_at: startAt.toISOString(),
    end_at: endAt.toISOString(),
    contest_url: contestUrl,
    contest_slug: contestSlugFromUrl(contestUrl),
    passcode_hash: passcode ? hashPasscode(passcode) : (existing?.passcode_hash || ""),
    passcode_preview: passcode ? maskPasscode(passcode) : (existing?.passcode_preview || ""),
    end_code_hash: endCode ? hashPasscode(endCode) : (existing?.end_code_hash || ""),
    end_code_preview: endCode ? maskPasscode(endCode) : (existing?.end_code_preview || ""),
    updated_at: now
  };

  await settingsRef().set(item);
  return publicSettings(item);
}

// Run an async mapper over items with a bounded number of concurrent workers, so
// a single request can't fan out into hundreds of simultaneous GCS/IAM calls.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker)
  );
  return results;
}

async function adminSessions(req) {
  requireAdmin(req);
  const username = req.query?.username;
  if (!username) return badRequest("username is required");

  const usernameNorm = normalizeUsername(username);
  const snapshot = await firestore
    .collection(SESSION_COLLECTION)
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
      return { ...item, evidence };
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
  const contestSlug = req.query?.contest_slug;

  let query = firestore.collection(SESSION_COLLECTION);
  if (contestSlug !== undefined && contestSlug !== null && contestSlug !== "") {
    query = query.where("contest_slug", "==", String(contestSlug));
  }
  const snapshot = await query.limit(SESSIONS_QUERY_LIMIT).get();
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
      name: doc.name || "",
      room: doc.room || "",
      contest_slug: doc.contest_slug || "",
      chunk_count: Number(doc.chunk_count || 0),
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
  const contestSlug = req.query?.contest_slug;
  const room = normalizeRoomFilter(req.query?.room);
  const status = String(req.query?.status || "");
  let query = firestore.collection(SESSION_COLLECTION);
  if (contestSlug !== undefined && contestSlug !== null && contestSlug !== "") {
    query = query.where("contest_slug", "==", String(contestSlug));
  }
  const snapshot = await query.limit(SESSIONS_QUERY_LIMIT).get();
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
  const sessions = docs
    .filter(matchesStatus)
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))
    .slice(0, 500)
    .map((doc) => ({
      session_id: doc.session_id,
      hackerrank_username: doc.hackerrank_username || "",
      name: doc.name || "",
      room: doc.room || "",
      contest_slug: doc.contest_slug || "",
      chunk_count: Number(doc.chunk_count || 0),
      created_at: doc.created_at || "",
      status: doc.status || ""
    }));
  return { sessions };
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
  return firestore.collection(SUBMISSION_EVENTS_COLLECTION).doc(submissionEventsDocId(usernameNorm, contestSlug));
}

// Validate + normalize one inbound submission event. submission_id is coerced to
// a string so it is a stable de-dupe key whether the poller sends an int or str.
function normalizeSubmissionEvent(event, index) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw httpError(400, `events[${index}] must be an object`);
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
    const snapshot = await firestore
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
  const room = normalizeRoomFilter(req.query?.room);

  let query = firestore.collection(SESSION_COLLECTION);
  if (contestSlug !== undefined && contestSlug !== null && contestSlug !== "") {
    query = query.where("contest_slug", "==", String(contestSlug));
  }
  const snapshot = await query.limit(SESSIONS_QUERY_LIMIT).get();
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

  return {
    contest_slug: contestSlug ? String(contestSlug) : null,
    room: room || null,
    stats,
    rooms,
    disconnected_staleness_ms: DISCONNECTED_STALENESS_MS
  };
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

// Phase 2 (2.4 / Epic 4.3): remote admin actions, per-session (session_id) or in
// bulk (usernames[] within a contest). Returns the updated docs so the console
// can reflect the new state immediately.
async function adminSessionAction(req) {
  requireAdmin(req);
  const body = parseBody(req);
  const action = String(body.action || "");
  const VALID_ACTIONS = ["approve", "lock", "unlock", "bypass", "end"];
  if (!VALID_ACTIONS.includes(action)) {
    return badRequest(`action must be one of ${VALID_ACTIONS.join(", ")}`);
  }

  const targets = await resolveActionTargets(body);
  if (!targets.length) return badRequest("Provide session_id or a non-empty usernames[]");

  const updated = [];
  for (const session of targets) {
    const result = await applySessionAction(action, session);
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
      let query = firestore
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

async function applySessionAction(action, session) {
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
    await sessionRef(session.session_id).update({ status: "active", unlocked_at: now, updated_at: now });
    return { ...session, status: "active", unlocked_at: now, updated_at: now };
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
    let query = firestore
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

function reviewRosterRef() {
  return firestore.collection(REVIEW_STATE_COLLECTION).doc(REVIEW_ROSTER_ID);
}

function reviewRecordId(usernameNorm, reviewerKey) {
  return `${usernameNorm}::${reviewerKey}`;
}

function reviewRecordRef(usernameNorm, reviewerKey) {
  return firestore.collection(REVIEW_COLLECTION).doc(reviewRecordId(usernameNorm, reviewerKey));
}

function reviewClaimRef(usernameNorm) {
  return firestore.collection(REVIEW_CLAIMS_COLLECTION).doc(usernameNorm);
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
  if (!Array.isArray(body.usernames)) return badRequest("usernames must be an array");
  if (body.usernames.length > REVIEW_ROSTER_LIMIT) {
    return badRequest(`Too many usernames in one request (max ${REVIEW_ROSTER_LIMIT})`);
  }
  const entries = normalizeRoster(body.usernames);
  const now = new Date().toISOString();
  // .set() (no merge) REPLACES the roster — a removed username is gone, matching
  // "replace the roster" rather than "append".
  await reviewRosterRef().set({ entries, updated_at: now });
  return { ok: true, count: entries.length };
}

// Read the persisted roster as [{ username, username_norm }] in roster order.
async function getReviewRoster() {
  const doc = await reviewRosterRef().get();
  if (!doc.exists) return [];
  const entries = doc.data()?.entries;
  return Array.isArray(entries) ? entries : [];
}

// All review records across the whole collection (used for summary counts and
// the serving priority). Capped so a pathological collection can't bloat a
// request.
async function getAllReviews() {
  const snapshot = await firestore.collection(REVIEW_COLLECTION).limit(REVIEWS_QUERY_LIMIT).get();
  return snapshot.docs.map((doc) => doc.data());
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
  const roster = await getReviewRoster();
  const reviews = await getAllReviews();
  const claims = await getActiveClaims();

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

// Every currently-active (non-expired) claim across the claims collection.
async function getActiveClaims() {
  const snapshot = await firestore.collection(REVIEW_CLAIMS_COLLECTION).limit(REVIEW_ROSTER_LIMIT).get();
  const nowMs = Date.now();
  return snapshot.docs.map((doc) => doc.data()).filter((claim) => isClaimActive(claim, nowMs));
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
  const reviewerName = String(body.reviewer_name).trim();
  if (!reviewerName) return badRequest("reviewer_name is required");
  const reviewerKey = reviewerKeyFor(reviewerName);

  const roster = await getReviewRoster();
  if (!roster.length) return { done: true };

  const reviews = await getAllReviews();
  const byUsername = indexReviewsByUsername(reviews);
  const claimsByNorm = await loadClaimsByNorm();

  const candidates = rankReviewCandidates(roster, byUsername, reviewerKey, Date.now(), claimsByNorm);

  // Walk candidates best-first; the first one we can atomically claim wins. A
  // lost claim race falls through to the next candidate.
  for (const candidate of candidates) {
    const claimed = await claimReviewUsername(candidate.username_norm, reviewerName);
    if (claimed) return { username: candidate.username };
  }
  return { done: true };
}

// Load every claim doc keyed by username_norm (raw, including stale ones) so the
// ranking pass can decide claimable-ness with a single read. Stale claims are
// filtered in rankReviewCandidates so they don't exclude a username.
async function loadClaimsByNorm() {
  const snapshot = await firestore.collection(REVIEW_CLAIMS_COLLECTION).limit(REVIEW_ROSTER_LIMIT).get();
  const byNorm = new Map();
  for (const doc of snapshot.docs) {
    const claim = doc.data();
    if (claim?.username_norm) byNorm.set(claim.username_norm, claim);
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
async function claimReviewUsername(usernameNorm, reviewerName) {
  const ref = reviewClaimRef(usernameNorm);
  const now = new Date().toISOString();
  const claimBody = { username_norm: usernameNorm, reviewer_name: reviewerName, claimed_at: now };

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

  const usernameNorm = normalizeUsername(body.username);
  // Roster-only: a verdict may only be recorded for a username currently on the
  // roster, so a typo / stale username can't create an orphan review record.
  const roster = await getReviewRoster();
  const rosterEntry = roster.find((entry) => entry.username_norm === usernameNorm);
  if (!rosterEntry) return badRequest("username is not on the review roster");

  const reviewerKey = reviewerKeyFor(reviewerName);
  const ref = reviewRecordRef(usernameNorm, reviewerKey);
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
    updated_at: now
  });

  // Release the claim so the username is immediately free for the next reviewer.
  // Best-effort + idempotent (delete of a missing doc is a no-op).
  await reviewClaimRef(usernameNorm).delete();

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
  const reviewerKey = reviewerKeyFor(reviewerName);
  const reviews = (await getAllReviews())
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
  let reviews = await getAllReviews();
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
const TAB_AWAY_DEFAULT_THRESHOLD_SECONDS = 12;
const DEFAULT_PROCTOR_ALERT_SETTINGS = {
  recording_stopped: { enabled: true, severity: "critical" },
  screen_share_stopped: { enabled: true, severity: "critical" },
  recording_error: { enabled: true, severity: "critical" },
  ip_changed: { enabled: true, severity: "warning" },
  tab_hidden: { enabled: true, severity: "warning" },
  tab_away: { enabled: true, severity: "warning", threshold_seconds: TAB_AWAY_DEFAULT_THRESHOLD_SECONDS },
  disconnected: { enabled: true, severity: "warning" }
};

// Read the stored alert-settings doc and merge it over the defaults so callers
// always see a complete, well-formed per-type config. One Firestore read; call
// once per request and thread the result into the sure-shot upsert sites so a
// single request never re-reads it.
async function getAlertSettings() {
  const doc = await firestore.collection(SETTINGS_COLLECTION).doc(ALERT_SETTINGS_ID).get();
  const stored = doc.exists ? (doc.data()?.proctor || {}) : {};
  return mergeAlertSettings(stored);
}

function mergeAlertSettings(stored) {
  const proctor = {};
  for (const [type, def] of Object.entries(DEFAULT_PROCTOR_ALERT_SETTINGS)) {
    const override = stored && typeof stored === "object" ? stored[type] : undefined;
    const entry = {
      enabled: override && typeof override.enabled === "boolean" ? override.enabled : def.enabled,
      severity: override && ALERT_SEVERITIES.includes(override.severity) ? override.severity : def.severity
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

  const item = {
    id,
    source: "proctor",
    type,
    severity,
    timestamp: isoOrNow(timestamp),
    hackerrank_username: session.hackerrank_username,
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

function isoOrNow(value) {
  if (value && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return new Date().toISOString();
}

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
  const contestSlug = req.query?.contest_slug;
  const severity = req.query?.severity;
  const source = req.query?.source;
  const room = normalizeRoomFilter(req.query?.room);
  const includeArchived = isTruthyParam(req.query?.include_archived);

  // B6: applying ALL THREE equality filters server-side (contest_slug + severity
  // + source) would need a composite Firestore index that doesn't exist. To stay
  // index-free (lower risk than relying on a deployed composite index), we push
  // AT MOST ONE equality filter to Firestore — the most selective, contest_slug —
  // and filter the remaining fields in memory. ALERTS_QUERY_LIMIT bounds the scan.
  let query = firestore.collection(ALERTS_COLLECTION);
  if (contestSlug) query = query.where("contest_slug", "==", String(contestSlug));

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
  const rooms = await listSessionRooms(contestSlug);

  return { alerts: withUrls, rooms };
}

// Distinct room labels across session docs (optionally scoped to a contest),
// capped. Shared by adminAlerts so its room dropdown matches adminStats'.
async function listSessionRooms(contestSlug) {
  let query = firestore.collection(SESSION_COLLECTION);
  if (contestSlug !== undefined && contestSlug !== null && contestSlug !== "") {
    query = query.where("contest_slug", "==", String(contestSlug));
  }
  const snapshot = await query.limit(SESSIONS_QUERY_LIMIT).get();
  return distinctRooms(snapshot.docs.map((doc) => doc.data()));
}

// A query param is "truthy" when it is the string "true"/"1"/"yes" (case
// insensitive) or the boolean true. Anything else (incl. absent) is false.
function isTruthyParam(value) {
  if (value === true) return true;
  const lowered = String(value === undefined || value === null ? "" : value).toLowerCase();
  return lowered === "true" || lowered === "1" || lowered === "yes";
}

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
  await firestore.collection(SETTINGS_COLLECTION).doc(ALERT_SETTINGS_ID).set({
    proctor: merged.proctor,
    updated_at: now
  });
  return merged;
}

async function resolveSignedReadUrl(objectKey) {
  // Best-effort: a missing bucket or a signing failure must not break the whole
  // admin listing, so we degrade to null instead of throwing.
  try {
    const [downloadUrl] = await bucket()
      .file(String(objectKey))
      .getSignedUrl({
        version: "v4",
        action: "read",
        expires: Date.now() + URL_EXPIRY_SECONDS * 1000
      });
    return downloadUrl;
  } catch (error) {
    console.warn(`Failed to sign read URL for ${objectKey}: ${error?.message || error}`);
    return null;
  }
}

function alertRef(alertId) {
  return firestore.collection(ALERTS_COLLECTION).doc(String(alertId));
}

async function getSession(sessionId) {
  const doc = await sessionRef(sessionId).get();
  if (!doc.exists) throw httpError(404, "Session not found");
  return doc.data();
}

// H3: gate every client WRITE endpoint on session status so admin lock/end and
// the pending-approval hold actually stop the browser instead of silently
// accepting more evidence/heartbeats:
//   ended  → 409 session_ended (the test is over; no further writes)
//   locked → 403 session_locked (admin paused it; needs unlock)
//   pending_approval → 403 waiting_for_approval (second device, not yet live)
// active (and any unknown/legacy status) is allowed so happy paths are unchanged.
function requireWritableSession(session) {
  const status = session?.status;
  if (status === "ended") throw httpError(409, "session_ended");
  if (status === "locked") throw httpError(403, "session_locked");
  if (status === "pending_approval") throw httpError(403, "waiting_for_approval");
  return session;
}

// Like getSession but returns null instead of throwing — used by resume and
// single-session reconciliation where "not found" is a normal control-flow path.
async function getSessionOrNull(sessionId) {
  const doc = await sessionRef(String(sessionId)).get();
  return doc.exists ? doc.data() : null;
}

async function getSettings() {
  const doc = await settingsRef().get();
  return doc.exists ? doc.data() : null;
}

// ---- GCS contest-foldering (Phase 2, 2.1) ---------------------------------
// ONE place that turns a contest_url into a path slug, and ONE place that
// assembles the per-session GCS prefix. Every key-build site calls
// sessionPrefix(session) so upload, signing, and admin-evidence listing always
// agree. New shape: contests/<slug>/sessions/<username_norm>/<session_id>/...
// Legacy fallback (no/invalid contest_url): sessions/<username_norm>/<session_id>/...

// Extract the contest slug from a contest_url: last non-empty path segment, then
// the existing sanitizeSegment. Empty/invalid url → "" (legacy, no contest folder).
function contestSlugFromUrl(contestUrl) {
  if (!contestUrl) return "";
  let pathname;
  try {
    pathname = new URL(String(contestUrl)).pathname;
  } catch {
    return "";
  }
  const segments = String(pathname).split("/").filter(Boolean);
  if (!segments.length) return "";
  return sanitizeSegment(segments[segments.length - 1]);
}

// Build the per-session prefix from parts. Slug present → contest folder; absent
// → legacy layout (and never a contests// double-slash).
function buildStoragePrefix(contestSlug, usernameNorm, sessionId) {
  if (contestSlug) {
    return `contests/${contestSlug}/sessions/${usernameNorm}/${sessionId}/`;
  }
  return `sessions/${usernameNorm}/${sessionId}/`;
}

// The prefix for an existing session doc. Prefer the persisted storage_prefix
// (zero extra reads); fall back to reconstructing from stored fields so legacy
// docs written before Phase 2 still resolve to their original legacy path.
function sessionPrefix(session) {
  if (session && session.storage_prefix) return session.storage_prefix;
  return buildStoragePrefix(session?.contest_slug, session?.username_norm, session?.session_id);
}

// Room label sanitizer (Epic 4.2): a short human-readable label, stored on the
// session/alert for display only (never used in a GCS key). Keep letters,
// digits, space, dash, dot, underscore; bound the length. Never throws.
function sanitizeRoom(value) {
  return String(value).trim().replace(/[^a-zA-Z0-9 ._-]/g, "").slice(0, 80);
}

function sessionRef(sessionId) {
  return firestore.collection(SESSION_COLLECTION).doc(sessionId);
}

function settingsRef() {
  return firestore.collection(SETTINGS_COLLECTION).doc(SETTINGS_ID);
}

async function putJsonl(key, records) {
  await bucket().file(key).save(records.map((record) => JSON.stringify(record)).join("\n") + "\n", {
    contentType: "application/x-ndjson"
  });
}

function bucket() {
  if (!EVIDENCE_BUCKET) throw httpError(500, "EVIDENCE_BUCKET is not configured.");
  return storage.bucket(EVIDENCE_BUCKET);
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body !== "string") return req.body;
  // N3: malformed JSON is a client error, not a server crash. Catch the
  // SyntaxError and surface a clean 400 instead of falling through to the
  // catch-all (which would otherwise report it as a 500).
  try {
    return JSON.parse(req.body);
  } catch {
    throw httpError(400, "invalid_json");
  }
}

function requireFields(body, fields) {
  for (const field of fields) {
    if (body[field] === undefined || body[field] === null || body[field] === "") {
      throw httpError(400, `${field} is required`);
    }
  }
}

function requireAdmin(req) {
  const password = req.get?.("x-admin-password") || req.headers?.["x-admin-password"];
  if (!ADMIN_PASSWORD || password !== ADMIN_PASSWORD) {
    throw httpError(401, "Unauthorized");
  }
}

let warnedMissingApiKey = false;

function requireApiKey(req) {
  // Closed-by-default: if no ingest key is configured, reject every request so
  // a misconfigured deploy never accepts unauthenticated alert writes.
  if (!ALERTS_INGEST_API_KEY) {
    if (!warnedMissingApiKey) {
      console.warn("ALERTS_INGEST_API_KEY is not set; rejecting all /api/alerts ingest requests.");
      warnedMissingApiKey = true;
    }
    throw httpError(401, "Unauthorized");
  }
  const provided = req.get?.("x-api-key") || req.headers?.["x-api-key"] || "";
  if (!safeEqual(provided, ALERTS_INGEST_API_KEY)) {
    throw httpError(401, "Unauthorized");
  }
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), "utf8");
  const bufB = Buffer.from(String(b), "utf8");
  // timingSafeEqual requires equal-length buffers; comparing lengths first would
  // leak length but bail out, so hash both to a fixed width and compare those.
  const hashA = createHash("sha256").update(bufA).digest();
  const hashB = createHash("sha256").update(bufB).digest();
  return timingSafeEqual(hashA, hashB);
}

function publicSettings(settings) {
  return {
    start_at: settings?.start_at || "",
    end_at: settings?.end_at || "",
    contest_url: settings?.contest_url || "",
    // contest_slug is derived from contest_url and persisted at save time; we
    // recompute on read so an older settings doc (no stored slug) still reports
    // the right value. This is the slug all sure-shot alerts/sessions join on.
    contest_slug: settings?.contest_slug || contestSlugFromUrl(settings?.contest_url),
    // Passcodes are removed (Phase 2, 0.1). These flags remain for backward
    // compatibility with any older admin UI; the backend no longer enforces them.
    passcode_set: Boolean(settings?.passcode_hash),
    passcode_preview: settings?.passcode_preview || "",
    end_code_set: Boolean(settings?.end_code_hash),
    end_code_preview: settings?.end_code_preview || "",
    updated_at: settings?.updated_at || ""
  };
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeUsername(value) {
  return sanitizeSegment(String(value).trim().toLowerCase());
}

function sanitizeSegment(value) {
  const cleaned = String(value).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  // M1: a segment that is empty or all-dots (e.g. "", ".", "..") is a path
  // traversal / blank-key hazard once it lands in a GCS object key. Substitute a
  // safe token so a username like ".." can never become a ".." path component.
  if (cleaned === "" || /^\.+$/.test(cleaned)) return "_";
  return cleaned;
}

function sanitizeObject(value) {
  return JSON.parse(JSON.stringify(value, (_key, nested) => {
    if (typeof nested === "string") return nested.slice(0, 500);
    return nested;
  }));
}

// Editor-event detail sanitizer (paste forensics). detail.text carries up to
// 2000 chars of inserted text by design; sanitizeObject's generic 500-char cap
// would clip it. Pull text out first, sanitize the rest, then re-attach with
// its OWN 2000-char cap plus a text_truncated flag when it was longer.
const EDITOR_TEXT_MAX_LENGTH = 2000;
function sanitizeEditorDetail(rawDetail) {
  if (!rawDetail || typeof rawDetail !== "object" || Array.isArray(rawDetail)
      || !("text" in rawDetail)) {
    return sanitizeObject(rawDetail || {});
  }
  const { text, ...rest } = rawDetail;
  const detail = sanitizeObject(rest);
  const textStr = String(text);
  detail.text = textStr.slice(0, EDITOR_TEXT_MAX_LENGTH);
  if (textStr.length > EDITOR_TEXT_MAX_LENGTH) detail.text_truncated = true;
  return detail;
}

function getClientIp(req) {
  const forwarded = req.get?.("x-forwarded-for") || req.headers?.["x-forwarded-for"] || "";
  const firstForwarded = String(forwarded).split(",").map((part) => part.trim()).find(Boolean);
  const direct = req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || "";
  return normalizeIp(firstForwarded || direct || "unknown");
}

function normalizeIp(value) {
  return String(value).replace(/^::ffff:/, "").slice(0, 80);
}

function hashPasscode(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function maskPasscode(value) {
  const text = String(value);
  return `${"*".repeat(Math.max(0, text.length - 2))}${text.slice(-2)}`;
}

function badRequest(message) {
  throw httpError(400, message);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function setCors(res) {
  res.set("access-control-allow-origin", PUBLIC_APP_ORIGIN);
  res.set("access-control-allow-methods", "GET,POST,OPTIONS");
  res.set("access-control-allow-headers", "content-type,x-admin-password,x-api-key");
}

function send(res, statusCode, body) {
  res.status(statusCode).json(body);
}
