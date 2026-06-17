// frontend/src/results/computeResults.test.ts — S-J Results-tab pure helpers.
// The Results tab has no jsdom render harness, so the table's filter + CSV
// logic is extracted here and unit-tested directly (vision §2.14).
import { describe, it, expect } from "vitest";
import { filterResultRows, buildResultsCsv, countUnmatched, selectionCounts, canMarkSelectionDone, evalFlagsLabel, type ResultRow, type RowEvaluation } from "./computeResults";

function evaluation(over: Partial<RowEvaluation> = {}): RowEvaluation {
  return {
    talent_tier: "strong",
    integrity_tier: "clean",
    composite: 82,
    paste_ratio: 0.12,
    flags_by_severity: { critical: 0, warning: 1, info: 2 },
    confidence: "high",
    one_line: "Solved 2 medium with genuine arcs.",
    recommended_action: null,
    ...over
  };
}

function row(over: Partial<ResultRow> = {}): ResultRow {
  return {
    person_id: "kec~21cs001",
    rank: 1,
    candidate_id: "21CS001",
    name: "Asha",
    college_norm: "kec",
    college: "KEC",
    display_id: "21CS001",
    total: 130,
    per_problem: [{ problem_id: "p1", best_score: 80, max_points: 100, attempts: 2 }, { problem_id: "p2", best_score: 50, max_points: 100, attempts: 1 }],
    integrity: { alerts_by_severity: { critical: 0, warning: 0, info: 0 }, total_alerts: 0, has_critical: false, review_count: 0, review_cheating_count: 0, review_verdict: "none" },
    selection_status: "none",
    from_snapshot: false,
    room: "",
    evaluation: null,
    ...over
  };
}

const ROWS: ResultRow[] = [
  row({ person_id: "a", candidate_id: "21CS001", name: "Asha", college: "KEC", college_norm: "kec", total: 130, room: "Lab A", selection_status: "shortlisted", integrity: { alerts_by_severity: { critical: 1, warning: 0, info: 0 }, total_alerts: 1, has_critical: true, review_count: 0, review_cheating_count: 0, review_verdict: "none" } }),
  row({ person_id: "b", candidate_id: "21CS002", name: "Bala", college: "PSG", college_norm: "psg", total: 100, room: "Lab B", selection_status: "none" }),
  row({ person_id: "c", candidate_id: "21CS003", name: "Cara", college: "KEC", college_norm: "kec", total: 40, room: "Lab A", selection_status: "selected" })
];

describe("filterResultRows", () => {
  it("no filters → every row", () => {
    expect(filterResultRows(ROWS, {}).map((r) => r.person_id)).toEqual(["a", "b", "c"]);
  });

  it("college filter (by norm)", () => {
    expect(filterResultRows(ROWS, { college: "kec" }).map((r) => r.person_id)).toEqual(["a", "c"]);
  });

  it("room filter", () => {
    expect(filterResultRows(ROWS, { room: "Lab B" }).map((r) => r.person_id)).toEqual(["b"]);
  });

  it("minScore filter keeps rows at or above the threshold", () => {
    expect(filterResultRows(ROWS, { minScore: 100 }).map((r) => r.person_id)).toEqual(["a", "b"]);
  });

  it("noCritical filter drops candidates with any critical alert", () => {
    expect(filterResultRows(ROWS, { noCritical: true }).map((r) => r.person_id)).toEqual(["b", "c"]);
  });

  it("text search matches candidate id or name (case-insensitive)", () => {
    expect(filterResultRows(ROWS, { search: "bal" }).map((r) => r.person_id)).toEqual(["b"]);
    expect(filterResultRows(ROWS, { search: "21CS003" }).map((r) => r.person_id)).toEqual(["c"]);
  });

  it("selection filter", () => {
    expect(filterResultRows(ROWS, { selection: "selected" }).map((r) => r.person_id)).toEqual(["c"]);
  });

  it("filters compose (AND)", () => {
    expect(filterResultRows(ROWS, { college: "kec", minScore: 50 }).map((r) => r.person_id)).toEqual(["a"]);
  });
});

