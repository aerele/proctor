import assert from "node:assert/strict";
import test from "node:test";

// Phase 2 backend tests: GCS contest-foldering, session model (resume /
// single-session / passcode removal), sure-shot proctor alerts, stats, and
// remote session actions. All Firestore/Storage access is mocked through the
// __setClientsForTest DI seam — no real GCP is touched.
//
// Env must be set BEFORE importing the handler (it reads env at module load).
// A unique ?phase2 query string gives us a fresh module instance independent of
// the other test files (which configure different collections).
const TEST_ADMIN_PASSWORD = "admin-pass-phase2";
process.env.ALERTS_INGEST_API_KEY = "phase2-ingest-key-placeholder-not-a-real-secret";
process.env.ALERTS_COLLECTION = "phase2_alerts";
process.env.SESSION_COLLECTION = "phase2_sessions";
process.env.SETTINGS_COLLECTION = "phase2_settings";
process.env.EVIDENCE_BUCKET = "phase2-bucket";
process.env.ADMIN_PASSWORD = TEST_ADMIN_PASSWORD;

const handler = await import("../src/handler.mjs?phase2");
const { api, __setClientsForTest } = handler;

// ---- Fake Firestore (supports create / update / set / get / where) --------

function isIncrementSentinel(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && typeof value.operand === "number"
    && (value.methodName === undefined || String(value.methodName).includes("increment"));
}

function applyUpdate(existing, patch) {
  const next = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (isIncrementSentinel(value)) {
      next[key] = Number(next[key] || 0) + value.operand;
    } else {
      next[key] = value;
    }
  }
  return next;
}

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
        get: query.get,
        doc(id) {
          return {
            id,
            async create(value) {
              if (store.has(id)) {
                const err = new Error("ALREADY_EXISTS");
                err.code = 6;
                throw err;
              }
              store.set(id, { ...value });
            },
            async set(value, options) {
              const existing = options?.merge ? store.get(id) || {} : {};
              store.set(id, { ...existing, ...value });
            },
            async update(patch) {
              const existing = store.get(id);
              if (!existing) {
                const err = new Error("NOT_FOUND");
                err.code = 5;
                throw err;
              }
              store.set(id, applyUpdate(existing, patch));
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

// ---- Fake Storage (records saves; signs read/write URLs) ------------------

function makeFakeStorage() {
  const saved = new Map(); // key -> body
  return {
    _saved: saved,
    bucket() {
      return {
        file(key) {
          return {
            async save(body) {
              saved.set(key, body);
            },
            async getSignedUrl() {
              return [`https://signed.example/${key}`];
            },
            async getMetadata() {
              return [{ size: 1, updated: "2026-06-05T00:00:00Z" }];
            }
          };
        },
        async getFiles({ prefix } = {}) {
          const files = [...saved.keys()]
            .filter((key) => !prefix || key.startsWith(prefix))
            .map((name) => ({
              name,
              async getMetadata() { return [{ size: 1, updated: "2026-06-05T00:00:00Z" }]; },
              async getSignedUrl() { return [`https://signed.example/${name}`]; }
            }));
          return [files];
        }
      };
    }
  };
}

// ---- Fake req/res ---------------------------------------------------------

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
    set(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    send(payload) { this.body = payload; return this; }
  };
}

async function call(req) {
  const res = makeRes();
  await api(req, res);
  return res;
}

const ADMIN_HEADERS = { "x-admin-password": TEST_ADMIN_PASSWORD };

// Seed a settings doc with a wide-open time window and a contest_url.
function seedSettings(firestore, { contestUrl = "https://www.hackerrank.com/contests/coding-contest-mcet-june-2026-slot-2" } = {}) {
  const store = firestore.collection(process.env.SETTINGS_COLLECTION);
  store.doc("active").set({
    start_at: new Date(Date.now() - 3600 * 1000).toISOString(),
    end_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    contest_url: contestUrl,
    updated_at: new Date().toISOString()
  });
}

function detailsBody(overrides = {}) {
  return {
    hackerrank_username: "Alice",
    name: "Alice Example",
    roll_number: "R-1",
    email: "alice@example.com",
    consent_accepted: true,
    ...overrides
  };
}

async function start(firestore, storage, overrides = {}) {
  __setClientsForTest({ firestore, storage });
  return call(makeReq({ method: "POST", path: "/api/session/start", body: detailsBody(overrides) }));
}

// =====================================================================
// 2.1 — GCS contest-foldering / slug helper
// =====================================================================

test("slug: valid contest_url → prefixed contest layout (full segment kept)", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  const res = await start(firestore, storage);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.contest_slug, "coding-contest-mcet-june-2026-slot-2");
  assert.ok(
    res.body.storage_prefix.startsWith("contests/coding-contest-mcet-june-2026-slot-2/sessions/alice/"),
    `prefix should be contest-foldered, got ${res.body.storage_prefix}`
  );
  assert.ok(res.body.storage_prefix.endsWith("/"));
});

