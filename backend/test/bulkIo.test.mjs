// backend/test/bulkIo.test.mjs — BANK-1 (F11): bulk export/import of problems +
// templates. Covers the pure core (src/bulkIo.mjs: hashing, the A/B/C/D resolver,
// bundle parse) AND the three endpoints end-to-end through the handler with the
// fake Firestore (export, import-preview, import-commit) — incl. the spec's
// skip-identical (B), fork-to-`-2` divergent (D), update-in-place (C), and the
// template self-contained embed + dangling-ref-blocked cases.
//
// Spec: docs/proposed/bulk-problem-template-io.md
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  canonicalProblemHash, canonicalTemplateHash, isValidPortableId, mintPortableId,
  nextForkSlug, resolveProblem, validateBundleEnvelope, BUNDLE_KIND, BUNDLE_VERSION,
  MAX_BUNDLE_PROBLEMS
} from "../src/bulkIo.mjs";

// Env MUST be set before importing the handler (it reads env at module load). A
// unique ?buster gives a fresh module instance independent of the other files.
process.env.EVIDENCE_BUCKET = "bankio-bucket";
process.env.SESSION_COLLECTION = "bankio_sessions";
process.env.SETTINGS_COLLECTION = "bankio_settings";
process.env.PROBLEMS_COLLECTION = "bankio_problems";
process.env.TEMPLATES_COLLECTION = "bankio_templates";
process.env.CONTESTS_COLLECTION = "bankio_contests";
process.env.SUBMISSIONS_COLLECTION = "bankio_submissions";
process.env.ADMIN_PASSWORD = "bankio-admin-pass";
process.env.INSTANCE_LABEL = "test-instance-A";

const handler = await import("../src/handler.mjs?bankio");
const { api, __setClientsForTest } = handler;

const ADMIN = { "x-admin-password": "bankio-admin-pass" };

// ---- inline req/res + fake Firestore (copied from problemAuthoring.test.mjs) --

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
      where(field, op, value) { return makeQuery(name, [...filters, { field, op, value }]); },
      limit() { return this; },
      async get() {
        const store = getCollection(name);
        let docs = [...store.values()];
        for (const { field, op, value } of filters) {
          if (op === "in") docs = docs.filter((doc) => Array.isArray(value) && value.includes(doc[field]));
          else docs = docs.filter((doc) => doc[field] === value);
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
        where: query.where, limit: query.limit, get: query.get,
        doc(id) {
          return {
            id,
            async create(value) {
              if (store.has(id)) { const err = new Error("ALREADY_EXISTS"); err.code = 6; throw err; }
              store.set(id, { ...value });
            },
            async set(value, options) {
              const existing = options?.merge ? store.get(id) || {} : {};
              store.set(id, { ...existing, ...value });
            },
            async delete() { store.delete(id); },
            async get() { const data = store.get(id); return { exists: Boolean(data), data: () => data }; }
          };
        }
      };
    }
  };
}
function makeFakeStorage() {
  const saved = new Map();
  return {
    _saved: saved,
    bucket() {
      return {
        file(key) {
          return {
            async save(body) { saved.set(key, body); },
            async getSignedUrl() { return [`https://signed.example/${key}`]; },
            async getMetadata() { return [{ size: 1, updated: "2026-06-05T00:00:00Z" }]; }
          };
        },
        async getFiles() { return [[]]; }
      };
    }
  };
}
function freshClients() {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  return { firestore };
}

function validProblem(overrides = {}) {
  return {
    id: "rev-str", title: "Reverse", statement: "Reverse the input line.",
    languages: ["python", "cpp"], cpuTimeLimit: 2, memoryLimit: 64000,
    points: 80, scoring: "per_test", status: "published",
    sampleTests: [{ input: "ab\n", expected: "ba" }],
    hiddenTests: [{ input: "abc\n", expected: "cba" }, { input: "xy\n", expected: "yx" }],
    ...overrides
  };
}

// ============================================================================
//  PURE CORE — src/bulkIo.mjs
// ============================================================================

