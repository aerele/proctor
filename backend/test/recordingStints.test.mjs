// backend/test/recordingStints.test.mjs
//
// F1 (e2e-live finding, 2026-06-11) — recording chunks must SURVIVE recorder
// restarts within one session. Three server-side guarantees:
//   1. /api/upload-url tracks a per-kind chunk-index HIGH-WATER MARK on the
//      session doc (screen_chunk_index_hwm / camera_chunk_index_hwm) so the
//      server always knows the highest index ever issued.
//   2. A request at/below the hwm (an old/stale client restarting its count at
//      1 after a share-drop / refresh) is BUMPED to hwm+1 — it can never mint
//      a write URL that overwrites a prior stint's object. Monotonic requests
//      from the fixed client pass through untouched.
//   3. start/resume responses carry chunk_count, camera_chunk_count and both
//      hwm fields (plus created_at for the elapsed anchor), so the resumed
//      recorder continues its count instead of restarting at 1.
// Storage layout is UNCHANGED (kind/chunk-{index:05d}.ext) — existing recorded
// sessions keep playing as-is.
import { test } from "node:test";
import assert from "node:assert/strict";

// Env MUST be set before importing the handler (it reads env at module load).
process.env.EVIDENCE_BUCKET = "stints-bucket";
process.env.SESSION_COLLECTION = "stints_sessions";
process.env.SETTINGS_COLLECTION = "stints_settings";
process.env.ALERTS_COLLECTION = "stints_alerts";
process.env.ROOM_GATES_COLLECTION = "stints_room_gates";
process.env.LIVE_LOCK_COLLECTION = "stints_live_locks";
process.env.ADMIN_PASSWORD = "stints-admin-pass";

const handler = await import("../src/handler.mjs?recordingStints");
const { api, __setClientsForTest } = handler;

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
            async getMetadata() { return [{ size: 1, updated: "2026-06-11T00:00:00Z" }]; }
          };
        },
        async getFiles({ prefix } = {}) {
          const files = [...saved.keys()]
            .filter((key) => !prefix || key.startsWith(prefix))
            .map((name) => ({
              name,
              metadata: { size: 1, updated: "2026-06-11T00:00:00Z" },
              async getMetadata() { return [{ size: 1, updated: "2026-06-11T00:00:00Z" }]; },
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
    created_at: "2026-06-11T09:00:00.000Z",
    chunk_count: 0,
    camera_chunk_count: 0,
    last_heartbeat_at: new Date().toISOString(),
    ...overrides
  });
}

function sessionDoc(firestore, id) {
  return firestore._collections.get(process.env.SESSION_COLLECTION).get(id);
}

async function uploadUrl(sessionId, kind, chunkIndex) {
  return call(makeReq({ method: "POST", path: "/api/upload-url", body: {
    session_id: sessionId, kind, chunk_index: chunkIndex, content_type: "video/webm"
  } }));
}

// ---- 1: hwm tracking + monotonic requests pass through unchanged ------------

test("upload-url: monotonic indexes pass through untouched and advance the per-kind hwm", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "s-mono");

  for (const index of [1, 2, 3]) {
    const res = await uploadUrl("s-mono", "screen", index);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.storage_key,
      `contests/kec-2026/sessions/alice/s-mono/screen/chunk-${String(index).padStart(5, "0")}.webm`);
  }
  const camera = await uploadUrl("s-mono", "camera", 1);
  assert.equal(camera.statusCode, 200);
  assert.equal(camera.body.storage_key, "contests/kec-2026/sessions/alice/s-mono/camera/chunk-00001.webm");

  const doc = sessionDoc(firestore, "s-mono");
  assert.equal(doc.screen_chunk_index_hwm, 3);
  assert.equal(doc.camera_chunk_index_hwm, 1);
  // F10.1 counters keep their existing semantics (one per issued URL).
  assert.equal(doc.chunk_count, 3);
  assert.equal(doc.camera_chunk_count, 1);
});

// ---- 2: the overwrite guard — a restarted count is bumped past the hwm ------

test("upload-url: an index at/below the hwm is bumped to hwm+1 (no overwrite of a prior stint)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "s-bump");

  // Stint 1 recorded chunks 1..24.
  for (let index = 1; index <= 24; index += 1) {
    assert.equal((await uploadUrl("s-bump", "screen", index)).statusCode, 200);
  }
  // A stale client restarts its count at 1 → the server serves 25, not 1.
  const restarted = await uploadUrl("s-bump", "screen", 1);
  assert.equal(restarted.statusCode, 200);
  assert.equal(restarted.body.storage_key,
    "contests/kec-2026/sessions/alice/s-bump/screen/chunk-00025.webm");
  // And its next request (2) keeps moving forward (26), never back.
  const next = await uploadUrl("s-bump", "screen", 2);
  assert.equal(next.body.storage_key,
    "contests/kec-2026/sessions/alice/s-bump/screen/chunk-00026.webm");
  assert.equal(sessionDoc(firestore, "s-bump").screen_chunk_index_hwm, 26);
});

