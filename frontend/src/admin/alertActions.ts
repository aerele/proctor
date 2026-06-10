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
 * session_id when that session is in the list (even if ended — a single-id
 * action targets exactly that doc), otherwise the candidate's latest LIVE
 * session by username (what the backend usernames[] path would act on).
 * Null = no session to act on (e.g. contest-eval signal for a candidate who
 * never started, or whose sessions all ended).
 */
export function sessionForAlert(alert: JoinableAlert, sessions: JoinableSession[]): JoinableSession | null {
  if (alert.session_id) {
    const direct = sessions.find((session) => session.session_id === alert.session_id);
    if (direct) return direct;
  }
  const username = alert.username_norm || alert.hackerrank_username;
  return username ? latestLiveSessionFor(username, sessions) : null;
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
