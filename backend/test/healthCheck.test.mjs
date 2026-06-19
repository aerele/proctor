// backend/test/healthCheck.test.mjs — focused tests for the admin pre-flight
// health check (POST /api/admin/health-check). Uses the existing test seams:
// __setClientsForTest (fake Firestore + Storage) and __setJudge0AdapterForTest
// (so LIGHT mode can ASSERT runBatch is never called). A fake fetch stands in
// for the served-bundle / signed-PUT / signed-GET / Judge0-liveness HTTP calls.
//
// Asserts:
//   - the response SHAPE matches the contract (overall/mode/ran_at/duration_ms/
//     checks[]/cleanup), every check is {id,label,status,latency_ms,detail}.
//   - LIGHT mode NEVER calls Judge0 runBatch (no billing mid-exam).
//   - the canary slug is namespaced __healthcheck-*.
//   - teardown ALWAYS runs (cleanup populated) even when a probe throws.
//   - auth: missing/incorrect x-admin-password -> 401.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

process.env.EVIDENCE_BUCKET = "hc-bucket";
process.env.SESSION_COLLECTION = "hc_sessions";
process.env.SETTINGS_COLLECTION = "hc_settings";
process.env.SUBMISSIONS_COLLECTION = "hc_submissions";
process.env.CONTESTS_COLLECTION = "hc_contests";
process.env.LIVE_LOCK_COLLECTION = "hc_live_locks";
process.env.PROBLEMS_COLLECTION = "hc_problems";
process.env.ADMIN_PASSWORD = "hc-admin-pass";
process.env.INVIGILATOR_PASSWORD = "hc-invig-pass";
process.env.PUBLIC_APP_ORIGIN = "https://proctor.example";
process.env.JUDGE0_BASE_URL = "https://judge0.example";
process.env.JUDGE0_MODE = "rapidapi";
process.env.JUDGE0_API_KEY = "hc-judge0-key";

const handler = await import("../src/handler.mjs?healthcheck");
const { api, __setClientsForTest, __setJudge0AdapterForTest } = handler;

// The served bundle carries the HASH VALUES (sha256 of each gate password), not
// the env-var names — so the fake bundle below embeds these and the probe
// asserts their presence (mirrors the live frontend deploy hash-gate).
const sha256Hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const ADMIN_HASH = sha256Hex("hc-admin-pass");
const INVIG_HASH = sha256Hex("hc-invig-pass");

