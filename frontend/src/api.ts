import type {
  AdminStatsResponse,
  Alert,
  AlertActionRequest,
  AlertActionResponse,
  AlertFilters,
  AlertSettings,
  AlertsResponse,
  BeaconKind,
  HeartbeatResponse,
  ProctorEvent,
  ProctorSettings,
  ReviewNature,
  ServerSessionStatus,
  SessionActionRequest,
  SessionActionResponse,
  SessionStartResponse,
  StudentForm,
  UploadManifestItem,
  UploadUrlResponse
} from "./types";

export const apiBaseUrl = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "") ?? "";
const demoMode = import.meta.env.VITE_DEMO_MODE === "true";
export const isDemoMode = demoMode;
const demoSettingsKey = "aerele-proctor-demo-settings";
const demoSessionsKey = "aerele-proctor-demo-sessions";
const demoAlertsKey = "aerele-proctor-demo-alerts";
const demoAlertSettingsKey = "aerele-proctor-demo-alert-settings";
export const adminPassword = import.meta.env.VITE_ADMIN_PASSWORD ?? "";
// C1: when set, the unlock gate compares the sha256 hash of the typed password
// to this embedded hash (so the plain password is never shipped in the bundle).
// Empty when unset; callers fall back to the plain adminPassword compare.
export const adminPasswordHash = (import.meta.env.VITE_ADMIN_PASSWORD_HASH ?? "").trim().toLowerCase();

// C1: SHA-256 hex of an input string via the Web Crypto API. Used by the admin
// unlock gate to verify the typed password against VITE_ADMIN_PASSWORD_HASH.
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  if (!apiBaseUrl && !demoMode) {
    throw new Error("VITE_API_BASE_URL is not configured.");
  }

  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {})
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    const e = new Error(parseErrorMessage(errorText) || `Request failed: ${response.status}`) as ApiError;
    e.status = response.status;
    e.code = parseErrorCode(errorText);
    throw e;
  }

  return response.json() as Promise<T>;
}

// An Error carrying the HTTP status and the backend's machine-readable error
// code (e.g. "session_locked"), so callers can react to lock/end/pending without
// string-matching the human message.
export type ApiError = Error & { status?: number; code?: string };

function parseErrorCode(errorText: string): string | undefined {
  if (!errorText) return undefined;
  try {
    const parsed = JSON.parse(errorText) as { error?: unknown };
    return parsed.error != null ? String(parsed.error) : undefined;
  } catch {
    return undefined;
  }
}

function parseErrorMessage(errorText: string) {
  if (!errorText) return "";
  try {
    const parsed = JSON.parse(errorText) as { error?: unknown; detail?: unknown };
    return String(parsed.error || parsed.detail || errorText);
  } catch {
    return errorText;
  }
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

// ---- Demo session store ---------------------------------------------------
// In demo mode there is no backend, so the student start/resume/end lifecycle is
// modelled in localStorage. Each record mirrors the relevant backend session-doc
// fields so resume can rebuild the same SessionStartResponse, and a second start
// for an already-active username reproduces the pending_approval path.

type DemoSession = {
  session_id: string;
  status: ServerSessionStatus;
  hackerrank_username: string;
  username_norm: string;
  name: string;
  room: string;
  contest_slug: string;
  storage_prefix: string;
  blocked_by_session_id: string | null;
  start_ip: string;
};

function readDemoSessions(): DemoSession[] {
  const raw = window.localStorage.getItem(demoSessionsKey);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DemoSession[]) : [];
  } catch {
    return [];
  }
}

function writeDemoSessions(sessions: DemoSession[]) {
  window.localStorage.setItem(demoSessionsKey, JSON.stringify(sessions));
}

function upsertDemoSession(session: DemoSession) {
  const sessions = readDemoSessions().filter((item) => item.session_id !== session.session_id);
  sessions.push(session);
  writeDemoSessions(sessions);
}

function normalizeUsername(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "_").slice(0, 120);
}

function demoStoragePrefix(contestSlug: string, usernameNorm: string, sessionId: string) {
  if (contestSlug) return `contests/${contestSlug}/sessions/${usernameNorm}/${sessionId}/`;
  return `sessions/${usernameNorm}/${sessionId}/`;
}

