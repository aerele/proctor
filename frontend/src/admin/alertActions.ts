// F6.4 — contextual alert ACTIONS for the alerts console. Pure logic only
// (vitest-covered in alertActions.test.ts): which SESSION actions are valid for
// a given session status, how an alert joins to its candidate's current session,
// and the labels/tooltips that explain each action in plain language.
//
// The validity table mirrors backend applySessionAction (handler.mjs) EXACTLY:
//   approve → "activate a PENDING session and end the conflicting one it waited
//             behind" — only meaningful on pending_approval;
//   lock    → freeze a live session (active, incl. the derived stale
//             "disconnected" — still status:"active" on the doc);
//   unlock  → re-activate a locked session;
//   bypass  → clear a second-device/conflict block WITHOUT ending the other
//             session (clears blocked_by_session_id) — the pending_approval
//             contingency override, labeled "Unblock" in the UI;
//   end     → end any non-ended session.
// Ended or unknown/missing sessions take NO session action (the backend bulk
// path resolveActionTargets skips ended docs; acting on nothing is noise).
import type { SessionAction } from "../types";

export type SessionActionInfo = {
  action: SessionAction;
  label: string;
  tooltip: string;
  destructive: boolean;
};

/** Canonical render order for session-action buttons (matches the legacy row order). */
export const SESSION_ACTION_ORDER: SessionAction[] = ["approve", "unlock", "lock", "bypass", "end"];

// One-line plain-language explanation per action (hover tooltip). "Bypass" is
// presented as "Unblock" — the wire-protocol action name stays "bypass".
export const SESSION_ACTION_INFO: Record<SessionAction, SessionActionInfo> = {
  approve: {
    action: "approve",
    label: "Approve",
    tooltip: "Activate this pending session and end the other session it was waiting behind — exactly one stays live.",
    destructive: false
  },
  unlock: {
    action: "unlock",
    label: "Unlock",
    tooltip: "Re-activate a locked session so the candidate can continue the exam.",
    destructive: false
  },
  lock: {
    action: "lock",
    label: "Lock",
    tooltip: "Freeze this session — the candidate is blocked from the exam until an admin unlocks it.",
    destructive: true
  },
  bypass: {
    action: "bypass",
    label: "Unblock",
    tooltip: "Re-activate a session blocked by another open session/second device; does not end the other session.",
    destructive: false
  },
  end: {
    action: "end",
    label: "End",
    tooltip: "End this session permanently — the candidate cannot continue this attempt.",
    destructive: true
  }
};

/** Alert-level actions (archive/unarchive) — separate group from session actions. */
export const ALERT_ACTION_INFO = {
  archive: { label: "Archive", tooltip: "Hide this alert from the default list; it stays stored and reachable via “Show archived”." },
  unarchive: { label: "Unarchive", tooltip: "Restore this archived alert to the default list." }
} as const;

/**
 * The session actions that are VALID (meaningful) for a session in the given
 * status. Statuses come from GET /api/admin/sessions-list: active /
 * disconnected (derived stale-active) / locked / pending_approval / ended.
 * Unknown or missing statuses (no session found for the alert) yield NO
 * session actions — such alerts keep only their alert actions (archive).
 */
export function validSessionActionsFor(status: string | null | undefined): SessionAction[] {
  switch (status) {
    case "active":
    case "disconnected": // still status:"active" on the doc — lockable/endable
      return ["lock", "end"];
    case "locked":
      return ["unlock", "end"];
    case "pending_approval":
      return ["approve", "bypass", "end"];
    default: // "ended", unknown, missing
      return [];
  }
}

// Minimal structural shapes so the join stays decoupled from the full
// RecordingSession / Alert types (and trivially testable).
export type JoinableSession = {
  session_id: string;
  hackerrank_username: string;
  status: string;
  created_at: string;
};

export type JoinableAlert = {
  session_id?: string;
  hackerrank_username: string;
  /** Lowercase/sanitized form when the alert carries one. */
  username_norm?: string;
};

