// backend/test/templates.test.mjs — S-I §1.1/§2: proctor_templates.
// Spec: docs/superpowers/specs/2026-06-10-s-i-multiproblem-detail-spec.md
// Pure module tests (validateTemplateInput / normalizeProblemEntries / seed)
// + admin CRUD endpoint tests (list merge/shadow, create slug rules, update
// no-re-slug, archive, clone deep-copy). The system-check preset is the
// always-available day-before lab-check template (vision S6/J1.5).
import { test } from "node:test";
import assert from "node:assert/strict";

// Env BEFORE import; unique ?templates cache-buster for a fresh handler instance.
process.env.EVIDENCE_BUCKET = "tp-bucket";
process.env.SESSION_COLLECTION = "tp_sessions";
process.env.SETTINGS_COLLECTION = "tp_settings";
process.env.CONTESTS_COLLECTION = "tp_contests";
process.env.TEMPLATES_COLLECTION = "tp_templates";
process.env.PROBLEMS_COLLECTION = "tp_problems";
process.env.ADMIN_PASSWORD = "tp-admin-pass";

const handler = await import("../src/handler.mjs?templates");
const { api, __setClientsForTest } = handler;
// handler.mjs?templates resolves ./templates.mjs WITHOUT a buster, so this is
// the exact module instance the handler configured (fakes propagate).
const {
  TEMPLATE_BOUNDS,
  SEED_TEMPLATES,
  normalizeProblemEntries,
  validateTemplateInput
} = await import("../src/templates.mjs");

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

const ADMIN = { "x-admin-password": "tp-admin-pass" };

const listReq = (q = {}, h = ADMIN) => makeReq({ method: "GET", path: "/api/admin/templates", headers: h, query: q });
const getReq = (q, h = ADMIN) => makeReq({ method: "GET", path: "/api/admin/template", headers: h, query: q });
const createReq = (body, h = ADMIN) => makeReq({ method: "POST", path: "/api/admin/templates", headers: h, body });
const updateReq = (body, h = ADMIN) => makeReq({ method: "POST", path: "/api/admin/template-update", headers: h, body });
const archiveReq = (body, h = ADMIN) => makeReq({ method: "POST", path: "/api/admin/template-archive", headers: h, body });
const cloneReq = (body, h = ADMIN) => makeReq({ method: "POST", path: "/api/admin/template-clone", headers: h, body });
const deleteReq = (body, h = ADMIN) => makeReq({ method: "POST", path: "/api/admin/template-delete", headers: h, body });

function validTemplate(overrides = {}) {
  return {
    name: "Aptitude R1",
    description: "First round.",
    problems: [{ problem_id: "sum-two", points: null, order: 0 }],
    defaults: { duration_minutes: 90 },
    ...overrides
  };
}

// ---- pure: normalizeProblemEntries -------------------------------------------

