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
import { buildResultsRows, summarizeIntegrity, buildResultsCsv, projectEvaluation } from "../src/scoreboard.mjs";

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
  // KPR 2026-06-12: trailing "unmatched" column flags identity-unmatched rows.
  // P1 (E): 6 candidate-evaluation columns sit after selection_status, before
  // unmatched; blank here (this fixture has no evaluations attached).
  assert.equal(lines[0], "rank,candidate_id,name,college,total,Sum Two,Reverse,critical_alerts,warning_alerts,info_alerts,review_verdict,selection_status,talent_tier,talent_composite,integrity_tier,paste_pct,eval_flags,eval_one_line,unmatched");
  assert.equal(lines.length, 4); // header + 3 candidates
  assert.match(lines[1], /^1,21CS001,Asha,KEC,130,80,50,1,0,0,flagged,shortlisted,,,,,,,$/);
  assert.match(lines[3], /^3,21CS002,Carol,KEC,0,0,0,0,0,0,none,none,,,,,,,$/);
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

// ---- KPR 2026-06-12: unmatched identities (loud-or-right) -----------------------

// The incident shape: a roster clear mid-contest flips later joins to
// anonymous keying (username_norm = bare typed id, person_id null). Those
// scoreboard identities never match an enrollment person_id and were silently
// dropped — 54 real scorers shown as 0. They must ride as FLAGGED rows.
test("buildResultsRows: scoreboard identities with no enrollment ride as flagged unmatched rows (never dropped)", () => {
  const fx = fixture();
  fx.submissions = [
    ...fx.submissions,
    { username_norm: "23cs091", person_id: null, candidate_id: "23CS091", problem_id: "p1", score: 100, max_points: 100, created_at: "2026-06-10T04:30:00.000Z" },
    { username_norm: "23cs091", person_id: null, candidate_id: "23CS091", problem_id: "p2", score: 50, max_points: 100, created_at: "2026-06-10T04:40:00.000Z" }
  ];
  const sessions = [
    { username_norm: "23cs091", candidate_id: "23CS091", name: "Kishore P S", created_at: "2026-06-10T04:20:00.000Z" }
  ];
  const rows = buildResultsRows({ ...fx, problemOrder: PROBLEM_ORDER, multiCollege: true, sessions });

  const unmatchedRow = rows.find((r) => r.unmatched);
  assert.ok(unmatchedRow, "unmatched submitter must appear as a row");
  assert.equal(unmatchedRow.candidate_id, "23CS091"); // typed display id from the submission denorm
  assert.equal(unmatchedRow.name, "Kishore P S");     // name typed at login (session doc)
  assert.equal(unmatchedRow.total, 150);              // best-per-problem, exactly like matched rows
  assert.deepEqual(unmatchedRow.per_problem.map((c) => [c.problem_id, c.best_score]), [["p1", 100], ["p2", 50]]);
  assert.equal(unmatchedRow.person_id, "");           // no enrollment/person behind it
  assert.equal(unmatchedRow.username_norm, "23cs091"); // forensic key preserved
  assert.equal(unmatchedRow.selection_status, "none");
  // Ranks fuse: 150 outranks Asha's 130 — the table tells the truth.
  assert.equal(unmatchedRow.rank, 1);
  // Matched rows are still all present, in their relative order.
  assert.deepEqual(rows.filter((r) => !r.unmatched).map((r) => r.person_id), ["kec~21cs001", "psg~21cs001", "kec~21cs002"]);
  // CSV flags the row in the trailing "unmatched" column (6 blank eval columns
  // precede it — this row has no evaluation attached).
  const csv = buildResultsCsv(rows, [{ problem_id: "p1", title: "Sum Two" }, { problem_id: "p2", title: "Reverse" }]);
  assert.match(csv, /^1,23CS091,Kishore P S,,150,100,50,0,0,0,none,none,,,,,,,yes$/m);
});

test("buildResultsRows: happy path (every submitter enrolled) appends NO unmatched rows", () => {
  const fx = fixture();
  const rows = buildResultsRows({ ...fx, problemOrder: PROBLEM_ORDER, multiCollege: true });
  assert.equal(rows.some((r) => r.unmatched), false);
  assert.equal(rows.length, 3);
});

test("buildResultsRows: PURGED contest (no submissions) appends no unmatched rows", () => {
  const enrollments = [{
    person_id: "kec~21cs001", college_norm: "kec", status: "active", selection_status: "selected",
    final_snapshot: { total_score: 130, per_problem: { p1: 80, p2: 50 }, integrity: null, unique_id: "21CS001", name: "Asha" }
  }];
  const rows = buildResultsRows({
    submissions: [], enrollments, persons: new Map(), integrityByPerson: new Map(),
    collegeNames: new Map(), problemOrder: PROBLEM_ORDER, multiCollege: false, purged: true
  });
  assert.equal(rows.length, 1);
  assert.equal(rows.some((r) => r.unmatched), false);
});

