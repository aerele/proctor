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

async function createOpenContest(name, { window: withWindow = true, body: extraBody = {} } = {}) {
  // S-I publish gate: a contest cannot open with zero problems, so every
  // open-contest fixture carries the published seed problem.
  let res = await call(makeReq({ method: "POST", path: "/api/admin/contests", headers: ADMIN_HEADERS, body: { name, problems: [{ problem_id: "sum-two" }], ...extraBody } }));
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
  assert.equal(session.username_norm, "kec~21cs001"); // person_id IS the norm
  assert.equal(session.person_id, "kec~21cs001");
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
  assert.equal(session.storage_prefix, `contests/${contest.slug}/sessions/kec~21cs001/${res.body.session_id}/`);
  // H1 live-lock rides the person norm.
  assert.ok(firestore._collections.get("pi_live_locks").has(`live:kec~21cs001:${contest.slug}`));
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
  assert.equal(session.person_id, "psgtech~21cs001");
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

  // F12 email-format gap: a typed-but-malformed email on the no-roster path is a 400.
  const badEmail = await call(startReq({ contest: contest.slug, candidate_id: "G3", name: "Gee", email: "gee@nowhere", consent_accepted: true }));
  assert.equal(badEmail.statusCode, 400);
  assert.match(badEmail.body.error, /email/i);
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

// ---- wave-4 fix: contest-owned enforcement/camera/gate are SERVED, not dead ----
// S-I instantiation snapshot-copies enforcement/camera_recording/
// room_gate_enabled onto the contest doc; every SESSION-BOUND serve path must
// read them from the contest, never the global settings doc. (Pre-session
// /api/exam-config and the invigilator gate endpoints stay settings-driven
// until S-D defines their contest-aware contracts.)

const WALK_IN = { name: "Guest", email: "guest@x.com", consent_accepted: true };

test("person start serves the CONTEST's snapshot enforcement + camera, never the global settings doc", async () => {
  const { firestore } = freshClients();
  // Global deployment knobs are the OPPOSITE of the contest's, to pin the source.
  await firestore.collection("pi_settings").doc("active").set({
    enforcement_mode: "block", fullscreen_reentry_seconds: 20, fullscreen_exit_limit: 2,
    camera_recording: { enabled: true, fps: 10, width: 640 }
  });
  const contest = await createOpenContest("Soft Mode", { body: {
    enforcement: { mode: "alert_first", fullscreen_reentry_seconds: 45, fullscreen_exit_limit: 5 },
    camera_recording: { enabled: false, fps: 5, width: 480 }
  } });
  const res = await call(startReq({ contest: contest.slug, candidate_id: "G1", ...WALK_IN }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.enforcement, { mode: "alert_first", fullscreen_reentry_seconds: 45, fullscreen_exit_limit: 5 });
  assert.deepEqual(res.body.upload_config.camera, { enabled: false, fps: 5, width: 480 });

  // Resume shares startResponse — same contest-sourced config.
  const resume = await call(resumeReq({ session_id: res.body.session_id, contest: contest.slug, candidate_id: "G1" }));
  assert.equal(resume.statusCode, 200);
  assert.deepEqual(resume.body.enforcement, { mode: "alert_first", fullscreen_reentry_seconds: 45, fullscreen_exit_limit: 5 });
  assert.deepEqual(resume.body.upload_config.camera, { enabled: false, fps: 5, width: 480 });
});

test("exec room gate reads the CONTEST's room_gate_enabled (contest ON + global OFF → exam_not_started)", async () => {
  const { firestore } = freshClients();
  await firestore.collection("pi_settings").doc("active").set({ room_gate_enabled: false });
  const contest = await createOpenContest("Gated Exec", { body: { room_gate_enabled: true } });
  const start = await call(startReq({ contest: contest.slug, candidate_id: "G1", ...WALK_IN }));
  assert.equal(start.statusCode, 200, JSON.stringify(start.body));
  assert.equal(start.body.room_gate_enabled, true);
  const run = await call(makeReq({ method: "POST", path: "/api/exec/run", body: {
    session_id: start.body.session_id, problem_id: "sum-two", language: "python", source_code: "print(1)"
  } }));
  assert.equal(run.statusCode, 403);
  assert.equal(run.body.error, "exam_not_started");
});

test("candidate room-gate poll follows the CONTEST gate in both directions", async () => {
  const { firestore } = freshClients();
  // Contest gate ON + global OFF → the candidate WAITS at the gate.
  await firestore.collection("pi_settings").doc("active").set({ room_gate_enabled: false });
  const gated = await createOpenContest("Gated Poll", { body: { room_gate_enabled: true } });
  const a = await call(startReq({ contest: gated.slug, candidate_id: "G1", ...WALK_IN }));
  const pollA = await call(makeReq({ method: "POST", path: "/api/session/room-gate", body: { session_id: a.body.session_id } }));
  assert.equal(pollA.statusCode, 200, JSON.stringify(pollA.body));
  assert.equal(pollA.body.gate_enabled, true);
  assert.equal(pollA.body.exam_started, false);

  // Contest gate OFF + global ON → the candidate starts immediately.
  await firestore.collection("pi_settings").doc("active").set({ room_gate_enabled: true });
  const open = await createOpenContest("Open Poll", { body: { room_gate_enabled: false } });
  const b = await call(startReq({ contest: open.slug, candidate_id: "G2", ...WALK_IN }));
  const pollB = await call(makeReq({ method: "POST", path: "/api/session/room-gate", body: { session_id: b.body.session_id } }));
  assert.equal(pollB.statusCode, 200, JSON.stringify(pollB.body));
  assert.equal(pollB.body.gate_enabled, false);
  assert.equal(pollB.body.exam_started, true);
});

test("heartbeat (the live channel) serves the CONTEST's enforcement + end_at on person sessions", async () => {
  const { firestore } = freshClients();
  await firestore.collection("pi_settings").doc("active").set({
    enforcement_mode: "block",
    end_at: new Date(Date.now() + 9 * HOUR).toISOString()
  });
  const contest = await createOpenContest("Soft HB", { body: {
    enforcement: { mode: "alert_first", fullscreen_reentry_seconds: 30, fullscreen_exit_limit: 3 }
  } });
  const start = await call(startReq({ contest: contest.slug, candidate_id: "G1", ...WALK_IN }));
  const hb = await call(makeReq({ method: "POST", path: "/api/heartbeat", body: {
    session_id: start.body.session_id, recording_state: "combined:recording;screen:recording", visibility_state: "visible"
  } }));
  assert.equal(hb.statusCode, 200, JSON.stringify(hb.body));
  assert.deepEqual(hb.body.enforcement, { mode: "alert_first", fullscreen_reentry_seconds: 30, fullscreen_exit_limit: 3 });
  const contestDoc = firestore._collections.get("pi_contests").get(contest.slug);
  assert.equal(hb.body.end_at, contestDoc.end_at); // S5 live end-time stays contest-sourced
});

test("enforcement-violation consequence follows the CONTEST's mode, both directions", async () => {
  const { firestore } = freshClients();
  // alert_first contest under a block global → alert only, never locked.
  await firestore.collection("pi_settings").doc("active").set({ enforcement_mode: "block" });
  const soft = await createOpenContest("Soft Violation", { body: {
    enforcement: { mode: "alert_first", fullscreen_reentry_seconds: 20, fullscreen_exit_limit: 2 }
  } });
  const a = await call(startReq({ contest: soft.slug, candidate_id: "G1", ...WALK_IN }));
  const resA = await call(makeReq({ method: "POST", path: "/api/session/enforcement-violation",
    body: { session_id: a.body.session_id, phase: "exit_limit", exit_count: 3 } }));
  assert.equal(resA.statusCode, 200, JSON.stringify(resA.body));
  assert.equal(resA.body.locked, false);
  assert.equal(resA.body.mode, "alert_first");
  assert.equal(firestore._collections.get("pi_sessions").get(a.body.session_id).status, "active");

  // block contest under an alert_first global → locked.
  await firestore.collection("pi_settings").doc("active").set({ enforcement_mode: "alert_first" });
  const hard = await createOpenContest("Hard Violation", { body: {
    enforcement: { mode: "block", fullscreen_reentry_seconds: 20, fullscreen_exit_limit: 2 }
  } });
  const b = await call(startReq({ contest: hard.slug, candidate_id: "G2", ...WALK_IN }));
  const resB = await call(makeReq({ method: "POST", path: "/api/session/enforcement-violation",
    body: { session_id: b.body.session_id, phase: "exit_limit", exit_count: 3 } }));
  assert.equal(resB.statusCode, 200, JSON.stringify(resB.body));
  assert.equal(resB.body.locked, true);
  assert.equal(firestore._collections.get("pi_sessions").get(b.body.session_id).status, "locked");
});

test("server-side exit-limit reconciliation (events path) uses the CONTEST's enforcement", async () => {
  const { firestore } = freshClients();
  // Global: block with a 0-exit limit — the OLD code would lock on the first exit.
  await firestore.collection("pi_settings").doc("active").set({ enforcement_mode: "block", fullscreen_exit_limit: 0 });
  const contest = await createOpenContest("Lenient Events", { body: {
    enforcement: { mode: "block", fullscreen_reentry_seconds: 20, fullscreen_exit_limit: 5 }
  } });
  const start = await call(startReq({ contest: contest.slug, candidate_id: "G1", ...WALK_IN }));
  const res = await call(makeReq({ method: "POST", path: "/api/events", body: {
    session_id: start.body.session_id,
    events: [{ type: "fullscreen_exit", timestamp: new Date().toISOString(), detail: {} }]
  } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const doc = firestore._collections.get("pi_sessions").get(start.body.session_id);
  assert.equal(doc.fullscreen_exit_count, 1);
  assert.equal(doc.status, "active"); // contest limit 5 — one exit is no violation
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

// ---- F-C (KPR 2026-06-12): enrollment-spine fallback after a roster clear ------
// The incident: roster cleared mid-contest → every later join keyed
// anonymously even when the typed id matched a surviving enrolled person.
// With the fix, roster-meta-absent + enrollment spine present → EXACT
// normalized match keys the session to the person; a non-matching id stays
// anonymous but is LOUDLY flagged identity_unresolved (surfaced in the
// Sessions list) — being unknowingly wrong is not acceptable.

test("F-C cleared roster: typed id matching the enrollment spine keys to the person (username_norm = person_id)", async () => {
  const { firestore } = freshClients();
  const contest = await createOpenContest("KPR Live");
  await uploadPersonRoster(contest.slug, [ROW_ASHA], { college_resolutions: { kec: { action: "create" } } });
  // Mid-contest clear: the contest is OPEN, so the typed-confirm gate (F-B)
  // engages — this also pins the gate's "open" leg.
  const refused = await call(makeReq({ method: "POST", path: "/api/admin/roster", headers: ADMIN_HEADERS,
    body: { contest: contest.slug, clear: true } }));
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.body.error, "roster_clear_confirmation_required");
  const cleared = await call(makeReq({ method: "POST", path: "/api/admin/roster", headers: ADMIN_HEADERS,
    body: { contest: contest.slug, clear: true, confirm_clear: contest.slug } }));
  assert.equal(cleared.statusCode, 200, JSON.stringify(cleared.body));

  // The student types the BARE roll number (norm of the roster's "21 CS 001").
  const res = await call(startReq({
    contest: contest.slug, candidate_id: "21CS001",
    name: "Typed Name", email: "typed@x.com", consent_accepted: true
  }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const session = firestore._collections.get("pi_sessions").get(res.body.session_id);
  assert.equal(session.username_norm, "kec~21cs001"); // keyed to the person
  assert.equal(session.person_id, "kec~21cs001");
  assert.equal(session.college_norm, "kec");
  assert.equal(session.candidate_id, "21 CS 001");    // person display form wins
  assert.equal(session.name, "Asha");                  // person profile preferred
  assert.equal(session.identity_source, "enrollment_spine");
  assert.equal(session.identity_unresolved, undefined);
  assert.equal(session.roster_verified, false);        // no ACTIVE roster consulted
});

test("F-C cleared roster: non-matching typed id stays anonymous but is flagged identity_unresolved + surfaced in sessions-list", async () => {
  const { firestore } = freshClients();
  const contest = await createOpenContest("KPR Live 2");
  await uploadPersonRoster(contest.slug, [ROW_ASHA], { college_resolutions: { kec: { action: "create" } } });
  await call(makeReq({ method: "POST", path: "/api/admin/roster", headers: ADMIN_HEADERS,
    body: { contest: contest.slug, clear: true, confirm_clear: contest.slug } }));

  const anon = await call(startReq({
    contest: contest.slug, candidate_id: "99XX999",
    name: "Stranger", email: "s@x.com", consent_accepted: true
  }));
  assert.equal(anon.statusCode, 200, JSON.stringify(anon.body));
  const anonSession = firestore._collections.get("pi_sessions").get(anon.body.session_id);
  assert.equal(anonSession.person_id, null);             // current anonymous behavior kept
  assert.equal(anonSession.username_norm, "99xx999");
  assert.equal(anonSession.identity_unresolved, true);   // ...but LOUD

  const matched = await call(startReq({
    contest: contest.slug, candidate_id: "21CS001",
    name: "Asha", email: "asha@x.com", consent_accepted: true
  }));
  assert.equal(matched.statusCode, 200);

  const list = await call(makeReq({ method: "GET", path: "/api/admin/sessions-list", headers: ADMIN_HEADERS,
    query: { contest_slug: contest.slug } }));
  assert.equal(list.statusCode, 200);
  const byId = new Map(list.body.sessions.map((s) => [s.session_id, s]));
  assert.equal(byId.get(anon.body.session_id).identity_unresolved, true);
  assert.equal(byId.get(matched.body.session_id).identity_unresolved, false);
});

test("F-C pure no-roster contest (never uploaded): today's behavior — no flag, no person keys, no spine lookup", async () => {
  const { firestore } = freshClients();
  const contest = await createOpenContest("Walk-in Only");
  const res = await call(startReq({
    contest: contest.slug, candidate_id: "Guest 7",
    name: "Guest", email: "g@x.com", consent_accepted: true
  }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const session = firestore._collections.get("pi_sessions").get(res.body.session_id);
  assert.equal(session.person_id, null);
  assert.equal(session.username_norm, "guest7");
  assert.equal(session.identity_unresolved, undefined); // never flagged without a spine
  assert.equal(session.identity_source, undefined);
});

test("F-C removed enrollment never spine-matches (stays anonymous + flagged)", async () => {
  const { firestore } = freshClients();
  const contest = await createOpenContest("KPR Live 3");
  await uploadPersonRoster(contest.slug, [ROW_ASHA], { college_resolutions: { kec: { action: "create" } } });
  // Re-upload WITHOUT Asha (marks her enrollment removed), then clear.
  await uploadPersonRoster(contest.slug, [
    { college: "KEC", unique_id: "21CS999", name: "Other", email: "o@x.com", room: "" }
  ]);
  await call(makeReq({ method: "POST", path: "/api/admin/roster", headers: ADMIN_HEADERS,
    body: { contest: contest.slug, clear: true, confirm_clear: contest.slug } }));

  const res = await call(startReq({
    contest: contest.slug, candidate_id: "21 CS 001", // Asha's id — enrollment is removed
    name: "Asha", email: "asha@x.com", consent_accepted: true
  }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const session = firestore._collections.get("pi_sessions").get(res.body.session_id);
  assert.equal(session.person_id, null);
  assert.equal(session.identity_unresolved, true);
});
