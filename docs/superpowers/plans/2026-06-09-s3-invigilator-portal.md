# S3 — Invigilator Portal (no signed-QR) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** READY (paired with `docs/superpowers/specs/2026-06-09-s3-invigilator-portal-design.md`).

**Goal:** A room invigilator opens `/invigilator`, unlocks with the invigilator password, picks their room, and can: release/re-display/regenerate a 6-digit room start code, press "Start now — allow all", watch room stats (live/disconnected/locked/pending/finished/started), and read their room's open alerts. Candidates (recording already running) wait at a room-code screen that releases on a correct code or auto-advances when the room opens. Run/Submit are server-blocked until release. **No signed-QR anything.**

**Architecture:** Backend = 5 new routes in `backend/src/handler.mjs` (`/api/invigilator/overview|room|release-code|open-room`, `/api/session/room-gate`), a new `proctor_room_gates` collection, `room_gate_enabled` on the settings doc, `exam_started_at` on session docs, and an exec gate. Frontend = new `InvigilatorApp.tsx` route, a pure `invigilator/gateLogic.ts` module (vitest), api.ts functions with demo branches, a student `RoomCodePanel`, and an admin settings checkbox.

**Conventions (match the repo exactly):** backend `node:test` + env-before-import + cache-buster import + pasted fake Firestore/Storage + `__setClientsForTest`/`__setJudge0AdapterForTest`; frontend vitest for pure logic only; demo-mode branches in `api.ts`. **Commits are LOCAL only — NEVER push.**

**IMPORTANT — parallel-build safety:** other agents may be editing `handler.mjs`, `api.ts`, `types.ts`, `App.tsx` tonight. All anchors below were verified against the current tree. If an anchor moved, find the equivalent location by the quoted text — do NOT duplicate routes/consts. Never modify `frontend/src/coding/*`, `backend/src/judge0Adapter.mjs`, `backend/src/problems.mjs`, or existing test files.

---

## File structure

**Backend**
- Modify `backend/src/handler.mjs` — new consts, `requireInvigilator`, one "S3" section with all gate handlers, 5 routes, `room_gate_enabled` plumbing, exec gate, CORS header.
- Create `backend/test/invigilator.test.mjs` — grows across Tasks 1–4.

**Frontend**
- Create `frontend/src/invigilator/gateLogic.ts` + `frontend/src/invigilator/gateLogic.test.ts` (vitest, pure).
- Create `frontend/src/InvigilatorApp.tsx`.
- Modify `frontend/src/types.ts`, `frontend/src/api.ts`, `frontend/src/App.tsx`.

---

## Task 1: Backend — invigilator auth, `/api/invigilator/overview`, `room_gate_enabled` plumbing

**Files:** Create `backend/test/invigilator.test.mjs`; modify `backend/src/handler.mjs`.

- [ ] **Step 1: Write the failing tests** — create `backend/test/invigilator.test.mjs` with EXACTLY this content:

```javascript
// backend/test/invigilator.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

// Env MUST be set before importing the handler (it reads env at module load).
// A unique ?invigilator query gives a fresh module instance independent of the
// other test files (which configure different collections).
process.env.EVIDENCE_BUCKET = "invig-bucket";
process.env.SESSION_COLLECTION = "invig_sessions";
process.env.SETTINGS_COLLECTION = "invig_settings";
process.env.ALERTS_COLLECTION = "invig_alerts";
process.env.ROOM_GATES_COLLECTION = "invig_room_gates";
process.env.SUBMISSIONS_COLLECTION = "invig_submissions";
process.env.LIVE_LOCK_COLLECTION = "invig_live_locks";
process.env.ADMIN_PASSWORD = "invig-admin-pass";
process.env.INVIGILATOR_PASSWORD = "invig-pass";

const handler = await import("../src/handler.mjs?invigilator");
const { api, __setClientsForTest, __setJudge0AdapterForTest } = handler;

// Inline req/res mocks + fakes, copied from phase2.test.mjs (NO helpers.mjs).
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

// ---- Fake Firestore (create / update / set / get / where / delete) ---------

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

// ---- Fake Storage (records saves; signs read/write URLs) ------------------

function makeFakeStorage() {
  const saved = new Map();
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

// ---- Seed helpers -----------------------------------------------------------

// Settings doc id is "active" (SETTINGS_ID). Default: a wide-open window for
// contest kec-2026 with the room gate ENABLED.
function seedSettings(firestore, overrides = {}) {
  firestore.collection(process.env.SETTINGS_COLLECTION).doc("active").set({
    start_at: "2026-01-01T00:00:00.000Z",
    end_at: "2099-01-01T00:00:00.000Z",
    contest_url: "https://www.hackerrank.com/contests/kec-2026",
    contest_slug: "kec-2026",
    room_gate_enabled: true,
    ...overrides
  });
}

// An ACTIVE session in Lab A-1 of kec-2026 with a FRESH heartbeat (so it is
// never accidentally "disconnected"); override per test.
function seedSession(firestore, id, overrides = {}) {
  firestore.collection(process.env.SESSION_COLLECTION).doc(id).set({
    session_id: id, status: "active",
    hackerrank_username: "Alice", username_norm: "alice",
    name: "Alice A", roll_number: "R1", email: "a@x.y", room: "Lab A-1",
    contest_slug: "kec-2026",
    storage_prefix: `contests/kec-2026/sessions/alice/${id}/`,
    created_at: "2026-06-09T09:00:00.000Z",
    last_heartbeat_at: new Date().toISOString(),
    ...overrides
  });
}

// ---- Task 1: auth + overview + settings plumbing ---------------------------

test("invigilator endpoints: 401 without a password, 401 with a wrong one", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  const noPass = await call(makeReq({ method: "GET", path: "/api/invigilator/overview" }));
  assert.equal(noPass.statusCode, 401);
  const wrong = await call(makeReq({ method: "GET", path: "/api/invigilator/overview",
    headers: { "x-invigilator-password": "nope" } }));
  assert.equal(wrong.statusCode, 401);
});

test("invigilator endpoints accept the ADMIN credential in either header", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  const viaAdminHeader = await call(makeReq({ method: "GET", path: "/api/invigilator/overview",
    headers: { "x-admin-password": "invig-admin-pass" } }));
  assert.equal(viaAdminHeader.statusCode, 200);
  const viaInvigHeader = await call(makeReq({ method: "GET", path: "/api/invigilator/overview",
    headers: { "x-invigilator-password": "invig-admin-pass" } }));
  assert.equal(viaInvigHeader.statusCode, 200);
});

test("closed-by-default: INVIGILATOR_PASSWORD unset rejects the invigilator header, admin still passes", async () => {
  // A second cache-busted import reads env at ITS load time, so deleting the
  // var here yields a module instance with no invigilator password configured.
  delete process.env.INVIGILATOR_PASSWORD;
  const h2 = await import("../src/handler.mjs?invigilator-nopass");
  process.env.INVIGILATOR_PASSWORD = "invig-pass"; // restore for later tests
  const firestore = makeFakeFirestore();
  h2.__setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  const call2 = async (req) => { const res = makeRes(); await h2.api(req, res); return res; };
  const viaInvig = await call2(makeReq({ method: "GET", path: "/api/invigilator/overview",
    headers: { "x-invigilator-password": "invig-pass" } }));
  assert.equal(viaInvig.statusCode, 401);
  const viaAdmin = await call2(makeReq({ method: "GET", path: "/api/invigilator/overview",
    headers: { "x-admin-password": "invig-admin-pass" } }));
  assert.equal(viaAdmin.statusCode, 200);
});

test("GET /api/invigilator/overview: rooms from the ACTIVE contest's sessions + gate flag", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "s1", { room: "Lab B-2" });
  seedSession(firestore, "s2", { room: "Lab A-1", username_norm: "bob", hackerrank_username: "Bob" });
  seedSession(firestore, "s3", { room: "", username_norm: "carl" });          // unassigned
  seedSession(firestore, "s4", { room: "Lab Z-9", contest_slug: "other" });   // other contest — excluded
  const res = await call(makeReq({ method: "GET", path: "/api/invigilator/overview",
    headers: { "x-invigilator-password": "invig-pass" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.contest_slug, "kec-2026");
  assert.equal(res.body.room_gate_enabled, true);
  assert.deepEqual(res.body.rooms, ["Lab A-1", "Lab B-2"]);
  assert.equal(res.body.has_unassigned, true);
});

test("room_gate_enabled round-trips through admin settings and appears in the start response", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  const save = await call(makeReq({ method: "POST", path: "/api/admin/settings",
    headers: { "x-admin-password": "invig-admin-pass" },
    body: { start_at: "2026-01-01T00:00:00.000Z", end_at: "2099-01-01T00:00:00.000Z",
            contest_url: "https://www.hackerrank.com/contests/kec-2026", room_gate_enabled: true } }));
  assert.equal(save.statusCode, 200);
  assert.equal(save.body.room_gate_enabled, true);
  const get = await call(makeReq({ method: "GET", path: "/api/admin/settings",
    headers: { "x-admin-password": "invig-admin-pass" } }));
  assert.equal(get.body.room_gate_enabled, true);
  // Candidate start response carries the flag → the client knows to show the
  // waiting room.
  const start = await call(makeReq({ method: "POST", path: "/api/session/start",
    body: { hackerrank_username: "Zoe", name: "Zoe Z", roll_number: "R9", email: "z@x.y",
            room: "Lab A-1", consent_accepted: true } }));
  assert.equal(start.statusCode, 200);
  assert.equal(start.body.room_gate_enabled, true);
});

test("CORS allows the x-invigilator-password header", async () => {
  const res = await call(makeReq({ method: "OPTIONS", path: "/api/invigilator/overview" }));
  assert.equal(res.statusCode, 204);
  assert.match(res.headers["access-control-allow-headers"], /x-invigilator-password/);
});
```

- [ ] **Step 2: Run, verify it fails** (overview route missing → 404 ≠ 401; settings flag missing):

Run: `cd /home/karthi/arogara/proctor/backend && node --test test/invigilator.test.mjs`
Expected: multiple failures (e.g. `401 !== 404`, `room_gate_enabled undefined !== true`).

- [ ] **Step 3: Implement** in `backend/src/handler.mjs` — six small edits:

**(a)** After the line `const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;` add:

```javascript
// S3 invigilator portal: a SEPARATE shared password so invigilators never hold
// the admin credential. Closed-by-default when unset (mirrors ALERTS_INGEST_API_KEY).
const INVIGILATOR_PASSWORD = process.env.INVIGILATOR_PASSWORD;
```

**(b)** Immediately after the `function requireAdmin(req) { ... }` block add:

```javascript
// S3: invigilator auth — x-invigilator-password vs INVIGILATOR_PASSWORD. The
// ADMIN credential is accepted too, in EITHER header, so an admin can open the
// portal (the portal client always sends x-invigilator-password). Comparisons
// are timing-safe (match requireApiKey's discipline). Closed-by-default: with
// INVIGILATOR_PASSWORD unset the invigilator path always rejects — only the
// admin fallback can pass.
let warnedMissingInvigilatorPassword = false;

function requireInvigilator(req) {
  const invig = req.get?.("x-invigilator-password") || req.headers?.["x-invigilator-password"] || "";
  const admin = req.get?.("x-admin-password") || req.headers?.["x-admin-password"] || "";
  if (ADMIN_PASSWORD && (safeEqual(admin, ADMIN_PASSWORD) || safeEqual(invig, ADMIN_PASSWORD))) return;
  if (!INVIGILATOR_PASSWORD) {
    if (!warnedMissingInvigilatorPassword) {
      console.warn("INVIGILATOR_PASSWORD is not set; rejecting invigilator-password requests.");
      warnedMissingInvigilatorPassword = true;
    }
    throw httpError(401, "Unauthorized");
  }
  if (!safeEqual(invig, INVIGILATOR_PASSWORD)) throw httpError(401, "Unauthorized");
}
```

