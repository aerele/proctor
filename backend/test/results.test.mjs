// backend/test/results.test.mjs — S-J §2.14 the Results-tab rollup, PURE half.
// Specs: docs/superpowers/specs/2026-06-10-f10-product-vision.md
//          §2.14 (Results tab: rank/per-problem/integrity column/selection),
//          §2.13 (multi-college projection rule), §2.9 (Enrollment selection +
//          final_snapshot), §3.3 (best-per-problem rollup + tie-break)
// The scoreboard rollup itself is covered by scoreboard.test.mjs; this file
// pins buildResultsRows — the JOIN of scoreboard rows × enrollments × persons ×
// integrity that the Results endpoint serves, plus the integrity summary and
// the CSV. PURE unit tests — no handler, no env, no GCP.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildResultsRows, summarizeIntegrity, buildResultsCsv } from "../src/scoreboard.mjs";

// ---- summarizeIntegrity --------------------------------------------------------

test("summarizeIntegrity: alerts grouped by severity, unknown severities ignored", () => {
  const summary = summarizeIntegrity({
    alerts: [
      { severity: "critical" }, { severity: "critical" },
      { severity: "warning" }, { severity: "info" },
      { severity: "bogus" }, {}
    ],
    reviews: []
  });
  assert.deepEqual(summary.alerts_by_severity, { critical: 2, warning: 1, info: 1 });
  assert.equal(summary.total_alerts, 4); // bogus + undefined dropped
  assert.equal(summary.has_critical, true);
});

test("summarizeIntegrity: review verdicts → flag + cheating count (verdict 1 = cheating)", () => {
  const summary = summarizeIntegrity({
    alerts: [],
    reviews: [{ verdict: 1, reviewer_name: "A" }, { verdict: 0, reviewer_name: "B" }, { verdict: 1, reviewer_name: "C" }]
  });
  assert.equal(summary.review_count, 3);
  assert.equal(summary.review_cheating_count, 2);
  assert.equal(summary.review_verdict, "flagged"); // any verdict==1 → flagged
});

test("summarizeIntegrity: all-clear reviews → cleared; no reviews → none", () => {
  assert.equal(summarizeIntegrity({ alerts: [], reviews: [{ verdict: 0 }] }).review_verdict, "cleared");
  assert.equal(summarizeIntegrity({ alerts: [], reviews: [] }).review_verdict, "none");
});

test("summarizeIntegrity: empty input → zeroed summary", () => {
  const summary = summarizeIntegrity({});
  assert.deepEqual(summary.alerts_by_severity, { critical: 0, warning: 0, info: 0 });
  assert.equal(summary.total_alerts, 0);
  assert.equal(summary.has_critical, false);
  assert.equal(summary.review_verdict, "none");
});

// ---- buildResultsRows ----------------------------------------------------------

const PROBLEM_ORDER = ["p1", "p2"];

function fixture() {
  const submissions = [
    // alice (kec~21cs001): p1 80, p2 50 → 130, rank 1
    { username_norm: "kec~21cs001", person_id: "kec~21cs001", candidate_id: "21CS001", problem_id: "p1", score: 40, max_points: 100, created_at: "2026-06-10T04:01:00.000Z" },
    { username_norm: "kec~21cs001", person_id: "kec~21cs001", candidate_id: "21CS001", problem_id: "p1", score: 80, max_points: 100, created_at: "2026-06-10T04:05:00.000Z" },
    { username_norm: "kec~21cs001", person_id: "kec~21cs001", candidate_id: "21CS001", problem_id: "p2", score: 50, max_points: 100, created_at: "2026-06-10T04:07:00.000Z" },
    // bob (psg~21cs001): p1 100 → 100, rank 2 (same roll, different college)
    { username_norm: "psg~21cs001", person_id: "psg~21cs001", candidate_id: "21CS001", problem_id: "p1", score: 100, max_points: 100, created_at: "2026-06-10T04:09:00.000Z" }
  ];
  const enrollments = [
    { person_id: "kec~21cs001", college_norm: "kec", status: "active", selection_status: "shortlisted", final_snapshot: null },
    { person_id: "psg~21cs001", college_norm: "psg", status: "active", selection_status: "none", final_snapshot: null },
    // carol enrolled but never submitted — still a row (absent candidate, 0 score)
    { person_id: "kec~21cs002", college_norm: "kec", status: "active", selection_status: "none", final_snapshot: null }
  ];
  const persons = new Map([
    ["kec~21cs001", { person_id: "kec~21cs001", unique_id: "21CS001", name: "Asha", college_norm: "kec" }],
    ["psg~21cs001", { person_id: "psg~21cs001", unique_id: "21CS001", name: "Bala", college_norm: "psg" }],
    ["kec~21cs002", { person_id: "kec~21cs002", unique_id: "21CS002", name: "Carol", college_norm: "kec" }]
  ]);
  const integrityByPerson = new Map([
    ["kec~21cs001", { alerts: [{ severity: "critical" }], reviews: [{ verdict: 1 }] }]
  ]);
  const collegeNames = new Map([["kec", "KEC"], ["psg", "PSG Tech"]]);
  return { submissions, enrollments, persons, integrityByPerson, collegeNames };
}

test("buildResultsRows: ranked join — score desc, enrolled-but-absent candidates included at 0", () => {
  const { submissions, enrollments, persons, integrityByPerson, collegeNames } = fixture();
  const rows = buildResultsRows({
    submissions, enrollments, persons, integrityByPerson, collegeNames,
    problemOrder: PROBLEM_ORDER, multiCollege: true
  });
  assert.deepEqual(rows.map((r) => r.person_id), ["kec~21cs001", "psg~21cs001", "kec~21cs002"]);
  assert.deepEqual(rows.map((r) => r.rank), [1, 2, 3]);
  assert.deepEqual(rows.map((r) => r.total), [130, 100, 0]);
  // carol (absent) is present with a 0 total and empty per-problem cells.
  const carol = rows[2];
  assert.equal(carol.total, 0);
  assert.equal(carol.name, "Carol");
  assert.equal(carol.selection_status, "none");
});

