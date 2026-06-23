// Rule 12 — D15 premeditated clipboard. Relocated from evaluationMetrics.mjs:677-698.
// Gated on `clipboard` (behavior-neutral: with no clipboard entries the old loop
// matched nothing and emitted no flag). Emits only the flag (the old
// `premeditated_clipboard` bool was a local, never stored in the integrity block).

import { collapseWs } from "../../evaluationReplay.mjs";

/** @type {import("../types.mjs").Rule} */
export const premeditatedClipboard = {
  id: "premeditated_clipboard",
  category: "integrity",
  scope: "session",
  needs: ["clipboard"],
  weight: 90,
  fn(features, ctx) {
    const { clipboard_match_min: CLIPBOARD_MATCH_MIN } = ctx.config;
    const replay = features.replay;
    const clipboardEntries = features.clipboardEntries || [];
    const firstForeign = replay.pastes.find((p) => p.foreign && collapseWs(p.text).length >= CLIPBOARD_MATCH_MIN);
    if (!firstForeign) return null;
    const fc = collapseWs(firstForeign.text);
    let premeditated = false;
    for (const entry of clipboardEntries) {
      const ce = collapseWs(entry);
      if (ce.length < CLIPBOARD_MATCH_MIN) continue;
      if (ce.includes(fc) || fc.includes(ce)) {
        premeditated = true;
        break;
      }
    }
    if (!premeditated) return null;
    return {
      kind: "flag",
      code: "premeditated_clipboard",
      severity: "critical",
      problem_id: firstForeign.problem_id,
      evidence: `Entry-clipboard snapshot matches the first foreign paste (premeditated).`,
    };
  },
};
