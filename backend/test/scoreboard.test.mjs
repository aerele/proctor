// backend/test/scoreboard.test.mjs — S-I §3.3: the pure scoring rollup.
// Per-problem best / contest totals / tie-break are COMPUTED at read time,
// never stored (vision §2.11) — this module is the single implementation the
// S-J Results endpoint (and the future enrollment.final_snapshot stamp) calls.
// PURE unit tests — no handler, no env, no GCP.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeScoreboard, computeSessionSummary } from "../src/scoreboard.mjs";

// Minimal submission doc shape (S-I §3.3 denorm contract).
function sub(over = {}) {
  return {
    session_id: "s1",
    contest_slug: "kec",
    username_norm: "alice",
    person_id: null,
    candidate_id: null,
    problem_id: "p1",
    score: 0,
    max_points: 100,
    verdict: "wrong_answer",
    created_at: "2026-06-10T04:00:00.000Z",
    ...over
  };
}
const at = (minute) => `2026-06-10T04:${String(minute).padStart(2, "0")}:00.000Z`;

// ---- computeSessionSummary ------------------------------------------------------

test("computeSessionSummary: per-problem best/attempts/verdicts/last_submitted_at; unsorted input ok", () => {
  const summary = computeSessionSummary([
    sub({ problem_id: "p1", score: 40, verdict: "wrong_answer", created_at: at(10) }),
    sub({ problem_id: "p2", score: 100, verdict: "accepted", created_at: at(12) }),
    // p1 improves later, then regresses — best sticks, last reflects the latest.
    sub({ problem_id: "p1", score: 80, verdict: "wrong_answer", created_at: at(20) }),
    sub({ problem_id: "p1", score: 0, verdict: "error", created_at: at(30) })
  ].reverse()); // deliberately unsorted

  assert.deepEqual(summary.p1, {
    best_score: 80, max_points: 100, attempts: 3,
    best_verdict: "wrong_answer", last_verdict: "error",
    last_submitted_at: at(30)
  });
  assert.equal(summary.p2.best_score, 100);
  assert.equal(summary.p2.attempts, 1);
  assert.equal(summary.p2.best_verdict, "accepted");
});

test("computeSessionSummary: a single zero-score submission still surfaces (attempted, 0 best)", () => {
  const summary = computeSessionSummary([sub({ score: 0, verdict: "wrong_answer" })]);
  assert.equal(summary.p1.best_score, 0);
  assert.equal(summary.p1.best_verdict, "wrong_answer");
  assert.equal(summary.p1.attempts, 1);
});

test("computeSessionSummary: empty input -> {}", () => {
  assert.deepEqual(computeSessionSummary([]), {});
  assert.deepEqual(computeSessionSummary(undefined), {});
});

// ---- computeScoreboard ------------------------------------------------------------

test("computeScoreboard: best per problem, totals, attempts; rows keyed by candidate", () => {
  const rows = computeScoreboard([
    sub({ username_norm: "alice", problem_id: "p1", score: 40, created_at: at(1) }),
    sub({ username_norm: "alice", problem_id: "p1", score: 80, created_at: at(5) }),
    sub({ username_norm: "alice", problem_id: "p2", score: 50, created_at: at(7), max_points: 50 }),
    sub({ username_norm: "bob", problem_id: "p1", score: 100, created_at: at(9), person_id: "per_1" })
  ], ["p1", "p2"]);

  assert.deepEqual(rows.map((r) => r.username_norm), ["alice", "bob"]);
  const alice = rows[0];
  assert.equal(alice.total, 130);
  assert.equal(alice.per_problem.p1.best_score, 80);
  assert.equal(alice.per_problem.p1.attempts, 2);
  assert.equal(alice.per_problem.p2.best_score, 50);
  assert.equal(alice.per_problem.p2.max_points, 50);
  assert.equal(alice.rank, 1);
  const bob = rows[1];
  assert.equal(bob.total, 100);
  assert.equal(bob.rank, 2);
  assert.equal(bob.person_id, "per_1"); // identity denorm carried onto the row
});

test("computeScoreboard tie-break GOLDEN: equal totals -> earlier last_improvement_at wins", () => {
  const rows = computeScoreboard([
    // alice: 100 at minute 5, then a non-improving re-submit at minute 50 —
    // re-submits that do NOT raise the running total must not move the stamp.
    sub({ username_norm: "alice", problem_id: "p1", score: 100, created_at: at(5) }),
    sub({ username_norm: "alice", problem_id: "p1", score: 100, created_at: at(50) }),
    sub({ username_norm: "alice", problem_id: "p1", score: 40, created_at: at(55) }),
    // bob reaches the same 100 total later (60 at min 2, +40 at min 10).
    sub({ username_norm: "bob", problem_id: "p1", score: 60, created_at: at(2) }),
    sub({ username_norm: "bob", problem_id: "p1", score: 100, created_at: at(10) })
  ], ["p1"]);

  assert.equal(rows[0].username_norm, "alice");
  assert.equal(rows[0].last_improvement_at, at(5));
  assert.equal(rows[1].username_norm, "bob");
  assert.equal(rows[1].last_improvement_at, at(10));
  assert.deepEqual(rows.map((r) => r.rank), [1, 2]);
});

test("computeScoreboard tie-break: improvement = STRICT running-total increase across problems", () => {
  const rows = computeScoreboard([
    // carol: p1 60 (min 1), p2 40 (min 8) -> total 100, last improvement min 8.
    sub({ username_norm: "carol", problem_id: "p1", score: 60, created_at: at(1) }),
    sub({ username_norm: "carol", problem_id: "p2", score: 40, created_at: at(8) }),
    // dave: p1 100 in one shot at minute 4 -> total 100, last improvement min 4.
    sub({ username_norm: "dave", problem_id: "p1", score: 100, created_at: at(4) })
  ], ["p1", "p2"]);
  assert.deepEqual(rows.map((r) => r.username_norm), ["dave", "carol"]);
});

test("computeScoreboard: zero-scorers rank after all scorers; deterministic username_norm final key", () => {
  const rows = computeScoreboard([
    sub({ username_norm: "zed", problem_id: "p1", score: 0, created_at: at(1) }),
    sub({ username_norm: "amy", problem_id: "p1", score: 0, created_at: at(2) }),
    sub({ username_norm: "win", problem_id: "p1", score: 10, created_at: at(3) })
  ], ["p1"]);
  assert.deepEqual(rows.map((r) => r.username_norm), ["win", "amy", "zed"]);
  assert.equal(rows[1].last_improvement_at, null); // never improved past 0
  assert.deepEqual(rows.map((r) => r.rank), [1, 2, 3]);
});

test("computeScoreboard: problemOrder scopes the rollup — submissions for removed problems do not count", () => {
  const rows = computeScoreboard([
    sub({ username_norm: "alice", problem_id: "p1", score: 30, created_at: at(1) }),
    sub({ username_norm: "alice", problem_id: "ghost", score: 100, created_at: at(2) })
  ], ["p1"]);
  assert.equal(rows[0].total, 30);
  assert.equal(rows[0].per_problem.ghost, undefined);
});

test("computeScoreboard: empty input -> []", () => {
  assert.deepEqual(computeScoreboard([], ["p1"]), []);
});
