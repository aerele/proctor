// backend/test/contestDataSize.test.mjs
//
// G1 (v1.1, design §2.6) — GET /api/admin/contest-data-size?contest=<slug>:
// the admin "Stored data" measurement. READ-ONLY: lists the ONE contest's
// evidence objects in GCS and returns total bytes + object count + a per-kind
// byte breakdown the admin UI renders (screen / camera / events / editorEvents /
// review / manifests / other). The frontend (api.ts fetchContestDataSize +
// ContestsPanel "Stored data" row) consumes:
//   { contest, evidence_bytes, evidence_objects, by_kind, computed_at }
//
// What this file pins:
//   - ADMIN auth required (no/empty/wrong x-admin-password → 401).
//   - the exact response SHAPE the frontend expects, with per-kind grouping
//     derived from the storage layout
//     contests/<slug>/sessions/<user>/<session>/<kind>/...
//   - STRICT scoping: a sibling contest's objects (and the shared exports/
//     subtree) are NEVER counted — only this slug's `contests/<slug>/` prefix.
//
// Inline req/res mocks + GCS/Firestore fakes are copied per the repo convention
// (NO shared test/helpers.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";

// Env MUST be set before importing the handler (it reads env at module load).
process.env.EVIDENCE_BUCKET = "cds-bucket";
process.env.SESSION_COLLECTION = "cds_sessions";
process.env.SETTINGS_COLLECTION = "cds_settings";
process.env.CONTESTS_COLLECTION = "cds_contests";
process.env.ALERTS_COLLECTION = "cds_alerts";
process.env.ADMIN_PASSWORD = "cds-admin-pass";

const handler = await import("../src/handler.mjs?contestDataSize");
const { api, __setClientsForTest } = handler;

// ---- inline req/res mocks ---------------------------------------------------
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
function adminGet(query, headers = { "x-admin-password": "cds-admin-pass" }) {
  return makeReq({ method: "GET", path: "/api/admin/contest-data-size", headers, query });
}

// ---- inline Firestore fake (only what this route reads: contest doc get) -----
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
            async set(value, options) {
              const existing = options?.merge ? store.get(id) || {} : {};
              store.set(id, { ...existing, ...value });
            },
            async get() { const data = store.get(id); return { exists: Boolean(data), data: () => data }; }
          };
        }
      };
    }
  };
}

// ---- inline GCS fake: getFiles({prefix}) over an in-memory object map --------
// Each entry carries an explicit size so per-kind sums are deterministic. The
// fake STRICTLY honors the prefix filter (no entry outside the requested prefix
// is ever returned) so a scoping bug in the route surfaces here.
function makeFakeStorage(objects /* Map<name, size> */) {
  return {
    bucket() {
      return {
        async getFiles({ prefix } = {}) {
          const files = [...objects.entries()]
            .filter(([name]) => !prefix || name.startsWith(prefix))
            .map(([name, size]) => ({ name, metadata: { size } }));
          return [files];
        },
        file() { throw new Error("contest-data-size must only LIST, never touch individual files"); }
      };
    }
  };
}

const SLUG = "kec-2026";
const OTHER = "kec-2025";

function seedContest(firestore, slug) {
  firestore.collection(process.env.CONTESTS_COLLECTION).doc(slug).set({
    slug, name: slug, status: "open",
    identity_mode: "person", identity_label: "Candidate ID",
    start_at: "2026-01-01T00:00:00.000Z", end_at: "2099-01-01T00:00:00.000Z",
    problems: [], rooms: [], room_gate_enabled: false
  });
}

// Evidence objects for SLUG (the contest under test): one of every kind, plus a
// sibling-contest object and a shared export zip that must NEVER be counted.
function seedObjects() {
  const objects = new Map();
  const p = `contests/${SLUG}/sessions/alice/sess1/`;
  objects.set(`${p}screen/chunk-00000.webm`, 1000);
  objects.set(`${p}screen/chunk-00001.webm`, 1500);   // screen total 2500
  objects.set(`${p}camera/chunk-00000.webm`, 400);    // camera total 400
  objects.set(`${p}events/events-123.jsonl`, 30);
  objects.set(`${p}events/session.jsonl`, 20);         // events total 50
  objects.set(`${p}editor-events/2026.ndjson`, 70);    // editorEvents total 70
  objects.set(`${p}review/clipboard.jsonl`, 11);       // review total 11
  objects.set(`${p}manifest.json`, 5);                 // manifests total 5
  // OUT-OF-SCOPE objects that must be excluded from SLUG's total:
  objects.set(`contests/${OTHER}/sessions/alice/sessX/screen/chunk-00000.webm`, 999999);
  objects.set(`exports/${SLUG}-2026.ndjson`, 888888);  // shared exports subtree
  return objects;
}

// ---- 1: auth required -------------------------------------------------------

test("contest-data-size: rejects a request with no admin password (401)", async () => {
  const firestore = makeFakeFirestore();
  seedContest(firestore, SLUG);
  __setClientsForTest({ firestore, storage: makeFakeStorage(seedObjects()) });
  const res = await call(adminGet({ contest: SLUG }, {}));
  assert.equal(res.statusCode, 401, JSON.stringify(res.body));
});

test("contest-data-size: rejects a wrong admin password (401)", async () => {
  const firestore = makeFakeFirestore();
  seedContest(firestore, SLUG);
  __setClientsForTest({ firestore, storage: makeFakeStorage(seedObjects()) });
  const res = await call(adminGet({ contest: SLUG }, { "x-admin-password": "nope" }));
  assert.equal(res.statusCode, 401, JSON.stringify(res.body));
});

// ---- 2: response shape ------------------------------------------------------

