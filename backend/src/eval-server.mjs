// backend/src/eval-server.mjs — the proctor-eval service ENTRY.
//
// WHY THIS EXISTS (deploy isolation, NOT data isolation)
// ------------------------------------------------------
// The candidate-evaluation / data-processing path (the P3 redesign target) gets
// its OWN Cloud Run service `proctor-eval` so it can be redeployed WITHOUT ever
// touching the test-taking service `proctor-api`. The test-taking path therefore
// stays zero-risk: a bad eval deploy can never take down an in-progress exam.
//
// `proctor-eval` SHARES the same Firestore + GCS + signer key + config as
// proctor-api — separation is at the DEPLOY boundary, not the data boundary. It
// receives the SAME env (the 15 vars) + the signer-key secret at deploy time
// (see _nightrun/eval-service-deploy.md).
//
// WRAPPER-OVER-FORK (zero eval-logic duplication)
// -----------------------------------------------
// We do NOT re-wire makeEvaluation / makeEvaluationRoutes / configureClients
// here. Instead we import the FULLY-WIRED `api` dispatcher from handler.mjs —
// the exact same instance proctor-api runs, with the same store configuration,
// CORS (setCors/PUBLIC_APP_ORIGIN), preflight handling, x-admin-password auth,
// and eval-route wiring — and put a PATH ALLOWLIST in front of it so only the
// three eval routes (and the CORS preflight) ever reach a handler. Everything
// else is a 404 BEFORE it reaches `api`. This means:
//   * proctor-api stays byte-for-byte UNCHANGED (handler.mjs's `api` is not
//     modified; this entry only consumes its additive `corsOrigin` export);
//   * the eval routes can NEVER diverge from the ones proctor-api serves;
//   * the test-taking routes are unreachable on proctor-eval (404), so a stray
//     session/exec/invigilator call to the eval origin is inert.
//
// ENV-LINT: this module reads NO environment directly (it delegates entirely to
// the already-env-configured `api`, and takes the CORS origin from handler.mjs's
// `corsOrigin` export), so it does not widen the env-lint allowlist (handler.mjs
// + config.mjs remain the only env readers).
import { api, corsOrigin } from "./handler.mjs";
import { send, setCors } from "./lib/http.mjs";

// The ONLY routes proctor-eval serves. Mirrors handler.mjs's dispatch lines for
// the eval domain (POST contest-evaluate, GET contest-evaluations, GET
// contest-evaluate-status). Keep this list in lockstep with routes/evaluation.mjs.
const EVAL_ROUTES = new Set([
  "POST /api/admin/contest-evaluate",
  "GET /api/admin/contest-evaluations",
  "GET /api/admin/contest-evaluate-status"
]);

// Resolve the request path the SAME way handler.mjs's `api` does, so the
// allowlist match and the downstream dispatch agree exactly.
function requestPath(req) {
  return req.path || new URL(req.url, "http://localhost").pathname;
}

// The proctor-eval HTTP entry (functions-framework --target=evalApi).
//
// OPTIONS preflight is forwarded to `api` so the browser gets the EXACT same
// CORS headers proctor-api emits (setCors + 204) — admin eval calls are
// cross-origin from the proctor-web SPA, so the preflight must succeed.
//
// An allowlisted eval route is forwarded to `api`, which applies CORS, runs the
// auth-first guard, and dispatches to the shared eval handler.
//
// Any OTHER path is a 404 emitted HERE, with the same CORS origin applied (so a
// cross-origin caller reads the JSON 404 rather than a CORS error) — it never
// reaches `api`, so the test-taking routes are not exposed on this service.
export const evalApi = async (req, res) => {
  if (req.method === "OPTIONS") return api(req, res);
  const key = `${req.method} ${requestPath(req)}`;
  if (EVAL_ROUTES.has(key)) return api(req, res);
  setCors(res, corsOrigin);
  return send(res, 404, { error: "Not found" });
};
