// backend/test/dtoIdentity.test.mjs — S-C slice 3: candidateOf across DTOs,
// submissions denorm, ingest candidate_id aliases, per-contest review-state
// ids, per-contest attendance.
// Specs: docs/superpowers/specs/2026-06-10-f9-identity-data-lifecycle-design.md
//          §1.2 (candidateOf dual-read adapter; ingest accepts both field names
//          forever), D7 (submissions denorm on NEW docs at submit time),
//          D17 ({norm}::{reviewerKey}::{slug} review ids; slugless = legacy)
//        docs/superpowers/specs/2026-06-10-f10-product-vision.md §2.11, §7 S-C
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.EVIDENCE_BUCKET = "di-bucket";
process.env.SESSION_COLLECTION = "di_sessions";
process.env.SETTINGS_COLLECTION = "di_settings";
process.env.CONTESTS_COLLECTION = "di_contests";
process.env.ROSTER_COLLECTION = "di_roster";
process.env.ALERTS_COLLECTION = "di_alerts";
process.env.SUBMISSIONS_COLLECTION = "di_submissions";
process.env.SUBMISSION_EVENTS_COLLECTION = "di_submission_events";
process.env.REVIEW_STATE_COLLECTION = "di_review_state";
process.env.REVIEW_COLLECTION = "di_reviews";
process.env.REVIEW_CLAIMS_COLLECTION = "di_review_claims";
process.env.LIVE_LOCK_COLLECTION = "di_live_locks";
process.env.COLLEGES_COLLECTION = "di_colleges";
process.env.PERSONS_COLLECTION = "di_persons";
process.env.ENROLLMENTS_COLLECTION = "di_enrollments";
process.env.ADMIN_AUDIT_COLLECTION = "di_audit";
process.env.ADMIN_PASSWORD = "di-admin-pass";
process.env.INVIGILATOR_PASSWORD = "di-invig-pass";
process.env.ALERTS_INGEST_API_KEY = "di-ingest-key";

const handler = await import("../src/handler.mjs?dtoidentity");
const { api, __setClientsForTest, __setJudge0AdapterForTest } = handler;

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
    if (isIncrementSentinel(value)) next[key] = Number(next[key] || 0) + value.operand;
    else next[key] = value;
  }
  return next;
}

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
              store.set(id, applyUpdate(existing, value));
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

const ADMIN_HEADERS = { "x-admin-password": "di-admin-pass" };
const INVIG_HEADERS = { "x-invigilator-password": "di-invig-pass" };
const INGEST_HEADERS = { "x-api-key": "di-ingest-key" };

function freshClients() {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  return { firestore, storage };
}

const PERSON_SESSION = {
  session_id: "p1",
  candidate_id: "21 CS 001",
  username_norm: "kec--21cs001",
  person_id: "kec--21cs001",
  college_norm: "kec",
  identity_label: "Roll Number",
  name: "Asha", roll_number: "", email: "asha@x.com",
  roster_unique_id: "21 CS 001", roster_verified: true,
  room: "Lab A", contest_slug: "kec-r1",
  storage_prefix: "contests/kec-r1/sessions/kec--21cs001/p1/",
  status: "active", created_at: "2026-06-10T02:00:00.000Z", chunk_count: 3
};
const LEGACY_ROSTER_SESSION = {
  session_id: "l1",
  hackerrank_username: "alice_hr",
  username_norm: "alice_hr",
  name: "Alice", roll_number: "21CS009", email: "alice@x.com",
  roster_unique_id: "21CS009", roster_verified: true,
  room: "Lab A", contest_slug: "",
  storage_prefix: "sessions/alice_hr/l1/",
  status: "active", created_at: "2026-06-10T01:00:00.000Z", chunk_count: 2
};
const LEGACY_PLAIN_SESSION = {
  session_id: "l2",
  hackerrank_username: "bob",
  username_norm: "bob",
  name: "Bob", roll_number: "", email: "bob@x.com",
  roster_unique_id: "", roster_verified: false,
  room: "Lab A", contest_slug: "",
  storage_prefix: "sessions/bob/l2/",
  status: "active", created_at: "2026-06-10T00:30:00.000Z", chunk_count: 0
};

async function seedSessions(firestore) {
  for (const session of [PERSON_SESSION, LEGACY_ROSTER_SESSION, LEGACY_PLAIN_SESSION]) {
    await firestore.collection("di_sessions").doc(session.session_id).set(session);
  }
}

