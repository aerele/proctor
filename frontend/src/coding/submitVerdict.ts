// frontend/src/coding/submitVerdict.ts
//
// Presentation mapping for the submit-result banner in the coding workspace.
// Kept as a pure function so the verdict → banner contract is unit-testable:
// "error" means the judging INFRASTRUCTURE failed (e.g. Judge0 timeout), not
// that the candidate's code was wrong — it must read as a neutral "submit
// again", never as a red wrong-answer.
import type { SubmitResult } from "../types";

export type SubmitTone = "success" | "failure" | "neutral";

export type SubmitPresentation = {
  tone: SubmitTone;
  message: string;
};

export function presentSubmitResult(result: SubmitResult): SubmitPresentation {
  if (result.verdict === "error") {
    // Counts are meaningless when judging never completed — show none.
    return { tone: "neutral", message: "Judging failed — please submit again." };
  }
  return {
    tone: result.verdict === "accepted" ? "success" : "failure",
    // S4: authored problems carry points + a scoring mode (per_test /
    // all_or_nothing) — show the earned score next to the raw test counts.
    message: `Verdict: ${result.verdict} — ${result.passed_count}/${result.total} hidden tests passed. Score: ${result.score}/${result.max_points}.`
  };
}
