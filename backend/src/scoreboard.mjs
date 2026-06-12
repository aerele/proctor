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

// ---- S-J §2.14 Results rollup (the JOIN over the scoreboard) -----------------
// buildResultsRows fuses the computeScoreboard output with the per-contest
// enrollment rows (selection_status + final_snapshot), the persons directory
// (label-driven id + name + college), and a per-candidate integrity summary
// (alerts-by-severity + review verdict). It is the single pure implementation
// the admin Results endpoint serves AND the final_snapshot stamp reads — kept
// here so it never re-joins in the handler. PURE: handler.mjs supplies the
// already-fetched docs.

const SEVERITY_ORDER = ["critical", "warning", "info"];

// Fold one candidate's alerts + review records into the Results integrity
// column. Alerts group by the three known severities (anything else is
// dropped, never silently bucketed). review_verdict: "flagged" if ANY reviewer
// marked verdict==1 (cheating), else "cleared" when reviews exist, else "none".
export function summarizeIntegrity({ alerts = [], reviews = [] } = {}) {
  const bySeverity = { critical: 0, warning: 0, info: 0 };
  for (const alert of alerts) {
    const severity = String(alert?.severity || "");
    if (Object.prototype.hasOwnProperty.call(bySeverity, severity)) bySeverity[severity] += 1;
  }
  const totalAlerts = bySeverity.critical + bySeverity.warning + bySeverity.info;
  const reviewList = Array.isArray(reviews) ? reviews : [];
  const cheating = reviewList.filter((r) => Number(r?.verdict) === 1).length;
  let verdict = "none";
  if (reviewList.length) verdict = cheating > 0 ? "flagged" : "cleared";
  return {
    alerts_by_severity: bySeverity,
    total_alerts: totalAlerts,
    has_critical: bySeverity.critical > 0,
    review_count: reviewList.length,
    review_cheating_count: cheating,
    review_verdict: verdict
  };
}

// Per-problem cells in CONTEST PROBLEM ORDER (every ordered problem appears,
// even when a candidate never touched it — so columns line up across rows).
function perProblemCells(problemOrder, byProblem) {
  return problemOrder.map((problemId) => {
    const cell = byProblem?.[problemId];
    return {
      problem_id: problemId,
      best_score: cell ? cell.best_score : 0,
      max_points: cell ? cell.max_points : 0,
      attempts: cell ? cell.attempts : 0
    };
  });
}

// ---- P1 candidate-evaluation projection (E) ---------------------------------
// Project a stored evaluation scorecard down to the compact shape the Results
// row + CSV carry. NULL-SAFE: any missing/invalid scorecard (null, non-object,
// no talent/integrity sub-objects) → null, so the join stays behavior-preserving
// when evaluations are absent. flags_by_severity counts scorecard.flags[] by
// severity (only the three known buckets; unknowns dropped, never bucketed).
export function projectEvaluation(scorecard) {
  if (!scorecard || typeof scorecard !== "object") return null;
  const talent = scorecard.talent && typeof scorecard.talent === "object" ? scorecard.talent : {};
  const integrity = scorecard.integrity && typeof scorecard.integrity === "object" ? scorecard.integrity : {};
  const tiers = scorecard.tiers && typeof scorecard.tiers === "object" ? scorecard.tiers : {};
  const coverage = scorecard.coverage && typeof scorecard.coverage === "object" ? scorecard.coverage : {};

  const flagsBySeverity = { critical: 0, warning: 0, info: 0 };
  for (const flag of Array.isArray(scorecard.flags) ? scorecard.flags : []) {
    const severity = String(flag?.severity || "");
    if (Object.prototype.hasOwnProperty.call(flagsBySeverity, severity)) flagsBySeverity[severity] += 1;
  }

  const composite = Number.isFinite(talent.composite) ? talent.composite : null;
  const pasteRatio = Number.isFinite(integrity.paste_ratio) ? integrity.paste_ratio : null;

  return {
    talent_tier: tiers.talent != null ? String(tiers.talent) : null,
    integrity_tier: tiers.integrity != null ? String(tiers.integrity) : null,
    composite,
    paste_ratio: pasteRatio,
    flags_by_severity: flagsBySeverity,
    confidence: coverage.confidence != null ? String(coverage.confidence) : null,
    one_line: tiers.one_line != null ? String(tiers.one_line) : null,
    recommended_action: scorecard.recommended_action != null ? scorecard.recommended_action : null
  };
}

