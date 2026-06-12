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
  assert.equal(EVALUATOR_VERSION, "1");
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
  assert.equal(sc.evaluator_version, "1");
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
  // v1 default (KPR 2026-06-12 review): talent-honesty signal, severity info —
  // it must not drag the orthogonal integrity axis to "watch" on its own.
  assert.equal(flag.severity, "info");
  // The gem-gamer discount: gamed partial points are excluded from score_frac,
  // so this 40-point near-stub partial contributes ~0 to the composite.
  assert.ok(sc.talent.composite <= 5, `composite ${sc.talent.composite} should exclude gamed points`);
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
  // Real-data case (KPR 2026-06-12): the initial stub load was never captured,
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
  assert.equal(sc.tiers.talent, "strong");
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
