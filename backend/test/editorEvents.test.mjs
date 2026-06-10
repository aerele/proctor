// backend/test/editorEvents.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

// Env BEFORE import; unique ?editor cache-buster for a fresh module instance.
process.env.EVIDENCE_BUCKET = "editor-bucket";
process.env.SESSION_COLLECTION = "editor_sessions";
process.env.SETTINGS_COLLECTION = "editor_settings";
process.env.EDITOR_EVENTS_COLLECTION = "editor-events";
process.env.SUBMISSIONS_COLLECTION = "editor_submissions";
process.env.ADMIN_PASSWORD = "editor-admin-pass";

const handler = await import("../src/handler.mjs?editor");
const { api, __setClientsForTest, __setJudge0AdapterForTest } = handler;

// Inline req/res + fakes, copied from phase2.test.mjs (NO helpers.mjs).
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

// ---- Fake Firestore (supports create / update / set / get / where) --------
// Copied from phase2.test.mjs. The fake storage records every save in
// `storage._saved` (key -> body), which is what we assert against — there is
// NO globalThis.__GCS_APPEND__ seam.

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
          // Mirror the Firestore operators the handler actually uses: scalar
          // equality and the `in` membership test (a small value array).
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
              // H1: live-slot lock release. Idempotent — deleting a missing doc
              // is a no-op, matching Firestore's delete semantics.
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

// ---- Fake Storage (records saves; signs read/write URLs) ------------------

