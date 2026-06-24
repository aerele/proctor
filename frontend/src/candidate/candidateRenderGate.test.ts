// frontend/src/candidate/candidateRenderGate.test.ts
//
// B2 / LT-1 / MI-1 + MA-5 (v1.1 candidate-flow state machine). The render-gate
// is the PRIMARY safety guarantee that exam content never renders outside
// fullscreen, and the MA-5 post-unlock trace confirms a valid unlock out of
// fullscreen lands on the FS_BLOCK block — not a flash of the workspace W1, not
// the classic fallback.

import { describe, it, expect } from "vitest";
import { candidateRenderDecision, type CandidateRenderInput } from "./candidateRenderGate";

// A baseline in-exam, recording, running, fullscreen session with a problem —
// the W1 happy path. Each test overrides only the field under examination.
const inExam: CandidateRenderInput = {
  hasProblem: true,
  status: "recording",
  gate: "running",
  examGateActive: false,
  examViewAllowed: true,
  fullscreen: true
};

describe("candidateRenderDecision — LT-1 render-gate (B2)", () => {
  it("fullscreen + recording + running + hasProblem → exam_workspace (W1)", () => {
    expect(candidateRenderDecision(inExam)).toBe("exam_workspace");
  });

  it("LT-1: recording + running but NOT fullscreen → fullscreen_block, NEVER exam_workspace", () => {
    const decision = candidateRenderDecision({ ...inExam, fullscreen: false });
    expect(decision).toBe("fullscreen_block");
    expect(decision).not.toBe("exam_workspace");
  });

  it("LT-1: not fullscreen wins even WITH a problem ready — content stays hidden", () => {
    // The whole point: a candidate out of fullscreen never sees questions even
    // though hasProblem is true.
    expect(candidateRenderDecision({ ...inExam, hasProblem: true, fullscreen: false })).toBe("fullscreen_block");
  });

  it("fullscreen but no own-editor problem → fall_through (classic fallback), not the block", () => {
    expect(candidateRenderDecision({ ...inExam, hasProblem: false })).toBe("fall_through");
  });

  it("not recording → fall_through (the FS_BLOCK block is recording-only)", () => {
    expect(candidateRenderDecision({ ...inExam, status: "idle", fullscreen: false })).toBe("fall_through");
    expect(candidateRenderDecision({ ...inExam, status: "starting", fullscreen: false })).toBe("fall_through");
  });

  it("room gate still active (examGateActive) → fall_through regardless of fullscreen", () => {
    expect(candidateRenderDecision({ ...inExam, examGateActive: true })).toBe("fall_through");
    expect(candidateRenderDecision({ ...inExam, examGateActive: true, fullscreen: false })).toBe("fall_through");
  });

  it("pre-exam hold / waiting room (examViewAllowed=false) → fall_through (its own branch owns it)", () => {
    expect(candidateRenderDecision({ ...inExam, examViewAllowed: false })).toBe("fall_through");
    expect(candidateRenderDecision({ ...inExam, examViewAllowed: false, fullscreen: false })).toBe("fall_through");
  });

  it("gate not running (e.g. still locked) → fall_through (the locked branch precedes this gate)", () => {
    expect(candidateRenderDecision({ ...inExam, gate: "locked", fullscreen: false })).toBe("fall_through");
  });
});

describe("candidateRenderDecision — MA-5 post-unlock trace", () => {
  // The MA-5 scenario: a valid unlock flips gate locked→running while the
  // candidate is OUT of fullscreen, status stays "recording". The render-gate
  // must put them in the FS_BLOCK block — NOT a flash of W1, NOT the classic
  // fallback — and once they re-enter fullscreen, W1 renders.
  it("just-unlocked, running, recording, OUT of fullscreen → fullscreen_block (no W1 flash)", () => {
    const justUnlocked: CandidateRenderInput = {
      hasProblem: true, // the problem is loaded — a naive gate WOULD flash W1 here
      status: "recording",
      gate: "running",
      examGateActive: false,
      examViewAllowed: true,
      fullscreen: false
    };
    const decision = candidateRenderDecision(justUnlocked);
    expect(decision).toBe("fullscreen_block");
    // The two things MA-5 forbids:
    expect(decision).not.toBe("exam_workspace"); // no flash of the workspace W1
    expect(decision).not.toBe("fall_through"); // not the classic fallback
  });

  it("after re-entering fullscreen, the SAME just-unlocked session renders W1", () => {
    const backInFullscreen: CandidateRenderInput = {
      hasProblem: true,
      status: "recording",
      gate: "running",
      examGateActive: false,
      examViewAllowed: true,
      fullscreen: true
    };
    expect(candidateRenderDecision(backInFullscreen)).toBe("exam_workspace");
  });
});
