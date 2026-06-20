import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REPLAY,
  lineColToOffset,
  applyChange,
  collapseWs,
  normalizedLineDistance,
  replaySession,
  isBareTemplate,
} from "../src/evaluationReplay.mjs";

// Helpers to build events tersely.
let _t = 0;
function tsAt(ms) {
  return new Date(ms).toISOString();
}
function ins(pid, ms, text, startLine, startCol) {
  return {
    type: "editor_insert",
    timestamp: tsAt(ms),
    problem_id: pid,
    detail: {
      insertedLen: text.length,
      deletedLen: 0,
      text,
      startLine,
      startCol,
      endLine: startLine,
      endCol: startCol,
    },
  };
}
function del(pid, ms, content, startLine, startCol, endLine, endCol) {
  // compute removed for deletedLen
  const off1 = lineColToOffset(content, startLine, startCol);
  const off2 = lineColToOffset(content, endLine, endCol);
  return {
    type: "editor_delete",
    timestamp: tsAt(ms),
    problem_id: pid,
    detail: {
      insertedLen: 0,
      deletedLen: off2 - off1,
      text: "",
      startLine,
      startCol,
      endLine,
      endCol,
    },
  };
}
function repl(pid, ms, content, text, startLine, startCol, endLine, endCol) {
  const off1 = lineColToOffset(content, startLine, startCol);
  const off2 = lineColToOffset(content, endLine, endCol);
  return {
    type: "editor_replace",
    timestamp: tsAt(ms),
    problem_id: pid,
    detail: {
      insertedLen: text.length,
      deletedLen: off2 - off1,
      text,
      startLine,
      startCol,
      endLine,
      endCol,
    },
  };
}
function paste(pid, ms, len, line = 1, col = 1) {
  return { type: "editor_paste", timestamp: tsAt(ms), problem_id: pid, detail: { len, line, col } };
}
function submit(pid, ms) {
  return { type: "code_submit", timestamp: tsAt(ms), problem_id: pid, detail: { language: "java" } };
}
function run(pid, ms) {
  return { type: "code_run", timestamp: tsAt(ms), problem_id: pid, detail: { language: "java" } };
}
function switchTo(from, to, ms) {
  return {
    type: "problem_switched",
    timestamp: tsAt(ms),
    problem_id: to,
    detail: { from_problem_id: from, to_problem_id: to },
  };
}

test("REPLAY constants match contract", () => {
  assert.equal(REPLAY.PASTE_PAIR_WINDOW_MS, 500);
  assert.equal(REPLAY.MIN_FOREIGN_PASTE_LEN, 30);
  assert.equal(REPLAY.LARGE_INSERT_PASTE_LEN, 40);
  assert.equal(REPLAY.AUTOCOMPLETE_MAX_LEN, 60);
  assert.equal(REPLAY.BURST_WINDOW_MS, 2000);
  assert.equal(REPLAY.BURST_MIN_CHARS, 80);
  assert.equal(REPLAY.IDLE_GAP_MS, 60000);
  assert.equal(REPLAY.MISMATCH_THRESHOLD, 0.15);
});

test("lineColToOffset 1-based and clamped", () => {
  const c = "abc\ndef\nghi";
  assert.equal(lineColToOffset(c, 1, 1), 0);
  assert.equal(lineColToOffset(c, 1, 4), 3); // end of line 1 (before \n)
  assert.equal(lineColToOffset(c, 2, 1), 4); // start of line 2
  assert.equal(lineColToOffset(c, 3, 4), 11); // end of doc
  assert.equal(lineColToOffset(c, 99, 99), c.length); // beyond → clamp end
  assert.equal(lineColToOffset(c, 2, 99), 7); // col beyond line → clamp to line end
});