// ---- P1 candidate-evaluation join (E) ------------------------------------------
// The compact row projection of a stored scorecard, the identity-keyed join onto
// Results rows (person_id for enrolled, username_norm for unmatched — MIXED
// keying is the acceptance case), the null-when-unevaluated default, the 6 new
// CSV columns, and the purged-path snapshot evaluation survival.

// A full scorecard (subset of the schema relevant to projectEvaluation).
function scorecard(over = {}) {
  return {
    schema_version: 1, evaluator_version: "1",
    talent: { composite: 72 },
    integrity: { paste_ratio: 0.37 },
    coverage: { confidence: "high" },
    flags: [
      { code: "x", severity: "critical" }, { code: "y", severity: "critical" },
      { code: "z", severity: "warning" }, { code: "w", severity: "bogus" }
    ],
    tiers: { talent: "strong", integrity: "watch", one_line: "Strong solver; one warning." },
    recommended_action: null,
    ...over
  };
}

test("projectEvaluation: projects scorecard → compact row shape; flags counted by severity", () => {
  const ev = projectEvaluation(scorecard());
  assert.equal(ev.talent_tier, "strong");
  assert.equal(ev.integrity_tier, "watch");
  assert.equal(ev.composite, 72);
  assert.equal(ev.paste_ratio, 0.37);
  assert.deepEqual(ev.flags_by_severity, { critical: 2, warning: 1, info: 0 }); // bogus dropped
  assert.equal(ev.confidence, "high");
  assert.equal(ev.one_line, "Strong solver; one warning.");
  assert.equal(ev.recommended_action, null); // P1 keeps recommended_action null
});

test("projectEvaluation: null-safe — missing/invalid scorecard → null; partial → zeroed flags + null fields", () => {
  assert.equal(projectEvaluation(null), null);
  assert.equal(projectEvaluation(undefined), null);
  assert.equal(projectEvaluation("nope"), null);
  assert.equal(projectEvaluation(42), null);
  const partial = projectEvaluation({}); // empty object is a valid (if blank) scorecard
  assert.deepEqual(partial.flags_by_severity, { critical: 0, warning: 0, info: 0 });
  assert.equal(partial.talent_tier, null);
  assert.equal(partial.integrity_tier, null);
  assert.equal(partial.composite, null);
  assert.equal(partial.paste_ratio, null);
  assert.equal(partial.confidence, null);
  assert.equal(partial.one_line, null);
});

test("buildResultsRows: MIXED keying — enrolled row joins by person_id, unmatched by username_norm", () => {
  const fx = fixture();
  // Add an anonymous post-clear submitter (unmatched) so we exercise BOTH keys.
  fx.submissions = [
    ...fx.submissions,
    { username_norm: "23cs091", person_id: null, candidate_id: "23CS091", problem_id: "p1", score: 100, max_points: 100, created_at: "2026-06-10T04:30:00.000Z" }
  ];
  const sessions = [{ username_norm: "23cs091", candidate_id: "23CS091", name: "Kishore", created_at: "2026-06-10T04:20:00.000Z" }];
  const evaluations = new Map([
    // enrolled person → keyed by person_id
    ["kec~21cs001", scorecard({ talent: { composite: 88 }, tiers: { talent: "strong", integrity: "clean", one_line: "Genuine." } })],
    // unmatched anonymous → keyed by username_norm
    ["23cs091", scorecard({ talent: { composite: 12 }, integrity: { paste_ratio: 0.91 }, tiers: { talent: "weak", integrity: "flag", one_line: "Full paste." },
      flags: [{ severity: "critical" }] })]
  ]);
  const rows = buildResultsRows({ ...fx, problemOrder: PROBLEM_ORDER, multiCollege: true, sessions, evaluations });

  const asha = rows.find((r) => r.person_id === "kec~21cs001");
  assert.ok(asha.evaluation, "enrolled row joined its scorecard by person_id");
  assert.equal(asha.evaluation.composite, 88);
  assert.equal(asha.evaluation.talent_tier, "strong");

  const anon = rows.find((r) => r.unmatched);
  assert.ok(anon.evaluation, "unmatched row joined its scorecard by username_norm");
  assert.equal(anon.evaluation.composite, 12);
  assert.equal(anon.evaluation.integrity_tier, "flag");
  assert.deepEqual(anon.evaluation.flags_by_severity, { critical: 1, warning: 0, info: 0 });
});

