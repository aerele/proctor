export type StudentForm = {
  // S-A: the typed identity value (UI label "Candidate ID"). Sent on the wire
  // as BOTH candidate_id and the frozen hackerrank_username until S-E
  // (identity.ts sessionStartPayload).
  candidate_id: string;
  name: string;
  roll_number: string;
  email: string;
  room: string;
  consent_accepted: boolean;
  // S2: the roster unique-ID the candidate confirmed ("" when no roster / not
  // yet confirmed). Sent to /api/session/start, which re-verifies it.
  roster_unique_id: string;
};

// Lifecycle status of the session as reported by the backend (Phase 2). Distinct
// from the client UI `SessionStatus` below: this is the server-side session doc
// state, the UI status is the recorder/screen state.
export type ServerSessionStatus = "active" | "pending_approval" | "locked" | "ended";

// ---- F5.3/F5.5: fullscreen enforcement + per-session exemptions ------------

export type EnforcementMode = "block" | "alert_first";

// Server-validated enforcement knobs, served via exam-config / start / heartbeat.
export type EnforcementConfigPayload = {
  fullscreen_reentry_seconds: number;
  fullscreen_exit_limit: number;
  mode: EnforcementMode;
};

// Per-session exemptions (admin session-action "exempt" / invigilator toggle).
export type EnforcementExemptions = {
  fullscreen?: boolean;
  switch_away?: boolean;
};

// ---- F10.1: separate low-res camera recording -------------------------------
// Server-validated camera-recording knobs (default ENABLED / 10 fps / 640 w),
// served via exam-config (pre-session consent copy), admin settings, and the
// session-start upload_config (the recorder's authoritative source). The wire
// shape matches cameraRecording.ts's CameraRecordingConfig.
export type CameraRecordingConfigPayload = {
  enabled: boolean;
  fps: number;
  width: number;
};

// POST /api/session/enforcement-violation — the server decides lock vs alert.
export type EnforcementViolationResponse = {
  ok: boolean;
  locked: boolean;
  exempt?: boolean;
  locked_reason?: string;
  mode?: EnforcementMode;
};

export type SessionStartResponse = {
  session_id: string;
  status?: ServerSessionStatus;
  hackerrank_username?: string;
  /** S-A accept-both: newer backends deliver this alongside (or instead of)
   * the frozen hackerrank_username — display via identity.ts candidateIdOf. */
  candidate_id?: string;
  name?: string;
  room?: string;
  contest_slug?: string;
  storage_prefix?: string;
  blocked_by_session_id?: string | null;
  start_ip?: string;
  contest_url?: string;
  /** S3: when true the client holds at the room-code screen until released. */
  room_gate_enabled?: boolean;
  /** F5.3: enforcement knobs + this session's exemptions + lock reason. */
  enforcement?: EnforcementConfigPayload;
  enforcement_exemptions?: EnforcementExemptions;
  locked_reason?: string | null;
  /** S4: candidate-facing problem assigned to this session (null when
   * unassigned). S-I: one-release compatibility alias = problems[0] without
   * `order`; prefer `problems` when present. */
  problem?: PublicProblem | null;
  /** S-I §3.4: the contest's ORDERED candidate-facing problems. Absent on
   * older backends (fall back to `problem`). */
  problems?: PublicProblem[];
  /** S-I §3.4: per-problem submit history for this session — restores chips/
   * attempts/total after a reload. Keyed by problem id. */
  submissions_summary?: Record<string, ProblemSubmissionSummary>;
  /** S-I §3.4: max stored submissions per (session, problem). */
  submit_budget?: number;
  upload_config: {
    chunk_seconds: number;
    video_bits_per_second: number;
    media_bits_per_second?: number;
    audio_bits_per_second?: number;
    max_width: number;
    max_frame_rate: number;
    /** F10.1: separate low-res camera stream knobs (absent on an older
     * backend — the recorder then records NO camera, see shouldRecordCamera). */
    camera?: CameraRecordingConfigPayload;
  };
  heartbeat_interval_seconds: number;
  // S5: authoritative exam end time + the server clock at response time (for
  // client skew correction). Empty/absent when no schedule is configured or
  // the backend predates S5.
  end_at?: string;
  server_now?: string;
  // F1 (e2e finding): server-side chunk-index continuation knowledge — counts
  // of issued upload URLs and the exact per-kind index high-water marks. The
  // recorder resumes its chunk count from max(these, the local sessionStorage
  // hwm) so a restarted stint never overwrites prior chunks. Absent on a
  // pre-F1 backend (treated as 0 — old behavior).
  chunk_count?: number;
  camera_chunk_count?: number;
  screen_chunk_index_hwm?: number;
  camera_chunk_index_hwm?: number;
  // F7 (e2e finding): the session's server-side start — anchors the candidate
  // ELAPSED counter so it survives recorder restarts and reloads.
  created_at?: string;
};

// Event `type` is an open string (the backend stores arbitrary types). S1
// exam-shell client-emitted types riding this same pipeline:
//   "fullscreen_enter" | "fullscreen_exit" (detail.expected=true at test end)
//   "onboarding_stage" ({from,to,label}) | "topbar_hidden" | "topbar_restored".
export type ProctorEvent = {
  type: string;
  timestamp: string;
  detail?: Record<string, unknown>;
  visibility_state?: DocumentVisibilityState;
};

