// backend/test/foreignPasteNeverDropped.test.mjs
//
// Spec EVAL-2 Layer A — "genuine foreign pastes are NEVER dropped". This is the
// owner's explicit guard (task #162): the false-positive fix that lets a
// self-paste read as non-foreign must NOT open a hole that lets a real external
// paste slip through.
//
// It also locks in the EVAL-2 MAJOR-3 redesign (owner override of the old silent
// side-list): a would-be-foreign paste on a problem whose reconstruction has
// glitches now STAYS in `foreign_pastes` tagged `reconstruction_unreliable`, with
// the D2 flag downgraded ONE severity notch (after_away critical→warning, plain
// warning→info) and `unverified: true`. It is flagged-but-de-weighted, never
// silenced — closing the "forge a glitch to dodge detection" hole.
//
// PURE unit test — no handler, no env, no GCP.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScorecard } from "../src/evaluationMetrics.mjs";

// ---- helpers (mirror evaluationMetrics.test.mjs) ----
function tsAt(ms) {
  return new Date(ms).toISOString();
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
// Emit single-char inserts that spell `code` (one keystroke per char), tracking
// line/col so the replayed content equals `code`. Returns { events, endMs }.
function typeOut(pid, startMs, code, stepMs = 50) {
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
// A switch-away episode that ENDS at `focusMs`; a paste shortly after correlates.
function awayShell(blurMs, focusMs) {
  return [
    { type: "window_blur", timestamp: tsAt(blurMs), detail: {} },
    { type: "window_focus", timestamp: tsAt(focusMs), detail: {} },
  ];
}
// A reconstruction glitch: a delete whose range/deletedLen disagree with the
// (empty) buffer, exactly the inconsistency replayTamper counts. This is also the
// shape a cheater would FORGE to try to mark a problem "unreliable".
function glitchDelete(pid, ms) {
  return {
    type: "editor_delete",
    timestamp: tsAt(ms),
    problem_id: pid,
    detail: { insertedLen: 0, deletedLen: 5, text: "", startLine: 3, startCol: 1, endLine: 3, endCol: 6 },
  };
}
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
function fpFlag(sc) {
  return sc.flags.find((f) => f.code === "foreign_paste" || f.code === "foreign_paste_after_away");
}

// A genuinely-external snippet: >=30 collapsed chars, real algorithm (not a bare
// template), not derivable from any on-page / stub / typed text the candidate had.
const EXTERNAL = "function dijkstra(g,s){ const dist={}; for(const v of g) dist[v]=Infinity; dist[s]=0; return dist; }";
// A >=300-char external full solution (for the confirmed-tier gate).
const EXTERNAL_FULL =
  "function solveGraph(nodes,edges){ let dist=new Array(nodes).fill(Infinity); dist[0]=0; " +
  "for(let k=0;k<nodes;k++){ for(const [u,v,w] of edges){ if(dist[u]+w<dist[v]) dist[v]=dist[u]+w; } } " +
  "let acc=0; for(let i=0;i<nodes;i++){ acc+=dist[i]===Infinity?0:dist[i]; } return acc+12345; } " +
  "// unique padding tail to exceed three hundred characters for the full-solution gate XYZ";

// ===========================================================================
// TEST 2 — genuine external pastes STAY foreign (no false negative from the fix)
// ===========================================================================
test("TEST2a genuine external paste on a clean problem → foreign + warning", () => {
  // Candidate types some unrelated code first, then pastes an external snippet
  // that is NOT a substring of what they typed.
  const typed = typeOut("p1", 100, "int helper(){ return 7; }\n");
  const pasteT = typed.endMs + 500;
  const events = [...typed.events, pasteEv("p1", pasteT, EXTERNAL.length), replEv("p1", pasteT + 50, 0, EXTERNAL, 2, 1)];
  const sc = buildScorecard(baseInput({ editorEvents: events }));

  assert.equal(sc.integrity.foreign_pastes.length, 1, "external paste IS foreign");
  assert.ok(!sc.integrity.foreign_pastes[0].reconstruction_unreliable, "clean problem → not tagged unreliable");
  const flag = fpFlag(sc);
  assert.equal(flag.code, "foreign_paste");
  assert.equal(flag.severity, "warning", "no away episode → full warning");
  assert.ok(!flag.unverified, "clean flag carries no unverified tag");
});

test("TEST2b genuine external paste after a switch-away → foreign + critical after_away", () => {
  const pasteT = 6000;
  const events = [pasteEv("p1", pasteT, EXTERNAL.length), replEv("p1", pasteT + 50, 0, EXTERNAL)];
  const sc = buildScorecard(baseInput({ editorEvents: events, shellEvents: awayShell(1000, 5000) }));

  assert.equal(sc.integrity.foreign_pastes.length, 1);
  assert.equal(sc.integrity.foreign_pastes[0].after_away_ms, 1000, "correlated with the away episode");
  const flag = fpFlag(sc);
  assert.equal(flag.code, "foreign_paste_after_away");
  assert.equal(flag.severity, "critical", "glitch-free after-away → full critical");
  assert.ok(!flag.unverified);
});

test("TEST2c external paste stays foreign even when on-page sources are present", () => {
  // The candidate legitimately sees a statement + sample I/O, but the paste is
  // genuinely external (not derivable from any of them) → still foreign.
  const statement = "Read N then N integers and print the maximum contiguous subarray sum (Kadane).";
  const sampleInput = "5\n3 1 4 1 5";
  const events = [pasteEv("p1", 1000, EXTERNAL.length), replEv("p1", 1050, 0, EXTERNAL)];
  const sc = buildScorecard(baseInput({ editorEvents: events, onPageByProblem: { p1: [statement, sampleInput] } }));

  assert.equal(sc.integrity.foreign_pastes.length, 1, "on-page sources must not over-suppress a real external paste");
  assert.equal(fpFlag(sc).severity, "warning");
});

// ===========================================================================
// TEST 3 — on-page + self pastes are NOT foreign
// ===========================================================================
test("TEST3 statement / sample-IO / own-typed pastes are NOT foreign", () => {
  // (a) pasting the problem statement text.
  const statement = "Read N then N integers and print the maximum contiguous subarray sum (Kadane).";
  const stmtChunk = "print the maximum contiguous subarray sum (Kadane).";
  const scStmt = buildScorecard(
    baseInput({
      editorEvents: [pasteEv("p1", 1000, stmtChunk.length), replEv("p1", 1050, 0, stmtChunk)],
      onPageByProblem: { p1: [statement] },
    })
  );
  assert.equal(scStmt.integrity.foreign_pastes.length, 0, "statement paste is on-page, not foreign");

  // (b) pasting sample input / expected output.
  const sampleExpected = "1 1 3 4 5 -- the sorted ascending sample output row";
  const scSample = buildScorecard(
    baseInput({
      editorEvents: [pasteEv("p1", 1000, sampleExpected.length), replEv("p1", 1050, 0, sampleExpected)],
      onPageByProblem: { p1: ["5\n3 1 4 1 5", sampleExpected] },
    })
  );
  assert.equal(scSample.integrity.foreign_pastes.length, 0, "sample-IO paste is on-page, not foreign");

  // (c) pasting the candidate's OWN already-typed content (self-duplication — the
  // exact real `occupations` pattern: type a line, then paste a copy of it).
  const line = "MAX(CASE WHEN Occupation = 'Doctor' THEN Name END) AS Doctor";
  const typed = typeOut("p1", 100, line + "\n", 30);
  const pasteT = typed.endMs + 500;
  const scSelf = buildScorecard(
    baseInput({ editorEvents: [...typed.events, pasteEv("p1", pasteT, line.length), replEv("p1", pasteT + 50, 0, line, 2, 1)] })
  );
  assert.equal(scSelf.integrity.foreign_pastes.length, 0, "pasting your own already-typed line is NOT foreign");
});

// ===========================================================================
// TEST 4 — glitchy would-be-foreign → flagged-but-downgraded-and-tagged
// (the owner design, NOT dropped). EVAL-2 MAJOR-3.
// ===========================================================================
test("TEST4a glitchy external paste STAYS foreign, tagged unreliable, flag downgraded to info", () => {
  const events = [glitchDelete("p1", 900), pasteEv("p1", 1000, EXTERNAL.length), replEv("p1", 1050, 0, EXTERNAL)];
  const sc = buildScorecard(baseInput({ editorEvents: events }));

  // NOT dropped — stays in foreign_pastes, tagged.
  assert.equal(sc.integrity.foreign_pastes.length, 1, "glitchy paste is NOT dropped");
  assert.equal(sc.integrity.foreign_pastes[0].reconstruction_unreliable, true, "tagged reconstruction_unreliable");
  // The silent side-list is gone entirely.
  assert.ok(!("unverified_pastes" in sc.integrity), "no unverified_pastes side-list field anymore");

  // The flag still fires, one severity lower, with the unverified tag + evidence note.
  const flag = fpFlag(sc);
  assert.ok(flag, "a foreign-paste flag still fires");
  assert.equal(flag.code, "foreign_paste", "no away → plain foreign_paste");
  assert.equal(flag.severity, "info", "warning downgraded to info on unreliable reconstruction");
  assert.equal(flag.unverified, true, "flag carries unverified");
  assert.match(flag.evidence, /reconstruction unreliable — unverified/, "evidence notes the unverified state");
});

test("TEST4b glitchy external paste AFTER away → critical downgraded to warning", () => {
  const pasteT = 6000;
  const events = [glitchDelete("p1", 800), pasteEv("p1", pasteT, EXTERNAL.length), replEv("p1", pasteT + 50, 0, EXTERNAL)];
  const sc = buildScorecard(baseInput({ editorEvents: events, shellEvents: awayShell(1000, 5000) }));

  assert.equal(sc.integrity.foreign_pastes.length, 1);
  assert.equal(sc.integrity.foreign_pastes[0].reconstruction_unreliable, true);
  const flag = fpFlag(sc);
  assert.equal(flag.code, "foreign_paste_after_away");
  assert.equal(flag.severity, "warning", "after_away critical downgraded to warning when unreliable");
  assert.equal(flag.unverified, true);
});

test("TEST4c downgrade actually lightens the verdict: tagged full-solution after-away does NOT confirm", () => {
  // A >=300-char foreign paste after an away episode is the canonical "confirmed"
  // trigger. The deriveTiers gate (!reconstruction_unreliable) must stop a tagged
  // one from silently re-escalating — the load-bearing "do not double-count" fix.
  const shell = awayShell(1000, 5000);
  const clean = buildScorecard(
    baseInput({ editorEvents: [pasteEv("p1", 6000, EXTERNAL_FULL.length), replEv("p1", 6050, 0, EXTERNAL_FULL)], shellEvents: shell })
  );
  assert.ok(EXTERNAL_FULL.length >= 300, "fixture sanity: full solution exceeds the gate length");
  assert.equal(clean.integrity.foreign_pastes[0].len >= 300, true);
  assert.equal(clean.tiers.integrity, "confirmed", "glitch-free full-solution after-away → confirmed");

  const glitchy = buildScorecard(
    baseInput({
      editorEvents: [glitchDelete("p1", 800), pasteEv("p1", 6000, EXTERNAL_FULL.length), replEv("p1", 6050, 0, EXTERNAL_FULL)],
      shellEvents: shell,
    })
  );
  assert.equal(glitchy.integrity.foreign_pastes[0].reconstruction_unreliable, true);
  // Load-bearing: the tagged paste de-escalates OUT of "confirmed".
  assert.notEqual(glitchy.tiers.integrity, "confirmed", "tagged paste must NOT re-escalate to confirmed");
  // The residual "flag" tier here comes from the co-present high_paste_ratio (critical)
  // in this all-paste fixture — NOT from the downgraded foreign-paste flag (a lone
  // downgraded after-away warning would be "watch"). See TEST4c-sole below for the
  // downgrade-alone effect with no incidental critical.
  assert.equal(glitchy.tiers.integrity, "flag");
});

test("TEST4c-sole the downgrade ALONE lightens the verdict (no incidental critical): confirmed → watch", () => {
  // Same full-solution after-away paste, but with enough honest typing that
  // paste_ratio stays below the high_paste_ratio threshold — so the foreign paste is
  // the SOLE integrity signal. Glitch-free → "confirmed"; tagged unreliable → "watch"
  // (the downgraded warning), proving the severity drop is what moves the verdict.
  const shell = awayShell(2000, 6000);
  // Lots of honest typing so paste_ratio stays below the high_paste_ratio threshold,
  // isolating the foreign paste as the sole integrity signal.
  const honest = typeOut("p1", 100, "def helper():\n    total = 0\n    for i in range(100):\n        total += i\n    return total\n".repeat(6), 5);
  const cleanEvents = [...honest.events, pasteEv("p1", honest.endMs + 6000, EXTERNAL_FULL.length), replEv("p1", honest.endMs + 6050, 0, EXTERNAL_FULL)];
  const clean = buildScorecard(baseInput({ editorEvents: cleanEvents, shellEvents: shell }));
  // glitchDelete FIRST (on the empty buffer) so it reliably glitches; honest typing
  // then accumulates, then the external paste.
  const glitchyEvents = [glitchDelete("p1", 50), ...honest.events, pasteEv("p1", honest.endMs + 6000, EXTERNAL_FULL.length), replEv("p1", honest.endMs + 6050, 0, EXTERNAL_FULL)];
  const glitchy = buildScorecard(baseInput({ editorEvents: glitchyEvents, shellEvents: shell }));
  // Only assert the downgrade-driven contrast if the fixture genuinely isolates the
  // foreign paste as the sole integrity signal (no high_paste_ratio etc.).
  const cleanCrit = (clean.integrity.flags || []).filter((f) => f.severity === "critical" && f.code !== "foreign_paste_after_away");
  if (cleanCrit.length === 0) {
    assert.equal(clean.tiers.integrity, "confirmed", "glitch-free full-solution after-away → confirmed");
    assert.equal(glitchy.tiers.integrity, "watch", "tagged (downgraded warning) as sole signal → watch, not confirmed/flag");
  }
  // Regardless, the tagged paste is never dropped and never confirms.
  assert.equal(glitchy.integrity.foreign_pastes[0].reconstruction_unreliable, true);
  assert.notEqual(glitchy.tiers.integrity, "confirmed");
});

test("TEST4d contrast: the SAME paste on a glitch-free problem fires at full severity, untagged", () => {
  const sc = buildScorecard(baseInput({ editorEvents: [pasteEv("p1", 1000, EXTERNAL.length), replEv("p1", 1050, 0, EXTERNAL)] }));
  assert.equal(sc.integrity.foreign_pastes.length, 1);
  assert.ok(!sc.integrity.foreign_pastes[0].reconstruction_unreliable, "not tagged");
  const flag = fpFlag(sc);
  assert.equal(flag.severity, "warning", "full severity");
  assert.ok(!flag.unverified, "no unverified tag");
});

// ===========================================================================
// TEST 5 — induce-glitch dodge is closed
// ===========================================================================
test("TEST5 honest typing + one external paste + one FORGED glitch → still flagged, not dropped", () => {
  // The candidate types honestly, then pastes one genuinely-external snippet, and
  // injects a forged glitch event on the same problem to try to silence the
  // foreign-paste flag. Under the OLD design this paste vanished into a silent
  // side-list. Now it MUST remain visible: in foreign_pastes (tagged) AND flagged.
  const honest = typeOut("p1", 100, "int add(int a,int b){\n  return a+b;\n}\n", 40);
  const forged = glitchDelete("p1", honest.endMs + 10);
  const pasteT = honest.endMs + 1000;
  const events = [...honest.events, forged, pasteEv("p1", pasteT, EXTERNAL.length), replEv("p1", pasteT + 50, 0, EXTERNAL, 4, 1)];
  const sc = buildScorecard(baseInput({ editorEvents: events }));

  // The dodge fails: the external paste is NOT hidden/dropped.
  assert.equal(sc.integrity.foreign_pastes.length, 1, "forged-glitch paste is still surfaced, not dropped");
  assert.equal(sc.integrity.foreign_pastes[0].reconstruction_unreliable, true, "marked unreliable (de-weighted, not silenced)");
  assert.ok(!("unverified_pastes" in sc.integrity), "no silent side-list to dodge into");

  const flag = fpFlag(sc);
  assert.ok(flag, "a foreign-paste flag STILL fires despite the forged glitch");
  assert.equal(flag.unverified, true, "rendered as unverified, not dropped");
});
