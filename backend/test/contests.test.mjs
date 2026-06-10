// backend/test/contests.test.mjs — S-B: contests collection, SHIPS DARK.
// Specs: docs/superpowers/specs/2026-06-10-f10-product-vision.md §2.7/§7 row 2/§10.3
//        docs/superpowers/specs/2026-06-10-f9-identity-data-lifecycle-design.md §2/§6
// Covers: proctor_contests CRUD (create/list/update/status via admin endpoints),
// slugify + collision -2 suffix, access-code mint + collision retry, server-side
// validation, legacy-contest synthesis (read-only, legacy:true), resolveContest
// and the scopedQuery chokepoint. No production candidate path reads any of it.
import { test } from "node:test";
import assert from "node:assert/strict";

// Env BEFORE import; unique ?contests cache-buster for a fresh handler instance.
process.env.EVIDENCE_BUCKET = "ct-bucket";
process.env.SESSION_COLLECTION = "ct_sessions";
process.env.SETTINGS_COLLECTION = "ct_settings";
process.env.CONTESTS_COLLECTION = "ct_contests";
process.env.ADMIN_PASSWORD = "ct-admin-pass";

const handler = await import("../src/handler.mjs?contests");
const { api, __setClientsForTest } = handler;
// handler.mjs?contests resolves ./contests.mjs WITHOUT a buster, so this import
// is the exact module instance the handler configured (fakes propagate).
const {
  ALL_CONTESTS,
  resolveContest,
  scopedQuery,
  slugify,
  __setRandomForTest
} = await import("../src/contests.mjs");

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

const ADMIN_HEADERS = { "x-admin-password": "ct-admin-pass" };

function createReq(body, headers = ADMIN_HEADERS) {
  return makeReq({ method: "POST", path: "/api/admin/contests", headers, body });
}
function listReq(query = {}, headers = ADMIN_HEADERS) {
  return makeReq({ method: "GET", path: "/api/admin/contests", headers, query });
}
function updateReq(body, headers = ADMIN_HEADERS) {
  return makeReq({ method: "POST", path: "/api/admin/contest-update", headers, body });
}
function statusReq(body, headers = ADMIN_HEADERS) {
  return makeReq({ method: "POST", path: "/api/admin/contest-status", headers, body });
}

async function seedLegacySettings(firestore, settings = {}) {
  await firestore.collection("ct_settings").doc("active").set({
    start_at: "2026-06-10T03:30:00.000Z",
    end_at: "2026-06-10T06:30:00.000Z",
    updated_at: "2026-06-10T00:00:00.000Z",
    ...settings
  });
}

// ---- slugify (F8/F9 rules: lowercase, trim, spaces→-, strip non [a-z0-9-]) ---

test("slugify: golden table", () => {
  assert.equal(slugify("KEC June 2026 — Round 1"), "kec-june-2026-round-1");
  assert.equal(slugify("  Aptitude   Round 1  "), "aptitude-round-1");
  assert.equal(slugify("already-a-slug"), "already-a-slug");
  assert.equal(slugify("PSG Tech!!"), "psg-tech");
  assert.equal(slugify("###"), "");
  assert.equal(slugify(""), "");
  assert.equal(slugify("- dashes -"), "dashes");
});

// ---- auth -------------------------------------------------------------------

test("contests: every admin endpoint rejects without the admin password", async () => {
  __setClientsForTest({ firestore: makeFakeFirestore() });
  assert.equal((await call(createReq({ name: "X" }, {}))).statusCode, 401);
  assert.equal((await call(listReq({}, {}))).statusCode, 401);
  assert.equal((await call(updateReq({ slug: "x", name: "Y" }, {}))).statusCode, 401);
  assert.equal((await call(statusReq({ slug: "x", status: "archived" }, {}))).statusCode, 401);
});

// ---- create -----------------------------------------------------------------

