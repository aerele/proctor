// frontend/src/coding/studentCopy.test.ts
//
// Candidate-facing copy must match the configured test surface. With the
// own-editor problem configured (SLICE1_PROBLEM truthy → ownEditor=true) NO
// candidate-facing string may direct the candidate to HackerRank; with no
// problem configured the original HackerRank copy is served verbatim.
// Admin-facing text and the "HackerRank username" identity field label are
// intentionally NOT part of this module — they keep the HackerRank name in
// both flows.
import { describe, it, expect } from "vitest";
import {
  endTestConfirmation,
  formStageIntro,
  integrityNotices,
  tabAuditMessage,
  testRules
} from "../studentCopy";

const allCandidateStrings = (ownEditor: boolean): string[] => [
  ...testRules(ownEditor).flatMap((rule) => [rule.title, rule.body]),
  endTestConfirmation(ownEditor),
  tabAuditMessage(ownEditor),
  formStageIntro(ownEditor),
  ...integrityNotices(ownEditor)
];

describe("own-editor copy (ownEditor=true)", () => {
  it("never mentions HackerRank in any candidate-facing string", () => {
    for (const s of allCandidateStrings(true)) {
      expect(s.toLowerCase()).not.toContain("hackerrank");
    }
  });

  it("never directs the candidate to an external contest", () => {
    for (const s of allCandidateStrings(true)) {
      expect(s.toLowerCase()).not.toContain("contest");
    }
  });

  it('rules: the stay-focused card title is "Stay on this tab"', () => {
    expect(testRules(true).map((r) => r.title)).toContain("Stay on this tab");
  });

  it("rules: keep-recording card directs sharing until the solution is submitted here", () => {
    const rule = testRules(true).find((r) => r.title === "Keep recording running");
    expect(rule?.body).toContain("until you have submitted your solution here");
  });

  it("rules: end-test card directs ending the test here after submitting", () => {
    const rule = testRules(true).find((r) => r.title === "End the test here when done");
    expect(rule?.body).toContain("After you submit your solution here");
    expect(rule?.body).toContain("End test");
  });

  it("end-test confirmation directs submitting the solution here", () => {
    expect(endTestConfirmation(true)).toContain("after submitting your solution here");
  });

  it("tab audit asks to keep only this proctor session open", () => {
    expect(tabAuditMessage(true)).toContain("Keep only this proctor session open");
  });

  it("form-stage intro points at the coding workspace, not an external site", () => {
    expect(formStageIntro(true)).toContain("coding workspace");
  });

  it("integrity notices reference submitted code instead of HackerRank submissions", () => {
    expect(integrityNotices(true)).toContain(
      "Submitted code may be checked for similarity, unusual structure, and copied code patterns."
    );
  });
});

describe("legacy HackerRank copy (ownEditor=false) is byte-for-byte unchanged", () => {
  it("keeps the original rules-card strings", () => {
    const rules = testRules(false);
    expect(rules.map((r) => r.title)).toContain("Stay on HackerRank and this tab");
    expect(rules.find((r) => r.title === "Keep recording running")?.body).toBe(
      "Screen recording is mandatory and continues even when this tab is hidden. Do not stop sharing until you have fully submitted on HackerRank."
    );
    expect(rules.find((r) => r.title === "Keep your camera visible")?.body).toBe(
      "If a camera is available, keep the self-view (or its pop-out) visible while you work in HackerRank. Microphone is captured when available."
    );
    expect(rules.find((r) => r.title === "End the test here when done")?.body).toBe(
      "After you submit on HackerRank, return and press End test. Closing the tab early is logged as an incomplete session."
    );
  });

  it("keeps the original end-test confirmation", () => {
    expect(endTestConfirmation(false)).toBe(
      "End the proctoring session only after submitting HackerRank. Closing the tab before this step is logged as an incomplete session. No code is needed — just confirm the assurance below."
    );
  });

  it("keeps the original tab-audit message", () => {
    expect(tabAuditMessage(false)).toBe(
      "Tab/focus review active. Keep only HackerRank and this proctor session open; other activity may be visible in the shared-screen recording."
    );
  });

  it("keeps the original form-stage intro", () => {
    expect(formStageIntro(false)).toBe(
      "Enter your details below, then start proctoring before you open the contest. When you start, your browser will ask which screen to share — choose Entire Screen."
    );
  });

  it("keeps the original HackerRank integrity notice and the full 12-notice rotation", () => {
    const notices = integrityNotices(false);
    expect(notices).toHaveLength(12);
    expect(notices).toContain(
      "HackerRank submissions may be checked for similarity, unusual structure, and copied code patterns."
    );
    // Both variants rotate the same number of notices.
    expect(integrityNotices(true)).toHaveLength(12);
  });

  it("both variants expose the same six rule cards (titles aside, same order/count)", () => {
    expect(testRules(false)).toHaveLength(6);
    expect(testRules(true)).toHaveLength(6);
  });
});