function makeFakeStorage() {
  const saved = new Map(); // key -> body
  return {
    _saved: saved,
    bucket() {
      return {
        file(key) {
          return {
            async save(body) {
              saved.set(key, body);
            },
            async getSignedUrl() {
              return [`https://signed.example/${key}`];
            },
            async getMetadata() {
              return [{ size: 1, updated: "2026-06-05T00:00:00Z" }];
            }
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

test("POST /api/editor-events accepts a batch and writes NDJSON to GCS under the session prefix", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  // Seed an ACTIVE session so the ownership gate passes; key uses its storage_prefix.
  firestore.collection(process.env.SESSION_COLLECTION).doc("s1").set({
    session_id: "s1", status: "active", username_norm: "alice", storage_prefix: "sessions/alice/s1/"
  });
  const events = [
    { type: "editor_insert", timestamp: "2026-06-09T10:00:00.000Z", detail: { len: 1, line: 1, col: 2 } },
    { type: "editor_cursor", timestamp: "2026-06-09T10:00:01.000Z", detail: { line: 3, col: 1 } }
  ];
  const res = await call(makeReq({ method: "POST", path: "/api/editor-events",
    body: { session_id: "s1", problem_id: "sum-two", events } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.stored, 2);
  // Exactly one GCS object written, under the session prefix's editor-events/ folder.
  const keys = [...storage._saved.keys()];
  assert.equal(keys.length, 1);
  assert.match(keys[0], /^sessions\/alice\/s1\/editor-events\/.*\.ndjson$/);
  assert.equal(storage._saved.get(keys[0]).trim().split("\n").length, 2);
});

test("POST /api/editor-events: batches stay problem-homogeneous — each NDJSON object carries ITS batch's problem_id (S-I §3.5)", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  firestore.collection(process.env.SESSION_COLLECTION).doc("s1").set({
    session_id: "s1", status: "active", username_norm: "alice", storage_prefix: "sessions/alice/s1/"
  });
  // Two batches for two problems — including the new problem_switched marker.
  await call(makeReq({ method: "POST", path: "/api/editor-events",
    body: { session_id: "s1", problem_id: "p-one", events: [
      { type: "editor_insert", timestamp: "t1", detail: {} }
    ] } }));
  await call(makeReq({ method: "POST", path: "/api/editor-events",
    body: { session_id: "s1", problem_id: "p-two", events: [
      { type: "problem_switched", timestamp: "t2", detail: { from_problem_id: "p-one", to_problem_id: "p-two" } },
      { type: "editor_insert", timestamp: "t3", detail: {} }
    ] } }));

  const keys = [...storage._saved.keys()].sort();
  assert.equal(keys.length, 2); // one object per batch — never merged
  const batchProblemIds = keys.map((key) => {
    const lines = storage._saved.get(key).trim().split("\n").map((line) => JSON.parse(line));
    const ids = new Set(lines.map((line) => line.problem_id));
    assert.equal(ids.size, 1, "every line in a batch must carry the same problem_id");
    return [...ids][0];
  });
  assert.deepEqual(batchProblemIds.sort(), ["p-one", "p-two"]);
  // The switch marker rode the INCOMING problem's batch with its detail intact.
  const switchLine = [...storage._saved.values()].flatMap((body) => body.trim().split("\n"))
    .map((line) => JSON.parse(line)).find((line) => line.type === "problem_switched");
  assert.deepEqual(switchLine.detail, { from_problem_id: "p-one", to_problem_id: "p-two" });
  assert.equal(switchLine.problem_id, "p-two");
});

test("POST /api/editor-events rejects an unknown/ended session (ownership gate)", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  firestore.collection(process.env.SESSION_COLLECTION).doc("s1").set({ session_id: "s1", status: "ended" });
  const res = await call(makeReq({ method: "POST", path: "/api/editor-events",
    body: { session_id: "s1", problem_id: "sum-two", events: [{ type: "editor_insert", timestamp: "t", detail: {} }] } }));
  assert.equal(res.statusCode, 409);
  assert.equal(storage._saved.size, 0); // nothing written
});

test("POST /api/editor-events rejects > MAX events with 400", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  firestore.collection(process.env.SESSION_COLLECTION).doc("s1").set({ session_id: "s1", status: "active", storage_prefix: "sessions/alice/s1/" });
  const events = Array.from({ length: 6000 }, () => ({ type: "editor_insert", timestamp: "t", detail: {} }));
  const res = await call(makeReq({ method: "POST", path: "/api/editor-events",
    body: { session_id: "s1", problem_id: "p", events } }));
  assert.equal(res.statusCode, 400);
});

// ---- Security hardening (adversarial review) -------------------------------
// (a) Each persisted editor event must be a NEW allow-listed object (mirrors
// recordEvents): capped type/timestamp, sanitizeObject'd detail, NO raw client
// keys spread through.

test("POST /api/editor-events sanitizes events: truncates oversized strings, drops unexpected keys", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  firestore.collection(process.env.SESSION_COLLECTION).doc("s1").set({
    session_id: "s1", status: "active", username_norm: "alice", storage_prefix: "sessions/alice/s1/"
  });
  const res = await call(makeReq({ method: "POST", path: "/api/editor-events",
    body: { session_id: "s1", problem_id: "sum-two", events: [{
      type: "T".repeat(200),                 // > 64 — must be capped
      timestamp: "S".repeat(100),            // > 40 — must be capped
      detail: { text: "A".repeat(2000), nested: { deep: "B".repeat(900) } }, // non-text strings > 500 — sanitizeObject caps
      injected_extra: "evil",                // unexpected key — must be dropped
      another_extra: { sneaky: true }        // unexpected key — must be dropped
    }] } }));
  assert.equal(res.statusCode, 200);
  const keys = [...storage._saved.keys()];
  assert.equal(keys.length, 1);
  const record = JSON.parse(storage._saved.get(keys[0]).trim());
  assert.equal(record.type.length, 64);
  assert.equal(record.timestamp.length, 40);
  // detail.text is paste-forensics payload: preserved up to 2000 chars (NOT the
  // generic 500-char cap). Exactly 2000 chars → intact, no truncation flag.
  assert.equal(record.detail.text.length, 2000);
  assert.equal(record.detail.text_truncated, undefined);
  assert.equal(record.detail.nested.deep.length, 500); // everything else stays capped at 500, recursively
  // ONLY the allow-listed shape persists — extra client keys are gone.
  assert.deepEqual(Object.keys(record).sort(),
    ["detail", "problem_id", "session_id", "timestamp", "type"]);
});

// ---- Paste forensics: detail.text gets its OWN 2000-char cap ---------------
// The capture design stores up to 2000 chars of inserted text; sanitizeObject's
// generic 500-char cap must NOT clip it.

test("POST /api/editor-events preserves a 1500-char detail.text intact (no truncation flag)", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  firestore.collection(process.env.SESSION_COLLECTION).doc("s1").set({
    session_id: "s1", status: "active", username_norm: "alice", storage_prefix: "sessions/alice/s1/"
  });
  const text = "P".repeat(1500);
  const res = await call(makeReq({ method: "POST", path: "/api/editor-events",
    body: { session_id: "s1", problem_id: "sum-two", events: [
      { type: "editor_insert", timestamp: "2026-06-09T10:00:00.000Z", detail: { text, len: 1500 } }
    ] } }));
  assert.equal(res.statusCode, 200);
  const record = JSON.parse(storage._saved.get([...storage._saved.keys()][0]).trim());
  assert.equal(record.detail.text, text);                // survives intact, all 1500 chars
  assert.equal(record.detail.text_truncated, undefined); // not truncated → no flag
  assert.equal(record.detail.len, 1500);                 // the rest of detail still sanitized normally
});

test("POST /api/editor-events caps a 3000-char detail.text at 2000 and sets text_truncated", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  firestore.collection(process.env.SESSION_COLLECTION).doc("s1").set({
    session_id: "s1", status: "active", username_norm: "alice", storage_prefix: "sessions/alice/s1/"
  });
  const text = "Q".repeat(3000);
  const res = await call(makeReq({ method: "POST", path: "/api/editor-events",
    body: { session_id: "s1", problem_id: "sum-two", events: [
      { type: "editor_insert", timestamp: "2026-06-09T10:00:00.000Z", detail: { text } }
    ] } }));
  assert.equal(res.statusCode, 200);
  const record = JSON.parse(storage._saved.get([...storage._saved.keys()][0]).trim());
  assert.equal(record.detail.text, text.slice(0, 2000)); // stored as the first 2000 chars
  assert.equal(record.detail.text_truncated, true);      // flagged as clipped
});

// ---- problem_id coercion (adversarial review) -------------------------------
// problem_id was stored verbatim from the client; it must be coerced to a
// bounded string (or null) so an object/array can never land in storage.

test("POST /api/editor-events coerces problem_id: object → bounded string, long string → 64 chars, missing → null", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  firestore.collection(process.env.SESSION_COLLECTION).doc("s1").set({
    session_id: "s1", status: "active", username_norm: "alice", storage_prefix: "sessions/alice/s1/"
  });
  const event = { type: "editor_insert", timestamp: "2026-06-09T10:00:00.000Z", detail: {} };

  // (a) object-valued problem_id → stored as a bounded STRING, never an object.
  let res = await call(makeReq({ method: "POST", path: "/api/editor-events",
    body: { session_id: "s1", problem_id: { evil: "payload" }, events: [event] } }));
  assert.equal(res.statusCode, 200);
  let record = JSON.parse(storage._saved.get([...storage._saved.keys()].at(-1)).trim());
  assert.equal(typeof record.problem_id, "string");
  assert.ok(record.problem_id.length <= 64);

  // (b) oversized string problem_id → sliced to 64 chars.
  res = await call(makeReq({ method: "POST", path: "/api/editor-events",
    body: { session_id: "s1", problem_id: "x".repeat(500), events: [event] } }));
  assert.equal(res.statusCode, 200);
  record = JSON.parse(storage._saved.get([...storage._saved.keys()].at(-1)).trim());
  assert.equal(record.problem_id, "x".repeat(64));

  // (c) missing problem_id → null (unchanged behavior).
  res = await call(makeReq({ method: "POST", path: "/api/editor-events",
    body: { session_id: "s1", events: [event] } }));
  assert.equal(res.statusCode, 200);
  record = JSON.parse(storage._saved.get([...storage._saved.keys()].at(-1)).trim());
  assert.equal(record.problem_id, null);
});

