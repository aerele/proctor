// backend/test/screenMarkers.test.mjs
//
// OMR P1 (2026-06-12 overlay-detection design §5.2/§11) — the screen-marker
// FEATURE FLAG plumbing, mirroring camera_recording end-to-end:
//   - settings doc gains screen_markers { enabled } — default OFF, garbage
//     falls back to disabled, an older admin payload WITHOUT the field
//     preserves the stored value (same rules as camera_recording).
//   - contest snapshot override: person-contest sessions read the CONTEST's
//     screen_markers field (template defaults -> instantiate -> contest doc),
//     legacy sessions read the global settings doc.
//   - THE HARD INVARIANT: the session start/resume response carries the
//     screen_markers key ONLY when enabled. Flag off (the default) keeps the
//     payload byte-identical to today — the EXACT pre-change key set is pinned
//     below — and the canary-pinned no-param /api/exam-config payload is never
//     touched in either flag state.
import { test } from "node:test";
import assert from "node:assert/strict";

// Env MUST be set before importing the handler (it reads env at module load).
process.env.EVIDENCE_BUCKET = "smark-bucket";
process.env.SESSION_COLLECTION = "smark_sessions";
process.env.SETTINGS_COLLECTION = "smark_settings";
process.env.ALERTS_COLLECTION = "smark_alerts";
process.env.CONTESTS_COLLECTION = "smark_contests";
process.env.ROOM_GATES_COLLECTION = "smark_room_gates";
process.env.LIVE_LOCK_COLLECTION = "smark_live_locks";
process.env.ADMIN_PASSWORD = "smark-admin-pass";

const handler = await import("../src/handler.mjs?screenMarkers");
const { api, __setClientsForTest } = handler;
const { normalizeTemplateScreenMarkers, validateTemplateInput, structuredCloneTemplate, SEED_TEMPLATES } =
  await import("../src/templates.mjs");

// Inline req/res mocks + fakes (repo convention: copied per test file, NO helpers.mjs).
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
    if (isIncrementSentinel(value)) {
      next[key] = Number(next[key] || 0) + value.operand;
    } else {
      next[key] = value;
    }
  }
  return next;
}

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
            async update(patch) {
              const existing = store.get(id);
              if (!existing) {
                const err = new Error("NOT_FOUND");
                err.code = 5;
                throw err;
              }
              store.set(id, applyUpdate(existing, patch));
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
            async getMetadata() { return [{ size: 1, updated: "2026-06-12T00:00:00Z" }]; }
          };
        },
        async getFiles({ prefix } = {}) {
          const files = [...saved.keys()]
            .filter((key) => !prefix || key.startsWith(prefix))
            .map((name) => ({
              name,
              metadata: { size: 1, updated: "2026-06-12T00:00:00Z" },
              async getMetadata() { return [{ size: 1, updated: "2026-06-12T00:00:00Z" }]; },
              async getSignedUrl() { return [`https://signed.example/${name}`]; }
            }));
          return [files];
        }
      };
    }
  };
}

// ---- Seed helpers -----------------------------------------------------------

function seedSettings(firestore, overrides = {}) {
  firestore.collection(process.env.SETTINGS_COLLECTION).doc("active").set({
    start_at: "2026-01-01T00:00:00.000Z",
    end_at: "2099-01-01T00:00:00.000Z",
    contest_url: "https://www.hackerrank.com/contests/kec-2026",
    contest_slug: "kec-2026",
    ...overrides
  });
}

function seedSession(firestore, id, overrides = {}) {
  firestore.collection(process.env.SESSION_COLLECTION).doc(id).set({
    session_id: id, status: "active",
    hackerrank_username: "Alice", username_norm: "alice",
    name: "Alice A", roll_number: "R1", email: "a@x.y", room: "Lab A-1",
    contest_slug: "kec-2026",
    storage_prefix: `contests/kec-2026/sessions/alice/${id}/`,
    created_at: "2026-06-12T09:00:00.000Z",
    chunk_count: 0,
    camera_chunk_count: 0,
    last_heartbeat_at: new Date().toISOString(),
    ...overrides
  });
}