test("slug: empty contest_url → LEGACY layout, no contests// double slash", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore, { contestUrl: "" });
  const res = await start(firestore, storage);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.contest_slug, "");
  assert.ok(res.body.storage_prefix.startsWith("sessions/alice/"), res.body.storage_prefix);
  assert.ok(!res.body.storage_prefix.includes("contests//"), "must not produce contests// double slash");
  assert.ok(!res.body.storage_prefix.includes("contests/"), "legacy layout has no contests/ prefix");
});

test("slug: invalid contest_url → legacy fallback", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore, { contestUrl: "not a url" });
  const res = await start(firestore, storage);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.contest_slug, "");
  assert.ok(res.body.storage_prefix.startsWith("sessions/alice/"));
});

test("slug: weird characters in the last segment are sanitized", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  // Trailing slash + special chars in the last path segment. The URL fragment
  // (#...) is correctly excluded by new URL().pathname, so only path chars count.
  seedSettings(firestore, { contestUrl: "https://x.test/contests/we!rd@slug-2026/" });
  const res = await start(firestore, storage);
  assert.equal(res.statusCode, 200);
  // sanitizeSegment maps every non [a-zA-Z0-9._-] char to "_" (dash is kept).
  assert.equal(res.body.contest_slug, "we_rd_slug-2026");
  assert.ok(res.body.storage_prefix.startsWith("contests/we_rd_slug-2026/sessions/alice/"));
});

test("slug: admin-evidence read prefix == upload prefix (same key layout)", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  const startRes = await start(firestore, storage);
  const sessionId = startRes.body.session_id;
  const uploadPrefix = startRes.body.storage_prefix;

  // Drive an upload-url so a chunk key is built at the upload site.
  const upRes = await call(makeReq({
    method: "POST",
    path: "/api/upload-url",
    body: { session_id: sessionId, kind: "screen", chunk_index: 0, content_type: "video/webm" }
  }));
  assert.equal(upRes.statusCode, 200);
  assert.ok(upRes.body.storage_key.startsWith(uploadPrefix), `upload key ${upRes.body.storage_key} must share the session prefix`);

  // Put a file under that prefix, then confirm the admin listing reads it back
  // from the SAME prefix.
  storage._saved.set(`${uploadPrefix}screen/chunk-00000.webm`, "x");
  const adminRes = await call(makeReq({
    method: "GET",
    path: "/api/admin/sessions",
    headers: ADMIN_HEADERS,
    query: { username: "Alice" }
  }));
  assert.equal(adminRes.statusCode, 200);
  const evidenceKeys = adminRes.body.sessions[0].evidence.map((e) => e.key);
  assert.ok(
    evidenceKeys.includes(`${uploadPrefix}screen/chunk-00000.webm`),
    `admin listing must use the same prefix; got ${JSON.stringify(evidenceKeys)}`
  );
});

// =====================================================================
// 2.2 — Session model: passcode removal / resume / single-session
// =====================================================================

test("passcode no longer required to start (no proctor_passcode supplied)", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  const res = await start(firestore, storage); // detailsBody has no proctor_passcode
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "active");
});

