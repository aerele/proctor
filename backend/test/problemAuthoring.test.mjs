// backend/test/problemAuthoring.test.mjs — S4: problem bank CRUD, active-problem
// assignment, public problem in start/resume, exec-from-bank + scoring.
import { test } from "node:test";
import assert from "node:assert/strict";

// Env MUST be set before importing the handler (it reads env at module load).
// A unique ?problems query gives a fresh module instance independent of the
// other test files (which configure different collections).
process.env.EVIDENCE_BUCKET = "problems-bucket";
process.env.SESSION_COLLECTION = "problems_sessions";
process.env.SETTINGS_COLLECTION = "problems_settings";
process.env.PROBLEMS_COLLECTION = "problems_bank";
process.env.SUBMISSIONS_COLLECTION = "problems_submissions";
process.env.ADMIN_PASSWORD = "problems-admin-pass";

const handler = await import("../src/handler.mjs?problems");
const { api, __setClientsForTest, __setJudge0AdapterForTest } = handler;

const ADMIN = { "x-admin-password": "problems-admin-pass" };

// ---- Inline req/res + fakes, copied from phase2.test.mjs (NO helpers.mjs) ----

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

function freshClients() {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  return { firestore, storage };
}

function validProblem(overrides = {}) {
  return {
    id: "rev-str", title: "Reverse", statement: "Reverse the input line.",
    languages: ["python", "cpp"], cpuTimeLimit: 2, memoryLimit: 64000,
    points: 80, scoring: "per_test", status: "published",
    sampleTests: [{ input: "ab\n", expected: "ba" }],
    hiddenTests: [
      { input: "abc\n", expected: "cba" },
      { input: "xy\n", expected: "yx" },
      { input: "z\n", expected: "z" },
      { input: "hello\n", expected: "olleh" }
    ],
    ...overrides
  };
}

// ---- Task 2: admin CRUD ------------------------------------------------------

test("problem CRUD endpoints are admin-gated (401 without the password)", async () => {
  freshClients();
  for (const req of [
    makeReq({ method: "GET", path: "/api/admin/problems" }),
    makeReq({ method: "GET", path: "/api/admin/problem", query: { id: "rev-str" } }),
    makeReq({ method: "POST", path: "/api/admin/problems", body: validProblem() }),
    makeReq({ method: "POST", path: "/api/admin/problem-delete", body: { id: "rev-str" } })
  ]) {
    const res = await call(req);
    assert.equal(res.statusCode, 401, `${req.method} ${req.path} must 401`);
  }
});

test("create -> get -> list roundtrip; list carries summaries WITHOUT test contents", async () => {
  freshClients();
  const created = await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem() }));
  assert.equal(created.statusCode, 200);
  assert.equal(created.body.ok, true);
  assert.equal(created.body.problem.id, "rev-str");
  assert.ok(created.body.problem.created_at);
  assert.ok(created.body.problem.updated_at);

  const got = await call(makeReq({ method: "GET", path: "/api/admin/problem", headers: ADMIN, query: { id: "rev-str" } }));
  assert.equal(got.statusCode, 200);
  assert.equal(got.body.problem.hiddenTests.length, 4); // admin sees hidden tests

  const list = await call(makeReq({ method: "GET", path: "/api/admin/problems", headers: ADMIN }));
  assert.equal(list.statusCode, 200);
  assert.equal(list.body.problems.length, 1);
  const row = list.body.problems[0];
  assert.equal(row.sample_count, 1);
  assert.equal(row.hidden_count, 4);
  assert.equal(row.status, "published");
  assert.equal(row.hiddenTests, undefined); // summaries only
  assert.equal(row.sampleTests, undefined);
});

