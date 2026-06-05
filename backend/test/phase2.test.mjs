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
            async delete() {
              // H1: live-slot lock release. Idempotent — deleting a missing doc
              // is a no-op, matching Firestore's delete semantics.
              store.delete(id);
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

async function startedSession(firestore, storage, { mergedVideoKey } = {}) {
  seedSettings(firestore);
  const res = await start(firestore, storage);
  const sessionId = res.body.session_id;
  // B4: simulate the video-worker having written merged_video_key back onto the
  // session doc after a successful merge, so sure-shot alerts get a deep-link.
  if (mergedVideoKey !== null) {
    const store = firestore._collections.get(process.env.SESSION_COLLECTION);
    const existing = store.get(sessionId);
    store.set(sessionId, { ...existing, merged_video_key: mergedVideoKey || `${existing.storage_prefix}alice-${sessionId}.webm` });
  }
  return sessionId;
}

for (const type of ["recording_stopped", "screen_share_stopped", "recording_error"]) {
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

test("B4: sure-shot alert without a merged video has NO video_key (no broken folder link)", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  // mergedVideoKey:null → do NOT write merged_video_key onto the session doc.
  const sessionId = await startedSession(firestore, storage, { mergedVideoKey: null });

  await call(makeReq({
    method: "POST",
    path: "/api/events",
    body: { session_id: sessionId, events: [{ type: "recording_error", timestamp: "2026-06-05T10:00:00Z" }] }
  }));

  const alerts = firestore._collections.get(process.env.ALERTS_COLLECTION);
  const alert = [...alerts.values()][0];
  assert.ok(alert, "alert raised");
  assert.equal(alert.video_key, undefined, "no merged video → no video_key (link hidden, not a broken folder prefix)");

  // And on READ the admin listing resolves download_url to null (link hidden).
  const res = await call(makeReq({ method: "GET", path: "/api/admin/alerts", headers: ADMIN_HEADERS }));
  assert.equal(res.body.alerts[0].download_url, null, "no video_key → download_url null");
});

test("B4: sure-shot alert WITH a merged video deep-links to merged_video_key", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  const sessionId = await startedSession(firestore, storage, { mergedVideoKey: "contests/c/sessions/alice/s1/alice-s1.webm" });

  await call(makeReq({
    method: "POST",
    path: "/api/events",
    body: { session_id: sessionId, events: [{ type: "recording_error", timestamp: "2026-06-05T10:00:00Z" }] }
  }));

  const alerts = firestore._collections.get(process.env.ALERTS_COLLECTION);
  const alert = [...alerts.values()][0];
  assert.equal(alert.video_key, "contests/c/sessions/alice/s1/alice-s1.webm", "deep-links to the merged video object");
  assert.ok(!alert.video_key.endsWith("/"), "never a folder prefix");
});

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

test("sure-shot: heartbeat with COMPOSITE stopped recording_state → critical proctor alert", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  const sessionId = await startedSession(firestore, storage);

  // B2: the REAL recorder sends a composite, not a bare 'stopped'. The core
  // capture (combined:inactive / screen:stopped) must trip the sure-shot.
  await call(makeReq({
    method: "POST",
    path: "/api/heartbeat",
    body: {
      session_id: sessionId,
      recording_state: "combined:inactive;screen:stopped;camera:recording;microphone:stopped",
      visibility_state: "visible"
    }
  }));
  const alerts = firestore._collections.get(process.env.ALERTS_COLLECTION);
  const recAlert = [...alerts.values()].find((a) => a.type === "recording_stopped");
  assert.ok(recAlert, "recording_stopped alert raised from composite heartbeat");
  assert.equal(recAlert.severity, "critical");
  assert.equal(recAlert.source, "proctor");

  // A fully-recording composite must NOT add another alert.
  await call(makeReq({
    method: "POST",
    path: "/api/heartbeat",
    body: {
      session_id: sessionId,
      recording_state: "combined:recording;screen:recording;camera:recording;microphone:recording",
      visibility_state: "visible"
    }
  }));
  const after = [...alerts.values()].filter((a) => a.type === "recording_stopped");
  assert.equal(after.length, 1, "a fully-recording composite adds no new stopped alert");
});

test("B2: a composite where ONLY camera/mic stopped does NOT fire recording_stopped", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  const sessionId = await startedSession(firestore, storage);

  // Core capture still recording; only optional tracks dropped → no sure-shot.
  await call(makeReq({
    method: "POST",
    path: "/api/heartbeat",
    body: {
      session_id: sessionId,
      recording_state: "combined:recording;screen:recording;camera:stopped;microphone:stopped",
      visibility_state: "visible"
    }
  }));
  const alerts = firestore._collections.get(process.env.ALERTS_COLLECTION);
  const recAlert = [...(alerts?.values() || [])].find((a) => a.type === "recording_stopped");
  assert.ok(!recAlert, "optional-track stop alone must not fire recording_stopped");
});

