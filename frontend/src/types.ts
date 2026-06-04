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