test("tags ride the authoring roundtrip and the list summary (S-I §1.2)", async () => {
  const { firestore } = freshClients();
  const created = await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN,
    body: validProblem({ tags: ["Strings", "two-pointers"] }) }));
  assert.equal(created.statusCode, 200);
  assert.deepEqual(created.body.problem.tags, ["strings", "two-pointers"]);

  // a legacy doc stored before tags existed summarizes as [] (never undefined)
  firestore.collection("problems_bank").doc("old-one").set({
    id: "old-one", title: "Old", status: "draft", sampleTests: [], hiddenTests: []
  });

  const list = await call(makeReq({ method: "GET", path: "/api/admin/problems", headers: ADMIN }));
  const bySlug = Object.fromEntries(list.body.problems.map((p) => [p.id, p]));
  assert.deepEqual(bySlug["rev-str"].tags, ["strings", "two-pointers"]);
  assert.deepEqual(bySlug["old-one"].tags, []);
});

test("upsert preserves created_at and refreshes updated_at", async () => {
  const { firestore } = freshClients();
  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem() }));
  const first = firestore._collections.get("problems_bank").get("rev-str");
  // backdate so the refresh is observable
  firestore._collections.get("problems_bank").set("rev-str", { ...first, created_at: "2020-01-01T00:00:00.000Z", updated_at: "2020-01-01T00:00:00.000Z" });
  const updated = await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem({ title: "Reverse v2" }) }));
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.body.problem.created_at, "2020-01-01T00:00:00.000Z");
  assert.notEqual(updated.body.problem.updated_at, "2020-01-01T00:00:00.000Z");
  assert.equal(updated.body.problem.title, "Reverse v2");
});

test("save validation: bad id and empty hiddenTests -> 400 with the specific error", async () => {
  freshClients();
  const badId = await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem({ id: "Bad_ID" }) }));
  assert.equal(badId.statusCode, 400);
  const noHidden = await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem({ hiddenTests: [] }) }));
  assert.equal(noHidden.statusCode, 400);
  // intentional 4xx httpErrors are serialized as {error: message, detail: message}
  assert.match(noHidden.body.error, /hiddenTests/);
});

test("GET unknown problem -> 404; invalid id -> 400", async () => {
  freshClients();
  assert.equal((await call(makeReq({ method: "GET", path: "/api/admin/problem", headers: ADMIN, query: { id: "ghost" } }))).statusCode, 404);
  assert.equal((await call(makeReq({ method: "GET", path: "/api/admin/problem", headers: ADMIN, query: { id: "a/b" } }))).statusCode, 400);
});

test("delete removes the doc and clears a matching active problem_id from settings", async () => {
  const { firestore } = freshClients();
  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem() }));
  firestore.collection("problems_settings").doc("active").set({
    start_at: "2026-01-01T00:00:00.000Z", end_at: "2027-01-01T00:00:00.000Z", problem_id: "rev-str"
  });
  const res = await call(makeReq({ method: "POST", path: "/api/admin/problem-delete", headers: ADMIN, body: { id: "rev-str" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(firestore._collections.get("problems_bank").has("rev-str"), false);
  assert.equal(firestore._collections.get("problems_settings").get("active").problem_id, "");
});

// ---- S-I §1.4.3: live-reference guard ----------------------------------------
// Deleting/unpublishing a referenced problem 409s with the referencing slugs;
// silent assignment-clearing survives ONLY for the legacy settings doc. Hidden-
// test edits on a problem referenced by an OPEN contest demand a typed confirm.

function seedContest(firestore, slug, status, problems) {
  firestore.collection("proctor_contests").doc(slug).set({ slug, status, problems });
}
function seedTemplateDoc(firestore, slug, problems, archived = false) {
  firestore.collection("proctor_templates").doc(slug).set({ slug, name: slug, archived, problems });
}

test("guard: delete of a contest/template-referenced problem -> 409 problem_referenced with slugs; doc survives", async () => {
  const { firestore } = freshClients();
  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem() }));
  seedContest(firestore, "kec-r1", "open", [{ problem_id: "rev-str", points: null, order: 0 }]);
  seedTemplateDoc(firestore, "apt-tpl", [{ problem_id: "rev-str", points: null, order: 0 }]);

  const res = await call(makeReq({ method: "POST", path: "/api/admin/problem-delete", headers: ADMIN, body: { id: "rev-str" } }));
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, "problem_referenced");
  assert.deepEqual(res.body.contests, ["kec-r1"]);
  assert.deepEqual(res.body.templates, ["apt-tpl"]);
  assert.equal(firestore._collections.get("problems_bank").has("rev-str"), true); // nothing deleted
});