// (b) source_code is capped at 65536 chars on BOTH exec endpoints — 400 before
// any execution (the stub adapter throws if it is ever reached).

test("POST /api/exec/run rejects source_code > 65536 chars with 400 (before any execution)", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  firestore.collection(process.env.SESSION_COLLECTION).doc("s1").set({ session_id: "s1", status: "active" });
  __setJudge0AdapterForTest({ runBatch: async () => { throw new Error("must not execute oversized source"); } });
  const res = await call(makeReq({ method: "POST", path: "/api/exec/run",
    body: { session_id: "s1", problem_id: "sum-two", language: "python", source_code: "a".repeat(65537) } }));
  assert.equal(res.statusCode, 400);
  __setJudge0AdapterForTest(null);
});

test("POST /api/exec/submit rejects source_code > 65536 chars with 400 (nothing stored)", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  firestore.collection(process.env.SESSION_COLLECTION).doc("s1").set({ session_id: "s1", status: "active" });
  __setJudge0AdapterForTest({ runBatch: async () => { throw new Error("must not execute oversized source"); } });
  const res = await call(makeReq({ method: "POST", path: "/api/exec/submit",
    body: { session_id: "s1", problem_id: "sum-two", language: "python", source_code: "a".repeat(65537) } }));
  assert.equal(res.statusCode, 400);
  assert.equal(firestore._collections.get(process.env.SUBMISSIONS_COLLECTION)?.size || 0, 0);
  __setJudge0AdapterForTest(null);
});

// (c) Language lookup must reject prototype keys: "constructor" is NOT an own
// key of LANGUAGE_IDS but indexes Object.prototype — it must 400, not execute.

test("POST /api/exec/run rejects prototype-key language ('constructor') with 400", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  firestore.collection(process.env.SESSION_COLLECTION).doc("s1").set({ session_id: "s1", status: "active" });
  __setJudge0AdapterForTest({ runBatch: async () => { throw new Error("must not execute a prototype-key language"); } });
  const res = await call(makeReq({ method: "POST", path: "/api/exec/run",
    body: { session_id: "s1", problem_id: "sum-two", language: "constructor", source_code: "x" } }));
  assert.equal(res.statusCode, 400);
  __setJudge0AdapterForTest(null);
});

test("POST /api/exec/submit rejects prototype-key language ('constructor') with 400", async () => {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  firestore.collection(process.env.SESSION_COLLECTION).doc("s1").set({ session_id: "s1", status: "active" });
  __setJudge0AdapterForTest({ runBatch: async () => { throw new Error("must not execute a prototype-key language"); } });
  const res = await call(makeReq({ method: "POST", path: "/api/exec/submit",
    body: { session_id: "s1", problem_id: "sum-two", language: "constructor", source_code: "x" } }));
  assert.equal(res.statusCode, 400);
  assert.equal(firestore._collections.get(process.env.SUBMISSIONS_COLLECTION)?.size || 0, 0);
  __setJudge0AdapterForTest(null);
});