function seedPersonContest(firestore, slug, overrides = {}) {
  firestore.collection(process.env.CONTESTS_COLLECTION).doc(slug).set({
    slug, name: slug, status: "open", listed: true,
    identity_mode: "person", identity_label: "Roll Number",
    start_at: "2026-01-01T00:00:00.000Z", end_at: "2099-01-01T00:00:00.000Z",
    room_gate_enabled: false, rooms: [], problems: [],
    created_at: "2026-06-12T00:00:00.000Z", updated_at: "2026-06-12T00:00:00.000Z",
    ...overrides
  });
}

const adminHeaders = { "x-admin-password": "smark-admin-pass" };

function startReq(extra = {}) {
  return makeReq({ method: "POST", path: "/api/session/start", body: {
    hackerrank_username: "alice", name: "Alice A", roll_number: "R1", email: "a@x.y",
    consent_accepted: true, ...extra
  } });
}

// THE pre-change session start/resume key set (today's live payload). Any new
// key appearing here with the flag OFF is a regression of the byte-identical
// invariant; with the flag ON exactly "screen_markers" may be added.
const START_RESPONSE_KEYS_TODAY = [
  "blocked_by_session_id", "camera_chunk_count", "camera_chunk_index_hwm",
  "candidate_id", "chunk_count", "contest_slug", "contest_url", "created_at",
  "end_at", "enforcement", "enforcement_exemptions", "hackerrank_username",
  "heartbeat_interval_seconds", "identity_label", "locked_reason", "name",
  "problem", "problems", "room", "room_gate_enabled", "screen_chunk_index_hwm",
  "server_now", "session_id", "start_ip", "status", "storage_prefix",
  "submissions_summary", "submit_budget", "upload_config"
];

// ---- 1: settings field (default OFF, validation, preservation) --------------

test("admin settings: screen_markers defaults to DISABLED when never configured", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  const res = await call(makeReq({ method: "GET", path: "/api/admin/settings", headers: adminHeaders }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.screen_markers, { enabled: false });
});

test("admin settings: screen_markers round-trips through save and get", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  const res = await call(makeReq({ method: "POST", path: "/api/admin/settings", headers: adminHeaders,
    body: {
      start_at: "2026-06-12T03:00:00.000Z", end_at: "2026-06-12T08:00:00.000Z",
      screen_markers: { enabled: true }
    } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.screen_markers, { enabled: true });
  const get = await call(makeReq({ method: "GET", path: "/api/admin/settings", headers: adminHeaders }));
  assert.deepEqual(get.body.screen_markers, { enabled: true });
});

test("admin settings: garbage screen_markers values fall back to DISABLED (never on by accident)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  for (const garbage of [{ enabled: "yes" }, { enabled: 1 }, "on", 42, [], null, {}]) {
    const res = await call(makeReq({ method: "POST", path: "/api/admin/settings", headers: adminHeaders,
      body: {
        start_at: "2026-06-12T03:00:00.000Z", end_at: "2026-06-12T08:00:00.000Z",
        screen_markers: garbage
      } }));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.screen_markers, { enabled: false },
      `garbage ${JSON.stringify(garbage)} must normalize to disabled`);
  }
});

test("admin settings: an older payload WITHOUT screen_markers preserves the stored value", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore, { screen_markers: { enabled: true } });
  const res = await call(makeReq({ method: "POST", path: "/api/admin/settings", headers: adminHeaders,
    body: { start_at: "2026-01-01T00:00:00.000Z", end_at: "2099-01-01T00:00:00.000Z" } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.screen_markers, { enabled: true });
});

// ---- 2: THE byte-identical-when-off invariant on start/resume ---------------

test("session start: flag OFF (default) — response key set is EXACTLY today's, no screen_markers byte anywhere", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore); // no screen_markers stored at all — today's live doc
  const res = await call(startReq());
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(Object.keys(res.body).sort(), START_RESPONSE_KEYS_TODAY);
  assert.ok(!JSON.stringify(res.body).includes("screen_markers"),
    "flag-off start response must not contain a single screen_markers byte");
});

test("session start: flag explicitly saved OFF — still byte-identical (no key)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore, { screen_markers: { enabled: false } });
  const res = await call(startReq());
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body).sort(), START_RESPONSE_KEYS_TODAY);
});

