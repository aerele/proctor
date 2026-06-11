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
process.env.SUBMISSION_EVENTS_COLLECTION = "phase2_submission_events";
process.env.SESSION_COLLECTION = "phase2_sessions";
process.env.SETTINGS_COLLECTION = "phase2_settings";
process.env.REVIEW_STATE_COLLECTION = "phase2_review_state";
process.env.REVIEW_COLLECTION = "phase2_reviews";
process.env.REVIEW_CLAIMS_COLLECTION = "phase2_review_claims";
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
      where(field, op, value) {
        return makeQuery(name, [...filters, { field, op, value }]);
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
        for (const { field, op, value } of filters) {
          // Mirror the Firestore operators the handler actually uses: scalar
          // equality and the `in` membership test (a small value array).
          if (op === "in") {
            docs = docs.filter((doc) => Array.isArray(value) && value.includes(doc[field]));
          } else {
            docs = docs.filter((doc) => doc[field] === value);
          }
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
            },
            async download() {
              return [saved.get(key) ?? ""];
            }
          };
        },
        async getFiles({ prefix } = {}) {
          const files = [...saved.keys()]
            .filter((key) => !prefix || key.startsWith(prefix))
            .map((name) => ({
              name,
              metadata: { size: 1, updated: "2026-06-05T00:00:00Z" },
              async getMetadata() { return [{ size: 1, updated: "2026-06-05T00:00:00Z" }]; },
              async getSignedUrl() { return [`https://signed.example/${name}`]; },
              async download() { return [saved.get(name) ?? ""]; }
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

test("start: a malformed candidate email → 400 (F12 email-format gap)", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  // No @, no domain dot, and an embedded space all fail the permissive gate.
  for (const email of ["asha-at-example", "asha@example", "has space@example.com"]) {
    const res = await start(firestore, storage, { email });
    assert.equal(res.statusCode, 400, `expected 400 for ${email}`);
    assert.match(res.body.error, /email/i);
  }
});

test("start: a well-formed candidate email → 200 (gate is permissive, not RFC-strict)", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  const res = await start(firestore, storage, { email: "asha.k+tag@mail.example.co" });
  assert.equal(res.statusCode, 200);
});

// S-E (F8.2): the legacy start no longer hard-requires the field named
// "hackerrank_username". The modern client sends `candidate_id`; the server
// synthesizes the FROZEN hackerrank_username session key from it so legacy reads
// (doc ids, GCS paths, dual-read DTOs) keep working unchanged.
test("start: candidate_id alone (no hackerrank_username) → 200, frozen key synthesized", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  // detailsBody seeds hackerrank_username; null it out and pass candidate_id only.
  const res = await start(firestore, storage, {
    hackerrank_username: undefined,
    candidate_id: "Asha_R",
    name: "Asha R",
    email: "asha@example.com",
    roll_number: "R-9"
  });
  assert.equal(res.statusCode, 200);
  // The frozen field IS the session key — username_norm derives from it, so the
  // session must be findable under candidate_id's normalized form.
  const stored = res.body;
  assert.equal(stored.hackerrank_username, "Asha_R", "candidate_id synthesized into the frozen field");
  assert.equal(stored.candidate_id, "Asha_R", "modern candidate_id still surfaced in the response");
});

test("start: NEITHER candidate_id nor hackerrank_username → 400 (id still mandatory)", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  const res = await start(firestore, storage, {
    hackerrank_username: undefined,
    candidate_id: undefined,
    name: "No Id",
    email: "noid@example.com",
    roll_number: "R-0"
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /required/i);
});

test("start: hackerrank_username still accepted verbatim (back-compat caller)", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  const res = await start(firestore, storage, {
    hackerrank_username: "Legacy_User",
    candidate_id: undefined,
    name: "Legacy User",
    email: "legacy@example.com",
    roll_number: "R-7"
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.hackerrank_username, "Legacy_User");
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
// Bulk session details — POST /api/admin/session-details
// =====================================================================

async function sessionDetails(usernames, contestSlug, headers = ADMIN_HEADERS) {
  const body = { usernames };
  if (contestSlug !== undefined) body.contest_slug = contestSlug;
  return call(makeReq({ method: "POST", path: "/api/admin/session-details", headers, body }));
}

test("session-details: projects details straight from the session doc, ZERO GCS access", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  await start(firestore, storage, {
    hackerrank_username: "Alice",
    name: "Alice Example",
    email: "alice@example.com",
    roll_number: "R-1",
    room: "Lab-3"
  });

  // Fail the test if the handler touches GCS at all — the whole point of this
  // endpoint is to avoid the per-username getFiles/getSignedUrl fan-out.
  const noGcs = {
    bucket() {
      throw new Error("session-details must not touch GCS");
    }
  };
  __setClientsForTest({ firestore, storage: noGcs });

  const res = await sessionDetails(["Alice"]);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.details.length, 1);
  const d = res.body.details[0];
  assert.equal(d.username, "Alice", "echoes the input username");
  assert.equal(d.hackerrank_username, "Alice");
  assert.equal(d.name, "Alice Example");
  assert.equal(d.email, "alice@example.com", "email projected (recording-sessions omits this)");
  assert.equal(d.roll_number, "R-1", "roll_number projected (recording-sessions omits this)");
  assert.equal(d.room, "Lab-3");
  assert.equal(d.contest_slug, "coding-contest-mcet-june-2026-slot-2");
  assert.equal(d.status, "active");
  assert.equal(d.found, true);
  // No signed-url / evidence fields leak into the details shape.
  assert.equal(Object.prototype.hasOwnProperty.call(d, "evidence"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(d, "download_url"), false);
});

test("session-details: preserves input ORDER and emits found:false for unknown usernames", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  await start(firestore, storage, { hackerrank_username: "Alice", name: "Alice Example", email: "a@x.com", roll_number: "R-1" });
  await start(firestore, storage, { hackerrank_username: "Bob", name: "Bob Example", email: "b@x.com", roll_number: "R-2" });

  // Order: a known one, an unknown one, another known one. Response must mirror
  // the input order exactly.
  const res = await sessionDetails(["Bob", "Nobody", "Alice"]);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.details.map((d) => d.username), ["Bob", "Nobody", "Alice"], "input order preserved");
  assert.deepEqual(res.body.details.map((d) => d.found), [true, false, true]);

  const missing = res.body.details[1];
  assert.equal(missing.found, false);
  assert.equal(missing.username, "Nobody", "unknown username still echoes the input");
  for (const field of ["hackerrank_username", "name", "email", "roll_number", "room", "contest_slug", "status"]) {
    assert.equal(missing[field], "", `unknown username has empty ${field}`);
  }
});

