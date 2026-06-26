// backend/src/evalRules/types.mjs
//
// Doc-only — JS has no types; this records the shapes the engine and rules pass
// around (EVAL-1 / F14). Importing this module is a no-op (it exports nothing
// runtime-relevant); it exists so the contract has one canonical home.

/**
 * @typedef {Object} Rule
 * @property {string}   id         stable id, e.g. "zero_effort_solve".
 * @property {"integrity"|"talent"} category
 * @property {string[]} needs      availability keys this rule requires; if any is
 *                                  unsatisfied the rule is SKIPPED and emits
 *                                  nothing (absent ⇒ inconclusive, never a
 *                                  violation). e.g. ["editor_coverage"],
 *                                  ["paste_inference"], ["clipboard"].
 * @property {number}   [weight]   advisory ordering/priority; does NOT change
 *                                  math in this phase (composite weights stay in
 *                                  computeComposite). Reserved for future scoring.
 * @property {"session"|"per_problem"} scope  "session" rules run once over the
 *                                  whole feature bundle; "per_problem" rules run
 *                                  once per problem id (with features.problem set).
 * @property {function(features, ctx): (Signal[]|Signal|null)} fn   pure; never
 *                                  mutates shared state, never reads another
 *                                  rule's output.
 * @property {boolean}  [enabled=true]
 */

/**
 * @typedef {Object} Signal   one of:
 *   { kind:"flag", code, severity:"critical"|"warning"|"info", problem_id, evidence,
 *     [unverified] }   // unverified:true marks a foreign paste whose problem
 *                      // reconstruction was glitchy (EVAL-2 MAJOR-3): the flag is
 *                      // emitted one severity notch lower and rendered with an
 *                      // "unverified / reconstruction-unreliable" marker.
 *   { kind:"talent", field, value }        // honest_reach / first_attempt pid
 *   { kind:"integrity", field, value }     // e.g. telemetry_tampered=true,
 *                                          //      replay_mismatches=[...], artifacts={}
 *   { kind:"accumulate", field, delta }    // discountedPartialPoints += best_score
 *   { kind:"coverage_gap", value }         // pushed onto coverage.gaps
 */

export {};
