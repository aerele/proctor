// backend/test/peopleScorecard.test.mjs — S-J People tab: the PURE cross-round
// scorecard builder (vision §2.14 People tab + §2.9 purge-survivor live-vs-
// snapshot fallback + §10.2 "kept scores must be VISIBLE, marked as from a
// purged contest"). No Firestore here — the handler supplies already-fetched
// docs; this module joins them deterministically into one row per contest the
// person attempted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScorecardRows, filterDirectory, buildScorecardCsv } from "../src/people.mjs";

// One person, two contests. R1 is LIVE (submissions present). R2 is PURGED
// (no submissions, only enrollment.final_snapshot) — the row must materialize
// from the snapshot AND be flagged from_snapshot:true.
function fixture() {
  const personId = "kec~21cs001";
  const enrollments = [
    {
      contest_slug: "r1", person_id: personId, college_norm: "kec",
      status: "active", source: "csv",
      selection_status: "selected", final_snapshot: null
    },
    {
      contest_slug: "r2", person_id: personId, college_norm: "kec",
      status: "active", source: "carry_over",
      selection_status: "rejected",
      final_snapshot: {
        total_score: 70, per_problem: { p1: 70 },
        integrity: { alerts_by_severity: { critical: 1, warning: 0, info: 0 }, review_verdict: "flagged" },
        session_status: "ended"
      }
    }
  ];
  // R1 live scoreboard rows keyed by person_id (the handler computed these per
  // contest via the existing scoreboard module).
  const liveByContest = {
    r1: [{ username_norm: personId, person_id: personId, total: 130, last_improvement_at: "2026-06-10T04:07:00.000Z" }]
  };
  const liveIntegrityByContest = {
    r1: { [personId]: { alerts_by_severity: { critical: 0, warning: 1, info: 0 }, review_verdict: "cleared" } }
  };
  const contests = {
    r1: { slug: "r1", name: "KEC June 2026 — Round 1", status: "archived", selection_done_at: "2026-06-10T09:00:00.000Z", db_purged_at: null },
    r2: { slug: "r2", name: "KEC June 2026 — Round 2", status: "archived", selection_done_at: "2026-06-12T09:00:00.000Z", db_purged_at: "2026-06-20T00:00:00.000Z" }
  };
  return { personId, enrollments, liveByContest, liveIntegrityByContest, contests };
}

test("scorecard: one row per attempted contest, in chronological/selection-done order", () => {
  const { enrollments, liveByContest, liveIntegrityByContest, contests } = fixture();
  const rows = buildScorecardRows({ enrollments, liveByContest, liveIntegrityByContest, contests });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.contest_slug), ["r1", "r2"]);
  assert.deepEqual(rows.map((r) => r.contest_name), ["KEC June 2026 — Round 1", "KEC June 2026 — Round 2"]);
});

test("scorecard: LIVE contest reads live data (total + integrity from the live join, from_snapshot:false)", () => {
  const { enrollments, liveByContest, liveIntegrityByContest, contests } = fixture();
  const rows = buildScorecardRows({ enrollments, liveByContest, liveIntegrityByContest, contests });
  const r1 = rows.find((r) => r.contest_slug === "r1");
  assert.equal(r1.total, 130);
  assert.equal(r1.from_snapshot, false);
  assert.equal(r1.selection_status, "selected");
  assert.equal(r1.integrity.alerts_by_severity.warning, 1);
  assert.equal(r1.integrity.review_verdict, "cleared");
});

test("scorecard: PURGED contest falls back to enrollment.final_snapshot, flagged from_snapshot:true", () => {
  const { enrollments, liveByContest, liveIntegrityByContest, contests } = fixture();
  const rows = buildScorecardRows({ enrollments, liveByContest, liveIntegrityByContest, contests });
  const r2 = rows.find((r) => r.contest_slug === "r2");
  assert.equal(r2.total, 70);
  assert.equal(r2.from_snapshot, true);
  assert.equal(r2.selection_status, "rejected");
  assert.equal(r2.integrity.alerts_by_severity.critical, 1);
  assert.equal(r2.integrity.review_verdict, "flagged");
});

