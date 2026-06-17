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

// P1 candidate-evaluation: the per-row projection of a stored scorecard
// (scoreboard.projectEvaluation). `null` on rows the evaluator hasn't scored
// (unevaluated enrollments, or unmatched submitters without a scorecard) —
// behaviour-preserving against backends that don't send it.
export type RowEvaluation = {
  talent_tier: "strong" | "moderate" | "weak";
  integrity_tier: "clean" | "watch" | "flag" | "confirmed";
  composite: number; // 0–100 sortable talent composite
  paste_ratio: number; // 0–1 across scoring problems
  flags_by_severity: { critical: number; warning: number; info: number };
  confidence: "high" | "medium" | "low";
  one_line: string;
  recommended_action: string | null; // P1: always null (LLM queue is P2)
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
  /** P1 candidate-evaluation: the projected scorecard for this identity, or
   *  null when unevaluated (the evaluator runs only on the admin's button). */
  evaluation: RowEvaluation | null;
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

// P1: the talent/integrity-tier filter vocabularies. "all" is the no-op.
export type EvalTalentFilter = "all" | "strong" | "moderate" | "weak";
export type EvalIntegrityFilter = "all" | "clean" | "watch" | "flag" | "confirmed";

export type ResultFilters = {
  search?: string;
  college?: string; // college_norm
  room?: string;
  minScore?: number | null;
  noCritical?: boolean;
  selection?: SelectionStatus | "";
  // P1 candidate-evaluation tier filters. "all"/absent are no-ops; a non-"all"
  // value drops rows with no evaluation (an unevaluated row can't match a tier).
  evalTalent?: EvalTalentFilter;
  evalIntegrity?: EvalIntegrityFilter;
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
    // P1 tier filters: a non-"all" pick requires an evaluation that matches —
    // unevaluated rows (evaluation:null) can't satisfy a tier, so they drop.
    if (filters.evalTalent && filters.evalTalent !== "all" && row.evaluation?.talent_tier !== filters.evalTalent) return false;
    if (filters.evalIntegrity && filters.evalIntegrity !== "all" && row.evaluation?.integrity_tier !== filters.evalIntegrity) return false;
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
    // P1 candidate-evaluation: SAME 6 columns/order as backend buildResultsCsv,
    // inserted after selection_status and before unmatched. Blank when null.
    "talent_tier", "talent_composite", "integrity_tier", "paste_pct", "eval_flags", "eval_one_line",
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
      // P1 evaluation columns (blank cells when unevaluated). paste_pct is the
      // paste_ratio rounded to a whole percent; eval_flags is the "1C/2W/0I"
      // counts string — both EXACTLY matching the backend CSV formatting.
      row.evaluation?.talent_tier ?? "",
      row.evaluation ? row.evaluation.composite : "",
      row.evaluation?.integrity_tier ?? "",
      row.evaluation ? `${Math.round(row.evaluation.paste_ratio * 100)}%` : "",
      row.evaluation ? evalFlagsLabel(row.evaluation.flags_by_severity) : "",
      row.evaluation?.one_line ?? "",
      row.unmatched ? "yes" : ""
    ];
    return cells.map((v) => csvField(String(v))).join(",");
  });
  return [header, ...lines].join("\n");
}

// P1: the "1C/2W/0I" flag-counts label — the same compact form the backend
// CSV `eval_flags` column uses and the Eval-Integrity table cell renders.
export function evalFlagsLabel(flags: { critical: number; warning: number; info: number }): string {
  return `${flags.critical}C/${flags.warning}W/${flags.info}I`;
}

// RFC-4180-ish, same M8 formula-injection guard the rest of the app uses.
function csvField(value: string): string {
  let v = value;
  if (v && /^[=+\-@\t\r]/.test(v)) v = "'" + v;
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}