**(c)** Immediately BEFORE the comment line `// ---- Proctor alert settings (admin) ----------------------------------------` add the S3 section opener + overview handler:

```javascript
// ---- S3: invigilator portal + room start gate -------------------------------
//
// Room-scoped console (NO signed-QR verification — deferred by design). Auth =
// requireInvigilator. Scope is ALWAYS the active contest from the settings doc;
// invigilators never pick a contest. Least privilege: these endpoints expose NO
// emails, NO IP addresses, NO signed media URLs.

// GET /api/invigilator/overview — room-picker bootstrap: distinct room labels
// (same helper the admin dropdowns use), whether blank-room sessions exist
// (the "_" pseudo-room), and whether the room start gate is enabled.
async function invigilatorOverview(req) {
  requireInvigilator(req);
  const settings = await getSettings();
  const contestSlug = settings?.contest_slug || contestSlugFromUrl(settings?.contest_url) || "";
  let query = firestore.collection(SESSION_COLLECTION);
  if (contestSlug) query = query.where("contest_slug", "==", contestSlug);
  const snapshot = await query.limit(SESSIONS_QUERY_LIMIT).get();
  const docs = snapshot.docs.map((doc) => doc.data());
  return {
    contest_slug: contestSlug || null,
    room_gate_enabled: Boolean(settings?.room_gate_enabled),
    rooms: distinctRooms(docs),
    has_unassigned: docs.some((doc) => !String(doc.room || "").trim())
  };
}
```

**(d)** In the route table, after the line `if (req.method === "GET" && path === "/api/admin/reviews") return send(res, 200, await adminReviews(req));` add:

```javascript
    if (req.method === "GET" && path === "/api/invigilator/overview") return send(res, 200, await invigilatorOverview(req));
```

**(e)** `room_gate_enabled` plumbing — three one-line additions:
- In `adminSaveSettings`, inside the `const item = { ... }` literal, after the `contest_slug: contestSlugFromUrl(contestUrl),` line add:
  ```javascript
    // S3: opt-in room start gate (invigilator OTP / start-now). Default false.
    room_gate_enabled: body.room_gate_enabled === true,
  ```
- In `publicSettings`, after the `contest_slug: ...` line add:
  ```javascript
    room_gate_enabled: Boolean(settings?.room_gate_enabled),
  ```
- In `startResponse`, after the `contest_url: settings?.contest_url || "",` line add:
  ```javascript
    // S3: tells the candidate client whether to hold at the room-code screen.
    room_gate_enabled: Boolean(settings?.room_gate_enabled),
  ```

**(f)** In `setCors`, change the allow-headers line to:

```javascript
  res.set("access-control-allow-headers", "content-type,x-admin-password,x-api-key,x-invigilator-password");
```

- [ ] **Step 4: Run, verify it passes — then the whole suite:**

Run: `cd /home/karthi/arogara/proctor/backend && node --test test/invigilator.test.mjs` → all Task-1 tests pass.
Run: `cd /home/karthi/arogara/proctor/backend && npm test` → ALL backend tests pass (existing suites unaffected).

- [ ] **Step 5: Commit**

```bash
cd /home/karthi/arogara/proctor
git add backend/src/handler.mjs backend/test/invigilator.test.mjs
git commit -m "feat(invigilator): invigilator auth + overview endpoint + room_gate_enabled setting"
```

---

## Task 2: Backend — room gate docs + release-code + open-room

**Files:** Modify `backend/src/handler.mjs`, `backend/test/invigilator.test.mjs`.

- [ ] **Step 1: Append failing tests** to the END of `backend/test/invigilator.test.mjs`:

```javascript
// ---- Task 2: release-code + open-room ---------------------------------------

test("POST /api/invigilator/release-code: 6-digit OTP, idempotent re-display, regenerate mints fresh", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  const first = await call(makeReq({ method: "POST", path: "/api/invigilator/release-code",
    headers: { "x-invigilator-password": "invig-pass" },
    body: { room: "Lab A-1", invigilator_name: "Priya" } }));
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.contest_slug, "kec-2026");
  assert.equal(first.body.gate.mode, "otp");
  assert.match(first.body.gate.otp, /^\d{6}$/);
  assert.equal(first.body.gate.released_by, "Priya");
  // stored under the deterministic gate id
  const gates = firestore._collections.get(process.env.ROOM_GATES_COLLECTION);
  assert.ok(gates.has("gate:kec-2026:Lab A-1"));
  // idempotent: a portal reload re-displays the SAME code
  const second = await call(makeReq({ method: "POST", path: "/api/invigilator/release-code",
    headers: { "x-invigilator-password": "invig-pass" },
    body: { room: "Lab A-1", invigilator_name: "Priya" } }));
  assert.equal(second.body.gate.otp, first.body.gate.otp);
  // regenerate writes a NEW gate doc (released_by proves the rewrite — the new
  // random code itself could collide one-in-a-million, so don't assert on it)
  const regen = await call(makeReq({ method: "POST", path: "/api/invigilator/release-code",
    headers: { "x-invigilator-password": "invig-pass" },
    body: { room: "Lab A-1", invigilator_name: "Asha", regenerate: true } }));
  assert.match(regen.body.gate.otp, /^\d{6}$/);
  assert.equal(regen.body.gate.released_by, "Asha");
});

test("POST /api/invigilator/open-room: start-now marks the room OPEN and keeps prior release info", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  const released = await call(makeReq({ method: "POST", path: "/api/invigilator/release-code",
    headers: { "x-invigilator-password": "invig-pass" },
    body: { room: "Lab A-1", invigilator_name: "Priya" } }));
  const open = await call(makeReq({ method: "POST", path: "/api/invigilator/open-room",
    headers: { "x-invigilator-password": "invig-pass" },
    body: { room: "Lab A-1", invigilator_name: "Asha" } }));
  assert.equal(open.statusCode, 200);
  assert.equal(open.body.gate.mode, "open");
  assert.equal(open.body.gate.opened_by, "Asha");
  assert.equal(open.body.gate.released_by, "Priya");                  // preserved
  assert.equal(open.body.gate.otp, released.body.gate.otp);           // preserved (re-arm support)
});

test("release-code / open-room: 400 room_gate_disabled when the admin toggle is off", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore, { room_gate_enabled: false });
  const release = await call(makeReq({ method: "POST", path: "/api/invigilator/release-code",
    headers: { "x-invigilator-password": "invig-pass" },
    body: { room: "Lab A-1", invigilator_name: "Priya" } }));
  assert.equal(release.statusCode, 400);
  assert.equal(release.body.error, "room_gate_disabled");
  const open = await call(makeReq({ method: "POST", path: "/api/invigilator/open-room",
    headers: { "x-invigilator-password": "invig-pass" },
    body: { room: "Lab A-1", invigilator_name: "Priya" } }));
  assert.equal(open.statusCode, 400);
});

test("release-code for the unassigned pseudo-room ('_') stores key '_' with a blank label", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  const res = await call(makeReq({ method: "POST", path: "/api/invigilator/release-code",
    headers: { "x-invigilator-password": "invig-pass" },
    body: { room: "_", invigilator_name: "Priya" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.gate.room_key, "_");
  assert.equal(res.body.gate.room, "");
  assert.ok(firestore._collections.get(process.env.ROOM_GATES_COLLECTION).has("gate:kec-2026:_"));
});
```

- [ ] **Step 2: Run, verify the new tests fail** (404 on the new routes):

Run: `cd /home/karthi/arogara/proctor/backend && node --test test/invigilator.test.mjs`

- [ ] **Step 3: Implement** in `backend/src/handler.mjs`:

**(a)** Change the node:crypto import line to:

```javascript
import { createHash, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
```

**(b)** After the `const INVIGILATOR_PASSWORD = ...` line add:

```javascript
const ROOM_GATES_COLLECTION = process.env.ROOM_GATES_COLLECTION || "proctor_room_gates";
```

**(c)** At the END of the S3 section (after `invigilatorOverview`, still before the `// ---- Proctor alert settings (admin)` comment) add:

```javascript
// Room start gate (S3). ONE doc per (contest, room); deterministic id so
// re-releases upsert (mirrors the live-lock id pattern). The OTP is stored in
// PLAINTEXT deliberately: it is a short-lived room-coordination code the
// invigilator must be able to RE-DISPLAY (portal reload, board rewrite), not a
// credential guarding data; online guessing is bounded by the per-session
// attempt cap in sessionRoomGate.
function gateRoomKey(room) {
  const cleaned = sanitizeRoom(room === undefined || room === null ? "" : room);
  return cleaned || "_";
}

function roomGateRef(contestSlug, roomKey) {
  return firestore.collection(ROOM_GATES_COLLECTION).doc(`gate:${contestSlug || "_"}:${roomKey}`);
}

async function getRoomGate(contestSlug, roomKey) {
  const doc = await roomGateRef(contestSlug, roomKey).get();
  return doc.exists ? doc.data() : null;
}

function generateRoomOtp() {
  return String(randomInt(0, 1000000)).padStart(6, "0");
}

// Public projection of a gate doc — exactly what invigilator endpoints return.
function publicRoomGate(gate) {
  if (!gate) return null;
  return {
    room: gate.room || "",
    room_key: gate.room_key,
    mode: gate.mode,
    otp: gate.otp || "",
    released_at: gate.released_at || null,
    released_by: gate.released_by || "",
    opened_at: gate.opened_at || null,
    opened_by: gate.opened_by || "",
    updated_at: gate.updated_at || ""
  };
}

// Gate mutations require the admin to have ENABLED the room gate (the admin
// checkbox is also the admin-side master bypass: turning it off releases
// everyone on their next poll).
async function requireGateEnabledSettings() {
  const settings = await getSettings();
  if (!settings?.room_gate_enabled) badRequest("room_gate_disabled");
  return settings;
}

// POST /api/invigilator/release-code — mint (or re-display) the room's 6-digit
// start OTP. Idempotent by default: an existing OTP is returned unchanged so a
// portal reload never silently invalidates the code already on the board; pass
// regenerate:true for a fresh one. Calling this on an OPEN room re-arms the
// OTP gate (late arrivals) — already-released candidates keep exam_started_at.
async function invigilatorReleaseCode(req) {
  requireInvigilator(req);
  const body = parseBody(req);
  requireFields(body, ["room"]);
  const settings = await requireGateEnabledSettings();
  const contestSlug = settings?.contest_slug || contestSlugFromUrl(settings?.contest_url) || "";
  const roomKey = gateRoomKey(body.room);
  const existing = await getRoomGate(contestSlug, roomKey);
  if (existing && existing.mode === "otp" && existing.otp && body.regenerate !== true) {
    return { ok: true, contest_slug: contestSlug || null, gate: publicRoomGate(existing) };
  }
  const now = new Date().toISOString();
  const item = {
    contest_slug: contestSlug,
    room: roomKey === "_" ? "" : sanitizeRoom(body.room),
    room_key: roomKey,
    mode: "otp",
    otp: generateRoomOtp(),
    released_at: now,
    released_by: String(body.invigilator_name || "").slice(0, 120),
    opened_at: existing?.opened_at || null,
    opened_by: existing?.opened_by || "",
    updated_at: now
  };
  await roomGateRef(contestSlug, roomKey).set(item);
  return { ok: true, contest_slug: contestSlug || null, gate: publicRoomGate(item) };
}

// POST /api/invigilator/open-room — start-now / allow-all: marks the room OPEN
// so every waiting candidate's next gate poll admits them without a code. This
// is the room-scoped parallel of the admin's master switch (room_gate_enabled).
async function invigilatorOpenRoom(req) {
  requireInvigilator(req);
  const body = parseBody(req);
  requireFields(body, ["room"]);
  const settings = await requireGateEnabledSettings();
  const contestSlug = settings?.contest_slug || contestSlugFromUrl(settings?.contest_url) || "";
  const roomKey = gateRoomKey(body.room);
  const existing = await getRoomGate(contestSlug, roomKey);
  const now = new Date().toISOString();
  const item = {
    contest_slug: contestSlug,
    room: roomKey === "_" ? "" : sanitizeRoom(body.room),
    room_key: roomKey,
    mode: "open",
    otp: existing?.otp || "",
    released_at: existing?.released_at || null,
    released_by: existing?.released_by || "",
    opened_at: now,
    opened_by: String(body.invigilator_name || "").slice(0, 120),
    updated_at: now
  };
  await roomGateRef(contestSlug, roomKey).set(item);
  return { ok: true, contest_slug: contestSlug || null, gate: publicRoomGate(item) };
}
```

