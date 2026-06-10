// F6.3 — pure logic for the Sessions detail card (vitest-covered in
// sessionDetail.test.ts): the chunk-count → approximate-recording-duration
// math and the alert→session join the card's "Alerts for this session" stat
// uses over the ALREADY-FETCHED alerts list (no extra backend read).
// F6.6 adds the capture-state language: per-source labels for the card rows
// and the recordings-review "what does this recording contain" header line.
import { normalizeJoinUsername, type JoinableAlert, type JoinableSession } from "./alertActions";
import type { CaptureSource, CaptureState } from "../types";

/** Every recorded chunk is a fixed 30-second .webm (uploadConfig.chunk_seconds
 * on the backend; CHUNK_SECONDS in RecordingReview.tsx). */
export const DETAIL_CHUNK_SECONDS = 30;

/** Approximate recording duration in seconds: chunks × 30s. Bad input → 0. */
export function approxRecordingSeconds(chunkCount: number): number {
  if (!Number.isFinite(chunkCount) || chunkCount <= 0) return 0;
  return chunkCount * DETAIL_CHUNK_SECONDS;
}

/**
 * Human form of the approximate duration: "—" (nothing recorded), "~30 sec",
 * "~6 min", "~1 h 50 min". Always "~" — chunk math is deliberately coarse.
 */
export function formatApproxDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  if (seconds < 60) return `~${Math.round(seconds)} sec`;
  const totalMinutes = Math.round(seconds / 60);
  if (totalMinutes < 60) return `~${totalMinutes} min`;
  return `~${Math.floor(totalMinutes / 60)} h ${totalMinutes % 60} min`;
}

// An alert as the join needs it: its own session pointer (proctor alerts) or
// just the candidate identity (contest-eval signals carry no session_id).
export type DetailJoinAlert = JoinableAlert & { id: string };

/**
 * The already-fetched alerts that belong to THIS session: alerts referencing
 * the session's id directly, plus session-less alerts (contest-eval signals)
 * for the same candidate — but never another session's alerts, even for the
 * same candidate (those belong to that other attempt's card).
 */
export function alertsForSession<T extends DetailJoinAlert>(alerts: T[], session: JoinableSession): T[] {
  const sessionNorm = normalizeJoinUsername(session.hackerrank_username);
  return alerts.filter((alert) => {
    if (alert.session_id) return alert.session_id === session.session_id;
    const alertNorm = alert.username_norm || normalizeJoinUsername(alert.hackerrank_username || "");
    return Boolean(alertNorm) && alertNorm === sessionNorm;
  });
}

// ---- F6.6 capture-state language -------------------------------------------
// What gets RECORDED is the direct screen stream with the microphone audio
// mixed in; the camera feed is live-monitor only (student-side preview /
// invigilator check) and is NEVER part of the recorded video. Every label
// below states that plainly so a proctor never goes hunting for a camera
// file that does not exist.

// Labels shared by every source for the non-"recording" states.
const COMMON_CAPTURE_LABELS: Record<string, string> = {
  stopped: "stopped mid-exam",
  error: "capture error",
  inactive: "not started"
};

// Per-source overrides: what "recording" means differs per source, and the
// optional sources (camera/mic) have denied/missing states.
const CAPTURE_LABELS: Record<CaptureSource, Record<string, string>> = {
  screen: {
    recording: "recording"
  },
  camera: {
    recording: "on (live monitor only — not in the recorded video)",
    permission_denied: "permission denied",
    unavailable: "no camera detected"
  },
  microphone: {
    recording: "recording (audio mixed into the screen video)",
    permission_denied: "permission denied",
    unavailable: "no microphone detected"
  }
};

/** Plain-language label for one capture source's last-reported state. */
export function captureSourceLabel(source: CaptureSource, state: string): string {
  return CAPTURE_LABELS[source][state] ?? COMMON_CAPTURE_LABELS[state] ?? "unknown";
}

// The recordings-review header fragments, derived per optional source.
const MIC_CONTENTS: Record<string, string> = {
  recording: "screen video + microphone audio",
  permission_denied: "screen video only — microphone permission denied",
  unavailable: "screen video only — no microphone detected",
  stopped: "screen video — microphone stopped mid-exam"
};

const CAMERA_CONTENTS: Record<string, string> = {
  recording: "camera live-monitored only (not recorded)",
  permission_denied: "camera permission denied",
  unavailable: "no camera detected",
  stopped: "camera stopped mid-exam"
};

/**
 * One header line for the recordings review: what the loaded recording
 * contains. Derived from the same last-reported capture state the session
 * card shows; null/undefined (legacy session, no composite heartbeat yet)
 * degrades to a "not reported" line rather than guessing.
 */
export function describeRecordingContents(state: CaptureState | null | undefined): string {
  if (!state) return "screen video — capture detail not reported for this session";
  const base = MIC_CONTENTS[state.microphone] ?? "screen video only — no microphone audio";
  const camera = CAMERA_CONTENTS[state.camera];
  return camera ? `${base}; ${camera}` : base;
}

// ---- F6 review: the session card's Recordings-tab deep-link affordances ----
// Both buttons jump to the Recordings tab scoped to this candidate/session.
// "View recording" additionally needs playable chunks; "View events" does not —
// the activity log there (events + alerts + submissions) renders without a
// single recorded chunk (/api/admin/session-events is chunk-independent).
// `dataAvailable` is false ONLY in demo mode for candidates outside the seeded
// recording dataset (the deep link would dead-end in "No sessions found").

export type DeepLinkAffordance = { disabled: boolean; tip: string };

const DEMO_NO_DATA_TIP =
  "Demo mode: this candidate has no seeded recording data, so the Recordings tab cannot load them. Open Asha_R, Karan_V, Neha_S or Vikram_T instead.";

export function viewRecordingAffordance(chunkCount: number, dataAvailable: boolean): DeepLinkAffordance {
  if (!dataAvailable) return { disabled: true, tip: DEMO_NO_DATA_TIP };
  if (!Number.isFinite(chunkCount) || chunkCount <= 0) {
    return { disabled: true, tip: "No recorded chunks yet — there is nothing to play for this session. Use “View events” for the chunk-free activity log." };
  }
  return { disabled: false, tip: "Open the Recordings tab with this candidate's recording loaded and this session selected." };
}

export function viewEventsAffordance(dataAvailable: boolean): DeepLinkAffordance {
  if (!dataAvailable) return { disabled: true, tip: DEMO_NO_DATA_TIP };
  return {
    disabled: false,
    tip: "Open this session's activity log on the Recordings tab (events, alerts, submission times) — available even when nothing was recorded."
  };
}
