import assert from "node:assert/strict";
import test from "node:test";

// The handler reads ALERTS_INGEST_API_KEY at module load time, so set a
// throwaway local-only placeholder BEFORE importing it. This is NOT a real
// secret — Karthi sets the real key via the deploy environment.
const TEST_API_KEY = "test-ingest-key-placeholder-not-a-real-secret";
const TEST_ADMIN_PASSWORD = "admin-pass";
process.env.ALERTS_INGEST_API_KEY = TEST_API_KEY;
process.env.ALERTS_COLLECTION = "test_alerts";
process.env.EVIDENCE_BUCKET = "test-bucket";
process.env.ADMIN_PASSWORD = TEST_ADMIN_PASSWORD;

// Import after env is configured. No real GCP is touched: the module-level
// `new Firestore()` / `new Storage()` are lazy and we immediately inject fakes.
const handler = await import("../src/handler.mjs");
const { api, __setClientsForTest } = handler;

// ---- Fake Firestore -------------------------------------------------------

function makeFakeFirestore() {
  const collections = new Map();

  function getCollection(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  }

  function makeQuery(name, filters) {
    return {
      where(field, _op, value) {
        return makeQuery(name, [...filters, { field, value }]);
      },
      limit() {
        return this;
      },
      // Chainable no-op: the REAL scan-window semantics (doc-id order vs
      // timestamp desc + truncating limit) are exercised in
      // alertsScanWindow.test.mjs; functional tests here only need pass-through.
      orderBy() {
        return this;
      },
      async get() {
        const store = getCollection(name);
        let docs = [...store.values()];
        for (const { field, value } of filters) {
          docs = docs.filter((doc) => doc[field] === value);
        }
        return { docs: docs.map((data) => ({ data: () => data })) };
      }
    };
  }

  return {
    _collections: collections,
    collection(name) {
      const store = getCollection(name);
      const query = makeQuery(name, []);
      return {
        where: query.where,
        limit: query.limit,
        orderBy: query.orderBy,
        get: query.get,
        doc(id) {
          return {
            id,
            async set(value, options) {
              const existing = options?.merge ? store.get(id) || {} : {};
              store.set(id, { ...existing, ...value });
            },
            async get() {
              const data = store.get(id);
              return { exists: Boolean(data), data: () => data };
            }
          };
        }
      };
    }
  };
}

// ---- Fake Express-ish req/res --------------------------------------------

function makeReq({ method, path, headers = {}, body, query = {} }) {
  const lowerHeaders = {};
  for (const [key, value] of Object.entries(headers)) lowerHeaders[key.toLowerCase()] = value;
  return {
    method,
    path,
    headers: lowerHeaders,
    query,
    body,
    get(name) {
      return lowerHeaders[String(name).toLowerCase()];
    }
  };
}

function makeRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    set(key, value) {
      this.headers[key] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    }
  };
}

async function call(req) {
  const res = makeRes();
  await api(req, res);
  return res;
}

function validAlert(overrides = {}) {
  return {
    id: "proctor:recording_stopped:alice:contest-1:2026-06-04T10:00:00Z",
    source: "proctor",
    type: "recording_stopped",
    severity: "critical",
    timestamp: "2026-06-04T10:00:00Z",
    hackerrank_username: "Alice",
    title: "Recording stopped",
    ...overrides
  };
}

// ---- requireApiKey: accept / reject (timing-safe) -------------------------

