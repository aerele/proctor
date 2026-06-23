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
process.env.CONTESTS_COLLECTION = "camrec_contests";
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

const CONTEST_SLUG = "kec-2026";

// Seed an OPEN, no-roster person contest directly. camera_recording overrides
// ride straight onto the contest doc (S-I snapshot field) — the same shape the
// session-bound serve paths read via cameraRecordingConfigFor.
function seedContest(firestore, { camera_recording, take_home_enabled, proctor_contact_phone } = {}) {
  const doc = {
    slug: CONTEST_SLUG,
    name: CONTEST_SLUG,
    status: "open",
    identity_mode: "person",
    identity_label: "Candidate ID",
    start_at: "2026-01-01T00:00:00.000Z",
    end_at: "2099-01-01T00:00:00.000Z",
    problems: [{ problem_id: "sum-two", points: null, order: 0 }],
    rooms: [],
    room_gate_enabled: false
  };
  if (camera_recording !== undefined) doc.camera_recording = camera_recording;
  if (take_home_enabled !== undefined) doc.take_home_enabled = take_home_enabled;
  if (proctor_contact_phone !== undefined) doc.proctor_contact_phone = proctor_contact_phone;
  firestore.collection(process.env.CONTESTS_COLLECTION).doc(CONTEST_SLUG).set(doc);
}