test("normalizeProblemEntries: dedupes ids, sorts by order, renumbers 0..n-1", () => {
  const r = normalizeProblemEntries([
    { problem_id: "b", points: 50, order: 7 },
    { problem_id: "a", order: 2 },
    { problem_id: "b", points: 10, order: 0 } // dup: first occurrence wins
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.entries, [
    { problem_id: "a", points: null, order: 0 },
    { problem_id: "b", points: 50, order: 1 }
  ]);
});

test("normalizeProblemEntries: bounds — 1..20 entries, valid ids, points 0..1000 or null", () => {
  assert.equal(normalizeProblemEntries([]).ok, false);
  assert.equal(normalizeProblemEntries("nope").ok, false);
  const tooMany = Array.from({ length: 21 }, (_, i) => ({ problem_id: `p-${i}` }));
  assert.equal(normalizeProblemEntries(tooMany).ok, false);
  assert.equal(normalizeProblemEntries([{ problem_id: "Bad_ID" }]).ok, false);
  assert.equal(normalizeProblemEntries([{ problem_id: "ok", points: 1001 }]).ok, false);
  assert.equal(normalizeProblemEntries([{ problem_id: "ok", points: 7.5 }]).ok, false);
  const zero = normalizeProblemEntries([{ problem_id: "ok", points: 0 }]);
  assert.equal(zero.ok, true);
  assert.equal(zero.entries[0].points, 0);
});

// ---- pure: validateTemplateInput ----------------------------------------------

test("validateTemplateInput: valid payload -> normalized allow-listed template", () => {
  const r = validateTemplateInput({ ...validTemplate(), evil: "dropped" });
  assert.equal(r.ok, true);
  assert.equal(r.template.name, "Aptitude R1");
  assert.equal(r.template.description, "First round.");
  assert.equal(r.template.evil, undefined); // never spread client input
  assert.deepEqual(r.template.problems, [{ problem_id: "sum-two", points: null, order: 0 }]);
  assert.equal(r.template.defaults.duration_minutes, 90);
});

test("validateTemplateInput: defaults normalized — every field present with spec defaults", () => {
  const r = validateTemplateInput(validTemplate({ defaults: undefined }));
  assert.equal(r.ok, true);
  const d = r.template.defaults;
  assert.equal(d.duration_minutes, 120);
  assert.equal(d.identity_label, "Roll Number");
  assert.equal(d.room_gate_enabled, true);
  assert.deepEqual(d.camera_recording, { enabled: true, fps: 10, width: 640 });
  assert.deepEqual(d.enforcement, { mode: "block", fullscreen_reentry_seconds: 20, fullscreen_exit_limit: 2 });
  assert.equal(d.evidence_retention_days, 4);
  assert.deepEqual(d.languages, ["python", "cpp", "java", "javascript", "sql"]);
});

test("validateTemplateInput: defaults bounds — garbage falls back, retention clamps, languages validated", () => {
  const r = validateTemplateInput(validTemplate({ defaults: {
    duration_minutes: "soon",            // garbage -> default 120
    identity_label: "  Hall Ticket  ",   // trimmed
    room_gate_enabled: "yes",            // non-boolean -> default true
    camera_recording: { enabled: false, fps: 99, width: 320 }, // fps out of range -> default 10
    enforcement: { mode: "alert_first", fullscreen_reentry_seconds: 0, fullscreen_exit_limit: 5 },
    evidence_retention_days: 99,         // clamps to 30
    languages: ["python", "python", "cpp"]
  } }));
  assert.equal(r.ok, true);
  const d = r.template.defaults;
  assert.equal(d.duration_minutes, 120);
  assert.equal(d.identity_label, "Hall Ticket");
  assert.equal(d.room_gate_enabled, true);
  assert.deepEqual(d.camera_recording, { enabled: false, fps: 10, width: 320 });
  assert.deepEqual(d.enforcement, { mode: "alert_first", fullscreen_reentry_seconds: 20, fullscreen_exit_limit: 5 });
  assert.equal(d.evidence_retention_days, 30);
  assert.deepEqual(d.languages, ["python", "cpp"]);

  assert.equal(validateTemplateInput(validTemplate({ defaults: { languages: ["rust"] } })).ok, false);
  assert.equal(validateTemplateInput(validTemplate({ defaults: { languages: [] } })).ok, false);
});

test("validateTemplateInput: rejections — name required/bounded, description bounded, problems required", () => {
  assert.equal(validateTemplateInput(validTemplate({ name: "  " })).ok, false);
  assert.equal(validateTemplateInput(validTemplate({ name: "x".repeat(TEMPLATE_BOUNDS.NAME_MAX + 1) })).ok, false);
  assert.equal(validateTemplateInput(validTemplate({ description: "x".repeat(TEMPLATE_BOUNDS.DESCRIPTION_MAX + 1) })).ok, false);
  assert.equal(validateTemplateInput(validTemplate({ problems: [] })).ok, false);
  assert.equal(validateTemplateInput(validTemplate({ problems: undefined })).ok, false);
});

// ---- pure: seed preset ----------------------------------------------------------

test("SEED_TEMPLATES: the system-check preset matches the spec shape (vision S6/J1.5)", () => {
  const seed = SEED_TEMPLATES["system-check"];
  assert.equal(seed.slug, "system-check");
  assert.equal(seed.name, "System check");
  assert.equal(seed.archived, false);
  assert.deepEqual(seed.problems, [{ problem_id: "sum-two", points: null, order: 0 }]);
  assert.equal(seed.defaults.duration_minutes, 30);
  assert.equal(seed.defaults.room_gate_enabled, false);
  assert.equal(seed.defaults.evidence_retention_days, 1);
  assert.equal(seed.defaults.identity_label, "Roll Number");
  assert.deepEqual(seed.defaults.camera_recording, { enabled: true, fps: 10, width: 320 });
  assert.deepEqual(seed.defaults.languages, ["python", "cpp", "java", "javascript", "sql"]);
});

// ---- endpoints: auth -------------------------------------------------------------

test("templates: every admin endpoint rejects without the admin password", async () => {
  __setClientsForTest({ firestore: makeFakeFirestore() });
  assert.equal((await call(listReq({}, {}))).statusCode, 401);
  assert.equal((await call(getReq({ slug: "system-check" }, {}))).statusCode, 401);
  assert.equal((await call(createReq(validTemplate(), {}))).statusCode, 401);
  assert.equal((await call(updateReq({ slug: "x" }, {}))).statusCode, 401);
  assert.equal((await call(archiveReq({ slug: "x", archived: true }, {}))).statusCode, 401);
  assert.equal((await call(cloneReq({ slug: "x" }, {}))).statusCode, 401);
  assert.equal((await call(deleteReq({ slug: "x" }, {}))).statusCode, 401);
});

// ---- endpoints: create / get / list -----------------------------------------------

const BANK_PROBLEM = {
  id: "rev-str", title: "Reverse", statement: "Reverse it.",
  languages: ["python"], cpuTimeLimit: 2, memoryLimit: 64000,
  points: 80, scoring: "per_test", status: "draft",
  sampleTests: [{ input: "ab\n", expected: "ba" }],
  hiddenTests: [{ input: "xy\n", expected: "yx" }]
};

test("create -> get -> list: slug derived from name; seeds merge into the list; totals computed", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore });
  // a DRAFT bank doc — templates may reference drafts (spec §1.1).
  await firestore.collection("tp_problems").doc("rev-str").set(BANK_PROBLEM);

  const created = await call(createReq(validTemplate({
    name: "Aptitude — Round 1",
    problems: [
      { problem_id: "rev-str", points: null, order: 0 },  // bank points 80
      { problem_id: "sum-two", points: 40, order: 1 }     // override 40
    ]
  })));
  assert.equal(created.statusCode, 200);
  const tpl = created.body.template;
  assert.equal(tpl.slug, "aptitude-round-1");
  assert.equal(tpl.archived, false);
  assert.ok(tpl.created_at);
  assert.equal(tpl.created_at, tpl.updated_at);

  const got = await call(getReq({ slug: "aptitude-round-1" }));
  assert.equal(got.statusCode, 200);
  assert.equal(got.body.template.name, "Aptitude — Round 1");
  assert.equal(got.body.template.problems.length, 2);

  const list = await call(listReq());
  assert.equal(list.statusCode, 200);
  const bySlug = Object.fromEntries(list.body.templates.map((t) => [t.slug, t]));
  // The created template: 80 (bank) + 40 (override) = 120.
  assert.equal(bySlug["aptitude-round-1"].problem_count, 2);
  assert.equal(bySlug["aptitude-round-1"].total_points, 120);
  assert.equal(bySlug["aptitude-round-1"].preset, false);
  // The system-check seed is merged in, marked preset, totals from the seed bank.
  assert.equal(bySlug["system-check"].preset, true);
  assert.equal(bySlug["system-check"].problem_count, 1);
  assert.equal(bySlug["system-check"].total_points, 100);
  // Full template docs never ride the list (summaries only).
  assert.equal(bySlug["aptitude-round-1"].problems, undefined);
  assert.equal(bySlug["aptitude-round-1"].defaults, undefined);
});

