// frontend/src/examTime.test.ts — pure exam-time math (S5).
import { describe, expect, it } from "vitest";
import { classifyEndAtChange, computeClockSkewMs, formatRemaining, recordingPreExamState, remainingMs, resolveSavedEndAt, sessionElapsedAnchorMs, shouldSurfaceExamTime, waitingRoomGate, waitingRoomMilestone, WAITING_ROOM_WINDOW_MS } from "./examTime";

describe("computeClockSkewMs", () => {
  it("is server minus client", () => {
    expect(computeClockSkewMs("2026-06-09T10:00:10.000Z", Date.parse("2026-06-09T10:00:00.000Z"))).toBe(10_000);
    expect(computeClockSkewMs("2026-06-09T09:59:55.000Z", Date.parse("2026-06-09T10:00:00.000Z"))).toBe(-5_000);
  });
  it("degrades to 0 when the server stamp is missing or invalid", () => {
    expect(computeClockSkewMs(undefined, 123)).toBe(0);
    expect(computeClockSkewMs("", 123)).toBe(0);
    expect(computeClockSkewMs("garbage", 123)).toBe(0);
  });
});

describe("remainingMs", () => {
  const now = Date.parse("2026-06-09T10:00:00.000Z");
  it("returns ms until end_at on the server clock", () => {
    expect(remainingMs("2026-06-09T11:00:00.000Z", now, 0)).toBe(3_600_000);
    // client clock 10 s behind the server → less real time left
    expect(remainingMs("2026-06-09T11:00:00.000Z", now, 10_000)).toBe(3_590_000);
  });
  it("goes negative when time is up", () => {
    expect(remainingMs("2026-06-09T09:59:00.000Z", now, 0)).toBe(-60_000);
  });
  it("returns null when end_at is missing or invalid (no countdown shown)", () => {
    expect(remainingMs(undefined, now, 0)).toBeNull();
    expect(remainingMs("", now, 0)).toBeNull();
    expect(remainingMs("garbage", now, 0)).toBeNull();
  });
});

describe("formatRemaining", () => {
  it("formats H:MM:SS", () => {
    expect(formatRemaining(3_661_000)).toBe("1:01:01");
    expect(formatRemaining(59_000)).toBe("0:00:59");
    expect(formatRemaining(3_600_000 * 11 + 5 * 60_000 + 9_000)).toBe("11:05:09");
  });
  it("clamps at zero (never shows negative time)", () => {
    expect(formatRemaining(0)).toBe("0:00:00");
    expect(formatRemaining(-5_000)).toBe("0:00:00");
  });
  it("floors sub-second remainders", () => {
    expect(formatRemaining(1_999)).toBe("0:00:01");
  });
});

// D1: a live exam-time adjustment must survive a stale settings-form save.
describe("resolveSavedEndAt", () => {
  const start = "2026-06-09T09:00:00.000Z";
  const formEnd = "2026-06-09T11:00:00.000Z";
  const liveEnd = "2026-06-09T11:30:00.000Z";
  const stamp = "2026-06-09T10:15:00.000Z";

  it("keeps a live-adjusted end_at (stamp present, same start) — stale form value ignored", () => {
    expect(resolveSavedEndAt(
      { start_at: start, end_at: liveEnd, end_at_updated_at: stamp },
      { start_at: start, end_at: formEnd }
    )).toEqual({ end_at: liveEnd, end_at_updated_at: stamp });
  });

  it("same start compares instants, not strings", () => {
    expect(resolveSavedEndAt(
      { start_at: start, end_at: liveEnd, end_at_updated_at: stamp },
      { start_at: "2026-06-09T14:30:00.000+05:30", end_at: formEnd }
    )).toEqual({ end_at: liveEnd, end_at_updated_at: stamp });
  });

  it("a NEW start_at is a new schedule: submitted end_at wins, stamp clears", () => {
    expect(resolveSavedEndAt(
      { start_at: start, end_at: liveEnd, end_at_updated_at: stamp },
      { start_at: "2026-06-10T09:00:00.000Z", end_at: formEnd }
    )).toEqual({ end_at: formEnd });
  });

  it("no stamp → the form still owns end_at", () => {
    expect(resolveSavedEndAt(
      { start_at: start, end_at: liveEnd },
      { start_at: start, end_at: formEnd }
    )).toEqual({ end_at: formEnd });
    expect(resolveSavedEndAt(null, { start_at: start, end_at: formEnd })).toEqual({ end_at: formEnd });
  });
});

