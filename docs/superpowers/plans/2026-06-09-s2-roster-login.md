# S2 — Roster login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** READY (paired with `docs/superpowers/specs/2026-06-09-s2-roster-login-design.md`).

**Goal:** Admin uploads a flexible-column student roster with a designated unique-ID column; when a roster is configured, student login requires a unique-ID-confirm roster match (server-enforced) with roster-sourced fields prefilled + locked; room becomes an admin-fed dropdown (+ "Other").

**Tech stack / conventions (follow EXACTLY):**
- Backend: Node 20 Cloud Function `backend/src/handler.mjs`; tests = `node:test` + inline fake Firestore/Storage + `__setClientsForTest` + env-vars-BEFORE-import + unique `?roster` cache-buster import. NO helpers.mjs.
- Frontend: React/Vite/TS; pure logic unit-tested with vitest; ALL network calls in `frontend/src/api.ts` with demo-mode branches (`VITE_DEMO_MODE=true` → localStorage).
- **Commits are LOCAL only, one per task. NEVER `git push`.**
- **Do NOT modify `frontend/src/coding/*`** (Slice 1 owns those files).
- If an `App.tsx` anchor string is not found verbatim (a parallel stretch item may have moved it), locate the same landmark (described per step) and apply the equivalent edit.

---

## File structure

**Backend:**
- Modify `backend/src/handler.mjs` — consts, 4 routes, handlers `adminSaveRoster`/`adminGetRoster`/`publicExamConfig`/`rosterLookup`, helpers `rosterMetaRef`/`getRosterMeta`/`normalizeUniqueId`/`rosterEntryId`/`normalizeRooms`/`findRosterEntry`/`maskEmail`, `startSession` roster gate, `adminSaveSettings`+`publicSettings` rooms.
- Create `backend/test/roster.test.mjs` — all S2 backend tests (built up across Tasks 1–3).

**Frontend:**
- Create `frontend/src/roster/parseRoster.ts` + `frontend/src/roster/parseRoster.test.ts` — pure CSV/TSV parsing + mapping heuristics.
- Modify `frontend/src/types.ts` — `ExamConfig`, `RosterColumnMapping`, `RosterUploadRequest/Response`, `RosterStatus`, `RosterLookupResult`; `StudentForm.roster_unique_id`; `ProctorSettings.rooms`.
- Modify `frontend/src/api.ts` — `fetchExamConfig`, `rosterLookup`, `fetchRosterStatus`, `uploadRoster`, `clearRoster` (+ demo branches); demo roster gate in `startSession`; rooms in settings demo.
- Modify `frontend/src/App.tsx` — admin rooms field + `CandidateRosterSection`; student `IdentityLookupPanel` + `RoomField` + roster gate wiring.

---

## Task 1: Backend — roster store (upload/get/clear) + rooms in settings

**Files:**
- Create: `backend/test/roster.test.mjs`
- Modify: `backend/src/handler.mjs`

- [ ] **Step 1.1: Write the failing tests**

Create `backend/test/roster.test.mjs` with EXACTLY this content (the fake req/res + Firestore/Storage blocks are copied from `backend/test/editorEvents.test.mjs` — same code, do not improvise):

```javascript
// backend/test/roster.test.mjs — S2: roster upload + roster-gated login + rooms.
import { test } from "node:test";
import assert from "node:assert/strict";

// Env BEFORE import; unique ?roster cache-buster for a fresh module instance.
process.env.EVIDENCE_BUCKET = "roster-bucket";
process.env.SESSION_COLLECTION = "roster_sessions";
process.env.SETTINGS_COLLECTION = "roster_settings";
process.env.ROSTER_COLLECTION = "roster_entries";
process.env.ADMIN_PASSWORD = "roster-admin-pass";

const handler = await import("../src/handler.mjs?roster");
const { api, __setClientsForTest } = handler;

// Inline req/res + fakes, copied from editorEvents.test.mjs (NO helpers.mjs).
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

// ---- S2 shared fixtures ----------------------------------------------------

const ADMIN = { "x-admin-password": "roster-admin-pass" };

function freshClients() {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  return { firestore, storage };
}

// Open proctor window so /api/session/start passes the time gate (Task 3).
function seedOpenWindow(firestore, extra = {}) {
  firestore.collection(process.env.SETTINGS_COLLECTION).doc("active").set({
    start_at: new Date(Date.now() - 3600_000).toISOString(),
    end_at: new Date(Date.now() + 3600_000).toISOString(),
    contest_url: "https://example.com/contests/night-run",
    contest_slug: "night-run",
    ...extra
  });
}

const SAMPLE_UPLOAD = {
  unique_id_column: "Roll No",
  columns: ["Roll No", "Student Name", "Email ID", "Phone"],
  // "phone" is NOT a mappable identity field -> must be dropped by the server.
  column_mapping: { name: "Student Name", email: "Email ID", roll_number: "Roll No", phone: "Phone" },
  rows: [
    { "Roll No": "21CS001", "Student Name": "Asha Raman", "Email ID": "asha@example.com", "Phone": "9999999999" },
    { "Roll No": "21CS002", "Student Name": "Vivek Nair", "Email ID": "vivek@example.com", "Phone": "8888888888" },
    { "Roll No": "21cs001", "Student Name": "Dup Row", "Email ID": "dup@example.com", "Phone": "7" },
    { "Roll No": "", "Student Name": "No Id", "Email ID": "noid@example.com", "Phone": "6" }
  ]
};

async function uploadSampleRoster(overrides = {}) {
  return call(makeReq({ method: "POST", path: "/api/admin/roster", headers: ADMIN,
    body: { ...SAMPLE_UPLOAD, ...overrides } }));
}

// ---- Task 1: admin roster store + rooms settings ---------------------------

test("POST /api/admin/roster requires the admin password", async () => {
  freshClients();
  const res = await call(makeReq({ method: "POST", path: "/api/admin/roster", body: SAMPLE_UPLOAD }));
  assert.equal(res.statusCode, 401);
});

test("POST /api/admin/roster stores entries + meta; skips dup/empty ids; drops unknown mapping fields", async () => {
  const { firestore } = freshClients();
  const res = await uploadSampleRoster();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.count, 2);
  assert.deepEqual(res.body.skipped, [
    { row: 2, reason: "duplicate_unique_id" },
    { row: 3, reason: "empty_unique_id" }
  ]);
  // Entries keyed by the normalized unique id.
  const entry = await firestore.collection(process.env.ROSTER_COLLECTION).doc("21cs001").get();
  assert.equal(entry.exists, true);
  assert.equal(entry.data().unique_id, "21CS001");
  assert.equal(entry.data().unique_id_norm, "21cs001");
  assert.equal(entry.data().fields["Student Name"], "Asha Raman");
  // Meta written LAST under the settings collection.
  const meta = await firestore.collection(process.env.SETTINGS_COLLECTION).doc("roster_meta").get();
  assert.equal(meta.data().configured, true);
  assert.equal(meta.data().count, 2);
  assert.equal(meta.data().unique_id_column, "Roll No");
  assert.equal(meta.data().version, entry.data().roster_version);
  // Unknown mapping keys (phone) dropped; known ones kept.
  assert.deepEqual(meta.data().column_mapping, { name: "Student Name", email: "Email ID", roll_number: "Roll No" });
});

test("POST /api/admin/roster 400s when unique_id_column is not one of columns", async () => {
  freshClients();
  const res = await uploadSampleRoster({ unique_id_column: "Nope" });
  assert.equal(res.statusCode, 400);
});

test("GET /api/admin/roster: configured:false before, meta summary after upload", async () => {
  freshClients();
  const before = await call(makeReq({ method: "GET", path: "/api/admin/roster", headers: ADMIN }));
  assert.equal(before.statusCode, 200);
  assert.equal(before.body.configured, false);
  await uploadSampleRoster();
  const after = await call(makeReq({ method: "GET", path: "/api/admin/roster", headers: ADMIN }));
  assert.equal(after.body.configured, true);
  assert.equal(after.body.count, 2);
  assert.equal(after.body.unique_id_column, "Roll No");
  assert.deepEqual(after.body.columns, ["Roll No", "Student Name", "Email ID", "Phone"]);
  assert.equal("rows" in after.body, false); // meta only, never the rows
});

test("POST /api/admin/roster {clear:true} disables the roster", async () => {
  freshClients();
  await uploadSampleRoster();
  const res = await call(makeReq({ method: "POST", path: "/api/admin/roster", headers: ADMIN, body: { clear: true } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.configured, false);
  const status = await call(makeReq({ method: "GET", path: "/api/admin/roster", headers: ADMIN }));
  assert.equal(status.body.configured, false);
});

test("settings rooms: sanitized + deduped on save and returned by GET", async () => {
  freshClients();
  const save = await call(makeReq({ method: "POST", path: "/api/admin/settings", headers: ADMIN, body: {
    start_at: "2026-06-10T09:00:00.000Z", end_at: "2026-06-10T12:00:00.000Z",
    rooms: ["Lab A-1", "Lab A-1", "  Lab B-2  ", "Bad<>Room!"]
  } }));
  assert.equal(save.statusCode, 200);
  assert.deepEqual(save.body.rooms, ["Lab A-1", "Lab B-2", "BadRoom"]);
  const get = await call(makeReq({ method: "GET", path: "/api/admin/settings", headers: ADMIN }));
  assert.deepEqual(get.body.rooms, ["Lab A-1", "Lab B-2", "BadRoom"]);
});
```

- [ ] **Step 1.2: Run to verify failure**

