// backend/test/identityCore.test.mjs — S-C slice 1: the identity core.
// Specs: docs/superpowers/specs/2026-06-10-f10-product-vision.md
//          §2.2 (College + canonicalization gate), §2.3 (Person), §2.8 (roster
//          validation order, LOCKED), §2.9 (Enrollment), §7 row S-C
//        docs/superpowers/specs/2026-06-10-f9-identity-data-lifecycle-design.md
//          D5 (dup hard-reject), D16 (proctor_admin_audit), D17 (roster_meta::{slug})
// Covers: proctor_colleges/persons/enrollments shapes, the per-contest roster
// upload pipeline (college column compulsory, canonicalization gate,
// duplicate-unique-id hard reject with row numbers, person upsert latest-wins +
// person_profile_updated audit rows, enrollment mint/remove/reactivate,
// roster_removed_mid_exam alert), composite-norm bounds (named acceptance task,
// vision §2.4), and the legacy global-roster path staying BIT-FOR-BIT.
import { test } from "node:test";
import assert from "node:assert/strict";

// Env BEFORE import; unique cache-buster for a fresh handler instance.
process.env.EVIDENCE_BUCKET = "ic-bucket";
process.env.SESSION_COLLECTION = "ic_sessions";
process.env.SETTINGS_COLLECTION = "ic_settings";
process.env.CONTESTS_COLLECTION = "ic_contests";
process.env.ROSTER_COLLECTION = "ic_roster";
process.env.ALERTS_COLLECTION = "ic_alerts";
process.env.COLLEGES_COLLECTION = "ic_colleges";
process.env.PERSONS_COLLECTION = "ic_persons";
process.env.ENROLLMENTS_COLLECTION = "ic_enrollments";
process.env.ADMIN_AUDIT_COLLECTION = "ic_audit";
process.env.ADMIN_PASSWORD = "ic-admin-pass";

const handler = await import("../src/handler.mjs?identitycore");
const { api, __setClientsForTest } = handler;
// handler.mjs?identitycore resolves ./identity.mjs WITHOUT a buster, so this
// import is the exact module instance the handler configured.
const { identityNorm, personIdOf, enrollmentIdOf, rosterMetaIdFor } = await import("../src/identity.mjs");

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
  function makeQuery(name, filters, ordering) {
    return {
      where(field, op, value) { return makeQuery(name, [...filters, { field, op, value }], ordering); },
      orderBy(field, direction) { return makeQuery(name, filters, { field, direction }); },
      limit() { return this; },
      async get() {
        const store = getCollection(name);
        let docs = [...store.values()];
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
      const store = getCollection(name);
      const query = makeQuery(name, []);
      return {
        where: query.where, orderBy: query.orderBy, limit: query.limit, get: query.get,
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
            async update(value) {
              const existing = store.get(id);
              if (!existing) throw new Error(`update of missing doc ${id}`);
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
            async save(contents) { saved.set(key, String(contents)); },
            async getSignedUrl() { return [`https://signed.example/${key}`]; },
            async download() { return [saved.get(key) || ""]; }
          };
        },
        async getFiles() { return [[]]; }
      };
    }
  };
}

const ADMIN_HEADERS = { "x-admin-password": "ic-admin-pass" };

