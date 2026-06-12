// backend/test/evaluationRoutes.test.mjs — P1 candidate-evaluation ROUTES +
// orchestrator integration. Mirrors the canaryIsolation / contestResults fake
// firestore + storage + handler import-with-?buster pattern.
//
// Covers (contract §F):
//   - 401/403 without admin header on BOTH routes
//   - 400 unknown contest on both routes
//   - evaluate over a MIXED-KEYING two-identity fixture (one enrolled person-keyed
//     identity with a person-keyed session+submission, one anonymous bare-norm
//     identity with session+submission, editor-events NDJSON + events JSONL served
//     by the fake storage) → writes 2 scorecard docs `<slug>::<key>` + done:true
//     + `__meta::<slug>`
//   - cursor batching (limit:1 → cursor returned, second call resumes + completes)
//   - idempotent re-run (skipped=2, evaluated=0); force:true recomputes
//   - GET returns {evaluations:2, meta non-null} and is contest-scoped
//   - scorecards carry talent/integrity/tiers/flags/coverage per schema
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

const handler = await import("../src/handler.mjs?evalroutes");
const { api, __setClientsForTest } = handler;
const { personIdOf, identityNorm } = await import("../src/identity.mjs");

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

// Fake Firestore — equality-filter aware (same shape as contestResults).
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

// Fake Storage backed by an in-memory object registry. getFiles({prefix})
// returns every object whose key starts with the prefix; each file.download()
// yields its stored NDJSON/JSONL contents. file.save() writes (unused here).
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
              matched.push({
                name: key,
                async download() { return [objects.get(key) || ""]; }
              });
            }
          }
          return [matched];
        }
      };
    }
  };
}

