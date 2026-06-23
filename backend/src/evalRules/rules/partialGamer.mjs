// Rule 3 — D12 partial gamer (info). Relocated from evaluationMetrics.mjs:499-506.
// Scoped to the near-stub subset (stub_delta < STUB_DELTA_LINES); emits a
// surfaced info flag only, adds NO discount (the discount is the wider rule 2).

/** @type {import("../types.mjs").Rule} */
export const partialGamer = {
  id: "partial_gamer",
  category: "talent",
  scope: "per_problem",
  needs: [],
  weight: 40,
  fn(features, ctx) {
    const p = features.problem;
    const { stub_delta_lines: STUB_DELTA_LINES } = ctx.config;
    if (!(p.isPartial && p.stub_delta_lines != null && p.stub_delta_lines < STUB_DELTA_LINES)) return null;
    return {
      kind: "flag",
      code: "partial_gamer",
      severity: "info",
      problem_id: p.pid,
      evidence: `Partial score ${p.best_score}/${p.effMax} with only ${p.stub_delta_lines} lines changed from stub.`,
    };
  },
};