**(d)** In the route table, after the invigilator/overview route line add:

```javascript
    if (req.method === "POST" && path === "/api/invigilator/release-code") return send(res, 200, await invigilatorReleaseCode(req));
    if (req.method === "POST" && path === "/api/invigilator/open-room") return send(res, 200, await invigilatorOpenRoom(req));
```

- [ ] **Step 4: Run, verify pass + whole suite:**

Run: `cd /home/karthi/arogara/proctor/backend && node --test test/invigilator.test.mjs`
Run: `cd /home/karthi/arogara/proctor/backend && npm test`

- [ ] **Step 5: Commit**

```bash
cd /home/karthi/arogara/proctor
git add backend/src/handler.mjs backend/test/invigilator.test.mjs
git commit -m "feat(invigilator): room start gate — release-code (idempotent OTP) + open-room (start-now/allow-all)"
```

---

## Task 3: Backend — candidate `/api/session/room-gate` + exec enforcement

**Files:** Modify `backend/src/handler.mjs`, `backend/test/invigilator.test.mjs`.

- [ ] **Step 1: Append failing tests** to the END of `backend/test/invigilator.test.mjs`:

```javascript
// ---- Task 3: candidate room-gate poll/unlock + exec enforcement -------------

test("room-gate: gate disabled -> started immediately, no doc writes", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore, { room_gate_enabled: false });
  seedSession(firestore, "s1");
  const res = await call(makeReq({ method: "POST", path: "/api/session/room-gate", body: { session_id: "s1" } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual({ gate_enabled: res.body.gate_enabled, exam_started: res.body.exam_started },
    { gate_enabled: false, exam_started: true });
  assert.equal(firestore._collections.get(process.env.SESSION_COLLECTION).get("s1").exam_started_at, undefined);
});

test("room-gate: waiting before any release; invigilator open-room auto-starts and stamps the session", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "s1");
  const waiting = await call(makeReq({ method: "POST", path: "/api/session/room-gate", body: { session_id: "s1" } }));
  assert.equal(waiting.statusCode, 200);
  assert.equal(waiting.body.exam_started, false);
  await call(makeReq({ method: "POST", path: "/api/invigilator/open-room",
    headers: { "x-invigilator-password": "invig-pass" }, body: { room: "Lab A-1", invigilator_name: "Priya" } }));
  const started = await call(makeReq({ method: "POST", path: "/api/session/room-gate", body: { session_id: "s1" } }));
  assert.equal(started.body.exam_started, true);
  const doc = firestore._collections.get(process.env.SESSION_COLLECTION).get("s1");
  assert.ok(doc.exam_started_at);
  assert.equal(doc.exam_start_method, "room_open");
  // idempotent replay
  const again = await call(makeReq({ method: "POST", path: "/api/session/room-gate", body: { session_id: "s1" } }));
  assert.equal(again.body.exam_started, true);
  assert.equal(again.body.exam_started_at, doc.exam_started_at);
});

test("room-gate: correct OTP starts; wrong OTP -> 403 invalid_code and counts the attempt", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "s1");
  const released = await call(makeReq({ method: "POST", path: "/api/invigilator/release-code",
    headers: { "x-invigilator-password": "invig-pass" }, body: { room: "Lab A-1", invigilator_name: "Priya" } }));
  const otp = released.body.gate.otp;
  const wrong = await call(makeReq({ method: "POST", path: "/api/session/room-gate",
    body: { session_id: "s1", code: "000000" === otp ? "999999" : "000000" } }));
  assert.equal(wrong.statusCode, 403);
  assert.equal(wrong.body.error, "invalid_code");
  assert.equal(firestore._collections.get(process.env.SESSION_COLLECTION).get("s1").gate_attempt_count, 1);
  const right = await call(makeReq({ method: "POST", path: "/api/session/room-gate",
    body: { session_id: "s1", code: otp } }));
  assert.equal(right.statusCode, 200);
  assert.equal(right.body.exam_started, true);
  assert.equal(firestore._collections.get(process.env.SESSION_COLLECTION).get("s1").exam_start_method, "otp");
});

test("room-gate: attempt cap -> 429 too_many_attempts (even with the right code)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "s1", { gate_attempt_count: 20 });
  const released = await call(makeReq({ method: "POST", path: "/api/invigilator/release-code",
    headers: { "x-invigilator-password": "invig-pass" }, body: { room: "Lab A-1", invigilator_name: "Priya" } }));
  const res = await call(makeReq({ method: "POST", path: "/api/session/room-gate",
    body: { session_id: "s1", code: released.body.gate.otp } }));
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.error, "too_many_attempts");
  // a code-less status poll still works (and start-now can still admit them)
  const poll = await call(makeReq({ method: "POST", path: "/api/session/room-gate", body: { session_id: "s1" } }));
  assert.equal(poll.statusCode, 200);
  assert.equal(poll.body.exam_started, false);
});

test("room-gate: unknown session 404; ended session 409 (ownership gate)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  const unknown = await call(makeReq({ method: "POST", path: "/api/session/room-gate", body: { session_id: "nope" } }));
  assert.equal(unknown.statusCode, 404);
  seedSession(firestore, "s1", { status: "ended" });
  const ended = await call(makeReq({ method: "POST", path: "/api/session/room-gate", body: { session_id: "s1" } }));
  assert.equal(ended.statusCode, 409);
});

test("exec run/submit blocked with 403 exam_not_started until released; allowed after", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "s1");
  __setJudge0AdapterForTest({ runBatch: async (items) => items.map(() => (
    { status: "accepted", passed: true, stdout: "", stderr: "", compileOutput: "", timeSec: 0, memoryKb: 1 })) });
  const blockedRun = await call(makeReq({ method: "POST", path: "/api/exec/run",
    body: { session_id: "s1", problem_id: "sum-two", language: "python", source_code: "x" } }));
  assert.equal(blockedRun.statusCode, 403);
  assert.equal(blockedRun.body.error, "exam_not_started");
  const blockedSubmit = await call(makeReq({ method: "POST", path: "/api/exec/submit",
    body: { session_id: "s1", problem_id: "sum-two", language: "python", source_code: "x" } }));
  assert.equal(blockedSubmit.statusCode, 403);
  // release via start-now, then run again
  await call(makeReq({ method: "POST", path: "/api/invigilator/open-room",
    headers: { "x-invigilator-password": "invig-pass" }, body: { room: "Lab A-1", invigilator_name: "Priya" } }));
  await call(makeReq({ method: "POST", path: "/api/session/room-gate", body: { session_id: "s1" } }));
  const allowed = await call(makeReq({ method: "POST", path: "/api/exec/run",
    body: { session_id: "s1", problem_id: "sum-two", language: "python", source_code: "x" } }));
  assert.equal(allowed.statusCode, 200);
  __setJudge0AdapterForTest(null);
});
```

- [ ] **Step 2: Run, verify the new tests fail:**

Run: `cd /home/karthi/arogara/proctor/backend && node --test test/invigilator.test.mjs`

- [ ] **Step 3: Implement** in `backend/src/handler.mjs`:

**(a)** After the `const ROOM_GATES_COLLECTION = ...` line add:

```javascript
// Per-session wrong-OTP cap: at the cap further code attempts get 429 (status
// polls still work, and an invigilator start-now still admits the session).
const GATE_ATTEMPT_LIMIT = Number(process.env.GATE_ATTEMPT_LIMIT || "20");
```

**(b)** At the END of the S3 section add:

```javascript
// POST /api/session/room-gate — candidate-side gate poll/unlock. Auth = the
// unguessable session token (like /api/events), never admin auth. With no
// `code` it is a cheap status poll (the client re-polls ~5 s, so an invigilator
// start-now admits candidates with ZERO typing); with a `code` it attempts the
// room OTP. Recording/events/heartbeats are deliberately NOT gated — a
// candidate "waiting" is still recorded. The attempt cap is checked BEFORE the
// compare so a capped session stays capped even with the right code.
async function sessionRoomGate(req) {
  const body = parseBody(req);
  requireFields(body, ["session_id"]);
  const session = requireWritableSession(await getSession(String(body.session_id)));
  const settings = await getSettings();
  if (!settings?.room_gate_enabled) {
    return { gate_enabled: false, exam_started: true, exam_started_at: session.exam_started_at || null };
  }
  if (session.exam_started_at) {
    return { gate_enabled: true, exam_started: true, exam_started_at: session.exam_started_at };
  }
  const contestSlug = session.contest_slug || "";
  const roomKey = gateRoomKey(session.room);
  const gate = await getRoomGate(contestSlug, roomKey);
  const now = new Date().toISOString();

  if (gate && gate.mode === "open") {
    await sessionRef(session.session_id).update({ exam_started_at: now, exam_start_method: "room_open", updated_at: now });
    return { gate_enabled: true, exam_started: true, exam_started_at: now };
  }

  const code = body.code === undefined || body.code === null ? "" : String(body.code).trim();
  if (!code) {
    return { gate_enabled: true, exam_started: false, room: session.room || "" };
  }

  if (Number(session.gate_attempt_count || 0) >= GATE_ATTEMPT_LIMIT) {
    throw httpError(429, "too_many_attempts");
  }
  if (gate && gate.mode === "otp" && gate.otp && safeEqual(code, gate.otp)) {
    await sessionRef(session.session_id).update({ exam_started_at: now, exam_start_method: "otp", updated_at: now });
    return { gate_enabled: true, exam_started: true, exam_started_at: now };
  }
  await sessionRef(session.session_id).update({ gate_attempt_count: FieldValue.increment(1), updated_at: now });
  throw httpError(403, "invalid_code");
}

// S3 gate enforcement for code execution: with the gate enabled, Run/Submit are
// blocked until the session was released (OTP / room open / admin turning the
// gate off). Deliberately NOT inside requireWritableSession — evidence writes
// (events, uploads, heartbeats) must keep flowing while the candidate waits.
async function requireExamStarted(session) {
  const settings = await getSettings();
  if (settings?.room_gate_enabled && !session.exam_started_at) {
    throw httpError(403, "exam_not_started");
  }
}
```

