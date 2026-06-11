// backend/test/contestResults.test.mjs — S-J: the Results-tab endpoints.
// Specs: docs/superpowers/specs/2026-06-10-f10-product-vision.md
//          §2.14 (Results tab: rank/per-problem/integrity/selection/CSV),
//          §2.9 (Enrollment selection + final_snapshot + purge-survivor),
//          §2.13 (multi-college projection rule), §7 row S-J.
//        docs/superpowers/specs/2026-06-10-f9-identity-data-lifecycle-design.md
//          (scopedQuery no-bleed invariant — the canary lives here too).
// Covers: GET /api/admin/contest-results rollup correctness (rank, per-problem
// best, integrity column, selection_status), CONTEST-SCOPE no-bleed (a second
// contest's submissions/alerts never leak in), CSV export, bulk selection
// transitions with the from_status guard, and "Mark selection done" stamping
// final_snapshot + the retention clock.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.EVIDENCE_BUCKET = "cr-bucket";
process.env.SESSION_COLLECTION = "cr_sessions";
process.env.SETTINGS_COLLECTION = "cr_settings";
process.env.CONTESTS_COLLECTION = "cr_contests";
process.env.ROSTER_COLLECTION = "cr_roster";
process.env.ALERTS_COLLECTION = "cr_alerts";
process.env.SUBMISSIONS_COLLECTION = "cr_submissions";
process.env.PROBLEMS_COLLECTION = "cr_problems";
process.env.REVIEW_COLLECTION = "cr_reviews";
process.env.COLLEGES_COLLECTION = "cr_colleges";
process.env.PERSONS_COLLECTION = "cr_persons";
process.env.ENROLLMENTS_COLLECTION = "cr_enrollments";
process.env.ADMIN_AUDIT_COLLECTION = "cr_audit";
process.env.ADMIN_PASSWORD = "cr-admin-pass";

const handler = await import("../src/handler.mjs?contestresults");
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

// Fake Firestore honoring the equality filters scopedQuery/the rollup use
// (contest_slug, roster_version, username_norm) — same shape as identityCore.
function makeFakeFirestore() {
  const collections = new Map();
  function getCollection(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  }
  function makeQuery(name, filters, ordering) {
    return {
      where(field, op, value) { return makeQuery(name, [...filters, { field, op, value }], ordering); },
      orderBy(field, direction) { return makeQuery(name, filters, { field, direction }); },
      limit() { return this; },
      async get() {
        let docs = [...getCollection(name).values()];
        for (const { field, op, value } of filters) {
          if (op === "in") docs = docs.filter((doc) => Array.isArray(value) && value.includes(doc[field]));
          else docs = docs.filter((doc) => doc[field] === value);
        }
        if (ordering) {
          docs = docs.sort((a, b) => {
            const cmp = String(a[ordering.field] ?? "").localeCompare(String(b[ordering.field] ?? ""));
            return ordering.direction === "desc" ? -cmp : cmp;
          });
        }
        return { docs: docs.map((data) => ({ data: () => data })) };
      }
    };
  }
  return {
    _collections: collections,
    collection(name) {
      const query = makeQuery(name, []);
      const store = getCollection(name);
      return {
        where: query.where, orderBy: query.orderBy, limit: query.limit, get: query.get,
        doc(id) {
          return {
            id,
            async create(value) { if (store.has(id)) { const e = new Error("ALREADY_EXISTS"); e.code = 6; throw e; } store.set(id, { ...value }); },
            async set(value, options) { const existing = options?.merge ? store.get(id) || {} : {}; store.set(id, { ...existing, ...value }); },
            async update(value) { const existing = store.get(id); if (!existing) throw new Error(`missing ${id}`); store.set(id, { ...existing, ...value }); },
            async delete() { store.delete(id); },
            async get() { const data = store.get(id); return { exists: Boolean(data), data: () => data }; }
          };
        }
      };
    }
  };
}
function makeFakeStorage() {
  return { bucket() { return { file() { return { async save() {}, async getSignedUrl() { return ["https://x"]; }, async download() { return [""]; } }; }, async getFiles() { return [[]]; } }; } }
}

