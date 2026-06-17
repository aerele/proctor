// backend/test/evaluationScanCaps.test.mjs
//
// Exam-eve 2026-06-18 (FIX 1): regression guard that the PRODUCTION candidate-
// evaluation instance scans with the RAISED caps. The caps live in
// evaluation.mjs DEFAULT params (sessionsQueryLimit=6000,
// submissionsQueryLimit=120000), but handler.mjs constructs the production
// makeEvaluation() with a ctx that OVERRIDES both — it passes
// sessionsQueryLimit: SESSIONS_QUERY_LIMIT and submissionsQueryLimit:
// SUBMISSIONS_RESULTS_LIMIT (the handler constants). So a defaults-only raise is
// DEAD CODE; the effective cap is whatever the handler constant is.
//
// This test drives a real evaluation through the production `api` over a fake
// Firestore that records the `.limit(n)` argument applied to each collection,
// then asserts the EFFECTIVE limits are 6000 (sessions) / 120000 (submissions).
// If a future ctx override silently shadows the raise back down, this fails.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.EVIDENCE_BUCKET = "ev-bucket";
process.env.SESSION_COLLECTION = "ev_sessions";
process.env.SETTINGS_COLLECTION = "ev_settings";
process.env.CONTESTS_COLLECTION = "ev_contests";
process.env.ROSTER_COLLECTION = "ev_roster";
process.env.ALERTS_COLLECTION = "ev_alerts";
process.env.SUBMISSIONS_COLLECTION = "ev_submissions";
process.env.PROBLEMS_COLLECTION = "ev_problems";
process.env.REVIEW_COLLECTION = "ev_reviews";
process.env.COLLEGES_COLLECTION = "ev_colleges";
process.env.PERSONS_COLLECTION = "ev_persons";
process.env.ENROLLMENTS_COLLECTION = "ev_enrollments";
process.env.ADMIN_AUDIT_COLLECTION = "ev_audit";
process.env.EVALUATIONS_COLLECTION = "ev_evaluations";
process.env.ADMIN_PASSWORD = "ev-admin-pass";

const handler = await import("../src/handler.mjs?evalscancaps");
const { api, __setClientsForTest } = handler;

const ADMIN_HEADERS = { "x-admin-password": "ev-admin-pass" };

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

// Fake Firestore that RECORDS the `.limit(n)` argument applied per collection.
// limitsByCollection.get(name) is the array of every limit value the code asked
// for on that collection during the run.
function makeRecordingFirestore(limitsByCollection) {
  const collections = new Map();
  function getCollection(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  }
  function record(name, value) {
    if (!limitsByCollection.has(name)) limitsByCollection.set(name, []);
    limitsByCollection.get(name).push(value);
  }
  function makeQuery(name, filters, ordering) {
    return {
      where(field, op, value) { return makeQuery(name, [...filters, { field, op, value }], ordering); },
      orderBy(field, direction) { return makeQuery(name, filters, { field, direction }); },
      limit(value) { record(name, value); return this; },
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

function makeFakeStorage(objects = new Map()) {
  return {
    _objects: objects,
    bucket() {
      return {
        file(key) {
          return {
            async save(contents) { objects.set(key, String(contents)); },
            async getSignedUrl() { return [`https://signed.example/${key}`]; },
            async download() { return [objects.get(key) || ""]; }
          };
        },
        async getFiles({ prefix } = {}) {
          const matched = [];
          for (const key of objects.keys()) {
            if (!prefix || key.startsWith(prefix)) {
              matched.push({ name: key, async download() { return [objects.get(key) || ""]; } });
            }
          }
          return [matched];
        }
      };
    }
  };
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

test("FIX 1: production evaluation scans with EFFECTIVE caps 6000 (sessions) / 120000 (submissions)", async () => {
  const limitsByCollection = new Map();
  const firestore = makeRecordingFirestore(limitsByCollection);
  __setClientsForTest({ firestore, storage: makeFakeStorage(new Map()) });

  firestore.collection("ev_problems").doc("p1").set({
    id: "p1", title: "Answer", points: 100, status: "published", scoring: "per_test",
    languages: ["python"], stubs: { python: "def solve():\n    pass\n" }
  });
  const contest = await createContest("Cap Guard 2026", [{ problem_id: "p1" }]);
  await openContest(contest.slug);

  // One session + one submission so the batch evaluator actually runs its
  // scoped submissions + sessions scans (each applies its `.limit()`).
  const slug = contest.slug;
  const prefix = `contests/${slug}/sessions/anon/s1/`;
  firestore.collection("ev_sessions").doc("s1").set({
    session_id: "s1", contest_slug: slug, username_norm: "anon", person_id: null,
    candidate_id: "anon", name: "Anon", room: "Lab A", status: "ended", storage_prefix: prefix,
    created_at: "2026-06-10T03:59:00.000Z"
  });
  firestore.collection("ev_submissions").doc("sub1").set({
    _id: "sub1", session_id: "s1", contest_slug: slug, username_norm: "anon", person_id: null,
    candidate_id: "anon", problem_id: "p1", language: "python", verdict: "accepted",
    passed_count: 10, total: 10, score: 100, max_points: 100,
    source_code: "def solve():\n    return 42\n", created_at: "2026-06-10T04:00:30.000Z"
  });

  const res = await call(makeReq({ method: "POST", path: "/api/admin/contest-evaluate", headers: ADMIN_HEADERS, body: { contest: slug } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));

  const submissionLimits = limitsByCollection.get("ev_submissions") || [];
  const sessionLimits = limitsByCollection.get("ev_sessions") || [];

  // The batch evaluator scans submissions with submissionsQueryLimit and
  // sessions with sessionsQueryLimit. Assert the RAISED caps are the effective
  // ones (catches a future ctx override silently shadowing the raise).
  assert.ok(
    submissionLimits.includes(120000),
    `expected submissions scan capped at 120000, saw ${JSON.stringify(submissionLimits)}`
  );
  assert.ok(
    sessionLimits.includes(6000),
    `expected sessions scan capped at 6000, saw ${JSON.stringify(sessionLimits)}`
  );
  // And explicitly NOT the old caps — a regression to 2000/50000 must fail here.
  assert.ok(!submissionLimits.includes(50000), "submissions scan must NOT use the old 50000 cap");
  assert.ok(!sessionLimits.includes(2000), "sessions scan must NOT use the old 2000 cap");
});