export type HeartbeatResponse = {
  ok: boolean;
  /** Server-side session lifecycle status; recorder self-stops when not 'active'. */
  status?: ServerSessionStatus;
  start_ip?: string;
  current_ip?: string;
  ip_changed?: boolean;
  newly_changed?: boolean;
  // S5: current exam end time + server clock — the live update channel.
  end_at?: string;
  server_now?: string;
  // F5.3/F5.5: live enforcement config + this session's exemptions, so an
  // admin/invigilator change applies within one heartbeat interval.
  enforcement?: EnforcementConfigPayload;
  enforcement_exemptions?: EnforcementExemptions;
};

export type UploadUrlResponse = {
  upload_url: string;
  storage_key: string;
  expires_in: number;
};

export type SessionStatus = "idle" | "starting" | "recording" | "ending" | "ended" | "error";

export type UploadManifestItem = {
  kind: string;
  index: number;
  storage_key: string;
  bytes: number;
  started_at: string;
  completed_at: string;
};

export type ReviewNature = "clipboard" | "tabs" | "cookies";

export type ProctorSettings = {
  start_at: string;
  end_at: string;
  contest_url?: string;
  /** S3: opt-in room start gate (invigilator OTP / start-now). */
  room_gate_enabled?: boolean;
  /** S4: id of the problem-bank problem assigned to this contest. */
  problem_id?: string;
  // S2: admin-configured room labels for the student room dropdown.
  rooms?: string[];
  // F5.3: fullscreen enforcement knobs (defaults 20 / 2 / "block").
  fullscreen_reentry_seconds?: number;
  fullscreen_exit_limit?: number;
  enforcement_mode?: EnforcementMode;
  // F10.1: separate low-res camera recording (default enabled / 10 / 640).
  camera_recording?: CameraRecordingConfigPayload;
  // S5/D1: stamped when the exam-time endpoint adjusts the end — while set (and
  // the start is unchanged) exam-time owns end_at, so a stale Settings save
  // cannot revert a live change. Used by the demo store for backend parity.
  end_at_updated_at?: string;
  // Passcodes are removed (Phase 2). These remain optional/backward-compatible so
  // an older settings doc still parses; the start/end flow no longer reads them.
  passcode?: string;
  end_code?: string;
  passcode_set?: boolean;
  passcode_preview?: string;
  end_code_set?: boolean;
  end_code_preview?: string;
  updated_at?: string;
};

// Live counts by session status for the admin dashboard (GET /api/admin/stats).
export type AdminStats = {
  live: number;
  locked: number;
  pending_approval: number;
  finished: number;
  // Derived count of active sessions whose newest liveness signal is stale.
  disconnected?: number;
  total: number;
  not_started_or_total?: number;
};

export type AdminStatsResponse = {
  contest_slug: string | null;
  room?: string | null;
  stats: AdminStats;
  // Distinct room labels for the console room dropdown (full contest scope).
  rooms?: string[];
  disconnected_staleness_ms?: number;
  // S5: current exam end time + server clock for the console exam-time card.
  end_at?: string;
  server_now?: string;
};

// S5: POST /api/admin/exam-time — live end-time control. EXACTLY ONE field set:
// an absolute end_at, a signed extend_minutes delta, or end_now (force-end).
export type ExamTimeRequest = {
  end_at?: string;
  extend_minutes?: number;
  end_now?: true;
};

export type ExamTimeResponse = {
  ok: boolean;
  start_at: string;
  end_at: string;
  server_now: string;
  // Sessions force-ended by end_now (0 for plain time changes).
  ended_count: number;
};

// GET /api/admin/recording-sessions — a LIGHTWEIGHT picker row for the screen-
// recording playback view. No GCS listing, no signed URLs (those come later via
// fetchAdminSessions when a user/session is chosen).
export type RecordingSession = {
  session_id: string;
  hackerrank_username: string;
  /** S-A accept-both (see SessionStartResponse.candidate_id). */
  candidate_id?: string;
  /** FIX-B1: the session's STORED Firestore key (username_norm = normalized
   *  candidate for legacy docs, person_id "{college_norm}~{uid_norm}" for
   *  person-mode docs). The recording-review player resolves a session by THIS
   *  exact key, not candidate_id, so person-mode recordings load. Absent on
   *  older backends (the lookup then falls back to candidate_id). */
  username_norm?: string;
  name: string;
  room: string;
  contest_slug: string;
  chunk_count: number;
  /** F10.1: separate camera-stream chunk counter (absent on older backends). */
  camera_chunk_count?: number;
  created_at: string;
  status: string;
};

export type RecordingSessionsResponse = {
  sessions: RecordingSession[];
  // sessions-list only (F6 review): true when the capped page may be missing
  // LIVE rows (raw query cap hit, or more live rows matched than the page
  // holds) — the alerts-console status join must not trust such a list.
  // Absent on recording-sessions and on older backends (treated as false).
  truncated?: boolean;
};

