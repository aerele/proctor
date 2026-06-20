// backend/test/evalServerEntry.test.mjs — the proctor-eval ENTRY (src/eval-server.mjs).
//
// Pins the deploy-isolation contract of the separate eval service:
//   * the `evalApi` target MOUNTS the three eval routes (POST contest-evaluate,
//     GET contest-evaluations, GET contest-evaluate-status) — they reach the
//     shared, fully-wired handler and run end-to-end against a fake Firestore +
//     GCS, identically to proctor-api;
//   * those routes are AUTH-FIRST: a missing/wrong x-admin-password is 401/403;
//   * EVERY non-eval route (a test-taking path like POST /api/session/start, or
//     another admin path) is a 404 on this service — the test-taking surface is
//     NOT exposed on proctor-eval (the whole point of the split);
//   * the CORS preflight (OPTIONS) is served (204) with CORS headers, so the
//     cross-origin admin SPA can call the eval service.
//
// Mirrors evaluationRoutes.test.mjs's fake-firestore + fake-storage + handler
// import-with-?buster pattern, but drives the request through `evalApi` instead
// of `api`, so the allowlist + the shared dispatch are both exercised.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.EVIDENCE_BUCKET = "ev-bucket";
process.env.SESSION_COLLECTION = "es_sessions";
process.env.CONTESTS_COLLECTION = "es_contests";
process.env.ROSTER_COLLECTION = "es_roster";
process.env.SUBMISSIONS_COLLECTION = "es_submissions";
process.env.PROBLEMS_COLLECTION = "es_problems";
process.env.COLLEGES_COLLECTION = "es_colleges";
process.env.PERSONS_COLLECTION = "es_persons";
process.env.ENROLLMENTS_COLLECTION = "es_enrollments";
process.env.ADMIN_AUDIT_COLLECTION = "es_audit";
process.env.EVALUATIONS_COLLECTION = "es_evaluations";
process.env.ADMIN_PASSWORD = "es-admin-pass";
// Tighten CORS so we can assert the eval service echoes the configured origin
// (the admin SPA origin) rather than the "*" default.
process.env.PUBLIC_APP_ORIGIN = "https://proctor-web.example";

// The eval ENTRY (evalApi) and the shared client seam come off index's eval
// surface; __setClientsForTest is re-exported from handler.mjs (which
// eval-server.mjs imports). A fresh ?buster keeps env capture isolated.
const handler = await import("../src/handler.mjs?evalserver");
const evalServer = await import("../src/eval-server.mjs?evalserver");
const { __setClientsForTest } = handler;
const { evalApi } = evalServer;

const ADMIN_HEADERS = { "x-admin-password": "es-admin-pass" };

