// Rule 7 — D2 foreign-paste flags. Relocated from evaluationMetrics.mjs:571-589.
// One flag per foreign paste, in foreign_pastes order: critical
// (foreign_paste_after_away) when correlated with a switch-away, else warning
// (foreign_paste). No availability gate (matches the old code).

/** @type {import("../types.mjs").Rule} */
export const foreignPaste = {
  id: "foreign_paste",
  category: "integrity",
  scope: "session",
  needs: [],
  weight: 80,
  fn(features) {
    const out = [];
    for (const fp of features.foreign_pastes) {
      if (fp.after_away_ms != null) {
        out.push({
          kind: "flag",
          code: "foreign_paste_after_away",
          severity: "critical",
          problem_id: fp.problem_id,
          evidence: `Foreign paste of ${fp.len} chars ${fp.after_away_ms}ms after a switch-away episode.`,
        });
      } else {
        out.push({
          kind: "flag",
          code: "foreign_paste",
          severity: "warning",
          problem_id: fp.problem_id,
          evidence: `Foreign paste of ${fp.len} chars not seen earlier in this session.`,
        });
      }
    }
    return out.length ? out : null;
  },
};