// F6.3 — GET /api/admin/session-detail?session_id=: ONE session doc projected
// to the least-privilege fields the Sessions detail card shows (identity incl.
// roster id, status, the IP block, and the doc's own activity counters). No
// email, no storage internals, no evidence/signed URLs. ("Card" in the name —
// SessionDetail below is the older batch session-details CSV row.)
export type SessionCardDetail = {
  session_id: string;
  hackerrank_username: string;
  /** S-A accept-both (see SessionStartResponse.candidate_id). */
  candidate_id?: string;
  name: string;
  roll_number: string;
  roster_unique_id: string;
  room: string;
  contest_slug: string;
  status: string;
  created_at: string;
  updated_at: string;
  blocked_by_session_id: string | null;
  start_ip: string;
  current_ip: string;
  ip_change_count: number;
  chunk_count: number;
  /** F10.1: separate camera-stream chunk counter (absent on older backends). */
  camera_chunk_count?: number;
  event_count: number;
  clipboard_event_count: number;
  focus_event_count: number;
  heartbeat_count: number;
  capture_state: CaptureState | null;
  /** F5.3: "fullscreen_enforcement" when the enforcement ladder locked it. */
  locked_reason?: string | null;
  /** F5.5: per-session exemption toggles. */
  enforcement_exemptions?: EnforcementExemptions;
};

export type SessionCardDetailResponse = {
  session: SessionCardDetail;
};

// S7 — GET /api/admin/ip-report: IP-wise count of logged-in users (the
// proxy-detection signal surface). One IpReportEntry per client IP, biggest
// clusters first; candidate rows are a bounded newest-first sample.
export type IpReportCandidate = {
  session_id: string;
  hackerrank_username: string;
  /** S-A accept-both (see SessionStartResponse.candidate_id). */
  candidate_id?: string;
  name: string;
  /** F8.1: roster identity for the drill-down ("" = legacy pre-roster session;
   * absent on older deployed backends). */
  roster_unique_id?: string;
  room: string;
  status: string;
  created_at: string;
  start_ip: string;
  ip_change_count: number;
};

export type IpReportEntry = {
  ip: string;
  sessions: number;
  users: number;
  active: number;
  locked: number;
  pending_approval: number;
  ended: number;
  rooms: string[];
  candidates: IpReportCandidate[];
  candidates_truncated: boolean;
};

// live = non-ended sessions only ("logged-in users"); all = include ended.
export type IpReportScope = "live" | "all";

export type IpReportResponse = {
  contest_slug: string | null;
  room: string | null;
  scope: IpReportScope;
  total_sessions: number;
  distinct_ips: number;
  multi_user_ips: number;
  ip_changed_sessions: number;
  ips: IpReportEntry[];
  ips_truncated: boolean;
};

// A SUBMISSION-TIME MARKER for the recording-review timeline. Sourced from the
// contest-eval poller via POST /api/submission-events and read back (admin) via
// GET /api/admin/submission-events. `valid` is the GREEN(true)/RED(false) flag
// (Accepted vs a terminal failure); transient submissions are never stored.
export type SubmissionEvent = {
  submission_id: string;
  hackerrank_username: string;
  /** S-A accept-both (see SessionStartResponse.candidate_id). */
  candidate_id?: string;
  contest_slug?: string;
  challenge_slug?: string;
  challenge_name?: string;
  lang?: string;
  status?: string;
  valid: boolean;
  /** ISO 8601 timestamp of the submission's real time. */
  submitted_at: string;
};

export type SubmissionEventsResponse = {
  events: SubmissionEvent[];
};

// One candidate proctor event from GET /api/admin/session-events (F6.7): the
// least-privilege projection of the session's stored event stream (GCS JSONL).
// `detail` is a SMALL flat object — scalar values only, strings truncated
// server-side — never the raw stored payload.
export type SessionEventItem = {
  type: string;
  /** ISO 8601 timestamp of when the event fired on the candidate's machine. */
  timestamp: string;
  detail?: Record<string, string | number | boolean>;
};

export type SessionEventsResponse = {
  events: SessionEventItem[];
  /** True when the merged list was capped server-side. */
  truncated?: boolean;
};

// F6.6 — the last-reported per-source capture state, parsed server-side from
// the composite heartbeat recording_state. The recorded webm is the DIRECT
// screen stream + mixed microphone audio; the camera is live-monitor only and
// is never part of the recorded video — hence per-source states rather than
// one recording flag. null until a composite heartbeat arrives (legacy docs).
export type CaptureSource = "screen" | "camera" | "microphone";
export type CaptureState = Record<CaptureSource, string>;

// One signed-URL evidence file as returned (per session) by GET /api/admin/sessions.
export type SessionEvidence = {
  key: string;
  size: number;
  last_modified?: string;
  download_url: string;
};

// A full session row from GET /api/admin/sessions: the session doc fields plus
// the resolved evidence listing (signed URLs, ~1h expiry). Only the fields the
// recording-playback view reads are typed; the rest is permissive.
export type AdminSessionDetail = {
  session_id?: string;
  hackerrank_username?: string;
  /** S-A accept-both (see SessionStartResponse.candidate_id). */
  candidate_id?: string;
  /** FIX-B1: the session's stored Firestore key — used to re-resolve the same
   *  session on a signed-URL refresh (works for legacy AND person-mode docs). */
  username_norm?: string;
  name?: string;
  room?: string;
  contest_slug?: string;
  storage_prefix?: string;
  status?: string;
  created_at?: string;
  chunk_count?: number;
  camera_chunk_count?: number;
  merged_video_key?: string;
  evidence?: SessionEvidence[];
  capture_state?: CaptureState | null;
  [key: string]: unknown;
};

