// backend/test/evaluationReplayDosGuard.test.mjs
//
// Regression guard for the reconstruction-growth DoS (EVAL-2 security fix):
//   - A forged editor event with an absurd startLine/endLine used to grow the
//     TextBuffer toward that line. The `_ensureGap` spread (`splice(idx, 0,
//     ...filler)`) overflowed the call stack (RangeError) at ~125-200k lines,
//     aborting the ENTIRE contest-eval batch (no try/catch around the candidate
//     loop) — a persistent DoS, since events live in GCS.
//   - Even short of crashing, a large grown document made every later edit's
//     range resolution O(lines) → super-linear replay time.
//
// The fix caps the reconstructed document at MAX_RECON_LINES total lines: a
// reference beyond the cap clamps to the content end (the safe O(1) flat-offset
// behavior) and the edit glitches, never growing. Real exam documents (the
// largest observed references line 47) are far under the cap, so genuine
// reconstructions are byte-identical. These tests pin all three properties:
// no crash, bounded time, and faithful within-cap growth.

import { test } from "node:test";
import assert from "node:assert/strict";
import { replaySession, applyChange } from "../src/evaluationReplay.mjs";

function tsAt(ms) {
  return new Date(ms).toISOString();
}
function ev(type, pid, ms, detail) {
  return { type, problem_id: pid, timestamp: tsAt(ms), detail };
}
function insAt(pid, ms, text, line, col) {
  return ev("editor_insert", pid, ms, {
    insertedLen: text.length,
    deletedLen: 0,
    text,
    startLine: line,
    startCol: col,
    endLine: line,
    endCol: col,
  });
}

// ---------------------------------------------------------------------------
// (a) A single event at startLine 1_000_000 does NOT throw, clamps to content
//     end (no million-line allocation), and glitches when its deletedLen lies.
// ---------------------------------------------------------------------------
test("DoS guard: single event at startLine 1_000_000 clamps + glitches, no throw", () => {
  // editor_replace claiming to delete 5 chars at line 1,000,000 of an EMPTY doc.
  // The range clamps to the content end (offset 0..0, deletes nothing), so the
  // claimed deletedLen=5 disagrees with the actual 0 → glitch. The inserted text
  // lands at the clamped end. Critically: the document is NOT grown to a million
  // lines.
  const forged = ev("editor_replace", "p1", 1000, {
    insertedLen: 3,
    deletedLen: 5,
    text: "abc",
    startLine: 1_000_000,
    startCol: 1,
    endLine: 1_000_000,
    endCol: 6,
  });

  let out;
  assert.doesNotThrow(() => {
    out = replaySession([forged], {});
  });
  const p = out.problems.p1;
  assert.equal(p.final_content, "abc"); // clamped append, no blank-line growth
  assert.ok(p.final_content.length < 100, `content stayed bounded (${p.final_content.length})`);
  assert.equal(p.glitches, 1, "forged out-of-range edit is flagged as a glitch");

  // And a pure INSERT at an absurd line is also clamped (not grown), no throw.
  let out2;
  assert.doesNotThrow(() => {
    out2 = replaySession([insAt("p1", 1000, "x", 999_999, 1)], {});
  });
  assert.equal(out2.problems.p1.final_content, "x");

  // The original crash-probe lines all survive now (no RangeError).
  for (const L of [50_000, 100_000, 200_000, 999_999]) {
    assert.doesNotThrow(() => replaySession([insAt("p1", 1000, "x", L, 1)], {}), `line ${L} must not throw`);
  }

  // String path (applyChange) clamps identically — no growth to content end.
  const r = applyChange("", { startLine: 1_000_000, startCol: 1, endLine: 1_000_000, endCol: 6, text: "abc", deletedLen: 5, insertedLen: 3 });
  assert.equal(r.content, "abc");
  assert.equal(r.glitch, true);
});

// ---------------------------------------------------------------------------
// (b) An adversarial stream (20k events at a high line) replays in bounded time
//     without throwing — both the O(1) beyond-cap clamp path and the within-cap
//     grown-document path (the super-linear concern) stay well under budget.
// ---------------------------------------------------------------------------
test("DoS guard: 20k events at an absurd line replay fast, no throw (clamp path)", () => {
  const events = [];
  for (let i = 0; i < 20_000; i++) events.push(insAt("p1", i * 5, "x", 1_000_000, 1));
  const start = Date.now();
  let out;
  assert.doesNotThrow(() => {
    out = replaySession(events, {});
  });
  const elapsed = Date.now() - start;
  assert.equal(out.events_n, 20_000);
  // Beyond-cap references never grow the document.
  assert.ok(out.problems.p1.final_content.length < 50_000, "document did not balloon");
  assert.ok(elapsed < 5000, `replay took ${elapsed}ms (must be < 5000)`);
});

