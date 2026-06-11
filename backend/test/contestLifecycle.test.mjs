// backend/test/contestLifecycle.test.mjs — Wave7-G data-lifecycle ENDPOINTS
// (S-G/S-H). The handler-level integration over in-memory Firestore + GCS fakes.
//
// Specs: docs/superpowers/specs/2026-06-10-f9-identity-data-lifecycle-design.md
//          §3.1 (export), §3.2 (triple-gated purge + tombstone), §3.4 (sweep),
//          Decision 12 (gates), Decision 14 (scheduler key auth).
//        docs/superpowers/specs/2026-06-10-f10-product-vision.md §2.9
//          (purge retains enrollments + final_snapshot), §2.16, §10.4 (zip
//          retention).
//
// Covers: export writes a GCS object + stamps last_export_at/export path + audit;
// purge gate rejections (no export / no confirm / wrong slug); purge deletes the
// heavy data, RETAINS enrollments + snapshot, writes a tombstone, and leaves a
// SECOND contest + persons UNTOUCHED (no-bleed); idempotent re-purge; retention
// sweep purges due evidence + expired zips + closed-by-default scheduler auth.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.EVIDENCE_BUCKET = "cl-bucket";
process.env.SESSION_COLLECTION = "cl_sessions";
process.env.SETTINGS_COLLECTION = "cl_settings";
process.env.CONTESTS_COLLECTION = "cl_contests";
process.env.ROSTER_COLLECTION = "cl_roster";
process.env.ALERTS_COLLECTION = "cl_alerts";
process.env.SUBMISSIONS_COLLECTION = "cl_submissions";
process.env.SUBMISSION_EVENTS_COLLECTION = "cl_subevents";
process.env.PROBLEMS_COLLECTION = "cl_problems";
process.env.REVIEW_COLLECTION = "cl_reviews";
process.env.REVIEW_CLAIMS_COLLECTION = "cl_review_claims";
process.env.LIVE_LOCK_COLLECTION = "cl_live_locks";
process.env.ROOM_GATES_COLLECTION = "cl_room_gates";
process.env.COLLEGES_COLLECTION = "cl_colleges";
process.env.PERSONS_COLLECTION = "cl_persons";
process.env.ENROLLMENTS_COLLECTION = "cl_enrollments";
process.env.ADMIN_AUDIT_COLLECTION = "cl_audit";
process.env.ADMIN_PASSWORD = "cl-admin-pass";
process.env.RETENTION_SWEEP_API_KEY = "cl-sweep-key";

const handler = await import("../src/handler.mjs?contestlifecycle");
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

// Fake Firestore honoring equality filters scopedQuery/the rollup use.
function makeFakeFirestore() {
  const collections = new Map();
  function getCollection(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  }
  function makeQuery(name, filters) {
    return {
      where(field, op, value) { return makeQuery(name, [...filters, { field, op, value }]); },
      orderBy() { return this; },
      limit() { return this; },
      async get() {
        let docs = [...getCollection(name).values()];
        for (const { field, op, value } of filters) {
          if (op === "in") docs = docs.filter((doc) => Array.isArray(value) && value.includes(doc[field]));
          else docs = docs.filter((doc) => doc[field] === value);
        }
        return { docs: docs.map((data) => ({ id: data.__id, data: () => data })) };
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
            async create(value) { if (store.has(id)) { const e = new Error("ALREADY_EXISTS"); e.code = 6; throw e; } store.set(id, { __id: id, ...value }); },
            async set(value, options) { const existing = options?.merge ? store.get(id) || {} : {}; store.set(id, { __id: id, ...existing, ...value }); },
            async update(value) { const existing = store.get(id); if (!existing) throw new Error(`missing ${id}`); store.set(id, { ...existing, ...value }); },
            async delete() { store.delete(id); },
            async get() { const data = store.get(id); return { exists: Boolean(data), data: () => data }; }
          };
        }
      };
    }
  };
}