test("create: minimal body mints the full default doc shape (vision §2.7 + F9 lifecycle placeholders)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore });
  const res = await call(createReq({ name: "KEC June 2026 — Round 1" }));
  assert.equal(res.statusCode, 200);
  const contest = res.body.contest;
  assert.equal(contest.slug, "kec-june-2026-round-1");
  assert.equal(contest.name, "KEC June 2026 — Round 1");
  assert.equal(contest.status, "draft");
  assert.equal(contest.listed, true);
  assert.equal(contest.identity_mode, "person");
  assert.equal(contest.identity_label, "Candidate ID");
  assert.match(contest.access_code, /^[A-Z2-9]{6}$/);
  assert.equal(contest.start_at, null);
  assert.equal(contest.end_at, null);
  assert.equal(contest.end_at_updated_at, null);
  assert.equal(contest.room_gate_enabled, false);
  assert.deepEqual(contest.rooms, []);
  // Lifecycle block placeholders (F9 §3) — all null / default.
  assert.equal(contest.selection_done_at, null);
  assert.equal(contest.evidence_retention_days, 4);
  assert.equal(contest.evidence_purged_at, null);
  assert.equal(contest.db_purged_at, null);
  assert.equal(contest.evidence_prefixes, null);
  assert.equal(contest.last_export, null);
  assert.ok(contest.created_at);
  assert.equal(contest.created_at, contest.updated_at);
  // Doc id IS the slug.
  assert.ok(firestore._collections.get("ct_contests").has("kec-june-2026-round-1"));
});

test("create: optional fields are validated and stored", async () => {
  __setClientsForTest({ firestore: makeFakeFirestore() });
  const res = await call(createReq({
    name: "Tech Round 2",
    identity_label: "Roll Number",
    listed: false,
    start_at: "2026-07-01T04:00:00.000Z",
    end_at: "2026-07-01T07:00:00.000Z",
    evidence_retention_days: 10
  }));
  assert.equal(res.statusCode, 200);
  const contest = res.body.contest;
  assert.equal(contest.identity_label, "Roll Number");
  assert.equal(contest.listed, false);
  assert.equal(contest.start_at, "2026-07-01T04:00:00.000Z");
  assert.equal(contest.end_at, "2026-07-01T07:00:00.000Z");
  assert.equal(contest.evidence_retention_days, 10);
});

test("create: slug collision gets the -2 / -3 suffix", async () => {
  __setClientsForTest({ firestore: makeFakeFirestore() });
  assert.equal((await call(createReq({ name: "Round 1" }))).body.contest.slug, "round-1");
  assert.equal((await call(createReq({ name: "round 1" }))).body.contest.slug, "round-1-2");
  assert.equal((await call(createReq({ name: "ROUND 1" }))).body.contest.slug, "round-1-3");
});

test("create: validation — name required, slug must be non-empty, window ordered, identity_mode locked to person", async () => {
  __setClientsForTest({ firestore: makeFakeFirestore() });
  assert.equal((await call(createReq({}))).statusCode, 400);
  assert.equal((await call(createReq({ name: "   " }))).statusCode, 400);
  assert.equal((await call(createReq({ name: "###" }))).statusCode, 400);
  const badWindow = await call(createReq({
    name: "X", start_at: "2026-07-01T07:00:00.000Z", end_at: "2026-07-01T04:00:00.000Z"
  }));
  assert.equal(badWindow.statusCode, 400);
  const badDate = await call(createReq({ name: "X", start_at: "not-a-date" }));
  assert.equal(badDate.statusCode, 400);
  // legacy_username exists ONLY on the synthesized legacy contest (vision §7 row S-B).
  const badMode = await call(createReq({ name: "X", identity_mode: "legacy_username" }));
  assert.equal(badMode.statusCode, 400);
  const badListed = await call(createReq({ name: "X", listed: "yes" }));
  assert.equal(badListed.statusCode, 400);
  const badRetention = await call(createReq({ name: "X", evidence_retention_days: "soon" }));
  assert.equal(badRetention.statusCode, 400);
});

test("create: evidence_retention_days clamps to 1..30 (F9 §2.1)", async () => {
  __setClientsForTest({ firestore: makeFakeFirestore() });
  assert.equal((await call(createReq({ name: "A", evidence_retention_days: 0 }))).body.contest.evidence_retention_days, 1);
  assert.equal((await call(createReq({ name: "B", evidence_retention_days: 99 }))).body.contest.evidence_retention_days, 30);
});

