// backend/test/attendance.test.mjs — S6: roster-based attendance stats.
// Spec: docs/superpowers/specs/2026-06-09-s6-attendance-stats-design.md
import { test } from "node:test";
import assert from "node:assert/strict";

// Env BEFORE import; unique ?attendance cache-buster for a fresh module instance.
process.env.EVIDENCE_BUCKET = "att-bucket";
process.env.SESSION_COLLECTION = "att_sessions";
process.env.SETTINGS_COLLECTION = "att_settings";
process.env.ROSTER_COLLECTION = "att_roster";
process.env.ADMIN_PASSWORD = "att-admin-pass";

const handler = await import("../src/handler.mjs?attendance");
const { api, __setClientsForTest } = handler;

// Inline req/res + fakes (convention: copied per test file, NO helpers.mjs).
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

const ADMIN_HEADERS = { "x-admin-password": "att-admin-pass" };

// ---- Seed helpers -----------------------------------------------------------
// Shapes mirror EXACTLY what S2 persists (S2 spec §3): meta in
// att_settings/roster_meta, one entry doc per student keyed by the normalized
// unique id, sessions stamped with roster_unique_id (display form).

function norm(value) {
  return String(value).trim().toLowerCase().replace(/\s+/g, "");
}

async function seedRoster(firestore, students, { version = "v1", mapping = { name: "Name", roll_number: "Roll", room: "Room" } } = {}) {
  await firestore.collection("att_settings").doc("roster_meta").set({
    configured: true,
    version,
    unique_id_column: "Reg No",
    column_mapping: mapping,
    columns: ["Reg No", "Name", "Roll", "Room"],
    count: students.length,
    updated_at: "2026-06-09T00:00:00.000Z"
  });
  for (const student of students) {
    const idNorm = norm(student.unique_id);
    await firestore.collection("att_roster").doc(idNorm).set({
      unique_id: student.unique_id,
      unique_id_norm: idNorm,
      roster_version: student.version ?? version,
      fields: {
        "Reg No": student.unique_id,
        Name: student.name ?? "",
        Roll: student.roll ?? "",
        Room: student.room ?? ""
      },
      created_at: "2026-06-09T00:00:00.000Z"
    });
  }
}

async function seedSession(firestore, sessionId, { roster_unique_id = "", status = "active", contest_slug = "contest-a" } = {}) {
  await firestore.collection("att_sessions").doc(sessionId).set({
    session_id: sessionId,
    hackerrank_username: sessionId,
    roster_unique_id,
    roster_verified: Boolean(roster_unique_id),
    status,
    contest_slug,
    created_at: "2026-06-09T01:00:00.000Z"
  });
}

function attendanceReq(query = {}, headers = ADMIN_HEADERS) {
  return makeReq({ method: "GET", path: "/api/admin/attendance", headers, query });
}

// ---- Tests --------------------------------------------------------------------

test("attendance: 401 without the admin password", async () => {
  __setClientsForTest({ firestore: makeFakeFirestore() });
  const res = await call(attendanceReq({}, {}));
  assert.equal(res.statusCode, 401);
});

test("attendance: configured:false when no roster is set", async () => {
  __setClientsForTest({ firestore: makeFakeFirestore() });
  const res = await call(attendanceReq());
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { configured: false });
});

test("attendance: taken/in-progress/completed/absent counts + mapped absentee fields", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore });
  await seedRoster(firestore, [
    { unique_id: "21CS001", name: "Asha", roll: "R1", room: "Lab A" },
    { unique_id: "21CS002", name: "Vikram", roll: "R2", room: "Lab B" },
    { unique_id: "21CS003", name: "Meera", roll: "R3", room: "Lab A" }
  ]);
  await seedSession(firestore, "s1", { roster_unique_id: "21CS001", status: "ended" });
  await seedSession(firestore, "s2", { roster_unique_id: "21CS002", status: "active" });

  const res = await call(attendanceReq());
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.configured, true);
  assert.equal(res.body.contest_slug, null);
  assert.equal(res.body.roster_total, 3);
  assert.deepEqual(res.body.taken, { total: 2, in_progress: 1, completed: 1 });
  assert.equal(res.body.not_taken, 1);
  assert.equal(res.body.unmatched_sessions, 0);
  // PII shape lock: an absentee row is EXACTLY these four mapped fields.
  assert.deepEqual(res.body.absentees, [
    { unique_id: "21CS003", name: "Meera", roll_number: "R3", room: "Lab A" }
  ]);
  assert.ok(res.body.generated_at);
});