test("buildResultsRows: per-problem cells preserve contest problem order", () => {
  const { submissions, enrollments, persons, integrityByPerson, collegeNames } = fixture();
  const rows = buildResultsRows({ submissions, enrollments, persons, integrityByPerson, collegeNames, problemOrder: PROBLEM_ORDER, multiCollege: true });
  const asha = rows[0];
  assert.deepEqual(asha.per_problem.map((c) => c.problem_id), ["p1", "p2"]);
  assert.equal(asha.per_problem[0].best_score, 80);
  assert.equal(asha.per_problem[1].best_score, 50);
});

test("buildResultsRows: identity label gains the college ONLY when multi-college (vision §2.13)", () => {
  const fx = fixture();
  const multi = buildResultsRows({ ...fx, problemOrder: PROBLEM_ORDER, multiCollege: true });
  assert.equal(multi[0].display_id, "21CS001 · KEC");
  assert.equal(multi[1].display_id, "21CS001 · PSG Tech");
  const single = buildResultsRows({ ...fx, problemOrder: PROBLEM_ORDER, multiCollege: false });
  assert.equal(single[0].display_id, "21CS001");
});

test("buildResultsRows: integrity column folds alerts-by-severity + review verdict per candidate", () => {
  const fx = fixture();
  const rows = buildResultsRows({ ...fx, problemOrder: PROBLEM_ORDER, multiCollege: true });
  assert.deepEqual(rows[0].integrity.alerts_by_severity, { critical: 1, warning: 0, info: 0 });
  assert.equal(rows[0].integrity.has_critical, true);
  assert.equal(rows[0].integrity.review_verdict, "flagged");
  // candidates without integrity data get the zeroed summary, not undefined.
  assert.equal(rows[1].integrity.has_critical, false);
  assert.equal(rows[1].integrity.review_verdict, "none");
});

test("buildResultsRows: removed enrollments are excluded by default (attendance/results denominator = active)", () => {
  const fx = fixture();
  fx.enrollments = [...fx.enrollments, { person_id: "kec~21cs009", college_norm: "kec", status: "removed", selection_status: "none", final_snapshot: null }];
  fx.persons.set("kec~21cs009", { person_id: "kec~21cs009", unique_id: "21CS009", name: "Removed", college_norm: "kec" });
  const rows = buildResultsRows({ ...fx, problemOrder: PROBLEM_ORDER, multiCollege: true });
  assert.equal(rows.some((r) => r.person_id === "kec~21cs009"), false);
});

test("buildResultsRows: PURGED contest falls back to enrollment.final_snapshot (vision §2.9 purge-survivor)", () => {
  // No submissions/persons (purged); rows materialize from the snapshot.
  const enrollments = [{
    person_id: "kec~21cs001", college_norm: "kec", status: "active",
    selection_status: "selected",
    final_snapshot: {
      total_score: 130,
      per_problem: { p1: 80, p2: 50 },
      integrity: { alerts_by_severity: { critical: 1, warning: 0, info: 0 }, review_verdict: "flagged" },
      unique_id: "21CS001", name: "Asha"
    }
  }];
  const rows = buildResultsRows({
    submissions: [], enrollments, persons: new Map(), integrityByPerson: new Map(),
    collegeNames: new Map([["kec", "KEC"]]), problemOrder: PROBLEM_ORDER, multiCollege: false, purged: true
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].total, 130);
  assert.equal(rows[0].name, "Asha");
  assert.equal(rows[0].from_snapshot, true);
  assert.equal(rows[0].per_problem[0].best_score, 80);
  assert.equal(rows[0].integrity.review_verdict, "flagged");
});

// ---- buildResultsCsv -----------------------------------------------------------

test("buildResultsCsv: header + one row per candidate, per-problem columns, integrity + selection", () => {
  const fx = fixture();
  const rows = buildResultsRows({ ...fx, problemOrder: PROBLEM_ORDER, multiCollege: true });
  const csv = buildResultsCsv(rows, [{ problem_id: "p1", title: "Sum Two" }, { problem_id: "p2", title: "Reverse" }]);
  const lines = csv.split("\n");
  assert.equal(lines[0], "rank,candidate_id,name,college,total,Sum Two,Reverse,critical_alerts,warning_alerts,info_alerts,review_verdict,selection_status");
  assert.equal(lines.length, 4); // header + 3 candidates
  assert.match(lines[1], /^1,21CS001,Asha,KEC,130,80,50,1,0,0,flagged,shortlisted$/);
  assert.match(lines[3], /^3,21CS002,Carol,KEC,0,0,0,0,0,0,none,none$/);
});

test("buildResultsCsv: CSV-injection guard on candidate-supplied fields", () => {
  const rows = [{
    rank: 1, candidate_id: "=cmd()", name: ",evil\n", college: "KEC", total: 0,
    per_problem: [{ problem_id: "p1", best_score: 0 }],
    integrity: { alerts_by_severity: { critical: 0, warning: 0, info: 0 }, review_verdict: "none" },
    selection_status: "none"
  }];
  const csv = buildResultsCsv(rows, [{ problem_id: "p1", title: "P1" }]);
  // The injected name has a newline, so the row spans two physical lines —
  // split on the candidate_id cell instead of line boundaries.
  assert.match(csv, /,'=cmd\(\),/); // formula prefix neutralized on candidate_id
  assert.match(csv, /,",evil\n"/); // comma + newline name field quoted
});