test("canonicalProblemHash: key-order independent, statement_format plain==absent, sorts languages", () => {
  const a = validProblem();
  const b = { ...validProblem(), statement_format: "plain" }; // explicit plain
  assert.equal(canonicalProblemHash(a), canonicalProblemHash(b));

  // language order does not change the hash (canonical sorts)
  const c = { ...validProblem(), languages: ["cpp", "python"] };
  assert.equal(canonicalProblemHash(a), canonicalProblemHash(c));

  // markdown != plain
  const d = { ...validProblem(), statement_format: "markdown" };
  assert.notEqual(canonicalProblemHash(a), canonicalProblemHash(d));

  // a content change (title) changes the hash
  const e = { ...validProblem(), title: "Reverse v2" };
  assert.notEqual(canonicalProblemHash(a), canonicalProblemHash(e));

  // a slug change is a content change (per §1.1)
  const f = { ...validProblem(), id: "rev-str-renamed" };
  assert.notEqual(canonicalProblemHash(a), canonicalProblemHash(f));

  // portable_id / origin / timestamps are NOT hashed
  const g = { ...validProblem(), portable_id: mintPortableId(), origin: { instance: "x", at: "y" },
    created_at: "2020", updated_at: "2021" };
  assert.equal(canonicalProblemHash(a), canonicalProblemHash(g));
});

test("canonicalTemplateHash: hashed over portable refs, key-order independent", () => {
  const pid = mintPortableId();
  const base = { name: "Set", description: "d", defaults: { duration_minutes: 30 },
    entries: [{ problem_portable_id: pid, points: null, order: 0 }] };
  const reordered = { name: "Set", defaults: { duration_minutes: 30 }, description: "d",
    entries: [{ order: 0, points: null, problem_portable_id: pid }] };
  assert.equal(canonicalTemplateHash(base), canonicalTemplateHash(reordered));
  const renamed = { ...base, name: "Set 2" };
  assert.notEqual(canonicalTemplateHash(base), canonicalTemplateHash(renamed));
});

test("isValidPortableId / mintPortableId: minted ids are valid uuid v4", () => {
  for (let i = 0; i < 20; i++) assert.equal(isValidPortableId(mintPortableId()), true);
  assert.equal(isValidPortableId("not-a-uuid"), false);
  assert.equal(isValidPortableId(""), false);
  assert.equal(isValidPortableId(undefined), false);
});

test("nextForkSlug: skips taken slugs, starts at -2", () => {
  assert.equal(nextForkSlug("two-sum", new Set()), "two-sum-2");
  assert.equal(nextForkSlug("two-sum", new Set(["two-sum-2"])), "two-sum-3");
  assert.equal(nextForkSlug("two-sum", new Set(["two-sum-2", "two-sum-3"])), "two-sum-4");
});

test("resolveProblem A/B/C/D: new, identical, update, divergent", () => {
  const pid = mintPortableId();
  const local = { ...validProblem(), portable_id: pid };
  const localHash = canonicalProblemHash(local);
  const byPortableId = new Map([[pid, local]]);
  const bySlug = new Map([[local.id, local]]);

  // A — new (different portable id, different slug)
  const newPid = mintPortableId();
  const a = resolveProblem({
    incoming: { ...validProblem(), id: "fresh-one", portable_id: newPid },
    byPortableId, bySlug, takenSlugs: new Set(bySlug.keys())
  });
  assert.equal(a.action, "create");
  assert.equal(a.target_slug, "fresh-one");

  // B — identical (same portable id, same content, content_hash == local)
  const b = resolveProblem({
    incoming: { ...validProblem(), portable_id: pid, content_hash: localHash, parent_hash: localHash },
    byPortableId, bySlug, takenSlugs: new Set(bySlug.keys())
  });
  assert.equal(b.action, "skip");
  assert.equal(b.reason, "identical");

  // C — incoming differs, local == parent_hash (local untouched since export)
  const c = resolveProblem({
    incoming: { ...validProblem(), title: "Reverse v2", portable_id: pid, parent_hash: localHash },
    byPortableId, bySlug, takenSlugs: new Set(bySlug.keys())
  });
  assert.equal(c.action, "update");
  assert.equal(c.target_slug, local.id);

  // D — incoming differs AND local != parent_hash (both sides changed) -> fork
  const d = resolveProblem({
    incoming: { ...validProblem(), title: "Reverse v2", portable_id: pid, parent_hash: "some-other-hash" },
    byPortableId, bySlug, takenSlugs: new Set(bySlug.keys())
  });
  assert.equal(d.action, "fork");
  assert.equal(d.target_slug, "rev-str-2");
  assert.equal(d.reason, "divergent");
});

