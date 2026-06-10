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

// D1 — which end_at does a Settings-form save actually persist? Mirrors the
// backend adminSaveSettings rule (demo parity): once the exam-time endpoint has
// adjusted the end (end_at_updated_at stamp) and the save keeps the SAME
// start_at (same exam window), the stored end_at + stamp survive — a stale
// form value can never revert a live extend/shorten/end-now. A changed
// start_at is a new schedule: the submitted end_at applies and the stamp clears.
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
