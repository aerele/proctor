import { createHash, randomUUID } from "node:crypto";
import { Firestore, FieldValue } from "@google-cloud/firestore";
import { Storage } from "@google-cloud/storage";

const firestore = new Firestore();
const storage = new Storage();

const SESSION_COLLECTION = process.env.SESSION_COLLECTION || "proctor_sessions";
const SETTINGS_COLLECTION = process.env.SETTINGS_COLLECTION || "proctor_settings";
const EVIDENCE_BUCKET = process.env.EVIDENCE_BUCKET;
const PUBLIC_APP_ORIGIN = process.env.PUBLIC_APP_ORIGIN || "*";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const URL_EXPIRY_SECONDS = Number(process.env.URL_EXPIRY_SECONDS || "900");
const SETTINGS_ID = "active";

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
    if (req.method === "POST" && path === "/api/upload-url") return send(res, 200, await createUploadUrl(req));
    if (req.method === "POST" && path === "/api/events") return send(res, 200, await recordEvents(req));
    if (req.method === "POST" && path === "/api/review-file") return send(res, 200, await recordReviewFile(req));
    if (req.method === "POST" && path === "/api/heartbeat") return send(res, 200, await recordHeartbeat(req));
    if (req.method === "POST" && path === "/api/session/validate-end") return send(res, 200, await validateEndSession(req));
    if (req.method === "POST" && path === "/api/session/end") return send(res, 200, await endSession(req));
    if (req.method === "GET" && path === "/api/admin/settings") return send(res, 200, await adminGetSettings(req));
    if (req.method === "POST" && path === "/api/admin/settings") return send(res, 200, await adminSaveSettings(req));
    if (req.method === "GET" && path === "/api/admin/sessions") return send(res, 200, await adminSessions(req));

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
  requireFields(body, ["hackerrank_username", "name", "roll_number", "email", "proctor_passcode"]);
  if (body.consent_accepted !== true) {
    return badRequest("Consent is required");
  }
  const settings = await validateProctorGate(body.proctor_passcode);

  const now = new Date().toISOString();
  const sessionId = randomUUID();
  const username = String(body.hackerrank_username).trim();
  const usernameNorm = normalizeUsername(username);
  const clientIp = getClientIp(req);

  const item = {
    session_id: sessionId,
    hackerrank_username: username,
    username_norm: usernameNorm,
    name: String(body.name).trim(),
    roll_number: String(body.roll_number).trim(),
    email: String(body.email).trim(),
    start_ip: clientIp,
    current_ip: clientIp,
    ip_change_count: 0,
    consent_accepted: true,
    status: "started",
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
  await putJsonl(`sessions/${usernameNorm}/${sessionId}/events/session.jsonl`, [{
    type: "session_started",
    timestamp: now,
    detail: { user_agent: req.get?.("user-agent") || req.headers?.["user-agent"] || "", start_ip: clientIp }
  }]);

  return {
    session_id: sessionId,
    start_ip: clientIp,
    contest_url: settings.contest_url || "",
    upload_config: uploadConfig,
    heartbeat_interval_seconds: 15
  };
}

async function validateProctorGate(passcode) {
  const settings = await getSettings();
  if (!settings?.passcode_hash || !settings?.start_at || !settings?.end_at) {
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
  if (hashPasscode(passcode) !== settings.passcode_hash) {
    throw httpError(403, "Invalid proctoring passcode.");
  }
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
  const objectKey = `sessions/${session.username_norm}/${session.session_id}/${kind}/chunk-${String(chunkIndex).padStart(5, "0")}.${extension}`;
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

  const eventKey = `sessions/${session.username_norm}/${session.session_id}/events/events-${Date.now()}-${randomUUID()}.jsonl`;
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
  const key = `sessions/${session.username_norm}/${session.session_id}/review/${body.nature}.jsonl`;
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
    await putJsonl(`sessions/${session.username_norm}/${session.session_id}/events/ip-change-${Date.now()}-${randomUUID()}.jsonl`, [{
      type: "ip_address_changed",
      timestamp: now,
      detail: {
        hackerrank_username: session.hackerrank_username,
        start_ip: startIp,
        previous_ip: previousIp,
        current_ip: currentIp
      }
    }]);
  }

  return { ok: true, start_ip: startIp, current_ip: currentIp, ip_changed: ipChanged, newly_changed: newlyChanged };
}

async function validateEndSession(req) {
  const body = parseBody(req);
  requireFields(body, ["session_id", "end_proctor_code"]);
  if (body.assurance_accepted !== true) return badRequest("Integrity assurance is required before ending the test.");
  await getSession(body.session_id);
  await validateEndCode(body.end_proctor_code);
  return { ok: true };
}

async function endSession(req) {
  const body = parseBody(req);
  requireFields(body, ["session_id", "end_proctor_code"]);
  if (body.assurance_accepted !== true) return badRequest("Integrity assurance is required before ending the test.");
  await validateEndCode(body.end_proctor_code);
  const session = await getSession(body.session_id);
  const manifest = Array.isArray(body.manifest) ? body.manifest : [];
  const now = new Date().toISOString();
  const manifestKey = `sessions/${session.username_norm}/${session.session_id}/manifest.json`;

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

async function validateEndCode(endCode) {
  const settings = await getSettings();
  if (!settings?.end_code_hash) throw httpError(403, "Proctoring end code is not configured.");
  if (hashPasscode(endCode) !== settings.end_code_hash) {
    throw httpError(403, "Invalid proctoring end code.");
  }
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
  const passcode = String(body.passcode || "");
  const endCode = String(body.end_code || "");
  const contestUrl = String(body.contest_url || "").trim();
  if (!existing?.passcode_hash && !passcode) return badRequest("Passcode is required the first time settings are saved.");
  if (!existing?.end_code_hash && !endCode) return badRequest("End code is required the first time settings are saved.");
  if (passcode && passcode.length < 4) return badRequest("Passcode must be at least 4 characters.");
  if (endCode && endCode.length < 4) return badRequest("End code must be at least 4 characters.");
  if (contestUrl && !isHttpUrl(contestUrl)) return badRequest("Contest URL must start with http:// or https://.");

  const now = new Date().toISOString();
  const item = {
    start_at: startAt.toISOString(),
    end_at: endAt.toISOString(),
    contest_url: contestUrl,
    passcode_hash: passcode ? hashPasscode(passcode) : existing.passcode_hash,
    passcode_preview: passcode ? maskPasscode(passcode) : existing.passcode_preview,
    end_code_hash: endCode ? hashPasscode(endCode) : existing.end_code_hash,
    end_code_preview: endCode ? maskPasscode(endCode) : existing.end_code_preview,
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
      const prefix = `sessions/${item.username_norm}/${item.session_id}/`;
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

async function getSession(sessionId) {
  const doc = await sessionRef(sessionId).get();
  if (!doc.exists) throw httpError(404, "Session not found");
  return doc.data();
}

async function getSettings() {
  const doc = await settingsRef().get();
  return doc.exists ? doc.data() : null;
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

function publicSettings(settings) {
  return {
    start_at: settings?.start_at || "",
    end_at: settings?.end_at || "",
    contest_url: settings?.contest_url || "",
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
  res.set("access-control-allow-headers", "content-type,x-admin-password");
}

function send(res, statusCode, body) {
  res.status(statusCode).json(body);
}