// THE Results join. Active enrollments are the row spine (results denominator =
// active enrollments, vision §2.9); a candidate with no submissions still gets
// a 0-score row, and a PURGED contest (purged:true → no submissions/persons)
// materializes rows from enrollment.final_snapshot (purge-survivor rule). The
// label-driven display id gains the college ONLY when the contest is
// multi-college (vision §2.13 projection rule).
//
// P1 (E): evaluations is an OPTIONAL Map keyed by identity_key — person_id for
// enrolled rows, username_norm for unmatched rows (mixed keying). Each row gains
// `evaluation: projectEvaluation(hit) || null`. On the purged path the live
// scorecard is gone, so a snapshot-stored evaluation (enrollment.final_snapshot
// .evaluation) is surfaced through the SAME projection shape. Zero behavior
// change when evaluations is empty (every pre-P1 test passes untouched).
export function buildResultsRows({
  submissions = [],
  enrollments = [],
  persons = new Map(),
  integrityByPerson = new Map(),
  collegeNames = new Map(),
  problemOrder = [],
  multiCollege = false,
  purged = false,
  sessions = [],
  evaluations = new Map()
} = {}) {
  const evaluationOf = (key) => (evaluations instanceof Map ? evaluations.get(key) : evaluations?.[key]) || null;
  const scoreboard = new Map(
    computeScoreboard(submissions, problemOrder).map((row) => [row.username_norm, row])
  );
  const personOf = (id) => (persons instanceof Map ? persons.get(id) : persons?.[id]) || null;
  const integrityOf = (id) => (integrityByPerson instanceof Map ? integrityByPerson.get(id) : integrityByPerson?.[id]) || null;
  const collegeNameOf = (norm) => (collegeNames instanceof Map ? collegeNames.get(norm) : collegeNames?.[norm]) || norm;

  const rows = [];
  const consumedNorms = new Set(); // scoreboard identities claimed by an enrollment
  for (const enrollment of enrollments) {
    if (String(enrollment?.status || "active") === "removed") continue; // active-only denominator
    const personId = String(enrollment.person_id || "");
    const snapshot = purged ? (enrollment.final_snapshot || null) : null;
    const board = scoreboard.get(personId);
    if (board) consumedNorms.add(personId);
    const person = personOf(personId);

    // identity: live person doc → snapshot copy → person_id components last.
    const uniqueId = String(person?.unique_id ?? snapshot?.unique_id ?? "");
    const name = String(person?.name ?? snapshot?.name ?? "");
    const collegeNorm = String(enrollment.college_norm || person?.college_norm || "");
    const collegeName = collegeNorm ? collegeNameOf(collegeNorm) : "";

    let total;
    let perProblem;
    let integrity;
    let fromSnapshot = false;
    if (board) {
      total = board.total;
      perProblem = perProblemCells(problemOrder, board.per_problem);
      integrity = summarizeIntegrity(integrityOf(personId) || {});
    } else if (snapshot) {
      fromSnapshot = true;
      total = Number(snapshot.total_score || 0);
      perProblem = problemOrder.map((problemId) => ({
        problem_id: problemId,
        best_score: Number(snapshot.per_problem?.[problemId] || 0),
        max_points: 0,
        attempts: 0
      }));
      integrity = normalizeSnapshotIntegrity(snapshot.integrity);
    } else {
      total = 0;
      perProblem = perProblemCells(problemOrder, {});
      integrity = summarizeIntegrity(integrityOf(personId) || {});
    }

    // P1 (E) evaluation: live scorecard keyed by person_id; on the purged path
    // the live scorecard is gone, so surface the snapshot-stored evaluation
    // (already in the compact stored shape — normalize to the same projection
    // shape so the UI never branches on origin) when present, else null.
    const evaluation = fromSnapshot
      ? (normalizeSnapshotEvaluation(snapshot?.evaluation) || null)
      : (projectEvaluation(evaluationOf(personId)) || null);

    rows.push({
      person_id: personId,
      candidate_id: uniqueId,
      name,
      college_norm: collegeNorm,
      college: collegeName,
      display_id: multiCollege && collegeName ? `${uniqueId} · ${collegeName}` : uniqueId,
      total,
      per_problem: perProblem,
      integrity,
      selection_status: String(enrollment.selection_status || "none"),
      from_snapshot: fromSnapshot,
      last_improvement_at: board?.last_improvement_at || null,
      evaluation
    });
  }

  // ---- UNMATCHED IDENTITIES (KPR 2026-06-12 incident: loud-or-right) ----------
  // Scoreboard identities NOT consumed by any enrollment — e.g. sessions that
  // joined anonymously after a mid-contest roster clear (username_norm = bare
  // typed id, never equal to any enrollment person_id). These were previously
  // dropped SILENTLY, showing real scorers as 0/absent. They now ride as
  // flagged rows (unmatched: true) with the same best-per-problem totals as
  // matched rows; identity is the candidate_id typed at login (name enriched
  // from the newest session doc when the caller supplies sessions).
  const sessionByNorm = new Map();
  for (const session of (Array.isArray(sessions) ? sessions : [])) {
    const norm = String(session?.username_norm || "");
    if (!norm) continue;
    const prev = sessionByNorm.get(norm);
    if (!prev || String(session.created_at || "") > String(prev.created_at || "")) {
      sessionByNorm.set(norm, session);
    }
  }
  for (const [norm, board] of scoreboard) {
    if (!norm || consumedNorms.has(norm)) continue;
    const session = sessionByNorm.get(norm) || null;
    const typedId = String(board.candidate_id || session?.candidate_id || norm);
    rows.push({
      person_id: "",
      username_norm: norm,
      candidate_id: typedId,
      name: String(session?.name || ""),
      college_norm: "",
      college: "",
      display_id: typedId,
      total: board.total,
      per_problem: perProblemCells(problemOrder, board.per_problem),
      integrity: summarizeIntegrity(integrityOf(norm) || {}),
      selection_status: "none",
      from_snapshot: false,
      last_improvement_at: board.last_improvement_at || null,
      evaluation: projectEvaluation(evaluationOf(norm)) || null, // P1 (E): unmatched rows key on username_norm
      unmatched: true
    });
  }

  // Rank: total desc, then earlier last_improvement_at, then candidate_id asc
  // (deterministic; never-scored rows sort after scored rows) — mirrors
  // computeScoreboard's order so the live and purged paths agree. Unmatched
  // rows rank IN PLACE (a real 33-point submitter outranks an enrolled 0);
  // their tie-break key is the scoreboard norm (person_id is empty).
  rows.sort((a, b) =>
    (b.total - a.total)
    || compareImprovement(a.last_improvement_at, b.last_improvement_at)
    || String(a.person_id || a.username_norm || "").localeCompare(String(b.person_id || b.username_norm || "")));
  rows.forEach((row, index) => { row.rank = index + 1; });
  return rows;
}

