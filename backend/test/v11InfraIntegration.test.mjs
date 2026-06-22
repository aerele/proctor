// backend/test/v11InfraIntegration.test.mjs — v1.1 G3 hardening exercised
// end-to-end through api():
//   #7  signed upload URL carries the x-goog-content-length-range size cap and
//       echoes max_bytes (so a valid token can't mint a multi-GB abuse PUT);
//   #9  oversized request bodies are rejected with a 413 BEFORE parse;
//   #4  the per-session telemetry rate limit throttles a scripted upload-url
//       flood while a real cadence is untouched.
//
// These pin the live-incident fixes that have no other test coverage.
import { test } from "node:test";
import assert from "node:assert/strict";

// Env BEFORE import. Tighten the two caps so the test can hit them cheaply
// without fabricating megabytes/floods of fixtures.
process.env.EVIDENCE_BUCKET = "v11i-bucket";
process.env.SESSION_COLLECTION = "v11i_sessions";
process.env.SETTINGS_COLLECTION = "v11i_settings";
process.env.CONTESTS_COLLECTION = "v11i_contests";
process.env.ALERTS_COLLECTION = "v11i_alerts";
process.env.ROOM_GATES_COLLECTION = "v11i_room_gates";
process.env.LIVE_LOCK_COLLECTION = "v11i_live_locks";
process.env.ADMIN_PASSWORD = "v11i-admin-pass";
process.env.MAX_REQUEST_BODY_BYTES = "1024";          // 1 KiB cap for the test
process.env.MAX_UPLOAD_CHUNK_BYTES = "12345678";      // a recognizable cap value

const handler = await import("../src/handler.mjs?v11infra");
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

function isIncrementSentinel(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && typeof value.operand === "number"
    && (value.methodName === undefined || String(value.methodName).includes("increment"));
}
function applyUpdate(existing, patch) {
  const next = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    next[key] = isIncrementSentinel(value) ? (Number(existing?.[key] || 0) + value.operand) : value;
  }
  return next;
}

function makeFakeFirestore() {
  const collections = new Map();
  const getCollection = (name) => { if (!collections.has(name)) collections.set(name, new Map()); return collections.get(name); };
  function makeQuery(name, filters) {
    return {
      where(field, op, value) { return makeQuery(name, [...filters, { field, op, value }]); },
      limit() { return this; },
      async get() {
        let docs = [...getCollection(name).values()];
        for (const { field, op, value } of filters) {
          docs = op === "in"
            ? docs.filter((d) => Array.isArray(value) && value.includes(d[field]))
            : docs.filter((d) => d[field] === value);
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
        where: query.where, limit: query.limit, get: query.get,
        doc(id) {
          return {
            id,
            async create(value) { if (store.has(id)) { const e = new Error("ALREADY_EXISTS"); e.code = 6; throw e; } store.set(id, { ...value }); },
            async set(value, options) { store.set(id, { ...(options?.merge ? store.get(id) || {} : {}), ...value }); },
            async update(patch) { const ex = store.get(id); if (!ex) { const e = new Error("NOT_FOUND"); e.code = 5; throw e; } store.set(id, applyUpdate(ex, patch)); },
            async delete() { store.delete(id); },
            async get() { const data = store.get(id); return { exists: Boolean(data), data: () => data }; }
          };
        }
      };
    }
  };
}

// Storage fake that CAPTURES the getSignedUrl options for the last signed file,
// so the test can assert the size-cap extension header was bound into the URL.
function makeCapturingStorage() {
  const captured = [];
  return {
    _captured: captured,
    bucket() {
      return {
        file(key) {
          return {
            async save() {},
            async getSignedUrl(opts) { captured.push({ key, opts }); return [`https://signed.example/${key}`]; },
            async getMetadata() { return [{ size: 1, updated: "2026-06-05T00:00:00Z" }]; }
          };
        },
        async getFiles() { return [[]]; }
      };
    }
  };
}

const CONTEST_SLUG = "kec-2026";
function seedSession(firestore, id, overrides = {}) {
  firestore.collection(process.env.SESSION_COLLECTION).doc(id).set({
    session_id: id, status: "active",
    username_norm: "alice", name: "Alice A", roll_number: "R1", email: "a@x.y", room: "Lab A-1",
    contest_slug: CONTEST_SLUG,
    storage_prefix: `contests/${CONTEST_SLUG}/sessions/alice/${id}/`,
    created_at: "2026-06-09T09:00:00.000Z",
    chunk_count: 0, camera_chunk_count: 0,
    last_heartbeat_at: new Date().toISOString(),
    ...overrides
  });
}

// ---- #7: signed-URL per-chunk size cap -------------------------------------

test("G3 #7: the signed upload URL binds the x-goog-content-length-range cap and echoes max_bytes", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeCapturingStorage();
  __setClientsForTest({ firestore, storage });
  seedSession(firestore, "s1");
  const res = await call(makeReq({ method: "POST", path: "/api/upload-url", body: {
    session_id: "s1", kind: "screen", chunk_index: 0, content_type: "video/webm"
  } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  // The response echoes the cap the candidate uploader must honor on the PUT.
  assert.equal(res.body.max_bytes, 12345678);
  // The signature itself was bound to the size range (so a token can't PUT bigger).
  const signed = storage._captured.at(-1);
  assert.equal(signed.opts.version, "v4");
  assert.equal(signed.opts.action, "write");
  assert.equal(signed.opts.extensionHeaders["x-goog-content-length-range"], "0,12345678");
});

// ---- #9: request body-size cap ---------------------------------------------

test("G3 #9: an oversized declared Content-Length is rejected with 413 before parse", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeCapturingStorage() });
  const res = await call(makeReq({
    method: "POST", path: "/api/events",
    headers: { "content-length": String(2048) }, // > 1024 cap
    body: { session_id: "s1", events: [] }
  }));
  assert.equal(res.statusCode, 413);
  assert.equal(res.body.error, "payload_too_large");
  assert.equal(res.body.max_bytes, 1024);
});

