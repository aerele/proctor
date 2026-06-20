// backend/src/routes/adminContests.mjs — the admin contest-lifecycle routes
// domain as a FACTORY (decomp B4, plan §A2/§A8). makeAdminContestsRoutes(ctx)
// closes over the handler-built ctx (per ?buster instance) and returns the seven
// admin contest route handlers + the two helpers they own.
//
// Routes (all auth-first with requireAdmin — routesAuthLint pins this; none is a
// GET in the canary's SCOPED_GET set except adminListContests, which reads
// through listContests() so it adds NO raw contest_slug filter):
//   adminListContests       GET  /api/admin/contests
//   adminCreateContest      POST /api/admin/contests
//   adminUpdateContest      POST /api/admin/contest-update
//   adminContestStatus      POST /api/admin/contest-status
//   adminContestRegenerate  POST /api/admin/contest-regenerate
//   adminContestSetCode     POST /api/admin/contest-set-code
//   adminContestExamTime    POST /api/admin/contest-exam-time
//
// Owned helpers that move WITH the routes (currently used only here):
//   instantiateTemplatePayload   — snapshot-on-instantiate (S-I §1.4.1)
//   requirePublishedProblems     — published-right-now guard (S-I §1.4.4)
//   enforceContestProblemsEditRules — veto-able defaults (S-I §1.4.5)
//
// Factory (not a configure-mutated singleton) for the same per-?buster-instance
// isolation reason as makeAuth / makeAdminTemplatesRoutes: contest tests import
// the handler with a ?buster and swap the fake Firestore via __setClientsForTest
// — getFirestore is therefore taken as a GETTER so the swap propagates (the live
// handle is never captured by value).
//
// enforceContestProblemsEditRules carries the ONE scoped query in this block
// (scopedQuery over SUBMISSIONS_COLLECTION) — it goes through the scopedQuery
// chokepoint, NOT a raw contest_slug equality filter, so scopingLint's allowlist
// stays {handler.mjs: 4}.
//
// endAllLiveSessions is owned by handler.mjs (it carries raw-where #2, moves at
// B14). adminContestExamTime calls it for the end_now sweep, so it arrives BY
// REFERENCE through ctx — single-source, never forked.
//
// Dependency direction (conventions): handler.mjs → routes/* → (src domain
// modules, lib/*). Nothing is imported here — every dependency (the live
// Firestore getter, the auth guard, the http transport helpers, the env-captured
// collection names, the contests/templates/problems domain fns, the contest-
// problems reader, and the resident endAllLiveSessions sweep) arrives through
// ctx, so the env-capture-at-load semantics stay in handler.mjs (env-lint).

