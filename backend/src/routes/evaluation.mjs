// backend/src/routes/evaluation.mjs — the candidate-evaluation route domain as
// a FACTORY (P1, plan §2.1 routes). makeEvaluationRoutes(ctx) closes over the
// handler-built ctx and returns the two admin route handlers. Both are
// AUTH-FIRST: requireAdmin(req) is the first statement (routesAuthLint pins
// this). Evaluation runs AFTER a contest closes, so the contest is resolved with
// requireOpen:false; an unknown/blank slug is a 400 (badRequest), never a 500.
//
// Dependency direction (conventions): handler.mjs → routes/* → src domain
// modules. This module imports nothing — everything (the admin guard, body
// parser, 400 helper, the makeEvaluation instance, and resolveContest) arrives
// through ctx, exactly like makeInvigilatorRoutes.

// The SINGLE source of truth for the eval-route allowlist: the exact
// "METHOD /path" dispatch keys these three handlers are wired under in
// handler.mjs. The proctor-eval entry (eval-server.mjs) derives its path
// allowlist (and its OPTIONS-preflight gate) from THIS set via handler.mjs's
// re-export, so the eval service can never serve a route the routes module
// doesn't declare, and the allowlist can never drift from the wiring (#112
// LOW-8). Keep these strings in lockstep with handler.mjs's dispatch lines for
// the eval domain.
export const EVAL_ROUTE_KEYS = Object.freeze([
  "POST /api/admin/contest-evaluate",
  "GET /api/admin/contest-evaluations",
  "GET /api/admin/contest-evaluate-status"
]);

export function makeEvaluationRoutes(ctx) {
  const { requireAdmin, parseBody, badRequest, resolveContest, evaluation } = ctx;

  // POST /api/admin/contest-evaluate — admin-triggered, cursor-batched evaluator.
  // Body { contest, limit?=25, cursor?, force? }. Evaluates up to `limit`
  // identities per call and returns { evaluated, skipped, cursor?, done,
  // meta_written? } so the UI can loop until done. Unknown contest → 400.
  async function adminContestEvaluate(req) {
    requireAdmin(req);
    const body = parseBody(req) || {};
    const slug = String(body.contest || "").trim();
    if (!slug) return badRequest("contest is required");
    let contest;
    try {
      contest = await resolveContest(slug, { requireOpen: false });
    } catch {
      return badRequest("unknown_contest");
    }
    return evaluation.evaluateContestBatch({
      contestSlug: contest.slug,
      limit: body.limit,
      cursor: body.cursor,
      force: body.force === true,
    });
  }

  // GET /api/admin/contest-evaluations?contest=<slug>[&identity=|&person_id=] —
  // all scorecards for the contest (+ the contest meta doc), optionally filtered
  // to one identity. Contest-scoped read (the list goes through scopedQuery on
  // the evaluations collection inside makeEvaluation). Unknown contest → 400.
  async function adminContestEvaluations(req) {
    requireAdmin(req);
    const slug = String(req.query?.contest ?? req.query?.contest_slug ?? "").trim();
    if (!slug) return badRequest("contest is required");
    const identity = req.query?.identity ?? req.query?.person_id ?? null;
    let contest;
    try {
      contest = await resolveContest(slug, { requireOpen: false });
    } catch {
      return badRequest("unknown_contest");
    }
    return evaluation.listEvaluations(contest.slug, identity);
  }

  // GET /api/admin/contest-evaluate-status?contest=<slug> — the current run
  // progress {status,total,processed,cursor,run_id,...} from the `__job::{slug}`
  // doc, so the UI can drive a "X / total" progress bar + resume from the SERVER
  // cursor on a transient error. Auth-first (routesAuthLint). Unknown slug → 400.
  async function adminContestEvaluateStatus(req) {
    requireAdmin(req);
    const slug = String(req.query?.contest ?? req.query?.contest_slug ?? "").trim();
    if (!slug) return badRequest("contest is required");
    let contest;
    try {
      contest = await resolveContest(slug, { requireOpen: false });
    } catch {
      return badRequest("unknown_contest");
    }
    return evaluation.evaluateStatus(contest.slug);
  }

  return { adminContestEvaluate, adminContestEvaluations, adminContestEvaluateStatus };
}