test("session-details: picks the NEWEST session per username (created_at desc)", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  // Two sessions for the same user; force distinct created_at and a distinguishing
  // field so we can tell which one was projected.
  const first = await start(firestore, storage, { hackerrank_username: "Alice", name: "Old Name", email: "old@x.com" });
  await call(makeReq({ method: "POST", path: "/api/admin/session-action", headers: ADMIN_HEADERS, body: { action: "end", session_id: first.body.session_id } }));
  const store = firestore._collections.get(process.env.SESSION_COLLECTION);
  store.set(first.body.session_id, { ...store.get(first.body.session_id), created_at: "2026-06-05T00:00:00.000Z" });
  const second = await start(firestore, storage, { hackerrank_username: "Alice", name: "New Name", email: "new@x.com" });
  store.set(second.body.session_id, { ...store.get(second.body.session_id), created_at: "2026-06-07T00:00:00.000Z" });

  const res = await sessionDetails(["Alice"]);
  assert.equal(res.body.details[0].name, "New Name", "newest session wins");
  assert.equal(res.body.details[0].email, "new@x.com");
});

test("session-details: '@'-prefixed input resolves to the same session (alt-norm match)", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  // Student started WITHOUT the '@'; username_norm is 'alice'.
  await start(firestore, storage, { hackerrank_username: "Alice", name: "Alice Example", email: "a@x.com" });

  // Roster entry typed WITH the '@' → normalizeUsername('@alice') === '_alice';
  // the alt-norm ('alice') must still find the session.
  const res = await sessionDetails(["@alice"]);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.details[0].found, true, "'@alice' resolves via alt-norm to 'alice'");
  assert.equal(res.body.details[0].username, "@alice", "echoes the exact input form");
  assert.equal(res.body.details[0].name, "Alice Example");
});

test("session-details: a GENUINE '_alice' username is NOT conflated with 'alice'", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  // Two DISTINCT students: one whose HackerRank handle is literally '_alice'
  // (username_norm '_alice'), and a separate 'alice' (username_norm 'alice').
  const us = await start(firestore, storage, { hackerrank_username: "_alice", name: "Underscore Alice", email: "underscore@x.com" });
  const pl = await start(firestore, storage, { hackerrank_username: "alice", name: "Plain Alice", email: "plain@x.com" });
  // Pin distinct created_at so any newest-first tie-break is deterministic.
  const store = firestore._collections.get(process.env.SESSION_COLLECTION);
  store.set(us.body.session_id, { ...store.get(us.body.session_id), created_at: "2026-06-05T00:00:00.000Z" });
  store.set(pl.body.session_id, { ...store.get(pl.body.session_id), created_at: "2026-06-07T00:00:00.000Z" });

  // Querying the literal '_alice' (no leading '@') must NOT fall back to 'alice'.
  // BEFORE the fix, '_alice' normalized to '_alice' and the alt-norm derived
  // 'alice' from the leading '_', wrongly merging the two distinct students.
  const underscore = await sessionDetails(["_alice"]);
  assert.equal(underscore.body.details[0].found, true);
  assert.equal(underscore.body.details[0].name, "Underscore Alice", "'_alice' resolves to the real '_alice' student, not 'alice'");
  assert.equal(underscore.body.details[0].email, "underscore@x.com");

  // And 'alice' (no leading '@') still resolves to the plain student only.
  const plain = await sessionDetails(["alice"]);
  assert.equal(plain.body.details[0].found, true);
  assert.equal(plain.body.details[0].name, "Plain Alice");
  assert.equal(plain.body.details[0].email, "plain@x.com");
});

test("session-details: a degenerate input ('@' / blank) does NOT query and is found:false", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  await start(firestore, storage, { hackerrank_username: "alice", name: "Plain Alice", email: "plain@x.com" });

  // A bare '@' normalizes to '_' (degenerate); it must not mass-match docs.
  const res = await sessionDetails(["@"]);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.details[0].found, false, "bare '@' carries no username → found:false");
  assert.equal(res.body.details[0].username, "@", "echoes the input form");
  assert.equal(res.body.details[0].name, "");
});

test("session-details: contest_slug scopes the match", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  await start(firestore, storage, { hackerrank_username: "Alice", name: "Alice Example", email: "a@x.com" });
  const contestSlug = "coding-contest-mcet-june-2026-slot-2";

  // Right slug → found; a different slug → not found (scoped out).
  const hit = await sessionDetails(["Alice"], contestSlug);
  assert.equal(hit.body.details[0].found, true);
  const miss = await sessionDetails(["Alice"], "some-other-contest");
  assert.equal(miss.body.details[0].found, false, "wrong contest_slug excludes the session");
});

test("session-details: caps usernames at REVIEW_ROSTER_LIMIT (5000) with a 400", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  const tooMany = Array.from({ length: 5001 }, (_, i) => `u${i}`);
  const res = await sessionDetails(tooMany);
  assert.equal(res.statusCode, 400);
});

test("session-details: usernames must be an array (400)", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  const res = await call(makeReq({ method: "POST", path: "/api/admin/session-details", headers: ADMIN_HEADERS, body: { usernames: "Alice" } }));
  assert.equal(res.statusCode, 400);
});

test("session-details: requires admin password", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  const res = await sessionDetails(["Alice"], undefined, {});
  assert.equal(res.statusCode, 401);
});

// =====================================================================
// Recording playback picker — GET /api/admin/recording-sessions
// =====================================================================

// Drive an upload-url so a chunk gets recorded (chunk_count incremented) on the
// given session, mirroring how the real recorder bumps the counter.
async function recordChunk(sessionId, chunkIndex = 0) {
  return call(makeReq({
    method: "POST",
    path: "/api/upload-url",
    body: { session_id: sessionId, kind: "screen", chunk_index: chunkIndex, content_type: "video/webm" }
  }));
}

test("recording-sessions: lists only sessions with chunks, newest-first, lightweight (no evidence/urls)", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);

  // alice records 2 chunks; bob records 0 (no recording) → bob excluded.
  const alice = await start(firestore, storage, { hackerrank_username: "alice" });
  await recordChunk(alice.body.session_id, 0);
  await recordChunk(alice.body.session_id, 1);
  await start(firestore, storage, { hackerrank_username: "bob" });

  const res = await call(makeReq({ method: "GET", path: "/api/admin/recording-sessions", headers: ADMIN_HEADERS }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.sessions.length, 1, "only the session with chunks is listed");
  const session = res.body.sessions[0];
  assert.equal(session.hackerrank_username, "alice");
  assert.equal(session.chunk_count, 2);
  // Lightweight contract: no GCS listing, no signed URLs.
  assert.equal(Object.prototype.hasOwnProperty.call(session, "evidence"), false, "no evidence array");
  assert.equal(Object.prototype.hasOwnProperty.call(session, "merged_video_key"), false, "no signed urls / merged key");
  // The shape the picker relies on.
  for (const field of ["session_id", "name", "room", "contest_slug", "created_at", "status"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(session, field), `expected field ${field}`);
  }
});

test("recording-sessions: falls back to ALL sessions when none report chunk_count", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  // Two sessions that never recorded a chunk (chunk_count stays 0).
  await start(firestore, storage, { hackerrank_username: "alice" });
  await start(firestore, storage, { hackerrank_username: "bob" });

  const res = await call(makeReq({ method: "GET", path: "/api/admin/recording-sessions", headers: ADMIN_HEADERS }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.sessions.length, 2, "fallback lists all sessions so the picker is not empty");
});