test("resolveProblem: legacy un-keyed slug collision defaults to fork (keep both); adopt override updates", () => {
  const legacy = { ...validProblem() }; // NO portable_id
  const bySlug = new Map([[legacy.id, legacy]]);
  const incoming = { ...validProblem(), title: "Reverse remote", portable_id: mintPortableId() };

  const keepBoth = resolveProblem({ incoming, byPortableId: new Map(), bySlug, takenSlugs: new Set(bySlug.keys()) });
  assert.equal(keepBoth.action, "fork");
  assert.equal(keepBoth.target_slug, "rev-str-2");
  assert.equal(keepBoth.reason, "legacy_collision");

  const adopt = resolveProblem({ incoming, byPortableId: new Map(), bySlug,
    takenSlugs: new Set(bySlug.keys()), override: "adopt" });
  assert.equal(adopt.action, "adopt");
  assert.equal(adopt.target_slug, "rev-str");
});

test("validateBundleEnvelope: magic, version, caps", () => {
  assert.equal(validateBundleEnvelope(null).ok, false);
  assert.equal(validateBundleEnvelope({ kind: "wrong" }).code, "unsupported_bundle");
  assert.equal(validateBundleEnvelope({ kind: BUNDLE_KIND, bundle_version: 99 }).code, "unsupported_bundle_version");
  const tooMany = { kind: BUNDLE_KIND, bundle_version: BUNDLE_VERSION,
    problems: new Array(MAX_BUNDLE_PROBLEMS + 1).fill({}), templates: [] };
  assert.equal(validateBundleEnvelope(tooMany).code, "bundle_too_many_problems");
  const ok = validateBundleEnvelope({ kind: BUNDLE_KIND, bundle_version: BUNDLE_VERSION });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.bundle.problems, []);
});

// ============================================================================
//  ENDPOINTS — export / import-preview / import-commit
// ============================================================================

test("endpoints are admin-gated (401 without the password)", async () => {
  freshClients();
  for (const req of [
    makeReq({ method: "POST", path: "/api/admin/bank-export", body: { problem_ids: ["rev-str"] } }),
    makeReq({ method: "POST", path: "/api/admin/bank-import-preview", body: { bundle: {} } }),
    makeReq({ method: "POST", path: "/api/admin/bank-import-commit", body: { bundle: {} } })
  ]) {
    assert.equal((await call(req)).statusCode, 401, `${req.path} must 401`);
  }
});

test("authoring mints a stable portable_id; a second save keeps it", async () => {
  const { firestore } = freshClients();
  const created = await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem() }));
  assert.equal(created.statusCode, 200);
  const pid = created.body.problem.portable_id;
  assert.equal(isValidPortableId(pid), true);
  assert.equal(created.body.problem.origin.instance, "test-instance-A");

  const resaved = await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem({ title: "Reverse v2" }) }));
  assert.equal(resaved.body.problem.portable_id, pid); // unchanged across edits
  assert.equal(firestore._collections.get("bankio_problems").get("rev-str").portable_id, pid);
});