export type AdminSessionsResponse = {
  sessions: AdminSessionDetail[];
};

export type SessionAction = "approve" | "lock" | "unlock" | "bypass" | "end" | "exempt";

export type SessionActionRequest = {
  action: SessionAction;
  session_id?: string;
  usernames?: string[];
  contest_slug?: string;
  /** F5.5: payload for action "exempt" — merged over the session's exemptions. */
  exemptions?: EnforcementExemptions;
};

export type SessionActionResponse = {
  ok: boolean;
  action: SessionAction;
  updated: Array<Record<string, unknown>>;
};

// ALERT CONTRACT — shared JSON shape across proctor, contest-eval, and the admin console.
// All three components MUST agree on this shape. Required on ingest:
// source, type, severity, timestamp, hackerrank_username, title.
export type AlertSeverity = "critical" | "warning" | "info";

export type AlertSource = "proctor" | "contest-eval";

export type AlertVerdictStatus = "pending" | "real" | "false_positive" | "inconclusive";

export type AlertVerdict = {
  status: AlertVerdictStatus;
  reason?: string;
  by?: string;
};

export type Alert = {
  /** Stable + idempotent, e.g. "<source>:<type>:<username_norm>:<contest_slug>:<dedupe>". */
  id: string;
  source: AlertSource;
  /**
   * proctor: recording_stopped | screen_share_stopped | recording_error | ip_changed | tab_hidden | tab_away | disconnected | fullscreen_enforcement
   *   (legacy, no longer raised but may still appear in stored data: invalid_share_surface)
   * contest-eval: peer_copy_cluster | recurring_pair | web_paste | first_attempt_solve | tough_first_attempt
   *   (legacy alias, no longer emitted: fast_solve)
   */
  type: string;
  severity: AlertSeverity;
  /** ISO 8601 timestamp. */
  timestamp: string;
  contest_slug?: string;
  hackerrank_username: string;
  /** S-A accept-both (see SessionStartResponse.candidate_id). */
  candidate_id?: string;
  /** Lowercase / sanitized identity value (wire name frozen — F9 D1). */
  username_norm?: string;
  session_id?: string;
  room?: string;
  /** Short headline. */
  title: string;
  /** Human-readable explanation. */
  detail?: string;
  /** Structured payload (cluster members, similarity %, etc.). */
  data?: Record<string, unknown>;
  /** GCS object key; backend resolves to a signed download_url on READ. */
  video_key?: string;
  /** Filled by backend GET /api/admin/alerts (never stored). */
  download_url?: string;
  verdict?: AlertVerdict;
  /** Archive flag — archived alerts are hidden from the default list. */
  archived?: boolean;
  archived_at?: string | null;
};

export type AlertFilters = {
  source?: AlertSource;
  severity?: AlertSeverity;
  contest_slug?: string;
  /** Room label filter (matches the session's stored room). */
  room?: string;
  /** Include archived alerts in the list (default excludes them). */
  include_archived?: boolean;
};

// GET /api/admin/alerts now returns the alerts plus the distinct room labels
// (from session docs) so the console can populate a room dropdown.
export type AlertsResponse = {
  alerts: Alert[];
  rooms?: string[];
};

// POST /api/admin/alert-action — archive/unarchive a set of alert ids.
export type AlertActionRequest = {
  action: "archive" | "unarchive";
  ids: string[];
};

export type AlertActionResponse = {
  ok: boolean;
  action: "archive" | "unarchive";
  archived: boolean;
  updated: string[];
  missing: string[];
};

// Per-type proctor alert configuration (GET/POST /api/admin/alert-settings).
// NOTE: invalid_share_surface was REMOVED — the recorder now refuses to record on
// an invalid share surface, so the event can never fire. Existing stored alerts of
// that type still DISPLAY; it is just no longer in the configurable catalog.
export type ProctorAlertType =
  | "recording_stopped"
  | "screen_share_stopped"
  | "recording_error"
  | "ip_changed"
  | "tab_hidden"
  | "tab_away"
  | "disconnected"
  // F5.3: the critical alert the enforcement ladder raises on a violation
  // (countdown expiry / exit limit) — in the backend catalog since wave 2,
  // missing here until wave 3.
  | "fullscreen_enforcement";

export type ProctorAlertTypeConfig = {
  enabled: boolean;
  severity: AlertSeverity;
  // F9.3: whether alerts of this type appear on the INVIGILATOR room dashboard
  // (filtered server-side). Defaults: critical types true, warning types false.
  show_to_invigilator: boolean;
  // Only tab_away carries this: the minimum continuous "HackerRank not visible"
  // span (seconds) the monitoring tab-away detector must observe before raising
  // an alert. Default 12. Source of truth for the detector's --min-gap-seconds.
  threshold_seconds?: number;
};

export type AlertSettings = {
  proctor: Record<string, ProctorAlertTypeConfig>;
};

// POST /api/session/beacon — liveness beacon, no auth (sendBeacon-friendly).
export type BeaconKind = "hidden" | "visible" | "closing";