test("applyChange insert/delete/replace and final content exact", () => {
  let content = "";
  // insert "hello" at 1,1
  let r = applyChange(content, { insertedLen: 5, deletedLen: 0, text: "hello", startLine: 1, startCol: 1, endLine: 1, endCol: 1 });
  assert.equal(r.content, "hello");
  assert.equal(r.glitch, false);
  // insert " world" at end
  r = applyChange(r.content, { insertedLen: 6, deletedLen: 0, text: " world", startLine: 1, startCol: 6, endLine: 1, endCol: 6 });
  assert.equal(r.content, "hello world");
  // replace "world" (cols 7..12) with "there"
  r = applyChange(r.content, { insertedLen: 5, deletedLen: 5, text: "there", startLine: 1, startCol: 7, endLine: 1, endCol: 12 });
  assert.equal(r.content, "hello there");
  // delete "hello " (cols 1..7)
  r = applyChange(r.content, { insertedLen: 0, deletedLen: 6, text: "", startLine: 1, startCol: 1, endLine: 1, endCol: 7 });
  assert.equal(r.content, "there");
});

test("applyChange glitch detection when range disagrees with deletedLen", () => {
  const content = "abcdef";
  // claim deletedLen=3 but range cols 1..2 (length 1) → glitch
  const r = applyChange(content, { insertedLen: 0, deletedLen: 3, text: "", startLine: 1, startCol: 1, endLine: 1, endCol: 2 });
  assert.equal(r.glitch, true);
  // resync removes deletedLen=3 chars from start
  assert.equal(r.content, "def");
});

test("collapseWs collapses and trims", () => {
  assert.equal(collapseWs("  a\n\t b   c  "), "a b c");
  assert.equal(collapseWs(""), "");
});

test("normalizedLineDistance basic", () => {
  assert.equal(normalizedLineDistance("a\nb\nc", "a\nb\nc"), 0);
  assert.equal(normalizedLineDistance("a\nb", "x\ny"), 1);
  // trailing newline equivalence
  assert.equal(normalizedLineDistance("x\n", "x"), 0);
  const d = normalizedLineDistance("a\nb\nc", "a\nB\nc");
  assert.ok(d > 0 && d < 0.5);
});

test("replay multi-event stream produces exact final content per problem", () => {
  const P = "p1";
  const events = [
    ins(P, 1000, "int x = 1;\n", 1, 1),
    ins(P, 1100, "int y = 2;\n", 2, 1),
    // delete line 1 "int x = 1;\n"
    del(P, 1200, "int x = 1;\nint y = 2;\n", 1, 1, 2, 1),
  ];
  const out = replaySession(events, {});
  assert.equal(out.problems[P].final_content, "int y = 2;\n");
  assert.equal(out.events_n, 3);
});

test("paste pairing: editor_paste + coincident replace classified as paste", () => {
  const P = "p1";
  const big = "x".repeat(120);
  const events = [
    paste(P, 1000, 120, 1, 1),
    // coincident change carrying the text, 50ms later, within ±500ms & len match
    repl(P, 1050, "", big, 1, 1, 1, 1),
  ];
  const out = replaySession(events, {});
  // typed should be 0, pasted should be 120
  assert.equal(out.typed_chars_by_problem[P] || 0, 0);
  assert.equal(out.pasted_chars_by_problem[P], 120);
  const rec = out.pastes.find((p) => p.len === 120);
  assert.ok(rec);
  assert.equal(rec.paired, true);
  assert.equal(rec.text, big);
});

test("paste pairing backward: change arrives just before the paste marker", () => {
  const P = "p1";
  const big = "y".repeat(100);
  const events = [
    repl(P, 1000, "", big, 1, 1, 1, 1),
    paste(P, 1100, 100, 1, 1),
  ];
  const out = replaySession(events, {});
  assert.equal(out.pasted_chars_by_problem[P], 100);
  assert.equal(out.typed_chars_by_problem[P] || 0, 0);
  const rec = out.pastes.find((p) => p.paired);
  assert.ok(rec);
});

test("unpaired big insert >=40 classified as paste WHEN paste telemetry present", () => {
  // Real-detection preserved: when the session DOES emit paste/selection markers
  // (here a non-pairing earlier paste marker), the "large unpaired insert ⇒
  // pasted" inference still fires exactly as before.
  const P = "p1";
  const blob = "abcdefghij\nklmnopqrst\nuvwxyz0123\n4567890abc"; // 43 chars, multiline
  const events = [
    paste(P, 100, 7), // a small paste marker far from the big insert (won't pair: len mismatch + window)
    ins(P, 1000, blob, 1, 1),
  ];
  const out = replaySession(events, {});
  // The 43-char unpaired insert is inferred pasted (7 from the unpaired marker +
  // 43 from the inferred-paste insert).
  assert.equal(out.pasted_chars_by_problem[P], 7 + blob.length);
  assert.equal(out.typed_chars_by_problem[P] || 0, 0);
  assert.equal(out.paste_inference_available, true);
});