test("upload-url: the bump is PER KIND — a camera restart never disturbs the screen series", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "s-kinds");

  assert.equal((await uploadUrl("s-kinds", "screen", 5)).statusCode, 200);
  assert.equal((await uploadUrl("s-kinds", "camera", 5)).statusCode, 200);
  const cameraRestart = await uploadUrl("s-kinds", "camera", 1);
  assert.equal(cameraRestart.body.storage_key,
    "contests/kec-2026/sessions/alice/s-kinds/camera/chunk-00006.webm");
  const screenNext = await uploadUrl("s-kinds", "screen", 6);
  assert.equal(screenNext.body.storage_key,
    "contests/kec-2026/sessions/alice/s-kinds/screen/chunk-00006.webm");
});

// ---- 3: back-compat — pre-F1 sessions (no hwm field) keep today's behavior --

test("upload-url: a pre-F1 session doc (hwm absent) serves the requested index unchanged", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  // A legacy doc that already counted 24 issued URLs but has NO hwm field.
  seedSession(firestore, "s-legacy", { chunk_count: 24 });

  const res = await uploadUrl("s-legacy", "screen", 1);
  assert.equal(res.statusCode, 200);
  // No hwm knowledge → no bump (exactly today's behavior for the first call) —
  // but the hwm starts tracking from here on.
  assert.equal(res.body.storage_key, "contests/kec-2026/sessions/alice/s-legacy/screen/chunk-00001.webm");
  assert.equal(sessionDoc(firestore, "s-legacy").screen_chunk_index_hwm, 1);
});

// ---- 4: start/resume responses carry the continuation fields ----------------

test("resume: response carries chunk counts + hwm fields + created_at for the recorder to continue from", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "s-resume", {
    chunk_count: 24, camera_chunk_count: 23,
    screen_chunk_index_hwm: 24, camera_chunk_index_hwm: 23
  });

  const res = await call(makeReq({ method: "POST", path: "/api/session/resume", body: { session_id: "s-resume" } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.chunk_count, 24);
  assert.equal(res.body.camera_chunk_count, 23);
  assert.equal(res.body.screen_chunk_index_hwm, 24);
  assert.equal(res.body.camera_chunk_index_hwm, 23);
  assert.equal(res.body.created_at, "2026-06-11T09:00:00.000Z");
});

test("resume: a pre-F1 session (no counters) serves zeros, never NaN/undefined", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "s-zero", { chunk_count: undefined, camera_chunk_count: undefined });

  const res = await call(makeReq({ method: "POST", path: "/api/session/resume", body: { session_id: "s-zero" } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.chunk_count, 0);
  assert.equal(res.body.camera_chunk_count, 0);
  assert.equal(res.body.screen_chunk_index_hwm, 0);
  assert.equal(res.body.camera_chunk_index_hwm, 0);
});

// ---- 5: the full two-stint flow — every chunk key is unique -----------------

test("two stints with a resume in between never collide on storage keys", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "s-flow");

  const issued = new Set();
  // Stint 1: the fixed client counts 1..3.
  for (const index of [1, 2, 3]) {
    const res = await uploadUrl("s-flow", "screen", index);
    assert.equal(res.statusCode, 200);
    assert.ok(!issued.has(res.body.storage_key), `duplicate key ${res.body.storage_key}`);
    issued.add(res.body.storage_key);
  }
  // Share drop → resume: the client reads the continuation base off resume.
  const resume = await call(makeReq({ method: "POST", path: "/api/session/resume", body: { session_id: "s-flow" } }));
  const base = Math.max(resume.body.chunk_count, resume.body.screen_chunk_index_hwm);
  assert.equal(base, 3);
  // Stint 2: continues at base+1.. — still unique keys.
  for (const offset of [1, 2]) {
    const res = await uploadUrl("s-flow", "screen", base + offset);
    assert.equal(res.statusCode, 200);
    assert.ok(!issued.has(res.body.storage_key), `duplicate key ${res.body.storage_key}`);
    issued.add(res.body.storage_key);
  }
  assert.equal(issued.size, 5);
});