test("recording-sessions: requires admin password", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  const res = await call(makeReq({ method: "GET", path: "/api/admin/recording-sessions", headers: {} }));
  assert.equal(res.statusCode, 401);
});

// =====================================================================
// Sessions drill-down — GET /api/admin/sessions-list (all docs, classified to
// match the stat-card counts; the all-docs counterpart to recording-sessions).
// =====================================================================

function sessionsList(query = {}, headers = ADMIN_HEADERS) {
  return call(makeReq({ method: "GET", path: "/api/admin/sessions-list", headers, query }));
}

// Force a session doc into a given status without going through an action (used
// to set up locked/ended fixtures deterministically).
function setStatus(firestore, sessionId, status) {
  const store = firestore._collections.get(process.env.SESSION_COLLECTION);
  store.set(sessionId, { ...store.get(sessionId), status });
}

test("sessions-list: a pending_approval session with chunk_count:0 IS returned (NOT recording-filtered)", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  // carol starts twice → the second is pending_approval, chunk_count:0, and
  // would be DROPPED by recording-sessions' chunk_count>0 filter.
  await start(firestore, storage, { hackerrank_username: "carol" });
  const second = await start(firestore, storage, { hackerrank_username: "carol" });
  const store = firestore._collections.get(process.env.SESSION_COLLECTION);
  assert.equal(store.get(second.body.session_id).status, "pending_approval", "second device is pending_approval");
  assert.equal(store.get(second.body.session_id).chunk_count, 0, "and recorded zero chunks");

  const res = await sessionsList({ status: "pending_approval" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.sessions.length, 1, "the zero-chunk pending session is listed");
  assert.equal(res.body.sessions[0].session_id, second.body.session_id);
  assert.equal(res.body.sessions[0].chunk_count, 0);
  assert.equal(res.body.sessions[0].status, "pending_approval");
  // Lightweight contract identical to recording-sessions: no evidence / signed urls.
  assert.equal(Object.prototype.hasOwnProperty.call(res.body.sessions[0], "evidence"), false);
});

test("sessions-list: status='' returns ALL session docs (incl. zero-chunk)", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  // active alice, ended bob, pending carol(2nd) → three docs total, zero chunks each.
  await start(firestore, storage, { hackerrank_username: "alice" });
  const bob = await start(firestore, storage, { hackerrank_username: "bob" });
  await call(makeReq({ method: "POST", path: "/api/session/end", body: { session_id: bob.body.session_id, assurance_accepted: true } }));
  await start(firestore, storage, { hackerrank_username: "carol" });
  await start(firestore, storage, { hackerrank_username: "carol" });

  const res = await sessionsList({ status: "" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.sessions.length, 4, "all four docs returned regardless of status/chunks");
  // Row shape matches recording-sessions exactly.
  for (const field of ["session_id", "hackerrank_username", "name", "room", "contest_slug", "chunk_count", "created_at", "status"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(res.body.sessions[0], field), `expected field ${field}`);
  }
});

test("sessions-list: status='locked' returns ONLY locked docs", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  await start(firestore, storage, { hackerrank_username: "alice" }); // active
  const bob = await start(firestore, storage, { hackerrank_username: "bob" });
  setStatus(firestore, bob.body.session_id, "locked");

  const res = await sessionsList({ status: "locked" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.sessions.length, 1, "only the locked doc");
  assert.equal(res.body.sessions[0].session_id, bob.body.session_id);
  assert.equal(res.body.sessions[0].status, "locked");
});

test("sessions-list: contest_slug and room scope the result", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  const contestSlug = "coding-contest-mcet-june-2026-slot-2";
  // Two rooms in the same contest.
  await start(firestore, storage, { hackerrank_username: "alice", room: "Lab-3" });
  await start(firestore, storage, { hackerrank_username: "bob", room: "Lab-4" });

  // contest_slug scope: both are in this contest, so status='' returns both.
  const all = await sessionsList({ contest_slug: contestSlug });
  assert.equal(all.body.sessions.length, 2, "both contest docs returned");
  // A non-matching contest_slug excludes everything.
  const none = await sessionsList({ contest_slug: "some-other-contest" });
  assert.equal(none.body.sessions.length, 0, "wrong contest_slug excludes all");

  // room scope: only the Lab-3 session.
  const lab3 = await sessionsList({ contest_slug: contestSlug, room: "Lab-3" });
  assert.equal(lab3.body.sessions.length, 1, "only the Lab-3 session");
  assert.equal(lab3.body.sessions[0].room, "Lab-3");
  assert.equal(lab3.body.sessions[0].hackerrank_username, "alice");
});

test("sessions-list: requires admin password", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  const res = await sessionsList({ status: "" }, {});
  assert.equal(res.statusCode, 401);
});

// Seed session docs DIRECTLY into the fake store (bypassing /api/session/start)
// so the cap/truncation tests below can create hundreds of docs cheaply. Each
// doc gets a monotonically increasing created_at, so seeding order == age order
// (later seeds are newer).
function seedSessionDocs(firestore, count, make = () => ({})) {
  firestore.collection(process.env.SESSION_COLLECTION); // materialize the store
  const store = firestore._collections.get(process.env.SESSION_COLLECTION);
  for (let i = 0; i < count; i += 1) {
    const seq = store.size;
    const doc = {
      session_id: `seed-${String(seq).padStart(5, "0")}`,
      hackerrank_username: `bulk_user_${seq}`,
      name: `Bulk User ${seq}`,
      room: "Lab-1",
      contest_slug: "bulk-contest",
      chunk_count: 0,
      created_at: new Date(Date.UTC(2026, 5, 9) + seq * 1000).toISOString(),
      status: "active",
      last_heartbeat_at: new Date().toISOString(),
      ...make(i)
    };
    store.set(doc.session_id, doc);
  }
}

test("sessions-list: capped page keeps live rows over newer ended rows (F6.4 join must see every live session)", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  // 30 live sessions created EARLY, then 600 ended rows created later — a plain
  // newest-500 cut would drop every live row, making the alerts-console join
  // render "no live session" (and hide Lock/End) for candidates who are live.
  seedSessionDocs(firestore, 30, () => ({ status: "active" }));
  seedSessionDocs(firestore, 600, () => ({ status: "ended" }));

  const res = await sessionsList({ status: "" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.sessions.length, 500, "the page stays capped at 500 rows");
  const liveRows = res.body.sessions.filter((row) => row.status !== "ended");
  assert.equal(liveRows.length, 30, "EVERY live row survives the cap");
  // Presentation order is unchanged: newest-first within the selected page.
  const stamps = res.body.sessions.map((row) => row.created_at);
  assert.deepEqual(stamps, [...stamps].sort((a, b) => b.localeCompare(a)), "page is newest-first");
  assert.equal(res.body.truncated, false, "live coverage is complete → not truncated");
});

test("sessions-list: truncated:true when live rows exceed the page cap", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  seedSessionDocs(firestore, 520, () => ({ status: "active" }));

  const res = await sessionsList({ status: "" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.sessions.length, 500, "the page stays capped");
  assert.equal(res.body.truncated, true, "live rows were cut → consumers must not trust the join");
});

