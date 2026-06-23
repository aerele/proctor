// Rule 4 — D13 honest reach. Relocated from evaluationMetrics.mjs:509-511.
// Unsolved problem with real reach (≥2 submits, ≥10min active, low paste) ⇒ a
// talent effort signal credited in the composite (reach_frac), appended to the
// honest_reach pid list. The gating predicate is precomputed as problem.honestReach.

/** @type {import("../types.mjs").Rule} */
export const honestReach = {
  id: "honest_reach",
  category: "talent",
  scope: "per_problem",
  needs: [],
  weight: 30,
  fn(features) {
    const p = features.problem;
    if (!p.honestReach) return null;
    return { kind: "talent", field: "honest_reach", value: p.pid };
  },
};
