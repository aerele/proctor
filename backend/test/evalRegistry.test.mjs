// backend/test/evalRegistry.test.mjs
//
// EVAL-1 / F14 acceptance: a rule can be ADDED, REMOVED (enabled:false), and
// re-thresholded via config — all WITHOUT editing the engine, deriveTiers,
// serialization, or routes. We exercise runRegistry directly with a synthetic
// feature bundle + custom rule arrays so the test proves the seam itself, not a
// particular detector. The existing 104-assertion suite
// (evaluationMetrics.test.mjs + clone + recommend) proves the relocation is
// behavior-preserving; this file proves the data-driven extensibility goal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runRegistry } from "../src/evalRules/engine.mjs";
import { RULES } from "../src/evalRules/rules/index.mjs";
import { DEFAULT_RULE_CONFIG } from "../src/evalRules/config.mjs";

// Minimal feature bundle the engine needs: one problem, no special telemetry.
function fakeFeatures(overrides = {}) {
  return {
    replay: { events_n: 5, paste_inference_available: false, problems: {}, pastes: [], submit_snapshots: [] },
    shellEvents: [],
    submissions: [],
    clipboardEntries: [],
    foreign_pastes: [],
    cadence: { superhuman_bursts: [], metronomic: false },
    editorCoveragePresent: true,
    problemsWithEvents: new Set(["p1"]),
    allPids: new Set(["p1"]),
    per_problem: { p1: { best_score: 50, max_points: 100 } },
    problemDetail: {
      p1: { pid: "p1", tier: "med", best_score: 50, effMax: 100, active_ms: 5000, typed: 200, codeLen: 400, stub_delta_lines: 30, zeroEffort: false, isPartial: true, honestReach: false, firstAttempt: false },
    },
    overallScoringPasteRatio: 0,
    ...overrides,
  };
}

// A throwaway demo rule — NO edit to engine.mjs to introduce it. It fires a
// custom flag whenever a per-problem score is partial.
const demoRule = {
  id: "demo_partial_marker",
  category: "integrity",
  scope: "per_problem",
  needs: [],
  fn(features) {
    const p = features.problem;
    if (!p.isPartial) return null;
    return { kind: "flag", code: "demo_partial_marker", severity: "info", problem_id: p.pid, evidence: `demo on ${p.pid}` };
  },
};

test("registry: a rule can be ADDED as data with no engine edit", () => {
  const f = fakeFeatures();
  const withoutDemo = runRegistry(f, { rules: [], config: DEFAULT_RULE_CONFIG });
  assert.equal(withoutDemo.flags.length, 0, "no rules ⇒ no flags");

  const withDemo = runRegistry(f, { rules: [demoRule], config: DEFAULT_RULE_CONFIG });
  const flag = withDemo.flags.find((fl) => fl.code === "demo_partial_marker");
  assert.ok(flag, "appending one registry entry surfaces its flag");
  assert.equal(flag.problem_id, "p1");
  assert.equal(flag.severity, "info");
});

test("registry: a rule can be REMOVED via enabled:false with no engine edit", () => {
  const f = fakeFeatures();
  const disabled = { ...demoRule, enabled: false };
  const out = runRegistry(f, { rules: [disabled], config: DEFAULT_RULE_CONFIG });
  assert.equal(out.flags.find((fl) => fl.code === "demo_partial_marker"), undefined, "enabled:false ⇒ rule emits nothing");
});

test("registry: a threshold can be changed via config with no code edit", () => {
  // Config-driven rule: fire only when best_score exceeds config.demo_floor.
  const configRule = {
    id: "demo_score_floor",
    category: "talent",
    scope: "per_problem",
    needs: [],
    fn(features, ctx) {
      const p = features.problem;
      if (!(p.best_score > ctx.config.demo_floor)) return null;
      return { kind: "flag", code: "demo_score_floor", severity: "info", problem_id: p.pid, evidence: `${p.best_score}>${ctx.config.demo_floor}` };
    },
  };
  const f = fakeFeatures(); // best_score 50

  const high = runRegistry(f, { rules: [configRule], config: { ...DEFAULT_RULE_CONFIG, demo_floor: 80 } });
  assert.equal(high.flags.length, 0, "floor 80 ⇒ score 50 does not fire");

  const low = runRegistry(f, { rules: [configRule], config: { ...DEFAULT_RULE_CONFIG, demo_floor: 10 } });
  assert.ok(low.flags.find((fl) => fl.code === "demo_score_floor"), "floor 10 ⇒ score 50 fires — threshold is pure data");
});

test("registry: an unsatisfied `needs` SKIPS the rule (absent ⇒ inconclusive)", () => {
  // A rule that needs paste_inference; our fake bundle has it false ⇒ skipped.
  const gatedRule = {
    id: "demo_needs_paste",
    category: "integrity",
    scope: "session",
    needs: ["paste_inference"],
    fn() {
      return { kind: "flag", code: "demo_needs_paste", severity: "critical", problem_id: null, evidence: "should not appear" };
    },
  };
  const f = fakeFeatures(); // paste_inference_available: false
  const out = runRegistry(f, { rules: [gatedRule], config: DEFAULT_RULE_CONFIG });
  assert.equal(out.flags.length, 0, "unsatisfied needs ⇒ rule contributes nothing");

  const f2 = fakeFeatures({ replay: { ...fakeFeatures().replay, paste_inference_available: true } });
  const out2 = runRegistry(f2, { rules: [gatedRule], config: DEFAULT_RULE_CONFIG });
  assert.ok(out2.flags.find((fl) => fl.code === "demo_needs_paste"), "satisfied needs ⇒ rule runs");
});

test("registry: the shipped RULES array is the 12 D1–D17 detectors in append order", () => {
  // Guards the load-bearing ORDER contract (spec §4): per-problem rules first,
  // then session rules, in the documented sequence. A reorder here would change
  // buildOneLine's "top flag" — so this is a tripwire, not just a count.
  const ids = RULES.map((r) => r.id);
  assert.deepEqual(ids, [
    "zero_effort_solve",
    "partial_discount",
    "partial_gamer",
    "honest_reach",
    "first_attempt_solve",
    "high_paste_ratio",
    "foreign_paste",
    "superhuman_cadence",
    "metronomic_cadence",
    "artifacts_provenance",
    "replay_tamper",
    "premeditated_clipboard",
  ]);
});
