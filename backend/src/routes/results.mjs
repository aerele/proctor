// backend/src/routes/results.mjs — the post-exam admin Results-tab READ/COMPUTE
// trio as a FACTORY (decomp B8, plan §A2/§A8). makeResultsRoutes(ctx) closes over
// the handler-built ctx (per ?buster instance) and returns the read route + the
// two compute helpers it owns.
//
// Scope is DELIBERATELY the read/compute trio ONLY (plan B8 note / resume Open-Q
// 2): the selection / adopt / mark-done / export / purge cluster STAYS resident
// in handler.mjs — those routes consume computeContestResults, so it is RETURNED
// from this factory and handler.mjs uses the returned reference (single source).
//
//   adminContestResults    GET /api/admin/contest-results — ADMIN-ONLY rollup
//                          (+ format=csv export via buildResultsCsv)
//   computeContestResults  the shared rollup (ALSO called by the resident
//                          selection-done / export / purge code → RETURNED)
//   integrityByPersonFor   per-candidate integrity inputs (ALSO passed into the
//                          makeAdminPeopleRoutes ctx → RETURNED, single source,
//                          never forked — constraint #5)
//
// Factory (not a configure-mutated singleton) for the same per-?buster-instance
// isolation reason as the other route domains: results tests import the handler
// with a ?buster and swap the fake Firestore via __setClientsForTest —
// getFirestore is therefore taken as a GETTER so the swap propagates (the live
// handle is never captured by value).
//
// integrityByPersonFor + computeContestResults each go through the scopedQuery
// chokepoint (the only raw .where() inside is on person_id / problem_id, never a
// raw contest_slug equality filter), so scopingLint's allowlist stays
// {handler.mjs: 4}.
//
// RESIDENT helpers that stay in handler.mjs and arrive BY REFERENCE through ctx
// (they are shared with still-resident code, so moving them would fork a single
// source or break call sites):
//   personContestForFilter — person-layer contest resolver (used by the whole
//                             person/selection/export cluster still in handler)
//   getAllReviews          — the S-C scoped review scan (used by the alerts +
//                             review code still in handler)
//
// Dependency direction (conventions): handler.mjs → routes/* → (src domain
// modules, lib/*). Nothing is imported here — every dependency (the live
// Firestore getter, the auth guard, the scopedQuery chokepoint, the scoreboard
// builders, the enrollment/person/college/problem/roster domain fns, the
// env-captured collection names + scan caps, and the two resident helpers by
// reference) arrives through ctx, so the env-capture-at-load semantics stay in
// handler.mjs (env-lint).