test("create: access-code mint retries on collision until a unique code lands (vision §10.3)", async () => {
  __setClientsForTest({ firestore: makeFakeFirestore() });
  try {
    __setRandomForTest(() => 0); // every draw = alphabet[0] → "AAAAAA"
    const first = await call(createReq({ name: "First" }));
    assert.equal(first.body.contest.access_code, "AAAAAA");
    // Next mint: first attempt re-draws "AAAAAA" (collides), retry draws "BBBBBB".
    let calls = 0;
    __setRandomForTest(() => (calls++ < 6 ? 0 : 1));
    const second = await call(createReq({ name: "Second" }));
    assert.equal(second.statusCode, 200);
    assert.equal(second.body.contest.access_code, "BBBBBB");
  } finally {
    __setRandomForTest(null);
  }
});

test("create: access-code mint gives up after bounded attempts instead of looping forever", async () => {
  __setClientsForTest({ firestore: makeFakeFirestore() });
  try {
    __setRandomForTest(() => 0);
    assert.equal((await call(createReq({ name: "First" }))).statusCode, 200);
    const second = await call(createReq({ name: "Second" })); // RNG can only ever mint "AAAAAA"
    assert.equal(second.statusCode, 500);
  } finally {
    __setRandomForTest(null);
  }
});

// ---- list -------------------------------------------------------------------

test("list: returns created contests newest-first; archived hidden unless include_archived", async () => {
  __setClientsForTest({ firestore: makeFakeFirestore() });
  await call(createReq({ name: "Alpha" }));
  await call(createReq({ name: "Beta" }));
  await call(statusReq({ slug: "alpha", status: "archived" }));

  const plain = await call(listReq());
  assert.equal(plain.statusCode, 200);
  assert.deepEqual(plain.body.contests.map((c) => c.slug), ["beta"]);
  assert.equal(plain.body.contests[0].legacy, false);

  const all = await call(listReq({ include_archived: "1" }));
  const bySlug = Object.fromEntries(all.body.contests.map((c) => [c.slug, c]));
  assert.equal(bySlug.alpha.status, "archived");
  assert.equal(bySlug.beta.status, "draft");
});

// ---- legacy-contest synthesis (F9 §6, read-only) ------------------------------

test("legacy: no settings doc → no synthesized entry", async () => {
  __setClientsForTest({ firestore: makeFakeFirestore() });
  const res = await call(listReq());
  assert.deepEqual(res.body.contests, []);
});

test("legacy: synthesized from settings.contest_slug, flagged legacy:true, identity_mode legacy_username", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore });
  await seedLegacySettings(firestore, { contest_slug: "kec-aerele-2026" });
  const res = await call(listReq());
  assert.equal(res.body.contests.length, 1);
  const legacy = res.body.contests[0];
  assert.equal(legacy.slug, "kec-aerele-2026");
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.legacy_empty_slug, false);
  assert.equal(legacy.identity_mode, "legacy_username");
  assert.equal(legacy.status, "open");
  assert.equal(legacy.access_code, null);
  assert.equal(legacy.start_at, "2026-06-10T03:30:00.000Z");
  assert.equal(legacy.end_at, "2026-06-10T06:30:00.000Z");
  // Synthesis never writes: the contests collection stays empty.
  assert.equal((firestore._collections.get("ct_contests") || new Map()).size, 0);
});

test("legacy: slug falls back to contest_url, then to 'legacy' with legacy_empty_slug", async () => {
  let firestore = makeFakeFirestore();
  __setClientsForTest({ firestore });
  await seedLegacySettings(firestore, { contest_url: "https://hr.example/contests/mcet-june" });
  let res = await call(listReq());
  assert.equal(res.body.contests[0].slug, "mcet-june");
  assert.equal(res.body.contests[0].legacy_empty_slug, false);

  firestore = makeFakeFirestore();
  __setClientsForTest({ firestore });
  await seedLegacySettings(firestore); // neither contest_slug nor contest_url
  res = await call(listReq());
  assert.equal(res.body.contests[0].slug, "legacy");
  assert.equal(res.body.contests[0].legacy_empty_slug, true);
});

