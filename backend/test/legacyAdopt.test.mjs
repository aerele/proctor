// backend/test/legacyAdopt.test.mjs — S-J legacy "Adopt into person model"
// (vision §2.15): a contest already run under legacy/F9-era norms (no college
// component) gets a one-time re-upload of its roster WITH the college column →
// rows match the contest's existing sessions/submissions via the contest's own
// identity lookup → person_id is STAMPED as a denormalized field onto those docs
// + enrollments are materialized (source:"csv", snapshot computed). username_norm
// and all keys stay FROZEN (never renamed). After adoption the already-run
// contest appears on person scorecards.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.EVIDENCE_BUCKET = "la-bucket";
process.env.SESSION_COLLECTION = "la_sessions";
process.env.SETTINGS_COLLECTION = "la_settings";
process.env.CONTESTS_COLLECTION = "la_contests";
process.env.ROSTER_COLLECTION = "la_roster";
process.env.ALERTS_COLLECTION = "la_alerts";
process.env.SUBMISSIONS_COLLECTION = "la_submissions";
process.env.PROBLEMS_COLLECTION = "la_problems";
process.env.REVIEW_COLLECTION = "la_reviews";
process.env.COLLEGES_COLLECTION = "la_colleges";
process.env.PERSONS_COLLECTION = "la_persons";
process.env.ENROLLMENTS_COLLECTION = "la_enrollments";
process.env.ADMIN_AUDIT_COLLECTION = "la_audit";
process.env.ADMIN_PASSWORD = "la-admin-pass";

const handler = await import("../src/handler.mjs?legacyadopt");
const { api, __setClientsForTest } = handler;
const { personIdOf, identityNorm, enrollmentIdOf } = await import("../src/identity.mjs");

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
  function makeDocRef(name, id) {
    const store = getCollection(name);
    return {
      id,
      async create(value) { if (store.has(id)) { const e = new Error("ALREADY_EXISTS"); e.code = 6; throw e; } store.set(id, { ...value }); },
      async set(value, options) { const existing = options?.merge ? store.get(id) || {} : {}; store.set(id, { ...existing, ...value }); },
      async update(value) { const existing = store.get(id); if (!existing) throw new Error(`missing ${id}`); store.set(id, { ...existing, ...value }); },
      async delete() { store.delete(id); },
      async get() { const data = store.get(id); return { exists: Boolean(data), data: () => data }; }
    };
  }
  function makeQuery(name, filters, ordering) {
    return {
      where(field, op, value) { return makeQuery(name, [...filters, { field, op, value }], ordering); },
      orderBy(field, direction) { return makeQuery(name, filters, { field, direction }); },
      limit() { return this; },
      async get() {
        let entries = [...getCollection(name).entries()];
        for (const { field, op, value } of filters) {
          if (op === "in") entries = entries.filter(([, doc]) => Array.isArray(value) && value.includes(doc[field]));
          else entries = entries.filter(([, doc]) => doc[field] === value);
        }
        if (ordering) {
          entries = entries.sort(([, a], [, b]) => {
            const cmp = String(a[ordering.field] ?? "").localeCompare(String(b[ordering.field] ?? ""));
            return ordering.direction === "desc" ? -cmp : cmp;
          });
        }
        // Query result docs expose data(), id, and ref (matching real Firestore)
        // so an adoption-style "stamp via doc.ref" update path is testable.
        return { docs: entries.map(([id, data]) => ({ id, data: () => data, ref: makeDocRef(name, id) })) };
      }
    };
  }
  return {
    _collections: collections,
    collection(name) {
      const query = makeQuery(name, []);
      return {
        where: query.where, orderBy: query.orderBy, limit: query.limit, get: query.get,
        doc(id) { return makeDocRef(name, id); }
      };
    }
  };
}
function makeFakeStorage() {
  return { bucket() { return { file() { return { async save() {}, async getSignedUrl() { return ["https://x"]; }, async download() { return [""]; } }; }, async getFiles() { return [[]]; } }; } }
}