// Fake Storage: records saves under keys, lists by prefix, deletes per-file.
function makeFakeStorage() {
  const saved = new Map(); // key -> { body, created }
  return {
    _saved: saved,
    bucket() {
      return {
        file(key) {
          return {
            async save(body) { saved.set(key, { body, created: "2026-06-11T10:00:00.000Z" }); },
            async getSignedUrl() { return [`https://signed.example/${key}`]; },
            async getMetadata() { return [{ size: 1, updated: saved.get(key)?.created || "2026-06-11T10:00:00.000Z" }]; },
            async download() { return [saved.get(key)?.body ?? ""]; },
            async delete() { saved.delete(key); }
          };
        },
        async getFiles({ prefix } = {}) {
          const files = [...saved.keys()]
            .filter((key) => !prefix || key.startsWith(prefix))
            .map((name) => ({
              name,
              metadata: { size: 1, updated: saved.get(name)?.created, timeCreated: saved.get(name)?.created },
              async getMetadata() { return [{ size: 1, updated: saved.get(name)?.created, timeCreated: saved.get(name)?.created }]; },
              async download() { return [saved.get(name)?.body ?? ""]; },
              async delete() { saved.delete(name); }
            }));
          return [files];
        }
      };
    }
  };
}

const ADMIN_HEADERS = { "x-admin-password": "cl-admin-pass" };

function freshClients() {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  return { firestore, storage };
}

const COL = "kec";
const PID = personIdOf("kec", identityNorm("21CS001"));

// Seed a person-mode contest with one enrolled candidate's full data trail +
// some evidence objects under its storage_prefix.
function seedContest(firestore, storage, slug, { withEvidence = true } = {}) {
  const now = "2026-06-10T00:00:00.000Z";
  firestore.collection("cl_contests").doc(slug).set({
    slug, name: `${slug} contest`, status: "open", identity_mode: "person",
    identity_label: "Roll Number", problems: [{ problem_id: "p1", points: 100, order: 0 }],
    colleges: ["kec"], created_at: now, updated_at: now,
    selection_done_at: null, evidence_retention_days: 4,
    evidence_purged_at: null, db_purged_at: null, evidence_prefixes: null, last_export: null
  });
  // person-mode: username_norm === person_id (the frozen join key) on every doc.
  const prefix = `contests/${slug}/sessions/${PID}/sess-${slug}/`;
  firestore.collection("cl_sessions").doc(`sess-${slug}`).set({
    session_id: `sess-${slug}`, contest_slug: slug, username_norm: PID,
    person_id: PID, candidate_id: "21 CS 001", status: "ended", storage_prefix: prefix
  });
  firestore.collection("cl_submissions").doc(`sub-${slug}`).set({
    session_id: `sess-${slug}`, contest_slug: slug, username_norm: PID,
    person_id: PID, problem_id: "p1", score: 80, max_points: 100, created_at: now
  });
  firestore.collection("cl_alerts").doc(`alert-${slug}`).set({
    contest_slug: slug, username_norm: PID, severity: "warning"
  });
  firestore.collection("cl_live_locks").doc(`live:${PID}:${slug}`).set({
    contest_slug: slug, username_norm: PID
  });
  firestore.collection("cl_room_gates").doc(`gate-${slug}`).set({ contest_slug: slug });
  // a review record + claim under the deterministic ids the purge reconstructs.
  firestore.collection("cl_reviews").doc(`${PID}::reviewer1::${slug}`).set({
    username_norm: PID, reviewer_name: "Reviewer1", contest_slug: slug, verdict: 0
  });
  firestore.collection("cl_review_claims").doc(`${PID}::${slug}`).set({
    username_norm: PID, contest_slug: slug, claimed_at: new Date().toISOString(), expires_at: "2099-01-01T00:00:00.000Z"
  });
  firestore.collection("cl_enrollments").doc(enrollmentIdOf(slug, PID)).set({
    contest_slug: slug, person_id: PID, college_norm: "kec", status: "active",
    selection_status: "selected", final_snapshot: null, created_at: now
  });
  firestore.collection("cl_persons").doc(PID).set({
    person_id: PID, college_norm: "kec", unique_id: "21 CS 001", name: "Test Candidate"
  });
  firestore.collection("cl_colleges").doc("kec").set({ college_norm: "kec", name: "KEC" });
  if (withEvidence) {
    storage.bucket().file(`${prefix}screen/chunk-0.webm`).save("video");
    storage.bucket().file(`${prefix}camera/chunk-0.webm`).save("cam");
  }
  return { prefix };
}