function startBody(overrides = {}) {
  return {
    contest: CONTEST_SLUG,
    candidate_id: "alice",
    name: "Alice A",
    email: "a@x.y",
    roll_number: "R1",
    consent_accepted: true,
    ...overrides
  };
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

// ---- 1: camera_recording snapshot field (defaults, validation) -------------

test("exam-config: camera_recording defaults to enabled 10fps 640w when the contest never configured it", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedContest(firestore);
  const res = await call(makeReq({ method: "GET", path: "/api/exam-config", query: { contest: CONTEST_SLUG } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.camera_recording, CAMERA_DEFAULTS);
});

test("T-B1 exam-config: take_home_enabled/proctor_contact_phone default falsy for a legacy contest; window fields still present", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedContest(firestore); // no take-home fields set (legacy doc)
  const res = await call(makeReq({ method: "GET", path: "/api/exam-config", query: { contest: CONTEST_SLUG } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.take_home_enabled, false);
  assert.equal(res.body.proctor_contact_phone, "");
  // The skew anchors + window fields the waiting-room gate seeds off are present.
  assert.equal(res.body.start_at, "2026-01-01T00:00:00.000Z");
  assert.equal(res.body.end_at, "2099-01-01T00:00:00.000Z");
  assert.ok(Number.isFinite(Date.parse(res.body.server_now)));
});

test("T-B1 exam-config: take_home_enabled/proctor_contact_phone reflect the remote contest's values", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedContest(firestore, { take_home_enabled: true, proctor_contact_phone: "+91 98765 43210" });
  const res = await call(makeReq({ method: "GET", path: "/api/exam-config", query: { contest: CONTEST_SLUG } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.take_home_enabled, true);
  assert.equal(res.body.proctor_contact_phone, "+91 98765 43210");
});

test("exam-config: camera_recording reflects the contest's snapshot value", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedContest(firestore, { camera_recording: { enabled: false, fps: 5, width: 800 } });
  const res = await call(makeReq({ method: "GET", path: "/api/exam-config", query: { contest: CONTEST_SLUG } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.camera_recording, { enabled: false, fps: 5, width: 800 });
});

test("exam-config: invalid camera_recording values on the contest fall back to defaults (never 0)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  // fps 0 (the blank-saves-0 hazard), width out of range, enabled non-boolean.
  seedContest(firestore, { camera_recording: { enabled: "yes", fps: 0, width: 5000 } });
  const res = await call(makeReq({ method: "GET", path: "/api/exam-config", query: { contest: CONTEST_SLUG } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.camera_recording, CAMERA_DEFAULTS);
});

test("exam-config: out-of-range fps (16+) and width (<320) fall back to defaults", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedContest(firestore, { camera_recording: { enabled: true, fps: 16, width: 100 } });
  const res = await call(makeReq({ method: "GET", path: "/api/exam-config", query: { contest: CONTEST_SLUG } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.camera_recording, CAMERA_DEFAULTS);
});

// ---- 2: session start serves the camera config inside upload_config --------

test("session start: upload_config carries the camera recording config from the contest", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedContest(firestore, { camera_recording: { enabled: true, fps: 8, width: 480 } });
  const res = await call(makeReq({ method: "POST", path: "/api/session/start", body: startBody() }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.upload_config.camera, { enabled: true, fps: 8, width: 480 });
  // The screen constraints are untouched by the camera block.
  assert.equal(res.body.upload_config.max_width, 960);
  assert.equal(res.body.upload_config.max_frame_rate, 4);
});

test("session start: camera config defaults to enabled when the contest never configured it", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedContest(firestore);
  const res = await call(makeReq({ method: "POST", path: "/api/session/start", body: startBody() }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.upload_config.camera, CAMERA_DEFAULTS);
});

test("public exam-config: serves the camera_recording block (consent copy is pre-session)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedContest(firestore, { camera_recording: { enabled: false, fps: 10, width: 640 } });
  const res = await call(makeReq({ method: "GET", path: "/api/exam-config", query: { contest: CONTEST_SLUG } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.camera_recording, { enabled: false, fps: 10, width: 640 });
});

// ---- 3: upload-url camera kind --------------------------------------------

test("upload-url: kind camera signs camera/chunk-{index:05d}.webm and counts camera_chunk_count", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
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

// ---- REC-4: ground-truth stored chunk counts (GCS listing) ------------------

// The regression that proves REC-4: 3 screen URLs minted (chunk_count===3) but
// only ONE screen object actually stored in GCS → stored_chunk_count===1. The
// mint counter must be UNCHANGED (still 3 — it feeds the picker + hwm).
test("admin session-detail: stored_chunk_count is the real GCS object count, not the mint counter", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  // chunk_count: 3 simulates 3 mint requests (retries/drains over-counting).
  seedSession(firestore, "s-stored-1", { chunk_count: 3, camera_chunk_count: 2 });
  // Place ONLY ONE screen object + ONE camera object under the session prefix.
  await storage.bucket().file("contests/kec-2026/sessions/alice/s-stored-1/screen/chunk-00000.webm").save("x");
  await storage.bucket().file("contests/kec-2026/sessions/alice/s-stored-1/camera/chunk-00000.webm").save("x");
  const res = await call(makeReq({ method: "GET", path: "/api/admin/session-detail",
    headers: adminHeaders, query: { session_id: "s-stored-1" } }));
  assert.equal(res.statusCode, 200);
  // Mint counter UNCHANGED (back-compat, picker filter, hwm).
  assert.equal(res.body.session.chunk_count, 3);
  assert.equal(res.body.session.camera_chunk_count, 2);
  // Ground truth: exactly what is stored.
  assert.equal(res.body.session.stored_chunk_count, 1);
  assert.equal(res.body.session.stored_camera_chunk_count, 1);
});

// stored == mints (a clean session, no retries) → pending 0.
test("admin session-detail: stored count matches mints when every PUT stored (pending 0)", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  seedSession(firestore, "s-stored-2", { chunk_count: 2, camera_chunk_count: 0 });
  await storage.bucket().file("contests/kec-2026/sessions/alice/s-stored-2/screen/chunk-00000.webm").save("x");
  await storage.bucket().file("contests/kec-2026/sessions/alice/s-stored-2/screen/chunk-00001.webm").save("x");
  const res = await call(makeReq({ method: "GET", path: "/api/admin/session-detail",
    headers: adminHeaders, query: { session_id: "s-stored-2" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.session.stored_chunk_count, 2);
  assert.equal(res.body.session.stored_camera_chunk_count, 0);
  // no client-reported backlog (buffer_pending_chunks unset) → pending 0.
  assert.equal(res.body.session.pending_upload_count, 0);
});

// Counting must ignore non-chunk objects (events/, manifest.json) under the prefix.
test("admin session-detail: stored count ignores non-chunk objects under the prefix", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  seedSession(firestore, "s-stored-3", { chunk_count: 1, camera_chunk_count: 0 });
  await storage.bucket().file("contests/kec-2026/sessions/alice/s-stored-3/screen/chunk-00000.webm").save("x");
  await storage.bucket().file("contests/kec-2026/sessions/alice/s-stored-3/events/2026.jsonl").save("x");
  await storage.bucket().file("contests/kec-2026/sessions/alice/s-stored-3/manifest.json").save("x");
  const res = await call(makeReq({ method: "GET", path: "/api/admin/session-detail",
    headers: adminHeaders, query: { session_id: "s-stored-3" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.session.stored_chunk_count, 1);
  assert.equal(res.body.session.stored_camera_chunk_count, 0);
});

// ---- REC-5: pending-upload count + raw backlog fields -----------------------

// pending_upload_count reflects the client-reported backlog (buffer_pending_chunks),
// NOT the mint inflation, and the raw heartbeat fields round-trip.
test("admin session-detail: pending_upload_count reflects the client-reported backlog", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  seedSession(firestore, "s-pending-1", {
    chunk_count: 5, camera_chunk_count: 0,
    buffer_pending_chunks: 4, buffer_pending_bytes: 2048, upload_queue_depth: 2,
    last_heartbeat_at: "2026-06-09T10:00:00.000Z"
  });
  // Client last reported 4 buffered chunks → pending 4. (mints=5 vs stored=1 is
  // retry inflation, NOT pending — pending tracks the client's backlog only.)
  await storage.bucket().file("contests/kec-2026/sessions/alice/s-pending-1/screen/chunk-00000.webm").save("x");
  const res = await call(makeReq({ method: "GET", path: "/api/admin/session-detail",
    headers: adminHeaders, query: { session_id: "s-pending-1" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.session.stored_chunk_count, 1);
  assert.equal(res.body.session.pending_upload_count, 4);
  assert.equal(res.body.session.buffer_pending_chunks, 4);
  assert.equal(res.body.session.buffer_pending_bytes, 2048);
  assert.equal(res.body.session.upload_queue_depth, 2);
  assert.equal(res.body.session.last_heartbeat_at, "2026-06-09T10:00:00.000Z");
});

// REGRESSION — the REC-5 false-alarm guard: retries mint many URLs per stored
// object (here 5 mints for 1 produced-and-stored chunk) with NO client-reported
// backlog. pending MUST be 0. Deriving it from mints − stored would falsely
// scream "4 pending" on a session that stored everything it produced.
test("admin session-detail: pending_upload_count does NOT false-alarm on retry/mint inflation", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  // 5 mints (4 retries) for 1 produced chunk, that chunk IS stored, no backlog.
  seedSession(firestore, "s-pending-2", { chunk_count: 5, buffer_pending_chunks: 0 });
  await storage.bucket().file("contests/kec-2026/sessions/alice/s-pending-2/screen/chunk-00000.webm").save("x");
  const res = await call(makeReq({ method: "GET", path: "/api/admin/session-detail",
    headers: adminHeaders, query: { session_id: "s-pending-2" } }));
  assert.equal(res.statusCode, 200);
  // Inflation is visible via chunk_count vs stored_chunk_count...
  assert.equal(res.body.session.chunk_count, 5);
  assert.equal(res.body.session.stored_chunk_count, 1);
  // ...but pending stays 0 because the client reported no buffered backlog.
  assert.equal(res.body.session.pending_upload_count, 0);
});

// A legacy doc with no buffer/heartbeat fields and no stored objects → the
// pending fields default cleanly (0/0/0/""), and stored counts are 0.
test("admin session-detail: legacy doc (no buffer fields, no stored objects) defaults pending to 0", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  // chunk_count 0 → no mints, nothing stored → no pending.
  seedSession(firestore, "s-legacy-1", { chunk_count: 0, camera_chunk_count: 0, last_heartbeat_at: undefined });
  const res = await call(makeReq({ method: "GET", path: "/api/admin/session-detail",
    headers: adminHeaders, query: { session_id: "s-legacy-1" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.session.stored_chunk_count, 0);
  assert.equal(res.body.session.stored_camera_chunk_count, 0);
  assert.equal(res.body.session.pending_upload_count, 0);
  assert.equal(res.body.session.buffer_pending_chunks, 0);
  assert.equal(res.body.session.buffer_pending_bytes, 0);
  assert.equal(res.body.session.upload_queue_depth, 0);
  assert.equal(res.body.session.last_heartbeat_at, "");
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