test("guard: archived contests/templates do NOT block deletion; the legacy settings clear still happens", async () => {
  const { firestore } = freshClients();
  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem() }));
  seedContest(firestore, "old-contest", "archived", [{ problem_id: "rev-str" }]);
  seedTemplateDoc(firestore, "old-tpl", [{ problem_id: "rev-str" }], true);
  firestore.collection("problems_settings").doc("active").set({
    start_at: "2026-01-01T00:00:00.000Z", end_at: "2027-01-01T00:00:00.000Z", problem_id: "rev-str"
  });

  const res = await call(makeReq({ method: "POST", path: "/api/admin/problem-delete", headers: ADMIN, body: { id: "rev-str" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(firestore._collections.get("problems_bank").has("rev-str"), false);
  // The LEGACY contest path keeps its silent clearing branch (spec §1.4.3).
  assert.equal(firestore._collections.get("problems_settings").get("active").problem_id, "");
});

test("guard: unpublish while contest-referenced -> 409; while ONLY template-referenced -> allowed", async () => {
  const { firestore } = freshClients();
  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem() })); // published
  seedContest(firestore, "kec-r1", "draft", [{ problem_id: "rev-str" }]);

  const blocked = await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN,
    body: validProblem({ status: "draft" }) }));
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.body.error, "problem_referenced");
  assert.deepEqual(blocked.body.contests, ["kec-r1"]);
  // Still published — the save was rejected wholesale.
  assert.equal(firestore._collections.get("problems_bank").get("rev-str").status, "published");

  // Drop the contest ref; a template ref alone does not block an unpublish
  // (instantiation re-validates published).
  firestore.collection("proctor_contests").doc("kec-r1").delete();
  seedTemplateDoc(firestore, "apt-tpl", [{ problem_id: "rev-str" }]);
  const allowed = await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN,
    body: validProblem({ status: "draft" }) }));
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.body.problem.status, "draft");
});

test("guard: hiddenTests edit on a problem referenced by an OPEN contest needs the typed confirm", async () => {
  const { firestore } = freshClients();
  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem() }));
  seedContest(firestore, "kec-live", "open", [{ problem_id: "rev-str" }]);

  const newHidden = [{ input: "abc\n", expected: "cba" }, { input: "zz\n", expected: "zz" }];
  // Changed hidden tests, no confirmation -> 409 with the open-contest list.
  const blocked = await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN,
    body: validProblem({ hiddenTests: newHidden }) }));
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.body.error, "live_edit_confirmation_required");
  assert.deepEqual(blocked.body.contests, ["kec-live"]);

  // Wrong confirmation string -> still 409.
  const wrong = await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN,
    body: validProblem({ hiddenTests: newHidden, confirm_live_edit: "nope" }) }));
  assert.equal(wrong.statusCode, 409);

  // confirm_live_edit === the problem id -> the edit lands.
  const confirmed = await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN,
    body: validProblem({ hiddenTests: newHidden, confirm_live_edit: "rev-str" }) }));
  assert.equal(confirmed.statusCode, 200);
  assert.equal(confirmed.body.problem.hiddenTests.length, 2);

  // A title-only edit (hidden tests unchanged) never demands the confirm.
  const titleOnly = await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN,
    body: validProblem({ hiddenTests: newHidden, title: "Reverse v3" }) }));
  assert.equal(titleOnly.statusCode, 200);

  // Hidden-test edits while referenced only by a DRAFT contest sail through.
  seedContest(firestore, "kec-live", "draft", [{ problem_id: "rev-str" }]);
  const draftRef = await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN,
    body: validProblem({ hiddenTests: [{ input: "q\n", expected: "q" }] }) }));
  assert.equal(draftRef.statusCode, 200);
});