// ---- req/res mocks (copied from the sibling handler tests) ------------------
function makeReq({ method, path, headers = {}, body, query = {} }) {
  const lowerHeaders = {};
  for (const [k, v] of Object.entries(headers)) lowerHeaders[k.toLowerCase()] = v;
  return { method, path, headers: lowerHeaders, query, body,
    get(name) { return lowerHeaders[String(name).toLowerCase()]; } };
}
function makeRes() {
  return { statusCode: null, body: null, headers: {},
    set(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    send(p) { this.body = p; return this; } };
}
async function call(req) { const res = makeRes(); await api(req, res); return res; }
const ADMIN = { "x-admin-password": "hc-admin-pass" };

// ---- fake Firestore (create/set/update/delete/get + where/limit/get) --------
function makeFakeFirestore() {
  const collections = new Map();
  function getCollection(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  }
  function makeQuery(name, filters) {
    return {
      where(field, op, value) { return makeQuery(name, [...filters, { field, op, value }]); },
      limit() { return this; },
      async get() {
        const store = getCollection(name);
        let docs = [...store.entries()].map(([id, data]) => ({ id, data }));
        for (const { field, op, value } of filters) {
          if (op === "in") docs = docs.filter((d) => Array.isArray(value) && value.includes(d.data[field]));
          else docs = docs.filter((d) => d.data[field] === value);
        }
        return { docs: docs.map(({ id, data }) => ({ id, data: () => data })) };
      }
    };
  }
  return {
    _collections: collections,
    collection(name) {
      const store = getCollection(name);
      const query = makeQuery(name, []);
      return {
        where: query.where, limit: query.limit, get: query.get,
        doc(id) {
          return {
            id,
            async create(value) {
              if (store.has(id)) { const err = new Error("ALREADY_EXISTS"); err.code = 6; throw err; }
              store.set(id, { ...value });
            },
            async set(value, options) {
              const existing = options?.merge ? store.get(id) || {} : {};
              store.set(id, { ...existing, ...value });
            },
            async update(value) {
              const existing = store.get(id);
              if (!existing) { const err = new Error("NOT_FOUND"); err.code = 5; throw err; }
              store.set(id, { ...existing, ...value });
            },
            async delete() { store.delete(id); },
            async get() { const data = store.get(id); return { exists: Boolean(data), id, data: () => data }; }
          };
        }
      };
    }
  };
}

// ---- fake Storage (records saved keys; signs URLs; lists by prefix) ---------
function makeFakeStorage() {
  const saved = new Map(); // key -> body
  return {
    _saved: saved,
    bucket() {
      return {
        file(key) {
          return {
            async save(body) { saved.set(key, body); },
            async getSignedUrl() { return [`https://signed.example/${key}`]; },
            async delete() { saved.delete(key); },
            async download() { return [saved.get(key) ?? ""]; }
          };
        },
        async getFiles({ prefix, maxResults } = {}) {
          let names = [...saved.keys()].filter((k) => !prefix || k.startsWith(prefix));
          if (maxResults) names = names.slice(0, maxResults);
          return [names.map((name) => ({
            name,
            metadata: { size: 1, updated: "2026-06-19T00:00:00Z" },
            async getSignedUrl() { return [`https://signed.example/${name}`]; },
            async delete() { saved.delete(name); }
          }))];
        }
      };
    }
  };
}

// ---- fake fetch: a signed PUT MIRRORS a real GCS PUT — it parses the object
// key out of the signed URL (fakeStorage signs as https://signed.example/<key>)
// and writes the body into the SAME _saved map the fake Storage lists from, so
// the post-PUT bucket().getFiles({prefix}) verification (and the later signed
// READ) see the object exactly as production would. Without this the
// infra_gcs_rw / chunk_upload_signed / recordings_read probes could only ever
// be tested for red-propagation; with it they have a real GREEN path.
// GET / returns bundle HTML, GET of a .js returns a bundle WITH both hash
// tokens, GET /languages returns a language array, GET of a signed read URL
// returns the stored bytes (200). ------------------------------------------
const SIGNED_PREFIX = "https://signed.example/";
function makeFakeFetch({ bundleOk = true, saved = new Map() } = {}) {
  const calls = [];
  async function fetchImpl(url, opts = {}) {
    calls.push({ url: String(url), method: opts.method || "GET" });
    const u = String(url);
    const method = opts.method || "GET";
    const ok = (status, text, json) => ({
      ok: status >= 200 && status < 300,
      status,
      async text() { return text ?? ""; },
      async json() { return json ?? JSON.parse(text || "null"); }
    });
    if (method === "PUT") {
      // Mirror a real signed PUT: persist the body under the object key so the
      // list-after-PUT verification (and the signed READ) find it.
      if (u.startsWith(SIGNED_PREFIX)) saved.set(u.slice(SIGNED_PREFIX.length), opts.body ?? "");
      return ok(200, "");
    }
    if (/\/languages$/.test(u)) return ok(200, null, [{ id: 71, name: "Python" }, { id: 54, name: "C++" }]);
    if (/\/$/.test(u) || u === "https://proctor.example") {
      return ok(200, '<html><head><script src="/assets/index-abc123.js"></script></head></html>');
    }
    if (/\.js$/.test(u)) {
      // The Vite build inlines the HASH VALUES (sha256 of the gate passwords),
      // NOT the env-var names — so the bundle_hashes probe asserts those values
      // are present. ADMIN_HASH/INVIG_HASH are sha256("hc-admin-pass") /
      // sha256("hc-invig-pass") (the test's ADMIN_PASSWORD/INVIGILATOR_PASSWORD).
      const body = bundleOk
        ? `const a="${ADMIN_HASH}";const b="${INVIG_HASH}";`
        : 'const a="nope";';
      return ok(200, body);
    }
    // signed read URLs (https://signed.example/<key>) -> 200 with the stored bytes.
    if (u.startsWith(SIGNED_PREFIX)) return ok(200, String(saved.get(u.slice(SIGNED_PREFIX.length)) ?? "chunk-bytes"));
    return ok(200, "chunk-bytes");
  }
  fetchImpl.calls = calls;
  return fetchImpl;
}

function setup({ bundleOk = true } = {}) {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  // The legacy proctor gate isn't on the person-mode start path, but seed a
  // settings doc so getSettings() never returns surprises.
  firestore.collection("hc_settings").doc("active").set({ updated_at: "2026-06-19T00:00:00Z" });
  // The fake fetch shares the Storage _saved map so a signed PUT actually lands
  // the object (mirroring a real GCS PUT) and a signed READ returns its bytes.
  return { firestore, storage, fetch: makeFakeFetch({ bundleOk, saved: storage._saved }) };
}

// Allow the test to inject fetchImpl into the health-check handler. The factory
// reads ctx.fetchImpl, but handler.mjs wires real fetch — so we monkeypatch the
// global fetch for the duration of the call (the factory's default closes over
// globalThis.fetch via (...args)=>fetch(...args), so a global swap propagates).
async function callHealthCheck(body, { fetch }) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    return await call(makeReq({ method: "POST", path: "/api/admin/health-check", headers: ADMIN, body }));
  } finally {
    globalThis.fetch = realFetch;
  }
}

