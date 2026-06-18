// backend/src/routes/adminPeople.mjs — the S-J §2.14 People tab route domain as
// a FACTORY (decomp B7, plan §A2/§A8). makeAdminPeopleRoutes(ctx) closes over the
// handler-built ctx (per ?buster instance) and returns the two admin People
// routes (the directory + the per-person cross-round scorecard).
//
// The People tab is the ONE sanctioned cross-contest surface. The directory + the
// per-person enrollment scan use the explicit ALL_CONTESTS sentinel (listAllPersons
// / listEnrollmentsForPerson, identity.mjs). The per-contest score/integrity reads
// the scorecard fans out are EACH contest-scoped through scopedQuery on the
// RESOLVED contest — so the F9 no-bleed invariant holds (the sentinel is for the
// person/enrollment axis only, never contest evidence). Both routes are auth-first
// with requireAdmin (routesAuthLint pins this) and SCOPED GETs in canaryIsolation's
// SCOPED_GET_REQUESTS: /api/admin/people and /api/admin/person are cross-contest BY
// DESIGN, and the only raw .where() inside is on person_id (NOT contest_slug) over
// a scopedQuery handle, so scopingLint's allowlist stays {handler.mjs: 4}.
//
// Factory (not a configure-mutated singleton) for the same per-?buster-instance
// isolation reason as makeAuth / makeSessionStore / makeAdminStatsRoutes:
// peopleDirectory.test.mjs imports the handler with a ?buster and swaps the fake
// Firestore via __setClientsForTest — getFirestore is therefore taken as a GETTER
// so the swap propagates (the live handle is never captured by value).
//
// OWNED here (moved verbatim from handler.mjs — used ONLY by these routes):
//   adminPeople / adminPerson      — the two route handlers
//   computePersonScorecard         — the cross-round join (sentinel scan + per-
//                                    contest scopedQuery reads + pure builder)
//   summarizeScorecardIntegrity    — folds integrityByPersonFor's raw shape into
//                                    the scorecard's alerts_by_severity/verdict
//
// SHARED helpers/deps stay RESIDENT in handler.mjs (or their own module) and
// arrive by reference through ctx — they are NOT moved here because other
// still-resident handler code reuses them:
//   getCollegeNameMap / listAllPersons / listEnrollmentsForPerson / getPersonById
//                          — identity.mjs fns (getCollegeNameMap also feeds the
//                            results table; listEnrollmentsForPerson is also used
//                            inside this module's two routes)
//   filterDirectory / buildScorecardRows / buildScorecardCsv
//                          — people.mjs PURE helpers (also unit-tested directly)
//   mapWithConcurrency     — lib/sanitize.mjs, used across the handler
//   resolveContest / scopedQuery — contests.mjs, used across the handler
//   contestProblemEntries  — contestProblems.mjs, also used by the results table
//   computeScoreboard / summarizeIntegrity — scoreboard.mjs, used by the results
//                            table
//   integrityByPersonFor   — handler-resident (also used by the results table);
//                            by reference so the SAME implementation is shared
//   getFirestore           — the live-client GETTER (swap-propagating)
//   badRequest             — lib/http.mjs transport helper
// Env-captured collection name / caps arrive BY VALUE (PEOPLE_DIRECTORY_LIMIT,
// SUBMISSIONS_COLLECTION, SUBMISSIONS_RESULTS_LIMIT) — nothing is imported here,
// so the env-capture-at-load semantics stay in handler.mjs (env-lint).
//
// Dependency direction (conventions): handler.mjs → routes/* → (src domain
// modules, lib/*).