Run: `cd /home/karthi/arogara/proctor/backend && node --test test/roster.test.mjs`
Expected: FAIL — the roster tests get `404` where `200`/`401` is asserted (routes don't exist) and the rooms test fails on `undefined !== [...]` (rooms not persisted). The file itself must load cleanly (no syntax/import errors).

- [ ] **Step 1.3: Implement in `backend/src/handler.mjs`**

**(a) Consts** — find the line:
```javascript
const EDITOR_EVENTS_INGEST_LIMIT = Number(process.env.EDITOR_EVENTS_INGEST_LIMIT || "5000");
```
and insert immediately AFTER it:
```javascript
// S2 roster (compulsory roster login). One ACTIVE roster, global (like the
// "active" settings doc). Meta lives in SETTINGS_COLLECTION under a distinct
// doc id (mirrors ALERT_SETTINGS_ID); entries live in ROSTER_COLLECTION, one
// doc per student keyed by the sanitized normalized unique-ID for O(1) login
// lookups. Re-upload is a VERSIONED REPLACE: entries carry roster_version and
// lookups ignore any entry whose version is not the meta's current one, so no
// mass delete is ever needed and a half-failed upload never becomes active.
const ROSTER_COLLECTION = process.env.ROSTER_COLLECTION || "proctor_roster";
const ROSTER_META_ID = "roster_meta";
const ROSTER_LIMIT = 5000;          // max rows per upload (mirrors REVIEW_ROSTER_LIMIT)
const ROSTER_COLUMNS_LIMIT = 30;    // max columns kept per row
const ROSTER_CELL_MAX = 200;        // max stored cell length
const CONFIGURED_ROOMS_LIMIT = 50;  // max admin-configured room labels
// The identity fields an admin may map roster columns onto. Mapped fields are
// SERVER-OVERRIDDEN at session start: the roster is the identity source of truth.
const ROSTER_MAPPABLE_FIELDS = ["name", "email", "roll_number", "hackerrank_username", "room"];
```

**(b) Routes** — find:
```javascript
    if (req.method === "POST" && path === "/api/editor-events") return send(res, 200, await ingestEditorEvents(req));
```
and insert immediately AFTER it:
```javascript
    if (req.method === "GET" && path === "/api/exam-config") return send(res, 200, await publicExamConfig());
    if (req.method === "POST" && path === "/api/roster/lookup") return send(res, 200, await rosterLookup(req));
    if (req.method === "GET" && path === "/api/admin/roster") return send(res, 200, await adminGetRoster(req));
    if (req.method === "POST" && path === "/api/admin/roster") return send(res, 200, await adminSaveRoster(req));
```
(`publicExamConfig` and `rosterLookup` are implemented in Task 2 — add stub-free routes now and the two functions in (e) below as Task 2 code; if you prefer strictly green commits, add these two route lines in Task 2 instead. The tests in this task only exercise the admin routes.)

**(c) Helpers + handlers** — insert this whole block immediately AFTER the closing `}` of `adminSaveSettings` (before the `mapWithConcurrency` comment):
```javascript
// ---- S2 roster store (spec: docs/superpowers/specs/2026-06-09-s2-roster-login-design.md)

function rosterMetaRef() {
  return firestore.collection(SETTINGS_COLLECTION).doc(ROSTER_META_ID);
}

// The ACTIVE roster meta, or null when no roster is configured (never uploaded,
// or cleared). Callers treat null as "roster gate off".
async function getRosterMeta() {
  const doc = await rosterMetaRef().get();
  const meta = doc.exists ? doc.data() : null;
  return meta && meta.configured ? meta : null;
}

// Unique-ID normalization: trim + lowercase + strip ALL whitespace, because
// colleges format roll numbers inconsistently ("21 CS 001" ≡ "21CS001").
function normalizeUniqueId(value) {
  return String(value).trim().toLowerCase().replace(/\s+/g, "");
}

// Firestore-doc-id-safe form of a normalized unique id (no "/", never empty or
// all-dots). Distinct ids that sanitize to the same doc id are detected at
// upload time (the upload sees every row) and reported as duplicate skips.
function rosterEntryId(uniqueIdNorm) {
  const cleaned = String(uniqueIdNorm).replace(/[^a-z0-9@._-]/g, "_").slice(0, 200);
  if (cleaned === "" || /^\.+$/.test(cleaned)) return "_";
  return cleaned;
}

// Admin-configured room labels: sanitizeRoom each, drop empties, dedupe
// case-insensitively preserving first-seen casing, cap the list.
function normalizeRooms(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const room = sanitizeRoom(item);
    if (!room || seen.has(room.toLowerCase())) continue;
    seen.add(room.toLowerCase());
    out.push(room);
    if (out.length >= CONFIGURED_ROOMS_LIMIT) break;
  }
  return out;
}

// POST /api/admin/roster — replace the active roster ({clear:true} disables it).
// The client parses the CSV; this endpoint receives structured rows. Entries are
// written first (bounded concurrency), the meta doc LAST, so a crashed upload
// never activates a half-written version.
async function adminSaveRoster(req) {
  requireAdmin(req);
  const body = parseBody(req);
  if (body.clear === true) {
    await rosterMetaRef().set({ configured: false, cleared_at: new Date().toISOString() });
    return { ok: true, configured: false, count: 0, skipped: [] };
  }
  requireFields(body, ["unique_id_column", "columns", "rows"]);
  const columns = Array.isArray(body.columns)
    ? body.columns.map((c) => String(c).trim().slice(0, ROSTER_CELL_MAX)).filter(Boolean)
    : [];
  if (!columns.length) return badRequest("columns must be a non-empty array");
  if (columns.length > ROSTER_COLUMNS_LIMIT) return badRequest(`max ${ROSTER_COLUMNS_LIMIT} columns`);
  const uniqueIdColumn = String(body.unique_id_column).trim();
  if (!columns.includes(uniqueIdColumn)) return badRequest("unique_id_column must be one of columns");
  const rows = Array.isArray(body.rows) ? body.rows : null;
  if (!rows || !rows.length) return badRequest("rows must be a non-empty array");
  if (rows.length > ROSTER_LIMIT) return badRequest(`max ${ROSTER_LIMIT} roster rows`);

  // Only known identity fields may be mapped, and only onto known columns.
  const mapping = {};
  for (const [field, column] of Object.entries(body.column_mapping || {})) {
    if (!ROSTER_MAPPABLE_FIELDS.includes(field)) continue;
    const col = String(column || "").trim();
    if (col && columns.includes(col)) mapping[field] = col;
  }

  const version = randomUUID();
  const now = new Date().toISOString();
  const seen = new Set();
  const entries = [];
  const skipped = [];
  rows.forEach((row, index) => {
    const fields = {};
    for (const column of columns) {
      fields[column] = String(row?.[column] ?? "").trim().slice(0, ROSTER_CELL_MAX);
    }
    const uniqueId = fields[uniqueIdColumn];
    if (!uniqueId) {
      skipped.push({ row: index, reason: "empty_unique_id" });
      return;
    }
    const entryId = rosterEntryId(normalizeUniqueId(uniqueId));
    if (seen.has(entryId)) {
      skipped.push({ row: index, reason: "duplicate_unique_id" });
      return;
    }
    seen.add(entryId);
    entries.push({
      entryId,
      item: {
        unique_id: uniqueId,
        unique_id_norm: normalizeUniqueId(uniqueId),
        roster_version: version,
        fields,
        created_at: now
      }
    });
  });
  if (!entries.length) return badRequest("no valid roster rows (every row was skipped)");

  await mapWithConcurrency(entries, 20, async ({ entryId, item }) => {
    await firestore.collection(ROSTER_COLLECTION).doc(entryId).set(item);
  });
  await rosterMetaRef().set({
    configured: true,
    version,
    unique_id_column: uniqueIdColumn,
    column_mapping: mapping,
    columns,
    count: entries.length,
    updated_at: now
  });
  return { ok: true, configured: true, count: entries.length, skipped };
}

// GET /api/admin/roster — meta summary ONLY (never the rows).
async function adminGetRoster(req) {
  requireAdmin(req);
  const meta = await getRosterMeta();
  if (!meta) return { configured: false };
  return {
    configured: true,
    count: meta.count || 0,
    unique_id_column: meta.unique_id_column || "",
    column_mapping: meta.column_mapping || {},
    columns: meta.columns || [],
    updated_at: meta.updated_at || ""
  };
}
```

**(d) Rooms in `adminSaveSettings`** — in the `item` object, find:
```javascript
    end_code_hash: endCode ? hashPasscode(endCode) : (existing?.end_code_hash || ""),
    end_code_preview: endCode ? maskPasscode(endCode) : (existing?.end_code_preview || ""),
    updated_at: now
```
and replace with:
```javascript
    end_code_hash: endCode ? hashPasscode(endCode) : (existing?.end_code_hash || ""),
    end_code_preview: endCode ? maskPasscode(endCode) : (existing?.end_code_preview || ""),
    // S2: room labels for the student room dropdown. An older admin UI that
    // doesn't send rooms preserves the stored list.
    rooms: normalizeRooms(Array.isArray(body.rooms) ? body.rooms : existing?.rooms),
    updated_at: now
```

**(e) Rooms in `publicSettings`** — find:
```javascript
    contest_slug: settings?.contest_slug || contestSlugFromUrl(settings?.contest_url),
```
and insert immediately AFTER it:
```javascript
    // S2: admin-configured room labels (student dropdown; later the invigilator
    // portal). Sanitized + deduped on read as well as on save.
    rooms: normalizeRooms(settings?.rooms),
```

- [ ] **Step 1.4: Run to verify pass**

Run: `cd /home/karthi/arogara/proctor/backend && node --test test/roster.test.mjs`
Expected: 6 tests pass, 0 fail.

Run the full backend suite (no regressions): `cd /home/karthi/arogara/proctor/backend && node --test test/*.test.mjs`
Expected: all tests pass (the pre-existing suites — phase2, alerts, exec, editorEvents, judge0Adapter, sanitize — stay green).

- [ ] **Step 1.5: Commit**

```bash
cd /home/karthi/arogara/proctor && git add backend/src/handler.mjs backend/test/roster.test.mjs && git commit -m "S2: backend roster store (upload/get/clear) + rooms in settings

Versioned-replace roster: entries keyed by normalized unique-ID in
proctor_roster, meta in proctor_settings/roster_meta written last.
Rooms list persisted+sanitized on the settings doc.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: Backend — public exam-config + roster lookup

**Files:**
- Modify: `backend/test/roster.test.mjs` (append)
- Modify: `backend/src/handler.mjs`

- [ ] **Step 2.1: Append the failing tests**

Append to the END of `backend/test/roster.test.mjs`:

```javascript
// ---- Task 2: public exam-config + lookup -----------------------------------

test("GET /api/exam-config: roster off + no rooms -> all-empty config", async () => {
  freshClients();
  const res = await call(makeReq({ method: "GET", path: "/api/exam-config" }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { roster_required: false, unique_id_label: "", rooms: [] });
});

test("GET /api/exam-config reflects the roster label + configured rooms", async () => {
  const { firestore } = freshClients();
  seedOpenWindow(firestore, { rooms: ["Lab A-1", "Lab B-2"] });
  await uploadSampleRoster();
  const res = await call(makeReq({ method: "GET", path: "/api/exam-config" }));
  assert.deepEqual(res.body, { roster_required: true, unique_id_label: "Roll No", rooms: ["Lab A-1", "Lab B-2"] });
});

test("POST /api/roster/lookup returns ONLY confirmation-safe fields (masked email, no extra columns)", async () => {
  freshClients();
  await uploadSampleRoster();
  const res = await call(makeReq({ method: "POST", path: "/api/roster/lookup", body: { unique_id: "21CS001" } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    found: true,
    unique_id: "21CS001",
    name: "Asha Raman",
    roll_number: "21CS001",
    room: "",
    hackerrank_username: "",
    email_masked: "as**@example.com"
  });
  const raw = JSON.stringify(res.body);
  assert.equal(raw.includes("asha@example.com"), false); // raw email never leaves
  assert.equal(raw.includes("9999999999"), false);       // unmapped Phone never leaves
});

test("POST /api/roster/lookup normalizes case + whitespace", async () => {
  freshClients();
  await uploadSampleRoster();
  const res = await call(makeReq({ method: "POST", path: "/api/roster/lookup", body: { unique_id: "  21 cs 001 " } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.unique_id, "21CS001");
});

test("POST /api/roster/lookup: unknown id -> 404; no roster -> 404", async () => {
  freshClients();
  const noRoster = await call(makeReq({ method: "POST", path: "/api/roster/lookup", body: { unique_id: "x" } }));
  assert.equal(noRoster.statusCode, 404);
  assert.equal(noRoster.body.error, "roster_not_configured");
  await uploadSampleRoster();
  const unknown = await call(makeReq({ method: "POST", path: "/api/roster/lookup", body: { unique_id: "99XX999" } }));
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.body.error, "not_on_roster");
});

test("POST /api/roster/lookup ignores entries from a previous roster version", async () => {
  freshClients();
  await uploadSampleRoster();
  // A second upload REPLACES the first: old-version entries become invisible.
  await uploadSampleRoster({
    rows: [{ "Roll No": "99ZZ999", "Student Name": "Only One", "Email ID": "o@example.com", "Phone": "" }]
  });
  const stale = await call(makeReq({ method: "POST", path: "/api/roster/lookup", body: { unique_id: "21CS001" } }));
  assert.equal(stale.statusCode, 404);
  const fresh = await call(makeReq({ method: "POST", path: "/api/roster/lookup", body: { unique_id: "99zz999" } }));
  assert.equal(fresh.statusCode, 200);
  assert.equal(fresh.body.name, "Only One");
});
```

- [ ] **Step 2.2: Run to verify failure**

Run: `cd /home/karthi/arogara/proctor/backend && node --test test/roster.test.mjs`
Expected: the 6 Task-1 tests still pass; the 6 new tests FAIL (404s / `publicExamConfig is not defined` if the routes were added in Task 1, or 404 route-not-found otherwise).

- [ ] **Step 2.3: Implement**

If the two public route lines were NOT added in Task 1(b), add them now (same anchor). Then insert this block immediately AFTER the closing `}` of `adminGetRoster`:

```javascript
// GET /api/exam-config — PUBLIC (the student form renders before any session
// exists). Returns only non-sensitive config: whether the roster gate is on,
// what to call the unique-ID field, and the room labels. Fail-open client-side
// is safe because /api/session/start re-enforces the roster gate regardless.
async function publicExamConfig() {
  const [settings, meta] = await Promise.all([getSettings(), getRosterMeta()]);
  return {
    roster_required: Boolean(meta),
    unique_id_label: meta?.unique_id_column || "",
    rooms: normalizeRooms(settings?.rooms)
  };
}

// The ACTIVE-version roster entry for a unique id, or null. Entries from a
// previous upload (stale roster_version) are invisible.
async function findRosterEntry(meta, uniqueId) {
  const norm = normalizeUniqueId(uniqueId);
  if (!norm) return null;
  const doc = await firestore.collection(ROSTER_COLLECTION).doc(rosterEntryId(norm)).get();
  const entry = doc.exists ? doc.data() : null;
  if (!entry || entry.roster_version !== meta.version) return null;
  return entry;
}

// Mask an email for the public confirm card: keep at most 2 leading chars of
// the local part + the full domain ("asha@x.com" -> "as**@x.com").
function maskEmail(value) {
  const text = String(value || "");
  if (!text) return "";
  const at = text.indexOf("@");
  if (at <= 0) return `${text.slice(0, 2)}***`;
  const local = text.slice(0, at);
  const keep = Math.min(2, local.length);
  return `${local.slice(0, keep)}${"*".repeat(Math.max(1, local.length - keep))}${text.slice(at)}`;
}

// POST /api/roster/lookup — PUBLIC unique-ID-confirm login, step 1. Returns the
// MINIMUM confirmation set: mapped name/roll/room/username + MASKED email.
// Unmapped extra columns (phone numbers, ...) and the raw email NEVER leave via
// this route — the raw email reaches the session doc only through the
// server-side override at /api/session/start. Enumeration risk is an accepted,
// documented limitation (spec §7).
async function rosterLookup(req) {
  const body = parseBody(req);
  requireFields(body, ["unique_id"]);
  const meta = await getRosterMeta();
  if (!meta) throw httpError(404, "roster_not_configured");
  const entry = await findRosterEntry(meta, String(body.unique_id));
  if (!entry) throw httpError(404, "not_on_roster");
  const mapping = meta.column_mapping || {};
  const field = (name) => (mapping[name] ? String(entry.fields?.[mapping[name]] || "") : "");
  return {
    found: true,
    unique_id: entry.unique_id,
    name: field("name"),
    roll_number: field("roll_number"),
    room: field("room"),
    hackerrank_username: field("hackerrank_username"),
    email_masked: maskEmail(field("email"))
  };
}
```

- [ ] **Step 2.4: Run to verify pass**

Run: `cd /home/karthi/arogara/proctor/backend && node --test test/roster.test.mjs`
Expected: 12 tests pass, 0 fail.
Run: `cd /home/karthi/arogara/proctor/backend && node --test test/*.test.mjs` — all green.

- [ ] **Step 2.5: Commit**

```bash
cd /home/karthi/arogara/proctor && git add backend/src/handler.mjs backend/test/roster.test.mjs && git commit -m "S2: public exam-config + roster unique-ID lookup (masked, minimal fields)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: Backend — roster gate on /api/session/start

**Files:**
- Modify: `backend/test/roster.test.mjs` (append)
- Modify: `backend/src/handler.mjs` (`startSession`)

- [ ] **Step 3.1: Append the failing tests**

Append to the END of `backend/test/roster.test.mjs`:

```javascript
// ---- Task 3: roster gate on /api/session/start ------------------------------

function startBody(overrides = {}) {
  return {
    hackerrank_username: "typed_user", name: "Typed Name", roll_number: "TYPED-1",
    email: "typed@example.com", room: "Lab A-1", consent_accepted: true, ...overrides
  };
}

test("start: roster configured + missing roster_unique_id -> 403 roster_id_required", async () => {
  const { firestore } = freshClients();
  seedOpenWindow(firestore);
  await uploadSampleRoster();
  const res = await call(makeReq({ method: "POST", path: "/api/session/start", body: startBody() }));
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "roster_id_required");
});

test("start: unknown roster id -> 403 not_on_roster", async () => {
  const { firestore } = freshClients();
  seedOpenWindow(firestore);
  await uploadSampleRoster();
  const res = await call(makeReq({ method: "POST", path: "/api/session/start",
    body: startBody({ roster_unique_id: "99XX999" }) }));
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "not_on_roster");
});

test("start: valid roster id -> session created with roster-overridden identity", async () => {
  const { firestore } = freshClients();
  seedOpenWindow(firestore);
  await uploadSampleRoster();
  const res = await call(makeReq({ method: "POST", path: "/api/session/start",
    body: startBody({ roster_unique_id: "21cs001" }) }));
  assert.equal(res.statusCode, 200);
  const doc = await firestore.collection(process.env.SESSION_COLLECTION).doc(res.body.session_id).get();
  const session = doc.data();
  assert.equal(session.name, "Asha Raman");              // roster wins over "Typed Name"
  assert.equal(session.email, "asha@example.com");       // raw roster email, not the typed/masked one
  assert.equal(session.roll_number, "21CS001");
  assert.equal(session.roster_unique_id, "21CS001");
  assert.equal(session.roster_verified, true);
  assert.equal(session.hackerrank_username, "typed_user"); // not mapped -> typed value kept
});

test("start: roster-mapped hackerrank_username overrides the typed one", async () => {
  const { firestore } = freshClients();
  seedOpenWindow(firestore);
  await uploadSampleRoster({
    columns: ["Roll No", "Student Name", "HR Handle"],
    column_mapping: { name: "Student Name", hackerrank_username: "HR Handle", roll_number: "Roll No" },
    rows: [{ "Roll No": "21CS001", "Student Name": "Asha Raman", "HR Handle": "asha_hr" }]
  });
  const res = await call(makeReq({ method: "POST", path: "/api/session/start",
    body: startBody({ roster_unique_id: "21CS001" }) }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.hackerrank_username, "asha_hr");
  const doc = await firestore.collection(process.env.SESSION_COLLECTION).doc(res.body.session_id).get();
  assert.equal(doc.data().username_norm, "asha_hr");
});

test("start: NO roster configured -> legacy flow unchanged (regression)", async () => {
  const { firestore } = freshClients();
  seedOpenWindow(firestore);
  const res = await call(makeReq({ method: "POST", path: "/api/session/start", body: startBody() }));
  assert.equal(res.statusCode, 200);
  const doc = await firestore.collection(process.env.SESSION_COLLECTION).doc(res.body.session_id).get();
  assert.equal(doc.data().name, "Typed Name");
  assert.equal(doc.data().roster_verified, false);
  assert.equal(doc.data().roster_unique_id, "");
});
```

- [ ] **Step 3.2: Run to verify failure**

Run: `cd /home/karthi/arogara/proctor/backend && node --test test/roster.test.mjs`
Expected: Task 1+2 tests pass; the 5 new tests FAIL (start currently returns 200 ignoring the roster, and `roster_verified` is undefined).

- [ ] **Step 3.3: Implement — two edits inside `startSession`**

**Edit A** — find (top of `startSession`, right after the gate):
```javascript
  const settings = await validateProctorGate();

  const now = new Date().toISOString();
  const username = String(body.hackerrank_username).trim();
  const usernameNorm = normalizeUsername(username);
```
replace with:
```javascript
  const settings = await validateProctorGate();

  // S2 roster gate: when a roster is configured, starting REQUIRES a roster
  // match, and mapped identity fields are overridden server-side from the
  // matched entry — client-typed values are ignored for those fields, so a
  // candidate can never start under an identity that is not on the roster.
  // (Runs before the session_id replay check too: a replayed start must still
  // carry a valid roster id; the client keeps it in form state.)
  const rosterMeta = await getRosterMeta();
  let rosterIdentity = null;
  if (rosterMeta) {
    if (!body.roster_unique_id) throw httpError(403, "roster_id_required");
    const entry = await findRosterEntry(rosterMeta, String(body.roster_unique_id));
    if (!entry) throw httpError(403, "not_on_roster");
    const mapping = rosterMeta.column_mapping || {};
    const fromRoster = (field) => (mapping[field] ? String(entry.fields?.[mapping[field]] || "") : "");
    rosterIdentity = {
      unique_id: entry.unique_id,
      name: fromRoster("name"),
      email: fromRoster("email"),
      roll_number: fromRoster("roll_number"),
      hackerrank_username: fromRoster("hackerrank_username")
    };
  }

  const now = new Date().toISOString();
  const username = String(rosterIdentity?.hackerrank_username || body.hackerrank_username).trim();
  const usernameNorm = normalizeUsername(username);
```

**Edit B** — find (inside the `item` object literal):
```javascript
    name: String(body.name).trim(),
    roll_number: String(body.roll_number).trim(),
    email: String(body.email).trim(),
    room,
```
replace with:
```javascript
    name: String(rosterIdentity?.name || body.name).trim(),
    roll_number: String(rosterIdentity?.roll_number || body.roll_number).trim(),
    email: String(rosterIdentity?.email || body.email).trim(),
    roster_unique_id: rosterIdentity ? rosterIdentity.unique_id : "",
    roster_verified: Boolean(rosterIdentity),
    room,
```

- [ ] **Step 3.4: Run to verify pass**

Run: `cd /home/karthi/arogara/proctor/backend && node --test test/roster.test.mjs`
Expected: 17 tests pass, 0 fail.
Run: `cd /home/karthi/arogara/proctor/backend && node --test test/*.test.mjs`
Expected: ALL backend tests pass — especially the existing phase2/phase2b start-session tests (they seed no roster meta, so `getRosterMeta()` returns null and the legacy path is untouched).

- [ ] **Step 3.5: Commit**

```bash
cd /home/karthi/arogara/proctor && git add backend/src/handler.mjs backend/test/roster.test.mjs && git commit -m "S2: enforce roster match at /api/session/start (server-side identity override)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: Frontend — pure CSV/TSV parser + mapping heuristics

**Files:**
- Create: `frontend/src/roster/parseRoster.test.ts`
- Create: `frontend/src/roster/parseRoster.ts`

- [ ] **Step 4.1: Write the failing tests**

Create `frontend/src/roster/parseRoster.test.ts`:

```typescript
// frontend/src/roster/parseRoster.test.ts — pure logic, vitest (like coding/editorEvents.test.ts)
import { describe, it, expect } from "vitest";
import { detectDelimiter, parseRoster, splitDelimitedLine, suggestMapping } from "./parseRoster";

describe("detectDelimiter", () => {
  it("picks comma for CSV headers", () => expect(detectDelimiter("Roll No,Name,Email")).toBe(","));
  it("picks tab for Excel-paste TSV", () => expect(detectDelimiter("Roll No\tName\tEmail")).toBe("\t"));
  it("picks semicolon for EU-locale CSV", () => expect(detectDelimiter("Roll No;Name;Email")).toBe(";"));
});

describe("splitDelimitedLine", () => {
  it("keeps commas inside quoted cells and unescapes doubled quotes", () => {
    expect(splitDelimitedLine('"Raman, Asha",21CS001,"He said ""hi"""', ",")).toEqual([
      "Raman, Asha", "21CS001", 'He said "hi"'
    ]);
  });
});

describe("parseRoster", () => {
  it("parses a quoted CSV with BOM and blank lines into columns/rows", () => {
    const text = '\uFEFFRoll No,Student Name,Email\n21CS001,"Raman, Asha",asha@example.com\n\n21CS002,Vivek,vivek@example.com\n';
    const result = parseRoster(text);
    expect(result.columns).toEqual(["Roll No", "Student Name", "Email"]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]["Student Name"]).toBe("Raman, Asha");
    expect(result.errors).toEqual([]);
  });
  it("reports ragged rows but keeps the padded data", () => {
    const result = parseRoster("A,B\n1\n2,3");
    expect(result.errors).toHaveLength(1);
    expect(result.rows).toEqual([{ A: "1", B: "" }, { A: "2", B: "3" }]);
  });
  it("names blank headers and de-dupes duplicate headers", () => {
    const result = parseRoster("Name,,Name\nx,y,z");
    expect(result.columns[1]).toBe("Column 2");
    expect(result.columns[2]).not.toBe("Name");
  });
  it("returns an error for an empty file", () => {
    expect(parseRoster("  \n ").errors[0]).toMatch(/empty/i);
  });
});

describe("suggestMapping", () => {
  it("maps the common college headers and prefers roll number as the unique id", () => {
    const { mapping, uniqueIdColumn } = suggestMapping([
      "S.No", "Register Number", "Student Name", "Email ID", "HackerRank Username", "Room"
    ]);
    expect(mapping.roll_number).toBe("Register Number");
    expect(mapping.name).toBe("Student Name");
    expect(mapping.email).toBe("Email ID");
    expect(mapping.hackerrank_username).toBe("HackerRank Username");
    expect(mapping.room).toBe("Room");
    expect(uniqueIdColumn).toBe("Register Number");
  });
  it("falls back to email, then the first column, for the unique id", () => {
    expect(suggestMapping(["Email", "Name"]).uniqueIdColumn).toBe("Email");
    expect(suggestMapping(["Foo", "Bar"]).uniqueIdColumn).toBe("Foo");
  });
});
```

- [ ] **Step 4.2: Run to verify failure**

Run: `cd /home/karthi/arogara/proctor/frontend && npx vitest run src/roster/parseRoster.test.ts`
Expected: FAIL — `Cannot find module './parseRoster'` (or equivalent resolve error).

- [ ] **Step 4.3: Implement**

NOTE: this module imports `RosterColumnMapping` from `../types` — that type is added in Task 5. To keep THIS task self-contained and green, define the type locally here and have Task 5 keep it in sync (types.ts re-declares it for API use; both are structurally identical so assignment works).

Create `frontend/src/roster/parseRoster.ts`:

```typescript
// S2 roster upload — pure CSV/TSV parsing + column-mapping heuristics.
// No React, no IO: the admin page reads the file, this module turns the text
// into {columns, rows} and suggests which column is which identity field.
// (Structurally identical to RosterColumnMapping in ../types — kept local so
// this pure module has zero app imports.)
export type RosterFieldMapping = {
  name?: string;
  email?: string;
  roll_number?: string;
  hackerrank_username?: string;
  room?: string;
};

export type ParsedRoster = {
  columns: string[];
  rows: Array<Record<string, string>>;
  errors: string[];
};

// Pick the delimiter that splits the header into the most cells: rosters come
// as comma CSV, Excel-paste TSV, or semicolon CSV (EU locales). Ties keep the
// earlier candidate, so a single-column file defaults to comma.
export function detectDelimiter(headerLine: string): string {
  const candidates = [",", "\t", ";"];
  let best = ",";
  let bestCount = 0;
  for (const candidate of candidates) {
    const count = splitDelimitedLine(headerLine, candidate).length;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

// RFC-4180-ish single-line splitter: quoted cells, embedded delimiters inside
// quotes, "" escapes. Embedded NEWLINES inside quotes are not supported (rare
// in rosters; such a file surfaces as ragged-row errors, not silent data loss).
export function splitDelimitedLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === "") {
      inQuotes = true;
    } else if (ch === delimiter) {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells.map((value) => value.trim());
}

export function parseRoster(text: string): ParsedRoster {
  const errors: string[] = [];
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r\n|\r|\n/)
    .filter((line) => line.trim() !== "");
  if (!lines.length) return { columns: [], rows: [], errors: ["The file is empty."] };

  const delimiter = detectDelimiter(lines[0]);
  const rawColumns = splitDelimitedLine(lines[0], delimiter);
  // Fill blank headers and de-dupe duplicates so every column has a stable,
  // unique name (rows are keyed by header).
  const seen = new Set<string>();
  const columns = rawColumns.map((name, index) => {
    let column = name || `Column ${index + 1}`;
    while (seen.has(column.toLowerCase())) column = `${column} (${index + 1})`;
    seen.add(column.toLowerCase());
    return column;
  });

  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitDelimitedLine(lines[i], delimiter);
    if (cells.length !== columns.length) {
      // Keep what we can (pad/truncate) — one ragged row must not kill the upload.
      errors.push(`Row ${i + 1}: expected ${columns.length} cells, got ${cells.length}.`);
    }
    const row: Record<string, string> = {};
    columns.forEach((column, c) => {
      row[column] = cells[c] ?? "";
    });
    if (Object.values(row).some((value) => value !== "")) rows.push(row); // skip fully-empty rows
  }
  return { columns, rows, errors };
}

// Header-name heuristics → suggested mapping. The admin can override every
// suggestion in the UI; these just save clicks on the common college formats.
// ORDER MATTERS: hackerrank/email/roll/room claim their columns BEFORE the
// broad /name/ pattern, so "Username"/"Student Name" resolve correctly.
const FIELD_PATTERNS: Array<{ field: keyof RosterFieldMapping; pattern: RegExp }> = [
  { field: "hackerrank_username", pattern: /hacker|user.?name|handle/i },
  { field: "email", pattern: /mail/i },
  { field: "roll_number", pattern: /roll|regist|reg\.?\s*no|admission/i },
  { field: "room", pattern: /room|lab|hall|venue/i },
  { field: "name", pattern: /name/i }
];

export function suggestMapping(columns: string[]): { mapping: RosterFieldMapping; uniqueIdColumn: string } {
  const mapping: RosterFieldMapping = {};
  const taken = new Set<string>();
  for (const { field, pattern } of FIELD_PATTERNS) {
    if (mapping[field]) continue;
    const match = columns.find((column) => !taken.has(column) && pattern.test(column));
    if (match) {
      mapping[field] = match;
      taken.add(match);
    }
  }
  // Unique-ID preference: roll/register number, then email, then first column.
  const uniqueIdColumn = mapping.roll_number || mapping.email || columns[0] || "";
  return { mapping, uniqueIdColumn };
}
```

- [ ] **Step 4.4: Run to verify pass**

Run: `cd /home/karthi/arogara/proctor/frontend && npx vitest run src/roster/parseRoster.test.ts`
Expected: 10 tests pass.
Also run the whole frontend unit suite: `cd /home/karthi/arogara/proctor/frontend && npm test` — all green (includes coding/editorEvents tests).

- [ ] **Step 4.5: Commit**

```bash
cd /home/karthi/arogara/proctor && git add frontend/src/roster/parseRoster.ts frontend/src/roster/parseRoster.test.ts && git commit -m "S2: pure CSV/TSV roster parser + column-mapping heuristics (vitest)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: Frontend — types + api client (with demo-mode parity)

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/api.ts`
- Modify: `frontend/src/App.tsx` (ONLY the `initialForm` literal — keeps `tsc` green)

- [ ] **Step 5.1: types.ts**

**(a)** In `StudentForm`, find:
```typescript
export type StudentForm = {
  hackerrank_username: string;
  name: string;
  roll_number: string;
  email: string;
  room: string;
  consent_accepted: boolean;
};
```
replace with:
```typescript
export type StudentForm = {
  hackerrank_username: string;
  name: string;
  roll_number: string;
  email: string;
  room: string;
  consent_accepted: boolean;
  // S2: the roster unique-ID the candidate confirmed ("" when no roster / not
  // yet confirmed). Sent to /api/session/start, which re-verifies it.
  roster_unique_id: string;
};
```

**(b)** In `ProctorSettings`, find:
```typescript
export type ProctorSettings = {
  start_at: string;
  end_at: string;
  contest_url?: string;
```
replace with:
```typescript
export type ProctorSettings = {
  start_at: string;
  end_at: string;
  contest_url?: string;
  // S2: admin-configured room labels for the student room dropdown.
  rooms?: string[];
```

**(c)** Append at the END of `types.ts`:
```typescript
// ---- S2 roster login --------------------------------------------------------

// Public pre-session exam config (GET /api/exam-config, no auth): drives the
// student form mode (roster gate on/off, unique-ID field label, room list).
export type ExamConfig = {
  roster_required: boolean;
  unique_id_label: string;
  rooms: string[];
};

// Identity fields a roster column can be mapped onto (matches the backend's
// ROSTER_MAPPABLE_FIELDS and roster/parseRoster.ts RosterFieldMapping).
export type RosterColumnMapping = {
  name?: string;
  email?: string;
  roll_number?: string;
  hackerrank_username?: string;
  room?: string;
};

// POST /api/admin/roster — the client parses the CSV; the backend stores rows.
export type RosterUploadRequest = {
  unique_id_column: string;
  columns: string[];
  column_mapping: RosterColumnMapping;
  rows: Array<Record<string, string>>;
};

export type RosterUploadResponse = {
  ok: boolean;
  configured: boolean;
  count: number;
  skipped: Array<{ row: number; reason: string }>;
};

// GET /api/admin/roster — meta only (never the rows).
export type RosterStatus = {
  configured: boolean;
  count?: number;
  unique_id_column?: string;
  column_mapping?: RosterColumnMapping;
  columns?: string[];
  updated_at?: string;
};

// POST /api/roster/lookup — confirmation-safe fields ONLY (email masked,
// unmapped extra columns never returned).
export type RosterLookupResult = {
  found: boolean;
  unique_id: string;
  name: string;
  roll_number: string;
  room: string;
  hackerrank_username: string;
  email_masked: string;
};
```

- [ ] **Step 5.2: App.tsx `initialForm`** (one-line change so `tsc` stays green)

Find:
```typescript
const initialForm: StudentForm = {
  hackerrank_username: "",
  name: "",
  roll_number: "",
  email: "",
  room: "",
  consent_accepted: false
};
```
replace with:
```typescript
const initialForm: StudentForm = {
  hackerrank_username: "",
  name: "",
  roll_number: "",
  email: "",
  room: "",
  consent_accepted: false,
  roster_unique_id: ""
};
```

- [ ] **Step 5.3: api.ts**

**(a) Type imports** — extend the type-import at the top of `api.ts` to also include `ExamConfig, RosterLookupResult, RosterStatus, RosterUploadRequest, RosterUploadResponse` (alphabetical within the existing list).

**(b) Demo key** — find:
```typescript
const demoReviewVerdictsKey = "aerele-proctor-demo-review-verdicts";
```
insert AFTER it:
```typescript
const demoRosterKey = "aerele-proctor-demo-roster";
```

**(c) Demo roster gate in `startSession`** — in the DEMO branch, find:
```typescript
    const contestUrl = settings.contest_url || "";
    const contestSlug = contestSlugFromUrl(contestUrl);
    const usernameNorm = normalizeUsername(form.hackerrank_username);
```
replace with:
```typescript
    const contestUrl = settings.contest_url || "";
    const contestSlug = contestSlugFromUrl(contestUrl);

    // S2 roster gate (demo parity with the backend): roster configured -> start
    // requires a roster match, and roster-mapped fields win over typed ones.
    const demoRosterHit = form.roster_unique_id ? demoRosterEntryFor(form.roster_unique_id) : null;
    if (getDemoRoster()) {
      if (!form.roster_unique_id) throw demoApiError(403, "roster_id_required");
      if (!demoRosterHit) throw demoApiError(403, "not_on_roster");
    }
    const demoMapping = demoRosterHit?.roster.column_mapping ?? {};
    const rosterUsername = demoRosterHit && demoMapping.hackerrank_username
      ? (demoRosterHit.row[demoMapping.hackerrank_username] ?? "").trim() : "";
    const rosterName = demoRosterHit && demoMapping.name
      ? (demoRosterHit.row[demoMapping.name] ?? "").trim() : "";
    const effectiveUsername = rosterUsername || form.hackerrank_username.trim();
    const usernameNorm = normalizeUsername(effectiveUsername);
```

**(d)** Still in the demo branch of `startSession`, find (inside the `DemoSession` literal):
```typescript
      hackerrank_username: form.hackerrank_username.trim(),
      username_norm: usernameNorm,
      name: form.name.trim(),
```
replace with:
```typescript
      hackerrank_username: effectiveUsername,
      username_norm: usernameNorm,
      name: rosterName || form.name.trim(),
```

**(e) Real `startSession` body** — find (in the non-demo request body):
```typescript
      room: form.room,
      consent_accepted: form.consent_accepted,
```
replace with:
```typescript
      room: form.room,
      consent_accepted: form.consent_accepted,
      ...(form.roster_unique_id ? { roster_unique_id: form.roster_unique_id } : {}),
```

**(f) Rooms in demo settings save** — in `saveProctorSettings`'s demo branch, find:
```typescript
    const next = {
      start_at: settings.start_at,
      end_at: settings.end_at,
      contest_url: settings.contest_url || "",
```
replace with:
```typescript
    const next = {
      start_at: settings.start_at,
      end_at: settings.end_at,
      contest_url: settings.contest_url || "",
      rooms: settings.rooms ?? getDemoSettings()?.rooms ?? [],
```
(`fetchProctorSettings`'s demo branch spreads the stored settings, so `rooms` flows back automatically; the real branches already pass the settings object through.)

**(g) New S2 section** — insert the following block immediately BEFORE the line:
```typescript
// ---- Coding workspace: editor-event capture + code execution ---------------
```

```typescript
// ---- S2 roster (compulsory roster login) ------------------------------------
// Spec: docs/superpowers/specs/2026-06-09-s2-roster-login-design.md

function demoApiError(status: number, code: string): ApiError {
  const error = new Error(code) as ApiError;
  error.status = status;
  error.code = code;
  return error;
}

function getDemoRoster(): RosterUploadRequest | null {
  const raw = window.localStorage.getItem(demoRosterKey);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RosterUploadRequest;
  } catch {
    return null;
  }
}

// Mirrors the backend normalizeUniqueId: trim + lowercase + strip ALL whitespace.
function normalizeUniqueId(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

// Mirrors the backend maskEmail ("asha@x.com" -> "as**@x.com").
function maskEmail(value: string) {
  if (!value) return "";
  const at = value.indexOf("@");
  if (at <= 0) return `${value.slice(0, 2)}***`;
  const local = value.slice(0, at);
  const keep = Math.min(2, local.length);
  return `${local.slice(0, keep)}${"*".repeat(Math.max(1, local.length - keep))}${value.slice(at)}`;
}

function demoRosterEntryFor(uniqueId: string): { roster: RosterUploadRequest; row: Record<string, string> } | null {
  const roster = getDemoRoster();
  if (!roster) return null;
  const norm = normalizeUniqueId(uniqueId);
  const row = roster.rows.find((r) => normalizeUniqueId(r[roster.unique_id_column] ?? "") === norm);
  return row ? { roster, row } : null;
}

// GET /api/exam-config — public student-page config. FAIL-OPEN on any error:
// the roster gate is re-enforced server-side at /api/session/start, so a config
// fetch failure can never bypass it — it only degrades the form UI.
export async function fetchExamConfig(): Promise<ExamConfig> {
  if (demoMode) {
    await wait(80);
    const roster = getDemoRoster();
    return {
      roster_required: Boolean(roster),
      unique_id_label: roster?.unique_id_column ?? "",
      rooms: getDemoSettings()?.rooms ?? []
    };
  }
  try {
    return await request<ExamConfig>("/api/exam-config", { method: "GET" });
  } catch {
    return { roster_required: false, unique_id_label: "", rooms: [] };
  }
}

// POST /api/roster/lookup — unique-ID-confirm login, step 1. Throws ApiError
// (status 404, code not_on_roster/roster_not_configured) when unmatched.
export async function rosterLookup(uniqueId: string): Promise<RosterLookupResult> {
  if (demoMode) {
    await wait(200);
    const hit = demoRosterEntryFor(uniqueId);
    if (!hit) throw demoApiError(404, "not_on_roster");
    const { roster, row } = hit;
    const mapped = (field: keyof RosterColumnMapping) => {
      const column = roster.column_mapping[field];
      return column ? (row[column] ?? "").trim() : "";
    };
    return {
      found: true,
      unique_id: (row[roster.unique_id_column] ?? "").trim(),
      name: mapped("name"),
      roll_number: mapped("roll_number"),
      room: mapped("room"),
      hackerrank_username: mapped("hackerrank_username"),
      email_masked: maskEmail(mapped("email"))
    };
  }
  return request<RosterLookupResult>("/api/roster/lookup", {
    method: "POST",
    body: JSON.stringify({ unique_id: uniqueId })
  });
}

// GET /api/admin/roster — roster meta (never the rows). `null` on 404 so the
// Settings UI can show "not deployed yet" (same degrade as review-roster).
export async function fetchRosterStatus(password: string): Promise<RosterStatus | null> {
  if (demoMode) {
    await wait(100);
    assertDemoAdmin(password);
    const roster = getDemoRoster();
    return roster
      ? {
          configured: true,
          count: roster.rows.length,
          unique_id_column: roster.unique_id_column,
          column_mapping: roster.column_mapping,
          columns: roster.columns,
          updated_at: new Date().toISOString()
        }
      : { configured: false };
  }
  try {
    return await request<RosterStatus>("/api/admin/roster", {
      method: "GET",
      headers: { "x-admin-password": password }
    });
  } catch (cause) {
    if ((cause as ApiError)?.status === 404) return null;
    throw cause;
  }
}

// POST /api/admin/roster — upload (replace) the roster. `null` on 404.
export async function uploadRoster(password: string, payload: RosterUploadRequest): Promise<RosterUploadResponse | null> {
  if (demoMode) {
    await wait(200);
    assertDemoAdmin(password);
    // Mirror the backend skip rules so the demo reports realistic counts.
    const seen = new Set<string>();
    const rows: Array<Record<string, string>> = [];
    const skipped: Array<{ row: number; reason: string }> = [];
    payload.rows.forEach((row, index) => {
      const uniqueId = (row[payload.unique_id_column] ?? "").trim();
      if (!uniqueId) {
        skipped.push({ row: index, reason: "empty_unique_id" });
        return;
      }
      const norm = normalizeUniqueId(uniqueId);
      if (seen.has(norm)) {
        skipped.push({ row: index, reason: "duplicate_unique_id" });
        return;
      }
      seen.add(norm);
      rows.push(row);
    });
    window.localStorage.setItem(demoRosterKey, JSON.stringify({ ...payload, rows }));
    return { ok: true, configured: true, count: rows.length, skipped };
  }
  try {
    return await request<RosterUploadResponse>("/api/admin/roster", {
      method: "POST",
      headers: { "x-admin-password": password },
      body: JSON.stringify(payload)
    });
  } catch (cause) {
    if ((cause as ApiError)?.status === 404) return null;
    throw cause;
  }
}

// POST /api/admin/roster {clear:true} — roster off (login reverts to legacy).
export async function clearRoster(password: string): Promise<{ ok: boolean } | null> {
  if (demoMode) {
    await wait(100);
    assertDemoAdmin(password);
    window.localStorage.removeItem(demoRosterKey);
    return { ok: true };
  }
  try {
    return await request<{ ok: boolean }>("/api/admin/roster", {
      method: "POST",
      headers: { "x-admin-password": password },
      body: JSON.stringify({ clear: true })
    });
  } catch (cause) {
    if ((cause as ApiError)?.status === 404) return null;
    throw cause;
  }
}
```

NOTE: `api.ts` must also import `RosterColumnMapping` in its type-import list (used by `rosterLookup`'s `mapped` helper).

- [ ] **Step 5.4: Verify**

Run: `cd /home/karthi/arogara/proctor/frontend && npm run lint`
Expected: `tsc -b` exits 0 (no output). Then `npm test` — all vitest suites still green.

- [ ] **Step 5.5: Commit**

```bash
cd /home/karthi/arogara/proctor && git add frontend/src/types.ts frontend/src/api.ts frontend/src/App.tsx && git commit -m "S2: roster api client + types + demo-mode roster gate parity

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6: Admin Settings UI — rooms field + Candidate roster section

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 6.1: Imports**

In the `./api` import (line ~3), add: `clearRoster`, `fetchExamConfig`, `fetchRosterStatus`, `rosterLookup`, `uploadRoster` (alphabetical). Add below the import lines:
```typescript
import { parseRoster, suggestMapping, type ParsedRoster, type RosterFieldMapping } from "./roster/parseRoster";
import type { ApiError } from "./api";
```
In the `./types` type-import (line ~7), add: `ExamConfig`, `RosterLookupResult`, `RosterStatus`, `RosterUploadResponse` (alphabetical). (`fetchExamConfig`, `rosterLookup`, `ExamConfig`, `RosterLookupResult`, `ApiError` are used by Task 7 — importing now is fine; `tsc` does not fail on unused imports with this config, but if it does, defer those three to Task 7.)

- [ ] **Step 6.2: AdminApp rooms state + load/save**

**(a)** Find:
```typescript
  const [rosterText, setRosterText] = useState("");
```
insert BEFORE it:
```typescript
  // S2: room labels for the student room dropdown, edited as comma-separated text.
  const [roomsText, setRoomsText] = useState("");
```

**(b)** In `loadSettings`, find:
```typescript
      setSettingsMessage("Loaded current gate.");
```
replace with:
```typescript
      setRoomsText((response.rooms ?? []).join(", "));
      setSettingsMessage("Loaded current gate.");
```

**(c)** In `saveSettings`, find:
```typescript
      const response = await saveProctorSettings(password, {
        start_at: localInputToIso(settings.start_at),
        end_at: localInputToIso(settings.end_at),
        contest_url: settings.contest_url
      });
```
replace with:
```typescript
      const response = await saveProctorSettings(password, {
        start_at: localInputToIso(settings.start_at),
        end_at: localInputToIso(settings.end_at),
        contest_url: settings.contest_url,
        // parseRosterInput = the existing comma/newline split + trim + dedupe.
        rooms: parseRosterInput(roomsText)
      });
```
and a few lines below, find:
```typescript
      setSettingsMessage("Saved. The time window is now the only start gate (no passcode).");
```
replace with:
```typescript
      setRoomsText((response.rooms ?? []).join(", "));
      setSettingsMessage("Saved. The time window is now the only start gate (no passcode).");
```

**(d)** In the settings-view gate section, find:
```tsx
          <Field label="Contest URL" type="url" value={settings.contest_url ?? ""} onChange={(value) => setSettings({ ...settings, contest_url: value })} />
          <div className="mt-6 flex flex-wrap gap-3 md:col-span-3">
```
replace with:
```tsx
          <Field label="Contest URL" type="url" value={settings.contest_url ?? ""} onChange={(value) => setSettings({ ...settings, contest_url: value })} />
          <Field label="Rooms (comma-separated)" value={roomsText} onChange={setRoomsText} />
          <div className="mt-6 flex flex-wrap gap-3 md:col-span-3">
```

- [ ] **Step 6.3: Render the roster section**

Find (settings view, right after the gate `</section>`):
```tsx
      </section>

      <ReviewRosterSection
```
replace with:
```tsx
      </section>

      <CandidateRosterSection password={password} />

      <ReviewRosterSection
```

- [ ] **Step 6.4: Add the `CandidateRosterSection` component**

Insert this complete component immediately BEFORE the line `function ProctorAlertTypesSection(` :

```tsx
// SETTINGS tab — S2 candidate roster upload. The admin picks a CSV/TSV file, we
// parse it CLIENT-SIDE (roster/parseRoster.ts), preview the first rows, choose
// the unique-ID column (+ optional identity-field mappings, pre-suggested from
// the headers), and POST structured rows to /api/admin/roster. While a roster
// is configured, student login REQUIRES a roster match (enforced server-side).
function CandidateRosterSection({ password }: { password: string }) {
  const [status, setStatus] = useState<RosterStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [parsed, setParsed] = useState<ParsedRoster | null>(null);
  const [fileName, setFileName] = useState("");
  const [uniqueIdColumn, setUniqueIdColumn] = useState("");
  const [mapping, setMapping] = useState<RosterFieldMapping>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const refresh = async () => {
    setBusy(true);
    setError("");
    try {
      const next = await fetchRosterStatus(password);
      if (next === null) setUnavailable(true);
      else {
        setUnavailable(false);
        setStatus(next);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onFile = async (file: File | null) => {
    setMessage("");
    setError("");
    if (!file) return;
    const text = await file.text();
    const result = parseRoster(text);
    if (!result.columns.length || !result.rows.length) {
      setParsed(null);
      setError(result.errors[0] || "Could not read any rows from that file.");
      return;
    }
    const suggestion = suggestMapping(result.columns);
    setParsed(result);
    setFileName(file.name);
    setUniqueIdColumn(suggestion.uniqueIdColumn);
    setMapping(suggestion.mapping);
  };

  const upload = async () => {
    if (!parsed || !uniqueIdColumn) return;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const response = await uploadRoster(password, {
        unique_id_column: uniqueIdColumn,
        columns: parsed.columns,
        column_mapping: mapping,
        rows: parsed.rows
      });
      if (response === null) {
        setUnavailable(true);
        return;
      }
      setMessage(
        `Roster saved: ${response.count} students` +
        (response.skipped.length ? `; ${response.skipped.length} row(s) skipped (${summarizeSkipped(response.skipped)})` : "") +
        ". Student login now requires a roster match."
      );
      setParsed(null);
      setFileName("");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const response = await clearRoster(password);
      if (response === null) {
        setUnavailable(true);
        return;
      }
      setMessage("Roster cleared — student login no longer requires a roster match.");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const mappingSelect = (field: keyof RosterFieldMapping, label: string) => (
    <label className="block">
      <span className="text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
      <select
        className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-3 text-sm"
        value={mapping[field] ?? ""}
        onChange={(event) => setMapping({ ...mapping, [field]: event.target.value || undefined })}
      >
        <option value="">— not in this file —</option>
        {(parsed?.columns ?? []).map((column) => (
          <option key={column} value={column}>{column}</option>
        ))}
      </select>
    </label>
  );

  return (
    <section className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Users size={20} />
          <div>
            <h2 className="text-2xl font-semibold">Candidate roster</h2>
            <p className="mt-1 text-sm text-muted">
              Upload the student list (CSV/TSV, any columns) and pick the unique-ID column. While a roster is active, students must match it to log in.
            </p>
          </div>
        </div>
        <button className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md border border-line px-4 text-sm font-medium disabled:opacity-50" onClick={() => void refresh()} disabled={busy}>
          <RefreshCw size={16} className={busy ? "animate-spin" : undefined} /> Reload
        </button>
      </div>

      {unavailable ? (
        <div className="rounded-lg border border-line bg-white p-4 text-sm text-muted">
          The roster endpoints are not deployed on this backend yet.
        </div>
      ) : (
        <>
          <div className="rounded-md border border-line bg-white/60 p-3 text-sm">
            {status?.configured ? (
              <span>
                <span className="font-semibold text-accent">Roster active:</span> {status.count} students · ID column <span className="font-mono">{status.unique_id_column}</span>
                {status.updated_at ? <span className="text-muted"> · updated {new Date(status.updated_at).toLocaleString()}</span> : null}
              </span>
            ) : (
              <span className="text-muted">No roster uploaded — student login is open (legacy form).</span>
            )}
          </div>

          <div className="mt-4">
            <label className="focus-ring inline-flex cursor-pointer items-center gap-2 rounded-md border border-line px-4 py-2 text-sm font-medium">
              <UploadCloud size={16} /> Choose roster file (.csv / .tsv)
              <input
                type="file"
                accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values"
                className="hidden"
                onChange={(event) => void onFile(event.target.files?.[0] ?? null)}
              />
            </label>
            {fileName ? <span className="ml-3 text-sm text-muted">{fileName}</span> : null}
          </div>

          {parsed ? (
            <div className="mt-4 space-y-4">
              {parsed.errors.length ? (
                <div className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
                  {parsed.errors.slice(0, 5).map((line) => <div key={line}>{line}</div>)}
                  {parsed.errors.length > 5 ? <div>…and {parsed.errors.length - 5} more.</div> : null}
                </div>
              ) : null}

              <div className="overflow-x-auto rounded-md border border-line">
                <table className="w-full text-left text-sm">
                  <thead className="bg-white/60 text-xs uppercase tracking-wide text-muted">
                    <tr>{parsed.columns.map((column) => <th key={column} className="px-3 py-2">{column}</th>)}</tr>
                  </thead>
                  <tbody>
                    {parsed.rows.slice(0, 5).map((row, index) => (
                      <tr key={index} className="border-t border-line">
                        {parsed.columns.map((column) => <td key={column} className="px-3 py-2">{row[column]}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted">Showing first {Math.min(5, parsed.rows.length)} of {parsed.rows.length} rows.</p>

              <div className="grid gap-3 md:grid-cols-3">
                <label className="block">
                  <span className="text-xs font-medium uppercase tracking-wide text-accent">Unique-ID column (required)</span>
                  <select
                    className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-3 text-sm"
                    value={uniqueIdColumn}
                    onChange={(event) => setUniqueIdColumn(event.target.value)}
                  >
                    {parsed.columns.map((column) => <option key={column} value={column}>{column}</option>)}
                  </select>
                </label>
                {mappingSelect("name", "Name column")}
                {mappingSelect("email", "Email column")}
                {mappingSelect("roll_number", "Roll-number column")}
                {mappingSelect("hackerrank_username", "HackerRank-username column")}
                {mappingSelect("room", "Room column")}
              </div>

              <button
                className="focus-ring inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => void upload()}
                disabled={busy || !uniqueIdColumn}
              >
                <UploadCloud size={16} /> {busy ? "Uploading…" : `Upload roster (${parsed.rows.length} students)`}
              </button>
            </div>
          ) : null}

          {status?.configured ? (
            <div className="mt-4">
              <button className="focus-ring inline-flex items-center gap-2 rounded-md border border-danger/40 px-4 py-2 text-sm font-medium text-danger disabled:opacity-50" onClick={() => void clear()} disabled={busy}>
                <X size={16} /> Clear roster (open login)
              </button>
            </div>
          ) : null}

          {message ? <div className="mt-4 rounded-lg border border-accent/30 bg-accent/10 p-4 text-sm text-accent">{message}</div> : null}
          {error ? <div className="mt-4 rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger">{error}</div> : null}
        </>
      )}
    </section>
  );
}

function summarizeSkipped(skipped: Array<{ row: number; reason: string }>) {
  const counts = new Map<string, number>();
  for (const item of skipped) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  return [...counts.entries()].map(([reason, count]) => `${count}× ${reason}`).join(", ");
}
```

(All icons used — `Users`, `UploadCloud`, `RefreshCw`, `X` — are already in the lucide import on line 1.)

- [ ] **Step 6.5: Verify**

Run: `cd /home/karthi/arogara/proctor/frontend && npm run lint`
Expected: exits 0. (If `tsc` flags the not-yet-used Task-7 imports, move `fetchExamConfig`, `rosterLookup`, `ExamConfig`, `RosterLookupResult`, `ApiError` imports to Task 7.)

- [ ] **Step 6.6: Commit**

```bash
cd /home/karthi/arogara/proctor && git add frontend/src/App.tsx && git commit -m "S2: admin settings — rooms list field + candidate roster upload section

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 7: Student login flow — identity gate + room dropdown

**Files:**
- Modify: `frontend/src/App.tsx`

> If the S1-stretch fullscreen-onboarding item already restructured `StudentApp`'s form area tonight, apply these edits to wherever the details form now lives — the landmarks are the `Your details` heading, the five `Field`s, and the consent `<label>`.

- [ ] **Step 7.1: StudentApp state**

Find:
```typescript
  const [pipMessage, setPipMessage] = useState("");
```
insert AFTER it:
```typescript
  // S2 roster login state. examConfig is the public pre-session config; the
  // unique-ID -> confirm flow fills form.roster_unique_id, which the server
  // re-verifies at /api/session/start (this client gate is UX only).
  const [examConfig, setExamConfig] = useState<ExamConfig | null>(null);
  const [uniqueIdInput, setUniqueIdInput] = useState("");
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupError, setLookupError] = useState("");
  const [rosterMatch, setRosterMatch] = useState<RosterLookupResult | null>(null);
```

- [ ] **Step 7.2: Roster flags + `canStart`**

Find:
```typescript
  const canStart = useMemo(() => {
    return Boolean(
      form.hackerrank_username.trim() &&
      form.name.trim() &&
      form.roll_number.trim() &&
      form.email.trim() &&
      form.room.trim() &&
      form.consent_accepted
    );
  }, [form]);
```
replace with:
```typescript
  const rosterRequired = Boolean(examConfig?.roster_required);
  const rosterConfirmed = Boolean(form.roster_unique_id);
  // S2: while a roster is required and unconfirmed, the details form stays
  // hidden behind the identity-confirm step.
  const rosterGateActive = rosterRequired && !rosterConfirmed;

  const canStart = useMemo(() => {
    return Boolean(
      (!rosterRequired || form.roster_unique_id) &&
      form.hackerrank_username.trim() &&
      form.name.trim() &&
      form.roll_number.trim() &&
      form.email.trim() &&
      form.room.trim() &&
      form.consent_accepted
    );
  }, [form, rosterRequired]);
```

- [ ] **Step 7.3: exam-config fetch effect**

Find the END of the resume-on-load effect:
```typescript
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```
(it is the FIRST effect in `StudentApp`, the one whose body starts with `const stored = window.localStorage.getItem(sessionStorageKey);`) and insert AFTER that whole effect:
```typescript
  // S2: fetch the public exam config (roster gate + room list) once for the
  // pre-session form. Fail-open on error: the server still enforces the roster
  // at /api/session/start; a fetch failure only degrades the form UI.
  useEffect(() => {
    let cancelled = false;
    void fetchExamConfig().then((config) => {
      if (!cancelled) setExamConfig(config);
    });
    return () => {
      cancelled = true;
    };
  }, []);
```

- [ ] **Step 7.4: Lookup/confirm handlers**

Find:
```typescript
  const start = async () => {
```
insert BEFORE it:
```typescript
  // S2: look up the typed unique ID against the server-side roster.
  const lookupRosterId = async () => {
    setLookupBusy(true);
    setLookupError("");
    try {
      setRosterMatch(await rosterLookup(uniqueIdInput.trim()));
    } catch (cause) {
      setRosterMatch(null);
      const status = (cause as ApiError)?.status;
      setLookupError(
        status === 404
          ? "We could not find that ID on the student list. Check it and try again, or call an invigilator."
          : cause instanceof Error ? cause.message : String(cause)
      );
    } finally {
      setLookupBusy(false);
    }
  };

  // "Yes, this is me": prefill the form from the roster record. Roster-sourced
  // fields render disabled; the server overrides them again at start anyway
  // (the roster is the identity source of truth — this is just honest UI).
  const confirmRosterMatch = () => {
    if (!rosterMatch) return;
    setForm({
      ...form,
      roster_unique_id: rosterMatch.unique_id,
      hackerrank_username: rosterMatch.hackerrank_username || form.hackerrank_username,
      name: rosterMatch.name || form.name,
      roll_number: rosterMatch.roll_number || form.roll_number,
      email: rosterMatch.email_masked || form.email,
      room: rosterMatch.room || form.room
    });
  };

  const rejectRosterMatch = () => {
    setRosterMatch(null);
    setLookupError("");
  };

  const resetRosterIdentity = () => {
    setRosterMatch(null);
    setUniqueIdInput("");
    setLookupError("");
    setForm({ ...initialForm });
  };
```

- [ ] **Step 7.5: Human message for roster start errors**

In `start()`, find:
```typescript
    } catch (cause) {
      // Registration/gate failure (time window, network, etc.) — generic error.
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus("idle");
      return;
    }
```
replace with:
```typescript
    } catch (cause) {
      // Registration/gate failure (time window, roster, network, ...). Roster
      // codes get a specific human message; everything else stays generic.
      const code = (cause as ApiError)?.code;
      setError(
        code === "not_on_roster" || code === "roster_id_required"
          ? "Your ID was not matched on the student list. Use “Not you? Re-enter ID” to redo the identity step, or call an invigilator."
          : cause instanceof Error ? cause.message : String(cause)
      );
      setStatus("idle");
      return;
    }
```

- [ ] **Step 7.6: Form-stage render — identity gate + locked fields + room dropdown**

Find the ENTIRE block (from `{isFormStage ? (` through the matching `) : null}` after the consent `</label>`):
```tsx
          {isFormStage ? (
            <>
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Your details</p>
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="HackerRank username" value={form.hackerrank_username} onChange={(value) => setForm({ ...form, hackerrank_username: value })} />
                <Field label="Full name" value={form.name} onChange={(value) => setForm({ ...form, name: value })} />
                <Field label="Roll number" value={form.roll_number} onChange={(value) => setForm({ ...form, roll_number: value })} />
                <Field label="Email" type="email" value={form.email} onChange={(value) => setForm({ ...form, email: value })} />
                <Field label="Room number" value={form.room} onChange={(value) => setForm({ ...form, room: value })} />
              </div>

              <label className="mt-5 flex gap-3 rounded-lg border border-line bg-white/60 p-4 text-sm leading-6 text-muted">
                <input
                  className="mt-1 h-4 w-4 accent-accent"
                  type="checkbox"
                  checked={form.consent_accepted}
                  onChange={(event) => setForm({ ...form, consent_accepted: event.target.checked })}
                />
                <span>
                  I have read the rules above and consent to screen recording and, where available, camera and microphone recording for this hiring assessment. I understand that suspicious activity, stopped recording, copied code, or failed verification may lead to disqualification.
                </span>
              </label>
            </>
          ) : null}
```
replace with:
```tsx
          {isFormStage ? (
            <>
              {rosterRequired ? (
                <IdentityLookupPanel
                  label={examConfig?.unique_id_label ?? ""}
                  value={uniqueIdInput}
                  onChange={setUniqueIdInput}
                  busy={lookupBusy}
                  error={lookupError}
                  match={rosterMatch}
                  confirmed={rosterConfirmed}
                  confirmedId={form.roster_unique_id}
                  onLookup={() => void lookupRosterId()}
                  onConfirm={confirmRosterMatch}
                  onReject={rejectRosterMatch}
                  onReset={resetRosterIdentity}
                />
              ) : null}
              {!rosterGateActive ? (
                <>
                  <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Your details</p>
                  <div className="grid gap-4 md:grid-cols-2">
                    <Field label="HackerRank username" value={form.hackerrank_username} disabled={rosterConfirmed && Boolean(rosterMatch?.hackerrank_username)} onChange={(value) => setForm({ ...form, hackerrank_username: value })} />
                    <Field label="Full name" value={form.name} disabled={rosterConfirmed && Boolean(rosterMatch?.name)} onChange={(value) => setForm({ ...form, name: value })} />
                    <Field label="Roll number" value={form.roll_number} disabled={rosterConfirmed && Boolean(rosterMatch?.roll_number)} onChange={(value) => setForm({ ...form, roll_number: value })} />
                    <Field label="Email" type="email" value={form.email} disabled={rosterConfirmed && Boolean(rosterMatch?.email_masked)} onChange={(value) => setForm({ ...form, email: value })} />
                    <RoomField rooms={examConfig?.rooms ?? []} value={form.room} onChange={(value) => setForm({ ...form, room: value })} />
                  </div>

                  <label className="mt-5 flex gap-3 rounded-lg border border-line bg-white/60 p-4 text-sm leading-6 text-muted">
                    <input
                      className="mt-1 h-4 w-4 accent-accent"
                      type="checkbox"
                      checked={form.consent_accepted}
                      onChange={(event) => setForm({ ...form, consent_accepted: event.target.checked })}
                    />
                    <span>
                      I have read the rules above and consent to screen recording and, where available, camera and microphone recording for this hiring assessment. I understand that suspicious activity, stopped recording, copied code, or failed verification may lead to disqualification.
                    </span>
                  </label>
                </>
              ) : null}
            </>
          ) : null}
```

- [ ] **Step 7.7: Add the two components**

Insert immediately AFTER the closing `}` of the `Field` component (near the bottom of `App.tsx`):

```tsx
// S2 — roster identity gate (form stage, before the details form). Three
// states: enter-ID, confirm-match, confirmed. The server re-verifies the ID at
// /api/session/start, so this panel is UX only — never a security boundary.
function IdentityLookupPanel({ label, value, onChange, busy, error, match, confirmed, confirmedId, onLookup, onConfirm, onReject, onReset }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  busy: boolean;
  error: string;
  match: RosterLookupResult | null;
  confirmed: boolean;
  confirmedId: string;
  onLookup: () => void;
  onConfirm: () => void;
  onReject: () => void;
  onReset: () => void;
}) {
  const idLabel = label || "Unique ID";
  if (confirmed) {
    return (
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-accent/30 bg-accent/5 p-4">
        <div className="flex items-center gap-2 text-sm">
          <UserCheck size={18} className="text-accent" />
          <span className="font-medium">Identity confirmed:</span>
          <span className="font-mono">{confirmedId}</span>
        </div>
        <button className="focus-ring inline-flex items-center gap-2 rounded-md border border-line px-3 py-2 text-xs font-medium" onClick={onReset}>
          Not you? Re-enter ID
        </button>
      </div>
    );
  }
  return (
    <div className="mb-5 rounded-lg border border-line bg-white/60 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-accent">Step 1 — confirm your identity</p>
      <p className="mt-1 text-sm text-muted">
        This exam uses a pre-registered student list. Enter your {idLabel} exactly as registered, then confirm the matched record.
      </p>
      {!match ? (
        <>
          <div className="mt-3 grid gap-3 md:grid-cols-[1fr_auto]">
            <Field label={idLabel} value={value} onChange={onChange} />
            <button
              className="focus-ring mt-5 inline-flex h-10 items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
              onClick={onLookup}
              disabled={busy || !value.trim()}
            >
              <Search size={16} /> {busy ? "Checking…" : "Find me"}
            </button>
          </div>
          {error ? <div className="mt-3 rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{error}</div> : null}
        </>
      ) : (
        <div className="mt-3 rounded-lg border border-accent/30 bg-accent/5 p-4">
          <p className="text-sm font-semibold text-ink">Is this you?</p>
          <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm md:grid-cols-2">
            <div><dt className="inline text-muted">{idLabel}: </dt><dd className="inline font-medium">{match.unique_id}</dd></div>
            {match.name ? <div><dt className="inline text-muted">Name: </dt><dd className="inline font-medium">{match.name}</dd></div> : null}
            {match.roll_number && match.roll_number !== match.unique_id ? (
              <div><dt className="inline text-muted">Roll number: </dt><dd className="inline font-medium">{match.roll_number}</dd></div>
            ) : null}
            {match.email_masked ? <div><dt className="inline text-muted">Email: </dt><dd className="inline font-medium">{match.email_masked}</dd></div> : null}
            {match.hackerrank_username ? <div><dt className="inline text-muted">HackerRank: </dt><dd className="inline font-medium">{match.hackerrank_username}</dd></div> : null}
            {match.room ? <div><dt className="inline text-muted">Room: </dt><dd className="inline font-medium">{match.room}</dd></div> : null}
          </dl>
          <div className="mt-4 flex flex-wrap gap-3">
            <button className="focus-ring inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-sm font-medium text-white" onClick={onConfirm}>
              <UserCheck size={16} /> Yes, this is me
            </button>
            <button className="focus-ring inline-flex items-center gap-2 rounded-md border border-line px-4 py-2 text-sm font-medium" onClick={onReject}>
              No — search again
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// S2 — pre-fed room dropdown (+ "Other" free text). Falls back to the legacy
// free-text field when the admin has not configured any rooms.
function RoomField({ rooms, value, onChange }: { rooms: string[]; value: string; onChange: (value: string) => void }) {
  const [otherMode, setOtherMode] = useState(() => value !== "" && !rooms.includes(value));
  if (!rooms.length) {
    return <Field label="Room number" value={value} onChange={onChange} />;
  }
  return (
    <label className="block">
      <span className="text-xs font-medium uppercase tracking-wide text-muted">Room number</span>
      <select
        className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-3 text-sm"
        value={otherMode ? "__other__" : value}
        onChange={(event) => {
          if (event.target.value === "__other__") {
            setOtherMode(true);
            onChange("");
          } else {
            setOtherMode(false);
            onChange(event.target.value);
          }
        }}
      >
        <option value="">Select your room…</option>
        {rooms.map((room) => (
          <option key={room} value={room}>{room}</option>
        ))}
        <option value="__other__">Other…</option>
      </select>
      {otherMode ? (
        <input
          className="focus-ring mt-2 h-10 w-full rounded-md border border-line bg-white px-3 text-sm"
          placeholder="Type your room"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : null}
    </label>
  );
}
```

(`UserCheck` and `Search` are already in the lucide import.)

- [ ] **Step 7.8: Verify**

Run: `cd /home/karthi/arogara/proctor/frontend && npm run lint` — exits 0.
Run: `cd /home/karthi/arogara/proctor/frontend && npm test` — all green.
Run: `cd /home/karthi/arogara/proctor/frontend && npm run build` — builds cleanly.

- [ ] **Step 7.9: Commit**

```bash
cd /home/karthi/arogara/proctor && git add frontend/src/App.tsx && git commit -m "S2: student login — unique-ID-confirm roster gate + room dropdown (+Other)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 8: Full-suite + demo-mode browser integration verification

**Files:** none modified (fixes, if any, get their own commits).

- [ ] **Step 8.1: Full test pass**

```bash
cd /home/karthi/arogara/proctor/backend && node --test test/*.test.mjs
cd /home/karthi/arogara/proctor/frontend && npm test && npm run lint && npm run build
```
Expected: everything green.

- [ ] **Step 8.2: Create a sample roster fixture**

```bash
printf 'Roll No,Student Name,Email ID,Phone,Room\n21CS001,Asha Raman,asha@example.com,9999999999,Lab A-1\n21CS002,Vivek Nair,vivek@example.com,8888888888,Lab B-2\n21CS003,"Raman, Divya",divya@example.com,7777777777,Lab A-1\n' > /tmp/roster-sample.csv
```

- [ ] **Step 8.3: Run the app in demo mode**

```bash
cd /home/karthi/arogara/proctor/frontend && VITE_DEMO_MODE=true VITE_ADMIN_PASSWORD=admin npm run dev
```
(Background it; note the dev URL, typically http://localhost:5173.)

- [ ] **Step 8.4: Browser integration via the :9222 Chrome MCP** — verify, with screenshots at each step:

1. `/admin` → unlock with `admin` → Settings: set a start/end window around now, set Rooms `Lab A-1, Lab B-2`, Save gate. Reload settings → rooms text persists.
2. Candidate roster section: choose `/tmp/roster-sample.csv` (use the MCP `upload_file` tool on the hidden file input) → preview shows 3 rows; Unique-ID column auto-suggests `Roll No`; mappings auto-suggest Name/Email/Roll/Room → Upload → "Roster saved: 3 students" and status line shows Roster active.
3. Student page (`/`, new tab): "Step 1 — confirm your identity" panel shows with label "Roll No". Wrong ID `99XX999` → not-found error. `21cs001` (lowercase, proving normalization) → confirm card shows Asha Raman + masked email `as**@example.com` (assert the RAW email does NOT appear anywhere on the page) → "Yes, this is me".
4. Details form: name/roll/email prefilled + disabled; username editable (not mapped); room dropdown pre-selected `Lab A-1`, options include both labs + "Other…" (selecting Other reveals the free-text input). Check consent → "Start proctoring" enables. (Do NOT need to complete the screen-share — the recorder prompt requires a human gesture; the roster gate itself is already server/demo-verified by the unit tests.)
5. "Not you? Re-enter ID" → form fully resets to the identity step.
6. Admin → Clear roster → student page reload → legacy details form (no identity step), room dropdown still present.

- [ ] **Step 8.5: Record results**

Append the S2 outcome (what passed, screenshots taken, any deviations) to `night-run/MORNING-NOTES.md` §1, and any autonomous judgment calls to §2. Commit the notes:

```bash
cd /home/karthi/arogara/proctor && git add night-run/MORNING-NOTES.md && git commit -m "S2: record roster-login build + integration-test results in morning notes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Verification summary (done bar)

- [ ] `backend: node --test test/*.test.mjs` — all green, 17 new roster tests included.
- [ ] `frontend: npm test` — parseRoster suite green; `npm run lint` + `npm run build` clean.
- [ ] Demo-mode browser flow verified end-to-end via :9222 MCP (Step 8.4), screenshots inspected.
- [ ] All commits LOCAL; **nothing pushed**.