test("ingestAlerts accepts a request with the correct x-api-key", async () => {
  __setClientsForTest({ firestore: makeFakeFirestore() });
  const res = await call(makeReq({
    method: "POST",
    path: "/api/alerts",
    headers: { "x-api-key": TEST_API_KEY },
    body: validAlert()
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
});

test("ingestAlerts rejects a missing x-api-key with 401", async () => {
  __setClientsForTest({ firestore: makeFakeFirestore() });
  const res = await call(makeReq({
    method: "POST",
    path: "/api/alerts",
    body: validAlert()
  }));
  assert.equal(res.statusCode, 401);
});

test("ingestAlerts rejects a wrong x-api-key with 401", async () => {
  __setClientsForTest({ firestore: makeFakeFirestore() });
  const res = await call(makeReq({
    method: "POST",
    path: "/api/alerts",
    headers: { "x-api-key": "wrong-key" },
    body: validAlert()
  }));
  assert.equal(res.statusCode, 401);
});

test("ingestAlerts rejects a key that is a prefix of the real key (timing-safe length handling)", async () => {
  __setClientsForTest({ firestore: makeFakeFirestore() });
  const res = await call(makeReq({
    method: "POST",
    path: "/api/alerts",
    headers: { "x-api-key": TEST_API_KEY.slice(0, -1) },
    body: validAlert()
  }));
  assert.equal(res.statusCode, 401);
});

// ---- ingestAlerts: validation good + bad ----------------------------------

test("ingestAlerts writes a valid single alert and adds received_at", async () => {
  const fakeFirestore = makeFakeFirestore();
  __setClientsForTest({ firestore: fakeFirestore });
  const res = await call(makeReq({
    method: "POST",
    path: "/api/alerts",
    headers: { "x-api-key": TEST_API_KEY },
    body: validAlert()
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ingested, 1);

  const store = fakeFirestore._collections.get("test_alerts");
  const stored = store.get("proctor:recording_stopped:alice:contest-1:2026-06-04T10:00:00Z");
  assert.ok(stored, "alert was stored under its id");
  assert.ok(stored.received_at, "received_at was added by the server");
  assert.equal(stored.username_norm, "alice");
  // download_url must never be persisted
  assert.equal(Object.prototype.hasOwnProperty.call(stored, "download_url"), false);
});

test("ingestAlerts accepts a batch via {alerts:[...]}", async () => {
  const fakeFirestore = makeFakeFirestore();
  __setClientsForTest({ firestore: fakeFirestore });
  const res = await call(makeReq({
    method: "POST",
    path: "/api/alerts",
    headers: { "x-api-key": TEST_API_KEY },
    body: {
      alerts: [
        validAlert({ id: "a1" }),
        validAlert({ id: "a2", source: "contest-eval", type: "web_paste", severity: "warning" })
      ]
    }
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ingested, 2);
  assert.deepEqual(res.body.ids, ["a1", "a2"]);
});

for (const field of ["source", "type", "severity", "timestamp", "hackerrank_username", "title"]) {
  test(`ingestAlerts rejects an alert missing required field '${field}' with 400`, async () => {
    __setClientsForTest({ firestore: makeFakeFirestore() });
    const alert = validAlert();
    delete alert[field];
    const res = await call(makeReq({
      method: "POST",
      path: "/api/alerts",
      headers: { "x-api-key": TEST_API_KEY },
      body: alert
    }));
    assert.equal(res.statusCode, 400, `missing ${field} should be 400`);
  });
}

test("ingestAlerts rejects an invalid source enum with 400", async () => {
  __setClientsForTest({ firestore: makeFakeFirestore() });
  const res = await call(makeReq({
    method: "POST",
    path: "/api/alerts",
    headers: { "x-api-key": TEST_API_KEY },
    body: validAlert({ source: "not-a-source" })
  }));
  assert.equal(res.statusCode, 400);
});

test("ingestAlerts rejects an invalid severity enum with 400", async () => {
  __setClientsForTest({ firestore: makeFakeFirestore() });
  const res = await call(makeReq({
    method: "POST",
    path: "/api/alerts",
    headers: { "x-api-key": TEST_API_KEY },
    body: validAlert({ severity: "fatal" })
  }));
  assert.equal(res.statusCode, 400);
});

test("ingestAlerts rejects a non-ISO timestamp with 400", async () => {
  __setClientsForTest({ firestore: makeFakeFirestore() });
  const res = await call(makeReq({
    method: "POST",
    path: "/api/alerts",
    headers: { "x-api-key": TEST_API_KEY },
    body: validAlert({ timestamp: "not-a-date" })
  }));
  assert.equal(res.statusCode, 400);
});

// ---- idempotent id --------------------------------------------------------

test("ingestAlerts is idempotent on alert.id (merge, no duplicate doc)", async () => {
  const fakeFirestore = makeFakeFirestore();
  __setClientsForTest({ firestore: fakeFirestore });
  const headers = { "x-api-key": TEST_API_KEY };

  await call(makeReq({ method: "POST", path: "/api/alerts", headers, body: validAlert({ title: "First" }) }));
  await call(makeReq({ method: "POST", path: "/api/alerts", headers, body: validAlert({ title: "Second" }) }));

  const store = fakeFirestore._collections.get("test_alerts");
  assert.equal(store.size, 1, "same id must not create a duplicate document");
  const stored = store.get("proctor:recording_stopped:alice:contest-1:2026-06-04T10:00:00Z");
  assert.equal(stored.title, "Second", "merge applied the latest payload");
});

test("ingestAlerts derives a stable id when none is provided", async () => {
  const fakeFirestore = makeFakeFirestore();
  __setClientsForTest({ firestore: fakeFirestore });
  const headers = { "x-api-key": TEST_API_KEY };
  const base = validAlert();
  delete base.id;

  const res1 = await call(makeReq({ method: "POST", path: "/api/alerts", headers, body: { ...base } }));
  const res2 = await call(makeReq({ method: "POST", path: "/api/alerts", headers, body: { ...base } }));

  assert.equal(res1.body.ids[0], res2.body.ids[0], "derived id is deterministic");
  const store = fakeFirestore._collections.get("test_alerts");
  assert.equal(store.size, 1, "deterministic derived id keeps ingest idempotent");
});

// ---- adminAlerts ----------------------------------------------------------

test("adminAlerts returns alerts newest-first and resolves download_url for video_key", async () => {
  const fakeFirestore = makeFakeFirestore();
  const fakeStorage = {
    bucket() {
      return {
        file(key) {
          return {
            async getSignedUrl() {
              return [`https://signed.example/${key}`];
            }
          };
        }
      };
    }
  };
  __setClientsForTest({ firestore: fakeFirestore, storage: fakeStorage });
  const headers = { "x-api-key": TEST_API_KEY };

  await call(makeReq({
    method: "POST", path: "/api/alerts", headers,
    body: validAlert({ id: "old", timestamp: "2026-06-04T09:00:00Z" })
  }));
  await call(makeReq({
    method: "POST", path: "/api/alerts", headers,
    body: validAlert({ id: "new", timestamp: "2026-06-04T11:00:00Z", video_key: "sessions/alice/v.webm" })
  }));

  const res = await call(makeReq({
    method: "GET",
    path: "/api/admin/alerts",
    headers: { "x-admin-password": TEST_ADMIN_PASSWORD }
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.alerts[0].id, "new", "newest-first ordering");
  assert.equal(res.body.alerts[0].download_url, "https://signed.example/sessions/alice/v.webm");
  assert.equal(res.body.alerts[1].download_url, null, "no video_key leaves download_url null");
});

test("adminAlerts requires the admin password", async () => {
  __setClientsForTest({ firestore: makeFakeFirestore() });
  const res = await call(makeReq({ method: "GET", path: "/api/admin/alerts", headers: {} }));
  assert.equal(res.statusCode, 401);
});

test("adminAlerts leaves download_url null when signing fails (graceful)", async () => {
  const fakeFirestore = makeFakeFirestore();
  const fakeStorage = {
    bucket() {
      return {
        file() {
          return {
            async getSignedUrl() {
              throw new Error("signing blew up");
            }
          };
        }
      };
    }
  };
  __setClientsForTest({ firestore: fakeFirestore, storage: fakeStorage });

  await call(makeReq({
    method: "POST", path: "/api/alerts",
    headers: { "x-api-key": TEST_API_KEY },
    body: validAlert({ id: "v", video_key: "sessions/alice/v.webm" })
  }));

  const res = await call(makeReq({
    method: "GET",
    path: "/api/admin/alerts",
    headers: { "x-admin-password": TEST_ADMIN_PASSWORD }
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.alerts[0].download_url, null);
});

test("adminAlerts filters by contest_slug / severity / source", async () => {
  const fakeFirestore = makeFakeFirestore();
  __setClientsForTest({ firestore: fakeFirestore, storage: { bucket: () => ({ file: () => ({ getSignedUrl: async () => [""] }) }) } });
  const headers = { "x-api-key": TEST_API_KEY };

  await call(makeReq({ method: "POST", path: "/api/alerts", headers, body: validAlert({ id: "p1", contest_slug: "alpha", severity: "critical", source: "proctor" }) }));
  await call(makeReq({ method: "POST", path: "/api/alerts", headers, body: validAlert({ id: "p2", contest_slug: "beta", severity: "warning", source: "contest-eval", type: "web_paste" }) }));

  const byContest = await call(makeReq({
    method: "GET",
    path: "/api/admin/alerts",
    headers: { "x-admin-password": TEST_ADMIN_PASSWORD },
    query: { contest_slug: "beta" }
  }));
  assert.equal(byContest.statusCode, 200);
  assert.equal(byContest.body.alerts.length, 1);
  assert.equal(byContest.body.alerts[0].id, "p2");

  // B6: severity / source are filtered in memory (no composite index needed).
  const bySeverity = await call(makeReq({
    method: "GET",
    path: "/api/admin/alerts",
    headers: { "x-admin-password": TEST_ADMIN_PASSWORD },
    query: { severity: "warning" }
  }));
  assert.deepEqual(bySeverity.body.alerts.map((a) => a.id), ["p2"], "in-memory severity filter");

  const bySource = await call(makeReq({
    method: "GET",
    path: "/api/admin/alerts",
    headers: { "x-admin-password": TEST_ADMIN_PASSWORD },
    query: { source: "proctor" }
  }));
  assert.deepEqual(bySource.body.alerts.map((a) => a.id), ["p1"], "in-memory source filter");

  // B6: all three at once — one server-side (contest_slug) + two in memory.
  const combined = await call(makeReq({
    method: "GET",
    path: "/api/admin/alerts",
    headers: { "x-admin-password": TEST_ADMIN_PASSWORD },
    query: { contest_slug: "beta", severity: "warning", source: "contest-eval" }
  }));
  assert.deepEqual(combined.body.alerts.map((a) => a.id), ["p2"], "combined filter, no composite index");

  const combinedMiss = await call(makeReq({
    method: "GET",
    path: "/api/admin/alerts",
    headers: { "x-admin-password": TEST_ADMIN_PASSWORD },
    query: { contest_slug: "beta", severity: "critical" }
  }));
  assert.equal(combinedMiss.body.alerts.length, 0, "no alert matches beta+critical");
});
