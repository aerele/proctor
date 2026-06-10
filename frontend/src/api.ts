import type {
  AdminSessionsResponse,
  AdminStatsResponse,
  Alert,
  AlertActionRequest,
  AlertActionResponse,
  AlertFilters,
  AlertSettings,
  AlertsResponse,
  BeaconKind,
  EditorEvent,
  ExamConfig,
  ExamTimeRequest,
  ExamTimeResponse,
  ExecRequest,
  HeartbeatResponse,
  InvigilatorAlert,
  InvigilatorOverviewResponse,
  InvigilatorRoomResponse,
  InvigilatorSessionRow,
  IpReportResponse,
  IpReportScope,
  ProblemDoc,
  ProblemSummary,
  ProctorAlertTypeConfig,
  ProctorEvent,
  ProctorSettings,
  PublicProblem,
  RecordingSession,
  RecordingSessionsResponse,
  ReviewMineResponse,
  ReviewNature,
  ReviewNextResponse,
  ReviewRecord,
  ReviewRosterSaveResponse,
  ReviewRosterSummary,
  ReviewsResponse,
  ReviewVerdict,
  ReviewVerdictResponse,
  RoomGate,
  RoomGateActionResponse,
  RoomGatePollResponse,
  RosterColumnMapping,
  RosterLookupResult,
  RosterStatus,
  RosterUploadRequest,
  RosterUploadResponse,
  RunResult,
  ServerSessionStatus,
  SessionActionRequest,
  SessionActionResponse,
  SessionDetail,
  SessionDetailsResponse,
  SessionEvidence,
  SessionStartResponse,
  StudentForm,
  SubmissionEvent,
  SubmissionEventsResponse,
  SubmitResult,
  UploadManifestItem,
  UploadUrlResponse
} from "./types";
import { computeAttendance, type AttendanceReport } from "./attendance/computeAttendance";
import { resolveSavedEndAt } from "./examTime";
import { roomKeyForLabel } from "./invigilator/gateLogic";
import { groupIpEntries, summarizeIpEntries, type IpRow } from "./ipReport";

export const apiBaseUrl = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "") ?? "";
const demoMode = import.meta.env.VITE_DEMO_MODE === "true";
export const isDemoMode = demoMode;
const demoSettingsKey = "aerele-proctor-demo-settings";
const demoSessionsKey = "aerele-proctor-demo-sessions";
// v2: F6.4 reseeded the demo alerts so their session_ids/usernames join to the
// DEMO_ALL_SESSIONS admin population (contextual action buttons need real
// statuses behind every alert) — the key bump discards stale v1 stores.
const demoAlertsKey = "aerele-proctor-demo-alerts-v2";
const demoAlertSettingsKey = "aerele-proctor-demo-alert-settings";
const demoReviewRosterKey = "aerele-proctor-demo-review-roster";
const demoReviewVerdictsKey = "aerele-proctor-demo-review-verdicts";
const demoRosterKey = "aerele-proctor-demo-roster";
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
  // S6: the matched roster id (display form), "" when no roster — mirrors the
  // backend session doc so demo attendance can join sessions to the roster.
  roster_unique_id: string;
  room: string;
  contest_slug: string;
  storage_prefix: string;
  blocked_by_session_id: string | null;
  start_ip: string;
  exam_started_at?: string | null;
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
    // S3: mirror the backend startResponse — the candidate client needs the
    // gate flag to know whether to hold at the room-code screen (demo parity).
    room_gate_enabled: getDemoSettings()?.room_gate_enabled === true,
    // S4: server-driven problem assigned to the session (null when unassigned).
    problem: demoActiveProblem(),
    upload_config: {
      chunk_seconds: 20,
      video_bits_per_second: 750_000,
      media_bits_per_second: 180_000,
      audio_bits_per_second: 32_000,
      max_width: 1280,
      max_frame_rate: 5
    },
    heartbeat_interval_seconds: 15,
    // S5: demo sessions read the exam end time from the demo settings store.
    end_at: getDemoSettings()?.end_at || "",
    server_now: new Date().toISOString()
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

    // S2 roster gate (demo parity with the backend): roster configured -> start
    // requires a roster match, and roster-mapped fields win over typed ones.
    const demoRosterHit = form.roster_unique_id ? demoRosterEntryFor(form.roster_unique_id) : null;
    if (getDemoRoster()) {
      if (!form.roster_unique_id) throw demoApiError(403, "roster_id_required");
      if (!demoRosterHit) throw demoApiError(403, "not_on_roster");
    }
    const demoMapping = demoRosterHit?.roster.column_mapping ?? {};
    const rosterUsername = demoRosterHit && demoMapping.hackerrank_username
      ? (demoRosterHit.row[demoMapping.hackerrank_username] ?? "").trim() : "";
    const rosterName = demoRosterHit && demoMapping.name
      ? (demoRosterHit.row[demoMapping.name] ?? "").trim() : "";
    const effectiveUsername = rosterUsername || form.hackerrank_username.trim();
    const usernameNorm = normalizeUsername(effectiveUsername);

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
      hackerrank_username: effectiveUsername,
      username_norm: usernameNorm,
      name: rosterName || form.name.trim(),
      roster_unique_id: demoRosterHit
        ? (demoRosterHit.row[demoRosterHit.roster.unique_id_column] ?? "").trim()
        : "",
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
      ...(form.roster_unique_id ? { roster_unique_id: form.roster_unique_id } : {}),
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
    // Phase 3: only the time window is required to save the gate.
    if (!settings.start_at || !settings.end_at) {
      throw new Error("Start time and end time are required.");
    }
    if (Date.parse(settings.start_at) >= Date.parse(settings.end_at)) {
      throw new Error("Start time must be before end time.");
    }
    const next = {
      start_at: settings.start_at,
      // D1 (backend parity): a live exam-time adjustment owns end_at for the
      // current window — a stale form value cannot revert it (pure rule in
      // examTime.ts; spreads end_at + the end_at_updated_at stamp when owned).
      ...resolveSavedEndAt(getDemoSettings(), { start_at: settings.start_at, end_at: settings.end_at }),
      contest_url: settings.contest_url || "",
      room_gate_enabled: settings.room_gate_enabled === true,
      problem_id: settings.problem_id || "",
      rooms: settings.rooms ?? getDemoSettings()?.rooms ?? [],
      // Passcodes are removed from the start/end flow, but we keep persisting any
      // value an older field still sends so the stored doc stays compatible.
      passcode: settings.passcode || getDemoSettings()?.passcode || "",
      end_code: settings.end_code || getDemoSettings()?.end_code || "",
      updated_at: new Date().toISOString()
    };
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
    // S5: mirror the real heartbeat — carry the current demo end time so the
    // student countdown updates live when the demo admin changes it.
    return { ok: true, status: session?.status ?? "active", start_ip: "demo.local", current_ip: "demo.local", ip_changed: false, newly_changed: false, end_at: getDemoSettings()?.end_at || "", server_now: new Date().toISOString() };
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

export async function fetchAdminSessions(username: string, password: string): Promise<AdminSessionsResponse> {
  if (demoMode) {
    await wait(120);
    assertDemoAdmin(password);
    const usernameNorm = normalizeUsername(username);
    // Recording playback view: a fake recording dataset takes precedence so the
    // whole search → timeline → player flow is exercisable OFFLINE. Falls back to
    // the demo STUDENT session store (no evidence) for any other username.
    const recording = demoRecordingSessionsFor(usernameNorm);
    if (recording.length) return { sessions: recording };
    const sessions = readDemoSessions()
      .filter((item) => item.username_norm === usernameNorm)
      .map((item) => ({ ...item, evidence: [] as SessionEvidence[] }));
    return { sessions };
  }

  return request<AdminSessionsResponse>(`/api/admin/sessions?username=${encodeURIComponent(username)}`, {
    method: "GET",
    headers: {
      "x-admin-password": password
    }
  });
}

// GET /api/admin/recording-sessions — lightweight picker list of sessions with
// recordings. Returns `null` when the endpoint is not deployed yet (404) so the
// UI degrades to a manual "enter username" input. In demo mode it returns the
// fake recording dataset so the picker/search works fully offline.
export async function fetchRecordingSessions(password: string, contestSlug?: string): Promise<RecordingSession[] | null> {
  if (demoMode) {
    await wait(120);
    assertDemoAdmin(password);
    const list = DEMO_RECORDING_SESSIONS.filter((s) => !contestSlug || s.contest_slug === contestSlug);
    return list.map((s) => ({
      session_id: s.session_id,
      hackerrank_username: s.hackerrank_username,
      name: s.name,
      room: s.room,
      contest_slug: s.contest_slug,
      chunk_count: s.chunk_count,
      created_at: s.created_at,
      status: s.status
    }));
  }

  const query = new URLSearchParams();
  if (contestSlug) query.set("contest_slug", contestSlug);
  const suffix = query.toString();
  try {
    const response = await request<RecordingSessionsResponse>(
      `/api/admin/recording-sessions${suffix ? `?${suffix}` : ""}`,
      { method: "GET", headers: { "x-admin-password": password } }
    );
    return response.sessions;
  } catch (cause) {
    // Endpoint not deployed yet → degrade gracefully to the manual-username path.
    if ((cause as ApiError)?.status === 404) return null;
    throw cause;
  }
}

// GET /api/admin/sessions-list — the ALL-DOCS (including zero-chunk) Sessions
// drill-down that backs the stat-card counts. Unlike fetchRecordingSessions
// (recorded-chunks-only playback picker), this lists EVERY session doc classified
// by the SAME rules as the stat cards (status: '' = all; 'active' = active;
// 'disconnected' = active && stale; literal otherwise), with room filtering — so
// the list matches the cards and zero-chunk pending_approval sessions are reachable
// for Approve. Returns `null` on 404 (endpoint not deployed yet) so the UI degrades
// gracefully, same as fetchRecordingSessions. In demo mode it classifies the
// SHARED admin population (DEMO_ALL_SESSIONS) — the SAME source fetchAdminStats
// counts from, NOT the recording seeds — applying the same status + contest + room
// filters and projecting the RecordingSession fields, so every drill-down list
// count equals its stat card and the zero-chunk pending_approval sessions appear
// with Approve exercisable.
export async function fetchSessionsList(
  password: string,
  opts: { status?: string; contestSlug?: string; room?: string }
): Promise<RecordingSession[] | null> {
  const status = opts.status || "";
  const contestSlug = opts.contestSlug || "";
  const room = opts.room || "";
  if (demoMode) {
    await wait(120);
    assertDemoAdmin(password);
    const matchesStatus = (session: DemoAdminSessionRow) => {
      switch (status) {
        case "":
          return true;
        case "active":
          return session.status === "active";
        // "disconnected" = active && stale (newest liveness stamp older than the
        // 45s window). Exactly the one old-heartbeat active row matches.
        case "disconnected":
          return session.status === "active" && session.stale === true;
        case "locked":
          return session.status === "locked";
        case "pending_approval":
          return session.status === "pending_approval";
        case "ended":
          return session.status === "ended";
        default:
          return false;
      }
    };
    // Filter the SHARED admin population (same source the stat cards count from),
    // so the drill-down list count always equals the card count for every status.
    return DEMO_ALL_SESSIONS
      .filter((session) => !contestSlug || session.contest_slug === contestSlug)
      .filter((session) => !room || String(session.room || "") === room)
      .filter(matchesStatus)
      .map((session) => ({
        session_id: session.session_id,
        hackerrank_username: session.hackerrank_username || "",
        name: session.name || "",
        room: session.room || "",
        contest_slug: session.contest_slug || "",
        chunk_count: session.chunk_count,
        created_at: session.created_at,
        status: session.status || ""
      }));
  }

  const query = new URLSearchParams();
  if (status) query.set("status", status);
  if (contestSlug) query.set("contest_slug", contestSlug);
  if (room) query.set("room", room);
  const suffix = query.toString();
  try {
    const response = await request<RecordingSessionsResponse>(
      `/api/admin/sessions-list${suffix ? `?${suffix}` : ""}`,
      { method: "GET", headers: { "x-admin-password": password } }
    );
    return response.sessions;
  } catch (cause) {
    // Endpoint not deployed yet → degrade gracefully (same as fetchRecordingSessions).
    if ((cause as ApiError)?.status === 404) return null;
    throw cause;
  }
}