async function createContest(name) {
  const res = await call(makeReq({ method: "POST", path: "/api/admin/contests", headers: ADMIN_HEADERS, body: { name } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body.contest;
}

function uploadReq(body) {
  return makeReq({ method: "POST", path: "/api/admin/roster", headers: ADMIN_HEADERS, body });
}

// Standard person-contest upload payload (template CSV shape, F8.3 amended).
function personUpload(contestSlug, rows, extra = {}) {
  return {
    contest: contestSlug,
    unique_id_column: "unique_id",
    columns: ["college", "unique_id", "name", "email", "room"],
    column_mapping: { name: "name", email: "email", room: "room" },
    rows,
    ...extra
  };
}

const ROW_ASHA = { college: "KEC", unique_id: "21 CS 001", name: "Asha", email: "asha@x.com", room: "Lab A" };
const ROW_BALA = { college: "KEC", unique_id: "21CS002", name: "Bala", email: "bala@x.com", room: "Lab A" };

function freshClients() {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  return { firestore, storage };
}

// ---- identityNorm + composite-norm bounds (vision §2.4 named acceptance task) ----

test("identityNorm: golden table (whitespace, case, sanitize collapse, all-dots, >120 chars)", () => {
  assert.equal(identityNorm("21 CS 001"), "21cs001");
  assert.equal(identityNorm("  21cs001  "), "21cs001");
  assert.equal(identityNorm("21CS001"), "21cs001");
  assert.equal(identityNorm("a#1"), "a_1");
  assert.equal(identityNorm("a$1"), "a_1"); // sanitize collapse: a#1 ≡ a$1 (dup-reject catches at upload)
  assert.equal(identityNorm("a@b.c"), "a_b.c"); // sanitizeSegment maps @ → _ (frozen handler behavior)
  assert.equal(identityNorm(".."), "_");
  assert.equal(identityNorm(""), "_");
  assert.equal(identityNorm("..."), "_");
  const long = "X".repeat(300);
  assert.equal(identityNorm(long), "x".repeat(120)); // sanitizeSegment caps at 120
});

test("composite norm bounds: person_id is sanitize-stable, under Firestore doc-id and GCS path limits", () => {
  const collegeNorm = identityNorm("C".repeat(300)); // worst case: 120 chars
  const uniqueIdNorm = identityNorm("U".repeat(300)); // worst case: 120 chars
  const personId = personIdOf(collegeNorm, uniqueIdNorm);
  assert.equal(personId, `${"c".repeat(120)}--${"u".repeat(120)}`);
  assert.equal(personId.length, 242);
  // person_id must be doc-id/path-safe BY CONSTRUCTION: re-sanitizing each
  // component is a no-op, and the "--" separator is in the safe charset.
  assert.match(personId, /^[a-zA-Z0-9@._-]+$/);
  // Firestore doc id limit: 1500 bytes. Worst enrollment id = slug(<=200) + "::" + person_id.
  const worstSlug = "s".repeat(200);
  assert.ok(Buffer.byteLength(enrollmentIdOf(worstSlug, personId)) < 1500);
  assert.ok(Buffer.byteLength(rosterMetaIdFor(worstSlug)) < 1500);
  // GCS object name limit: 1024 bytes. Worst storage prefix + the longest
  // chunk-ish suffix stays under it ONLY for realistic slugs — pin the real
  // bound: prefix = contests/{slug}/sessions/{person_id}/{uuid}/ then suffix.
  const prefix = `contests/${worstSlug}/sessions/${personId}/${"a".repeat(36)}/`;
  assert.ok(Buffer.byteLength(`${prefix}camera/chunk-00000.webm`) < 1024);
});

// ---- per-contest roster upload: validation order (LOCKED, vision §2.8) ----

test("upload without a college column → 400 college_column_required, nothing written", async () => {
  const { firestore } = freshClients();
  const contest = await createContest("KEC June 2026");
  const res = await call(uploadReq({
    contest: contest.slug,
    unique_id_column: "unique_id",
    columns: ["unique_id", "name"],
    column_mapping: { name: "name" },
    rows: [{ unique_id: "21CS001", name: "Asha" }]
  }));
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "college_column_required");
  assert.equal(firestore._collections.get("ic_persons"), undefined);
});

test("blank college cells → 400 college_required with 1-based row numbers", async () => {
  freshClients();
  const contest = await createContest("KEC June 2026");
  const res = await call(uploadReq(personUpload(contest.slug, [
    ROW_ASHA,
    { ...ROW_BALA, college: "" },
    { college: "", unique_id: "21CS003", name: "Cara", email: "c@x.com", room: "" }
  ])));
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "college_required");
  assert.deepEqual(res.body.rows, [2, 3]);
});

test("college canonicalization gate: unknown college → needs_college_confirmation preview, NOTHING written", async () => {
  const { firestore } = freshClients();
  const contest = await createContest("KEC June 2026");
  const res = await call(uploadReq(personUpload(contest.slug, [ROW_ASHA, ROW_BALA])));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.needs_college_confirmation, true);
  assert.deepEqual(res.body.new_colleges, [
    { college_norm: "kec", name: "KEC", names: ["KEC"], rows: 2 }
  ]);
  assert.deepEqual(res.body.known_colleges, []);
  // preview only — no person/college/enrollment/roster writes, no meta
  for (const colName of ["ic_colleges", "ic_persons", "ic_enrollments"]) {
    assert.equal(firestore._collections.get(colName)?.size ?? 0, 0, colName);
  }
  assert.equal(firestore._collections.get("ic_settings").has(rosterMetaIdFor(contest.slug)), false);
});