**(c)** Route: after the line `if (req.method === "POST" && path === "/api/session/end") return send(res, 200, await endSession(req));` add:

```javascript
    if (req.method === "POST" && path === "/api/session/room-gate") return send(res, 200, await sessionRoomGate(req));
```

**(d)** In `execRun`, immediately after its line `const session = requireWritableSession(await getSession(String(body.session_id || "")));` add:

```javascript
  await requireExamStarted(session); // S3 room gate
```

**(e)** In `execSubmit`, immediately after its line `const session = requireWritableSession(await getSession(sessionId));` add:

```javascript
  await requireExamStarted(session); // S3 room gate
```

> Note: existing `exec.test.mjs` stays green — it seeds NO settings doc, so `room_gate_enabled` is falsy and the gate never fires there.

- [ ] **Step 4: Run, verify pass + whole suite:**

Run: `cd /home/karthi/arogara/proctor/backend && node --test test/invigilator.test.mjs`
Run: `cd /home/karthi/arogara/proctor/backend && npm test` (especially `exec.test.mjs` must still pass)

- [ ] **Step 5: Commit**

```bash
cd /home/karthi/arogara/proctor
git add backend/src/handler.mjs backend/test/invigilator.test.mjs
git commit -m "feat(invigilator): candidate room-gate poll/unlock + exec blocked until exam_started"
```

---

## Task 4: Backend — `/api/invigilator/room` dashboard (stats + students + gate + alerts)

**Files:** Modify `backend/src/handler.mjs`, `backend/test/invigilator.test.mjs`.

- [ ] **Step 1: Append failing tests** to the END of `backend/test/invigilator.test.mjs`:

```javascript
// ---- Task 4: room dashboard --------------------------------------------------

function seedAlert(firestore, id, overrides = {}) {
  firestore.collection(process.env.ALERTS_COLLECTION).doc(id).set({
    id, source: "proctor", type: "recording_stopped", severity: "critical",
    timestamp: "2026-06-09T10:00:00.000Z", hackerrank_username: "Alice", username_norm: "alice",
    title: "Recording stopped", contest_slug: "kec-2026", room: "Lab A-1", session_id: "a1",
    video_key: "contests/kec-2026/sessions/alice/a1/screen/merged.webm",
    ...overrides
  });
}

test("GET /api/invigilator/room: room-scoped stats + least-privilege rows + gate + filtered alerts", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  const fresh = new Date().toISOString();
  seedSession(firestore, "a1");                                                            // live
  seedSession(firestore, "a2", { username_norm: "bob", hackerrank_username: "Bob", name: "Bob B",
    last_heartbeat_at: "2026-06-09T00:00:00.000Z" });                                      // live, stale -> disconnected
  seedSession(firestore, "a3", { username_norm: "carl", name: "Carl C", status: "locked" });
  seedSession(firestore, "a4", { username_norm: "dan", name: "Dan D", status: "ended", exam_started_at: fresh });
  seedSession(firestore, "b1", { username_norm: "eve", room: "Lab B-2" });                 // other room — excluded
  await call(makeReq({ method: "POST", path: "/api/invigilator/release-code",
    headers: { "x-invigilator-password": "invig-pass" }, body: { room: "Lab A-1", invigilator_name: "Priya" } }));
  seedAlert(firestore, "al1");
  seedAlert(firestore, "al2", { id: "al2", archived: true });                              // archived — excluded
  seedAlert(firestore, "al3", { id: "al3", room: "Lab B-2" });                             // other room — excluded
  const res = await call(makeReq({ method: "GET", path: "/api/invigilator/room",
    query: { room: "Lab A-1" }, headers: { "x-invigilator-password": "invig-pass" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.room, "Lab A-1");
  assert.deepEqual(res.body.stats,
    { live: 2, locked: 1, pending_approval: 0, finished: 1, disconnected: 1, started: 1, total: 4 });
  assert.equal(res.body.sessions.length, 4);
  const row = res.body.sessions.find((r) => r.session_id === "a1");
  assert.equal(row.name, "Alice A");
  assert.equal(row.roll_number, "R1");
  // least-privilege: NO email / IP / storage fields on rows
  assert.ok(!("email" in row) && !("start_ip" in row) && !("current_ip" in row) && !("storage_prefix" in row));
  assert.equal(res.body.sessions.find((r) => r.session_id === "a2").stale, true);
  assert.equal(res.body.sessions.find((r) => r.session_id === "a4").exam_started_at, fresh);
  // gate present with the released OTP
  assert.match(res.body.gate.otp, /^\d{6}$/);
  // alerts: room-scoped, archived excluded, NO media fields
  assert.deepEqual(res.body.alerts.map((a) => a.id), ["al1"]);
  assert.ok(!("video_key" in res.body.alerts[0]) && !("download_url" in res.body.alerts[0]));
});

test("GET /api/invigilator/room: room=_ selects blank-room sessions; room param required", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore, storage: makeFakeStorage() });
  seedSettings(firestore);
  seedSession(firestore, "u1", { room: "" });
  seedSession(firestore, "a1");
  const res = await call(makeReq({ method: "GET", path: "/api/invigilator/room",
    query: { room: "_" }, headers: { "x-invigilator-password": "invig-pass" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.room_key, "_");
  assert.deepEqual(res.body.sessions.map((r) => r.session_id), ["u1"]);
  const missing = await call(makeReq({ method: "GET", path: "/api/invigilator/room",
    headers: { "x-invigilator-password": "invig-pass" } }));
  assert.equal(missing.statusCode, 400);
});
```

- [ ] **Step 2: Run, verify the new tests fail** (404 on the route):

Run: `cd /home/karthi/arogara/proctor/backend && node --test test/invigilator.test.mjs`

- [ ] **Step 3: Implement** in `backend/src/handler.mjs`:

**(a)** After the `const GATE_ATTEMPT_LIMIT = ...` line add:

```javascript
// Caps for the invigilator room dashboard payload.
const INVIGILATOR_SESSIONS_LIMIT = 500;
const INVIGILATOR_ALERTS_LIMIT = 100;
```

**(b)** At the END of the S3 section add:

```javascript
// GET /api/invigilator/room?room=<label> — the ONE-CALL room dashboard the
// portal polls every ~5 s: counts (same classification rules as adminStats,
// incl. the derived disconnected signal) + a lightweight per-student list + the
// room gate + the room's OPEN alerts. The special label "_" selects sessions
// with NO room. Least privilege: rows carry NO email and NO IPs; alerts carry
// NO video/download fields — invigilators read presence, not recordings.
async function invigilatorRoom(req) {
  requireInvigilator(req);
  const roomParam = req.query?.room;
  if (roomParam === undefined || roomParam === null || roomParam === "") {
    return badRequest("room is required");
  }
  const settings = await getSettings();
  const contestSlug = settings?.contest_slug || contestSlugFromUrl(settings?.contest_url) || "";
  const roomKey = gateRoomKey(roomParam);
  const roomLabel = roomKey === "_" ? "" : sanitizeRoom(roomParam);

  let query = firestore.collection(SESSION_COLLECTION);
  if (contestSlug) query = query.where("contest_slug", "==", contestSlug);
  const snapshot = await query.limit(SESSIONS_QUERY_LIMIT).get();
  const docs = snapshot.docs.map((doc) => doc.data())
    .filter((doc) => String(doc.room || "") === roomLabel);

  const nowMs = Date.now();
  const stats = { live: 0, locked: 0, pending_approval: 0, finished: 0, disconnected: 0, started: 0, total: 0 };
  for (const doc of docs) {
    stats.total += 1;
    if (doc.exam_started_at) stats.started += 1;
    if (doc.status === "active") {
      stats.live += 1;
      if (isStaleSession(doc, nowMs)) stats.disconnected += 1;
    } else if (doc.status === "locked") stats.locked += 1;
    else if (doc.status === "pending_approval") stats.pending_approval += 1;
    else if (doc.status === "ended") stats.finished += 1;
  }

  const sessions = docs
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")))
    .slice(0, INVIGILATOR_SESSIONS_LIMIT)
    .map((doc) => ({
      session_id: doc.session_id,
      name: doc.name || "",
      hackerrank_username: doc.hackerrank_username || "",
      roll_number: doc.roll_number || "",
      status: doc.status || "",
      stale: doc.status === "active" ? isStaleSession(doc, nowMs) : false,
      exam_started_at: doc.exam_started_at || null,
      created_at: doc.created_at || ""
    }));

  const gate = publicRoomGate(await getRoomGate(contestSlug, roomKey));

  // Same index-free pattern as adminAlerts: at most ONE equality filter
  // (contest_slug) pushed to Firestore; room/archive filtering in memory.
  let alertQuery = firestore.collection(ALERTS_COLLECTION);
  if (contestSlug) alertQuery = alertQuery.where("contest_slug", "==", contestSlug);
  const alertSnapshot = await alertQuery.limit(ALERTS_QUERY_LIMIT).get();
  const alerts = alertSnapshot.docs
    .map((doc) => doc.data())
    .filter((alert) => String(alert.room || "") === roomLabel)
    .filter((alert) => !alert.archived)
    .sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")))
    .slice(0, INVIGILATOR_ALERTS_LIMIT)
    .map((alert) => ({
      id: alert.id,
      type: alert.type,
      severity: alert.severity,
      timestamp: alert.timestamp,
      title: alert.title,
      detail: alert.detail ? String(alert.detail) : "",
      hackerrank_username: alert.hackerrank_username || "",
      session_id: alert.session_id || ""
    }));

  return {
    contest_slug: contestSlug || null,
    room: roomLabel || null,
    room_key: roomKey,
    room_gate_enabled: Boolean(settings?.room_gate_enabled),
    stats,
    sessions,
    gate,
    alerts,
    disconnected_staleness_ms: DISCONNECTED_STALENESS_MS
  };
}
```

**(c)** Route: after the invigilator/overview route line add:

```javascript
    if (req.method === "GET" && path === "/api/invigilator/room") return send(res, 200, await invigilatorRoom(req));
```

- [ ] **Step 4: Run, verify pass + whole suite:**

Run: `cd /home/karthi/arogara/proctor/backend && node --test test/invigilator.test.mjs`
Run: `cd /home/karthi/arogara/proctor/backend && npm test`

- [ ] **Step 5: Commit**

```bash
cd /home/karthi/arogara/proctor
git add backend/src/handler.mjs backend/test/invigilator.test.mjs
git commit -m "feat(invigilator): room dashboard endpoint — stats + students + gate + selective alerts"
```

---

## Task 5: Frontend — types, pure gateLogic (vitest), api client + demo branches

**Files:** Create `frontend/src/invigilator/gateLogic.ts`, `frontend/src/invigilator/gateLogic.test.ts`; modify `frontend/src/types.ts`, `frontend/src/api.ts`.

- [ ] **Step 1: Write the failing vitest** — create `frontend/src/invigilator/gateLogic.test.ts`:

