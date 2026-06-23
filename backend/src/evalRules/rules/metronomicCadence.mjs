// Rule 9 — D4 metronomic cadence. Relocated from evaluationMetrics.mjs:601-608.
// Gated on editor_coverage (same rationale as rule 8 — and behavior-neutral,
// since with no events cadence.metronomic is false). Reads precomputed cadence.

/** @type {import("../types.mjs").Rule} */
export const metronomicCadence = {
  id: "metronomic_cadence",
  category: "integrity",
  scope: "session",
  needs: ["editor_coverage"],
  weight: 60,
  fn(features, ctx) {
    const { metronomic_cv: METRONOMIC_CV, metronomic_min_keys: METRONOMIC_MIN_KEYS } = ctx.config;
    if (!features.cadence.metronomic) return null;
    return {
      kind: "flag",
      code: "metronomic_cadence",
      severity: "warning",
      problem_id: null,
      evidence: `Inter-character timing gaps show CV<${METRONOMIC_CV} over ≥${METRONOMIC_MIN_KEYS} characters (replayer-like).`,
    };
  },
};