test("confirmed re-post with create resolution: colleges/persons/enrollments/entries/meta written with exact shapes", async () => {
  const { firestore } = freshClients();
  const contest = await createContest("KEC June 2026");
  const res = await call(uploadReq(personUpload(contest.slug, [ROW_ASHA, ROW_BALA], {
    college_resolutions: { kec: { action: "create" } }
  })));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
  assert.equal(res.body.count, 2);
  assert.deepEqual(res.body.colleges_created, ["kec"]);
  assert.deepEqual(res.body.persons, { created: 2, updated: 0 });
  assert.deepEqual(res.body.enrollments, { created: 2, reactivated: 0, removed: 0 });

  // College doc (vision §2.2 shape exactly)
  const college = firestore._collections.get("ic_colleges").get("kec");
  assert.equal(college.college_norm, "kec");
  assert.equal(college.name, "KEC");
  assert.equal(college.source, "roster_upload");
  assert.ok(college.created_at);

  // Person doc (vision §2.3 shape: components stored as fields, never parsed)
  const personId = personIdOf("kec", "21cs001");
  assert.equal(personId, "kec--21cs001");
  const person = firestore._collections.get("ic_persons").get(personId);
  assert.equal(person.person_id, personId);
  assert.equal(person.college_norm, "kec");
  assert.equal(person.unique_id, "21 CS 001"); // display form preserved
  assert.equal(person.unique_id_norm, "21cs001");
  assert.equal(person.name, "Asha");
  assert.equal(person.email, "asha@x.com");
  assert.deepEqual(person.created_from, { contest_slug: contest.slug, roster_version: person.created_from.roster_version });
  assert.equal(person.merged_into, null); // alias pointer reserved day one
  assert.ok(person.created_at && person.updated_at);

  // Enrollment doc (vision §2.9 shape, doc id {contest_slug}::{person_id})
  const enrollment = firestore._collections.get("ic_enrollments").get(enrollmentIdOf(contest.slug, personId));
  assert.deepEqual(enrollment, {
    contest_slug: contest.slug,
    person_id: personId,
    college_norm: "kec",
    status: "active",
    source: "csv",
    selection_status: "none",
    selection_updated_at: null,
    selection_by: null,
    final_snapshot: null,
    created_at: enrollment.created_at
  });

  // Roster entry: id scheme unchanged (v{version}:{idnorm}, idnorm = person_id)
  const meta = firestore._collections.get("ic_settings").get(rosterMetaIdFor(contest.slug));
  assert.equal(meta.configured, true);
  assert.equal(meta.college_column, "college");
  assert.equal(meta.count, 2);
  const entry = firestore._collections.get("ic_roster").get(`v${meta.version}:${personId}`);
  assert.equal(entry.person_id, personId);
  assert.equal(entry.college, "KEC");
  assert.equal(entry.college_norm, "kec");
  assert.equal(entry.contest_slug, contest.slug);
  assert.equal(entry.unique_id, "21 CS 001");
  assert.equal(entry.unique_id_norm, "21cs001");

  // Contest doc gains derived read-only colleges list (vision §2.7)
  const contestDoc = firestore._collections.get("ic_contests").get(contest.slug);
  assert.deepEqual(contestDoc.colleges, ["kec"]);
});