test("export: single problem -> self-describing bundle; mints+writes back a portable_id on a legacy doc", async () => {
  const { firestore } = freshClients();
  // a legacy doc with NO portable_id (pre-feature authoring)
  firestore.collection("bankio_problems").doc("legacy-one").set({
    id: "legacy-one", title: "Legacy", statement: "s", languages: ["python"],
    cpuTimeLimit: 2, memoryLimit: 64000, points: 50, scoring: "per_test", status: "published",
    sampleTests: [{ input: "a\n", expected: "a" }], hiddenTests: [{ input: "b\n", expected: "b" }]
  });
  const res = await call(makeReq({ method: "POST", path: "/api/admin/bank-export", headers: ADMIN,
    body: { problem_ids: ["legacy-one"], template_slugs: [] } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.kind, BUNDLE_KIND);
  assert.equal(res.body.bundle_version, BUNDLE_VERSION);
  assert.equal(res.body.exported_from, "test-instance-A");
  assert.deepEqual(res.body.counts, { problems: 1, templates: 0 });
  assert.equal(res.body.problems.length, 1);
  const item = res.body.problems[0];
  assert.equal(isValidPortableId(item.portable_id), true);
  assert.ok(item.content_hash);
  assert.equal(item.parent_hash, item.content_hash); // first-ever export
  assert.equal(item.hiddenTests.length, 1);
  // write-back: the source doc now carries the SAME portable id
  assert.equal(firestore._collections.get("bankio_problems").get("legacy-one").portable_id, item.portable_id);
});

test("export: a template embeds ALL its referenced problems (self-contained), refs translated to portable ids", async () => {
  const { firestore } = freshClients();
  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem() }));
  const tpl = await call(makeReq({ method: "POST", path: "/api/admin/templates", headers: ADMIN,
    body: { name: "Weekly", description: "", problems: [{ problem_id: "rev-str", points: null, order: 0 }] } }));
  assert.equal(tpl.statusCode, 200);

  const res = await call(makeReq({ method: "POST", path: "/api/admin/bank-export", headers: ADMIN,
    body: { problem_ids: [], template_slugs: [tpl.body.template.slug] } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.counts.problems, 1); // the referenced problem pulled in
  assert.equal(res.body.counts.templates, 1);
  const tplItem = res.body.templates[0];
  assert.equal(tplItem.problems.length, 1);
  assert.equal(isValidPortableId(tplItem.problems[0].problem_portable_id), true);
  assert.equal(tplItem.problems[0].problem_id_hint, "rev-str");
  // the embedded problem's portable id matches the template ref's portable id
  assert.equal(tplItem.problems[0].problem_portable_id, res.body.problems[0].portable_id);
});

test("export: a problem selected directly AND via a template is embedded ONCE (dedupe by portable id)", async () => {
  freshClients();
  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem() }));
  const tpl = await call(makeReq({ method: "POST", path: "/api/admin/templates", headers: ADMIN,
    body: { name: "Weekly", description: "", problems: [{ problem_id: "rev-str", points: null, order: 0 }] } }));
  const res = await call(makeReq({ method: "POST", path: "/api/admin/bank-export", headers: ADMIN,
    body: { problem_ids: ["rev-str"], template_slugs: [tpl.body.template.slug] } }));
  assert.equal(res.body.problems.length, 1); // not 2
});

// ---- the round-trip cases (B / D / C) on a SECOND instance -------------------
// We simulate "import into instance B" by exporting from this instance, wiping
// the bank, and importing the bundle back into a fresh (or modified) bank.

async function exportBundle(problemIds = [], templateSlugs = []) {
  const res = await call(makeReq({ method: "POST", path: "/api/admin/bank-export", headers: ADMIN,
    body: { problem_ids: problemIds, template_slugs: templateSlugs } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body;
}

test("import preview+commit: brand-new problem -> create; re-import is a no-op skip (B identical)", async () => {
  const { firestore } = freshClients();
  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem() }));
  const bundle = await exportBundle(["rev-str"]);

  // wipe the bank -> importing the bundle is a CREATE
  firestore._collections.get("bankio_problems").clear();

  const preview = await call(makeReq({ method: "POST", path: "/api/admin/bank-import-preview", headers: ADMIN, body: { bundle } }));
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.body.problems[0].action, "create");
  assert.equal(preview.body.summary.created, 1);
  assert.ok(preview.body.preview_token);

  const commit = await call(makeReq({ method: "POST", path: "/api/admin/bank-import-commit", headers: ADMIN,
    body: { bundle, preview_token: preview.body.preview_token } }));
  assert.equal(commit.statusCode, 200);
  assert.equal(commit.body.applied.created, 1);
  const stored = firestore._collections.get("bankio_problems").get("rev-str");
  assert.equal(stored.portable_id, bundle.problems[0].portable_id); // identity preserved
  assert.equal(stored.title, "Reverse");

  // re-import the SAME bundle -> identical -> skip (dedup, true no-op)
  const preview2 = await call(makeReq({ method: "POST", path: "/api/admin/bank-import-preview", headers: ADMIN, body: { bundle } }));
  assert.equal(preview2.body.problems[0].action, "skip");
  assert.equal(preview2.body.problems[0].reason, "identical");
  assert.equal(preview2.body.summary.unchanged, 1);
  const commit2 = await call(makeReq({ method: "POST", path: "/api/admin/bank-import-commit", headers: ADMIN,
    body: { bundle, preview_token: preview2.body.preview_token } }));
  assert.equal(commit2.body.applied.skipped, 1);
});

