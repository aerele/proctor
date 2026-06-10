// frontend/src/coding/submitVerdict.test.ts
//
// The submit-result banner presentation. The backend returns verdict
// "accepted" | "wrong_answer" | "error" — "error" means the judging
// infrastructure failed (e.g. Judge0 timeout), NOT that the candidate's
// code was wrong, so it must render as a neutral "try again" message.
import { describe, it, expect } from "vitest";
import { presentSubmitResult } from "./submitVerdict";
import type { SubmitResult } from "../types";

describe("presentSubmitResult", () => {
  it("renders accepted as a success banner with the hidden-test counts and score", () => {
    const result: SubmitResult = { verdict: "accepted", passed_count: 4, total: 4, score: 100, max_points: 100, submission_id: "s1" };
    const p = presentSubmitResult(result);
    expect(p.tone).toBe("success");
    expect(p.message).toContain("accepted");
    expect(p.message).toContain("4/4 hidden tests passed");
    // S4: authored problems carry points + a scoring mode — surface the earned score.
    expect(p.message).toContain("Score: 100/100");
  });

  it("renders wrong_answer as a failure banner with the hidden-test counts and score", () => {
    const result: SubmitResult = { verdict: "wrong_answer", passed_count: 1, total: 4, score: 25, max_points: 100, submission_id: "s2" };
    const p = presentSubmitResult(result);
    expect(p.tone).toBe("failure");
    expect(p.message).toContain("wrong_answer");
    expect(p.message).toContain("1/4 hidden tests passed");
    expect(p.message).toContain("Score: 25/100");
  });

  it("renders error (judging infra failed) as a NEUTRAL retry message, never as a wrong answer", () => {
    const result: SubmitResult = { verdict: "error", passed_count: 0, total: 4, score: 0, max_points: 100, submission_id: "s3" };
    const p = presentSubmitResult(result);
    expect(p.tone).toBe("neutral");
    expect(p.message).toBe("Judging failed — please submit again.");
    // Must not leak failure framing, misleading 0/N counts, or a 0 score.
    expect(p.message.toLowerCase()).not.toContain("wrong");
    expect(p.message).not.toContain("0/4");
    expect(p.message).not.toContain("Score:");
  });
});