// ---- Shared demo ADMIN dataset -------------------------------------------
// The full session population the admin stat cards summarize AND the Sessions
// drill-down list. In production both fetchAdminStats and fetchSessionsList read
// the SAME Firestore session docs, so the card count always equals the list count
// for every status. In demo mode we mirror that by deriving BOTH from this single
// source — instead of the cards using a canned object while the list filtered the
// near-empty live-session store (which made them disagree).
//
// Distribution (total 23): 6 active (exactly ONE stale → disconnected = 1),
// 1 locked, 2 pending_approval (zero-chunk second-device sessions), 14 ended.
type DemoAdminSessionRow = {
  session_id: string;
  hackerrank_username: string;
  name: string;
  room: string;
  contest_slug: string;
  status: "active" | "locked" | "pending_approval" | "ended";
  chunk_count: number;
  created_at: string;
  // Deterministic "disconnected" marker: true on the one active row that should
  // derive as disconnected, falsy/omitted on every other row. A flag (not
  // wall-clock math) so the demo counts never drift as the page stays open.
  stale?: boolean;
};

const DEMO_CONTEST_SLUG = "mcet-june-2026"; // the slug DEMO_RECORDING_SESSIONS uses

// Base "now" for the demo created_at stamps, captured once at module load.
const DEMO_NOW_MS = Date.now();
const demoCreated = (offsetMin: number) => new Date(DEMO_NOW_MS - offsetMin * 60_000).toISOString();

// The full demo admin session population both fetchAdminStats and fetchSessionsList
// derive from — the single shared source that keeps every card count == its
// drill-down list count.
const DEMO_ALL_SESSIONS: DemoAdminSessionRow[] = [
  // 6 active: 5 fresh + 1 stale (the stale one derives as disconnected).
  { session_id: "live-arav-1a01", hackerrank_username: "Arav_M", name: "Arav Menon", room: "Lab A-1", contest_slug: DEMO_CONTEST_SLUG, status: "active", chunk_count: 12, created_at: demoCreated(20) },
  { session_id: "live-divya-1a02", hackerrank_username: "Divya_P", name: "Divya Pillai", room: "Lab B-2", contest_slug: DEMO_CONTEST_SLUG, status: "active", chunk_count: 9, created_at: demoCreated(18) },
  { session_id: "live-rohan-1a03", hackerrank_username: "Rohan_K", name: "Rohan Krishnan", room: "Lab A-1", contest_slug: DEMO_CONTEST_SLUG, status: "active", chunk_count: 15, created_at: demoCreated(22) },
  { session_id: "live-sneha-1a04", hackerrank_username: "Sneha_B", name: "Sneha Bhat", room: "Lab B-2", contest_slug: DEMO_CONTEST_SLUG, status: "active", chunk_count: 7, created_at: demoCreated(15) },
  { session_id: "live-aditya-1a05", hackerrank_username: "Aditya_R", name: "Aditya Raghavan", room: "Lab A-1", contest_slug: DEMO_CONTEST_SLUG, status: "active", chunk_count: 11, created_at: demoCreated(19) },
  // The ONE stale active row → derived "disconnected" (count = 1).
  { session_id: "live-meera-1a06", hackerrank_username: "Meera_S", name: "Meera Subramani", room: "Lab B-2", contest_slug: DEMO_CONTEST_SLUG, status: "active", chunk_count: 6, created_at: demoCreated(17), stale: true },
  // 1 locked.
  { session_id: "live-imran-2b01", hackerrank_username: "Imran_K", name: "Imran Khan", room: "Lab A-1", contest_slug: DEMO_CONTEST_SLUG, status: "locked", chunk_count: 8, created_at: demoCreated(16) },
  // 2 pending_approval — zero-chunk second-device sessions (the case the fix
  // makes reachable; these render the Approve action in the drill-down).
  { session_id: "live-fatima-3c01", hackerrank_username: "Fatima_A", name: "Fatima Ansari", room: "Lab A-1", contest_slug: DEMO_CONTEST_SLUG, status: "pending_approval", chunk_count: 0, created_at: demoCreated(4) },
  { session_id: "live-vivek-3c02", hackerrank_username: "Vivek_N", name: "Vivek Nair", room: "Lab B-2", contest_slug: DEMO_CONTEST_SLUG, status: "pending_approval", chunk_count: 0, created_at: demoCreated(3) },
  // 14 ended.
  { session_id: "live-asha-4d01", hackerrank_username: "Asha_R", name: "Asha Ramanathan", room: "Lab A-1", contest_slug: DEMO_CONTEST_SLUG, status: "ended", chunk_count: 18, created_at: demoCreated(120) },
  { session_id: "live-karan-4d02", hackerrank_username: "Karan_V", name: "Karan Verma", room: "Lab B-2", contest_slug: DEMO_CONTEST_SLUG, status: "ended", chunk_count: 16, created_at: demoCreated(118) },
  { session_id: "live-neha-4d03", hackerrank_username: "Neha_S", name: "Neha Sharma", room: "Lab B-2", contest_slug: DEMO_CONTEST_SLUG, status: "ended", chunk_count: 20, created_at: demoCreated(115) },
  { session_id: "live-vikram-4d04", hackerrank_username: "Vikram_T", name: "Vikram Thiagarajan", room: "Lab A-1", contest_slug: DEMO_CONTEST_SLUG, status: "ended", chunk_count: 22, created_at: demoCreated(110) },
  { session_id: "live-priya-4d05", hackerrank_username: "Priya_G", name: "Priya Gopal", room: "Lab B-2", contest_slug: DEMO_CONTEST_SLUG, status: "ended", chunk_count: 14, created_at: demoCreated(108) },
  { session_id: "live-sanjay-4d06", hackerrank_username: "Sanjay_M", name: "Sanjay Murthy", room: "Lab A-1", contest_slug: DEMO_CONTEST_SLUG, status: "ended", chunk_count: 17, created_at: demoCreated(105) },
  { session_id: "live-lakshmi-4d07", hackerrank_username: "Lakshmi_V", name: "Lakshmi Venkat", room: "Lab B-2", contest_slug: DEMO_CONTEST_SLUG, status: "ended", chunk_count: 19, created_at: demoCreated(102) },
  { session_id: "live-arjun-4d08", hackerrank_username: "Arjun_D", name: "Arjun Das", room: "Lab A-1", contest_slug: DEMO_CONTEST_SLUG, status: "ended", chunk_count: 13, created_at: demoCreated(100) },
  { session_id: "live-pooja-4d09", hackerrank_username: "Pooja_I", name: "Pooja Iyer", room: "Lab B-2", contest_slug: DEMO_CONTEST_SLUG, status: "ended", chunk_count: 21, created_at: demoCreated(98) },
  { session_id: "live-rahul-4d10", hackerrank_username: "Rahul_J", name: "Rahul Joshi", room: "Lab A-1", contest_slug: DEMO_CONTEST_SLUG, status: "ended", chunk_count: 15, created_at: demoCreated(95) },
  { session_id: "live-anita-4d11", hackerrank_username: "Anita_C", name: "Anita Chandran", room: "Lab B-2", contest_slug: DEMO_CONTEST_SLUG, status: "ended", chunk_count: 18, created_at: demoCreated(92) },
  { session_id: "live-deepak-4d12", hackerrank_username: "Deepak_R", name: "Deepak Rao", room: "Lab A-1", contest_slug: DEMO_CONTEST_SLUG, status: "ended", chunk_count: 16, created_at: demoCreated(90) },
  { session_id: "live-kavya-4d13", hackerrank_username: "Kavya_N", name: "Kavya Nambiar", room: "Lab B-2", contest_slug: DEMO_CONTEST_SLUG, status: "ended", chunk_count: 23, created_at: demoCreated(88) },
  { session_id: "live-suresh-4d14", hackerrank_username: "Suresh_B", name: "Suresh Babu", room: "Lab A-1", contest_slug: DEMO_CONTEST_SLUG, status: "ended", chunk_count: 12, created_at: demoCreated(85) }
];

// S7 demo IP assignment: each demo room sits behind one NAT IP (the normal
// campus picture), with deterministic overrides painting the anomalies the
// report exists to catch — an off-campus active candidate, an ended outlier
// (visible under scope=all), and one mid-exam IP change.
const DEMO_IP_OVERRIDES: Record<string, { ip: string; start_ip?: string }> = {
  "live-sneha-1a04": { ip: "198.51.100.42" },
  "live-vikram-4d04": { ip: "192.0.2.77" },
  "live-divya-1a02": { ip: "203.0.113.11", start_ip: "198.51.100.7" }
};

function demoIpFor(session: DemoAdminSessionRow): { ip: string; start_ip: string; ip_change_count: number } {
  const override = DEMO_IP_OVERRIDES[session.session_id];
  const roomIp = session.room === "Lab A-1" ? "203.0.113.10" : "203.0.113.11";
  const ip = override?.ip ?? roomIp;
  const startIp = override?.start_ip ?? ip;
  return { ip, start_ip: startIp, ip_change_count: startIp !== ip ? 1 : 0 };
}

// Demo "disconnected" is a deterministic per-row `stale` flag on DEMO_ALL_SESSIONS
// (not wall-clock math), so the demo counts never drift as the page stays open.
// Production uses the real backend isStaleSession (handler.mjs) over live heartbeats.

// GET /api/admin/submission-events — the SUBMISSION-TIME MARKERS for one user's
// recording-review timeline (GREEN valid / RED invalid). Returns `null` on a 404
// (endpoint not deployed yet) so the timeline simply renders WITHOUT markers
// instead of erroring. In demo mode it returns canned events for the demo
// students so the markers are visible offline.
export async function fetchSubmissionEvents(
  password: string,
  username: string,
  contestSlug?: string
): Promise<SubmissionEvent[] | null> {
  if (demoMode) {
    await wait(100);
    assertDemoAdmin(password);
    return demoSubmissionEventsFor(normalizeUsername(username), contestSlug);
  }

  const query = new URLSearchParams();
  query.set("username", username);
  if (contestSlug) query.set("contest_slug", contestSlug);
  try {
    const response = await request<SubmissionEventsResponse>(
      `/api/admin/submission-events?${query.toString()}`,
      { method: "GET", headers: { "x-admin-password": password } }
    );
    return response.events;
  } catch (cause) {
    // Endpoint not deployed yet → no markers (graceful), not a hard error.
    if ((cause as ApiError)?.status === 404) return null;
    throw cause;
  }
}

