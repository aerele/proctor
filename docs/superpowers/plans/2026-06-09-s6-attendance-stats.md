# S6 — Attendance stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** READY (paired with `docs/superpowers/specs/2026-06-09-s6-attendance-stats-design.md`).

**Goal:** Admin "Attendance" tab — taken / not-taken counts (in-progress vs completed split) + the absentee list with CSV download, computed by joining the S2 roster against session docs' `roster_unique_id`.

**Tech stack / conventions (follow EXACTLY):**
- Backend: Node 20 Cloud Function `backend/src/handler.mjs`; tests = `node:test` + inline fake Firestore + `__setClientsForTest` + env-vars-BEFORE-import + unique `?attendance` cache-buster import. NO helpers.mjs.
- Frontend: React/Vite/TS; pure logic unit-tested with vitest; ALL network calls in `frontend/src/api.ts` with demo-mode branches (`VITE_DEMO_MODE=true` → localStorage).
- **Commits are LOCAL only, one per task. NEVER `git push`.**
- **Do NOT modify `frontend/src/coding/*`** (Slice 1 owns those files).
- Several parallel items (S1/S2/S3/S5) also edit `App.tsx` and the `api.ts` import block. If an anchor string is not found verbatim, locate the landmark described per step and apply the equivalent edit — do NOT skip the edit.

---

## File structure

