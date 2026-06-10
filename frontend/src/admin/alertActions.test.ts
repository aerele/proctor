import { describe, expect, it } from "vitest";
import {
  ALERT_ACTION_INFO,
  SESSION_ACTION_INFO,
  SESSION_ACTION_ORDER,
  bulkSessionActionsFor,
  joinableSessions,
  sessionForAlert,
  validSessionActionsFor
} from "./alertActions";

// Minimal sessions-list rows (RecordingSession projection) for the join tests.
const sessions = [
  { session_id: "s-active", hackerrank_username: "Arav_M", status: "active", created_at: "2026-06-10T09:00:00.000Z" },
  { session_id: "s-locked", hackerrank_username: "Imran_K", status: "locked", created_at: "2026-06-10T09:01:00.000Z" },
  { session_id: "s-pending", hackerrank_username: "Fatima_A", status: "pending_approval", created_at: "2026-06-10T09:30:00.000Z" },
  { session_id: "s-ended", hackerrank_username: "Asha_R", status: "ended", created_at: "2026-06-10T08:00:00.000Z" },
  // Same candidate twice: an old ended attempt + a newer live one (latest-live join).
  { session_id: "s-neha-old", hackerrank_username: "Neha_S", status: "ended", created_at: "2026-06-10T08:10:00.000Z" },
  { session_id: "s-neha-new", hackerrank_username: "Neha_S", status: "disconnected", created_at: "2026-06-10T09:20:00.000Z" }
];

describe("validSessionActionsFor", () => {
  // Mirrors backend applySessionAction (handler.mjs) semantics per status:
  it("active → lock + end", () => {
    expect(validSessionActionsFor("active")).toEqual(["lock", "end"]);
  });

  it("disconnected (derived stale-active) → lock + end", () => {
    expect(validSessionActionsFor("disconnected")).toEqual(["lock", "end"]);
  });

  it("locked → unlock + end", () => {
    expect(validSessionActionsFor("locked")).toEqual(["unlock", "end"]);
  });

  it("pending_approval → approve + bypass + end", () => {
    expect(validSessionActionsFor("pending_approval")).toEqual(["approve", "bypass", "end"]);
  });

  it("ended → nothing", () => {
    expect(validSessionActionsFor("ended")).toEqual([]);
  });

  it("unknown / missing session → nothing", () => {
    expect(validSessionActionsFor("weird_status")).toEqual([]);
    expect(validSessionActionsFor("")).toEqual([]);
    expect(validSessionActionsFor(undefined)).toEqual([]);
    expect(validSessionActionsFor(null)).toEqual([]);
  });

  it("returns actions in the canonical render order", () => {
    for (const status of ["active", "disconnected", "locked", "pending_approval"]) {
      const actions = validSessionActionsFor(status);
      const sorted = [...actions].sort((a, b) => SESSION_ACTION_ORDER.indexOf(a) - SESSION_ACTION_ORDER.indexOf(b));
      expect(actions).toEqual(sorted);
    }
  });
});

describe("sessionForAlert", () => {
  it("joins by session_id when the alert has one (even an ended session)", () => {
    const joined = sessionForAlert({ session_id: "s-ended", hackerrank_username: "Asha_R" }, sessions);
    expect(joined?.session_id).toBe("s-ended");
    expect(joined?.status).toBe("ended");
  });

  it("falls back to the username's latest LIVE session when the session_id is not in the list", () => {
    const joined = sessionForAlert({ session_id: "gone-1234", hackerrank_username: "Fatima_A" }, sessions);
    expect(joined?.session_id).toBe("s-pending");
  });

  it("joins by username (latest non-ended) when the alert has no session_id", () => {
    const joined = sessionForAlert({ hackerrank_username: "Neha_S" }, sessions);
    expect(joined?.session_id).toBe("s-neha-new");
  });

  it("username join is case-insensitive (username_norm vs stored casing)", () => {
    const joined = sessionForAlert({ hackerrank_username: "Imran_K", username_norm: "imran_k" }, sessions);
    expect(joined?.session_id).toBe("s-locked");
  });

  it("returns null when the candidate has only ended sessions (backend bulk path targets nothing)", () => {
    const joined = sessionForAlert({ hackerrank_username: "Asha_R" }, sessions);
    expect(joined).toBeNull();
  });

  it("returns null for contest-eval candidates with no session at all", () => {
    expect(sessionForAlert({ hackerrank_username: "Ghost_X" }, sessions)).toBeNull();
    expect(sessionForAlert({ hackerrank_username: "Ghost_X" }, [])).toBeNull();
  });
});

describe("bulkSessionActionsFor", () => {
  it("unions the valid actions of each candidate's latest live session, deduped, in canonical order", () => {
    // Arav (active) + Imran (locked) + Fatima (pending) → everything applies somewhere.
    expect(bulkSessionActionsFor(["Arav_M", "Imran_K", "Fatima_A"], sessions))
      .toEqual(["approve", "unlock", "lock", "bypass", "end"]);
  });

  it("two candidates with the same status contribute once", () => {
    expect(bulkSessionActionsFor(["Arav_M", "Neha_S"], sessions)).toEqual(["lock", "end"]);
  });

  it("candidates with no live session contribute nothing", () => {
    expect(bulkSessionActionsFor(["Asha_R", "Ghost_X"], sessions)).toEqual([]);
    expect(bulkSessionActionsFor([], sessions)).toEqual([]);
  });
});

describe("joinableSessions", () => {
  it("passes a complete (untruncated) list through for the status join", () => {
    expect(joinableSessions({ sessions, truncated: false })).toBe(sessions);
  });

  it("treats a truncated list like no list at all — null → full-action fallback", () => {
    // A capped sessions-list may be MISSING live sessions; joining against it
    // would show "no live session" (and hide Lock/End) for live candidates.
    expect(joinableSessions({ sessions, truncated: true })).toBeNull();
  });

  it("returns null when the endpoint is unavailable (null result)", () => {
    expect(joinableSessions(null)).toBeNull();
  });
});

describe("SESSION_ACTION_INFO", () => {
  it("renames bypass to Unblock while keeping the wire action name", () => {
    expect(SESSION_ACTION_INFO.bypass.action).toBe("bypass");
    expect(SESSION_ACTION_INFO.bypass.label).toBe("Unblock");
  });

  it("keeps end and lock destructive (confirm dialogs) and the rest not", () => {
    expect(SESSION_ACTION_INFO.end.destructive).toBe(true);
    expect(SESSION_ACTION_INFO.lock.destructive).toBe(true);
    expect(SESSION_ACTION_INFO.approve.destructive).toBe(false);
    expect(SESSION_ACTION_INFO.unlock.destructive).toBe(false);
    expect(SESSION_ACTION_INFO.bypass.destructive).toBe(false);
  });

  it("gives every session and alert action a one-line tooltip", () => {
    for (const action of SESSION_ACTION_ORDER) {
      expect(SESSION_ACTION_INFO[action].tooltip.length).toBeGreaterThan(10);
      expect(SESSION_ACTION_INFO[action].tooltip).not.toContain("\n");
    }
    expect(ALERT_ACTION_INFO.archive.tooltip.length).toBeGreaterThan(10);
    expect(ALERT_ACTION_INFO.unarchive.tooltip.length).toBeGreaterThan(10);
  });
});