test("import: self-import on the SAME unchanged bank is all-skip (safety property §6.8)", async () => {
  freshClients();
  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem() }));
  const bundle = await exportBundle(["rev-str"]);
  const preview = await call(makeReq({ method: "POST", path: "/api/admin/bank-import-preview", headers: ADMIN, body: { bundle } }));
  assert.equal(preview.body.problems[0].action, "skip");
  assert.equal(preview.body.summary.unchanged, 1);
});

test("import D (divergent fork-to-`-2`): both sides edited since export -> fork to rev-str-2 with a FRESH portable id", async () => {
  const { firestore } = freshClients();
  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem() }));
  const bundle = await exportBundle(["rev-str"]);
  const originalPid = bundle.problems[0].portable_id;

  // EDIT the bundle item (simulates the remote instance B's edit) ...
  bundle.problems[0].title = "Reverse on B";
  delete bundle.problems[0].content_hash; // recomputed at import from content
  // ... AND edit the LOCAL doc (so local != parent_hash -> divergent)
  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem({ title: "Reverse on A" }) }));

  const preview = await call(makeReq({ method: "POST", path: "/api/admin/bank-import-preview", headers: ADMIN, body: { bundle } }));
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.body.problems[0].action, "fork");
  assert.equal(preview.body.problems[0].target_slug, "rev-str-2");
  assert.equal(preview.body.summary.forked, 1);

  const commit = await call(makeReq({ method: "POST", path: "/api/admin/bank-import-commit", headers: ADMIN,
    body: { bundle, preview_token: preview.body.preview_token } }));
  assert.equal(commit.body.applied.forked, 1);
  const orig = firestore._collections.get("bankio_problems").get("rev-str");
  const fork = firestore._collections.get("bankio_problems").get("rev-str-2");
  assert.equal(orig.title, "Reverse on A");        // A's edit preserved (no overwrite)
  assert.equal(fork.title, "Reverse on B");         // the import landed as a fork
  assert.notEqual(fork.portable_id, originalPid);   // fresh lineage
  assert.equal(fork.forked_from, originalPid);      // annotated
});

test("import C (update in place): local untouched since export -> the bundle's edit advances it", async () => {
  const { firestore } = freshClients();
  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem() }));
  const bundle = await exportBundle(["rev-str"]);

  // Only the REMOTE (bundle) side edited; local stays exactly as exported. The
  // bundle's parent_hash == the local content hash -> C (update in place).
  bundle.problems[0].title = "Reverse improved";
  delete bundle.problems[0].content_hash;

  const preview = await call(makeReq({ method: "POST", path: "/api/admin/bank-import-preview", headers: ADMIN, body: { bundle } }));
  assert.equal(preview.body.problems[0].action, "update");
  assert.equal(preview.body.summary.updated, 1);

  const commit = await call(makeReq({ method: "POST", path: "/api/admin/bank-import-commit", headers: ADMIN,
    body: { bundle, preview_token: preview.body.preview_token } }));
  assert.equal(commit.body.applied.updated, 1);
  const stored = firestore._collections.get("bankio_problems").get("rev-str");
  assert.equal(stored.title, "Reverse improved");
  assert.equal(stored.portable_id, bundle.problems[0].portable_id); // same identity
  assert.equal(firestore._collections.get("bankio_problems").has("rev-str-2"), false); // no fork
});

