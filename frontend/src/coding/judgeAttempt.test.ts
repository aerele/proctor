// frontend/src/coding/judgeAttempt.test.ts
//
// M9 — a failed Run/Submit must NOT silently swallow the rejection. The
// candidate has to see an inline "couldn't reach the judge" message, and that
// message must clear the moment they try again. This isolates the pure attempt
// wrapper that the workspace uses to drive that state.
import { describe, it, expect, vi } from "vitest";
import { JUDGE_UNREACHABLE_MESSAGE, runJudgeAttempt } from "./judgeAttempt";

describe("runJudgeAttempt", () => {
  it("returns the resolved value on success and no error", async () => {
    const outcome = await runJudgeAttempt(async () => ({ verdict: "accepted" }));
    expect(outcome).toEqual({ ok: true, value: { verdict: "accepted" } });
  });

  it("reports the judge-unreachable error instead of throwing when the action rejects", async () => {
    const outcome = await runJudgeAttempt(async () => {
      throw new Error("network down");
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBe(JUDGE_UNREACHABLE_MESSAGE);
    }
  });

  it("treats a non-2xx-style rejection the same friendly way (never leaks raw errors)", async () => {
    const outcome = await runJudgeAttempt(async () => {
      throw { status: 500, body: "boom" };
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBe(JUDGE_UNREACHABLE_MESSAGE);
      expect(outcome.error).not.toContain("500");
    }
  });

  it("invokes the action exactly once per attempt", async () => {
    const action = vi.fn(async () => 7);
    await runJudgeAttempt(action);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("exposes a candidate-facing message that mentions the judge and retrying", () => {
    expect(JUDGE_UNREACHABLE_MESSAGE).toMatch(/judge/i);
    expect(JUDGE_UNREACHABLE_MESSAGE).toMatch(/try again/i);
  });
});
