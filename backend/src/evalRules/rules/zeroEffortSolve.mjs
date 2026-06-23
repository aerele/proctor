// Rule 1 — D10 zero-effort solve. Relocated from evaluationMetrics.mjs:471-479.
// The zeroEffort predicate itself (editor coverage + per-problem events + tier +
// active_ms + typed-frac gates) is precomputed in extractFeatures and surfaced
// as problem.zeroEffort, so the math here is the relocated math. The availability
// gate (editor_coverage + per_problem_events) is declared in `needs` and is the
// same predicate the old code applied inline (:459-460).

/** @type {import("../types.mjs").Rule} */
export const zeroEffortSolve = {
  id: "zero_effort_solve",
  category: "integrity",
  scope: "per_problem",
  needs: ["editor_coverage", "per_problem_events"],
  weight: 100,
  fn(features) {
    const p = features.problem;
    if (!p.zeroEffort) return null;
    return [
      { kind: "integrity", field: "zero_effort_solves", value: p.pid }, // appends to the pid list
      {
        kind: "flag",
        code: "zero_effort_solve",
        severity: "critical",
        problem_id: p.pid,
        evidence: `Accepted ${p.tier} solve with only ${p.active_ms}ms active editing and ${p.typed} typed chars (code ${p.codeLen} chars).`,
      },
    ];
  },
};