test("guard: adminGetProblem reports its references (contests + templates)", async () => {
  const { firestore } = freshClients();
  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem() }));
  seedContest(firestore, "kec-r1", "open", [{ problem_id: "rev-str" }]);
  seedTemplateDoc(firestore, "apt-tpl", [{ problem_id: "rev-str" }]);

  const res = await call(makeReq({ method: "GET", path: "/api/admin/problem", headers: ADMIN, query: { id: "rev-str" } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.references, { contests: ["kec-r1"], templates: ["apt-tpl"] });
});

// ---- Task 3: settings problem_id + public problem in start/resume -----------

const GATE = { start_at: "2026-01-01T00:00:00.000Z", end_at: "2027-01-01T00:00:00.000Z" };

test("settings save validates problem_id: unknown/draft -> 400; published bank doc or built-in seed -> saved + echoed", async () => {
  freshClients();
  const unknown = await call(makeReq({ method: "POST", path: "/api/admin/settings", headers: ADMIN,
    body: { ...GATE, problem_id: "ghost" } }));
  assert.equal(unknown.statusCode, 400);

  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem({ id: "draft-one", status: "draft" }) }));
  const draft = await call(makeReq({ method: "POST", path: "/api/admin/settings", headers: ADMIN,
    body: { ...GATE, problem_id: "draft-one" } }));
  assert.equal(draft.statusCode, 400);

  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem() }));
  const published = await call(makeReq({ method: "POST", path: "/api/admin/settings", headers: ADMIN,
    body: { ...GATE, problem_id: "rev-str" } }));
  assert.equal(published.statusCode, 200);
  assert.equal(published.body.problem_id, "rev-str");

  // built-in seed counts as assignable even with no Firestore doc
  const seed = await call(makeReq({ method: "POST", path: "/api/admin/settings", headers: ADMIN,
    body: { ...GATE, problem_id: "sum-two" } }));
  assert.equal(seed.statusCode, 200);

  const echoed = await call(makeReq({ method: "GET", path: "/api/admin/settings", headers: ADMIN }));
  assert.equal(echoed.body.problem_id, "sum-two");
});

