import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Firestore, FieldValue } from "@google-cloud/firestore";
import { Storage } from "@google-cloud/storage";

let firestore = new Firestore();
let storage = new Storage();

// Dependency-injection seam for unit tests only. Production code never calls
// these; tests inject fake Firestore/Storage objects so no real GCP is touched.
export function __setClientsForTest({ firestore: fakeFirestore, storage: fakeStorage } = {}) {
  if (fakeFirestore) firestore = fakeFirestore;
  if (fakeStorage) storage = fakeStorage;
}

const SESSION_COLLECTION = process.env.SESSION_COLLECTION || "proctor_sessions";
const SETTINGS_COLLECTION = process.env.SETTINGS_COLLECTION || "proctor_settings";
const ALERTS_COLLECTION = process.env.ALERTS_COLLECTION || "proctor_alerts";
const EVIDENCE_BUCKET = process.env.EVIDENCE_BUCKET;
const PUBLIC_APP_ORIGIN = process.env.PUBLIC_APP_ORIGIN || "*";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ALERTS_INGEST_API_KEY = process.env.ALERTS_INGEST_API_KEY;
const URL_EXPIRY_SECONDS = Number(process.env.URL_EXPIRY_SECONDS || "900");
const ALERTS_QUERY_LIMIT = 500;
const SESSIONS_QUERY_LIMIT = 2000;
const SETTINGS_ID = "active";

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
    if (req.method === "POST" && path === "/api/review-file") return send(res, 200, await recordReviewFile(req));
    if (req.method === "POST" && path === "/api/heartbeat") return send(res, 200, await recordHeartbeat(req));
    if (req.method === "POST" && path === "/api/session/validate-end") return send(res, 200, await validateEndSession(req));
    if (req.method === "POST" && path === "/api/session/end") return send(res, 200, await endSession(req));
    if (req.method === "GET" && path === "/api/admin/settings") return send(res, 200, await adminGetSettings(req));
    if (req.method === "POST" && path === "/api/admin/settings") return send(res, 200, await adminSaveSettings(req));
    if (req.method === "GET" && path === "/api/admin/sessions") return send(res, 200, await adminSessions(req));
    if (req.method === "GET" && path === "/api/admin/stats") return send(res, 200, await adminStats(req));
    if (req.method === "POST" && path === "/api/admin/session-action") return send(res, 200, await adminSessionAction(req));
    if (req.method === "POST" && path === "/api/alerts") return send(res, 200, await ingestAlerts(req));
    if (req.method === "GET" && path === "/api/admin/alerts") return send(res, 200, await adminAlerts(req));

    return send(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    const statusCode = error?.statusCode || 500;
    return send(res, statusCode, {
      error: statusCode === 500 ? "Internal server error" : String(error?.message || error),
      detail: String(error?.message || error)
    });
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
  const hasConflict = Boolean(existingActive && existingActive.session_id !== sessionId);
  const status = hasConflict ? "pending_approval" : "active";

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
    blocked_by_session_id: hasConflict ? existingActive.session_id : null,
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
  const session = await getSession(body.session_id);
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
  const session = await getSession(body.session_id);
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
  // clipboard) are intentionally NOT surfaced.
  await raiseSureShotAlertsFromEvents(session, cleanedEvents);

  return { ok: true, storage_key: eventKey };
}

async function recordReviewFile(req) {
  const body = parseBody(req);
  requireFields(body, ["session_id", "nature", "records"]);
  const session = await getSession(body.session_id);
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
  const session = await getSession(body.session_id);
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
    heartbeat_count: FieldValue.increment(1),
    ip_change_count: FieldValue.increment(newlyChanged ? 1 : 0)
  });

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
    await upsertProctorAlert(session, {
      type: "ip_changed",
      severity: "warning",
      timestamp: now,
      title: "IP address changed",
      detail: `IP changed from ${previousIp} to ${currentIp}`,
      dedupe: currentIp,
      data: { start_ip: startIp, previous_ip: previousIp, current_ip: currentIp }
    });
  }

  // Phase 2 (2.3): a heartbeat reporting the recorder is no longer recording is
  // a sure-shot critical. Deduped per-day so a sustained-stopped state collapses
  // to one alert per session rather than one per heartbeat.
  if (isRecordingStopped(body.recording_state)) {
    await upsertProctorAlert(session, {
      type: "recording_stopped",
      severity: "critical",
      timestamp: now,
      title: "Recording stopped",
      detail: `recording_state=${String(body.recording_state)}`,
      dedupe: now.slice(0, 10),
      data: { recording_state: String(body.recording_state) }
    });
  }

  return { ok: true, start_ip: startIp, current_ip: currentIp, ip_changed: ipChanged, newly_changed: newlyChanged };
}

async function validateEndSession(req) {
  // Phase 2 (0.1): the exit passcode is gone. Ending only requires the integrity
  // assurance checkbox. `end_proctor_code`/`end_code` are no longer required.
  const body = parseBody(req);
  requireFields(body, ["session_id"]);
  if (body.assurance_accepted !== true) return badRequest("Integrity assurance is required before ending the test.");
  await getSession(body.session_id);
  return { ok: true };
}