test("sessions-list: truncated:true when the raw query hits SESSIONS_QUERY_LIMIT", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  // Exactly 2000 docs = the handler's SESSIONS_QUERY_LIMIT. The raw query has
  // no orderBy, so at the cap ARBITRARY docs (live ones included) may have been
  // dropped — the list must self-report as truncated even though the returned
  // page itself is small and the matched live rows fit.
  seedSessionDocs(firestore, 2000, () => ({ status: "ended" }));

  const res = await sessionsList({ status: "" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.truncated, true, "query-cap truncation is flagged");
});

// =====================================================================
// Session detail — GET /api/admin/session-detail (F6.3 detail card). ONE
// session doc projected to the least-privilege fields the admin card shows:
// identity (incl. roster id), status, IPs, and the doc's own counters. No
// email, no storage internals, no evidence/signed URLs.
// =====================================================================

function sessionDetail(query = {}, headers = ADMIN_HEADERS) {
  return call(makeReq({ method: "GET", path: "/api/admin/session-detail", headers, query }));
}

test("session-detail: returns the least-privilege projection for one session", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  const started = await start(firestore, storage, { hackerrank_username: "alice" });
  await recordChunk(started.body.session_id, 0);
  await recordChunk(started.body.session_id, 1);

  const res = await sessionDetail({ session_id: started.body.session_id });
  assert.equal(res.statusCode, 200);
  const detail = res.body.session;
  assert.equal(detail.session_id, started.body.session_id);
  assert.equal(detail.hackerrank_username, "alice");
  assert.equal(detail.name, "Alice Example");
  assert.equal(detail.roll_number, "R-1");
  assert.equal(detail.status, "active");
  assert.equal(detail.chunk_count, 2);
  // The card's IP block: start/current IP + mid-exam change count.
  assert.equal(typeof detail.start_ip, "string");
  assert.equal(typeof detail.current_ip, "string");
  assert.equal(detail.ip_change_count, 0);
  // Doc counters the card surfaces as cheap activity stats.
  for (const field of ["event_count", "clipboard_event_count", "focus_event_count", "heartbeat_count"]) {
    assert.equal(typeof detail[field], "number", `expected numeric ${field}`);
  }
  for (const field of ["roster_unique_id", "room", "contest_slug", "created_at", "updated_at", "blocked_by_session_id"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(detail, field), `expected field ${field}`);
  }
  // Least-privilege: NO email, NO storage internals, NO evidence/signed URLs.
  for (const field of ["email", "storage_prefix", "evidence", "merged_video_key"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(detail, field), false, `must not expose ${field}`);
  }
});

test("session-detail: 404 for an unknown session_id", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  __setClientsForTest({ firestore, storage });
  const res = await sessionDetail({ session_id: "no-such-session" });
  assert.equal(res.statusCode, 404);
});

test("session-detail: 400 when session_id is missing", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  __setClientsForTest({ firestore, storage });
  const res = await sessionDetail({});
  assert.equal(res.statusCode, 400);
});

test("session-detail: requires admin password", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  const res = await sessionDetail({ session_id: "x" }, {});
  assert.equal(res.statusCode, 401);
});

// =====================================================================
// Capture state — F6.6: the heartbeat already persists the recorder's
// composite recording_state ("combined:X;screen:Y;camera:Z;microphone:W")
// on the session doc; the admin surfaces get it back as a STRUCTURED
// per-source capture_state so the session card and the recordings header
// can say what the recording actually contains.
// =====================================================================

function heartbeatWith(sessionId, recordingState) {
  return call(makeReq({
    method: "POST",
    path: "/api/heartbeat",
    body: { session_id: sessionId, recording_state: recordingState, visibility_state: "visible" }
  }));
}

test("capture-state: session-detail exposes the per-source state parsed from the heartbeat", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  const started = await start(firestore, storage);
  await heartbeatWith(started.body.session_id, "combined:recording;screen:recording;camera:permission_denied;microphone:recording");

  const res = await sessionDetail({ session_id: started.body.session_id });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.session.capture_state, {
    screen: "recording",
    camera: "permission_denied",
    microphone: "recording"
  });
});

test("capture-state: a bare legacy recording_state (or none yet) → capture_state null", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);

  // No heartbeat yet — nothing reported.
  const fresh = await start(firestore, storage);
  const before = await sessionDetail({ session_id: fresh.body.session_id });
  assert.equal(before.body.session.capture_state, null);

  // Legacy bare string — no per-source segments to project.
  await heartbeatWith(fresh.body.session_id, "recording");
  const after = await sessionDetail({ session_id: fresh.body.session_id });
  assert.equal(after.body.session.capture_state, null);
});

test("capture-state: an unexpected segment value projects as 'unknown' (never leaks raw)", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  const started = await start(firestore, storage);
  await heartbeatWith(started.body.session_id, "combined:recording;screen:recording;camera:weird-future-state;microphone:unavailable");

  const res = await sessionDetail({ session_id: started.body.session_id });
  assert.deepEqual(res.body.session.capture_state, {
    screen: "recording",
    camera: "unknown",
    microphone: "unavailable"
  });
});

test("capture-state: GET /api/admin/sessions rows carry capture_state (recordings header)", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  const started = await start(firestore, storage, { hackerrank_username: "alice" });
  await heartbeatWith(started.body.session_id, "combined:recording;screen:recording;camera:unavailable;microphone:permission_denied");

  const res = await call(makeReq({
    method: "GET",
    path: "/api/admin/sessions",
    headers: ADMIN_HEADERS,
    query: { username: "alice" }
  }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.sessions[0].capture_state, {
    screen: "recording",
    camera: "unavailable",
    microphone: "permission_denied"
  });
});

// =====================================================================
// Submission-time markers — POST /api/submission-events + GET /api/admin/submission-events
// =====================================================================

const INGEST_HEADERS = { "x-api-key": process.env.ALERTS_INGEST_API_KEY };

function submissionEvent(overrides = {}) {
  return {
    hackerrank_username: "Alice",
    contest_slug: "mcet-june-2026",
    submission_id: 1001,
    challenge_slug: "two-sum",
    challenge_name: "Two Sum",
    lang: "python3",
    status: "Accepted",
    valid: true,
    submitted_at: "2026-06-05T09:05:00.000Z",
    ...overrides
  };
}

test("submission-events: ingest stores a per-(user,contest) doc and admin reads it sorted ascending", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });

  const res = await call(makeReq({
    method: "POST",
    path: "/api/submission-events",
    headers: INGEST_HEADERS,
    body: {
      events: [
        submissionEvent({ submission_id: 1002, submitted_at: "2026-06-05T09:10:00.000Z", status: "Wrong Answer", valid: false }),
        submissionEvent({ submission_id: 1001, submitted_at: "2026-06-05T09:05:00.000Z" })
      ]
    }
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.stored, 2);

  // One doc per (username_norm, contest_slug).
  const store = firestore._collections.get(process.env.SUBMISSION_EVENTS_COLLECTION);
  assert.equal(store.size, 1, "one merged doc per (username_norm, contest_slug)");
  assert.ok(store.has("alice:mcet-june-2026"), `expected keyed doc, got ${[...store.keys()]}`);

  const read = await call(makeReq({
    method: "GET",
    path: "/api/admin/submission-events",
    headers: ADMIN_HEADERS,
    query: { username: "Alice", contest_slug: "mcet-june-2026" }
  }));
  assert.equal(read.statusCode, 200);
  assert.equal(read.body.events.length, 2);
  // Sorted by submitted_at ascending.
  assert.equal(read.body.events[0].submission_id, "1001");
  assert.equal(read.body.events[1].submission_id, "1002");
  assert.equal(read.body.events[0].valid, true);
  assert.equal(read.body.events[1].valid, false);
});