test("G3 #9: an oversized STRING body (lying/absent Content-Length) is also rejected with 413", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeCapturingStorage() });
  const big = "x".repeat(2000); // 2000 bytes utf8 > 1024 cap, no content-length header
  const res = await call(makeReq({ method: "POST", path: "/api/events", body: big }));
  assert.equal(res.statusCode, 413);
  assert.equal(res.body.error, "payload_too_large");
});

test("G3 #9: a body UNDER the cap passes the size gate (cap doesn't break normal traffic)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeCapturingStorage() });
  seedSession(firestore, "s-ok");
  const res = await call(makeReq({
    method: "POST", path: "/api/events",
    headers: { "content-length": "50" },
    body: { session_id: "s-ok", events: [{ type: "focus", at: "2026-06-10T00:00:00.000Z" }] }
  }));
  // Not a 413 — the size gate let it through (200 = recorded).
  assert.notEqual(res.statusCode, 413);
  assert.equal(res.statusCode, 200);
});

// ---- #4: per-session telemetry rate limit ----------------------------------

test("G3 #4: a scripted upload-url flood from ONE session eventually 429s (the cap holds)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeCapturingStorage() });
  seedSession(firestore, "flood");
  // upload-url burst is 120; drive well past it in the same instant.
  let saw429 = false;
  for (let i = 0; i < 200; i++) {
    const res = await call(makeReq({ method: "POST", path: "/api/upload-url", body: {
      session_id: "flood", kind: "screen", chunk_index: i, content_type: "video/webm"
    } }));
    if (res.statusCode === 429) { saw429 = true; break; }
    assert.equal(res.statusCode, 200, `unexpected ${res.statusCode} at i=${i}`);
  }
  assert.ok(saw429, "a 200-deep upload-url flood from one session must hit the rate limit");
});

test("G3 #4: a DIFFERENT session is unaffected by another session's flood (per-session buckets)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeCapturingStorage() });
  seedSession(firestore, "noisy");
  seedSession(firestore, "quiet");
  // Drain noisy until it 429s.
  for (let i = 0; i < 200; i++) {
    const r = await call(makeReq({ method: "POST", path: "/api/upload-url", body: {
      session_id: "noisy", kind: "screen", chunk_index: i, content_type: "video/webm"
    } }));
    if (r.statusCode === 429) break;
  }
  // quiet's first request is fine — its bucket is full.
  const ok = await call(makeReq({ method: "POST", path: "/api/upload-url", body: {
    session_id: "quiet", kind: "screen", chunk_index: 0, content_type: "video/webm"
  } }));
  assert.equal(ok.statusCode, 200);
});