// Same normalization the api layer applies to usernames (api.ts) — sessions-list
// rows carry the raw hackerrank_username, alerts often only username_norm.
// Exported so other admin joins (sessionDetail.ts) share the one definition.
export function normalizeJoinUsername(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "_").slice(0, 120);
}

/** The candidate's latest LIVE (non-ended) session — mirrors the backend bulk
 * path (resolveActionTargets: filter ended out, newest created_at first). */
function latestLiveSessionFor(username: string, sessions: JoinableSession[]): JoinableSession | null {
  const norm = normalizeJoinUsername(username);
  const live = sessions
    .filter((session) => session.status !== "ended" && normalizeJoinUsername(session.hackerrank_username) === norm)
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  return live[0] ?? null;
}

/**
 * Join an alert to the session its actions would target: the alert's own
 * session_id when that session is in the list AND still live, otherwise the
 * candidate's latest LIVE session by username (what the backend usernames[]
 * path would act on) — an alert pinned to an old ENDED attempt must not lose
 * Lock/End while the candidate is live on a newer session (F6 review). When
 * the direct join is ended and no live session exists, the ended doc is kept
 * so the row shows the truthful "SESSION — ENDED" context (archive-only).
 * Null = no session to act on (e.g. contest-eval signal for a candidate who
 * never started).
 */
export function sessionForAlert(alert: JoinableAlert, sessions: JoinableSession[]): JoinableSession | null {
  const username = alert.username_norm || alert.hackerrank_username;
  const live = username ? latestLiveSessionFor(username, sessions) : null;
  if (alert.session_id) {
    const direct = sessions.find((session) => session.session_id === alert.session_id);
    if (direct && direct.status !== "ended") return direct;
    if (direct) return live ?? direct;
  }
  return live;
}

/**
 * F6 review: the sessions-list response is CAPPED server-side, and the backend
 * flags a page that may be MISSING live sessions as truncated (query cap hit,
 * or more live rows than the page holds). Joining against such a list would
 * show "no live session" — and hide Lock/End — for candidates who are actually
 * live. Treat truncated exactly like "no join data": return null so callers
 * fall back to the full action set (the backend resolves the real target
 * session per candidate when an action runs, so capability is never lost).
 */
export function joinableSessions<T extends JoinableSession>(
  result: { sessions: T[]; truncated: boolean } | null
): T[] | null {
  if (result === null || result.truncated) return null;
  return result.sessions;
}

/**
 * F6 review: how the alerts console should treat its status-join data.
 * - "joined": a usable sessions list is in hand (fresh, or stale data kept
 *   across a failed refresh — stale statuses beat dropping the buttons) →
 *   rows render the status-contextual action set.
 * - "fallback": no list YET and nothing has failed — first load in flight,
 *   endpoint 404 (not deployed), or a truncated page mapped to null by
 *   joinableSessions → rows render the FULL action set (incomplete data must
 *   not cost admin capability; the backend resolves real targets per action).
 * - "unavailable": the sessions-list fetch FAILED (non-404) and there is no
 *   previous data to keep — the statuses are unknowable, so rows degrade to
 *   archive-only with a "session status unavailable" note instead of
 *   offering session actions against a console we know is erroring.
 */
export type AlertJoinState = "joined" | "fallback" | "unavailable";

export function alertJoinState(sessions: JoinableSession[] | null, fetchFailed: boolean): AlertJoinState {
  if (sessions !== null) return "joined";
  return fetchFailed ? "unavailable" : "fallback";
}

/**
 * Bulk buttons over a selection: the UNION of valid actions across each
 * selected candidate's latest live session (deduped, canonical order). The
 * backend bulk path applies an action per-candidate to that same latest live
 * session and skips candidates without one, so a union is safe: every rendered
 * action does something for at least one selected candidate.
 */
export function bulkSessionActionsFor(usernames: string[], sessions: JoinableSession[]): SessionAction[] {
  const valid = new Set<SessionAction>();
  for (const username of usernames) {
    const live = latestLiveSessionFor(username, sessions);
    if (!live) continue;
    for (const action of validSessionActionsFor(live.status)) valid.add(action);
  }
  return SESSION_ACTION_ORDER.filter((action) => valid.has(action));
}