test("create: slug collisions get -2 suffix; seed slugs are never claimed", async () => {
  __setClientsForTest({ firestore: makeFakeFirestore() });
  assert.equal((await call(createReq(validTemplate({ name: "Round 1" })))).body.template.slug, "round-1");
  assert.equal((await call(createReq(validTemplate({ name: "round 1" })))).body.template.slug, "round-1-2");
  // "System check" slugifies to the seed's slug — create must NOT shadow the
  // preset by accident; it walks to the suffix instead.
  assert.equal((await call(createReq(validTemplate({ name: "System check" })))).body.template.slug, "system-check-2");
});

test("create: problems must reference EXISTING bank problems (draft OK, ghost -> 400)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore });
  await firestore.collection("tp_problems").doc("rev-str").set(BANK_PROBLEM); // draft
  const ok = await call(createReq(validTemplate({ problems: [{ problem_id: "rev-str" }] })));
  assert.equal(ok.statusCode, 200, "a draft bank problem is referenceable from a template");

  const ghost = await call(createReq(validTemplate({ name: "Ghostly", problems: [{ problem_id: "ghost" }] })));
  assert.equal(ghost.statusCode, 400);
  assert.equal(ghost.body.error, "unknown_problems");
  assert.deepEqual(ghost.body.problems, ["ghost"]);
});

test("get: unknown slug -> 404; the seed answers without any doc", async () => {
  __setClientsForTest({ firestore: makeFakeFirestore() });
  assert.equal((await call(getReq({ slug: "ghost" }))).statusCode, 404);
  const seed = await call(getReq({ slug: "system-check" }));
  assert.equal(seed.statusCode, 200);
  assert.equal(seed.body.template.preset, true);
  assert.equal(seed.body.template.defaults.duration_minutes, 30);
});

// ---- endpoints: update ---------------------------------------------------------------

