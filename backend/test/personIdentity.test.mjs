// backend/test/personIdentity.test.mjs — S-C slice 2: person-mode identity
// derivation at session start + dual-norm contest-pinned resume.
// Specs: docs/superpowers/specs/2026-06-10-f10-product-vision.md §2.4 (identity
//          chain: username_norm = person_id; server-side college resolution;
//          picker ONLY on genuine ambiguity; no-roster person_id:null), §2.10
//        docs/superpowers/specs/2026-06-10-f9-identity-data-lifecycle-design.md
//          D2 (one identity field candidate_id), D4 (identity_label denorm),
//          D6 (H1 live-lock unchanged), D8 (dual-norm contest-pinned resume)
// THE CANARY: the legacy start path must produce IDENTICAL session docs —
// pinned by exact key-set + value assertions at the bottom.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.EVIDENCE_BUCKET = "pi-bucket";
process.env.SESSION_COLLECTION = "pi_sessions";
process.env.SETTINGS_COLLECTION = "pi_settings";
process.env.CONTESTS_COLLECTION = "pi_contests";
process.env.ROSTER_COLLECTION = "pi_roster";
process.env.ALERTS_COLLECTION = "pi_alerts";
process.env.LIVE_LOCK_COLLECTION = "pi_live_locks";
process.env.COLLEGES_COLLECTION = "pi_colleges";
process.env.PERSONS_COLLECTION = "pi_persons";
process.env.ENROLLMENTS_COLLECTION = "pi_enrollments";
process.env.ADMIN_AUDIT_COLLECTION = "pi_audit";
process.env.ADMIN_PASSWORD = "pi-admin-pass";

const handler = await import("../src/handler.mjs?personidentity");
const { api, __setClientsForTest } = handler;

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

const ADMIN_HEADERS = { "x-admin-password": "pi-admin-pass" };
const HOUR = 3600 * 1000;

function freshClients() {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  return { firestore, storage };
}