// ---- Multi-reviewer recording-review workflow ----------------------------
// A binary YES(1)/NO(0) verdict a reviewer gives after watching a student's
// recording. Multiple reviewers each watch independently; the server serves the
// next student by priority and records each (username, reviewer) verdict.

export type ReviewVerdict = 0 | 1;

// POST /api/admin/review-roster — the operator pastes the full set of usernames
// to be reviewed. The client splits/trims/dedupes too, but the server is the
// source of truth. Response echoes how many usernames are now in the roster.
export type ReviewRosterSaveRequest = {
  usernames: string[];
};

export type ReviewRosterSaveResponse = {
  ok: boolean;
  count: number;
};

// GET /api/admin/review-roster — roster summary for the Settings page: the full
// username list plus the review-coverage buckets that drive the serving priority
// (0 reviews, exactly 1, 2+) and how many reviewers currently hold a claim.
export type ReviewRosterSummary = {
  usernames: string[];
  total: number;
  with_0_reviews: number;
  with_1_review: number;
  with_2plus_reviews: number;
  active_claims: number;
};

// POST /api/admin/review-next {reviewer_name} — the SERVER picks who this
// reviewer watches next (by coverage priority, never repeating a username this
// reviewer already scored). Returns the chosen username, or {done:true} when the
// reviewer's queue is empty.
export type ReviewNextResponse = { username: string; done?: false } | { done: true; username?: undefined };

// POST /api/admin/review-verdict — record one reviewer's binary verdict for one
// student. Idempotent server-side on (username, reviewer_name).
export type ReviewVerdictRequest = {
  username: string;
  reviewer_name: string;
  verdict: ReviewVerdict;
};

export type ReviewVerdictResponse = {
  ok: boolean;
};

// One verdict record this reviewer has already submitted (GET review-mine).
export type ReviewMineItem = {
  username: string;
  verdict: ReviewVerdict;
  created_at: string;
};

// GET /api/admin/review-mine?reviewer_name=X — this reviewer's own completed
// verdicts (for the header count + the re-watch "Your reviews" list).
export type ReviewMineResponse = {
  count: number;
  reviews: ReviewMineItem[];
};

// One verdict record across ALL reviewers (GET reviews) — the CSV export source.
export type ReviewRecord = {
  username: string;
  reviewer_name: string;
  verdict: ReviewVerdict;
  created_at: string;
};

// GET /api/admin/reviews — every verdict record from every reviewer, for the
// operator's "Export reviews CSV" (one CSV row per record).
export type ReviewsResponse = {
  reviews: ReviewRecord[];
};

// POST /api/admin/session-details — the operator pastes a roster of usernames and
// gets back the full candidate-detail row for each (one per INPUT username, in
// input order). `found` is false when no session doc matched that username, so the
// "Download all details" CSV can still emit a row (blank cells) for the missing.
export type SessionDetail = {
  username: string;
  hackerrank_username: string;
  /** S-A accept-both (see SessionStartResponse.candidate_id). */
  candidate_id?: string;
  name: string;
  email: string;
  roll_number: string;
  room: string;
  contest_slug: string;
  status: string;
  found: boolean;
};

export type SessionDetailsResponse = {
  details: SessionDetail[];
};

export type EditorEventType =
  | "editor_insert" | "editor_delete" | "editor_replace" | "editor_paste"
  | "editor_cursor" | "editor_selection" | "editor_focus" | "editor_blur"
  | "code_run" | "code_submit"
  /** S-I §3.5: switch marker riding the INCOMING problem's batch —
   * detail: { from_problem_id, to_problem_id }. */
  | "problem_switched";

export type EditorEvent = {
  type: EditorEventType;
  timestamp: string;             // ISO
  detail?: Record<string, unknown>;
};

export type ExecRequest = {
  session_id: string;
  problem_id: string;
  language: "python" | "cpp" | "java" | "javascript";
  source_code: string;
};

export type RunCaseResult = {
  input: string; expected: string; passed: boolean;
  status: string; stdout: string; stderr: string; compileOutput: string;
};
export type RunResult = { results: RunCaseResult[] };

// §9 lock: the submit response carries ONLY the verdict + pass/fail counts on the
// hidden tests — no per-test array (the backend stores that detail admin-side only).
// "error" = the judging infrastructure failed (e.g. Judge0 timeout) — NOT a wrong
// answer; the UI renders it neutrally and asks the candidate to submit again.
export type SubmitResult = { verdict: "accepted" | "wrong_answer" | "error"; passed_count: number; total: number; score: number; max_points: number; submission_id: string };

// ---- S2 roster login --------------------------------------------------------

// Public pre-session exam config (GET /api/exam-config, no auth): drives the
// student form mode (roster gate on/off, unique-ID field label, room list).
export type ExamConfig = {
  roster_required: boolean;
  unique_id_label: string;
  rooms: string[];
  /** F5.3: fullscreen enforcement knobs (absent on an older backend). */
  enforcement?: EnforcementConfigPayload;
  /** F10.1: camera-recording knobs — the consent disclosure renders
   * pre-session, so the form needs them before any session exists. */
  camera_recording?: CameraRecordingConfigPayload;
};

