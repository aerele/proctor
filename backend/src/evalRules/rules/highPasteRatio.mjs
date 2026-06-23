// Rule 6 — D1 high paste ratio. Relocated from evaluationMetrics.mjs:562-569.
// Gated on paste_inference (the old inline gate at :562): with no paste/selection
// telemetry the axis is inconclusive, never a violation. overallScoringPasteRatio
// is precomputed in extractFeatures.

/** @type {import("../types.mjs").Rule} */
export const highPasteRatio = {
  id: "high_paste_ratio",
  category: "integrity",
  scope: "session",
  needs: ["paste_inference"],
  weight: 80,
  fn(features, ctx) {
    const { paste_ratio_flag: PASTE_RATIO_FLAG } = ctx.config;
    if (!(features.overallScoringPasteRatio > PASTE_RATIO_FLAG)) return null;
    return {
      kind: "flag",
      code: "high_paste_ratio",
      severity: "critical",
      problem_id: null,
      evidence: `Overall paste ratio ${round2(features.overallScoringPasteRatio)} across scoring problems exceeds ${PASTE_RATIO_FLAG}.`,
    };
  },
};

function round2(x) {
  return Math.round(x * 100) / 100;
}