```typescript
// frontend/src/invigilator/gateLogic.test.ts
import { describe, expect, it } from "vitest";
import { gateStatusLabel, isCompleteOtp, normalizeOtpInput, roomKeyForLabel } from "./gateLogic";
import type { RoomGate } from "../types";

const baseGate: RoomGate = {
  room: "Lab A-1", room_key: "Lab A-1", mode: "otp", otp: "123456",
  released_at: "2026-06-09T10:00:00.000Z", released_by: "Priya",
  opened_at: null, opened_by: "", updated_at: "2026-06-09T10:00:00.000Z"
};

describe("normalizeOtpInput", () => {
  it("strips non-digits and caps at 6", () => {
    expect(normalizeOtpInput(" 12a3-4 5678")).toBe("123456");
    expect(normalizeOtpInput("12")).toBe("12");
    expect(normalizeOtpInput("abc")).toBe("");
  });
});

describe("isCompleteOtp", () => {
  it("accepts exactly six digits", () => {
    expect(isCompleteOtp("123456")).toBe(true);
    expect(isCompleteOtp("12345")).toBe(false);
    expect(isCompleteOtp("1234567")).toBe(false);
    expect(isCompleteOtp("12345a")).toBe(false);
  });
});

describe("roomKeyForLabel", () => {
  it("mirrors the backend sanitizer (keep letters/digits/space/._-, max 80) and falls back to '_'", () => {
    expect(roomKeyForLabel("Lab A-1")).toBe("Lab A-1");
    expect(roomKeyForLabel("Lab @#A!")).toBe("Lab A");
    expect(roomKeyForLabel("   ")).toBe("_");
    expect(roomKeyForLabel("")).toBe("_");
    expect(roomKeyForLabel("x".repeat(100))).toBe("x".repeat(80));
  });
});

describe("gateStatusLabel", () => {
  it("classifies missing / armed / open gates", () => {
    expect(gateStatusLabel(null).tone).toBe("idle");
    expect(gateStatusLabel(baseGate).tone).toBe("armed");
    expect(gateStatusLabel({ ...baseGate, mode: "open" }).tone).toBe("open");
  });
});
```

- [ ] **Step 2: Run, verify it fails** (module missing):

Run: `cd /home/karthi/arogara/proctor/frontend && npx vitest run src/invigilator/gateLogic.test.ts`

- [ ] **Step 3: Implement.**

**(a)** Create `frontend/src/invigilator/gateLogic.ts`:

```typescript
// frontend/src/invigilator/gateLogic.ts — pure helpers for the S3 room gate.
// No React, no fetch — unit-tested with vitest.
import type { RoomGate } from "../types";

// Mirror of the backend's sanitizeRoom + gateRoomKey: the portal must send the
// SAME key the backend derives from a candidate's room label, and the
// "(no room set)" picker entry maps to the reserved "_" key.
export function roomKeyForLabel(label: string): string {
  const cleaned = String(label).trim().replace(/[^a-zA-Z0-9 ._-]/g, "").slice(0, 80);
  return cleaned || "_";
}

// Candidate OTP input: digits only, capped at 6 (the input is forgiving about
// spaces/dashes people type when copying from a board).
export function normalizeOtpInput(raw: string): string {
  return String(raw).replace(/\D/g, "").slice(0, 6);
}

export function isCompleteOtp(value: string): boolean {
  return /^\d{6}$/.test(value);
}

export type GateBadge = { label: string; tone: "idle" | "armed" | "open" };

export function gateStatusLabel(gate: RoomGate | null): GateBadge {
  if (!gate) return { label: "No code released yet", tone: "idle" };
  if (gate.mode === "open") return { label: "Room OPEN — everyone admitted", tone: "open" };
  return { label: "Code active", tone: "armed" };
}
```

**(b)** In `frontend/src/types.ts`:
- Inside `SessionStartResponse`, after the `contest_url?: string;` line add:
  ```typescript
    /** S3: when true the client holds at the room-code screen until released. */
    room_gate_enabled?: boolean;
  ```
- Inside `ProctorSettings`, after the `contest_url?: string;` line add:
  ```typescript
    /** S3: opt-in room start gate (invigilator OTP / start-now). */
    room_gate_enabled?: boolean;
  ```
- APPEND at the end of the file:

```typescript
// ---- S3: invigilator portal + room start gate -------------------------------

export type RoomGateMode = "otp" | "open";

export type RoomGate = {
  room: string;
  room_key: string;
  mode: RoomGateMode;
  otp: string;
  released_at: string | null;
  released_by: string;
  opened_at: string | null;
  opened_by: string;
  updated_at: string;
};

export type RoomGateActionResponse = {
  ok: boolean;
  contest_slug: string | null;
  gate: RoomGate;
};

export type InvigilatorOverviewResponse = {
  contest_slug: string | null;
  room_gate_enabled: boolean;
  rooms: string[];
  has_unassigned: boolean;
};

export type InvigilatorSessionRow = {
  session_id: string;
  name: string;
  hackerrank_username: string;
  roll_number: string;
  status: ServerSessionStatus | "";
  stale: boolean;
  exam_started_at: string | null;
  created_at: string;
};

export type InvigilatorAlert = {
  id: string;
  type: string;
  severity: AlertSeverity;
  timestamp: string;
  title: string;
  detail: string;
  hackerrank_username: string;
  session_id: string;
};

export type InvigilatorRoomStats = {
  live: number;
  locked: number;
  pending_approval: number;
  finished: number;
  disconnected: number;
  started: number;
  total: number;
};

export type InvigilatorRoomResponse = {
  contest_slug: string | null;
  room: string | null;
  room_key: string;
  room_gate_enabled: boolean;
  stats: InvigilatorRoomStats;
  sessions: InvigilatorSessionRow[];
  gate: RoomGate | null;
  alerts: InvigilatorAlert[];
  disconnected_staleness_ms?: number;
};

export type RoomGatePollResponse = {
  gate_enabled: boolean;
  exam_started: boolean;
  exam_started_at?: string | null;
  room?: string;
};
```

**(c)** In `frontend/src/api.ts`:
- Add to the existing `import type { ... } from "./types";` list: `InvigilatorAlert`, `InvigilatorOverviewResponse`, `InvigilatorRoomResponse`, `InvigilatorSessionRow`, `RoomGate`, `RoomGateActionResponse`, `RoomGatePollResponse`.
- Add a new import line after the types import:
  ```typescript
  import { roomKeyForLabel } from "./invigilator/gateLogic";
  ```
- In the `DemoSession` type, after `start_ip: string;` add:
  ```typescript
    exam_started_at?: string | null;
  ```
- In `saveProctorSettings`'s demo branch, inside `const next = { ... }`, after the `contest_url: ...` line add:
  ```typescript
        room_gate_enabled: settings.room_gate_enabled === true,
  ```
- APPEND at the end of the file:

```typescript
// ---- S3: invigilator portal + room start gate -------------------------------

export const invigilatorPassword = import.meta.env.VITE_INVIGILATOR_PASSWORD ?? "";
// When set, the portal unlock compares sha256(typed) to this hash so the plain
// password never ships in the bundle (mirrors VITE_ADMIN_PASSWORD_HASH).
export const invigilatorPasswordHash = (import.meta.env.VITE_INVIGILATOR_PASSWORD_HASH ?? "").trim().toLowerCase();
const demoRoomGatesKey = "aerele-proctor-demo-room-gates";

function assertDemoInvigilator(password: string) {
  if (invigilatorPassword && password === invigilatorPassword) return;
  if (adminPassword && password === adminPassword) return;
  throw new Error("Invalid invigilator password.");
}

function invigilatorHeaders(password: string) {
  return { "x-invigilator-password": password };
}

type DemoRoomGateStore = Record<string, RoomGate>;

function readDemoRoomGates(): DemoRoomGateStore {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(demoRoomGatesKey) || "{}");
    return parsed && typeof parsed === "object" ? (parsed as DemoRoomGateStore) : {};
  } catch {
    return {};
  }
}

function writeDemoRoomGates(store: DemoRoomGateStore) {
  window.localStorage.setItem(demoRoomGatesKey, JSON.stringify(store));
}

export async function fetchInvigilatorOverview(password: string): Promise<InvigilatorOverviewResponse> {
  if (demoMode) {
    await wait(120);
    assertDemoInvigilator(password);
    const rooms = [
      ...new Set(DEMO_ALL_SESSIONS.map((s) => String(s.room || "").trim()).filter(Boolean))
    ].sort((a, b) => a.localeCompare(b));
    return {
      contest_slug: DEMO_CONTEST_SLUG,
      room_gate_enabled: getDemoSettings()?.room_gate_enabled === true,
      rooms,
      has_unassigned: false
    };
  }
  return request<InvigilatorOverviewResponse>("/api/invigilator/overview", {
    method: "GET",
    headers: invigilatorHeaders(password)
  });
}

export async function fetchInvigilatorRoom(password: string, room: string): Promise<InvigilatorRoomResponse> {
  if (demoMode) {
    await wait(120);
    assertDemoInvigilator(password);
    const roomKey = roomKeyForLabel(room);
    const roomLabel = roomKey === "_" ? "" : room;
    const docs = DEMO_ALL_SESSIONS.filter((s) => String(s.room || "") === roomLabel);
    const gate = readDemoRoomGates()[roomKey] || null;
    const stats = { live: 0, locked: 0, pending_approval: 0, finished: 0, disconnected: 0, started: 0, total: 0 };
    for (const s of docs) {
      stats.total += 1;
      if (gate?.mode === "open") stats.started += 1; // demo approximation
      if (s.status === "active") {
        stats.live += 1;
        if (s.stale === true) stats.disconnected += 1;
      } else if (s.status === "locked") stats.locked += 1;
      else if (s.status === "pending_approval") stats.pending_approval += 1;
      else if (s.status === "ended") stats.finished += 1;
    }
    const sessions: InvigilatorSessionRow[] = docs
      .slice()
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")))
      .map((s) => ({
        session_id: s.session_id,
        name: s.name,
        hackerrank_username: s.hackerrank_username,
        roll_number: "",
        status: s.status,
        stale: s.status === "active" && s.stale === true,
        exam_started_at: gate?.mode === "open" ? gate.opened_at : null,
        created_at: s.created_at
      }));
    const alerts: InvigilatorAlert[] = readDemoAlerts()
      .filter((a) => String(a.room || "") === roomLabel && !a.archived)
      .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
      .slice(0, 100)
      .map((a) => ({
        id: a.id, type: a.type, severity: a.severity, timestamp: a.timestamp,
        title: a.title, detail: String(a.detail || ""),
        hackerrank_username: a.hackerrank_username, session_id: String(a.session_id || "")
      }));
    return {
      contest_slug: DEMO_CONTEST_SLUG,
      room: roomLabel || null,
      room_key: roomKey,
      room_gate_enabled: getDemoSettings()?.room_gate_enabled === true,
      stats, sessions, gate, alerts,
      disconnected_staleness_ms: 45000
    };
  }
  return request<InvigilatorRoomResponse>(`/api/invigilator/room?room=${encodeURIComponent(room)}`, {
    method: "GET",
    headers: invigilatorHeaders(password)
  });
}

export async function releaseRoomCode(
  password: string, room: string, invigilatorName: string, regenerate = false
): Promise<RoomGateActionResponse> {
  if (demoMode) {
    await wait(150);
    assertDemoInvigilator(password);
    if (getDemoSettings()?.room_gate_enabled !== true) throw new Error("room_gate_disabled");
    const store = readDemoRoomGates();
    const roomKey = roomKeyForLabel(room);
    const existing = store[roomKey];
    if (existing && existing.mode === "otp" && existing.otp && !regenerate) {
      return { ok: true, contest_slug: DEMO_CONTEST_SLUG, gate: existing };
    }
    const now = new Date().toISOString();
    const gate: RoomGate = {
      room: roomKey === "_" ? "" : room,
      room_key: roomKey,
      mode: "otp",
      otp: String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0"),
      released_at: now,
      released_by: invigilatorName,
      opened_at: existing?.opened_at ?? null,
      opened_by: existing?.opened_by ?? "",
      updated_at: now
    };
    store[roomKey] = gate;
    writeDemoRoomGates(store);
    return { ok: true, contest_slug: DEMO_CONTEST_SLUG, gate };
  }
  return request<RoomGateActionResponse>("/api/invigilator/release-code", {
    method: "POST",
    headers: invigilatorHeaders(password),
    body: JSON.stringify({ room, invigilator_name: invigilatorName, ...(regenerate ? { regenerate: true } : {}) })
  });
}

export async function openRoom(password: string, room: string, invigilatorName: string): Promise<RoomGateActionResponse> {
  if (demoMode) {
    await wait(150);
    assertDemoInvigilator(password);
    if (getDemoSettings()?.room_gate_enabled !== true) throw new Error("room_gate_disabled");
    const store = readDemoRoomGates();
    const roomKey = roomKeyForLabel(room);
    const existing = store[roomKey];
    const now = new Date().toISOString();
    const gate: RoomGate = {
      room: roomKey === "_" ? "" : room,
      room_key: roomKey,
      mode: "open",
      otp: existing?.otp ?? "",
      released_at: existing?.released_at ?? null,
      released_by: existing?.released_by ?? "",
      opened_at: now,
      opened_by: invigilatorName,
      updated_at: now
    };
    store[roomKey] = gate;
    writeDemoRoomGates(store);
    return { ok: true, contest_slug: DEMO_CONTEST_SLUG, gate };
  }
  return request<RoomGateActionResponse>("/api/invigilator/open-room", {
    method: "POST",
    headers: invigilatorHeaders(password),
    body: JSON.stringify({ room, invigilator_name: invigilatorName })
  });
}

// Candidate-side gate poll/unlock. No code = status poll; with a code it
// attempts the room OTP. Demo mode mirrors the backend against localStorage.
export async function pollRoomGate(sessionId: string, code?: string): Promise<RoomGatePollResponse> {
  if (demoMode) {
    await wait(100);
    const settings = getDemoSettings();
    if (settings?.room_gate_enabled !== true) return { gate_enabled: false, exam_started: true };
    const session = readDemoSessions().find((item) => item.session_id === sessionId);
    if (!session) throw new Error("Session not found");
    if (session.exam_started_at) {
      return { gate_enabled: true, exam_started: true, exam_started_at: session.exam_started_at };
    }
    const gate = readDemoRoomGates()[roomKeyForLabel(session.room)];
    const now = new Date().toISOString();
    if (gate?.mode === "open") {
      upsertDemoSession({ ...session, exam_started_at: now });
      return { gate_enabled: true, exam_started: true, exam_started_at: now };
    }
    if (code !== undefined && code !== "") {
      if (gate?.mode === "otp" && gate.otp === String(code).trim()) {
        upsertDemoSession({ ...session, exam_started_at: now });
        return { gate_enabled: true, exam_started: true, exam_started_at: now };
      }
      const error = new Error("invalid_code") as ApiError;
      error.status = 403;
      error.code = "invalid_code";
      throw error;
    }
    return { gate_enabled: true, exam_started: false, room: session.room };
  }
  return request<RoomGatePollResponse>("/api/session/room-gate", {
    method: "POST",
    body: JSON.stringify({ session_id: sessionId, ...(code ? { code } : {}) })
  });
}
```

