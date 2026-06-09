// frontend/src/shell/examShell.test.ts
import { describe, it, expect } from "vitest";
import {
  deriveStage, stageHint, topBarVisible, STAGE_META,
  formatWallClock, formatExamElapsed,
  type StageInput
} from "./examShell";

const base: StageInput = { fullscreen: true, gate: "form", status: "idle", examReleased: true };

describe("deriveStage", () => {
  it("1 FULLSCREEN: not in fullscreen, in any pre-end state", () => {
    expect(deriveStage({ ...base, fullscreen: false })).toBe(1);
    expect(deriveStage({ ...base, fullscreen: false, gate: "running", status: "recording" })).toBe(1);
    expect(deriveStage({ ...base, fullscreen: false, gate: "pending_approval" })).toBe(1);
  });
  it("2 DETAILS: fullscreen OK, no session yet (gate form), incl. registration in flight", () => {
    expect(deriveStage(base)).toBe(2);
    expect(deriveStage({ ...base, status: "starting" })).toBe(2);
  });
  it("3 GET READY: session exists but surface not live (resume needed / share starting / pending approval)", () => {
    expect(deriveStage({ ...base, gate: "running", status: "idle" })).toBe(3);
    expect(deriveStage({ ...base, gate: "running", status: "starting" })).toBe(3);
    expect(deriveStage({ ...base, gate: "pending_approval", status: "idle" })).toBe(3);
  });
  it("3 GET READY: recording but the room gate has not released the exam (S3 seam)", () => {
    expect(deriveStage({ ...base, gate: "running", status: "recording", examReleased: false })).toBe(3);
  });
  it("4 IN EXAM: recording (and ending) with the exam released", () => {
    expect(deriveStage({ ...base, gate: "running", status: "recording" })).toBe(4);
    expect(deriveStage({ ...base, gate: "running", status: "ending" })).toBe(4);
  });
  it("5 DONE: ended wins over everything, even out of fullscreen", () => {
    expect(deriveStage({ ...base, gate: "ended", status: "ended", fullscreen: false })).toBe(5);
    expect(deriveStage({ ...base, gate: "running", status: "ended" })).toBe(5);
  });
  it("locked reports 3 (the bar is hidden on the locked screen anyway)", () => {
    expect(deriveStage({ ...base, gate: "locked", status: "idle" })).toBe(3);
  });
});

describe("STAGE_META", () => {
  it("carries the spec §4 label + color block per stage", () => {
    expect(STAGE_META[1]).toEqual({ label: "FULLSCREEN", blockClass: "bg-red-600" });
    expect(STAGE_META[2]).toEqual({ label: "DETAILS", blockClass: "bg-amber-500" });
    expect(STAGE_META[3]).toEqual({ label: "GET READY", blockClass: "bg-sky-500" });
    expect(STAGE_META[4]).toEqual({ label: "IN EXAM", blockClass: "bg-emerald-600" });
    expect(STAGE_META[5]).toEqual({ label: "DONE", blockClass: "bg-indigo-600" });
  });
});

describe("topBarVisible", () => {
  it("bar renders unless an anomaly episode is active or the session is locked", () => {
    expect(topBarVisible(false, "form")).toBe(true);
    expect(topBarVisible(false, "running")).toBe(true);
    expect(topBarVisible(false, "ended")).toBe(true);
    expect(topBarVisible(true, "running")).toBe(false);
    expect(topBarVisible(false, "locked")).toBe(false);
  });
});

describe("stageHint", () => {
  it("stage 1: fullscreen instruction", () => {
    expect(stageHint({ ...base, fullscreen: false, ownEditor: true })).toMatch(/fullscreen/i);
  });
  it("stage 2: details + start proctoring", () => {
    expect(stageHint({ ...base, ownEditor: true })).toMatch(/details/i);
  });
  it("stage 3 variants: pending approval / locked / resume / share prompt / end-retry / waiting for release", () => {
    expect(stageHint({ ...base, gate: "pending_approval", ownEditor: true })).toMatch(/approve/i);
    expect(stageHint({ ...base, gate: "locked", ownEditor: true })).toMatch(/locked/i);
    expect(stageHint({ ...base, gate: "running", status: "idle", ownEditor: true })).toMatch(/resume recording/i);
    expect(stageHint({ ...base, gate: "running", status: "starting", ownEditor: true })).toMatch(/entire screen/i);
    expect(stageHint({ ...base, gate: "running", status: "error", ownEditor: true })).toMatch(/retry/i);
    expect(stageHint({ ...base, gate: "running", status: "recording", examReleased: false, ownEditor: true })).toMatch(/room/i);
  });
  it("stage 4: own-editor copy never mentions HackerRank; legacy copy does", () => {
    const own = stageHint({ ...base, gate: "running", status: "recording", ownEditor: true });
    expect(own).toMatch(/coding workspace/i);
    expect(own).not.toMatch(/hackerrank/i);
    expect(stageHint({ ...base, gate: "running", status: "recording", ownEditor: false })).toMatch(/HackerRank/);
  });
  it("stage 5: complete", () => {
    expect(stageHint({ ...base, gate: "ended", status: "ended", ownEditor: true })).toMatch(/complete/i);
  });
});

describe("formatWallClock", () => {
  it("renders HH:MM:SS local time, zero-padded", () => {
    expect(formatWallClock(new Date(2026, 5, 10, 9, 5, 3))).toBe("09:05:03");
    expect(formatWallClock(new Date(2026, 5, 10, 23, 59, 59))).toBe("23:59:59");
  });
});

describe("formatExamElapsed", () => {
  it("renders H:MM:SS with unpadded hours", () => {
    expect(formatExamElapsed(0)).toBe("0:00:00");
    expect(formatExamElapsed(61)).toBe("0:01:01");
    expect(formatExamElapsed(3723)).toBe("1:02:03");
  });
  it("clamps negatives to zero", () => {
    expect(formatExamElapsed(-5)).toBe("0:00:00");
  });
});