test("unpaired big insert NOT inferred pasted when NO paste/selection telemetry (availability gate)", () => {
  // Missing-data gate (2026-06-19): with ZERO paste AND ZERO selection events in
  // the stream, a large unpaired insert is INCONCLUSIVE on the paste axis, not a
  // paste. It must not inflate pasted_chars / paste_ratio. The diagnosis: today's
  // cohort emitted no paste/selection markers, so legitimate large inserts were
  // mis-credited as pasted, flagging an honest cohort.
  const P = "p1";
  const blob = "abcdefghij\nklmnopqrst\nuvwxyz0123\n4567890abc"; // 43 chars, multiline
  const events = [ins(P, 1000, blob, 1, 1)];
  const out = replaySession(events, {});
  assert.equal(out.pasted_chars_by_problem[P] || 0, 0);
  assert.equal(out.typed_chars_by_problem[P], blob.length);
  assert.equal(out.paste_inference_available, false);
  assert.equal(out.has_paste_events, false);
  assert.equal(out.has_selection_events, false);
});

test("availability flag set by editor_selection alone re-enables paste inference", () => {
  // A session that emits selection telemetry (but no explicit paste markers)
  // still has the paste-inference signal available, so a large unpaired insert
  // is classified as before.
  const P = "p1";
  const blob = "abcdefghij\nklmnopqrst\nuvwxyz0123\n4567890abc"; // 43 chars
  const events = [
    { type: "editor_selection", timestamp: tsAt(100), problem_id: P, detail: { startLine: 1, startCol: 1, endLine: 1, endCol: 5 } },
    ins(P, 1000, blob, 1, 1),
  ];
  const out = replaySession(events, {});
  assert.equal(out.pasted_chars_by_problem[P], blob.length);
  assert.equal(out.has_selection_events, true);
  assert.equal(out.paste_inference_available, true);
});

test("autocomplete-shaped insert excluded from paste", () => {
  const P = "p1";
  // single line, <=60 chars, ends in ')' → autocomplete
  const text = "System.out.println(answer)";
  const events = [ins(P, 1000, text, 1, 1)];
  const out = replaySession(events, {});
  assert.equal(out.typed_chars_by_problem[P], text.length);
  assert.equal(out.pasted_chars_by_problem[P] || 0, 0);
});

test("stub-matching large insert excluded from paste", () => {
  const P = "p1";
  const stub = "public class Main {\n    public static void main(String[] a) {\n    }\n}\n";
  const events = [ins(P, 1000, stub, 1, 1)];
  const out = replaySession(events, { stubs: [stub] });
  assert.equal(out.pasted_chars_by_problem[P] || 0, 0);
  assert.equal(out.typed_chars_by_problem[P], stub.length);
});

test("foreign vs self-paste: moving own code is benign", () => {
  const P = "p1";
  const P2 = "p2";
  const ownBlock = "for(int i=0;i<n;i++){ sum+=arr[i]; total++; check(i); }"; // >30 chars
  const events = [
    // type own code in p1 (as a big paste-classified insert but it's the origin)
    ins(P, 1000, ownBlock, 1, 1),
    switchTo(P, P2, 2000),
    // paste the SAME block into p2 → self-paste, foreign:false
    paste(P2, 3000, ownBlock.length, 1, 1),
    repl(P2, 3050, "", ownBlock, 1, 1, 1, 1),
  ];
  const out = replaySession(events, {});
  const rec = out.pastes.find((p) => p.problem_id === P2 && p.len >= 40);
  assert.ok(rec);
  assert.equal(rec.foreign, false);
});