describe("selectionCounts", () => {
  it("tallies every selection bucket including none", () => {
    expect(selectionCounts(ROWS)).toEqual({ none: 1, shortlisted: 1, selected: 1, rejected: 0 });
  });
});

describe("canMarkSelectionDone", () => {
  it("true when at least one row is persisted Selected", () => {
    // ROWS has one 'selected' (c).
    expect(canMarkSelectionDone(ROWS)).toBe(true);
  });
  it("true when at least one row is persisted Rejected", () => {
    expect(canMarkSelectionDone([row({ selection_status: "rejected" })])).toBe(true);
  });
  it("false when no row has a final verdict (only none/shortlisted)", () => {
    expect(canMarkSelectionDone([
      row({ person_id: "x", selection_status: "none" }),
      row({ person_id: "y", selection_status: "shortlisted" })
    ])).toBe(false);
  });
  it("false for an empty result set", () => {
    expect(canMarkSelectionDone([])).toBe(false);
  });
});

describe("buildResultsCsv", () => {
  it("header + per-problem title columns + integrity + selection + eval; rows in order", () => {
    const csv = buildResultsCsv(ROWS, [{ problem_id: "p1", title: "Sum Two" }, { problem_id: "p2", title: "Reverse" }]);
    const lines = csv.split("\n");
    // P1: the 6 eval columns sit after selection_status, before the KPR-2026
    // trailing "unmatched" column — EXACT order/headers match the backend CSV.
    expect(lines[0]).toBe("rank,candidate_id,name,college,total,Sum Two,Reverse,critical_alerts,warning_alerts,info_alerts,review_verdict,selection_status,talent_tier,talent_composite,integrity_tier,paste_pct,eval_flags,eval_one_line,unmatched");
    // Row "a" has no evaluation → the 6 eval cells are blank.
    expect(lines[1]).toBe("1,21CS001,Asha,KEC,130,80,50,1,0,0,none,shortlisted,,,,,,,");
    expect(lines.length).toBe(4);
  });

  it("P1: populated evaluation columns — tier, composite, paste_pct (rounded %), 1C/2W/0I flags, one_line", () => {
    const rows = [row({
      candidate_id: "21CS010", name: "Eva", total: 90,
      evaluation: evaluation({
        talent_tier: "moderate", integrity_tier: "flag", composite: 47, paste_ratio: 0.638,
        flags_by_severity: { critical: 1, warning: 2, info: 0 }, one_line: "High paste ratio on the hard problem."
      })
    })];
    const csv = buildResultsCsv(rows, [{ problem_id: "p1", title: "Sum Two" }]);
    // ...,critical,warning,info,review_verdict,selection → 0,0,0,none,none;
    // then paste_ratio 0.638 → "64%" and flags → "1C/2W/0I".
    expect(csv.split("\n")[1]).toBe("1,21CS010,Eva,KEC,90,80,0,0,0,none,none,moderate,47,flag,64%,1C/2W/0I,High paste ratio on the hard problem.,");
  });

  it("P1: blank eval cells when evaluation is null", () => {
    const csv = buildResultsCsv([row()], [{ problem_id: "p1", title: "Sum Two" }]);
    // 6 consecutive blanks for talent_tier..eval_one_line, then the unmatched blank.
    expect(csv.split("\n")[1]).toBe("1,21CS001,Asha,KEC,130,80,0,0,0,none,none,,,,,,,");
  });

  it("KPR 2026-06-12: unmatched rows export with the yes flag (+ eval cells)", () => {
    const rows = [row({
      person_id: "", username_norm: "23cs091", candidate_id: "23CS091", name: "Kishore P S", college: "", total: 100, unmatched: true,
      evaluation: evaluation({ talent_tier: "weak", integrity_tier: "watch", composite: 12, paste_ratio: 0.05, flags_by_severity: { critical: 0, warning: 1, info: 0 }, one_line: "Thin signal." })
    })];
    const csv = buildResultsCsv(rows, [{ problem_id: "p1", title: "Sum Two" }]);
    expect(csv.split("\n")[1]).toBe("1,23CS091,Kishore P S,,100,80,0,0,0,none,none,weak,12,watch,5%,0C/1W/0I,Thin signal.,yes");
  });

  it("CSV-injection guard on candidate-supplied id/name", () => {
    const evil = [row({ candidate_id: "=cmd()", name: "a,b\nc" })];
    const csv = buildResultsCsv(evil, [{ problem_id: "p1", title: "P1" }]);
    expect(csv).toContain(",'=cmd(),");
    expect(csv).toContain(',"a,b\nc"');
  });
});

