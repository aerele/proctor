// Rule 10 — D9 artifacts + provenance over submission sources. Relocated from
// evaluationMetrics.mjs:610-618. ALWAYS emits integrity.artifacts (object) and
// integrity.provenance_hits (array) — even when empty — because the old code
// unconditionally wrote those two fields (starting {} / []). It therefore has NO
// availability gate: gating it would drop the two fields and change the scorecard
// bytes when a candidate has no submissions.

import { artifacts, provenance } from "../../evaluationClone.mjs";

/** @type {import("../types.mjs").Rule} */
export const artifactsProvenance = {
  id: "artifacts_provenance",
  category: "integrity",
  scope: "session",
  needs: [],
  weight: 50,
  fn(features) {
    const artifactsAgg = {};
    const provenanceHits = [];
    for (const s of features.submissions) {
      const code = s.source_code || "";
      if (!code) continue;
      for (const a of artifacts(code)) artifactsAgg[a] = (artifactsAgg[a] || 0) + 1;
      for (const p of provenance(code)) provenanceHits.push({ problem_id: s.problem_id, name: p });
    }
    return [
      { kind: "integrity", field: "artifacts", value: artifactsAgg },
      { kind: "integrity", field: "provenance_hits", value: provenanceHits },
    ];
  },
};
