// backend/src/routes/adminProblems.mjs — the problem-bank admin authoring route
// domain as a FACTORY (decomp B3, plan §A2/§A8). makeAdminProblemsRoutes(ctx)
// closes over the handler-built ctx (per ?buster instance) and returns the four
// admin problem-bank route handlers + the helpers it OWNS (problemRef /
// problemReferenceUniverse). handler.mjs instantiates this at module scope and
// destructures the route handlers into the SAME names the dispatch table calls,
// so the dispatch lines stay byte-identical (canaryIsolation text-scans them).
//
// Every route handler is AUTH-FIRST: requireAdmin(req) is the first statement
// (routesAuthLint pins this).
//
// Factory (not a configure-mutated singleton) for the same per-?buster-instance
// isolation reason as makeAuth / makeSessionStore / makeAdminTemplatesRoutes:
// problemAuthoring.test.mjs imports the handler with a ?problems buster and swaps
// the fake Firestore via __setClientsForTest — getFirestore is therefore taken as
// a GETTER so the swap propagates (the live handle is never captured by value).
//
// Dependency direction (conventions): handler.mjs → routes/* → (src domain
// modules, lib/*). Everything stateful or env-captured (the live Firestore
// getter, collection names, query caps, the problem-domain store/validation fns,
// the contest-reference finder, the template lister, the legacy-settings store
// fns, and the http transport helpers) arrives through ctx — nothing is imported
// here, so the env-capture-at-load semantics stay in handler.mjs (env-lint).

