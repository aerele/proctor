// backend/test/ipReport.test.mjs — S7: IP-wise report of logged-in users.
import { test } from "node:test";
import assert from "node:assert/strict";

// Env MUST be set before importing the handler (it reads env at module load).
// Unique collection names + the ?ipreport cache-buster give this file a fresh
// module instance independent of the other test files.
process.env.EVIDENCE_BUCKET = "ipreport-bucket";
process.env.SESSION_COLLECTION = "ipreport_sessions";
process.env.SETTINGS_COLLECTION = "ipreport_settings";
process.env.ALERTS_COLLECTION = "ipreport_alerts";
process.env.LIVE_LOCK_COLLECTION = "ipreport_live_locks";
process.env.ADMIN_PASSWORD = "ipreport-admin-pass";

const handler = await import("../src/handler.mjs?ipreport");
const { api, __setClientsForTest } = handler;

const ipReportModule = await import("../src/ipReport.mjs");
const { buildIpReport, reportIp, IP_REPORT_CANDIDATES_LIMIT, IP_REPORT_IPS_LIMIT } = ipReportModule;

// Inline req/res mocks + fakes, copied from editorEvents.test.mjs (NO shared
// helpers file — each test file pastes its own).
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

// ---- Fake Firestore (create / update / set / get / where / delete) ---------
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
      async get() {
        const store = getCollection(name);
        let docs = [...store.values()];
        for (const { field, op, value } of filters) {
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
              metadata: { size: 1, updated: "2026-06-05T00:00:00Z" },
              async getMetadata() { return [{ size: 1, updated: "2026-06-05T00:00:00Z" }]; },
              async getSignedUrl() { return [`https://signed.example/${name}`]; }
            }));
          return [files];
        }
      };
    }
  };
}

const ADMIN_HEADERS = { "x-admin-password": "ipreport-admin-pass" };

// Session-doc factory for the pure tests (only the fields the report reads).
function sessionDoc(overrides = {}) {
  return {
    session_id: "sess-default",
    hackerrank_username: "Alice",
    username_norm: "alice",
    name: "Alice Example",
    room: "Lab A-1",
    contest_slug: "c1",
    status: "active",
    created_at: "2026-06-09T10:00:00.000Z",
    start_ip: "10.0.0.1",
    current_ip: "10.0.0.1",
    ip_change_count: 0,
    ...overrides
  };
}

// =====================================================================
// Pure: reportIp
// =====================================================================

test("reportIp: current_ip wins, start_ip is the fallback, unknown is the floor", () => {
  assert.equal(reportIp({ current_ip: "2.2.2.2", start_ip: "1.1.1.1" }), "2.2.2.2");
  assert.equal(reportIp({ start_ip: "1.1.1.1" }), "1.1.1.1");
  assert.equal(reportIp({ current_ip: "  " }), "unknown");
  assert.equal(reportIp({}), "unknown");
});

// =====================================================================
// Pure: buildIpReport
// =====================================================================

test("buildIpReport: groups by IP, dedupes users by username_norm, counts statuses", () => {
  const report = buildIpReport([
    sessionDoc({ session_id: "a1", username_norm: "alice", current_ip: "10.0.0.1", status: "active" }),
    // alice's SECOND session from the same IP: +1 session, NOT +1 user.
    sessionDoc({ session_id: "a2", username_norm: "alice", current_ip: "10.0.0.1", status: "ended" }),
    sessionDoc({ session_id: "b1", username_norm: "bob", hackerrank_username: "Bob", current_ip: "10.0.0.1", status: "locked" }),
    sessionDoc({ session_id: "c1", username_norm: "carol", hackerrank_username: "Carol", current_ip: "10.0.0.2", status: "pending_approval", room: "Lab B-2" })
  ]);

  assert.equal(report.total_sessions, 4);
  assert.equal(report.distinct_ips, 2);
  assert.equal(report.multi_user_ips, 1);
  assert.equal(report.ips_truncated, false);

  const cluster = report.ips[0]; // 2 users > 1 user → sorted first
  assert.equal(cluster.ip, "10.0.0.1");
  assert.equal(cluster.sessions, 3);
  assert.equal(cluster.users, 2);
  assert.equal(cluster.active, 1);
  assert.equal(cluster.ended, 1);
  assert.equal(cluster.locked, 1);
  assert.equal(cluster.pending_approval, 0);

  const solo = report.ips[1];
  assert.equal(solo.ip, "10.0.0.2");
  assert.equal(solo.users, 1);
  assert.equal(solo.pending_approval, 1);
  assert.deepEqual(solo.rooms, ["Lab B-2"]);
});

