import { describe, expect, it } from "vitest";
import { alertsForSession, approxRecordingSeconds, formatApproxDuration } from "./sessionDetail";

describe("approxRecordingSeconds", () => {
  it("is chunk_count × 30s (the fixed recorder chunk length)", () => {
    expect(approxRecordingSeconds(0)).toBe(0);
    expect(approxRecordingSeconds(1)).toBe(30);
    expect(approxRecordingSeconds(12)).toBe(360);
    expect(approxRecordingSeconds(220)).toBe(6600);
  });

  it("clamps negative / non-finite counts to 0", () => {
    expect(approxRecordingSeconds(-3)).toBe(0);
    expect(approxRecordingSeconds(Number.NaN)).toBe(0);
  });
});

describe("formatApproxDuration", () => {
  it("renders an em dash for zero (no recording)", () => {
    expect(formatApproxDuration(0)).toBe("—");
  });

  it("renders seconds below a minute", () => {
    expect(formatApproxDuration(30)).toBe("~30 sec");
  });

  it("renders whole minutes below an hour", () => {
    expect(formatApproxDuration(360)).toBe("~6 min");
    // Partial minutes round to the nearest minute (chunks are coarse anyway).
    expect(formatApproxDuration(90)).toBe("~2 min");
  });

  it("renders hours + minutes at or past an hour", () => {
    expect(formatApproxDuration(3600)).toBe("~1 h 0 min");
    expect(formatApproxDuration(6600)).toBe("~1 h 50 min");
  });
});

describe("alertsForSession", () => {
  const session = {
    session_id: "s-1",
    hackerrank_username: "Asha_R",
    status: "active",
    created_at: "2026-06-10T09:00:00.000Z"
  };

  it("counts alerts that reference the session's id directly", () => {
    const alerts = [
      { id: "a1", session_id: "s-1", hackerrank_username: "Asha_R" },
      { id: "a2", session_id: "s-other", hackerrank_username: "Asha_R" }
    ];
    expect(alertsForSession(alerts, session).map((a) => a.id)).toEqual(["a1"]);
  });

  it("includes session-less alerts for the same candidate (contest-eval signals)", () => {
    const alerts = [
      { id: "a1", hackerrank_username: "Asha_R" },
      { id: "a2", hackerrank_username: "Someone_Else" }
    ];
    expect(alertsForSession(alerts, session).map((a) => a.id)).toEqual(["a1"]);
  });

  it("matches the candidate by normalized username (username_norm vs raw)", () => {
    const alerts = [{ id: "a1", hackerrank_username: "ASHA_R", username_norm: "asha_r" }];
    expect(alertsForSession(alerts, session)).toHaveLength(1);
  });

  it("excludes another session's alerts even for the same candidate", () => {
    const alerts = [{ id: "a1", session_id: "s-2", hackerrank_username: "Asha_R" }];
    expect(alertsForSession(alerts, session)).toHaveLength(0);
  });
});
