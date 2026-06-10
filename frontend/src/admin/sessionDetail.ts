// F6.3 — pure logic for the Sessions detail card (vitest-covered in
// sessionDetail.test.ts): the chunk-count → approximate-recording-duration
// math and the alert→session join the card's "Alerts for this session" stat
// uses over the ALREADY-FETCHED alerts list (no extra backend read).
import { normalizeJoinUsername, type JoinableAlert, type JoinableSession } from "./alertActions";

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
