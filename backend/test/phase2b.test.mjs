import assert from "node:assert/strict";
import test from "node:test";

// Phase 2 (extension) backend tests: alert archive, room filtering + rooms list,
// proctor alert settings (disable/severity override), the liveness beacon, and
// the derived disconnected count from a stale heartbeat. All Firestore/Storage
// access is mocked through the __setClientsForTest DI seam — no real GCP.
//
// Env must be set BEFORE importing the handler (it reads env at module load). A
// unique ?phase2b query string gives a fresh module instance independent of the
// other test files (which configure different collections).
const TEST_ADMIN_PASSWORD = "admin-pass-phase2b";
process.env.ALERTS_INGEST_API_KEY = "phase2b-ingest-key-placeholder-not-a-real-secret";
process.env.ALERTS_COLLECTION = "phase2b_alerts";
process.env.SESSION_COLLECTION = "phase2b_sessions";
process.env.SETTINGS_COLLECTION = "phase2b_settings";
process.env.EVIDENCE_BUCKET = "phase2b-bucket";
process.env.ADMIN_PASSWORD = TEST_ADMIN_PASSWORD;
process.env.DISCONNECTED_STALENESS_MS = "45000";

const handler = await import("../src/handler.mjs?phase2b");
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

// ---- Fake Storage ---------------------------------------------------------

