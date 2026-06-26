import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EVALUATOR_VERSION,
  THRESHOLDS,
  awayEpisodes,
  computeCadence,
  correlateAwayPastes,
  stubDeltaLines,
  buildScorecard,
  crossCandidateAnalysis,
  applyCrossPatches,
  identityKeyOf,
} from "../src/evaluationMetrics.mjs";

// ---- helpers ----
function tsAt(ms) {
  return new Date(ms).toISOString();
}
function ins(pid, ms, text, line = 1, col = 1) {
  return {
    type: "editor_insert",
    timestamp: tsAt(ms),
    problem_id: pid,
    detail: { insertedLen: text.length, deletedLen: 0, text, startLine: line, startCol: col, endLine: line, endCol: col },
  };
}
function singleChar(pid, ms, ch = "x", col = 1) {
  return ins(pid, ms, ch, 1, col);
}
// Emit single-char inserts that spell `code` (one keystroke per char), tracking
// line/col so the replayed final content equals `code`. Returns events.
function typeOut(pid, startMs, code, stepMs = 1000) {
  const events = [];
  let line = 1;
  let col = 1;
  let t = startMs;
  for (const ch of code) {
    events.push({
      type: "editor_insert",
      timestamp: tsAt(t),
      problem_id: pid,
      detail: { insertedLen: 1, deletedLen: 0, text: ch, startLine: line, startCol: col, endLine: line, endCol: col },
    });
    if (ch === "\n") {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
    t += stepMs;
  }
  return { events, endMs: t };
}
function pasteEv(pid, ms, len, line = 1, col = 1) {
  return { type: "editor_paste", timestamp: tsAt(ms), problem_id: pid, detail: { len, line, col } };
}
function replEv(pid, ms, beforeLen, text, line = 1, col = 1) {
  return {
    type: "editor_replace",
    timestamp: tsAt(ms),
    problem_id: pid,
    detail: { insertedLen: text.length, deletedLen: 0, text, startLine: line, startCol: col, endLine: line, endCol: col },
  };
}
function submitEv(pid, ms) {
  return { type: "code_submit", timestamp: tsAt(ms), problem_id: pid, detail: { language: "java" } };
}
function runEv(pid, ms) {
  return { type: "code_run", timestamp: tsAt(ms), problem_id: pid, detail: { language: "java" } };
}
function sub(o) {
  return {
    _id: o._id || "sub1",
    problem_id: o.problem_id,
    language: o.language || "java",
    verdict: o.verdict,
    score: o.score != null ? o.score : 0,
    max_points: o.max_points != null ? o.max_points : 100,
    source_code: o.source_code || "",
    created_at: o.created_at,
    person_id: o.person_id != null ? o.person_id : null,
    username_norm: o.username_norm || "u",
  };
}

test("EVALUATOR_VERSION and THRESHOLDS constants", () => {
  assert.equal(EVALUATOR_VERSION, "4");
  assert.equal(THRESHOLDS.AWAY_PASTE_WINDOW_MS, 10000);
  assert.equal(THRESHOLDS.SUPERHUMAN_CPS, 14);
  assert.equal(THRESHOLDS.SUPERHUMAN_RUN, 25);
  assert.equal(THRESHOLDS.METRONOMIC_CV, 0.15);
  assert.equal(THRESHOLDS.METRONOMIC_MIN_KEYS, 40);
  assert.equal(THRESHOLDS.ZERO_EFFORT_ACTIVE_MS, 120000);
  assert.equal(THRESHOLDS.ZERO_EFFORT_TYPED_FRAC, 0.15);
  assert.equal(THRESHOLDS.PASTE_RATIO_FLAG, 0.6);
  assert.equal(THRESHOLDS.STUB_DELTA_LINES, 10);
  assert.equal(THRESHOLDS.REACH_MIN_SUBMITS, 2);
  assert.equal(THRESHOLDS.REACH_MIN_ACTIVE_MS, 600000);
  assert.equal(THRESHOLDS.REACH_MAX_PASTE, 0.3);
  assert.equal(THRESHOLDS.FOREIGN_PASTE_MATCH_MIN, 80);
  assert.equal(THRESHOLDS.FULL_SOLUTION_PASTE_LEN, 300);
  assert.equal(THRESHOLDS.SILENT_GAP_MS, 300000);
  assert.equal(THRESHOLDS.MISMATCH, 0.15);
});

test("identityKeyOf person vs anonymous vs empty", () => {
  assert.equal(identityKeyOf({ person_id: "p1", username_norm: "u1" }), "p1");
  assert.equal(identityKeyOf({ person_id: null, username_norm: "u1" }), "u1");
  assert.equal(identityKeyOf({ person_id: null, username_norm: null }), "");
  assert.equal(identityKeyOf(null), "");
});

test("awayEpisodes from blur/focus and visibility pairs", () => {
  const ev = [
    { type: "window_blur", timestamp: tsAt(1000), detail: {} },
    { type: "window_focus", timestamp: tsAt(4000), detail: {} },
    { type: "visibility_change", timestamp: tsAt(10000), detail: { state: "hidden" } },
    { type: "visibility_change", timestamp: tsAt(13000), detail: { state: "visible" } },
  ];
  const eps = awayEpisodes(ev);
  assert.equal(eps.length, 2);
  assert.equal(eps[0].t0, 1000);
  assert.equal(eps[0].t1, 4000);
  assert.equal(eps[1].t0, 10000);
  assert.equal(eps[1].t1, 13000);
});

test("awayEpisodes switch_away_episode duration + fullscreen expected exclusion", () => {
  const ev = [
    { type: "switch_away_episode", timestamp: tsAt(20000), detail: { count: 1, duration_ms: 2278 } },
    { type: "fullscreen_exit", timestamp: tsAt(30000), detail: { expected: true } }, // benign
    { type: "fullscreen_exit", timestamp: tsAt(40000), detail: { expected: false } }, // counts
  ];
  const eps = awayEpisodes(ev);
  assert.equal(eps.length, 2);
  const swEp = eps.find((e) => e.kind === "switch_away_episode");
  assert.equal(swEp.t0, 20000 - 2278);
  assert.equal(swEp.t1, 20000);
  assert.ok(eps.find((e) => e.kind === "fullscreen_exit" && e.t0 === 40000));
});

test("computeCadence normal: median/p95 inter-key gaps", () => {
  const ts = [];
  for (let i = 0; i < 10; i++) ts.push(i * 200); // 200ms gaps
  const cad = computeCadence({ p1: ts });
  assert.equal(cad.median_ikg_ms, 200);
  assert.equal(cad.metronomic, false); // not enough keys (<40)
  assert.equal(cad.superhuman_bursts.length, 0);
});

test("computeCadence superhuman burst detection", () => {
  // 30 keystrokes at 20ms gaps = 50 chars/s ≥14, run ≥25
  const ts = [];
  for (let i = 0; i < 30; i++) ts.push(i * 20);
  const cad = computeCadence({ p1: ts });
  assert.equal(cad.superhuman_bursts.length, 1);
  assert.ok(cad.superhuman_bursts[0].cps >= 14);
  assert.equal(cad.superhuman_bursts[0].run_len, 30);
});

test("computeCadence metronomic: CV<0.15 over >=40 keys", () => {
  // 50 keystrokes at near-constant 100ms gaps (tiny jitter) → low CV
  const ts = [];
  let t = 0;
  for (let i = 0; i < 50; i++) {
    ts.push(t);
    t += 100 + (i % 2); // 100 or 101 — CV tiny
  }
  const cad = computeCadence({ p1: ts });
  assert.equal(cad.metronomic, true);
});

test("correlateAwayPastes within 10s after episode end and during episode", () => {
  const episodes = [{ t0: 1000, t1: 5000, kind: "blur" }];
  const pastes = [
    { problem_id: "p1", ts: 3000, len: 50 }, // during episode
    { problem_id: "p1", ts: 8000, len: 60 }, // 3s after end → within 10s
    { problem_id: "p1", ts: 20000, len: 70 }, // too late
  ];
  const out = correlateAwayPastes(pastes, [], episodes);
  assert.equal(out.length, 2);
  assert.equal(out[0].after_away_ms, 0); // during
  assert.equal(out[1].after_away_ms, 3000);
});

test("stubDeltaLines line-level distance", () => {
  const stub = "public class Main {\n  // code\n}";
  const same = "public class Main {\n  // code\n}";
  assert.equal(stubDeltaLines(same, stub), 0);
  const changed = "public class Main {\n  int x = 1;\n  return x;\n}";
  assert.ok(stubDeltaLines(changed, stub) >= 2);
});

// ---- buildScorecard scenarios ----

function baseInput(overrides) {
  return {
    contest_slug: "c1",
    identity: { person_id: null, username_norm: "u1", candidate_id: "cand1", name: "U One" },
    sessions: [{ session_id: "s1", room: "R1", start_ip: "10.0.0.5", ip_change_count: 0, fullscreen_exit_count: 0 }],
    submissions: [],
    editorEvents: [],
    shellEvents: [],
    problemPoints: { p1: 100 },
    stubsByProblem: { p1: ["public class Main {\n  // Write your code here\n}\n"] },
    hardness: () => "med",
    maxTotal: 100,
    clipboardEntries: [],
    ...overrides,
  };
}

test("buildScorecard basic schema + identity fields", () => {
  const sc = buildScorecard(baseInput({}));
  assert.equal(sc.schema_version, 1);
  assert.equal(sc.evaluator_version, "4");
  assert.equal(sc.contest_slug, "c1");
  assert.equal(sc.person_id, null);
  assert.equal(sc.username_norm, "u1");
  assert.equal(sc.identity_key, "u1");
  assert.deepEqual(sc.session_ids, ["s1"]);
  assert.ok(sc.coverage);
  assert.ok(sc.talent);
  assert.ok(sc.integrity);
  assert.ok(Array.isArray(sc.flags));
  assert.ok(sc.tiers);
  assert.ok(sc.cross_inputs);
  assert.equal(sc.recommended_action, null);
});

test("buildScorecard zero-effort solve flag (D10)", () => {
  // accepted med solve, tiny active editing, near-zero typed, big code that
  // arrived as one large paste (so replayed state == submitted code: no tamper).
  const code = "class S { int f(){ return 42; } }".repeat(20); // big code, single insert
  const events = [
    pasteEv("p1", 1000, code.length),
    replEv("p1", 1050, 0, code), // paste-classified → 0 typed chars
    submitEv("p1", 1500),
  ];
  const sc = buildScorecard(
    baseInput({
      editorEvents: events,
      submissions: [sub({ problem_id: "p1", verdict: "accepted", score: 100, max_points: 100, source_code: code, created_at: tsAt(1500) })],
      hardness: () => "med",
    })
  );
  assert.equal(sc.integrity.telemetry_tampered, false); // replayed matches submitted
  assert.ok(sc.integrity.zero_effort_solves.includes("p1"));
  assert.ok(sc.flags.find((f) => f.code === "zero_effort_solve" && f.severity === "critical"));
  assert.equal(sc.tiers.integrity, "flag");
});

test("buildScorecard stub-delta partial gamer (D12)", () => {
  const stub = "public class Main {\n  public static void main(String[] a){\n    // Write your code here\n  }\n}\n";
  // final content = stub + 1 trivial line → partial score, <10 line delta
  const finalCode = "public class Main {\n  public static void main(String[] a){\n    System.out.println(1);\n  }\n}\n";
  const events = [ins("p1", 1000, finalCode, 1, 1)];
  const sc = buildScorecard(
    baseInput({
      editorEvents: events,
      stubsByProblem: { p1: [stub] },
      problemPoints: { p1: 100 },
      submissions: [sub({ problem_id: "p1", verdict: "wrong_answer", score: 40, max_points: 100, source_code: finalCode, created_at: tsAt(1500) })],
    })
  );
  const flag = sc.flags.find((f) => f.code === "partial_gamer");
  assert.ok(flag);
  // v1 default (from real-data review): talent-honesty signal, severity info —
  // it must not drag the orthogonal integrity axis to "watch" on its own.
  assert.equal(flag.severity, "info");
  // The gem-gamer discount: gamed partial points are excluded from score_frac,
  // so this 40-point near-stub partial contributes ~0 to the composite.
  assert.ok(sc.talent.composite <= 5, `composite ${sc.talent.composite} should exclude gamed points`);
});

// (b) widened discount (2026-06-20): a non-genuine partial whose stub_delta is
// LARGE (>=10 lines, so the near-stub partial_gamer flag does NOT fire) must
// STILL be discounted from the composite — every partial is genuine_arc=false.
test("buildScorecard widened partial discount: stub_delta>=10 partial still discounted (b)", () => {
  const stub = baseInput({}).stubsByProblem.p1[0]; // 3-line stub
  // A long, substantially-diverged final body → stub_delta_lines >= 10, so this
  // is NOT a near-stub partial (no partial_gamer flag), yet it scored partial.
  const finalCode =
    "public class Main {\n" +
    "  static int helper(int n){\n" +
    "    int acc = 0;\n" +
    "    for (int i = 0; i < n; i++) {\n" +
    "      acc += i * i;\n" +
    "      if (acc > 1000) acc -= 7;\n" +
    "    }\n" +
    "    return acc;\n" +
    "  }\n" +
    "  public static void main(String[] a){\n" +
    "    System.out.println(helper(10));\n" +
    "  }\n" +
    "}\n";
  const events = [ins("p1", 1000, finalCode, 1, 1)];
  const sc = buildScorecard(
    baseInput({
      editorEvents: events,
      stubsByProblem: { p1: [stub] },
      problemPoints: { p1: 100 },
      submissions: [sub({ problem_id: "p1", verdict: "wrong_answer", score: 40, max_points: 100, source_code: finalCode, created_at: tsAt(1500) })],
    })
  );
  // confirm this is the diverged (non-near-stub) branch: no partial_gamer flag.
  assert.ok(sc.talent.per_problem.p1.stub_delta_lines >= THRESHOLDS.STUB_DELTA_LINES);
  assert.equal(sc.flags.find((f) => f.code === "partial_gamer"), undefined);
  // not a full solve → genuine_arc=false; the 40 partial points are discounted.
  assert.equal(sc.talent.per_problem.p1.genuine_arc, false);
  assert.equal(sc.talent.total_score, 40);
  // score_frac contributes 0 (40-40 discounted); hardness/genuine/reach all 0
  // for an unsolved problem ⇒ composite 0.
  assert.equal(sc.talent.composite, 0, `composite ${sc.talent.composite} should discount the diverged partial`);
});

// (b) a FULL solve is never discounted — its points reach the composite.
test("buildScorecard widened partial discount: full solve is NOT discounted (b)", () => {
  const code = "class S { int solve(){ return 1; } }";
  const { events, endMs } = typeOut("p1", 0, code);
  events.push(submitEv("p1", endMs + 1000));
  const sc = buildScorecard(
    baseInput({
      hardness: () => "med",
      editorEvents: events,
      submissions: [sub({ problem_id: "p1", verdict: "accepted", score: 100, max_points: 100, source_code: code, created_at: tsAt(endMs + 1000) })],
    })
  );
  // full solve: best_score==max_points ⇒ NOT a partial ⇒ not discounted.
  assert.equal(sc.talent.total_score, 100);
  assert.equal(sc.flags.find((f) => f.code === "partial_gamer"), undefined);
  // score_frac = 100/100 = 1 ⇒ 55*1 contributes ⇒ composite well above 0.
  assert.ok(sc.talent.composite >= 55, `composite ${sc.talent.composite} should credit the full solve`);
});

// (b) near-stub partial: discounted exactly ONCE (no double-count with the
// widened path) and still emits the partial_gamer info flag.
test("buildScorecard widened partial discount: near-stub discounted once, no double-count (b)", () => {
  const stub = "public class Main {\n  public static void main(String[] a){\n    // Write your code here\n  }\n}\n";
  const finalCode = "public class Main {\n  public static void main(String[] a){\n    System.out.println(1);\n  }\n}\n";
  const events = [ins("p1", 1000, finalCode, 1, 1)];
  const sc = buildScorecard(
    baseInput({
      editorEvents: events,
      stubsByProblem: { p1: [stub] },
      problemPoints: { p1: 100 },
      submissions: [sub({ problem_id: "p1", verdict: "wrong_answer", score: 40, max_points: 100, source_code: finalCode, created_at: tsAt(1500) })],
    })
  );
  // near-stub: the surfaced info flag is preserved.
  assert.ok(sc.flags.find((f) => f.code === "partial_gamer" && f.severity === "info"));
  // single discount: 40 partial points subtracted once → score_frac=(40-40)/100=0,
  // and no other talent component fires (unsolved) → composite exactly 0. A
  // double-count would clamp at the same 0 here, so verify the discount equals
  // the partial total (not 2x) by checking total_score carries the raw 40.
  assert.equal(sc.talent.total_score, 40);
  assert.equal(sc.talent.composite, 0, `composite ${sc.talent.composite} should subtract the partial exactly once`);
});

test("buildScorecard honest reach (D13)", () => {
  // unsolved, >=2 submits, active>=10min, paste<0.3
  const events = [];
  // type chars over 11 minutes with gaps <60s to accumulate active_ms
  let t = 0;
  for (let i = 0; i < 40; i++) {
    events.push(singleChar("p1", t, "a", 1));
    t += 20000; // 20s gaps, capped at 60s each → active accrues
  }
  const sc = buildScorecard(
    baseInput({
      editorEvents: events,
      submissions: [
        sub({ problem_id: "p1", verdict: "wrong_answer", score: 50, max_points: 100, source_code: "code here long enough", created_at: tsAt(100000) }),
        sub({ problem_id: "p1", verdict: "wrong_answer", score: 60, max_points: 100, source_code: "code here longer", created_at: tsAt(700000) }),
      ],
    })
  );
  assert.ok(sc.talent.honest_reach.includes("p1"));
});

test("buildScorecard foreign paste vs self-paste + foreign_pastes evidence (D2)", () => {
  const foreign = "def solve(n):\n  total=0\n  for i in range(n): total+=i*i\n  return total*2";
  const events = [pasteEv("p1", 1000, foreign.length), replEv("p1", 1050, 0, foreign)];
  const sc = buildScorecard(
    baseInput({
      editorEvents: events,
      submissions: [sub({ problem_id: "p1", verdict: "wrong_answer", score: 0, max_points: 100, source_code: foreign, created_at: tsAt(2000) })],
    })
  );
  assert.equal(sc.integrity.foreign_pastes.length, 1);
  const fp = sc.integrity.foreign_pastes[0];
  assert.equal(fp.problem_id, "p1");
  assert.ok(fp.len >= 40);
  assert.ok(typeof fp.ts === "string"); // ISO
  assert.ok(fp.preview.length <= 200);
});

test("buildScorecard foreign_paste_after_away → critical", () => {
  const foreign = "function dijkstra(g,s){ const dist={}; for(const v of g) dist[v]=Infinity; return dist; }";
  const events = [pasteEv("p1", 6000, foreign.length), replEv("p1", 6050, 0, foreign)];
  const shell = [
    { type: "window_blur", timestamp: tsAt(1000), detail: {} },
    { type: "window_focus", timestamp: tsAt(5000), detail: {} }, // episode ends at 5000, paste at 6000 → 1000ms after
  ];
  const sc = buildScorecard(baseInput({ editorEvents: events, shellEvents: shell }));
  const fp = sc.integrity.foreign_pastes[0];
  assert.equal(fp.after_away_ms, 1000);
  assert.ok(sc.flags.find((f) => f.code === "foreign_paste_after_away" && f.severity === "critical"));
});

// ---- EVAL-2 A.2: statement + sample I/O are on-page (not foreign) -------------
test("buildScorecard onPageByProblem: pasting the problem statement is NOT foreign (A.2)", () => {
  const statement = "Read N then N integers and print the maximum contiguous subarray sum (Kadane).";
  const chunk = "print the maximum contiguous subarray sum (Kadane).";
  const events = [pasteEv("p1", 1000, chunk.length), replEv("p1", 1050, 0, chunk)];
  // Without onPage it would be foreign; with it threaded it is suppressed.
  const without = buildScorecard(baseInput({ editorEvents: events }));
  assert.equal(without.integrity.foreign_pastes.length, 1, "foreign without on-page");
  const sc = buildScorecard(baseInput({ editorEvents: events, onPageByProblem: { p1: [statement] } }));
  assert.equal(sc.integrity.foreign_pastes.length, 0, "statement paste is on-page, not foreign");
});

test("buildScorecard onPageByProblem: pasting sample input/expected is NOT foreign (A.2)", () => {
  const sampleInput = "5\n3 1 4 1 5\nextra descriptive sample row text here";
  const sampleExpected = "1 1 3 4 5 -- the sorted ascending sample output row";
  const events = [pasteEv("p1", 1000, sampleExpected.length), replEv("p1", 1050, 0, sampleExpected)];
  const sc = buildScorecard(
    baseInput({ editorEvents: events, onPageByProblem: { p1: [sampleInput, sampleExpected] } })
  );
  assert.equal(sc.integrity.foreign_pastes.length, 0);
});

test("buildScorecard onPageByProblem: a genuine external paste STAYS foreign (no over-suppression, A.2)", () => {
  const statement = "Read N then N integers and print the maximum contiguous subarray sum (Kadane).";
  const external = "def quicksort(a):\n  if len(a)<=1: return a\n  p=a[0]; return qs(lo)+[p]+qs(hi)";
  const events = [pasteEv("p1", 1000, external.length), replEv("p1", 1050, 0, external)];
  const sc = buildScorecard(baseInput({ editorEvents: events, onPageByProblem: { p1: [statement] } }));
  assert.equal(sc.integrity.foreign_pastes.length, 1, "external paste not on-page stays foreign");
});

// ---- EVAL-2 MAJOR-3: glitch tag on foreign pastes ----------------------------
test("buildScorecard GLITCH TAG on foreign paste: glitchy problem STAYS foreign, tagged unreliable + downgraded", () => {
  const foreign = "def solve(n):\n  total=0\n  for i in range(n): total+=i*i\n  return total*2";
  // A delete on an empty buffer forces a reconstruction glitch on p1 (range
  // disagrees with deletedLen) BEFORE the foreign paste lands.
  const glitchDelete = {
    type: "editor_delete", timestamp: tsAt(900), problem_id: "p1",
    detail: { insertedLen: 0, deletedLen: 5, text: "", startLine: 3, startCol: 1, endLine: 3, endCol: 6 },
  };
  const events = [glitchDelete, pasteEv("p1", 1000, foreign.length), replEv("p1", 1050, 0, foreign)];
  const sc = buildScorecard(baseInput({ editorEvents: events }));
  // EVAL-2 MAJOR-3: the paste is NEVER dropped into a silent side-list — it stays
  // in foreign_pastes, tagged reconstruction_unreliable, and the side-list is gone.
  assert.equal(sc.integrity.foreign_pastes.length, 1, "glitchy-problem paste stays in foreign_pastes, not dropped");
  assert.equal(sc.integrity.foreign_pastes[0].problem_id, "p1");
  assert.equal(sc.integrity.foreign_pastes[0].reconstruction_unreliable, true, "tagged as reconstruction-unreliable");
  assert.ok(!Object.prototype.hasOwnProperty.call(sc.integrity, "unverified" + "_pastes"), "the silent side-list is removed");
  // The D2 flag STILL fires (no longer silent) but at ONE LOWER severity, tagged.
  const fpFlag = sc.flags.find((f) => f.code === "foreign_paste" || f.code === "foreign_paste_after_away");
  assert.ok(fpFlag, "a foreign-paste flag still fires on a glitchy problem");
  assert.equal(fpFlag.code, "foreign_paste", "no away episode here → plain foreign_paste");
  assert.equal(fpFlag.severity, "info", "plain warning downgraded to info on unreliable reconstruction");
  assert.equal(fpFlag.unverified, true, "flag carries the unverified tag");
  assert.match(fpFlag.evidence, /reconstruction unreliable — unverified/, "evidence notes the unverified state");
  // Contrast: the SAME paste on a glitch-free problem IS confidently foreign.
  const clean = buildScorecard(baseInput({ editorEvents: [pasteEv("p1", 1000, foreign.length), replEv("p1", 1050, 0, foreign)] }));
  assert.equal(clean.integrity.foreign_pastes.length, 1, "clean-problem paste stays foreign");
  assert.ok(!clean.integrity.foreign_pastes[0].reconstruction_unreliable, "clean paste is not tagged unreliable");
  const cleanFlag = clean.flags.find((f) => f.code === "foreign_paste");
  assert.equal(cleanFlag.severity, "warning", "glitch-free paste keeps full warning severity");
  assert.ok(!cleanFlag.unverified, "glitch-free flag carries no unverified tag");
});

test("buildScorecard replay-vs-submission mismatch detect (D16b) → telemetry_tampered", () => {
  // editor state at submit is SUBSTANTIVE (≥30 collapsed chars — the
  // empty-snapshot guard must not eat real tamper evidence) but the submission
  // source is totally different.
  const editorContent = "line A alpha beta\nline B gamma delta\nline C epsilon zeta\n";
  const events = [ins("p1", 1000, editorContent, 1, 1), submitEv("p1", 1500)];
  const differentSource = "completely\ndifferent\ncode\nhere\nentirely\n";
  const sc = buildScorecard(
    baseInput({
      editorEvents: events,
      submissions: [sub({ problem_id: "p1", verdict: "accepted", score: 100, max_points: 100, source_code: differentSource, created_at: tsAt(1500) })],
    })
  );
  assert.ok(sc.integrity.replay_mismatches.length >= 1);
  assert.equal(sc.integrity.telemetry_tampered, true);
  assert.equal(sc.tiers.integrity, "confirmed");
});

test("buildScorecard GLITCH GATE: mismatch on a glitchy replay is a coverage gap, never tamper (D16b/D16c)", () => {
  // Real-data case: the initial stub load was never captured,
  // so the first delete targets a range the empty replay buffer doesn't have →
  // glitch. The replayed snapshot then mismatches the submission, but that is
  // base-content desync, not tamper evidence.
  const events = [
    // delete 5 chars at line 3 of an EMPTY buffer → glitch (range disagrees)
    { type: "editor_delete", timestamp: tsAt(900), problem_id: "p1", detail: { insertedLen: 0, deletedLen: 5, text: "", startLine: 3, startCol: 1, endLine: 3, endCol: 6 } },
    ins("p1", 1000, "partial replay content", 1, 1),
    submitEv("p1", 1500),
  ];
  const sc = buildScorecard(
    baseInput({
      editorEvents: events,
      submissions: [sub({ problem_id: "p1", verdict: "accepted", score: 100, max_points: 100, source_code: "completely\ndifferent\ncode\nhere\nentirely\n", created_at: tsAt(1500) })],
    })
  );
  assert.ok(sc.integrity.replay_mismatches.length >= 1, "mismatch is still recorded");
  assert.equal(sc.integrity.telemetry_tampered, false, "glitchy replay must not claim tamper");
  assert.ok(!sc.flags.some((f) => f.code === "telemetry_tampered"));
  assert.ok(sc.coverage.gaps.some((g) => String(g).startsWith("replay_base_unreliable:")), "degrades coverage instead");
  assert.notEqual(sc.coverage.confidence, "high");
});

test("buildScorecard NO mismatch flag when problem has zero editor events (coverage gap)", () => {
  // submission for p2 which has NO editor events → no snapshot → no mismatch flag
  const events = [ins("p1", 1000, "some code", 1, 1)]; // only p1 has events
  const sc = buildScorecard(
    baseInput({
      problemPoints: { p1: 100, p2: 100 },
      editorEvents: events,
      submissions: [sub({ problem_id: "p2", verdict: "accepted", score: 100, max_points: 100, source_code: "x\ny\nz\n", created_at: tsAt(1500) })],
    })
  );
  assert.equal(sc.integrity.telemetry_tampered, false);
});

test("buildScorecard cadence superhuman flag in scorecard", () => {
  const events = [];
  for (let i = 0; i < 30; i++) events.push(singleChar("p1", i * 20, "a", 1 + i));
  const sc = buildScorecard(baseInput({ editorEvents: events }));
  assert.ok(sc.integrity.cadence.superhuman_bursts.length >= 1);
  assert.ok(sc.flags.find((f) => f.code === "superhuman_cadence"));
});

test("buildScorecard high paste ratio flag (D1) critical", () => {
  const blob = "z".repeat(200);
  const events = [
    pasteEv("p1", 1000, 200),
    replEv("p1", 1050, 0, blob),
    ins("p1", 2000, "ab", 1, 201), // tiny typed
  ];
  const sc = buildScorecard(
    baseInput({
      editorEvents: events,
      submissions: [sub({ problem_id: "p1", verdict: "wrong_answer", score: 0, max_points: 100, source_code: blob, created_at: tsAt(3000) })],
    })
  );
  assert.ok(sc.integrity.paste_ratio > 0.6);
  assert.ok(sc.flags.find((f) => f.code === "high_paste_ratio" && f.severity === "critical"));
  assert.equal(sc.tiers.integrity, "flag");
});

test("buildScorecard premeditated clipboard (D15) critical", () => {
  const foreign = "static int gcd(int a,int b){ return b==0? a : gcd(b,a%b); } // helper util";
  const events = [pasteEv("p1", 1000, foreign.length), replEv("p1", 1050, 0, foreign)];
  const sc = buildScorecard(
    baseInput({
      editorEvents: events,
      clipboardEntries: [foreign],
    })
  );
  assert.ok(sc.flags.find((f) => f.code === "premeditated_clipboard" && f.severity === "critical"));
});

test("buildScorecard genuine arc + talent tier (strong on hard genuine solve)", () => {
  // typed-majority, wrong-before-solve, accepted full on a HARD problem → strong.
  // Type the actual code so replayed state matches submitted code (no tamper).
  const code = "class S { int solve(){ /* real */ return 1; } }";
  const { events, endMs } = typeOut("p1", 0, code);
  events.push(runEv("p1", endMs + 1000));
  events.push(submitEv("p1", endMs + 2000));
  const sc = buildScorecard(
    baseInput({
      hardness: () => "hard",
      editorEvents: events,
      submissions: [
        sub({ problem_id: "p1", verdict: "wrong_answer", score: 40, max_points: 100, source_code: code, created_at: tsAt(endMs + 1500) }),
        sub({ problem_id: "p1", verdict: "accepted", score: 100, max_points: 100, source_code: code, created_at: tsAt(endMs + 2500) }),
      ],
    })
  );
  assert.equal(sc.integrity.telemetry_tampered, false);
  assert.equal(sc.talent.per_problem.p1.genuine_arc, true);
  assert.equal(sc.talent.n_solved_full, 1);
  assert.equal(sc.talent.hardest_tier, "hard");
  assert.equal(sc.tiers.talent, "strong"); // gh=1 ⇒ strong (survives tightened gate)
});

// ---- (c) strong-talent gate floor (tightened 2026-06-20) -------------------
// strong ⇔ gh>=1 || gm>=3. A thin-strong (gm=2,gh=0) now falls to MODERATE (not
// below). honest_reach is NOT a strong-qualifier (it credits the composite only).
// Build N genuine MED full-solves on distinct problems with a per-pid hardness
// map; optionally an honest-reach problem.
function genuineMedSolve(pid, startMs) {
  // typed-majority full solve with a prior wrong submit → genuine_arc med.
  const code = `class S${pid} { int solve(){ /* ${pid} */ return 1; } }`;
  const { events, endMs } = typeOut(pid, startMs, code);
  events.push(runEv(pid, endMs + 1000));
  events.push(submitEv(pid, endMs + 2000));
  const submissions = [
    sub({ _id: `${pid}w`, problem_id: pid, verdict: "wrong_answer", score: 40, max_points: 100, source_code: code, created_at: tsAt(endMs + 1500) }),
    sub({ _id: `${pid}a`, problem_id: pid, verdict: "accepted", score: 100, max_points: 100, source_code: code, created_at: tsAt(endMs + 2500) }),
  ];
  return { events, submissions, endMs: endMs + 3000 };
}
function buildMedScorecard(nMed, { withReach = false } = {}) {
  const medPids = [];
  let events = [];
  let submissions = [];
  let t = 0;
  const points = {};
  for (let i = 0; i < nMed; i++) {
    const pid = `m${i}`;
    medPids.push(pid);
    points[pid] = 100;
    const g = genuineMedSolve(pid, t);
    events = events.concat(g.events);
    submissions = submissions.concat(g.submissions);
    t = g.endMs + 1000;
  }
  if (withReach) {
    // honest reach: unsolved, >=2 submits, active>=10min, paste<0.3 (typed).
    const rp = "rp";
    points[rp] = 100;
    let rt = 0;
    for (let i = 0; i < 40; i++) {
      events.push(singleChar(rp, rt, "a", 1));
      rt += 20000; // 20s gaps → active accrues past 10min
    }
    submissions.push(sub({ _id: "rp1", problem_id: rp, verdict: "wrong_answer", score: 50, max_points: 100, source_code: "code here long enough", created_at: tsAt(100000) }));
    submissions.push(sub({ _id: "rp2", problem_id: rp, verdict: "wrong_answer", score: 60, max_points: 100, source_code: "code here longer", created_at: tsAt(700000) }));
  }
  const hardness = (pid) => (medPids.includes(pid) ? "med" : "easy");
  return buildScorecard(
    baseInput({
      editorEvents: events,
      submissions,
      problemPoints: points,
      stubsByProblem: {},
      hardness,
      maxTotal: 100 * Object.keys(points).length,
    })
  );
}

test("(c) talent gate: gm=2/gh=0/reach=0 ⇒ MODERATE (was strong)", () => {
  const sc = buildMedScorecard(2);
  assert.equal(sc.talent.n_medplus_solved, 2);
  assert.equal(sc.talent.honest_reach.length, 0);
  // 2 genuine med, no hard, no reach: demoted from old strong → moderate (not weak).
  assert.equal(sc.tiers.talent, "moderate");
});

test("(c) talent gate: gm=3/gh=0/reach=0 ⇒ STRONG", () => {
  const sc = buildMedScorecard(3);
  assert.equal(sc.talent.n_medplus_solved, 3);
  assert.equal(sc.tiers.talent, "strong");
});

test("(c) talent gate: gm=4/gh=0/reach=0 ⇒ STRONG (Anita-like survives)", () => {
  // The Anita-like genuinely-selected candidate (gm=4) must NOT be demoted — the
  // floor uses med>=3, not a hard-or-reach-only floor.
  const sc = buildMedScorecard(4);
  assert.equal(sc.talent.n_medplus_solved, 4);
  assert.equal(sc.tiers.talent, "strong");
});

test("(c) talent gate: gm=2 + honest_reach>0 ⇒ MODERATE (reach is NOT a strong-qualifier)", () => {
  const sc = buildMedScorecard(2, { withReach: true });
  assert.equal(sc.talent.n_medplus_solved, 2);
  assert.ok(sc.talent.honest_reach.length > 0);
  // honest_reach credits the composite (reach_frac), NOT the talent tier: a
  // 0-hard / 2-med solver with reach stays MODERATE — trying ≠ strong talent.
  assert.equal(sc.tiers.talent, "moderate");
});

test("composite formula hand-computed", () => {
  // One hard problem, solved full, genuine, no reach.
  // score_frac=100/100=1; hardness_frac: weight solved=4, weight all=4 → 1;
  // genuine_frac=1/1=1; reach_frac=0.
  // composite=round(55*1+20*1+15*1+10*0)=90.
  const code = "class S { int solve(){ return 1; } }";
  const { events, endMs } = typeOut("p1", 0, code);
  events.push(submitEv("p1", endMs + 1000));
  const sc = buildScorecard(
    baseInput({
      hardness: () => "hard",
      editorEvents: events,
      submissions: [
        sub({ problem_id: "p1", verdict: "wrong_answer", score: 0, max_points: 100, source_code: code, created_at: tsAt(endMs) }),
        sub({ problem_id: "p1", verdict: "accepted", score: 100, max_points: 100, source_code: code, created_at: tsAt(endMs + 1000) }),
      ],
    })
  );
  assert.equal(sc.integrity.telemetry_tampered, false);
  assert.equal(sc.talent.composite, 90);
});

test("THE GATE: telemetry_tampered confirmed caps talent weak + composite<=20", () => {
  const editorContent = "real\neditor\nstate\n";
  const events = [];
  let t = 0;
  for (let i = 0; i < 50; i++) {
    events.push(singleChar("p1", t, "a", 1 + (i % 40)));
    t += 1000;
  }
  events.push(ins("p1", t, editorContent, 2, 1));
  events.push(submitEv("p1", t + 500));
  const differentSource = "TOTALLY\nDIFFERENT\nSUBMITTED\nCODE\nXYZ\n";
  const sc = buildScorecard(
    baseInput({
      hardness: () => "hard",
      editorEvents: events,
      submissions: [sub({ problem_id: "p1", verdict: "accepted", score: 100, max_points: 100, source_code: differentSource, created_at: tsAt(t + 500) })],
    })
  );
  assert.equal(sc.integrity.telemetry_tampered, true);
  assert.equal(sc.tiers.integrity, "confirmed");
  assert.equal(sc.tiers.talent, "weak");
  assert.ok(sc.talent.composite <= 20);
});

test("flags carry one-line evidence strings", () => {
  const code = "class S {}".repeat(30);
  const events = [ins("p1", 1000, "x", 1, 1), submitEv("p1", 1500)];
  const sc = buildScorecard(
    baseInput({
      editorEvents: events,
      hardness: () => "med",
      submissions: [sub({ problem_id: "p1", verdict: "accepted", score: 100, max_points: 100, source_code: code, created_at: tsAt(1500) })],
    })
  );
  const f = sc.flags.find((x) => x.code === "zero_effort_solve");
  assert.ok(f);
  assert.equal(typeof f.evidence, "string");
  assert.ok(f.evidence.length > 0);
  assert.ok(!f.evidence.includes("\n"));
});

test("coverage confidence high/low", () => {
  const high = buildScorecard(baseInput({ editorEvents: [ins("p1", 1000, "abc", 1, 1)] }));
  assert.equal(high.coverage.confidence, "high");
  const low = buildScorecard(baseInput({ editorEvents: [] }));
  assert.equal(low.coverage.confidence, "low");
});

// ---- MISSING-DATA / AVAILABILITY-GATE tests (2026-06-19) ----
// The eval must NEVER accuse a candidate of cheating because evidence is MISSING
// or UNREAD. Such cases are inconclusive/no-data, never a violation.

test("MISSING DATA: no editor/shell evidence at all → integrity inconclusive, NOT flag; no zero_effort/paste", () => {
  // This is the live "everyone flagged" shape: a candidate who fully solved a
  // MED problem, but the eval read ZERO editor + ZERO shell events. Pre-fix this
  // emitted a critical zero_effort_solve and tier "flag". It must now be
  // "inconclusive" with no zero_effort and no high_paste flags.
  const sc = buildScorecard(
    baseInput({
      editorEvents: [],
      shellEvents: [],
      hardness: () => "med",
      submissions: [sub({ problem_id: "p1", verdict: "accepted", score: 100, max_points: 100, source_code: "class S { int f(){ return 42; } }".repeat(20), created_at: tsAt(1500) })],
    })
  );
  assert.equal(sc.coverage.editor_events_n, 0);
  assert.equal(sc.coverage.shell_events_n, 0);
  assert.equal(sc.coverage.confidence, "low");
  assert.equal(sc.tiers.integrity, "inconclusive");
  assert.equal(sc.integrity.zero_effort_solves.length, 0, "zero_effort must not fire without editor coverage");
  assert.ok(!sc.flags.find((f) => f.code === "zero_effort_solve"), "no zero_effort flag");
  assert.ok(!sc.flags.find((f) => f.code === "high_paste_ratio"), "no paste flag without paste telemetry");
  assert.match(sc.tiers.one_line, /inconclusive/);
});

test("MISSING DATA: no paste/selection telemetry → large inserts NOT scored as paste (paste inconclusive)", () => {
  // Today's cohort emitted no editor_paste / editor_selection events. A genuine
  // large insert (e.g. a big edit) must NOT be inferred as pasted, so paste_ratio
  // stays ~0 and no high_paste_ratio flag is raised. Editor coverage IS present
  // here (so the candidate is not "no data" overall — only the paste axis is
  // inconclusive), so the tier is clean, not inconclusive.
  const bigCode = "class Solution {\n  int compute(int n){\n    int total = 0;\n    for(int i=0;i<n;i++){ total += i*i; }\n    return total;\n  }\n}\n";
  const events = [ins("p1", 1000, bigCode, 1, 1), submitEv("p1", 1500)];
  const sc = buildScorecard(
    baseInput({
      editorEvents: events,
      submissions: [sub({ problem_id: "p1", verdict: "accepted", score: 100, max_points: 100, source_code: bigCode, created_at: tsAt(1500) })],
    })
  );
  assert.equal(sc.integrity.paste_ratio, 0, "no paste inference without paste/selection markers");
  assert.ok(!sc.flags.find((f) => f.code === "high_paste_ratio"), "no false high_paste flag");
  assert.equal(sc.tiers.integrity, "clean");
});

test("PRESENT DATA: zero_effort STILL fires when editor coverage present (real detection preserved)", () => {
  // Same scenario as the D10 test but asserted here to prove the availability
  // gate did NOT weaken real detection: with paste telemetry present and a real
  // zero-effort solve, the critical flag still fires and the tier is "flag".
  const code = "class S { int f(){ return 42; } }".repeat(20);
  const events = [pasteEv("p1", 1000, code.length), replEv("p1", 1050, 0, code), submitEv("p1", 1500)];
  const sc = buildScorecard(
    baseInput({
      editorEvents: events,
      hardness: () => "med",
      submissions: [sub({ problem_id: "p1", verdict: "accepted", score: 100, max_points: 100, source_code: code, created_at: tsAt(1500) })],
    })
  );
  assert.ok(sc.integrity.zero_effort_solves.includes("p1"));
  assert.ok(sc.flags.find((f) => f.code === "zero_effort_solve" && f.severity === "critical"));
  assert.equal(sc.tiers.integrity, "flag");
});

test("PRESENT DATA: high_paste_ratio STILL fires when paste telemetry present (real detection preserved)", () => {
  const blob = "z".repeat(200);
  const events = [pasteEv("p1", 1000, 200), replEv("p1", 1050, 0, blob), ins("p1", 2000, "ab", 1, 201)];
  const sc = buildScorecard(
    baseInput({
      editorEvents: events,
      submissions: [sub({ problem_id: "p1", verdict: "wrong_answer", score: 0, max_points: 100, source_code: blob, created_at: tsAt(3000) })],
    })
  );
  assert.ok(sc.integrity.paste_ratio > 0.6);
  assert.ok(sc.flags.find((f) => f.code === "high_paste_ratio" && f.severity === "critical"));
});

test("READ FAILURE: evidenceReadFailed → gcs_read_failed gap + inconclusive (distinct from real absence)", () => {
  // A simulated transient GCS read failure: the orchestrator could not enumerate
  // the evidence. This is a GAP, not "no data": coverage records gcs_read_failed,
  // confidence drops, and the tier is inconclusive — never a violation. The
  // one_line makes the read-failure reason explicit for the reviewer.
  const sc = buildScorecard(
    baseInput({
      editorEvents: [],
      shellEvents: [],
      evidenceReadFailed: true,
      hardness: () => "med",
      submissions: [sub({ problem_id: "p1", verdict: "accepted", score: 100, max_points: 100, source_code: "class S { int f(){ return 42; } }".repeat(20), created_at: tsAt(1500) })],
    })
  );
  assert.ok(sc.coverage.gaps.includes("gcs_read_failed"));
  assert.equal(sc.coverage.confidence, "low");
  assert.equal(sc.tiers.integrity, "inconclusive");
  assert.ok(!sc.flags.find((f) => f.code === "zero_effort_solve"));
  assert.match(sc.tiers.one_line, /read failed/);
});

test("INCONCLUSIVE does NOT mask a real Firestore-derived recurring-pair clone (cross-pass)", () => {
  // A candidate with no interaction evidence is inconclusive — UNLESS a
  // code-similarity clone proof (recurring_pair_conclusive) is injected by the
  // cross-pass. That proof is independent of the interaction stream, so it must
  // still confirm. This guards against the inconclusive tier weakening real
  // clone detection.
  const sc = buildScorecard(
    baseInput({
      editorEvents: [],
      shellEvents: [],
      hardness: () => "hard",
      submissions: [sub({ problem_id: "p1", verdict: "accepted", score: 100, max_points: 100, source_code: "class S { int f(){ return 1; } }", created_at: tsAt(1500) })],
    })
  );
  assert.equal(sc.tiers.integrity, "inconclusive"); // before cross-pass
  const patch = {
    clone_cluster_refs: [],
    recurring_pair_refs: [{ other: "B", n_problems: 1, problems: ["p1"], n_hard: 1, conclusive: true }],
    paste_match_edges: [],
    tight_refs: [],
    flags: [{ code: "recurring_pair_conclusive", severity: "critical", problem_id: null, evidence: "Recurring identical code with B." }],
    integrity_escalation: "confirmed",
  };
  const patched = applyCrossPatches(sc, patch);
  assert.equal(patched.tiers.integrity, "confirmed", "clone proof confirms even with no interaction evidence");
});

// ---- cross-candidate analysis ----

function makeCandidate(key, opts) {
  return {
    identityKey: key,
    username_norm: key,
    scorecard: opts.scorecard || { contest_slug: "c1", identity_key: key, talent: { total_score: opts.total || 0 }, integrity: { cadence: {}, paste_ratio: 0 } },
    submissions: opts.submissions || [],
    pastes: opts.pastes || [],
    finalContents: opts.finalContents || {},
    cross_inputs: opts.cross_inputs || { final_content_norms: opts.finalNorms || {} },
    room: opts.room || "",
    ips: opts.ips || [],
  };
}

test("crossCandidateAnalysis: exact clone pair on hard problem → recurring conclusive + confirmed escalation", () => {
  // Two candidates with IDENTICAL accepted code on a HARD problem (solved by ≤10 → hard).
  const hardCode = "class Solution { int f(int n){ int s=0; for(int i=0;i<n;i++) s+=i*i; return s; } }";
  const A = makeCandidate("A", {
    submissions: [sub({ problem_id: "ph", verdict: "accepted", score: 100, max_points: 100, source_code: hardCode, created_at: tsAt(1000) })],
    total: 100,
  });
  const B = makeCandidate("B", {
    submissions: [sub({ problem_id: "ph", verdict: "accepted", score: 100, max_points: 100, source_code: hardCode, created_at: tsAt(2000) })],
    total: 100,
  });
  const C = makeCandidate("C", {
    submissions: [sub({ problem_id: "pe", verdict: "accepted", score: 100, max_points: 100, source_code: "class X { void g(){} }", created_at: tsAt(3000) })],
    total: 100,
  });
  const { meta, patches } = crossCandidateAnalysis({ candidates: [A, B, C], problems: [{ problem_id: "ph" }, { problem_id: "pe" }] });
  assert.equal(meta.hardness.ph, "hard"); // 2 solvers ≤10
  const pa = patches.get("A");
  assert.ok(pa.recurring_pair_refs.find((r) => r.other === "B" && r.conclusive));
  assert.equal(pa.integrity_escalation, "confirmed");
  assert.ok(pa.flags.find((f) => f.code === "recurring_pair_conclusive" && f.severity === "critical"));
  assert.ok(pa.flags.find((f) => f.code === "hard_clone_cluster"));
});

// ===========================================================================
// PENDING-1/2/3 (2026-06-22): recurring-pair conclusiveness gate.
// ===========================================================================

// Helper: build N accepted candidates on a SINGLE problem with given codes.
function cohortOnProblem(pid, entries, opts = {}) {
  // entries: [{key, code, ts, room, ips}]
  return entries.map((e, i) =>
    makeCandidate(e.key, {
      submissions: [sub({ problem_id: pid, verdict: "accepted", score: 100, max_points: 100, source_code: e.code, created_at: tsAt(e.ts != null ? e.ts : 1000 * (i + 1)) })],
      room: e.room || opts.room || "",
      ips: e.ips || opts.ips || [],
      total: 100,
    })
  );
}

test("PENDING-2: single-problem CANONICAL exact match → NOT conclusive (no confirm)", () => {
  // 6 solvers, 3 short canonical SQL forms, ≥5 solvers → canonical. The two
  // candidates who share a form are NOT confirmed (convergence, not copying).
  const f = [
    "select city from station order by length(city) limit 1",
    "select city from station order by length(city) desc limit 1",
    "select city from station group by city order by length(city) limit 1",
  ];
  const entries = [];
  for (let i = 0; i < 6; i++) entries.push({ key: `c${i}`, code: f[i % 3], room: "R", ips: ["10.0.0.1"] });
  const cands = cohortOnProblem("wos5", entries);
  const { meta, patches } = crossCandidateAnalysis({ candidates: cands, problems: [{ problem_id: "wos5" }] });
  assert.equal(meta.hardness.wos5, "hard"); // 6 solvers ≤10
  assert.equal(meta.canonical.wos5, true);
  // c0 and c3 share form f[0] (proximity present: same room) but it is canonical.
  const p0 = patches.get("c0");
  assert.ok(!p0.recurring_pair_refs.some((r) => r.conclusive), "canonical single-problem pair NOT conclusive");
  assert.notEqual(p0.integrity_escalation, "confirmed");
  // the hard cluster is down-weighted to a (warning) clone_cluster, not critical.
  assert.ok(!p0.flags.some((f2) => f2.code === "hard_clone_cluster"), "canonical hard cluster is down-weighted");
  assert.ok(p0.flags.some((f2) => f2.code === "clone_cluster" && f2.severity === "warning"));
});

test("PENDING-1/2/3: single-problem exact+hard+non-canonical+PROXIMITY → conclusive", () => {
  // 6 solvers on a SUBSTANTIVE (long) hard problem; 2 share identical long code
  // AND are in the same room → conclusive copy.
  const longA = "class result{public static int solve(int n){int s=0;for(int i=2;i<=n;i++){s=(s*i+7)%1000003;}return s;}}public class main{public static void main(string[]a){scanner sc=new scanner(system.in);system.out.println(result.solve(sc.nextint()));}}";
  const variants = [];
  for (let i = 0; i < 4; i++) variants.push(longA.replace("int s=0", `int s=${i}`).replace("return s", `return s/* ${i} */ +0-0`));
  const entries = [
    { key: "X", code: longA, room: "R1", ips: ["10.0.0.5"], ts: 1000 },
    { key: "Y", code: longA, room: "R1", ips: ["10.0.0.5"], ts: 2000 }, // same room → proximity
    { key: "Z0", code: variants[0], room: "R2" }, { key: "Z1", code: variants[1], room: "R3" },
    { key: "Z2", code: variants[2], room: "R4" }, { key: "Z3", code: variants[3], room: "R5" },
  ];
  const cands = cohortOnProblem("hardP", entries);
  const { meta, patches } = crossCandidateAnalysis({ candidates: cands, problems: [{ problem_id: "hardP" }] });
  assert.equal(meta.hardness.hardP, "hard");
  assert.equal(meta.canonical.hardP, false, "long forms ⇒ not canonical");
  const px = patches.get("X");
  assert.ok(px.recurring_pair_refs.some((r) => r.other === "Y" && r.conclusive), "exact+hard+non-canon+same-room ⇒ conclusive");
  assert.equal(px.integrity_escalation, "confirmed");
  assert.ok(px.flags.some((f2) => f2.code === "hard_clone_cluster"));
});

test("PENDING-3: single-problem exact+hard+non-canonical but NO proximity → NOT conclusive", () => {
  // Same as above but the two sharers are in different rooms with no IP overlap
  // and no tight gap → no proximity → NOT confirmed (different-room-no-proximity separation).
  const longA = "class result{public static int solve(int n){int s=0;for(int i=2;i<=n;i++){s=(s*i+7)%1000003;}return s;}}public class main{public static void main(string[]a){scanner sc=new scanner(system.in);system.out.println(result.solve(sc.nextint()));}}";
  const variants = [];
  for (let i = 0; i < 4; i++) variants.push(longA.replace("int s=0", `int s=${i}`).replace("return s", `return s/* ${i} */ +0-0`));
  const entries = [
    { key: "X", code: longA, room: "RA", ips: ["10.1.1.1"], ts: 1000 },
    { key: "Y", code: longA, room: "RB", ips: ["10.2.2.2"], ts: 1000 + 5_000_000 }, // far apart, diff room/IP
    { key: "Z0", code: variants[0], room: "RC" }, { key: "Z1", code: variants[1], room: "RD" },
    { key: "Z2", code: variants[2], room: "RE" }, { key: "Z3", code: variants[3], room: "RF" },
  ];
  const cands = cohortOnProblem("hardP", entries);
  const { patches } = crossCandidateAnalysis({ candidates: cands, problems: [{ problem_id: "hardP" }] });
  const px = patches.get("X");
  assert.ok(!px.recurring_pair_refs.some((r) => r.conclusive), "no proximity ⇒ single-problem NOT conclusive");
  assert.notEqual(px.integrity_escalation, "confirmed");
});

test("PENDING-1: single-problem SKELETON-ONLY (code differs) → NOT conclusive even if hard+same-room", () => {
  // Renamed-variable convergence on one hard problem, SAME room — skeleton matches
  // but coreExact differs → not proof on a single problem.
  const a = "class result{public static int solve(int n){int total=0;for(int i=2;i<=n;i++){total=(total*i+7)%1000003;}return total;}}";
  const b = "class result{public static int solve(int n){int acc=0;for(int j=2;j<=n;j++){acc=(acc*j+7)%1000003;}return acc;}}";
  // pad cohort so the problem is hard (≤10 solvers) with distinct code each.
  const entries = [
    { key: "A", code: a, room: "R1", ips: ["10.0.0.9"], ts: 1000 },
    { key: "B", code: b, room: "R1", ips: ["10.0.0.9"], ts: 2000 },
  ];
  const cands = cohortOnProblem("hardP", entries);
  const { patches } = crossCandidateAnalysis({ candidates: cands, problems: [{ problem_id: "hardP" }] });
  const pa = patches.get("A");
  assert.ok(!pa.recurring_pair_refs.some((r) => r.conclusive), "skeleton-only single problem ⇒ not conclusive");
  assert.notEqual(pa.integrity_escalation, "confirmed");
});

test("PENDING-1 SCOPE: multi-problem SKELETON-only (renamed-variable ring) STAYS conclusive (KPR guard)", () => {
  // Two candidates share the SAME skeleton on TWO problems with different
  // variable names (a real renamed-variable copy ring). The
  // coreExact requirement is single-problem-only — a 2-problem skeleton ring is
  // still conclusive copying. (Long, substantive code so neither problem is
  // canonical; different variable names so coreExact differs — skeleton-only.)
  const a1 = "class r{int solve(int n){int total=0;for(int i=0;i<n;i++){total=(total*i+13)%99991;}return total;}}public class main{public static void main(string[]a){scanner sc=new scanner(system.in);system.out.println(r.solve(sc.nextint()));}}";
  const b1 = a1.replace(/total/g, "acc").replace(/\bi\b/g, "k");
  // NB: avoid SQL keywords (sum/max/min/count are in the skeleton KW set and stay
  // literal — they would NOT rename to V and break the skeleton-match intent).
  const a2 = "class r{int g(int m){int tot=0;for(int i=0;i<m;i++){tot=(tot+i*i-1)%88883;}return tot;}}public class main{public static void main(string[]a){scanner sc=new scanner(system.in);system.out.println(r.g(sc.nextint()));}}";
  const b2 = a2.replace(/tot/g, "acc").replace(/\bi\b/g, "k");
  const A = makeCandidate("A", { submissions: [
    sub({ problem_id: "p1", verdict: "accepted", score: 100, max_points: 100, source_code: a1, created_at: tsAt(1000) }),
    sub({ problem_id: "p2", verdict: "accepted", score: 100, max_points: 100, source_code: a2, created_at: tsAt(1100) }),
  ], total: 200 });
  const B = makeCandidate("B", { submissions: [
    sub({ problem_id: "p1", verdict: "accepted", score: 100, max_points: 100, source_code: b1, created_at: tsAt(2000) }),
    sub({ problem_id: "p2", verdict: "accepted", score: 100, max_points: 100, source_code: b2, created_at: tsAt(2100) }),
  ], total: 200 });
  const { meta, patches } = crossCandidateAnalysis({ candidates: [A, B], problems: [{ problem_id: "p1" }, { problem_id: "p2" }] });
  // sanity: skeleton matches, coreExact differs (renamed variables)
  const rpMeta = meta.recurring_pairs.find((r) => r.pair.includes("A") && r.pair.includes("B"));
  assert.ok(rpMeta, "A↔B recurring pair surfaced (skeleton on 2 problems)");
  assert.equal(rpMeta.n_problems, 2);
  assert.equal(rpMeta.n_exact, 0, "skeleton-only — no coreExact match on either problem");
  const pa = patches.get("A");
  const rp = pa.recurring_pair_refs.find((r) => r.other === "B");
  assert.ok(rp, "A↔B recurring ref on A's patch");
  assert.ok(rp.conclusive, "multi-problem skeleton-only ring STAYS conclusive (KPR regression guard)");
  assert.equal(pa.integrity_escalation, "confirmed");
});

test("crossCandidateAnalysis: directed paste edge", () => {
  const ownerCode = "static long power(long b,long e,long m){ long r=1; b%=m; while(e>0){ if((e&1)==1) r=r*b%m; b=b*b%m; e>>=1; } return r; }";
  const owner = makeCandidate("OWNER", {
    submissions: [sub({ problem_id: "p1", verdict: "accepted", score: 100, max_points: 100, source_code: ownerCode, created_at: tsAt(1000) })],
    finalNorms: {},
    cross_inputs: { final_content_norms: { p1: "" } },
    total: 100,
  });
  // paster pasted owner's code (foreign paste record with text), later ts
  const paster = makeCandidate("PASTER", {
    submissions: [sub({ problem_id: "p1", verdict: "wrong_answer", score: 0, max_points: 100, source_code: ownerCode, created_at: tsAt(5000) })],
    pastes: [{ problem_id: "p1", ts: 4000, len: ownerCode.length, text: ownerCode, foreign: true }],
    total: 0,
  });
  const { patches } = crossCandidateAnalysis({ candidates: [owner, paster], problems: [{ problem_id: "p1" }] });
  const pPaster = patches.get("PASTER");
  assert.ok(pPaster.paste_match_edges.find((e) => e.from === "OWNER" && e.to === "PASTER"));
  assert.ok(pPaster.flags.find((f) => f.code === "directed_paste_match" && f.severity === "critical"));
  // provable: owner's accepted submission (ts 1000) existed before paste (ts 4000)
  assert.equal(pPaster.paste_match_edges[0].provable, true);
});

test("crossCandidateAnalysis: failed-code cluster", () => {
  const brokenCode = "int main(){ int x; cin>>x; cout<<x*2; return 0; } // wrong approach here";
  const A = makeCandidate("FA", {
    submissions: [sub({ problem_id: "p1", verdict: "wrong_answer", score: 0, max_points: 100, source_code: brokenCode, created_at: tsAt(1000) })],
  });
  const B = makeCandidate("FB", {
    submissions: [sub({ problem_id: "p1", verdict: "wrong_answer", score: 0, max_points: 100, source_code: brokenCode, created_at: tsAt(2000) })],
  });
  const { meta, patches } = crossCandidateAnalysis({ candidates: [A, B], problems: [{ problem_id: "p1" }] });
  assert.equal(meta.clusters.failed.length, 1);
  assert.ok(patches.get("FA").clone_cluster_refs.find((r) => r.kind === "failed"));
  assert.ok(patches.get("FA").flags.find((f) => f.code === "failed_clone_cluster"));
});

test("crossCandidateAnalysis: same-minute tight annotated same_room + submit cluster", () => {
  const hardCode = "class Solution{ int sol(int n){ int r=0; while(n>0){ r+=n%10; n/=10; } return r; } }";
  const mk = (k, ms) =>
    makeCandidate(k, {
      submissions: [sub({ problem_id: "ph", verdict: "accepted", score: 100, max_points: 100, source_code: hardCode, created_at: tsAt(ms) })],
      room: "ROOM-7",
      ips: ["192.168.1.10"],
      total: 100,
    });
  // 3 candidates same room, same hard code, within 60s → tight same_room + submit cluster
  const A = mk("TA", 1000);
  const B = mk("TB", 2000);
  const Cc = mk("TC", 3000);
  const { meta, patches } = crossCandidateAnalysis({ candidates: [A, B, Cc], problems: [{ problem_id: "ph" }] });
  assert.ok(meta.tight.length >= 1);
  assert.ok(meta.tight.some((t) => t.same_room === true));
  assert.equal(meta.submit_clusters.length, 1);
  assert.equal(meta.submit_clusters[0].identities.length, 3);
  assert.ok(meta.submit_clusters[0].rooms.includes("ROOM-7"));
  // tight ref attached
  assert.ok(patches.get("TA").tight_refs.length >= 1);
});

test("applyCrossPatches merges patch + re-derives tiers/composite/one_line", () => {
  // Build a clean scorecard, then apply a confirmed recurring-pair patch → confirmed + capped composite.
  const code = "class S { int solve(){ return 1; } }";
  const { events, endMs } = typeOut("p1", 0, code);
  events.push(submitEv("p1", endMs + 1000));
  const sc = buildScorecard(
    baseInput({
      hardness: () => "hard",
      editorEvents: events,
      submissions: [sub({ problem_id: "p1", verdict: "accepted", score: 100, max_points: 100, source_code: code, created_at: tsAt(endMs + 1000) })],
    })
  );
  assert.equal(sc.integrity.telemetry_tampered, false);
  assert.equal(sc.tiers.talent, "strong");
  const patch = {
    clone_cluster_refs: [{ problem_id: "p1", kind: "skeleton", n_users: 2, hardness: "hard", others: ["B"] }],
    recurring_pair_refs: [{ other: "B", n_problems: 1, problems: ["p1"], n_hard: 1, conclusive: true }],
    paste_match_edges: [],
    tight_refs: [],
    flags: [
      { code: "recurring_pair_conclusive", severity: "critical", problem_id: null, evidence: "Recurring identical code with B." },
      { code: "hard_clone_cluster", severity: "critical", problem_id: "p1", evidence: "Member of a HARD skeleton clone cluster on p1 with B." },
    ],
    integrity_escalation: "confirmed",
  };
  const patched = applyCrossPatches(sc, patch);
  assert.equal(patched.tiers.integrity, "confirmed");
  assert.equal(patched.tiers.talent, "weak"); // gate
  assert.ok(patched.talent.composite <= 20);
  assert.equal(patched.integrity.recurring_pair_refs.length, 1);
  assert.ok(patched.flags.find((f) => f.code === "recurring_pair_conclusive"));
  // dedupe: applying again does not duplicate flags
  const again = applyCrossPatches(patched, patch);
  const count = again.flags.filter((f) => f.code === "recurring_pair_conclusive").length;
  assert.equal(count, 1);
});

test("mixed-keying: person_id null uses username_norm as identity_key", () => {
  const sc = buildScorecard(baseInput({ identity: { person_id: null, username_norm: "anon42", candidate_id: "c", name: "Anon" } }));
  assert.equal(sc.identity_key, "anon42");
  assert.equal(sc.person_id, null);
  // person identity
  const sc2 = buildScorecard(baseInput({ identity: { person_id: "P9", username_norm: "u9", candidate_id: "c", name: "N" } }));
  assert.equal(sc2.identity_key, "P9");
  assert.equal(sc2.person_id, "P9");
});

test("cross_inputs subobject shape", () => {
  const foreign = "def helper(x):\n  return x*x + sum(range(x)) - 1  # some external snippet";
  const events = [pasteEv("p1", 1000, foreign.length), replEv("p1", 1050, 0, foreign), submitEv("p1", 1500)];
  const sc = buildScorecard(
    baseInput({
      editorEvents: events,
      submissions: [
        sub({ problem_id: "p1", verdict: "wrong_answer", score: 0, max_points: 100, source_code: "wrong attempt code here long enough", created_at: tsAt(1200) }),
      ],
    })
  );
  const ci = sc.cross_inputs;
  assert.ok(Array.isArray(ci.foreign_paste_texts));
  assert.ok(ci.final_content_norms);
  assert.ok(ci.failed_norms);
  assert.equal(ci.room, "R1");
  assert.ok(Array.isArray(ci.ips));
  assert.ok(Array.isArray(ci.submit_times));
  assert.ok(ci.submit_times[0].problem_id === "p1");
});