**Backend:**
- Modify `backend/src/handler.mjs` — 1 route + handler `adminAttendance` (reuses S2's `getRosterMeta`/`normalizeUniqueId`/`ROSTER_COLLECTION`/`ROSTER_LIMIT`).
- Create `backend/test/attendance.test.mjs`.

**Frontend:**
- Create `frontend/src/attendance/computeAttendance.ts` + `frontend/src/attendance/computeAttendance.test.ts` — pure attendance math + CSV builder + all S6 types.
- Modify `frontend/src/api.ts` — `fetchAttendance` (+ demo branch); `roster_unique_id` on `DemoSession`.
- Modify `frontend/src/App.tsx` — `AdminView` + nav tab + `AttendancePanel`.

---

## Task 0: Dependency gate — S2 backend must already be on main (NO commit)

S6 reads S2's roster store. Verify S2's backend landed:

- [ ] **Step 0.1:** Run:
```bash
cd /home/karthi/arogara/proctor && grep -c "getRosterMeta\|normalizeUniqueId\|ROSTER_COLLECTION\|ROSTER_LIMIT" backend/src/handler.mjs
```
Expected: a number ≥ 4. **If 0 (or grep exits non-zero): STOP — S2 has not landed. Do not build S6.** Report the blocker to the coordinator instead.

- [ ] **Step 0.2:** Run:
```bash
cd /home/karthi/arogara/proctor/backend && node --test test/roster.test.mjs
```
Expected: all S2 roster tests pass (17 if S2 completed its backend tasks). If this file does not exist, STOP per Step 0.1.

---

## Task 1: Backend — `GET /api/admin/attendance`

**Files:**
- Create: `backend/test/attendance.test.mjs`
- Modify: `backend/src/handler.mjs`

- [ ] **Step 1.1: Write the failing tests**

Create `backend/test/attendance.test.mjs` with EXACTLY this content (req/res + Firestore fakes follow the existing convention — same code as `roster.test.mjs`, no improvising):

```javascript
// backend/test/attendance.test.mjs — S6: roster-based attendance stats.
// Spec: docs/superpowers/specs/2026-06-09-s6-attendance-stats-design.md
import { test } from "node:test";
import assert from "node:assert/strict";

// Env BEFORE import; unique ?attendance cache-buster for a fresh module instance.
process.env.EVIDENCE_BUCKET = "att-bucket";
process.env.SESSION_COLLECTION = "att_sessions";
process.env.SETTINGS_COLLECTION = "att_settings";
process.env.ROSTER_COLLECTION = "att_roster";
process.env.ADMIN_PASSWORD = "att-admin-pass";

const handler = await import("../src/handler.mjs?attendance");
const { api, __setClientsForTest } = handler;

// Inline req/res + fakes (convention: copied per test file, NO helpers.mjs).
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
            async set(value, options) {
              const existing = options?.merge ? store.get(id) || {} : {};
              store.set(id, { ...existing, ...value });
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

const ADMIN_HEADERS = { "x-admin-password": "att-admin-pass" };

// ---- Seed helpers -----------------------------------------------------------
// Shapes mirror EXACTLY what S2 persists (S2 spec §3): meta in
// att_settings/roster_meta, one entry doc per student keyed by the normalized
// unique id, sessions stamped with roster_unique_id (display form).

function norm(value) {
  return String(value).trim().toLowerCase().replace(/\s+/g, "");
}

async function seedRoster(firestore, students, { version = "v1", mapping = { name: "Name", roll_number: "Roll", room: "Room" } } = {}) {
  await firestore.collection("att_settings").doc("roster_meta").set({
    configured: true,
    version,
    unique_id_column: "Reg No",
    column_mapping: mapping,
    columns: ["Reg No", "Name", "Roll", "Room"],
    count: students.length,
    updated_at: "2026-06-09T00:00:00.000Z"
  });
  for (const student of students) {
    const idNorm = norm(student.unique_id);
    await firestore.collection("att_roster").doc(idNorm).set({
      unique_id: student.unique_id,
      unique_id_norm: idNorm,
      roster_version: student.version ?? version,
      fields: {
        "Reg No": student.unique_id,
        Name: student.name ?? "",
        Roll: student.roll ?? "",
        Room: student.room ?? ""
      },
      created_at: "2026-06-09T00:00:00.000Z"
    });
  }
}

async function seedSession(firestore, sessionId, { roster_unique_id = "", status = "active", contest_slug = "contest-a" } = {}) {
  await firestore.collection("att_sessions").doc(sessionId).set({
    session_id: sessionId,
    hackerrank_username: sessionId,
    roster_unique_id,
    roster_verified: Boolean(roster_unique_id),
    status,
    contest_slug,
    created_at: "2026-06-09T01:00:00.000Z"
  });
}

function attendanceReq(query = {}, headers = ADMIN_HEADERS) {
  return makeReq({ method: "GET", path: "/api/admin/attendance", headers, query });
}

// ---- Tests --------------------------------------------------------------------

test("attendance: 401 without the admin password", async () => {
  __setClientsForTest({ firestore: makeFakeFirestore() });
  const res = await call(attendanceReq({}, {}));
  assert.equal(res.statusCode, 401);
});

test("attendance: configured:false when no roster is set", async () => {
  __setClientsForTest({ firestore: makeFakeFirestore() });
  const res = await call(attendanceReq());
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { configured: false });
});

test("attendance: taken/in-progress/completed/absent counts + mapped absentee fields", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore });
  await seedRoster(firestore, [
    { unique_id: "21CS001", name: "Asha", roll: "R1", room: "Lab A" },
    { unique_id: "21CS002", name: "Vikram", roll: "R2", room: "Lab B" },
    { unique_id: "21CS003", name: "Meera", roll: "R3", room: "Lab A" }
  ]);
  await seedSession(firestore, "s1", { roster_unique_id: "21CS001", status: "ended" });
  await seedSession(firestore, "s2", { roster_unique_id: "21CS002", status: "active" });

  const res = await call(attendanceReq());
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.configured, true);
  assert.equal(res.body.contest_slug, null);
  assert.equal(res.body.roster_total, 3);
  assert.deepEqual(res.body.taken, { total: 2, in_progress: 1, completed: 1 });
  assert.equal(res.body.not_taken, 1);
  assert.equal(res.body.unmatched_sessions, 0);
  // PII shape lock: an absentee row is EXACTLY these four mapped fields.
  assert.deepEqual(res.body.absentees, [
    { unique_id: "21CS003", name: "Meera", roll_number: "R3", room: "Lab A" }
  ]);
  assert.ok(res.body.generated_at);
});

test("attendance: matching normalizes case + whitespace ('21 cs 001' matches 21CS001)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore });
  await seedRoster(firestore, [{ unique_id: "21CS001", name: "Asha" }]);
  await seedSession(firestore, "s1", { roster_unique_id: "21 cs 001", status: "active" });

  const res = await call(attendanceReq());
  assert.deepEqual(res.body.taken, { total: 1, in_progress: 1, completed: 0 });
  assert.equal(res.body.not_taken, 0);
  assert.equal(res.body.unmatched_sessions, 0);
});

test("attendance: pending_approval and locked sessions count as taken (in progress)", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore });
  await seedRoster(firestore, [
    { unique_id: "21CS001", name: "Asha" },
    { unique_id: "21CS002", name: "Vikram" }
  ]);
  await seedSession(firestore, "s1", { roster_unique_id: "21CS001", status: "pending_approval" });
  await seedSession(firestore, "s2", { roster_unique_id: "21CS002", status: "locked" });

  const res = await call(attendanceReq());
  assert.deepEqual(res.body.taken, { total: 2, in_progress: 2, completed: 0 });
  assert.equal(res.body.not_taken, 0);
});

test("attendance: multiple sessions for one student count once; any non-ended wins", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore });
  await seedRoster(firestore, [{ unique_id: "21CS001", name: "Asha" }]);
  await seedSession(firestore, "s1", { roster_unique_id: "21CS001", status: "ended" });
  await seedSession(firestore, "s2", { roster_unique_id: "21CS001", status: "active" });

  const res = await call(attendanceReq());
  assert.equal(res.body.roster_total, 1);
  assert.deepEqual(res.body.taken, { total: 1, in_progress: 1, completed: 0 });
});

test("attendance: stale-version entries are invisible and their sessions are unmatched", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore });
  // Meta version is v1; the second entry is from a replaced upload (v0).
  await seedRoster(firestore, [
    { unique_id: "21CS001", name: "Asha" },
    { unique_id: "21CS002", name: "Old Upload", version: "v0" }
  ]);
  await seedSession(firestore, "s1", { roster_unique_id: "21CS002", status: "active" });

  const res = await call(attendanceReq());
  assert.equal(res.body.roster_total, 1);
  assert.deepEqual(res.body.taken, { total: 0, in_progress: 0, completed: 0 });
  assert.equal(res.body.not_taken, 1);
  assert.equal(res.body.absentees[0].unique_id, "21CS001");
  assert.equal(res.body.unmatched_sessions, 1);
});

test("attendance: legacy sessions without roster_unique_id count as unmatched only", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore });
  await seedRoster(firestore, [{ unique_id: "21CS001", name: "Asha" }]);
  await seedSession(firestore, "s1", { roster_unique_id: "", status: "active" });

  const res = await call(attendanceReq());
  assert.deepEqual(res.body.taken, { total: 0, in_progress: 0, completed: 0 });
  assert.equal(res.body.not_taken, 1);
  assert.equal(res.body.unmatched_sessions, 1);
});

test("attendance: contest_slug scopes the sessions side", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore });
  await seedRoster(firestore, [{ unique_id: "21CS001", name: "Asha" }]);
  await seedSession(firestore, "s1", { roster_unique_id: "21CS001", status: "active", contest_slug: "contest-b" });

  const res = await call(attendanceReq({ contest_slug: "contest-a" }));
  assert.equal(res.body.contest_slug, "contest-a");
  // The contest-b session is filtered out BEFORE counting: not taken, not unmatched.
  assert.deepEqual(res.body.taken, { total: 0, in_progress: 0, completed: 0 });
  assert.equal(res.body.not_taken, 1);
  assert.equal(res.body.unmatched_sessions, 0);
});

test("attendance: absentees sorted by unique_id; unmapped fields come back empty", async () => {
  const firestore = makeFakeFirestore();
  __setClientsForTest({ firestore });
  await seedRoster(
    firestore,
    [
      { unique_id: "21CS010", name: "Meera", roll: "R10", room: "Lab A" },
      { unique_id: "21CS002", name: "Vikram", roll: "R2", room: "Lab B" }
    ],
    { mapping: { name: "Name" } } // roll_number and room are NOT mapped
  );

  const res = await call(attendanceReq());
  assert.deepEqual(res.body.absentees, [
    { unique_id: "21CS002", name: "Vikram", roll_number: "", room: "" },
    { unique_id: "21CS010", name: "Meera", roll_number: "", room: "" }
  ]);
});
```

- [ ] **Step 1.2: Run to verify failure**

Run: `cd /home/karthi/arogara/proctor/backend && node --test test/attendance.test.mjs`
Expected: 10 tests, ALL FAIL (there is no `/api/admin/attendance` route yet, so every call falls through to the router's 404/unknown handling — including the 401 test, which receives a non-401 status).

- [ ] **Step 1.3: Implement**

**(a) Route** — in `backend/src/handler.mjs`, find:
```javascript
    if (req.method === "GET" && path === "/api/admin/stats") return send(res, 200, await adminStats(req));
```
and insert immediately AFTER it:
```javascript
    if (req.method === "GET" && path === "/api/admin/attendance") return send(res, 200, await adminAttendance(req));
```

**(b) Handler** — find (the end of `isStaleSession`, just before the `adminSessionAction` comment block):
```javascript
  return nowMs - newest > DISCONNECTED_STALENESS_MS;
}
```
and insert immediately AFTER it:
```javascript

// ---- S6 attendance (spec: docs/superpowers/specs/2026-06-09-s6-attendance-stats-design.md)

// GET /api/admin/attendance?contest_slug=<optional> — roster-based attendance:
// taken / not-taken counts + the absentee list. "Taken" = the roster student has
// AT LEAST ONE session doc whose roster_unique_id matches their ACTIVE-version
// roster entry (any status — pending_approval/locked still means they showed
// up); "in_progress" = any of their sessions is non-ended; "completed" = all
// ended. Sessions that can't be tied to the active roster (legacy pre-roster,
// blank id, replaced-roster ids) are surfaced as unmatched_sessions — never
// silently dropped, never counted as attendance. Absentee rows carry ONLY the
// mapped identity fields (unique_id, name, roll_number, room) — no email, no
// raw roster fields (PII minimization). Computed on demand: one version-
// filtered roster scan + one session scan, joined in memory (no new state, no
// composite index — both filters are single-field equalities). The admin UI
// loads this on tab-open + manual refresh only (NO auto-poll).
async function adminAttendance(req) {
  requireAdmin(req);
  const contestSlug = req.query?.contest_slug;
  const meta = await getRosterMeta();
  if (!meta) return { configured: false };

  // Active-version roster entries (stale versions are invisible — S2 invariant).
  const entriesSnap = await firestore
    .collection(ROSTER_COLLECTION)
    .where("roster_version", "==", meta.version)
    .limit(ROSTER_LIMIT)
    .get();
  const entries = entriesSnap.docs.map((doc) => doc.data());

  // Session docs, optionally contest-scoped (same pattern as adminStats).
  let query = firestore.collection(SESSION_COLLECTION);
  if (contestSlug !== undefined && contestSlug !== null && contestSlug !== "") {
    query = query.where("contest_slug", "==", String(contestSlug));
  }
  const sessionsSnap = await query.limit(SESSIONS_QUERY_LIMIT).get();
  const sessions = sessionsSnap.docs.map((doc) => doc.data());

  // norm unique id -> true when ANY of that student's sessions is still live.
  const knownNorms = new Set(entries.map((entry) => String(entry.unique_id_norm || "")));
  const liveByNorm = new Map();
  let unmatched = 0;
  for (const session of sessions) {
    const idNorm = normalizeUniqueId(String(session.roster_unique_id || ""));
    if (!idNorm || !knownNorms.has(idNorm)) {
      unmatched += 1;
      continue;
    }
    const live = session.status !== "ended";
    liveByNorm.set(idNorm, Boolean(liveByNorm.get(idNorm)) || live);
  }

  const mapping = meta.column_mapping || {};
  const mappedField = (entry, name) =>
    (mapping[name] ? String(entry.fields?.[mapping[name]] || "") : "");
  const taken = { total: 0, in_progress: 0, completed: 0 };
  const absentees = [];
  for (const entry of entries) {
    const idNorm = String(entry.unique_id_norm || "");
    if (liveByNorm.has(idNorm)) {
      taken.total += 1;
      if (liveByNorm.get(idNorm)) taken.in_progress += 1;
      else taken.completed += 1;
    } else {
      absentees.push({
        unique_id: String(entry.unique_id || ""),
        name: mappedField(entry, "name"),
        roll_number: mappedField(entry, "roll_number"),
        room: mappedField(entry, "room")
      });
    }
  }
  absentees.sort((a, b) => a.unique_id.localeCompare(b.unique_id));

  return {
    configured: true,
    contest_slug: contestSlug ? String(contestSlug) : null,
    roster_total: entries.length,
    taken,
    not_taken: absentees.length,
    absentees,
    unmatched_sessions: unmatched,
    generated_at: new Date().toISOString()
  };
}
```

- [ ] **Step 1.4: Run to verify pass**

Run: `cd /home/karthi/arogara/proctor/backend && node --test test/attendance.test.mjs`
Expected: 10 tests pass, 0 fail.
Run: `cd /home/karthi/arogara/proctor/backend && node --test test/*.test.mjs`
Expected: ALL backend tests pass (attendance touches no existing handler).

- [ ] **Step 1.5: Commit**

```bash
cd /home/karthi/arogara/proctor && git add backend/src/handler.mjs backend/test/attendance.test.mjs && git commit -m "S6: GET /api/admin/attendance — roster taken/not-taken + absentee list

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: Frontend — pure attendance math + CSV builder

**Files:**
- Create: `frontend/src/attendance/computeAttendance.test.ts`
- Create: `frontend/src/attendance/computeAttendance.ts`

- [ ] **Step 2.1: Write the failing tests**

Create `frontend/src/attendance/computeAttendance.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { buildAbsenteesCsv, computeAttendance } from "./computeAttendance";

const roster = [
  { unique_id: "21CS001", name: "Asha", roll_number: "R1", room: "Lab A" },
  { unique_id: "21CS002", name: "Vikram", roll_number: "R2", room: "Lab B" },
  { unique_id: "21CS010", name: "Meera", roll_number: "R3", room: "Lab A" }
];

describe("computeAttendance", () => {
  it("marks everyone absent when there are no sessions", () => {
    const core = computeAttendance(roster, []);
    expect(core.roster_total).toBe(3);
    expect(core.taken).toEqual({ total: 0, in_progress: 0, completed: 0 });
    expect(core.not_taken).toBe(3);
    expect(core.absentees.map((a) => a.unique_id)).toEqual(["21CS001", "21CS002", "21CS010"]);
    expect(core.unmatched_sessions).toBe(0);
  });

  it("splits taken into in-progress (any non-ended) and completed (all ended)", () => {
    const core = computeAttendance(roster, [
      { roster_unique_id: "21CS001", status: "ended" },
      { roster_unique_id: "21CS002", status: "active" }
    ]);
    expect(core.taken).toEqual({ total: 2, in_progress: 1, completed: 1 });
    expect(core.not_taken).toBe(1);
    expect(core.absentees.map((a) => a.unique_id)).toEqual(["21CS010"]);
  });

  it("matches unique ids case- and whitespace-insensitively", () => {
    const core = computeAttendance(roster, [{ roster_unique_id: "21 cs 001", status: "active" }]);
    expect(core.taken.total).toBe(1);
    expect(core.unmatched_sessions).toBe(0);
  });

  it("counts a student once across multiple sessions; any live session wins", () => {
    const core = computeAttendance(roster, [
      { roster_unique_id: "21CS001", status: "ended" },
      { roster_unique_id: "21CS001", status: "active" }
    ]);
    expect(core.taken).toEqual({ total: 1, in_progress: 1, completed: 0 });
  });

  it("counts pending_approval and locked as taken / in progress", () => {
    const core = computeAttendance(roster, [
      { roster_unique_id: "21CS001", status: "pending_approval" },
      { roster_unique_id: "21CS002", status: "locked" }
    ]);
    expect(core.taken).toEqual({ total: 2, in_progress: 2, completed: 0 });
  });

  it("routes blank and off-roster ids into unmatched_sessions", () => {
    const core = computeAttendance(roster, [
      { roster_unique_id: "", status: "active" },
      { roster_unique_id: "99XX999", status: "active" }
    ]);
    expect(core.taken.total).toBe(0);
    expect(core.not_taken).toBe(3);
    expect(core.unmatched_sessions).toBe(2);
  });

  it("sorts absentees by unique_id regardless of roster order", () => {
    const shuffled = [roster[2], roster[0], roster[1]];
    const core = computeAttendance(shuffled, []);
    expect(core.absentees.map((a) => a.unique_id)).toEqual(["21CS001", "21CS002", "21CS010"]);
  });
});

describe("buildAbsenteesCsv", () => {
  it("emits a header plus one escaped row per absentee", () => {
    const csv = buildAbsenteesCsv([
      { unique_id: "21CS001", name: 'Asha "AJ", Jr', roll_number: "R1", room: "Lab A" }
    ]);
    expect(csv).toBe('unique_id,name,roll_number,room\n21CS001,"Asha ""AJ"", Jr",R1,Lab A');
  });

  it("returns only the header for an empty list", () => {
    expect(buildAbsenteesCsv([])).toBe("unique_id,name,roll_number,room");
  });
});
```

- [ ] **Step 2.2: Run to verify failure**

Run: `cd /home/karthi/arogara/proctor/frontend && npx vitest run src/attendance/computeAttendance.test.ts`
Expected: FAILS — cannot resolve `./computeAttendance` (module does not exist yet).

- [ ] **Step 2.3: Implement**

Create `frontend/src/attendance/computeAttendance.ts`:

```typescript
// S6 attendance — pure attendance math + CSV builder, shared by the api.ts demo
// branch and unit tests. Mirrors the backend adminAttendance semantics EXACTLY
// (spec: docs/superpowers/specs/2026-06-09-s6-attendance-stats-design.md):
// taken = >=1 matching session (any status); in_progress = any non-ended;
// completed = all ended; blank/off-roster session ids -> unmatched_sessions.

export type AttendanceAbsentee = {
  unique_id: string;
  name: string;
  roll_number: string;
  room: string;
};

export type AttendanceSessionLike = {
  roster_unique_id: string;
  status: string;
};

export type AttendanceCore = {
  roster_total: number;
  taken: { total: number; in_progress: number; completed: number };
  not_taken: number;
  absentees: AttendanceAbsentee[];
  unmatched_sessions: number;
};

// GET /api/admin/attendance response. `configured:false` carries nothing else.
export type AttendanceReport =
  | { configured: false }
  | ({ configured: true; contest_slug: string | null; generated_at: string } & AttendanceCore);

// Mirrors the backend normalizeUniqueId: trim + lowercase + strip ALL whitespace
// (colleges format roll numbers inconsistently: "21 CS 001" ≡ "21CS001").
function normalizeUniqueId(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

export function computeAttendance(
  roster: AttendanceAbsentee[],
  sessions: AttendanceSessionLike[]
): AttendanceCore {
  const knownNorms = new Set(roster.map((row) => normalizeUniqueId(row.unique_id)));
  const liveByNorm = new Map<string, boolean>();
  let unmatched = 0;
  for (const session of sessions) {
    const idNorm = normalizeUniqueId(session.roster_unique_id || "");
    if (!idNorm || !knownNorms.has(idNorm)) {
      unmatched += 1;
      continue;
    }
    const live = session.status !== "ended";
    liveByNorm.set(idNorm, Boolean(liveByNorm.get(idNorm)) || live);
  }
  const taken = { total: 0, in_progress: 0, completed: 0 };
  const absentees: AttendanceAbsentee[] = [];
  for (const row of roster) {
    const idNorm = normalizeUniqueId(row.unique_id);
    if (liveByNorm.has(idNorm)) {
      taken.total += 1;
      if (liveByNorm.get(idNorm)) taken.in_progress += 1;
      else taken.completed += 1;
    } else {
      absentees.push(row);
    }
  }
  absentees.sort((a, b) => a.unique_id.localeCompare(b.unique_id));
  return {
    roster_total: roster.length,
    taken,
    not_taken: absentees.length,
    absentees,
    unmatched_sessions: unmatched
  };
}

// RFC-4180-ish escaping, same rules as App.tsx's csvField (kept local so this
// module stays pure + importable by both api.ts and App.tsx).
function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

// Absentees CSV for the exam-day report: fixed header + one row per absentee.
export function buildAbsenteesCsv(absentees: AttendanceAbsentee[]): string {
  const header = "unique_id,name,roll_number,room";
  const rows = absentees.map((a) =>
    [csvField(a.unique_id), csvField(a.name), csvField(a.roll_number), csvField(a.room)].join(",")
  );
  return [header, ...rows].join("\n");
}
```

- [ ] **Step 2.4: Run to verify pass**

Run: `cd /home/karthi/arogara/proctor/frontend && npx vitest run src/attendance/computeAttendance.test.ts`
Expected: 9 tests pass, 0 fail.
Run: `cd /home/karthi/arogara/proctor/frontend && npm test`
Expected: ALL frontend tests pass.

- [ ] **Step 2.5: Commit**

```bash
cd /home/karthi/arogara/proctor && git add frontend/src/attendance && git commit -m "S6: pure attendance math + absentees CSV builder (vitest)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: Frontend — `fetchAttendance` in api.ts (+ demo `roster_unique_id`)

**Files:**
- Modify: `frontend/src/api.ts`

No new unit tests here by design: the attendance logic is the Task-2 pure module (already tested); the request/demo plumbing follows the established untested-in-vitest api.ts pattern and is exercised in Task 5's browser run. Verification is the TypeScript build.

- [ ] **Step 3.1: Module import**

In `frontend/src/api.ts`, find the closing line of the type import block:
```typescript
} from "./types";
```
and insert immediately AFTER it:
```typescript
import { computeAttendance, type AttendanceReport } from "./attendance/computeAttendance";
```
Also confirm `RosterColumnMapping` is among the names in the `import type {...} from "./types"` list (S2 added it; if S2's frontend tasks have not added it yet, add `RosterColumnMapping,` to that list — it exists in `types.ts` after S2 Task 6).

- [ ] **Step 3.2: `roster_unique_id` on the demo session record**

**(a) Type** — find (inside `type DemoSession = {`):
```typescript
  username_norm: string;
  name: string;
  room: string;
```
replace with:
```typescript
  username_norm: string;
  name: string;
  // S6: the matched roster id (display form), "" when no roster — mirrors the
  // backend session doc so demo attendance can join sessions to the roster.
  roster_unique_id: string;
  room: string;
```

**(b) Stamp at demo start** — in `startSession`'s demo branch, find the `DemoSession` literal lines (AFTER S2's edits these read):
```typescript
      hackerrank_username: effectiveUsername,
      username_norm: usernameNorm,
      name: rosterName || form.name.trim(),
```
replace with:
```typescript
      hackerrank_username: effectiveUsername,
      username_norm: usernameNorm,
      name: rosterName || form.name.trim(),
      roster_unique_id: demoRosterHit
        ? (demoRosterHit.row[demoRosterHit.roster.unique_id_column] ?? "").trim()
        : "",
```
*Re-anchor note:* if S2's frontend tasks have not run yet, the literal still reads `hackerrank_username: form.hackerrank_username.trim(), / username_norm: usernameNorm, / name: form.name.trim(),` and there is no `demoRosterHit` in scope — in that case add `roster_unique_id: "",` after the `name:` line instead, and leave a `// TODO(S2): stamp the matched roster id here` comment. Run `npx tsc -b --pretty false` after either edit — the now-required field will flag any other `DemoSession` literal that needs the field (currently there is exactly one constructor site; spreads like `{ ...session, status: "ended" }` are unaffected).

- [ ] **Step 3.3: `fetchAttendance`**

Find:
```typescript
export async function sessionAction(password: string, body: SessionActionRequest): Promise<SessionActionResponse> {
```
and insert immediately BEFORE it:
```typescript
// ---- S6 attendance stats ----------------------------------------------------
// GET /api/admin/attendance — roster-based taken / not-taken / absentees.
// Spec: docs/superpowers/specs/2026-06-09-s6-attendance-stats-design.md.
// `null` on 404 so the Attendance tab can show "not deployed yet" (same degrade
// as fetchSessionsList / fetchRosterStatus). The demo branch joins the demo
// roster against the REAL demo session store via the SAME pure computeAttendance
// the backend semantics mirror, so demo and production agree by construction.
export async function fetchAttendance(password: string, contestSlug?: string): Promise<AttendanceReport | null> {
  if (demoMode) {
    await wait(150);
    assertDemoAdmin(password);
    const roster = getDemoRoster();
    if (!roster) return { configured: false };
    const mapped = (row: Record<string, string>, field: keyof RosterColumnMapping) => {
      const column = roster.column_mapping[field];
      return column ? (row[column] ?? "").trim() : "";
    };
    const rosterRows = roster.rows.map((row) => ({
      unique_id: (row[roster.unique_id_column] ?? "").trim(),
      name: mapped(row, "name"),
      roll_number: mapped(row, "roll_number"),
      room: mapped(row, "room")
    }));
    const sessions = readDemoSessions()
      .filter((session) => !contestSlug || session.contest_slug === contestSlug)
      .map((session) => ({
        // Old persisted demo sessions predate the field — read defensively.
        roster_unique_id: String(session.roster_unique_id ?? ""),
        status: session.status
      }));
    return {
      configured: true,
      contest_slug: contestSlug || null,
      generated_at: new Date().toISOString(),
      ...computeAttendance(rosterRows, sessions)
    };
  }

  const query = new URLSearchParams();
  if (contestSlug) query.set("contest_slug", contestSlug);
  const suffix = query.toString();
  try {
    return await request<AttendanceReport>(`/api/admin/attendance${suffix ? `?${suffix}` : ""}`, {
      method: "GET",
      headers: { "x-admin-password": password }
    });
  } catch (cause) {
    if ((cause as ApiError)?.status === 404) return null;
    throw cause;
  }
}

```
*Re-anchor note:* `getDemoRoster` is S2's helper (api.ts S2 section). If S2's frontend tasks have not landed, this demo branch cannot compile — STOP and report the S2-frontend dependency to the coordinator (backend Task 1 + pure Task 2 are still shippable).

- [ ] **Step 3.4: Typecheck**

Run: `cd /home/karthi/arogara/proctor/frontend && npx tsc -b --pretty false`
Expected: exit 0, no errors (the `fetchAttendance` export is unused until Task 4 — that is fine for tsc).
Run: `cd /home/karthi/arogara/proctor/frontend && npm test`
Expected: ALL frontend tests still pass.

- [ ] **Step 3.5: Commit**

```bash
cd /home/karthi/arogara/proctor && git add frontend/src/api.ts && git commit -m "S6: fetchAttendance API client + roster_unique_id on demo sessions

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: Frontend — Attendance tab + AttendancePanel in App.tsx

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 4.1: Imports**

**(a)** In the `./api` import (App.tsx line ~3, the long named-import list), add `fetchAttendance` keeping alphabetical order (between `fetchAllReviews` and the next `fetch*` name; S2 may have inserted `fetchExamConfig`/`fetchRosterStatus` into the same list — order is `fetchAllReviews, fetchAttendance, fetchExamConfig, ...`).

**(b)** Find:
```tsx
import { CodingWorkspace } from "./coding/CodingWorkspace";
```
and insert immediately AFTER it:
```tsx
import { buildAbsenteesCsv, type AttendanceReport } from "./attendance/computeAttendance";
```
(`UserCheck`, `Download`, `RefreshCw`, `AlertTriangle`, `Clock`, `CheckCircle2`, `Users` are already in the lucide-react import — no icon import changes.)

- [ ] **Step 4.2: AdminView + nav tab**

**(a)** Find:
```tsx
type AdminView = "stats" | "alerts" | "sessions" | "review" | "recordings" | "settings";
```
replace with:
```tsx
type AdminView = "stats" | "alerts" | "sessions" | "attendance" | "review" | "recordings" | "settings";
```
*Re-anchor note:* if a parallel item already extended this union, just add `"attendance"` after `"sessions"`.

**(b)** Find:
```tsx
        <AdminTab active={view === "sessions"} onClick={() => { setView("sessions"); void loadSessions(); }} icon={<Users size={16} />} label="Sessions" />
```
and insert immediately AFTER it:
```tsx
        <AdminTab active={view === "attendance"} onClick={() => setView("attendance")} icon={<UserCheck size={16} />} label="Attendance" />
```
(No load call here — `AttendancePanel` self-loads on mount.)

- [ ] **Step 4.3: Render the panel**

Find:
```tsx
      {view === "alerts" ? (
```
and insert immediately BEFORE it:
```tsx
      {view === "attendance" ? (
        <AttendancePanel password={password} contestSlug={alertFilters.contest_slug ?? ""} />
      ) : null}

```

- [ ] **Step 4.4: The AttendancePanel component**

Find the comment line:
```tsx
// Shared room dropdown — populated from the response `rooms` list (full contest
```
and insert immediately BEFORE it:
```tsx
// S6 ATTENDANCE — roster-based attendance from GET /api/admin/attendance: taken /
// not-taken counts (in-progress vs completed) + the absentee list with CSV export.
// Self-contained (own load/error state, like ContestEvalAlertTypesSection): loads
// when the tab mounts and when the global contest filter changes; manual Refresh
// only — NO auto-poll (each call scans the whole roster + session set). Degrades
// to "not deployed yet" when fetchAttendance returns null (endpoint 404).
function AttendancePanel({ password, contestSlug }: { password: string; contestSlug: string }) {
  const [report, setReport] = useState<AttendanceReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const next = await fetchAttendance(password, contestSlug || undefined);
      if (next === null) {
        setUnavailable(true);
        setReport(null);
        return;
      }
      setUnavailable(false);
      setReport(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load is stable per render inputs
  }, [contestSlug]);

  const downloadCsv = () => {
    if (!report || !report.configured) return;
    const csv = buildAbsenteesCsv(report.absentees);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "absentees.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const needle = filter.trim().toLowerCase();
  const rows = report && report.configured
    ? report.absentees.filter(
        (a) =>
          !needle ||
          a.unique_id.toLowerCase().includes(needle) ||
          a.name.toLowerCase().includes(needle) ||
          a.roll_number.toLowerCase().includes(needle) ||
          a.room.toLowerCase().includes(needle)
      )
    : [];

  return (
    <section className="space-y-5">
      <div className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <UserCheck size={20} />
            <div>
              <h1 className="text-2xl font-semibold">Attendance</h1>
              <p className="mt-1 text-sm text-muted">
                Roster-based attendance{contestSlug ? <> for contest <span className="font-mono font-medium">{contestSlug}</span></> : null}: who has taken the test, who is still in it, and who never showed up. Loads on open; Refresh to update.
              </p>
            </div>
          </div>
          <button className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white disabled:opacity-50" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={16} className={loading ? "animate-spin" : undefined} /> {loading ? "Refreshing" : "Refresh"}
          </button>
        </div>
      </div>

      {error ? <div className="rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger">{error}</div> : null}

      {unavailable ? (
        <div className="rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm text-warning">
          <AlertTriangle size={16} className="mr-2 inline" />
          The attendance endpoint is not deployed yet. Deploy the backend to enable attendance stats.
        </div>
      ) : report === null ? (
        <div className="rounded-lg border border-line bg-panel p-5 text-sm text-muted">{loading ? "Loading attendance…" : "No attendance loaded yet."}</div>
      ) : !report.configured ? (
        <div className="rounded-lg border border-line bg-panel p-5 text-sm text-muted">
          No student roster is configured, so attendance cannot be computed. Upload a roster in Settings → Candidate roster first.
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <StatCard label="On roster" value={report.roster_total} tone="ink" icon={<Users size={18} />} />
            <StatCard label="Taken" value={report.taken.total} tone="accent" icon={<UserCheck size={18} />} />
            <StatCard label="In progress" value={report.taken.in_progress} tone="warning" icon={<Clock size={18} />} />
            <StatCard label="Completed" value={report.taken.completed} tone="muted" icon={<CheckCircle2 size={18} />} />
            <StatCard label="Not taken" value={report.not_taken} tone="danger" icon={<AlertTriangle size={18} />} />
          </div>

          {report.unmatched_sessions > 0 ? (
            <p className="inline-flex items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              <AlertTriangle size={14} /> {report.unmatched_sessions} session{report.unmatched_sessions === 1 ? "" : "s"} could not be tied to the roster (started before the roster was uploaded, or under a replaced roster) — not counted as attendance.
            </p>
          ) : null}

          <div className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Absentees</h2>
                <p className="mt-1 text-xs text-muted">
                  {report.not_taken} roster student{report.not_taken === 1 ? "" : "s"} with no session — as of {new Date(report.generated_at).toLocaleString()}.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <input
                  className="focus-ring h-9 rounded-md border border-line px-3 text-sm"
                  placeholder="Filter by ID, name, roll, room"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
                <button
                  className="focus-ring inline-flex h-9 items-center justify-center gap-2 rounded-md border border-line px-3 text-sm font-medium disabled:opacity-50"
                  onClick={downloadCsv}
                  disabled={report.not_taken === 0}
                >
                  <Download size={14} /> Download CSV
                </button>
              </div>
            </div>

            {report.not_taken === 0 ? (
              <p className="mt-4 rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-accent">Full house — every roster student has a session.</p>
            ) : rows.length === 0 ? (
              <p className="mt-4 text-sm text-muted">No absentees match this filter.</p>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                      <th className="px-4 py-3 font-semibold">Unique ID</th>
                      <th className="px-4 py-3 font-semibold">Name</th>
                      <th className="px-4 py-3 font-semibold">Roll number</th>
                      <th className="px-4 py-3 font-semibold">Room</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((a) => (
                      <tr key={a.unique_id} className="border-b border-line/60 last:border-0">
                        <td className="px-4 py-3 font-mono text-xs font-semibold text-ink">{a.unique_id}</td>
                        <td className="px-4 py-3">{a.name || "—"}</td>
                        <td className="px-4 py-3 text-muted">{a.roll_number || "—"}</td>
                        <td className="px-4 py-3 text-muted">{a.room || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

```

- [ ] **Step 4.5: Verify**

Run: `cd /home/karthi/arogara/proctor/frontend && npx tsc -b --pretty false`
Expected: exit 0.
Run: `cd /home/karthi/arogara/proctor/frontend && npm run build`
Expected: build succeeds.
Run: `cd /home/karthi/arogara/proctor/frontend && npm test`
Expected: ALL frontend tests pass.

- [ ] **Step 4.6: Commit**

```bash
cd /home/karthi/arogara/proctor && git add frontend/src/App.tsx && git commit -m "S6: admin Attendance tab — counts, unmatched note, absentee table + CSV

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: Browser integration test (demo mode, :9222 MCP) + evidence

**Files:**
- Create: `night-run/evidence/s6-attendance-demo.png`

State is seeded via localStorage (deterministic; S2's own plan integration-tests the upload UI and the real student start, so S6 tests the attendance pipeline itself). Use the chrome-devtools MCP against the Chrome instance on :9222.

- [ ] **Step 5.1: Start the dev server** (background):
```bash
cd /home/karthi/arogara/proctor/frontend && VITE_DEMO_MODE=true VITE_ADMIN_PASSWORD=admin npm run dev
```
Note the URL (typically http://localhost:5173).

- [ ] **Step 5.2: Empty state.** Navigate a page to `http://localhost:5173/admin`, type `admin` into the password field, click "Unlock admin". Click the **Attendance** tab. Expected: the "No student roster is configured…" card.

- [ ] **Step 5.3: Seed the demo roster + sessions** via `evaluate_script` on that page:
```javascript
() => {
  localStorage.setItem("aerele-proctor-demo-roster", JSON.stringify({
    unique_id_column: "Reg No",
    columns: ["Reg No", "Name", "Roll", "Room"],
    column_mapping: { name: "Name", roll_number: "Roll", room: "Room" },
    rows: [
      { "Reg No": "21CS001", "Name": "Asha R", "Roll": "R1", "Room": "Lab A" },
      { "Reg No": "21CS002", "Name": "Vikram T", "Roll": "R2", "Room": "Lab B" },
      { "Reg No": "21CS003", "Name": "Meera S", "Roll": "R3", "Room": "Lab A" }
    ]
  }));
  const sessions = [
    { session_id: "s6-demo-taken-1", status: "active", hackerrank_username: "asha_r",
      username_norm: "asha_r", name: "Asha R", roster_unique_id: "21CS001", room: "Lab A",
      contest_slug: "", storage_prefix: "sessions/asha_r/s6-demo-taken-1/",
      blocked_by_session_id: null, start_ip: "demo.local" },
    { session_id: "s6-demo-legacy-1", status: "active", hackerrank_username: "walkin",
      username_norm: "walkin", name: "Walk In", roster_unique_id: "", room: "Lab B",
      contest_slug: "", storage_prefix: "sessions/walkin/s6-demo-legacy-1/",
      blocked_by_session_id: null, start_ip: "demo.local" }
  ];
  localStorage.setItem("aerele-proctor-demo-sessions", JSON.stringify(sessions));
  return "seeded";
}
```

- [ ] **Step 5.4: Verify the report.** Click **Refresh** on the Attendance tab. Expected, verify ALL via snapshot:
  - Cards: On roster **3**, Taken **1**, In progress **1**, Completed **0**, Not taken **2**.
  - Warning note: "1 session could not be tied to the roster…".
  - Absentee table: exactly 2 rows, sorted — `21CS002 / Vikram T / R2 / Lab B` then `21CS003 / Meera S / R3 / Lab A`.
  - Type `vik` in the filter → exactly 1 row (Vikram); clear it → 2 rows again.
  - "Download CSV" button is enabled (do not click; CSV content is vitest-covered).

- [ ] **Step 5.5: Completed-state check.** Via `evaluate_script`, mark the matched session ended:
```javascript
() => {
  const sessions = JSON.parse(localStorage.getItem("aerele-proctor-demo-sessions") || "[]");
  for (const s of sessions) if (s.session_id === "s6-demo-taken-1") s.status = "ended";
  localStorage.setItem("aerele-proctor-demo-sessions", JSON.stringify(sessions));
  return "ended";
}
```
Click **Refresh**. Expected: Taken **1**, In progress **0**, Completed **1**, Not taken **2**.

- [ ] **Step 5.6: Evidence.** Take a screenshot of the full Attendance tab (the Step-5.4 or 5.5 state) and save it as `/home/karthi/arogara/proctor/night-run/evidence/s6-attendance-demo.png`. Visually inspect it yourself before counting this step done (counts readable, table populated).

- [ ] **Step 5.7: Cleanup.** `evaluate_script`: `() => { localStorage.removeItem("aerele-proctor-demo-roster"); localStorage.removeItem("aerele-proctor-demo-sessions"); return "clean"; }` — then stop the dev server. (If other night-run items are mid-flight with their own demo state, only remove these two keys, never `localStorage.clear()`.)

- [ ] **Step 5.8: Commit**

```bash
cd /home/karthi/arogara/proctor && git add night-run/evidence/s6-attendance-demo.png && git commit -m "S6: demo-mode browser integration evidence for the Attendance tab

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
(If Steps 5.2–5.5 surfaced fixes, include the fixed source files in this commit with an amended message describing the fix.)

---

## Done bar (MORNING-NOTES §Process)

- All 10 backend tests + 9 vitest tests green; full backend + frontend suites green; `npm run build` clean.
- Browser-integration verified in demo mode with screenshot evidence committed.
- Every task committed locally; **nothing pushed**.
- Report to the coordinator for the MORNING-NOTES entry: judgment calls = pending/locked count as "taken"; no auto-poll; absentee rows exclude email; new tab (vs a Live-stats section).