function makeFakeStorage() {
  const saved = new Map();
  return {
    _saved: saved,
    bucket() {
      return {
        file(key) {
          return {
            async save(body) { saved.set(key, body); },
            async getSignedUrl() { return [`https://signed.example/${key}`]; },
            async getMetadata() { return [{ size: 1, updated: "2026-06-05T00:00:00Z" }]; }
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
    get(name) { return lowerHeaders[String(name).toLowerCase()]; }
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

function seedSettings(firestore, { contestUrl = "https://www.hackerrank.com/contests/coding-contest-mcet-june-2026-slot-2" } = {}) {
  firestore.collection(process.env.SETTINGS_COLLECTION).doc("active").set({
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

// Seed an alert doc straight into the fake store (bypassing ingest auth).
function seedAlert(firestore, alert) {
  firestore.collection(process.env.ALERTS_COLLECTION).doc(alert.id).set({ ...alert });
}

// =====================================================================
// 1 — ALERT ARCHIVE
// =====================================================================

test("archive: adminAlerts EXCLUDES archived alerts by default", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  seedAlert(firestore, { id: "a1", source: "proctor", type: "recording_stopped", severity: "critical", timestamp: "2026-06-05T10:00:00Z", title: "x" });
  seedAlert(firestore, { id: "a2", source: "proctor", type: "ip_changed", severity: "warning", timestamp: "2026-06-05T11:00:00Z", title: "y", archived: true, archived_at: "2026-06-05T11:30:00Z" });

  const res = await call(makeReq({ method: "GET", path: "/api/admin/alerts", headers: ADMIN_HEADERS }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.alerts.map((a) => a.id), ["a1"], "archived a2 is hidden by default");
});

test("archive: ?include_archived=true INCLUDES archived alerts", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  seedAlert(firestore, { id: "a1", source: "proctor", type: "recording_stopped", severity: "critical", timestamp: "2026-06-05T10:00:00Z", title: "x" });
  seedAlert(firestore, { id: "a2", source: "proctor", type: "ip_changed", severity: "warning", timestamp: "2026-06-05T11:00:00Z", title: "y", archived: true });

  const res = await call(makeReq({
    method: "GET", path: "/api/admin/alerts", headers: ADMIN_HEADERS,
    query: { include_archived: "true" }
  }));
  assert.deepEqual(res.body.alerts.map((a) => a.id).sort(), ["a1", "a2"], "both shown when include_archived");
});

test("archive: POST /api/admin/alert-action archive sets archived + archived_at; unarchive clears them", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  seedAlert(firestore, { id: "a1", source: "proctor", type: "recording_stopped", severity: "critical", timestamp: "2026-06-05T10:00:00Z", title: "x" });
  seedAlert(firestore, { id: "a2", source: "proctor", type: "ip_changed", severity: "warning", timestamp: "2026-06-05T11:00:00Z", title: "y" });
  const store = firestore._collections.get(process.env.ALERTS_COLLECTION);

  const archiveRes = await call(makeReq({
    method: "POST", path: "/api/admin/alert-action", headers: ADMIN_HEADERS,
    body: { action: "archive", ids: ["a1", "a2"] }
  }));
  assert.equal(archiveRes.statusCode, 200);
  assert.deepEqual(archiveRes.body.updated.sort(), ["a1", "a2"]);
  assert.equal(store.get("a1").archived, true);
  assert.ok(store.get("a1").archived_at, "archived_at stamped");
  assert.equal(store.get("a2").archived, true);

  // After archiving, default listing is empty.
  const hidden = await call(makeReq({ method: "GET", path: "/api/admin/alerts", headers: ADMIN_HEADERS }));
  assert.equal(hidden.body.alerts.length, 0, "both archived → none in default listing");

  // Unarchive a1 brings it back.
  const unarchiveRes = await call(makeReq({
    method: "POST", path: "/api/admin/alert-action", headers: ADMIN_HEADERS,
    body: { action: "unarchive", ids: ["a1"] }
  }));
  assert.equal(unarchiveRes.statusCode, 200);
  assert.equal(store.get("a1").archived, false);
  assert.equal(store.get("a1").archived_at, null, "archived_at cleared on unarchive");

  const after = await call(makeReq({ method: "GET", path: "/api/admin/alerts", headers: ADMIN_HEADERS }));
  assert.deepEqual(after.body.alerts.map((a) => a.id), ["a1"], "unarchived a1 reappears");
});

test("archive: alert-action reports missing ids and does not 500 the batch", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  seedAlert(firestore, { id: "a1", source: "proctor", type: "recording_stopped", severity: "critical", timestamp: "2026-06-05T10:00:00Z", title: "x" });

  const res = await call(makeReq({
    method: "POST", path: "/api/admin/alert-action", headers: ADMIN_HEADERS,
    body: { action: "archive", ids: ["a1", "ghost"] }
  }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.updated, ["a1"]);
  assert.deepEqual(res.body.missing, ["ghost"]);
});

test("archive: alert-action validates action and non-empty ids", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });

  const badAction = await call(makeReq({
    method: "POST", path: "/api/admin/alert-action", headers: ADMIN_HEADERS,
    body: { action: "delete", ids: ["a1"] }
  }));
  assert.equal(badAction.statusCode, 400);

  const noIds = await call(makeReq({
    method: "POST", path: "/api/admin/alert-action", headers: ADMIN_HEADERS,
    body: { action: "archive", ids: [] }
  }));
  assert.equal(noIds.statusCode, 400);
});

test("archive: alert-action requires admin password", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  const res = await call(makeReq({ method: "POST", path: "/api/admin/alert-action", headers: {}, body: { action: "archive", ids: ["a1"] } }));
  assert.equal(res.statusCode, 401);
});

// =====================================================================
// 2 — ROOM FILTERS + rooms list
// =====================================================================

test("rooms: adminAlerts filters by ?room and returns a distinct rooms list from sessions", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  // Sessions in two rooms so the rooms list is populated from session docs.
  await start(firestore, storage, { hackerrank_username: "alice", room: "Lab-A" });
  await start(firestore, storage, { hackerrank_username: "bob", room: "Lab-B" });
  __setClientsForTest({ firestore, storage });

  seedAlert(firestore, { id: "a1", source: "proctor", type: "recording_stopped", severity: "critical", timestamp: "2026-06-05T10:00:00Z", title: "x", room: "Lab-A" });
  seedAlert(firestore, { id: "a2", source: "proctor", type: "ip_changed", severity: "warning", timestamp: "2026-06-05T11:00:00Z", title: "y", room: "Lab-B" });

  const res = await call(makeReq({
    method: "GET", path: "/api/admin/alerts", headers: ADMIN_HEADERS,
    query: { room: "Lab-A" }
  }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.alerts.map((a) => a.id), ["a1"], "only Lab-A alert returned");
  assert.deepEqual(res.body.rooms, ["Lab-A", "Lab-B"], "rooms list from session docs, sorted");
});

test("rooms: adminStats filters counts by ?room and returns the rooms list", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  await start(firestore, storage, { hackerrank_username: "alice", room: "Lab-A" });
  await start(firestore, storage, { hackerrank_username: "bob", room: "Lab-B" });
  await start(firestore, storage, { hackerrank_username: "carol", room: "Lab-A" });

  // No room → counts all three, rooms list has both labels.
  const all = await call(makeReq({ method: "GET", path: "/api/admin/stats", headers: ADMIN_HEADERS }));
  assert.equal(all.body.stats.live, 3);
  assert.deepEqual(all.body.rooms, ["Lab-A", "Lab-B"]);

  // Room-scoped → only Lab-A's two sessions counted, but rooms list stays full.
  const scoped = await call(makeReq({ method: "GET", path: "/api/admin/stats", headers: ADMIN_HEADERS, query: { room: "Lab-A" } }));
  assert.equal(scoped.body.room, "Lab-A");
  assert.equal(scoped.body.stats.live, 2, "only Lab-A sessions counted");
  assert.equal(scoped.body.stats.total, 2);
  assert.deepEqual(scoped.body.rooms, ["Lab-A", "Lab-B"], "rooms dropdown stays full while one is selected");
});

// =====================================================================
// 3 — PROCTOR ALERT SETTINGS
// =====================================================================

test("alert-settings: GET returns full default config (all enabled, documented severities)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  const res = await call(makeReq({ method: "GET", path: "/api/admin/alert-settings", headers: ADMIN_HEADERS }));
  assert.equal(res.statusCode, 200);
  const p = res.body.proctor;
  assert.equal(p.recording_stopped.enabled, true);
  assert.equal(p.recording_stopped.severity, "critical");
  assert.equal(p.screen_share_stopped.severity, "critical");
  assert.equal(p.invalid_share_surface.severity, "critical");
  assert.equal(p.recording_error.severity, "critical");
  assert.equal(p.ip_changed.severity, "warning");
  assert.equal(p.tab_hidden.severity, "warning");
  assert.equal(p.tab_away.severity, "warning");
  assert.equal(p.disconnected.severity, "warning");
});

test("alert-settings: GET requires admin password", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  const res = await call(makeReq({ method: "GET", path: "/api/admin/alert-settings", headers: {} }));
  assert.equal(res.statusCode, 401);
});

