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

// HTML-escape a string so an attacker-controlled query value (the contest slug)
// cannot inject markup/script when interpolated into the /eval-ui document.
// Covers the five XSS-relevant characters; the slug only ever lands in element
// text + an attribute-free context here, but we escape all five regardless.
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Read the `contest` query param either from req.query (functions-framework
// parses it) or by parsing the URL ourselves (test harness / raw requests).
function contestParam(req) {
  if (req.query && typeof req.query.contest === "string") return req.query.contest;
  try {
    return new URL(req.url, "http://localhost").searchParams.get("contest") || "";
  } catch {
    return "";
  }
}

// The /eval-ui PLACEHOLDER document. EVAL-EXCLUSIVE: this route is served only
// by the proctor-eval entry (never by handler.mjs's `api`), so the eval team can
// rewrite this page + the real P3 evaluation output WITHOUT any frontend/API
// change — the frontend merely embeds ${evalApiBaseUrl}/eval-ui in an iframe.
//
// Tonight this is an intentional, self-contained placeholder (no external
// assets, inline CSS only) showing NO sensitive data, so it needs no auth.
//
// P3 NOTE: when this page renders REAL evaluation data, it will authenticate to
// the eval API itself — the parent (proctor-web) frame will pass a short-lived
// admin token via postMessage (or a query param), which this page replays as
// x-admin-password on its fetches. Not needed tonight (placeholder shows nothing
// privileged), but the embed contract (iframe + ?contest=) is frozen now.
function renderEvalUi(contestRaw) {
  const trimmed = String(contestRaw ?? "").trim();
  const contestText = trimmed ? escapeHtml(trimmed) : "—";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Evaluation</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #1f2933;
    background: #f7f8fa;
    -webkit-font-smoothing: antialiased;
  }
  .wrap {
    min-height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 48px 24px;
  }
  .card {
    width: 100%;
    max-width: 560px;
    background: #ffffff;
    border: 1px solid #e3e7ec;
    border-radius: 14px;
    padding: 40px 36px;
    box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04), 0 8px 24px rgba(16, 24, 40, 0.06);
  }
  h1 {
    margin: 0 0 6px;
    font-size: 22px;
    font-weight: 650;
    letter-spacing: -0.01em;
    color: #101828;
  }
  .served {
    margin: 0 0 20px;
    font-size: 13px;
    color: #667085;
  }
  .meta {
    display: flex;
    gap: 8px;
    align-items: baseline;
    padding: 12px 14px;
    background: #f3f5f8;
    border: 1px solid #e6eaef;
    border-radius: 10px;
    font-size: 14px;
  }
  .meta .label { color: #667085; }
  .meta .value { color: #101828; font-weight: 600; }
  .note {
    margin: 20px 0 0;
    font-size: 13px;
    line-height: 1.55;
    color: #98a2b3;
  }
  @media (prefers-color-scheme: dark) {
    body { color: #e4e7ec; background: #0f1115; }
    .card { background: #161a20; border-color: #262b33; box-shadow: none; }
    h1 { color: #f2f4f7; }
    .served { color: #98a2b3; }
    .meta { background: #1b2027; border-color: #262b33; }
    .meta .value { color: #f2f4f7; }
    .note { color: #6b7280; }
  }
</style>
</head>
<body>
  <main class="wrap">
    <section class="card" role="region" aria-label="Evaluation">
      <h1>Evaluation</h1>
      <p class="served">This page is rendered by the proctor-eval service</p>
      <div class="meta">
        <span class="label">Contest:</span>
        <span class="value">${contestText}</span>
      </div>
      <p class="note">The P3 evaluation output (recommendations, reasoning, selections) will render here.</p>
    </section>
  </main>
</body>
</html>`;
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
  // EVAL-EXCLUSIVE /eval-ui — handled DIRECTLY here, BEFORE the forward-to-`api`
  // allowlist, so this HTML page is served ONLY by proctor-eval (handler.mjs's
  // `api` never sees it). The frontend's "Evaluation" tab embeds this page in an
  // iframe, so the eval team can rewrite it freely (post-P3) with no frontend
  // change.
  //
  // FRAMING: we set CORS (the eval origin) but deliberately DO NOT emit
  // X-Frame-Options / a frame-blocking CSP, so the proctor-web origin can iframe
  // it. (setCors does not add any framing header; we keep it that way.)
  if (req.method === "GET" && requestPath(req) === "/eval-ui") {
    setCors(res, corsOrigin);
    res.set("content-type", "text/html; charset=utf-8");
    return res.status(200).send(renderEvalUi(contestParam(req)));
  }
  if (req.method === "OPTIONS") return api(req, res);
  const key = `${req.method} ${requestPath(req)}`;
  if (EVAL_ROUTES.has(key)) return api(req, res);
  setCors(res, corsOrigin);
  return send(res, 404, { error: "Not found" });
};