test("session start: flag ON — response gains EXACTLY the screen_markers key, enabled true", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore, { screen_markers: { enabled: true } });
  const res = await call(startReq());
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body).sort(), [...START_RESPONSE_KEYS_TODAY, "screen_markers"].sort());
  assert.deepEqual(res.body.screen_markers, { enabled: true });
  // Nothing existing changed shape: the recorder's upload_config is untouched.
  assert.equal(res.body.upload_config.max_width, 960);
  assert.equal(res.body.upload_config.max_frame_rate, 4);
});

test("session resume: flag OFF omits the key; flag ON carries it (same carrier as start)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "s-res-1");
  const off = await call(makeReq({ method: "POST", path: "/api/session/resume",
    body: { session_id: "s-res-1", hackerrank_username: "alice" } }));
  assert.equal(off.statusCode, 200, JSON.stringify(off.body));
  assert.ok(!("screen_markers" in off.body));

  seedSettings(firestore, { screen_markers: { enabled: true } });
  const on = await call(makeReq({ method: "POST", path: "/api/session/resume",
    body: { session_id: "s-res-1", hackerrank_username: "alice" } }));
  assert.equal(on.statusCode, 200);
  assert.deepEqual(on.body.screen_markers, { enabled: true });
});

// ---- 3: contest snapshot override (person contests own their flag) ----------

test("person-contest resume: the CONTEST's screen_markers wins over the settings doc (both directions)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  // Contest ON, settings OFF -> key rides.
  seedSettings(firestore, { screen_markers: { enabled: false } });
  seedPersonContest(firestore, "round-1", { screen_markers: { enabled: true } });
  seedSession(firestore, "s-pc-1", {
    contest_slug: "round-1", candidate_id: "21 CS 001",
    username_norm: "kec~21cs001",
    storage_prefix: "contests/round-1/sessions/kec~21cs001/s-pc-1/"
  });
  const on = await call(makeReq({ method: "POST", path: "/api/session/resume",
    body: { session_id: "s-pc-1", contest: "round-1" } }));
  assert.equal(on.statusCode, 200, JSON.stringify(on.body));
  assert.deepEqual(on.body.screen_markers, { enabled: true });

  // Contest OFF (legacy contest doc with no field), settings ON -> key absent.
  seedSettings(firestore, { screen_markers: { enabled: true } });
  seedPersonContest(firestore, "round-2"); // no screen_markers on the doc -> default OFF
  seedSession(firestore, "s-pc-2", {
    contest_slug: "round-2", candidate_id: "21 CS 002",
    username_norm: "kec~21cs002",
    storage_prefix: "contests/round-2/sessions/kec~21cs002/s-pc-2/"
  });
  const off = await call(makeReq({ method: "POST", path: "/api/session/resume",
    body: { session_id: "s-pc-2", contest: "round-2" } }));
  assert.equal(off.statusCode, 200, JSON.stringify(off.body));
  assert.ok(!("screen_markers" in off.body),
    "a person contest whose doc has no/OFF screen_markers must omit the key even when settings turned it on");
});

// ---- 4: the canary-pinned no-param exam-config is NEVER touched -------------

test("exam-config (no param): key set unchanged even with the flag ON in settings", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore, { screen_markers: { enabled: true } });
  const res = await call(makeReq({ method: "GET", path: "/api/exam-config" }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    Object.keys(res.body).sort(),
    ["camera_recording", "enforcement", "rooms", "roster_required", "unique_id_label"]
  );
});