// ---- Demo recording dataset ----------------------------------------------
// A small, self-contained set of fake students whose sessions carry screen
// chunks so the recording-playback UI (search → timeline → player → auto-advance)
// is fully testable OFFLINE. Each chunk's last_modified is placed on a real-time
// line at chunkSeconds spacing, with a deliberate GAP in one session so the
// timeline gap-rendering and seek-to-nearest logic are exercised. The actual clip
// for every chunk is the bundled /sample.webm placeholder.
const DEMO_CHUNK_SECONDS = 30;
const DEMO_SAMPLE_CLIP = "/sample.webm";

type DemoRecordingSeed = {
  session_id: string;
  hackerrank_username: string;
  username_norm: string;
  name: string;
  room: string;
  contest_slug: string;
  status: string;
  created_at: string;
  chunk_count: number;
  // Index offsets (0-based positions on the timeline). A jump between consecutive
  // values models a recording gap. Defaults to contiguous 0..chunk_count-1.
  gapAfterIndex?: number; // chunks after this 1-based index are shifted later
  gapChunks?: number; // how many chunk-widths of gap to insert
  // Multiple gaps (for the large/realistic seed). Each entry shifts every chunk
  // whose 1-based index is > afterIndex later by `chunks` chunk-widths. Applied in
  // addition to (and after) the single-gap fields above. afterIndex must be sorted
  // ascending; shifts accumulate so later chunks reflect all earlier gaps.
  gaps?: Array<{ afterIndex: number; chunks: number }>;
};

const DEMO_RECORDING_SESSIONS: DemoRecordingSeed[] = [
  {
    session_id: "rec-asha-9f2a",
    hackerrank_username: "Asha_R",
    username_norm: "asha_r",
    name: "Asha Ramanathan",
    room: "Lab A-1",
    contest_slug: "mcet-june-2026",
    status: "ended",
    created_at: "2026-06-05T09:00:00.000Z",
    chunk_count: 8
  },
  {
    session_id: "rec-karan-71b4",
    hackerrank_username: "Karan_V",
    username_norm: "karan_v",
    name: "Karan Verma",
    room: "Lab B-2",
    contest_slug: "mcet-june-2026",
    status: "ended",
    // Late joiner: starts 2 minutes after the test start.
    created_at: "2026-06-05T09:02:00.000Z",
    chunk_count: 6,
    // Gap: after the 3rd chunk, the recording dropped for ~1 chunk-width.
    gapAfterIndex: 3,
    gapChunks: 2
  },
  {
    session_id: "rec-neha-3c10",
    hackerrank_username: "Neha_S",
    username_norm: "neha_s",
    name: "Neha Sharma",
    room: "Lab B-2",
    contest_slug: "mcet-june-2026",
    status: "active",
    created_at: "2026-06-05T09:00:30.000Z",
    chunk_count: 4
  },
  {
    // REAL-SCALE seed: a full ~1h50m sitting. 220 recorded chunks × 30s = 110min of
    // recording; two recording GAPS push the timeline end a little past that, so the
    // dense timeline, adaptive 15-min ticks, gap rendering and marker legibility can
    // all be verified OFFLINE. Gap 1: ~5min blackout after chunk 80 (around 00:40).
    // Gap 2: ~2.5min blackout after chunk 150 (around 01:15, post-gap-1 shifted).
    session_id: "rec-vikram-load",
    hackerrank_username: "Vikram_T",
    username_norm: "vikram_t",
    name: "Vikram Thiagarajan",
    room: "Lab C-3",
    contest_slug: "mcet-june-2026",
    status: "ended",
    created_at: "2026-06-05T09:00:00.000Z",
    chunk_count: 220,
    gaps: [
      { afterIndex: 80, chunks: 10 }, // ~5min recording gap mid-test
      { afterIndex: 150, chunks: 5 } // ~2.5min recording gap later
    ]
  }
];

// ---- Demo submission-time markers ----------------------------------------
// Canned submission events for the 3 demo students so the timeline markers
// (GREEN valid / RED invalid) are visible OFFLINE. Times are placed ON each
// student's recording timeline (created_at + minutes), with a realistic mix of
// valid + invalid. One of Karan's lands in his recording GAP (09:03:30–09:04:30)
// so the proctor sees "they submitted during the blackout".
type DemoSubmissionSeed = SubmissionEvent & { username_norm: string };

const DEMO_SUBMISSION_EVENTS: DemoSubmissionSeed[] = [
  // Asha (created 09:00:00, 8 chunks → 09:00–09:04): two fails then an accept.
  { username_norm: "asha_r", hackerrank_username: "Asha_R", contest_slug: "mcet-june-2026", submission_id: "as-1", challenge_slug: "two-sum", challenge_name: "Two Sum", lang: "python3", status: "Wrong Answer", valid: false, submitted_at: "2026-06-05T09:01:10.000Z" },
  { username_norm: "asha_r", hackerrank_username: "Asha_R", contest_slug: "mcet-june-2026", submission_id: "as-2", challenge_slug: "two-sum", challenge_name: "Two Sum", lang: "python3", status: "Runtime Error", valid: false, submitted_at: "2026-06-05T09:02:25.000Z" },
  { username_norm: "asha_r", hackerrank_username: "Asha_R", contest_slug: "mcet-june-2026", submission_id: "as-3", challenge_slug: "two-sum", challenge_name: "Two Sum", lang: "python3", status: "Accepted", valid: true, submitted_at: "2026-06-05T09:03:40.000Z" },
  // Karan (created 09:02:00, gap 09:03:30–09:04:30): one accept, one in the GAP.
  { username_norm: "karan_v", hackerrank_username: "Karan_V", contest_slug: "mcet-june-2026", submission_id: "ka-1", challenge_slug: "balanced-brackets", challenge_name: "Balanced Brackets", lang: "cpp", status: "Accepted", valid: true, submitted_at: "2026-06-05T09:03:05.000Z" },
  { username_norm: "karan_v", hackerrank_username: "Karan_V", contest_slug: "mcet-june-2026", submission_id: "ka-2", challenge_slug: "balanced-brackets", challenge_name: "Balanced Brackets", lang: "cpp", status: "Compilation error", valid: false, submitted_at: "2026-06-05T09:04:00.000Z" },
  // Neha (created 09:00:30, 4 chunks → 09:00:30–09:02:30): one fail, one accept.
  { username_norm: "neha_s", hackerrank_username: "Neha_S", contest_slug: "mcet-june-2026", submission_id: "ne-1", challenge_slug: "two-sum", challenge_name: "Two Sum", lang: "java", status: "Terminated due to timeout", valid: false, submitted_at: "2026-06-05T09:01:15.000Z" },
  { username_norm: "neha_s", hackerrank_username: "Neha_S", contest_slug: "mcet-june-2026", submission_id: "ne-2", challenge_slug: "two-sum", challenge_name: "Two Sum", lang: "java", status: "Accepted", valid: true, submitted_at: "2026-06-05T09:02:05.000Z" },
  // Vikram (created 09:00:00, ~117min span, gaps at 40–45min and 80–82.5min):
  // 22 submissions across the full sitting, a realistic valid/invalid mix, several
  // clustered tightly (to prove dense markers stay individually legible), and two
  // landing IN the recording gaps (proctor sees "submitted during the blackout").
  // Times are real (09:00 + offset); the recording timeline labels them in h:mm:ss.
  { username_norm: "vikram_t", hackerrank_username: "Vikram_T", contest_slug: "mcet-june-2026", submission_id: "vt-01", challenge_slug: "two-sum", challenge_name: "Two Sum", lang: "cpp", status: "Wrong Answer", valid: false, submitted_at: "2026-06-05T09:03:20.000Z" },
  { username_norm: "vikram_t", hackerrank_username: "Vikram_T", contest_slug: "mcet-june-2026", submission_id: "vt-02", challenge_slug: "two-sum", challenge_name: "Two Sum", lang: "cpp", status: "Wrong Answer", valid: false, submitted_at: "2026-06-05T09:05:10.000Z" },
  { username_norm: "vikram_t", hackerrank_username: "Vikram_T", contest_slug: "mcet-june-2026", submission_id: "vt-03", challenge_slug: "two-sum", challenge_name: "Two Sum", lang: "cpp", status: "Accepted", valid: true, submitted_at: "2026-06-05T09:07:45.000Z" },
  // Cluster around 12–13min (three submissions within ~70s → dense markers).
  { username_norm: "vikram_t", hackerrank_username: "Vikram_T", contest_slug: "mcet-june-2026", submission_id: "vt-04", challenge_slug: "balanced-brackets", challenge_name: "Balanced Brackets", lang: "cpp", status: "Runtime Error", valid: false, submitted_at: "2026-06-05T09:12:05.000Z" },
  { username_norm: "vikram_t", hackerrank_username: "Vikram_T", contest_slug: "mcet-june-2026", submission_id: "vt-05", challenge_slug: "balanced-brackets", challenge_name: "Balanced Brackets", lang: "cpp", status: "Wrong Answer", valid: false, submitted_at: "2026-06-05T09:12:40.000Z" },
  { username_norm: "vikram_t", hackerrank_username: "Vikram_T", contest_slug: "mcet-june-2026", submission_id: "vt-06", challenge_slug: "balanced-brackets", challenge_name: "Balanced Brackets", lang: "cpp", status: "Accepted", valid: true, submitted_at: "2026-06-05T09:13:15.000Z" },
  { username_norm: "vikram_t", hackerrank_username: "Vikram_T", contest_slug: "mcet-june-2026", submission_id: "vt-07", challenge_slug: "merge-intervals", challenge_name: "Merge Intervals", lang: "cpp", status: "Compilation error", valid: false, submitted_at: "2026-06-05T09:18:30.000Z" },
  { username_norm: "vikram_t", hackerrank_username: "Vikram_T", contest_slug: "mcet-june-2026", submission_id: "vt-08", challenge_slug: "merge-intervals", challenge_name: "Merge Intervals", lang: "cpp", status: "Accepted", valid: true, submitted_at: "2026-06-05T09:22:50.000Z" },
  { username_norm: "vikram_t", hackerrank_username: "Vikram_T", contest_slug: "mcet-june-2026", submission_id: "vt-09", challenge_slug: "lru-cache", challenge_name: "LRU Cache", lang: "cpp", status: "Wrong Answer", valid: false, submitted_at: "2026-06-05T09:28:10.000Z" },
  { username_norm: "vikram_t", hackerrank_username: "Vikram_T", contest_slug: "mcet-june-2026", submission_id: "vt-10", challenge_slug: "lru-cache", challenge_name: "LRU Cache", lang: "cpp", status: "Terminated due to timeout", valid: false, submitted_at: "2026-06-05T09:33:25.000Z" },
  { username_norm: "vikram_t", hackerrank_username: "Vikram_T", contest_slug: "mcet-june-2026", submission_id: "vt-11", challenge_slug: "lru-cache", challenge_name: "LRU Cache", lang: "cpp", status: "Accepted", valid: true, submitted_at: "2026-06-05T09:38:55.000Z" },
  // vt-12 lands IN GAP 1 (recording blackout 40–45min): "submitted during blackout".
  { username_norm: "vikram_t", hackerrank_username: "Vikram_T", contest_slug: "mcet-june-2026", submission_id: "vt-12", challenge_slug: "word-ladder", challenge_name: "Word Ladder", lang: "cpp", status: "Wrong Answer", valid: false, submitted_at: "2026-06-05T09:42:30.000Z" },
  { username_norm: "vikram_t", hackerrank_username: "Vikram_T", contest_slug: "mcet-june-2026", submission_id: "vt-13", challenge_slug: "word-ladder", challenge_name: "Word Ladder", lang: "cpp", status: "Runtime Error", valid: false, submitted_at: "2026-06-05T09:48:05.000Z" },
  { username_norm: "vikram_t", hackerrank_username: "Vikram_T", contest_slug: "mcet-june-2026", submission_id: "vt-14", challenge_slug: "word-ladder", challenge_name: "Word Ladder", lang: "cpp", status: "Accepted", valid: true, submitted_at: "2026-06-05T09:54:40.000Z" },
  { username_norm: "vikram_t", hackerrank_username: "Vikram_T", contest_slug: "mcet-june-2026", submission_id: "vt-15", challenge_slug: "trapping-rain-water", challenge_name: "Trapping Rain Water", lang: "cpp", status: "Wrong Answer", valid: false, submitted_at: "2026-06-05T10:01:15.000Z" },
  { username_norm: "vikram_t", hackerrank_username: "Vikram_T", contest_slug: "mcet-june-2026", submission_id: "vt-16", challenge_slug: "trapping-rain-water", challenge_name: "Trapping Rain Water", lang: "cpp", status: "Accepted", valid: true, submitted_at: "2026-06-05T10:08:30.000Z" },
  { username_norm: "vikram_t", hackerrank_username: "Vikram_T", contest_slug: "mcet-june-2026", submission_id: "vt-17", challenge_slug: "edit-distance", challenge_name: "Edit Distance", lang: "cpp", status: "Wrong Answer", valid: false, submitted_at: "2026-06-05T10:14:20.000Z" },
  // vt-18 lands IN GAP 2 (recording blackout ~80–82.5min → 10:20–10:22:30).
  { username_norm: "vikram_t", hackerrank_username: "Vikram_T", contest_slug: "mcet-june-2026", submission_id: "vt-18", challenge_slug: "edit-distance", challenge_name: "Edit Distance", lang: "cpp", status: "Runtime Error", valid: false, submitted_at: "2026-06-05T10:21:10.000Z" },
  { username_norm: "vikram_t", hackerrank_username: "Vikram_T", contest_slug: "mcet-june-2026", submission_id: "vt-19", challenge_slug: "edit-distance", challenge_name: "Edit Distance", lang: "cpp", status: "Accepted", valid: true, submitted_at: "2026-06-05T10:27:45.000Z" },
  { username_norm: "vikram_t", hackerrank_username: "Vikram_T", contest_slug: "mcet-june-2026", submission_id: "vt-20", challenge_slug: "n-queens", challenge_name: "N-Queens", lang: "cpp", status: "Wrong Answer", valid: false, submitted_at: "2026-06-05T10:36:05.000Z" },
  { username_norm: "vikram_t", hackerrank_username: "Vikram_T", contest_slug: "mcet-june-2026", submission_id: "vt-21", challenge_slug: "n-queens", challenge_name: "N-Queens", lang: "cpp", status: "Wrong Answer", valid: false, submitted_at: "2026-06-05T10:44:30.000Z" },
  { username_norm: "vikram_t", hackerrank_username: "Vikram_T", contest_slug: "mcet-june-2026", submission_id: "vt-22", challenge_slug: "n-queens", challenge_name: "N-Queens", lang: "cpp", status: "Accepted", valid: true, submitted_at: "2026-06-05T10:54:10.000Z" }
];

