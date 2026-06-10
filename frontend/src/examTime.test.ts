// frontend/src/examTime.test.ts — pure exam-time math (S5).
import { describe, expect, it } from "vitest";
import { classifyEndAtChange, computeClockSkewMs, formatRemaining, remainingMs, resolveSavedEndAt } from "./examTime";

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

// D1: mirrors the backend adminSaveSettings rule so the demo settings save
// behaves exactly like production.
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