test("exact-norm college match links silently; map resolution folds spelling variants onto an existing college", async () => {
  const { firestore } = freshClients();
  const contest = await createContest("KEC June 2026");
  // Seed the college via a first confirmed upload.
  await call(uploadReq(personUpload(contest.slug, [ROW_ASHA], { college_resolutions: { kec: { action: "create" } } })));

  // "kec" exact-norm match → NO confirmation needed even with new rows.
  const silent = await call(uploadReq(personUpload(contest.slug, [ROW_ASHA, ROW_BALA])));
  assert.equal(silent.statusCode, 200);
  assert.equal(silent.body.ok, true);

  // "K.E.C." norms to "k.e.c." → unmatched → gate; mapping to "kec" reuses it.
  const drift = { ...ROW_BALA, college: "K.E.C." };
  const blocked = await call(uploadReq(personUpload(contest.slug, [ROW_ASHA, drift])));
  assert.equal(blocked.body.needs_college_confirmation, true);
  assert.deepEqual(blocked.body.new_colleges, [{ college_norm: "k.e.c.", name: "K.E.C.", names: ["K.E.C."], rows: 1 }]);
  assert.deepEqual(blocked.body.known_colleges, [{ college_norm: "kec", name: "KEC" }]);

  const mapped = await call(uploadReq(personUpload(contest.slug, [ROW_ASHA, drift], {
    college_resolutions: { "k.e.c.": { action: "map", college_norm: "kec" } }
  })));
  assert.equal(mapped.statusCode, 200, JSON.stringify(mapped.body));
  assert.equal(mapped.body.ok, true);
  // No k.e.c. college doc was created; Bala landed under kec.
  assert.equal(firestore._collections.get("ic_colleges").has("k.e.c."), false);
  assert.ok(firestore._collections.get("ic_persons").has(personIdOf("kec", "21cs002")));
});

test("duplicate (college, unique_id) on FINAL-norm form → 400 duplicate_unique_ids with row numbers (whole file rejected)", async () => {
  const { firestore } = freshClients();
  const contest = await createContest("KEC June 2026");
  const res = await call(uploadReq(personUpload(contest.slug, [
    ROW_ASHA,                                                  // row 1: 21 CS 001
    ROW_BALA,                                                  // row 2
    { ...ROW_ASHA, unique_id: "21cs001", name: "Imposter" },   // row 3: same final norm as row 1
    { ...ROW_BALA, unique_id: " 21CS002 ", name: "Echo" }      // row 4: same final norm as row 2
  ], { college_resolutions: { kec: { action: "create" } } })));
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "duplicate_unique_ids");
  assert.deepEqual(res.body.duplicates, [
    { row: 3, college: "KEC", unique_id: "21cs001", conflicts_with_row: 1 },
    { row: 4, college: "KEC", unique_id: "21CS002", conflicts_with_row: 2 }
  ]);
  // HARD reject: nothing was written, not even the colleges.
  assert.equal(firestore._collections.get("ic_persons")?.size ?? 0, 0);
  assert.equal(firestore._collections.get("ic_enrollments")?.size ?? 0, 0);
});

test("same unique_id under DIFFERENT colleges in one roster: allowed, warned, distinct person_ids (canary a)", async () => {
  const { firestore } = freshClients();
  const contest = await createContest("Shared Drive");
  const res = await call(uploadReq(personUpload(contest.slug, [
    { college: "KEC", unique_id: "21CS001", name: "Asha", email: "a@x.com", room: "" },
    { college: "PSG Tech", unique_id: "21CS001", name: "Priya", email: "p@y.com", room: "" }
  ], { college_resolutions: { kec: { action: "create" }, psgtech: { action: "create" } } })));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.ambiguous_ids, [{ unique_id_norm: "21cs001", colleges: ["kec", "psgtech"] }]);
  // Two persons, two enrollments — no collision by construction.
  assert.ok(firestore._collections.get("ic_persons").has("kec--21cs001"));
  assert.ok(firestore._collections.get("ic_persons").has("psgtech--21cs001"));
  assert.equal(firestore._collections.get("ic_enrollments").size, 2);
});