test("foreign paste: text never seen before is foreign", () => {
  const P = "p1";
  const foreign = "def quicksort(a):\n  if len(a)<=1: return a\n  p=a[0]; return qs(lo)+[p]+qs(hi)";
  const events = [paste(P, 1000, foreign.length, 1, 1), repl(P, 1050, "", foreign, 1, 1, 1, 1)];
  const out = replaySession(events, {});
  const rec = out.pastes.find((p) => p.len >= 40);
  assert.ok(rec);
  assert.equal(rec.foreign, true);
});

test("extraSelfTexts and stubs make a paste benign", () => {
  const P = "p1";
  const blob = "private static long modpow(long b,long e,long m){ long r=1; return r; }";
  let out = replaySession([paste(P, 1000, blob.length, 1, 1), repl(P, 1050, "", blob, 1, 1, 1, 1)], { extraSelfTexts: [blob] });
  let rec = out.pastes.find((p) => p.len >= 40);
  assert.equal(rec.foreign, false);
  out = replaySession([paste(P, 1000, blob.length, 1, 1), repl(P, 1050, "", blob, 1, 1, 1, 1)], { stubs: [blob] });
  rec = out.pastes.find((p) => p.len >= 40);
  assert.equal(rec.foreign, false);
});

test("truncated mega-paste prefix matching against self", () => {
  const P = "p1";
  const P2 = "p2";
  const fullOwn = "A".repeat(50) + "_OWN_CODE_BLOCK_" + "B".repeat(50);
  const prefix = fullOwn.slice(0, 60); // captured (truncated) prefix
  const events = [
    ins(P, 1000, fullOwn, 1, 1),
    switchTo(P, P2, 2000),
    paste(P2, 3000, fullOwn.length, 1, 1),
    {
      type: "editor_replace",
      timestamp: tsAt(3050),
      problem_id: P2,
      detail: { insertedLen: prefix.length, deletedLen: 0, text: prefix, startLine: 1, startCol: 1, endLine: 1, endCol: 1, truncated: true },
    },
  ];
  const out = replaySession(events, {});
  const rec = out.pastes.find((p) => p.problem_id === P2);
  assert.ok(rec);
  // prefix is a substring of own prior content → benign
  assert.equal(rec.foreign, false);
});

test("glitch detection counts per problem", () => {
  const P = "p1";
  const events = [
    ins(P, 1000, "abcdef", 1, 1),
    // delete claiming deletedLen 3 but range length 1 → glitch
    { type: "editor_delete", timestamp: tsAt(1100), problem_id: P, detail: { insertedLen: 0, deletedLen: 3, text: "", startLine: 1, startCol: 1, endLine: 1, endCol: 2 } },
  ];
  const out = replaySession(events, {});
  assert.equal(out.problems[P].glitches, 1);
});

test("active_ms gap capping excludes gaps > 60s", () => {
  const P = "p1";
  const events = [
    ins(P, 0, "a", 1, 1),
    ins(P, 5000, "b", 1, 2), // +5s
    ins(P, 100000, "c", 1, 3), // +95s gap → excluded
    ins(P, 110000, "d", 1, 4), // +10s
  ];
  const out = replaySession(events, {});
  // 5000 + 10000 = 15000 (95s gap excluded)
  assert.equal(out.active_ms_by_problem[P], 15000);
});

test("submit snapshot captures content at submit time", () => {
  const P = "p1";
  const events = [
    ins(P, 1000, "v1 code", 1, 1),
    submit(P, 1500),
    ins(P, 2000, " more", 1, 8),
    submit(P, 2500),
  ];
  const out = replaySession(events, {});
  assert.equal(out.submit_snapshots.length, 2);
  assert.equal(out.submit_snapshots[0].content, "v1 code");
  assert.equal(out.submit_snapshots[1].content, "v1 code more");
  assert.equal(out.submit_marks.length, 2);
});

test("run marks captured", () => {
  const P = "p1";
  const out = replaySession([run(P, 100), run(P, 200)], {});
  assert.equal(out.run_marks.length, 2);
});

test("single_char_ts captures only insertedLen==1 editor_insert", () => {
  const P = "p1";
  const events = [
    ins(P, 100, "a", 1, 1),
    ins(P, 200, "b", 1, 2),
    ins(P, 300, "cd", 1, 3), // not single-char
  ];
  const out = replaySession(events, {});
  assert.deepEqual(out.single_char_ts_by_problem[P], [100, 200]);
});