function contestSlugFromUrl(contestUrl?: string) {
  if (!contestUrl) return "";
  try {
    const segments = new URL(contestUrl).pathname.split("/").filter(Boolean);
    if (!segments.length) return "";
    return segments[segments.length - 1].replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  } catch {
    return "";
  }
}

function demoSessionResponse(session: DemoSession, contestUrl: string): SessionStartResponse {
  return {
    session_id: session.session_id,
    status: session.status,
    hackerrank_username: session.hackerrank_username,
    name: session.name,
    room: session.room,
    contest_slug: session.contest_slug,
    storage_prefix: session.storage_prefix,
    blocked_by_session_id: session.blocked_by_session_id,
    start_ip: session.start_ip,
    contest_url: contestUrl,
    upload_config: {
      chunk_seconds: 20,
      video_bits_per_second: 750_000,
      media_bits_per_second: 180_000,
      audio_bits_per_second: 32_000,
      max_width: 1280,
      max_frame_rate: 5
    },
    heartbeat_interval_seconds: 15
  };
}

export async function startSession(form: StudentForm, existingSessionId?: string): Promise<SessionStartResponse> {
  if (demoMode) {
    await wait(250);
    const settings = getDemoSettings();
    // Phase 3: no passcode. Start is gated by configured-and-valid time window only.
    if (!settings?.start_at || !settings?.end_at) {
      throw new Error("Proctoring is not configured yet. Ask the administrator to set the schedule.");
    }
    const now = Date.now();
    if (now < Date.parse(settings.start_at)) {
      throw new Error("Proctoring has not started yet.");
    }
    if (now > Date.parse(settings.end_at)) {
      throw new Error("Proctoring has ended.");
    }

    const contestUrl = settings.contest_url || "";
    const contestSlug = contestSlugFromUrl(contestUrl);
    const usernameNorm = normalizeUsername(form.hackerrank_username);

    // Idempotent replay: same session_id this browser already owns → return it.
    if (existingSessionId) {
      const replay = readDemoSessions().find((item) => item.session_id === existingSessionId);
      if (replay && replay.username_norm === usernameNorm && replay.contest_slug === contestSlug) {
        return demoSessionResponse(replay, contestUrl);
      }
    }

    // Single-session reconciliation: a non-ended session for the same
    // (username, contest) forces the new one to pending_approval.
    const existingLive = readDemoSessions().find(
      (item) => item.username_norm === usernameNorm && item.contest_slug === contestSlug && item.status !== "ended"
    );
    const sessionId = crypto.randomUUID();
    const hasConflict = Boolean(existingLive);
    const session: DemoSession = {
      session_id: sessionId,
      status: hasConflict ? "pending_approval" : "active",
      hackerrank_username: form.hackerrank_username.trim(),
      username_norm: usernameNorm,
      name: form.name.trim(),
      room: form.room.trim(),
      contest_slug: contestSlug,
      storage_prefix: demoStoragePrefix(contestSlug, usernameNorm, sessionId),
      blocked_by_session_id: hasConflict ? existingLive!.session_id : null,
      start_ip: "demo.local"
    };
    upsertDemoSession(session);
    return demoSessionResponse(session, contestUrl);
  }

  return request<SessionStartResponse>("/api/session/start", {
    method: "POST",
    body: JSON.stringify({
      hackerrank_username: form.hackerrank_username,
      name: form.name,
      roll_number: form.roll_number,
      email: form.email,
      room: form.room,
      consent_accepted: form.consent_accepted,
      ...(existingSessionId ? { session_id: existingSessionId } : {})
    })
  });
}

export async function resumeSession(sessionId: string, hackerrankUsername?: string): Promise<SessionStartResponse> {
  if (demoMode) {
    await wait(150);
    const session = readDemoSessions().find((item) => item.session_id === sessionId);
    if (!session) throw new Error("Session not found");
    if (hackerrankUsername && session.username_norm !== normalizeUsername(hackerrankUsername)) {
      throw new Error("Session not found");
    }
    const contestUrl = getDemoSettings()?.contest_url || "";
    return demoSessionResponse(session, contestUrl);
  }

  return request<SessionStartResponse>("/api/session/resume", {
    method: "POST",
    body: JSON.stringify({
      session_id: sessionId,
      ...(hackerrankUsername ? { hackerrank_username: hackerrankUsername } : {})
    })
  });
}