// Identity fields a roster column can be mapped onto (matches the backend's
// ROSTER_MAPPABLE_FIELDS and roster/parseRoster.ts RosterFieldMapping).
export type RosterColumnMapping = {
  name?: string;
  email?: string;
  roll_number?: string;
  hackerrank_username?: string;
  room?: string;
  /** S-C: the COMPULSORY college column on per-contest (person) uploads. */
  college?: string;
};

// S-C college canonicalization gate (vision §2.2): the admin maps each NEW
// college string onto an existing college or confirms creating it.
export type CollegeResolution =
  | { action: "map"; college_norm: string }
  | { action: "create"; name?: string };

export type NewCollegePreview = {
  college_norm: string;
  name: string;
  names: string[];
  rows: number;
};

export type KnownCollege = { college_norm: string; name: string };

// S-C duplicate hard-reject payload row (400 duplicate_unique_ids).
export type RosterDuplicate = {
  row: number;
  college: string;
  unique_id: string;
  conflicts_with_row: number;
};

// POST /api/admin/roster — the client parses the CSV; the backend stores rows.
// S-C: `contest` routes the upload down the person-layer pipeline (compulsory
// college column + canonicalization gate + dup hard-reject); absent = legacy.
export type RosterUploadRequest = {
  contest?: string;
  unique_id_column: string;
  columns: string[];
  column_mapping: RosterColumnMapping;
  rows: Array<Record<string, string>>;
  college_column?: string;
  college_resolutions?: Record<string, CollegeResolution>;
};

export type RosterUploadResponse = {
  ok: boolean;
  configured?: boolean;
  count?: number;
  skipped?: Array<{ row: number; reason: string }>;
  contest?: string;
  /** S-C canonicalization gate: the preview that blocks until the admin maps-or-confirms. */
  needs_college_confirmation?: boolean;
  new_colleges?: NewCollegePreview[];
  known_colleges?: KnownCollege[];
  ambiguous_ids?: Array<{ unique_id_norm: string; colleges: string[] }>;
  colleges_created?: string[];
  persons?: { created: number; updated: number };
  enrollments?: { created: number; reactivated: number; removed: number };
};

// GET /api/admin/roster — meta only (never the rows).
export type RosterStatus = {
  configured: boolean;
  contest?: string;
  count?: number;
  unique_id_column?: string;
  college_column?: string;
  column_mapping?: RosterColumnMapping;
  columns?: string[];
  updated_at?: string;
};

// POST /api/roster/lookup — confirmation-safe fields ONLY (email masked,
// unmapped extra columns never returned).
export type RosterLookupResult = {
  found: boolean;
  unique_id: string;
  name: string;
  roll_number: string;
  room: string;
  hackerrank_username: string;
  /** S-A accept-both (see SessionStartResponse.candidate_id). */
  candidate_id?: string;
  email_masked: string;
};

// ---- S3: invigilator portal + room start gate -------------------------------

// "none" = a gate doc that exists only because an unlock code was minted —
// it never releases a start gate (wave-2 unlock-namespace fix).
export type RoomGateMode = "otp" | "open" | "none";

export type RoomGate = {
  room: string;
  room_key: string;
  mode: RoomGateMode;
  otp: string;
  released_at: string | null;
  released_by: string;
  opened_at: string | null;
  opened_by: string;
  /** F5.6 wave-2 fix: the ENFORCEMENT-UNLOCK code — its own namespace, never
   *  the start OTP (which every candidate in an OTP-gated room typed). */
  unlock_otp?: string;
  unlock_released_at?: string | null;
  unlock_released_by?: string;
  updated_at: string;
};

export type RoomGateActionResponse = {
  ok: boolean;
  contest_slug: string | null;
  gate: RoomGate;
};

export type InvigilatorOverviewResponse = {
  contest_slug: string | null;
  room_gate_enabled: boolean;
  rooms: string[];
  has_unassigned: boolean;
};

// M13: NO session_id on rows — it is the candidate's write-endpoint bearer
// token; invigilators identify candidates by name/roll/username.
export type InvigilatorSessionRow = {
  name: string;
  hackerrank_username: string;
  /** S-A accept-both (see SessionStartResponse.candidate_id). */
  candidate_id?: string;
  /** F2 (E2E live): the EXACT stored session key (legacy = normalized
   *  candidate, person-mode = person_id "{college}~{uid}") the row actions
   *  (Unlock / Exempt) post back — a display id can never normalize to a
   *  person_id. Absent on older backends (actions fall back to the display id). */
  username_norm?: string;
  roll_number: string;
  /** F9.4: the roster's unique id (identity data — joins the alert detail view). */
  roster_unique_id: string;
  status: ServerSessionStatus | "";
  stale: boolean;
  exam_started_at: string | null;
  /** F5.5: drives the per-student exemption toggles on the room dashboard. */
  enforcement_exemptions?: EnforcementExemptions;
  /** F5.6 wave-2 fix: "fullscreen_enforcement" when the lock is invigilator-
   *  releasable (per-row Unlock); null for admin locks. Fixed token, no PII. */
  locked_reason?: string | null;
  created_at: string;
};