test("update: rename does NOT re-slug; fields patch; created_at preserved, updated_at bumps", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore });
  await call(createReq(validTemplate({ name: "Round 1" })));
  // Backdate so the refresh is observable.
  const store = firestore._collections.get("tp_templates");
  store.set("round-1", { ...store.get("round-1"), created_at: "2020-01-01T00:00:00.000Z", updated_at: "2020-01-01T00:00:00.000Z" });

  const res = await call(updateReq({
    slug: "round-1", name: "Round 1 (KEC)", defaults: { duration_minutes: 45 }
  }));
  assert.equal(res.statusCode, 200);
  const tpl = res.body.template;
  assert.equal(tpl.slug, "round-1"); // rename keeps the slug
  assert.equal(tpl.name, "Round 1 (KEC)");
  assert.equal(tpl.defaults.duration_minutes, 45);
  assert.deepEqual(tpl.problems, [{ problem_id: "sum-two", points: null, order: 0 }]); // untouched
  assert.equal(tpl.created_at, "2020-01-01T00:00:00.000Z");
  assert.notEqual(tpl.updated_at, "2020-01-01T00:00:00.000Z");

  assert.equal((await call(updateReq({ slug: "ghost", name: "X" }))).statusCode, 404);
});

test("update: editing a seed slug materializes a shadow doc; the list shows it ONCE, no longer preset", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore });
  const res = await call(updateReq({ slug: "system-check", name: "System check (ours)" }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.template.name, "System check (ours)");
  assert.ok(firestore._collections.get("tp_templates").has("system-check")); // shadow doc written

  const list = await call(listReq());
  const rows = list.body.templates.filter((t) => t.slug === "system-check");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].preset, false);
  assert.equal(rows[0].name, "System check (ours)");
});

// ---- endpoints: archive ----------------------------------------------------------------

test("archive: toggles the flag; archived templates stay listed with the flag", async () => {
  __setClientsForTest({ firestore: makeFakeFirestore() });
  await call(createReq(validTemplate({ name: "Old One" })));
  const res = await call(archiveReq({ slug: "old-one", archived: true }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.template.archived, true);

  const list = await call(listReq());
  const row = list.body.templates.find((t) => t.slug === "old-one");
  assert.equal(row.archived, true);

  const back = await call(archiveReq({ slug: "old-one", archived: false }));
  assert.equal(back.body.template.archived, false);
  assert.equal((await call(archiveReq({ slug: "old-one", archived: "yes" }))).statusCode, 400);
  assert.equal((await call(archiveReq({ slug: "ghost", archived: true }))).statusCode, 404);
});

// ---- endpoints: clone -------------------------------------------------------------------

test("clone: deep copy under a new slug; defaults name 'Copy of …'; fresh timestamps; archived reset", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore });
  await call(createReq(validTemplate({ name: "Master", description: "keep me" })));
  await call(archiveReq({ slug: "master", archived: true })); // clone must reset this

  const res = await call(cloneReq({ slug: "master" }));
  assert.equal(res.statusCode, 200);
  const clone = res.body.template;
  assert.equal(clone.name, "Copy of Master");
  assert.equal(clone.slug, "copy-of-master");
  assert.equal(clone.archived, false);
  assert.equal(clone.description, "keep me");
  assert.deepEqual(clone.problems, [{ problem_id: "sum-two", points: null, order: 0 }]);

  // DEEP copy: mutating the clone's problems must not touch the original.
  const store = firestore._collections.get("tp_templates");
  store.get("copy-of-master").problems[0].points = 999;
  assert.equal(store.get("master").problems[0].points, null);

  // Custom name + collision handling.
  const named = await call(cloneReq({ slug: "master", name: "Master" }));
  assert.equal(named.body.template.slug, "master-2");
  assert.equal((await call(cloneReq({ slug: "ghost" }))).statusCode, 404);

  // Cloning the seed preset works without any doc.
  const seedClone = await call(cloneReq({ slug: "system-check" }));
  assert.equal(seedClone.statusCode, 200);
  assert.equal(seedClone.body.template.slug, "copy-of-system-check");
  assert.equal(seedClone.body.template.defaults.duration_minutes, 30);
});

// ---- endpoints: delete (hard remove of an author-owned template) ------------------------

test("delete: removes the doc; it drops off the list; the seed preset cannot be deleted", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore });
  await call(createReq(validTemplate({ name: "Disposable" })));
  assert.ok(firestore._collections.get("tp_templates").has("disposable"));

  const res = await call(deleteReq({ slug: "disposable" }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(firestore._collections.get("tp_templates").has("disposable"), false);

  const list = await call(listReq());
  assert.equal(list.body.templates.some((t) => t.slug === "disposable"), false);

  // Unknown slug -> 404.
  assert.equal((await call(deleteReq({ slug: "ghost" }))).statusCode, 404);

  // The system-check seed has no doc to delete and must never disappear from the
  // list — deleting it is a 400 (clone-then-delete is the customize path).
  const seed = await call(deleteReq({ slug: "system-check" }));
  assert.equal(seed.statusCode, 400);
  assert.equal(seed.body.error, "template_preset_undeletable");
  assert.ok((await call(listReq())).body.templates.some((t) => t.slug === "system-check"));
});