test("buildIpReport: missing IPs group under 'unknown'; rooms dedupe + sort", () => {
  const report = buildIpReport([
    sessionDoc({ session_id: "l1", username_norm: "leg1", current_ip: "", start_ip: "", room: "Lab B-2" }),
    sessionDoc({ session_id: "l2", username_norm: "leg2", current_ip: undefined, start_ip: undefined, room: "Lab A-1" }),
    sessionDoc({ session_id: "l3", username_norm: "leg3", current_ip: "", start_ip: "", room: "Lab A-1" })
  ]);
  assert.equal(report.distinct_ips, 1);
  assert.equal(report.ips[0].ip, "unknown");
  assert.deepEqual(report.ips[0].rooms, ["Lab A-1", "Lab B-2"]);
});

test("buildIpReport: sorts users desc, then sessions desc, then ip asc", () => {
  const report = buildIpReport([
    // ip A: 1 user, 2 sessions
    sessionDoc({ session_id: "a1", username_norm: "u1", current_ip: "10.0.0.9" }),
    sessionDoc({ session_id: "a2", username_norm: "u1", current_ip: "10.0.0.9" }),
    // ip B: 2 users
    sessionDoc({ session_id: "b1", username_norm: "u2", current_ip: "10.0.0.5" }),
    sessionDoc({ session_id: "b2", username_norm: "u3", current_ip: "10.0.0.5" }),
    // ip C: 1 user, 1 session — ties with D on users+sessions, ip asc breaks it
    sessionDoc({ session_id: "c1", username_norm: "u4", current_ip: "10.0.0.7" }),
    // ip D: 1 user, 1 session
    sessionDoc({ session_id: "d1", username_norm: "u5", current_ip: "10.0.0.3" })
  ]);
  assert.deepEqual(report.ips.map((entry) => entry.ip), ["10.0.0.5", "10.0.0.9", "10.0.0.3", "10.0.0.7"]);
});

test("buildIpReport: candidate rows capped with truncation flag; newest first", () => {
  const docs = [];
  for (let i = 0; i < IP_REPORT_CANDIDATES_LIMIT + 5; i += 1) {
    docs.push(sessionDoc({
      session_id: `s${i}`,
      username_norm: `user${i}`,
      hackerrank_username: `User${i}`,
      current_ip: "10.0.0.1",
      created_at: `2026-06-09T10:${String(i).padStart(2, "0")}:00.000Z`
    }));
  }
  const report = buildIpReport(docs);
  const entry = report.ips[0];
  assert.equal(entry.sessions, IP_REPORT_CANDIDATES_LIMIT + 5);
  assert.equal(entry.candidates.length, IP_REPORT_CANDIDATES_LIMIT);
  assert.equal(entry.candidates_truncated, true);
  // Newest created_at first.
  assert.equal(entry.candidates[0].session_id, `s${IP_REPORT_CANDIDATES_LIMIT + 4}`);
  // Candidate rows carry exactly the documented projection.
  assert.deepEqual(Object.keys(entry.candidates[0]).sort(), [
    "created_at", "hackerrank_username", "ip_change_count", "name", "room", "roster_unique_id", "session_id", "start_ip", "status"
  ]);
});

