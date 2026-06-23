// Rule 2 — D12 partial-credit discount (widened 2026-06-20). Relocated from
// evaluationMetrics.mjs:488-491. EVERY partial (best_score>0 && effMax>0 &&
// best_score<effMax) is a non-genuine partial, so its points are discounted from
// the composite via the discountedPartialPoints accumulator. No availability gate
// (matches the old code, which had none here).

/** @type {import("../types.mjs").Rule} */
export const partialDiscount = {
  id: "partial_discount",
  category: "talent",
  scope: "per_problem",
  needs: [],
  weight: 50,
  fn(features) {
    const p = features.problem;
    if (!p.isPartial) return null;
    return { kind: "accumulate", field: "discountedPartialPoints", delta: p.best_score };
  },
};
