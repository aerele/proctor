// backend/src/evalRules/config.mjs
//
// Thresholds as DATA (EVAL-1 / F14 registry refactor). Every value here is a
// 1:1 relocation of the old `THRESHOLDS` block that lived in
// evaluationMetrics.mjs:26-55 — same numbers, same D-number comments. The
// engine resolves a rule's config from DEFAULT_RULE_CONFIG (with optional
// per-contest override plumbing in the engine), so a threshold change is a data
// change, not a code edit.
//
// Back-compat: evaluationMetrics.mjs still re-exports `THRESHOLDS` (the keyed,
// UPPER_SNAKE shape the test at evaluationMetrics.test.mjs:87-105 asserts
// explicitly), derived from these values. The two MUST stay in lockstep.

export const DEFAULT_RULE_CONFIG = {
  // D3 — switch-away → paste correlation window (paste/burst within 10s of episode end).
  away_paste_window_ms: 10000,
  // D4 — typing cadence.
  superhuman_cps: 14, // ≥14 chars/s sustained ⇒ superhuman
  superhuman_run: 25, // over a run of ≥25 consecutive single-char inserts
  metronomic_cv: 0.15, // coefficient-of-variation < 0.15 ⇒ metronomic (replayer tell)
  metronomic_min_keys: 40, // over ≥40 keystrokes
  // D10 — zero-effort solve.
  zero_effort_active_ms: 120000, // active_ms < 120s
  zero_effort_typed_frac: 0.15, // typed_chars < 0.15 × |code|
  // D1 — overall paste ratio flag across scoring problems.
  paste_ratio_flag: 0.6,
  // D12 — stub-delta partial gamer.
  stub_delta_lines: 10,
  // D13 — honest reach.
  reach_min_submits: 2,
  reach_min_active_ms: 600000, // ≥10 min
  reach_max_paste: 0.3,
  // D6 — inter-candidate paste-content matching minimum length.
  foreign_paste_match_min: 80,
  // D2/integrity-confirmed — full-solution foreign paste length.
  full_solution_paste_len: 300,
  // D16a — silent editor gap while session active (coverage; lowers confidence).
  silent_gap_ms: 300000, // 5 min
  // D16b — replay-vs-submission normalized line distance mismatch.
  mismatch: 0.15,
  // D15 — premeditated clipboard: foreign-paste match length.
  clipboard_match_min: 40,
};

// The legacy UPPER_SNAKE shape, derived from DEFAULT_RULE_CONFIG so there is one
// source of truth. evaluationMetrics.mjs re-exports this as `THRESHOLDS`.
export const THRESHOLDS = {
  AWAY_PASTE_WINDOW_MS: DEFAULT_RULE_CONFIG.away_paste_window_ms,
  SUPERHUMAN_CPS: DEFAULT_RULE_CONFIG.superhuman_cps,
  SUPERHUMAN_RUN: DEFAULT_RULE_CONFIG.superhuman_run,
  METRONOMIC_CV: DEFAULT_RULE_CONFIG.metronomic_cv,
  METRONOMIC_MIN_KEYS: DEFAULT_RULE_CONFIG.metronomic_min_keys,
  ZERO_EFFORT_ACTIVE_MS: DEFAULT_RULE_CONFIG.zero_effort_active_ms,
  ZERO_EFFORT_TYPED_FRAC: DEFAULT_RULE_CONFIG.zero_effort_typed_frac,
  PASTE_RATIO_FLAG: DEFAULT_RULE_CONFIG.paste_ratio_flag,
  STUB_DELTA_LINES: DEFAULT_RULE_CONFIG.stub_delta_lines,
  REACH_MIN_SUBMITS: DEFAULT_RULE_CONFIG.reach_min_submits,
  REACH_MIN_ACTIVE_MS: DEFAULT_RULE_CONFIG.reach_min_active_ms,
  REACH_MAX_PASTE: DEFAULT_RULE_CONFIG.reach_max_paste,
  FOREIGN_PASTE_MATCH_MIN: DEFAULT_RULE_CONFIG.foreign_paste_match_min,
  FULL_SOLUTION_PASTE_LEN: DEFAULT_RULE_CONFIG.full_solution_paste_len,
  SILENT_GAP_MS: DEFAULT_RULE_CONFIG.silent_gap_ms,
  MISMATCH: DEFAULT_RULE_CONFIG.mismatch,
  CLIPBOARD_MATCH_MIN: DEFAULT_RULE_CONFIG.clipboard_match_min,
};
