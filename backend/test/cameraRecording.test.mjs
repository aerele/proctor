// backend/test/cameraRecording.test.mjs
//
// F10.1 — separate low-res CAMERA recording stream:
//   - proctor settings gain camera_recording {enabled (default TRUE), fps
//     (default 10, valid 1-15), width (default 640, valid 320-1280)}; invalid /
//     blank values fall back to the defaults (never 0 — the wave-2 blank-saves-0
//     hazard), and an older admin payload WITHOUT the field preserves the
//     stored value (same rule as rooms/enforcement).
//   - the session-start response serves the camera config inside upload_config
//     (the same path the screen constraints ride) so the recorder reads ONE
//     authoritative config object.
//   - /api/upload-url accepts kind "camera" → GCS objects
//     camera/chunk-{index:05d}.webm under the session storage_prefix, counted
//     on the session doc as camera_chunk_count. kind "screen" keeps owning
//     chunk_count (the admin-UI duration math) — camera chunks must never
//     inflate it. Any OTHER kind is rejected (path-traversal hardening: the
//     two known kinds are the entire upload surface).
//   - session end accepts a manifest carrying BOTH kinds.
//   - admin session-detail / recording-sessions rows surface camera_chunk_count.
import { test } from "node:test";
import assert from "node:assert/strict";

// Env MUST be set before importing the handler (it reads env at module load).
process.env.EVIDENCE_BUCKET = "camrec-bucket";
process.env.SESSION_COLLECTION = "camrec_sessions";
process.env.SETTINGS_COLLECTION = "camrec_settings";
process.env.ALERTS_COLLECTION = "camrec_alerts";
process.env.ROOM_GATES_COLLECTION = "camrec_room_gates";
process.env.LIVE_LOCK_COLLECTION = "camrec_live_locks";
process.env.ADMIN_PASSWORD = "camrec-admin-pass";

