// backend/src/evalRules/engine.mjs
//
// The data-driven rule engine (EVAL-1 / F14). It runs the registry against a
// feature bundle the orchestrator built ONCE and routes each rule's emitted
// Signals into the exact flags/integrity/talent/accumulator slots that
// deriveTiers + computeComposite already consume. No detector math lives here —
// it lives in the per-rule fns under ./rules/. The engine only sequences and
// routes, so the output stays byte-identical to the old straight-line body.
//
// ORDERING CONTRACT (load-bearing — see spec §4 "Crucial ordering note"):
// flags are appended in a fixed source order the old code relied on
// (buildOneLine picks "the top flag" via flags.find, applyCrossPatches dedupes
// by code|problem_id|evidence). The engine reproduces that order:
//   1. per-problem rules, iterated pid-by-pid in features.allPids order, and
//      within each pid in registry order (zero_effort then partial_gamer, the
//      original interleave).
//   2. session rules, in registry order.
// RULES below is therefore authored in exactly the legacy append order.

import { DEFAULT_RULE_CONFIG } from "./config.mjs";
import { RULES } from "./rules/index.mjs";

// Availability map — formalizes the ad-hoc gates from the old buildScorecard
// (editorCoveragePresent :297, problemsWithEvents :300, pasteInferenceAvailable
// :306). per_problem_events is a predicate over pid because it is checked
// per-problem; the others are session-wide booleans.
export function buildAvail(features) {
  const replay = features.replay;
  return {
    editor_coverage: replay.events_n > 0,
    per_problem_events: features.problemsWithEvents, // Set<pid>; checked per pid
    paste_inference: replay.paste_inference_available === true,
    shell_events: (features.shellEvents || []).length > 0,
    submissions: (features.submissions || []).length > 0,
    clipboard: (features.clipboardEntries || []).length > 0,
  };
}

// A rule's `needs` are satisfied when every key holds. per_problem_events is a
// Set keyed by the CURRENT problem (features.problem.pid) — a per-problem rule
// that needs it is suppressed for problems with no editor events, mirroring the
// old zero-effort gate (:460).
function availSatisfied(avail, key, features) {
  const v = avail[key];
  if (key === "per_problem_events") {
    const pid = features.problem ? features.problem.pid : null;
    return v instanceof Set ? v.has(pid) : false;
  }
  return v === true;
}

function freshCollected() {
  return {
    flags: [],
    talent: { honest_reach: [], first_attempt_solves: [] },
    // zero_effort_solves is an APPEND list (pid order); other integrity fields
    // are scalars (telemetry_tampered, replay_mismatches, artifacts, ...).
    integrity: { zero_effort_solves: [] },
    accumulators: {}, // field => running sum (discountedPartialPoints)
    coverage_gaps: [],
  };
}

function route(sig, collected) {
  if (!sig) return;
  switch (sig.kind) {
    case "flag":
      collected.flags.push({
        code: sig.code,
        severity: sig.severity,
        problem_id: sig.problem_id !== undefined ? sig.problem_id : null,
        evidence: sig.evidence,
      });
      break;
    case "talent":
      if (Array.isArray(collected.talent[sig.field])) collected.talent[sig.field].push(sig.value);
      else collected.talent[sig.field] = sig.value;
      break;
    case "integrity":
      // Array fields (e.g. zero_effort_solves) APPEND; scalar fields assign.
      if (Array.isArray(collected.integrity[sig.field])) collected.integrity[sig.field].push(sig.value);
      else collected.integrity[sig.field] = sig.value;
      break;
    case "accumulate":
      collected.accumulators[sig.field] = (collected.accumulators[sig.field] || 0) + (sig.delta || 0);
      break;
    case "coverage_gap":
      collected.coverage_gaps.push(sig.value);
      break;
    default:
      // Unknown signal kind — ignore (future-proofing; a typo here would be a
      // dropped signal, so rules should be tested against the parity harness).
      break;
  }
}

function runRule(rule, features, ctx, collected) {
  if (rule.enabled === false) return;
  if (!rule.needs.every((k) => availSatisfied(ctx.avail, k, features))) return; // inconclusive
  const out = rule.fn(features, ctx);
  if (!out) return;
  for (const sig of [].concat(out)) route(sig, collected);
}

// runRegistry — the engine entry point. `features` is the bundle built once by
// the orchestrator (extractFeatures). config defaults to DEFAULT_RULE_CONFIG;
// the per-contest override plumbing is a shallow merge, unused in this phase
// (resolved config === DEFAULT_RULE_CONFIG ⇒ identical output).
export function runRegistry(features, { rules = RULES, config = DEFAULT_RULE_CONFIG } = {}) {
  const resolved = config === DEFAULT_RULE_CONFIG ? config : { ...DEFAULT_RULE_CONFIG, ...config };
  const ctx = { config: resolved, avail: buildAvail(features) };
  const collected = freshCollected();

  const perProblem = rules.filter((r) => r.scope === "per_problem");
  const session = rules.filter((r) => r.scope !== "per_problem");

  // 1) per-problem rules, pid-by-pid (allPids order), registry order within pid.
  // features.problemDetail[pid] holds the per-problem rule inputs the old loop
  // computed inline; it is internal to the engine (NOT the scorecard's
  // per_problem table, which keeps its exact serialized shape).
  for (const pid of features.allPids) {
    const problem = features.problemDetail[pid];
    if (!problem) continue;
    const pf = { ...features, problem };
    for (const rule of perProblem) runRule(rule, pf, ctx, collected);
  }

  // 2) session rules, registry order.
  for (const rule of session) runRule(rule, features, ctx, collected);

  return collected;
}