test("B1: heartbeat response carries the live session status", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  const sessionId = await startedSession(firestore, storage);

  // An active session reports status:'active' so the recorder keeps going.
  const active = await call(makeReq({
    method: "POST",
    path: "/api/heartbeat",
    body: { session_id: sessionId, recording_state: "recording", visibility_state: "visible" }
  }));
  assert.equal(active.statusCode, 200);
  assert.equal(active.body.status, "active", "active session heartbeat reports status:active");
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

// =====================================================================
// Security / correctness hardening (H1, H3, M1, M3, N3)
// =====================================================================

// ---- H1: single-session start race (TOCTOU) ----
// Two near-simultaneous starts for the SAME (username_norm, contest_slug) must
// resolve to EXACTLY ONE active session; the loser falls to pending_approval.
// We fire both via Promise.all so their internal awaits interleave — this is the
// race the deterministic live-slot lock has to win. Before the fix both starts'
// pre-reads see "no active session" and both go active.
test("H1: two concurrent starts → exactly one active, the other pending_approval", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  __setClientsForTest({ firestore, storage });

  const body = detailsBody(); // same username_norm for both
  const [a, b] = await Promise.all([
    call(makeReq({ method: "POST", path: "/api/session/start", body: { ...body } })),
    call(makeReq({ method: "POST", path: "/api/session/start", body: { ...body } }))
  ]);

  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  const statuses = [a.body.status, b.body.status].sort();
  assert.deepEqual(statuses, ["active", "pending_approval"], "exactly one active under the race");

  const store = firestore._collections.get(process.env.SESSION_COLLECTION);
  const docStatuses = [...store.values()].map((s) => s.status).sort();
  assert.deepEqual(docStatuses, ["active", "pending_approval"], "persisted docs agree: only one active");

  // The pending one must point at the real winner's session_id.
  const active = [a, b].find((r) => r.body.status === "active");
  const pending = [a, b].find((r) => r.body.status === "pending_approval");
  assert.equal(pending.body.blocked_by_session_id, active.body.session_id);
});

test("H1: the live slot is released on end so a fresh start re-acquires it (active)", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  const first = await start(firestore, storage);
  assert.equal(first.body.status, "active");

  // End the active session, then a brand-new start should win the freed slot.
  const endRes = await call(makeReq({
    method: "POST",
    path: "/api/session/end",
    body: { session_id: first.body.session_id, assurance_accepted: true }
  }));
  assert.equal(endRes.statusCode, 200);

  const fresh = await start(firestore, storage);
  assert.equal(fresh.body.status, "active", "slot freed on end → fresh start re-acquires it");
});

// ---- H3: write endpoints check session status ----
// Helper: directly set a session's status in the fake store (simulates an admin
// lock/end having already happened).
function setSessionStatus(firestore, sessionId, status) {
  const store = firestore._collections.get(process.env.SESSION_COLLECTION);
  const existing = store.get(sessionId);
  store.set(sessionId, { ...existing, status });
}

const WRITE_ENDPOINTS = [
  { path: "/api/upload-url", body: (sid) => ({ session_id: sid, kind: "screen", chunk_index: 0, content_type: "video/webm" }) },
  { path: "/api/events", body: (sid) => ({ session_id: sid, events: [{ type: "x", timestamp: "2026-06-05T10:00:00Z" }] }) },
  { path: "/api/heartbeat", body: (sid) => ({ session_id: sid, recording_state: "recording", visibility_state: "visible" }) },
  { path: "/api/review-file", body: (sid) => ({ session_id: sid, nature: "clipboard", records: [{ a: 1 }] }) },
  { path: "/api/session/validate-end", body: (sid) => ({ session_id: sid, assurance_accepted: true }) },
  { path: "/api/session/end", body: (sid) => ({ session_id: sid, assurance_accepted: true }) }
];

for (const { status, code, signal } of [
  { status: "locked", code: 403, signal: "session_locked" },
  { status: "ended", code: 409, signal: "session_ended" },
  { status: "pending_approval", code: 403, signal: "waiting_for_approval" }
]) {
  for (const ep of WRITE_ENDPOINTS) {
    test(`H3: ${status} session → ${ep.path} rejected (${code} ${signal})`, async () => {
      const firestore = makeFakeFirestore();
      const storage = makeFakeStorage();
      const sessionId = await startedSession(firestore, storage);
      setSessionStatus(firestore, sessionId, status);

      const res = await call(makeReq({ method: "POST", path: ep.path, body: ep.body(sessionId) }));
      assert.equal(res.statusCode, code, `${ep.path} on ${status} should be ${code}`);
      assert.equal(res.body.error, signal, `${ep.path} on ${status} should signal ${signal}`);
    });
  }
}

