// backend/test/canaryIsolation.test.mjs — S-C: the no-bleed ACCEPTANCE BAR
// (F9 §2.3.4 canary isolation suite + coverage meta-test; F10 §7 row S-C).
//
// Two contests, the SAME candidate id in both; every contest-B doc embeds the
// sentinel "BLEED-CANARY-B". Every contest-scoped admin/invigilator GET in the
// maintained plain endpoint-name list below is called scoped to contest A and
// its serialized response must contain ZERO canary occurrences.
//
// The COVERAGE META-TEST diffs that list against the handler's actual GET
// route table: a new contest-scoped GET that is not categorized (scoped with a
// canary request, or explicitly exempted with a reason) FAILS CI.
//
// Canary sub-properties (a) distinct person_ids for the same roll under two
// colleges and (b) one person joining two contests' enrollments are pinned in
// identityCore.test.mjs; this file owns (c) endpoint isolation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.EVIDENCE_BUCKET = "cn-bucket";
process.env.SESSION_COLLECTION = "cn_sessions";
process.env.SETTINGS_COLLECTION = "cn_settings";
process.env.CONTESTS_COLLECTION = "cn_contests";
process.env.ROSTER_COLLECTION = "cn_roster";
process.env.ALERTS_COLLECTION = "cn_alerts";
process.env.SUBMISSION_EVENTS_COLLECTION = "cn_submission_events";
process.env.REVIEW_STATE_COLLECTION = "cn_review_state";
process.env.REVIEW_COLLECTION = "cn_reviews";
process.env.REVIEW_CLAIMS_COLLECTION = "cn_review_claims";
process.env.COLLEGES_COLLECTION = "cn_colleges";
process.env.PERSONS_COLLECTION = "cn_persons";
process.env.ENROLLMENTS_COLLECTION = "cn_enrollments";
process.env.ADMIN_AUDIT_COLLECTION = "cn_audit";
process.env.ADMIN_PASSWORD = "cn-admin-pass";
process.env.INVIGILATOR_PASSWORD = "cn-invig-pass";

const handler = await import("../src/handler.mjs?canary");
const { api, __setClientsForTest } = handler;

const HANDLER_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "handler.mjs"),
  "utf8"
);

const CANARY = "BLEED-CANARY-B";
const A = "contest-a";
const B = "contest-b";

// ---- THE LIST (plain endpoint names — F9 §2.3.4 deliberately NOT a ROUTES
// refactor). Keys are the contest-scoped GET endpoints; values build the
// contest-A-scoped request the canary suite fires.
const ADMIN_HEADERS = { "x-admin-password": "cn-admin-pass" };
const INVIG_HEADERS = { "x-invigilator-password": "cn-invig-pass" };
const SCOPED_GET_REQUESTS = {
  "/api/admin/alerts": () => adminGet("/api/admin/alerts", { contest_slug: A }),
  "/api/admin/attendance": () => adminGet("/api/admin/attendance", { contest_slug: A }),
  "/api/admin/ip-report": () => adminGet("/api/admin/ip-report", { contest_slug: A, scope: "all" }),
  "/api/admin/recording-sessions": () => adminGet("/api/admin/recording-sessions", { contest_slug: A }),
  "/api/admin/review-mine": () => adminGet("/api/admin/review-mine", { contest: A, reviewer_name: "Rev" }),
  "/api/admin/review-roster": () => adminGet("/api/admin/review-roster", { contest: A }),
  "/api/admin/reviews": () => adminGet("/api/admin/reviews", { contest: A }),
  "/api/admin/roster": () => adminGet("/api/admin/roster", { contest: A }),
  "/api/admin/sessions-list": () => adminGet("/api/admin/sessions-list", { contest_slug: A }),
  "/api/admin/stats": () => adminGet("/api/admin/stats", { contest_slug: A }),
  "/api/admin/submission-events": () => adminGet("/api/admin/submission-events", { username: "21 CS 001", contest_slug: A }),
  // Invigilator endpoints scope to the SETTINGS contest (per-contest token auth
  // lands at S-D) — the fixture pins settings.contest_slug = contest A.
  "/api/invigilator/overview": () => makeReq({ method: "GET", path: "/api/invigilator/overview", headers: INVIG_HEADERS }),
  "/api/invigilator/room": () => makeReq({ method: "GET", path: "/api/invigilator/room", headers: INVIG_HEADERS, query: { room: "Lab A" } })
};