- [ ] **Step 4: Run, verify pass + typecheck:**

Run: `cd /home/karthi/arogara/proctor/frontend && npx vitest run src/invigilator/gateLogic.test.ts` → 4 test groups pass.
Run: `cd /home/karthi/arogara/proctor/frontend && npm run lint` → no TS errors. (Note: `npm run test` runs ALL vitest files — also fine to use.)

- [ ] **Step 5: Commit**

```bash
cd /home/karthi/arogara/proctor
git add frontend/src/invigilator/gateLogic.ts frontend/src/invigilator/gateLogic.test.ts frontend/src/types.ts frontend/src/api.ts
git commit -m "feat(invigilator): gate types + pure gateLogic (vitest) + api client with demo branches"
```

---

## Task 6: Frontend — InvigilatorApp + route + admin settings checkbox

**Files:** Create `frontend/src/InvigilatorApp.tsx`; modify `frontend/src/App.tsx`.

- [ ] **Step 1: Create `frontend/src/InvigilatorApp.tsx`** with EXACTLY this content:

```tsx
// frontend/src/InvigilatorApp.tsx
// S3 — the room invigilator portal (/invigilator). Unlock mirrors the admin
// gate (client-side verify, then the typed password rides x-invigilator-password
// on every call; the backend also accepts the admin credential). NO signed-QR
// ID verification here — that is DEFERRED by design; ID checks stay manual.
import { AlertTriangle, Bell, DoorOpen, KeyRound, RefreshCw, ShieldCheck, Users } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  adminPassword, adminPasswordHash,
  fetchInvigilatorOverview, fetchInvigilatorRoom,
  invigilatorPassword, invigilatorPasswordHash,
  openRoom, releaseRoomCode, sha256Hex
} from "./api";
import { gateStatusLabel } from "./invigilator/gateLogic";
import type { InvigilatorAlert, InvigilatorRoomResponse, InvigilatorSessionRow, RoomGate } from "./types";

const POLL_INTERVAL_MS = 5000;
const savedKey = "aerele-proctor-invigilator";
const UNASSIGNED_KEY = "_";
const UNASSIGNED_LABEL = "(no room set)";
const OTHER_CHOICE = "__other__";

type SavedIdentity = { name: string; room: string };

function readSaved(): SavedIdentity {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(savedKey) || "{}") as Partial<SavedIdentity>;
    return { name: String(parsed.name || ""), room: String(parsed.room || "") };
  } catch {
    return { name: "", room: "" };
  }
}

export function InvigilatorApp() {
  const [unlocked, setUnlocked] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [name, setName] = useState(() => readSaved().name);
  // The API value for the selected room ("_" = the unassigned pseudo-room).
  const [room, setRoom] = useState(() => readSaved().room);
  const [roomChoice, setRoomChoice] = useState("");
  const [otherRoom, setOtherRoom] = useState("");
  const [rooms, setRooms] = useState<string[]>([]);
  const [hasUnassigned, setHasUnassigned] = useState(false);
  const [gateEnabled, setGateEnabled] = useState(false);
  const [contestSlug, setContestSlug] = useState<string | null>(null);
  const [data, setData] = useState<InvigilatorRoomResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const saveIdentity = (nextRoom: string) => {
    window.localStorage.setItem(savedKey, JSON.stringify({ name: name.trim(), room: nextRoom }));
  };

  // Unlock: invigilator hash → invigilator plain → admin hash → admin plain
  // (an admin may open the portal with the admin credential).
  const unlock = async () => {
    setError("");
    if (!name.trim()) {
      setError("Enter your name — code releases are recorded against it.");
      return;
    }
    const typed = passwordInput;
    let ok = false;
    try {
      if (invigilatorPasswordHash && (await sha256Hex(typed)) === invigilatorPasswordHash) ok = true;
      if (!ok && adminPasswordHash && (await sha256Hex(typed)) === adminPasswordHash) ok = true;
    } catch {
      setError("This browser cannot hash the password (crypto.subtle unavailable).");
      return;
    }
    if (!ok && invigilatorPassword && typed === invigilatorPassword) ok = true;
    if (!ok && adminPassword && typed === adminPassword) ok = true;
    if (!ok) {
      setError("Invalid invigilator password.");
      return;
    }
    setPassword(typed);
    setUnlocked(true);
    setPasswordInput("");
    saveIdentity(room);
    try {
      const overview = await fetchInvigilatorOverview(typed);
      setRooms(overview.rooms);
      setHasUnassigned(overview.has_unassigned);
      setGateEnabled(overview.room_gate_enabled);
      setContestSlug(overview.contest_slug);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const confirmRoom = () => {
    const next = roomChoice === OTHER_CHOICE ? otherRoom.trim() : roomChoice;
    if (!next) return;
    if (room && next !== room
      && !window.confirm("Change rooms? Your view moves to the new room; past gate actions stay recorded under your name.")) {
      return;
    }
    setRoom(next);
    setData(null);
    saveIdentity(next);
  };

  // Room dashboard poll: ONE GET per 5 s returns stats + students + gate +
  // alerts (mirrors the admin auto-poll; transient poll errors are swallowed).
  useEffect(() => {
    if (!unlocked || !room) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const response = await fetchInvigilatorRoom(password, room);
        if (cancelled) return;
        setData(response);
        setGateEnabled(response.room_gate_enabled);
        setContestSlug(response.contest_slug);
      } catch {
        // next tick or a manual action surfaces real errors
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [unlocked, room, password]);

  const release = async (regenerate: boolean) => {
    if (regenerate && !window.confirm("Generate a NEW code? The code currently on the board stops working.")) return;
    setBusy(true);
    setError("");
    try {
      const response = await releaseRoomCode(password, room, name.trim(), regenerate);
      setData((current) => (current ? { ...current, gate: response.gate } : current));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const startNow = async () => {
    if (!window.confirm("Start now for the WHOLE room? Every waiting candidate is admitted without a code.")) return;
    setBusy(true);
    setError("");
    try {
      const response = await openRoom(password, room, name.trim());
      setData((current) => (current ? { ...current, gate: response.gate } : current));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!unlocked) {
    return (
      <PortalShell>
        <section className="mx-auto mt-16 max-w-md rounded-lg border border-line bg-panel p-6 shadow-subtle">
          <div className="flex items-center gap-3">
            <ShieldCheck size={22} className="text-accent" />
            <h1 className="text-xl font-semibold text-ink">Invigilator portal</h1>
          </div>
          <p className="mt-2 text-sm leading-6 text-muted">
            Room console: release the start code, start the room, watch who is recording, and read your room's alerts. ID checks are manual (no QR scanning).
          </p>
          <div className="mt-4 space-y-3">
            <label className="block text-sm">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">Your name</span>
              <input className="focus-ring h-10 w-full rounded-md border border-line bg-white px-3 text-sm" value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">Invigilator password</span>
              <input
                className="focus-ring h-10 w-full rounded-md border border-line bg-white px-3 text-sm"
                type="password"
                value={passwordInput}
                onChange={(event) => setPasswordInput(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") void unlock(); }}
              />
            </label>
            <button className="focus-ring inline-flex h-10 w-full items-center justify-center rounded-md bg-ink text-sm font-medium text-white" onClick={() => void unlock()}>
              Enter
            </button>
            {error ? <p className="text-sm font-medium text-danger">{error}</p> : null}
          </div>
        </section>
      </PortalShell>
    );
  }

  if (!room) {
    return (
      <PortalShell>
        <section className="mx-auto mt-16 max-w-md rounded-lg border border-line bg-panel p-6 shadow-subtle">
          <h1 className="text-xl font-semibold text-ink">Pick your room</h1>
          <p className="mt-2 text-sm text-muted">{contestSlug ? `Contest: ${contestSlug}` : "No contest configured yet."}</p>
          <div className="mt-4 space-y-3">
            <select className="focus-ring h-10 w-full rounded-md border border-line bg-white px-3 text-sm" value={roomChoice} onChange={(event) => setRoomChoice(event.target.value)}>
              <option value="">Select a room…</option>
              {rooms.map((label) => <option key={label} value={label}>{label}</option>)}
              {hasUnassigned ? <option value={UNASSIGNED_KEY}>{UNASSIGNED_LABEL}</option> : null}
              <option value={OTHER_CHOICE}>Other…</option>
            </select>
            {roomChoice === OTHER_CHOICE ? (
              <input className="focus-ring h-10 w-full rounded-md border border-line bg-white px-3 text-sm" placeholder="Room label" value={otherRoom} onChange={(event) => setOtherRoom(event.target.value)} />
            ) : null}
            <button
              className="focus-ring inline-flex h-10 w-full items-center justify-center rounded-md bg-ink text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!roomChoice || (roomChoice === OTHER_CHOICE && !otherRoom.trim())}
              onClick={confirmRoom}
            >
              Open room console
            </button>
            {error ? <p className="text-sm font-medium text-danger">{error}</p> : null}
          </div>
        </section>
      </PortalShell>
    );
  }

  const roomLabel = room === UNASSIGNED_KEY ? UNASSIGNED_LABEL : room;
  const stats = data?.stats ?? null;

  return (
    <PortalShell>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-accent">Aerele Proctor — Invigilator</p>
          <h1 className="mt-1 text-2xl font-semibold text-ink">Room {roomLabel}</h1>
          <p className="mt-1 text-sm text-muted">
            {name.trim()}{contestSlug ? ` · ${contestSlug}` : ""} · refreshes every {POLL_INTERVAL_MS / 1000}s
          </p>
        </div>
        <button
          className="focus-ring inline-flex h-10 items-center gap-2 rounded-md border border-line px-4 text-sm font-medium"
          onClick={() => {
            if (window.confirm("Leave this room view and pick another room?")) {
              setRoom("");
              setRoomChoice("");
              setData(null);
              saveIdentity("");
            }
          }}
        >
          Change room
        </button>
      </header>

      {error ? <div className="mt-4 rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger">{error}</div> : null}

      <div className="mt-5">
        <GateCard
          gate={data?.gate ?? null}
          gateEnabled={gateEnabled}
          busy={busy}
          onRelease={() => void release(false)}
          onRegenerate={() => void release(true)}
          onStartNow={() => void startNow()}
        />
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
        <StatTile label="Recording" value={stats?.live ?? 0} tone="accent" />
        <StatTile label="Disconnected" value={stats?.disconnected ?? 0} tone="danger" />
        <StatTile label="Locked" value={stats?.locked ?? 0} tone="danger" />
        <StatTile label="Waiting approval" value={stats?.pending_approval ?? 0} tone="warning" />
        <StatTile label="Finished" value={stats?.finished ?? 0} />
        <StatTile label="Started exam" value={stats?.started ?? 0} tone="accent" />
        <StatTile label="Total" value={stats?.total ?? 0} />
      </div>

      <section className="mt-5 rounded-lg border border-line bg-panel p-5 shadow-subtle">
        <div className="mb-3 flex items-center gap-2">
          <Users size={18} />
          <h2 className="text-base font-semibold">Students in this room</h2>
        </div>
        {data && data.sessions.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs font-semibold uppercase tracking-wide text-muted">
                  <th className="py-2 pr-3">Name</th>
                  <th className="py-2 pr-3">Username</th>
                  <th className="py-2 pr-3">Roll no.</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2">Exam</th>
                </tr>
              </thead>
              <tbody>
                {data.sessions.map((row) => {
                  const badge = statusBadge(row);
                  return (
                    <tr key={row.session_id} className="border-b border-line/60">
                      <td className="py-2 pr-3 font-medium text-ink">{row.name || "—"}</td>
                      <td className="py-2 pr-3 text-muted">{row.hackerrank_username || "—"}</td>
                      <td className="py-2 pr-3 text-muted">{row.roll_number || "—"}</td>
                      <td className="py-2 pr-3">
                        <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-semibold ${badge.className}`}>{badge.label}</span>
                      </td>
                      <td className="py-2 text-muted">{row.exam_started_at ? "Started" : "Waiting"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted">{data ? "No sessions in this room yet." : "Loading…"}</p>
        )}
      </section>

      <section className="mt-5 rounded-lg border border-line bg-panel p-5 shadow-subtle">
        <div className="mb-3 flex items-center gap-2">
          <Bell size={18} />
          <h2 className="text-base font-semibold">Room alerts</h2>
        </div>
        {data && data.alerts.length ? (
          <div className="space-y-2">
            {data.alerts.map((alert) => <AlertRow key={alert.id} alert={alert} />)}
          </div>
        ) : (
          <p className="text-sm text-muted">{data ? "No open alerts for this room." : "Loading…"}</p>
        )}
      </section>
    </PortalShell>
  );
}