test("H3: an active session still allows writes (happy path unchanged)", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  const sessionId = await startedSession(firestore, storage);
  for (const ep of WRITE_ENDPOINTS.filter((e) => e.path !== "/api/session/end")) {
    const res = await call(makeReq({ method: "POST", path: ep.path, body: ep.body(sessionId) }));
    assert.equal(res.statusCode, 200, `${ep.path} on an active session must succeed`);
  }
});

// ---- M1: sanitizeSegment pure-dot / empty segments ----
// A pure-dot username ('.', '..', '...') is a non-empty string so it passes the
// required-field check and DOES reach sanitizeSegment — it must never become a
// '..' (or '.') path component once it lands in the GCS storage_prefix.
for (const username of ["..", ".", "..."]) {
  test(`M1: username '${username}' → safe segment, never '..' in the key`, async () => {
    const firestore = makeFakeFirestore();
    const storage = makeFakeStorage();
    seedSettings(firestore);
    const res = await start(firestore, storage, { hackerrank_username: username });
    assert.equal(res.statusCode, 200);
    const prefix = res.body.storage_prefix;
    // The username segment sits between .../sessions/ and the next slash.
    const match = prefix.match(/sessions\/([^/]+)\//);
    assert.ok(match, `expected a sessions/<user>/ segment in ${prefix}`);
    const userSegment = match[1];
    assert.ok(!/^\.+$/.test(userSegment), `username segment must not be all dots, got '${userSegment}'`);
    assert.ok(userSegment.length > 0, "username segment must not be empty");
    assert.ok(!prefix.includes("/../"), "no traversal segment in the key");
    assert.ok(!prefix.includes("/./"), "no '.' segment in the key");
  });
}

// An EMPTY username is rejected upstream by the required-field check (it never
// reaches key-building) — assert that contract so the empty case is covered too.
test("M1: empty username is rejected at the contract (400), never key-built", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  const res = await start(firestore, storage, { hackerrank_username: "" });
  assert.equal(res.statusCode, 400);
});

// A pure-dot value on a NON-username segment (upload `kind`) also reaches
// sanitizeSegment and must not produce a traversal in the object key.
test("M1: upload kind '..' → safe segment, no traversal in the storage_key", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  const sessionId = await startedSession(firestore, storage);
  const res = await call(makeReq({
    method: "POST",
    path: "/api/upload-url",
    body: { session_id: sessionId, kind: "..", chunk_index: 0, content_type: "video/webm" }
  }));
  assert.equal(res.statusCode, 200);
  assert.ok(!res.body.storage_key.includes("/../"), `no traversal in ${res.body.storage_key}`);
  assert.ok(res.body.storage_key.includes("/_/"), "pure-dot kind became the safe '_' token");
});

// ---- M3: 500s must not leak internal messages ----
// Force an UNEXPECTED error from deep inside an endpoint (a storage save that
// throws a non-httpError) and assert the client gets a generic 500 with NO
// `detail` echoing the internal message.
test("M3: an unexpected 500 returns a generic error with no internal detail", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  const sessionId = await startedSession(firestore, storage);

  const SECRET = "INTERNAL_SECRET_STACK_DETAIL_xyz";
  // Swap the bucket so file().save() throws a plain (non-httpError) Error.
  const brokenStorage = {
    bucket() {
      return {
        file() {
          return {
            async save() { throw new Error(SECRET); },
            async getSignedUrl() { return ["https://signed.example/x"]; }
          };
        }
      };
    }
  };
  __setClientsForTest({ firestore, storage: brokenStorage });

  // Silence the expected server-side console.error during this test.
  const originalError = console.error;
  console.error = () => {};
  let res;
  try {
    res = await call(makeReq({
      method: "POST",
      path: "/api/events",
      body: { session_id: sessionId, events: [{ type: "x", timestamp: "2026-06-05T10:00:00Z" }] }
    }));
  } finally {
    console.error = originalError;
  }

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, "Internal server error");
  assert.equal(Object.prototype.hasOwnProperty.call(res.body, "detail"), false, "500 must NOT include a detail field");
  assert.ok(!JSON.stringify(res.body).includes(SECRET), "internal message must never reach the client");
});

test("M3: intentional 4xx still includes its detail (contract unchanged)", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  // Missing required field → 400 httpError, which should still carry detail.
  const res = await call(makeReq({ method: "POST", path: "/api/events", body: { events: [] } }));
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.detail, "intentional 4xx keeps its detail for the client");
});

// ---- N3: malformed JSON body → 400, not 500 ----
test("N3: malformed JSON string body → 400 invalid_json (not a 500)", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  // req.body is a raw string (as a non-parsing runtime would deliver it).
  const res = await call(makeReq({
    method: "POST",
    path: "/api/session/end",
    body: "{ not valid json :"
  }));
  assert.equal(res.statusCode, 400, "malformed JSON is a client 400, not a server 500");
  assert.equal(res.body.error, "invalid_json");
});
