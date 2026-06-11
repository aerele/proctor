// backend/test/peopleDirectory.test.mjs — S-J People tab endpoints (vision
// §2.14 People tab: directory search → person page = cross-round scorecard,
// reading LIVE data where it exists and FALLING BACK to enrollment.final_snapshot
// after purge; §2.9 purge-survivor; §10.2 snapshot scores VISIBLE).
//
// THE ALL_CONTESTS SENTINEL CONTRACT (vision §2.14 + §7 row S-J): the People
// directory + the per-person enrollment scan are the ONE sanctioned
// cross-contest reads. They use the explicit ALL_CONTESTS sentinel so the F9
// no-bleed canary stays intact: a person scorecard MUST span both contests, but
// the CONTEST-scoped reads it fans out per contest (scoreboard, integrity) MUST
// each stay isolated to their own contest. The "ALL_CONTESTS sentinel does not
// break the no-bleed canary" test below pins exactly that.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.EVIDENCE_BUCKET = "pd-bucket";
process.env.SESSION_COLLECTION = "pd_sessions";
process.env.SETTINGS_COLLECTION = "pd_settings";
process.env.CONTESTS_COLLECTION = "pd_contests";
process.env.ROSTER_COLLECTION = "pd_roster";
process.env.ALERTS_COLLECTION = "pd_alerts";
process.env.SUBMISSIONS_COLLECTION = "pd_submissions";
process.env.PROBLEMS_COLLECTION = "pd_problems";
process.env.REVIEW_COLLECTION = "pd_reviews";
process.env.COLLEGES_COLLECTION = "pd_colleges";
process.env.PERSONS_COLLECTION = "pd_persons";
process.env.ENROLLMENTS_COLLECTION = "pd_enrollments";
process.env.ADMIN_AUDIT_COLLECTION = "pd_audit";
process.env.ADMIN_PASSWORD = "pd-admin-pass";

const handler = await import("../src/handler.mjs?peopledirectory");
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