test("profile latest-wins + person_profile_updated audit row on name/email change", async () => {
  const { firestore } = freshClients();
  const contest = await createContest("KEC June 2026");
  await call(uploadReq(personUpload(contest.slug, [ROW_ASHA], { college_resolutions: { kec: { action: "create" } } })));
  assert.equal(firestore._collections.get("ic_audit")?.size ?? 0, 0);

  // Re-upload with a changed name + email → person updated, audit row written.
  const renamed = { ...ROW_ASHA, name: "Asha R", email: "asha.r@x.com" };
  const res = await call(uploadReq(personUpload(contest.slug, [renamed])));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.persons, { created: 0, updated: 1 });
  const person = firestore._collections.get("ic_persons").get("kec--21cs001");
  assert.equal(person.name, "Asha R");
  assert.equal(person.email, "asha.r@x.com");
  const audits = [...firestore._collections.get("ic_audit").values()];
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "person_profile_updated");
  assert.equal(audits[0].person_id, "kec--21cs001");
  assert.equal(audits[0].contest_slug, contest.slug);
  assert.deepEqual(audits[0].changes, {
    name: { from: "Asha", to: "Asha R" },
    email: { from: "asha@x.com", to: "asha.r@x.com" }
  });
  assert.ok(audits[0].roster_version);
  assert.ok("actor_ip" in audits[0] && "actor_ua" in audits[0]);

  // Identical re-upload → NO new audit row (only real changes leave a trail).
  await call(uploadReq(personUpload(contest.slug, [renamed])));
  assert.equal(firestore._collections.get("ic_audit").size, 1);
});

test("re-upload removal semantics: dropped person → enrollment removed (kept); re-add reactivates; in-flight session raises roster_removed_mid_exam", async () => {
  const { firestore } = freshClients();
  const contest = await createContest("KEC June 2026");
  await call(uploadReq(personUpload(contest.slug, [ROW_ASHA, ROW_BALA], { college_resolutions: { kec: { action: "create" } } })));

  // Bala has an in-flight session under the person norm.
  await firestore.collection("ic_sessions").doc("sess-bala").set({
    session_id: "sess-bala", username_norm: "kec--21cs002", contest_slug: contest.slug,
    candidate_id: "21CS002", status: "active", room: "Lab A", created_at: "2026-06-10T01:00:00.000Z"
  });

  // Re-upload WITHOUT Bala → enrollment marked removed (never deleted) + alert.
  const res = await call(uploadReq(personUpload(contest.slug, [ROW_ASHA])));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.enrollments, { created: 0, reactivated: 0, removed: 1 });
  const enrollment = firestore._collections.get("ic_enrollments").get(enrollmentIdOf(contest.slug, "kec--21cs002"));
  assert.equal(enrollment.status, "removed");
  assert.ok(enrollment.removed_at);
  const alerts = [...firestore._collections.get("ic_alerts").values()];
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, "roster_removed_mid_exam");
  assert.equal(alerts[0].username_norm, "kec--21cs002");
  assert.equal(alerts[0].contest_slug, contest.slug);
  assert.equal(alerts[0].session_id, "sess-bala");

  // Re-adding Bala reactivates the SAME enrollment doc.
  const back = await call(uploadReq(personUpload(contest.slug, [ROW_ASHA, ROW_BALA])));
  assert.deepEqual(back.body.enrollments, { created: 0, reactivated: 1, removed: 0 });
  const reactivated = firestore._collections.get("ic_enrollments").get(enrollmentIdOf(contest.slug, "kec--21cs002"));
  assert.equal(reactivated.status, "active");
  assert.equal(reactivated.removed_at, null);
});

test("blank unique_id rows: skip-with-report (1-based rows), college gate unaffected", async () => {
  freshClients();
  const contest = await createContest("KEC June 2026");
  const res = await call(uploadReq(personUpload(contest.slug, [
    ROW_ASHA,
    { college: "KEC", unique_id: "", name: "NoId", email: "", room: "" }
  ], { college_resolutions: { kec: { action: "create" } } })));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.count, 1);
  assert.deepEqual(res.body.skipped, [{ row: 2, reason: "empty_unique_id" }]);
});

test("same person across two contests joins BOTH enrollments under the same person doc (canary b)", async () => {
  const { firestore } = freshClients();
  const round1 = await createContest("KEC Round 1");
  const round2 = await createContest("KEC Round 2");
  await call(uploadReq(personUpload(round1.slug, [ROW_ASHA], { college_resolutions: { kec: { action: "create" } } })));
  const res = await call(uploadReq(personUpload(round2.slug, [ROW_ASHA])));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const personId = "kec--21cs001";
  assert.equal(firestore._collections.get("ic_persons").size, 1); // ONE durable person
  assert.ok(firestore._collections.get("ic_enrollments").has(enrollmentIdOf(round1.slug, personId)));
  assert.ok(firestore._collections.get("ic_enrollments").has(enrollmentIdOf(round2.slug, personId)));
  // created_from preserves the FIRST contest (upsert never rewrites identity).
  assert.equal(firestore._collections.get("ic_persons").get(personId).created_from.contest_slug, round1.slug);
});