test("buildResultsRows: un-evaluated rows (no scorecard in the map) carry evaluation:null", () => {
  const fx = fixture();
  const evaluations = new Map([["kec~21cs001", scorecard()]]); // only Asha evaluated
  const rows = buildResultsRows({ ...fx, problemOrder: PROBLEM_ORDER, multiCollege: true, evaluations });
  assert.ok(rows.find((r) => r.person_id === "kec~21cs001").evaluation);
  assert.equal(rows.find((r) => r.person_id === "psg~21cs001").evaluation, null);
  assert.equal(rows.find((r) => r.person_id === "kec~21cs002").evaluation, null);
});

test("buildResultsRows: empty evaluations map is behavior-preserving (every row evaluation:null)", () => {
  const fx = fixture();
  const rows = buildResultsRows({ ...fx, problemOrder: PROBLEM_ORDER, multiCollege: true });
  assert.equal(rows.every((r) => r.evaluation === null), true);
});

test("buildResultsCsv: 6 evaluation columns populated when present, blank when null; header order", () => {
  const fx = fixture();
  const evaluations = new Map([
    ["kec~21cs001", scorecard({ talent: { composite: 88 }, integrity: { paste_ratio: 0.37 },
      tiers: { talent: "strong", integrity: "watch", one_line: "Strong, one warning." },
      flags: [{ severity: "critical" }, { severity: "critical" }, { severity: "warning" }] })]
  ]);
  const rows = buildResultsRows({ ...fx, problemOrder: PROBLEM_ORDER, multiCollege: true, evaluations });
  const csv = buildResultsCsv(rows, [{ problem_id: "p1", title: "Sum Two" }, { problem_id: "p2", title: "Reverse" }]);
  const lines = csv.split("\n");
  assert.equal(lines[0], "rank,candidate_id,name,college,total,Sum Two,Reverse,critical_alerts,warning_alerts,info_alerts,review_verdict,selection_status,talent_tier,talent_composite,integrity_tier,paste_pct,eval_flags,eval_one_line,unmatched");
  // Asha (evaluated): tier, composite, integrity tier, paste_pct rounded "37", flags "2C/1W/0I", one_line.
  assert.match(lines[1], /^1,21CS001,Asha,KEC,130,80,50,1,0,0,flagged,shortlisted,strong,88,watch,37,2C\/1W\/0I,"Strong, one warning\.",$/);
  // Bala (un-evaluated): the 6 eval columns are blank. CSV carries candidate_id
  // (= unique_id "21CS001"), name, college — NOT the display_id suffix.
  assert.match(lines[2], /^2,21CS001,Bala,PSG Tech,100,100,0,0,0,0,none,none,,,,,,,$/);
});

test("buildResultsRows: PURGED path resurfaces a snapshot-stored evaluation (normalized) when present", () => {
  const enrollments = [{
    person_id: "kec~21cs001", college_norm: "kec", status: "active", selection_status: "selected",
    final_snapshot: {
      total_score: 130, per_problem: { p1: 80, p2: 50 },
      integrity: { alerts_by_severity: { critical: 1, warning: 0, info: 0 }, review_verdict: "flagged" },
      // the compact stored evaluation shape (handler stamps this at selection-done)
      evaluation: { talent_tier: "strong", integrity_tier: "watch", composite: 71,
        flags_by_severity: { critical: 1, warning: 2, info: 0 }, one_line: "Frozen.", recommended_action: null },
      unique_id: "21CS001", name: "Asha"
    }
  }];
  const rows = buildResultsRows({
    submissions: [], enrollments, persons: new Map(), integrityByPerson: new Map(),
    collegeNames: new Map([["kec", "KEC"]]), problemOrder: PROBLEM_ORDER, multiCollege: false, purged: true
  });
  assert.equal(rows[0].from_snapshot, true);
  assert.ok(rows[0].evaluation, "snapshot evaluation survives the purge");
  assert.equal(rows[0].evaluation.talent_tier, "strong");
  assert.equal(rows[0].evaluation.composite, 71);
  assert.deepEqual(rows[0].evaluation.flags_by_severity, { critical: 1, warning: 2, info: 0 });
  assert.equal(rows[0].evaluation.one_line, "Frozen.");
});

test("buildResultsRows: PURGED path with no snapshot evaluation → evaluation:null", () => {
  const enrollments = [{
    person_id: "kec~21cs001", college_norm: "kec", status: "active", selection_status: "selected",
    final_snapshot: { total_score: 130, per_problem: { p1: 80, p2: 50 }, integrity: null, unique_id: "21CS001", name: "Asha" }
  }];
  const rows = buildResultsRows({
    submissions: [], enrollments, persons: new Map(), integrityByPerson: new Map(),
    collegeNames: new Map([["kec", "KEC"]]), problemOrder: PROBLEM_ORDER, multiCollege: false, purged: true
  });
  assert.equal(rows[0].from_snapshot, true);
  assert.equal(rows[0].evaluation, null);
});