test("resume payload carries the PUBLIC problem view — never hiddenTests; null when unassigned", async () => {
  const { firestore } = freshClients();
  firestore.collection("problems_sessions").doc("s1").set({
    session_id: "s1", status: "active", username_norm: "alice", contest_slug: "", storage_prefix: "sessions/alice/s1/"
  });
  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem() }));
  firestore.collection("problems_settings").doc("active").set({ ...GATE, problem_id: "rev-str" });

  const res = await call(makeReq({ method: "POST", path: "/api/session/resume", body: { session_id: "s1" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.problem.id, "rev-str");
  assert.equal(res.body.problem.title, "Reverse");
  assert.equal(res.body.problem.points, 80);
  assert.equal(res.body.problem.cpuTimeLimit, 2);
  assert.deepEqual(res.body.problem.sampleTests, [{ input: "ab\n", expected: "ba" }]);
  assert.equal(res.body.problem.hiddenTests, undefined); // the §9 lock extends to the bank
  assert.equal(res.body.problem.status, undefined);      // lifecycle is admin-only

  // unassigned -> problem: null (legacy link-flow fallback)
  firestore.collection("problems_settings").doc("active").set({ ...GATE });
  const bare = await call(makeReq({ method: "POST", path: "/api/session/resume", body: { session_id: "s1" } }));
  assert.equal(bare.body.problem, null);
});

// ---- S-I §3.4: multi-problem start/resume payload -------------------------------

test("resume for a REAL-contest session serves the contest's ordered problems[] + summary + budget (S-I §3.4)", async () => {
  const { firestore } = freshClients();
  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem() })); // rev-str, 80 pts
  firestore.collection("proctor_contests").doc("kec-r1").set({
    slug: "kec-r1", status: "open",
    problems: [
      { problem_id: "sum-two", points: 40, order: 1 },
      { problem_id: "rev-str", points: null, order: 0 }
    ]
  });
  firestore.collection("problems_sessions").doc("ms1").set({
    session_id: "ms1", status: "active", username_norm: "alice",
    contest_slug: "kec-r1", storage_prefix: "contests/kec-r1/sessions/alice/ms1/"
  });
  firestore.collection("problems_settings").doc("active").set({ ...GATE });

  const res = await call(makeReq({ method: "POST", path: "/api/session/resume", body: { session_id: "ms1" } }));
  assert.equal(res.statusCode, 200);
  // Ordered problems[] with EFFECTIVE points + order; never hiddenTests/status.
  assert.equal(res.body.problems.length, 2);
  assert.deepEqual(res.body.problems.map((p) => p.id), ["rev-str", "sum-two"]);
  assert.deepEqual(res.body.problems.map((p) => p.order), [0, 1]);
  assert.equal(res.body.problems[0].points, 80);  // bank points (null override)
  assert.equal(res.body.problems[1].points, 40);  // entry override beats the seed's 100
  assert.equal(res.body.problems[0].hiddenTests, undefined);
  assert.equal(res.body.problems[0].status, undefined);
  // One-release compatibility alias: problems[0] WITHOUT the order key.
  assert.equal(res.body.problem.id, "rev-str");
  assert.equal(res.body.problem.order, undefined);
  // Budget + empty summary for a fresh session.
  assert.equal(res.body.submit_budget, 50);
  assert.deepEqual(res.body.submissions_summary, {});
});

test("resume restores submissions_summary from stored submissions (chips/totals survive a reload)", async () => {
  const { firestore } = freshClients();
  firestore.collection("proctor_contests").doc("kec-r1").set({
    slug: "kec-r1", status: "open", problems: [{ problem_id: "sum-two", points: null, order: 0 }]
  });
  firestore.collection("problems_sessions").doc("ms2").set({
    session_id: "ms2", status: "active", username_norm: "alice", contest_slug: "kec-r1",
    storage_prefix: "contests/kec-r1/sessions/alice/ms2/"
  });
  firestore.collection("problems_settings").doc("active").set({ ...GATE });
  // Two stored submissions for THIS session; one for another session (ignored).
  firestore.collection("problems_submissions").doc("a").set({
    session_id: "ms2", problem_id: "sum-two", score: 40, max_points: 100,
    verdict: "wrong_answer", created_at: "2026-06-10T04:10:00.000Z"
  });
  firestore.collection("problems_submissions").doc("b").set({
    session_id: "ms2", problem_id: "sum-two", score: 100, max_points: 100,
    verdict: "accepted", created_at: "2026-06-10T04:20:00.000Z"
  });
  firestore.collection("problems_submissions").doc("c").set({
    session_id: "other", problem_id: "sum-two", score: 10, max_points: 100,
    verdict: "wrong_answer", created_at: "2026-06-10T04:30:00.000Z"
  });

  const res = await call(makeReq({ method: "POST", path: "/api/session/resume", body: { session_id: "ms2" } }));
  assert.equal(res.statusCode, 200);
  const cell = res.body.submissions_summary["sum-two"];
  assert.equal(cell.best_score, 100);
  assert.equal(cell.attempts, 2);
  assert.equal(cell.best_verdict, "accepted");
  assert.equal(cell.last_submitted_at, "2026-06-10T04:20:00.000Z");
});