export function makeAdminContestsRoutes(ctx) {
  const {
    getFirestore,
    requireAdmin,
    parseBody,
    requireFields,
    badRequest,
    httpError,
    httpErrorWith,
    // env-captured collection names (by value at handler load)
    contestsCollection,
    submissionsCollection,
    // contest-scope chokepoint (by reference)
    scopedQuery,
    // contests domain (src/contests.mjs)
    listContests,
    createContest,
    updateContest,
    setContestStatus,
    regenerateContestSecret,
    setContestAccessCode,
    applyContestExamTime,
    // templates domain (src/templates.mjs)
    getTemplate,
    normalizeProblemEntries,
    // problems domain (src/problems.mjs)
    getProblem,
    getBankProblem,
    // contest-problems reader (src/contestProblems.mjs)
    contestProblemEntries,
    // resident sweep owned by handler.mjs (raw-where #2; moves at B14), by reference
    endAllLiveSessions
  } = ctx;

  async function adminListContests(req) {
    requireAdmin(req);
    const includeArchived = ["1", "true"].includes(String(req.query?.include_archived ?? "").toLowerCase());
    // Hide ephemeral __healthcheck-* canaries from the ADMIN-FACING list (the
    // Contests panel + scope picker consume this route). The hide is at the
    // RESPONSE layer ONLY — the shared listContests() still returns them so the
    // health check's orphanSweep can find + purge leftover canaries. slugify()
    // strips leading underscores, so no real contest slug can start with "__".
    const contests = await listContests({ includeArchived });
    return { contests: contests.filter((c) => !String(c.slug || "").startsWith("__healthcheck-")) };
  }

  async function adminCreateContest(req) {
    requireAdmin(req);
    const body = parseBody(req);
    let payload = body;
    if (body.template_slug !== undefined && body.template_slug !== null && String(body.template_slug).trim() !== "") {
      payload = await instantiateTemplatePayload(body);
    } else if (body.problems !== undefined && Array.isArray(body.problems) && body.problems.length) {
      // Direct problems[] (no template): same published-right-now rule.
      const checked = normalizeProblemEntries(body.problems);
      if (!checked.ok) return badRequest(checked.error);
      await requirePublishedProblems(checked.entries, "problems_unavailable");
    }
    return { ok: true, contest: await createContest(payload) };
  }

  // S-I §1.4.1: snapshot-on-instantiate — copy the template's problems[] and
  // every defaults.* field onto the contest doc AS THE CONTEST'S OWN FIELDS.
  // Body values win over template defaults (the create form pre-fills, the admin
  // may edit before posting). duration_minutes only PREFILLS end_at; an explicit
  // end_at always wins. Template edits after this moment change nothing.
  async function instantiateTemplatePayload(body) {
    const template = await getTemplate(body.template_slug);
    if (!template) throw httpError(404, "template_not_found");
    if (template.archived) throw httpError(400, "template_archived");

    let entries = template.problems || [];
    if (body.problems !== undefined) {
      const checked = normalizeProblemEntries(body.problems);
      if (!checked.ok) return badRequest(checked.error);
      entries = checked.entries;
    }
    // §1.4.4: every entry must reference an existing PUBLISHED problem right now.
    await requirePublishedProblems(entries, "template_problems_unavailable");

    const defaults = template.defaults || {};
    let endAt = body.end_at;
    if ((endAt === undefined || endAt === null || endAt === "") && body.start_at) {
      const startMs = Date.parse(String(body.start_at));
      if (Number.isFinite(startMs)) {
        endAt = new Date(startMs + (defaults.duration_minutes ?? 120) * 60_000).toISOString();
      }
    }
    const pick = (bodyValue, templateValue) => (bodyValue !== undefined ? bodyValue : templateValue);
    return {
      name: body.name,
      listed: body.listed,
      start_at: body.start_at,
      end_at: endAt,
      problems: entries.map((entry) => ({ ...entry })), // the contest's own copy
      template_slug: template.slug,                      // display-only provenance
      identity_label: pick(body.identity_label, defaults.identity_label),
      // Dress-rehearsal finding (2026-06-12): rooms was silently DROPPED on
      // template-instantiate while direct creates accept it — forward it.
      rooms: body.rooms,
      room_gate_enabled: pick(body.room_gate_enabled, defaults.room_gate_enabled),
      camera_recording: pick(body.camera_recording, defaults.camera_recording),
      screen_markers: pick(body.screen_markers, defaults.screen_markers),
      enforcement: pick(body.enforcement, defaults.enforcement),
      evidence_retention_days: pick(body.evidence_retention_days, defaults.evidence_retention_days),
      languages: pick(body.languages, defaults.languages)
    };
  }

  // Contest problems must be servable to candidates the moment the contest can
  // open: existing published bank/seed docs only. Reasons: draft|missing.
  async function requirePublishedProblems(entries, errorName) {
    const unavailable = [];
    for (const entry of entries) {
      if (await getProblem(entry.problem_id)) continue;
      const bank = await getBankProblem(entry.problem_id);
      unavailable.push({ problem_id: entry.problem_id, reason: bank ? "draft" : "missing" });
    }
    if (unavailable.length) throw httpErrorWith(400, errorName, { problems: unavailable });
  }

  async function adminUpdateContest(req) {
    requireAdmin(req);
    const body = parseBody(req);
    requireFields(body, ["slug"]);
    if (body.problems !== undefined) await enforceContestProblemsEditRules(String(body.slug), body);
    return { ok: true, contest: await updateContest(String(body.slug), body) };
  }

  // S-I §1.4.5 (veto-able defaults): contest problems[] edits are free while
  // draft; once OPEN —
  //   adding an entry            -> requires body.confirm === true
  //   removing an entry that has stored submissions in THIS contest -> 409
  //   changing an entry's points -> typed contest-slug confirmation (best scores
  //     are computed live, so the change applies retroactively)
  async function enforceContestProblemsEditRules(slug, body) {
    const doc = await getFirestore().collection(contestsCollection).doc(slug).get();
    if (!doc.exists) throw httpError(404, "contest_not_found");
    const existing = doc.data();

    const checked = normalizeProblemEntries(Array.isArray(body.problems) && body.problems.length ? body.problems : []);
    const entries = checked.ok ? checked.entries : [];
    if (Array.isArray(body.problems) && body.problems.length && !checked.ok) return badRequest(checked.error);
    await requirePublishedProblems(entries, "problems_unavailable");

    if (existing.status !== "open") return; // draft/archived edits are free

    const oldEntries = contestProblemEntries(existing);
    const oldById = new Map(oldEntries.map((entry) => [entry.problem_id, entry]));
    const newById = new Map(entries.map((entry) => [entry.problem_id, entry]));

    const added = entries.filter((entry) => !oldById.has(entry.problem_id));
    if (added.length && body.confirm !== true) {
      throw httpErrorWith(409, "problem_add_requires_confirm", {
        problems: added.map((entry) => entry.problem_id)
      });
    }

    for (const entry of oldEntries) {
      if (newById.has(entry.problem_id)) continue;
      // Removal: blocked when this contest already stored submissions for it.
      const snapshot = await scopedQuery(getFirestore().collection(submissionsCollection), existing)
        .where("problem_id", "==", entry.problem_id)
        .limit(1)
        .get();
      if (snapshot.docs.length) {
        throw httpErrorWith(409, "problem_has_submissions", { problem_id: entry.problem_id });
      }
    }

    const pointsEdited = entries.filter((entry) =>
      oldById.has(entry.problem_id)
      && (oldById.get(entry.problem_id).points ?? null) !== (entry.points ?? null));
    if (pointsEdited.length && body.confirm_points_edit !== existing.slug) {
      throw httpErrorWith(409, "points_edit_confirmation_required", {
        contest: existing.slug,
        problems: pointsEdited.map((entry) => entry.problem_id)
      });
    }
  }

  async function adminContestStatus(req) {
    requireAdmin(req);
    const body = parseBody(req);
    requireFields(body, ["slug", "status"]);
    return { ok: true, contest: await setContestStatus(String(body.slug), String(body.status)) };
  }

  // S-D: POST /api/admin/contest-regenerate {slug, field} — mint a fresh
  // access_code or invigilator_key (vision §2.7: both are regenerate-able).
  async function adminContestRegenerate(req) {
    requireAdmin(req);
    const body = parseBody(req);
    requireFields(body, ["slug", "field"]);
    return { ok: true, contest: await regenerateContestSecret(String(body.slug), String(body.field)) };
  }

  // W4: POST /api/admin/contest-set-code {slug, access_code} — set a CUSTOM test
  // code. contests.mjs owns the format rule (6 chars, mint alphabet) and the
  // unique-among-OPEN-contests check.
  async function adminContestSetCode(req) {
    requireAdmin(req);
    const body = parseBody(req);
    requireFields(body, ["slug", "access_code"]);
    return { ok: true, contest: await setContestAccessCode(String(body.slug), String(body.access_code)) };
  }

  // S-D: POST /api/admin/contest-exam-time {slug, end_at|extend_minutes|end_now}
  // — the legacy S5 exam-time card, per contest. contests.mjs owns the doc write;
  // end_now additionally ends every live session in THIS contest's scope (same
  // paginated sweep as the legacy endpoint).
  async function adminContestExamTime(req) {
    requireAdmin(req);
    const body = parseBody(req);
    requireFields(body, ["slug"]);
    const { contest, field, now } = await applyContestExamTime(String(body.slug), body);
    let endedCount = 0;
    if (field === "end_now") {
      endedCount = await endAllLiveSessions(contest.slug, now);
    }
    return { ok: true, start_at: contest.start_at, end_at: contest.end_at, server_now: now, ended_count: endedCount };
  }

  return {
    // route handlers — names match the dispatch table exactly so handler.mjs's
    // dispatch lines stay byte-identical (canaryIsolation). All auth-first
    // (routesAuthLint).
    adminListContests,
    adminCreateContest,
    adminUpdateContest,
    adminContestStatus,
    adminContestRegenerate,
    adminContestSetCode,
    adminContestExamTime
  };
}