// F8.1: the drill-down rows must identify the candidate by ROSTER id (the
// admin-facing identity) — carried from the session doc, "" for legacy
// pre-roster sessions.
test("buildIpReport: candidate rows carry roster_unique_id ('' when absent)", () => {
  const report = buildIpReport([
    sessionDoc({ session_id: "r1", username_norm: "rita", current_ip: "10.0.0.1", roster_unique_id: "23BCS101" }),
    sessionDoc({ session_id: "r2", username_norm: "leg", current_ip: "10.0.0.1", created_at: "2026-06-09T09:00:00.000Z" })
  ]);
  const candidates = report.ips[0].candidates;
  assert.equal(candidates[0].roster_unique_id, "23BCS101");
  assert.equal(candidates[1].roster_unique_id, "");
});

test("buildIpReport: caps IP groups at IP_REPORT_IPS_LIMIT, biggest kept, flag set", () => {
  const docs = [];
  // One big cluster that MUST survive the cap...
  docs.push(sessionDoc({ session_id: "big1", username_norm: "big1", current_ip: "10.9.9.9" }));
  docs.push(sessionDoc({ session_id: "big2", username_norm: "big2", current_ip: "10.9.9.9" }));
  // ...plus IP_REPORT_IPS_LIMIT singleton IPs.
  for (let i = 0; i < IP_REPORT_IPS_LIMIT; i += 1) {
    docs.push(sessionDoc({ session_id: `solo${i}`, username_norm: `solo${i}`, current_ip: `10.1.${Math.floor(i / 250)}.${i % 250}` }));
  }
  const report = buildIpReport(docs);
  assert.equal(report.distinct_ips, IP_REPORT_IPS_LIMIT + 1);
  assert.equal(report.ips.length, IP_REPORT_IPS_LIMIT);
  assert.equal(report.ips_truncated, true);
  assert.equal(report.ips[0].ip, "10.9.9.9", "the multi-user cluster survives the cap");
});

test("buildIpReport: ip_changed_sessions counts docs with ip_change_count > 0", () => {
  const report = buildIpReport([
    sessionDoc({ session_id: "x1", username_norm: "x1", ip_change_count: 2 }),
    sessionDoc({ session_id: "x2", username_norm: "x2", ip_change_count: 0 }),
    sessionDoc({ session_id: "x3", username_norm: "x3", ip_change_count: 1, current_ip: "10.0.0.2" })
  ]);
  assert.equal(report.ip_changed_sessions, 2);
});

// =====================================================================
// getClientIp hardening — Cloud Run appends the REAL client IP as the LAST
// x-forwarded-for value; earlier entries are client-supplied and spoofable.
// =====================================================================

function seedSettings(firestore) {
  firestore.collection(process.env.SETTINGS_COLLECTION).doc("active").set({
    start_at: new Date(Date.now() - 3600 * 1000).toISOString(),
    end_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    contest_url: "https://www.hackerrank.com/contests/ipreport-contest",
    updated_at: new Date().toISOString()
  });
}

test("getClientIp: multi-hop x-forwarded-for → the LAST hop is stored, not the spoofable first", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  seedSettings(firestore);

  const res = await call(makeReq({
    method: "POST",
    path: "/api/session/start",
    headers: { "x-forwarded-for": "1.2.3.4, 9.9.9.9" },
    body: {
      hackerrank_username: "Spoofy",
      name: "Spoofy Example",
      roll_number: "R-9",
      email: "spoofy@example.com",
      consent_accepted: true
    }
  }));
  assert.equal(res.statusCode, 200);
  const stored = firestore._collections.get(process.env.SESSION_COLLECTION).get(res.body.session_id);
  assert.equal(stored.start_ip, "9.9.9.9", "the proxy-appended last hop is the trusted client IP");
  assert.equal(stored.current_ip, "9.9.9.9");
});

// =====================================================================
// GET /api/admin/ip-report
// =====================================================================

// Seed session docs DIRECTLY (the endpoint only reads them); ids = session_id.
function seedSession(firestore, doc) {
  firestore.collection(process.env.SESSION_COLLECTION).doc(doc.session_id).set(doc);
}