test("legacy canary: a settings-assigned session keeps the EXACT problem shape; problems[] mirrors it with order 0", async () => {
  const { firestore } = freshClients();
  firestore.collection("problems_sessions").doc("s1").set({
    session_id: "s1", status: "active", username_norm: "alice", contest_slug: "", storage_prefix: "sessions/alice/s1/"
  });
  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem() }));
  firestore.collection("problems_settings").doc("active").set({ ...GATE, problem_id: "rev-str" });

  const res = await call(makeReq({ method: "POST", path: "/api/session/resume", body: { session_id: "s1" } }));
  // The alias is BYTE-IDENTICAL to the pre-S-I public problem view.
  assert.deepEqual(Object.keys(res.body.problem).sort(),
    ["cpuTimeLimit", "id", "languages", "memoryLimit", "points", "sampleTests", "statement", "title"]);
  assert.equal(res.body.problem.points, 80);
  // problems[] carries the same problem once, with order 0 added.
  assert.equal(res.body.problems.length, 1);
  assert.equal(res.body.problems[0].id, "rev-str");
  assert.equal(res.body.problems[0].order, 0);
  assert.equal(res.body.submit_budget, 50);
});

test("contest languages intersect per-problem languages at serve time (S-I §1.1 defaults)", async () => {
  const { firestore } = freshClients();
  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN,
    body: validProblem({ languages: ["python", "cpp"] }) }));
  firestore.collection("proctor_contests").doc("lang-c").set({
    slug: "lang-c", status: "open", languages: ["python", "java"],
    problems: [{ problem_id: "rev-str", points: null, order: 0 }]
  });
  firestore.collection("problems_sessions").doc("ls1").set({
    session_id: "ls1", status: "active", username_norm: "alice", contest_slug: "lang-c",
    storage_prefix: "contests/lang-c/sessions/alice/ls1/"
  });
  firestore.collection("problems_settings").doc("active").set({ ...GATE });

  const res = await call(makeReq({ method: "POST", path: "/api/session/resume", body: { session_id: "ls1" } }));
  assert.deepEqual(res.body.problems[0].languages, ["python"]);
});

test("a problem UNPUBLISHED after assignment degrades to problem: null (no dead payloads)", async () => {
  const { firestore } = freshClients();
  firestore.collection("problems_sessions").doc("s1").set({
    session_id: "s1", status: "active", username_norm: "alice", contest_slug: "", storage_prefix: "sessions/alice/s1/"
  });
  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem() }));
  firestore.collection("problems_settings").doc("active").set({ ...GATE, problem_id: "rev-str" });
  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem({ status: "draft" }) }));
  const res = await call(makeReq({ method: "POST", path: "/api/session/resume", body: { session_id: "s1" } }));
  assert.equal(res.body.problem, null);
});

// ---- Task 4: exec-from-bank + scoring ----------------------------------------

// Deterministic clock for the per-session exec rate limiter (the exec.test.mjs
// precedent): every exec test reuses session "s1", so step past the cooldowns
// between calls rather than weakening the limiter.
const { __setExecClockForTest } = handler;
let execNowMs = 0;
__setExecClockForTest(() => execNowMs);
const advanceExecClock = (ms) => { execNowMs += ms; };

function seedExecFixture() {
  advanceExecClock(3600_000); // past any cooldown an earlier test started for "s1"
  const clients = freshClients();
  clients.firestore.collection("problems_sessions").doc("s1").set({
    session_id: "s1", status: "active", username_norm: "alice", storage_prefix: "sessions/alice/s1/"
  });
  return clients;
}