test("attendance: matching normalizes case + whitespace ('21 cs 001' matches 21CS001)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore });
  await seedRoster(firestore, [{ unique_id: "21CS001", name: "Asha" }]);
  await seedSession(firestore, "s1", { roster_unique_id: "21 cs 001", status: "active" });

  const res = await call(attendanceReq());
  assert.deepEqual(res.body.taken, { total: 1, in_progress: 1, completed: 0 });
  assert.equal(res.body.not_taken, 0);
  assert.equal(res.body.unmatched_sessions, 0);
});

test("attendance: pending_approval and locked sessions count as taken (in progress)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore });
  await seedRoster(firestore, [
    { unique_id: "21CS001", name: "Asha" },
    { unique_id: "21CS002", name: "Vikram" }
  ]);
  await seedSession(firestore, "s1", { roster_unique_id: "21CS001", status: "pending_approval" });
  await seedSession(firestore, "s2", { roster_unique_id: "21CS002", status: "locked" });

  const res = await call(attendanceReq());
  assert.deepEqual(res.body.taken, { total: 2, in_progress: 2, completed: 0 });
  assert.equal(res.body.not_taken, 0);
});

test("attendance: multiple sessions for one student count once; any non-ended wins", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore });
  await seedRoster(firestore, [{ unique_id: "21CS001", name: "Asha" }]);
  await seedSession(firestore, "s1", { roster_unique_id: "21CS001", status: "ended" });
  await seedSession(firestore, "s2", { roster_unique_id: "21CS001", status: "active" });

  const res = await call(attendanceReq());
  assert.equal(res.body.roster_total, 1);
  assert.deepEqual(res.body.taken, { total: 1, in_progress: 1, completed: 0 });
});

test("attendance: stale-version entries are invisible and their sessions are unmatched", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore });
  // Meta version is v1; the second entry is from a replaced upload (v0).
  await seedRoster(firestore, [
    { unique_id: "21CS001", name: "Asha" },
    { unique_id: "21CS002", name: "Old Upload", version: "v0" }
  ]);
  await seedSession(firestore, "s1", { roster_unique_id: "21CS002", status: "active" });

  const res = await call(attendanceReq());
  assert.equal(res.body.roster_total, 1);
  assert.deepEqual(res.body.taken, { total: 0, in_progress: 0, completed: 0 });
  assert.equal(res.body.not_taken, 1);
  assert.equal(res.body.absentees[0].unique_id, "21CS001");
  assert.equal(res.body.unmatched_sessions, 1);
});

test("attendance: legacy sessions without roster_unique_id count as unmatched only", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore });
  await seedRoster(firestore, [{ unique_id: "21CS001", name: "Asha" }]);
  await seedSession(firestore, "s1", { roster_unique_id: "", status: "active" });

  const res = await call(attendanceReq());
  assert.deepEqual(res.body.taken, { total: 0, in_progress: 0, completed: 0 });
  assert.equal(res.body.not_taken, 1);
  assert.equal(res.body.unmatched_sessions, 1);
});

test("attendance: contest_slug scopes the sessions side", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore });
  await seedRoster(firestore, [{ unique_id: "21CS001", name: "Asha" }]);
  await seedSession(firestore, "s1", { roster_unique_id: "21CS001", status: "active", contest_slug: "contest-b" });

  const res = await call(attendanceReq({ contest_slug: "contest-a" }));
  assert.equal(res.body.contest_slug, "contest-a");
  // The contest-b session is filtered out BEFORE counting: not taken, not unmatched.
  assert.deepEqual(res.body.taken, { total: 0, in_progress: 0, completed: 0 });
  assert.equal(res.body.not_taken, 1);
  assert.equal(res.body.unmatched_sessions, 0);
});

test("attendance: absentees sorted by unique_id; unmapped fields come back empty", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore });
  await seedRoster(
    firestore,
    [
      { unique_id: "21CS010", name: "Meera", roll: "R10", room: "Lab A" },
      { unique_id: "21CS002", name: "Vikram", roll: "R2", room: "Lab B" }
    ],
    { mapping: { name: "Name" } } // roll_number and room are NOT mapped
  );

  const res = await call(attendanceReq());
  assert.deepEqual(res.body.absentees, [
    { unique_id: "21CS002", name: "Vikram", roll_number: "", room: "" },
    { unique_id: "21CS010", name: "Meera", roll_number: "", room: "" }
  ]);
});
