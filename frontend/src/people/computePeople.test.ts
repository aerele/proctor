// frontend/src/people/computePeople.test.ts — S-J People-tab PURE helpers
// (vision §2.14 People tab). The directory filter, the scorecard CSV, and the
// scorecard summary stats are pure transforms over the backend payload so they
// unit-test without a render harness.
import { describe, expect, it } from "vitest";
import {
  filterDirectoryRows, buildScorecardCsv, scorecardSummary,
  type DirectoryPerson, type ScorecardRow
} from "./computePeople";

const PEOPLE: DirectoryPerson[] = [
  { person_id: "kec~21cs001", unique_id: "21CS001", name: "Asha Ramanathan", college_norm: "kec", college: "KEC", contest_count: 2 },
  { person_id: "psg~22it004", unique_id: "22IT004", name: "Bala Subramanian", college_norm: "psg", college: "PSG Tech", contest_count: 1 },
  { person_id: "kec~21cs033", unique_id: "21CS033", name: "Chitra Nair", college_norm: "kec", college: "KEC", contest_count: 1 }
];

describe("filterDirectoryRows", () => {
  it("filters by college_norm exactly", () => {
    expect(filterDirectoryRows(PEOPLE, { college: "psg" }).map((p) => p.person_id)).toEqual(["psg~22it004"]);
  });
  it("case-insensitive substring over unique_id AND name", () => {
    expect(filterDirectoryRows(PEOPLE, { search: "asha" }).map((p) => p.person_id)).toEqual(["kec~21cs001"]);
    expect(filterDirectoryRows(PEOPLE, { search: "22it004" }).map((p) => p.person_id)).toEqual(["psg~22it004"]);
    expect(filterDirectoryRows(PEOPLE, { search: "nair" }).map((p) => p.person_id)).toEqual(["kec~21cs033"]);
  });
  it("AND-composes college + search", () => {
    expect(filterDirectoryRows(PEOPLE, { college: "kec", search: "21cs0" }).map((p) => p.person_id))
      .toEqual(["kec~21cs001", "kec~21cs033"]);
  });
  it("empty filters return everyone", () => {
    expect(filterDirectoryRows(PEOPLE, {})).toEqual(PEOPLE);
  });
});

const ROWS: ScorecardRow[] = [
  {
    contest_slug: "r1", contest_name: "KEC Round 1", contest_status: "archived", contest_purged: false,
    total: 130, per_problem: null,
    integrity: { alerts_by_severity: { critical: 0, warning: 1, info: 0 }, total_alerts: 1, has_critical: false, review_verdict: "cleared" },
    selection_status: "selected", source: "csv", from_snapshot: false, last_improvement_at: null, selection_done_at: "2026-06-10T09:00:00.000Z"
  },
  {
    contest_slug: "r2", contest_name: "KEC Round 2", contest_status: "archived", contest_purged: true,
    total: 70, per_problem: null,
    integrity: { alerts_by_severity: { critical: 1, warning: 0, info: 0 }, total_alerts: 1, has_critical: true, review_verdict: "flagged" },
    selection_status: "rejected", source: "carry_over", from_snapshot: true, last_improvement_at: null, selection_done_at: "2026-06-12T09:00:00.000Z"
  }
];

describe("scorecardSummary", () => {
  it("counts rounds, best/total scores, and selection outcomes", () => {
    const s = scorecardSummary(ROWS);
    expect(s.rounds).toBe(2);
    expect(s.best_total).toBe(130);
    expect(s.selected).toBe(1);
    expect(s.rejected).toBe(1);
    expect(s.flagged).toBe(1); // r2 review_verdict flagged
  });
});

describe("buildScorecardCsv", () => {
  it("header + one line per contest row, formula-injection guarded", () => {
    const dangerous: ScorecardRow[] = [{ ...ROWS[0], contest_name: "=cmd()" }, ROWS[1]];
    const csv = buildScorecardCsv({ unique_id: "21CS001", name: "Asha", college: "KEC" }, dangerous);
    const lines = csv.split("\n");
    expect(lines[0]).toMatch(/^contest,contest_name,status,total,critical_alerts,warning_alerts,review_verdict,selection_status/);
    expect(csv).toContain("'=cmd()");        // guarded
    expect(lines).toHaveLength(3);            // header + 2 rows
    expect(lines[1]).toContain("130");
    expect(lines[2]).toContain("purged");     // r2 from a purged contest
  });
});