export function makeAdminPeopleRoutes(ctx) {
  const {
    getFirestore,
    requireAdmin,
    badRequest,
    // identity.mjs fns (by reference — shared with resident handler code)
    listAllPersons,
    getCollegeNameMap,
    getPersonById,
    listEnrollmentsForPerson,
    // people.mjs PURE helpers (by reference — also unit-tested directly)
    filterDirectory,
    buildScorecardRows,
    buildScorecardCsv,
    // shared utilities / domain fns (by reference)
    mapWithConcurrency,
    resolveContest,
    scopedQuery,
    contestProblemEntries,
    computeScoreboard,
    summarizeIntegrity,
    integrityByPersonFor,
    // env-captured collection name / caps (by value at handler load)
    peopleDirectoryLimit,
    submissionsCollection,
    submissionsResultsLimit
  } = ctx;

  // GET /api/admin/people?search=&college= — the directory. ADMIN-ONLY. Returns
  // the (capped) person list filtered by college/id/name, each with a contest
  // count, plus the college options for the filter dropdown.
  async function adminPeople(req) {
    requireAdmin(req);
    const people = await listAllPersons();
    const collegeNames = await getCollegeNameMap();
    const filtered = filterDirectory(people, {
      search: req.query?.search ?? "",
      college: req.query?.college ?? ""
    });

    // Per-person contest count: ONE bounded cross-contest enrollment scan, grouped
    // by person_id (the directory needs the "attempted N rounds" badge). Capped to
    // the filtered set so an empty search doesn't fan out unboundedly.
    const rows = await mapWithConcurrency(filtered.slice(0, peopleDirectoryLimit), 20, async (person) => {
      const enrollments = await listEnrollmentsForPerson(person.person_id);
      const active = enrollments.filter((e) => String(e.status || "active") !== "removed");
      return {
        person_id: person.person_id,
        unique_id: person.unique_id || "",
        name: person.name || "",
        college_norm: person.college_norm || "",
        college: collegeNames.get(person.college_norm) || person.college_norm || "",
        contest_count: active.length
      };
    });
    rows.sort((a, b) => String(a.college_norm).localeCompare(String(b.college_norm)) || String(a.unique_id).localeCompare(String(b.unique_id)));

    return {
      configured: true,
      people: rows,
      colleges: [...collegeNames.entries()].map(([college_norm, name]) => ({ college_norm, name }))
        .sort((a, b) => a.college_norm.localeCompare(b.college_norm)),
      total: rows.length
    };
  }

  // GET /api/admin/person?person_id=&format= — one person's cross-round scorecard.
  // ADMIN-ONLY. Reads LIVE data per contest where it exists, falls back to the
  // frozen enrollment.final_snapshot after purge (vision §2.9 purge-survivor;
  // §10.2 snapshot scores VISIBLE, marked from a purged contest). CSV export when
  // format=csv.
  async function adminPerson(req) {
    requireAdmin(req);
    const personId = String(req.query?.person_id ?? req.query?.id ?? "").trim();
    if (!personId) return badRequest("person_id is required");
    const person = await getPersonById(personId);
    if (!person) return { configured: false };

    const data = await computePersonScorecard(person);
    if (String(req.query?.format || "").toLowerCase() === "csv") {
      return { csv: buildScorecardCsv(data.person, data.rows) };
    }
    return data;
  }

  // The cross-round join. ONE sanctioned cross-contest enrollment scan (sentinel)
  // gives the contests this person attempted; for EACH contest we resolve the
  // contest doc and read its LIVE submissions/alerts/reviews SCOPED to that
  // contest (the no-bleed guarantee — the sentinel never touches contest
  // evidence). buildScorecardRows (pure) does the live-vs-snapshot fallback.
  async function computePersonScorecard(person) {
    const personId = person.person_id;
    const enrollments = await listEnrollmentsForPerson(personId);
    const activeEnrollments = enrollments.filter((e) => String(e.status || "active") !== "removed");

    const liveByContest = {};
    const liveIntegrityByContest = {};
    const contests = {};
    const collegeNames = await getCollegeNameMap();

    await mapWithConcurrency(activeEnrollments, 8, async (enrollment) => {
      const slug = String(enrollment.contest_slug || "");
      if (!slug) return;
      let contest;
      try {
        contest = await resolveContest(slug, { requireOpen: false });
      } catch {
        contest = { slug, name: slug };
      }
      contests[slug] = contest;

      // A purged contest has no live data — skip the per-contest reads entirely
      // (the pure builder reads its final_snapshot). Otherwise read this person's
      // LIVE score + integrity, each SCOPED to this contest.
      if (contest.db_purged_at) return;

      const problemEntries = contestProblemEntries(contest);
      const problemOrder = problemEntries.map((entry) => entry.problem_id);

      const submissionsSnap = await scopedQuery(getFirestore().collection(submissionsCollection), contest)
        .where("person_id", "==", personId)
        .limit(submissionsResultsLimit)
        .get();
      const submissions = submissionsSnap.docs.map((doc) => doc.data());
      liveByContest[slug] = computeScoreboard(submissions, problemOrder);

      const integrity = await integrityByPersonFor(contest, [personId]);
      const summary = integrity.get(personId);
      liveIntegrityByContest[slug] = { [personId]: summarizeScorecardIntegrity(summary) };
    });

    const rows = buildScorecardRows({ enrollments: activeEnrollments, liveByContest, liveIntegrityByContest, contests });

    return {
      configured: true,
      person: {
        person_id: personId,
        unique_id: person.unique_id || "",
        name: person.name || "",
        college_norm: person.college_norm || "",
        college: collegeNames.get(person.college_norm) || person.college_norm || "",
        email: person.email || ""
      },
      rows,
      generated_at: new Date().toISOString()
    };
  }

  // integrityByPersonFor returns raw { alerts:[], reviews:[] } per person; the
  // scorecard builder wants the SAME folded shape the Results table uses. Reuse
  // the pure summarizer so a person's integrity reads identically on both surfaces.
  function summarizeScorecardIntegrity(raw) {
    const folded = summarizeIntegrity(raw || {});
    return { alerts_by_severity: folded.alerts_by_severity, review_verdict: folded.review_verdict };
  }

  return {
    // route handlers — names match the dispatch table exactly so handler.mjs's
    // dispatch lines stay byte-identical (canaryIsolation). Both are auth-first
    // (routesAuthLint) and SCOPED GETs (SCOPED_GET_REQUESTS).
    adminPeople,
    adminPerson
  };
}
