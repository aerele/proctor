// backend/src/scoreboard.mjs
// S-I §3.3: the pure scoring rollup. Identity/problem/effective-points facts
// are DENORMED onto each submission at write time; per-problem best, contest
// total, rank and the tie-break are COMPUTED here at read time — never stored
// on person/enrollment/session (vision §2.11 "computed, never stored"; the
// only ever-stored copy is enrollment.final_snapshot at selection-done, which
// is S-J/S-G and calls this same module).
//
// S-J contract: Results endpoint = scopedQuery over proctor_submissions →
// computeScoreboard(submissions, contestProblemEntries(contest) ids) → columns
// in entry order. S-I ships the module + denorm so S-J is a thin wrapper.

// Rows keyed by candidate (username_norm, carrying person_id/candidate_id).
// Tie-break (exact algorithm, spec §3.3): per candidate, walk submissions in
// created_at order maintaining per-problem best-so-far and the running total;
// every submission that STRICTLY increases the running total stamps
// last_improvement_at. Rank order: total desc, then last_improvement_at asc
// (earlier wins; never-improved rows sort after every stamped row), then
// username_norm asc (deterministic). Ranks are assigned 1..n in that order.
export function computeScoreboard(submissions, problemOrder = []) {
  const list = Array.isArray(submissions) ? submissions : [];
  const scope = Array.isArray(problemOrder) && problemOrder.length ? new Set(problemOrder.map(String)) : null;
  const byCandidate = new Map();

  const sorted = [...list].sort((a, b) => String(a?.created_at || "").localeCompare(String(b?.created_at || "")));
  for (const submission of sorted) {
    if (!submission) continue;
    const problemId = String(submission.problem_id || "");
    if (scope && !scope.has(problemId)) continue; // removed/foreign problems never count
    const key = String(submission.username_norm || "");
    let row = byCandidate.get(key);
    if (!row) {
      row = {
        username_norm: key,
        person_id: null,
        candidate_id: null,
        per_problem: {},
        total: 0,
        last_improvement_at: null,
        rank: 0
      };
      byCandidate.set(key, row);
    }
    if (submission.person_id) row.person_id = submission.person_id;
    if (submission.candidate_id) row.candidate_id = submission.candidate_id;

    let cell = row.per_problem[problemId];
    if (!cell) {
      cell = { best_score: 0, max_points: 0, attempts: 0 };
      row.per_problem[problemId] = cell;
    }
    cell.attempts += 1;
    if (Number.isFinite(submission.max_points)) cell.max_points = submission.max_points;
    const score = Number.isFinite(submission.score) ? submission.score : 0;
    if (score > cell.best_score) {
      row.total += score - cell.best_score; // running total strictly increased
      cell.best_score = score;
      row.last_improvement_at = submission.created_at || row.last_improvement_at;
    }
  }

  const rows = [...byCandidate.values()].sort((a, b) =>
    (b.total - a.total)
    || compareImprovement(a.last_improvement_at, b.last_improvement_at)
    || a.username_norm.localeCompare(b.username_norm));
  rows.forEach((row, index) => { row.rank = index + 1; });
  return rows;
}

// Earlier improvement wins; a row that never improved (null) sorts after
// every stamped row regardless of timestamp.
function compareImprovement(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  return String(a).localeCompare(String(b));
}

// One SESSION's per-problem submission summary — startResponse ships this so a
// reload restores chips/attempt meters/total instantly (spec §3.4).
export function computeSessionSummary(submissions) {
  const list = Array.isArray(submissions) ? submissions : [];
  const sorted = [...list].sort((a, b) => String(a?.created_at || "").localeCompare(String(b?.created_at || "")));
  const summary = {};
  for (const submission of sorted) {
    if (!submission) continue;
    const problemId = String(submission.problem_id || "");
    if (!problemId) continue;
    const score = Number.isFinite(submission.score) ? submission.score : 0;
    let cell = summary[problemId];
    if (!cell) {
      cell = {
        best_score: score,
        max_points: 0,
        attempts: 0,
        best_verdict: submission.verdict || "",
        last_verdict: "",
        last_submitted_at: ""
      };
      summary[problemId] = cell;
    } else if (score > cell.best_score) {
      cell.best_score = score;
      cell.best_verdict = submission.verdict || "";
    }
    cell.attempts += 1;
    if (Number.isFinite(submission.max_points)) cell.max_points = submission.max_points;
    cell.last_verdict = submission.verdict || "";
    cell.last_submitted_at = submission.created_at || cell.last_submitted_at;
  }
  return summary;
}