describe("evalFlagsLabel", () => {
  it("formats counts as the 1C/2W/0I compact string", () => {
    expect(evalFlagsLabel({ critical: 1, warning: 2, info: 0 })).toBe("1C/2W/0I");
    expect(evalFlagsLabel({ critical: 0, warning: 0, info: 0 })).toBe("0C/0W/0I");
  });
});

describe("evaluation threading + tier filters", () => {
  const evalRows: ResultRow[] = [
    row({ person_id: "strong-clean", evaluation: evaluation({ talent_tier: "strong", integrity_tier: "clean" }) }),
    row({ person_id: "moderate-watch", evaluation: evaluation({ talent_tier: "moderate", integrity_tier: "watch" }) }),
    row({ person_id: "weak-flag", evaluation: evaluation({ talent_tier: "weak", integrity_tier: "flag" }) }),
    row({ person_id: "confirmed", evaluation: evaluation({ talent_tier: "weak", integrity_tier: "confirmed" }) }),
    row({ person_id: "unevaluated", evaluation: null })
  ];

  it("threads the evaluation onto rows (null preserved)", () => {
    expect(evalRows[0].evaluation?.talent_tier).toBe("strong");
    expect(evalRows[4].evaluation).toBeNull();
  });

  it("evalTalent 'all' (or absent) is a no-op", () => {
    expect(filterResultRows(evalRows, {}).length).toBe(5);
    expect(filterResultRows(evalRows, { evalTalent: "all" }).length).toBe(5);
  });

  it("evalTalent filters to the matching tier and drops unevaluated rows", () => {
    expect(filterResultRows(evalRows, { evalTalent: "strong" }).map((r) => r.person_id)).toEqual(["strong-clean"]);
    expect(filterResultRows(evalRows, { evalTalent: "weak" }).map((r) => r.person_id)).toEqual(["weak-flag", "confirmed"]);
  });

  it("evalIntegrity filters to the matching tier and drops unevaluated rows", () => {
    expect(filterResultRows(evalRows, { evalIntegrity: "confirmed" }).map((r) => r.person_id)).toEqual(["confirmed"]);
    expect(filterResultRows(evalRows, { evalIntegrity: "clean" }).map((r) => r.person_id)).toEqual(["strong-clean"]);
  });

  it("tier filters compose with each other and with existing filters (AND)", () => {
    expect(filterResultRows(evalRows, { evalTalent: "weak", evalIntegrity: "confirmed" }).map((r) => r.person_id)).toEqual(["confirmed"]);
    expect(filterResultRows(evalRows, { evalTalent: "weak", evalIntegrity: "flag" }).map((r) => r.person_id)).toEqual(["weak-flag"]);
  });
});

// ---- KPR 2026-06-12: unmatched identities --------------------------------------

describe("countUnmatched", () => {
  it("counts only rows flagged unmatched", () => {
    const rows = [...ROWS, row({ person_id: "", username_norm: "23cs091", candidate_id: "23CS091", unmatched: true })];
    expect(countUnmatched(rows)).toBe(1);
    expect(countUnmatched(ROWS)).toBe(0);
  });
});

describe("filterResultRows with unmatched rows", () => {
  it("unmatched rows pass through filters like any other row (never silently hidden)", () => {
    const rows = [...ROWS, row({ person_id: "", username_norm: "23cs091", candidate_id: "23CS091", name: "Kishore P S", college_norm: "", college: "", total: 100, room: "", unmatched: true })];
    expect(filterResultRows(rows, {}).some((r) => r.unmatched)).toBe(true);
    expect(filterResultRows(rows, { minScore: 100 }).some((r) => r.unmatched)).toBe(true);
    expect(filterResultRows(rows, { search: "kishore" }).map((r) => r.candidate_id)).toEqual(["23CS091"]);
  });
});
