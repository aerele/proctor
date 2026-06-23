// Rule 8 — D4 superhuman cadence. Relocated from evaluationMetrics.mjs:592-600.
// Gated on editor_coverage (cadence is meaningless without editor events; the
// old code computed cadence only over replayed keystrokes). Reads the precomputed
// cadence object (computeCadence stays a shared feature step).

/** @type {import("../types.mjs").Rule} */
export const superhumanCadence = {
  id: "superhuman_cadence",
  category: "integrity",
  scope: "session",
  needs: ["editor_coverage"],
  weight: 60,
  fn(features, ctx) {
    const { superhuman_cps: SUPERHUMAN_CPS } = ctx.config;
    const bursts = features.cadence.superhuman_bursts;
    if (!bursts.length) return null;
    const b = bursts[0];
    return {
      kind: "flag",
      code: "superhuman_cadence",
      severity: "warning",
      problem_id: b.problem_id,
      evidence: `Run of ${b.run_len} typed characters at ${b.cps} chars/s (≥${SUPERHUMAN_CPS}).`,
    };
  },
};