test("bursts: >=80 typed chars within 2s recorded", () => {
  const P = "p1";
  // four 25-char single-line autocomplete-shaped-but-typed inserts? Need typed.
  // Use multi-line so not autocomplete but small enough (<40) to stay typed.
  const chunk = "abcdefghijklmnopqrstuvwxy0\n"; // 26 chars, <40, multiline → typed
  const events = [
    ins(P, 0, chunk, 1, 1),
    ins(P, 200, chunk, 2, 1),
    ins(P, 400, chunk, 3, 1),
    ins(P, 600, chunk, 4, 1),
  ];
  const out = replaySession(events, {});
  assert.ok(out.bursts.length >= 1);
  assert.ok(out.bursts[0].chars >= REPLAY.BURST_MIN_CHARS);
  assert.equal(out.bursts[0].problem_id, P);
});

test("null-problem events attributed to active problem; pre-switch nulls skipped", () => {
  const P = "p1";
  const events = [
    // null problem before any switch → skipped (no active)
    { type: "editor_insert", timestamp: tsAt(100), problem_id: null, detail: { insertedLen: 3, deletedLen: 0, text: "xyz", startLine: 1, startCol: 1, endLine: 1, endCol: 1 } },
    switchTo(null, P, 200),
    // null problem after switch → attributed to P
    { type: "editor_insert", timestamp: tsAt(300), problem_id: null, detail: { insertedLen: 5, deletedLen: 0, text: "hello", startLine: 1, startCol: 1, endLine: 1, endCol: 1 } },
  ];
  const out = replaySession(events, {});
  assert.equal(out.problems[P].final_content, "hello");
});

test("unpaired paste marker counts len but text unknown", () => {
  const P = "p1";
  const events = [paste(P, 1000, 200, 1, 1)]; // no coincident change
  const out = replaySession(events, {});
  assert.equal(out.pasted_chars_by_problem[P], 200);
  const rec = out.pastes.find((p) => p.len === 200);
  assert.equal(rec.paired, false);
  assert.equal(rec.text, "");
  assert.equal(rec.foreign, false);
});

test("performance: 200k events well under a second", () => {
  const P = "p1";
  const events = [];
  for (let i = 0; i < 200000; i++) {
    events.push(ins(P, i * 10, "a", 1, 1 + (i % 50)));
  }
  const start = Date.now();
  const out = replaySession(events, {});
  const elapsed = Date.now() - start;
  assert.ok(out.events_n === 200000);
  // Load-tolerant ceiling, NOT a benchmark: this guards against catastrophic
  // (order-of-magnitude / super-linear) replay regressions, which would take
  // many seconds. A 200k-event replay runs in well under a second in
  // isolation; the generous 10s wall is to avoid flaking when the host CPU is
  // under contention (CI/parallel test runs/background jobs).
  assert.ok(elapsed < 10000, `replay took ${elapsed}ms`);
});