const ADMIN_HEADERS = { "x-admin-password": "la-admin-pass" };
function freshClients() {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  return firestore;
}
async function createContest(name, problems) {
  const res = await call(makeReq({ method: "POST", path: "/api/admin/contests", headers: ADMIN_HEADERS, body: { name, problems } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body.contest;
}
async function openContest(slug) {
  await call(makeReq({ method: "POST", path: "/api/admin/contest-status", headers: ADMIN_HEADERS, body: { slug, status: "open" } }));
}
function seedProblem(firestore, id, title) {
  firestore.collection("la_problems").doc(id).set({ id, title, points: 100, status: "published", scoring: "per_test", languages: ["python"] });
}

// A contest that already ran with LEGACY- shaped sessions/submissions: the
// username_norm is the bare identityNorm of the typed id (NO college prefix),
// person_id is absent. These are exactly what a pre-person contest leaves behind.
function legacyNorm(uniqueId) { return identityNorm(uniqueId); }

function seedLegacySession(firestore, slug, { uniqueId, name }) {
  const norm = legacyNorm(uniqueId);
  firestore.collection("la_sessions").doc(`sess-${norm}`).set({
    session_id: `sess-${norm}`, contest_slug: slug,
    username_norm: norm,            // legacy norm, NO college — must stay frozen
    candidate_id: uniqueId, roster_unique_id: uniqueId, name,
    status: "ended", created_at: "2026-06-10T04:00:00.000Z"
  });
}
function seedLegacySubmission(firestore, slug, { uniqueId, problemId, score, createdAt }) {
  const norm = legacyNorm(uniqueId);
  firestore.collection("la_submissions").doc(`${norm}:${problemId}:${createdAt}`).set({
    session_id: `sess-${norm}`, contest_slug: slug,
    username_norm: norm,            // frozen
    candidate_id: uniqueId, problem_id: problemId, score, max_points: 100,
    verdict: score >= 100 ? "accepted" : "wrong_answer", created_at: createdAt
  });
}

const ADOPT_ROWS = [
  { college: "KEC", unique_id: "21CS001", name: "Asha" },
  { college: "KEC", unique_id: "21CS002", name: "Bala" }
];
const KEC_001 = personIdOf("kec", identityNorm("21CS001"));
const KEC_002 = personIdOf("kec", identityNorm("21CS002"));

async function adopt(firestore, slug, rows = ADOPT_ROWS) {
  return call(makeReq({ method: "POST", path: "/api/admin/contest-adopt", headers: ADMIN_HEADERS, body: {
    contest: slug, unique_id_column: "unique_id",
    columns: ["college", "unique_id", "name"], column_mapping: { name: "name" }, rows,
    college_resolutions: { kec: { action: "create" } }
  } }));
}

test("adopt: stamps person_id onto matching legacy sessions + submissions, freezing username_norm", async () => {
  const firestore = freshClients();
  seedProblem(firestore, "p1", "Sum");
  const contest = await createContest("Legacy Aptitude 2025", [{ problem_id: "p1" }]);
  await openContest(contest.slug);
  seedLegacySession(firestore, contest.slug, { uniqueId: "21CS001", name: "Asha" });
  seedLegacySubmission(firestore, contest.slug, { uniqueId: "21CS001", problemId: "p1", score: 100, createdAt: "2026-06-10T04:05:00.000Z" });

  const res = await adopt(firestore, contest.slug);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
  assert.equal(res.body.sessions_stamped, 1);
  assert.equal(res.body.submissions_stamped, 1);

  const sessNorm = legacyNorm("21CS001");
  const session = firestore._collections.get("la_sessions").get(`sess-${sessNorm}`);
  assert.equal(session.person_id, KEC_001);          // stamped
  assert.equal(session.college_norm, "kec");          // denormed too
  assert.equal(session.username_norm, sessNorm);      // FROZEN — never renamed

  const sub = firestore._collections.get("la_submissions").get(`${sessNorm}:p1:2026-06-10T04:05:00.000Z`);
  assert.equal(sub.person_id, KEC_001);
  assert.equal(sub.username_norm, sessNorm);          // FROZEN
});

test("adopt: materializes enrollments (source:csv) for every rostered person", async () => {
  const firestore = freshClients();
  seedProblem(firestore, "p1", "Sum");
  const contest = await createContest("Legacy 2025", [{ problem_id: "p1" }]);
  await openContest(contest.slug);
  seedLegacySession(firestore, contest.slug, { uniqueId: "21CS001", name: "Asha" });
  seedLegacySession(firestore, contest.slug, { uniqueId: "21CS002", name: "Bala" });
  seedLegacySubmission(firestore, contest.slug, { uniqueId: "21CS001", problemId: "p1", score: 90, createdAt: "2026-06-10T04:05:00.000Z" });

  const res = await adopt(firestore, contest.slug);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));

  const e1 = firestore._collections.get("la_enrollments").get(enrollmentIdOf(contest.slug, KEC_001));
  const e2 = firestore._collections.get("la_enrollments").get(enrollmentIdOf(contest.slug, KEC_002));
  assert.equal(e1.status, "active");
  assert.equal(e1.source, "csv");
  assert.equal(e2.status, "active");
});

test("adopt: after adoption the legacy contest appears on the person scorecard with its real score", async () => {
  const firestore = freshClients();
  seedProblem(firestore, "p1", "Sum");
  const contest = await createContest("Legacy 2025", [{ problem_id: "p1" }]);
  await openContest(contest.slug);
  seedLegacySession(firestore, contest.slug, { uniqueId: "21CS001", name: "Asha" });
  seedLegacySubmission(firestore, contest.slug, { uniqueId: "21CS001", problemId: "p1", score: 100, createdAt: "2026-06-10T04:05:00.000Z" });
  await adopt(firestore, contest.slug);

  // The scorecard now finds the contest via the materialized enrollment, and
  // reads the LIVE submission score (the docs were stamped, not deleted).
  const card = await call(makeReq({ method: "GET", path: "/api/admin/person", headers: ADMIN_HEADERS, query: { person_id: KEC_001 } }));
  assert.equal(card.statusCode, 200, JSON.stringify(card.body));
  assert.equal(card.body.rows.length, 1);
  assert.equal(card.body.rows[0].contest_slug, contest.slug);
  assert.equal(card.body.rows[0].total, 100);
  assert.equal(card.body.rows[0].from_snapshot, false);
});

test("adopt: a roster row with no matching session still enrolls the person (0 sessions stamped for it)", async () => {
  const firestore = freshClients();
  seedProblem(firestore, "p1", "Sum");
  const contest = await createContest("Legacy 2025", [{ problem_id: "p1" }]);
  await openContest(contest.slug);
  // Only 21CS001 sat the exam; 21CS002 was rostered but absent.
  seedLegacySession(firestore, contest.slug, { uniqueId: "21CS001", name: "Asha" });

  const res = await adopt(firestore, contest.slug);
  assert.equal(res.body.sessions_stamped, 1);
  // both persons enrolled regardless
  assert.ok(firestore._collections.get("la_enrollments").get(enrollmentIdOf(contest.slug, KEC_001)));
  assert.ok(firestore._collections.get("la_enrollments").get(enrollmentIdOf(contest.slug, KEC_002)));
});

test("adopt: writes a contest-level audit entry (the one-time backfill is traceable)", async () => {
  const firestore = freshClients();
  seedProblem(firestore, "p1", "Sum");
  const contest = await createContest("Legacy 2025", [{ problem_id: "p1" }]);
  await openContest(contest.slug);
  seedLegacySession(firestore, contest.slug, { uniqueId: "21CS001", name: "Asha" });
  await adopt(firestore, contest.slug);

  const audits = [...firestore._collections.get("la_audit").values()];
  assert.ok(audits.some((a) => a.action === "adopt_into_person_model" && a.contest_slug === contest.slug));
});
