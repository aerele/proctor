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
// receives the SAME env + the signer-key secret at deploy time (see
// docs/DEPLOY.md for the eval-service deploy).
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
import { api, corsOrigin, EVAL_ROUTE_KEYS } from "./handler.mjs";
import { send, setCors } from "./lib/http.mjs";
import { EVAL_UI_HTML, getClientAppSource, getRecommendModuleSource } from "./evalUiPage.mjs";

// The ONLY routes proctor-eval serves. DERIVED from EVAL_ROUTE_KEYS — the single
// source of truth declared in routes/evaluation.mjs (re-exported via handler.mjs)
// alongside the handlers themselves — so this allowlist can NEVER drift from the
// routes routes/evaluation.mjs actually wires (#112 LOW-8). Each key is a
// "METHOD /path" string matching `${req.method} ${requestPath(req)}` below.
const EVAL_ROUTES = new Set(EVAL_ROUTE_KEYS);

// The PATHS of those routes (the second token of each "METHOD /path" key), used
// to gate the OPTIONS preflight forward: a preflight is forwarded ONLY for a path
// the eval service serves. Also derived from EVAL_ROUTE_KEYS so it can't drift.
const EVAL_PATHS = new Set(EVAL_ROUTE_KEYS.map((key) => key.slice(key.indexOf(" ") + 1)));

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
  // EVAL-EXCLUSIVE /eval-ui (+ its two static assets) — handled DIRECTLY here,
  // BEFORE the forward-to-`api` allowlist, so they are served ONLY by
  // proctor-eval (handler.mjs's `api` never sees them). The frontend's
  // "Evaluation" tab embeds /eval-ui in an iframe, so the eval team can rewrite
  // the page freely (post-split) with no frontend/API change.
  //
  //   GET /eval-ui              -> the static page shell (no server-side data;
  //                                the client reads ?contest itself, so there is
  //                                no server-side XSS surface).
  //   GET /eval-ui/app.js       -> the browser app (evalUiClient.js).
  //   GET /eval-ui/recommend.js -> the SAME pure recommendation module the node
  //                                tests pin (evaluationRecommend.mjs), served
  //                                verbatim so the page logic == the tested logic.
  //
  // The page SELF-AUTHENTICATES (the parent passes no token): it asks for the
  // admin password and replays it as x-admin-password on its same-origin fetch to
  // GET /api/admin/contest-evaluations. So these three routes expose nothing
  // privileged — only static HTML/JS — and need no auth themselves.
  //
  // FRAMING: we set CORS (the eval origin) but deliberately DO NOT emit
  // X-Frame-Options / a frame-blocking CSP, so the proctor-web origin can iframe
  // the page. (setCors does not add any framing header; we keep it that way.)
  if (req.method === "GET") {
    const path = requestPath(req);
    if (path === "/eval-ui") {
      setCors(res, corsOrigin);
      res.set("content-type", "text/html; charset=utf-8");
      return res.status(200).send(EVAL_UI_HTML);
    }
    if (path === "/eval-ui/app.js") {
      setCors(res, corsOrigin);
      res.set("content-type", "text/javascript; charset=utf-8");
      res.set("cache-control", "no-store");
      return res.status(200).send(getClientAppSource());
    }
    if (path === "/eval-ui/recommend.js") {
      setCors(res, corsOrigin);
      res.set("content-type", "text/javascript; charset=utf-8");
      res.set("cache-control", "no-store");
      return res.status(200).send(getRecommendModuleSource());
    }
  }
  // OPTIONS preflight: forward to `api` (which emits setCors + 204) ONLY for a
  // path the eval service actually serves — i.e. the path of one of the eval API
  // routes (the browser preflights the SAME path it will then POST/GET). Gating
  // on EVAL_ROUTES membership (#112 LOW-7) means a preflight for an unrelated
  // path is a CORS-headed 404 here, never forwarded to the shared handler. The
  // /eval-ui* assets are GET-only same-origin self-fetches that need no preflight.
  const path = requestPath(req);
  if (req.method === "OPTIONS") {
    if (EVAL_PATHS.has(path)) return api(req, res);
    setCors(res, corsOrigin);
    return send(res, 404, { error: "Not found" });
  }
  const key = `${req.method} ${path}`;
  if (EVAL_ROUTES.has(key)) return api(req, res);
  setCors(res, corsOrigin);
  return send(res, 404, { error: "Not found" });
};