test("submission-events: re-posting the same submission_id de-dups (idempotent upsert)", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });

  const post = (status, valid) => call(makeReq({
    method: "POST",
    path: "/api/submission-events",
    headers: INGEST_HEADERS,
    body: { events: [submissionEvent({ submission_id: 2001, status, valid })] }
  }));

  await post("Processing", false); // would be skipped poller-side, but exercise de-dup
  await post("Accepted", true); // re-post same id with a terminal classification

  const read = await call(makeReq({
    method: "GET",
    path: "/api/admin/submission-events",
    headers: ADMIN_HEADERS,
    query: { username: "Alice", contest_slug: "mcet-june-2026" }
  }));
  assert.equal(read.body.events.length, 1, "same submission_id de-duped to one event");
  assert.equal(read.body.events[0].status, "Accepted", "later post overwrites the earlier one");
  assert.equal(read.body.events[0].valid, true);
});

test("submission-events: admin read with NO contest_slug merges across contests", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });

  await call(makeReq({
    method: "POST",
    path: "/api/submission-events",
    headers: INGEST_HEADERS,
    body: {
      events: [
        submissionEvent({ contest_slug: "contest-a", submission_id: 3001, submitted_at: "2026-06-05T09:01:00.000Z" }),
        submissionEvent({ contest_slug: "contest-b", submission_id: 3002, submitted_at: "2026-06-05T09:02:00.000Z", valid: false, status: "Runtime Error" })
      ]
    }
  }));

  const read = await call(makeReq({
    method: "GET",
    path: "/api/admin/submission-events",
    headers: ADMIN_HEADERS,
    query: { username: "Alice" } // no contest_slug → merge across contests
  }));
  assert.equal(read.statusCode, 200);
  assert.equal(read.body.events.length, 2, "events from both contests merged");
  assert.equal(read.body.events[0].submission_id, "3001");
  assert.equal(read.body.events[1].submission_id, "3002");
});

test("submission-events: ingest requires the api key (401 without x-api-key)", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  const res = await call(makeReq({
    method: "POST",
    path: "/api/submission-events",
    headers: {}, // no x-api-key
    body: { events: [submissionEvent()] }
  }));
  assert.equal(res.statusCode, 401);
});