// M12/M13 least-privilege projection: NO session_id (bearer token) and NO
// free-text detail (the ip_changed detail embeds candidate IPs).
export type InvigilatorAlert = {
  id: string;
  type: string;
  severity: AlertSeverity;
  timestamp: string;
  title: string;
  hackerrank_username: string;
  /** S-A accept-both (see SessionStartResponse.candidate_id). */
  candidate_id?: string;
};

export type InvigilatorRoomStats = {
  live: number;
  locked: number;
  pending_approval: number;
  finished: number;
  disconnected: number;
  started: number;
  total: number;
};

export type InvigilatorRoomResponse = {
  contest_slug: string | null;
  room: string | null;
  room_key: string;
  room_gate_enabled: boolean;
  stats: InvigilatorRoomStats;
  sessions: InvigilatorSessionRow[];
  gate: RoomGate | null;
  alerts: InvigilatorAlert[];
  /** FIX-B3 #6: true when at least one alert type is shared with invigilators —
   *  drives the empty-feed copy ("nothing fired" vs "nothing is shared"). */
  alerts_shared?: boolean;
  disconnected_staleness_ms?: number;
};

export type RoomGatePollResponse = {
  gate_enabled: boolean;
  exam_started: boolean;
  exam_started_at?: string | null;
  room?: string;
};

// ---- S4: problem bank (admin authoring) -------------------------------------
export type ProblemLanguage = "python" | "cpp" | "java" | "javascript";
export type ProblemTest = { input: string; expected: string };
export type ProblemScoring = "per_test" | "all_or_nothing";
export type ProblemStatus = "draft" | "published";

// Full authored problem (admin-only surfaces; includes hidden tests).
export type ProblemDoc = {
  id: string;
  title: string;
  statement: string;
  languages: ProblemLanguage[];
  cpuTimeLimit: number;
  memoryLimit: number;
  points: number;
  scoring: ProblemScoring;
  status: ProblemStatus;
  /** S-I §1.2: bank tags (picker/filter chips). Absent on older backends. */
  tags?: string[];
  /** F12.2: optional per-language starter-code stubs (author-supplied). Each
   * value is the prefilled editor code for that language. Absent = generic
   * STARTERS scaffold (back-compat with stub-less problems). */
  stubs?: Partial<Record<ProblemLanguage, string>>;
  sampleTests: ProblemTest[];
  hiddenTests: ProblemTest[];
  created_at?: string;
  updated_at?: string;
};

// One row from GET /api/admin/problems (summaries only — no test contents).
export type ProblemSummary = {
  id: string;
  title: string;
  status: ProblemStatus;
  points: number;
  scoring: ProblemScoring;
  languages: string[];
  /** S-I §1.2: bank tags (picker/filter chips). Absent on older backends. */
  tags?: string[];
  sample_count: number;
  hidden_count: number;
  updated_at: string;
};

// Candidate-facing view delivered inside the start/resume response. NEVER
// carries hidden tests. S-I: `points` is the EFFECTIVE points (contest entry
// override applied) when the session belongs to a contest.
export type PublicProblem = {
  id: string;
  title: string;
  statement: string;
  languages: ProblemLanguage[];
  points: number;
  cpuTimeLimit: number;
  memoryLimit: number;
  sampleTests: ProblemTest[];
  /** F12.2: optional per-language starter-code stubs. Absent = fall back to the
   * generic STARTERS scaffold (back-compat with stub-less problems). */
  stubs?: Partial<Record<ProblemLanguage, string>>;
  /** S-I §3.4: position in the contest's ordered problems[] (absent on the
   * one-release legacy `problem` alias and on older backends). */
  order?: number;
};

// ---- S-I §1: templates + contest problems[] (backend shipped; UI = next wave)
// Spec: docs/superpowers/specs/2026-06-10-s-i-multiproblem-detail-spec.md

/** One ordered problem reference on a contest or template. points null = use
 * the bank problem's points at serve time; else an int override 0..1000. */
export type ContestProblemEntry = {
  problem_id: string;
  points: number | null;
  order: number;
};

/** Template defaults snapshot-copied onto a contest at instantiation (§1.4). */
export type TemplateDefaults = {
  duration_minutes: number;
  identity_label: string;
  room_gate_enabled: boolean;
  camera_recording: CameraRecordingConfigPayload;
  enforcement: EnforcementConfigPayload;
  evidence_retention_days: number;
  languages: ProblemLanguage[];
};

/** Full template doc (GET /api/admin/template?slug=). */
export type ProctorTemplate = {
  slug: string;
  name: string;
  description: string;
  archived: boolean;
  /** true when the row is the code-level seed preset (e.g. system-check). */
  preset?: boolean;
  problems: ContestProblemEntry[];
  defaults: TemplateDefaults;
  created_at: string | null;
  updated_at: string | null;
};

/** One row from GET /api/admin/templates (summaries only). */
export type TemplateSummary = {
  slug: string;
  name: string;
  archived: boolean;
  preset: boolean;
  problem_count: number;
  total_points: number;
  updated_at: string;
};

/** S-I §1.4.3: what references a problem — rides adminGetProblem and the
 * 409 problem_referenced / live_edit_confirmation_required guard bodies. */
export type ProblemReferences = {
  contests: string[];
  templates: string[];
};

/** S-I §3.4: one problem's submit history inside submissions_summary —
 * restores chips / attempt meters / the workspace total on resume. */
