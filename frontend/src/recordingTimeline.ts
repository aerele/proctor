// frontend/src/recordingTimeline.ts — pure logic for the recordings timeline
// activity overlay + click-to-jump log (F6.7). Merges the three per-candidate
// streams (proctor alerts, session events, submission markers) onto the SAME
// test-relative scale the scrubber uses, tags entries that land inside a
// recording gap ("during blackout"), and provides the kind/severity filtering
// and the simple offset-clustering the dense event lane uses. No React, no IO —
// everything here is vitest-covered.
import type { Alert, AlertSeverity, SessionEventItem, SubmissionEvent } from "./types";

export type TimelineLogKind = "alert" | "event" | "submission";

// A span where nothing was recorded (mirrors RecordingReview's TimelineGap).
export type TimelineGapSpan = {
  fromSec: number;
  toSec: number;
};

// One merged row of the activity log / one marker on the timeline overlay.
export type TimelineLogEntry = {
  kind: TimelineLogKind;
  /** Stable unique id (React key + filter assertions). */
  id: string;
  /** The underlying alert/event type or submission status (for tooling). */
  type: string;
  /** Test-relative offset in seconds (can be negative for pre-start entries). */
  offsetSec: number;
  /** Absolute ISO timestamp of the underlying record. */
  timestamp: string;
  /** One-line headline. */
  label: string;
  /** One-line supporting detail ("" when none). */
  detail: string;
  /** Alerts only. */
  severity?: AlertSeverity;
  /** Submissions only: GREEN valid / RED invalid. */
  valid?: boolean;
  /** True when the entry lands inside a recording gap (a blackout). */
  duringGap: boolean;
};

export type TimelineLogFilters = {
  alerts: boolean;
  events: boolean;
  submissions: boolean;
  /** Narrows ALERTS only; "" = every severity. */
  severity: "" | AlertSeverity;
};

// Sensible defaults: everything visible (Karthi: usability is the bar).
export const DEFAULT_LOG_FILTERS: TimelineLogFilters = {
  alerts: true,
  events: true,
  submissions: true,
  severity: ""
};

// Machinery noise that would drown the log without telling the reviewer
// anything (one chunk_uploaded per 30s of recording = the recording itself,
// which the timeline already shows as chunks). upload_error and heartbeat_error
// are deliberately KEPT — they explain why chunks/liveness are missing.
const NOISE_EVENT_TYPES = new Set(["chunk_uploaded", "media_preview_play_error", "event_upload_error"]);

// Friendly labels for the known proctor event types; unknown types degrade to
// a humanized form of the raw type so new emitters still render sensibly.
const EVENT_LABELS: Record<string, string> = {
  session_started: "Session started",
  window_blur: "Window lost focus",
  window_focus: "Window focused",
  page_hide: "Page hidden or closed",
  before_unload: "Page closing",
  clipboard_activity: "Clipboard activity",
  ip_address_changed: "IP address changed",
  screen_share_stopped: "Screen share stopped",
  combined_recording_started: "Recording started",
  recording_error: "Recording error",
  upload_error: "Chunk upload failed",
  heartbeat_error: "Heartbeat failed",
  small_video_chunk_detected: "Suspiciously small video chunk",
  invalid_share_surface: "Invalid share surface picked",
  session_stop_requested: "Candidate ended the session",
  fullscreen_enter: "Entered fullscreen",
  fullscreen_exit: "Exited fullscreen",
  camera_microphone_started: "Camera + microphone started",
  camera_stopped: "Camera stopped",
  microphone_stopped: "Microphone stopped",
  camera_microphone_unavailable: "Camera/microphone unavailable"
};

const DETAIL_SUMMARY_MAX_ENTRIES = 3;
const DETAIL_SUMMARY_VALUE_MAX = 80;

// (timestamp − testStart) in seconds; null when either side is invalid so the
// caller can drop the entry instead of plotting it at NaN.
export function offsetSecFor(timestamp: string, testStartMs: number): number | null {
  if (!Number.isFinite(testStartMs)) return null;
  const ms = Date.parse(timestamp || "");
  if (!Number.isFinite(ms)) return null;
  return (ms - testStartMs) / 1000;
}

// Whether a test-relative offset lands inside any recording gap (inclusive of
// the edges — a record stamped exactly at the blackout boundary is "during").
export function isDuringGap(offsetSec: number, gaps: TimelineGapSpan[]): boolean {
  return gaps.some((gap) => offsetSec >= gap.fromSec && offsetSec <= gap.toSec);
}

// Friendly one-line label for an event type. visibility_change reads the
// detail state so "Tab hidden" and "Tab visible" are distinguishable at a glance.
export function eventLabel(type: string, detail?: Record<string, string | number | boolean>): string {
  if (type === "visibility_change") {
    const state = detail?.state;
    if (state === "hidden") return "Tab hidden";
    if (state === "visible") return "Tab visible";
    return "Tab visibility changed";
  }
  return EVENT_LABELS[type] ?? type.replace(/_/g, " ");
}