test("scorecard: a LIVE contest with no submissions yet still shows a 0 row (attempted via enrollment), not snapshot", () => {
  const enrollments = [
    { contest_slug: "r1", person_id: "kec~x", college_norm: "kec", status: "active", selection_status: "none", final_snapshot: null }
  ];
  const rows = buildScorecardRows({
    enrollments, liveByContest: { r1: [] }, liveIntegrityByContest: {},
    contests: { r1: { slug: "r1", name: "R1", status: "open", db_purged_at: null } }
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].total, 0);
  assert.equal(rows[0].from_snapshot, false);
});

test("scorecard: a removed enrollment is dropped (the person was un-rostered from that contest)", () => {
  const enrollments = [
    { contest_slug: "r1", person_id: "kec~x", college_norm: "kec", status: "removed", selection_status: "none", final_snapshot: null }
  ];
  const rows = buildScorecardRows({
    enrollments, liveByContest: {}, liveIntegrityByContest: {},
    contests: { r1: { slug: "r1", name: "R1", status: "open" } }
  });
  assert.deepEqual(rows, []);
});

test("scorecard: a PURGED contest with a NULL snapshot still appears (attempted), total 0, from_snapshot:true", () => {
  // Purge stamps snapshots, but a person who never scored has total 0 — the row
  // must not vanish (vision §10.2: never blank/missing rows for purged contests).
  const enrollments = [
    { contest_slug: "r2", person_id: "kec~x", college_norm: "kec", status: "active", selection_status: "none",
      final_snapshot: { total_score: 0, per_problem: {}, integrity: null, session_status: "ended" } }
  ];
  const rows = buildScorecardRows({
    enrollments, liveByContest: { r2: [] }, liveIntegrityByContest: {},
    contests: { r2: { slug: "r2", name: "R2", status: "archived", db_purged_at: "2026-06-20T00:00:00.000Z" } }
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].total, 0);
  assert.equal(rows[0].from_snapshot, true);
  assert.equal(rows[0].contest_purged, true);
});

// ---- directory filter (search by college / id / name) ----------------------

test("directory: filters by college_norm exactly", () => {
  const people = [
    { person_id: "kec~1", college_norm: "kec", unique_id: "21CS001", name: "Asha" },
    { person_id: "psg~2", college_norm: "psg", unique_id: "22IT002", name: "Bala" }
  ];
  assert.deepEqual(filterDirectory(people, { college: "kec" }).map((p) => p.person_id), ["kec~1"]);
});

test("directory: case-insensitive substring search over unique_id AND name", () => {
  const people = [
    { person_id: "kec~1", college_norm: "kec", unique_id: "21CS001", name: "Asha Ramanathan" },
    { person_id: "kec~2", college_norm: "kec", unique_id: "21CS002", name: "Bala Subramanian" }
  ];
  assert.deepEqual(filterDirectory(people, { search: "asha" }).map((p) => p.person_id), ["kec~1"]);
  assert.deepEqual(filterDirectory(people, { search: "21cs002" }).map((p) => p.person_id), ["kec~2"]);
  assert.deepEqual(filterDirectory(people, { search: "subraman" }).map((p) => p.person_id), ["kec~2"]);
});

test("directory: empty filters return everyone (capped by the caller, not here)", () => {
  const people = [{ person_id: "a", college_norm: "kec", unique_id: "1", name: "A" }];
  assert.deepEqual(filterDirectory(people, {}), people);
});

// ---- CSV export ------------------------------------------------------------

test("scorecard CSV: header + one line per contest row with formula-injection guard", () => {
  const { enrollments, liveByContest, liveIntegrityByContest, contests } = fixture();
  // A dangerous contest_name (formula injection) must be guarded in the export.
  contests.r1.name = "=cmd()";
  const rows = buildScorecardRows({ enrollments, liveByContest, liveIntegrityByContest, contests });
  const csv = buildScorecardCsv(
    { person_id: "kec~21cs001", unique_id: "21CS001", name: "Asha", college: "KEC" },
    rows
  );
  const lines = csv.split("\n");
  assert.match(lines[0], /^contest,contest_name,status,total,critical_alerts,warning_alerts,review_verdict,selection_status/);
  // the dangerous contest_name is quoted+apostrophe-guarded
  assert.ok(csv.includes("'=cmd()"));
  assert.equal(lines.length, 3); // header + 2 contests
  assert.ok(lines[1].includes("130"));
  assert.ok(lines[2].includes("purged") || lines[2].includes("Purged"));
});
