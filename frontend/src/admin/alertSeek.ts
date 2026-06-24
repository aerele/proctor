// LT-12 — pure mapping for "jump to the recording at an alert's exact moment".
//
// An alert carries a wall-clock ISO timestamp; the recording player plots
// everything on a TEST-RELATIVE scale anchored at the session's test-start
// (created_at) — the same scale buildTimelineLog / the scrubber use. To seek
// the player to the alert moment we convert the alert's wall-clock time into
// that test-relative offset:  offsetSec = (alertMs − testStartMs) / 1000.
//
// This is the SAME arithmetic recordingTimeline.offsetSecFor does for log
// entries; it's lifted here as its own tiny, DOM-free helper so the alert→seek
// path is unit-tested in isolation (this repo has no jsdom), matching the
// recordingSessionSelect / bulkSelect convention. The player still clamps the
// result to the nearest available chunk (chunkPosForTestTime) — a seek that
// lands in a recording gap snaps to the closest recorded frame — so this helper
// only owns the time math, never the chunk picking.

/** Epoch ms of an ISO timestamp, or null when it's missing/unparseable. */
export function alertEpochMs(timestamp: string | null | undefined): number | null {
  if (!timestamp) return null;
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Test-relative seek offset (seconds) for an alert moment, given the session's
 * test-start anchor in epoch ms. Returns null when either side is missing or
 * unparseable so the caller can skip seeking (load the session at its start)
 * rather than seeking to NaN. The value MAY be negative (an alert stamped before
 * the recording's test-start anchor) — the caller/player clamps to the span.
 */
export function alertSeekOffsetSec(
  alertTimestamp: string | null | undefined,
  testStartMs: number | null | undefined
): number | null {
  const alertMs = alertEpochMs(alertTimestamp);
  if (alertMs === null) return null;
  if (testStartMs == null || !Number.isFinite(testStartMs)) return null;
  return (alertMs - testStartMs) / 1000;
}

// The deep-link payload an alert hands the recordings tab so the player can
// seek to the alert moment. `seekToMs` is the alert's wall-clock time in epoch
// ms (resolved against the session's test-start once the playlist is loaded).
export type AlertRecordingLink = {
  username: string;
  usernameNorm?: string;
  sessionId?: string;
  /** Epoch ms of the alert timestamp; undefined ⇒ no seek (load at the start). */
  seekToMs?: number;
};

// Minimal alert shape this builder needs (decoupled from the full Alert type).
export type SeekableAlert = {
  timestamp: string;
  session_id?: string;
  username_norm?: string;
  hackerrank_username?: string;
  candidate_id?: string;
};

/**
 * Build the recordings deep-link for "view recording at this moment". The
 * session it targets is resolved by the caller (the alert's joined live session,
 * else its own session_id) — passed in as `target` so this stays pure. `display`
 * is the candidate label (candidateIdOf) the player loads by; `usernameNorm` is
 * the stored key person-mode lookups need. Returns null when there's no session
 * to open (a session-less alert has no recording to jump into).
 */
export function buildAlertRecordingLink(
  alert: SeekableAlert,
  target: { sessionId?: string; usernameNorm?: string } | null,
  display: string
): AlertRecordingLink | null {
  const sessionId = target?.sessionId || alert.session_id;
  if (!sessionId) return null;
  const seekMs = alertEpochMs(alert.timestamp);
  return {
    username: display,
    ...(target?.usernameNorm || alert.username_norm
      ? { usernameNorm: target?.usernameNorm || alert.username_norm }
      : {}),
    sessionId,
    ...(seekMs !== null ? { seekToMs: seekMs } : {})
  };
}