test("submission-events: admin read requires the admin password (401 without it)", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  const res = await call(makeReq({
    method: "GET",
    path: "/api/admin/submission-events",
    headers: {}, // no x-admin-password
    query: { username: "Alice" }
  }));
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

// A pure-dot value on a NON-username segment (upload `kind`) must not produce
// a traversal in any object key. F10.1 strengthened the M1 guarantee: kind is
// now an ALLOWLIST (screen | camera), so a dot kind is rejected outright
// instead of being sanitized into a "_" folder (cameraRecording.test.mjs
// covers the allowlist itself).
test("M1: upload kind '..' → rejected outright, no traversal possible", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  const sessionId = await startedSession(firestore, storage);
  const res = await call(makeReq({
    method: "POST",
    path: "/api/upload-url",
    body: { session_id: sessionId, kind: "..", chunk_index: 0, content_type: "video/webm" }
  }));
  assert.equal(res.statusCode, 400);
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

// =====================================================================
// Multi-reviewer recording review: roster, priority serving, claim
// atomicity, verdicts. All through the public api() + the DI seam.
// =====================================================================

const REVIEW_STATE = process.env.REVIEW_STATE_COLLECTION;
const REVIEW_REVIEWS = process.env.REVIEW_COLLECTION;
const REVIEW_CLAIMS = process.env.REVIEW_CLAIMS_COLLECTION;

function reviewEnv() {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  return { firestore, storage };
}

async function setRoster(usernames) {
  return call(makeReq({
    method: "POST", path: "/api/admin/review-roster",
    headers: ADMIN_HEADERS, body: { usernames }
  }));
}

async function getRosterSummary() {
  return call(makeReq({ method: "GET", path: "/api/admin/review-roster", headers: ADMIN_HEADERS }));
}

async function reviewNext(reviewerName) {
  return call(makeReq({
    method: "POST", path: "/api/admin/review-next",
    headers: ADMIN_HEADERS, body: { reviewer_name: reviewerName }
  }));
}

async function reviewVerdict(username, reviewerName, verdict) {
  return call(makeReq({
    method: "POST", path: "/api/admin/review-verdict",
    headers: ADMIN_HEADERS, body: { username, reviewer_name: reviewerName, verdict }
  }));
}

// Seed a completed review directly into the fake reviews collection (id =
// `<username_norm>::<reviewerKey>`), matching the handler's record shape. Used to
// craft a precise priority state without driving the full claim→verdict flow.
function seedReview(firestore, { username, reviewer, verdict, createdAt }) {
  const norm = String(username).trim().toLowerCase().replace(/[^a-z0-9._-]/g, "_");
  const reviewerKey = String(reviewer).trim().toLowerCase().replace(/[^a-z0-9._-]/g, "_");
  const now = createdAt || new Date().toISOString();
  firestore.collection(REVIEW_REVIEWS).doc(`${norm}::${reviewerKey}`).set({
    username, username_norm: norm, reviewer_name: reviewer, verdict, created_at: now, updated_at: now
  });
}

// Seed a claim doc directly (to simulate another reviewer holding/expiring it).
function seedClaim(firestore, { username, reviewer, claimedAt }) {
  const norm = String(username).trim().toLowerCase().replace(/[^a-z0-9._-]/g, "_");
  firestore.collection(REVIEW_CLAIMS).doc(norm).set({
    username_norm: norm, reviewer_name: reviewer, claimed_at: claimedAt
  });
}

// ---- Roster set / replace / get + summary -------------------------------

test("review roster: set normalizes (trim, drop blanks, dedupe by norm, keep order+display)", async () => {
  reviewEnv();
  const res = await setRoster(["  Alice ", "Bob", "", "  ", "alice", "Carol", "BOB"]);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.count, 3, "Alice/alice and Bob/BOB dedupe by norm; blanks dropped");

  const summary = await getRosterSummary();
  assert.deepEqual(summary.body.usernames, ["Alice", "Bob", "Carol"], "first-seen display form + roster order kept");
  assert.equal(summary.body.total, 3);
});

test("review roster: POST replaces the roster wholesale (not append)", async () => {
  reviewEnv();
  await setRoster(["Alice", "Bob"]);
  await setRoster(["Carol", "Dave"]);
  const summary = await getRosterSummary();
  assert.deepEqual(summary.body.usernames, ["Carol", "Dave"], "second set replaces the first");
});

test("review roster: summary counts derive from reviews + claims", async () => {
  const { firestore } = reviewEnv();
  await setRoster(["Alice", "Bob", "Carol", "Dave"]);
  // Alice: 0 reviews. Bob: 1 review. Carol: 2 reviews. Dave: 1 review + active claim.
  seedReview(firestore, { username: "Bob", reviewer: "R1", verdict: 1 });
  seedReview(firestore, { username: "Carol", reviewer: "R1", verdict: 1 });
  seedReview(firestore, { username: "Carol", reviewer: "R2", verdict: 0 });
  seedReview(firestore, { username: "Dave", reviewer: "R1", verdict: 0 });
  seedClaim(firestore, { username: "Dave", reviewer: "R2", claimedAt: new Date().toISOString() });

  const summary = await getRosterSummary();
  assert.equal(summary.body.with_0_reviews, 1, "Alice");
  assert.equal(summary.body.with_1_review, 2, "Bob + Dave");
  assert.equal(summary.body.with_2plus_reviews, 1, "Carol");
  assert.equal(summary.body.active_claims, 1, "Dave's live claim");
});

test("review roster: GET empty roster → zeros, not an error", async () => {
  reviewEnv();
  const summary = await getRosterSummary();
  assert.equal(summary.statusCode, 200);
  assert.deepEqual(summary.body.usernames, []);
  assert.equal(summary.body.total, 0);
  assert.equal(summary.body.active_claims, 0);
});

// ---- Priority serving ----------------------------------------------------

test("review priority: bucket 0 (unreviewed) is served before any 1-review student", async () => {
  const { firestore } = reviewEnv();
  await setRoster(["Alice", "Bob"]);
  // Bob already has 1 (positive) review; Alice has 0 → Alice (bucket 0) wins.
  seedReview(firestore, { username: "Bob", reviewer: "R1", verdict: 1 });
  const res = await reviewNext("R2");
  assert.equal(res.body.username, "Alice");
});

test("review priority: full bucket order 0 < 1(pos) < 2(neg) < 3, and bucket-3 highest-pos first", async () => {
  const { firestore } = reviewEnv();
  // Roster crafted so each student lands in a distinct bucket; A is the only
  // bucket-0, so we verify order by serving, recording a verdict to advance, and
  // re-serving. To isolate ordering we instead read the priority via sequential
  // pulls by a reviewer who hasn't touched anyone.
  await setRoster(["Zero", "OnePos", "OneNeg", "TwoLow", "TwoHigh"]);
  // Zero: 0 reviews (bucket 0)
  // OnePos: 1 review, pos==1 (bucket 1)
  seedReview(firestore, { username: "OnePos", reviewer: "Ra", verdict: 1 });
  // OneNeg: 1 review, pos==0 (bucket 2)
  seedReview(firestore, { username: "OneNeg", reviewer: "Ra", verdict: 0 });
  // TwoLow: 2 reviews, pos==0 (bucket 3, pos 0)
  seedReview(firestore, { username: "TwoLow", reviewer: "Ra", verdict: 0 });
  seedReview(firestore, { username: "TwoLow", reviewer: "Rb", verdict: 0 });
  // TwoHigh: 2 reviews, pos==2 (bucket 3, pos 2 — top of bucket 3)
  seedReview(firestore, { username: "TwoHigh", reviewer: "Ra", verdict: 1 });
  seedReview(firestore, { username: "TwoHigh", reviewer: "Rb", verdict: 1 });

  // Reviewer "Fresh" has reviewed nobody, so candidacy is unaffected; each pull
  // claims the served username (blocking a re-serve), so a sequence of pulls by
  // DISTINCT fresh reviewers reveals the global priority order.
  const order = [];
  for (const reviewer of ["F1", "F2", "F3", "F4", "F5"]) {
    const res = await reviewNext(reviewer);
    order.push(res.body.username);
  }
  assert.deepEqual(order, ["Zero", "OnePos", "OneNeg", "TwoHigh", "TwoLow"],
    "0 < 1pos < 1neg < bucket3(highest pos first)");
});

test("review priority: within a bucket, roster order is the tiebreak", async () => {
  reviewEnv();
  await setRoster(["Charlie", "Alice", "Bob"]); // all bucket 0
  const res = await reviewNext("R1");
  assert.equal(res.body.username, "Charlie", "roster order, not alphabetical");
});

test("review priority: bucket 3 tiebreak is pos DESC then r ASC then roster order", async () => {
  const { firestore } = reviewEnv();
  await setRoster(["P1R3", "P1R2", "P2R2"]);
  // P1R3: pos1, r3
  seedReview(firestore, { username: "P1R3", reviewer: "Ra", verdict: 1 });
  seedReview(firestore, { username: "P1R3", reviewer: "Rb", verdict: 0 });
  seedReview(firestore, { username: "P1R3", reviewer: "Rc", verdict: 0 });
  // P1R2: pos1, r2
  seedReview(firestore, { username: "P1R2", reviewer: "Ra", verdict: 1 });
  seedReview(firestore, { username: "P1R2", reviewer: "Rb", verdict: 0 });
  // P2R2: pos2, r2 — highest pos → first
  seedReview(firestore, { username: "P2R2", reviewer: "Ra", verdict: 1 });
  seedReview(firestore, { username: "P2R2", reviewer: "Rb", verdict: 1 });

  const order = [];
  for (const reviewer of ["F1", "F2", "F3"]) {
    order.push((await reviewNext(reviewer)).body.username);
  }
  // P2R2 (pos2) first; then P1R2 vs P1R3 both pos1 → fewer reviews (r2) first.
  assert.deepEqual(order, ["P2R2", "P1R2", "P1R3"]);
});

test("review priority: empty roster → {done:true}", async () => {
  reviewEnv();
  const res = await reviewNext("R1");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.done, true);
});

test("review-next: missing/blank reviewer_name → 400", async () => {
  reviewEnv();
  await setRoster(["Alice"]);
  const missing = await call(makeReq({ method: "POST", path: "/api/admin/review-next", headers: ADMIN_HEADERS, body: {} }));
  assert.equal(missing.statusCode, 400);
  const blank = await reviewNext("   ");
  assert.equal(blank.statusCode, 400);
});

// ---- Never re-serve a username a reviewer already reviewed ----------------

test("review: a reviewer is NEVER served a username they already reviewed", async () => {
  const { firestore } = reviewEnv();
  await setRoster(["Alice", "Bob"]);
  // R1 already reviewed Alice → R1 must be served Bob (not Alice again), even
  // though Alice (bucket 0... actually 1 review now) vs Bob (0) — Bob is bucket 0
  // and Alice is excluded for R1 anyway.
  seedReview(firestore, { username: "Alice", reviewer: "R1", verdict: 1 });
  const res = await reviewNext("R1");
  assert.equal(res.body.username, "Bob");

  // Now R1 has reviewed Alice; if Bob also gets claimed-and-verdicted by R1,
  // there is nothing left for R1.
  await reviewVerdict("Bob", "R1", 0);
  const next = await reviewNext("R1");
  assert.equal(next.body.done, true, "R1 has reviewed everyone → done");
});