const ADMIN_HEADERS = { "x-admin-password": "cr-admin-pass" };

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
  const res = await call(makeReq({ method: "POST", path: "/api/admin/contest-status", headers: ADMIN_HEADERS, body: { slug, status: "open" } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
}
function seedProblem(firestore, id, title) {
  firestore.collection("cr_problems").doc(id).set({ id, title, points: 100, status: "published", scoring: "per_test", languages: ["python"] });
}
async function uploadRoster(slug, rows) {
  const res = await call(makeReq({ method: "POST", path: "/api/admin/roster", headers: ADMIN_HEADERS, body: {
    contest: slug, unique_id_column: "unique_id",
    columns: ["college", "unique_id", "name"], column_mapping: { name: "name" }, rows,
    college_resolutions: { kec: { action: "create" }, psg: { action: "create" } }
  } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true, JSON.stringify(res.body));
  return res.body;
}
function seedSubmission(firestore, collectionSlug, { personId, candidateId, problemId, score, createdAt }) {
  const id = `${personId}:${problemId}:${createdAt}`;
  firestore.collection("cr_submissions").doc(id).set({
    session_id: `sess-${personId}`, contest_slug: collectionSlug, username_norm: personId, person_id: personId,
    candidate_id: candidateId, problem_id: problemId, score, max_points: 100, verdict: score >= 100 ? "accepted" : "wrong_answer",
    created_at: createdAt
  });
}
function seedAlert(firestore, { id, contestSlug, personId, severity, archived = false }) {
  firestore.collection("cr_alerts").doc(id).set({ id, contest_slug: contestSlug, username_norm: personId, severity, archived, timestamp: "2026-06-10T05:00:00.000Z" });
}
function seedReview(firestore, { personId, reviewer, verdict, contestSlug }) {
  const docId = `${personId}::${reviewer}::${contestSlug}`;
  firestore.collection("cr_reviews").doc(docId).set({ username_norm: personId, reviewer_name: reviewer, verdict, contest_slug: contestSlug });
}

const KEC_001 = personIdOf("kec", identityNorm("21CS001"));
const KEC_002 = personIdOf("kec", identityNorm("21CS002"));

// One fully-seeded single-college contest: 2 problems, 3 candidates, 1 absent.
async function seedContest(firestore) {
  seedProblem(firestore, "p1", "Sum Two");
  seedProblem(firestore, "p2", "Reverse");
  const contest = await createContest("KEC June 2026", [{ problem_id: "p1" }, { problem_id: "p2" }]);
  await openContest(contest.slug);
  await uploadRoster(contest.slug, [
    { college: "KEC", unique_id: "21CS001", name: "Asha" },
    { college: "KEC", unique_id: "21CS002", name: "Bala" },
    { college: "KEC", unique_id: "21CS003", name: "Cara" } // absent — no submissions
  ]);
  // Asha: p1 80, p2 50 = 130; Bala: p1 100 = 100; Cara: nothing.
  seedSubmission(firestore, contest.slug, { personId: KEC_001, candidateId: "21CS001", problemId: "p1", score: 40, createdAt: "2026-06-10T04:01:00.000Z" });
  seedSubmission(firestore, contest.slug, { personId: KEC_001, candidateId: "21CS001", problemId: "p1", score: 80, createdAt: "2026-06-10T04:05:00.000Z" });
  seedSubmission(firestore, contest.slug, { personId: KEC_001, candidateId: "21CS001", problemId: "p2", score: 50, createdAt: "2026-06-10T04:07:00.000Z" });
  seedSubmission(firestore, contest.slug, { personId: KEC_002, candidateId: "21CS002", problemId: "p1", score: 100, createdAt: "2026-06-10T04:09:00.000Z" });
  // Asha has 1 critical alert + a cheating review verdict.
  seedAlert(firestore, { id: "a1", contestSlug: contest.slug, personId: KEC_001, severity: "critical" });
  seedAlert(firestore, { id: "a2", contestSlug: contest.slug, personId: KEC_001, severity: "warning", archived: true }); // archived → ignored
  seedReview(firestore, { personId: KEC_001, reviewer: "rev", verdict: 1, contestSlug: contest.slug });
  return contest;
}

// ---- rollup correctness ---------------------------------------------------------

test("contest-results: ranked rollup — rank, total, per-problem best, absent candidate at 0", async () => {
  const firestore = freshClients();
  const contest = await seedContest(firestore);
  const res = await call(makeReq({ method: "GET", path: "/api/admin/contest-results", headers: ADMIN_HEADERS, query: { contest: contest.slug } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.configured, true);
  assert.deepEqual(res.body.rows.map((r) => r.candidate_id), ["21CS001", "21CS002", "21CS003"]);
  assert.deepEqual(res.body.rows.map((r) => r.rank), [1, 2, 3]);
  assert.deepEqual(res.body.rows.map((r) => r.total), [130, 100, 0]);
  // per-problem in contest order, best score
  assert.deepEqual(res.body.rows[0].per_problem.map((c) => [c.problem_id, c.best_score]), [["p1", 80], ["p2", 50]]);
  // problem titles surfaced for the header
  assert.deepEqual(res.body.problems.map((p) => p.title), ["Sum Two", "Reverse"]);
  // single college → no college suffix on the label
  assert.equal(res.body.rows[0].display_id, "21CS001");
});

test("contest-results: integrity column folds non-archived alerts by severity + review verdict", async () => {
  const firestore = freshClients();
  const contest = await seedContest(firestore);
  const res = await call(makeReq({ method: "GET", path: "/api/admin/contest-results", headers: ADMIN_HEADERS, query: { contest: contest.slug } }));
  const asha = res.body.rows[0];
  assert.deepEqual(asha.integrity.alerts_by_severity, { critical: 1, warning: 0, info: 0 }); // archived warning excluded
  assert.equal(asha.integrity.has_critical, true);
  assert.equal(asha.integrity.review_verdict, "flagged");
  const bala = res.body.rows[1];
  assert.equal(bala.integrity.has_critical, false);
  assert.equal(bala.integrity.review_verdict, "none");
});

test("contest-results: NO-BLEED — a second contest's submissions/alerts never leak in (F9 canary)", async () => {
  const firestore = freshClients();
  const contest = await seedContest(firestore);
  // A parallel contest with the SAME roll numbers (same college) — different slug.
  seedProblem(firestore, "p1", "Sum Two");
  const other = await createContest("PSG June 2026", [{ problem_id: "p1" }]);
  await openContest(other.slug);
  await uploadRoster(other.slug, [{ college: "KEC", unique_id: "21CS001", name: "Asha" }]);
  // A 999 score for the SAME person_id but under the OTHER contest_slug.
  seedSubmission(firestore, other.slug, { personId: KEC_001, candidateId: "21CS001", problemId: "p1", score: 100, createdAt: "2026-06-10T06:00:00.000Z" });
  seedAlert(firestore, { id: "other-a", contestSlug: other.slug, personId: KEC_001, severity: "critical" });

  const res = await call(makeReq({ method: "GET", path: "/api/admin/contest-results", headers: ADMIN_HEADERS, query: { contest: contest.slug } }));
  const asha = res.body.rows.find((r) => r.person_id === KEC_001);
  assert.equal(asha.total, 130); // NOT 230 — the other contest's submission did not bleed in
  assert.equal(asha.integrity.alerts_by_severity.critical, 1); // NOT 2
});

test("contest-results: unknown/legacy contest → { configured:false } (no global leak)", async () => {
  freshClients();
  const res = await call(makeReq({ method: "GET", path: "/api/admin/contest-results", headers: ADMIN_HEADERS, query: { contest: "nope" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.configured, false);
});

test("contest-results: requires admin", async () => {
  const firestore = freshClients();
  const contest = await seedContest(firestore);
  const res = await call(makeReq({ method: "GET", path: "/api/admin/contest-results", query: { contest: contest.slug } }));
  assert.equal(res.statusCode, 401);
});

// ---- CSV export ----------------------------------------------------------------

test("contest-results?format=csv: header + per-problem columns + integrity + selection", async () => {
  const firestore = freshClients();
  const contest = await seedContest(firestore);
  const res = await call(makeReq({ method: "GET", path: "/api/admin/contest-results", headers: ADMIN_HEADERS, query: { contest: contest.slug, format: "csv" } }));
  assert.equal(res.statusCode, 200);
  const lines = res.body.csv.split("\n");
  assert.equal(lines[0], "rank,candidate_id,name,college,total,Sum Two,Reverse,critical_alerts,warning_alerts,info_alerts,review_verdict,selection_status");
  assert.match(lines[1], /^1,21CS001,Asha,KEC,130,80,50,1,0,0,flagged,none$/);
});

// ---- bulk selection transitions ------------------------------------------------

test("contest-selection: bulk transition to shortlisted, then a from_status-guarded promote", async () => {
  const firestore = freshClients();
  const contest = await seedContest(firestore);

  let res = await call(makeReq({ method: "POST", path: "/api/admin/contest-selection", headers: ADMIN_HEADERS, body: {
    contest: contest.slug, person_ids: [KEC_001, KEC_002], selection_status: "shortlisted"
  } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.updated.sort(), [KEC_001, KEC_002].sort());

  // Promote only the already-shortlisted to selected — Cara (none) must be skipped by the guard.
  res = await call(makeReq({ method: "POST", path: "/api/admin/contest-selection", headers: ADMIN_HEADERS, body: {
    contest: contest.slug, person_ids: [KEC_001, KEC_002, personIdOf("kec", identityNorm("21CS003"))],
    from_status: "shortlisted", selection_status: "selected"
  } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.updated.sort(), [KEC_001, KEC_002].sort());
  assert.ok(res.body.skipped.some((s) => s.reason === "from_status_mismatch"));

  // The transitions show up on the Results rows.
  const results = await call(makeReq({ method: "GET", path: "/api/admin/contest-results", headers: ADMIN_HEADERS, query: { contest: contest.slug } }));
  const byId = new Map(results.body.rows.map((r) => [r.person_id, r.selection_status]));
  assert.equal(byId.get(KEC_001), "selected");
  assert.equal(byId.get(personIdOf("kec", identityNorm("21CS003"))), "none");
});

test("contest-selection: rejects an unknown selection_status", async () => {
  const firestore = freshClients();
  const contest = await seedContest(firestore);
  const res = await call(makeReq({ method: "POST", path: "/api/admin/contest-selection", headers: ADMIN_HEADERS, body: {
    contest: contest.slug, person_ids: [KEC_001], selection_status: "winner"
  } }));
  assert.equal(res.statusCode, 400);
});

// ---- mark selection done (snapshot + retention clock) --------------------------

test("contest-selection-done: stamps each enrollment's final_snapshot + the contest retention clock", async () => {
  const firestore = freshClients();
  const contest = await seedContest(firestore);
  await call(makeReq({ method: "POST", path: "/api/admin/contest-selection", headers: ADMIN_HEADERS, body: {
    contest: contest.slug, person_ids: [KEC_001], selection_status: "selected"
  } }));

  const res = await call(makeReq({ method: "POST", path: "/api/admin/contest-selection-done", headers: ADMIN_HEADERS, body: { contest: contest.slug } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(res.body.selection_done_at);
  assert.equal(res.body.enrollments_snapshotted, 3);

  // The snapshot is frozen onto the enrollment doc.
  const ashaEnroll = firestore.collection("cr_enrollments").doc(enrollmentIdOf(contest.slug, KEC_001));
  const snap = (await ashaEnroll.get()).data().final_snapshot;
  assert.equal(snap.total_score, 130);
  assert.deepEqual(snap.per_problem, { p1: 80, p2: 50 });
  assert.equal(snap.integrity.review_verdict, "flagged");
  assert.equal(snap.name, "Asha");

  // The retention clock is stamped on the CONTEST doc (Wave-7 sweep reads it).
  const contestDoc = (await firestore.collection("cr_contests").doc(contest.slug).get()).data();
  assert.ok(contestDoc.selection_done_at);
});

test("PURGE-SURVIVOR: with submissions deleted, results fall back to final_snapshot (vision §2.9)", async () => {
  const firestore = freshClients();
  const contest = await seedContest(firestore);
  await call(makeReq({ method: "POST", path: "/api/admin/contest-selection", headers: ADMIN_HEADERS, body: {
    contest: contest.slug, person_ids: [KEC_001], selection_status: "selected"
  } }));
  await call(makeReq({ method: "POST", path: "/api/admin/contest-selection-done", headers: ADMIN_HEADERS, body: { contest: contest.slug } }));

  // Simulate the F9 purge: delete every submission (heavy data gone), keep enrollments.
  for (const id of [...firestore._collections.get("cr_submissions").keys()]) {
    firestore.collection("cr_submissions").doc(id).delete();
  }

  const res = await call(makeReq({ method: "GET", path: "/api/admin/contest-results", headers: ADMIN_HEADERS, query: { contest: contest.slug } }));
  assert.equal(res.statusCode, 200);
  const asha = res.body.rows.find((r) => r.person_id === KEC_001);
  assert.equal(asha.total, 130); // from the frozen snapshot, not blank
  assert.equal(asha.from_snapshot, true);
  assert.equal(asha.selection_status, "selected");
  assert.equal(asha.name, "Asha");
});