const handler = await import("../src/handler.mjs?cameraRecording");
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
            async getMetadata() { return [{ size: 1, updated: "2026-06-05T00:00:00Z" }]; }
          };
        },
        async getFiles({ prefix } = {}) {
          const files = [...saved.keys()]
            .filter((key) => !prefix || key.startsWith(prefix))
            .map((name) => ({
              name,
              metadata: { size: 1, updated: "2026-06-05T00:00:00Z" },
              async getMetadata() { return [{ size: 1, updated: "2026-06-05T00:00:00Z" }]; },
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
    created_at: "2026-06-09T09:00:00.000Z",
    chunk_count: 0,
    camera_chunk_count: 0,
    last_heartbeat_at: new Date().toISOString(),
    ...overrides
  });
}

function sessionDoc(firestore, id) {
  return firestore._collections.get(process.env.SESSION_COLLECTION).get(id);
}

const adminHeaders = { "x-admin-password": "camrec-admin-pass" };

const CAMERA_DEFAULTS = { enabled: true, fps: 10, width: 640 };

// ---- 1: settings field (defaults, validation, preservation) ----------------

test("admin settings: camera_recording defaults to enabled 10fps 640w when never configured", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  const res = await call(makeReq({ method: "GET", path: "/api/admin/settings", headers: adminHeaders }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.camera_recording, CAMERA_DEFAULTS);
});

test("admin settings: camera_recording round-trips through save and get", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  const res = await call(makeReq({ method: "POST", path: "/api/admin/settings", headers: adminHeaders,
    body: {
      start_at: "2026-06-10T03:00:00.000Z", end_at: "2026-06-10T08:00:00.000Z",
      camera_recording: { enabled: false, fps: 5, width: 800 }
    } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.camera_recording, { enabled: false, fps: 5, width: 800 });
  const get = await call(makeReq({ method: "GET", path: "/api/admin/settings", headers: adminHeaders }));
  assert.deepEqual(get.body.camera_recording, { enabled: false, fps: 5, width: 800 });
});

test("admin settings: invalid camera_recording values fall back to defaults (never 0)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  // fps 0 (the blank-saves-0 hazard), width out of range, enabled non-boolean.
  const res = await call(makeReq({ method: "POST", path: "/api/admin/settings", headers: adminHeaders,
    body: {
      start_at: "2026-06-10T03:00:00.000Z", end_at: "2026-06-10T08:00:00.000Z",
      camera_recording: { enabled: "yes", fps: 0, width: 5000 }
    } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.camera_recording, CAMERA_DEFAULTS);
});

test("admin settings: out-of-range fps (16+) and width (<320) fall back to defaults", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  const res = await call(makeReq({ method: "POST", path: "/api/admin/settings", headers: adminHeaders,
    body: {
      start_at: "2026-06-10T03:00:00.000Z", end_at: "2026-06-10T08:00:00.000Z",
      camera_recording: { enabled: true, fps: 16, width: 100 }
    } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.camera_recording, CAMERA_DEFAULTS);
});

test("admin settings: an older payload WITHOUT camera_recording preserves the stored value", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore, { camera_recording: { enabled: false, fps: 3, width: 320 } });
  const res = await call(makeReq({ method: "POST", path: "/api/admin/settings", headers: adminHeaders,
    body: { start_at: "2026-01-01T00:00:00.000Z", end_at: "2099-01-01T00:00:00.000Z" } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.camera_recording, { enabled: false, fps: 3, width: 320 });
});

// ---- 2: session start serves the camera config inside upload_config --------

test("session start: upload_config carries the camera recording config from settings", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore, { camera_recording: { enabled: true, fps: 8, width: 480 } });
  const res = await call(makeReq({ method: "POST", path: "/api/session/start", body: {
    hackerrank_username: "alice", name: "Alice A", roll_number: "R1", email: "a@x.y",
    consent_accepted: true
  } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.upload_config.camera, { enabled: true, fps: 8, width: 480 });
  // The screen constraints are untouched by the camera block.
  assert.equal(res.body.upload_config.max_width, 960);
  assert.equal(res.body.upload_config.max_frame_rate, 4);
});

test("session start: camera config defaults to enabled when settings never configured it", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  const res = await call(makeReq({ method: "POST", path: "/api/session/start", body: {
    hackerrank_username: "alice", name: "Alice A", roll_number: "R1", email: "a@x.y",
    consent_accepted: true
  } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.upload_config.camera, CAMERA_DEFAULTS);
});

test("public exam-config: serves the camera_recording block (consent copy is pre-session)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore, { camera_recording: { enabled: false, fps: 10, width: 640 } });
  const res = await call(makeReq({ method: "GET", path: "/api/exam-config" }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.camera_recording, { enabled: false, fps: 10, width: 640 });
});

// ---- 3: upload-url camera kind --------------------------------------------

test("upload-url: kind camera signs camera/chunk-{index:05d}.webm and counts camera_chunk_count", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "s-cam-1");
  const res = await call(makeReq({ method: "POST", path: "/api/upload-url", body: {
    session_id: "s-cam-1", kind: "camera", chunk_index: 3, content_type: "video/webm"
  } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.storage_key, "contests/kec-2026/sessions/alice/s-cam-1/camera/chunk-00003.webm");
  const doc = sessionDoc(firestore, "s-cam-1");
  assert.equal(doc.camera_chunk_count, 1);
  // chunk_count is the SCREEN counter (admin-UI duration math) — untouched.
  assert.equal(doc.chunk_count, 0);
});

test("upload-url: kind screen still owns chunk_count and never touches camera_chunk_count", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "s-scr-1");
  const res = await call(makeReq({ method: "POST", path: "/api/upload-url", body: {
    session_id: "s-scr-1", kind: "screen", chunk_index: 1, content_type: "video/webm"
  } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.storage_key, "contests/kec-2026/sessions/alice/s-scr-1/screen/chunk-00001.webm");
  const doc = sessionDoc(firestore, "s-scr-1");
  assert.equal(doc.chunk_count, 1);
  assert.equal(doc.camera_chunk_count || 0, 0);
});

test("upload-url: rejects any kind other than screen/camera (path-traversal hardening)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "s-kind-1");
  for (const kind of ["webcam", "../secrets", "camera/../../x", "events", ""]) {
    const res = await call(makeReq({ method: "POST", path: "/api/upload-url", body: {
      session_id: "s-kind-1", kind, chunk_index: 0, content_type: "video/webm"
    } }));
    assert.equal(res.statusCode, 400, `kind ${JSON.stringify(kind)} must be rejected`);
  }
  // Nothing counted on the doc for rejected kinds.
  const doc = sessionDoc(firestore, "s-kind-1");
  assert.equal(doc.chunk_count, 0);
  assert.equal(doc.camera_chunk_count, 0);
});

test("upload-url: camera chunk_index must be a non-negative integer", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "s-idx-1");
  for (const chunkIndex of [-1, 1.5, "seven", null]) {
    const res = await call(makeReq({ method: "POST", path: "/api/upload-url", body: {
      session_id: "s-idx-1", kind: "camera", chunk_index: chunkIndex, content_type: "video/webm"
    } }));
    assert.equal(res.statusCode, 400, `chunk_index ${JSON.stringify(chunkIndex)} must be rejected`);
  }
});

// ---- 4: session end accepts a mixed-kind manifest ---------------------------

test("session end: manifest with screen AND camera entries is accepted and stored", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  seedSettings(firestore);
  seedSession(firestore, "s-end-1", { chunk_count: 2, camera_chunk_count: 2 });
  const res = await call(makeReq({ method: "POST", path: "/api/session/end", body: {
    session_id: "s-end-1",
    assurance_accepted: true,
    manifest: [
      { kind: "screen", index: 1, storage_key: "contests/kec-2026/sessions/alice/s-end-1/screen/chunk-00001.webm" },
      { kind: "screen", index: 2, storage_key: "contests/kec-2026/sessions/alice/s-end-1/screen/chunk-00002.webm" },
      { kind: "camera", index: 1, storage_key: "contests/kec-2026/sessions/alice/s-end-1/camera/chunk-00001.webm" },
      { kind: "camera", index: 2, storage_key: "contests/kec-2026/sessions/alice/s-end-1/camera/chunk-00002.webm" }
    ]
  } }));
  assert.equal(res.statusCode, 200);
  const doc = sessionDoc(firestore, "s-end-1");
  assert.equal(doc.status, "ended");
  assert.equal(doc.uploaded_manifest_count, 4);
  // The screen-chunk counter the admin UI's duration math reads is untouched.
  assert.equal(doc.chunk_count, 2);
  assert.equal(doc.camera_chunk_count, 2);
  const manifestBody = storage._saved.get("contests/kec-2026/sessions/alice/s-end-1/manifest.json");
  assert.ok(manifestBody?.includes("camera/chunk-00001.webm"));
});

// ---- 5: admin surfaces camera_chunk_count -----------------------------------

test("admin session-detail: includes camera_chunk_count", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSession(firestore, "s-det-1", { chunk_count: 5, camera_chunk_count: 4 });
  const res = await call(makeReq({ method: "GET", path: "/api/admin/session-detail",
    headers: adminHeaders, query: { session_id: "s-det-1" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.session.chunk_count, 5);
  assert.equal(res.body.session.camera_chunk_count, 4);
});

test("admin recording-sessions: rows include camera_chunk_count (0 for legacy docs)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSession(firestore, "s-rec-1", { chunk_count: 6, camera_chunk_count: 6 });
  seedSession(firestore, "s-rec-legacy", { username_norm: "bob", hackerrank_username: "Bob", chunk_count: 3, camera_chunk_count: undefined });
  const res = await call(makeReq({ method: "GET", path: "/api/admin/recording-sessions", headers: adminHeaders, query: {} }));
  assert.equal(res.statusCode, 200);
  const byId = Object.fromEntries(res.body.sessions.map((s) => [s.session_id, s]));
  assert.equal(byId["s-rec-1"].camera_chunk_count, 6);
  assert.equal(byId["s-rec-legacy"].camera_chunk_count, 0);
});