test("DoS guard: 20k edits on a grown (within-cap) document replay fast, no throw", () => {
  // Force the document to actually grow (sequential lines), then hammer 20k edits
  // at a high within-cap line so each resolve walks the grown content. This is the
  // super-linear path the fix bounds; line 3000 stays within the cap. (If the cap
  // is ever lowered below 3000 the edits simply clamp — still bounded.)
  const events = [];
  let t = 0;
  for (let line = 1; line <= 3000; line++) events.push(insAt("p1", t++ * 2, "y", line, 1));
  for (let i = 0; i < 20_000; i++) events.push(insAt("p1", t++ * 2, "z", 3000, 1));
  const start = Date.now();
  let out;
  assert.doesNotThrow(() => {
    out = replaySession(events, {});
  });
  const elapsed = Date.now() - start;
  assert.ok(out.events_n === 23_000);
  assert.ok(elapsed < 5000, `grown-doc replay took ${elapsed}ms (must be < 5000)`);
});

// ---------------------------------------------------------------------------
// (c) Normal small-gap growth (a ~29-line gap, like real streams whose max gap
//     is 28) STILL grows faithfully — the cap only clamps pathological refs.
// ---------------------------------------------------------------------------
test("faithful growth preserved: a ~29-line gap still reconstructs exactly", () => {
  const events = [
    insAt("p1", 1000, "line0", 1, 1), // doc is 1 line: "line0"
    insAt("p1", 1100, "X", 30, 1), // jump to line 30 (gap = 29 lines beyond content)
  ];
  const out = replaySession(events, {});
  // Faithful line model: grow to 30 lines (append 29 newlines), then insert "X"
  // at line 30, col 1 (the end). NOT clamped onto line 1.
  const expected = "line0" + "\n".repeat(29) + "X";
  assert.equal(out.problems.p1.final_content, expected);
  assert.equal((out.problems.p1.final_content.match(/\n/g) || []).length, 29);
  assert.equal(out.problems.p1.glitches, 0);

  // String path (applyChange) reconstructs the same grown document.
  let s = "";
  s = applyChange(s, { startLine: 1, startCol: 1, endLine: 1, endCol: 1, text: "line0", deletedLen: 0, insertedLen: 5 }).content;
  s = applyChange(s, { startLine: 30, startCol: 1, endLine: 30, endCol: 1, text: "X", deletedLen: 0, insertedLen: 1 }).content;
  assert.equal(s, expected);
});

// ---------------------------------------------------------------------------
// Equivalence: the exported string path (applyChange accumulation) and the
// buffer path (TextBuffer.apply via replaySession final_content) stay byte-for-
// byte equal — including across cap-clamped (beyond-cap) references. A compact
// seeded fuzz exercising growth, deletes, inverted ranges, and absurd lines.
// ---------------------------------------------------------------------------
test("equivalence: applyChange == TextBuffer.apply across growth, deletes, and cap clamps", () => {
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const texts = ["", "x", "foo", "a\nb", "\n", "hello world", "()", "line1\nline2\nline3"];
  let seeds = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const rng = mulberry32(seed);
    let str = "";
    const events = [];
    let ts = 0;
    for (let step = 0; step < 25; step++) {
      const lines = str.split("\n");
      // Mostly in/just-beyond content; ~12% absurd (beyond cap) to test clamping.
      let sl = rng() < 0.12 ? 1_000_000 + Math.floor(rng() * 9) : 1 + Math.floor(rng() * (lines.length + 3));
      const sc = 1 + Math.floor(rng() * 6);
      let el = sl + Math.floor(rng() * 3);
      if (rng() < 0.1) el = Math.max(1, sl - 1); // inverted
      const ec = 1 + Math.floor(rng() * 6);
      const text = texts[Math.floor(rng() * texts.length)];
      const deletedLen = Math.floor(rng() * 5);
      const detail = { startLine: sl, startCol: sc, endLine: el, endCol: ec, text, deletedLen, insertedLen: text.length };
      // String path
      str = applyChange(str, detail).content;
      // Buffer path event
      events.push(ev("editor_insert", "P", (ts += 10), detail));
    }
    const replay = replaySession(events, { stubs: [] });
    const buf = replay.problems.P ? replay.problems.P.final_content : "";
    assert.equal(buf, str, `seed ${seed}: buffer path != string path`);
    seeds++;
  }
  assert.equal(seeds, 200);
});