test("start is still gated by the time window (before start_at → 403)", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  firestore.collection(process.env.SETTINGS_COLLECTION).doc("active").set({
    start_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    end_at: new Date(Date.now() + 7200 * 1000).toISOString(),
    contest_url: "https://x.test/contests/c1",
    updated_at: new Date().toISOString()
  });
  const res = await start(firestore, storage);
  assert.equal(res.statusCode, 403);
});

test("resume: POST /api/session/resume returns the live session without re-collecting details", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  const startRes = await start(firestore, storage);
  const sessionId = startRes.body.session_id;

  const res = await call(makeReq({
    method: "POST",
    path: "/api/session/resume",
    body: { session_id: sessionId }
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.session_id, sessionId);
  assert.equal(res.body.status, "active");
  assert.equal(res.body.name, "Alice Example", "resume returns stored details, no re-collection");
});

test("resume: unknown session_id → 404", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  __setClientsForTest({ firestore, storage });
  const res = await call(makeReq({
    method: "POST",
    path: "/api/session/resume",
    body: { session_id: "does-not-exist" }
  }));
  assert.equal(res.statusCode, 404);
});

test("resume: session belongs to a different username → 404", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  const startRes = await start(firestore, storage);
  const res = await call(makeReq({
    method: "POST",
    path: "/api/session/resume",
    body: { session_id: startRes.body.session_id, hackerrank_username: "SomeoneElse" }
  }));
  assert.equal(res.statusCode, 404);
});

test("idempotent resume: start with the SAME session_id returns the existing session (no second doc)", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  const startRes = await start(firestore, storage);
  const sessionId = startRes.body.session_id;

  const again = await call(makeReq({
    method: "POST",
    path: "/api/session/start",
    body: detailsBody({ session_id: sessionId })
  }));
  assert.equal(again.statusCode, 200);
  assert.equal(again.body.session_id, sessionId, "same session_id is returned, not a new one");
  assert.equal(again.body.status, "active");
  const store = firestore._collections.get(process.env.SESSION_COLLECTION);
  assert.equal(store.size, 1, "no duplicate session document created");
});

test("single-session: a NEW start for an already-active username → pending_approval", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  const first = await start(firestore, storage);
  assert.equal(first.body.status, "active");

  // A second start with NO session_id (different browser) must not silently
  // create a second active session.
  const second = await start(firestore, storage);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.status, "pending_approval");
  assert.equal(second.body.blocked_by_session_id, first.body.session_id);

  const store = firestore._collections.get(process.env.SESSION_COLLECTION);
  const statuses = [...store.values()].map((s) => s.status).sort();
  assert.deepEqual(statuses, ["active", "pending_approval"]);
});

// =====================================================================
// 2.3 — Sure-shot proctor alerts → proctor_alerts
// =====================================================================

async function startedSession(firestore, storage) {
  seedSettings(firestore);
  const res = await start(firestore, storage);
  return res.body.session_id;
}

for (const type of ["recording_stopped", "screen_share_stopped", "invalid_share_surface", "recording_error"]) {
  test(`sure-shot: event '${type}' → exactly one idempotent proctor alert`, async () => {
    const firestore = makeFakeFirestore();
    const storage = makeFakeStorage();
    const sessionId = await startedSession(firestore, storage);

    const ev = { session_id: sessionId, events: [{ type, timestamp: "2026-06-05T10:00:00Z", detail: { reason: "x" } }] };
    await call(makeReq({ method: "POST", path: "/api/events", body: ev }));
    await call(makeReq({ method: "POST", path: "/api/events", body: ev })); // retry

    const alerts = firestore._collections.get(process.env.ALERTS_COLLECTION);
    assert.equal(alerts.size, 1, "one sure-shot alert, idempotent across retries");
    const alert = [...alerts.values()][0];
    assert.equal(alert.source, "proctor");
    assert.equal(alert.type, type);
    assert.equal(alert.severity, "critical");
    assert.equal(alert.username_norm, "alice");
    assert.equal(alert.contest_slug, "coding-contest-mcet-june-2026-slot-2");
    assert.equal(alert.session_id, sessionId);
    assert.ok(alert.video_key, "video_key attached for deep-link");
    assert.ok(alert.id.startsWith(`proctor:${type}:alice:`), alert.id);
  });
}