const ADMIN_HEADERS = { "x-admin-password": "pd-admin-pass" };

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
  firestore.collection("pd_problems").doc(id).set({ id, title, points: 100, status: "published", scoring: "per_test", languages: ["python"] });
}
async function uploadRoster(slug, rows, resolutions) {
  const res = await call(makeReq({ method: "POST", path: "/api/admin/roster", headers: ADMIN_HEADERS, body: {
    contest: slug, unique_id_column: "unique_id",
    columns: ["college", "unique_id", "name"], column_mapping: { name: "name" }, rows,
    college_resolutions: resolutions
  } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true, JSON.stringify(res.body));
  return res.body;
}
function seedSubmission(firestore, slug, { personId, candidateId, problemId, score, createdAt }) {
  const id = `${personId}:${problemId}:${createdAt}`;
  firestore.collection("pd_submissions").doc(id).set({
    session_id: `sess-${personId}`, contest_slug: slug, username_norm: personId, person_id: personId,
    candidate_id: candidateId, problem_id: problemId, score, max_points: 100,
    verdict: score >= 100 ? "accepted" : "wrong_answer", created_at: createdAt
  });
}
function seedAlert(firestore, { id, slug, personId, severity, archived = false }) {
  firestore.collection("pd_alerts").doc(id).set({ id, contest_slug: slug, username_norm: personId, severity, archived, timestamp: "2026-06-10T05:00:00.000Z" });
}

const KEC_001 = personIdOf("kec", identityNorm("21CS001"));
const KEC_002 = personIdOf("kec", identityNorm("21CS002"));
const PSG_009 = personIdOf("psg", identityNorm("22IT009"));

// Two contests Asha (KEC_001) attempted. R1 LIVE (submissions present), R2
// PURGED (db_purged_at stamped + enrollment.final_snapshot frozen). A second
// person (Bala, KEC_002) only in R1; a third (PSG_009) only in R2.
async function seedTwoRounds(firestore) {
  seedProblem(firestore, "p1", "Sum Two");
  seedProblem(firestore, "p2", "Reverse");
  const r1 = await createContest("KEC Round 1", [{ problem_id: "p1" }, { problem_id: "p2" }]);
  await openContest(r1.slug);
  await uploadRoster(r1.slug, [
    { college: "KEC", unique_id: "21CS001", name: "Asha Ramanathan" },
    { college: "KEC", unique_id: "21CS002", name: "Bala Subramanian" }
  ], { kec: { action: "create" } });
  // Asha: p1 80 + p2 50 = 130; Bala: p1 100.
  seedSubmission(firestore, r1.slug, { personId: KEC_001, candidateId: "21CS001", problemId: "p1", score: 80, createdAt: "2026-06-10T04:05:00.000Z" });
  seedSubmission(firestore, r1.slug, { personId: KEC_001, candidateId: "21CS001", problemId: "p2", score: 50, createdAt: "2026-06-10T04:07:00.000Z" });
  seedSubmission(firestore, r1.slug, { personId: KEC_002, candidateId: "21CS002", problemId: "p1", score: 100, createdAt: "2026-06-10T04:09:00.000Z" });
  seedAlert(firestore, { id: "r1-a1", slug: r1.slug, personId: KEC_001, severity: "warning" });

  const r2 = await createContest("KEC Round 2", [{ problem_id: "p1" }]);
  await openContest(r2.slug);
  await uploadRoster(r2.slug, [
    { college: "KEC", unique_id: "21CS001", name: "Asha Ramanathan" },
    { college: "PSG", unique_id: "22IT009", name: "Priya Iyer" }
  ], { kec: { action: "create" }, psg: { action: "create" } });
  // R2 is PURGED: stamp the enrollment snapshots + db_purged_at, delete the
  // submissions (simulate the Wave-7 purge having run). Asha 70 selected.
  firestore.collection("pd_enrollments").doc(enrollmentIdOf(r2.slug, KEC_001)).set({
    final_snapshot: {
      total_score: 70, per_problem: { p1: 70 },
      integrity: { alerts_by_severity: { critical: 1, warning: 0, info: 0 }, review_verdict: "flagged" },
      session_status: "ended"
    },
    selection_status: "selected"
  }, { merge: true });
  firestore.collection("pd_contests").doc(r2.slug).set({ db_purged_at: "2026-06-20T00:00:00.000Z" }, { merge: true });
  return { r1, r2 };
}

// ---- directory search ----------------------------------------------------------

test("people directory: search by name returns matching persons across all contests", async () => {
  const firestore = freshClients();
  await seedTwoRounds(firestore);
  const res = await call(makeReq({ method: "GET", path: "/api/admin/people", headers: ADMIN_HEADERS, query: { search: "asha" } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.people.map((p) => p.person_id), [KEC_001]);
  assert.equal(res.body.people[0].name, "Asha Ramanathan");
  assert.equal(res.body.people[0].college, "KEC");
  assert.equal(res.body.people[0].contest_count, 2); // Asha attempted both rounds
});

test("people directory: search by unique_id substring", async () => {
  const firestore = freshClients();
  await seedTwoRounds(firestore);
  const res = await call(makeReq({ method: "GET", path: "/api/admin/people", headers: ADMIN_HEADERS, query: { search: "22IT009" } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.people.map((p) => p.person_id), [PSG_009]);
});

test("people directory: filter by college_norm", async () => {
  const firestore = freshClients();
  await seedTwoRounds(firestore);
  const res = await call(makeReq({ method: "GET", path: "/api/admin/people", headers: ADMIN_HEADERS, query: { college: "psg" } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.people.map((p) => p.person_id), [PSG_009]);
});

test("people directory: empty query returns everyone (capped), with college options", async () => {
  const firestore = freshClients();
  await seedTwoRounds(firestore);
  const res = await call(makeReq({ method: "GET", path: "/api/admin/people", headers: ADMIN_HEADERS, query: {} }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.people.map((p) => p.person_id).sort(), [KEC_001, KEC_002, PSG_009].sort());
  assert.deepEqual(res.body.colleges.map((c) => c.college_norm).sort(), ["kec", "psg"]);
});

// ---- person scorecard: live-vs-snapshot fallback -------------------------------

test("person scorecard: cross-round, LIVE round reads live data + PURGED round reads final_snapshot", async () => {
  const firestore = freshClients();
  const { r1, r2 } = await seedTwoRounds(firestore);
  const res = await call(makeReq({ method: "GET", path: "/api/admin/person", headers: ADMIN_HEADERS, query: { person_id: KEC_001 } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.person.person_id, KEC_001);
  assert.equal(res.body.person.name, "Asha Ramanathan");
  assert.equal(res.body.rows.length, 2);

  const r1Row = res.body.rows.find((row) => row.contest_slug === r1.slug);
  assert.equal(r1Row.total, 130);          // LIVE: computed from submissions
  assert.equal(r1Row.from_snapshot, false);
  assert.equal(r1Row.integrity.alerts_by_severity.warning, 1);

  const r2Row = res.body.rows.find((row) => row.contest_slug === r2.slug);
  assert.equal(r2Row.total, 70);           // PURGED: from final_snapshot
  assert.equal(r2Row.from_snapshot, true);
  assert.equal(r2Row.contest_purged, true);
  assert.equal(r2Row.selection_status, "selected");
  assert.equal(r2Row.integrity.review_verdict, "flagged");
});

test("person scorecard: unknown person → 404-style configured:false (no crash, no leak)", async () => {
  const firestore = freshClients();
  await seedTwoRounds(firestore);
  const res = await call(makeReq({ method: "GET", path: "/api/admin/person", headers: ADMIN_HEADERS, query: { person_id: "nope~nobody" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.configured, false);
});

test("person scorecard CSV: format=csv returns the per-contest scorecard CSV", async () => {
  const firestore = freshClients();
  await seedTwoRounds(firestore);
  const res = await call(makeReq({ method: "GET", path: "/api/admin/person", headers: ADMIN_HEADERS, query: { person_id: KEC_001, format: "csv" } }));
  assert.equal(res.statusCode, 200);
  assert.match(res.body.csv, /^contest,contest_name,status,total,/);
  assert.ok(res.body.csv.includes("130"));
  assert.ok(res.body.csv.includes("70"));
});

// ---- THE ALL_CONTESTS sentinel does NOT break the no-bleed canary --------------

test("ALL_CONTESTS sentinel: the person enrollment scan spans contests, but the per-contest live reads stay isolated", async () => {
  const firestore = freshClients();
  const { r1, r2 } = await seedTwoRounds(firestore);

  // Asha is in BOTH rounds. The scorecard must show two rows (sentinel works).
  const card = await call(makeReq({ method: "GET", path: "/api/admin/person", headers: ADMIN_HEADERS, query: { person_id: KEC_001 } }));
  assert.equal(card.body.rows.length, 2);

  // CANARY: even though the scan is cross-contest, R1's live total (130) must
  // NOT bleed into R2's row, and R2's snapshot total (70) must NOT bleed into
  // R1's row. The per-contest scoreboard fan-out is each scoped to its own
  // contest — the sentinel is only used for the ENROLLMENT directory scan.
  const r1Row = card.body.rows.find((row) => row.contest_slug === r1.slug);
  const r2Row = card.body.rows.find((row) => row.contest_slug === r2.slug);
  assert.equal(r1Row.total, 130);
  assert.equal(r2Row.total, 70);
  assert.notEqual(r1Row.total, r2Row.total);

  // And the contest-scoped Results endpoint for R1 must still be isolated: it
  // must NOT contain R2's 70 score for Asha (the F9 no-bleed invariant the
  // sentinel must not weaken).
  const r1Results = await call(makeReq({ method: "GET", path: "/api/admin/contest-results", headers: ADMIN_HEADERS, query: { contest: r1.slug } }));
  const ashaR1 = r1Results.body.rows.find((row) => row.person_id === KEC_001);
  assert.equal(ashaR1.total, 130); // R1's number, never R2's 70
});

test("person scorecard NO-BLEED: a same-college roll under a different contest never merges into the wrong person", async () => {
  const firestore = freshClients();
  await seedTwoRounds(firestore);
  // Bala only attempted R1 — his scorecard has exactly one row, never Asha's.
  const res = await call(makeReq({ method: "GET", path: "/api/admin/person", headers: ADMIN_HEADERS, query: { person_id: KEC_002 } }));
  assert.equal(res.body.rows.length, 1);
  assert.equal(res.body.rows[0].total, 100);
});