function PortalShell(props: { children: ReactNode }) {
  return <main className="mx-auto min-h-screen w-full max-w-5xl px-4 pb-16 pt-6">{props.children}</main>;
}

function GateCard(props: {
  gate: RoomGate | null;
  gateEnabled: boolean;
  busy: boolean;
  onRelease: () => void;
  onRegenerate: () => void;
  onStartNow: () => void;
}) {
  const { gate, gateEnabled, busy, onRelease, onRegenerate, onStartNow } = props;
  const badge = gateStatusLabel(gate);
  const tones: Record<string, string> = {
    idle: "border-line bg-white/60 text-muted",
    armed: "border-accent/40 bg-accent/10 text-accent",
    open: "border-warning/40 bg-warning/10 text-warning"
  };
  return (
    <section className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <KeyRound size={18} />
          <h2 className="text-base font-semibold">Room start gate</h2>
        </div>
        <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${tones[badge.tone]}`}>{badge.label}</span>
      </div>
      {!gateEnabled ? (
        <p className="mt-3 text-sm text-muted">
          Room start codes are OFF for this contest — ask the admin to enable "Room start codes" in the console settings. Stats and alerts below still work.
        </p>
      ) : (
        <>
          {gate && gate.mode === "otp" && gate.otp ? (
            <p className="mt-4 text-center font-mono text-5xl font-bold tracking-[0.35em] text-ink">{gate.otp}</p>
          ) : null}
          {gate?.mode === "open" ? (
            <p className="mt-3 text-sm text-muted">
              Everyone in this room is admitted automatically — no code needed. Releasing a code re-arms the gate for late arrivals only.
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-3">
            {!gate || gate.mode === "open" || !gate.otp ? (
              <button className="focus-ring inline-flex h-10 items-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white disabled:opacity-50" disabled={busy} onClick={onRelease}>
                <KeyRound size={16} /> Release room code
              </button>
            ) : (
              <button className="focus-ring inline-flex h-10 items-center gap-2 rounded-md border border-line px-4 text-sm font-medium disabled:opacity-50" disabled={busy} onClick={onRegenerate}>
                <RefreshCw size={16} /> Regenerate code
              </button>
            )}
            {gate?.mode !== "open" ? (
              <button className="focus-ring inline-flex h-10 items-center gap-2 rounded-md bg-accent px-4 text-sm font-semibold text-white disabled:opacity-50" disabled={busy} onClick={onStartNow}>
                <DoorOpen size={16} /> Start now — allow all
              </button>
            ) : null}
          </div>
          {gate?.released_by ? (
            <p className="mt-3 text-xs text-muted">
              Code released by {gate.released_by}{gate.released_at ? ` at ${new Date(gate.released_at).toLocaleTimeString()}` : ""}.
            </p>
          ) : null}
          {gate?.opened_by ? (
            <p className="mt-1 text-xs text-muted">
              Room opened by {gate.opened_by}{gate.opened_at ? ` at ${new Date(gate.opened_at).toLocaleTimeString()}` : ""}.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function StatTile(props: { label: string; value: number; tone?: "danger" | "warning" | "accent" }) {
  const tone = props.tone === "danger" ? "text-danger" : props.tone === "warning" ? "text-warning" : props.tone === "accent" ? "text-accent" : "text-ink";
  return (
    <div className="rounded-lg border border-line bg-panel p-4 shadow-subtle">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{props.label}</p>
      <p className={`mt-1 text-2xl font-semibold ${tone}`}>{props.value}</p>
    </div>
  );
}

function statusBadge(row: InvigilatorSessionRow): { label: string; className: string } {
  if (row.status === "active" && row.stale) return { label: "Disconnected", className: "border-danger/40 bg-danger/10 text-danger" };
  if (row.status === "active") return { label: "Recording", className: "border-accent/40 bg-accent/10 text-accent" };
  if (row.status === "locked") return { label: "Locked", className: "border-danger/40 bg-danger/10 text-danger" };
  if (row.status === "pending_approval") return { label: "Waiting approval", className: "border-warning/40 bg-warning/10 text-warning" };
  if (row.status === "ended") return { label: "Finished", className: "border-line bg-white/60 text-muted" };
  return { label: row.status || "Unknown", className: "border-line bg-white/60 text-muted" };
}

function AlertRow(props: { alert: InvigilatorAlert }) {
  const { alert } = props;
  const tone = alert.severity === "critical"
    ? "border-danger/40 bg-danger/10 text-danger"
    : alert.severity === "warning"
      ? "border-warning/40 bg-warning/10 text-warning"
      : "border-line bg-white/60 text-muted";
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-white/60 px-3 py-2 text-sm">
      <AlertTriangle size={16} className={alert.severity === "critical" ? "text-danger" : "text-warning"} />
      <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${tone}`}>{alert.severity}</span>
      <span className="font-medium text-ink">{alert.title}</span>
      <span className="text-muted">{alert.hackerrank_username}</span>
      <span className="ml-auto text-xs text-muted">{new Date(alert.timestamp).toLocaleTimeString()}</span>
    </div>
  );
}
```

- [ ] **Step 2: Wire the route + admin checkbox** in `frontend/src/App.tsx`:

**(a)** After the line `import { RecordingReview } from "./RecordingReview";` add:

```tsx
import { InvigilatorApp } from "./InvigilatorApp";
```

**(b)** Replace the `App` function body:

```tsx
export function App() {
  const isAdmin = window.location.pathname.startsWith("/admin");
  return isAdmin ? <AdminApp /> : <StudentApp />;
}
```

with:

```tsx
export function App() {
  // S3: the invigilator portal lives on its own path, like /admin.
  if (window.location.pathname.startsWith("/invigilator")) return <InvigilatorApp />;
  const isAdmin = window.location.pathname.startsWith("/admin");
  return isAdmin ? <AdminApp /> : <StudentApp />;
}
```

**(c)** Admin settings — three edits in `AdminApp`:
- In `loadSettings`, the `setSettings({ ... })` call currently maps `start_at`, `end_at`, `contest_url`. Add to that object literal:
  ```tsx
        room_gate_enabled: Boolean(response.room_gate_enabled),
  ```
- In `saveSettings`, the `saveProctorSettings(password, { ... })` body currently sends `start_at`, `end_at`, `contest_url`. Add:
  ```tsx
        room_gate_enabled: settings.room_gate_enabled === true,
  ```
  and in the `setSettings({ ... })` that follows the response, add:
  ```tsx
        room_gate_enabled: Boolean(response.room_gate_enabled),
  ```
- In the settings form JSX, immediately AFTER the line
  `<Field label="Contest URL" type="url" value={settings.contest_url ?? ""} onChange={(value) => setSettings({ ...settings, contest_url: value })} />`
  add:
  ```tsx
          <label className="flex items-start gap-3 rounded-md border border-line bg-white/60 p-4 text-sm leading-6 text-muted md:col-span-3">
            <input
              className="mt-1 h-4 w-4 accent-accent"
              type="checkbox"
              checked={settings.room_gate_enabled === true}
              onChange={(event) => setSettings({ ...settings, room_gate_enabled: event.target.checked })}
            />
            <span>
              <span className="font-medium text-ink">Room start codes (invigilator gate)</span> — after recording starts, candidates wait until their room's invigilator releases a 6-digit code (or presses "Start now") from <code>/invigilator</code>. Unchecking this releases everyone.
            </span>
          </label>
  ```

- [ ] **Step 3: Typecheck + run all frontend tests:**

Run: `cd /home/karthi/arogara/proctor/frontend && npm run lint` → no errors.
Run: `cd /home/karthi/arogara/proctor/frontend && npm run test` → all vitest suites pass.

- [ ] **Step 4: Commit**

```bash
cd /home/karthi/arogara/proctor
git add frontend/src/InvigilatorApp.tsx frontend/src/App.tsx
git commit -m "feat(invigilator): /invigilator portal UI + admin room-gate settings checkbox"
```

---

## Task 7: Frontend — student waiting room (RoomCodePanel)

**Files:** Modify `frontend/src/App.tsx`.

- [ ] **Step 1: Implement** — six edits, all in `StudentApp` / module scope of `App.tsx`:

**(a)** Add `KeyRound` to the lucide-react import list (line 1), keeping alphabetical order (between `Film` and `ListChecks`).

**(b)** Add `pollRoomGate` to the existing value import from `./api` (the big `import { adminPassword, ... } from "./api";` list, alphabetical position after `heartbeat`/before `resumeSession` — exact position is cosmetic). Then add two type/value imports after the api import lines:

```tsx
import type { ApiError } from "./api";
import { isCompleteOtp, normalizeOtpInput } from "./invigilator/gateLogic";
```

**(c)** In `StudentApp`, after the line `const [pipMessage, setPipMessage] = useState("");` add:

```tsx
  // S3 room gate: whether THIS session has been released into the exam (room
  // OTP / invigilator start-now / gate disabled). Starts false when the gate is
  // enabled; the poll effect corrects it (also after reload/resume).
  const [examStarted, setExamStarted] = useState(false);
  const [gateCode, setGateCode] = useState("");
  const [gateError, setGateError] = useState("");
  const [gateBusy, setGateBusy] = useState(false);