export function makeResultsRoutes(ctx) {
  const {
    getFirestore,
    requireAdmin,
    // scoped-read chokepoint
    scopedQuery,
    // scoreboard domain (src/scoreboard.mjs)
    buildResultsRows,
    buildResultsCsv,
    // enrollment / person / college / problem / roster domain
    listEnrollments,
    contestProblemEntries,
    getContestRosterMeta,
    getPersonsByIds,
    getCollegeNameMap,
    getProblem,
    // resident helpers (owned by handler.mjs), by reference
    personContestForFilter,
    getAllReviews,
    // env-captured collection names + scan caps (by value at handler load)
    submissionsCollection,
    submissionsResultsLimit,
    sessionCollection,
    sessionsQueryLimit,
    evaluationsCollection,
    alertsCollection,
    alertsQueryLimit
  } = ctx;

  // GET /api/admin/contest-results?contest=slug — ADMIN-ONLY (candidates never
  // see others' scores, vision §2.14). For every ACTIVE enrollment in the
  // contest: rank + label-driven id/name/college + total + per-problem best +
  // the integrity column (alerts-by-severity + review verdict) + selection_status.
  // Reuses computeScoreboard/computeSessionSummary via scoreboard.buildResultsRows
  // (best-per-problem default). The F9 no-bleed invariant holds: every Firestore
  // read goes through scopedQuery on the RESOLVED contest. CSV export rides the
  // same builder when format=csv.
  async function adminContestResults(req) {
    requireAdmin(req);
    const contest = await personContestForFilter(req.query?.contest ?? req.query?.contest_slug);
    if (!contest) {
      // Results is a person-layer surface: legacy/unknown/global has no enrollment
      // spine. Degrade to a clean "not available" rather than 500 or leak global.
      return { configured: false };
    }
    const data = await computeContestResults(contest);
    if (String(req.query?.format || "").toLowerCase() === "csv") {
      return { csv: buildResultsCsv(data.rows, data.problems) };
    }
    return data;
  }

  // The shared rollup: ONE enrollment scan + ONE submissions scan + ONE alerts
  // scan + ONE reviews scan, all contest-scoped, joined in memory by the pure
  // scoreboard module. Purged contests (no live submissions) fall back to each
  // enrollment's final_snapshot (vision §2.9 purge-survivor; the per-row
  // from_snapshot flag tells the UI to mark it).
  async function computeContestResults(contest) {
    const enrollments = await listEnrollments(contest);
    const problemEntries = contestProblemEntries(contest);
    const problemOrder = problemEntries.map((entry) => entry.problem_id);

    // NO-ROSTER signal (2026-06-18 exam-eve): a contest with NO active enrollments
    // AND no roster configured is a self-entered-identity contest — students typed
    // their own id at login (vision §2.4 no-roster rule). In that case EVERY
    // scoring identity necessarily lands in the "unmatched" branch below (there are
    // no enrollments to consume them), which is NORMAL, not an integrity problem.
    // We surface no_roster so the UI swaps the alarming "not on the roster" framing
    // for neutral "self-entered" copy. A ROSTERED contest (roster meta present, or
    // any active enrollment) keeps the loud genuine-unmatched behavior unchanged.
    const hasActiveEnrollment = enrollments.some((e) => String(e?.status || "active") !== "removed");
    const rosterMeta = await getContestRosterMeta(contest);
    const noRoster = !hasActiveEnrollment && !rosterMeta;

    const submissionsSnap = await scopedQuery(getFirestore().collection(submissionsCollection), contest)
      .limit(submissionsResultsLimit)
      .get();
    const submissions = submissionsSnap.docs.map((doc) => doc.data());

    // Purge-survivor: with no live submissions but stamped snapshots, read from
    // the frozen enrollment.final_snapshot instead of the (deleted) heavy data.
    const purged = submissions.length === 0
      && enrollments.some((enrollment) => enrollment.status !== "removed" && enrollment.final_snapshot);

    const activeIds = enrollments.filter((e) => e.status !== "removed").map((e) => e.person_id);
    const [persons, collegeNames, integrityByPerson, sessionsSnap] = await Promise.all([
      purged ? new Map() : getPersonsByIds(activeIds),
      getCollegeNameMap(),
      purged ? new Map() : integrityByPersonFor(contest),
      // KPR 2026-06-12: session docs enrich UNMATCHED submitter rows (name typed
      // at login). Skipped on the purged path (sessions are deleted by then).
      purged ? null : scopedQuery(getFirestore().collection(sessionCollection), contest).limit(sessionsQueryLimit).get()
    ]);
    const sessions = sessionsSnap ? sessionsSnap.docs.map((doc) => doc.data()) : [];

    // P1 (E): join the stored candidate-evaluation scorecards (one doc per
    // contest×identity, keyed by identity_key — person_id for enrolled rows,
    // username_norm for unmatched). The __meta:: cross doc is skipped. Empty when
    // the contest was never evaluated → buildResultsRows stays behavior-preserving.
    // Skipped on the purged path (the live scorecards are gone; the snapshot
    // carries the evaluation projection instead).
    const evaluations = new Map();
    if (!purged) {
      const evaluationsSnap = await scopedQuery(getFirestore().collection(evaluationsCollection), contest)
        .limit(submissionsResultsLimit)
        .get();
      for (const doc of evaluationsSnap.docs) {
        const scorecard = doc.data();
        const key = String(scorecard?.identity_key || "");
        if (!key || key.startsWith("__meta::")) continue;
        evaluations.set(key, scorecard);
      }
    }

    const multiCollege = Array.isArray(contest.colleges) && contest.colleges.length > 1;
    const rows = buildResultsRows({
      submissions, enrollments, persons, integrityByPerson, collegeNames,
      problemOrder, multiCollege, purged, sessions, evaluations
    });

    // Per-problem column titles (contest order) for the table header + CSV.
    const problems = await Promise.all(problemEntries.map(async (entry) => {
      const problem = await getProblem(entry.problem_id).catch(() => null);
      return { problem_id: entry.problem_id, title: problem?.title || entry.problem_id, points: entry.points };
    }));

    return {
      configured: true,
      contest_slug: contest.slug,
      multi_college: multiCollege,
      selection_done_at: contest.selection_done_at || null,
      problems,
      rows,
      // KPR 2026-06-12: count of scoring identities NOT consumed by any
      // enrollment — drives the loud "N submitters not on the roster" banner.
      unmatched_count: rows.filter((row) => row.unmatched).length,
      // 2026-06-18 exam-eve: when the whole contest is self-entered (no roster, no
      // enrollments), the UI shows NEUTRAL "self-entered" copy instead of the loud
      // unmatched banner/badge. Rostered contests keep no_roster:false → loud.
      no_roster: noRoster,
      generated_at: new Date().toISOString()
    };
  }

  // Per-candidate integrity inputs: this contest's alerts grouped by username_norm
  // (= person_id under person mode) + this contest's review records grouped the
  // same way. ONE bounded scan each, scoped to the contest. summarizeIntegrity
  // (pure) folds them in buildResultsRows.
  // KPR 2026-06-12: grouped by EVERY username_norm in the contest (no active-
  // enrollment filter) so UNMATCHED submitter rows keep their integrity column
  // too — buildResultsRows looks up matched rows by person_id and unmatched rows
  // by their scoreboard norm; matched-row values are identical to before (the
  // extra keys are simply never read for them).
  async function integrityByPersonFor(contest) {
    const out = new Map();
    const ensure = (id) => {
      if (!out.has(id)) out.set(id, { alerts: [], reviews: [] });
      return out.get(id);
    };

    const alertsSnap = await scopedQuery(getFirestore().collection(alertsCollection), contest)
      .limit(alertsQueryLimit)
      .get();
    for (const doc of alertsSnap.docs) {
      const alert = doc.data();
      if (alert.archived) continue; // archived = triaged-away, not an open integrity signal
      const personId = String(alert.username_norm || "");
      if (!personId) continue;
      ensure(personId).alerts.push({ severity: alert.severity });
    }

    // Reviews are stored per (username, reviewer, contest-slug); reuse the S-C
    // scope helper so a person-contest reads its OWN review set (not the legacy
    // slugless pile). Bounded scan + in-memory scope filter (mirrors getAllReviews).
    const reviews = await getAllReviews(contest.slug);
    for (const review of reviews) {
      const personId = String(review.username_norm || "");
      if (!personId) continue;
      ensure(personId).reviews.push({ verdict: review.verdict, reviewer_name: review.reviewer_name });
    }
    return out;
  }

  return {
    // route handler — name matches the dispatch table exactly so handler.mjs's
    // dispatch line stays byte-identical (canaryIsolation). adminContestResults is
    // auth-first (routesAuthLint) and a SCOPED GET (SCOPED_GET_REQUESTS).
    adminContestResults,
    // compute helpers RETURNED for single-source reuse by resident handler.mjs
    // code: computeContestResults (selection-done / export / purge cluster) and
    // integrityByPersonFor (the makeAdminPeopleRoutes ctx). Never forked.
    computeContestResults,
    integrityByPersonFor
  };
}
