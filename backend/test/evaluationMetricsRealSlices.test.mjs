// backend/test/evaluationMetricsRealSlices.test.mjs
//
// Spec EVAL-2 Layer A.4 — committed REAL-slice regression. Proves that genuine
// foreign-paste detection does NOT mis-flag legitimate self-pastes on the actual
// telemetry of a live exam session, and that the replay faithfully reconstructs
// the candidate's real code.
//
// These are the two cases the owner asked us to lock down (the live-test
// false-positive re-review, task #162): a candidate who duplicated their OWN already-typed SQL line
// (`occupations`) and who pasted their OWN already-typed Python (`challenge-8`).
// Both used to come out FOREIGN (a false positive); the fix makes them
// `foreign === false`. The fixture is the sanitized real event stream — session
// identifier stripped, only type/problem_id/timestamp/detail retained, no
// candidate name / roster id / session uuid (public repo). The SQL/Python is
// generic exam code, acceptable to commit.
//
// PURE unit test — no handler, no env, no GCP. Cross-checked against the
// regress.mjs ground-truth harness used during the build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { replaySession } from "../src/evaluationReplay.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(HERE, "fixtures", "foreignPasteRealSlices.json"), "utf8"));

// Ground-truth needles for `occupations` — the candidate's own pivot query. The
// load-bearing one is the Doctor line they typed and then re-pasted for the other
// occupations; all four CASE arms must survive the replay verbatim. (Identical to
// the build-time regress.mjs needle list.)
const OCC_NEEDLES = [
  "MAX(CASE WHEN Occupation = 'Doctor' THEN Name END) AS Doctor,",
  "Professor",
  "Singer",
  "Actor",
];

// Replay a per-problem slice exactly as buildScorecard would (no extra sources —
// the slice is self-contained, so a paste is only non-foreign when it is the
// candidate's own earlier content / on-buffer text).
function replaySlice(events) {
  return replaySession(events, { stubs: [] });
}

function pasteAt(replay, problemId, iso) {
  const ms = Date.parse(iso);
  return replay.pastes.find((p) => p.problem_id === problemId && p.ts === ms);
}

// ---------------------------------------------------------------------------
// Fixture hygiene — the committed real slice must never carry PII. Defends the
// public repo against a future regeneration accidentally re-introducing the
// session id or another top-level field.
// ---------------------------------------------------------------------------
test("real-slice fixture is sanitized (no session id, only whitelisted keys)", () => {
  const allow = ["detail", "problem_id", "timestamp", "type"];
  const allEvents = [...FIXTURE.occupations, ...FIXTURE.challenge8];
  assert.ok(allEvents.length > 2000, "fixture carries the full real per-problem streams");
  for (const ev of allEvents) {
    const keys = Object.keys(ev).sort();
    assert.deepEqual(keys, allow, `event has exactly the whitelisted keys, got ${keys.join(",")}`);
    assert.ok(!("session_id" in ev), "session_id stripped");
  }
  // No session uuid / candidate identity leaked anywhere in the WHOLE serialized
  // fixture (including the top-level `_comment` and `pastes` fields, not just the
  // event arrays) — a regeneration must never re-introduce PII anywhere in the file.
  const raw = JSON.stringify(FIXTURE);
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(raw), "no uuid anywhere in fixture");
  assert.ok(!/athish/i.test(raw), "no candidate name anywhere in fixture");
  assert.ok(!/essdee|REDACTED-ROSTER-ID/i.test(raw), "no contest slug / roster id anywhere in fixture");
});

// ---------------------------------------------------------------------------
// REAL CASE 1 — occupations: a self-duplicated SQL line is NOT foreign, and the
// real code reconstructs byte-faithfully with zero replay glitches.
// ---------------------------------------------------------------------------
test("REAL occupations slice: reconstructs ground truth, self-paste is foreign===false", () => {
  const replay = replaySlice(FIXTURE.occupations);
  const prob = replay.problems["occupations"];
  assert.ok(prob, "occupations replayed");

  // Faithful reconstruction.
  assert.equal(prob.glitches, 0, "occupations reconstruction is glitch-free");
  for (const needle of OCC_NEEDLES) {
    assert.ok(prob.final_content.includes(needle), `final_content contains ${JSON.stringify(needle)}`);
  }

  // The flagged paste (the candidate re-pasting their own Doctor line) is NOT foreign.
  const paste = pasteAt(replay, "occupations", FIXTURE.pastes.occupations);
  assert.ok(paste, "the recorded occupations paste is present in the replay");
  assert.equal(paste.foreign, false, "self-duplicated SQL line is NOT a foreign paste");

  // Whole-slice guard: no foreign paste anywhere in this honest session.
  assert.equal(replay.pastes.filter((p) => p.foreign).length, 0, "no foreign pastes in the occupations slice");
});

// ---------------------------------------------------------------------------
// REAL CASE 2 — challenge-8: the candidate pasting their OWN already-typed Python
// is NOT foreign. (This problem's reconstruction has glitches, but because the
// paste is correctly non-foreign it never enters the foreign-paste path at all.)
// ---------------------------------------------------------------------------
test("REAL challenge-8 slice: self-paste of own typed code is foreign===false", () => {
  const replay = replaySlice(FIXTURE.challenge8);
  const prob = replay.problems["challenge-8-aerele"];
  assert.ok(prob, "challenge-8 replayed");

  const paste = pasteAt(replay, "challenge-8-aerele", FIXTURE.pastes.challenge8);
  assert.ok(paste, "the recorded challenge-8 paste is present in the replay");
  assert.equal(paste.foreign, false, "self-paste of own typed Python is NOT foreign");

  assert.equal(replay.pastes.filter((p) => p.foreign).length, 0, "no foreign pastes in the challenge-8 slice");
});