describe("classifyEndAtChange", () => {
  it("initial when nothing was shown before", () => {
    expect(classifyEndAtChange(undefined, "2026-06-09T11:00:00.000Z")).toBe("initial");
    expect(classifyEndAtChange("", "2026-06-09T11:00:00.000Z")).toBe("initial");
  });
  it("unchanged for the same instant or an unusable next value", () => {
    expect(classifyEndAtChange("2026-06-09T11:00:00.000Z", "2026-06-09T11:00:00.000Z")).toBe("unchanged");
    expect(classifyEndAtChange("2026-06-09T11:00:00.000Z", "")).toBe("unchanged");
    expect(classifyEndAtChange("2026-06-09T11:00:00.000Z", "garbage")).toBe("unchanged");
  });
  it("extended / shortened by comparing instants", () => {
    expect(classifyEndAtChange("2026-06-09T11:00:00.000Z", "2026-06-09T11:30:00.000Z")).toBe("extended");
    expect(classifyEndAtChange("2026-06-09T11:00:00.000Z", "2026-06-09T10:45:00.000Z")).toBe("shortened");
  });
});

// F7 (e2e finding): the ELAPSED counter anchors on the session's server-side
// start, mapped to the client clock, so recorder restarts never reset it.
describe("sessionElapsedAnchorMs", () => {
  const clientNow = Date.parse("2026-06-12T10:30:00.000Z");

  it("maps created_at onto the client clock (zero skew → identity)", () => {
    const createdAt = "2026-06-12T10:00:00.000Z";
    const anchor = sessionElapsedAnchorMs(createdAt, "2026-06-12T10:30:00.000Z", clientNow);
    expect(anchor).toBe(Date.parse(createdAt));
    // 30 minutes elapsed, regardless of which recording stint is running.
    expect(Math.floor((clientNow - anchor) / 1000)).toBe(1800);
  });

  it("corrects for clock skew the same way the countdown does", () => {
    // Client clock 5 minutes BEHIND the server: server_now reads 10:35 when
    // the client reads 10:30. Session started 10:00 server time → elapsed is
    // 35 minutes of server time, anchored correctly on the client clock.
    const anchor = sessionElapsedAnchorMs("2026-06-12T10:00:00.000Z", "2026-06-12T10:35:00.000Z", clientNow);
    expect(Math.floor((clientNow - anchor) / 1000)).toBe(35 * 60);
  });

  it("falls back to 'now' (stint start) when created_at is missing or garbage", () => {
    expect(sessionElapsedAnchorMs(undefined, "2026-06-12T10:30:00.000Z", clientNow)).toBe(clientNow);
    expect(sessionElapsedAnchorMs("", undefined, clientNow)).toBe(clientNow);
    expect(sessionElapsedAnchorMs("not-a-date", undefined, clientNow)).toBe(clientNow);
  });

  it("clamps a future anchor to 'now' so elapsed never renders negative", () => {
    // A skewed/garbled stamp placing the start in the client future.
    const anchor = sessionElapsedAnchorMs("2026-06-12T11:00:00.000Z", undefined, clientNow);
    expect(anchor).toBe(clientNow);
  });
});