// A stored final_snapshot integrity blob may be partial — normalize it to the
// same shape summarizeIntegrity returns so the UI never branches on origin.
function normalizeSnapshotIntegrity(integrity) {
  const src = integrity && typeof integrity === "object" ? integrity : {};
  const sev = src.alerts_by_severity && typeof src.alerts_by_severity === "object" ? src.alerts_by_severity : {};
  const bySeverity = {
    critical: Number(sev.critical || 0),
    warning: Number(sev.warning || 0),
    info: Number(sev.info || 0)
  };
  return {
    alerts_by_severity: bySeverity,
    total_alerts: bySeverity.critical + bySeverity.warning + bySeverity.info,
    has_critical: bySeverity.critical > 0,
    review_count: Number(src.review_count || 0),
    review_cheating_count: Number(src.review_cheating_count || 0),
    review_verdict: src.review_verdict || "none"
  };
}

// A stored final_snapshot.evaluation blob is ALREADY in the compact projection
// shape (handler stores {talent_tier, integrity_tier, composite,
// flags_by_severity, one_line, recommended_action} at selection-done). Normalize
// it to the full row-projection shape (filling paste_ratio/confidence absent in
// the snapshot) so the purged path matches the live path. Null when no blob.
function normalizeSnapshotEvaluation(evaluation) {
  if (!evaluation || typeof evaluation !== "object") return null;
  const sev = evaluation.flags_by_severity && typeof evaluation.flags_by_severity === "object"
    ? evaluation.flags_by_severity : {};
  return {
    talent_tier: evaluation.talent_tier != null ? String(evaluation.talent_tier) : null,
    integrity_tier: evaluation.integrity_tier != null ? String(evaluation.integrity_tier) : null,
    composite: Number.isFinite(evaluation.composite) ? evaluation.composite : null,
    paste_ratio: Number.isFinite(evaluation.paste_ratio) ? evaluation.paste_ratio : null,
    flags_by_severity: {
      critical: Number(sev.critical || 0),
      warning: Number(sev.warning || 0),
      info: Number(sev.info || 0)
    },
    confidence: evaluation.confidence != null ? String(evaluation.confidence) : null,
    one_line: evaluation.one_line != null ? String(evaluation.one_line) : null,
    recommended_action: evaluation.recommended_action != null ? evaluation.recommended_action : null
  };
}