// Compact one-liner from the (already small, scalar-only) event detail:
// "state: hidden · count: 2". Bounded entries + value length so a row never wraps.
export function summarizeEventDetail(detail?: Record<string, string | number | boolean>): string {
  if (!detail) return "";
  return Object.entries(detail)
    .slice(0, DETAIL_SUMMARY_MAX_ENTRIES)
    .map(([key, value]) => {
      const text = String(value);
      const clipped = text.length > DETAIL_SUMMARY_VALUE_MAX ? `${text.slice(0, DETAIL_SUMMARY_VALUE_MAX)}…` : text;
      return `${key}: ${clipped}`;
    })
    .join(" · ");
}

// The candidate's alerts out of a contest-scoped alert list: match on
// username_norm (both sides are backend-normalized), falling back to a
// lowercase username compare for records missing the norm field.
export function alertsForCandidate(
  alerts: Alert[],
  session: { username_norm?: unknown; hackerrank_username?: unknown }
): Alert[] {
  const key =
    String(session.username_norm || "").trim() ||
    String(session.hackerrank_username || "").trim().toLowerCase();
  if (!key) return [];
  return alerts.filter((alert) => {
    const alertKey =
      String(alert.username_norm || "").trim() ||
      String(alert.hackerrank_username || "").trim().toLowerCase();
    return alertKey === key;
  });
}

// Merge alerts + events + submissions into ONE time-ordered entry list on the
// test-relative scale. Entries with unparseable timestamps (or no test-start
// anchor) are dropped; noisy machinery event types are skipped.
export function buildTimelineLog(params: {
  alerts: Alert[];
  events: SessionEventItem[];
  submissions: SubmissionEvent[];
  testStartMs: number;
  gaps: TimelineGapSpan[];
}): TimelineLogEntry[] {
  const { alerts, events, submissions, testStartMs, gaps } = params;
  const entries: TimelineLogEntry[] = [];

  for (const alert of alerts) {
    const offsetSec = offsetSecFor(alert.timestamp, testStartMs);
    if (offsetSec === null) continue;
    entries.push({
      kind: "alert",
      id: `alert:${alert.id}`,
      type: alert.type,
      offsetSec,
      timestamp: alert.timestamp,
      label: alert.title || alert.type,
      detail: alert.detail || "",
      severity: alert.severity,
      duringGap: isDuringGap(offsetSec, gaps)
    });
  }

  events.forEach((event, index) => {
    if (NOISE_EVENT_TYPES.has(event.type)) return;
    const offsetSec = offsetSecFor(event.timestamp, testStartMs);
    if (offsetSec === null) return;
    entries.push({
      kind: "event",
      // Index keeps ids unique even for identical repeated events.
      id: `event:${index}:${event.type}@${event.timestamp}`,
      type: event.type,
      offsetSec,
      timestamp: event.timestamp,
      label: eventLabel(event.type, event.detail),
      detail: summarizeEventDetail(event.detail),
      duringGap: isDuringGap(offsetSec, gaps)
    });
  });

  for (const submission of submissions) {
    const offsetSec = offsetSecFor(submission.submitted_at, testStartMs);
    if (offsetSec === null) continue;
    entries.push({
      kind: "submission",
      id: `sub:${submission.submission_id}`,
      type: submission.status || (submission.valid ? "Accepted" : "Failed"),
      offsetSec,
      timestamp: submission.submitted_at,
      label: `${submission.valid ? "Accepted" : submission.status || "Failed"} · ${
        submission.challenge_name || submission.challenge_slug || "submission"
      }`,
      detail: submission.lang || "",
      valid: submission.valid,
      duringGap: isDuringGap(offsetSec, gaps)
    });
  }

  return entries.sort(
    (a, b) => a.offsetSec - b.offsetSec || a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id)
  );
}

// Apply the log panel's filter state: kind toggles drop whole streams; the
// severity narrows ALERTS only (events/submissions are unaffected by it).
export function filterTimelineLog(entries: TimelineLogEntry[], filters: TimelineLogFilters): TimelineLogEntry[] {
  return entries.filter((entry) => {
    if (entry.kind === "alert") {
      if (!filters.alerts) return false;
      return !filters.severity || entry.severity === filters.severity;
    }
    if (entry.kind === "event") return filters.events;
    return filters.submissions;
  });
}

// A cluster of markers too close to render individually at the current zoom.
export type MarkerCluster = {
  /** The cluster anchor — the FIRST entry's offset (clicks seek here). */
  offsetSec: number;
  entries: TimelineLogEntry[];
};

// Greedy left-to-right clustering over (already time-sorted) entries: an entry
// within minSepSec of the current cluster's anchor joins it; otherwise it
// starts a new cluster. Simple by design — enough to keep a dense event lane
// hoverable without a real layout engine.
export function clusterMarkers(entries: TimelineLogEntry[], minSepSec: number): MarkerCluster[] {
  const clusters: MarkerCluster[] = [];
  for (const entry of entries) {
    const current = clusters[clusters.length - 1];
    if (current && entry.offsetSec - current.offsetSec <= minSepSec) {
      current.entries.push(entry);
    } else {
      clusters.push({ offsetSec: entry.offsetSec, entries: [entry] });
    }
  }
  return clusters;
}