// #135 take-home — the candidate WaitingRoom gate (pure boundary math).
describe("waitingRoomGate — 15-min boundary (T-F1)", () => {
  const now = Date.parse("2026-06-22T10:00:00.000Z");
  const at = (msFromNow: number) => new Date(now + msFromNow).toISOString();

  it("T-F1: +14:59 to T0 → waitingRoomActive, not tooEarly (inside the window, pre-T0)", () => {
    const g = waitingRoomGate(at(14 * 60_000 + 59_000), now, 0);
    expect(g.msUntilStart).toBe(14 * 60_000 + 59_000);
    expect(g.waitingRoomActive).toBe(true);
    expect(g.tooEarly).toBe(false);
  });

  it("T-F1: exactly +15:00 to T0 → still inside the window (<= boundary), waitingRoomActive", () => {
    const g = waitingRoomGate(at(WAITING_ROOM_WINDOW_MS), now, 0);
    expect(g.waitingRoomActive).toBe(true);
    expect(g.tooEarly).toBe(false);
  });

  it("T-F1: +15:01 to T0 → tooEarly, NOT waitingRoomActive (beyond the window)", () => {
    const g = waitingRoomGate(at(WAITING_ROOM_WINDOW_MS + 1_000), now, 0);
    expect(g.waitingRoomActive).toBe(false);
    expect(g.tooEarly).toBe(true);
  });

  it("T-F1: -1s (just past T0) → BOTH false (exam open, W1 condition satisfied)", () => {
    const g = waitingRoomGate(at(-1_000), now, 0);
    expect(g.msUntilStart).toBe(-1_000);
    expect(g.waitingRoomActive).toBe(false);
    expect(g.tooEarly).toBe(false);
  });

  it("T-F1: exactly at T0 (0ms) → both false (msUntilStart > 0 required for waiting)", () => {
    const g = waitingRoomGate(at(0), now, 0);
    expect(g.waitingRoomActive).toBe(false);
    expect(g.tooEarly).toBe(false);
  });

  it("T-F1: missing/unparseable start_at → null + both false (no take-home schedule, no gate)", () => {
    expect(waitingRoomGate(undefined, now, 0)).toEqual({ msUntilStart: null, waitingRoomActive: false, tooEarly: false });
    expect(waitingRoomGate("", now, 0)).toEqual({ msUntilStart: null, waitingRoomActive: false, tooEarly: false });
    expect(waitingRoomGate("garbage", now, 0)).toEqual({ msUntilStart: null, waitingRoomActive: false, tooEarly: false });
  });
});

describe("waitingRoomGate — clock skew (T-F2)", () => {
  const localNow = Date.parse("2026-06-22T10:00:00.000Z");
  // T0 is 10 minutes ahead on the SERVER clock.
  const startAt = new Date(localNow + 10 * 60_000).toISOString();

  it("T-F2: with no skew, a +10min start is inside the window", () => {
    const g = waitingRoomGate(startAt, localNow, 0);
    expect(g.msUntilStart).toBe(10 * 60_000);
    expect(g.waitingRoomActive).toBe(true);
  });

  it("T-F2: the gate flips at SERVER T0, not the local clock (skew applied)", () => {
    // Server is 30s AHEAD of local (server_now 30s later than local). The skew-
    // corrected remaining = end - (local + skew) → 30s LESS real time to T0.
    const skew = computeClockSkewMs(new Date(localNow + 30_000).toISOString(), localNow);
    expect(skew).toBe(30_000);
    const g = waitingRoomGate(startAt, localNow, skew);
    expect(g.msUntilStart).toBe(10 * 60_000 - 30_000); // server time, not local
    expect(g.waitingRoomActive).toBe(true);
  });

  it("T-F2 (stale-config server_now): a 5-min-old server stamp would put us PAST a near T0 by local clock, but the fresh re-evaluation crosses correctly", () => {
    // start_at is +20s out by the SERVER clock; the client clock is 90s SLOW
    // (server_now is 90s ahead). Without skew correction the client thinks it has
    // 20s left; WITH skew the server says T0 already passed 70s ago → exam open.
    const start = new Date(localNow + 20_000).toISOString();
    const skew = computeClockSkewMs(new Date(localNow + 90_000).toISOString(), localNow);
    expect(skew).toBe(90_000);
    const g = waitingRoomGate(start, localNow, skew);
    expect(g.msUntilStart).toBe(20_000 - 90_000); // -70s → past T0 on the server
    expect(g.waitingRoomActive).toBe(false); // exam open, not waiting
    expect(g.tooEarly).toBe(false);
  });
});