```

**(d)** In `applyServerStatus`, after the line `setContestUrl(session.contest_url || "");` add:

```tsx
    // S3: gate disabled (or absent on an older backend) → released immediately.
    setExamStarted(!session.room_gate_enabled);
```

**(e)** Immediately AFTER the closing `};` of `applyServerStatus` add the poll effect + submit handler:

```tsx
  // S3 room gate: while recording with the gate enabled and not yet released,
  // poll every 5 s so an invigilator "Start now" admits the candidate with zero
  // typing. The first tick runs immediately (covers resume-after-reload where
  // the server may already have released this session).
  useEffect(() => {
    if (status !== "recording" || !sessionConfig?.room_gate_enabled || examStarted) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const response = await pollRoomGate(sessionConfig.session_id);
        if (!cancelled && response.exam_started) setExamStarted(true);
      } catch {
        // transient poll errors are silent; the explicit submit surfaces errors
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [status, sessionConfig, examStarted]);

  const submitGateCode = async () => {
    if (!sessionConfig) return;
    setGateBusy(true);
    setGateError("");
    try {
      const response = await pollRoomGate(sessionConfig.session_id, gateCode.trim());
      if (response.exam_started) {
        setExamStarted(true);
        setGateCode("");
      }
    } catch (cause) {
      const apiError = cause as ApiError;
      if (apiError.code === "invalid_code") {
        setGateError("That code is not correct for your room. Check the board or ask your invigilator.");
      } else if (apiError.code === "too_many_attempts") {
        setGateError("Too many wrong attempts. Wait — your invigilator can admit the whole room.");
      } else {
        setGateError(apiError.message || String(cause));
      }
    } finally {
      setGateBusy(false);
    }
  };
```

**(f)** In the main return path of `StudentApp`, right after the line `const isFormStage = gate === "form" && status !== "recording" && status !== "ending";` add:

```tsx
  // S3 room gate: enabled for this contest AND this session not yet released.
  const examGateActive = Boolean(sessionConfig?.room_gate_enabled) && !examStarted;
```

Then make three render changes:
1. The contest-link condition `{status === "recording" && mediaCapture.screen === "recording" && contestUrl && !error ? (` becomes:
   ```tsx
            {status === "recording" && mediaCapture.screen === "recording" && contestUrl && !error && !examGateActive ? (
   ```
2. Immediately BEFORE the Slice-1 CodingWorkspace block (the comment `{/* Slice 1: own coding workspace ...`) insert:
   ```tsx
      {/* S3 room gate: recording runs while the candidate waits; the workspace
          and the contest link stay hidden until the room code (or an
          invigilator start-now) releases this session. */}
      {status === "recording" && examGateActive ? (
        <div className="mt-5">
          <RoomCodePanel
            room={identity?.room || ""}
            code={gateCode}
            error={gateError}
            busy={gateBusy}
            onCodeChange={(value) => setGateCode(normalizeOtpInput(value))}
            onSubmit={() => void submitGateCode()}
          />
        </div>
      ) : null}
   ```
3. The CodingWorkspace condition `{sessionId && status === "recording" && (` becomes:
   ```tsx
      {sessionId && status === "recording" && !examGateActive && (
   ```

**(g)** Add the panel component — insert immediately BEFORE the line `function AdminApp() {`:

```tsx
// S3: the waiting room between "recording started" and "exam released". Shows a
// big 6-digit entry (the invigilator writes the room code on the board) and
// auto-advances when the invigilator opens the whole room.
function RoomCodePanel(props: {
  room: string;
  code: string;
  error: string;
  busy: boolean;
  onCodeChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const { room, code, error, busy, onCodeChange, onSubmit } = props;
  return (
    <section className="rounded-lg border border-accent/40 bg-accent/5 p-6 text-center shadow-subtle">
      <KeyRound size={26} className="mx-auto text-accent" />
      <h2 className="mt-3 text-xl font-semibold text-ink">Waiting for your room code</h2>
      <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-muted">
        Recording has started. Your invigilator will announce a 6-digit start code for room {room ? <strong>{room}</strong> : "(not set)"} just before the test begins. Enter it below — or simply wait: if your invigilator starts the whole room, this screen advances automatically.
      </p>
      <div className="mx-auto mt-4 flex max-w-xs items-center gap-3">
        <input
          className="focus-ring h-12 w-full rounded-md border border-line bg-white px-4 text-center text-2xl font-semibold tracking-[0.4em] text-ink"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="000000"
          value={code}
          onChange={(event) => onCodeChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && isCompleteOtp(code) && !busy) onSubmit();
          }}
        />
        <button
          className="focus-ring inline-flex h-12 items-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!isCompleteOtp(code) || busy}
          onClick={onSubmit}
        >
          {busy ? "Checking…" : "Start"}
        </button>
      </div>
      {error ? <p className="mt-3 text-sm font-medium text-danger">{error}</p> : null}
      <p className="mt-3 text-xs text-muted">Stay in this tab. Your screen is being recorded while you wait.</p>
    </section>
  );
}
```

- [ ] **Step 2: Typecheck + tests:**

Run: `cd /home/karthi/arogara/proctor/frontend && npm run lint` → no errors.
Run: `cd /home/karthi/arogara/proctor/frontend && npm run test` → all pass.

- [ ] **Step 3: Commit**

```bash
cd /home/karthi/arogara/proctor
git add frontend/src/App.tsx
git commit -m "feat(invigilator): student waiting room — room-code entry + auto-advance poll, exec surface hidden until release"
```

---

## Task 8: Verification — full suites + browser integration (demo mode)

- [ ] **Step 1: Full test suites:**

```bash
cd /home/karthi/arogara/proctor/backend && npm test
cd /home/karthi/arogara/proctor/frontend && npm run test && npm run lint
```
Expected: everything green.

- [ ] **Step 2: Browser integration (Chrome on :9222 via the chrome-devtools MCP).** Start the demo app:

```bash
cd /home/karthi/arogara/proctor/frontend && VITE_DEMO_MODE=true VITE_ADMIN_PASSWORD=dev VITE_INVIGILATOR_PASSWORD=invig npm run dev
```

Checklist (take a screenshot at each ✓):
1. `http://localhost:5173/admin` → unlock with `dev` → Settings → set a valid window (now-1h → now+6h), tick **Room start codes (invigilator gate)** → Save → reload settings shows the box still ticked.
2. `http://localhost:5173/invigilator` → unlock with `invig` + name "Priya" → room picker lists `Lab A-1`, `Lab B-2` (demo rooms) → pick `Lab A-1`.
3. Dashboard: stat tiles populated from demo sessions (Recording > 0, Total > 0); students table lists Lab A-1 names; room alerts show only Lab A-1, non-archived demo alerts.
4. **Release room code** → a 6-digit code renders huge; reload the page, re-unlock, same room → the SAME code re-displays (idempotency). **Regenerate** (confirm) → new code.
5. **Start now — allow all** (confirm) → badge flips to "Room OPEN — everyone admitted".
6. Student flow: `http://localhost:5173/` → fill the form with room `Lab B-2` (a room NOT yet open) → Start proctoring (accept the screen-share prompt — if MCP automation cannot accept the OS share dialog, do this one check by hand or launch Chromium with `--auto-select-desktop-capture-source="Entire screen"`) → the **Waiting for your room code** panel shows, the coding workspace does NOT.
7. Type a wrong 6-digit code → inline error. In the invigilator tab switch to room `Lab B-2`, release the code, read it, type it in the student tab → workspace appears.
8. Repeat with a fresh student session in another room and use **Start now** in the portal instead → the student screen auto-advances within ~5 s without typing.
9. Admin tab: untick the room-gate checkbox, Save → a fresh waiting student auto-advances on the next poll (admin master bypass).

- [ ] **Step 3: Record evidence + commit any fixes** (each fix gets its own commit). Add results to `night-run/MORNING-NOTES.md` §1 (what is done + tested) and §2 (judgment calls — at minimum: plaintext OTP, admin password accepted on invigilator endpoints, re-arm-after-open semantics, roll numbers visible to invigilators).

```bash
cd /home/karthi/arogara/proctor
git add night-run/MORNING-NOTES.md
git commit -m "docs(night-run): S3 invigilator portal verification notes"
```
