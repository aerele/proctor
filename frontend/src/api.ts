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
  CaptureState,
  EditorEvent,
  EnforcementConfigPayload,
  EnforcementExemptions,
  EnforcementViolationResponse,
  ContestCreateRequest,
  ContestExamConfig,
  ContestStatus,
  ContestSummary,
  ContestUpdateRequest,
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
  SessionCardDetail,
  SessionCardDetailResponse,
  SessionDetail,
  SessionDetailsResponse,
  SessionEventItem,
  SessionEventsResponse,
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
import type { ContestResultsResponse, ResultRow, SelectionStatus } from "./results/computeResults";
import { summarizeSubmissions, type StoredSubmission } from "./coding/problemSwitch";
import { emptyPersonRosterState, evaluatePersonRosterUpload, identityNorm, type PersonRosterState } from "./roster/personRoster";
import { normalizeCameraRecording } from "./cameraRecording";
import { sessionStartPayload } from "./identity";
import { resolveSavedEndAt } from "./examTime";
import { roomKeyForLabel } from "./invigilator/gateLogic";
import { groupIpEntries, summarizeIpEntries, type IpRow } from "./ipReport";

export const apiBaseUrl = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "") ?? "";
const demoMode = import.meta.env.VITE_DEMO_MODE === "true";
export const isDemoMode = demoMode;
const demoSettingsKey = "aerele-proctor-demo-settings";
const demoSessionsKey = "aerele-proctor-demo-sessions";
// v3: F6.7 retimed the demo alerts INTO their candidates' demo recording
// windows and added Vikram_T alerts (incl. one inside a recording gap) so the
// recordings activity overlay + log render meaningfully in demo mode.
// v2: F6.4 reseeded the demo alerts so their session_ids/usernames join to the
// DEMO_ALL_SESSIONS admin population (contextual action buttons need real
// statuses behind every alert) — the key bump discards stale v1 stores.
const demoAlertsKey = "aerele-proctor-demo-alerts-v3";
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
    e.body = parseErrorBody(errorText);
    throw e;
  }

  return response.json() as Promise<T>;
}

// An Error carrying the HTTP status, the backend's machine-readable error
// code (e.g. "session_locked"), and the FULL parsed error body — S-C reject
// payloads (duplicate_unique_ids rows, college_required rows, college_choices)
// ride the same JSON error shape and panels render them from `body`.
export type ApiError = Error & { status?: number; code?: string; body?: Record<string, unknown> };

