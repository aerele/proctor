// frontend/src/coding/problemSwitch.test.ts
//
// S-I §4 (multi-problem candidate workspace) pure logic: status-chip
// derivation, workspace totals, per-problem localStorage draft guards, the
// single-problem/legacy layout pin, submit-summary merging and the
// server-driven cooldown helpers. Spec:
// docs/superpowers/specs/2026-06-10-s-i-multiproblem-detail-spec.md §4.1-4.3.
import { describe, it, expect } from "vitest";
import {
  DRAFT_KEY_PREFIX,
  MAX_DRAFT_CODE_CHARS,
  chipFor,
  clearSessionDrafts,
  cooldownSecondsRemaining,
  draftKey,
  execRetryAfterSeconds,
  mergeSubmitOutcome,
  restoreDraft,
  serializeDraft,
  showProblemSidebar,
  workspaceTotals
} from "./problemSwitch";
import type { ProblemSubmissionSummary, SubmitResult } from "../types";

const summary = (over: Partial<ProblemSubmissionSummary> = {}): ProblemSubmissionSummary => ({
  best_score: 0,
  max_points: 100,
  attempts: 1,
  best_verdict: "wrong_answer",
  last_verdict: "wrong_answer",
  last_submitted_at: "2026-06-11T00:00:00.000Z",
  ...over
});

describe("chipFor (spec §4.1 — submit outcomes ONLY, never Run)", () => {
  it("no submissions → the em-dash 'not started' chip", () => {
    expect(chipFor(undefined)).toEqual({ state: "none", label: "—" });
    expect(chipFor(null)).toEqual({ state: "none", label: "—" });
    expect(chipFor(summary({ attempts: 0 }))).toEqual({ state: "none", label: "—" });
  });

  it("full best → solved chip with score", () => {
    expect(chipFor(summary({ best_score: 100, best_verdict: "accepted" })))
      .toEqual({ state: "solved", label: "✓ 100/100" });
  });

  it("partial best → attempted chip with the partial score", () => {
    expect(chipFor(summary({ best_score: 40 }))).toEqual({ state: "partial", label: "↻ 40/100" });
  });

  it("attempted but zero best → zero chip", () => {
    expect(chipFor(summary({ best_score: 0 }))).toEqual({ state: "zero", label: "✗ 0/100" });
  });

  it("zero-point problem: an accepted verdict still reads solved (never zero)", () => {
    expect(chipFor(summary({ best_score: 0, max_points: 0, best_verdict: "accepted" })))
      .toEqual({ state: "solved", label: "✓ 0/0" });
  });
});

describe("workspaceTotals (spec §4.1 — Total: Σ best / Σ points, solved x/y)", () => {
  const problems = [
    { id: "a", points: 100 },
    { id: "b", points: 150 },
    { id: "c", points: 50 }
  ];

  it("sums best scores over the contest's possible points and counts solved", () => {
    const totals = workspaceTotals(problems, {
      a: summary({ best_score: 100, best_verdict: "accepted" }),
      b: summary({ best_score: 40, max_points: 150 })
    });
    expect(totals).toEqual({ earned: 140, possible: 300, solved: 1, count: 3 });
  });

  it("no submissions → zero earned, zero solved", () => {
    expect(workspaceTotals(problems, {})).toEqual({ earned: 0, possible: 300, solved: 0, count: 3 });
  });

  it("ignores summary entries for problems not in the contest list", () => {
    const totals = workspaceTotals(problems, { ghost: summary({ best_score: 999 }) });
    expect(totals.earned).toBe(0);
  });
});

describe("mergeSubmitOutcome (live submit → summary, mirrors computeSessionSummary)", () => {
  const accepted: SubmitResult = { verdict: "accepted", passed_count: 4, total: 4, score: 100, max_points: 100, submission_id: "s1" };
  const partial: SubmitResult = { verdict: "wrong_answer", passed_count: 2, total: 4, score: 50, max_points: 100, submission_id: "s2" };

  it("first submission creates the summary cell", () => {
    const merged = mergeSubmitOutcome(undefined, partial, "2026-06-11T01:00:00.000Z");
    expect(merged).toEqual({
      best_score: 50, max_points: 100, attempts: 1,
      best_verdict: "wrong_answer", last_verdict: "wrong_answer",
      last_submitted_at: "2026-06-11T01:00:00.000Z"
    });
  });

  it("an improving submission raises best_score and best_verdict", () => {
    const base = mergeSubmitOutcome(undefined, partial, "t1");
    const merged = mergeSubmitOutcome(base, accepted, "t2");
    expect(merged.best_score).toBe(100);
    expect(merged.best_verdict).toBe("accepted");
    expect(merged.attempts).toBe(2);
    expect(merged.last_submitted_at).toBe("t2");
  });

  it("a worse submission keeps best but updates last verdict + attempts", () => {
    const base = mergeSubmitOutcome(undefined, accepted, "t1");
    const merged = mergeSubmitOutcome(base, partial, "t2");
    expect(merged.best_score).toBe(100);
    expect(merged.best_verdict).toBe("accepted");
    expect(merged.last_verdict).toBe("wrong_answer");
    expect(merged.attempts).toBe(2);
  });
});