function demoSubmissionEventsFor(usernameNorm: string, contestSlug?: string): SubmissionEvent[] {
  return DEMO_SUBMISSION_EVENTS
    .filter((seed) => seed.username_norm === usernameNorm)
    .filter((seed) => !contestSlug || seed.contest_slug === contestSlug)
    .map(({ username_norm: _drop, ...event }) => event)
    .sort((a, b) => a.submitted_at.localeCompare(b.submitted_at));
}

// Build the signed-evidence playlist for a demo session: one screen chunk per
// index, last_modified stamped at chunkSeconds spacing from created_at (a chunk's
// last_modified is its END time, matching the real "object finalized when the
// 30s chunk closes" semantics the offset math relies on). An optional gap shifts
// the tail later so the timeline shows a visible blank.
function demoEvidenceFor(seed: DemoRecordingSeed): SessionEvidence[] {
  const createdMs = Date.parse(seed.created_at);
  const prefix = `contests/${seed.contest_slug}/sessions/${seed.username_norm}/${seed.session_id}/`;
  const evidence: SessionEvidence[] = [];
  for (let i = 1; i <= seed.chunk_count; i += 1) {
    let position = i; // 1-based contiguous position on the timeline
    if (seed.gapAfterIndex && i > seed.gapAfterIndex) position += seed.gapChunks ?? 1;
    // Apply any additional (multi-gap) shifts; each gap pushes all later chunks.
    if (seed.gaps) {
      for (const gap of seed.gaps) {
        if (i > gap.afterIndex) position += gap.chunks;
      }
    }
    // last_modified = END of this chunk = createdMs + position*chunkSeconds.
    const lastModifiedMs = createdMs + position * DEMO_CHUNK_SECONDS * 1000;
    evidence.push({
      key: `${prefix}screen/chunk-${String(i).padStart(5, "0")}.webm`,
      size: 320_000 + i * 1000,
      last_modified: new Date(lastModifiedMs).toISOString(),
      download_url: DEMO_SAMPLE_CLIP
    });
  }
  // Add a couple of non-screen files so filtering is exercised too.
  evidence.push({ key: `${prefix}manifest.json`, size: 412, last_modified: seed.created_at, download_url: DEMO_SAMPLE_CLIP });
  return evidence;
}

function demoRecordingSessionsFor(usernameNorm: string): AdminSessionsResponse["sessions"] {
  return DEMO_RECORDING_SESSIONS
    .filter((seed) => seed.username_norm === usernameNorm)
    .map((seed) => ({
      session_id: seed.session_id,
      hackerrank_username: seed.hackerrank_username,
      username_norm: seed.username_norm,
      name: seed.name,
      room: seed.room,
      contest_slug: seed.contest_slug,
      storage_prefix: `contests/${seed.contest_slug}/sessions/${seed.username_norm}/${seed.session_id}/`,
      status: seed.status,
      created_at: seed.created_at,
      chunk_count: seed.chunk_count,
      evidence: demoEvidenceFor(seed)
    }));
}