// GET endpoints that are NOT contest-scoped — each with the reason it is
// exempt. A new GET route must land in exactly one of these two tables.
const EXEMPT_GETS = {
  "/api/exam-config": "legacy/public pre-session config; ?contest= routing lands at S-D",
  "/api/candidate-route": "public routing boolean (does the legacy settings doc exist?) — carries no contest data at all",
  "/api/admin/settings": "the global legacy settings doc itself",
  "/api/admin/contests": "the contest list — inherently cross-contest",
  "/api/admin/problems": "global problem bank (assignment is per-contest, content is not)",
  "/api/admin/problem": "global problem bank",
  "/api/admin/templates": "global template library (S-I §1.1) — blueprints, not contest data; contests SNAPSHOT from them",
  "/api/admin/template": "global template library (S-I §1.1)",
  "/api/admin/alert-settings": "GLOBAL alert-type config (F8 decision 5)",
  "/api/admin/sessions": "username search across contests BY DESIGN (F9 D10); person norms are contest-distinct so person data cannot collide",
  "/api/admin/session-detail": "keyed by unguessable session_id (the bearer token)",
  "/api/admin/session-events": "keyed by unguessable session_id"
};

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
function adminGet(path, query) {
  return makeReq({ method: "GET", path, headers: ADMIN_HEADERS, query });
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
  return {
    bucket() {
      return {
        file(key) {
          return {
            async save() {},
            async getSignedUrl() { return [`https://signed.example/${key}`]; },
            async download() { return [""]; }
          };
        },
        async getFiles() { return [[]]; }
      };
    }
  };
}

// ---- two-contest fixture --------------------------------------------------------

