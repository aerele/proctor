// frontend/src/results/computeResults.ts — S-J Results-tab pure helpers
// (vision §2.14). The ranked table, its filters, and the CSV export are pure
// transforms over the backend rollup so they unit-test without a render
// harness. The ResultRow shape mirrors backend scoreboard.buildResultsRows.

export type SelectionStatus = "none" | "shortlisted" | "selected" | "rejected";

export type ResultIntegrity = {
  alerts_by_severity: { critical: number; warning: number; info: number };
  total_alerts: number;
  has_critical: boolean;
  review_count: number;
  review_cheating_count: number;
  review_verdict: "none" | "cleared" | "flagged";
};

export type ResultProblemCell = {
  problem_id: string;
  best_score: number;
  max_points: number;
  attempts: number;
};

export type ResultRow = {
  person_id: string;
  rank: number;
  candidate_id: string;
  name: string;
  college_norm: string;
  college: string;
  display_id: string;
  total: number;
  per_problem: ResultProblemCell[];
  integrity: ResultIntegrity;
  selection_status: SelectionStatus;
  from_snapshot: boolean;
  room: string;
  /** KPR 2026-06-12: a scoring identity NOT consumed by any enrollment (e.g.
   *  an anonymous post-roster-clear session). person_id is "" on these rows;
   *  scores come straight from submissions and the UI badges them loudly. */
  unmatched?: boolean;
  /** The scoreboard key of an unmatched row (forensics; absent on matched rows). */
  username_norm?: string;
};

export type ResultProblem = { problem_id: string; title: string; points?: number | null };

export type ContestResultsResponse =
  | { configured: false }
  | {
      configured: true;
      contest_slug: string;
      multi_college: boolean;
      selection_done_at: string | null;
      problems: ResultProblem[];
      rows: ResultRow[];
      /** KPR 2026-06-12: count of unmatched submitter rows (absent on older backends). */
      unmatched_count?: number;
      generated_at: string;
    };

// KPR 2026-06-12: the banner count — prefers the rows themselves so it works
// against older backends that don't send unmatched_count.
export function countUnmatched(rows: ResultRow[]): number {
  return rows.filter((row) => row.unmatched === true).length;
}

export type ResultFilters = {
  search?: string;
  college?: string; // college_norm
  room?: string;
  minScore?: number | null;
  noCritical?: boolean;
  selection?: SelectionStatus | "";
};

// AND-composed client-side filters over the ranked rows (the server already
// ranked + joined). Empty/absent fields are no-ops.
export function filterResultRows(rows: ResultRow[], filters: ResultFilters): ResultRow[] {
  const needle = (filters.search ?? "").trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.college && row.college_norm !== filters.college) return false;
    if (filters.room && row.room !== filters.room) return false;
    if (filters.minScore != null && row.total < filters.minScore) return false;
    if (filters.noCritical && row.integrity.has_critical) return false;
    if (filters.selection && row.selection_status !== filters.selection) return false;
    if (needle && !row.candidate_id.toLowerCase().includes(needle) && !row.name.toLowerCase().includes(needle)) return false;
    return true;
  });
}

// Per-bucket selection tally (drives the filter-chip counts + the "Mark
// selection done" summary). Always carries all four buckets.
export function selectionCounts(rows: ResultRow[]): Record<SelectionStatus, number> {
  const counts: Record<SelectionStatus, number> = { none: 0, shortlisted: 0, selected: 0, rejected: 0 };
  for (const row of rows) counts[row.selection_status] = (counts[row.selection_status] ?? 0) + 1;
  return counts;
}

// FIX-B3 #3: "Mark selection done" freezes each candidate's final-selection
// snapshot, so it only makes sense once a FINAL decision exists for at least one
// candidate. A final decision is a persisted "selected" OR "rejected" mark —
// "shortlisted" is a working state, not a final verdict, and "none" is unset.
// The disabled-button tooltip states exactly this precondition.
export function canMarkSelectionDone(rows: ResultRow[]): boolean {
  return rows.some((row) => row.selection_status === "selected" || row.selection_status === "rejected");
}

// Same column contract + injection guard as the backend buildResultsCsv (the
// frontend exports what it renders; the backend path exists for API callers).
export function buildResultsCsv(rows: ResultRow[], problems: ResultProblem[]): string {
  const header = [
    "rank", "candidate_id", "name", "college", "total",
    ...problems.map((p) => p.title || p.problem_id),
    "critical_alerts", "warning_alerts", "info_alerts", "review_verdict", "selection_status",
    // KPR 2026-06-12: flagged in the export too — a hiring decision must never
    // mistake an unverified typed id for a roster-verified one.
    "unmatched"
  ].map(csvField).join(",");
  const lines = rows.map((row) => {
    const cells: Array<string | number> = [
      row.rank, row.candidate_id, row.name, row.college, row.total,
      ...problems.map((p) => row.per_problem.find((c) => c.problem_id === p.problem_id)?.best_score ?? 0),
      row.integrity.alerts_by_severity.critical,
      row.integrity.alerts_by_severity.warning,
      row.integrity.alerts_by_severity.info,
      row.integrity.review_verdict,
      row.selection_status,
      row.unmatched ? "yes" : ""
    ];
    return cells.map((v) => csvField(String(v))).join(",");
  });
  return [header, ...lines].join("\n");
}

// RFC-4180-ish, same M8 formula-injection guard the rest of the app uses.
function csvField(value: string): string {
  let v = value;
  if (v && /^[=+\-@\t\r]/.test(v)) v = "'" + v;
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}
