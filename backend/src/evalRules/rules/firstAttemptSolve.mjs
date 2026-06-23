// Rule 5 — D14 first-attempt solve. Relocated from evaluationMetrics.mjs:514-516.
// First submit accepted with no prior failed run/submit ⇒ appended to the
// first_attempt_solves pid list. Predicate precomputed as problem.firstAttempt.

/** @type {import("../types.mjs").Rule} */
export const firstAttemptSolve = {
  id: "first_attempt_solve",
  category: "talent",
  scope: "per_problem",
  needs: [],
  weight: 30,
  fn(features) {
    const p = features.problem;
    if (!p.firstAttempt) return null;
    return { kind: "talent", field: "first_attempt_solves", value: p.pid };
  },
};