test("alert-settings: POST upserts; disabling a type SKIPS its sure-shot upsert", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  const startRes = await start(firestore, storage);
  const sessionId = startRes.body.session_id;

  // Disable recording_stopped.
  const save = await call(makeReq({
    method: "POST", path: "/api/admin/alert-settings", headers: ADMIN_HEADERS,
    body: { proctor: { recording_stopped: { enabled: false, severity: "critical" } } }
  }));
  assert.equal(save.statusCode, 200);
  assert.equal(save.body.proctor.recording_stopped.enabled, false);

  // A recording_stopped event must NOT raise an alert now.
  await call(makeReq({
    method: "POST", path: "/api/events",
    body: { session_id: sessionId, events: [{ type: "recording_stopped", timestamp: "2026-06-05T10:00:00Z" }] }
  }));
  const alerts = firestore._collections.get(process.env.ALERTS_COLLECTION);
  const rec = [...(alerts?.values() || [])].filter((a) => a.type === "recording_stopped");
  assert.equal(rec.length, 0, "disabled type raises no alert");

  // But a still-enabled type (recording_error) does. Re-fetch the collection:
  // the disabled first event never created the alerts collection, so the earlier
  // `alerts` reference can be undefined until a real alert lands.
  await call(makeReq({
    method: "POST", path: "/api/events",
    body: { session_id: sessionId, events: [{ type: "recording_error", timestamp: "2026-06-05T10:00:01Z" }] }
  }));
  const alertsAfter = firestore._collections.get(process.env.ALERTS_COLLECTION);
  const err = [...(alertsAfter?.values() || [])].filter((a) => a.type === "recording_error");
  assert.equal(err.length, 1, "an enabled type still fires");
});

test("alert-settings: severity OVERRIDE is applied to the raised alert", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  const startRes = await start(firestore, storage);
  const sessionId = startRes.body.session_id;

  // Override recording_error from critical → warning.
  await call(makeReq({
    method: "POST", path: "/api/admin/alert-settings", headers: ADMIN_HEADERS,
    body: { proctor: { recording_error: { enabled: true, severity: "warning" } } }
  }));

  await call(makeReq({
    method: "POST", path: "/api/events",
    body: { session_id: sessionId, events: [{ type: "recording_error", timestamp: "2026-06-05T10:00:00Z" }] }
  }));
  const alerts = firestore._collections.get(process.env.ALERTS_COLLECTION);
  const alert = [...alerts.values()].find((a) => a.type === "recording_error");
  assert.ok(alert, "alert raised");
  assert.equal(alert.severity, "warning", "configured severity overrides the default critical");
});