// ---- (a) bare-template foreign-paste suppression ----------------------------
// Real HR templates (whitespace-collapsed, byte-accurate from the saved
// scorecard cross_inputs.foreign_paste_texts) — pasting one is HR muscle memory,
// carries zero algorithm signal, and must NOT be flagged foreign.
const BARE_TEMPLATES = {
  // JAVA_HR: imports → class Result { Complete the 'X' / Write your code here } → public class Main.
  java:
    "import java.io.*; import java.math.*; import java.security.*; import java.text.*; import java.util.*; import java.util.concurrent.*; import java.util.regex.*; class Result { /* * Complete the 'solve' function below. *compelete the 'solve' function below. * The function is expected to return an INTEGER. * The function accepts INTEGER_ARRAY s as parameter. */ public static int solve(List<Integer> s) { // Write your code here return 0; } } public class Main { public static void main(String[] args)",
  // PY3_HR: shebang + stdlib imports → # Complete the 'X' → def X → if __name__ main.
  python:
    "#!/bin/python3 import math import os import random import re import sys # # Complete the 'minCoins' function below. # # The function is expected to return an INTEGER. # The function accepts INTEGER n as parameter. # def minCoins(n): # Write your code here return 0 if __name__ == '__main__': fptr = sys.stdout n = int(input().strip()) result = minCoins(n) fptr.write(str(result) + '\\n')",
  // JS_HR: 'use strict' + fs + stdin scaffold → readLine → Complete the 'X'.
  javascript:
    "'use strict'; const fs = require('fs'); process.stdin.resume(); process.stdin.setEncoding('utf-8'); let inputString = ''; let currentLine = 0; process.stdin.on('data', function(inputStdin) { inputString += inputStdin; }); process.stdin.on('end', function() { inputString = inputString.split('\\n'); main(); }); function readLine() { return inputString[currentLine++]; } /* * Complete the 'minCoins' function below. * * The function is expected to return an INTEGER. * The function accepts INTEGER n as",
  // CPP_BITS: bits/stdc++ + ltrim/rtrim decls → int X(){ Write your code here } → int main.
  cpp:
    '#include <bits/stdc++.h> using namespace std; string ltrim(const string &); string rtrim(const string &); /* * Complete the \'minCoins\' function below. * * The function is expected to return an INTEGER. * The function accepts INTEGER n as parameter. */ int minCoins(int n) { // Write your code here return 0; } int main() { ostream& fout = cout; string n_temp; getline(cin, n_temp); int n = stoi(ltrim(rtrim(n_temp))); int result = minCoins(n); fout << result << "\\n"; return 0; } string ltrim(const s',
  // SQL_DDL: the problem's own CREATE TABLE + INSERT seed rows pasted into the query editor.
  sql:
    "CREATE TABLE ORDERS(id INT , customer VARCHAR(30),amount INT); INSERT INTO ORDERS VALUES (1, 'Alice', 600); INSERT INTO ORDERS VALUES (2, 'Alice', 700); INSERT INTO ORDERS VALUES (3, 'Bob', 1500); INSERT INTO ORDERS VALUES (4, 'Carol', 400);",
};

// The proctor's OWN generic STARTERS (CodingWorkspace.tsx STARTERS), collapsed.
const PROCTOR_STARTERS = [
  "# Read from standard input, print the answer to standard output.",
  "#include <bits/stdc++.h> using namespace std; int main() { // Read from stdin, print the answer to stdout. return 0; }",
  "import java.util.*; public class Main { public static void main(String[] args) { // Read from System.in, print the answer to System.out. } }",
  '// Read from stdin, print the answer to stdout. const input = require("fs").readFileSync(0, "utf8");',
  "-- Write your SQL query below.",
];

test("isBareTemplate: each real HR language template is recognized as bare", () => {
  for (const [lang, tpl] of Object.entries(BARE_TEMPLATES)) {
    assert.equal(isBareTemplate(tpl), true, `${lang} template should be bare`);
  }
});

test("isBareTemplate: proctor's own generic STARTERS are bare", () => {
  for (const s of PROCTOR_STARTERS) {
    assert.equal(isBareTemplate(s), true, `starter should be bare: ${s.slice(0, 40)}`);
  }
});

test("isBareTemplate: template + a real appended solution (over maxLen) is NOT bare", () => {
  // Append a long genuine algorithm so the collapsed paste is clearly longer than
  // the language maxLen bound (PY3 ~1000) — this is the case the bound protects.
  const solution = Array.from(
    { length: 70 },
    (_, i) => `dp[${i}] = max(dp[${i - 1}], dp[${i}] + weight[${i}]) # transition ${i} of the recurrence`
  ).join(" ");
  const combo = collapseWs(BARE_TEMPLATES.python + " def solve(s): " + solution);
  assert.ok(combo.length > 1000, `combo should exceed PY3 maxLen, got ${combo.length}`);
  assert.equal(isBareTemplate(combo), false);
});

test("isBareTemplate: a genuinely foreign algorithm paste (no template preamble) is NOT bare", () => {
  // ~300-char unique solution with no language preamble → not a template.
  const foreign = collapseWs(
    "public static int countSubsequences(int[] arr, int target) { int n = arr.length; int[][] dp = new int[n+1][target+1]; for (int i = 0; i <= n; i++) dp[i][0] = 1; for (int i = 1; i <= n; i++) for (int s = 1; s <= target; s++) { dp[i][s] = dp[i-1][s]; if (arr[i-1] <= s) dp[i][s] += dp[i-1][s-arr[i-1]]; } return dp[n][target]; }"
  );
  assert.ok(foreign.length >= 300);
  assert.equal(isBareTemplate(foreign), false);
});