// ---- candidateOf across DTOs -----------------------------------------------

test("sessions-list rows carry candidate_id via the dual-read adapter (person → candidate_id, legacy roster → roster id, plain → HR username)", async () => {
  const { firestore } = freshClients();
  await seedSessions(firestore);
  const res = await call(makeReq({ method: "GET", path: "/api/admin/sessions-list", headers: ADMIN_HEADERS }));
  assert.equal(res.statusCode, 200);
  const byId = new Map(res.body.sessions.map((s) => [s.session_id, s]));
  assert.equal(byId.get("p1").candidate_id, "21 CS 001");
  assert.equal(byId.get("p1").hackerrank_username, ""); // legacy alias stays present, empty for person docs
  assert.equal(byId.get("l1").candidate_id, "21CS009"); // roster id IS the candidate id concept
  assert.equal(byId.get("l1").hackerrank_username, "alice_hr"); // unchanged legacy field
  assert.equal(byId.get("l2").candidate_id, "bob");
});

test("recording-sessions rows carry candidate_id", async () => {
  const { firestore } = freshClients();
  await seedSessions(firestore);
  const res = await call(makeReq({ method: "GET", path: "/api/admin/recording-sessions", headers: ADMIN_HEADERS }));
  assert.equal(res.statusCode, 200);
  const person = res.body.sessions.find((s) => s.session_id === "p1");
  assert.equal(person.candidate_id, "21 CS 001");
});

