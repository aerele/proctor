// LT-8: pure selector for "which of a student's loaded sessions becomes active".
//
// A student can have MULTIPLE attempts/sessions. Two entry points choose one:
//   - the picker row click (left list) and the Sessions deep link both name an
//     EXACT session id → that session must win;
//   - a plain "load this student" (no id) → fall back to the NEWEST session.
//
// The newest pick must not assume the backend's array order: it picks the max
// created_at defensively (string-comparable ISO timestamps), so a reorder never
// silently changes the default. Extracted from RecordingReview.loadUser so the
// "clicked attempt N loads attempt N, not the latest" guarantee is unit-tested
// without a DOM (this repo has no jsdom).

// The minimal shape the selector needs from a loaded session.
export type SelectableSession = {
  session_id?: string | number;
  created_at?: string;
};

// Pick the NEWEST session by created_at (max ISO timestamp). Defensive against
// the backend returning rows in any order. Returns undefined for an empty list.
export function newestSession<T extends SelectableSession>(sessions: T[]): T | undefined {
  if (!sessions.length) return undefined;
  return [...sessions].sort((a, b) =>
    String(b.created_at || "").localeCompare(String(a.created_at || ""))
  )[0];
}

// Choose the session to make active:
//   - when preferSessionId names one of the loaded sessions → THAT exact session
//     (the picker-row / deep-link path — clicking attempt N loads attempt N);
//   - otherwise the newest session (the plain "load this student" default).
// preferSessionId is matched by string-equality on session_id so a numeric id
// from one source and a string id from another still line up.
export function pickTargetSession<T extends SelectableSession>(
  sessions: T[],
  preferSessionId?: string
): T | undefined {
  const preferred = preferSessionId
    ? sessions.find((s) => String(s.session_id) === preferSessionId)
    : undefined;
  return preferred ?? newestSession(sessions);
}