async function endSession(req) {
  const body = parseBody(req);
  requireFields(body, ["session_id"]);
  if (body.assurance_accepted !== true) return badRequest("Integrity assurance is required before ending the test.");
  const session = await getSession(body.session_id);
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
      const evidence = await Promise.all(files.map(async (file) => {
        const [metadata] = await file.getMetadata();
        const [downloadUrl] = await file.getSignedUrl({
          version: "v4",
          action: "read",
          expires: Date.now() + 3600 * 1000
        });
        return {
          key: file.name,
          size: Number(metadata.size || 0),
          last_modified: metadata.updated,
          download_url: downloadUrl
        };
      }));
      return { ...item, evidence };
    }));

  return { sessions };
}

// Phase 2 (2.4 / Epic 6.4 / 4.4): live counts by status for the admin dashboard.
// Counts are derived from the session docs; an optional ?contest_slug filters to
// one contest. "finished" == ended; "live" == active; plus locked + pending.
async function adminStats(req) {
  requireAdmin(req);
  const contestSlug = req.query?.contest_slug;

  let query = firestore.collection(SESSION_COLLECTION);
  if (contestSlug !== undefined && contestSlug !== null && contestSlug !== "") {
    query = query.where("contest_slug", "==", String(contestSlug));
  }
  const snapshot = await query.limit(SESSIONS_QUERY_LIMIT).get();
  const docs = snapshot.docs.map((doc) => doc.data());

  const stats = { live: 0, locked: 0, pending_approval: 0, finished: 0, total: 0 };
  for (const doc of docs) {
    stats.total += 1;
    if (doc.status === "active") stats.live += 1;
    else if (doc.status === "locked") stats.locked += 1;
    else if (doc.status === "pending_approval") stats.pending_approval += 1;
    else if (doc.status === "ended") stats.finished += 1;
  }
  // "not started or total": with no roster the backend can't know who hasn't
  // started, so we report total session docs as the closest defensible number
  // (the frontend can subtract the started states to estimate yet-to-start once
  // a roster exists).
  stats.not_started_or_total = stats.total;

  return { contest_slug: contestSlug ? String(contestSlug) : null, stats };
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
        out.push({ ...conflict, status: "ended", ended_at: now, updated_at: now, ended_reason: "superseded_by_approval" });
      }
    }
    await sessionRef(session.session_id).update({ status: "active", blocked_by_session_id: null, approved_at: now, updated_at: now });
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
    return { ...session, status: "active", blocked_by_session_id: null, bypassed_at: now, updated_at: now };
  }

  if (action === "end") {
    await sessionRef(session.session_id).update({ status: "ended", ended_at: now, updated_at: now, ended_reason: "admin_action" });
    return { ...session, status: "ended", ended_at: now, updated_at: now, ended_reason: "admin_action" };
  }

  return null;
}

// ---- Sure-shot proctor alerts (Phase 2, 2.3 / Epic 4) ---------------------

// SURE-SHOT client event types: when one of these arrives via /api/events we
// raise an idempotent proctor alert. Everything else (focus/blur/visibility/
// clipboard) is intentionally NOT surfaced — it is noisy.
const SURE_SHOT_EVENT_TYPES = {
  recording_stopped: { severity: "critical", title: "Recording stopped" },
  screen_share_stopped: { severity: "critical", title: "Screen sharing stopped" },
  invalid_share_surface: { severity: "critical", title: "Invalid share surface" },
  recording_error: { severity: "critical", title: "Recording error" }
};

// Recorder states that mean "not recording" for the heartbeat sure-shot.
const STOPPED_RECORDING_STATES = new Set(["stopped", "inactive", "ended", "error"]);

function isRecordingStopped(recordingState) {
  return STOPPED_RECORDING_STATES.has(String(recordingState || "").toLowerCase());
}

async function raiseSureShotAlertsFromEvents(session, events) {
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
    const timestamp = isoOrNow(event.timestamp);
    await upsertProctorAlert(session, {
      type: event.type,
      severity: spec.severity,
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

// Deep-link target for a sure-shot alert: the merged review video if the worker
// already produced one (manifest_key implies the merge ran), else the raw
// screen-chunk prefix so the console can still navigate to the evidence folder.
function sureShotVideoKey(session) {
  if (session.merged_video_key) return session.merged_video_key;
  return `${sessionPrefix(session)}screen/`;
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

  let query = firestore.collection(ALERTS_COLLECTION);
  if (contestSlug) query = query.where("contest_slug", "==", String(contestSlug));
  if (severity) query = query.where("severity", "==", String(severity));
  if (source) query = query.where("source", "==", String(source));

  const snapshot = await query.limit(ALERTS_QUERY_LIMIT).get();
  const alerts = snapshot.docs
    .map((doc) => doc.data())
    .sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")))
    .slice(0, ALERTS_QUERY_LIMIT);

  const withUrls = await Promise.all(alerts.map(async (alert) => {
    if (!alert.video_key) return { ...alert, download_url: null };
    const downloadUrl = await resolveSignedReadUrl(alert.video_key);
    return { ...alert, download_url: downloadUrl };
  }));

  return { alerts: withUrls };
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
  return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
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
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

function sanitizeObject(value) {
  return JSON.parse(JSON.stringify(value, (_key, nested) => {
    if (typeof nested === "string") return nested.slice(0, 500);
    return nested;
  }));
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