test("legacy: a real contest doc with the same slug suppresses the synthesized entry", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore });
  await seedLegacySettings(firestore, { contest_slug: "kec-aerele-2026" });
  // Simulate a future migrated/imported real doc owning the legacy slug.
  await firestore.collection("ct_contests").doc("kec-aerele-2026").set({
    slug: "kec-aerele-2026", name: "KEC Aerele 2026", status: "open", listed: true,
    identity_mode: "person", created_at: "2026-06-09T00:00:00.000Z"
  });
  const res = await call(listReq());
  assert.equal(res.body.contests.length, 1);
  assert.equal(res.body.contests[0].legacy, false);
});

test("legacy: create never claims the synthesized legacy slug (suffixes instead)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore });
  await seedLegacySettings(firestore, { contest_slug: "kec-aerele-2026" });
  const res = await call(createReq({ name: "KEC Aerele 2026" }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.contest.slug, "kec-aerele-2026-2");
});

// ---- update (name change does NOT change slug) --------------------------------

test("update: rename keeps the slug; display fields update; updated_at bumps", async () => {
  __setClientsForTest({ firestore: makeFakeFirestore() });
  const created = (await call(createReq({ name: "Round 1" }))).body.contest;
  const res = await call(updateReq({
    slug: "round-1", name: "Round 1 (KEC)", identity_label: "Roll Number", listed: false
  }));
  assert.equal(res.statusCode, 200);
  const contest = res.body.contest;
  assert.equal(contest.slug, "round-1");
  assert.equal(contest.name, "Round 1 (KEC)");
  assert.equal(contest.identity_label, "Roll Number");
  assert.equal(contest.listed, false);
  assert.equal(contest.access_code, created.access_code); // mint once, never on update
  assert.equal(contest.status, "draft");
});

test("update: window edits validate against the MERGED window", async () => {
  __setClientsForTest({ firestore: makeFakeFirestore() });
  await call(createReq({ name: "W", end_at: "2026-07-01T07:00:00.000Z" }));
  const bad = await call(updateReq({ slug: "w", start_at: "2026-07-01T08:00:00.000Z" }));
  assert.equal(bad.statusCode, 400);
  const good = await call(updateReq({ slug: "w", start_at: "2026-07-01T04:00:00.000Z" }));
  assert.equal(good.statusCode, 200);
  assert.equal(good.body.contest.start_at, "2026-07-01T04:00:00.000Z");
});

test("update: unknown slug → 404; identity_mode/status/access_code are not updatable", async () => {
  __setClientsForTest({ firestore: makeFakeFirestore() });
  await call(createReq({ name: "U" }));
  assert.equal((await call(updateReq({ slug: "nope", name: "X" }))).statusCode, 404);
  assert.equal((await call(updateReq({ slug: "u", identity_mode: "legacy_username" }))).statusCode, 400);
  assert.equal((await call(updateReq({ slug: "u", status: "open" }))).statusCode, 400);
  assert.equal((await call(updateReq({ slug: "u", access_code: "HACKED" }))).statusCode, 400);
});

test("update/status: the synthesized legacy contest is read-only (404, nothing written)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore });
  await seedLegacySettings(firestore, { contest_slug: "kec-aerele-2026" });
  assert.equal((await call(updateReq({ slug: "kec-aerele-2026", name: "X" }))).statusCode, 404);
  assert.equal((await call(statusReq({ slug: "kec-aerele-2026", status: "archived" }))).statusCode, 404);
  assert.equal((firestore._collections.get("ct_contests") || new Map()).size, 0);
});

// ---- status / archive ----------------------------------------------------------

test("status: draft → open → archived; invalid status rejected", async () => {
  __setClientsForTest({ firestore: makeFakeFirestore() });
  await call(createReq({ name: "S" }));
  assert.equal((await call(statusReq({ slug: "s", status: "open" }))).body.contest.status, "open");
  assert.equal((await call(statusReq({ slug: "s", status: "archived" }))).body.contest.status, "archived");
  assert.equal((await call(statusReq({ slug: "s", status: "deleted" }))).statusCode, 400);
  assert.equal((await call(statusReq({ slug: "missing", status: "open" }))).statusCode, 404);
});