test("review: the SAME username is intentionally served to DIFFERENT reviewers", async () => {
  reviewEnv();
  await setRoster(["Solo"]);
  const r1 = await reviewNext("R1");
  assert.equal(r1.body.username, "Solo");
  await reviewVerdict("Solo", "R1", 1); // releases claim
  const r2 = await reviewNext("R2");
  assert.equal(r2.body.username, "Solo", "a second reviewer still gets Solo");
});

// ---- Claim atomicity ------------------------------------------------------

test("review claim: two concurrent review-next calls never get the same username", async () => {
  reviewEnv();
  await setRoster(["Solo"]); // only ONE candidate so both reviewers contend
  // Fire both concurrently against the same fake firestore; the atomic .create()
  // on the claim doc must let exactly one win Solo and the other get {done:true}.
  const [a, b] = await Promise.all([reviewNext("R1"), reviewNext("R2")]);
  const usernames = [a.body.username, b.body.username].filter(Boolean);
  const dones = [a.body.done, b.body.done].filter(Boolean);
  assert.equal(usernames.length, 1, "exactly one reviewer is served Solo");
  assert.equal(usernames[0], "Solo");
  assert.equal(dones.length, 1, "the other reviewer gets done:true");
});

test("review claim: an active claim by another reviewer hides the username; an EXPIRED claim is reclaimable", async () => {
  const { firestore } = reviewEnv();
  await setRoster(["Solo"]);
  // Fresh claim by R1 → R2 sees nothing.
  seedClaim(firestore, { username: "Solo", reviewer: "R1", claimedAt: new Date().toISOString() });
  const blocked = await reviewNext("R2");
  assert.equal(blocked.body.done, true, "live claim by R1 hides Solo from R2");

  // Expire the claim (older than CLAIM_TTL_MS = 10 min) → R2 can reclaim.
  seedClaim(firestore, { username: "Solo", reviewer: "R1", claimedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString() });
  const reclaimed = await reviewNext("R2");
  assert.equal(reclaimed.body.username, "Solo", "expired claim is free → R2 reclaims");
});

test("review claim: submitting a verdict releases (deletes) the claim", async () => {
  const { firestore } = reviewEnv();
  await setRoster(["Solo"]);
  await reviewNext("R1"); // R1 claims Solo
  // A second reviewer is blocked while the claim is live.
  assert.equal((await reviewNext("R2")).body.done, true);
  // R1 submits → claim released.
  const verdict = await reviewVerdict("Solo", "R1", 1);
  assert.equal(verdict.body.ok, true);
  assert.equal(firestore._collections.get(REVIEW_CLAIMS)?.has("solo"), false, "claim doc deleted on verdict");
  // Now R2 can be served Solo.
  assert.equal((await reviewNext("R2")).body.username, "Solo");
});

// ---- Verdict validation + idempotency ------------------------------------

test("review verdict: only roster usernames + verdict∈{0,1}; idempotent overwrite", async () => {
  reviewEnv();
  await setRoster(["Alice"]);
  // Not on roster.
  const offRoster = await reviewVerdict("Mallory", "R1", 1);
  assert.equal(offRoster.statusCode, 400);
  // Bad verdict.
  assert.equal((await reviewVerdict("Alice", "R1", 2)).statusCode, 400);
  assert.equal((await reviewVerdict("Alice", "R1", "yes")).statusCode, 400);

  // Valid; then re-verdict overwrites (still one row for Alice::R1).
  assert.equal((await reviewVerdict("Alice", "R1", 1)).body.ok, true);
  assert.equal((await reviewVerdict("Alice", "R1", 0)).body.ok, true);
  const all = await call(makeReq({ method: "GET", path: "/api/admin/reviews", headers: ADMIN_HEADERS }));
  const aliceRows = all.body.reviews.filter((r) => r.username === "Alice");
  assert.equal(aliceRows.length, 1, "re-verdict overwrites the same (username,reviewer) doc");
  assert.equal(aliceRows[0].verdict, 0, "latest verdict wins");
});

test("review verdict: created_at is set once and preserved across a re-verdict", async () => {
  const { firestore } = reviewEnv();
  await setRoster(["Alice"]);
  await reviewVerdict("Alice", "R1", 1);
  const firstCreated = firestore.collection(REVIEW_REVIEWS).doc("alice::r1");
  const created1 = (await firstCreated.get()).data().created_at;
  await reviewVerdict("Alice", "R1", 0);
  const created2 = (await firstCreated.get()).data().created_at;
  assert.equal(created1, created2, "created_at preserved on re-verdict");
});

// ---- review-mine + reviews -----------------------------------------------

test("review-mine: filters by reviewer, newest first", async () => {
  const { firestore } = reviewEnv();
  await setRoster(["Alice", "Bob", "Carol"]);
  seedReview(firestore, { username: "Alice", reviewer: "R1", verdict: 1, createdAt: "2026-06-01T00:00:00Z" });
  seedReview(firestore, { username: "Bob", reviewer: "R1", verdict: 0, createdAt: "2026-06-03T00:00:00Z" });
  seedReview(firestore, { username: "Carol", reviewer: "R2", verdict: 1, createdAt: "2026-06-02T00:00:00Z" });

  const mine = await call(makeReq({
    method: "GET", path: "/api/admin/review-mine",
    headers: ADMIN_HEADERS, query: { reviewer_name: "R1" }
  }));
  assert.equal(mine.body.count, 2, "only R1's reviews");
  assert.deepEqual(mine.body.reviews.map((r) => r.username), ["Bob", "Alice"], "newest first");
  assert.equal(mine.body.reviews.every((r) => r.username !== "Carol"), true, "R2's review excluded");
});

test("review-mine: missing reviewer_name → 400", async () => {
  reviewEnv();
  const res = await call(makeReq({ method: "GET", path: "/api/admin/review-mine", headers: ADMIN_HEADERS, query: {} }));
  assert.equal(res.statusCode, 400);
});

test("reviews: returns ALL rows incl. multiple per username; supports ?username filter", async () => {
  const { firestore } = reviewEnv();
  await setRoster(["Alice", "Bob"]);
  seedReview(firestore, { username: "Alice", reviewer: "R1", verdict: 1 });
  seedReview(firestore, { username: "Alice", reviewer: "R2", verdict: 0 });
  seedReview(firestore, { username: "Bob", reviewer: "R1", verdict: 1 });

  const all = await call(makeReq({ method: "GET", path: "/api/admin/reviews", headers: ADMIN_HEADERS }));
  assert.equal(all.body.reviews.length, 3, "all rows returned");
  assert.equal(all.body.reviews.filter((r) => r.username === "Alice").length, 2, "two reviewers for Alice");
  // Shape suitable for the CSV username,reviewer_name,verdict.
  for (const row of all.body.reviews) {
    assert.ok("username" in row && "reviewer_name" in row && "verdict" in row);
  }

  const filtered = await call(makeReq({
    method: "GET", path: "/api/admin/reviews",
    headers: ADMIN_HEADERS, query: { username: "Alice" }
  }));
  assert.equal(filtered.body.reviews.length, 2, "?username filter scopes to Alice");
  assert.equal(filtered.body.reviews.every((r) => r.username === "Alice"), true);
});