test("noisy events (focus/blur/visibility/clipboard) → NO proctor alerts", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  const sessionId = await startedSession(firestore, storage);

  await call(makeReq({
    method: "POST",
    path: "/api/events",
    body: {
      session_id: sessionId,
      events: [
        { type: "visibility_change", timestamp: "2026-06-05T10:00:00Z" },
        { type: "window_blur", timestamp: "2026-06-05T10:00:01Z" },
        { type: "window_focus", timestamp: "2026-06-05T10:00:02Z" },
        { type: "clipboard_activity", timestamp: "2026-06-05T10:00:03Z" }
      ]
    }
  }));
  const alerts = firestore._collections.get(process.env.ALERTS_COLLECTION);
  assert.equal(alerts === undefined || alerts.size === 0, true, "noisy events must not create alerts");
});

test("sure-shot: heartbeat with recording_state=stopped → critical proctor alert", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  const sessionId = await startedSession(firestore, storage);

  await call(makeReq({
    method: "POST",
    path: "/api/heartbeat",
    body: { session_id: sessionId, recording_state: "stopped", visibility_state: "visible" }
  }));
  const alerts = firestore._collections.get(process.env.ALERTS_COLLECTION);
  const recAlert = [...alerts.values()].find((a) => a.type === "recording_stopped");
  assert.ok(recAlert, "recording_stopped alert raised from heartbeat");
  assert.equal(recAlert.severity, "critical");
  assert.equal(recAlert.source, "proctor");

  // A 'recording' heartbeat must NOT add another alert.
  await call(makeReq({
    method: "POST",
    path: "/api/heartbeat",
    body: { session_id: sessionId, recording_state: "recording", visibility_state: "visible" }
  }));
  const after = [...alerts.values()].filter((a) => a.type === "recording_stopped");
  assert.equal(after.length, 1, "a recording heartbeat adds no new stopped alert");
});

test("sure-shot: heartbeat IP change → warning ip_changed proctor alert", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  const sessionId = await startedSession(firestore, storage);

  await call(makeReq({
    method: "POST",
    path: "/api/heartbeat",
    headers: { "x-forwarded-for": "10.0.0.99" },
    body: { session_id: sessionId, recording_state: "recording", visibility_state: "visible" }
  }));
  const alerts = firestore._collections.get(process.env.ALERTS_COLLECTION);
  const ipAlert = [...(alerts?.values() || [])].find((a) => a.type === "ip_changed");
  assert.ok(ipAlert, "ip_changed alert raised");
  assert.equal(ipAlert.severity, "warning");
});

test("sure-shot alerts appear in GET /api/admin/alerts", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  const sessionId = await startedSession(firestore, storage);

  await call(makeReq({
    method: "POST",
    path: "/api/events",
    body: { session_id: sessionId, events: [{ type: "recording_error", timestamp: "2026-06-05T10:00:00Z" }] }
  }));

  const res = await call(makeReq({ method: "GET", path: "/api/admin/alerts", headers: ADMIN_HEADERS }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.alerts.length, 1);
  assert.equal(res.body.alerts[0].type, "recording_error");
  assert.ok(res.body.alerts[0].download_url, "video_key resolved to a signed download_url on read");
});

// =====================================================================
// 2.4 — Stats + remote actions
// =====================================================================

test("stats: counts by status for a contest", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);

  // active(alice)
  await start(firestore, storage, { hackerrank_username: "alice" });
  // ended(bob)
  const bob = await start(firestore, storage, { hackerrank_username: "bob" });
  await call(makeReq({ method: "POST", path: "/api/session/end", body: { session_id: bob.body.session_id, assurance_accepted: true } }));
  // pending(carol-second-device): carol active then carol second → pending
  await start(firestore, storage, { hackerrank_username: "carol" });
  await start(firestore, storage, { hackerrank_username: "carol" });

  const res = await call(makeReq({ method: "GET", path: "/api/admin/stats", headers: ADMIN_HEADERS }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.stats.live, 2, "alice + carol(first) active");
  assert.equal(res.body.stats.finished, 1, "bob ended");
  assert.equal(res.body.stats.pending_approval, 1, "carol(second) pending");
  assert.equal(res.body.stats.total, 4);
});