async function seedTwoContestFixture() {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  const now = "2026-06-10T02:00:00.000Z";

  for (const slug of [A, B]) {
    await firestore.collection("cn_contests").doc(slug).set({
      slug, name: slug, status: "open", listed: true,
      identity_mode: "person", identity_label: "Roll Number", access_code: null,
      start_at: "2026-06-10T00:00:00.000Z", end_at: "2026-06-10T08:00:00.000Z",
      room_gate_enabled: false, rooms: [], created_at: now, updated_at: now
    });
  }
  // Invigilator endpoints scope off the settings doc — pin it to contest A.
  await firestore.collection("cn_settings").doc("active").set({ contest_slug: A });

  // SAME person/candidate id in BOTH contests (the F9 §2.3.4 seed).
  const sessionBase = {
    username_norm: "kec--21cs001", person_id: "kec--21cs001", college_norm: "kec",
    candidate_id: "21 CS 001", roster_unique_id: "21 CS 001", roster_verified: true,
    identity_label: "Roll Number", status: "active", consent_accepted: true,
    chunk_count: 1, created_at: now
  };
  await firestore.collection("cn_sessions").doc("sa").set({
    ...sessionBase, session_id: "sa", contest_slug: A, name: "Asha", room: "Lab A",
    start_ip: "10.0.0.1", current_ip: "10.0.0.1",
    storage_prefix: `contests/${A}/sessions/kec--21cs001/sa/`
  });
  await firestore.collection("cn_sessions").doc("sb").set({
    ...sessionBase, session_id: "sb", contest_slug: B, name: CANARY, room: `${CANARY} Hall`,
    start_ip: "10.9.9.9", current_ip: "10.9.9.9", email: `${CANARY}@x.com`,
    storage_prefix: `contests/${B}/sessions/kec--21cs001/sb/`
  });

  // Alerts.
  await firestore.collection("cn_alerts").doc("al-a").set({
    id: "al-a", source: "proctor", type: "recording_stopped", severity: "critical",
    timestamp: now, received_at: now, hackerrank_username: "21 CS 001", candidate_id: "21 CS 001",
    username_norm: "kec--21cs001", title: "Recording stopped", contest_slug: A, room: "Lab A"
  });
  await firestore.collection("cn_alerts").doc("al-b").set({
    id: "al-b", source: "proctor", type: "recording_stopped", severity: "critical",
    timestamp: now, received_at: now, hackerrank_username: "21 CS 001", candidate_id: "21 CS 001",
    username_norm: "kec--21cs001", title: `${CANARY} alert`, detail: CANARY,
    contest_slug: B, room: `${CANARY} Hall`
  });

  // Submission events (same user, both contests; B carries the sentinel).
  await firestore.collection("cn_submission_events").doc("21_cs_001:contest-a").set({
    username_norm: "21_cs_001", contest_slug: A, updated_at: now,
    events: [{ submission_id: "1", hackerrank_username: "21 CS 001", valid: true, submitted_at: now, challenge_name: "two-sum" }]
  });
  await firestore.collection("cn_submission_events").doc("21_cs_001:contest-b").set({
    username_norm: "21_cs_001", contest_slug: B, updated_at: now,
    events: [{ submission_id: "2", hackerrank_username: "21 CS 001", valid: true, submitted_at: now, challenge_name: CANARY }]
  });

  // Per-contest rosters (meta + active-version entries).
  await firestore.collection("cn_settings").doc(`roster_meta::${A}`).set({
    configured: true, contest_slug: A, version: "va",
    unique_id_column: "unique_id", college_column: "college",
    column_mapping: { name: "name", college: "college" },
    columns: ["college", "unique_id", "name"], count: 1, updated_at: now
  });
  await firestore.collection("cn_roster").doc("vva:kec--21cs001").set({
    unique_id: "21 CS 001", unique_id_norm: "21cs001", college: "KEC", college_norm: "kec",
    person_id: "kec--21cs001", contest_slug: A, roster_version: "va",
    fields: { college: "KEC", unique_id: "21 CS 001", name: "Asha" }, created_at: now
  });
  await firestore.collection("cn_settings").doc(`roster_meta::${B}`).set({
    configured: true, contest_slug: B, version: "vb",
    unique_id_column: "unique_id", college_column: "college",
    column_mapping: { name: "name", college: "college" },
    columns: ["college", "unique_id", "name", `${CANARY}-col`], count: 2, updated_at: now
  });
  await firestore.collection("cn_roster").doc("vvb:kec--21cs001").set({
    unique_id: "21 CS 001", unique_id_norm: "21cs001", college: "KEC", college_norm: "kec",
    person_id: "kec--21cs001", contest_slug: B, roster_version: "vb",
    fields: { college: "KEC", unique_id: "21 CS 001", name: CANARY, [`${CANARY}-col`]: CANARY }, created_at: now
  });
  // A second B-rostered person with NO session: B's attendance absentee list
  // carries the canary (keeps the attendance positive control meaningful).
  await firestore.collection("cn_roster").doc("vvb:kec--99xx999").set({
    unique_id: "99 XX 999", unique_id_norm: "99xx999", college: "KEC", college_norm: "kec",
    person_id: "kec--99xx999", contest_slug: B, roster_version: "vb",
    fields: { college: "KEC", unique_id: "99 XX 999", name: `${CANARY} Absentee` }, created_at: now
  });

  // Per-contest review state (S-C suffixed ids) for both contests.
  await firestore.collection("cn_review_state").doc(`roster::${A}`).set({
    entries: [{ username: "21 CS 001", username_norm: "21_cs_001" }], contest_slug: A, updated_at: now
  });
  await firestore.collection("cn_review_state").doc(`roster::${B}`).set({
    entries: [{ username: CANARY, username_norm: "bleed-canary-b" }], contest_slug: B, updated_at: now
  });
  await firestore.collection("cn_reviews").doc(`21_cs_001::rev::${A}`).set({
    username: "21 CS 001", username_norm: "21_cs_001", reviewer_name: "Rev",
    verdict: 1, contest_slug: A, created_at: now, updated_at: now
  });
  await firestore.collection("cn_reviews").doc(`bleed-canary-b::rev::${B}`).set({
    username: CANARY, username_norm: "bleed-canary-b", reviewer_name: "Rev",
    verdict: 1, contest_slug: B, created_at: now, updated_at: now
  });

  // Enrollments (cross-check b: one person, two contests — and B is invisible
  // to A's scope by doc-id + field construction).
  for (const slug of [A, B]) {
    await firestore.collection("cn_enrollments").doc(`${slug}::kec--21cs001`).set({
      contest_slug: slug, person_id: "kec--21cs001", college_norm: "kec",
      status: "active", source: "csv", selection_status: "none",
      selection_updated_at: null, selection_by: null, final_snapshot: null, created_at: now
    });
  }

  return firestore;
}