function parseErrorBody(errorText: string): Record<string, unknown> | undefined {
  if (!errorText) return undefined;
  try {
    const parsed = JSON.parse(errorText) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

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
  // F5.3/F5.5: enforcement lock reason + per-session exemptions (demo parity
  // for the violation→lock→code-unlock flow and the exemption toggles).
  locked_reason?: string | null;
  enforcement_exemptions?: EnforcementExemptions;
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

// F5.3 demo parity: the same NaN-guarded normalization the backend's
// enforcementConfig applies (defaults 20 / 2 / "block").
function enforcementIntOr(raw: unknown, fallback: number, minimum: number): number {
  const num = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(num) && Number.isInteger(num) && num >= minimum ? num : fallback;
}

function normalizeEnforcementSettings(settings: Partial<ProctorSettings> | null | undefined) {
  return {
    fullscreen_reentry_seconds: enforcementIntOr(settings?.fullscreen_reentry_seconds, 20, 1),
    fullscreen_exit_limit: enforcementIntOr(settings?.fullscreen_exit_limit, 2, 0),
    enforcement_mode: (settings?.enforcement_mode === "alert_first" ? "alert_first" : "block") as "block" | "alert_first"
  };
}

function demoEnforcement(): EnforcementConfigPayload {
  const normalized = normalizeEnforcementSettings(getDemoSettings());
  return {
    fullscreen_reentry_seconds: normalized.fullscreen_reentry_seconds,
    fullscreen_exit_limit: normalized.fullscreen_exit_limit,
    mode: normalized.enforcement_mode
  };
}

// F10.1 demo parity: the camera-recording knobs from the demo settings store,
// normalized with the exact backend rules (default ENABLED / 10 fps / 640 w;
// invalid values fall back, never 0).
function demoCameraRecording() {
  return normalizeCameraRecording(getDemoSettings()?.camera_recording);
}

function demoSessionResponse(session: DemoSession, contestUrl: string, contest?: ContestSummary | null): SessionStartResponse {
  // S-I §3.4 parity: ordered problems[] (contest-owned for person contests,
  // legacy settings problem_id otherwise), the one-release `problem` alias
  // (= problems[0] minus `order`), the per-problem submissions summary and
  // the submit budget.
  const problems = demoContestProblems(contest ?? null);
  let problemAlias: PublicProblem | null = null;
  if (problems.length) {
    const { order: _order, ...alias } = problems[0];
    problemAlias = alias;
  }
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
    // S-D: person-contest sessions read the gate flag from the CONTEST doc
    // (backend startResponse parity: the contest owns its snapshot fields).
    room_gate_enabled: contest && !contest.legacy
      ? contest.room_gate_enabled === true
      : getDemoSettings()?.room_gate_enabled === true,
    // F5.3/F5.5: enforcement knobs + exemptions + lock reason (backend parity).
    enforcement: demoEnforcement(),
    enforcement_exemptions: session.enforcement_exemptions ?? {},
    locked_reason: session.locked_reason ?? null,
    // S4: server-driven problem assigned to the session (null when unassigned).
    // S-I: alias = problems[0]; `problems` is the real ordered payload.
    problem: problemAlias,
    problems,
    submissions_summary: demoSubmissionsSummaryFor(session.session_id),
    submit_budget: DEMO_SUBMIT_BUDGET,
    upload_config: {
      chunk_seconds: 20,
      video_bits_per_second: 750_000,
      media_bits_per_second: 180_000,
      audio_bits_per_second: 32_000,
      max_width: 1280,
      max_frame_rate: 5,
      // F10.1: the recorder reads the camera knobs from upload_config
      // (backend startResponse parity).
      camera: demoCameraRecording()
    },
    heartbeat_interval_seconds: 15,
    // S5: demo sessions read the exam end time from the demo settings store.
    // S-D: person-contest sessions read the exam end time from the CONTEST doc.
    end_at: (contest && !contest.legacy ? contest.end_at : getDemoSettings()?.end_at) || "",
    server_now: new Date().toISOString()
  };
}

// S-D demo parity for the PINNED person-contest start (backend
// startPersonSession): contest window gates the start, the contest roster
// resolves identity server-side (403 roster_id_required / not_on_roster,
// 409 college_choices on genuine ambiguity, body.college picks), mapped
// roster fields override typed ones, username_norm = "{college}~{id}".
function demoPersonStart(
  form: StudentForm,
  contest: ContestSummary,
  college: string | undefined,
  existingSessionId?: string
): SessionStartResponse {
  if (contest.status !== "open") throw demoApiError(403, "contest_not_open");
  if (!contest.start_at || !contest.end_at) {
    throw demoApiError(403, "Proctoring is not configured yet. Ask the administrator to set the schedule.");
  }
  const now = Date.now();
  if (now < Date.parse(contest.start_at)) throw demoApiError(403, "Proctoring has not started yet.");
  if (now > Date.parse(contest.end_at)) throw demoApiError(403, "Proctoring has ended.");

  const roster = getDemoPersonRoster(contest.slug);
  let identity: {
    username_norm: string;
    candidate_id: string;
    roster_unique_id: string;
    name: string;
  };
  if (roster) {
    const typed = (form.roster_unique_id || form.candidate_id).trim();
    if (!typed) throw demoApiError(403, "roster_id_required");
    const columns = roster.columns ?? [];
    const mapping = roster.column_mapping ?? {};
    const collegeColumn =
      (roster.college_column && columns.includes(roster.college_column) && roster.college_column) ||
      (mapping.college && columns.includes(mapping.college) && mapping.college) ||
      columns.find((column) => column.toLowerCase() === "college") || "";
    const matches = roster.rows.filter(
      (row) => identityNorm(row[roster.unique_id_column] ?? "") === identityNorm(typed)
    );
    if (!matches.length) throw demoApiError(403, "not_on_roster");
    // Group by college_norm — 2+ colleges is GENUINE ambiguity (vision §2.4).
    const byCollege = new Map<string, Record<string, string>>();
    for (const row of matches) {
      const norm = identityNorm((row[collegeColumn] ?? "").trim());
      if (!byCollege.has(norm)) byCollege.set(norm, row);
    }
    let chosenNorm = [...byCollege.keys()][0];
    if (byCollege.size > 1) {
      const picked = (college ?? "").trim().toLowerCase();
      if (!picked || !byCollege.has(picked)) {
        const known = getDemoPersonState().colleges;
        throw demoApiError(409, "college_choices", {
          college_choices: [...byCollege.keys()].map((norm) => ({
            college_norm: norm,
            name: known[norm] || (byCollege.get(norm)![collegeColumn] ?? norm),
            college: byCollege.get(norm)![collegeColumn] ?? ""
          }))
        });
      }
      chosenNorm = picked;
    }
    const row = byCollege.get(chosenNorm)!;
    const displayId = (row[roster.unique_id_column] ?? "").trim();
    // A MAPPED field is authoritative even when blank (backend rule).
    const mappedOrTyped = (field: "name") =>
      mapping[field] ? (row[mapping[field]!] ?? "").trim() : form[field].trim();
    identity = {
      username_norm: `${chosenNorm}~${identityNorm(typed)}`,
      candidate_id: displayId,
      roster_unique_id: displayId,
      name: mappedOrTyped("name")
    };
  } else {
    // No-roster person contest (vision §2.4): typed id + name + email.
    const typed = form.candidate_id.trim();
    if (!form.name.trim() || !form.email.trim()) throw demoApiError(400, "name and email are required");
    if (!typed) throw demoApiError(400, "candidate_id is required");
    identity = {
      username_norm: identityNorm(typed),
      candidate_id: typed,
      roster_unique_id: "",
      name: form.name.trim()
    };
  }

  // Replay + single-live-session reconciliation — same mechanics as the
  // legacy demo branch, keyed on (username_norm, contest slug).
  if (existingSessionId) {
    const replay = readDemoSessions().find((item) => item.session_id === existingSessionId);
    if (replay && replay.username_norm === identity.username_norm && replay.contest_slug === contest.slug) {
      return demoSessionResponse(replay, "", contest);
    }
  }
  const existingLive = readDemoSessions().find(
    (item) => item.username_norm === identity.username_norm && item.contest_slug === contest.slug && item.status !== "ended"
  );
  const sessionId = crypto.randomUUID();
  const session: DemoSession = {
    session_id: sessionId,
    status: existingLive ? "pending_approval" : "active",
    hackerrank_username: identity.candidate_id,
    username_norm: identity.username_norm,
    name: identity.name,
    roster_unique_id: identity.roster_unique_id,
    room: form.room.trim(),
    contest_slug: contest.slug,
    storage_prefix: demoStoragePrefix(contest.slug, identity.username_norm, sessionId),
    blocked_by_session_id: existingLive ? existingLive.session_id : null,
    start_ip: "demo.local"
  };
  upsertDemoSession(session);
  return demoSessionResponse(session, "", contest);
}

export async function startSession(
  form: StudentForm,
  existingSessionId?: string,
  opts?: { contest?: string; college?: string }
): Promise<SessionStartResponse> {
  if (demoMode) {
    await wait(250);
    // S-D: a pinned NON-legacy contest takes the person-layer start; the
    // pinned legacy contest (or no pin) keeps the legacy branch bit-for-bit
    // (backend resolvePersonContestForStart parity).
    if (opts?.contest) {
      const pinned = demoContestsList().find((contest) => contest.slug === opts.contest);
      if (!pinned) throw demoApiError(400, "unknown_contest");
      if (!pinned.legacy) return demoPersonStart(form, pinned, opts.college, existingSessionId);
    }
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
    const effectiveUsername = rosterUsername || form.candidate_id.trim();
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

  // S-A: dual-field body — candidate_id AND the frozen hackerrank_username
  // carry the same value (identity.ts) so the current backend is unchanged.
  // S-D: a pinned contest rides as `contest` (routes person contests down the
  // person-layer start) and a college pick resolves a 409 college_choices.
  return request<SessionStartResponse>("/api/session/start", {
    method: "POST",
    body: JSON.stringify({
      ...sessionStartPayload(form, existingSessionId),
      ...(opts?.contest ? { contest: opts.contest } : {}),
      ...(opts?.college ? { college: opts.college } : {})
    })
  });
}

export async function resumeSession(
  sessionId: string,
  candidateId?: string,
  opts?: { contest?: string }
): Promise<SessionStartResponse> {
  if (demoMode) {
    await wait(150);
    const session = readDemoSessions().find((item) => item.session_id === sessionId);
    if (!session) throw new Error("Session not found");
    if (candidateId && session.username_norm !== normalizeUsername(candidateId)) {
      throw new Error("Session not found");
    }
    // S-D (F9 D8 parity): a contest-pinned resume only returns sessions of
    // THAT contest — a token from another contest is indistinguishable from
    // an unknown one.
    if (opts?.contest && session.contest_slug !== opts.contest) {
      throw demoApiError(404, "session_not_found");
    }
    const pinned = opts?.contest
      ? demoContestsList().find((contest) => contest.slug === opts.contest) ?? null
      : null;
    const contestUrl = pinned && !pinned.legacy ? "" : getDemoSettings()?.contest_url || "";
    return demoSessionResponse(session, contestUrl, pinned);
  }

  // S-A: when an identity value rides resume, send it dual-field (candidate_id
  // + the frozen hackerrank_username) — same contract as session/start.
  // S-D: the pinned contest rides as `contest` (contest-pinned resume, F9 D8).
  return request<SessionStartResponse>("/api/session/resume", {
    method: "POST",
    body: JSON.stringify({
      session_id: sessionId,
      ...(candidateId ? { candidate_id: candidateId, hackerrank_username: candidateId } : {}),
      ...(opts?.contest ? { contest: opts.contest } : {})
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
          // F5.3: GET always reports normalized enforcement values (backend parity).
          ...normalizeEnforcementSettings(settings),
          // F10.1: always normalized on read — a legacy store reports the
          // defaults (enabled / 10 fps / 640 w), exactly like the backend.
          camera_recording: normalizeCameraRecording(settings.camera_recording),
          passcode: "",
          end_code: "",
          passcode_set: Boolean(settings.passcode),
          passcode_preview: maskPasscode(settings.passcode),
          end_code_set: Boolean(settings.end_code),
          end_code_preview: maskPasscode(settings.end_code)
        }
      : { start_at: "", end_at: "", ...normalizeEnforcementSettings(null), camera_recording: normalizeCameraRecording(null), passcode_set: false, end_code_set: false };
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
      // F5.3: persist the enforcement knobs through the same NaN-guarded
      // normalization the backend applies (defaults 20 / 2 / "block"); an
      // absent field preserves the stored value (backend parity).
      ...normalizeEnforcementSettings({
        fullscreen_reentry_seconds: settings.fullscreen_reentry_seconds ?? getDemoSettings()?.fullscreen_reentry_seconds,
        fullscreen_exit_limit: settings.fullscreen_exit_limit ?? getDemoSettings()?.fullscreen_exit_limit,
        enforcement_mode: settings.enforcement_mode ?? getDemoSettings()?.enforcement_mode
      }),
      // F10.1: same preserve-when-absent + normalize rules as the backend.
      camera_recording: normalizeCameraRecording(
        settings.camera_recording !== undefined ? settings.camera_recording : getDemoSettings()?.camera_recording),
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
  /** F5.3 wave-2 fix: corrective fullscreen truth for the server-side
   *  enforcement countdown (true clears a stale open exit; false starts the
   *  clock when the exit event itself was lost). */
  fullscreen: boolean;
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
    // F5.3/F5.5: ditto for enforcement config + per-session exemptions.
    return {
      ok: true,
      status: session?.status ?? "active",
      start_ip: "demo.local",
      current_ip: "demo.local",
      ip_changed: false,
      newly_changed: false,
      end_at: getDemoSettings()?.end_at || "",
      enforcement: demoEnforcement(),
      enforcement_exemptions: session?.enforcement_exemptions ?? {},
      server_now: new Date().toISOString()
    };
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

// S-D (A1): the OPTIONAL contestSlug scopes the review/recordings username
// search like every other admin GET — under person identity the same person_id
// recurs across rounds by design, so an unscoped search would interleave them.
export async function fetchAdminSessions(username: string, password: string, contestSlug?: string): Promise<AdminSessionsResponse> {
  if (demoMode) {
    await wait(120);
    assertDemoAdmin(password);
    const usernameNorm = normalizeUsername(username);
    // Recording playback view: a fake recording dataset takes precedence so the
    // whole search → timeline → player flow is exercisable OFFLINE. Falls back to
    // the demo STUDENT session store (no evidence) for any other username.
    const recording = demoRecordingSessionsFor(usernameNorm)
      .filter((item) => !contestSlug || item.contest_slug === contestSlug);
    if (recording.length) return { sessions: recording };
    const sessions = readDemoSessions()
      .filter((item) => item.username_norm === usernameNorm)
      .filter((item) => !contestSlug || item.contest_slug === contestSlug)
      .map((item) => ({ ...item, evidence: [] as SessionEvidence[] }));
    return { sessions };
  }

  const query = new URLSearchParams();
  query.set("username", username);
  if (contestSlug) query.set("contest_slug", contestSlug);
  return request<AdminSessionsResponse>(`/api/admin/sessions?${query.toString()}`, {
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
      camera_chunk_count: s.camera_chunk_count ?? 0,
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
// gracefully, same as fetchRecordingSessions. The result also carries the
// backend's `truncated` flag (F6 review): true when the capped page may be
// missing LIVE rows, so the alerts-console status join knows to fall back to
// the full action set instead of trusting an incomplete list (older backends
// without the flag read as false — same trust as before). In demo mode it
// classifies the SHARED admin population (DEMO_ALL_SESSIONS) — the SAME source
// fetchAdminStats counts from, NOT the recording seeds — applying the same
// status + contest + room filters and projecting the RecordingSession fields,
// so every drill-down list count equals its stat card and the zero-chunk
// pending_approval sessions appear with Approve exercisable (the demo
// population is small, so truncated is always false).
export type SessionsListResult = { sessions: RecordingSession[]; truncated: boolean };

export async function fetchSessionsList(
  password: string,
  opts: { status?: string; contestSlug?: string; room?: string }
): Promise<SessionsListResult | null> {
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
    const sessions = DEMO_ALL_SESSIONS
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
        camera_chunk_count: session.camera_chunk_count ?? 0,
        created_at: session.created_at,
        status: session.status || ""
      }));
    return { sessions, truncated: false };
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
    return { sessions: response.sessions, truncated: response.truncated === true };
  } catch (cause) {
    // Endpoint not deployed yet → degrade gracefully (same as fetchRecordingSessions).
    if ((cause as ApiError)?.status === 404) return null;
    throw cause;
  }
}

// F6.3 — GET /api/admin/session-detail?session_id= for the Sessions detail
// card: ONE session doc projected to the least-privilege card fields (identity
// incl. roster id, status, IP block, doc activity counters). Returns `null` on
// 404 — endpoint not deployed OR the doc vanished — so the card degrades to
// the list-row fields it already has instead of erroring. The demo branch
// derives the detail from the SHARED admin population (DEMO_ALL_SESSIONS) plus
// the same per-room IP assignment the demo IP report uses, with deterministic
// activity counters scaled off chunk_count (no wall-clock randomness).
export async function fetchSessionCardDetail(password: string, sessionId: string): Promise<SessionCardDetail | null> {
  if (demoMode) {
    await wait(120);
    assertDemoAdmin(password);
    const row = DEMO_ALL_SESSIONS.find((session) => session.session_id === sessionId);
    if (!row) return null;
    const { ip, start_ip, ip_change_count } = demoIpFor(row);
    return {
      session_id: row.session_id,
      hackerrank_username: row.hackerrank_username,
      name: row.name,
      roll_number: demoRosterIdFor(row),
      roster_unique_id: demoRosterIdFor(row),
      room: row.room,
      contest_slug: row.contest_slug,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.created_at,
      blocked_by_session_id: null,
      start_ip,
      current_ip: ip,
      ip_change_count,
      chunk_count: row.chunk_count,
      camera_chunk_count: row.camera_chunk_count ?? 0,
      // Deterministic activity counters: scale off the recording length so a
      // longer demo session also "did more" (heartbeats every 15s ≈ 2/chunk).
      event_count: row.chunk_count * 3 + 4,
      clipboard_event_count: Math.floor(row.chunk_count / 5),
      focus_event_count: Math.floor(row.chunk_count / 3),
      heartbeat_count: row.chunk_count * 2,
      // F6.6: varied per-source capture states (null for pending_approval —
      // those sessions never sent a composite heartbeat).
      capture_state: demoCaptureStateFor(row),
      // F5.3/F5.5: the demo locked row reads as an ENFORCEMENT lock so the
      // admin can see the locked-by-enforcement state; exemption toggles
      // reflect the in-memory row (mutated by the exempt action).
      locked_reason: row.status === "locked" ? "fullscreen_enforcement" : null,
      enforcement_exemptions: { ...row.enforcement_exemptions }
    };
  }

  const query = new URLSearchParams();
  query.set("session_id", sessionId);
  try {
    const response = await request<SessionCardDetailResponse>(
      `/api/admin/session-detail?${query.toString()}`,
      { method: "GET", headers: { "x-admin-password": password } }
    );
    return response.session;
  } catch (cause) {
    // Endpoint not deployed (or the doc vanished) → the card falls back to the
    // list-row fields it already has (graceful, same as fetchSessionsList).
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
  // F10.1: separate camera-stream chunk counter (only Asha's row carries one —
  // the same candidate whose recording seed has camera chunks).
  camera_chunk_count?: number;
  created_at: string;
  // Deterministic "disconnected" marker: true on the one active row that should
  // derive as disconnected, falsy/omitted on every other row. A flag (not
  // wall-clock math) so the demo counts never drift as the page stays open.
  stale?: boolean;
  // F5.5: per-session exemption toggles (mutated in place like status —
  // in-memory only, resets on reload).
  enforcement_exemptions?: EnforcementExemptions;
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
  { session_id: "live-asha-4d01", hackerrank_username: "Asha_R", name: "Asha Ramanathan", room: "Lab A-1", contest_slug: DEMO_CONTEST_SLUG, status: "ended", chunk_count: 18, camera_chunk_count: 18, created_at: demoCreated(120) },
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

// Deterministic demo roster id — ONE derivation shared by the session card and
// the IP report (F8.1) so the same session always shows the same roster id.
function demoRosterIdFor(session: DemoAdminSessionRow): string {
  return `R-${session.session_id.slice(-4).toUpperCase()}`;
}

// F6.6 demo capture states — deterministic per-session overrides (same pattern
// as DEMO_IP_OVERRIDES) so the session card and the recordings header show
// every real-world shape OFFLINE: full capture, denied camera, denied mic,
// missing devices, and a capture that stopped mid-exam. Everything else gets
// the healthy default; a pending_approval session never sent a composite
// heartbeat, so it reports null (exactly like production).
const DEMO_CAPTURE_OVERRIDES: Record<string, CaptureState> = {
  // Live: Rohan never granted the camera; Sneha has no mic on her machine.
  "live-rohan-1a03": { screen: "recording", camera: "permission_denied", microphone: "recording" },
  "live-sneha-1a04": { screen: "recording", camera: "recording", microphone: "unavailable" },
  // The stale/disconnected row: everything stopped mid-exam.
  "live-meera-1a06": { screen: "stopped", camera: "stopped", microphone: "stopped" },
  // Ended outliers: Karan's lab machine had neither camera nor mic; Neha
  // denied both optional prompts.
  "live-karan-4d02": { screen: "recording", camera: "unavailable", microphone: "unavailable" },
  "live-neha-4d03": { screen: "recording", camera: "permission_denied", microphone: "permission_denied" },
  // Recording-review seeds (the demo playback dataset reuses the same helper).
  "rec-karan-71b4": { screen: "recording", camera: "permission_denied", microphone: "recording" },
  "rec-neha-3c10": { screen: "recording", camera: "recording", microphone: "unavailable" }
};

const DEMO_CAPTURE_DEFAULT: CaptureState = { screen: "recording", camera: "recording", microphone: "recording" };

function demoCaptureStateFor(session: { session_id: string; status: string }): CaptureState | null {
  if (session.status === "pending_approval") return null;
  return DEMO_CAPTURE_OVERRIDES[session.session_id] ?? DEMO_CAPTURE_DEFAULT;
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

// F6.7 — GET /api/admin/session-events?session_id= : the candidate's proctor
// event stream (visibility/blur/clipboard/IP/recording-state...) for the
// recordings timeline overlay + activity log. Returns `null` on a 404 (endpoint
// not deployed yet) so the timeline renders WITHOUT event markers instead of
// erroring. The result carries the backend's `truncated` flag (F6 review):
// true when the stream was capped server-side, so the activity log can say
// "showing the first N events" instead of silently presenting a partial log
// as complete (older backends without the flag read as false). In demo mode
// it returns canned per-session events so the overlay and log are fully
// demoable offline (small canned sets — never truncated).
export type SessionEventsResult = { events: SessionEventItem[]; truncated: boolean };

export async function fetchSessionEvents(password: string, sessionId: string): Promise<SessionEventsResult | null> {
  if (demoMode) {
    await wait(100);
    assertDemoAdmin(password);
    return { events: DEMO_SESSION_EVENTS[sessionId] ?? [], truncated: false };
  }

  const query = new URLSearchParams();
  query.set("session_id", sessionId);
  try {
    const response = await request<SessionEventsResponse>(
      `/api/admin/session-events?${query.toString()}`,
      { method: "GET", headers: { "x-admin-password": password } }
    );
    return { events: response.events, truncated: response.truncated === true };
  } catch (cause) {
    // Endpoint not deployed yet → no event markers (graceful), not a hard error.
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
  // F10.1: how many camera/chunk-*.webm files to seed (0/absent = none). The
  // camera chunks share the screen chunks' last_modified placement so both
  // sources line up on the timeline.
  camera_chunk_count?: number;
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
    chunk_count: 8,
    // F10.1: THE camera-recording demo candidate — same 8 windows on the
    // camera series so the Screen/Camera toggle is demoable offline.
    camera_chunk_count: 8
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

// ---- Demo session events (F6.7) ------------------------------------------
// Canned per-session proctor events placed ON each demo recording's timeline so
// the activity overlay + click-to-jump log render offline. Each session tells a
// believable story: focus churn, clipboard activity, and recording-state events
// that EXPLAIN the seeded gaps (upload/heartbeat errors and share-stops at the
// blackout boundaries, with some events landing INSIDE a gap so the "during
// blackout" tag is demoable). Keyed by session_id (events are per-session).
const DEMO_SESSION_EVENTS: Record<string, SessionEventItem[]> = {
  // Asha: 09:00:00–09:04:00, no gaps — light focus churn + one paste.
  "rec-asha-9f2a": [
    { type: "session_started", timestamp: "2026-06-05T09:00:02.000Z", detail: { start_ip: "203.0.113.10" } },
    { type: "combined_recording_started", timestamp: "2026-06-05T09:00:06.000Z", detail: { width: 1920, height: 1080 } },
    { type: "camera_recording_started", timestamp: "2026-06-05T09:00:07.000Z", detail: { fps: 10, width: 640 } },
    { type: "visibility_change", timestamp: "2026-06-05T09:01:32.000Z", detail: { state: "hidden" } },
    { type: "visibility_change", timestamp: "2026-06-05T09:01:54.000Z", detail: { state: "visible" } },
    { type: "clipboard_activity", timestamp: "2026-06-05T09:02:18.000Z", detail: { action: "paste", length: 184 } },
    { type: "window_blur", timestamp: "2026-06-05T09:03:05.000Z" },
    { type: "window_focus", timestamp: "2026-06-05T09:03:18.000Z" }
  ],
  // Karan: 09:02:00–09:06:00 with a recording gap 09:03:30–09:04:30 — the
  // upload error + blur land INSIDE the blackout; recording resumes after it.
  "rec-karan-71b4": [
    { type: "session_started", timestamp: "2026-06-05T09:02:01.000Z", detail: { start_ip: "203.0.113.11" } },
    { type: "combined_recording_started", timestamp: "2026-06-05T09:02:05.000Z", detail: { width: 1366, height: 768 } },
    { type: "window_blur", timestamp: "2026-06-05T09:03:40.000Z" },
    { type: "upload_error", timestamp: "2026-06-05T09:03:55.000Z", detail: { kind: "screen", message: "Failed to fetch" } },
    { type: "combined_recording_started", timestamp: "2026-06-05T09:04:32.000Z", detail: { width: 1366, height: 768 } },
    { type: "visibility_change", timestamp: "2026-06-05T09:05:10.000Z", detail: { state: "hidden" } }
  ],
  // Neha: 09:00:30–09:02:30 — short and quiet, one copy.
  "rec-neha-3c10": [
    { type: "session_started", timestamp: "2026-06-05T09:00:31.000Z", detail: { start_ip: "203.0.113.11" } },
    { type: "clipboard_activity", timestamp: "2026-06-05T09:01:42.000Z", detail: { action: "copy", length: 56 } }
  ],
  // Vikram (the real-scale seed): 09:00:00–10:57:30 with gaps 09:40–09:45 and
  // 10:20–10:22:30 — a full sitting's worth of events, incl. blackout-interior
  // ones and the recording-state churn around both gaps.
  "rec-vikram-load": [
    { type: "session_started", timestamp: "2026-06-05T09:00:01.000Z", detail: { start_ip: "10.4.1.18" } },
    { type: "combined_recording_started", timestamp: "2026-06-05T09:00:08.000Z", detail: { width: 1920, height: 1080 } },
    { type: "visibility_change", timestamp: "2026-06-05T09:09:40.000Z", detail: { state: "hidden" } },
    { type: "visibility_change", timestamp: "2026-06-05T09:09:52.000Z", detail: { state: "visible" } },
    { type: "window_blur", timestamp: "2026-06-05T09:16:25.000Z" },
    { type: "window_focus", timestamp: "2026-06-05T09:16:41.000Z" },
    { type: "clipboard_activity", timestamp: "2026-06-05T09:24:10.000Z", detail: { action: "paste", length: 312 } },
    { type: "screen_share_stopped", timestamp: "2026-06-05T09:40:02.000Z", detail: { reason: "track_ended" } },
    { type: "window_blur", timestamp: "2026-06-05T09:41:30.000Z" },
    { type: "visibility_change", timestamp: "2026-06-05T09:43:05.000Z", detail: { state: "hidden" } },
    { type: "combined_recording_started", timestamp: "2026-06-05T09:45:04.000Z", detail: { width: 1920, height: 1080 } },
    { type: "ip_address_changed", timestamp: "2026-06-05T09:52:30.000Z", detail: { previous_ip: "10.4.1.18", current_ip: "10.4.2.7" } },
    { type: "clipboard_activity", timestamp: "2026-06-05T10:05:40.000Z", detail: { action: "copy", length: 88 } },
    { type: "upload_error", timestamp: "2026-06-05T10:20:06.000Z", detail: { kind: "screen", message: "network unreachable" } },
    { type: "heartbeat_error", timestamp: "2026-06-05T10:21:00.000Z", detail: { message: "Failed to fetch" } },
    { type: "combined_recording_started", timestamp: "2026-06-05T10:22:33.000Z", detail: { width: 1920, height: 1080 } },
    { type: "visibility_change", timestamp: "2026-06-05T10:38:20.000Z", detail: { state: "hidden" } },
    { type: "visibility_change", timestamp: "2026-06-05T10:38:30.000Z", detail: { state: "visible" } },
    { type: "session_stop_requested", timestamp: "2026-06-05T10:57:20.000Z" }
  ]
};

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
  // F10.1: the separate low-res camera series (contiguous from created_at —
  // the camera seeds carry no gaps; same END-time last_modified semantics).
  for (let i = 1; i <= (seed.camera_chunk_count ?? 0); i += 1) {
    evidence.push({
      key: `${prefix}camera/chunk-${String(i).padStart(5, "0")}.webm`,
      size: 60_000 + i * 500,
      last_modified: new Date(createdMs + i * DEMO_CHUNK_SECONDS * 1000).toISOString(),
      download_url: DEMO_SAMPLE_CLIP
    });
  }
  // Add a couple of non-screen files so filtering is exercised too.
  evidence.push({ key: `${prefix}manifest.json`, size: 412, last_modified: seed.created_at, download_url: DEMO_SAMPLE_CLIP });
  return evidence;
}

// F6 review — guard for the session-card Recordings-tab deep links ("View
// recording" / "View events"): in DEMO mode only the recording dataset above
// is loadable in the Recordings tab, so a deep link for any other candidate
// dead-ends in "No sessions found". Always true against a real backend
// (/api/admin/sessions serves every candidate, zero-chunk sessions included).
export function recordingDataAvailable(username: string): boolean {
  if (!demoMode) return true;
  const usernameNorm = normalizeUsername(username);
  return DEMO_RECORDING_SESSIONS.some((seed) => seed.username_norm === usernameNorm);
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
      camera_chunk_count: seed.camera_chunk_count ?? 0,
      evidence: demoEvidenceFor(seed),
      // F6.6: the recordings-review header reads this to say what the loaded
      // recording contains (varied across the demo seeds).
      capture_state: demoCaptureStateFor(seed)
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

// ---- S-J Results tab (vision §2.14) ----------------------------------------
//
// GET /api/admin/contest-results — ADMIN-ONLY ranked rollup. Returns null on a
// 404 (endpoint not deployed yet) so the tab degrades gracefully like
// attendance/ip-report. The demo branch serves a deterministic, localStorage-
// backed dataset for the demo contest so selection transitions persist.

export async function fetchContestResults(password: string, contestSlug: string): Promise<ContestResultsResponse | null> {
  if (demoMode) {
    await wait(160);
    assertDemoAdmin(password);
    return demoContestResults(contestSlug);
  }
  const query = contestSlug ? `?contest=${encodeURIComponent(contestSlug)}` : "";
  try {
    return await request<ContestResultsResponse>(`/api/admin/contest-results${query}`, {
      method: "GET",
      headers: { "x-admin-password": password }
    });
  } catch (cause) {
    if ((cause as ApiError)?.status === 404) return null;
    throw cause;
  }
}

// POST /api/admin/contest-selection — bulk selection transition (with an
// optional from_status race guard). Returns the per-person outcome.
export async function setContestSelection(
  password: string,
  body: { contest: string; person_ids: string[]; selection_status: SelectionStatus; from_status?: SelectionStatus }
): Promise<{ ok: boolean; to_status: string; updated: string[]; skipped: Array<{ person_id: string; reason: string }> }> {
  if (demoMode) {
    await wait(140);
    assertDemoAdmin(password);
    return demoSetSelection(body);
  }
  return request("/api/admin/contest-selection", {
    method: "POST",
    headers: { "x-admin-password": password },
    body: JSON.stringify(body)
  });
}

// POST /api/admin/contest-selection-done — freeze final_snapshot + stamp the
// retention clock. The Wave-7 sweep reads selection_done_at; this only stamps.
export async function markSelectionDone(
  password: string,
  contestSlug: string
): Promise<{ ok: boolean; selection_done_at: string; enrollments_snapshotted: number }> {
  if (demoMode) {
    await wait(180);
    assertDemoAdmin(password);
    return demoMarkSelectionDone(contestSlug);
  }
  return request("/api/admin/contest-selection-done", {
    method: "POST",
    headers: { "x-admin-password": password },
    body: JSON.stringify({ contest: contestSlug })
  });
}

// ---- demo Results dataset (parity for the NEW tab — acceptance bar S4) ------
// Deterministic ranked rows for the demo contest (demo-drive-r1), with
// selection_status persisted in localStorage so the bulk-selection UI + "Mark
// selection done" behave like production. Two colleges so the multi-college
// label projection (vision §2.13) is visible.

const demoSelectionKey = "aerele-proctor-demo-selection-v1";
const demoSelectionDoneKey = "aerele-proctor-demo-selection-done-v1";

type DemoResultSeed = {
  person_id: string; candidate_id: string; name: string; college_norm: string; college: string;
  room: string; scores: [number, number, number]; critical: number; warning: number; review: "none" | "cleared" | "flagged";
};

// 12 candidates across KEC + PSG; problem points 100/150/50 (sum-two/reverse-
// words/max-window-sum). Scores hand-tuned for a believable spread.
const DEMO_RESULT_SEEDS: DemoResultSeed[] = [
  { person_id: "kec~21cs017", candidate_id: "21CS017", name: "Asha Ramanathan", college_norm: "kec", college: "KEC", room: "Lab 1", scores: [100, 150, 50], critical: 0, warning: 0, review: "cleared" },
  { person_id: "psg~22it004", candidate_id: "22IT004", name: "Bala Subramanian", college_norm: "psg", college: "PSG Tech", room: "Lab 2", scores: [100, 150, 0], critical: 0, warning: 1, review: "none" },
  { person_id: "kec~21cs033", candidate_id: "21CS033", name: "Chitra Nair", college_norm: "kec", college: "KEC", room: "Lab 1", scores: [100, 100, 50], critical: 0, warning: 0, review: "none" },
  { person_id: "psg~22it019", candidate_id: "22IT019", name: "Deepak Rao", college_norm: "psg", college: "PSG Tech", room: "Lab 2", scores: [100, 150, 0], critical: 1, warning: 2, review: "flagged" },
  { person_id: "kec~21cs008", candidate_id: "21CS008", name: "Esha Pillai", college_norm: "kec", college: "KEC", room: "Lab 1", scores: [100, 75, 50], critical: 0, warning: 0, review: "none" },
  { person_id: "psg~22it041", candidate_id: "22IT041", name: "Farhan Ali", college_norm: "psg", college: "PSG Tech", room: "Lab 2", scores: [100, 100, 0], critical: 0, warning: 1, review: "none" },
  { person_id: "kec~21cs025", candidate_id: "21CS025", name: "Gita Menon", college_norm: "kec", college: "KEC", room: "Lab 1", scores: [60, 100, 0], critical: 0, warning: 0, review: "none" },
  { person_id: "psg~22it012", candidate_id: "22IT012", name: "Harish Kumar", college_norm: "psg", college: "PSG Tech", room: "Lab 2", scores: [100, 0, 0], critical: 0, warning: 0, review: "none" },
  { person_id: "kec~21cs049", candidate_id: "21CS049", name: "Ishita Bhat", college_norm: "kec", college: "KEC", room: "Lab 1", scores: [40, 50, 0], critical: 2, warning: 1, review: "flagged" },
  { person_id: "psg~22it027", candidate_id: "22IT027", name: "Jayant Verma", college_norm: "psg", college: "PSG Tech", room: "Lab 2", scores: [60, 0, 0], critical: 0, warning: 0, review: "none" },
  { person_id: "kec~21cs002", candidate_id: "21CS002", name: "Kavya Iyer", college_norm: "kec", college: "KEC", room: "Lab 1", scores: [0, 0, 0], critical: 0, warning: 0, review: "none" },
  { person_id: "psg~22it038", candidate_id: "22IT038", name: "Lokesh Babu", college_norm: "psg", college: "PSG Tech", room: "Lab 2", scores: [0, 0, 0], critical: 1, warning: 0, review: "none" }
];

const DEMO_RESULT_PROBLEMS = [
  { problem_id: "sum-two", title: "Sum of Two Numbers", points: 100 },
  { problem_id: "reverse-words", title: "Reverse the Words", points: 150 },
  { problem_id: "max-window-sum", title: "Maximum Window Sum", points: 50 }
];

function readDemoSelection(): Record<string, SelectionStatus> {
  try {
    const raw = window.localStorage.getItem(demoSelectionKey);
    return raw ? (JSON.parse(raw) as Record<string, SelectionStatus>) : {};
  } catch {
    return {};
  }
}
function writeDemoSelection(map: Record<string, SelectionStatus>) {
  window.localStorage.setItem(demoSelectionKey, JSON.stringify(map));
}

function demoContestResults(contestSlug: string): ContestResultsResponse {
  // Results is a person-layer surface: only the seeded demo contest carries it.
  if (contestSlug !== "demo-drive-r1") return { configured: false };
  const selection = readDemoSelection();
  const rows: ResultRow[] = DEMO_RESULT_SEEDS.map((seed) => {
    const total = seed.scores[0] + seed.scores[1] + seed.scores[2];
    return {
      person_id: seed.person_id,
      rank: 0,
      candidate_id: seed.candidate_id,
      name: seed.name,
      college_norm: seed.college_norm,
      college: seed.college,
      display_id: `${seed.candidate_id} · ${seed.college}`, // multi-college demo
      total,
      per_problem: DEMO_RESULT_PROBLEMS.map((p, i) => ({
        problem_id: p.problem_id, best_score: seed.scores[i], max_points: p.points, attempts: seed.scores[i] > 0 ? 1 : 0
      })),
      integrity: {
        alerts_by_severity: { critical: seed.critical, warning: seed.warning, info: 0 },
        total_alerts: seed.critical + seed.warning,
        has_critical: seed.critical > 0,
        review_count: seed.review === "none" ? 0 : 1,
        review_cheating_count: seed.review === "flagged" ? 1 : 0,
        review_verdict: seed.review
      },
      selection_status: selection[seed.person_id] ?? "none",
      from_snapshot: false,
      room: seed.room
    };
  });
  rows.sort((a, b) => b.total - a.total || a.candidate_id.localeCompare(b.candidate_id));
  rows.forEach((row, index) => { row.rank = index + 1; });
  return {
    configured: true,
    contest_slug: contestSlug,
    multi_college: true,
    selection_done_at: window.localStorage.getItem(demoSelectionDoneKey),
    problems: DEMO_RESULT_PROBLEMS,
    rows,
    generated_at: new Date().toISOString()
  };
}

function demoSetSelection(body: { contest: string; person_ids: string[]; selection_status: SelectionStatus; from_status?: SelectionStatus }) {
  const selection = readDemoSelection();
  const updated: string[] = [];
  const skipped: Array<{ person_id: string; reason: string }> = [];
  for (const id of body.person_ids) {
    const current = selection[id] ?? "none";
    if (body.from_status && current !== body.from_status) {
      skipped.push({ person_id: id, reason: "from_status_mismatch" });
      continue;
    }
    selection[id] = body.selection_status;
    updated.push(id);
  }
  writeDemoSelection(selection);
  return { ok: true, to_status: body.selection_status, updated: updated.sort(), skipped };
}

function demoMarkSelectionDone(contestSlug: string) {
  if (contestSlug !== "demo-drive-r1") throw demoApiError(400, "contest must name a person-mode contest");
  const now = new Date().toISOString();
  window.localStorage.setItem(demoSelectionDoneKey, now);
  return { ok: true, selection_done_at: now, enrollments_snapshotted: DEMO_RESULT_SEEDS.length };
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
          // F8.1: same derivation as the demo session card, so the drill-down
          // roster id matches what "Open session card" then shows.
          roster_unique_id: demoRosterIdFor(session),
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
    // F5.5: per-session exemption toggles (merge semantics, backend parity).
    else if (body.action === "exempt") row.enforcement_exemptions = { ...row.enforcement_exemptions, ...sanitizeDemoExemptions(body.exemptions) };
    updated.push({ ...row });
  }
  return updated;
}

// F5.5 demo parity with the backend's sanitizeExemptions: known keys, booleans only.
function sanitizeDemoExemptions(input: EnforcementExemptions | undefined): EnforcementExemptions {
  const out: EnforcementExemptions = {};
  if (input && typeof input.fullscreen === "boolean") out.fullscreen = input.fullscreen;
  if (input && typeof input.switch_away === "boolean") out.switch_away = input.switch_away;
  return out;
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
      // F5.3 parity: an admin unlock clears the enforcement lock reason.
      upsertDemoSession({ ...target, status: "active", locked_reason: null });
      updated.push({ ...target, status: "active", locked_reason: null });
    } else if (body.action === "exempt") {
      const merged = { ...sanitizeDemoExemptions(target.enforcement_exemptions), ...sanitizeDemoExemptions(body.exemptions) };
      upsertDemoSession({ ...target, enforcement_exemptions: merged });
      updated.push({ ...target, enforcement_exemptions: merged });
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
      // F6.7: inside Asha's demo recording window (09:00–09:04) so the marker
      // lands on her timeline overlay.
      timestamp: "2026-06-05T09:03:42.000Z",
      contest_slug: "mcet-june-2026",
      hackerrank_username: "Asha_R",
      username_norm: "asha_r",
      session_id: "live-asha-4d01",
      room: "Lab A-1",
      title: "Recording stopped mid-assessment",
      detail: "MediaRecorder stopped before submission with no end-session event. Possible deliberate stop.",
      data: { gap_seconds: 1080, last_chunk_index: 54 },
      video_key: "mcet-june-2026/asha_r/live-asha-4d01.webm",
      download_url: sampleVideo
    },
    {
      id: "contest-eval:peer_copy_cluster:karan_v:mcet-june-2026:c3",
      source: "contest-eval",
      type: "peer_copy_cluster",
      severity: "critical",
      // F6.7: INSIDE Karan's recording gap (09:03:30–09:04:30) — the log row
      // gets the "during blackout" tag.
      timestamp: "2026-06-05T09:04:10.000Z",
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
      // F6.7: inside Neha's demo recording window (09:00:30–09:02:30).
      timestamp: "2026-06-05T09:01:58.000Z",
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
      // F6.7: inside Asha's demo recording window (09:00–09:04).
      timestamp: "2026-06-05T09:01:25.000Z",
      contest_slug: "mcet-june-2026",
      hackerrank_username: "Asha_R",
      username_norm: "asha_r",
      session_id: "live-asha-4d01",
      room: "Lab A-1",
      title: "Network IP changed",
      detail: "Source IP changed once early in the session (likely a Wi-Fi handoff). Informational only.",
      data: { start_ip: "10.4.1.18", current_ip: "10.4.2.7" },
      download_url: sampleVideo
    },
    // F6.7: Vikram_T — the real-scale recording seed (rec-vikram-load,
    // 09:00–10:57 with gaps 09:40–09:45 and 10:20–10:22:30) gets alerts of all
    // three severities so the overlay's severity colors + the blackout tag are
    // demoable on the dense timeline. Joins live-vikram-4d04 (ended).
    {
      id: "proctor:tab_away:vikram_t:mcet-june-2026:1",
      source: "proctor",
      type: "tab_away",
      severity: "warning",
      timestamp: "2026-06-05T09:09:42.000Z",
      contest_slug: "mcet-june-2026",
      hackerrank_username: "Vikram_T",
      username_norm: "vikram_t",
      session_id: "live-vikram-4d04",
      room: "Lab A-1",
      title: "Tab switched away for 13s",
      detail: "Candidate left the exam tab for 13 seconds, then returned. Above the configured threshold.",
      data: { away_seconds: 13, threshold_seconds: 12 },
      download_url: sampleVideo
    },
    {
      id: "proctor:recording_stopped:vikram_t:mcet-june-2026:1",
      source: "proctor",
      type: "recording_stopped",
      severity: "critical",
      // Lands INSIDE recording gap 1 (09:40–09:45) — "during blackout" row.
      timestamp: "2026-06-05T09:40:05.000Z",
      contest_slug: "mcet-june-2026",
      hackerrank_username: "Vikram_T",
      username_norm: "vikram_t",
      session_id: "live-vikram-4d04",
      room: "Lab A-1",
      title: "Recording stopped mid-assessment",
      detail: "Screen share ended and the recorder stopped; chunks resumed 5 minutes later. Review the blackout window.",
      data: { gap_seconds: 300, last_chunk_index: 80 },
      download_url: sampleVideo
    },
    {
      id: "proctor:ip_changed:vikram_t:mcet-june-2026:1",
      source: "proctor",
      type: "ip_changed",
      severity: "info",
      timestamp: "2026-06-05T09:52:30.000Z",
      contest_slug: "mcet-june-2026",
      hackerrank_username: "Vikram_T",
      username_norm: "vikram_t",
      session_id: "live-vikram-4d04",
      room: "Lab A-1",
      title: "Network IP changed",
      detail: "Source IP changed mid-session shortly after the recording resumed (10.4.1.18 → 10.4.2.7).",
      data: { start_ip: "10.4.1.18", current_ip: "10.4.2.7" },
      download_url: sampleVideo
    }
  ];
}

// Default per-type proctor alert config — mirrors the backend
// DEFAULT_PROCTOR_ALERT_SETTINGS so the demo console renders the same toggle list.
// F9.3 (Wave6, Karthi): show_to_invigilator DEFAULTS ALL OFF — the admin opts in
// per type; nothing is shared with invigilators by default.
const DEFAULT_DEMO_ALERT_SETTINGS: AlertSettings = {
  proctor: {
    recording_stopped: { enabled: true, severity: "critical", show_to_invigilator: false },
    screen_share_stopped: { enabled: true, severity: "critical", show_to_invigilator: false },
    recording_error: { enabled: true, severity: "critical", show_to_invigilator: false },
    // F5.3: the fullscreen enforcement ladder tripped (alert display only —
    // the block-mode lock is policy, governed by enforcement_mode).
    fullscreen_enforcement: { enabled: true, severity: "critical", show_to_invigilator: false },
    ip_changed: { enabled: true, severity: "warning", show_to_invigilator: false },
    tab_hidden: { enabled: true, severity: "warning", show_to_invigilator: false },
    tab_away: { enabled: true, severity: "warning", show_to_invigilator: false, threshold_seconds: 12 },
    disconnected: { enabled: true, severity: "warning", show_to_invigilator: false }
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
      severity: override && ["critical", "warning", "info"].includes(override.severity) ? override.severity : def.severity,
      // F9.3 (mirrors backend): only an explicit boolean overrides the default.
      show_to_invigilator: override && typeof override.show_to_invigilator === "boolean"
        ? override.show_to_invigilator
        : def.show_to_invigilator
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

// Read the persisted demo alert settings (full config, defaults merged). Used by
// the admin settings tab AND the demo invigilator feed filter (F9.3).
function readDemoAlertSettings(): AlertSettings {
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

export async function fetchAlertSettings(password: string): Promise<AlertSettings> {
  if (demoMode) {
    await wait(100);
    assertDemoAdmin(password);
    return readDemoAlertSettings();
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

function demoApiError(status: number, code: string, body?: Record<string, unknown>): ApiError {
  const error = new Error(code) as ApiError;
  error.status = status;
  error.code = code;
  if (body) error.body = { error: code, detail: code, ...body };
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

// ---- S-C demo person-roster stores (per-contest roster + the shared
// colleges/persons/enrollments state, mirroring the backend identity core).
const demoPersonRosterKeyPrefix = "aerele-proctor-demo-person-roster::";
const demoPersonStateKey = "aerele-proctor-demo-person-state";

function getDemoPersonRoster(contest: string): RosterUploadRequest | null {
  const raw = window.localStorage.getItem(`${demoPersonRosterKeyPrefix}${contest}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RosterUploadRequest;
  } catch {
    return null;
  }
}

function getDemoPersonState(): PersonRosterState {
  const raw = window.localStorage.getItem(demoPersonStateKey);
  if (!raw) return emptyPersonRosterState();
  try {
    return { ...emptyPersonRosterState(), ...(JSON.parse(raw) as PersonRosterState) };
  } catch {
    return emptyPersonRosterState();
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
      rooms: getDemoSettings()?.rooms ?? [],
      enforcement: demoEnforcement(),
      // F10.1: the consent disclosure renders pre-session off exam-config.
      camera_recording: demoCameraRecording()
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
// S-C: `contest` reads that contest's roster meta (roster_meta::{slug}).
export async function fetchRosterStatus(password: string, contest?: string): Promise<RosterStatus | null> {
  if (demoMode) {
    await wait(100);
    assertDemoAdmin(password);
    const roster = contest ? getDemoPersonRoster(contest) : getDemoRoster();
    return roster
      ? {
          configured: true,
          ...(contest ? { contest, college_column: roster.college_column || roster.column_mapping.college || "college" } : {}),
          count: roster.rows.length,
          unique_id_column: roster.unique_id_column,
          column_mapping: roster.column_mapping,
          columns: roster.columns,
          updated_at: new Date().toISOString()
        }
      : { configured: false, ...(contest ? { contest } : {}) };
  }
  try {
    const query = contest ? `?contest=${encodeURIComponent(contest)}` : "";
    return await request<RosterStatus>(`/api/admin/roster${query}`, {
      method: "GET",
      headers: { "x-admin-password": password }
    });
  } catch (cause) {
    if ((cause as ApiError)?.status === 404) return null;
    throw cause;
  }
}

// POST /api/admin/roster — upload (replace) the roster. `null` on 404.
// S-C: payload.contest routes the upload down the PERSON-layer pipeline; the
// demo branch runs the same validation order via roster/personRoster.ts so
// the college gate / dup-reject / confirmation panels behave identically.
export async function uploadRoster(password: string, payload: RosterUploadRequest): Promise<RosterUploadResponse | null> {
  if (demoMode) {
    await wait(200);
    assertDemoAdmin(password);
    if (payload.contest) {
      const result = evaluatePersonRosterUpload(payload, getDemoPersonState());
      if (result.kind === "error") {
        throw demoApiError(result.status, result.code, result.payload);
      }
      if (result.kind === "confirm") {
        return {
          ok: false,
          needs_college_confirmation: true,
          new_colleges: result.new_colleges,
          known_colleges: result.known_colleges
        };
      }
      window.localStorage.setItem(demoPersonStateKey, JSON.stringify(result.state));
      window.localStorage.setItem(`${demoPersonRosterKeyPrefix}${payload.contest}`, JSON.stringify(payload));
      return result.response;
    }
    // Legacy (no contest): mirror the backend skip rules unchanged.
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
// S-C: with `contest`, clears THAT contest's roster (enrollments survive).
export async function clearRoster(password: string, contest?: string): Promise<{ ok: boolean } | null> {
  if (demoMode) {
    await wait(100);
    assertDemoAdmin(password);
    if (contest) window.localStorage.removeItem(`${demoPersonRosterKeyPrefix}${contest}`);
    else window.localStorage.removeItem(demoRosterKey);
    return { ok: true };
  }
  try {
    return await request<{ ok: boolean }>("/api/admin/roster", {
      method: "POST",
      headers: { "x-admin-password": password },
      body: JSON.stringify({ clear: true, ...(contest ? { contest } : {}) })
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

// ---- S-I §6 demo exec parity -------------------------------------------------
// A localStorage demo-submissions list (so submissions_summary, chips, totals
// and attempt meters all work offline and survive a reload) + per-(session,
// problem) cooldown stamps mirroring the backend limiter (run 5s / submit 20s
// / budget 50 — independent per problem, exactly the server semantics the
// workspace renders from retry_after_seconds).

const demoSubmissionsKey = "aerele-proctor-demo-submissions-v1";
const DEMO_SUBMIT_BUDGET = 50;
const DEMO_RUN_COOLDOWN_SECONDS = 5;
const DEMO_SUBMIT_COOLDOWN_SECONDS = 20;

// Per-problem demo submit profiles → varied status chips out of the box:
// sum-two solves (✓), reverse-words lands partial (↻), max-window-sum zeroes
// (✗). Unknown/authored problems pass everything.
const DEMO_SUBMIT_PASSES: Record<string, number> = {
  "reverse-words": 2,
  "max-window-sum": 0
};

type DemoStoredSubmission = StoredSubmission & { session_id: string };

function readDemoSubmissions(): DemoStoredSubmission[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(demoSubmissionsKey) || "[]");
    return Array.isArray(parsed) ? (parsed as DemoStoredSubmission[]) : [];
  } catch {
    return [];
  }
}

function writeDemoSubmissions(submissions: DemoStoredSubmission[]) {
  window.localStorage.setItem(demoSubmissionsKey, JSON.stringify(submissions));
}

function demoSubmissionsSummaryFor(sessionId: string) {
  return summarizeSubmissions(readDemoSubmissions().filter((item) => item.session_id === sessionId));
}

// In-memory cooldown stamps (the backend limiter is in-memory too; a reload
// clearing them is acceptable demo parity).
const demoExecStamps = new Map<string, { run: number; submit: number }>();

function demoExecGate(sessionId: string, problemId: string, kind: "run" | "submit", attemptsSoFar = 0): void {
  const key = `${sessionId}::${problemId}`;
  const stamps = demoExecStamps.get(key) ?? { run: -Infinity, submit: -Infinity };
  const windowSeconds = kind === "run" ? DEMO_RUN_COOLDOWN_SECONDS : DEMO_SUBMIT_COOLDOWN_SECONDS;
  const waitMs = windowSeconds * 1000 - (Date.now() - stamps[kind]);
  if (waitMs > 0) throw demoApiError(429, "rate_limited", { retry_after_seconds: Math.ceil(waitMs / 1000) });
  // Stored-submission budget (backend: only successful stores count; the demo
  // store only holds successful submits, so the count matches).
  if (kind === "submit" && attemptsSoFar >= DEMO_SUBMIT_BUDGET) {
    throw demoApiError(429, "rate_limited", { retry_after_seconds: 3600 });
  }
  stamps[kind] = Date.now();
  demoExecStamps.set(key, stamps);
}

// Effective points parity (backend resolveExecProblem): the session's contest
// entry override wins, else the bank problem's points.
function demoEffectivePoints(sessionId: string, problem: ProblemDoc): number {
  const session = readDemoSessions().find((item) => item.session_id === sessionId);
  const contest = session?.contest_slug
    ? readDemoContests().find((item) => item.slug === session.contest_slug) ?? null
    : null;
  const entry = contest?.problems?.find((item) => item.problem_id === problem.id);
  return entry?.points ?? problem.points ?? 100;
}

export async function execRun(req: ExecRequest): Promise<RunResult> {
  if (demoMode) {
    const problem = findDemoProblem(req.problem_id);
    if (!problem || problem.status !== "published") throw demoApiError(400, "unknown problem_id");
    demoExecGate(req.session_id, req.problem_id, "run");
    await wait(300);
    // Echo the problem's OWN samples as passing — per-problem demo parity with
    // the real /api/exec/run shape (results.length === sampleTests.length).
    return {
      results: problem.sampleTests.map((t) => ({
        input: t.input, expected: t.expected, passed: true, status: "accepted",
        stdout: t.expected, stderr: "", compileOutput: ""
      }))
    };
  }
  return request<RunResult>("/api/exec/run", { method: "POST", body: JSON.stringify(req) });
}

export async function execSubmit(req: ExecRequest): Promise<SubmitResult> {
  if (demoMode) {
    const problem = findDemoProblem(req.problem_id);
    if (!problem || problem.status !== "published") throw demoApiError(400, "unknown problem_id");
    const stored = readDemoSubmissions();
    const attempts = stored.filter((item) => item.session_id === req.session_id && item.problem_id === req.problem_id).length;
    demoExecGate(req.session_id, req.problem_id, "submit", attempts);
    await wait(500);
    // §9 lock: mirror the real /api/exec/submit shape — verdict + counts +
    // score, never per-test hidden detail.
    const total = problem.hiddenTests.length || 4;
    const passed = Math.min(DEMO_SUBMIT_PASSES[req.problem_id] ?? total, total);
    const maxPoints = demoEffectivePoints(req.session_id, problem);
    const score = problem.scoring === "all_or_nothing"
      ? (passed === total ? maxPoints : 0)
      : Math.floor((maxPoints * passed) / total);
    const verdict: SubmitResult["verdict"] = passed === total ? "accepted" : "wrong_answer";
    const created = new Date().toISOString();
    writeDemoSubmissions([...stored, {
      session_id: req.session_id, problem_id: req.problem_id,
      verdict, score, max_points: maxPoints, created_at: created
    }]);
    return { verdict, passed_count: passed, total, score, max_points: maxPoints, submission_id: `demo-${stored.length + 1}` };
  }
  return request<SubmitResult>("/api/exec/submit", { method: "POST", body: JSON.stringify(req) });
}

// ---- S-D: contests administration (Contests tab + selector + routing) -------
// Spec: docs/superpowers/specs/2026-06-10-f10-product-vision.md §2.7/§5/§10.3.
// Demo parity: a localStorage contests store seeded with one OPEN demo contest
// whose access code is the fixed "DEMO42", plus the synthesized legacy row
// derived from the demo settings doc (mirrors backend legacy synthesis).

// v2: S-I reseeded demo-drive-r1 with THREE ordered problems (sum-two,
// reverse-words ×150 pts, max-window-sum ×50 pts) so the multi-problem
// workspace demos meaningfully — the key bump discards stale v1 stores.
const demoContestsKey = "aerele-proctor-demo-contests-v2";
export const DEMO_ACCESS_CODE = "DEMO42";
const DEMO_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ23456789";

function randomDemoCode(length: number, alphabet = DEMO_CODE_ALPHABET): string {
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function seedDemoContests(): ContestSummary[] {
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  return [{
    slug: "demo-drive-r1",
    name: "Demo Drive — Round 1",
    status: "open",
    legacy: false,
    listed: true,
    identity_label: "Roll Number",
    access_code: DEMO_ACCESS_CODE,
    invigilator_key: "demo-invigilator-key-001",
    start_at: new Date(nowMs - 60 * 60_000).toISOString(),
    end_at: new Date(nowMs + 6 * 60 * 60_000).toISOString(),
    problems: [
      { problem_id: "sum-two", points: null, order: 0 },
      { problem_id: "reverse-words", points: null, order: 1 },
      { problem_id: "max-window-sum", points: null, order: 2 }
    ],
    rooms: ["Lab 1", "Lab 2"],
    room_gate_enabled: false,
    template_slug: "demo-aptitude-r1",
    created_at: now,
    updated_at: now
  }];
}

function readDemoContests(): ContestSummary[] {
  const raw = window.localStorage.getItem(demoContestsKey);
  if (raw) {
    try {
      return JSON.parse(raw) as ContestSummary[];
    } catch {
      // fall through to reseed
    }
  }
  const seeded = seedDemoContests();
  window.localStorage.setItem(demoContestsKey, JSON.stringify(seeded));
  return seeded;
}

function writeDemoContests(contests: ContestSummary[]) {
  window.localStorage.setItem(demoContestsKey, JSON.stringify(contests));
}

// Mirrors backend legacy synthesis: the demo settings doc surfaces as a
// read-only legacy:true contest (slug from contest_url, like demo sessions).
function demoLegacyContest(): ContestSummary | null {
  const settings = getDemoSettings();
  if (!settings) return null;
  const slug = contestSlugFromUrl(settings.contest_url || "") || "legacy";
  return {
    slug,
    name: slug,
    status: "open",
    legacy: true,
    listed: true,
    identity_label: "Candidate ID",
    access_code: null,
    invigilator_key: null,
    start_at: settings.start_at || null,
    end_at: settings.end_at || null,
    problem_id: settings.problem_id || "",
    rooms: settings.rooms ?? [],
    room_gate_enabled: settings.room_gate_enabled === true,
    template_slug: null,
    created_at: null,
    updated_at: settings.updated_at || null
  };
}

function demoContestsList(): ContestSummary[] {
  const real = readDemoContests();
  const legacy = demoLegacyContest();
  if (legacy && !real.some((contest) => contest.slug === legacy.slug)) {
    return [...real, legacy];
  }
  return real;
}

function findDemoContest(slug: string): ContestSummary {
  const hit = readDemoContests().find((contest) => contest.slug === slug);
  if (!hit) throw demoApiError(404, "contest_not_found");
  return hit;
}

function updateDemoContest(slug: string, patch: Partial<ContestSummary>): ContestSummary {
  const contests = readDemoContests();
  const index = contests.findIndex((contest) => contest.slug === slug);
  if (index < 0) throw demoApiError(404, "contest_not_found");
  const next = { ...contests[index], ...patch, updated_at: new Date().toISOString() };
  contests[index] = next;
  writeDemoContests(contests);
  return next;
}

function demoSlugify(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
}

export async function fetchContests(password: string, includeArchived = true): Promise<ContestSummary[]> {
  if (demoMode) {
    await wait(120);
    assertDemoAdmin(password);
    return demoContestsList().filter((contest) => includeArchived || contest.status !== "archived");
  }
  const query = includeArchived ? "?include_archived=1" : "";
  const response = await request<{ contests: ContestSummary[] }>(`/api/admin/contests${query}`, {
    method: "GET",
    headers: { "x-admin-password": password }
  });
  return response.contests;
}

export async function createContestApi(password: string, body: ContestCreateRequest): Promise<ContestSummary> {
  if (demoMode) {
    await wait(200);
    assertDemoAdmin(password);
    const name = body.name.trim();
    if (!name) throw demoApiError(400, "name is required");
    const baseSlug = demoSlugify(name);
    if (!baseSlug) throw demoApiError(400, "name must contain letters or digits");
    const contests = readDemoContests();
    let slug = baseSlug;
    for (let n = 2; contests.some((contest) => contest.slug === slug); n++) slug = `${baseSlug}-${n}`;
    // Demo instantiate: the demo template's problems/defaults snapshot-copy in.
    const template = body.template_slug ? demoTemplateBySlug(body.template_slug) : null;
    const now = new Date().toISOString();
    const item: ContestSummary = {
      slug,
      name,
      status: "draft",
      legacy: false,
      listed: true,
      identity_label: body.identity_label ?? template?.defaults.identity_label ?? "Candidate ID",
      access_code: randomDemoCode(6),
      invigilator_key: randomDemoCode(24, "abcdefghijklmnopqrstuvwxyz234567"),
      start_at: body.start_at || null,
      end_at: body.end_at || null,
      problems: (body.problems ?? template?.problems ?? []).map((entry, order) => ({
        problem_id: entry.problem_id, points: entry.points ?? null, order
      })),
      rooms: body.rooms ?? [],
      room_gate_enabled: body.room_gate_enabled ?? template?.defaults.room_gate_enabled ?? false,
      template_slug: template?.slug ?? null,
      created_at: now,
      updated_at: now
    };
    writeDemoContests([item, ...contests]);
    return item;
  }
  const response = await request<{ contest: ContestSummary }>("/api/admin/contests", {
    method: "POST",
    headers: { "x-admin-password": password },
    body: JSON.stringify(body)
  });
  return response.contest;
}

export async function updateContestApi(password: string, body: ContestUpdateRequest): Promise<ContestSummary> {
  if (demoMode) {
    await wait(150);
    assertDemoAdmin(password);
    const { slug, confirm: _c, confirm_points_edit: _p, ...patch } = body;
    if (patch.start_at !== undefined || patch.end_at !== undefined) {
      const existing = findDemoContest(slug);
      const start = patch.start_at !== undefined ? patch.start_at : existing.start_at;
      const end = patch.end_at !== undefined ? patch.end_at : existing.end_at;
      if (start && end && Date.parse(start) >= Date.parse(end)) {
        throw demoApiError(400, "Start time must be before end time.");
      }
    }
    const normalized: Partial<ContestSummary> = {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.identity_label !== undefined ? { identity_label: patch.identity_label } : {}),
      ...(patch.listed !== undefined ? { listed: patch.listed } : {}),
      ...(patch.start_at !== undefined ? { start_at: patch.start_at || null } : {}),
      ...(patch.end_at !== undefined ? { end_at: patch.end_at || null } : {}),
      ...(patch.rooms !== undefined ? { rooms: patch.rooms.map((room) => room.trim()).filter(Boolean) } : {}),
      ...(patch.room_gate_enabled !== undefined ? { room_gate_enabled: patch.room_gate_enabled } : {}),
      ...(patch.problems !== undefined
        ? { problems: patch.problems.map((entry, order) => ({ problem_id: entry.problem_id, points: entry.points ?? null, order })) }
        : {})
    };
    return updateDemoContest(slug, normalized);
  }
  const response = await request<{ contest: ContestSummary }>("/api/admin/contest-update", {
    method: "POST",
    headers: { "x-admin-password": password },
    body: JSON.stringify(body)
  });
  return response.contest;
}

export async function setContestStatusApi(password: string, slug: string, status: ContestStatus): Promise<ContestSummary> {
  if (demoMode) {
    await wait(150);
    assertDemoAdmin(password);
    const contest = findDemoContest(slug);
    if (status === "open" && !(contest.problems ?? []).length) {
      throw demoApiError(400, "contest_has_no_problems");
    }
    return updateDemoContest(slug, { status });
  }
  const response = await request<{ contest: ContestSummary }>("/api/admin/contest-status", {
    method: "POST",
    headers: { "x-admin-password": password },
    body: JSON.stringify({ slug, status })
  });
  return response.contest;
}

export async function regenerateContestSecretApi(
  password: string, slug: string, field: "access_code" | "invigilator_key"
): Promise<ContestSummary> {
  if (demoMode) {
    await wait(150);
    assertDemoAdmin(password);
    findDemoContest(slug);
    return updateDemoContest(slug, field === "access_code"
      ? { access_code: randomDemoCode(6) }
      : { invigilator_key: randomDemoCode(24, "abcdefghijklmnopqrstuvwxyz234567") });
  }
  const response = await request<{ contest: ContestSummary }>("/api/admin/contest-regenerate", {
    method: "POST",
    headers: { "x-admin-password": password },
    body: JSON.stringify({ slug, field })
  });
  return response.contest;
}

// S-D: the legacy S5 exam-time card semantics, per contest.
export async function adjustContestExamTime(password: string, slug: string, body: ExamTimeRequest): Promise<ExamTimeResponse> {
  if (demoMode) {
    await wait(150);
    assertDemoAdmin(password);
    const contest = findDemoContest(slug);
    if (!contest.start_at || !contest.end_at) throw demoApiError(400, "Contest schedule is not configured yet.");
    const now = new Date().toISOString();
    let newEndMs: number;
    if (body.end_now === true) {
      newEndMs = Date.parse(now);
    } else if (body.end_at) {
      newEndMs = Date.parse(body.end_at);
      if (!Number.isFinite(newEndMs)) throw demoApiError(400, "end_at must be a valid ISO 8601 date");
    } else {
      const delta = Number(body.extend_minutes);
      if (!Number.isFinite(delta) || delta === 0) throw demoApiError(400, "extend_minutes must be a non-zero number");
      newEndMs = Date.parse(contest.end_at) + delta * 60_000;
    }
    if (newEndMs <= Date.parse(contest.start_at)) throw demoApiError(400, "End time must be after the start time.");
    const newEndAt = new Date(newEndMs).toISOString();
    updateDemoContest(slug, { end_at: newEndAt, end_at_updated_at: now });
    let endedCount = 0;
    if (body.end_now === true) {
      for (const session of readDemoSessions()) {
        if (session.contest_slug === slug && session.status !== "ended") {
          upsertDemoSession({ ...session, status: "ended", blocked_by_session_id: null });
          endedCount += 1;
        }
      }
    }
    return { ok: true, start_at: contest.start_at, end_at: newEndAt, server_now: now, ended_count: endedCount };
  }
  return request<ExamTimeResponse>("/api/admin/contest-exam-time", {
    method: "POST",
    headers: { "x-admin-password": password },
    body: JSON.stringify({ slug, ...body })
  });
}

// S-D (vision §10.3): PUBLIC access-code -> contest resolver for the landing
// page. Throws ApiError 400 invalid_code / 404 code_not_found (and 429 when
// rate-limited server-side) — the landing page renders the message inline.
export async function resolveAccessCodeApi(code: string): Promise<{ slug: string; name: string }> {
  if (demoMode) {
    await wait(150);
    const cleaned = code.trim().toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(cleaned)) throw demoApiError(400, "invalid_code");
    const hit = demoContestsList().find((contest) => contest.status === "open" && contest.access_code === cleaned);
    if (!hit) throw demoApiError(404, "code_not_found");
    return { slug: hit.slug, name: hit.name };
  }
  return request<{ slug: string; name: string }>("/api/access-code", {
    method: "POST",
    body: JSON.stringify({ code })
  });
}

// S-D: per-contest pre-session config. UNLIKE the legacy fetchExamConfig this
// THROWS on failure — the candidate app must distinguish "unknown/closed
// contest" (-> access-code landing) from a transient fetch error.
export async function fetchContestExamConfig(slug: string): Promise<ContestExamConfig> {
  if (demoMode) {
    await wait(120);
    const contest = demoContestsList().find((item) => item.slug === slug);
    if (!contest) throw demoApiError(400, "unknown_contest");
    if (contest.status !== "open") throw demoApiError(403, "contest_not_open");
    if (contest.legacy) {
      const roster = getDemoRoster();
      return {
        contest_slug: contest.slug,
        contest_name: contest.name,
        identity_label: contest.identity_label,
        identity_mode: "legacy_username",
        roster_required: Boolean(roster),
        unique_id_label: roster?.unique_id_column ?? "",
        rooms: getDemoSettings()?.rooms ?? [],
        room_gate_enabled: contest.room_gate_enabled,
        enforcement: demoEnforcement(),
        camera_recording: demoCameraRecording(),
        start_at: contest.start_at,
        end_at: contest.end_at,
        server_now: new Date().toISOString()
      };
    }
    return {
      contest_slug: contest.slug,
      contest_name: contest.name,
      identity_label: contest.identity_label,
      identity_mode: "person",
      roster_required: Boolean(getDemoPersonRoster(contest.slug)),
      unique_id_label: contest.identity_label,
      rooms: contest.rooms,
      room_gate_enabled: contest.room_gate_enabled,
      enforcement: demoEnforcement(),
      camera_recording: demoCameraRecording(),
      start_at: contest.start_at,
      end_at: contest.end_at,
      server_now: new Date().toISOString()
    };
  }
  return request<ContestExamConfig>(`/api/exam-config?contest=${encodeURIComponent(slug)}`, { method: "GET" });
}

// S-D candidate routing: does the LEGACY settings-driven exam exist? Decides
// form-vs-landing for the NO-?contest= candidate URL. THROWS on failure — the
// router fails OPEN to the legacy flow (candidateRouting.routeForNoParam).
export async function fetchCandidateRoute(): Promise<{ legacy_configured: boolean }> {
  if (demoMode) {
    await wait(80);
    return { legacy_configured: Boolean(getDemoSettings()) };
  }
  return request<{ legacy_configured: boolean }>("/api/candidate-route", { method: "GET" });
}

// ---- S-D: templates list (the create-from-template picker) -------------------
// Full Templates tab CRUD is the S-I frontend wave; the Contests tab only
// needs the LIST to instantiate from.

export type ContestTemplateSummary = {
  slug: string;
  name: string;
  archived: boolean;
  preset: boolean;
  problem_count: number;
  total_points: number;
  updated_at: string;
};

type DemoTemplate = {
  slug: string;
  name: string;
  archived: boolean;
  preset: boolean;
  problems: Array<{ problem_id: string; points: number | null; order: number }>;
  defaults: { identity_label: string; room_gate_enabled: boolean; duration_minutes: number };
};

const DEMO_TEMPLATES: DemoTemplate[] = [
  {
    slug: "demo-aptitude-r1",
    name: "Demo Aptitude — Round 1",
    archived: false,
    preset: false,
    problems: [
      { problem_id: "sum-two", points: null, order: 0 },
      { problem_id: "reverse-words", points: null, order: 1 },
      { problem_id: "max-window-sum", points: null, order: 2 }
    ],
    defaults: { identity_label: "Roll Number", room_gate_enabled: true, duration_minutes: 120 }
  },
  {
    slug: "system-check",
    name: "System check",
    archived: false,
    preset: true,
    problems: [{ problem_id: "sum-two", points: null, order: 0 }],
    defaults: { identity_label: "Candidate ID", room_gate_enabled: false, duration_minutes: 30 }
  }
];

function demoTemplateBySlug(slug: string): DemoTemplate {
  const hit = DEMO_TEMPLATES.find((template) => template.slug === slug);
  if (!hit) throw demoApiError(404, "template_not_found");
  return hit;
}

export async function fetchTemplates(password: string): Promise<ContestTemplateSummary[]> {
  if (demoMode) {
    await wait(120);
    assertDemoAdmin(password);
    return DEMO_TEMPLATES.map((template) => ({
      slug: template.slug,
      name: template.name,
      archived: template.archived,
      preset: template.preset,
      problem_count: template.problems.length,
      total_points: 100 * template.problems.length,
      updated_at: ""
    }));
  }
  const response = await request<{ templates: ContestTemplateSummary[] }>("/api/admin/templates", {
    method: "GET",
    headers: { "x-admin-password": password }
  });
  return response.templates;
}

// ---- S3: invigilator portal + room start gate -------------------------------

export const invigilatorPassword = import.meta.env.VITE_INVIGILATOR_PASSWORD ?? "";
// When set, the portal unlock compares sha256(typed) to this hash so the plain
// password never ships in the bundle (mirrors VITE_ADMIN_PASSWORD_HASH).
export const invigilatorPasswordHash = (import.meta.env.VITE_INVIGILATOR_PASSWORD_HASH ?? "").trim().toLowerCase();
const demoRoomGatesKey = "aerele-proctor-demo-room-gates";

// S-D (vision I1): resolve the OPTIONAL invigilator ?contest= in demo mode.
// null = the legacy settings-driven portal (today's behavior, bit-for-bit).
function demoInvigilatorContest(contest?: string): ContestSummary | null {
  if (!contest) return null;
  const hit = demoContestsList().find((item) => item.slug === contest);
  if (!hit) throw demoApiError(400, "unknown_contest");
  return hit;
}

// S-D parity with backend requireInvigilatorFor: the credential may be the
// global invigilator password, the admin password, or — for a NAMED non-legacy
// contest — that contest's own invigilator_key. A key never authenticates
// another contest or the legacy (no-contest) portal.
function assertDemoInvigilator(password: string, contest?: ContestSummary | null) {
  if (invigilatorPassword && password === invigilatorPassword) return;
  if (adminPassword && password === adminPassword) return;
  if (contest && !contest.legacy && contest.invigilator_key && password === contest.invigilator_key) return;
  throw new Error("Invalid invigilator password.");
}

function invigilatorHeaders(password: string) {
  return { "x-invigilator-password": password };
}

// S-D: with a body/query contest the real backend scopes everything to it.
function invigilatorContestQuery(contest?: string) {
  return contest ? `&contest=${encodeURIComponent(contest)}` : "";
}

function invigilatorContestBody(contest?: string) {
  return contest ? { contest } : {};
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

// Backend gate docs are keyed gate:{contest}:{room}. The demo store mirrors
// that for NON-legacy contests; the legacy portal keeps the historical bare
// roomKey so existing demo state survives.
function demoGateKey(contest: ContestSummary | null, roomKey: string): string {
  return contest && !contest.legacy ? `${contest.slug}:${roomKey}` : roomKey;
}

// Is the room start gate enabled for this portal view? Contest mode reads the
// CONTEST doc (S-I snapshot field); legacy reads the demo settings.
function demoGateEnabled(contest: ContestSummary | null): boolean {
  if (contest && !contest.legacy) return contest.room_gate_enabled === true;
  return getDemoSettings()?.room_gate_enabled === true;
}

export async function fetchInvigilatorOverview(password: string, contest?: string): Promise<InvigilatorOverviewResponse> {
  if (demoMode) {
    await wait(120);
    const pinned = demoInvigilatorContest(contest);
    assertDemoInvigilator(password, pinned);
    if (pinned && !pinned.legacy) {
      // Backend parity: the CONFIGURED contest rooms union the rooms its
      // sessions actually carry (demo person sessions live in localStorage).
      const sessionRooms = readDemoSessions()
        .filter((s) => s.contest_slug === pinned.slug)
        .map((s) => String(s.room || "").trim())
        .filter(Boolean);
      return {
        contest_slug: pinned.slug,
        room_gate_enabled: pinned.room_gate_enabled === true,
        rooms: [...new Set([...pinned.rooms, ...sessionRooms])].sort((a, b) => a.localeCompare(b)),
        has_unassigned: false
      };
    }
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
  return request<InvigilatorOverviewResponse>(
    `/api/invigilator/overview${contest ? `?contest=${encodeURIComponent(contest)}` : ""}`,
    { method: "GET", headers: invigilatorHeaders(password) }
  );
}

export async function fetchInvigilatorRoom(password: string, room: string, contest?: string): Promise<InvigilatorRoomResponse> {
  if (demoMode) {
    await wait(120);
    const pinned = demoInvigilatorContest(contest);
    assertDemoInvigilator(password, pinned);
    const roomKey = roomKeyForLabel(room);
    const roomLabel = roomKey === "_" ? "" : room;
    const personContest = pinned && !pinned.legacy ? pinned : null;
    const gate = readDemoRoomGates()[demoGateKey(personContest, roomKey)] || null;
    // S-D scoping: a pinned NON-legacy contest sees ITS OWN sessions — the
    // person sessions this browser's demo candidate flow created — never the
    // legacy demo population (and vice versa).
    type DemoRoomDoc = {
      session_id: string; status: ServerSessionStatus; name: string;
      hackerrank_username: string; roll_number: string; roster_unique_id: string;
      stale: boolean; exam_started_at: string | null;
      enforcement_exemptions: EnforcementExemptions; locked_reason: string | null;
      created_at: string;
    };
    const docs: DemoRoomDoc[] = personContest
      ? readDemoSessions()
          .filter((s) => s.contest_slug === personContest.slug && String(s.room || "") === roomLabel)
          .map((s) => ({
            session_id: s.session_id,
            status: s.status,
            name: s.name,
            hackerrank_username: s.hackerrank_username,
            roll_number: s.roster_unique_id,
            roster_unique_id: s.roster_unique_id,
            stale: false,
            exam_started_at: s.exam_started_at ?? null,
            enforcement_exemptions: { ...(s.enforcement_exemptions ?? {}) },
            locked_reason: s.locked_reason ?? null,
            created_at: new Date().toISOString()
          }))
      : DEMO_ALL_SESSIONS
          .filter((s) => String(s.room || "") === roomLabel)
          .map((s) => ({
            // M13 parity: NO session_id leaves via the row projection below.
            // Roll number / roster id mirror the session-card demo derivation
            // (the demo roster's unique column IS the roll number).
            session_id: s.session_id,
            status: s.status,
            name: s.name,
            hackerrank_username: s.hackerrank_username,
            roll_number: `R-${s.session_id.slice(-4).toUpperCase()}`,
            roster_unique_id: `R-${s.session_id.slice(-4).toUpperCase()}`,
            stale: s.status === "active" && s.stale === true,
            exam_started_at: gate?.mode === "open" ? gate.opened_at ?? null : null,
            enforcement_exemptions: { ...s.enforcement_exemptions },
            // F5.6 wave-2 parity: demo convention treats a locked row as an
            // enforcement lock (mirrors the demo sessions-list derivation).
            locked_reason: s.status === "locked" ? "fullscreen_enforcement" : null,
            created_at: s.created_at
          }));
    const stats = { live: 0, locked: 0, pending_approval: 0, finished: 0, disconnected: 0, started: 0, total: 0 };
    for (const s of docs) {
      stats.total += 1;
      if (s.exam_started_at || gate?.mode === "open") stats.started += 1; // demo approximation
      if (s.status === "active") {
        stats.live += 1;
        if (s.stale) stats.disconnected += 1;
      } else if (s.status === "locked") stats.locked += 1;
      else if (s.status === "pending_approval") stats.pending_approval += 1;
      else if (s.status === "ended") stats.finished += 1;
    }
    const sessions: InvigilatorSessionRow[] = docs
      .slice()
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")))
      .map((s) => ({
        name: s.name,
        hackerrank_username: s.hackerrank_username,
        roll_number: s.roll_number,
        roster_unique_id: s.roster_unique_id,
        status: s.status,
        stale: s.stale,
        exam_started_at: s.exam_started_at,
        // F5.5: drives the room dashboard's per-student exemption toggles.
        enforcement_exemptions: s.enforcement_exemptions,
        locked_reason: s.locked_reason,
        created_at: s.created_at
      }));
    // F9.3 parity (Wave6): honour show_to_invigilator per type — DEFAULT ALL OFF,
    // and catalog-unknown types are never shared (no opt-in switch exists). M12/M13
    // parity: NO detail, NO session_id on the projected alert rows. The demo alert
    // store belongs to the LEGACY population — a pinned contest's feed starts empty.
    const alertSettings = readDemoAlertSettings();
    const alerts: InvigilatorAlert[] = personContest ? [] : readDemoAlerts()
      .filter((a) => String(a.room || "") === roomLabel && !a.archived)
      .filter((a) => {
        const config = alertSettings.proctor[a.type];
        return config ? config.show_to_invigilator === true : false;
      })
      .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
      .slice(0, 100)
      .map((a) => ({
        id: a.id, type: a.type, severity: a.severity, timestamp: a.timestamp,
        title: a.title, hackerrank_username: a.hackerrank_username
      }));
    return {
      contest_slug: personContest ? personContest.slug : DEMO_CONTEST_SLUG,
      room: roomLabel || null,
      room_key: roomKey,
      room_gate_enabled: demoGateEnabled(personContest),
      stats, sessions, gate, alerts,
      disconnected_staleness_ms: 45000
    };
  }
  return request<InvigilatorRoomResponse>(
    `/api/invigilator/room?room=${encodeURIComponent(room)}${invigilatorContestQuery(contest)}`,
    { method: "GET", headers: invigilatorHeaders(password) }
  );
}

export async function releaseRoomCode(
  password: string, room: string, invigilatorName: string, regenerate = false, contest?: string
): Promise<RoomGateActionResponse> {
  if (demoMode) {
    await wait(150);
    const pinned = demoInvigilatorContest(contest);
    assertDemoInvigilator(password, pinned);
    const personContest = pinned && !pinned.legacy ? pinned : null;
    if (!demoGateEnabled(personContest)) throw new Error("room_gate_disabled");
    const store = readDemoRoomGates();
    const roomKey = roomKeyForLabel(room);
    const storeKey = demoGateKey(personContest, roomKey);
    const existing = store[storeKey];
    const contestSlug = personContest ? personContest.slug : DEMO_CONTEST_SLUG;
    if (existing && existing.mode === "otp" && existing.otp && !regenerate) {
      return { ok: true, contest_slug: contestSlug, gate: existing };
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
      // Backend parity: a full gate rewrite preserves a minted unlock code.
      unlock_otp: existing?.unlock_otp ?? "",
      unlock_released_at: existing?.unlock_released_at ?? null,
      unlock_released_by: existing?.unlock_released_by ?? "",
      updated_at: now
    };
    store[storeKey] = gate;
    writeDemoRoomGates(store);
    return { ok: true, contest_slug: contestSlug, gate };
  }
  return request<RoomGateActionResponse>("/api/invigilator/release-code", {
    method: "POST",
    headers: invigilatorHeaders(password),
    body: JSON.stringify({ room, invigilator_name: invigilatorName, ...(regenerate ? { regenerate: true } : {}), ...invigilatorContestBody(contest) })
  });
}

export async function openRoom(password: string, room: string, invigilatorName: string, contest?: string): Promise<RoomGateActionResponse> {
  if (demoMode) {
    await wait(150);
    const pinned = demoInvigilatorContest(contest);
    assertDemoInvigilator(password, pinned);
    const personContest = pinned && !pinned.legacy ? pinned : null;
    if (!demoGateEnabled(personContest)) throw new Error("room_gate_disabled");
    const store = readDemoRoomGates();
    const roomKey = roomKeyForLabel(room);
    const storeKey = demoGateKey(personContest, roomKey);
    const existing = store[storeKey];
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
      // Backend parity: a full gate rewrite preserves a minted unlock code.
      unlock_otp: existing?.unlock_otp ?? "",
      unlock_released_at: existing?.unlock_released_at ?? null,
      unlock_released_by: existing?.unlock_released_by ?? "",
      updated_at: now
    };
    store[storeKey] = gate;
    writeDemoRoomGates(store);
    return { ok: true, contest_slug: personContest ? personContest.slug : DEMO_CONTEST_SLUG, gate };
  }
  return request<RoomGateActionResponse>("/api/invigilator/open-room", {
    method: "POST",
    headers: invigilatorHeaders(password),
    body: JSON.stringify({ room, invigilator_name: invigilatorName, ...invigilatorContestBody(contest) })
  });
}

// F5.6 wave-2 fix: mint (or re-display) the room's ENFORCEMENT-UNLOCK code —
// a SEPARATE namespace from the start OTP (which every candidate in an
// OTP-gated room personally typed). Deliberately NOT gated on
// room_gate_enabled: in the default deployment (block mode, start gate off)
// this is the room proctor's only code path. Demo mode mirrors the backend
// against the shared room-gate store.
export async function releaseUnlockCode(
  password: string, room: string, invigilatorName: string, regenerate = false, contest?: string
): Promise<RoomGateActionResponse> {
  if (demoMode) {
    await wait(150);
    const pinned = demoInvigilatorContest(contest);
    assertDemoInvigilator(password, pinned);
    const personContest = pinned && !pinned.legacy ? pinned : null;
    const store = readDemoRoomGates();
    const roomKey = roomKeyForLabel(room);
    const storeKey = demoGateKey(personContest, roomKey);
    const existing = store[storeKey];
    const contestSlug = personContest ? personContest.slug : DEMO_CONTEST_SLUG;
    if (existing?.unlock_otp && !regenerate) {
      return { ok: true, contest_slug: contestSlug, gate: existing };
    }
    const now = new Date().toISOString();
    const gate: RoomGate = {
      room: roomKey === "_" ? "" : room,
      room_key: roomKey,
      // The start-gate state stays untouched ("none" can never release a start).
      mode: existing?.mode ?? "none",
      otp: existing?.otp ?? "",
      released_at: existing?.released_at ?? null,
      released_by: existing?.released_by ?? "",
      opened_at: existing?.opened_at ?? null,
      opened_by: existing?.opened_by ?? "",
      unlock_otp: String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0"),
      unlock_released_at: now,
      unlock_released_by: invigilatorName,
      updated_at: now
    };
    store[storeKey] = gate;
    writeDemoRoomGates(store);
    return { ok: true, contest_slug: contestSlug, gate };
  }
  return request<RoomGateActionResponse>("/api/invigilator/unlock-code", {
    method: "POST",
    headers: invigilatorHeaders(password),
    body: JSON.stringify({ room, invigilator_name: invigilatorName, ...(regenerate ? { regenerate: true } : {}), ...invigilatorContestBody(contest) })
  });
}

// F5.6 wave-2 fix: release one student's ENFORCEMENT lock from the room
// dashboard. Least privilege mirrors invigilatorExempt: addressed by room +
// username, never session_id. Admin locks are refused server-side
// (not_enforcement_locked). Demo mode mutates the shared admin population row
// (demo convention: a locked demo row is an enforcement lock).
export async function invigilatorUnlock(
  password: string, room: string, username: string, contest?: string
): Promise<{ ok: boolean; username: string; status: string }> {
  if (demoMode) {
    await wait(120);
    const pinned = demoInvigilatorContest(contest);
    assertDemoInvigilator(password, pinned);
    const roomLabel = roomKeyForLabel(room) === "_" ? "" : room;
    if (pinned && !pinned.legacy) {
      // Person sessions live in the localStorage demo store — release the
      // newest locked one for this candidate display id in this room.
      const locked = readDemoSessions()
        .filter((s) => s.contest_slug === pinned.slug && String(s.room || "") === roomLabel)
        .filter((s) => s.status === "locked" && (s.hackerrank_username === username || s.roster_unique_id === username));
      if (!locked.length) throw demoApiError(404, "no_locked_session_in_room");
      const session = locked[locked.length - 1];
      upsertDemoSession({ ...session, status: "active", locked_reason: null });
      return { ok: true, username: session.hackerrank_username, status: "active" };
    }
    const usernameNorm = normalizeUsername(username);
    const locked = DEMO_ALL_SESSIONS
      .filter((row) => normalizeUsername(row.hackerrank_username) === usernameNorm && row.status === "locked")
      .filter((row) => String(row.room || "") === roomLabel)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    if (!locked.length) throw demoApiError(404, "no_locked_session_in_room");
    const row = locked[0];
    row.status = "active";
    return { ok: true, username: row.hackerrank_username, status: "active" };
  }
  return request<{ ok: boolean; username: string; status: string }>("/api/invigilator/unlock", {
    method: "POST",
    headers: invigilatorHeaders(password),
    body: JSON.stringify({ room, username, ...invigilatorContestBody(contest) })
  });
}

// F5.5: per-student enforcement exemption from the invigilator room dashboard.
// Least privilege: addressed by room + username (never session_id). Demo mode
// mutates the shared admin population row in place (same pattern as the demo
// session actions), so the next 5 s poll reflects the toggle.
export async function invigilatorExempt(
  password: string,
  room: string,
  username: string,
  exemptions: EnforcementExemptions,
  contest?: string
): Promise<{ ok: boolean; username: string; enforcement_exemptions: EnforcementExemptions }> {
  if (demoMode) {
    await wait(120);
    const pinned = demoInvigilatorContest(contest);
    assertDemoInvigilator(password, pinned);
    const roomLabel = roomKeyForLabel(room) === "_" ? "" : room;
    if (pinned && !pinned.legacy) {
      const live = readDemoSessions()
        .filter((s) => s.contest_slug === pinned.slug && String(s.room || "") === roomLabel)
        .filter((s) => s.status !== "ended" && (s.hackerrank_username === username || s.roster_unique_id === username));
      if (!live.length) throw demoApiError(404, "no_live_session_in_room");
      const session = live[live.length - 1];
      const merged = { ...sanitizeDemoExemptions(session.enforcement_exemptions), ...sanitizeDemoExemptions(exemptions) };
      upsertDemoSession({ ...session, enforcement_exemptions: merged });
      return { ok: true, username: session.hackerrank_username, enforcement_exemptions: { ...merged } };
    }
    const usernameNorm = normalizeUsername(username);
    const live = DEMO_ALL_SESSIONS
      .filter((row) => normalizeUsername(row.hackerrank_username) === usernameNorm && row.status !== "ended")
      .filter((row) => String(row.room || "") === roomLabel)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    if (!live.length) throw demoApiError(404, "no_live_session_in_room");
    const row = live[0];
    row.enforcement_exemptions = { ...sanitizeDemoExemptions(row.enforcement_exemptions), ...sanitizeDemoExemptions(exemptions) };
    return { ok: true, username: row.hackerrank_username, enforcement_exemptions: { ...row.enforcement_exemptions } };
  }
  return request<{ ok: boolean; username: string; enforcement_exemptions: EnforcementExemptions }>("/api/invigilator/exempt", {
    method: "POST",
    headers: invigilatorHeaders(password),
    body: JSON.stringify({ room, username, exemptions, ...invigilatorContestBody(contest) })
  });
}

// Candidate-side gate poll/unlock. No code = status poll; with a code it
// attempts the room OTP. Demo mode mirrors the backend against localStorage.
export async function pollRoomGate(sessionId: string, code?: string): Promise<RoomGatePollResponse> {
  if (demoMode) {
    await wait(100);
    const session = readDemoSessions().find((item) => item.session_id === sessionId);
    if (!session) throw new Error("Session not found");
    // S-D: a person-contest session reads the gate flag from ITS contest doc
    // and its gate from the per-contest store (legacy keeps today's path).
    const sessionContest = demoContestsList().find(
      (item) => item.slug === session.contest_slug && !item.legacy
    ) ?? null;
    if (!demoGateEnabled(sessionContest)) return { gate_enabled: false, exam_started: true };
    if (session.exam_started_at) {
      return { gate_enabled: true, exam_started: true, exam_started_at: session.exam_started_at };
    }
    const gate = readDemoRoomGates()[demoGateKey(sessionContest, roomKeyForLabel(session.room))];
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

// F5.3: the candidate client reports a tripped enforcement ladder (countdown
// expired / exit limit exceeded). The SERVER decides lock vs alert-only from
// its own settings. Demo mode mirrors the backend against localStorage.
export async function reportEnforcementViolation(
  sessionId: string,
  phase: "countdown_expired" | "exit_limit",
  exitCount: number
): Promise<EnforcementViolationResponse> {
  if (demoMode) {
    await wait(120);
    const session = readDemoSessions().find((item) => item.session_id === sessionId);
    if (!session) throw demoApiError(404, "Session not found");
    if (session.enforcement_exemptions?.fullscreen === true) {
      return { ok: true, locked: false, exempt: true };
    }
    if (demoEnforcement().mode === "alert_first") {
      return { ok: true, locked: false, mode: "alert_first" };
    }
    upsertDemoSession({ ...session, status: "locked", locked_reason: "fullscreen_enforcement" });
    return { ok: true, locked: true, locked_reason: "fullscreen_enforcement", mode: "block" };
  }
  return request<EnforcementViolationResponse>("/api/session/enforcement-violation", {
    method: "POST",
    body: JSON.stringify({ session_id: sessionId, phase, exit_count: exitCount })
  });
}

// F5.6 L2 release: candidate-side unlock of an ENFORCEMENT lock with the
// room's dedicated UNLOCK code (gate.unlock_otp — wave-2 fix: never the start
// OTP, which the candidate typed themselves). Throws ApiError invalid_code /
// no_unlock_code / not_enforcement_locked / too_many_attempts.
export async function unlockEnforcementGate(sessionId: string, code: string): Promise<{ ok: boolean; status: string }> {
  if (demoMode) {
    await wait(150);
    const session = readDemoSessions().find((item) => item.session_id === sessionId);
    if (!session) throw demoApiError(404, "Session not found");
    if (session.status !== "locked" || session.locked_reason !== "fullscreen_enforcement") {
      throw demoApiError(403, "not_enforcement_locked");
    }
    const gate = readDemoRoomGates()[roomKeyForLabel(session.room)];
    if (!gate?.unlock_otp) throw demoApiError(403, "no_unlock_code");
    if (gate.unlock_otp === String(code).trim()) {
      upsertDemoSession({ ...session, status: "active", locked_reason: null });
      return { ok: true, status: "active" };
    }
    throw demoApiError(403, "invalid_code");
  }
  return request<{ ok: boolean; status: string }>("/api/session/unlock-gate", {
    method: "POST",
    body: JSON.stringify({ session_id: sessionId, code })
  });
}

// ---- S4: problem bank (admin authoring) -------------------------------------

// v2 (F12.2): the demo SEED problems gained per-language starter stubs. The
// seed is read LIVE (not persisted), but any problems blob an admin authored in
// an earlier demo session would shadow the seed without stubs — a fresh key
// drops those so demo mode reliably surfaces the new stubs.
const demoProblemsKey = "aerele-proctor-demo-problems-v2";

// Demo mirror of the backend's built-in seed (problems.mjs SEED_PROBLEMS).
// S-I §6: 3 published problems (with tags) so the multi-problem workspace
// demos meaningfully — varied points feed the Total/Solved header and the
// per-problem demo submit profiles produce varied status chips.
const DEMO_SEED_PROBLEMS: ProblemDoc[] = [{
  id: "sum-two",
  title: "Sum of Two Numbers",
  statement: "Read two integers a and b on one line separated by a space. Print a + b.",
  languages: ["python", "cpp", "java", "javascript"],
  cpuTimeLimit: 5, memoryLimit: 128000, points: 100,
  scoring: "per_test", status: "published", tags: ["math", "warmup"],
  // F12.2: example per-language starter stubs so demo mode shows the feature —
  // a read-the-input skeleton with the logic left as a TODO.
  stubs: {
    python: "a, b = map(int, input().split())\n# TODO: print a + b\n",
    cpp: "#include <bits/stdc++.h>\nusing namespace std;\nint main() {\n    long long a, b;\n    cin >> a >> b;\n    // TODO: print a + b\n    return 0;\n}\n",
    java: "import java.util.*;\npublic class Main {\n    public static void main(String[] args) {\n        Scanner sc = new Scanner(System.in);\n        long a = sc.nextLong(), b = sc.nextLong();\n        // TODO: print a + b\n    }\n}\n",
    javascript: "const [a, b] = require(\"fs\").readFileSync(0, \"utf8\").trim().split(/\\s+/).map(Number);\n// TODO: print a + b\n"
  },
  sampleTests: [{ input: "2 3\n", expected: "5" }, { input: "10 20\n", expected: "30" }],
  hiddenTests: [
    { input: "0 0\n", expected: "0" }, { input: "-5 5\n", expected: "0" },
    { input: "1000000 1\n", expected: "1000001" }, { input: "-100 -200\n", expected: "-300" }
  ]
}, {
  id: "reverse-words",
  title: "Reverse the Words",
  statement: "Read one line of text. Print the words in reverse order, separated by single spaces.",
  languages: ["python", "cpp", "java", "javascript"],
  cpuTimeLimit: 5, memoryLimit: 128000, points: 150,
  scoring: "per_test", status: "published", tags: ["strings"],
  stubs: {
    python: "words = input().split()\n# TODO: print the words in reverse order\n",
    javascript: "const words = require(\"fs\").readFileSync(0, \"utf8\").trim().split(/\\s+/);\n// TODO: print the words in reverse order\n"
  },
  sampleTests: [{ input: "hello world\n", expected: "world hello" }, { input: "a b c\n", expected: "c b a" }],
  hiddenTests: [
    { input: "one\n", expected: "one" }, { input: "to be or not\n", expected: "not or be to" },
    { input: "x y\n", expected: "y x" }, { input: "alpha beta gamma\n", expected: "gamma beta alpha" }
  ]
}, {
  id: "max-window-sum",
  title: "Maximum Window Sum",
  statement: "Read n and k on one line, then n integers on the next line. Print the maximum sum over any k consecutive integers.",
  languages: ["python", "cpp", "java", "javascript"],
  cpuTimeLimit: 5, memoryLimit: 128000, points: 50,
  scoring: "per_test", status: "published", tags: ["arrays", "sliding-window"],
  stubs: {
    python: "n, k = map(int, input().split())\nnums = list(map(int, input().split()))\n# TODO: print the maximum sum over any k consecutive integers\n"
  },
  sampleTests: [{ input: "5 2\n1 2 3 4 5\n", expected: "9" }],
  hiddenTests: [
    { input: "3 1\n-1 -2 -3\n", expected: "-1" }, { input: "4 4\n1 1 1 1\n", expected: "4" },
    { input: "6 3\n2 1 5 1 3 2\n", expected: "9" }, { input: "5 2\n5 -1 5 -1 5\n", expected: "4" }
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

// S-I §6 demo shim (mirrors backend contestProblemEntries): non-empty contest
// problems[] > legacy settings problem_id > []. The legacy demo deployment
// therefore keeps today's single-problem behavior bit-for-bit.
function demoProblemEntries(source: { problems?: Array<{ problem_id: string; points: number | null; order: number }>; problem_id?: string } | null): Array<{ problem_id: string; points: number | null; order: number }> {
  if (source && Array.isArray(source.problems) && source.problems.length) {
    return [...source.problems].sort((a, b) => a.order - b.order);
  }
  if (source?.problem_id) return [{ problem_id: source.problem_id, points: null, order: 0 }];
  return [];
}

// Candidate view of a demo contest's problems (backend contestProblemsPublic
// parity) — published only, never hiddenTests, points = EFFECTIVE points
// (contest entry override applied), plus `order`. A legacy session (no
// contest / legacy contest) reads the demo settings problem_id.
function demoContestProblems(contest: ContestSummary | null): PublicProblem[] {
  const source = contest && !contest.legacy ? contest : { problem_id: getDemoSettings()?.problem_id || "" };
  const problems: PublicProblem[] = [];
  for (const entry of demoProblemEntries(source)) {
    const p = findDemoProblem(entry.problem_id);
    if (!p || p.status !== "published") continue;
    problems.push({
      id: p.id, title: p.title, statement: p.statement, languages: p.languages,
      points: entry.points ?? p.points ?? 100, cpuTimeLimit: p.cpuTimeLimit, memoryLimit: p.memoryLimit,
      sampleTests: p.sampleTests,
      // F12.2: carry per-language stubs into the demo candidate payload (omitted
      // when the problem has none — mirrors the backend's contestProblemsPublic).
      ...(p.stubs && Object.keys(p.stubs).length ? { stubs: p.stubs } : {}),
      order: entry.order
    });
  }
  return problems;
}

export async function fetchProblems(password: string): Promise<ProblemSummary[]> {
  if (demoMode) {
    await wait(120);
    assertDemoAdmin(password);
    return readDemoProblems()
      .map((p) => ({
        id: p.id, title: p.title, status: p.status, points: p.points, scoring: p.scoring,
        languages: p.languages, tags: p.tags ?? [], sample_count: p.sampleTests.length, hidden_count: p.hiddenTests.length,
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