function seedReportPopulation(firestore) {
  seedSession(firestore, sessionDoc({ session_id: "al1", username_norm: "alice", hackerrank_username: "Alice", current_ip: "10.1.1.1", status: "active", room: "Lab A-1", contest_slug: "c1" }));
  seedSession(firestore, sessionDoc({ session_id: "bo1", username_norm: "bob", hackerrank_username: "Bob", current_ip: "10.1.1.1", status: "locked", room: "Lab A-1", contest_slug: "c1" }));
  seedSession(firestore, sessionDoc({ session_id: "ca1", username_norm: "carol", hackerrank_username: "Carol", current_ip: "10.1.1.1", status: "ended", room: "Lab B-2", contest_slug: "c1" }));
  seedSession(firestore, sessionDoc({ session_id: "da1", username_norm: "dave", hackerrank_username: "Dave", current_ip: "10.2.2.2", status: "active", room: "Lab B-2", contest_slug: "c2" }));
  // Legacy doc with no IP fields → groups under "unknown".
  seedSession(firestore, sessionDoc({ session_id: "le1", username_norm: "legacy", hackerrank_username: "Legacy", current_ip: "", start_ip: "", status: "active", room: "Lab A-1", contest_slug: "c1" }));
}

test("ip-report: rejects a missing/wrong admin password", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  const noAuth = await call(makeReq({ method: "GET", path: "/api/admin/ip-report" }));
  assert.equal(noAuth.statusCode, 401);
  const badAuth = await call(makeReq({ method: "GET", path: "/api/admin/ip-report", headers: { "x-admin-password": "wrong" } }));
  assert.equal(badAuth.statusCode, 401);
});

test("ip-report: default scope=live excludes ended sessions; contest filter applies", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedReportPopulation(firestore);

  const res = await call(makeReq({
    method: "GET", path: "/api/admin/ip-report",
    headers: ADMIN_HEADERS, query: { contest_slug: "c1" }
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.scope, "live");
  assert.equal(res.body.contest_slug, "c1");
  // carol (ended) excluded; dave (contest c2) excluded; alice+bob+legacy remain.
  assert.equal(res.body.total_sessions, 3);
  assert.equal(res.body.distinct_ips, 2);
  const cluster = res.body.ips[0];
  assert.equal(cluster.ip, "10.1.1.1");
  assert.equal(cluster.users, 2);
  assert.equal(cluster.active, 1);
  assert.equal(cluster.locked, 1);
  assert.equal(cluster.ended, 0);
  assert.equal(res.body.ips[1].ip, "unknown");
});

test("ip-report: scope=all includes ended sessions", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedReportPopulation(firestore);

  const res = await call(makeReq({
    method: "GET", path: "/api/admin/ip-report",
    headers: ADMIN_HEADERS, query: { contest_slug: "c1", scope: "all" }
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.scope, "all");
  assert.equal(res.body.total_sessions, 4);
  const cluster = res.body.ips.find((entry) => entry.ip === "10.1.1.1");
  assert.equal(cluster.sessions, 3);
  assert.equal(cluster.users, 3);
  assert.equal(cluster.ended, 1);
  assert.deepEqual(cluster.rooms, ["Lab A-1", "Lab B-2"]);
});

test("ip-report: room filter narrows the population", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedReportPopulation(firestore);

  const res = await call(makeReq({
    method: "GET", path: "/api/admin/ip-report",
    headers: ADMIN_HEADERS, query: { contest_slug: "c1", room: "Lab A-1" }
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.room, "Lab A-1");
  // alice (active), bob (locked), legacy (active) are the live Lab A-1 docs;
  // carol is Lab B-2 (and ended), dave is contest c2.
  assert.equal(res.body.total_sessions, 3);
});

test("ip-report: invalid scope → 400", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  const res = await call(makeReq({
    method: "GET", path: "/api/admin/ip-report",
    headers: ADMIN_HEADERS, query: { scope: "bogus" }
  }));
  assert.equal(res.statusCode, 400);
  assert.match(String(res.body.error), /scope must be live or all/);
});