test("import: overrides force fork even on an identical item; preview_token mismatch -> 409", async () => {
  const { firestore } = freshClients();
  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem() }));
  const bundle = await exportBundle(["rev-str"]);
  const pid = bundle.problems[0].portable_id;

  const preview = await call(makeReq({ method: "POST", path: "/api/admin/bank-import-preview", headers: ADMIN, body: { bundle } }));
  // a tampered bundle after preview -> commit refuses
  const tampered = JSON.parse(JSON.stringify(bundle));
  tampered.problems[0].title = "changed";
  const stale = await call(makeReq({ method: "POST", path: "/api/admin/bank-import-commit", headers: ADMIN,
    body: { bundle: tampered, preview_token: preview.body.preview_token } }));
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.body.error, "bundle_changed");

  // override fork on the (otherwise identical) item lands a -2 copy
  const commit = await call(makeReq({ method: "POST", path: "/api/admin/bank-import-commit", headers: ADMIN,
    body: { bundle, overrides: { [pid]: "fork" } } }));
  assert.equal(commit.body.applied.forked, 1);
  assert.equal(firestore._collections.get("bankio_problems").has("rev-str-2"), true);
});

test("template import: round-trip onto a wiped bank creates problem + template; refs resolve to local slug", async () => {
  const { firestore } = freshClients();
  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem() }));
  const tpl = await call(makeReq({ method: "POST", path: "/api/admin/templates", headers: ADMIN,
    body: { name: "Weekly", description: "", problems: [{ problem_id: "rev-str", points: null, order: 0 }] } }));
  const bundle = await exportBundle([], [tpl.body.template.slug]);

  // wipe BOTH collections -> import recreates the problem then the template
  firestore._collections.get("bankio_problems").clear();
  firestore._collections.get("bankio_templates").clear();

  const preview = await call(makeReq({ method: "POST", path: "/api/admin/bank-import-preview", headers: ADMIN, body: { bundle } }));
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.body.problems[0].action, "create");
  assert.equal(preview.body.templates[0].action, "create");

  const commit = await call(makeReq({ method: "POST", path: "/api/admin/bank-import-commit", headers: ADMIN,
    body: { bundle, preview_token: preview.body.preview_token } }));
  assert.equal(commit.statusCode, 200);
  assert.equal(commit.body.applied.created, 2); // problem + template
  const tplDoc = [...firestore._collections.get("bankio_templates").values()][0];
  assert.equal(tplDoc.problems[0].problem_id, "rev-str"); // ref resolved to local slug
  assert.ok(isValidPortableId(tplDoc.portable_id));
});

test("template import: a forked problem -> the template ref points at the fork (-2), never dangling (§6.1)", async () => {
  const { firestore } = freshClients();
  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem() }));
  const tpl = await call(makeReq({ method: "POST", path: "/api/admin/templates", headers: ADMIN,
    body: { name: "Weekly", description: "", problems: [{ problem_id: "rev-str", points: null, order: 0 }] } }));
  const bundle = await exportBundle([], [tpl.body.template.slug]);

  // Force the referenced PROBLEM to diverge (edit bundle problem + local) so it
  // forks to rev-str-2; the template's entry must follow to rev-str-2.
  bundle.problems[0].title = "Reverse on B";
  delete bundle.problems[0].content_hash;
  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem({ title: "Reverse on A" }) }));
  // wipe templates so the template is a fresh create (its own portable id is new locally)
  firestore._collections.get("bankio_templates").clear();

  const preview = await call(makeReq({ method: "POST", path: "/api/admin/bank-import-preview", headers: ADMIN, body: { bundle } }));
  assert.equal(preview.body.problems[0].action, "fork");
  assert.equal(preview.body.problems[0].target_slug, "rev-str-2");
  assert.equal(preview.body.templates[0].action, "create");
  // the template plan's entries already point at the forked slug
  assert.deepEqual(preview.body.templates[0].entries.map((e) => e.problem_id), ["rev-str-2"]);

  const commit = await call(makeReq({ method: "POST", path: "/api/admin/bank-import-commit", headers: ADMIN,
    body: { bundle, preview_token: preview.body.preview_token } }));
  assert.equal(commit.statusCode, 200);
  const tplDoc = [...firestore._collections.get("bankio_templates").values()][0];
  assert.equal(tplDoc.problems[0].problem_id, "rev-str-2"); // ref followed the fork
});

