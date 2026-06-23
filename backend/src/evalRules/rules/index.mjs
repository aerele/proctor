// backend/src/evalRules/rules/index.mjs
//
// THE REGISTRY (EVAL-1 / F14). A flat array of rule descriptors. The engine
// iterates this array; adding/removing a per-candidate rule is a one-line edit
// here plus one rule file — with NO change to engine.mjs, deriveTiers,
// serialization, or routes.
//
// ORDER IS LOAD-BEARING. The array is authored in the exact legacy flag-append
// order so the scorecard (esp. buildOneLine's "top flag" and any
// order-dependent output) is byte-identical to the pre-refactor code:
//   per-problem rules (1–5) run first, pid-by-pid, in this array's order within
//   each pid (zero_effort then partial_gamer — the original interleave); then
//   the session rules (6–12) run in this array's order. See engine.mjs.

import { zeroEffortSolve } from "./zeroEffortSolve.mjs";
import { partialDiscount } from "./partialDiscount.mjs";
import { partialGamer } from "./partialGamer.mjs";
import { honestReach } from "./honestReach.mjs";
import { firstAttemptSolve } from "./firstAttemptSolve.mjs";
import { highPasteRatio } from "./highPasteRatio.mjs";
import { foreignPaste } from "./foreignPaste.mjs";
import { superhumanCadence } from "./superhumanCadence.mjs";
import { metronomicCadence } from "./metronomicCadence.mjs";
import { artifactsProvenance } from "./artifactsProvenance.mjs";
import { replayTamper } from "./replayTamper.mjs";
import { premeditatedClipboard } from "./premeditatedClipboard.mjs";

/** @type {import("../types.mjs").Rule[]} */
export const RULES = [
  // --- per-problem (run inside the pid iteration, in this order per pid) ---
  zeroEffortSolve, //      1 · D10
  partialDiscount, //      2 · D12 discount accumulator
  partialGamer, //         3 · D12 info flag
  honestReach, //          4 · D13
  firstAttemptSolve, //    5 · D14
  // --- whole-session (run after the per-problem pass, in this order) ---
  highPasteRatio, //       6 · D1
  foreignPaste, //         7 · D2
  superhumanCadence, //    8 · D4
  metronomicCadence, //    9 · D4
  artifactsProvenance, // 10 · D9
  replayTamper, //        11 · D16b
  premeditatedClipboard, //12 · D15
];