function makeReq({ method, path, headers = {}, body, query = {} }) {
  const lowerHeaders = {};
  for (const [k, v] of Object.entries(headers)) lowerHeaders[k.toLowerCase()] = v;
  return { method, path, headers: lowerHeaders, query, body,
    get(name) { return lowerHeaders[String(name).toLowerCase()]; } };
}
function makeRes() {
  return { statusCode: null, body: null, headers: {},
    set(k, v) { this.headers[String(k).toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    send(p) { this.body = p; return this; } };
}
async function call(req) { const res = makeRes(); await evalApi(req, res); return res; }

// Minimal fake Firestore (equality-filter aware) + fake Storage, same shape as
// evaluationRoutes.test.mjs — enough to drive the eval routes end-to-end.
function makeFakeFirestore() {
  const collections = new Map();
  function getCollection(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  }
  function makeQuery(name, filters, ordering) {
    return {
      where(field, op, value) { return makeQuery(name, [...filters, { field, op, value }], ordering); },
      orderBy(field, direction) { return makeQuery(name, filters, { field, direction }); },
      limit() { return this; },
      async get() {
        let docs = [...getCollection(name).values()];
        for (const { field, op, value } of filters) {
          if (op === "in") docs = docs.filter((doc) => Array.isArray(value) && value.includes(doc[field]));
          else docs = docs.filter((doc) => doc[field] === value);
        }
        if (ordering) {
          docs = docs.sort((a, b) => {
            const cmp = String(a[ordering.field] ?? "").localeCompare(String(b[ordering.field] ?? ""));
            return ordering.direction === "desc" ? -cmp : cmp;
          });
        }
        return { docs: docs.map((data) => ({ data: () => data })) };
      }
    };
  }
  return {
    _collections: collections,
    collection(name) {
      const query = makeQuery(name, []);
      const store = getCollection(name);
      return {
        where: query.where, orderBy: query.orderBy, limit: query.limit, get: query.get,
        doc(id) {
          return {
            id,
            async create(value) { if (store.has(id)) { const e = new Error("ALREADY_EXISTS"); e.code = 6; throw e; } store.set(id, { ...value }); },
            async set(value, options) { const existing = options?.merge ? store.get(id) || {} : {}; store.set(id, { ...existing, ...value }); },
            async update(value) { const existing = store.get(id); if (!existing) throw new Error(`missing ${id}`); store.set(id, { ...existing, ...value }); },
            async delete() { store.delete(id); },
            async get() { const data = store.get(id); return { exists: Boolean(data), data: () => data }; }
          };
        }
      };
    }
  };
}
function makeFakeStorage(objects = new Map()) {
  return {
    bucket() {
      return {
        file(key) {
          return {
            async save(contents) { objects.set(key, String(contents)); },
            async getSignedUrl() { return [`https://signed.example/${key}`]; },
            async download() { return [objects.get(key) || ""]; }
          };
        },
        async getFiles({ prefix } = {}) {
          const matched = [];
          for (const key of objects.keys()) {
            if (!prefix || key.startsWith(prefix)) matched.push({ name: key, async download() { return [objects.get(key) || ""]; } });
          }
          return [matched];
        }
      };
    }
  };
}
function freshClients() {
  __setClientsForTest({ firestore: makeFakeFirestore(), storage: makeFakeStorage() });
}

// ---- the eval routes are MOUNTED on evalApi --------------------------------
// They reach the shared handler: an unknown contest is the eval route's own 400
// (not the entry's 404), which proves the request hit the eval handler — not the
// allowlist's "Not found" fallthrough.

test("evalApi MOUNTS POST /api/admin/contest-evaluate (reaches eval handler → 400 unknown contest, not entry 404)", async () => {
  freshClients();
  const res = await call(makeReq({ method: "POST", path: "/api/admin/contest-evaluate", headers: ADMIN_HEADERS, body: { contest: "no-such" } }));
  assert.equal(res.statusCode, 400, JSON.stringify(res.body));
});

test("evalApi MOUNTS GET /api/admin/contest-evaluations (→ 400 unknown contest)", async () => {
  freshClients();
  const res = await call(makeReq({ method: "GET", path: "/api/admin/contest-evaluations", headers: ADMIN_HEADERS, query: { contest: "no-such" } }));
  assert.equal(res.statusCode, 400, JSON.stringify(res.body));
});

test("evalApi MOUNTS GET /api/admin/contest-evaluate-status (→ 400 unknown contest)", async () => {
  freshClients();
  const res = await call(makeReq({ method: "GET", path: "/api/admin/contest-evaluate-status", headers: ADMIN_HEADERS, query: { contest: "no-such" } }));
  assert.equal(res.statusCode, 400, JSON.stringify(res.body));
});

// ---- auth-first: a non-admin caller is rejected on every eval route ---------

test("evalApi REJECTS non-admin on every eval route (401/403)", async () => {
  freshClients();
  const noHeaderPost = await call(makeReq({ method: "POST", path: "/api/admin/contest-evaluate", body: { contest: "x" } }));
  assert.ok([401, 403].includes(noHeaderPost.statusCode), JSON.stringify(noHeaderPost.body));

  const badPassPost = await call(makeReq({ method: "POST", path: "/api/admin/contest-evaluate", headers: { "x-admin-password": "wrong" }, body: { contest: "x" } }));
  assert.ok([401, 403].includes(badPassPost.statusCode), JSON.stringify(badPassPost.body));

  const noHeaderGet = await call(makeReq({ method: "GET", path: "/api/admin/contest-evaluations", query: { contest: "x" } }));
  assert.ok([401, 403].includes(noHeaderGet.statusCode), JSON.stringify(noHeaderGet.body));

  const noHeaderStatus = await call(makeReq({ method: "GET", path: "/api/admin/contest-evaluate-status", query: { contest: "x" } }));
  assert.ok([401, 403].includes(noHeaderStatus.statusCode), JSON.stringify(noHeaderStatus.body));
});

// ---- DEPLOY ISOLATION: the test-taking + non-eval routes are NOT exposed -----

test("evalApi 404s a test-taking route (POST /api/session/start) — not exposed on proctor-eval", async () => {
  freshClients();
  const res = await call(makeReq({ method: "POST", path: "/api/session/start", body: { hackerrank_username: "x" } }));
  assert.equal(res.statusCode, 404, JSON.stringify(res.body));
  assert.equal(res.body.error, "Not found");
});

test("evalApi 404s a non-eval admin route (GET /api/admin/contests) even WITH admin auth", async () => {
  freshClients();
  const res = await call(makeReq({ method: "GET", path: "/api/admin/contests", headers: ADMIN_HEADERS }));
  assert.equal(res.statusCode, 404, JSON.stringify(res.body));
  assert.equal(res.body.error, "Not found");
});

test("evalApi 404s a non-eval exec route (POST /api/exec/run)", async () => {
  freshClients();
  const res = await call(makeReq({ method: "POST", path: "/api/exec/run", headers: ADMIN_HEADERS, body: {} }));
  assert.equal(res.statusCode, 404, JSON.stringify(res.body));
});

// The eval routes themselves must NOT respond to the wrong METHOD (a GET to the
// POST-only evaluate route is a 404, not a mis-dispatch).
test("evalApi 404s the wrong method on an eval path (GET /api/admin/contest-evaluate)", async () => {
  freshClients();
  const res = await call(makeReq({ method: "GET", path: "/api/admin/contest-evaluate", headers: ADMIN_HEADERS }));
  assert.equal(res.statusCode, 404, JSON.stringify(res.body));
});

// ---- CORS: preflight + origin echo so the cross-origin admin SPA can call -----

test("evalApi serves the CORS preflight (OPTIONS → 204) with the configured origin + admin header allowed", async () => {
  freshClients();
  const res = await call(makeReq({ method: "OPTIONS", path: "/api/admin/contest-evaluate" }));
  assert.equal(res.statusCode, 204, JSON.stringify(res.body));
  assert.equal(res.headers["access-control-allow-origin"], "https://proctor-web.example");
  assert.match(res.headers["access-control-allow-headers"], /x-admin-password/);
});

// #112 LOW-7: the OPTIONS preflight is forwarded to the shared handler ONLY for a
// path the eval service actually serves (an EVAL_ROUTES path). A preflight for any
// OTHER path (a test-taking route, a non-eval admin route) is a CORS-headed 404
// emitted by the entry — it is NOT forwarded to `api`.
test("evalApi does NOT forward an OPTIONS preflight for a non-eval path (404, not forwarded)", async () => {
  freshClients();
  const sessionPreflight = await call(makeReq({ method: "OPTIONS", path: "/api/session/start" }));
  assert.equal(sessionPreflight.statusCode, 404, JSON.stringify(sessionPreflight.body));
  assert.equal(sessionPreflight.body.error, "Not found");
  // Still CORS-headed so a cross-origin caller reads the JSON 404, not a CORS error.
  assert.equal(sessionPreflight.headers["access-control-allow-origin"], "https://proctor-web.example");

  const adminPreflight = await call(makeReq({ method: "OPTIONS", path: "/api/admin/contests" }));
  assert.equal(adminPreflight.statusCode, 404, JSON.stringify(adminPreflight.body));
});

test("evalApi DOES forward the OPTIONS preflight for every eval API path (204)", async () => {
  freshClients();
  for (const path of ["/api/admin/contest-evaluate", "/api/admin/contest-evaluations", "/api/admin/contest-evaluate-status"]) {
    const res = await call(makeReq({ method: "OPTIONS", path }));
    assert.equal(res.statusCode, 204, `${path}: ${JSON.stringify(res.body)}`);
    assert.equal(res.headers["access-control-allow-origin"], "https://proctor-web.example");
  }
});

test("evalApi applies CORS headers to its 404 fallthrough (cross-origin caller reads the 404, not a CORS error)", async () => {
  freshClients();
  const res = await call(makeReq({ method: "GET", path: "/api/admin/contests", headers: ADMIN_HEADERS }));
  assert.equal(res.statusCode, 404);
  assert.equal(res.headers["access-control-allow-origin"], "https://proctor-web.example");
});

// ---- /eval-ui: the EVAL-EXCLUSIVE embeddable recommendation page -------------
// Served DIRECTLY by the eval entry (before the allowlist), so the frontend's
// Evaluation tab can iframe ${evalApiBaseUrl}/eval-ui and the eval team owns the
// page. The page is a STATIC shell (no server-side data interpolation): it reads
// ?contest itself and self-authenticates (asks for the admin password, replays
// it as x-admin-password on its own same-origin fetch), so the three /eval-ui
// routes expose only static HTML/JS and need no auth.

test("evalApi serves GET /eval-ui as 200 text/html — the static app shell, iframe-embeddable", async () => {
  freshClients();
  const res = await call(makeReq({ method: "GET", path: "/eval-ui", query: { contest: "mcet-june-2026" } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.match(String(res.headers["content-type"]), /text\/html/);
  assert.match(String(res.headers["content-type"]), /charset=utf-8/);
  const html = String(res.body);
  assert.match(html, /<title>Evaluation<\/title>/);
  // The shell loads the client app module; all data is fetched + rendered client-side.
  assert.match(html, /<script type="module" src="\/eval-ui\/app\.js">/);
  assert.match(html, /id="root"/);
});

test("GET /eval-ui does NOT reflect the contest param into the document (no server-side XSS surface)", async () => {
  freshClients();
  const evil = "<script>alert(1)</script>";
  const res = await call(makeReq({ method: "GET", path: "/eval-ui", query: { contest: evil } }));
  assert.equal(res.statusCode, 200);
  const html = String(res.body);
  // The shell is identical regardless of the query — the slug never touches the
  // server-rendered HTML (the client reads it from location), so there is nothing
  // to escape and no injection vector here.
  assert.ok(!html.includes("alert(1)"), "contest param leaked into the server-rendered page");
});

test("GET /eval-ui/app.js serves the browser client as text/javascript", async () => {
  freshClients();
  const res = await call(makeReq({ method: "GET", path: "/eval-ui/app.js" }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.match(String(res.headers["content-type"]), /javascript/);
  const js = String(res.body);
  // It imports the shared pure recommendation module and self-authenticates.
  assert.match(js, /\/eval-ui\/recommend\.js/);
  assert.match(js, /x-admin-password/);
});

test("GET /eval-ui/recommend.js serves the SAME pure module the node tests pin", async () => {
  freshClients();
  const res = await call(makeReq({ method: "GET", path: "/eval-ui/recommend.js" }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.match(String(res.headers["content-type"]), /javascript/);
  const js = String(res.body);
  assert.match(js, /export function computeRecommendationReport/);
});

test("GET /eval-ui does NOT set a frame-blocking header (X-Frame-Options / frame-ancestors) — must be iframe-embeddable", async () => {
  freshClients();
  const res = await call(makeReq({ method: "GET", path: "/eval-ui", query: { contest: "c" } }));
  assert.equal(res.statusCode, 200);
  // No X-Frame-Options at all (DENY/SAMEORIGIN would break the proctor-web embed).
  assert.equal(res.headers["x-frame-options"], undefined);
  // No CSP frame-ancestors lock-out either.
  const csp = res.headers["content-security-policy"];
  if (csp) assert.ok(!/frame-ancestors/i.test(String(csp)), "CSP frame-ancestors would block embedding");
});

// /eval-ui is EVAL-EXCLUSIVE: the wrong method on it falls through to the normal
// allowlist 404 (it is NOT one of the 3 eval API routes).
test("evalApi 404s a non-GET on /eval-ui (POST /eval-ui is not a route)", async () => {
  freshClients();
  const res = await call(makeReq({ method: "POST", path: "/eval-ui" }));
  assert.equal(res.statusCode, 404, JSON.stringify(res.body));
  assert.equal(res.body.error, "Not found");
});