// ---- (c) the isolation suite ------------------------------------------------------

test("canary: every contest-scoped GET, called scoped to contest A, returns ZERO contest-B canary bytes", async () => {
  await seedTwoContestFixture();
  for (const [endpoint, buildReq] of Object.entries(SCOPED_GET_REQUESTS)) {
    const res = await call(buildReq());
    assert.equal(res.statusCode, 200, `${endpoint}: ${JSON.stringify(res.body)}`);
    const serialized = JSON.stringify(res.body);
    assert.ok(!serialized.includes(CANARY), `${endpoint} leaked the contest-B canary: ${serialized.slice(0, 500)}`);
  }
});

test("canary positive control: the same endpoints scoped to contest B DO return the canary (the sentinel is alive)", async () => {
  await seedTwoContestFixture();
  // One endpoint per data family proves the seed works — a canary that nothing
  // can ever return would make the isolation test vacuous.
  const positive = [
    adminGet("/api/admin/sessions-list", { contest_slug: B }),
    adminGet("/api/admin/alerts", { contest_slug: B }),
    adminGet("/api/admin/submission-events", { username: "21 CS 001", contest_slug: B }),
    adminGet("/api/admin/reviews", { contest: B }),
    adminGet("/api/admin/roster", { contest: B }),
    adminGet("/api/admin/attendance", { contest_slug: B })
  ];
  for (const req of positive) {
    const res = await call(req);
    assert.equal(res.statusCode, 200, `${req.path}: ${JSON.stringify(res.body)}`);
    assert.ok(JSON.stringify(res.body).includes(CANARY), `${req.path} positive control found no canary`);
  }
});

test("scopedQuery legacy translation: selecting the synthesized legacy contest matches contest_slug:\"\" sessions", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  // Settings doc with NO slug sources → legacy contest synthesizes as "legacy"
  // with legacy_empty_slug:true.
  await firestore.collection("cn_settings").doc("active").set({ updated_at: "2026-06-10T00:00:00.000Z" });
  await firestore.collection("cn_sessions").doc("lg1").set({
    session_id: "lg1", hackerrank_username: "alice", username_norm: "alice",
    contest_slug: "", status: "active", created_at: "2026-06-10T01:00:00.000Z"
  });
  const res = await call(adminGet("/api/admin/stats", { contest_slug: "legacy" }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.stats.total, 1); // pre-S-C this filter matched NOTHING
});

// ---- the coverage meta-test ----------------------------------------------------------

test("META: every GET route in handler.mjs is categorized — contest-scoped (with a canary request) or exempt (with a reason)", () => {
  const routePattern = /req\.method === "GET" && path === "([^"]+)"/g;
  const actual = new Set();
  for (const match of HANDLER_SOURCE.matchAll(routePattern)) actual.add(match[1]);
  assert.ok(actual.size >= 20, `route extraction looks broken: only ${actual.size} GET routes found`);

  const scoped = new Set(Object.keys(SCOPED_GET_REQUESTS));
  const exempt = new Set(Object.keys(EXEMPT_GETS));
  for (const endpoint of scoped) {
    assert.ok(!exempt.has(endpoint), `${endpoint} is in BOTH the scoped and exempt lists`);
  }
  const categorized = new Set([...scoped, ...exempt]);
  const missing = [...actual].filter((endpoint) => !categorized.has(endpoint)).sort();
  assert.deepEqual(
    missing, [],
    `New GET endpoint(s) not categorized for contest isolation: ${missing.join(", ")} — ` +
    "add a canary request to SCOPED_GET_REQUESTS or an exemption WITH A REASON to EXEMPT_GETS in canaryIsolation.test.mjs"
  );
  const stale = [...categorized].filter((endpoint) => !actual.has(endpoint)).sort();
  assert.deepEqual(stale, [], `Categorized endpoints no longer in the route table: ${stale.join(", ")}`);
});