test("template import: a dangling problem ref (not in bundle, not local) is BLOCKED in preview (§3.4.2)", async () => {
  freshClients();
  // Hand-craft a bundle whose template references a portable id with no problem.
  const ghostPid = mintPortableId();
  const tplPid = mintPortableId();
  const bundle = {
    kind: BUNDLE_KIND, bundle_version: BUNDLE_VERSION, exported_at: "2026-06-23T00:00:00.000Z",
    exported_from: "test-instance-A", counts: { problems: 0, templates: 1 },
    problems: [],
    templates: [{
      portable_id: tplPid, slug: "broken", name: "Broken", description: "",
      defaults: { duration_minutes: 30 },
      problems: [{ problem_portable_id: ghostPid, problem_id_hint: "ghost-problem", points: null, order: 0 }]
    }]
  };
  const preview = await call(makeReq({ method: "POST", path: "/api/admin/bank-import-preview", headers: ADMIN, body: { bundle } }));
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.body.templates[0].action, "blocked");
  assert.equal(preview.body.templates[0].reason, "dangling_problem_refs");
  assert.equal(preview.body.templates[0].dangling[0].hint, "ghost-problem");
  assert.equal(preview.body.summary.blocked, 1);
});

test("import: a bad envelope (wrong kind / version / oversized) -> 400 at preview", async () => {
  freshClients();
  const badKind = await call(makeReq({ method: "POST", path: "/api/admin/bank-import-preview", headers: ADMIN,
    body: { bundle: { kind: "something-else", bundle_version: 1 } } }));
  assert.equal(badKind.statusCode, 400);
  assert.equal(badKind.body.error, "unsupported_bundle");

  const badVersion = await call(makeReq({ method: "POST", path: "/api/admin/bank-import-preview", headers: ADMIN,
    body: { bundle: { kind: BUNDLE_KIND, bundle_version: 99 } } }));
  assert.equal(badVersion.statusCode, 400);
  assert.equal(badVersion.body.error, "unsupported_bundle_version");
});

test("export: empty selection -> 400; missing directly-selected problem -> 404", async () => {
  freshClients();
  const empty = await call(makeReq({ method: "POST", path: "/api/admin/bank-export", headers: ADMIN,
    body: { problem_ids: [], template_slugs: [] } }));
  assert.equal(empty.statusCode, 400);

  const missing = await call(makeReq({ method: "POST", path: "/api/admin/bank-export", headers: ADMIN,
    body: { problem_ids: ["does-not-exist"], template_slugs: [] } }));
  assert.equal(missing.statusCode, 404);
});

test("import-commit: idempotent re-run lands nothing new (already-applied items hash-match -> skip)", async () => {
  const { firestore } = freshClients();
  await call(makeReq({ method: "POST", path: "/api/admin/problems", headers: ADMIN, body: validProblem() }));
  const bundle = await exportBundle(["rev-str"]);
  firestore._collections.get("bankio_problems").clear();

  const first = await call(makeReq({ method: "POST", path: "/api/admin/bank-import-commit", headers: ADMIN, body: { bundle } }));
  assert.equal(first.body.applied.created, 1);
  const second = await call(makeReq({ method: "POST", path: "/api/admin/bank-import-commit", headers: ADMIN, body: { bundle } }));
  assert.equal(second.body.applied.created, 0);
  assert.equal(second.body.applied.skipped, 1);
  assert.equal(firestore._collections.get("bankio_problems").has("rev-str-2"), false); // no spurious fork
});
