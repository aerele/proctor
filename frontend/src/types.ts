export type StudentForm = {
  hackerrank_username: string;
  name: string;
  roll_number: string;
  email: string;
  room: string;
  consent_accepted: boolean;
};

// Lifecycle status of the session as reported by the backend (Phase 2). Distinct
// from the client UI `SessionStatus` below: this is the server-side session doc
// state, the UI status is the recorder/screen state.
export type ServerSessionStatus = "active" | "pending_approval" | "locked" | "ended";

export type SessionStartResponse = {
  session_id: string;
  status?: ServerSessionStatus;
  hackerrank_username?: string;
  name?: string;
  room?: string;
  contest_slug?: string;
  storage_prefix?: string;
  blocked_by_session_id?: string | null;
  start_ip?: string;
  contest_url?: string;
  upload_config: {
    chunk_seconds: number;
    video_bits_per_second: number;
    media_bits_per_second?: number;
    audio_bits_per_second?: number;
    max_width: number;
    max_frame_rate: number;
  };
  heartbeat_interval_seconds: number;
};

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
};

// GET /api/admin/recording-sessions — a LIGHTWEIGHT picker row for the screen-
// recording playback view. No GCS listing, no signed URLs (those come later via
// fetchAdminSessions when a user/session is chosen).
export type RecordingSession = {
  session_id: string;
  hackerrank_username: string;
  name: string;
  room: string;
  contest_slug: string;
  chunk_count: number;
  created_at: string;
  status: string;
};

export type RecordingSessionsResponse = {
  sessions: RecordingSession[];
};

// A SUBMISSION-TIME MARKER for the recording-review timeline. Sourced from the
// contest-eval poller via POST /api/submission-events and read back (admin) via
// GET /api/admin/submission-events. `valid` is the GREEN(true)/RED(false) flag
// (Accepted vs a terminal failure); transient submissions are never stored.
export type SubmissionEvent = {
  submission_id: string;
  hackerrank_username: string;
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
  name?: string;
  room?: string;
  contest_slug?: string;
  storage_prefix?: string;
  status?: string;
  created_at?: string;
  chunk_count?: number;
  merged_video_key?: string;
  evidence?: SessionEvidence[];
  [key: string]: unknown;
};

export type AdminSessionsResponse = {
  sessions: AdminSessionDetail[];
};

export type SessionAction = "approve" | "lock" | "unlock" | "bypass" | "end";

export type SessionActionRequest = {
  action: SessionAction;
  session_id?: string;
  usernames?: string[];
  contest_slug?: string;
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
   * proctor: recording_stopped | screen_share_stopped | recording_error | ip_changed | tab_hidden | tab_away | disconnected
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
  /** Lowercase / sanitized username. */
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
  | "disconnected";

export type ProctorAlertTypeConfig = {
  enabled: boolean;
  severity: AlertSeverity;
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