test("stats: requires admin password", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  const res = await call(makeReq({ method: "GET", path: "/api/admin/stats", headers: {} }));
  assert.equal(res.statusCode, 401);
});

test("session-action: approve activates pending and ends the conflicting active", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  const first = await start(firestore, storage);
  const second = await start(firestore, storage); // pending_approval, blocked_by first

  const res = await call(makeReq({
    method: "POST",
    path: "/api/admin/session-action",
    headers: ADMIN_HEADERS,
    body: { action: "approve", session_id: second.body.session_id }
  }));
  assert.equal(res.statusCode, 200);

  const store = firestore._collections.get(process.env.SESSION_COLLECTION);
  assert.equal(store.get(second.body.session_id).status, "active", "approved session is now active");
  assert.equal(store.get(first.body.session_id).status, "ended", "conflicting session ended");
  assert.equal(store.get(second.body.session_id).blocked_by_session_id, null);
});

test("session-action: lock then unlock toggles status", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  const s = await start(firestore, storage);
  const store = firestore._collections.get(process.env.SESSION_COLLECTION);

  await call(makeReq({ method: "POST", path: "/api/admin/session-action", headers: ADMIN_HEADERS, body: { action: "lock", session_id: s.body.session_id } }));
  assert.equal(store.get(s.body.session_id).status, "locked");

  await call(makeReq({ method: "POST", path: "/api/admin/session-action", headers: ADMIN_HEADERS, body: { action: "unlock", session_id: s.body.session_id } }));
  assert.equal(store.get(s.body.session_id).status, "active");
});

test("session-action: end marks ended", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  const s = await start(firestore, storage);
  const store = firestore._collections.get(process.env.SESSION_COLLECTION);

  await call(makeReq({ method: "POST", path: "/api/admin/session-action", headers: ADMIN_HEADERS, body: { action: "end", session_id: s.body.session_id } }));
  assert.equal(store.get(s.body.session_id).status, "ended");
});

test("session-action: bypass clears a pending block without ending the other", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  const first = await start(firestore, storage);
  const second = await start(firestore, storage); // pending
  const store = firestore._collections.get(process.env.SESSION_COLLECTION);

  await call(makeReq({ method: "POST", path: "/api/admin/session-action", headers: ADMIN_HEADERS, body: { action: "bypass", session_id: second.body.session_id } }));
  assert.equal(store.get(second.body.session_id).status, "active", "bypassed session is active");
  assert.equal(store.get(second.body.session_id).blocked_by_session_id, null);
  assert.equal(store.get(first.body.session_id).status, "active", "bypass does NOT end the other session");
});

test("session-action: bulk by usernames[] ends each live session", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  const alice = await start(firestore, storage, { hackerrank_username: "alice" });
  const bob = await start(firestore, storage, { hackerrank_username: "bob" });
  const store = firestore._collections.get(process.env.SESSION_COLLECTION);

  const res = await call(makeReq({
    method: "POST",
    path: "/api/admin/session-action",
    headers: ADMIN_HEADERS,
    body: { action: "end", usernames: ["alice", "bob"] }
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(store.get(alice.body.session_id).status, "ended");
  assert.equal(store.get(bob.body.session_id).status, "ended");
});

test("session-action: rejects an unknown action with 400", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  const s = await start(firestore, storage);
  const res = await call(makeReq({
    method: "POST",
    path: "/api/admin/session-action",
    headers: ADMIN_HEADERS,
    body: { action: "nuke", session_id: s.body.session_id }
  }));
  assert.equal(res.statusCode, 400);
});

test("session-action: requires admin password", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  const res = await call(makeReq({ method: "POST", path: "/api/admin/session-action", headers: {}, body: { action: "end", session_id: "x" } }));
  assert.equal(res.statusCode, 401);
});