export async function fetchProctorSettings(password: string): Promise<ProctorSettings> {
  if (demoMode) {
    await wait(100);
    assertDemoAdmin(password);
    const settings = getDemoSettings();
    return settings
      ? {
          ...settings,
          passcode: "",
          end_code: "",
          passcode_set: Boolean(settings.passcode),
          passcode_preview: maskPasscode(settings.passcode),
          end_code_set: Boolean(settings.end_code),
          end_code_preview: maskPasscode(settings.end_code)
        }
      : { start_at: "", end_at: "", passcode_set: false, end_code_set: false };
  }

  return request<ProctorSettings>("/api/admin/settings", {
    method: "GET",
    headers: {
      "x-admin-password": password
    }
  });
}

export async function saveProctorSettings(password: string, settings: ProctorSettings): Promise<ProctorSettings> {
  if (demoMode) {
    await wait(150);
    assertDemoAdmin(password);
    const next = {
      start_at: settings.start_at,
      end_at: settings.end_at,
      contest_url: settings.contest_url || "",
      // Passcodes are removed from the start/end flow, but we keep persisting any
      // value an older field still sends so the stored doc stays compatible.
      passcode: settings.passcode || getDemoSettings()?.passcode || "",
      end_code: settings.end_code || getDemoSettings()?.end_code || "",
      updated_at: new Date().toISOString()
    };
    // Phase 3: only the time window is required to save the gate.
    if (!next.start_at || !next.end_at) {
      throw new Error("Start time and end time are required.");
    }
    if (Date.parse(next.start_at) >= Date.parse(next.end_at)) {
      throw new Error("Start time must be before end time.");
    }
    window.localStorage.setItem(demoSettingsKey, JSON.stringify(next));
    return {
      ...next,
      passcode: "",
      end_code: "",
      passcode_set: Boolean(next.passcode),
      passcode_preview: maskPasscode(next.passcode),
      end_code_set: Boolean(next.end_code),
      end_code_preview: maskPasscode(next.end_code)
    };
  }

  return request<ProctorSettings>("/api/admin/settings", {
    method: "POST",
    headers: {
      "x-admin-password": password
    },
    body: JSON.stringify(settings)
  });
}

export async function getUploadUrl(params: {
  session_id: string;
  kind: string;
  chunk_index: number;
  content_type: string;
}): Promise<UploadUrlResponse> {
  if (demoMode) {
    await wait(40);
    return {
      upload_url: "demo://upload",
      storage_key: `demo/${params.session_id}/${params.kind}-${params.chunk_index}.webm`,
      expires_in: 900
    };
  }

  return request<UploadUrlResponse>("/api/upload-url", {
    method: "POST",
    body: JSON.stringify(params)
  });
}