test("session-detail carries candidate_id + identity_label + person_id + college_norm", async () => {
  const { firestore } = freshClients();
  await seedSessions(firestore);
  const res = await call(makeReq({ method: "GET", path: "/api/admin/session-detail", headers: ADMIN_HEADERS, query: { session_id: "p1" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.session.candidate_id, "21 CS 001");
  assert.equal(res.body.session.identity_label, "Roll Number");
  assert.equal(res.body.session.person_id, "kec--21cs001");
  assert.equal(res.body.session.college_norm, "kec");
  // Legacy rows label-fall back to the S-A interim label.
  const legacy = await call(makeReq({ method: "GET", path: "/api/admin/session-detail", headers: ADMIN_HEADERS, query: { session_id: "l2" } }));
  assert.equal(legacy.body.session.candidate_id, "bob");
  assert.equal(legacy.body.session.identity_label, "Candidate ID");
  assert.equal(legacy.body.session.person_id, null);
});

test("bulk session-details rows carry candidate_id; person sessions resolve by person norm", async () => {
  const { firestore } = freshClients();
  await seedSessions(firestore);
  const res = await call(makeReq({ method: "POST", path: "/api/admin/session-details", headers: ADMIN_HEADERS,
    body: { usernames: ["kec--21cs001", "bob"] } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.details[0].found, true);
  assert.equal(res.body.details[0].candidate_id, "21 CS 001");
  assert.equal(res.body.details[1].candidate_id, "bob");
});

test("invigilator room rows carry candidate_id", async () => {
  const { firestore } = freshClients();
  await seedSessions(firestore);
  const res = await call(makeReq({ method: "GET", path: "/api/invigilator/room", headers: INVIG_HEADERS, query: { room: "Lab A" } }));
  assert.equal(res.statusCode, 200);
  const person = res.body.sessions.find((s) => s.candidate_id === "21 CS 001");
  assert.ok(person, JSON.stringify(res.body.sessions));
});

// ---- sure-shot alerts from person sessions -----------------------------------

test("sure-shot alert raised from a person session carries the display candidate id (never undefined)", async () => {
  const { firestore } = freshClients();
  await seedSessions(firestore);
  const res = await call(makeReq({ method: "POST", path: "/api/events", body: {
    session_id: "p1",
    events: [{ type: "recording_stopped", timestamp: "2026-06-10T02:10:00.000Z" }]
  } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const alerts = [...firestore._collections.get("di_alerts").values()];
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].hackerrank_username, "21 CS 001"); // dual-read: display id, not undefined
  assert.equal(alerts[0].candidate_id, "21 CS 001");
  assert.equal(alerts[0].username_norm, "kec--21cs001");
  assert.match(alerts[0].id, /^proctor:recording_stopped:kec--21cs001:kec-r1:/);
});

// ---- ingest aliases (accepted FOREVER, F9 §1.2) -------------------------------

test("alerts ingest accepts candidate_id as an alias for hackerrank_username", async () => {
  const { firestore } = freshClients();
  const res = await call(makeReq({ method: "POST", path: "/api/alerts", headers: INGEST_HEADERS, body: { alerts: [{
    source: "contest-eval", type: "peer_copy", severity: "critical",
    timestamp: "2026-06-10T03:00:00.000Z", candidate_id: "21 CS 001",
    username_norm: "kec--21cs001", contest_slug: "kec-r1", title: "Peer copy suspected"
  }] } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const alert = [...firestore._collections.get("di_alerts").values()][0];
  assert.equal(alert.hackerrank_username, "21 CS 001"); // frozen field name still written
  assert.equal(alert.candidate_id, "21 CS 001");
  assert.equal(alert.username_norm, "kec--21cs001");
});

test("submission-events ingest accepts candidate_id as an alias", async () => {
  const { firestore } = freshClients();
  const res = await call(makeReq({ method: "POST", path: "/api/submission-events", headers: INGEST_HEADERS, body: { events: [{
    candidate_id: "21 CS 001", submission_id: 42, submitted_at: "2026-06-10T03:05:00.000Z",
    valid: true, contest_slug: "kec-r1"
  }] } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  // Doc id derivation is UNCHANGED (normalizeUsername of the display value) —
  // mapping poller events onto person norms is S-F scope; only the alias lands here.
  const doc = firestore._collections.get("di_submission_events").get("21_cs_001:kec-r1");
  assert.ok(doc, [...firestore._collections.get("di_submission_events").keys()].join(","));
  assert.equal(doc.events[0].hackerrank_username, "21 CS 001");
});

// ---- submissions denorm (F9 D7: NEW docs at submit time) ----------------------

test("exec submit denormalizes contest_slug + username_norm + candidate_id + person_id onto the stored submission", async () => {
  const { firestore } = freshClients();
  await seedSessions(firestore);
  __setJudge0AdapterForTest({ runBatch: async (items) => items.map(() => ({ passed: true, status: "accepted", timeSec: 0.1 })) });

  const person = await call(makeReq({ method: "POST", path: "/api/exec/submit", body: {
    session_id: "p1", problem_id: "sum-two", language: "python", source_code: "print(1)"
  } }));
  assert.equal(person.statusCode, 200, JSON.stringify(person.body));
  const stored = firestore._collections.get("di_submissions").get(person.body.submission_id);
  assert.equal(stored.contest_slug, "kec-r1");
  assert.equal(stored.username_norm, "kec--21cs001");
  assert.equal(stored.candidate_id, "21 CS 001");
  assert.equal(stored.person_id, "kec--21cs001");
  assert.equal(stored.problem_id, "sum-two");

  const legacy = await call(makeReq({ method: "POST", path: "/api/exec/submit", body: {
    session_id: "l2", problem_id: "sum-two", language: "python", source_code: "print(1)"
  } }));
  assert.equal(legacy.statusCode, 200, JSON.stringify(legacy.body));
  const legacyStored = firestore._collections.get("di_submissions").get(legacy.body.submission_id);
  assert.equal(legacyStored.contest_slug, "");
  assert.equal(legacyStored.username_norm, "bob");
  assert.equal(legacyStored.candidate_id, "bob");
  assert.equal(legacyStored.person_id, null);
  __setJudge0AdapterForTest(null);
});

// ---- per-contest review-state ids (F9 D17) -------------------------------------

async function createContest(name) {
  const res = await call(makeReq({ method: "POST", path: "/api/admin/contests", headers: ADMIN_HEADERS, body: { name } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body.contest;
}

test("review flow with a contest: roster::{slug} doc, {norm}::{slug} claims, {norm}::{reviewer}::{slug} review ids; legacy slugless data invisible to it and vice versa", async () => {
  const { firestore } = freshClients();
  const contest = await createContest("KEC Round 1");

  // A LEGACY review record + roster (slugless) pre-exist.
  await firestore.collection("di_review_state").doc("roster").set({
    entries: [{ username: "legacy_user", username_norm: "legacy_user" }], updated_at: "2026-06-09T00:00:00.000Z"
  });
  await firestore.collection("di_reviews").doc("legacy_user::old_reviewer").set({
    username: "legacy_user", username_norm: "legacy_user", reviewer_name: "Old Reviewer",
    verdict: 1, created_at: "2026-06-09T01:00:00.000Z", updated_at: "2026-06-09T01:00:00.000Z"
  });

  // Contest-scoped roster.
  const setRoster = await call(makeReq({ method: "POST", path: "/api/admin/review-roster", headers: ADMIN_HEADERS,
    body: { contest: contest.slug, usernames: ["kec--21cs001"] } }));
  assert.equal(setRoster.statusCode, 200, JSON.stringify(setRoster.body));
  assert.ok(firestore._collections.get("di_review_state").has(`roster::${contest.slug}`));

  // The scoped roster summary counts ONLY scoped reviews (none yet).
  const summary = await call(makeReq({ method: "GET", path: "/api/admin/review-roster", headers: ADMIN_HEADERS, query: { contest: contest.slug } }));
  assert.deepEqual(summary.body.usernames, ["kec--21cs001"]);
  assert.equal(summary.body.with_0_reviews, 1);

  // review-next claims under the contest-scoped claim id.
  const next = await call(makeReq({ method: "POST", path: "/api/admin/review-next", headers: ADMIN_HEADERS,
    body: { contest: contest.slug, reviewer_name: "Rev A" } }));
  assert.equal(next.body.username, "kec--21cs001");
  assert.ok(firestore._collections.get("di_review_claims").has(`kec--21cs001::${contest.slug}`));

  // Verdict lands under the suffixed review id with a contest_slug field.
  const verdict = await call(makeReq({ method: "POST", path: "/api/admin/review-verdict", headers: ADMIN_HEADERS,
    body: { contest: contest.slug, username: "kec--21cs001", reviewer_name: "Rev A", verdict: 1 } }));
  assert.equal(verdict.statusCode, 200, JSON.stringify(verdict.body));
  const reviewDoc = firestore._collections.get("di_reviews").get(`kec--21cs001::rev_a::${contest.slug}`);
  assert.ok(reviewDoc, [...firestore._collections.get("di_reviews").keys()].join(","));
  assert.equal(reviewDoc.contest_slug, contest.slug);
  assert.equal(firestore._collections.get("di_review_claims").has(`kec--21cs001::${contest.slug}`), false); // released

  // Scoped reads see ONLY the scoped record; legacy reads see ONLY the legacy one.
  const mineScoped = await call(makeReq({ method: "GET", path: "/api/admin/review-mine", headers: ADMIN_HEADERS,
    query: { contest: contest.slug, reviewer_name: "Rev A" } }));
  assert.equal(mineScoped.body.count, 1);
  const reviewsScoped = await call(makeReq({ method: "GET", path: "/api/admin/reviews", headers: ADMIN_HEADERS, query: { contest: contest.slug } }));
  assert.equal(reviewsScoped.body.reviews.length, 1);
  assert.equal(reviewsScoped.body.reviews[0].username, "kec--21cs001");
  const reviewsLegacy = await call(makeReq({ method: "GET", path: "/api/admin/reviews", headers: ADMIN_HEADERS }));
  assert.equal(reviewsLegacy.body.reviews.length, 1);
  assert.equal(reviewsLegacy.body.reviews[0].username, "legacy_user");

  // The legacy roster summary still reads the slugless roster doc.
  const legacySummary = await call(makeReq({ method: "GET", path: "/api/admin/review-roster", headers: ADMIN_HEADERS }));
  assert.deepEqual(legacySummary.body.usernames, ["legacy_user"]);
  assert.equal(legacySummary.body.with_1_review, 1);
});

// ---- per-contest attendance ------------------------------------------------------

test("attendance for a person contest joins ITS roster by person_id and reports college on absentees", async () => {
  const { firestore } = freshClients();
  // Create + open is not required for attendance; create + roster is enough.
  const contest = await createContest("KEC June 2026");
  const upload = await call(makeReq({ method: "POST", path: "/api/admin/roster", headers: ADMIN_HEADERS, body: {
    contest: contest.slug,
    unique_id_column: "unique_id",
    columns: ["college", "unique_id", "name", "email", "room"],
    column_mapping: { name: "name", email: "email", roll_number: "unique_id", room: "room" },
    rows: [
      { college: "KEC", unique_id: "21CS001", name: "Asha", email: "a@x.com", room: "Lab A" },
      { college: "KEC", unique_id: "21CS002", name: "Bala", email: "b@x.com", room: "Lab A" }
    ],
    college_resolutions: { kec: { action: "create" } }
  } }));
  assert.equal(upload.body.ok, true, JSON.stringify(upload.body));

  // person_id matches what THIS contest's roster derives (PERSON_ID_SEPARATOR
  // "~" — the wave-4 injectivity fix); the attendance join is by person_id.
  await firestore.collection("di_sessions").doc("a1").set({
    session_id: "a1", username_norm: "kec~21cs001", person_id: "kec~21cs001",
    candidate_id: "21CS001", contest_slug: contest.slug, status: "active",
    roster_unique_id: "21CS001", created_at: "2026-06-10T02:00:00.000Z"
  });

  const res = await call(makeReq({ method: "GET", path: "/api/admin/attendance", headers: ADMIN_HEADERS, query: { contest_slug: contest.slug } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.configured, true);
  assert.equal(res.body.contest_slug, contest.slug);
  assert.equal(res.body.roster_total, 2);
  assert.deepEqual(res.body.taken, { total: 1, in_progress: 1, completed: 0 });
  assert.equal(res.body.not_taken, 1);
  assert.deepEqual(res.body.absentees, [{ unique_id: "21CS002", name: "Bala", roll_number: "21CS002", room: "Lab A", college: "KEC" }]);

  // The GLOBAL legacy attendance path is untouched: no global roster → configured:false.
  const legacy = await call(makeReq({ method: "GET", path: "/api/admin/attendance", headers: ADMIN_HEADERS }));
  assert.deepEqual(legacy.body, { configured: false });
});

// ---- KPR 2026-06-12: attendance after a roster clear (enrollment-spine fallback)

test("attendance falls back to the enrollment spine when the roster was cleared — explicit source + note, never a silent blank", async () => {
  const { firestore } = freshClients();
  const contest = await createContest("KEC June 2026");
  const upload = await call(makeReq({ method: "POST", path: "/api/admin/roster", headers: ADMIN_HEADERS, body: {
    contest: contest.slug,
    unique_id_column: "unique_id",
    columns: ["college", "unique_id", "name", "email", "room"],
    column_mapping: { name: "name", email: "email", roll_number: "unique_id", room: "room" },
    rows: [
      { college: "KEC", unique_id: "21CS001", name: "Asha", email: "a@x.com", room: "Lab A" },
      { college: "KEC", unique_id: "21CS002", name: "Bala", email: "b@x.com", room: "Lab A" }
    ],
    college_resolutions: { kec: { action: "create" } }
  } }));
  assert.equal(upload.body.ok, true, JSON.stringify(upload.body));

  // Clear the roster (draft contest, no window → the F-B confirm gate stays off:
  // the pre-exam fix workflow keeps its friction-free clear).
  const cleared = await call(makeReq({ method: "POST", path: "/api/admin/roster", headers: ADMIN_HEADERS,
    body: { contest: contest.slug, clear: true } }));
  assert.equal(cleared.statusCode, 200, JSON.stringify(cleared.body));

  // One person-keyed session (taken, in progress) + one anonymous post-clear
  // session (unmatched — counted, never silently dropped).
  await firestore.collection("di_sessions").doc("a1").set({
    session_id: "a1", username_norm: "kec~21cs001", person_id: "kec~21cs001",
    candidate_id: "21CS001", contest_slug: contest.slug, status: "active",
    roster_unique_id: "21CS001", created_at: "2026-06-10T02:00:00.000Z"
  });
  await firestore.collection("di_sessions").doc("anon1").set({
    session_id: "anon1", username_norm: "23cs091", person_id: null,
    candidate_id: "23CS091", contest_slug: contest.slug, status: "ended",
    roster_unique_id: "", created_at: "2026-06-10T02:10:00.000Z"
  });

  const res = await call(makeReq({ method: "GET", path: "/api/admin/attendance", headers: ADMIN_HEADERS, query: { contest_slug: contest.slug } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.configured, true);          // NOT the old silent {configured:false}
  assert.equal(res.body.source, "enrollments");     // the admin knows what they're looking at
  assert.match(res.body.note, /roster .* cleared/i);
  assert.equal(res.body.roster_total, 2);
  assert.deepEqual(res.body.taken, { total: 1, in_progress: 1, completed: 0 });
  assert.equal(res.body.not_taken, 1);
  assert.deepEqual(res.body.absentees, [{ unique_id: "21CS002", name: "Bala", roll_number: "", room: "", college: "KEC" }]);
  assert.equal(res.body.unmatched_sessions, 1);
});

test("attendance: person contest with NO roster and NO enrollments stays configured:false", async () => {
  freshClients();
  const contest = await createContest("Bare Contest");
  const res = await call(makeReq({ method: "GET", path: "/api/admin/attendance", headers: ADMIN_HEADERS, query: { contest_slug: contest.slug } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { configured: false, contest_slug: contest.slug });
});