// ---- EXPORT -----------------------------------------------------------------

test("export: writes a GCS object under exports/{slug}/, stamps last_export_at + path, audit", async () => {
  const { firestore, storage } = freshClients();
  seedContest(firestore, storage, "kec-r1");
  const res = await call(makeReq({ method: "POST", path: "/api/admin/contest-export", headers: ADMIN_HEADERS, body: { contest: "kec-r1" } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.match(res.body.gcs_key, /^exports\/kec-r1\//);
  assert.ok(res.body.signed_url, "a reference/temp URL is returned");
  assert.equal(res.body.counts.sessions, 1);
  assert.equal(res.body.counts.submissions, 1);
  assert.equal(res.body.counts.enrollments, 1);

  // the export object exists in GCS
  const keys = [...storage._saved.keys()];
  assert.ok(keys.some((k) => k.startsWith("exports/kec-r1/")), "export object written to GCS");

  // contest doc stamped
  const contest = firestore._collections.get("cl_contests").get("kec-r1");
  assert.ok(contest.last_export_at, "last_export_at stamped");
  assert.equal(contest.last_export.gcs_key, res.body.gcs_key);

  // audit row written
  const audits = [...firestore._collections.get("cl_audit").values()];
  assert.ok(audits.some((a) => a.action === "contest_export" && a.contest_slug === "kec-r1"));
});

test("export: requires admin auth", async () => {
  const { firestore, storage } = freshClients();
  seedContest(firestore, storage, "kec-r1");
  const res = await call(makeReq({ method: "POST", path: "/api/admin/contest-export", body: { contest: "kec-r1" } }));
  assert.equal(res.statusCode, 401);
});

// ---- PURGE GATES ------------------------------------------------------------

test("purge: rejected when no prior export (export_required)", async () => {
  const { firestore, storage } = freshClients();
  seedContest(firestore, storage, "kec-r1");
  const res = await call(makeReq({ method: "POST", path: "/api/admin/contest-purge", headers: ADMIN_HEADERS,
    body: { contest: "kec-r1", confirm: true, slug: "kec-r1" } }));
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "export_required");
  // nothing deleted
  assert.equal(firestore._collections.get("cl_sessions").size, 1);
});

test("purge: rejected when confirm flag missing (confirm_required)", async () => {
  const { firestore, storage } = freshClients();
  seedContest(firestore, storage, "kec-r1");
  await call(makeReq({ method: "POST", path: "/api/admin/contest-export", headers: ADMIN_HEADERS, body: { contest: "kec-r1" } }));
  const res = await call(makeReq({ method: "POST", path: "/api/admin/contest-purge", headers: ADMIN_HEADERS,
    body: { contest: "kec-r1", slug: "kec-r1" } }));
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "confirm_required");
});

test("purge: rejected when typed slug wrong (slug_mismatch)", async () => {
  const { firestore, storage } = freshClients();
  seedContest(firestore, storage, "kec-r1");
  await call(makeReq({ method: "POST", path: "/api/admin/contest-export", headers: ADMIN_HEADERS, body: { contest: "kec-r1" } }));
  const res = await call(makeReq({ method: "POST", path: "/api/admin/contest-purge", headers: ADMIN_HEADERS,
    body: { contest: "kec-r1", confirm: true, slug: "WRONG" } }));
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "slug_mismatch");
});

// ---- PURGE happy path + no-bleed --------------------------------------------

test("purge: deletes heavy data, RETAINS enrollment + snapshot, writes tombstone; OTHER contest + persons untouched", async () => {
  const { firestore, storage } = freshClients();
  seedContest(firestore, storage, "kec-r1");
  seedContest(firestore, storage, "kec-r2"); // the no-bleed sibling

  await call(makeReq({ method: "POST", path: "/api/admin/contest-export", headers: ADMIN_HEADERS, body: { contest: "kec-r1" } }));
  const res = await call(makeReq({ method: "POST", path: "/api/admin/contest-purge", headers: ADMIN_HEADERS,
    body: { contest: "kec-r1", confirm: true, slug: "kec-r1", include_evidence: true } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));

  // kec-r1 heavy data gone
  assert.equal(firestore._collections.get("cl_sessions").has("sess-kec-r1"), false, "session deleted");
  assert.equal(firestore._collections.get("cl_submissions").has("sub-kec-r1"), false, "submission deleted");
  assert.equal(firestore._collections.get("cl_alerts").has("alert-kec-r1"), false, "alert deleted");
  assert.equal(firestore._collections.get("cl_live_locks").size, 1, "only kec-r2's live-lock remains");
  assert.equal(firestore._collections.get("cl_room_gates").size, 1, "only kec-r2's room-gate remains");
  assert.equal(firestore._collections.get("cl_reviews").has(`${PID}::reviewer1::kec-r1`), false, "review record deleted (id reconstructed)");
  assert.equal(firestore._collections.get("cl_review_claims").has(`${PID}::kec-r1`), false, "review claim deleted");
  assert.equal(firestore._collections.get("cl_reviews").has(`${PID}::reviewer1::kec-r2`), true, "sibling review intact");

  // PURGE-SURVIVOR: enrollment retained, final_snapshot refreshed
  const enr = firestore._collections.get("cl_enrollments").get(enrollmentIdOf("kec-r1", PID));
  assert.ok(enr, "enrollment retained (purge-survivor)");
  assert.ok(enr.final_snapshot, "final_snapshot stamped before delete");
  assert.equal(enr.final_snapshot.total_score, 80);

  // persons NEVER purged
  assert.ok(firestore._collections.get("cl_persons").has(PID), "person retained");
  assert.ok(firestore._collections.get("cl_colleges").has("kec"), "college retained");

  // TOMBSTONE on the contest
  const contest = firestore._collections.get("cl_contests").get("kec-r1");
  assert.ok(contest.db_purged_at, "db_purged_at tombstone stamped");
  assert.ok(contest.purged_at, "purged_at tombstone stamped");
  assert.ok(contest.purge_counts, "removed counts recorded on tombstone");
  assert.equal(contest.purge_counts.sessions, 1);

  // NO-BLEED: kec-r2 entirely intact
  assert.equal(firestore._collections.get("cl_sessions").has("sess-kec-r2"), true, "sibling session intact");
  assert.equal(firestore._collections.get("cl_submissions").has("sub-kec-r2"), true, "sibling submission intact");
  const r2 = firestore._collections.get("cl_contests").get("kec-r2");
  assert.equal(r2.db_purged_at, null, "sibling contest not tombstoned");

  // include_evidence:true deleted the evidence objects but kept the export zip
  const keys = [...storage._saved.keys()];
  assert.ok(!keys.some((k) => k.startsWith("contests/kec-r1/sessions/")), "kec-r1 evidence deleted");
  assert.ok(keys.some((k) => k.startsWith("contests/kec-r2/sessions/")), "kec-r2 evidence intact");
  assert.ok(keys.some((k) => k.startsWith("exports/kec-r1/")), "export zip preserved (recovery path)");
});

test("purge: idempotent re-purge of a tombstoned contest is a no-op", async () => {
  const { firestore, storage } = freshClients();
  seedContest(firestore, storage, "kec-r1");
  await call(makeReq({ method: "POST", path: "/api/admin/contest-export", headers: ADMIN_HEADERS, body: { contest: "kec-r1" } }));
  await call(makeReq({ method: "POST", path: "/api/admin/contest-purge", headers: ADMIN_HEADERS,
    body: { contest: "kec-r1", confirm: true, slug: "kec-r1", include_evidence: true } }));
  // re-POST: still 200, already_purged flagged, no throw
  const res = await call(makeReq({ method: "POST", path: "/api/admin/contest-purge", headers: ADMIN_HEADERS,
    body: { contest: "kec-r1", confirm: true, slug: "kec-r1", include_evidence: true } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.already_purged, true);
});

test("purge with include_evidence:false stamps evidence_prefixes on the tombstone (Decision 13)", async () => {
  const { firestore, storage } = freshClients();
  const { prefix } = seedContest(firestore, storage, "kec-r1");
  await call(makeReq({ method: "POST", path: "/api/admin/contest-export", headers: ADMIN_HEADERS, body: { contest: "kec-r1" } }));
  await call(makeReq({ method: "POST", path: "/api/admin/contest-purge", headers: ADMIN_HEADERS,
    body: { contest: "kec-r1", confirm: true, slug: "kec-r1", include_evidence: false } }));
  const contest = firestore._collections.get("cl_contests").get("kec-r1");
  assert.ok(Array.isArray(contest.evidence_prefixes), "evidence_prefixes persisted for the later sweep");
  assert.ok(contest.evidence_prefixes.includes(prefix), "the session prefix is on the tombstone");
  assert.equal(contest.evidence_purged_at, null, "evidence not yet purged");
  // evidence still present in GCS
  assert.ok([...storage._saved.keys()].some((k) => k.startsWith(prefix)), "evidence retained until the sweep");
});

// ---- PURGE: export-is-the-recovery-path (the stamp must point at a LIVE zip) -

test("purge: rejected when last_export_at is stamped but the export zip is gone (export_missing)", async () => {
  const { firestore, storage } = freshClients();
  seedContest(firestore, storage, "kec-r1");
  await call(makeReq({ method: "POST", path: "/api/admin/contest-export", headers: ADMIN_HEADERS, body: { contest: "kec-r1" } }));
  // The recovery zip is auto-deleted (sweep / GCS lifecycle) but the stamp lingers.
  const key = firestore._collections.get("cl_contests").get("kec-r1").last_export.gcs_key;
  storage._saved.delete(key);
  const res = await call(makeReq({ method: "POST", path: "/api/admin/contest-purge", headers: ADMIN_HEADERS,
    body: { contest: "kec-r1", confirm: true, slug: "kec-r1", include_evidence: true } }));
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "export_missing", "an irreversible purge cannot proceed once the recovery anchor is gone");
  // NOTHING deleted — the contest's heavy data is fully intact.
  assert.equal(firestore._collections.get("cl_sessions").has("sess-kec-r1"), true, "session intact (purge refused)");
  assert.equal(firestore._collections.get("cl_contests").get("kec-r1").db_purged_at, null, "no tombstone written");
});

// ---- PURGE: crash-barrier tombstone scaffold is written BEFORE the deletes ---

test("purge: tombstone scaffold (db_purged_at + evidence_prefixes) is persisted BEFORE the finalize, so a crash leaves a recoverable state", async () => {
  const { firestore, storage } = freshClients();
  const { prefix } = seedContest(firestore, storage, "kec-r1");
  await call(makeReq({ method: "POST", path: "/api/admin/contest-export", headers: ADMIN_HEADERS, body: { contest: "kec-r1" } }));

  // Simulate dying after the scaffold + deletes but before the tombstone is
  // FINALIZED: count writes to the contest doc and throw on the 2nd one (the
  // finalize). The 1st write is the crash-barrier scaffold and must persist.
  const originalCollection = firestore.collection.bind(firestore);
  let contestSetCount = 0;
  firestore.collection = (name) => {
    const col = originalCollection(name);
    if (name === "cl_contests") {
      const origDoc = col.doc.bind(col);
      col.doc = (id) => {
        const ref = origDoc(id);
        if (id === "kec-r1") {
          const origSet = ref.set.bind(ref);
          ref.set = async (value, options) => {
            // The export-stamp write already ran (pre-purge); only count the
            // purge-time scaffold/finalize writes (they carry db_purged_at /
            // purge_counts).
            if (value && (value.db_purged_at || value.purge_counts)) {
              contestSetCount += 1;
              if (contestSetCount === 2) throw new Error("simulated crash before finalize");
            }
            return origSet(value, options);
          };
        }
        return ref;
      };
    }
    return col;
  };

  const res = await call(makeReq({ method: "POST", path: "/api/admin/contest-purge", headers: ADMIN_HEADERS,
    body: { contest: "kec-r1", confirm: true, slug: "kec-r1", include_evidence: false } }));
  assert.notEqual(res.statusCode, 200, "the purge did not complete cleanly (crashed at finalize)");

  firestore.collection = originalCollection; // restore

  const contest = firestore._collections.get("cl_contests").get("kec-r1");
  assert.ok(contest.purged_at, "purged_at scaffold stamped despite the crash → idempotent re-purge can finish");
  assert.ok(contest.db_purged_at, "db_purged_at scaffold stamped before the finalize");
  assert.ok(Array.isArray(contest.evidence_prefixes), "evidence_prefixes recorded up-front for the sweep");
  assert.ok(contest.evidence_prefixes.includes(prefix), "the session prefix is on the scaffold for the later sweep");

  // A re-POST is now an idempotent no-op (the scaffold tombstone short-circuits the gate).
  const retry = await call(makeReq({ method: "POST", path: "/api/admin/contest-purge", headers: ADMIN_HEADERS,
    body: { contest: "kec-r1", confirm: true, slug: "kec-r1", include_evidence: false } }));
  assert.equal(retry.statusCode, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.already_purged, true, "tombstoned contest → idempotent re-purge");
});

// ---- RETENTION SWEEP --------------------------------------------------------

test("retention-sweep: closed-by-default — wrong/missing scheduler key rejects", async () => {
  freshClients();
  const res = await call(makeReq({ method: "POST", path: "/api/admin/retention-sweep", headers: { "x-api-key": "nope" }, body: {} }));
  assert.equal(res.statusCode, 401);
});

test("retention-sweep: purges DUE evidence (selection_done + retention elapsed), reports what it purged", async () => {
  const { firestore, storage } = freshClients();
  const { prefix } = seedContest(firestore, storage, "kec-r1");
  // mark selection done in the far past so the 4-day window elapsed
  firestore.collection("cl_contests").doc("kec-r1").set({ selection_done_at: "2026-06-01T00:00:00.000Z" }, { merge: true });
  // a SECOND contest whose window has NOT elapsed
  seedContest(firestore, storage, "kec-r2");
  firestore.collection("cl_contests").doc("kec-r2").set({ selection_done_at: "2026-12-01T00:00:00.000Z" }, { merge: true });

  const res = await call(makeReq({ method: "POST", path: "/api/admin/retention-sweep",
    headers: { "x-api-key": "cl-sweep-key" }, body: {} }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(res.body.evidence_purged.some((r) => r.contest === "kec-r1"), "kec-r1 evidence purged");
  assert.ok(!res.body.evidence_purged.some((r) => r.contest === "kec-r2"), "kec-r2 not yet due");

  // kec-r1 evidence gone, stamped; kec-r2 intact
  assert.ok(![...storage._saved.keys()].some((k) => k.startsWith(prefix)), "kec-r1 evidence deleted");
  const contest = firestore._collections.get("cl_contests").get("kec-r1");
  assert.ok(contest.evidence_purged_at, "evidence_purged_at stamped on verified-empty listing");
  // results/snapshots survive (enrollment + person)
  assert.ok(firestore._collections.get("cl_enrollments").has(enrollmentIdOf("kec-r1", PID)), "enrollment survives evidence sweep");
});

test("retention-sweep: deletes export zips older than 10 days, keeps fresh ones", async () => {
  const { firestore, storage } = freshClients();
  seedContest(firestore, storage, "kec-r1");
  // stale zip (created 2026-05-01) + fresh zip (created 2026-06-11)
  storage._saved.set("exports/kec-r1/2026-05-01T00-00-00-000Z.zip", { body: "old", created: "2026-05-01T00:00:00.000Z" });
  storage._saved.set("exports/kec-r1/2026-06-11T00-00-00-000Z.zip", { body: "new", created: "2026-06-11T00:00:00.000Z" });

  const res = await call(makeReq({ method: "POST", path: "/api/admin/retention-sweep",
    headers: { "x-api-key": "cl-sweep-key" }, body: {} }));
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.exports_deleted >= 1, "at least the stale zip deleted");
  assert.equal(storage._saved.has("exports/kec-r1/2026-05-01T00-00-00-000Z.zip"), false, "stale zip deleted");
  assert.equal(storage._saved.has("exports/kec-r1/2026-06-11T00-00-00-000Z.zip"), true, "fresh zip kept");
});

test("retention-sweep: clears last_export/last_export_at when it deletes the zip a contest's stamp points at (stamp never outlives its artifact)", async () => {
  const { firestore, storage } = freshClients();
  seedContest(firestore, storage, "kec-r1");
  // Stamp the contest as exported, pointing at a STALE zip (created 2026-05-01).
  const staleKey = "exports/kec-r1/2026-05-01T00-00-00-000Z.zip";
  storage._saved.set(staleKey, { body: "old", created: "2026-05-01T00:00:00.000Z" });
  firestore.collection("cl_contests").doc("kec-r1").set({
    last_export_at: "2026-05-01T00:00:00.000Z",
    last_export: { at: "2026-05-01T00:00:00.000Z", gcs_key: staleKey, counts: { sessions: 1 } }
  }, { merge: true });

  const res = await call(makeReq({ method: "POST", path: "/api/admin/retention-sweep",
    headers: { "x-api-key": "cl-sweep-key" }, body: {} }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(storage._saved.has(staleKey), false, "the stale recovery zip was deleted");

  const contest = firestore._collections.get("cl_contests").get("kec-r1");
  assert.equal(contest.last_export_at, null, "last_export_at cleared so the purge gate can't pass on a gone artifact");
  assert.equal(contest.last_export, null, "last_export cleared");
});

test("retention-sweep: leaves last_export intact when the stamped zip is still within retention", async () => {
  const { firestore, storage } = freshClients();
  seedContest(firestore, storage, "kec-r1");
  const freshKey = "exports/kec-r1/2026-06-11T00-00-00-000Z.zip";
  storage._saved.set(freshKey, { body: "new", created: "2026-06-11T00:00:00.000Z" });
  firestore.collection("cl_contests").doc("kec-r1").set({
    last_export_at: "2026-06-11T00:00:00.000Z",
    last_export: { at: "2026-06-11T00:00:00.000Z", gcs_key: freshKey, counts: { sessions: 1 } }
  }, { merge: true });

  await call(makeReq({ method: "POST", path: "/api/admin/retention-sweep",
    headers: { "x-api-key": "cl-sweep-key" }, body: {} }));
  const contest = firestore._collections.get("cl_contests").get("kec-r1");
  assert.equal(contest.last_export_at, "2026-06-11T00:00:00.000Z", "fresh export stamp untouched");
  assert.ok(contest.last_export, "fresh last_export untouched");
  assert.equal(storage._saved.has(freshKey), true, "fresh zip kept");
});

test("retention-sweep: admin password also authorizes (manual trigger)", async () => {
  freshClients();
  const res = await call(makeReq({ method: "POST", path: "/api/admin/retention-sweep", headers: ADMIN_HEADERS, body: {} }));
  assert.equal(res.statusCode, 200, "admin can trigger the sweep manually");
});