test("per-contest GET /api/admin/roster?contest= returns that contest's meta summary", async () => {
  freshClients();
  const contest = await createContest("KEC June 2026");
  const empty = await call(makeReq({ method: "GET", path: "/api/admin/roster", headers: ADMIN_HEADERS, query: { contest: contest.slug } }));
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.body, { configured: false, contest: contest.slug });

  await call(uploadReq(personUpload(contest.slug, [ROW_ASHA], { college_resolutions: { kec: { action: "create" } } })));
  const res = await call(makeReq({ method: "GET", path: "/api/admin/roster", headers: ADMIN_HEADERS, query: { contest: contest.slug } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.configured, true);
  assert.equal(res.body.contest, contest.slug);
  assert.equal(res.body.count, 1);
  assert.equal(res.body.college_column, "college");
  assert.equal(res.body.unique_id_column, "unique_id");
});

test("per-contest clear: purges the active version's entries + flips meta off; enrollments stay (durable rows)", async () => {
  const { firestore } = freshClients();
  const contest = await createContest("KEC June 2026");
  await call(uploadReq(personUpload(contest.slug, [ROW_ASHA], { college_resolutions: { kec: { action: "create" } } })));
  const res = await call(uploadReq({ contest: contest.slug, clear: true }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.configured, false);
  assert.equal(firestore._collections.get("ic_roster").size, 0); // PII purged
  const meta = firestore._collections.get("ic_settings").get(rosterMetaIdFor(contest.slug));
  assert.equal(meta.configured, false);
  assert.equal(firestore._collections.get("ic_enrollments").size, 1); // never deleted
});

test("per-contest roster upload refuses the legacy contest and unknown contests", async () => {
  const { firestore } = freshClients();
  // Legacy settings doc exists → a synthesized legacy contest with slug "legacy".
  await firestore.collection("ic_settings").doc("active").set({
    start_at: "2026-06-10T03:30:00.000Z", end_at: "2026-06-10T06:30:00.000Z"
  });
  const legacy = await call(uploadReq(personUpload("legacy", [ROW_ASHA])));
  assert.equal(legacy.statusCode, 400);
  assert.equal(legacy.body.error, "per_contest_roster_requires_person_contest");

  const unknown = await call(uploadReq(personUpload("nope", [ROW_ASHA])));
  assert.equal(unknown.statusCode, 400);
  assert.equal(unknown.body.error, "unknown_contest");
});

// ---- LEGACY canary: the global roster path is BIT-FOR-BIT today's behavior ----

test("legacy upload (no contest) writes EXACTLY today's docs: no persons, no colleges, no enrollments, global meta, v{version}:{idnorm} entries", async () => {
  const { firestore } = freshClients();
  const res = await call(uploadReq({
    unique_id_column: "unique_id",
    columns: ["unique_id", "name"],
    column_mapping: { name: "name" },
    rows: [{ unique_id: "21 CS 001", name: "Asha" }, { unique_id: "21 CS 001", name: "Dup" }]
  }));
  assert.equal(res.statusCode, 200);
  // Today's semantics: duplicate is a SKIP (not a hard reject) on the legacy path.
  assert.deepEqual(res.body, {
    ok: true, configured: true, count: 1,
    skipped: [{ row: 1, reason: "duplicate_unique_id" }] // legacy 0-based row index
  });
  // Global meta doc id, legacy entry id shape (no person component).
  const meta = firestore._collections.get("ic_settings").get("roster_meta");
  assert.equal(meta.configured, true);
  const entry = firestore._collections.get("ic_roster").get(`v${meta.version}:21cs001`);
  assert.deepEqual(Object.keys(entry).sort(), ["created_at", "fields", "roster_version", "unique_id", "unique_id_norm"]);
  // The person layer NEVER engages on the legacy path.
  for (const colName of ["ic_colleges", "ic_persons", "ic_enrollments", "ic_audit"]) {
    assert.equal(firestore._collections.get(colName)?.size ?? 0, 0, colName);
  }
});
