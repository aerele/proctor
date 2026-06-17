// backend/test/alertsScanWindow.test.mjs — zero-alerts scan-window regression
// (investigation 2026-06-10, root cause #1).
//
// Without an orderBy, Firestore returns the first `limit(n)` docs in DOC-ID
// order, and the archived filter only runs in memory AFTERWARDS. A pile of
// bulk-archived old alerts whose ids sort first (the real KEC pile:
// `contest-eval:first_attempt_solve:*`) therefore fills the entire scan window
// and live alerts NEVER reach the in-memory filter — the console shows zero.
//
// The fix orders the default scan by `timestamp desc` BEFORE the limit so the
// window always holds the newest docs. The archived filter must STAY in
// memory: legacy docs omit the `archived` field entirely, so an equality
// filter (`where("archived","==",false)`) would drop every legacy live alert.
// `timestamp` is a single-field orderBy — covered by Firestore's automatic
// index, no composite needed (combining it with the contest_slug equality
// filter WOULD need one, so the contest-scoped branch keeps the bare scan).
import { test } from "node:test";
import assert from "node:assert/strict";

// Env BEFORE import (handler reads env at module load); unique collections +
// a unique ?alertsScan query give a fresh module instance independent of the
// other test files.
process.env.EVIDENCE_BUCKET = "scan-bucket";
process.env.SESSION_COLLECTION = "scan_sessions";
process.env.SETTINGS_COLLECTION = "scan_settings";
process.env.ALERTS_COLLECTION = "scan_alerts";
process.env.ROOM_GATES_COLLECTION = "scan_room_gates";
process.env.ADMIN_PASSWORD = "scan-admin-pass";
process.env.INVIGILATOR_PASSWORD = "scan-invig-pass";
process.env.ALERTS_INGEST_API_KEY = "test-ingest-key-placeholder-not-a-real-secret";

const handler = await import("../src/handler.mjs?alertsScan");
const { api, __setClientsForTest } = handler;

const SCAN_LIMIT = 500; // mirrors ALERTS_QUERY_LIMIT in handler.mjs

// ---- Fake Firestore that models the REAL scan-window semantics -------------
// Unlike the other test files' fakes (whose limit() is a no-op), this one
// reproduces the two Firestore behaviours the bug depends on:
//   1. limit(n) truncates the result set;
//   2. without orderBy, docs come back in doc-id (__name__) order;
//      with orderBy(field, "desc"), they come back newest-first.
function makeFakeFirestore() {
  const collections = new Map();

  function getCollection(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  }

  function makeQuery(name, filters, order, limitN) {
    return {
      where(field, _op, value) {
        return makeQuery(name, [...filters, { field, value }], order, limitN);
      },
      orderBy(field, direction = "asc") {
        return makeQuery(name, filters, { field, direction }, limitN);
      },
      limit(n) {
        return makeQuery(name, filters, order, n);
      },
      async get() {
        let entries = [...getCollection(name).entries()];
        for (const { field, value } of filters) {
          entries = entries.filter(([, data]) => data[field] === value);
        }
        if (order) {
          entries.sort(([, a], [, b]) => {
            const cmp = String(a[order.field] ?? "").localeCompare(String(b[order.field] ?? ""));
            return order.direction === "desc" ? -cmp : cmp;
          });
        } else {
          entries.sort(([idA], [idB]) => idA.localeCompare(idB));
        }
        if (limitN !== undefined) entries = entries.slice(0, limitN);
        return { docs: entries.map(([id, data]) => ({ id, data: () => data })) };
      }
    };
  }

  return {
    _collections: collections,
    collection(name) {
      const store = getCollection(name);
      const query = makeQuery(name, [], undefined, undefined);
      return {
        where: query.where,
        orderBy: query.orderBy,
        limit: query.limit,
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

// The real KEC pile: bulk-archived contest-eval alerts whose ids sort FIRST
// alphabetically ("contest-eval:…" < "proctor:…"), enough to fill the whole
// scan window on their own. No video_key, so no storage fake is needed.
function seedArchivedPile(firestore) {
  const alerts = firestore.collection(process.env.ALERTS_COLLECTION);
  for (let i = 0; i < SCAN_LIMIT; i += 1) {
    const id = `contest-eval:first_attempt_solve:user${String(i).padStart(4, "0")}:kec-aerele:fa`;
    alerts.doc(id).set({
      id, source: "contest-eval", type: "first_attempt_solve", severity: "info",
      timestamp: "2026-06-05T10:00:00.000Z", hackerrank_username: `user${i}`,
      username_norm: `user${i}`, title: "First-attempt solve",
      contest_slug: "kec-aerele", archived: true
    });
  }
}

// A NEWER live alert whose doc id sorts AFTER the pile. Deliberately a legacy
// doc: NO `archived` field at all — the fix must keep treating it as live
// (in-memory filter), not push an `archived == false` equality to Firestore.
function seedLiveAlert(firestore, overrides = {}) {
  const id = "proctor:tab_switch:zara:mcet-2:hb1";
  firestore.collection(process.env.ALERTS_COLLECTION).doc(id).set({
    id, source: "proctor", type: "recording_stopped", severity: "critical",
    timestamp: "2026-06-10T12:00:00.000Z", hackerrank_username: "Zara",
    username_norm: "zara", title: "Recording stopped",
    contest_slug: "mcet-2", room: "Lab A-1",
    ...overrides
  });
  return id;
}

test("adminAlerts: an all-archived first scan window must not hide a newer live alert", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore });
  seedArchivedPile(firestore);
  const liveId = seedLiveAlert(firestore);
  // Newest doc overall but ARCHIVED — proves the in-memory archived filter
  // still runs after the orderBy fix (ordering alone must not resurrect it).
  firestore.collection(process.env.ALERTS_COLLECTION).doc("proctor:zz:newest-archived").set({
    id: "proctor:zz:newest-archived", source: "proctor", type: "recording_stopped",
    severity: "critical", timestamp: "2026-06-10T13:00:00.000Z",
    hackerrank_username: "Yan", username_norm: "yan", title: "Recording stopped",
    archived: true
  });

  const res = await call(makeReq({ method: "GET", path: "/api/admin/alerts",
    headers: { "x-admin-password": "scan-admin-pass" } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.alerts.map((a) => a.id), [liveId],
    "default scan must surface the newest LIVE alert despite 500 archived docs sorting first by id");
});

test("invigilatorRoom: alert feed survives an all-archived first scan window", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore });
  // No contest configured — the unfiltered scan branch, same as adminAlerts'.
  firestore.collection(process.env.SETTINGS_COLLECTION).doc("active").set({
    start_at: "2026-01-01T00:00:00.000Z", end_at: "2099-01-01T00:00:00.000Z",
    contest_url: "", contest_slug: "", room_gate_enabled: false
  });
  // Wave6: nothing is shared with invigilators by default — opt recording_stopped
  // IN so the live alert reaches the feed and this test exercises the SCAN-WINDOW
  // behavior (not the share filter).
  firestore.collection(process.env.SETTINGS_COLLECTION).doc("alert_settings").set({
    proctor: { recording_stopped: { enabled: true, severity: "critical", show_to_invigilator: true } }
  });
  seedArchivedPile(firestore);
  const liveId = seedLiveAlert(firestore);

  const res = await call(makeReq({ method: "GET", path: "/api/invigilator/room",
    query: { room: "Lab A-1" }, headers: { "x-invigilator-password": "scan-invig-pass" } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.alerts.map((a) => a.id), [liveId],
    "room feed must surface the newest LIVE alert despite 500 archived docs sorting first by id");
});