async function createOpenContest(name, { window: withWindow = true } = {}) {
  // S-I publish gate: a contest cannot open with zero problems, so every
  // open-contest fixture carries the published seed problem.
  let res = await call(makeReq({ method: "POST", path: "/api/admin/contests", headers: ADMIN_HEADERS, body: { name, problems: [{ problem_id: "sum-two" }] } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const contest = res.body.contest;
  if (withWindow) {
    res = await call(makeReq({ method: "POST", path: "/api/admin/contest-update", headers: ADMIN_HEADERS, body: {
      slug: contest.slug,
      start_at: new Date(Date.now() - HOUR).toISOString(),
      end_at: new Date(Date.now() + HOUR).toISOString()
    } }));
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  }
  res = await call(makeReq({ method: "POST", path: "/api/admin/contest-status", headers: ADMIN_HEADERS, body: { slug: contest.slug, status: "open" } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body.contest;
}

async function uploadPersonRoster(contestSlug, rows, extra = {}) {
  const res = await call(makeReq({ method: "POST", path: "/api/admin/roster", headers: ADMIN_HEADERS, body: {
    contest: contestSlug,
    unique_id_column: "unique_id",
    columns: ["college", "unique_id", "name", "email", "room"],
    column_mapping: { name: "name", email: "email" },
    rows,
    ...extra
  } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true, JSON.stringify(res.body));
  return res.body;
}

const ROW_ASHA = { college: "KEC", unique_id: "21 CS 001", name: "Asha", email: "asha@x.com", room: "Lab A" };
const ROW_PRIYA = { college: "PSG Tech", unique_id: "21CS001", name: "Priya", email: "priya@y.com", room: "Hall 2" };

function startReq(body) {
  return makeReq({ method: "POST", path: "/api/session/start", headers: { "x-forwarded-for": "10.1.1.1" }, body });
}
function resumeReq(body) {
  return makeReq({ method: "POST", path: "/api/session/resume", body });
}

// ---- person-mode start --------------------------------------------------------

test("person contest + roster: username_norm = person_id, candidate_id = roster display id, profile server-overridden", async () => {
  const { firestore } = freshClients();
  const contest = await createOpenContest("KEC June 2026");
  await uploadPersonRoster(contest.slug, [ROW_ASHA], { college_resolutions: { kec: { action: "create" } } });

  const res = await call(startReq({
    contest: contest.slug,
    roster_unique_id: "21cs001", // typed loosely; roster display form wins
    name: "Typed Name Ignored",  // name is MAPPED → server-overridden
    email: "typed@ignored.com",
    roll_number: "R-77",         // unmapped → typed value kept
    consent_accepted: true
  }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, "active");
  assert.equal(res.body.candidate_id, "21 CS 001");
  assert.equal(res.body.identity_label, "Candidate ID");
  assert.equal(res.body.contest_slug, contest.slug);
  // S-I (landed at merge): person contests serve their OWN problems[]; the
  // fixture carries the seed problem, and `problem` is the problems[0] alias.
  assert.equal(res.body.problem?.id, "sum-two");
  assert.equal(res.body.problems.length, 1);
  assert.equal(res.body.problems[0].id, "sum-two");
  assert.equal(res.body.room_gate_enabled, false);

  const session = firestore._collections.get("pi_sessions").get(res.body.session_id);
  assert.equal(session.username_norm, "kec--21cs001"); // person_id IS the norm
  assert.equal(session.person_id, "kec--21cs001");
  assert.equal(session.college_norm, "kec");
  assert.equal(session.candidate_id, "21 CS 001");
  assert.equal(session.identity_label, "Candidate ID");
  assert.equal(session.contest_slug, contest.slug);
  assert.equal(session.roster_verified, true);
  assert.equal(session.roster_unique_id, "21 CS 001");
  assert.equal(session.name, "Asha");          // mapped: roster wins
  assert.equal(session.email, "asha@x.com");
  assert.equal(session.roll_number, "R-77");   // unmapped: typed kept
  assert.equal(session.hackerrank_username, undefined); // F9 D2: deleted for new contests
  assert.equal(session.storage_prefix, `contests/${contest.slug}/sessions/kec--21cs001/${res.body.session_id}/`);
  // H1 live-lock rides the person norm.
  assert.ok(firestore._collections.get("pi_live_locks").has(`live:kec--21cs001:${contest.slug}`));
});

test("person contest window gates the start (contest doc, NOT the legacy settings window)", async () => {
  freshClients();
  const noWindow = await createOpenContest("No Window", { window: false });
  await uploadPersonRoster(noWindow.slug, [ROW_ASHA], { college_resolutions: { kec: { action: "create" } } });
  const res = await call(startReq({ contest: noWindow.slug, roster_unique_id: "21CS001", consent_accepted: true }));
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /not configured/);
});

test("ambiguity: same unique_id in two colleges → 409 college_choices payload; college param resolves it", async () => {
  const { firestore } = freshClients();
  const contest = await createOpenContest("Shared Drive");
  await uploadPersonRoster(contest.slug, [ROW_ASHA, ROW_PRIYA], {
    college_resolutions: { kec: { action: "create" }, psgtech: { action: "create" } }
  });

  const ambiguous = await call(startReq({ contest: contest.slug, roster_unique_id: "21CS001", consent_accepted: true }));
  assert.equal(ambiguous.statusCode, 409);
  assert.equal(ambiguous.body.error, "college_choices");
  assert.deepEqual(ambiguous.body.college_choices, [
    { college_norm: "kec", name: "KEC", college: "KEC" },
    { college_norm: "psgtech", name: "PSG Tech", college: "PSG Tech" }
  ]);

  const picked = await call(startReq({ contest: contest.slug, roster_unique_id: "21CS001", college: "psgtech", consent_accepted: true }));
  assert.equal(picked.statusCode, 200, JSON.stringify(picked.body));
  const session = firestore._collections.get("pi_sessions").get(picked.body.session_id);
  assert.equal(session.person_id, "psgtech--21cs001");
  assert.equal(session.name, "Priya");

  const wrongCollege = await call(startReq({ contest: contest.slug, roster_unique_id: "21CS001", college: "nowhere", consent_accepted: true }));
  assert.equal(wrongCollege.statusCode, 409);
});

test("person roster gate: missing id → 403 roster_id_required; unknown id → 403 not_on_roster", async () => {
  freshClients();
  const contest = await createOpenContest("KEC June 2026");
  await uploadPersonRoster(contest.slug, [ROW_ASHA], { college_resolutions: { kec: { action: "create" } } });
  const missing = await call(startReq({ contest: contest.slug, consent_accepted: true }));
  assert.equal(missing.statusCode, 403);
  assert.equal(missing.body.error, "roster_id_required");
  const unknown = await call(startReq({ contest: contest.slug, roster_unique_id: "99XX999", consent_accepted: true }));
  assert.equal(unknown.statusCode, 403);
  assert.equal(unknown.body.error, "not_on_roster");
});

test("no-roster person contest: person_id null, username_norm = identityNorm(candidate_id)", async () => {
  const { firestore } = freshClients();
  const contest = await createOpenContest("Open Walk-in");
  const res = await call(startReq({
    contest: contest.slug,
    candidate_id: "Guest 42",
    name: "Guest", email: "guest@x.com",
    consent_accepted: true
  }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const session = firestore._collections.get("pi_sessions").get(res.body.session_id);
  assert.equal(session.person_id, null);   // documented limitation: no linking
  assert.equal(session.college_norm, "");
  assert.equal(session.username_norm, "guest42");
  assert.equal(session.candidate_id, "Guest 42");
  assert.equal(session.roster_verified, false);

  // id + name + email are required on the no-roster path (F9 §1.4).
  const noName = await call(startReq({ contest: contest.slug, candidate_id: "G2", email: "g@x.com", consent_accepted: true }));
  assert.equal(noName.statusCode, 400);
});

test("H1 live-lock on person norms: same person same contest → pending; same roll different colleges → both active; same person two contests → both active", async () => {
  freshClients();
  const contest = await createOpenContest("Shared Drive");
  await uploadPersonRoster(contest.slug, [ROW_ASHA, ROW_PRIYA], {
    college_resolutions: { kec: { action: "create" }, psgtech: { action: "create" } }
  });

  const first = await call(startReq({ contest: contest.slug, roster_unique_id: "21CS001", college: "kec", consent_accepted: true }));
  assert.equal(first.body.status, "active");
  const second = await call(startReq({ contest: contest.slug, roster_unique_id: "21CS001", college: "kec", consent_accepted: true }));
  assert.equal(second.body.status, "pending_approval");
  assert.equal(second.body.blocked_by_session_id, first.body.session_id);

  // Same roll number, OTHER college, same contest: a different person — active.
  const other = await call(startReq({ contest: contest.slug, roster_unique_id: "21CS001", college: "psgtech", consent_accepted: true }));
  assert.equal(other.body.status, "active");

  // Same person in a SECOND contest: composite key keeps both live.
  const round2 = await createOpenContest("Shared Drive R2");
  await uploadPersonRoster(round2.slug, [ROW_ASHA]);
  const r2 = await call(startReq({ contest: round2.slug, roster_unique_id: "21CS001", consent_accepted: true }));
  assert.equal(r2.body.status, "active");
});

test("replay idempotency: re-posting the same session_id + identity returns the SAME session", async () => {
  freshClients();
  const contest = await createOpenContest("KEC June 2026");
  await uploadPersonRoster(contest.slug, [ROW_ASHA], { college_resolutions: { kec: { action: "create" } } });
  const first = await call(startReq({ contest: contest.slug, roster_unique_id: "21CS001", consent_accepted: true }));
  const replay = await call(startReq({
    contest: contest.slug, roster_unique_id: "21CS001", consent_accepted: true,
    session_id: first.body.session_id
  }));
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.body.session_id, first.body.session_id);
  assert.equal(replay.body.status, "active");
});

test("person start response carries the CONTEST window end_at, not the legacy settings end_at", async () => {
  const { firestore } = freshClients();
  // A legacy settings doc exists with a DIFFERENT window + a problem assigned —
  // none of it may leak into the person contest's response.
  await firestore.collection("pi_settings").doc("active").set({
    start_at: new Date(Date.now() - 2 * HOUR).toISOString(),
    end_at: new Date(Date.now() + 9 * HOUR).toISOString(),
    problem_id: "legacy-problem",
    contest_url: "https://hackerrank.example/legacy-exam",
    room_gate_enabled: true
  });
  const contest = await createOpenContest("KEC June 2026");
  await uploadPersonRoster(contest.slug, [ROW_ASHA], { college_resolutions: { kec: { action: "create" } } });
  const res = await call(startReq({ contest: contest.slug, roster_unique_id: "21CS001", consent_accepted: true }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const contestDoc = firestore._collections.get("pi_contests").get(contest.slug);
  assert.equal(res.body.end_at, contestDoc.end_at);
  // S-I (landed at merge): the person contest serves ITS problems[], never the
  // legacy settings problem_id — the alias must be the contest's own problem.
  assert.equal(res.body.problem?.id, "sum-two");
  assert.equal(res.body.problems.some((p) => p.id === "legacy-problem"), false);
  assert.equal(res.body.contest_url, ""); // contest_url is dead for person contests
  assert.equal(res.body.room_gate_enabled, false); // contest doc, not settings
});

// ---- resume (F9 D8: dual-norm + contest-pinned) --------------------------------

test("resume is contest-pinned: wrong contest → 404; matching contest + person candidate_id → resumes", async () => {
  freshClients();
  const contest = await createOpenContest("KEC June 2026");
  await uploadPersonRoster(contest.slug, [ROW_ASHA], { college_resolutions: { kec: { action: "create" } } });
  const start = await call(startReq({ contest: contest.slug, roster_unique_id: "21CS001", consent_accepted: true }));

  const wrong = await call(resumeReq({ session_id: start.body.session_id, contest: "some-other-contest" }));
  assert.equal(wrong.statusCode, 404);

  // person leg: identityNorm("21 CS 001") === identityNorm(session.candidate_id),
  // even though username_norm is the college-prefixed person_id.
  const ok = await call(resumeReq({ session_id: start.body.session_id, contest: contest.slug, candidate_id: "21 CS 001" }));
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.session_id, start.body.session_id);
  assert.equal(ok.body.candidate_id, "21 CS 001");

  // wrong identity still 404s.
  const imposter = await call(resumeReq({ session_id: start.body.session_id, contest: contest.slug, candidate_id: "OTHER" }));
  assert.equal(imposter.statusCode, 404);

  // transitional: contest absent is tolerated for one release (F9 D8).
  const absent = await call(resumeReq({ session_id: start.body.session_id, candidate_id: "21cs001" }));
  assert.equal(absent.statusCode, 200);
});

test("resume legacy leg: hackerrank_username verified via normalizeUsername exactly as today", async () => {
  const { firestore } = freshClients();
  await firestore.collection("pi_sessions").doc("legacy-1").set({
    session_id: "legacy-1", hackerrank_username: "Alice X", username_norm: "alice_x",
    contest_slug: "", status: "active", storage_prefix: "sessions/alice_x/legacy-1/"
  });
  await firestore.collection("pi_settings").doc("active").set({ end_at: new Date(Date.now() + HOUR).toISOString() });
  const ok = await call(resumeReq({ session_id: "legacy-1", hackerrank_username: "alice x" }));
  assert.equal(ok.statusCode, 200);
  const wrong = await call(resumeReq({ session_id: "legacy-1", hackerrank_username: "bob" }));
  assert.equal(wrong.statusCode, 404);
});

// ---- THE LEGACY CANARY: today's start path, bit-for-bit -------------------------

test("legacy start (no contest param) produces EXACTLY today's session doc — no person fields, same key set", async () => {
  const { firestore } = freshClients();
  await firestore.collection("pi_settings").doc("active").set({
    start_at: new Date(Date.now() - HOUR).toISOString(),
    end_at: new Date(Date.now() + HOUR).toISOString(),
    contest_url: "https://hackerrank.example/contests/legacy-exam"
  });
  const res = await call(startReq({
    hackerrank_username: "Alice", name: "Alice A", roll_number: "21CS009",
    email: "alice@x.com", consent_accepted: true
  }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const session = firestore._collections.get("pi_sessions").get(res.body.session_id);
  // EXACT key set — any person-layer field appearing here breaks the canary.
  assert.deepEqual(Object.keys(session).sort(), [
    "blocked_by_session_id", "camera_chunk_count", "chunk_count",
    "clipboard_event_count", "consent_accepted", "contest_slug", "created_at",
    "current_ip", "email", "enforcement_exemptions", "event_count",
    "focus_event_count", "hackerrank_username", "heartbeat_count",
    "ip_change_count", "name", "roll_number", "room", "roster_unique_id",
    "roster_verified", "session_id", "start_ip", "status", "storage_prefix",
    "updated_at", "upload_error_count", "username_norm"
  ]);
  assert.equal(session.hackerrank_username, "Alice");
  assert.equal(session.username_norm, "alice");
  assert.equal(session.contest_slug, "legacy-exam");
  assert.equal(session.storage_prefix, `contests/legacy-exam/sessions/alice/${session.session_id}/`);
});

test("start naming the SYNTHESIZED legacy contest falls through to today's path bit-for-bit", async () => {
  const { firestore } = freshClients();
  await firestore.collection("pi_settings").doc("active").set({
    start_at: new Date(Date.now() - HOUR).toISOString(),
    end_at: new Date(Date.now() + HOUR).toISOString(),
    contest_slug: "legacy-exam",
    contest_url: "https://hackerrank.example/contests/legacy-exam"
  });
  const res = await call(startReq({
    contest: "legacy-exam", // resolves to the synthesized legacy contest
    hackerrank_username: "Alice", name: "Alice A", roll_number: "21CS009",
    email: "alice@x.com", consent_accepted: true
  }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const session = firestore._collections.get("pi_sessions").get(res.body.session_id);
  assert.equal(session.hackerrank_username, "Alice");
  assert.equal(session.candidate_id, undefined);
  assert.equal(session.person_id, undefined);
});

test("start naming an unknown contest → 400 unknown_contest; a draft person contest → 403 contest_not_open", async () => {
  freshClients();
  const res = await call(startReq({ contest: "nope", hackerrank_username: "a", name: "n", roll_number: "r", email: "e@x", consent_accepted: true }));
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "unknown_contest");

  const created = await call(makeReq({ method: "POST", path: "/api/admin/contests", headers: ADMIN_HEADERS, body: { name: "Draft Only" } }));
  const draft = await call(startReq({ contest: created.body.contest.slug, roster_unique_id: "x", consent_accepted: true }));
  assert.equal(draft.statusCode, 403);
  assert.equal(draft.body.error, "contest_not_open");
});