// ---- resolveContest (F9 §2.3.1) -------------------------------------------------

test("resolveContest: open contest resolves by slug; draft is contest_not_open unless requireOpen:false", async () => {
  __setClientsForTest({ firestore: makeFakeFirestore() });
  await call(createReq({ name: "Live One" }));
  await assert.rejects(resolveContest("live-one"), /contest_not_open/);
  const draft = await resolveContest("live-one", { requireOpen: false });
  assert.equal(draft.slug, "live-one");
  await call(statusReq({ slug: "live-one", status: "open" }));
  const open = await resolveContest("live-one");
  assert.equal(open.status, "open");
  assert.equal(open.legacy, false);
});

test("resolveContest: unknown/empty slug → unknown_contest (400)", async () => {
  __setClientsForTest({ firestore: makeFakeFirestore() });
  await assert.rejects(resolveContest("ghost"), (err) => err.statusCode === 400 && /unknown_contest/.test(err.message));
  await assert.rejects(resolveContest(""), /unknown_contest/);
});

test("resolveContest: accepts a req-like object — query.contest first, then JSON body.contest", async () => {
  __setClientsForTest({ firestore: makeFakeFirestore() });
  await call(createReq({ name: "Req Based" }));
  await call(statusReq({ slug: "req-based", status: "open" }));
  const viaQuery = await resolveContest({ query: { contest: "req-based" } });
  assert.equal(viaQuery.slug, "req-based");
  const viaBody = await resolveContest({ body: JSON.stringify({ contest: "req-based" }) });
  assert.equal(viaBody.slug, "req-based");
  const viaParsedBody = await resolveContest({ body: { contest: "req-based" } });
  assert.equal(viaParsedBody.slug, "req-based");
});

test("resolveContest: the synthesized legacy contest resolves read-only with legacy:true", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore });
  await seedLegacySettings(firestore, { contest_slug: "kec-aerele-2026" });
  const legacy = await resolveContest("kec-aerele-2026");
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.identity_mode, "legacy_username");
});

// ---- scopedQuery chokepoint (F9 §2.3.2) ----------------------------------------

test("scopedQuery: filters to the contest's slug; ALL_CONTESTS passes through unfiltered", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore });
  await call(createReq({ name: "A" }));
  await call(statusReq({ slug: "a", status: "open" }));
  await firestore.collection("ct_sessions").doc("s1").set({ session_id: "s1", contest_slug: "a" });
  await firestore.collection("ct_sessions").doc("s2").set({ session_id: "s2", contest_slug: "b" });
  await firestore.collection("ct_sessions").doc("s3").set({ session_id: "s3", contest_slug: "" });

  const contest = await resolveContest("a");
  const scoped = await scopedQuery(firestore.collection("ct_sessions"), contest).get();
  assert.deepEqual(scoped.docs.map((d) => d.data().session_id), ["s1"]);

  const everything = await scopedQuery(firestore.collection("ct_sessions"), ALL_CONTESTS).get();
  assert.equal(everything.docs.length, 3);
});

test("scopedQuery: a legacy_empty_slug contest translates to the contest_slug=='' filter (F9 §6)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore });
  await seedLegacySettings(firestore); // no slug anywhere → slug "legacy", legacy_empty_slug:true
  await firestore.collection("ct_sessions").doc("s1").set({ session_id: "s1", contest_slug: "" });
  await firestore.collection("ct_sessions").doc("s2").set({ session_id: "s2", contest_slug: "a" });

  const legacy = await resolveContest("legacy");
  const scoped = await scopedQuery(firestore.collection("ct_sessions"), legacy).get();
  assert.deepEqual(scoped.docs.map((d) => d.data().session_id), ["s1"]);
});

test("scopedQuery: refuses an unresolved contest (no accidental cross-contest reads)", () => {
  const firestore = makeFakeFirestore();
  assert.throws(() => scopedQuery(firestore.collection("ct_sessions"), null));
  assert.throws(() => scopedQuery(firestore.collection("ct_sessions"), { name: "no slug" }));
  assert.throws(() => scopedQuery(firestore.collection("ct_sessions"), "a-bare-slug"));
});