test("alert-settings: disabling ip_changed skips the heartbeat-derived sure-shot", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  const startRes = await start(firestore, storage);
  const sessionId = startRes.body.session_id;

  await call(makeReq({
    method: "POST", path: "/api/admin/alert-settings", headers: ADMIN_HEADERS,
    body: { proctor: { ip_changed: { enabled: false, severity: "warning" } } }
  }));

  await call(makeReq({
    method: "POST", path: "/api/heartbeat",
    headers: { "x-forwarded-for": "10.0.0.99" },
    body: { session_id: sessionId, recording_state: "recording", visibility_state: "visible" }
  }));
  const alerts = firestore._collections.get(process.env.ALERTS_COLLECTION);
  const ip = [...(alerts?.values() || [])].filter((a) => a.type === "ip_changed");
  assert.equal(ip.length, 0, "disabled ip_changed raises no alert even on a real IP change");
});

test("alert-settings: POST ignores unknown types and invalid severities (normalized to defaults)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  const res = await call(makeReq({
    method: "POST", path: "/api/admin/alert-settings", headers: ADMIN_HEADERS,
    body: { proctor: { not_a_type: { enabled: false }, recording_stopped: { enabled: true, severity: "bogus" } } }
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.proctor.not_a_type, undefined, "unknown type dropped");
  assert.equal(res.body.proctor.recording_stopped.severity, "critical", "invalid severity falls back to default");
});

// =====================================================================
// 4 — LIVENESS / BEACON + disconnected count
// =====================================================================

test("beacon: 'hidden' updates last_seen_at and raises a warning tab_hidden alert", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  const startRes = await start(firestore, storage);
  const sessionId = startRes.body.session_id;
  const store = firestore._collections.get(process.env.SESSION_COLLECTION);
  const before = store.get(sessionId).last_seen_at;

  const res = await call(makeReq({
    method: "POST", path: "/api/session/beacon",
    body: { session_id: sessionId, kind: "hidden" }
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.kind, "hidden");
  assert.ok(store.get(sessionId).last_seen_at, "last_seen_at stamped");
  assert.notEqual(store.get(sessionId).last_seen_at, before);

  const alerts = firestore._collections.get(process.env.ALERTS_COLLECTION);
  const tab = [...alerts.values()].find((a) => a.type === "tab_hidden");
  assert.ok(tab, "tab_hidden alert raised");
  assert.equal(tab.severity, "warning");
  assert.equal(tab.source, "proctor");
  assert.equal(tab.session_id, sessionId);
  assert.equal(tab.room, undefined, "no room → room field omitted (only set when truthy)");
  assert.ok(tab.id.startsWith("proctor:tab_hidden:alice:"), tab.id);
});

test("beacon: accepts a text/plain (string) body like navigator.sendBeacon", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  const startRes = await start(firestore, storage);
  const sessionId = startRes.body.session_id;

  const res = await call(makeReq({
    method: "POST", path: "/api/session/beacon",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ session_id: sessionId, kind: "closing" })
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.kind, "closing");
  const alerts = firestore._collections.get(process.env.ALERTS_COLLECTION);
  assert.ok([...alerts.values()].some((a) => a.type === "tab_hidden"), "closing also raises tab_hidden");
});

test("beacon: 'visible' refreshes last_seen_at but raises NO alert", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  const startRes = await start(firestore, storage);
  const sessionId = startRes.body.session_id;

  await call(makeReq({ method: "POST", path: "/api/session/beacon", body: { session_id: sessionId, kind: "visible" } }));
  const alerts = firestore._collections.get(process.env.ALERTS_COLLECTION);
  assert.equal(alerts === undefined || alerts.size === 0, true, "visible is liveness-only, no alert");
  const store = firestore._collections.get(process.env.SESSION_COLLECTION);
  assert.ok(store.get(sessionId).last_seen_at, "last_seen_at still refreshed on visible");
});

test("beacon: respects the tab_hidden enable toggle (disabled → no alert, still updates last_seen)", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  const startRes = await start(firestore, storage);
  const sessionId = startRes.body.session_id;

  await call(makeReq({
    method: "POST", path: "/api/admin/alert-settings", headers: ADMIN_HEADERS,
    body: { proctor: { tab_hidden: { enabled: false, severity: "warning" } } }
  }));

  const res = await call(makeReq({ method: "POST", path: "/api/session/beacon", body: { session_id: sessionId, kind: "hidden" } }));
  assert.equal(res.statusCode, 200);
  const alerts = firestore._collections.get(process.env.ALERTS_COLLECTION);
  const tab = [...(alerts?.values() || [])].filter((a) => a.type === "tab_hidden");
  assert.equal(tab.length, 0, "disabled tab_hidden raises no alert");
  const store = firestore._collections.get(process.env.SESSION_COLLECTION);
  assert.ok(store.get(sessionId).last_seen_at, "last_seen_at still updated even when alert disabled");
});

