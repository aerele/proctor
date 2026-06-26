// Rule 7 — D2 foreign-paste flags. Relocated from evaluationMetrics.mjs:571-589.
// One flag per foreign paste, in foreign_pastes order: critical
// (foreign_paste_after_away) when correlated with a switch-away, else warning
// (foreign_paste). No availability gate (matches the old code).
//
// EVAL-2 MAJOR-3 — reconstruction-unreliable tag: when the paste's problem had
// replay glitches, foreign-ness can't be confidently asserted (extractFeatures
// tags the record `reconstruction_unreliable`). Rather than drop it (the old
// silent side-list a cheater could forge a glitch to hit), we still flag it but
// DOWNGRADE one severity notch — after-away critical→warning, plain warning→info
// — carry `unverified: true` on the flag, and note it in the evidence string so
// the recommendation + eval UI render the uncertainty. A glitch-free paste is
// unchanged.

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
      const unreliable = fp.reconstruction_unreliable === true;
      const tag = unreliable ? " (reconstruction unreliable — unverified)" : "";
      if (fp.after_away_ms != null) {
        out.push({
          kind: "flag",
          code: "foreign_paste_after_away",
          severity: unreliable ? "warning" : "critical",
          problem_id: fp.problem_id,
          evidence: `Foreign paste of ${fp.len} chars ${fp.after_away_ms}ms after a switch-away episode.${tag}`,
          ...(unreliable ? { unverified: true } : {}),
        });
      } else {
        out.push({
          kind: "flag",
          code: "foreign_paste",
          severity: unreliable ? "info" : "warning",
          problem_id: fp.problem_id,
          evidence: `Foreign paste of ${fp.len} chars not seen earlier in this session.${tag}`,
          ...(unreliable ? { unverified: true } : {}),
        });
      }
    }
    return out.length ? out : null;
  },
};