const CHECK_KEYS = ["id", "label", "status", "latency_ms", "detail"];

test("health-check: LIGHT mode returns the contract shape, all checks present, NEVER calls Judge0", async () => {
  const ctx = setup();
  let runBatchCalls = 0;
  __setJudge0AdapterForTest({ runBatch: async () => { runBatchCalls += 1; return []; } });

  const res = await callHealthCheck({ mode: "light" }, ctx);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const b = res.body;
  // Top-level contract.
  assert.equal(b.mode, "light");
  assert.ok(b.overall === "green" || b.overall === "red", `overall: ${b.overall}`);
  assert.ok(typeof b.ran_at === "string" && !Number.isNaN(Date.parse(b.ran_at)), `ran_at: ${b.ran_at}`);
  assert.ok(typeof b.duration_ms === "number", `duration_ms: ${b.duration_ms}`);
  assert.ok(Array.isArray(b.checks) && b.checks.length >= 8, `checks.length: ${b.checks?.length}`);
  assert.ok(b.cleanup && typeof b.cleanup.ok === "boolean", `cleanup: ${JSON.stringify(b.cleanup)}`);

  // Every check has the full contract shape.
  for (const c of b.checks) {
    for (const k of CHECK_KEYS) assert.ok(k in c, `check ${c.id} missing ${k}`);
    assert.ok(["green", "red", "skip"].includes(c.status), `check ${c.id} bad status ${c.status}`);
    assert.equal(typeof c.latency_ms, "number");
  }

  // The LIGHT-mode probe set is present; judge0_exec is NOT.
  const ids = new Set(b.checks.map((c) => c.id));
  for (const id of [
    "infra_firestore", "infra_gcs_rw", "bundle_hashes", "auth_session_start",
    "exam_config", "chunk_upload_signed", "recordings_read", "telemetry_event", "judge0_liveness"
  ]) assert.ok(ids.has(id), `LIGHT mode missing probe ${id}`);
  assert.ok(!ids.has("judge0_exec"), "LIGHT mode must NOT run judge0_exec");

  // THE invariant: no metered execution in LIGHT mode.
  assert.equal(runBatchCalls, 0, "LIGHT mode called Judge0 runBatch (billing!)");

  // POSITIVE PATH: in a fully-healthy LIGHT run the three exam-morning probes —
  // local v4 signing -> real PUT -> verify (infra_gcs_rw, chunk_upload_signed)
  // and signed READ -> fetch (recordings_read) — must all be GREEN (the fake
  // signed PUT now lands the object in the shared Storage map, so the
  // list-after-PUT + read-back actually succeed, not just shape-check).
  const byId = new Map(b.checks.map((c) => [c.id, c]));
  for (const id of ["infra_gcs_rw", "chunk_upload_signed", "recordings_read", "bundle_hashes"]) {
    assert.equal(byId.get(id).status, "green", `${id} should be GREEN in a healthy LIGHT run: ${byId.get(id).detail}`);
  }
  // bundle_hashes proves the served bundle carries the expected hash VALUES,
  // and must NOT leak any raw password or hash value in its detail string.
  const bundleDetail = byId.get("bundle_hashes").detail;
  assert.ok(!bundleDetail.includes("hc-admin-pass") && !bundleDetail.includes("hc-invig-pass")
    && !bundleDetail.includes(ADMIN_HASH) && !bundleDetail.includes(INVIG_HASH),
    `bundle_hashes detail leaked a secret: ${bundleDetail}`);
  // A fully-healthy LIGHT run is GREEN overall.
  assert.equal(b.overall, "green", `healthy LIGHT run should be GREEN; reds: ${b.checks.filter((c) => c.status === "red").map((c) => `${c.id}=${c.detail}`).join(", ")}`);

  // overall == red iff any non-skip check is red.
  const anyRed = b.checks.some((c) => c.status === "red");
  assert.equal(b.overall, anyRed ? "red" : "green");
});