export type ProblemSubmissionSummary = {
  best_score: number;
  max_points: number;
  attempts: number;
  best_verdict: string;
  last_verdict: string;
  last_submitted_at: string;
};

// ---- S-D: contest administration (Contests tab + selector + routing) --------
// Spec: docs/superpowers/specs/2026-06-10-f10-product-vision.md §2.7/§5 A1-A3

export type ContestStatus = "draft" | "open" | "archived";

/** One contest doc from GET /api/admin/contests. The synthesized legacy
 * contest rides the same list with legacy:true (read-only — no doc exists). */
export type ContestSummary = {
  slug: string;
  name: string;
  status: ContestStatus;
  legacy: boolean;
  /** Set only on the synthesized legacy contest of an empty-slug deployment. */
  legacy_empty_slug?: boolean;
  listed: boolean;
  identity_label: string;
  /** Typed 6-char candidate access code (vision §10.3); null on legacy. */
  access_code: string | null;
  /** Per-contest invigilator portal token (vision §2.7); null on legacy. */
  invigilator_key: string | null;
  start_at: string | null;
  end_at: string | null;
  end_at_updated_at?: string | null;
  /** Ordered problems snapshot (S-I). Absent on the legacy synth row. */
  problems?: ContestProblemEntry[];
  /** Legacy synth carries the single-problem assignment instead. */
  problem_id?: string;
  rooms: string[];
  room_gate_enabled: boolean;
  template_slug: string | null;
  /** Round N-1 pointer (vision §2.7); set on carry-over contests. */
  previous_contest_slug?: string | null;
  camera_recording?: CameraRecordingConfigPayload;
  enforcement?: EnforcementConfigPayload;
  languages?: ProblemLanguage[];
  evidence_retention_days?: number;
  // ---- Data-lifecycle stamps (Wave7-G backend; spread from the contest doc) ----
  /** ISO of the last successful export (gate 1 of the purge; null = never). */
  last_export_at?: string | null;
  /** The last export's GCS object reference + per-dataset counts. */
  last_export?: { at?: string; gcs_key?: string; counts?: Record<string, number> } | null;
  /** ISO the retention clock started ("Mark selection done"); null = not started. */
  selection_done_at?: string | null;
  /** ISO the evidence sweep deleted the recordings; null = not yet swept. */
  evidence_purged_at?: string | null;
  /** ISO the heavy data was purged (tombstone); null = not purged. */
  db_purged_at?: string | null;
  /** Alias for db_purged_at on the tombstone (vision §2.16). */
  purged_at?: string | null;
  /** Per-dataset delete counts recorded on the tombstone. */
  purge_counts?: Record<string, number> | null;
  created_at: string | null;
  updated_at: string | null;
};

/** POST /api/admin/contest-export response (Wave7-G). */
export type ContestExportResponse = {
  ok: boolean;
  gcs_key: string;
  signed_url: string;
  counts: Record<string, number>;
  exported_at: string;
};

/** POST /api/admin/contest-purge response (Wave7-G). */
export type ContestPurgeResponse = {
  ok: boolean;
  contest: string;
  already_purged?: boolean;
  counts?: Record<string, number>;
  evidence_deleted?: number;
  evidence_retained?: boolean;
  enrollments_retained?: boolean;
};

/** POST /api/admin/retention-sweep response (Wave7-G). */
export type RetentionSweepResponse = {
  ok: boolean;
  swept_at: string;
  evidence_purged: Array<{ contest?: string; objects_deleted?: number; completed?: boolean }>;
  exports_deleted: number;
};

/** POST /api/admin/contests body (create — blank or from a template). */
export type ContestCreateRequest = {
  name: string;
  template_slug?: string;
  problems?: Array<{ problem_id: string; points?: number | null }>;
  identity_label?: string;
  start_at?: string;
  end_at?: string;
  room_gate_enabled?: boolean;
  rooms?: string[];
};

/** POST /api/admin/contest-update body (slug addresses the contest). */
export type ContestUpdateRequest = {
  slug: string;
  name?: string;
  identity_label?: string;
  listed?: boolean;
  start_at?: string | null;
  end_at?: string | null;
  rooms?: string[];
  room_gate_enabled?: boolean;
  problems?: Array<{ problem_id: string; points?: number | null }>;
  /** S-I open-contest guard: confirm problem ADDs on an open contest. */
  confirm?: boolean;
  /** S-I open-contest guard: typed contest slug confirming a points edit. */
  confirm_points_edit?: string;
  evidence_retention_days?: number;
};

/** Per-contest pre-session config (GET /api/exam-config?contest=). */
export type ContestExamConfig = ExamConfig & {
  contest_slug: string;
  contest_name: string;
  identity_label: string;
  /**
   * Forks the pinned candidate identity UX (S-D): "person" = typed id is
   * resolved server-side at start (college picker on 409 college_choices);
   * "legacy_username" = today's roster-lookup confirm flow.
   */
  identity_mode: "person" | "legacy_username";
  room_gate_enabled: boolean;
  start_at: string | null;
  end_at: string | null;
  server_now: string;
};

/** One 409 college_choices option from /api/session/start (person contests). */
export type CollegeChoice = {
  college_norm: string;
  name: string;
  college: string;
};
