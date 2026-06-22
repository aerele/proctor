// Pure exam-time math for the student countdown and the admin remaining-time
// display (S5). The SERVER is the time authority: every payload that carries
// end_at also carries server_now; remaining time is computed against the server
// clock via a skew offset so a wrong local clock cannot fake more (or less)
// exam time. No React, no I/O — unit-tested with vitest.

export type EndAtChange = "initial" | "unchanged" | "extended" | "shortened";

// Server-minus-client clock skew in ms. 0 when the server stamp is missing or
// unparseable (degrades to trusting the local clock).
export function computeClockSkewMs(serverNowIso: string | undefined, clientNowMs: number): number {
  if (!serverNowIso) return 0;
  const serverMs = Date.parse(serverNowIso);
  if (!Number.isFinite(serverMs)) return 0;
  return serverMs - clientNowMs;
}

// Milliseconds until end_at on the SERVER clock (clientNow + skew). null when
// end_at is missing/invalid (no countdown shown). Negative once time is up.
export function remainingMs(endAtIso: string | undefined, clientNowMs: number, skewMs: number): number | null {
  if (!endAtIso) return null;
  const endMs = Date.parse(endAtIso);
  if (!Number.isFinite(endMs)) return null;
  return endMs - (clientNowMs + skewMs);
}

// "H:MM:SS" with unpadded hours, clamped at zero so an overrun never renders a
// negative time.
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

// F7 (e2e finding): client-epoch anchor for the candidate ELAPSED counter.
// The counter must measure from the SESSION's server-side start (created_at),
// not from the current recorder stint, so a recording restart (share-drop
// recovery, refresh-resume) never resets it to 0:00. The server stamp is
// mapped onto the client clock with the same skew correction the countdown
// uses. Falls back to "now" (stint start — the old behavior) when created_at
// is missing/unparseable (pre-F7 backend), and clamps to "now" so a skewed
// future stamp can never render a negative elapsed time.
export function sessionElapsedAnchorMs(
  createdAtIso: string | undefined,
  serverNowIso: string | undefined,
  clientNowMs: number
): number {
  const createdMs = createdAtIso ? Date.parse(createdAtIso) : NaN;
  if (!Number.isFinite(createdMs)) return clientNowMs;
  const anchor = createdMs - computeClockSkewMs(serverNowIso, clientNowMs);
  return Math.min(anchor, clientNowMs);
}

// #135 take-home: the pre-T0 waiting-room window. Recording starts ~10 min
// early (D1) and the candidate holds in the waiting room until the official
// start (T0). The countdown only renders inside this 15-min window (D6); beyond
// it the candidate is "too early" and sees the come-back-later screen instead.
export const WAITING_ROOM_WINDOW_MS = 15 * 60 * 1000;

// #135 take-home: the PURE time half of the candidate waiting-room gate. Given
// the official start (start_at = T0), the local clock, and the server skew,
// returns the skew-corrected ms until T0 plus the two derived booleans:
//   waitingRoomActive — inside the 15-min window AND before T0 (show the
//                       countdown waiting room);
//   tooEarly          — more than 15 min before T0 (show come-back-later).
// Both are false once T0 has passed (msUntilStart <= 0 → the exam is open) or
// when start_at is missing/unparseable (no take-home schedule → no gate). The
// non-time gates (takeHome flag, status==='recording', gate, examGateActive)
// stay at the call site (StudentApp) — this is the boundary math only, so the
// 15-min/skew decision is unit-tested in isolation (T-F1/T-F2).
export function waitingRoomGate(
  startAtIso: string | undefined,
  clientNowMs: number,
  skewMs: number,
  windowMs: number = WAITING_ROOM_WINDOW_MS
): { msUntilStart: number | null; waitingRoomActive: boolean; tooEarly: boolean } {
  const msUntilStart = remainingMs(startAtIso, clientNowMs, skewMs);
  if (msUntilStart === null) return { msUntilStart: null, waitingRoomActive: false, tooEarly: false };
  return {
    msUntilStart,
    waitingRoomActive: msUntilStart > 0 && msUntilStart <= windowMs,
    tooEarly: msUntilStart > windowMs
  };
}

