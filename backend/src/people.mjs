// backend/src/people.mjs — S-J People tab PURE helpers (vision §2.14 People tab,
// §2.9 purge-survivor live-vs-snapshot fallback, §10.2 "kept scores must be
// VISIBLE, marked as from a purged/archived contest"). NO Firestore: the handler
// supplies already-fetched enrollments + per-contest live scoreboard rows +
// per-contest live integrity + the contest docs; this module joins them into one
// row per contest the person attempted. Kept pure so the cross-round scorecard
// unit-tests without a DB and the handler never re-joins inline.

// Normalize whatever integrity blob we have (live summary OR a stored
// final_snapshot.integrity, which may be partial) into the ONE shape the UI
// renders — so the scorecard never branches on data origin (mirrors
// scoreboard.normalizeSnapshotIntegrity, kept local to avoid a cross-import).
function normalizeIntegrity(integrity) {
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
    review_verdict: src.review_verdict || "none"
  };
}

// A contest is "purged" for scorecard purposes when its DB data was deleted
// (db_purged_at stamped). The scorecard then reads enrollment.final_snapshot.
function isContestPurged(contest) {
  return Boolean(contest && contest.db_purged_at);
}

// THE cross-round join (vision §2.14). For each ACTIVE enrollment (one per
// contest the person attempted) emit one row: read LIVE data where it exists
// (the contest still has submissions), else FALL BACK to the frozen
// enrollment.final_snapshot (the contest was purged — "light data" survives the
// purge, vision §2.9). from_snapshot flags the fallback so the UI marks it.
//
// Inputs (all keyed by contest_slug; the handler fetched them):
//   enrollments[]            — this person's enrollments across ALL contests
//   liveByContest[slug]      — scoreboard rows for that contest (find this person)
//   liveIntegrityByContest[slug][person_id] — live integrity summary
//   contests[slug]           — the contest doc (name, status, db_purged_at, ...)
export function buildScorecardRows({
  enrollments = [],
  liveByContest = {},
  liveIntegrityByContest = {},
  contests = {}
} = {}) {
  const rows = [];
  for (const enrollment of enrollments) {
    if (String(enrollment?.status || "active") === "removed") continue; // un-rostered → not an attempt
    const slug = String(enrollment.contest_slug || "");
    const personId = String(enrollment.person_id || "");
    const contest = contests[slug] || null;
    const purged = isContestPurged(contest);

    // Live scoreboard row for this person in this contest (may be absent: a
    // not-yet-scored candidate in a LIVE contest, or a purged contest).
    const liveRows = liveByContest[slug] || [];
    const liveRow = liveRows.find((row) => String(row?.person_id || row?.username_norm || "") === personId) || null;
    const snapshot = enrollment.final_snapshot || null;

    let total;
    let perProblem;
    let integrity;
    let fromSnapshot;
    if (!purged && liveRow) {
      // LIVE contest, candidate has a live row.
      fromSnapshot = false;
      total = Number(liveRow.total || 0);
      perProblem = liveRow.per_problem || null;
      const liveIntegrity = (liveIntegrityByContest[slug] || {})[personId] || null;
      integrity = normalizeIntegrity(liveIntegrity);
    } else if (purged || (!liveRow && snapshot)) {
      // PURGED contest → snapshot. Also: a contest with NO live rows at all but a
      // stamped snapshot (selection done before purge) reads the snapshot too.
      fromSnapshot = true;
      total = Number(snapshot?.total_score || 0);
      perProblem = snapshot?.per_problem || null;
      integrity = normalizeIntegrity(snapshot?.integrity);
    } else {
      // LIVE contest, candidate attempted (enrolled) but has not scored yet.
      fromSnapshot = false;
      total = 0;
      perProblem = null;
      integrity = normalizeIntegrity(null);
    }

    rows.push({
      contest_slug: slug,
      contest_name: contest?.name || slug,
      contest_status: contest?.status || "",
      contest_purged: purged,
      total,
      per_problem: perProblem,
      integrity,
      selection_status: String(enrollment.selection_status || "none"),
      source: String(enrollment.source || "csv"),
      from_snapshot: fromSnapshot,
      last_improvement_at: liveRow?.last_improvement_at || null,
      selection_done_at: contest?.selection_done_at || null
    });
  }

  // Deterministic chronological order: by selection_done_at (when the round
  // closed), then contest_slug — Round 1 before Round 2 in the common case, and
  // stable when neither is set.
  rows.sort((a, b) =>
    String(a.selection_done_at || "").localeCompare(String(b.selection_done_at || ""))
    || String(a.contest_slug).localeCompare(String(b.contest_slug)));
  return rows;
}

// Directory filter (vision §2.14: search by college / id / name). AND-composed,
// case-insensitive substring over unique_id + name, exact college_norm match.
// PURE: the handler fetched the (capped) person directory; this filters it.
export function filterDirectory(people = [], { search = "", college = "" } = {}) {
  const needle = String(search || "").trim().toLowerCase();
  const collegeNorm = String(college || "").trim();
  return people.filter((person) => {
    if (collegeNorm && String(person.college_norm || "") !== collegeNorm) return false;
    if (needle) {
      const id = String(person.unique_id || "").toLowerCase();
      const name = String(person.name || "").toLowerCase();
      if (!id.includes(needle) && !name.includes(needle)) return false;
    }
    return true;
  });
}

// Per-person scorecard CSV (vision §2.14 exportable). One line per contest row;
// the same formula-injection guard the Results CSV uses (candidate-supplied
// name/id are guarded). The person header fields prefix nothing — the export is
// the scorecard table, one file per person.
export function buildScorecardCsv(person = {}, rows = []) {
  const header = [
    "contest", "contest_name", "status", "total",
    "critical_alerts", "warning_alerts", "review_verdict", "selection_status"
  ].map(csvField).join(",");
  const lines = rows.map((row) => [
    row.contest_slug,
    row.contest_name,
    row.from_snapshot ? (row.contest_purged ? "purged" : "snapshot") : "live",
    row.total,
    row.integrity.alerts_by_severity.critical,
    row.integrity.alerts_by_severity.warning,
    row.integrity.review_verdict,
    row.selection_status
  ].map((value) => csvField(String(value))).join(","));
  return [header, ...lines].join("\n");
}

function csvField(value) {
  let v = String(value ?? "");
  if (v && /^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}