// RFC-4180-ish CSV with the same formula-injection guard the frontend uses
// (candidate-supplied id/name are quoted + prefixed). Header carries the
// per-problem TITLES (in contest order) so the export reads like the table.
export function buildResultsCsv(rows, problems = []) {
  const titles = problems.map((p) => String(p?.title || p?.problem_id || ""));
  const header = [
    "rank", "candidate_id", "name", "college", "total",
    ...titles,
    "critical_alerts", "warning_alerts", "info_alerts", "review_verdict", "selection_status",
    // P1 (E) candidate-evaluation columns — after selection_status, before
    // unmatched. Blank cells when the row has no evaluation (behavior-preserving
    // for un-evaluated contests).
    "talent_tier", "talent_composite", "integrity_tier", "paste_pct", "eval_flags", "eval_one_line",
    // KPR 2026-06-12: unmatched-identity rows are flagged in the export too —
    // a hiring decision must never mistake an unverified typed id for a
    // roster-verified one. "yes" on flagged rows, blank otherwise.
    "unmatched"
  ].map(csvField).join(",");
  const lines = rows.map((row) => {
    const ev = row.evaluation || null;
    const pastePct = ev && Number.isFinite(ev.paste_ratio) ? String(Math.round(ev.paste_ratio * 100)) : "";
    const evalFlags = ev
      ? `${ev.flags_by_severity.critical}C/${ev.flags_by_severity.warning}W/${ev.flags_by_severity.info}I`
      : "";
    const cells = [
      row.rank, row.candidate_id, row.name, row.college, row.total,
      ...problems.map((p) => {
        const cell = (row.per_problem || []).find((c) => c.problem_id === p.problem_id);
        return cell ? cell.best_score : 0;
      }),
      row.integrity.alerts_by_severity.critical,
      row.integrity.alerts_by_severity.warning,
      row.integrity.alerts_by_severity.info,
      row.integrity.review_verdict,
      row.selection_status,
      ev && ev.talent_tier != null ? ev.talent_tier : "",
      ev && Number.isFinite(ev.composite) ? ev.composite : "",
      ev && ev.integrity_tier != null ? ev.integrity_tier : "",
      pastePct,
      evalFlags,
      ev && ev.one_line != null ? ev.one_line : "",
      row.unmatched ? "yes" : ""
    ];
    return cells.map((value) => csvField(String(value))).join(",");
  });
  return [header, ...lines].join("\n");
}

// Same escaping rules as the frontend csvField (M8 formula guard): a cell that
// could be read as a spreadsheet formula gets a leading apostrophe; cells with
// commas/quotes/newlines are quoted with doubled inner quotes.
function csvField(value) {
  let v = String(value ?? "");
  if (v && /^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
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