test("beacon: gated ONLY by session ownership — unknown session_id → 404, no admin auth needed", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  __setClientsForTest({ firestore, storage });
  const res = await call(makeReq({ method: "POST", path: "/api/session/beacon", body: { session_id: "nope", kind: "hidden" } }));
  assert.equal(res.statusCode, 404);
});

test("beacon: missing session_id → 400", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  const res = await call(makeReq({ method: "POST", path: "/api/session/beacon", body: { kind: "hidden" } }));
  assert.equal(res.statusCode, 400);
});

test("beacon: a locked/ended session can still emit liveness (NOT requireWritableSession-gated)", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  const startRes = await start(firestore, storage);
  const sessionId = startRes.body.session_id;
  // Force the session ended; a beacon must still be accepted (200), unlike the
  // write endpoints which 409 an ended session.
  const store = firestore._collections.get(process.env.SESSION_COLLECTION);
  store.set(sessionId, { ...store.get(sessionId), status: "ended" });

  const res = await call(makeReq({ method: "POST", path: "/api/session/beacon", body: { session_id: sessionId, kind: "closing" } }));
  assert.equal(res.statusCode, 200, "beacon is liveness, not a guarded write");
});

test("disconnected: adminStats counts active sessions with a stale heartbeat/last_seen", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  const fresh = await start(firestore, storage, { hackerrank_username: "fresh" });
  const stale = await start(firestore, storage, { hackerrank_username: "stale" });
  const store = firestore._collections.get(process.env.SESSION_COLLECTION);

  const nowIso = new Date().toISOString();
  const oldIso = new Date(Date.now() - 120000).toISOString(); // 2 min ago > 45s

  // fresh: recent heartbeat → live, not disconnected.
  store.set(fresh.body.session_id, { ...store.get(fresh.body.session_id), status: "active", last_heartbeat_at: nowIso, last_seen_at: nowIso });
  // stale: old heartbeat + old beacon → still active but disconnected.
  store.set(stale.body.session_id, { ...store.get(stale.body.session_id), status: "active", last_heartbeat_at: oldIso, last_seen_at: oldIso });

  const res = await call(makeReq({ method: "GET", path: "/api/admin/stats", headers: ADMIN_HEADERS }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.stats.live, 2, "both still active");
  assert.equal(res.body.stats.disconnected, 1, "only the stale one is disconnected");
  assert.equal(res.body.disconnected_staleness_ms, 45000, "staleness threshold surfaced");
});

test("disconnected: a recent beacon (last_seen_at) keeps an otherwise-stale heartbeat session fresh", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  const s = await start(firestore, storage, { hackerrank_username: "beaconed" });
  const store = firestore._collections.get(process.env.SESSION_COLLECTION);

  const nowIso = new Date().toISOString();
  const oldIso = new Date(Date.now() - 120000).toISOString();
  // Heartbeat is old, but a recent beacon refreshed last_seen_at → NOT stale.
  store.set(s.body.session_id, { ...store.get(s.body.session_id), status: "active", last_heartbeat_at: oldIso, last_seen_at: nowIso });

  const res = await call(makeReq({ method: "GET", path: "/api/admin/stats", headers: ADMIN_HEADERS }));
  assert.equal(res.body.stats.disconnected, 0, "newest of heartbeat/beacon is recent → not disconnected");
});

test("disconnected: an ended session is never counted as disconnected", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  seedSettings(firestore);
  const s = await start(firestore, storage, { hackerrank_username: "done" });
  const store = firestore._collections.get(process.env.SESSION_COLLECTION);
  const oldIso = new Date(Date.now() - 120000).toISOString();
  store.set(s.body.session_id, { ...store.get(s.body.session_id), status: "ended", last_heartbeat_at: oldIso });

  const res = await call(makeReq({ method: "GET", path: "/api/admin/stats", headers: ADMIN_HEADERS }));
  assert.equal(res.body.stats.disconnected, 0, "disconnected is derived only from ACTIVE sessions");
});
