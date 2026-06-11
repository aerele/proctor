// backend/test/contestAdminSD.test.mjs — S-D: contest administration plumbing.
// Specs: docs/superpowers/specs/2026-06-10-f10-product-vision.md §2.7 (derived
//        URLs + invigilator_key), §5 rows A2/A3/C1/I1, §7 row S-D, §10.3
//        (typed access code).
// Covers: invigilator_key minted at create + regenerate endpoint (access_code
// too), the PUBLIC rate-limited POST /api/access-code resolver, per-contest
// GET /api/exam-config?contest=, per-contest exam-time (extend/end-now), rooms
// editing via contest-update, and invigilator per-contest key auth + scoping.
import { test } from "node:test";
import assert from "node:assert/strict";

// Env BEFORE import; unique ?sdadmin cache-buster for a fresh handler instance.
process.env.EVIDENCE_BUCKET = "sd-bucket";
process.env.SESSION_COLLECTION = "sd_sessions";
process.env.SETTINGS_COLLECTION = "sd_settings";
process.env.CONTESTS_COLLECTION = "sd_contests";
process.env.TEMPLATES_COLLECTION = "sd_templates";
process.env.PROBLEMS_COLLECTION = "sd_problems";
process.env.SUBMISSIONS_COLLECTION = "sd_submissions";
process.env.ALERTS_COLLECTION = "sd_alerts";
process.env.ROOM_GATES_COLLECTION = "sd_room_gates";
process.env.LIVE_LOCK_COLLECTION = "sd_live_locks";
process.env.ADMIN_PASSWORD = "sd-admin-pass";
process.env.INVIGILATOR_PASSWORD = "sd-invig-pass";

const handler = await import("../src/handler.mjs?sdadmin");
const { api, __setClientsForTest, __setAccessCodeClockForTest } = handler;

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

