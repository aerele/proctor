import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REPLAY,
  lineColToOffset,
  applyChange,
  collapseWs,
  normalizedLineDistance,
  replaySession,
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

test("unpaired big insert >=40 classified as paste", () => {
  const P = "p1";
  const blob = "abcdefghij\nklmnopqrst\nuvwxyz0123\n4567890abc"; // 43 chars, multiline
  const events = [ins(P, 1000, blob, 1, 1)];
  const out = replaySession(events, {});
  assert.equal(out.pasted_chars_by_problem[P], blob.length);
  assert.equal(out.typed_chars_by_problem[P] || 0, 0);
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
  assert.ok(elapsed < 2000, `replay took ${elapsed}ms`);
});