// #135 take-home — should a heartbeat re-surface the exam-time contract (end_at /
// T0 / remote flag / proctor phone)? The backend now ALWAYS emits start_at (every
// contest), so a bare `end_at || start_at` would fire onExamTimeChange — an extra
// state write/re-render — on EVERY normal (non-remote) heartbeat, which never
// happened pre-#135. Gate the start_at-only arm on take_home so the non-remote
// path stays byte-identical (fires only when end_at is present, as before), while
// a take-home session still refreshes from start_at even with no end_at set. Pure
// so the byte-identity invariant is unit-tested in isolation.
export function shouldSurfaceExamTime(args: {
  endAt?: string;
  startAt?: string;
  takeHome?: boolean;
}): boolean {
  return Boolean(args.endAt || (args.startAt && args.takeHome));
}

// #135 take-home — the candidate render-precedence for the recording pre-exam
// states (pure decision, no JSX). Once a session is live (status==="recording"),
// the candidate is in exactly one of three states by start-time boundary:
//   tooEarly          → HOLD on the come-back-later screen (start_at pushed
//                       >15 min out mid-wait; defense-in-depth, spec §4d);
//   waitingRoomActive → the pre-T0 waiting room (inside the 15-min window);
//   otherwise (T0 passed) → the live exam (W1) is allowed.
// The invariant this guards: a tooEarly candidate must NEVER reach the live exam
// view — holdWhileRecording and examViewAllowed are mutually exclusive, and a
// tooEarly candidate is held, not released. Mirrors the StudentApp render order
// (come-back-later → waiting room → W1) so the precedence is unit-tested in
// isolation rather than only through the component tree.
export function recordingPreExamState(args: {
  tooEarly: boolean;
  waitingRoomActive: boolean;
}): { holdWhileRecording: boolean; waitingRoomActive: boolean; examViewAllowed: boolean } {
  const holdWhileRecording = args.tooEarly;
  const waitingRoomActive = !holdWhileRecording && args.waitingRoomActive;
  return {
    holdWhileRecording,
    waitingRoomActive,
    // The live exam is allowed only once the candidate is neither held nor
    // waiting — i.e. T0 has passed (or there is no take-home schedule at all).
    examViewAllowed: !holdWhileRecording && !args.waitingRoomActive
  };
}

// #135 (A9): coarse milestone copy for the waiting-room aria-live region. The
// per-second mm:ss counter is aria-hidden (a screen reader must NOT hear it tick
// every second); this returns the bucketed announcement instead, so the live
// region only changes — and is only re-announced — when a milestone is crossed
// (10 / 5 / 1 minute, then "exam has started"). null = no announcement yet
// (e.g. >10 min out, or no schedule). Pure for unit testing.
export function waitingRoomMilestone(msUntilStart: number | null): string | null {
  if (msUntilStart === null) return null;
  if (msUntilStart <= 0) return "Your exam has started.";
  const minutes = Math.ceil(msUntilStart / 60_000);
  if (minutes <= 1) return "Exam starts in 1 minute.";
  if (minutes <= 5) return "Exam starts in 5 minutes.";
  if (minutes <= 10) return "Exam starts in 10 minutes.";
  return null;
}

// D1 — which end_at does a settings save actually persist? Pure rule (demo
// parity): once the exam-time endpoint has adjusted the end (end_at_updated_at
// stamp) and the save keeps the SAME start_at (same exam window), the stored
// end_at + stamp survive — a stale form value can never revert a live
// extend/shorten/end-now. A changed start_at is a new schedule: the submitted
// end_at applies and the stamp clears.
export function resolveSavedEndAt(
  existing: { start_at?: string; end_at?: string; end_at_updated_at?: string } | null | undefined,
  submitted: { start_at: string; end_at: string }
): { end_at: string; end_at_updated_at?: string } {
  const sameWindowStart =
    Boolean(existing?.start_at) && Date.parse(existing!.start_at!) === Date.parse(submitted.start_at);
  if (sameWindowStart && existing?.end_at_updated_at) {
    return { end_at: existing.end_at || "", end_at_updated_at: existing.end_at_updated_at };
  }
  return { end_at: submitted.end_at };
}

// Classify a newly-received end_at against the one already shown, so the UI can
// announce "extended" / "shortened" exactly once per change. An unusable next
// value is "unchanged" (keep what we have); a first usable value is "initial".
export function classifyEndAtChange(prevEndAt: string | undefined, nextEndAt: string | undefined): EndAtChange {
  const prevMs = prevEndAt ? Date.parse(prevEndAt) : NaN;
  const nextMs = nextEndAt ? Date.parse(nextEndAt) : NaN;
  if (!Number.isFinite(nextMs)) return "unchanged";
  if (!Number.isFinite(prevMs)) return "initial";
  if (nextMs === prevMs) return "unchanged";
  return nextMs > prevMs ? "extended" : "shortened";
}