// Fake Firestore honoring limit/orderBy/startAfter (end-now pagination) —
// copied from examTime.test.mjs.
function makeFakeFirestore() {
  const collections = new Map();
  function getCollection(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  }
  function makeQuery(name, { filters = [], ordered = false, startAfterId = null, limitN = Infinity } = {}) {
    return {
      where(field, op, value) {
        return makeQuery(name, { filters: [...filters, { field, op, value }], ordered, startAfterId, limitN });
      },
      orderBy() { return makeQuery(name, { filters, ordered: true, startAfterId, limitN }); },
      startAfter(id) { return makeQuery(name, { filters, ordered, startAfterId: String(id), limitN }); },
      limit(n) { return makeQuery(name, { filters, ordered, startAfterId, limitN: n }); },
      async get() {
        const store = getCollection(name);
        let entries = [...store.entries()];
        for (const { field, op, value } of filters) {
          if (op === "in") entries = entries.filter(([, doc]) => Array.isArray(value) && value.includes(doc[field]));
          else entries = entries.filter(([, doc]) => doc[field] === value);
        }
        if (ordered) entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        if (startAfterId !== null) entries = entries.filter(([id]) => id > startAfterId);
        entries = entries.slice(0, limitN);
        return { docs: entries.map(([id, data]) => ({ id, data: () => data })) };
      }
    };
  }
  return {
    _collections: collections,
    collection(name) {
      const store = getCollection(name);
      const query = makeQuery(name);
      return {
        where: query.where,
        orderBy: query.orderBy,
        limit: query.limit,
        get: query.get,
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
            async update(patch) {
              const existing = store.get(id);
              if (!existing) { const err = new Error("NOT_FOUND"); err.code = 5; throw err; }
              store.set(id, applyUpdate(existing, patch));
            },
            async delete() { store.delete(id); },
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

const ADMIN_HEADERS = { "x-admin-password": "sd-admin-pass" };

function freshDb() {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore });
  __setAccessCodeClockForTest(null);
  return firestore;
}

// Create a contest through the API (mints access_code + invigilator_key).
async function createContest(body) {
  const res = await call(makeReq({
    method: "POST", path: "/api/admin/contests", headers: ADMIN_HEADERS,
    body: { problems: [{ problem_id: "sum-two" }], ...body }
  }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body.contest;
}

async function openContest(slug) {
  const res = await call(makeReq({
    method: "POST", path: "/api/admin/contest-status", headers: ADMIN_HEADERS,
    body: { slug, status: "open" }
  }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body.contest;
}

const KEY_PATTERN = /^[A-Za-z0-9_-]{24,}$/;
const CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/; // mint alphabet: A-Z minus I/O ambiguity? (exact set asserted below)

// ---- invigilator_key lifecycle ----------------------------------------------

test("create mints a URL-safe invigilator_key; update cannot edit it", async () => {
  freshDb();
  const contest = await createContest({ name: "KEC R1" });
  assert.match(String(contest.invigilator_key || ""), KEY_PATTERN);

  const res = await call(makeReq({
    method: "POST", path: "/api/admin/contest-update", headers: ADMIN_HEADERS,
    body: { slug: contest.slug, invigilator_key: "attacker-chosen" }
  }));
  assert.equal(res.statusCode, 400);
});

test("legacy synthesized contest carries invigilator_key:null", async () => {
  const firestore = freshDb();
  await firestore.collection("sd_settings").doc("active").set({
    contest_slug: "legacy-exam", start_at: "2026-06-10T03:00:00.000Z", end_at: "2026-06-10T08:00:00.000Z"
  });
  const res = await call(makeReq({ method: "GET", path: "/api/admin/contests", headers: ADMIN_HEADERS }));
  const legacy = res.body.contests.find((c) => c.legacy);
  assert.ok(legacy);
  assert.equal(legacy.invigilator_key, null);
});

// ---- POST /api/admin/contest-regenerate ---------------------------------------

test("regenerate access_code mints a fresh valid code; invigilator_key untouched", async () => {
  freshDb();
  const contest = await createContest({ name: "Regen A" });
  const res = await call(makeReq({
    method: "POST", path: "/api/admin/contest-regenerate", headers: ADMIN_HEADERS,
    body: { slug: contest.slug, field: "access_code" }
  }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const updated = res.body.contest;
  assert.match(updated.access_code, /^[ABCDEFGHIJKLMNOPQRSTUVWXYZ23456789]{6}$/);
  assert.notEqual(updated.access_code, contest.access_code);
  assert.equal(updated.invigilator_key, contest.invigilator_key);
});

test("regenerate invigilator_key mints a fresh key; access_code untouched", async () => {
  freshDb();
  const contest = await createContest({ name: "Regen B" });
  const res = await call(makeReq({
    method: "POST", path: "/api/admin/contest-regenerate", headers: ADMIN_HEADERS,
    body: { slug: contest.slug, field: "invigilator_key" }
  }));
  assert.equal(res.statusCode, 200);
  const updated = res.body.contest;
  assert.match(String(updated.invigilator_key), KEY_PATTERN);
  assert.notEqual(updated.invigilator_key, contest.invigilator_key);
  assert.equal(updated.access_code, contest.access_code);
});

test("regenerate: unknown slug -> 404; bad field -> 400; legacy contest -> 404; admin auth required", async () => {
  const firestore = freshDb();
  await firestore.collection("sd_settings").doc("active").set({ contest_slug: "legacy-exam" });
  const make = (body, headers = ADMIN_HEADERS) => call(makeReq({
    method: "POST", path: "/api/admin/contest-regenerate", headers, body
  }));
  assert.equal((await make({ slug: "ghost", field: "access_code" })).statusCode, 404);
  assert.equal((await make({ slug: "legacy-exam", field: "access_code" })).statusCode, 404);
  const contest = await createContest({ name: "Auth Check" });
  assert.equal((await make({ slug: contest.slug, field: "nope" })).statusCode, 400);
  assert.equal((await make({ slug: contest.slug, field: "access_code" }, {})).statusCode, 401);
});

// ---- POST /api/access-code (PUBLIC, rate limited) ------------------------------

function codeReq(code, ip = "203.0.113.9") {
  return makeReq({
    method: "POST", path: "/api/access-code",
    headers: { "x-forwarded-for": ip }, body: { code }
  });
}

test("access-code resolves an OPEN contest (case-insensitive); draft codes do not resolve", async () => {
  freshDb();
  const draft = await createContest({ name: "Code Draft" });
  const toOpen = await createContest({ name: "Code Open" });
  await openContest(toOpen.slug);

  const hit = await call(codeReq(toOpen.access_code.toLowerCase()));
  assert.equal(hit.statusCode, 200, JSON.stringify(hit.body));
  assert.equal(hit.body.slug, toOpen.slug);
  assert.equal(hit.body.name, "Code Open");

  const miss = await call(codeReq(draft.access_code));
  assert.equal(miss.statusCode, 404);
  assert.equal(miss.body.error, "code_not_found");
});

test("access-code: malformed code -> 400 invalid_code; unknown code -> 404", async () => {
  freshDb();
  assert.equal((await call(codeReq("AB"))).statusCode, 400);
  assert.equal((await call(codeReq(""))).statusCode, 400);
  const unknown = await call(codeReq("ZZZZZZ"));
  assert.equal(unknown.statusCode, 404);
});

test("access-code rate limit: per-IP cap inside the window, 429 + retry hint; other IPs unaffected; window expiry resets", async () => {
  freshDb();
  let nowMs = 1_000_000;
  __setAccessCodeClockForTest(() => nowMs);
  for (let i = 0; i < 10; i++) {
    assert.equal((await call(codeReq("ZZZZZZ", "198.51.100.7"))).statusCode, 404);
  }
  const capped = await call(codeReq("ZZZZZZ", "198.51.100.7"));
  assert.equal(capped.statusCode, 429);
  assert.ok(capped.body.retry_after_seconds >= 1);
  // A different IP still gets through.
  assert.equal((await call(codeReq("ZZZZZZ", "198.51.100.8"))).statusCode, 404);
  // After the window passes, the capped IP resets.
  nowMs += 61_000;
  assert.equal((await call(codeReq("ZZZZZZ", "198.51.100.7"))).statusCode, 404);
  __setAccessCodeClockForTest(null);
});

// ---- GET /api/exam-config?contest= ----------------------------------------------

test("exam-config?contest= serves the contest's OWN config (label, rooms, gate, enforcement, camera, window)", async () => {
  const firestore = freshDb();
  const contest = await createContest({
    name: "Cfg One",
    identity_label: "Roll Number",
    room_gate_enabled: true,
    start_at: "2026-06-12T03:00:00.000Z",
    end_at: "2026-06-12T06:00:00.000Z",
    enforcement: { mode: "alert_first", fullscreen_reentry_seconds: 33, fullscreen_exit_limit: 4 },
    camera_recording: { enabled: false, fps: 5, width: 320 }
  });
  await call(makeReq({
    method: "POST", path: "/api/admin/contest-update", headers: ADMIN_HEADERS,
    body: { slug: contest.slug, rooms: ["Lab 1", "Lab 2"] }
  }));
  await openContest(contest.slug);
  // Per-contest roster meta (S-C shape) -> roster_required:true.
  await firestore.collection("sd_settings").doc(`roster_meta::${contest.slug}`).set({
    configured: true, version: 1, count: 2
  });

  const res = await call(makeReq({ method: "GET", path: "/api/exam-config", query: { contest: contest.slug } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.contest_slug, contest.slug);
  assert.equal(res.body.contest_name, "Cfg One");
  assert.equal(res.body.identity_label, "Roll Number");
  assert.equal(res.body.unique_id_label, "Roll Number");
  assert.equal(res.body.roster_required, true);
  assert.deepEqual(res.body.rooms, ["Lab 1", "Lab 2"]);
  assert.equal(res.body.room_gate_enabled, true);
  assert.equal(res.body.enforcement.mode, "alert_first");
  assert.equal(res.body.enforcement.fullscreen_reentry_seconds, 33);
  assert.equal(res.body.camera_recording.enabled, false);
  assert.equal(res.body.start_at, "2026-06-12T03:00:00.000Z");
  assert.equal(res.body.end_at, "2026-06-12T06:00:00.000Z");
  assert.ok(res.body.server_now);
});

test("exam-config?contest=: no roster -> roster_required:false; draft -> 403; unknown -> 400", async () => {
  freshDb();
  const contest = await createContest({ name: "Cfg Two" });
  await openContest(contest.slug);
  const open = await call(makeReq({ method: "GET", path: "/api/exam-config", query: { contest: contest.slug } }));
  assert.equal(open.statusCode, 200);
  assert.equal(open.body.roster_required, false);

  const draft = await createContest({ name: "Cfg Draft" });
  const draftRes = await call(makeReq({ method: "GET", path: "/api/exam-config", query: { contest: draft.slug } }));
  assert.equal(draftRes.statusCode, 403);
  assert.equal(draftRes.body.error, "contest_not_open");

  const unknown = await call(makeReq({ method: "GET", path: "/api/exam-config", query: { contest: "ghost" } }));
  assert.equal(unknown.statusCode, 400);
  assert.equal(unknown.body.error, "unknown_contest");
});

test("exam-config WITHOUT ?contest= keeps today's settings-driven shape bit-for-bit", async () => {
  const firestore = freshDb();
  await firestore.collection("sd_settings").doc("active").set({
    rooms: ["Hall A"], room_gate_enabled: true
  });
  const res = await call(makeReq({ method: "GET", path: "/api/exam-config" }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    Object.keys(res.body).sort(),
    ["camera_recording", "enforcement", "rooms", "roster_required", "unique_id_label"]
  );
  assert.deepEqual(res.body.rooms, ["Hall A"]);
});

test("exam-config?contest=<legacy slug> serves the settings-driven config with the contest header fields", async () => {
  const firestore = freshDb();
  await firestore.collection("sd_settings").doc("active").set({
    contest_slug: "legacy-exam", rooms: ["Hall B"], room_gate_enabled: true,
    start_at: "2026-06-10T03:00:00.000Z", end_at: "2026-06-10T08:00:00.000Z"
  });
  const res = await call(makeReq({ method: "GET", path: "/api/exam-config", query: { contest: "legacy-exam" } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.contest_slug, "legacy-exam");
  assert.deepEqual(res.body.rooms, ["Hall B"]);
  assert.equal(res.body.room_gate_enabled, true);
});

// S-D candidate routing: the pinned candidate app forks its identity UX on the
// contest's identity_mode (person -> server-resolved id + college picker;
// legacy_username -> today's roster-lookup confirm flow). The payload must say
// which one it is — the two branches are otherwise shape-identical.
test("exam-config?contest= carries identity_mode: person contest vs legacy slug", async () => {
  const firestore = freshDb();
  await firestore.collection("sd_settings").doc("active").set({
    contest_slug: "legacy-exam", rooms: ["Hall B"], room_gate_enabled: false
  });
  const contest = await createContest({ name: "Mode Check" });
  await openContest(contest.slug);

  const person = await call(makeReq({ method: "GET", path: "/api/exam-config", query: { contest: contest.slug } }));
  assert.equal(person.statusCode, 200, JSON.stringify(person.body));
  assert.equal(person.body.identity_mode, "person");

  const legacy = await call(makeReq({ method: "GET", path: "/api/exam-config", query: { contest: "legacy-exam" } }));
  assert.equal(legacy.statusCode, 200, JSON.stringify(legacy.body));
  assert.equal(legacy.body.identity_mode, "legacy_username");
});

// ---- GET /api/candidate-route (PUBLIC) -----------------------------------------
// The no-?contest= candidate URL must keep serving today's legacy form while
// the legacy settings doc exists (bit-for-bit deployment guarantee) and show
// the access-code landing page once there is no legacy exam to serve. The
// locked no-param /api/exam-config payload cannot carry this signal, so the
// router asks this tiny public endpoint instead.

test("candidate-route: legacy_configured true while the active settings doc exists", async () => {
  const firestore = freshDb();
  await firestore.collection("sd_settings").doc("active").set({
    contest_slug: "legacy-exam", start_at: "2026-06-10T03:00:00.000Z", end_at: "2026-06-10T08:00:00.000Z"
  });
  const res = await call(makeReq({ method: "GET", path: "/api/candidate-route" }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { legacy_configured: true });
});

test("candidate-route: legacy_configured false with no settings doc, even when real contests exist", async () => {
  freshDb();
  const contest = await createContest({ name: "Pure Contest World" });
  await openContest(contest.slug);
  const res = await call(makeReq({ method: "GET", path: "/api/candidate-route" }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { legacy_configured: false });
});

// ---- POST /api/admin/contest-exam-time --------------------------------------------

test("contest-exam-time: extend_minutes moves the contest's OWN end_at and stamps end_at_updated_at", async () => {
  const firestore = freshDb();
  const contest = await createContest({
    name: "Time One",
    start_at: "2026-06-12T03:00:00.000Z", end_at: "2026-06-12T06:00:00.000Z"
  });
  const res = await call(makeReq({
    method: "POST", path: "/api/admin/contest-exam-time", headers: ADMIN_HEADERS,
    body: { slug: contest.slug, extend_minutes: 30 }
  }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.end_at, "2026-06-12T06:30:00.000Z");
  const stored = firestore._collections.get("sd_contests").get(contest.slug);
  assert.equal(stored.end_at, "2026-06-12T06:30:00.000Z");
  assert.ok(stored.end_at_updated_at);
});

test("contest-exam-time: end_now ends ONLY this contest's live sessions", async () => {
  const firestore = freshDb();
  const contest = await createContest({
    name: "Time Two",
    start_at: "2020-01-01T00:00:00.000Z", end_at: "2099-01-01T00:00:00.000Z"
  });
  const sessions = firestore.collection("sd_sessions");
  await sessions.doc("s1").set({ session_id: "s1", status: "active", contest_slug: contest.slug, username_norm: "a" });
  await sessions.doc("s2").set({ session_id: "s2", status: "active", contest_slug: "other-contest", username_norm: "b" });
  const res = await call(makeReq({
    method: "POST", path: "/api/admin/contest-exam-time", headers: ADMIN_HEADERS,
    body: { slug: contest.slug, end_now: true }
  }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.ended_count, 1);
  assert.equal(firestore._collections.get("sd_sessions").get("s1").status, "ended");
  assert.equal(firestore._collections.get("sd_sessions").get("s2").status, "active");
});

test("contest-exam-time validations: exactly-one-of, window sanity, unconfigured schedule, unknown slug, auth", async () => {
  freshDb();
  const contest = await createContest({
    name: "Time Three",
    start_at: "2026-06-12T03:00:00.000Z", end_at: "2026-06-12T06:00:00.000Z"
  });
  const post = (body, headers = ADMIN_HEADERS) => call(makeReq({
    method: "POST", path: "/api/admin/contest-exam-time", headers, body
  }));
  assert.equal((await post({ slug: contest.slug })).statusCode, 400);
  assert.equal((await post({ slug: contest.slug, extend_minutes: 10, end_now: true })).statusCode, 400);
  assert.equal((await post({ slug: contest.slug, end_at: "2026-06-12T02:00:00.000Z" })).statusCode, 400);
  assert.equal((await post({ slug: "ghost", extend_minutes: 10 })).statusCode, 404);
  assert.equal((await post({ slug: contest.slug, extend_minutes: 10 }, {})).statusCode, 401);
  const bare = await createContest({ name: "No Window" });
  assert.equal((await post({ slug: bare.slug, extend_minutes: 10 })).statusCode, 400);
});

// ---- rooms editing via contest-update -----------------------------------------------

test("contest-update accepts rooms[]: sanitized, deduped, blanks dropped; non-array -> 400", async () => {
  freshDb();
  const contest = await createContest({ name: "Rooms One" });
  const res = await call(makeReq({
    method: "POST", path: "/api/admin/contest-update", headers: ADMIN_HEADERS,
    body: { slug: contest.slug, rooms: ["Lab 1", "lab 1", "Lab 2!!", "   ", "Lab 3"] }
  }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.contest.rooms, ["Lab 1", "Lab 2", "Lab 3"]);

  const bad = await call(makeReq({
    method: "POST", path: "/api/admin/contest-update", headers: ADMIN_HEADERS,
    body: { slug: contest.slug, rooms: "Lab 1" }
  }));
  assert.equal(bad.statusCode, 400);
});

// ---- invigilator per-contest key auth + scoping ---------------------------------------

async function seedTwoContests(firestore) {
  const a = await createContest({ name: "Invig A", room_gate_enabled: true });
  await call(makeReq({
    method: "POST", path: "/api/admin/contest-update", headers: ADMIN_HEADERS,
    body: { slug: a.slug, rooms: ["Lab 1"] }
  }));
  const aOpen = await openContest(a.slug);
  const b = await createContest({ name: "Invig B" });
  const bOpen = await openContest(b.slug);
  const sessions = firestore.collection("sd_sessions");
  await sessions.doc("sa").set({
    session_id: "sa", status: "active", contest_slug: a.slug, room: "Lab 1",
    name: "Asha", hackerrank_username: "asha", username_norm: "asha", created_at: "2026-06-12T03:10:00.000Z"
  });
  await sessions.doc("sb").set({
    session_id: "sb", status: "active", contest_slug: b.slug, room: "Lab 1",
    name: "Banu", hackerrank_username: "banu", username_norm: "banu", created_at: "2026-06-12T03:11:00.000Z"
  });
  return { a: aOpen, b: bOpen };
}

test("invigilator overview?contest= authenticates with THAT contest's key and scopes to the contest doc", async () => {
  const firestore = freshDb();
  const { a, b } = await seedTwoContests(firestore);

  const ok = await call(makeReq({
    method: "GET", path: "/api/invigilator/overview", query: { contest: a.slug },
    headers: { "x-invigilator-password": a.invigilator_key }
  }));
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.contest_slug, a.slug);
  assert.equal(ok.body.room_gate_enabled, true);
  assert.ok(ok.body.rooms.includes("Lab 1"));

  // A's key never opens B; garbage never opens anything.
  const cross = await call(makeReq({
    method: "GET", path: "/api/invigilator/overview", query: { contest: b.slug },
    headers: { "x-invigilator-password": a.invigilator_key }
  }));
  assert.equal(cross.statusCode, 401);
  const wrong = await call(makeReq({
    method: "GET", path: "/api/invigilator/overview", query: { contest: a.slug },
    headers: { "x-invigilator-password": "nope" }
  }));
  assert.equal(wrong.statusCode, 401);
  // Global password + admin password still pass as fallback (Aerele staff).
  const viaGlobal = await call(makeReq({
    method: "GET", path: "/api/invigilator/overview", query: { contest: a.slug },
    headers: { "x-invigilator-password": "sd-invig-pass" }
  }));
  assert.equal(viaGlobal.statusCode, 200);
  const viaAdmin = await call(makeReq({
    method: "GET", path: "/api/invigilator/overview", query: { contest: a.slug },
    headers: { "x-admin-password": "sd-admin-pass" }
  }));
  assert.equal(viaAdmin.statusCode, 200);
  // Unknown contest -> 400 even with the global password.
  const ghost = await call(makeReq({
    method: "GET", path: "/api/invigilator/overview", query: { contest: "ghost" },
    headers: { "x-invigilator-password": "sd-invig-pass" }
  }));
  assert.equal(ghost.statusCode, 400);
});

test("a contest key does NOT authenticate the legacy (no-contest-param) portal", async () => {
  const firestore = freshDb();
  const { a } = await seedTwoContests(firestore);
  const res = await call(makeReq({
    method: "GET", path: "/api/invigilator/overview",
    headers: { "x-invigilator-password": a.invigilator_key }
  }));
  assert.equal(res.statusCode, 401);
});

test("invigilator room?contest= sees ONLY that contest's sessions; gate honours the CONTEST's room_gate_enabled", async () => {
  const firestore = freshDb();
  const { a } = await seedTwoContests(firestore);

  const room = await call(makeReq({
    method: "GET", path: "/api/invigilator/room", query: { contest: a.slug, room: "Lab 1" },
    headers: { "x-invigilator-password": a.invigilator_key }
  }));
  assert.equal(room.statusCode, 200, JSON.stringify(room.body));
  assert.equal(room.body.contest_slug, a.slug);
  assert.equal(room.body.room_gate_enabled, true);
  assert.deepEqual(room.body.sessions.map((s) => s.name), ["Asha"]);

  // release-code rides the CONTEST gate flag (global settings have no gate on).
  const release = await call(makeReq({
    method: "POST", path: "/api/invigilator/release-code",
    headers: { "x-invigilator-password": a.invigilator_key },
    body: { contest: a.slug, room: "Lab 1", invigilator_name: "Meera" }
  }));
  assert.equal(release.statusCode, 200, JSON.stringify(release.body));
  assert.match(release.body.gate.otp, /^\d{6}$/);
  assert.ok(firestore._collections.get("sd_room_gates").has(`gate:${a.slug}:Lab 1`));
});

test("release-code on a contest with the gate OFF -> 400 room_gate_disabled", async () => {
  const firestore = freshDb();
  const { b } = await seedTwoContests(firestore);
  const res = await call(makeReq({
    method: "POST", path: "/api/invigilator/release-code",
    headers: { "x-invigilator-password": b.invigilator_key },
    body: { contest: b.slug, room: "Lab 1" }
  }));
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "room_gate_disabled");
});