test("exam-config (?contest=): no screen_markers leak on the contest branch either", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore, { screen_markers: { enabled: true } });
  seedPersonContest(firestore, "round-3", { screen_markers: { enabled: true } });
  const res = await call(makeReq({ method: "GET", path: "/api/exam-config", query: { contest: "round-3" } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(!JSON.stringify(res.body).includes("screen_markers"),
    "exam-config must never carry the marker flag (design §5.2: start/resume is the only carrier)");
});

// ---- 5: template defaults + contest instantiation snapshot ------------------

test("normalizeTemplateScreenMarkers: default OFF, garbage falls back, explicit booleans honored", () => {
  assert.deepEqual(normalizeTemplateScreenMarkers(undefined), { enabled: false });
  assert.deepEqual(normalizeTemplateScreenMarkers(null), { enabled: false });
  assert.deepEqual(normalizeTemplateScreenMarkers({}), { enabled: false });
  assert.deepEqual(normalizeTemplateScreenMarkers({ enabled: "yes" }), { enabled: false });
  assert.deepEqual(normalizeTemplateScreenMarkers([true]), { enabled: false });
  assert.deepEqual(normalizeTemplateScreenMarkers({ enabled: true }), { enabled: true });
  assert.deepEqual(normalizeTemplateScreenMarkers({ enabled: false }), { enabled: false });
});

test("validateTemplateInput: defaults gain screen_markers (OFF unless explicitly enabled)", () => {
  const base = {
    name: "R1", description: "",
    problems: [{ problem_id: "sum-two", points: null, order: 0 }]
  };
  const noDefaults = validateTemplateInput(base);
  assert.equal(noDefaults.ok, true);
  assert.deepEqual(noDefaults.template.defaults.screen_markers, { enabled: false });
  const enabled = validateTemplateInput({ ...base, defaults: { screen_markers: { enabled: true } } });
  assert.equal(enabled.ok, true);
  assert.deepEqual(enabled.template.defaults.screen_markers, { enabled: true });
});

test("SEED_TEMPLATES + structuredCloneTemplate: seed defaults carry screen_markers OFF; clones never share the object", () => {
  assert.deepEqual(SEED_TEMPLATES["system-check"].defaults.screen_markers, { enabled: false });
  const clone = structuredCloneTemplate(SEED_TEMPLATES["system-check"]);
  assert.deepEqual(clone.defaults.screen_markers, { enabled: false });
  assert.notEqual(clone.defaults.screen_markers, SEED_TEMPLATES["system-check"].defaults.screen_markers);
  // A pre-flag stored template (no field) clones to the normalized default.
  const legacy = structuredCloneTemplate({ problems: [], defaults: {} });
  assert.deepEqual(legacy.defaults.screen_markers, { enabled: false });
});

test("contest create: screen_markers snapshots onto the contest doc (default OFF, explicit body wins)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  const off = await call(makeReq({ method: "POST", path: "/api/admin/contests", headers: adminHeaders,
    body: { name: "Markers Off", problems: [{ problem_id: "sum-two" }] } }));
  assert.equal(off.statusCode, 200, JSON.stringify(off.body));
  const offDoc = firestore._collections.get(process.env.CONTESTS_COLLECTION).get("markers-off");
  assert.deepEqual(offDoc.screen_markers, { enabled: false });

  const on = await call(makeReq({ method: "POST", path: "/api/admin/contests", headers: adminHeaders,
    body: { name: "Markers On", problems: [{ problem_id: "sum-two" }], screen_markers: { enabled: true } } }));
  assert.equal(on.statusCode, 200, JSON.stringify(on.body));
  const onDoc = firestore._collections.get(process.env.CONTESTS_COLLECTION).get("markers-on");
  assert.deepEqual(onDoc.screen_markers, { enabled: true });
});

test("contest update: screen_markers patches when sent, preserved when absent", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedPersonContest(firestore, "patchable", { status: "draft", screen_markers: { enabled: false } });
  const patched = await call(makeReq({ method: "POST", path: "/api/admin/contest-update", headers: adminHeaders,
    body: { slug: "patchable", screen_markers: { enabled: true } } }));
  assert.equal(patched.statusCode, 200, JSON.stringify(patched.body));
  assert.deepEqual(firestore._collections.get(process.env.CONTESTS_COLLECTION).get("patchable").screen_markers,
    { enabled: true });
  const untouched = await call(makeReq({ method: "POST", path: "/api/admin/contest-update", headers: adminHeaders,
    body: { slug: "patchable", name: "Renamed" } }));
  assert.equal(untouched.statusCode, 200, JSON.stringify(untouched.body));
  assert.deepEqual(firestore._collections.get(process.env.CONTESTS_COLLECTION).get("patchable").screen_markers,
    { enabled: true });
});