describe("draft persistence (spec §4.2 — proctor-draft::{session}::{problem})", () => {
  it("draftKey follows the spec's exact scheme", () => {
    expect(draftKey("sess-1", "sum-two")).toBe("proctor-draft::sess-1::sum-two");
    expect(draftKey("sess-1", "sum-two").startsWith(DRAFT_KEY_PREFIX)).toBe(true);
  });

  it("serialize → restore round-trips language + code", () => {
    const raw = serializeDraft({ language: "python", code: "print(1)\n" }, "2026-06-11T00:00:00.000Z");
    expect(restoreDraft(raw, ["python", "cpp"])).toEqual({ language: "python", code: "print(1)\n" });
  });

  it("rejects corrupt JSON", () => {
    expect(restoreDraft("{nope", ["python"])).toBeNull();
    expect(restoreDraft(null, ["python"])).toBeNull();
  });

  it("rejects a stored language not in the problem's languages (fall back to starter)", () => {
    const raw = serializeDraft({ language: "java", code: "class Main {}" }, "t");
    expect(restoreDraft(raw, ["python", "cpp"])).toBeNull();
  });

  it("rejects oversize code (MAX_DRAFT_CODE_CHARS, backend source cap parity)", () => {
    const raw = serializeDraft({ language: "python", code: "x".repeat(MAX_DRAFT_CODE_CHARS + 1) }, "t");
    expect(restoreDraft(raw, ["python"])).toBeNull();
  });

  it("rejects non-string fields", () => {
    expect(restoreDraft(JSON.stringify({ language: "python", code: 42 }), ["python"])).toBeNull();
    expect(restoreDraft(JSON.stringify({ code: "x" }), ["python"])).toBeNull();
  });

  it("clearSessionDrafts removes ONLY this session's draft keys", () => {
    const store = new Map<string, string>([
      [draftKey("sess-1", "a"), "x"],
      [draftKey("sess-1", "b"), "y"],
      [draftKey("sess-2", "a"), "keep"],
      ["unrelated-key", "keep"]
    ]);
    const storage = {
      get length() { return store.size; },
      key: (i: number) => [...store.keys()][i] ?? null,
      removeItem: (k: string) => { store.delete(k); }
    };
    clearSessionDrafts("sess-1", storage);
    expect([...store.keys()]).toEqual([draftKey("sess-2", "a"), "unrelated-key"]);
  });
});

describe("showProblemSidebar (spec §3 task pin — single-problem/legacy unchanged)", () => {
  it("legacy/single-problem contests render NO sidebar", () => {
    expect(showProblemSidebar(0)).toBe(false);
    expect(showProblemSidebar(1)).toBe(false);
  });
  it("multi-problem contests render the switcher", () => {
    expect(showProblemSidebar(2)).toBe(true);
    expect(showProblemSidebar(20)).toBe(true);
  });
});

describe("server cooldown helpers (spec §4.3 — server is the source of truth)", () => {
  it("extracts retry_after_seconds from an ApiError body", () => {
    const error = Object.assign(new Error("rate_limited"), {
      status: 429, code: "rate_limited", body: { error: "rate_limited", retry_after_seconds: 12 }
    });
    expect(execRetryAfterSeconds(error)).toBe(12);
  });

  it("returns null when no machine-readable hint exists", () => {
    expect(execRetryAfterSeconds(new Error("boom"))).toBeNull();
    expect(execRetryAfterSeconds(Object.assign(new Error("x"), { body: { retry_after_seconds: "soon" } }))).toBeNull();
    expect(execRetryAfterSeconds(Object.assign(new Error("x"), { body: { retry_after_seconds: 0 } }))).toBeNull();
    expect(execRetryAfterSeconds(null)).toBeNull();
  });

  it("cooldownSecondsRemaining counts down and clamps at zero", () => {
    expect(cooldownSecondsRemaining(10_000, 4_500)).toBe(6);
    expect(cooldownSecondsRemaining(10_000, 10_000)).toBe(0);
    expect(cooldownSecondsRemaining(10_000, 12_000)).toBe(0);
    expect(cooldownSecondsRemaining(null, 12_000)).toBe(0);
  });
});