export function makeAdminProblemsRoutes(ctx) {
  const {
    getFirestore,
    requireAdmin,
    parseBody,
    badRequest,
    httpError,
    httpErrorWith,
    // collection names (captured at handler load, per ?buster instance) + caps
    problemsCollection,
    problemsQueryLimit,
    contestsCollection,
    // problem domain fns / constants
    isValidProblemId,
    validateProblemInput,
    getBankProblem,
    // contest-reference finder (pure) + the template lister it reads through
    findProblemReferences,
    listTemplates,
    // BANK-1 (F11) §1.2: portable identity is minted on first authoring so the
    // export bundle and the source doc agree forever after — no batch migration.
    mintPortableId,
    instanceLabel
  } = ctx;

  // ---- S4: problem bank (admin authoring) ------------------------------------

  function problemRef(id) {
    return getFirestore().collection(problemsCollection).doc(id);
  }

  async function adminListProblems(req) {
    requireAdmin(req);
    const snapshot = await getFirestore().collection(problemsCollection).limit(problemsQueryLimit).get();
    const problems = snapshot.docs
      .map((doc) => doc.data())
      .map((p) => ({
        id: p.id,
        title: p.title || "",
        status: p.status || "draft",
        points: p.points ?? 100,
        scoring: p.scoring || "per_test",
        languages: p.languages || [],
        tags: Array.isArray(p.tags) ? p.tags : [], // S-I §1.2 (legacy docs → [])
        sample_count: (p.sampleTests || []).length,
        hidden_count: (p.hiddenTests || []).length,
        updated_at: p.updated_at || ""
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return { problems };
  }

  async function adminGetProblem(req) {
    requireAdmin(req);
    const id = String(req.query?.id || "");
    if (!isValidProblemId(id)) return badRequest("invalid id");
    const doc = await problemRef(id).get();
    if (!doc.exists) throw httpError(404, "Problem not found");
    // S-I §5.3: surface what references this problem so the editor can render
    // the "Referenced by" line and pre-warn before delete/unpublish.
    const refs = findProblemReferences(id, await problemReferenceUniverse());
    // Full doc INCLUDING hiddenTests — admin-only surface.
    return {
      problem: doc.data(),
      references: {
        contests: refs.contests.map((contest) => contest.slug),
        templates: refs.templates.map((template) => template.slug)
      }
    };
  }

  // ---- S-I §1.4.3: live-reference guard ----------------------------------------
  // Problem CONTENT stays live on contests (exec/start read the bank at serve
  // time), so destructive bank edits must be guarded:
  //   delete while referenced                  -> 409 problem_referenced
  //   unpublish while CONTEST-referenced       -> 409 problem_referenced
  //     (template-only references allow it — instantiation re-validates)
  //   hiddenTests edit while an OPEN contest references it -> typed confirm
  //     (body.confirm_live_edit === the problem id), else 409.

  // Bounded pre-fetch for findProblemReferences: real contest docs (limit 500;
  // archived filtered by the pure function) + templates with seeds merged. The
  // global/settings problem path is not contest-referenced, so it keeps the
  // silent-clear branch below instead of a 409.
  async function problemReferenceUniverse() {
    const [contestSnapshot, templates] = await Promise.all([
      getFirestore().collection(contestsCollection).limit(CONTESTS_REFERENCE_LIMIT).get(),
      listTemplates()
    ]);
    return { contests: contestSnapshot.docs.map((doc) => doc.data()), templates };
  }
  const CONTESTS_REFERENCE_LIMIT = 500;

  async function adminSaveProblem(req) {
    requireAdmin(req);
    const body = parseBody(req);
    const checked = validateProblemInput(body);
    if (!checked.ok) return badRequest(checked.error);
    const existing = await problemRef(checked.problem.id).get();
    // Guard comparisons run against doc-or-seed (a draft doc shadowing a
    // published seed IS an unpublish); created_at preservation stays doc-only.
    const current = existing.exists ? existing.data() : await getBankProblem(checked.problem.id);
    if (current) {
      const unpublishing = current.status === "published" && checked.problem.status === "draft";
      const hiddenChanged = JSON.stringify(current.hiddenTests || []) !== JSON.stringify(checked.problem.hiddenTests);
      if (unpublishing || hiddenChanged) {
        const refs = findProblemReferences(checked.problem.id, await problemReferenceUniverse());
        if (unpublishing && refs.contests.length) {
          throw httpErrorWith(409, "problem_referenced", {
            contests: refs.contests.map((contest) => contest.slug),
            templates: refs.templates.map((template) => template.slug)
          });
        }
        const openContests = refs.contests.filter((contest) => contest.status === "open");
        if (hiddenChanged && openContests.length && body.confirm_live_edit !== checked.problem.id) {
          throw httpErrorWith(409, "live_edit_confirmation_required", {
            contests: openContests.map((contest) => contest.slug)
          });
        }
      }
    }
    const now = new Date().toISOString();
    // BANK-1 (F11) §1.2: a portable_id + origin is minted ONCE (first author of
    // this slug) and preserved verbatim on every later save. An existing doc's
    // identity is never re-minted; a legacy doc with no portable_id stays as-is
    // until export back-fills it (export is the other mint site).
    const prior = existing.exists ? existing.data() : null;
    const identity = (prior && prior.portable_id)
      ? { portable_id: prior.portable_id, ...(prior.origin ? { origin: prior.origin } : {}) }
      : (prior ? {} : { portable_id: mintPortableId(), origin: { instance: instanceLabel, at: now } });
    const item = {
      ...checked.problem,
      ...identity,
      created_at: existing.exists ? (existing.data().created_at || now) : now,
      updated_at: now
    };
    await problemRef(item.id).set(item);
    return { ok: true, problem: item };
  }

  async function adminDeleteProblem(req) {
    requireAdmin(req);
    const body = parseBody(req);
    const id = String(body.id || "");
    if (!isValidProblemId(id)) return badRequest("invalid id");
    // S-I §1.4.3: references found -> 409, NO silent clearing of contest or
    // template assignments. (Replaces the old delete-clears-assignment rule.)
    const refs = findProblemReferences(id, await problemReferenceUniverse());
    if (refs.contests.length || refs.templates.length) {
      throw httpErrorWith(409, "problem_referenced", {
        contests: refs.contests.map((contest) => contest.slug),
        templates: refs.templates.map((template) => template.slug)
      });
    }
    await problemRef(id).delete();
    return { ok: true };
  }

  return {
    // route handlers (auth-first — routesAuthLint guards this); names match the
    // dispatch table exactly so handler.mjs's dispatch lines stay byte-identical.
    adminListProblems,
    adminGetProblem,
    adminSaveProblem,
    adminDeleteProblem,
    // problem-bank helpers it owns (currently used only by these routes; kept
    // single-source here in case future resident code needs them via ctx)
    problemRef,
    problemReferenceUniverse
  };
}