test("isBareTemplate: too-short snippet is NOT bare", () => {
  assert.equal(isBareTemplate("int x = 5;"), false);
  assert.equal(isBareTemplate(""), false);
  // shebang preamble but no scaffold markers (a tiny real solution) → not bare.
  assert.equal(
    isBareTemplate("#!/bin/python3 import math import os import random import re import sys print(\"YES\")"),
    false
  );
});

test("replaySession: pasting a bare HR template is suppressed (foreign:false)", () => {
  const P = "p1";
  const tpl = BARE_TEMPLATES.python;
  const events = [paste(P, 1000, tpl.length, 1, 1), repl(P, 1050, "", tpl, 1, 1, 1, 1)];
  const out = replaySession(events, {});
  const rec = out.pastes.find((p) => p.len >= REPLAY.MIN_FOREIGN_PASTE_LEN);
  assert.ok(rec);
  assert.equal(rec.foreign, false);
});

test("replaySession: bare template + a real long solution stays foreign", () => {
  const P = "p1";
  const solution = Array.from(
    { length: 70 },
    (_, i) => `dp[${i}] = max(dp[${i - 1}], dp[${i}] + weight[${i}]) # transition ${i}`
  ).join(" ");
  const paste1 = BARE_TEMPLATES.python + " def solve(s): " + solution; // clearly > maxLen
  assert.ok(collapseWs(paste1).length > 1000);
  const events = [paste(P, 1000, paste1.length, 1, 1), repl(P, 1050, "", paste1, 1, 1, 1, 1)];
  const out = replaySession(events, {});
  const rec = out.pastes.find((p) => p.len >= REPLAY.MIN_FOREIGN_PASTE_LEN);
  assert.ok(rec);
  assert.equal(rec.foreign, true);
});

// ---- (a) BODY-EMPTINESS GATE -------------------------------------------------
// The bug: a real external/AI solution that RETAINS the HR scaffold (imports +
// Main/main I/O) but fills the USER FUNCTION BODY with a real algorithm — yet is
// shorter than maxLen (a complete medium solution is ~200-500 collapsed chars,
// well under the 1000-1300 bound, and can even be SHORTER than the full bare
// template). Length alone can never separate it, so isBareTemplate must also gate
// on the user function body being a bare stub. These four are compact (~200-500
// collapsed), retain each language's scaffold, and carry a real algorithm.
const SCAFFOLD_RETAINING_SOLUTIONS = {
  // JAVA: max-profit single-pass scan, inside class Result, Main scaffold retained.
  java:
    "import java.io.*; import java.math.*; import java.security.*; import java.text.*; import java.util.*; import java.util.concurrent.*; import java.util.regex.*; class Result { public static int solve(List<Integer> prices) { int minP = Integer.MAX_VALUE; int best = 0; for (int p : prices) { if (p < minP) minP = p; else if (p - minP > best) best = p - minP; } return best; } } public class Main { public static void main(String[] args) throws IOException {",
  // CPP: prime check, bits/stdc++ + int main scaffold retained.
  cpp:
    "#include <bits/stdc++.h> using namespace std; string ltrim(const string &); string rtrim(const string &); int solve(int n) { if (n < 2) return 0; for (int i = 2; (long long)i * i <= n; i++) { if (n % i == 0) return 0; } return 1; } int main() { ostream& fout = cout; string n_temp; getline(cin, n_temp); int n = stoi(ltrim(rtrim(n_temp))); int result = solve(n); fout << result; return 0; }",
  // PYTHON: greedy coin-change, shebang + if __name__ scaffold retained.
  python:
    "#!/bin/python3 import math import os import random import re import sys # # Complete the 'minCoins' function below. # def minCoins(n): coins = [25, 10, 5, 1] count = 0 for c in coins: while n >= c: n -= c count += 1 return count if __name__ == '__main__': fptr = sys.stdout n = int(input().strip()) result = minCoins(n) fptr.write(str(result) + '\\n')",
  // JS: even-sum scan, use strict + readLine + main scaffold retained.
  javascript:
    "'use strict'; const fs = require('fs'); process.stdin.resume(); process.stdin.setEncoding('utf-8'); let inputString = ''; let currentLine = 0; process.stdin.on('data', d => { inputString += d; }); function readLine() { return inputString[currentLine++]; } /* Complete the 'solve' function below. */ function solve(s) { let total = 0; for (let i = 0; i < s.length; i++) { if (s[i] % 2 === 0) total += s[i]; } return total; } function main() { const n = parseInt(readLine()); }",
};