test("health-check: a namespaced __healthcheck-* canary contest is created and torn down", async () => {
  const ctx = setup();
  __setJudge0AdapterForTest({ runBatch: async () => [] });

  const res = await callHealthCheck({ mode: "light" }, ctx);
  assert.equal(res.statusCode, 200);

  // After a clean run NO __healthcheck-* contest doc should remain (teardown).
  const contests = ctx.firestore._collections.get("hc_contests") || new Map();
  const leftover = [...contests.keys()].filter((slug) => slug.startsWith("__healthcheck-"));
  assert.deepEqual(leftover, [], `canary contest doc(s) not torn down: ${leftover.join(", ")}`);

  // No leftover session docs either.
  const sessions = ctx.firestore._collections.get("hc_sessions") || new Map();
  assert.equal(sessions.size, 0, "canary session doc not torn down");

  // No leftover live-locks.
  const locks = ctx.firestore._collections.get("hc_live_locks") || new Map();
  assert.equal(locks.size, 0, "canary live-lock not released");

  // The auth_session_start probe detail proves the canary slug was namespaced
  // (it started an active session in the __healthcheck- contest).
  const authCheck = res.body.checks.find((c) => c.id === "auth_session_start");
  assert.ok(authCheck, "auth_session_start probe missing");

  // No leftover GCS objects under the canary contest prefix.
  const stray = [...ctx.storage._saved.keys()].filter((k) => k.startsWith("contests/__healthcheck-"));
  assert.deepEqual(stray, [], `canary GCS objects not torn down: ${stray.join(", ")}`);
});

test("health-check: a probe that THROWS is red but teardown still runs (cleanup populated)", async () => {
  const ctx = setup();
  __setJudge0AdapterForTest({ runBatch: async () => [] });
  // Make the Judge0 liveness fetch throw — that probe must go red, the rest
  // must still run, and teardown must still execute.
  const throwingFetch = async (url, opts) => {
    if (/\/languages$/.test(String(url))) throw new Error("ECONNREFUSED judge0");
    return ctx.fetch(url, opts);
  };

  const res = await callHealthCheck({ mode: "light" }, { fetch: throwingFetch });
  assert.equal(res.statusCode, 200);
  const liveness = res.body.checks.find((c) => c.id === "judge0_liveness");
  assert.equal(liveness.status, "red", "thrown probe should be red");
  assert.match(liveness.detail, /ECONNREFUSED/, "red probe must carry the REAL error message");
  assert.equal(res.body.overall, "red", "any red check -> overall red");

  // Teardown STILL ran despite the red probe.
  assert.ok(res.body.cleanup && typeof res.body.cleanup.ok === "boolean", "cleanup not populated after a throwing probe");
  const contests = ctx.firestore._collections.get("hc_contests") || new Map();
  const leftover = [...contests.keys()].filter((slug) => slug.startsWith("__healthcheck-"));
  assert.deepEqual(leftover, [], "teardown skipped after a throwing probe");
});

