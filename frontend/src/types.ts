export type StudentForm = {
  hackerrank_username: string;
  name: string;
  roll_number: string;
  email: string;
  proctor_passcode: string;
  consent_accepted: boolean;
};

export type SessionStartResponse = {
  session_id: string;
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
  passcode?: string;
  end_code?: string;
  passcode_set?: boolean;
  passcode_preview?: string;
  end_code_set?: boolean;
  end_code_preview?: string;
  updated_at?: string;
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
   * proctor: recording_stopped | screen_share_stopped | invalid_share_surface | recording_error | ip_changed
   * contest-eval: peer_copy_cluster | recurring_pair | web_paste | fast_solve
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
};

export type AlertFilters = {
  source?: AlertSource;
  severity?: AlertSeverity;
  contest_slug?: string;
};