// #135 take-home — the recording pre-exam render precedence. The load-bearing
// invariant (FIX #1, spec §4d): a tooEarly candidate whose session is already
// recording must HOLD on the come-back-later screen and must NEVER fall through
// to the live exam (an admin pushing start_at >15 min out mid-wait must not leak
// the questions pre-T0).
describe("recordingPreExamState — pre-T0 hold precedence (FIX #1)", () => {
  it("tooEarly while recording HOLDS and never allows the exam view", () => {
    const s = recordingPreExamState({ tooEarly: true, waitingRoomActive: false });
    expect(s.holdWhileRecording).toBe(true);
    expect(s.examViewAllowed).toBe(false); // the question-leak guard
    expect(s.waitingRoomActive).toBe(false);
  });

  it("tooEarly wins even if the waiting-window boolean is somehow also set", () => {
    // Defense in depth: tooEarly and waitingRoomActive are mutually exclusive in
    // examTime math, but the precedence must still hold the candidate, not leak.
    const s = recordingPreExamState({ tooEarly: true, waitingRoomActive: true });
    expect(s.holdWhileRecording).toBe(true);
    expect(s.examViewAllowed).toBe(false);
    expect(s.waitingRoomActive).toBe(false);
  });

  it("inside the 15-min window → waiting room, not the exam, not the hold", () => {
    const s = recordingPreExamState({ tooEarly: false, waitingRoomActive: true });
    expect(s.holdWhileRecording).toBe(false);
    expect(s.waitingRoomActive).toBe(true);
    expect(s.examViewAllowed).toBe(false);
  });

  it("past T0 (neither hold nor waiting) → the live exam is allowed", () => {
    const s = recordingPreExamState({ tooEarly: false, waitingRoomActive: false });
    expect(s.holdWhileRecording).toBe(false);
    expect(s.waitingRoomActive).toBe(false);
    expect(s.examViewAllowed).toBe(true);
  });

  it("the three states are mutually exclusive across every input combo", () => {
    for (const tooEarly of [true, false]) {
      for (const waitingRoomActive of [true, false]) {
        const s = recordingPreExamState({ tooEarly, waitingRoomActive });
        const flags = [s.holdWhileRecording, s.waitingRoomActive, s.examViewAllowed].filter(Boolean);
        expect(flags.length).toBe(1); // exactly one branch is ever active
      }
    }
  });
});

// #135 take-home — heartbeat exam-time surfacing gate (FIX #2). The backend now
// always emits start_at, so the non-take-home path must stay byte-identical:
// the trigger fires only on end_at (as before) unless take_home is set.
describe("shouldSurfaceExamTime — non-remote byte-identity (FIX #2)", () => {
  it("non-take-home with start_at but no end_at does NOT fire (pre-#135 behavior)", () => {
    expect(shouldSurfaceExamTime({ startAt: "2026-06-22T10:00:00.000Z" })).toBe(false);
    expect(shouldSurfaceExamTime({ startAt: "2026-06-22T10:00:00.000Z", takeHome: false })).toBe(false);
  });

  it("non-take-home with end_at fires (unchanged from before)", () => {
    expect(shouldSurfaceExamTime({ endAt: "2026-06-22T11:00:00.000Z" })).toBe(true);
    expect(shouldSurfaceExamTime({ endAt: "2026-06-22T11:00:00.000Z", startAt: "2026-06-22T10:00:00.000Z" })).toBe(true);
  });

  it("take-home with start_at fires even without end_at (waiting-room countdown stays live)", () => {
    expect(shouldSurfaceExamTime({ startAt: "2026-06-22T10:00:00.000Z", takeHome: true })).toBe(true);
  });

  it("nothing present → no fire", () => {
    expect(shouldSurfaceExamTime({})).toBe(false);
    expect(shouldSurfaceExamTime({ takeHome: true })).toBe(false);
  });
});

describe("waitingRoomMilestone — coarse a11y announcements (A9)", () => {
  it("buckets to 10 / 5 / 1 minute, then 'started'; null beyond 10 min", () => {
    // The announcement is the NEXT milestone at-or-above the remaining minutes
    // (ceil): you hear "10 minutes" until you cross into the ≤5 bucket, etc.
    expect(waitingRoomMilestone(12 * 60_000)).toBeNull();      // >10 min: silent
    expect(waitingRoomMilestone(10 * 60_000)).toBe("Exam starts in 10 minutes.");
    expect(waitingRoomMilestone(6 * 60_000)).toBe("Exam starts in 10 minutes.");  // ceil(6)=6 → ≤10 bucket
    expect(waitingRoomMilestone(5 * 60_000)).toBe("Exam starts in 5 minutes.");
    expect(waitingRoomMilestone(2 * 60_000)).toBe("Exam starts in 5 minutes.");   // ceil(2)=2 → ≤5 bucket
    expect(waitingRoomMilestone(90_000)).toBe("Exam starts in 5 minutes.");       // ceil(1.5)=2 → ≤5 bucket
    expect(waitingRoomMilestone(60_000)).toBe("Exam starts in 1 minute.");        // ceil(1)=1 → ≤1 bucket
    expect(waitingRoomMilestone(1)).toBe("Exam starts in 1 minute.");
    expect(waitingRoomMilestone(0)).toBe("Your exam has started.");
    expect(waitingRoomMilestone(-5_000)).toBe("Your exam has started.");
    expect(waitingRoomMilestone(null)).toBeNull();
  });
});