export async function uploadBlob(uploadUrl: string, blob: Blob): Promise<void> {
  if (demoMode || uploadUrl.startsWith("demo://")) {
    await wait(80);
    return;
  }

  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "content-type": blob.type || "application/octet-stream"
    },
    body: blob
  });

  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status}`);
  }
}

export async function sendEvents(sessionId: string, events: ProctorEvent[]): Promise<void> {
  if (!events.length) return;
  if (demoMode) {
    await wait(50);
    return;
  }

  await request<{ ok: boolean }>("/api/events", {
    method: "POST",
    body: JSON.stringify({ session_id: sessionId, events })
  });
}

export async function uploadReviewFile(sessionId: string, nature: ReviewNature, records: Array<Record<string, unknown>>): Promise<void> {
  if (!records.length) return;
  if (demoMode) {
    await wait(50);
    return;
  }

  await request<{ ok: boolean; storage_key: string }>("/api/review-file", {
    method: "POST",
    body: JSON.stringify({ session_id: sessionId, nature, records })
  });
}

export async function heartbeat(params: {
  session_id: string;
  recording_state: string;
  visibility_state: DocumentVisibilityState;
  upload_queue_depth: number;
  client_time: string;
  network_online: boolean;
}): Promise<HeartbeatResponse> {
  if (demoMode) {
    // B8: mirror the backend H3 write-guard so the lock-stop UX is testable in
    // demo mode. If a proctor has locked/ended this demo session (e.g. from a
    // second tab acting as admin), throw the same 403/409-tagged error the real
    // backend would — driving useProctorRecorder's onStatusChange.
    const session = readDemoSessions().find((item) => item.session_id === params.session_id);
    if (session && session.status !== "active") {
      const status = session.status;
      const code = status === "ended" ? "session_ended" : status === "locked" ? "session_locked" : "waiting_for_approval";
      const e = new Error(code) as ApiError;
      e.status = status === "ended" ? 409 : 403;
      e.code = code;
      throw e;
    }
    return { ok: true, status: session?.status ?? "active", start_ip: "demo.local", current_ip: "demo.local", ip_changed: false, newly_changed: false };
  }
  return request<HeartbeatResponse>("/api/heartbeat", {
    method: "POST",
    body: JSON.stringify(params)
  });
}

export async function endSession(params: { sessionId: string; manifest: UploadManifestItem[]; assuranceAccepted: boolean }): Promise<void> {
  if (demoMode) {
    await wait(250);
    if (!params.assuranceAccepted) {
      throw new Error("Integrity assurance is required before ending the test.");
    }
    // Mark the demo session ended so it stops blocking new starts and reflects in stats.
    const session = readDemoSessions().find((item) => item.session_id === params.sessionId);
    if (session) upsertDemoSession({ ...session, status: "ended", blocked_by_session_id: null });
    return;
  }

  await request<{ ok: boolean }>("/api/session/end", {
    method: "POST",
    body: JSON.stringify({
      session_id: params.sessionId,
      manifest: params.manifest,
      assurance_accepted: params.assuranceAccepted
    })
  });
}

export async function validateEndSession(params: { sessionId: string; assuranceAccepted: boolean }): Promise<void> {
  if (demoMode) {
    await wait(100);
    if (!params.assuranceAccepted) {
      throw new Error("Integrity assurance is required before ending the test.");
    }
    return;
  }

  await request<{ ok: boolean }>("/api/session/validate-end", {
    method: "POST",
    body: JSON.stringify({
      session_id: params.sessionId,
      assurance_accepted: params.assuranceAccepted
    })
  });
}

export async function fetchAdminSessions(username: string, password: string) {
  if (demoMode) {
    await wait(100);
    assertDemoAdmin(password);
    const usernameNorm = normalizeUsername(username);
    const sessions = readDemoSessions()
      .filter((item) => item.username_norm === usernameNorm)
      .map((item) => ({ ...item, evidence: [] as Array<Record<string, unknown>> }));
    return { sessions: sessions as Array<Record<string, unknown>> };
  }

  return request<{
    sessions: Array<Record<string, unknown>>;
  }>(`/api/admin/sessions?username=${encodeURIComponent(username)}`, {
    method: "GET",
    headers: {
      "x-admin-password": password
    }
  });
}

export async function fetchAdminStats(password: string, contestSlug?: string, room?: string): Promise<AdminStatsResponse> {
  if (demoMode) {
    await wait(120);
    assertDemoAdmin(password);
    const sessions = readDemoSessions();
    // Distinct rooms come from the demo session store (contest-scoped, BEFORE the
    // room filter) so the dropdown stays full. Fall back to the demo alert rooms
    // when no sessions exist yet so the canned-number path still has a dropdown.
    const demoRooms = sessions.length
      ? [...new Set(sessions.filter((s) => !contestSlug || s.contest_slug === contestSlug).map((s) => String(s.room || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b))
      : distinctDemoRooms(readDemoAlerts(), contestSlug);
    // Derive live counts from the demo session store so the dashboard reflects
    // whatever the student flow created. Fall back to canned numbers when empty.
    if (!sessions.length) {
      const canned = { live: 6, locked: 1, pending_approval: 2, finished: 14, disconnected: 1, total: 23, not_started_or_total: 23 };
      return {
        contest_slug: contestSlug || null,
        room: room || null,
        stats: canned,
        rooms: demoRooms,
        disconnected_staleness_ms: 45000
      };
    }
    const stats = { live: 0, locked: 0, pending_approval: 0, finished: 0, disconnected: 0, total: 0, not_started_or_total: 0 };
    for (const session of sessions) {
      if (contestSlug && session.contest_slug !== contestSlug) continue;
      // Room scopes the COUNTS (but not the rooms dropdown, computed above).
      if (room && String(session.room || "") !== room) continue;
      stats.total += 1;
      if (session.status === "active") stats.live += 1;
      else if (session.status === "locked") stats.locked += 1;
      else if (session.status === "pending_approval") stats.pending_approval += 1;
      else if (session.status === "ended") stats.finished += 1;
    }
    stats.not_started_or_total = stats.total;
    return { contest_slug: contestSlug || null, room: room || null, stats, rooms: demoRooms, disconnected_staleness_ms: 45000 };
  }

  const query = new URLSearchParams();
  if (contestSlug) query.set("contest_slug", contestSlug);
  if (room) query.set("room", room);
  const suffix = query.toString();
  return request<AdminStatsResponse>(`/api/admin/stats${suffix ? `?${suffix}` : ""}`, {
    method: "GET",
    headers: {
      "x-admin-password": password
    }
  });
}

export async function sessionAction(password: string, body: SessionActionRequest): Promise<SessionActionResponse> {
  if (demoMode) {
    await wait(150);
    assertDemoAdmin(password);
    const updated = applyDemoSessionAction(body);
    return { ok: true, action: body.action, updated };
  }

  return request<SessionActionResponse>("/api/admin/session-action", {
    method: "POST",
    headers: {
      "x-admin-password": password
    },
    body: JSON.stringify(body)
  });
}

// Mirror the backend applySessionAction semantics against the demo store so the
// admin console behaves identically in VITE_DEMO_MODE.
function applyDemoSessionAction(body: SessionActionRequest): Array<Record<string, unknown>> {
  const sessions = readDemoSessions();
  const targets: DemoSession[] = [];
  if (body.session_id) {
    const found = sessions.find((item) => item.session_id === body.session_id);
    if (found) targets.push(found);
  } else if (body.usernames?.length) {
    for (const username of body.usernames) {
      const usernameNorm = normalizeUsername(username);
      const live = sessions
        .filter((item) => item.username_norm === usernameNorm && item.status !== "ended" && (!body.contest_slug || item.contest_slug === body.contest_slug));
      if (live.length) targets.push(live[0]);
    }
  }

  const updated: Array<Record<string, unknown>> = [];
  for (const target of targets) {
    if (body.action === "approve") {
      if (target.blocked_by_session_id) {
        const conflict = sessions.find((item) => item.session_id === target.blocked_by_session_id);
        if (conflict && conflict.status !== "ended") {
          upsertDemoSession({ ...conflict, status: "ended", blocked_by_session_id: null });
          updated.push({ ...conflict, status: "ended" });
        }
      }
      upsertDemoSession({ ...target, status: "active", blocked_by_session_id: null });
      updated.push({ ...target, status: "active", blocked_by_session_id: null });
    } else if (body.action === "lock") {
      upsertDemoSession({ ...target, status: "locked" });
      updated.push({ ...target, status: "locked" });
    } else if (body.action === "unlock") {
      upsertDemoSession({ ...target, status: "active" });
      updated.push({ ...target, status: "active" });
    } else if (body.action === "bypass") {
      upsertDemoSession({ ...target, status: "active", blocked_by_session_id: null });
      updated.push({ ...target, status: "active", blocked_by_session_id: null });
    } else if (body.action === "end") {
      upsertDemoSession({ ...target, status: "ended", blocked_by_session_id: null });
      updated.push({ ...target, status: "ended" });
    }
  }
  return updated;
}

export async function fetchAlerts(password: string, filters?: AlertFilters): Promise<AlertsResponse> {
  if (demoMode) {
    await wait(120);
    assertDemoAdmin(password);
    const all = readDemoAlerts();
    const alerts = filterDemoAlerts(all, filters);
    // Distinct rooms come from the FULL alert set (contest-scoped only), BEFORE
    // the room/archive filter, so the dropdown always lists every room — mirroring
    // the backend (which derives rooms from session docs over the contest scope).
    const rooms = distinctDemoRooms(all, filters?.contest_slug);
    return { alerts, rooms };
  }

  const query = new URLSearchParams();
  if (filters?.source) query.set("source", filters.source);
  if (filters?.severity) query.set("severity", filters.severity);
  if (filters?.contest_slug) query.set("contest_slug", filters.contest_slug);
  if (filters?.room) query.set("room", filters.room);
  if (filters?.include_archived) query.set("include_archived", "true");
  const suffix = query.toString();

  return request<AlertsResponse>(`/api/admin/alerts${suffix ? `?${suffix}` : ""}`, {
    method: "GET",
    headers: {
      "x-admin-password": password
    }
  });
}

// POST /api/admin/alert-action — archive/unarchive a set of alert ids. In demo
// mode this MUTATES the persisted demo alert store so the console list and stats
// visibly change after the action (Karthi saw clicks do nothing in demo).
export async function alertAction(password: string, body: AlertActionRequest): Promise<AlertActionResponse> {
  if (demoMode) {
    await wait(120);
    assertDemoAdmin(password);
    const archived = body.action === "archive";
    const now = new Date().toISOString();
    const ids = new Set(body.ids.filter(Boolean).map(String));
    const all = readDemoAlerts();
    const updated: string[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const found = all.find((alert) => alert.id === id);
      if (!found) {
        missing.push(id);
        continue;
      }
      found.archived = archived;
      found.archived_at = archived ? now : null;
      updated.push(id);
    }
    writeDemoAlerts(all);
    return { ok: true, action: body.action, archived, updated, missing };
  }

  return request<AlertActionResponse>("/api/admin/alert-action", {
    method: "POST",
    headers: {
      "x-admin-password": password
    },
    body: JSON.stringify(body)
  });
}

function filterDemoAlerts(alerts: Alert[], filters?: AlertFilters): Alert[] {
  return alerts.filter((alert) => {
    if (filters?.source && alert.source !== filters.source) return false;
    if (filters?.severity && alert.severity !== filters.severity) return false;
    if (filters?.contest_slug && alert.contest_slug !== filters.contest_slug) return false;
    if (filters?.room && String(alert.room || "") !== filters.room) return false;
    // Exclude archived alerts by default; include them only on opt-in. This
    // mirrors the backend default-excludes-archived behaviour.
    if (!filters?.include_archived && alert.archived) return false;
    return true;
  });
}

function distinctDemoRooms(alerts: Alert[], contestSlug?: string): string[] {
  const set = new Set<string>();
  for (const alert of alerts) {
    if (contestSlug && alert.contest_slug !== contestSlug) continue;
    const room = String(alert.room || "").trim();
    if (room) set.add(room);
  }
  return [...set].sort((a, b) => a.localeCompare(b)).slice(0, 200);
}

// Persisted demo alert store. Seeded once from the canned sample set so archive
// flags survive across reloads and re-renders. Read-through: if nothing is
// stored yet, seed and persist the sample alerts.
function readDemoAlerts(): Alert[] {
  const raw = window.localStorage.getItem(demoAlertsKey);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as Alert[];
    } catch {
      // fall through to reseed
    }
  }
  const seeded = demoAlerts();
  writeDemoAlerts(seeded);
  return seeded;
}

function writeDemoAlerts(alerts: Alert[]) {
  window.localStorage.setItem(demoAlertsKey, JSON.stringify(alerts));
}

function demoAlerts(): Alert[] {
  // A small placeholder clip lives at /sample.webm so the video link is demoable.
  const sampleVideo = "/sample.webm";
  return [
    {
      id: "proctor:recording_stopped:asha_r:mcet-june-2026:1",
      source: "proctor",
      type: "recording_stopped",
      severity: "critical",
      timestamp: "2026-06-05T09:42:11.000Z",
      contest_slug: "mcet-june-2026",
      hackerrank_username: "Asha_R",
      username_norm: "asha_r",
      session_id: "sess-9f2a",
      room: "Lab A-1",
      title: "Recording stopped mid-assessment",
      detail: "MediaRecorder stopped 18m before submission with no end-session event. Possible deliberate stop.",
      data: { gap_seconds: 1080, last_chunk_index: 54 },
      video_key: "mcet-june-2026/asha_r/sess-9f2a.webm",
      download_url: sampleVideo
    },
    {
      id: "contest-eval:peer_copy_cluster:karan_v:mcet-june-2026:c3",
      source: "contest-eval",
      type: "peer_copy_cluster",
      severity: "critical",
      timestamp: "2026-06-05T09:31:54.000Z",
      contest_slug: "mcet-june-2026",
      hackerrank_username: "Karan_V",
      username_norm: "karan_v",
      room: "Lab B-2",
      title: "Peer-copy cluster (3 candidates, 97% similar)",
      detail: "Near-identical submissions for 'Balanced Brackets' across Karan_V, Neha_S, and Imran_K within a 4-minute window.",
      data: { cluster: ["karan_v", "neha_s", "imran_k"], similarity_pct: 97, problem: "balanced-brackets" },
      download_url: sampleVideo
    },
    {
      id: "proctor:screen_share_stopped:neha_s:mcet-june-2026:1",
      source: "proctor",
      type: "screen_share_stopped",
      severity: "warning",
      timestamp: "2026-06-05T09:25:03.000Z",
      contest_slug: "mcet-june-2026",
      hackerrank_username: "Neha_S",
      username_norm: "neha_s",
      session_id: "sess-71b4",
      room: "Lab B-2",
      title: "Screen share stopped",
      detail: "Candidate ended screen share for 42s, then resumed. Logged for review.",
      data: { interruptions: 1, gap_seconds: 42 },
      video_key: "mcet-june-2026/neha_s/sess-71b4.webm",
      download_url: sampleVideo
    },
    {
      id: "contest-eval:web_paste:imran_k:mcet-june-2026:p2",
      source: "contest-eval",
      type: "web_paste",
      severity: "warning",
      timestamp: "2026-06-05T09:18:40.000Z",
      contest_slug: "mcet-june-2026",
      hackerrank_username: "Imran_K",
      username_norm: "imran_k",
      room: "Lab B-2",
      title: "Web/editorial paste suspected",
      detail: "Submission matches a known editorial for 'Two Sum' with identical variable naming and comment structure.",
      data: { source_match: "editorial", similarity_pct: 88, problem: "two-sum" },
      download_url: sampleVideo
    },
    {
      id: "proctor:ip_changed:asha_r:mcet-june-2026:1",
      source: "proctor",
      type: "ip_changed",
      severity: "info",
      timestamp: "2026-06-05T09:05:22.000Z",
      contest_slug: "mcet-june-2026",
      hackerrank_username: "Asha_R",
      username_norm: "asha_r",
      session_id: "sess-9f2a",
      room: "Lab A-1",
      title: "Network IP changed",
      detail: "Source IP changed once early in the session (likely a Wi-Fi handoff). Informational only.",
      data: { start_ip: "10.4.1.18", current_ip: "10.4.2.7" },
      download_url: sampleVideo
    }
  ];
}

// Default per-type proctor alert config — mirrors the backend
// DEFAULT_PROCTOR_ALERT_SETTINGS so the demo console renders the same toggle list.
const DEFAULT_DEMO_ALERT_SETTINGS: AlertSettings = {
  proctor: {
    recording_stopped: { enabled: true, severity: "critical" },
    screen_share_stopped: { enabled: true, severity: "critical" },
    invalid_share_surface: { enabled: true, severity: "critical" },
    recording_error: { enabled: true, severity: "critical" },
    ip_changed: { enabled: true, severity: "warning" },
    tab_hidden: { enabled: true, severity: "warning" },
    tab_away: { enabled: true, severity: "warning" },
    disconnected: { enabled: true, severity: "warning" }
  }
};

// Merge a (possibly partial) stored proctor config over the defaults so callers
// always see a complete, well-formed per-type config — mirrors backend merge.
function mergeDemoAlertSettings(stored?: Partial<AlertSettings["proctor"]>): AlertSettings {
  const proctor: AlertSettings["proctor"] = {};
  for (const [type, def] of Object.entries(DEFAULT_DEMO_ALERT_SETTINGS.proctor)) {
    const override = stored?.[type];
    proctor[type] = {
      enabled: override && typeof override.enabled === "boolean" ? override.enabled : def.enabled,
      severity: override && ["critical", "warning", "info"].includes(override.severity) ? override.severity : def.severity
    };
  }
  return { proctor };
}

export async function fetchAlertSettings(password: string): Promise<AlertSettings> {
  if (demoMode) {
    await wait(100);
    assertDemoAdmin(password);
    const raw = window.localStorage.getItem(demoAlertSettingsKey);
    let stored: Partial<AlertSettings["proctor"]> | undefined;
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as AlertSettings;
        stored = parsed?.proctor;
      } catch {
        stored = undefined;
      }
    }
    return mergeDemoAlertSettings(stored);
  }

  return request<AlertSettings>("/api/admin/alert-settings", {
    method: "GET",
    headers: {
      "x-admin-password": password
    }
  });
}

export async function saveAlertSettings(password: string, settings: AlertSettings): Promise<AlertSettings> {
  if (demoMode) {
    await wait(150);
    assertDemoAdmin(password);
    const merged = mergeDemoAlertSettings(settings?.proctor);
    window.localStorage.setItem(demoAlertSettingsKey, JSON.stringify(merged));
    return merged;
  }

  return request<AlertSettings>("/api/admin/alert-settings", {
    method: "POST",
    headers: {
      "x-admin-password": password
    },
    body: JSON.stringify(settings)
  });
}

// POST /api/session/beacon — liveness beacon via navigator.sendBeacon (NO auth,
// sendBeacon-friendly). Best-effort, fire-and-forget: never awaited by the
// caller, never throws. In demo mode it stamps the demo session's last-seen so
// the demo store stays coherent, then no-ops the network call.
export function sendSessionBeacon(sessionId: string, kind: BeaconKind): void {
  if (!sessionId) return;
  if (demoMode) {
    const session = readDemoSessions().find((item) => item.session_id === sessionId);
    // Demo store has no last_seen field on the typed shape; updating updated_at via
    // upsert keeps the record fresh without changing status. No-op if not found.
    if (session) upsertDemoSession({ ...session });
    return;
  }
  const url = `${apiBaseUrl}/api/session/beacon`;
  const payload = JSON.stringify({ session_id: sessionId, kind });
  try {
    if (navigator.sendBeacon) {
      // text/plain keeps the request "simple" (no CORS preflight) and the backend
      // parses a text/plain JSON string leniently.
      const blob = new Blob([payload], { type: "text/plain" });
      navigator.sendBeacon(url, blob);
      return;
    }
  } catch {
    // fall through to fetch keepalive
  }
  // Fallback for browsers without sendBeacon: keepalive fetch so the request can
  // still complete during unload.
  try {
    void fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: payload, keepalive: true });
  } catch {
    // best-effort only
  }
}

function assertDemoAdmin(password: string) {
  // The unlock gate (App.tsx) already verified the password (plain compare, or
  // sha256 against VITE_ADMIN_PASSWORD_HASH) before storing it. Here we only
  // re-check against the plain VITE_ADMIN_PASSWORD when one is configured; if the
  // demo build was given ONLY a hash, there is no plain value to compare so we
  // trust the already-unlocked session and accept any non-empty password.
  if (adminPassword && password !== adminPassword) {
    throw new Error("Invalid admin password.");
  }
  if (!adminPassword && !password) {
    throw new Error("Invalid admin password.");
  }
}

function getDemoSettings(): (ProctorSettings & { passcode?: string; end_code?: string }) | null {
  const raw = window.localStorage.getItem(demoSettingsKey);
  return raw ? JSON.parse(raw) : null;
}

function maskPasscode(value = "") {
  if (!value) return "";
  return `${"*".repeat(Math.max(0, value.length - 2))}${value.slice(-2)}`;
}