test("exec/run resolves the problem from the BANK: adapter sees the doc's sample tests + limits", async () => {
  seedExecFixture();
  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem() }));
  const seen = [];
  __setJudge0AdapterForTest({
    runBatch: async (items) => {
      seen.push(...items);
      return items.map(() => ({ status: "accepted", passed: true, stdout: "ba", stderr: "", compileOutput: "", timeSec: 0.01, memoryKb: 100 }));
    }
  });
  const res = await call(makeReq({ method: "POST", path: "/api/exec/run",
    body: { session_id: "s1", problem_id: "rev-str", language: "python", source_code: "print(input()[::-1])" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.results.length, 1);          // rev-str has ONE sample
  assert.equal(res.body.results[0].input, "ab\n");   // the BANK's sample, not the seed's
  assert.equal(seen.length, 1);
  assert.equal(seen[0].stdin, "ab\n");
  assert.equal(seen[0].cpuTimeLimit, 2);             // the BANK's limit
  assert.equal(seen[0].memoryLimit, 64000);
  __setJudge0AdapterForTest(null);
});

test("exec/run on a DRAFT problem -> 400 unknown problem_id (drafts are not executable)", async () => {
  seedExecFixture();
  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem({ status: "draft" }) }));
  __setJudge0AdapterForTest({ runBatch: async () => { throw new Error("must not run a draft"); } });
  const res = await call(makeReq({ method: "POST", path: "/api/exec/run",
    body: { session_id: "s1", problem_id: "rev-str", language: "python", source_code: "x" } }));
  assert.equal(res.statusCode, 400);
  __setJudge0AdapterForTest(null);
});

test("exec/run seed fallback: sum-two still works with an empty bank", async () => {
  seedExecFixture();
  __setJudge0AdapterForTest({
    runBatch: async (items) => items.map(() => ({ status: "accepted", passed: true, stdout: "5", stderr: "", compileOutput: "", timeSec: 0.01, memoryKb: 100 }))
  });
  const res = await call(makeReq({ method: "POST", path: "/api/exec/run",
    body: { session_id: "s1", problem_id: "sum-two", language: "python", source_code: "print(sum(map(int,input().split())))" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.results.length, 2); // the seed's two samples
  __setJudge0AdapterForTest(null);
});

test("exec/submit scores per_test: 3/4 hidden passed on an 80-point problem -> score 60, stored + returned", async () => {
  const { firestore } = seedExecFixture();
  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem() })); // 80 pts, per_test, 4 hidden
  __setJudge0AdapterForTest({
    runBatch: async (items) => items.map((_, i) => ({ status: i === 2 ? "wrong_answer" : "accepted", passed: i !== 2, stdout: "", stderr: "", compileOutput: "", timeSec: 0, memoryKb: 1 }))
  });
  const res = await call(makeReq({ method: "POST", path: "/api/exec/submit",
    body: { session_id: "s1", problem_id: "rev-str", language: "python", source_code: "x" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.verdict, "wrong_answer");
  assert.equal(res.body.passed_count, 3);
  assert.equal(res.body.score, 60);
  assert.equal(res.body.max_points, 80);
  const stored = [...firestore._collections.get("problems_submissions").values()][0];
  assert.equal(stored.score, 60);
  assert.equal(stored.max_points, 80);
  assert.equal(stored.scoring, "per_test");
  __setJudge0AdapterForTest(null);
});

test("exec/submit scores all_or_nothing: full sweep pays, partial pays zero", async () => {
  seedExecFixture();
  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem({ scoring: "all_or_nothing" }) }));
  __setJudge0AdapterForTest({
    runBatch: async (items) => items.map(() => ({ status: "accepted", passed: true, stdout: "", stderr: "", compileOutput: "", timeSec: 0, memoryKb: 1 }))
  });
  const sweep = await call(makeReq({ method: "POST", path: "/api/exec/submit",
    body: { session_id: "s1", problem_id: "rev-str", language: "python", source_code: "x" } }));
  assert.equal(sweep.body.score, 80);

  advanceExecClock(21_000); // past the 20 s submit cooldown for "s1"
  __setJudge0AdapterForTest({
    runBatch: async (items) => items.map((_, i) => ({ status: i === 0 ? "wrong_answer" : "accepted", passed: i !== 0, stdout: "", stderr: "", compileOutput: "", timeSec: 0, memoryKb: 1 }))
  });
  const partial = await call(makeReq({ method: "POST", path: "/api/exec/submit",
    body: { session_id: "s1", problem_id: "rev-str", language: "python", source_code: "x" } }));
  assert.equal(partial.body.score, 0);
  __setJudge0AdapterForTest(null);
});
