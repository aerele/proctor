import { describe, expect, it } from "vitest";
import { newestSession, pickTargetSession, type SelectableSession } from "./recordingSessionSelect";

// A student with THREE attempts. attempt-1 is the newest by created_at, so a
// plain load defaults to it; the bug (LT-8) was that clicking ANY row loaded
// this newest one regardless of which row was clicked.
const sessions: SelectableSession[] = [
  { session_id: "attempt-1", created_at: "2026-06-23T12:00:00Z" }, // newest
  { session_id: "attempt-2", created_at: "2026-06-23T10:00:00Z" },
  { session_id: "attempt-3", created_at: "2026-06-23T08:00:00Z" }, // oldest
];

describe("pickTargetSession (LT-8 — row click loads the clicked attempt)", () => {
  it("selects the EXACT clicked session, not the latest", () => {
    // Clicking the OLDEST attempt's row must load THAT attempt.
    expect(pickTargetSession(sessions, "attempt-3")?.session_id).toBe("attempt-3");
    // And a middle attempt.
    expect(pickTargetSession(sessions, "attempt-2")?.session_id).toBe("attempt-2");
    // Explicitly picking the newest still resolves to it.
    expect(pickTargetSession(sessions, "attempt-1")?.session_id).toBe("attempt-1");
  });

  it("falls back to the NEWEST session when no id is given (plain load)", () => {
    expect(pickTargetSession(sessions, undefined)?.session_id).toBe("attempt-1");
    expect(pickTargetSession(sessions)?.session_id).toBe("attempt-1");
  });

  it("does not assume backend array order for the newest fallback", () => {
    // Newest row placed LAST in the array — must still win by created_at.
    const reordered: SelectableSession[] = [
      { session_id: "old", created_at: "2026-06-23T08:00:00Z" },
      { session_id: "new", created_at: "2026-06-23T12:00:00Z" },
    ];
    expect(pickTargetSession(reordered)?.session_id).toBe("new");
  });

  it("falls back to the newest when preferSessionId matches no loaded session", () => {
    // A stale/unknown id (e.g. a session dropped by a contest re-scope) must not
    // return undefined-and-blank — it degrades to the newest, same as no id.
    expect(pickTargetSession(sessions, "no-such-session")?.session_id).toBe("attempt-1");
  });

  it("matches a numeric session_id against a string preferSessionId", () => {
    const numeric: SelectableSession[] = [
      { session_id: 101, created_at: "2026-06-23T12:00:00Z" },
      { session_id: 202, created_at: "2026-06-23T08:00:00Z" },
    ];
    expect(pickTargetSession(numeric, "202")?.session_id).toBe(202);
  });

  it("returns undefined for an empty session list", () => {
    expect(pickTargetSession([], "anything")).toBeUndefined();
    expect(pickTargetSession([])).toBeUndefined();
  });
});

describe("newestSession", () => {
  it("returns the max created_at session", () => {
    expect(newestSession(sessions)?.session_id).toBe("attempt-1");
  });

  it("returns undefined for an empty list", () => {
    expect(newestSession([])).toBeUndefined();
  });
});