test("isBareTemplate: scaffold-retaining REAL solution (compact, < maxLen) is NOT bare", () => {
  for (const [lang, src] of Object.entries(SCAFFOLD_RETAINING_SOLUTIONS)) {
    const c = collapseWs(src);
    // It is compact — squarely under the language maxLen bound (1000/1300) — so
    // length alone could NOT distinguish it from a bare template.
    assert.ok(c.length <= 600, `${lang} should be compact, got ${c.length}`);
    assert.equal(isBareTemplate(c), false, `${lang} scaffold+real-algo must NOT be bare`);
  }
});

test("isBareTemplate: bare preamble + real algorithm in body, UNDER old maxLen, is NOT bare", () => {
  // Kadane's max-subarray substituted into the body; collapsed length is small
  // (well under PY3 maxLen 1000), proving the body gate — not the length bound —
  // is what rejects it.
  const c = collapseWs(
    "#!/bin/python3 import math import os import random import re import sys # Complete the 'solve' function below. def solve(a): best = a[0] cur = a[0] for x in a[1:]: cur = max(x, cur + x) best = max(best, cur) return best if __name__ == '__main__': print(solve([1, 2, 3]))"
  );
  assert.ok(c.length < 1000, `should be under PY3 maxLen, got ${c.length}`);
  assert.equal(isBareTemplate(c), false);
});

test("isBareTemplate: genuine empty-stub bodies stay bare (cleanup preserved)", () => {
  // Each real bare HR template — placeholder + trivial return/pass only — must
  // STILL classify bare so the 0618 desk-check cleanup (224 honest candidates) is
  // preserved. (BARE_TEMPLATES are byte-accurate empty stubs from the saved data.)
  for (const [lang, tpl] of Object.entries(BARE_TEMPLATES)) {
    assert.equal(isBareTemplate(tpl), true, `${lang} empty-stub template must stay bare`);
  }
  // Extra explicit empty-stub bodies seen in the real data (return 0 only, no
  // placeholder; and a return-0-only Java body).
  const pyStub = collapseWs(
    "#!/bin/python3 import math import os import random import re import sys # # Complete the 'solve' function below. # def solve(s): return 0 if __name__ == '__main__': fptr = sys.stdout n = int(input().strip()) s = list(map(int, input().rstrip().split())) result = solve(s) fptr.write(str(result) + '\\n')"
  );
  assert.equal(isBareTemplate(pyStub), true);
  const javaStub = collapseWs(
    "import java.io.*; import java.math.*; import java.security.*; import java.text.*; import java.util.*; import java.util.concurrent.*; import java.util.regex.*; class Result { /* * Complete the 'solve' function below. */ public static int solve(List<Integer> s) { return 0; } } public class Main { public static void main(String[] args) throws IOException { BufferedReader b"
  );
  assert.equal(isBareTemplate(javaStub), true);
});

test("replaySession: scaffold-retaining real solution stays foreign (bug fix)", () => {
  for (const [lang, src] of Object.entries(SCAFFOLD_RETAINING_SOLUTIONS)) {
    const P = "p1";
    const events = [paste(P, 1000, src.length, 1, 1), repl(P, 1050, "", src, 1, 1, 1, 1)];
    const out = replaySession(events, {});
    const rec = out.pastes.find((p) => p.len >= REPLAY.MIN_FOREIGN_PASTE_LEN);
    assert.ok(rec, `${lang}: expected a foreign-eligible paste record`);
    assert.equal(rec.foreign, true, `${lang} scaffold+real-algo paste must stay foreign`);
  }
});
