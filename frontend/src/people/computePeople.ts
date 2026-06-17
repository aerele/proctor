// frontend/src/people/computePeople.ts — S-J People-tab pure helpers (vision
// §2.14). The directory filter, scorecard summary, and CSV export are pure
// transforms over the backend payload so they unit-test without a render
// harness. Shapes mirror the backend (people.mjs buildScorecardRows + the
// /api/admin/people directory rows).

export type SelectionStatus = "none" | "shortlisted" | "selected" | "rejected";

export type ScorecardIntegrity = {
  alerts_by_severity: { critical: number; warning: number; info: number };
  total_alerts: number;
  has_critical: boolean;
  review_verdict: "none" | "cleared" | "flagged";
};

export type ScorecardRow = {
  contest_slug: string;
  contest_name: string;
  contest_status: string;
  contest_purged: boolean;
  total: number;
  per_problem: Array<{ problem_id: string; best_score: number }> | null;
  integrity: ScorecardIntegrity;
  selection_status: SelectionStatus;
  source: string;
  from_snapshot: boolean;
  last_improvement_at: string | null;
  selection_done_at: string | null;
};

export type DirectoryPerson = {
  person_id: string;
  unique_id: string;
  name: string;
  college_norm: string;
  college: string;
  contest_count: number;
};

export type CollegeOption = { college_norm: string; name: string };

export type PeopleDirectoryResponse = {
  configured: boolean;
  people: DirectoryPerson[];
  colleges: CollegeOption[];
  total: number;
};

export type PersonScorecardResponse =
  | { configured: false }
  | {
      configured: true;
      person: { person_id: string; unique_id: string; name: string; college_norm: string; college: string; email: string };
      rows: ScorecardRow[];
      generated_at: string;
    };

export type DirectoryFilters = { search?: string; college?: string };

// AND-composed directory filter (mirrors the backend filterDirectory; the
// backend already filtered, this re-filters client-side for instant typeahead
// so the admin doesn't re-round-trip on every keystroke).
export function filterDirectoryRows(people: DirectoryPerson[], filters: DirectoryFilters): DirectoryPerson[] {
  const needle = (filters.search ?? "").trim().toLowerCase();
  const college = (filters.college ?? "").trim();
  return people.filter((person) => {
    if (college && person.college_norm !== college) return false;
    if (needle && !person.unique_id.toLowerCase().includes(needle) && !person.name.toLowerCase().includes(needle)) return false;
    return true;
  });
}

// The scorecard header stats (rounds attempted, best total, selection outcomes,
// flagged count) — drives the summary chips above the cross-round table.
export function scorecardSummary(rows: ScorecardRow[]) {
  const summary = {
    rounds: rows.length,
    best_total: 0,
    shortlisted: 0,
    selected: 0,
    rejected: 0,
    flagged: 0,
    purged: 0
  };
  for (const row of rows) {
    if (row.total > summary.best_total) summary.best_total = row.total;
    if (row.selection_status === "shortlisted") summary.shortlisted += 1;
    if (row.selection_status === "selected") summary.selected += 1;
    if (row.selection_status === "rejected") summary.rejected += 1;
    if (row.integrity.review_verdict === "flagged") summary.flagged += 1;
    if (row.contest_purged) summary.purged += 1;
  }
  return summary;
}

// A scorecard row's human status word (live / snapshot / purged) — the UI marks
// rows whose numbers come from a frozen final_snapshot (vision §10.2: kept
// scores are VISIBLE and clearly attributed to a purged/archived contest).
export function rowSourceLabel(row: ScorecardRow): "live" | "snapshot" | "purged" {
  if (!row.from_snapshot) return "live";
  return row.contest_purged ? "purged" : "snapshot";
}

// Per-person scorecard CSV (vision §2.14 exportable). One line per contest; the
// same formula-injection guard the Results CSV uses.
export function buildScorecardCsv(
  _person: { unique_id: string; name: string; college: string },
  rows: ScorecardRow[]
): string {
  const header = [
    "contest", "contest_name", "status", "total",
    "critical_alerts", "warning_alerts", "review_verdict", "selection_status"
  ].map(csvField).join(",");
  const lines = rows.map((row) => [
    row.contest_slug,
    row.contest_name,
    rowSourceLabel(row),
    row.total,
    row.integrity.alerts_by_severity.critical,
    row.integrity.alerts_by_severity.warning,
    row.integrity.review_verdict,
    row.selection_status
  ].map((value) => csvField(String(value))).join(","));
  return [header, ...lines].join("\n");
}

function csvField(value: string): string {
  let v = String(value ?? "");
  if (v && /^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}