test("health-check: FULL mode adds judge0_exec and DOES call Judge0 runBatch", async () => {
  const ctx = setup();
  let runBatchCalls = 0;
  __setJudge0AdapterForTest({
    runBatch: async (items) => {
      runBatchCalls += 1;
      // Both seed tests pass (status accepted + passed true).
      return items.map(() => ({ status: "accepted", passed: true, stdout: "0", stderr: "", compileOutput: "", timeSec: 0.01, memoryKb: 100 }));
    }
  });

  const res = await callHealthCheck({ mode: "full" }, ctx);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.mode, "full");
  const ids = new Set(res.body.checks.map((c) => c.id));
  assert.ok(ids.has("judge0_exec"), "FULL mode must include judge0_exec");
  assert.equal(runBatchCalls, 1, "FULL mode should call Judge0 runBatch exactly once");
  const exec = res.body.checks.find((c) => c.id === "judge0_exec");
  assert.equal(exec.status, "green", `judge0_exec should pass: ${exec.detail}`);

  // FULL-mode submission doc is torn down too.
  const subs = ctx.firestore._collections.get("hc_submissions") || new Map();
  assert.equal(subs.size, 0, "canary submission not torn down");
});

test("health-check: an invalid/absent mode defaults to light (no Judge0 exec)", async () => {
  const ctx = setup();
  let runBatchCalls = 0;
  __setJudge0AdapterForTest({ runBatch: async () => { runBatchCalls += 1; return []; } });

  const res = await callHealthCheck({ mode: "garbage" }, ctx);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.mode, "light");
  assert.equal(runBatchCalls, 0, "invalid mode must be treated as light (no billing)");
});

test("health-check: missing or wrong admin password -> 401 (auth is required)", async () => {
  setup();
  __setJudge0AdapterForTest({ runBatch: async () => [] });
  const realFetch = globalThis.fetch;
  globalThis.fetch = makeFakeFetch();
  try {
    const noAuth = await call(makeReq({ method: "POST", path: "/api/admin/health-check", body: { mode: "light" } }));
    assert.equal(noAuth.statusCode, 401);
    const badAuth = await call(makeReq({ method: "POST", path: "/api/admin/health-check", headers: { "x-admin-password": "wrong" }, body: { mode: "light" } }));
    assert.equal(badAuth.statusCode, 401);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("health-check: bundle missing the hash gate -> bundle_hashes red, overall red", async () => {
  const ctx = setup({ bundleOk: false });
  __setJudge0AdapterForTest({ runBatch: async () => [] });
  const res = await callHealthCheck({ mode: "light" }, ctx);
  assert.equal(res.statusCode, 200);
  const bundle = res.body.checks.find((c) => c.id === "bundle_hashes");
  assert.equal(bundle.status, "red");
  // Error names the missing LABELS (admin/invigilator) — never a hash/password.
  assert.match(bundle.detail, /missing expected password hash/);
  assert.match(bundle.detail, /admin|invigilator/);
  // And it must NEVER leak a raw password or a hash value.
  assert.ok(!bundle.detail.includes("hc-admin-pass") && !bundle.detail.includes("hc-invig-pass"),
    "bundle_hashes detail leaked a raw password");
  assert.ok(!bundle.detail.includes(ADMIN_HASH) && !bundle.detail.includes(INVIG_HASH),
    "bundle_hashes detail leaked a hash value");
  assert.equal(res.body.overall, "red");
});