export async function fetchAdminStats(password: string, contestSlug?: string, room?: string): Promise<AdminStatsResponse> {
  if (demoMode) {
    await wait(120);
    assertDemoAdmin(password);
    // Count from the SHARED admin population — the SAME source fetchSessionsList
    // filters — so each card count equals its drill-down list count, mirroring
    // production (where stats and sessions-list both read the same session docs).
    const all = DEMO_ALL_SESSIONS;
    // Distinct rooms come from the contest-scoped population BEFORE the room
    // filter, so the Room dropdown stays full while the filter re-scopes counts.
    const demoRooms = [
      ...new Set(
        all
          .filter((s) => !contestSlug || s.contest_slug === contestSlug)
          .map((s) => String(s.room || "").trim())
          .filter(Boolean)
      )
    ].sort((a, b) => a.localeCompare(b));
    const stats = { live: 0, locked: 0, pending_approval: 0, finished: 0, disconnected: 0, total: 0, not_started_or_total: 0 };
    for (const session of all) {
      if (contestSlug && session.contest_slug !== contestSlug) continue;
      // Room scopes the COUNTS (but not the rooms dropdown, computed above).
      if (room && String(session.room || "") !== room) continue;
      stats.total += 1;
      if (session.status === "active") {
        stats.live += 1;
        // disconnected = active && stale (derived, not a separate status).
        if (session.stale === true) stats.disconnected += 1;
      } else if (session.status === "locked") stats.locked += 1;
      else if (session.status === "pending_approval") stats.pending_approval += 1;
      else if (session.status === "ended") stats.finished += 1;
    }
    stats.not_started_or_total = stats.total;
    return { contest_slug: contestSlug || null, room: room || null, stats, rooms: demoRooms, disconnected_staleness_ms: 45000, end_at: getDemoSettings()?.end_at || "", server_now: new Date().toISOString() };
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

// ---- S6 attendance stats ----------------------------------------------------
// GET /api/admin/attendance — roster-based taken / not-taken / absentees.
// Spec: docs/superpowers/specs/2026-06-09-s6-attendance-stats-design.md.
// `null` on 404 so the Attendance tab can show "not deployed yet" (same degrade
// as fetchSessionsList / fetchRosterStatus). The demo branch joins the demo
// roster against the REAL demo session store via the SAME pure computeAttendance
// the backend semantics mirror, so demo and production agree by construction.
export async function fetchAttendance(password: string, contestSlug?: string): Promise<AttendanceReport | null> {
  if (demoMode) {
    await wait(150);
    assertDemoAdmin(password);
    const roster = getDemoRoster();
    if (!roster) return { configured: false };
    const mapped = (row: Record<string, string>, field: keyof RosterColumnMapping) => {
      const column = roster.column_mapping[field];
      return column ? (row[column] ?? "").trim() : "";
    };
    const rosterRows = roster.rows.map((row) => ({
      unique_id: (row[roster.unique_id_column] ?? "").trim(),
      name: mapped(row, "name"),
      roll_number: mapped(row, "roll_number"),
      room: mapped(row, "room")
    }));
    const sessions = readDemoSessions()
      .filter((session) => !contestSlug || session.contest_slug === contestSlug)
      .map((session) => ({
        // Old persisted demo sessions predate the field — read defensively.
        roster_unique_id: String(session.roster_unique_id ?? ""),
        status: session.status
      }));
    return {
      configured: true,
      contest_slug: contestSlug || null,
      generated_at: new Date().toISOString(),
      ...computeAttendance(rosterRows, sessions)
    };
  }

  const query = new URLSearchParams();
  if (contestSlug) query.set("contest_slug", contestSlug);
  const suffix = query.toString();
  try {
    return await request<AttendanceReport>(`/api/admin/attendance${suffix ? `?${suffix}` : ""}`, {
      method: "GET",
      headers: { "x-admin-password": password }
    });
  } catch (cause) {
    if ((cause as ApiError)?.status === 404) return null;
    throw cause;
  }
}

// S7 — GET /api/admin/ip-report: IP-wise counts of logged-in users (the
// proxy-detection signal). Returns null on 404 (endpoint not deployed yet) so
// the IP-report tab degrades gracefully, mirroring fetchSessionsList. The demo
// branch derives the report from the SHARED admin population (DEMO_ALL_SESSIONS)
// + the deterministic demoIpFor assignment, so demo numbers reconcile with the
// demo stat cards by construction.
export async function fetchIpReport(
  password: string,
  opts: { contestSlug?: string; scope?: IpReportScope }
): Promise<IpReportResponse | null> {
  const scope: IpReportScope = opts.scope ?? "live";
  const contestSlug = opts.contestSlug || "";
  if (demoMode) {
    await wait(120);
    assertDemoAdmin(password);
    const rows: IpRow[] = DEMO_ALL_SESSIONS
      .filter((session) => !contestSlug || session.contest_slug === contestSlug)
      .filter((session) => scope === "all" || session.status !== "ended")
      .map((session) => {
        const assigned = demoIpFor(session);
        return {
          session_id: session.session_id,
          hackerrank_username: session.hackerrank_username,
          name: session.name,
          room: session.room,
          status: session.status,
          created_at: session.created_at,
          ip: assigned.ip,
          start_ip: assigned.start_ip,
          ip_change_count: assigned.ip_change_count
        };
      });
    const ips = groupIpEntries(rows);
    return {
      contest_slug: contestSlug || null,
      room: null,
      scope,
      ...summarizeIpEntries(ips, rows),
      ips,
      ips_truncated: false
    };
  }

  const query = new URLSearchParams();
  if (contestSlug) query.set("contest_slug", contestSlug);
  if (scope !== "live") query.set("scope", scope);
  const suffix = query.toString();
  try {
    return await request<IpReportResponse>(`/api/admin/ip-report${suffix ? `?${suffix}` : ""}`, {
      method: "GET",
      headers: { "x-admin-password": password }
    });
  } catch (cause) {
    if ((cause as ApiError)?.status === 404) return null;
    throw cause;
  }
}

export async function sessionAction(password: string, body: SessionActionRequest): Promise<SessionActionResponse> {
  if (demoMode) {
    await wait(150);
    assertDemoAdmin(password);
    // Two demo stores cover different demo flows: the localStorage session store
    // (student-flow sessions started in this browser) and the canned admin
    // population (DEMO_ALL_SESSIONS — what the admin console lists). Apply to
    // both; their ids/usernames don't overlap, so counts don't double.
    const updated = [...applyDemoSessionAction(body), ...applyDemoAdminPopulationAction(body)];
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

// S5: live exam-time control — set an absolute end_at, shift it by
// extend_minutes, or end_now (which also force-ends every live session). The
// demo branch mirrors the backend exactly: merge-update the demo settings, and
// for end_now mark every non-ended demo session ended so the demo heartbeat
// throws the same 409 session_ended the real backend would (B8 parity).
export async function adjustExamTime(password: string, body: ExamTimeRequest): Promise<ExamTimeResponse> {
  if (demoMode) {
    await wait(150);
    assertDemoAdmin(password);
    const settings = getDemoSettings();
    if (!settings?.start_at || !settings?.end_at) {
      throw new Error("Proctoring schedule is not configured yet.");
    }
    const now = new Date().toISOString();
    let newEndMs: number;
    if (body.end_now === true) {
      newEndMs = Date.parse(now);
    } else if (body.end_at) {
      newEndMs = Date.parse(body.end_at);
      if (!Number.isFinite(newEndMs)) throw new Error("end_at must be a valid ISO 8601 date");
    } else {
      const delta = Number(body.extend_minutes);
      if (!Number.isFinite(delta) || delta === 0) throw new Error("extend_minutes must be a non-zero number");
      newEndMs = Date.parse(settings.end_at) + delta * 60_000;
    }
    if (newEndMs <= Date.parse(settings.start_at)) {
      throw new Error("End time must be after the start time.");
    }
    const newEndAt = new Date(newEndMs).toISOString();
    // D1: end_at_updated_at stamps exam-time ownership of end_at (backend
    // parity) so a stale Settings-form save cannot revert this live change.
    window.localStorage.setItem(demoSettingsKey, JSON.stringify({ ...settings, end_at: newEndAt, end_at_updated_at: now, updated_at: now }));
    let endedCount = 0;
    if (body.end_now === true) {
      for (const session of readDemoSessions()) {
        if (session.status !== "ended") {
          upsertDemoSession({ ...session, status: "ended", blocked_by_session_id: null });
          endedCount += 1;
        }
      }
    }
    return { ok: true, start_at: settings.start_at, end_at: newEndAt, server_now: now, ended_count: endedCount };
  }

  return request<ExamTimeResponse>("/api/admin/exam-time", {
    method: "POST",
    headers: { "x-admin-password": password },
    body: JSON.stringify(body)
  });
}

// F6.4 demo parity: apply the action to the shared admin population
// (DEMO_ALL_SESSIONS) too, so the alerts-console status join, the Sessions
// drill-down, and the stat cards all reflect the new status on the next poll.
// In-memory only (module const — resets on reload), mirroring the same target
// resolution as the backend: a single session_id, or each username's newest
// live session. Returns the updated rows for the action's "N session(s)" count.
function applyDemoAdminPopulationAction(body: SessionActionRequest): Array<Record<string, unknown>> {
  const targets: DemoAdminSessionRow[] = [];
  if (body.session_id) {
    const found = DEMO_ALL_SESSIONS.find((row) => row.session_id === body.session_id);
    if (found) targets.push(found);
  } else if (body.usernames?.length) {
    for (const username of body.usernames) {
      const usernameNorm = normalizeUsername(username);
      const live = DEMO_ALL_SESSIONS
        .filter((row) => normalizeUsername(row.hackerrank_username) === usernameNorm && row.status !== "ended")
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      if (live.length) targets.push(live[0]);
    }
  }
  const updated: Array<Record<string, unknown>> = [];
  for (const row of targets) {
    if (body.action === "approve" || body.action === "unlock" || body.action === "bypass") row.status = "active";
    else if (body.action === "lock") row.status = "locked";
    else if (body.action === "end") row.status = "ended";
    updated.push({ ...row });
  }
  return updated;
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
  // F6.4: every session_id / username here joins to a DEMO_ALL_SESSIONS row so
  // the contextual action buttons render real statuses across the spectrum:
  // active (Arav), pending_approval (Fatima), locked (Imran), ended (Asha,
  // Neha, Karan) — plus the no-session contest-eval shape via Karan/Imran
  // username joins.
  const sampleVideo = "/sample.webm";
  return [
    {
      // PENDING second-device candidate — no session_id on the alert; the
      // username join resolves her latest live session (pending_approval) so
      // the row offers Approve / Unblock / End.
      id: "proctor:disconnected:fatima_a:mcet-june-2026:1",
      source: "proctor",
      type: "disconnected",
      severity: "warning",
      timestamp: "2026-06-05T09:50:08.000Z",
      contest_slug: "mcet-june-2026",
      hackerrank_username: "Fatima_A",
      username_norm: "fatima_a",
      room: "Lab A-1",
      title: "Disconnected — second device waiting for approval",
      detail: "Heartbeats stopped on the first device; a second device then started and is blocked pending admin approval.",
      data: { last_heartbeat_age_seconds: 95, pending_session_id: "live-fatima-3c01" }
    },
    {
      // ACTIVE candidate — joins live-arav-1a01 (active) → Lock / End.
      id: "proctor:tab_away:arav_m:mcet-june-2026:1",
      source: "proctor",
      type: "tab_away",
      severity: "warning",
      timestamp: "2026-06-05T09:46:30.000Z",
      contest_slug: "mcet-june-2026",
      hackerrank_username: "Arav_M",
      username_norm: "arav_m",
      session_id: "live-arav-1a01",
      room: "Lab A-1",
      title: "Tab switched away for 14s",
      detail: "Candidate left the exam tab for 14 seconds, then returned. Above the configured threshold.",
      data: { away_seconds: 14, threshold_seconds: 12 },
      video_key: "mcet-june-2026/arav_m/live-arav-1a01.webm",
      download_url: sampleVideo
    },
    {
      id: "proctor:recording_stopped:asha_r:mcet-june-2026:1",
      source: "proctor",
      type: "recording_stopped",
      severity: "critical",
      timestamp: "2026-06-05T09:42:11.000Z",
      contest_slug: "mcet-june-2026",
      hackerrank_username: "Asha_R",
      username_norm: "asha_r",
      session_id: "live-asha-4d01",
      room: "Lab A-1",
      title: "Recording stopped mid-assessment",
      detail: "MediaRecorder stopped 18m before submission with no end-session event. Possible deliberate stop.",
      data: { gap_seconds: 1080, last_chunk_index: 54 },
      video_key: "mcet-june-2026/asha_r/live-asha-4d01.webm",
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
      session_id: "live-neha-4d03",
      room: "Lab B-2",
      title: "Screen share stopped",
      detail: "Candidate ended screen share for 42s, then resumed. Logged for review.",
      data: { interruptions: 1, gap_seconds: 42 },
      video_key: "mcet-june-2026/neha_s/live-neha-4d03.webm",
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
      session_id: "live-asha-4d01",
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
    recording_error: { enabled: true, severity: "critical" },
    ip_changed: { enabled: true, severity: "warning" },
    tab_hidden: { enabled: true, severity: "warning" },
    tab_away: { enabled: true, severity: "warning", threshold_seconds: 12 },
    disconnected: { enabled: true, severity: "warning" }
  }
};

// Merge a (possibly partial) stored proctor config over the defaults so callers
// always see a complete, well-formed per-type config — mirrors backend merge.
function mergeDemoAlertSettings(stored?: Partial<AlertSettings["proctor"]>): AlertSettings {
  const proctor: AlertSettings["proctor"] = {};
  for (const [type, def] of Object.entries(DEFAULT_DEMO_ALERT_SETTINGS.proctor)) {
    const override = stored?.[type];
    const entry: ProctorAlertTypeConfig = {
      enabled: override && typeof override.enabled === "boolean" ? override.enabled : def.enabled,
      severity: override && ["critical", "warning", "info"].includes(override.severity) ? override.severity : def.severity
    };
    // Mirror the backend: tab_away alone carries threshold_seconds. Validate it's
    // a positive finite number; otherwise fall back to the default (12).
    if (def.threshold_seconds !== undefined) {
      const raw = override?.threshold_seconds;
      const num = typeof raw === "number" ? raw : Number(raw);
      entry.threshold_seconds = Number.isFinite(num) && num > 0 ? num : def.threshold_seconds;
    }
    proctor[type] = entry;
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

// ===========================================================================
// MULTI-REVIEWER RECORDING-REVIEW WORKFLOW
// ===========================================================================
// Six admin-gated endpoints (x-admin-password). 10 reviewers each enter a name
// and are served students one-by-one to give a binary YES(1)/NO(0) verdict; an
// operator pastes the roster and exports a CSV. Each endpoint degrades on a 404
// (endpoint not deployed yet) so review mode can show "not deployed yet" instead
// of hard-erroring. In demo mode all six are backed by a localStorage store that
// implements the SAME serving priority the backend will, so the whole flow runs
// offline against the existing demo students.

// Split a pasted roster on commas OR newlines (and stray whitespace), trim each,
// drop blanks, and dedupe case-insensitively while preserving first-seen casing.
// Used by saveReviewRoster and mirrored in the Settings UI for the live count.
export function parseRosterInput(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of raw.split(/[\n,]+/)) {
    const name = token.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

// GET /api/admin/review-roster → roster summary (coverage buckets + active
// claims). Returns `null` on a 404 so the Settings/Review UI can show a clear
// "review workflow is not deployed yet" note instead of erroring.
export async function fetchReviewRoster(password: string): Promise<ReviewRosterSummary | null> {
  if (demoMode) {
    await wait(100);
    assertDemoAdmin(password);
    return demoReviewRosterSummary();
  }
  try {
    return await request<ReviewRosterSummary>("/api/admin/review-roster", {
      method: "GET",
      headers: { "x-admin-password": password }
    });
  } catch (cause) {
    if ((cause as ApiError)?.status === 404) return null;
    throw cause;
  }
}

// POST /api/admin/review-roster {usernames} → {ok,count}. Returns `null` on a
// 404 (not deployed) so the Settings page can degrade gracefully.
export async function saveReviewRoster(password: string, usernames: string[]): Promise<ReviewRosterSaveResponse | null> {
  // Trim/dedupe client-side too (defense-in-depth; the textarea also pre-parses).
  const cleaned = parseRosterInput(usernames.join("\n"));
  if (demoMode) {
    await wait(150);
    assertDemoAdmin(password);
    writeDemoRoster(cleaned);
    return { ok: true, count: cleaned.length };
  }
  try {
    return await request<ReviewRosterSaveResponse>("/api/admin/review-roster", {
      method: "POST",
      headers: { "x-admin-password": password },
      body: JSON.stringify({ usernames: cleaned })
    });
  } catch (cause) {
    if ((cause as ApiError)?.status === 404) return null;
    throw cause;
  }
}

// POST /api/admin/review-next {reviewer_name} → {username} | {done:true}. The
// SERVER picks who to serve (by priority); the UI just shows whoever comes back.
// Returns `null` on a 404 so review mode can show "not deployed yet".
export async function reviewNext(password: string, reviewerName: string): Promise<ReviewNextResponse | null> {
  if (demoMode) {
    await wait(150);
    assertDemoAdmin(password);
    return demoReviewNext(reviewerName);
  }
  try {
    return await request<ReviewNextResponse>("/api/admin/review-next", {
      method: "POST",
      headers: { "x-admin-password": password },
      body: JSON.stringify({ reviewer_name: reviewerName })
    });
  } catch (cause) {
    if ((cause as ApiError)?.status === 404) return null;
    throw cause;
  }
}

// POST /api/admin/review-verdict {username, reviewer_name, verdict} → {ok}.
// Returns `null` on a 404 so the caller can surface "not deployed yet".
export async function submitReviewVerdict(
  password: string,
  params: { username: string; reviewer_name: string; verdict: ReviewVerdict }
): Promise<ReviewVerdictResponse | null> {
  if (demoMode) {
    await wait(150);
    assertDemoAdmin(password);
    demoRecordVerdict(params.username, params.reviewer_name, params.verdict);
    return { ok: true };
  }
  try {
    return await request<ReviewVerdictResponse>("/api/admin/review-verdict", {
      method: "POST",
      headers: { "x-admin-password": password },
      body: JSON.stringify(params)
    });
  } catch (cause) {
    if ((cause as ApiError)?.status === 404) return null;
    throw cause;
  }
}

// GET /api/admin/review-mine?reviewer_name=X → this reviewer's own verdicts.
// Returns `null` on a 404 so the header count/list can degrade gracefully.
export async function fetchMyReviews(password: string, reviewerName: string): Promise<ReviewMineResponse | null> {
  if (demoMode) {
    await wait(100);
    assertDemoAdmin(password);
    return demoReviewMine(reviewerName);
  }
  try {
    return await request<ReviewMineResponse>(
      `/api/admin/review-mine?reviewer_name=${encodeURIComponent(reviewerName)}`,
      { method: "GET", headers: { "x-admin-password": password } }
    );
  } catch (cause) {
    if ((cause as ApiError)?.status === 404) return null;
    throw cause;
  }
}

// GET /api/admin/reviews → every verdict record across all reviewers (CSV source).
// Returns `null` on a 404 so the export button can show "not deployed yet".
export async function fetchAllReviews(password: string): Promise<ReviewRecord[] | null> {
  if (demoMode) {
    await wait(120);
    assertDemoAdmin(password);
    return readDemoVerdicts()
      .slice()
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  try {
    const response = await request<ReviewsResponse>("/api/admin/reviews", {
      method: "GET",
      headers: { "x-admin-password": password }
    });
    return response.reviews;
  } catch (cause) {
    if ((cause as ApiError)?.status === 404) return null;
    throw cause;
  }
}

// POST /api/admin/session-details {usernames, contest_slug?} → one detail row per
// INPUT username (in input order; found:false with blank fields when no session
// matched). Backs the operator's "Download all details" CSV. Returns `null` on a
// 404 (endpoint not deployed yet) so the button degrades gracefully. In demo mode
// it resolves details from the demo session store + recording seeds.
export async function fetchSessionDetails(
  password: string,
  usernames: string[],
  contestSlug?: string
): Promise<SessionDetail[] | null> {
  if (demoMode) {
    await wait(120);
    assertDemoAdmin(password);
    return usernames.map((username) => demoSessionDetailFor(username, contestSlug));
  }
  try {
    const response = await request<SessionDetailsResponse>("/api/admin/session-details", {
      method: "POST",
      headers: { "x-admin-password": password },
      body: JSON.stringify({ usernames, contest_slug: contestSlug })
    });
    return response.details;
  } catch (cause) {
    if ((cause as ApiError)?.status === 404) return null;
    throw cause;
  }
}

// Resolve one demo session-detail row for a username (input order preserved by the
// caller). Looks first at the demo student session store, then the recording seeds;
// `found:false` (blank fields) when neither matches the username/contest scope.
// The demo data carries no email/roll_number, so those stay blank in demo.
function demoSessionDetailFor(username: string, contestSlug?: string): SessionDetail {
  const usernameNorm = normalizeUsername(username);
  const session = readDemoSessions().find(
    (item) => item.username_norm === usernameNorm && (!contestSlug || item.contest_slug === contestSlug)
  );
  if (session) {
    return {
      username,
      hackerrank_username: session.hackerrank_username,
      name: session.name,
      email: "",
      roll_number: "",
      room: session.room,
      contest_slug: session.contest_slug,
      status: session.status,
      found: true
    };
  }
  const seed = DEMO_RECORDING_SESSIONS.find(
    (item) => item.username_norm === usernameNorm && (!contestSlug || item.contest_slug === contestSlug)
  );
  if (seed) {
    return {
      username,
      hackerrank_username: seed.hackerrank_username,
      name: seed.name,
      email: "",
      roll_number: "",
      room: seed.room,
      contest_slug: seed.contest_slug,
      status: seed.status,
      found: true
    };
  }
  return {
    username,
    hackerrank_username: "",
    name: "",
    email: "",
    roll_number: "",
    room: "",
    contest_slug: contestSlug ?? "",
    status: "",
    found: false
  };
}

// ---- Demo review store ----------------------------------------------------
// localStorage-backed, persists across reloads. The roster defaults to the four
// demo students that have recordings. Verdicts accumulate as reviewers act, and
// the serving priority below mirrors the contract the backend implements.

const DEMO_DEFAULT_ROSTER = ["Asha_R", "Karan_V", "Neha_S", "Vikram_T"];

type DemoVerdict = {
  username: string;
  reviewer_name: string;
  verdict: ReviewVerdict;
  created_at: string;
};

function readDemoRoster(): string[] {
  const raw = window.localStorage.getItem(demoReviewRosterKey);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as string[];
    } catch {
      // fall through to seed
    }
  }
  writeDemoRoster(DEMO_DEFAULT_ROSTER);
  return DEMO_DEFAULT_ROSTER.slice();
}

function writeDemoRoster(usernames: string[]) {
  window.localStorage.setItem(demoReviewRosterKey, JSON.stringify(usernames));
}

function readDemoVerdicts(): DemoVerdict[] {
  const raw = window.localStorage.getItem(demoReviewVerdictsKey);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DemoVerdict[]) : [];
  } catch {
    return [];
  }
}

function writeDemoVerdicts(verdicts: DemoVerdict[]) {
  window.localStorage.setItem(demoReviewVerdictsKey, JSON.stringify(verdicts));
}

// Record one verdict, idempotent on (username, reviewer_name): a re-submit by the
// same reviewer for the same student overwrites the prior verdict (matching the
// backend's idempotent upsert), so re-watching never creates duplicate records.
function demoRecordVerdict(username: string, reviewerName: string, verdict: ReviewVerdict) {
  const verdicts = readDemoVerdicts();
  const existing = verdicts.find(
    (v) => v.username.toLowerCase() === username.toLowerCase() && v.reviewer_name.toLowerCase() === reviewerName.toLowerCase()
  );
  if (existing) {
    existing.verdict = verdict;
    existing.created_at = new Date().toISOString();
  } else {
    verdicts.push({ username, reviewer_name: reviewerName, verdict, created_at: new Date().toISOString() });
  }
  writeDemoVerdicts(verdicts);
}

// Per-username review tallies over ALL reviewers, used for the coverage buckets
// and the serving priority.
function demoReviewTallies(): Map<string, { count: number; positive: number }> {
  const tallies = new Map<string, { count: number; positive: number }>();
  for (const username of readDemoRoster()) {
    tallies.set(username.toLowerCase(), { count: 0, positive: 0 });
  }
  for (const v of readDemoVerdicts()) {
    const key = v.username.toLowerCase();
    const entry = tallies.get(key) ?? { count: 0, positive: 0 };
    entry.count += 1;
    if (v.verdict === 1) entry.positive += 1;
    tallies.set(key, entry);
  }
  return tallies;
}

function demoReviewRosterSummary(): ReviewRosterSummary {
  const roster = readDemoRoster();
  const tallies = demoReviewTallies();
  let with0 = 0;
  let with1 = 0;
  let with2plus = 0;
  for (const username of roster) {
    const count = tallies.get(username.toLowerCase())?.count ?? 0;
    if (count === 0) with0 += 1;
    else if (count === 1) with1 += 1;
    else with2plus += 1;
  }
  // Demo has no real server-side claim lease; report the distinct reviewers who
  // have acted as a stand-in for "active reviewers" so the number is non-zero.
  const reviewers = new Set(readDemoVerdicts().map((v) => v.reviewer_name.toLowerCase()));
  return {
    usernames: roster,
    total: roster.length,
    with_0_reviews: with0,
    with_1_review: with1,
    with_2plus_reviews: with2plus,
    active_claims: reviewers.size
  };
}

// SERVING PRIORITY (mirrors the backend contract): never serve a username this
// reviewer already reviewed, then pick from the highest-priority non-empty
// bucket. Bucket 0: students with 0 reviews. Bucket 1: 1-review POSITIVE.
// Bucket 2: 1-review NEGATIVE. Bucket 3: 2+ reviews, by positive-score desc.
function demoReviewNext(reviewerName: string): ReviewNextResponse {
  const roster = readDemoRoster();
  const verdicts = readDemoVerdicts();
  const reviewedByMe = new Set(
    verdicts.filter((v) => v.reviewer_name.toLowerCase() === reviewerName.toLowerCase()).map((v) => v.username.toLowerCase())
  );
  const tallies = demoReviewTallies();

  const eligible = roster.filter((u) => !reviewedByMe.has(u.toLowerCase()));
  if (!eligible.length) return { done: true };

  const tally = (u: string) => tallies.get(u.toLowerCase()) ?? { count: 0, positive: 0 };

  const bucket0 = eligible.filter((u) => tally(u).count === 0);
  if (bucket0.length) return { username: bucket0[0] };

  const bucket1pos = eligible.filter((u) => tally(u).count === 1 && tally(u).positive === 1);
  if (bucket1pos.length) return { username: bucket1pos[0] };

  const bucket2neg = eligible.filter((u) => tally(u).count === 1 && tally(u).positive === 0);
  if (bucket2neg.length) return { username: bucket2neg[0] };

  const bucket3 = eligible
    .filter((u) => tally(u).count >= 2)
    .sort((a, b) => tally(b).positive - tally(a).positive);
  if (bucket3.length) return { username: bucket3[0] };

  // Any remaining eligible (shouldn't happen given the buckets above cover all).
  return { username: eligible[0] };
}

function demoReviewMine(reviewerName: string): ReviewMineResponse {
  const reviews = readDemoVerdicts()
    .filter((v) => v.reviewer_name.toLowerCase() === reviewerName.toLowerCase())
    .map((v) => ({ username: v.username, verdict: v.verdict, created_at: v.created_at }))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  return { count: reviews.length, reviews };
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

// ---- S2 roster (compulsory roster login) ------------------------------------
// Spec: docs/superpowers/specs/2026-06-09-s2-roster-login-design.md

function demoApiError(status: number, code: string): ApiError {
  const error = new Error(code) as ApiError;
  error.status = status;
  error.code = code;
  return error;
}

function getDemoRoster(): RosterUploadRequest | null {
  const raw = window.localStorage.getItem(demoRosterKey);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RosterUploadRequest;
  } catch {
    return null;
  }
}

// Mirrors the backend normalizeUniqueId: trim + lowercase + strip ALL whitespace.
function normalizeUniqueId(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

// Mirrors the backend maskEmail ("asha@x.com" -> "as**@x.com").
function maskEmail(value: string) {
  if (!value) return "";
  const at = value.indexOf("@");
  if (at <= 0) return `${value.slice(0, 2)}***`;
  const local = value.slice(0, at);
  const keep = Math.min(2, local.length);
  return `${local.slice(0, keep)}${"*".repeat(Math.max(1, local.length - keep))}${value.slice(at)}`;
}

function demoRosterEntryFor(uniqueId: string): { roster: RosterUploadRequest; row: Record<string, string> } | null {
  const roster = getDemoRoster();
  if (!roster) return null;
  const norm = normalizeUniqueId(uniqueId);
  const row = roster.rows.find((r) => normalizeUniqueId(r[roster.unique_id_column] ?? "") === norm);
  return row ? { roster, row } : null;
}

// GET /api/exam-config — public student-page config. FAIL-OPEN on any error:
// the roster gate is re-enforced server-side at /api/session/start, so a config
// fetch failure can never bypass it — it only degrades the form UI.
export async function fetchExamConfig(): Promise<ExamConfig> {
  if (demoMode) {
    await wait(80);
    const roster = getDemoRoster();
    return {
      roster_required: Boolean(roster),
      unique_id_label: roster?.unique_id_column ?? "",
      rooms: getDemoSettings()?.rooms ?? []
    };
  }
  try {
    return await request<ExamConfig>("/api/exam-config", { method: "GET" });
  } catch {
    return { roster_required: false, unique_id_label: "", rooms: [] };
  }
}

// POST /api/roster/lookup — unique-ID-confirm login, step 1. Throws ApiError
// (status 404, code not_on_roster/roster_not_configured) when unmatched.
export async function rosterLookup(uniqueId: string): Promise<RosterLookupResult> {
  if (demoMode) {
    await wait(200);
    const hit = demoRosterEntryFor(uniqueId);
    if (!hit) throw demoApiError(404, "not_on_roster");
    const { roster, row } = hit;
    const mapped = (field: keyof RosterColumnMapping) => {
      const column = roster.column_mapping[field];
      return column ? (row[column] ?? "").trim() : "";
    };
    return {
      found: true,
      unique_id: (row[roster.unique_id_column] ?? "").trim(),
      name: mapped("name"),
      roll_number: mapped("roll_number"),
      room: mapped("room"),
      hackerrank_username: mapped("hackerrank_username"),
      email_masked: maskEmail(mapped("email"))
    };
  }
  return request<RosterLookupResult>("/api/roster/lookup", {
    method: "POST",
    body: JSON.stringify({ unique_id: uniqueId })
  });
}

// GET /api/admin/roster — roster meta (never the rows). `null` on 404 so the
// Settings UI can show "not deployed yet" (same degrade as review-roster).
export async function fetchRosterStatus(password: string): Promise<RosterStatus | null> {
  if (demoMode) {
    await wait(100);
    assertDemoAdmin(password);
    const roster = getDemoRoster();
    return roster
      ? {
          configured: true,
          count: roster.rows.length,
          unique_id_column: roster.unique_id_column,
          column_mapping: roster.column_mapping,
          columns: roster.columns,
          updated_at: new Date().toISOString()
        }
      : { configured: false };
  }
  try {
    return await request<RosterStatus>("/api/admin/roster", {
      method: "GET",
      headers: { "x-admin-password": password }
    });
  } catch (cause) {
    if ((cause as ApiError)?.status === 404) return null;
    throw cause;
  }
}

// POST /api/admin/roster — upload (replace) the roster. `null` on 404.
export async function uploadRoster(password: string, payload: RosterUploadRequest): Promise<RosterUploadResponse | null> {
  if (demoMode) {
    await wait(200);
    assertDemoAdmin(password);
    // Mirror the backend skip rules so the demo reports realistic counts.
    const seen = new Set<string>();
    const rows: Array<Record<string, string>> = [];
    const skipped: Array<{ row: number; reason: string }> = [];
    payload.rows.forEach((row, index) => {
      const uniqueId = (row[payload.unique_id_column] ?? "").trim();
      if (!uniqueId) {
        skipped.push({ row: index, reason: "empty_unique_id" });
        return;
      }
      const norm = normalizeUniqueId(uniqueId);
      if (seen.has(norm)) {
        skipped.push({ row: index, reason: "duplicate_unique_id" });
        return;
      }
      seen.add(norm);
      rows.push(row);
    });
    window.localStorage.setItem(demoRosterKey, JSON.stringify({ ...payload, rows }));
    return { ok: true, configured: true, count: rows.length, skipped };
  }
  try {
    return await request<RosterUploadResponse>("/api/admin/roster", {
      method: "POST",
      headers: { "x-admin-password": password },
      body: JSON.stringify(payload)
    });
  } catch (cause) {
    if ((cause as ApiError)?.status === 404) return null;
    throw cause;
  }
}

// POST /api/admin/roster {clear:true} — roster off (login reverts to legacy).
export async function clearRoster(password: string): Promise<{ ok: boolean } | null> {
  if (demoMode) {
    await wait(100);
    assertDemoAdmin(password);
    window.localStorage.removeItem(demoRosterKey);
    return { ok: true };
  }
  try {
    return await request<{ ok: boolean }>("/api/admin/roster", {
      method: "POST",
      headers: { "x-admin-password": password },
      body: JSON.stringify({ clear: true })
    });
  } catch (cause) {
    if ((cause as ApiError)?.status === 404) return null;
    throw cause;
  }
}

// ---- Coding workspace: editor-event capture + code execution ---------------

export async function sendEditorEvents(sessionId: string, problemId: string, events: EditorEvent[]): Promise<void> {
  if (demoMode) return;                       // demo: don't post
  await request<{ ok: boolean }>("/api/editor-events", {
    method: "POST",
    body: JSON.stringify({ session_id: sessionId, problem_id: problemId, events })
  });
}

export async function execRun(req: ExecRequest): Promise<RunResult> {
  if (demoMode) {
    await wait(300);
    // The sum-two problem has TWO samples; return both so the demo matches the
    // real /api/exec/run shape (Task 3 asserts results.length === 2).
    return { results: [
      { input: "2 3\n", expected: "5", passed: true, status: "accepted", stdout: "5", stderr: "", compileOutput: "" },
      { input: "10 20\n", expected: "30", passed: true, status: "accepted", stdout: "30", stderr: "", compileOutput: "" }
    ] };
  }
  return request<RunResult>("/api/exec/run", { method: "POST", body: JSON.stringify(req) });
}

export async function execSubmit(req: ExecRequest): Promise<SubmitResult> {
  if (demoMode) {
    await wait(500);
    // §9 lock: mirror the real /api/exec/submit shape — verdict + counts +
    // score, never per-test hidden detail.
    return { verdict: "accepted", passed_count: 4, total: 4, score: 100, max_points: 100, submission_id: "demo" };
  }
  return request<SubmitResult>("/api/exec/submit", { method: "POST", body: JSON.stringify(req) });
}

// ---- S3: invigilator portal + room start gate -------------------------------

export const invigilatorPassword = import.meta.env.VITE_INVIGILATOR_PASSWORD ?? "";
// When set, the portal unlock compares sha256(typed) to this hash so the plain
// password never ships in the bundle (mirrors VITE_ADMIN_PASSWORD_HASH).
export const invigilatorPasswordHash = (import.meta.env.VITE_INVIGILATOR_PASSWORD_HASH ?? "").trim().toLowerCase();
const demoRoomGatesKey = "aerele-proctor-demo-room-gates";

function assertDemoInvigilator(password: string) {
  if (invigilatorPassword && password === invigilatorPassword) return;
  if (adminPassword && password === adminPassword) return;
  throw new Error("Invalid invigilator password.");
}

function invigilatorHeaders(password: string) {
  return { "x-invigilator-password": password };
}

type DemoRoomGateStore = Record<string, RoomGate>;

function readDemoRoomGates(): DemoRoomGateStore {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(demoRoomGatesKey) || "{}");
    return parsed && typeof parsed === "object" ? (parsed as DemoRoomGateStore) : {};
  } catch {
    return {};
  }
}

function writeDemoRoomGates(store: DemoRoomGateStore) {
  window.localStorage.setItem(demoRoomGatesKey, JSON.stringify(store));
}

export async function fetchInvigilatorOverview(password: string): Promise<InvigilatorOverviewResponse> {
  if (demoMode) {
    await wait(120);
    assertDemoInvigilator(password);
    const rooms = [
      ...new Set(DEMO_ALL_SESSIONS.map((s) => String(s.room || "").trim()).filter(Boolean))
    ].sort((a, b) => a.localeCompare(b));
    return {
      contest_slug: DEMO_CONTEST_SLUG,
      room_gate_enabled: getDemoSettings()?.room_gate_enabled === true,
      rooms,
      has_unassigned: false
    };
  }
  return request<InvigilatorOverviewResponse>("/api/invigilator/overview", {
    method: "GET",
    headers: invigilatorHeaders(password)
  });
}

export async function fetchInvigilatorRoom(password: string, room: string): Promise<InvigilatorRoomResponse> {
  if (demoMode) {
    await wait(120);
    assertDemoInvigilator(password);
    const roomKey = roomKeyForLabel(room);
    const roomLabel = roomKey === "_" ? "" : room;
    const docs = DEMO_ALL_SESSIONS.filter((s) => String(s.room || "") === roomLabel);
    const gate = readDemoRoomGates()[roomKey] || null;
    const stats = { live: 0, locked: 0, pending_approval: 0, finished: 0, disconnected: 0, started: 0, total: 0 };
    for (const s of docs) {
      stats.total += 1;
      if (gate?.mode === "open") stats.started += 1; // demo approximation
      if (s.status === "active") {
        stats.live += 1;
        if (s.stale === true) stats.disconnected += 1;
      } else if (s.status === "locked") stats.locked += 1;
      else if (s.status === "pending_approval") stats.pending_approval += 1;
      else if (s.status === "ended") stats.finished += 1;
    }
    const sessions: InvigilatorSessionRow[] = docs
      .slice()
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")))
      .map((s) => ({
        session_id: s.session_id,
        name: s.name,
        hackerrank_username: s.hackerrank_username,
        roll_number: "",
        status: s.status,
        stale: s.status === "active" && s.stale === true,
        exam_started_at: gate?.mode === "open" ? gate.opened_at : null,
        created_at: s.created_at
      }));
    const alerts: InvigilatorAlert[] = readDemoAlerts()
      .filter((a) => String(a.room || "") === roomLabel && !a.archived)
      .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
      .slice(0, 100)
      .map((a) => ({
        id: a.id, type: a.type, severity: a.severity, timestamp: a.timestamp,
        title: a.title, detail: String(a.detail || ""),
        hackerrank_username: a.hackerrank_username, session_id: String(a.session_id || "")
      }));
    return {
      contest_slug: DEMO_CONTEST_SLUG,
      room: roomLabel || null,
      room_key: roomKey,
      room_gate_enabled: getDemoSettings()?.room_gate_enabled === true,
      stats, sessions, gate, alerts,
      disconnected_staleness_ms: 45000
    };
  }
  return request<InvigilatorRoomResponse>(`/api/invigilator/room?room=${encodeURIComponent(room)}`, {
    method: "GET",
    headers: invigilatorHeaders(password)
  });
}

export async function releaseRoomCode(
  password: string, room: string, invigilatorName: string, regenerate = false
): Promise<RoomGateActionResponse> {
  if (demoMode) {
    await wait(150);
    assertDemoInvigilator(password);
    if (getDemoSettings()?.room_gate_enabled !== true) throw new Error("room_gate_disabled");
    const store = readDemoRoomGates();
    const roomKey = roomKeyForLabel(room);
    const existing = store[roomKey];
    if (existing && existing.mode === "otp" && existing.otp && !regenerate) {
      return { ok: true, contest_slug: DEMO_CONTEST_SLUG, gate: existing };
    }
    const now = new Date().toISOString();
    const gate: RoomGate = {
      room: roomKey === "_" ? "" : room,
      room_key: roomKey,
      mode: "otp",
      otp: String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0"),
      released_at: now,
      released_by: invigilatorName,
      opened_at: existing?.opened_at ?? null,
      opened_by: existing?.opened_by ?? "",
      updated_at: now
    };
    store[roomKey] = gate;
    writeDemoRoomGates(store);
    return { ok: true, contest_slug: DEMO_CONTEST_SLUG, gate };
  }
  return request<RoomGateActionResponse>("/api/invigilator/release-code", {
    method: "POST",
    headers: invigilatorHeaders(password),
    body: JSON.stringify({ room, invigilator_name: invigilatorName, ...(regenerate ? { regenerate: true } : {}) })
  });
}

export async function openRoom(password: string, room: string, invigilatorName: string): Promise<RoomGateActionResponse> {
  if (demoMode) {
    await wait(150);
    assertDemoInvigilator(password);
    if (getDemoSettings()?.room_gate_enabled !== true) throw new Error("room_gate_disabled");
    const store = readDemoRoomGates();
    const roomKey = roomKeyForLabel(room);
    const existing = store[roomKey];
    const now = new Date().toISOString();
    const gate: RoomGate = {
      room: roomKey === "_" ? "" : room,
      room_key: roomKey,
      mode: "open",
      otp: existing?.otp ?? "",
      released_at: existing?.released_at ?? null,
      released_by: existing?.released_by ?? "",
      opened_at: now,
      opened_by: invigilatorName,
      updated_at: now
    };
    store[roomKey] = gate;
    writeDemoRoomGates(store);
    return { ok: true, contest_slug: DEMO_CONTEST_SLUG, gate };
  }
  return request<RoomGateActionResponse>("/api/invigilator/open-room", {
    method: "POST",
    headers: invigilatorHeaders(password),
    body: JSON.stringify({ room, invigilator_name: invigilatorName })
  });
}

// Candidate-side gate poll/unlock. No code = status poll; with a code it
// attempts the room OTP. Demo mode mirrors the backend against localStorage.
export async function pollRoomGate(sessionId: string, code?: string): Promise<RoomGatePollResponse> {
  if (demoMode) {
    await wait(100);
    const settings = getDemoSettings();
    if (settings?.room_gate_enabled !== true) return { gate_enabled: false, exam_started: true };
    const session = readDemoSessions().find((item) => item.session_id === sessionId);
    if (!session) throw new Error("Session not found");
    if (session.exam_started_at) {
      return { gate_enabled: true, exam_started: true, exam_started_at: session.exam_started_at };
    }
    const gate = readDemoRoomGates()[roomKeyForLabel(session.room)];
    const now = new Date().toISOString();
    if (gate?.mode === "open") {
      upsertDemoSession({ ...session, exam_started_at: now });
      return { gate_enabled: true, exam_started: true, exam_started_at: now };
    }
    if (code !== undefined && code !== "") {
      if (gate?.mode === "otp" && gate.otp === String(code).trim()) {
        upsertDemoSession({ ...session, exam_started_at: now });
        return { gate_enabled: true, exam_started: true, exam_started_at: now };
      }
      const error = new Error("invalid_code") as ApiError;
      error.status = 403;
      error.code = "invalid_code";
      throw error;
    }
    return { gate_enabled: true, exam_started: false, room: session.room };
  }
  return request<RoomGatePollResponse>("/api/session/room-gate", {
    method: "POST",
    body: JSON.stringify({ session_id: sessionId, ...(code ? { code } : {}) })
  });
}

// ---- S4: problem bank (admin authoring) -------------------------------------

const demoProblemsKey = "aerele-proctor-demo-problems";

// Demo mirror of the backend's built-in seed (problems.mjs SEED_PROBLEMS).
const DEMO_SEED_PROBLEMS: ProblemDoc[] = [{
  id: "sum-two",
  title: "Sum of Two Numbers",
  statement: "Read two integers a and b on one line separated by a space. Print a + b.",
  languages: ["python", "cpp", "java", "javascript"],
  cpuTimeLimit: 5, memoryLimit: 128000, points: 100,
  scoring: "per_test", status: "published",
  sampleTests: [{ input: "2 3\n", expected: "5" }, { input: "10 20\n", expected: "30" }],
  hiddenTests: [
    { input: "0 0\n", expected: "0" }, { input: "-5 5\n", expected: "0" },
    { input: "1000000 1\n", expected: "1000001" }, { input: "-100 -200\n", expected: "-300" }
  ]
}];

function readDemoProblems(): ProblemDoc[] {
  try {
    const raw = window.localStorage.getItem(demoProblemsKey);
    return raw ? (JSON.parse(raw) as ProblemDoc[]) : [];
  } catch {
    return [];
  }
}

function writeDemoProblems(problems: ProblemDoc[]): void {
  window.localStorage.setItem(demoProblemsKey, JSON.stringify(problems));
}

// Demo id resolution: an authored demo problem wins; the seed answers only when
// no demo doc exists (mirrors the backend bank-shadows-seed rule).
function findDemoProblem(id: string): ProblemDoc | null {
  return readDemoProblems().find((p) => p.id === id)
    ?? DEMO_SEED_PROBLEMS.find((p) => p.id === id)
    ?? null;
}

// Candidate view of the demo active problem — published only, never hiddenTests.
function demoActiveProblem(): PublicProblem | null {
  const problemId = getDemoSettings()?.problem_id || "";
  if (!problemId) return null;
  const p = findDemoProblem(problemId);
  if (!p || p.status !== "published") return null;
  return {
    id: p.id, title: p.title, statement: p.statement, languages: p.languages,
    points: p.points, cpuTimeLimit: p.cpuTimeLimit, memoryLimit: p.memoryLimit,
    sampleTests: p.sampleTests
  };
}

export async function fetchProblems(password: string): Promise<ProblemSummary[]> {
  if (demoMode) {
    await wait(120);
    assertDemoAdmin(password);
    return readDemoProblems()
      .map((p) => ({
        id: p.id, title: p.title, status: p.status, points: p.points, scoring: p.scoring,
        languages: p.languages, sample_count: p.sampleTests.length, hidden_count: p.hiddenTests.length,
        updated_at: p.updated_at || ""
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  const response = await request<{ problems: ProblemSummary[] }>("/api/admin/problems", {
    method: "GET",
    headers: { "x-admin-password": password }
  });
  return response.problems;
}

export async function fetchProblemDetail(password: string, id: string): Promise<ProblemDoc> {
  if (demoMode) {
    await wait(120);
    assertDemoAdmin(password);
    const found = readDemoProblems().find((p) => p.id === id);
    if (!found) throw new Error("Problem not found");
    return found;
  }
  const response = await request<{ problem: ProblemDoc }>(`/api/admin/problem?id=${encodeURIComponent(id)}`, {
    method: "GET",
    headers: { "x-admin-password": password }
  });
  return response.problem;
}

export async function saveProblem(password: string, problem: ProblemDoc): Promise<ProblemDoc> {
  if (demoMode) {
    await wait(150);
    assertDemoAdmin(password);
    const now = new Date().toISOString();
    const all = readDemoProblems();
    const existing = all.find((p) => p.id === problem.id);
    const item: ProblemDoc = { ...problem, created_at: existing?.created_at || now, updated_at: now };
    writeDemoProblems([...all.filter((p) => p.id !== problem.id), item]);
    return item;
  }
  const response = await request<{ ok: boolean; problem: ProblemDoc }>("/api/admin/problems", {
    method: "POST",
    headers: { "x-admin-password": password },
    body: JSON.stringify(problem)
  });
  return response.problem;
}

export async function deleteProblem(password: string, id: string): Promise<void> {
  if (demoMode) {
    await wait(120);
    assertDemoAdmin(password);
    writeDemoProblems(readDemoProblems().filter((p) => p.id !== id));
    const settings = getDemoSettings();
    if (settings && settings.problem_id === id) {
      window.localStorage.setItem(demoSettingsKey, JSON.stringify({ ...settings, problem_id: "" }));
    }
    return;
  }
  await request<{ ok: boolean }>("/api/admin/problem-delete", {
    method: "POST",
    headers: { "x-admin-password": password },
    body: JSON.stringify({ id })
  });
}