// ---- Auth: every review route requires admin -----------------------------

test("review routes: all require x-admin-password", async () => {
  reviewEnv();
  const calls = [
    makeReq({ method: "POST", path: "/api/admin/review-roster", body: { usernames: [] } }),
    makeReq({ method: "GET", path: "/api/admin/review-roster" }),
    makeReq({ method: "POST", path: "/api/admin/review-next", body: { reviewer_name: "R1" } }),
    makeReq({ method: "POST", path: "/api/admin/review-verdict", body: { username: "A", reviewer_name: "R1", verdict: 1 } }),
    makeReq({ method: "GET", path: "/api/admin/review-mine", query: { reviewer_name: "R1" } }),
    makeReq({ method: "GET", path: "/api/admin/reviews" })
  ];
  for (const req of calls) {
    const res = await call(req);
    assert.equal(res.statusCode, 401, `${req.method} ${req.path} must require admin`);
  }
});

// =====================================================================
// F6.7 — GET /api/admin/session-events (recordings timeline event log)
// =====================================================================
// The candidate's proctor events live as JSONL objects under the session's
// GCS prefix (events/events-*.jsonl batches, events/session.jsonl, and
// events/ip-change-*.jsonl). This endpoint lists + parses them for the admin
// recordings timeline: least-privilege projection ({type, timestamp, small
// scalar detail}), ordered by time, capped.

test("session-events: requires admin", async () => {
  __setClientsForTest({ firestore: makeFakeFirestore(), storage: makeFakeStorage() });
  const res = await call(makeReq({ method: "GET", path: "/api/admin/session-events", query: { session_id: "s1" } }));
  assert.equal(res.statusCode, 401);
});

test("session-events: session_id required → 400; unknown session → 404", async () => {
  __setClientsForTest({ firestore: makeFakeFirestore(), storage: makeFakeStorage() });
  const missing = await call(makeReq({ method: "GET", path: "/api/admin/session-events", headers: ADMIN_HEADERS }));
  assert.equal(missing.statusCode, 400);
  const unknown = await call(makeReq({
    method: "GET", path: "/api/admin/session-events", headers: ADMIN_HEADERS, query: { session_id: "nope" }
  }));
  assert.equal(unknown.statusCode, 404);
});

test("session-events: merges every events/ jsonl, time-ordered, least-privilege projection", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  const sessionId = await startedSession(firestore, storage);

  // Two batches posted OUT OF ORDER (later batch first) so the read must sort.
  await call(makeReq({
    method: "POST",
    path: "/api/events",
    body: {
      session_id: sessionId,
      events: [
        // detail carries a GCS storage_key (must be dropped), a nested object
        // (must be dropped — scalars only), and an oversized string (truncated).
        { type: "chunk_uploaded", timestamp: "2026-06-05T10:05:00Z", detail: { kind: "screen", index: 3, storage_key: "contests/c/x.webm", nested: { deep: 1 }, message: "y".repeat(500) } },
        { type: "window_blur", timestamp: "2026-06-05T10:04:00Z" }
      ]
    }
  }));
  await call(makeReq({
    method: "POST",
    path: "/api/events",
    body: {
      session_id: sessionId,
      events: [
        { type: "visibility_change", timestamp: "2026-06-05T10:01:00Z", visibility_state: "hidden", detail: { state: "hidden" } },
        { type: "clipboard_activity", timestamp: "2026-06-05T10:02:30Z", detail: { action: "paste", length: 42 } }
      ]
    }
  }));

  const res = await call(makeReq({
    method: "GET", path: "/api/admin/session-events", headers: ADMIN_HEADERS, query: { session_id: sessionId }
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.truncated, false);

  const events = res.body.events;
  // 4 posted events + the session_started record from events/session.jsonl.
  assert.equal(events.length, 5, JSON.stringify(events.map((e) => e.type)));
  const stamps = events.map((e) => e.timestamp);
  assert.deepEqual(stamps, [...stamps].sort(), "events must be time-ordered ascending");
  assert.ok(events.some((e) => e.type === "session_started"), "session.jsonl record included");

  // Least-privilege projection: exactly {type, timestamp, detail} per event.
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), ["detail", "timestamp", "type"]);
  }
  const uploaded = events.find((e) => e.type === "chunk_uploaded");
  assert.equal(uploaded.detail.storage_key, undefined, "storage_key must be dropped");
  assert.equal(uploaded.detail.nested, undefined, "nested objects must be dropped (scalars only)");
  assert.equal(uploaded.detail.message.length, 200, "long strings truncated to 200 chars");
  assert.equal(uploaded.detail.index, 3, "numeric scalars kept");
  const clipboard = events.find((e) => e.type === "clipboard_activity");
  assert.deepEqual(clipboard.detail, { action: "paste", length: 42 });
});

test("session-events: includes ip-change jsonl records written outside /api/events", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  const sessionId = await startedSession(firestore, storage);
  const prefix = firestore._collections.get(process.env.SESSION_COLLECTION).get(sessionId).storage_prefix;

  // The heartbeat path writes ip-change records as their own jsonl objects.
  storage._saved.set(
    `${prefix}events/ip-change-1234-abcd.jsonl`,
    JSON.stringify({ type: "ip_address_changed", timestamp: "2026-06-05T10:03:00Z", detail: { previous_ip: "10.0.0.1", current_ip: "10.0.0.2" } }) + "\n"
  );

  const res = await call(makeReq({
    method: "GET", path: "/api/admin/session-events", headers: ADMIN_HEADERS, query: { session_id: sessionId }
  }));
  assert.equal(res.statusCode, 200);
  const ipChange = res.body.events.find((e) => e.type === "ip_address_changed");
  assert.ok(ipChange, "ip-change record included");
  assert.equal(ipChange.detail.current_ip, "10.0.0.2");
});

test("session-events: caps the merged list and flags truncation", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  const sessionId = await startedSession(firestore, storage);
  const prefix = firestore._collections.get(process.env.SESSION_COLLECTION).get(sessionId).storage_prefix;

  // 2100 records in one jsonl (the cap is 2000). Malformed lines are skipped.
  const lines = [];
  for (let i = 0; i < 2100; i += 1) {
    lines.push(JSON.stringify({ type: "window_blur", timestamp: `2026-06-05T10:00:00.${String(i).padStart(4, "0")}Z` }));
  }
  lines.push("not-json {");
  storage._saved.set(`${prefix}events/events-1-bulk.jsonl`, lines.join("\n") + "\n");

  const res = await call(makeReq({
    method: "GET", path: "/api/admin/session-events", headers: ADMIN_HEADERS, query: { session_id: sessionId }
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.events.length, 2000, "capped at 2000");
  assert.equal(res.body.truncated, true);
});