test("contest-data-size: returns total + object count + per-kind breakdown in the frontend's shape", async () => {
  const firestore = makeFakeFirestore();
  seedContest(firestore, SLUG);
  __setClientsForTest({ firestore, storage: makeFakeStorage(seedObjects()) });
  const res = await call(adminGet({ contest: SLUG }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));

  const body = res.body;
  // Exact keys the frontend (ContestDataSizeResponse) expects.
  assert.deepEqual(
    Object.keys(body).sort(),
    ["by_kind", "computed_at", "contest", "evidence_bytes", "evidence_objects"]
  );
  assert.equal(body.contest, SLUG);
  // 8 in-scope objects; the sibling-contest + exports objects are excluded.
  assert.equal(body.evidence_objects, 8);
  assert.equal(body.evidence_bytes, 2500 + 400 + 50 + 70 + 11 + 5);
  assert.deepEqual(body.by_kind, {
    screen: 2500, camera: 400, events: 50, editorEvents: 70, review: 11, manifests: 5
  });
  // computed_at is a parseable ISO timestamp.
  assert.ok(!Number.isNaN(Date.parse(body.computed_at)), "computed_at is an ISO timestamp");
});

// ---- 3: strict slug scoping -------------------------------------------------

test("contest-data-size: counts ONLY this slug's contests/<slug>/ prefix (no sibling/export bleed)", async () => {
  const firestore = makeFakeFirestore();
  seedContest(firestore, SLUG);
  seedContest(firestore, OTHER);
  __setClientsForTest({ firestore, storage: makeFakeStorage(seedObjects()) });
  const res = await call(adminGet({ contest: SLUG }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  // The 999999-byte sibling object and 888888-byte export zip would dwarf the
  // real total if scoping leaked — assert the total is the in-scope sum only.
  assert.equal(res.body.evidence_bytes, 3036);
  assert.ok(res.body.evidence_bytes < 999999, "sibling-contest bytes leaked into the total");
  // And the OTHER contest, measured on its own, sees its own object only.
  const other = await call(adminGet({ contest: OTHER }));
  assert.equal(other.statusCode, 200, JSON.stringify(other.body));
  assert.equal(other.body.evidence_objects, 1);
  assert.equal(other.body.evidence_bytes, 999999);
});

// ---- 4: empty contest -------------------------------------------------------

test("contest-data-size: a contest with no stored objects returns zeros + an empty breakdown", async () => {
  const firestore = makeFakeFirestore();
  seedContest(firestore, SLUG);
  __setClientsForTest({ firestore, storage: makeFakeStorage(new Map()) });
  const res = await call(adminGet({ contest: SLUG }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.evidence_bytes, 0);
  assert.equal(res.body.evidence_objects, 0);
  assert.deepEqual(res.body.by_kind, {});
});

// ---- 5: missing/unknown contest --------------------------------------------

test("contest-data-size: an unknown or missing contest is a 400 (never lists the bucket)", async () => {
  const firestore = makeFakeFirestore();
  seedContest(firestore, SLUG);
  __setClientsForTest({ firestore, storage: makeFakeStorage(seedObjects()) });
  const missing = await call(adminGet({}));
  assert.equal(missing.statusCode, 400, JSON.stringify(missing.body));
  const unknown = await call(adminGet({ contest: "does-not-exist" }));
  assert.equal(unknown.statusCode, 400, JSON.stringify(unknown.body));
});

// ---- 6: v1.1 triple-review #10 — MANUAL pagination (no whole-subtree OOM) ----
// A PAGING GCS fake that hands back the listing one page at a time via nextQuery
// (mirroring @google-cloud/storage's getFiles(autoPaginate:false) contract). The
// route must follow nextQuery and aggregate EVERY page, never relying on the
// library auto-paginating the entire subtree into one in-memory array.
function makePagingStorage(objects /* Map<name,size> */, pageSize = 2) {
  const all = [...objects.entries()].map(([name, size]) => ({ name, metadata: { size } }));
  let pageRequests = 0;
  const storage = {
    get _pageRequests() { return pageRequests; },
    bucket() {
      return {
        async getFiles(query = {}) {
          pageRequests += 1;
          const prefix = query.prefix || "";
          const matching = all.filter((f) => f.name.startsWith(prefix));
          const start = Number(query.pageToken || 0);
          const slice = matching.slice(start, start + pageSize);
          const nextStart = start + pageSize;
          const nextQuery = nextStart < matching.length ? { ...query, pageToken: nextStart } : null;
          return [slice, nextQuery];
        },
        file() { throw new Error("contest-data-size must only LIST, never touch individual files"); }
      };
    }
  };
  return storage;
}

test("contest-data-size: aggregates across MULTIPLE pages (manual pagination, no OOM auto-paginate)", async () => {
  const firestore = makeFakeFirestore();
  seedContest(firestore, SLUG);
  const storage = makePagingStorage(seedObjects(), 2); // tiny pages → forces multi-page
  __setClientsForTest({ firestore, storage });
  const res = await call(adminGet({ contest: SLUG }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  // Same totals as the single-page test — proving every page was aggregated.
  assert.equal(res.body.evidence_objects, 8);
  assert.equal(res.body.evidence_bytes, 2500 + 400 + 50 + 70 + 11 + 5);
  assert.deepEqual(res.body.by_kind, {
    screen: 2500, camera: 400, events: 50, editorEvents: 70, review: 11, manifests: 5
  });
  // It actually PAGED (more than one getFiles call) — i.e. it followed nextQuery.
  assert.ok(storage._pageRequests > 1, `expected multiple page requests, got ${storage._pageRequests}`);
});