function freshClients(objects) {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage(objects);
  __setClientsForTest({ firestore, storage });
  return { firestore, storage };
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
async function uploadRoster(slug, rows) {
  const res = await call(makeReq({ method: "POST", path: "/api/admin/roster", headers: ADMIN_HEADERS, body: {
    contest: slug, unique_id_column: "unique_id",
    columns: ["college", "unique_id", "name"], column_mapping: { name: "name" }, rows,
    college_resolutions: { kec: { action: "create" } }
  } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
}

const STUB_PY = "def solve():\n    pass\n";

function seedProblem(firestore, id, title) {
  firestore.collection("ev_problems").doc(id).set({
    id, title, points: 100, status: "published", scoring: "per_test",
    languages: ["python"], stubs: { python: STUB_PY }
  });
}

// One editor-event NDJSON line per record.
function ndjson(records) {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

// A genuine, typed solve: a run of single-char inserts then a code_submit.
function typedEditorStream(sessionId, problemId, t0Ms) {
  const records = [];
  let t = t0Ms;
  const code = "def solve():\n    return 42\n";
  let line = 1, col = 1;
  for (const ch of code) {
    records.push({
      type: "editor_insert",
      timestamp: new Date(t).toISOString(),
      session_id: sessionId,
      problem_id: problemId,
      detail: { insertedLen: 1, deletedLen: 0, text: ch, startLine: line, startCol: col, endLine: line, endCol: col }
    });
    if (ch === "\n") { line += 1; col = 1; } else { col += 1; }
    t += 250; // human cadence
  }
  records.push({
    type: "code_submit", timestamp: new Date(t).toISOString(),
    session_id: sessionId, problem_id: problemId, detail: { language: "python" }
  });
  return records;
}

// Shell events JSONL: a benign focus stream (no away episodes).
function shellStream(t0Ms) {
  return [
    { type: "window_focus", timestamp: new Date(t0Ms).toISOString(), visibility_state: "visible", detail: {} }
  ];
}

// Seed the MIXED-KEYING fixture: one enrolled person-keyed identity + one
// anonymous bare-norm identity, each with a session, a submission, and GCS
// editor/shell evidence. Returns { contest, personKey, anonNorm, objects }.
async function seedMixedFixture() {
  const objects = new Map();
  const { firestore } = freshClients(objects);
  seedProblem(firestore, "p1", "Answer");
  const contest = await createContest("KEC Eval 2026", [{ problem_id: "p1" }]);
  await openContest(contest.slug);
  await uploadRoster(contest.slug, [{ college: "KEC", unique_id: "21CS001", name: "Asha" }]);
  const slug = contest.slug;

  const personKey = personIdOf("kec", identityNorm("21CS001")); // enrolled, person-keyed
  const anonNorm = "walkin-bob"; // anonymous bare-norm identity (no enrollment)

  const t0 = Date.parse("2026-06-10T04:00:00.000Z");

  // ---- person-keyed identity: session + accepted submission + evidence -------
  const personPrefix = `contests/${slug}/sessions/${personKey}/sp/`;
  firestore.collection("ev_sessions").doc("sp").set({
    session_id: "sp", contest_slug: slug, username_norm: personKey, person_id: personKey,
    candidate_id: "21CS001", name: "Asha", room: "Lab A", status: "ended",
    start_ip: "10.0.0.5", current_ip: "10.0.0.5", storage_prefix: personPrefix,
    fullscreen_exit_count: 0, ip_change_count: 0, created_at: "2026-06-10T03:59:00.000Z"
  });
  firestore.collection("ev_submissions").doc("sub-p1").set({
    _id: "sub-p1", session_id: "sp", contest_slug: slug, username_norm: personKey, person_id: personKey,
    candidate_id: "21CS001", problem_id: "p1", language: "python", verdict: "accepted",
    passed_count: 10, total: 10, score: 100, max_points: 100,
    source_code: "def solve():\n    return 42\n", created_at: "2026-06-10T04:00:30.000Z"
  });
  objects.set(`${personPrefix}editor-events/batch-0.ndjson`, ndjson(typedEditorStream("sp", "p1", t0)));
  objects.set(`${personPrefix}events/shell-0.jsonl`, ndjson(shellStream(t0)));

  // ---- anonymous bare-norm identity: session + submission + evidence ---------
  const anonPrefix = `contests/${slug}/sessions/${anonNorm}/sa/`;
  firestore.collection("ev_sessions").doc("sa").set({
    session_id: "sa", contest_slug: slug, username_norm: anonNorm, person_id: null,
    candidate_id: "walkin-bob", name: "Bob", room: "Lab A", status: "ended",
    start_ip: "10.0.0.6", current_ip: "10.0.0.6", storage_prefix: anonPrefix,
    fullscreen_exit_count: 0, ip_change_count: 0, created_at: "2026-06-10T03:59:30.000Z"
  });
  firestore.collection("ev_submissions").doc("sub-a1").set({
    _id: "sub-a1", session_id: "sa", contest_slug: slug, username_norm: anonNorm, person_id: null,
    candidate_id: "walkin-bob", problem_id: "p1", language: "python", verdict: "wrong_answer",
    passed_count: 3, total: 10, score: 30, max_points: 100,
    source_code: "def solve():\n    return 0\n", created_at: "2026-06-10T04:01:00.000Z"
  });
  objects.set(`${anonPrefix}editor-events/batch-0.ndjson`, ndjson(typedEditorStream("sa", "p1", t0 + 60000)));
  objects.set(`${anonPrefix}events/shell-0.jsonl`, ndjson(shellStream(t0 + 60000)));

  return { contest, slug, personKey, anonNorm, firestore, objects };
}

// ---- auth ------------------------------------------------------------------

test("evaluate route: 401/403 without admin header", async () => {
  freshClients();
  const noHeader = await call(makeReq({ method: "POST", path: "/api/admin/contest-evaluate", body: { contest: "x" } }));
  assert.ok([401, 403].includes(noHeader.statusCode), JSON.stringify(noHeader.body));
  const badPass = await call(makeReq({ method: "POST", path: "/api/admin/contest-evaluate", headers: { "x-admin-password": "wrong" }, body: { contest: "x" } }));
  assert.ok([401, 403].includes(badPass.statusCode), JSON.stringify(badPass.body));
});

test("evaluations GET route: 401/403 without admin header", async () => {
  freshClients();
  const noHeader = await call(makeReq({ method: "GET", path: "/api/admin/contest-evaluations", query: { contest: "x" } }));
  assert.ok([401, 403].includes(noHeader.statusCode), JSON.stringify(noHeader.body));
  const badPass = await call(makeReq({ method: "GET", path: "/api/admin/contest-evaluations", headers: { "x-admin-password": "wrong" }, query: { contest: "x" } }));
  assert.ok([401, 403].includes(badPass.statusCode), JSON.stringify(badPass.body));
});

// ---- 400 unknown contest ---------------------------------------------------

test("evaluate route: 400 on unknown contest", async () => {
  freshClients();
  const res = await call(makeReq({ method: "POST", path: "/api/admin/contest-evaluate", headers: ADMIN_HEADERS, body: { contest: "no-such-contest" } }));
  assert.equal(res.statusCode, 400, JSON.stringify(res.body));
});

test("evaluations GET route: 400 on unknown contest", async () => {
  freshClients();
  const res = await call(makeReq({ method: "GET", path: "/api/admin/contest-evaluations", headers: ADMIN_HEADERS, query: { contest: "no-such-contest" } }));
  assert.equal(res.statusCode, 400, JSON.stringify(res.body));
});

// ---- evaluate the mixed-keying fixture -------------------------------------

test("evaluate: mixed-keying fixture → 2 scorecard docs + meta + done", async () => {
  const { slug, personKey, anonNorm, firestore } = await seedMixedFixture();
  const res = await call(makeReq({ method: "POST", path: "/api/admin/contest-evaluate", headers: ADMIN_HEADERS, body: { contest: slug } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.done, true, JSON.stringify(res.body));
  assert.equal(res.body.evaluated, 2, JSON.stringify(res.body));
  assert.equal(res.body.meta_written, true);

  const evalCol = firestore._collections.get("ev_evaluations");
  assert.ok(evalCol.has(`${slug}::${personKey}`), `missing person scorecard; ids=${[...evalCol.keys()].join(",")}`);
  assert.ok(evalCol.has(`${slug}::${anonNorm}`), `missing anon scorecard; ids=${[...evalCol.keys()].join(",")}`);
  assert.ok(evalCol.has(`__meta::${slug}`), `missing meta doc; ids=${[...evalCol.keys()].join(",")}`);

  // The person-keyed scorecard carries the full schema.
  const sc = evalCol.get(`${slug}::${personKey}`);
  assert.equal(sc.schema_version, 1);
  assert.equal(sc.evaluator_version, "1");
  assert.equal(sc.contest_slug, slug);
  assert.equal(sc.identity_key, personKey);
  assert.equal(sc.person_id, personKey);
  assert.ok(sc.talent && typeof sc.talent.composite === "number");
  assert.ok(sc.integrity && typeof sc.integrity.paste_ratio === "number");
  assert.ok(sc.tiers && typeof sc.tiers.one_line === "string");
  assert.ok(Array.isArray(sc.flags));
  assert.ok(sc.coverage && typeof sc.coverage.confidence === "string");
  assert.equal(sc.recommended_action, null);
  // Editor events were ingested → coverage reflects it.
  assert.ok(sc.coverage.editor_events_n > 0, "person scorecard saw editor events");
  assert.deepEqual(sc.session_ids, ["sp"]);

  // The anonymous bare-norm scorecard is keyed by username_norm, person_id null.
  const an = evalCol.get(`${slug}::${anonNorm}`);
  assert.equal(an.identity_key, anonNorm);
  assert.equal(an.person_id, null);
  assert.equal(an.username_norm, anonNorm);
  assert.ok(an.coverage.editor_events_n > 0, "anon scorecard saw editor events");
});

// ---- cursor batching -------------------------------------------------------

test("evaluate: cursor batching (limit:1 → cursor → resume → done)", async () => {
  const { slug, firestore } = await seedMixedFixture();
  const first = await call(makeReq({ method: "POST", path: "/api/admin/contest-evaluate", headers: ADMIN_HEADERS, body: { contest: slug, limit: 1 } }));
  assert.equal(first.statusCode, 200, JSON.stringify(first.body));
  assert.equal(first.body.evaluated, 1, JSON.stringify(first.body));
  assert.equal(first.body.done, false, JSON.stringify(first.body));
  assert.ok(first.body.cursor, "first batch returns a cursor");
  assert.ok(!("meta_written" in first.body) || first.body.meta_written === undefined, "no meta on partial batch");

  const second = await call(makeReq({ method: "POST", path: "/api/admin/contest-evaluate", headers: ADMIN_HEADERS, body: { contest: slug, limit: 1, cursor: first.body.cursor } }));
  assert.equal(second.statusCode, 200, JSON.stringify(second.body));
  assert.equal(second.body.evaluated, 1, JSON.stringify(second.body));
  assert.equal(second.body.done, true, JSON.stringify(second.body));
  assert.equal(second.body.meta_written, true);

  const evalCol = firestore._collections.get("ev_evaluations");
  // 2 scorecards + 1 meta.
  const ids = [...evalCol.keys()];
  assert.equal(ids.filter((id) => !id.startsWith("__meta::")).length, 2, ids.join(","));
  assert.ok(ids.includes(`__meta::${slug}`));
});

// ---- idempotency + force ---------------------------------------------------

test("evaluate: idempotent re-run skips, force recomputes", async () => {
  const { slug } = await seedMixedFixture();
  const first = await call(makeReq({ method: "POST", path: "/api/admin/contest-evaluate", headers: ADMIN_HEADERS, body: { contest: slug } }));
  assert.equal(first.body.evaluated, 2);

  const rerun = await call(makeReq({ method: "POST", path: "/api/admin/contest-evaluate", headers: ADMIN_HEADERS, body: { contest: slug } }));
  assert.equal(rerun.statusCode, 200, JSON.stringify(rerun.body));
  assert.equal(rerun.body.evaluated, 0, JSON.stringify(rerun.body));
  assert.equal(rerun.body.skipped, 2, JSON.stringify(rerun.body));
  assert.equal(rerun.body.done, true);

  const forced = await call(makeReq({ method: "POST", path: "/api/admin/contest-evaluate", headers: ADMIN_HEADERS, body: { contest: slug, force: true } }));
  assert.equal(forced.statusCode, 200, JSON.stringify(forced.body));
  assert.equal(forced.body.evaluated, 2, JSON.stringify(forced.body));
  assert.equal(forced.body.skipped, 0, JSON.stringify(forced.body));
});

// ---- GET list --------------------------------------------------------------

test("evaluations GET: returns {evaluations:2, meta non-null}", async () => {
  const { slug } = await seedMixedFixture();
  await call(makeReq({ method: "POST", path: "/api/admin/contest-evaluate", headers: ADMIN_HEADERS, body: { contest: slug } }));
  const res = await call(makeReq({ method: "GET", path: "/api/admin/contest-evaluations", headers: ADMIN_HEADERS, query: { contest: slug } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.evaluations.length, 2, JSON.stringify(res.body.evaluations.map((e) => e.identity_key)));
  assert.ok(res.body.meta, "meta returned");
  assert.equal(res.body.meta.contest_slug, slug);
  // The meta doc must NOT appear in the evaluations array.
  assert.ok(res.body.evaluations.every((e) => e.identity_key), "no meta doc leaked into evaluations");
});

test("evaluations GET: identity filter narrows to one scorecard", async () => {
  const { slug, personKey } = await seedMixedFixture();
  await call(makeReq({ method: "POST", path: "/api/admin/contest-evaluate", headers: ADMIN_HEADERS, body: { contest: slug } }));
  const res = await call(makeReq({ method: "GET", path: "/api/admin/contest-evaluations", headers: ADMIN_HEADERS, query: { contest: slug, person_id: personKey } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.evaluations.length, 1);
  assert.equal(res.body.evaluations[0].identity_key, personKey);
});

// ---- contest scoping (no cross-contest bleed) ------------------------------

test("evaluations GET: a second contest's scorecard is invisible", async () => {
  const { slug, firestore } = await seedMixedFixture();
  await call(makeReq({ method: "POST", path: "/api/admin/contest-evaluate", headers: ADMIN_HEADERS, body: { contest: slug } }));

  // Stamp a scorecard for a DIFFERENT contest directly into the collection.
  const other = await createContest("Other Eval", [{ problem_id: "p1" }]);
  await openContest(other.slug);
  firestore.collection("ev_evaluations").doc(`${other.slug}::ghost`).set({
    schema_version: 1, evaluator_version: "1", contest_slug: other.slug,
    identity_key: "ghost", person_id: "ghost", username_norm: "ghost",
    talent: { composite: 0 }, integrity: { paste_ratio: 0 }, tiers: { one_line: "x" },
    flags: [], coverage: { confidence: "low" }, session_ids: [], recommended_action: null
  });

  const res = await call(makeReq({ method: "GET", path: "/api/admin/contest-evaluations", headers: ADMIN_HEADERS, query: { contest: slug } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.evaluations.length, 2, "other contest's scorecard must not bleed in");
  assert.ok(res.body.evaluations.every((e) => e.contest_slug === slug));
});
