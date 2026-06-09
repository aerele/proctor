# S5 — Dynamic exam time + "End now" — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-06-09-s5-dynamic-time-end-now-design.md` — read it first.

**Goal:** Admin extends/shortens the live exam end time or force-ends the exam for everyone; students see a skew-corrected countdown that updates within one heartbeat (≤15 s), with change notices and a time-up state — no reload.

**Architecture:** Backend = `end_at`+`server_now` added to start/resume/heartbeat/stats responses + one new route `POST /api/admin/exam-time` (merge-writes ONLY the end-time fields; `end_now` force-ends all non-ended sessions in the contest scope, reusing the existing end semantics + live-slot release). Frontend = pure `examTime.ts` math module (vitest), `onExamTimeChange` heartbeat callback in `useProctorRecorder`, countdown/notice/time-up in `StudentApp`+`TimerBar`, and an `ExamTimeCard` on the admin Live stats view fed by the existing 5 s stats poll. Demo branches in `api.ts` make the whole loop work offline.

**Conventions (match the repo exactly):** backend `node:test` + env-before-import + unique `?examtime` cache-buster import + pasted fake Firestore/Storage + `__setClientsForTest` (NO helpers.mjs); frontend vitest for pure logic only; demo-mode branches in `api.ts`. **Commits are LOCAL only — NEVER push.**

**IMPORTANT — parallel-build safety:** S2/S3/S4 agents may have edited `handler.mjs`, `api.ts`, `types.ts`, `App.tsx` before you run. Anchors below were verified against the 2026-06-09 tree; if an anchor moved, find the equivalent location by the quoted text — do NOT duplicate routes/consts/fields. Specifically: do NOT touch `adminSaveSettings`, `publicSettings`, `execRun`, `execSubmit` (S2/S3 edit those), and never modify `frontend/src/coding/*`, `backend/src/judge0Adapter.mjs`, `backend/src/problems.mjs`, or existing test files.

---

## File structure

**Backend:**
- Create `backend/test/examTime.test.mjs`.
- Modify `backend/src/handler.mjs` — `startResponse` + `recordHeartbeat` + `adminStats` gain `end_at`/`server_now`; new `adminExamTime` + `endAllLiveSessions` + 1 route.

**Frontend:**
- Create `frontend/src/examTime.ts`, `frontend/src/examTime.test.ts`.
- Modify `frontend/src/types.ts` — `end_at`/`server_now` on `SessionStartResponse`, `HeartbeatResponse`, `AdminStatsResponse`; new `ExamTimeRequest`/`ExamTimeResponse`.
- Modify `frontend/src/api.ts` — demo `end_at` plumbing + new `adjustExamTime` (with demo branch).
- Modify `frontend/src/useProctorRecorder.ts` — `onExamTimeChange` callback.
- Modify `frontend/src/App.tsx` — student countdown/notice/time-up + `TimerBar` props; admin `ExamTimeCard` + wiring.

---

## Task 1: Backend — `end_at` + `server_now` on start/resume/heartbeat responses

**Files:** Create `backend/test/examTime.test.mjs`; modify `backend/src/handler.mjs`.

- [ ] **Step 1.1: Write the failing tests.** Create `backend/test/examTime.test.mjs` with EXACTLY this content:

```javascript
// backend/test/examTime.test.mjs — S5: dynamic exam time + end-now.
import { test } from "node:test";
import assert from "node:assert/strict";

// Env MUST be set before importing the handler (it reads env at module load).
// Unique collection names + the ?examtime cache-buster give this file a fresh
// module instance independent of the other test files.
process.env.EVIDENCE_BUCKET = "examtime-bucket";
process.env.SESSION_COLLECTION = "examtime_sessions";
process.env.SETTINGS_COLLECTION = "examtime_settings";
process.env.ALERTS_COLLECTION = "examtime_alerts";
process.env.LIVE_LOCK_COLLECTION = "examtime_live_locks";
process.env.ADMIN_PASSWORD = "examtime-admin-pass";

const handler = await import("../src/handler.mjs?examtime");
const { api, __setClientsForTest } = handler;

// Inline req/res mocks + fakes, copied from phase2.test.mjs / exec.test.mjs
// (NO helpers.mjs — each test file pastes its own).
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

// ---- Shared helpers for this file ------------------------------------------

const ADMIN = { "x-admin-password": "examtime-admin-pass" };

function isoMinutesFromNow(minutes) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function freshFakes() {
  const firestore = makeFakeFirestore();
  const storage = makeFakeStorage();
  __setClientsForTest({ firestore, storage });
  return { firestore, storage };
}

// Seed the active settings doc with an OPEN window (started 60 min ago, ends in
// 60 min) plus extra fields a merge-write must preserve (S2 adds rooms etc.).
async function seedSettings(firestore, overrides = {}) {
  const item = {
    start_at: isoMinutesFromNow(-60),
    end_at: isoMinutesFromNow(60),
    contest_url: "https://www.hackerrank.com/contests/kec-2026",
    contest_slug: "kec-2026",
    rooms: ["Lab A-1"],
    updated_at: new Date().toISOString(),
    ...overrides
  };
  await firestore.collection(process.env.SETTINGS_COLLECTION).doc("active").set(item);
  return item;
}

// ---- Task 1: end_at + server_now on start / resume / heartbeat -------------

test("POST /api/session/start response carries end_at + server_now", async () => {
  const { firestore } = freshFakes();
  const seeded = await seedSettings(firestore);
  const res = await call(makeReq({ method: "POST", path: "/api/session/start", body: {
    hackerrank_username: "alice", name: "Alice", roll_number: "R1",
    email: "a@example.com", consent_accepted: true
  } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.end_at, seeded.end_at);
  assert.ok(Number.isFinite(Date.parse(res.body.server_now)));
});

test("POST /api/session/resume response carries end_at + server_now", async () => {
  const { firestore } = freshFakes();
  const seeded = await seedSettings(firestore);
  await firestore.collection(process.env.SESSION_COLLECTION).doc("s1").set({
    session_id: "s1", status: "active", username_norm: "alice",
    contest_slug: "kec-2026", storage_prefix: "contests/kec-2026/sessions/alice/s1/"
  });
  const res = await call(makeReq({ method: "POST", path: "/api/session/resume", body: { session_id: "s1" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.end_at, seeded.end_at);
  assert.ok(Number.isFinite(Date.parse(res.body.server_now)));
});

test("POST /api/heartbeat response carries end_at + server_now (the student's live channel)", async () => {
  const { firestore } = freshFakes();
  const seeded = await seedSettings(firestore);
  // No start_ip/current_ip on the seed → heartbeat sees no IP change (no alert path).
  await firestore.collection(process.env.SESSION_COLLECTION).doc("s1").set({
    session_id: "s1", status: "active", username_norm: "alice",
    contest_slug: "kec-2026", storage_prefix: "contests/kec-2026/sessions/alice/s1/"
  });
  const res = await call(makeReq({ method: "POST", path: "/api/heartbeat", body: {
    session_id: "s1", recording_state: "combined:recording;screen:recording", visibility_state: "visible"
  } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "active");
  assert.equal(res.body.end_at, seeded.end_at);
  assert.ok(Number.isFinite(Date.parse(res.body.server_now)));
});
```

- [ ] **Step 1.2: Run — expect the new assertions to FAIL** (`end_at` is `undefined`):

```bash
cd /home/karthi/arogara/proctor/backend && node --test test/examTime.test.mjs
```

Expected: 3 tests, **3 fail** with `AssertionError ... undefined !== '<ISO date>'` on the `end_at` assertions.

- [ ] **Step 1.3: Implement** in `backend/src/handler.mjs` — two edits:

**(a)** In `startResponse` (the function whose comment reads `// Shared start/resume payload so the browser always gets the same shape whether`), replace:

```javascript
    upload_config: uploadConfig,
    heartbeat_interval_seconds: 15
  };
}
```

with:

```javascript
    upload_config: uploadConfig,
    heartbeat_interval_seconds: 15,
    // S5: authoritative exam end time + the server clock at response time, so
    // the client shows a skew-corrected countdown from the very first response.
    end_at: settings?.end_at || "",
    server_now: new Date().toISOString()
  };
}
```

**(b)** In `recordHeartbeat`, replace the final return line:

```javascript
  // B1: surface the session lifecycle status so the recorder can self-stop if a
  // proctor locked/ended the session (requireWritableSession already 403/409s a
  // non-active session, but an active heartbeat returns the live status too).
  return { ok: true, status: session.status || "active", start_ip: startIp, current_ip: currentIp, ip_changed: ipChanged, newly_changed: newlyChanged };
```

with:

```javascript
  // B1: surface the session lifecycle status so the recorder can self-stop if a
  // proctor locked/ended the session (requireWritableSession already 403/409s a
  // non-active session, but an active heartbeat returns the live status too).
  // S5: ALSO surface the current exam end time + server clock. The heartbeat is
  // the student's only live channel (15 s interval), so an admin's end-time
  // change reaches every student within one interval — no reload. Costs one
  // extra settings read per heartbeat (the same doc the start gate reads).
  const settings = await getSettings();
  return { ok: true, status: session.status || "active", start_ip: startIp, current_ip: currentIp, ip_changed: ipChanged, newly_changed: newlyChanged, end_at: settings?.end_at || "", server_now: now };
```

- [ ] **Step 1.4: Run — expect PASS:**

```bash
cd /home/karthi/arogara/proctor/backend && node --test test/examTime.test.mjs
```

Expected: `tests 3` / `pass 3` / `fail 0`.

- [ ] **Step 1.5: Full backend suite still green** (additive fields must not break phase2/phase2b/exec/etc.):

```bash
cd /home/karthi/arogara/proctor/backend && npm test
```

Expected: all test files pass, `fail 0`.

- [ ] **Step 1.6: Commit (LOCAL only — never push):**

```bash
cd /home/karthi/arogara/proctor && git add backend/src/handler.mjs backend/test/examTime.test.mjs && git commit -m "S5: exam end_at + server_now on session start/resume + heartbeat responses

The 15s heartbeat is the student's live channel; carrying the current
end time on it (plus the start/resume bootstrap) lets a proctor's live
time change reach every student within one interval, skew-corrected
against the server clock.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: Backend — `POST /api/admin/exam-time` (set / extend / end-now) + stats `end_at`

**Files:** Modify `backend/test/examTime.test.mjs`, `backend/src/handler.mjs`.

- [ ] **Step 2.1: Append the failing tests** to the END of `backend/test/examTime.test.mjs`:

```javascript
// ---- Task 2: POST /api/admin/exam-time + stats end_at -----------------------

test("POST /api/admin/exam-time validation: admin auth, configured schedule, exactly-one field, sane values", async () => {
  const { firestore } = freshFakes();

  // 401 without the admin password
  const noAuth = await call(makeReq({ method: "POST", path: "/api/admin/exam-time", body: { end_now: true } }));
  assert.equal(noAuth.statusCode, 401);

  // 400 when the schedule was never configured
  const unconfigured = await call(makeReq({ method: "POST", path: "/api/admin/exam-time", headers: ADMIN, body: { end_now: true } }));
  assert.equal(unconfigured.statusCode, 400);

  await seedSettings(firestore);
  // exactly ONE of the three fields
  const none = await call(makeReq({ method: "POST", path: "/api/admin/exam-time", headers: ADMIN, body: {} }));
  assert.equal(none.statusCode, 400);
  const two = await call(makeReq({ method: "POST", path: "/api/admin/exam-time", headers: ADMIN, body: { end_now: true, extend_minutes: 5 } }));
  assert.equal(two.statusCode, 400);
  // bad values
  const badIso = await call(makeReq({ method: "POST", path: "/api/admin/exam-time", headers: ADMIN, body: { end_at: "not-a-date" } }));
  assert.equal(badIso.statusCode, 400);
  const zero = await call(makeReq({ method: "POST", path: "/api/admin/exam-time", headers: ADMIN, body: { extend_minutes: 0 } }));
  assert.equal(zero.statusCode, 400);
  const falseEnd = await call(makeReq({ method: "POST", path: "/api/admin/exam-time", headers: ADMIN, body: { end_now: false } }));
  assert.equal(falseEnd.statusCode, 400);
  // window inversion: new end before start
  const beforeStart = await call(makeReq({ method: "POST", path: "/api/admin/exam-time", headers: ADMIN, body: { end_at: isoMinutesFromNow(-120) } }));
  assert.equal(beforeStart.statusCode, 400);
});

test("POST /api/admin/exam-time {end_at}: sets the new end WITHOUT clobbering other settings fields (merge-write)", async () => {
  const { firestore } = freshFakes();
  await seedSettings(firestore);
  const newEnd = isoMinutesFromNow(120);
  const res = await call(makeReq({ method: "POST", path: "/api/admin/exam-time", headers: ADMIN, body: { end_at: newEnd } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.end_at, newEnd);
  assert.equal(res.body.ended_count, 0);
  assert.ok(Number.isFinite(Date.parse(res.body.server_now)));
  const stored = firestore._collections.get(process.env.SETTINGS_COLLECTION).get("active");
  assert.equal(stored.end_at, newEnd);
  assert.ok(stored.end_at_updated_at);
  // merge:true preserved everything else (incl. fields other features add)
  assert.equal(stored.contest_url, "https://www.hackerrank.com/contests/kec-2026");
  assert.deepEqual(stored.rooms, ["Lab A-1"]);
  assert.equal(stored.contest_slug, "kec-2026");
  assert.equal(stored.start_at !== undefined, true);
});

test("POST /api/admin/exam-time {extend_minutes}: positive extends, negative shortens, never inverts the window", async () => {
  const { firestore } = freshFakes();
  const seeded = await seedSettings(firestore);

  const plus = await call(makeReq({ method: "POST", path: "/api/admin/exam-time", headers: ADMIN, body: { extend_minutes: 30 } }));
  assert.equal(plus.statusCode, 200);
  assert.equal(Date.parse(plus.body.end_at), Date.parse(seeded.end_at) + 30 * 60_000);

  // deltas compose against the CURRENT (already-extended) end
  const minus = await call(makeReq({ method: "POST", path: "/api/admin/exam-time", headers: ADMIN, body: { extend_minutes: -45 } }));
  assert.equal(minus.statusCode, 200);
  assert.equal(Date.parse(minus.body.end_at), Date.parse(seeded.end_at) - 15 * 60_000);

  // a shorten that would land before start_at → 400, end unchanged
  const invert = await call(makeReq({ method: "POST", path: "/api/admin/exam-time", headers: ADMIN, body: { extend_minutes: -10000 } }));
  assert.equal(invert.statusCode, 400);
  const stored = firestore._collections.get(process.env.SETTINGS_COLLECTION).get("active");
  assert.equal(Date.parse(stored.end_at), Date.parse(seeded.end_at) - 15 * 60_000);
});

test("POST /api/admin/exam-time {end_now}: ends every non-ended session in the contest scope, releases live locks", async () => {
  const { firestore } = freshFakes();
  await seedSettings(firestore);
  const sessions = firestore.collection(process.env.SESSION_COLLECTION);
  await sessions.doc("s-active").set({ session_id: "s-active", status: "active", username_norm: "alice", contest_slug: "kec-2026" });
  await sessions.doc("s-locked").set({ session_id: "s-locked", status: "locked", username_norm: "bob", contest_slug: "kec-2026" });
  await sessions.doc("s-pending").set({ session_id: "s-pending", status: "pending_approval", username_norm: "cara", contest_slug: "kec-2026" });
  await sessions.doc("s-done").set({ session_id: "s-done", status: "ended", username_norm: "dan", contest_slug: "kec-2026" });
  await sessions.doc("s-other").set({ session_id: "s-other", status: "active", username_norm: "eve", contest_slug: "other-contest" });
  // alice's live-slot lock must be released so a legitimate later start works
  await firestore.collection(process.env.LIVE_LOCK_COLLECTION).doc("live:alice:kec-2026").set({
    username_norm: "alice", contest_slug: "kec-2026", session_id: "s-active", acquired_at: new Date().toISOString()
  });

  const before = Date.now();
  const res = await call(makeReq({ method: "POST", path: "/api/admin/exam-time", headers: ADMIN, body: { end_now: true } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.ended_count, 3);
  // end_at moved to ~now
  const endMs = Date.parse(res.body.end_at);
  assert.ok(endMs >= before && endMs <= Date.now());

  const store = firestore._collections.get(process.env.SESSION_COLLECTION);
  for (const id of ["s-active", "s-locked", "s-pending"]) {
    assert.equal(store.get(id).status, "ended", `${id} force-ended`);
    assert.equal(store.get(id).ended_reason, "exam_ended_by_admin");
    assert.ok(store.get(id).ended_at);
  }
  assert.equal(store.get("s-done").ended_reason, undefined, "already-ended session untouched");
  assert.equal(store.get("s-other").status, "active", "other contest untouched");
  assert.equal(firestore._collections.get(process.env.LIVE_LOCK_COLLECTION).has("live:alice:kec-2026"), false, "live slot released");
});

test("GET /api/admin/stats carries end_at + server_now for the console exam-time card", async () => {
  const { firestore } = freshFakes();
  const seeded = await seedSettings(firestore);
  const res = await call(makeReq({ method: "GET", path: "/api/admin/stats", headers: ADMIN }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.end_at, seeded.end_at);
  assert.ok(Number.isFinite(Date.parse(res.body.server_now)));
});
```

- [ ] **Step 2.2: Run — expect the new tests to FAIL** (exam-time → 404 route not found; stats `end_at` undefined):

```bash
cd /home/karthi/arogara/proctor/backend && node --test test/examTime.test.mjs
```

Expected: `tests 8`, the 3 Task-1 tests pass, the 5 new ones fail (404 / undefined).

- [ ] **Step 2.3: Implement** in `backend/src/handler.mjs` — three edits:

**(a)** In the route table inside `api`, immediately AFTER the line

```javascript
    if (req.method === "GET" && path === "/api/admin/stats") return send(res, 200, await adminStats(req));
```

add:

```javascript
    if (req.method === "POST" && path === "/api/admin/exam-time") return send(res, 200, await adminExamTime(req));
```

**(b)** In `adminStats`, replace the final return:

```javascript
  return {
    contest_slug: contestSlug ? String(contestSlug) : null,
    room: room || null,
    stats,
    rooms,
    disconnected_staleness_ms: DISCONNECTED_STALENESS_MS
  };
}
```

with:

```javascript
  // S5: the console exam-time card rides on the existing 5 s stats poll, so the
  // current end time + a server clock stamp come back with every poll.
  const settings = await getSettings();
  return {
    contest_slug: contestSlug ? String(contestSlug) : null,
    room: room || null,
    stats,
    rooms,
    disconnected_staleness_ms: DISCONNECTED_STALENESS_MS,
    end_at: settings?.end_at || "",
    server_now: new Date().toISOString()
  };
}
```

**(c)** Immediately AFTER the closing brace of `adminStats` (and BEFORE the comment `// Normalize a ?room query param to the same sanitized form rooms are stored in,`), insert:

```javascript
// ---- S5: dynamic exam time + end-now (admin) -------------------------------
//
// POST /api/admin/exam-time — live control over the exam END time. Deliberately
// NOT part of adminSaveSettings: a merge-write touches ONLY the end-time fields,
// so settings keys other features own (rooms, gate flags, contest_url) are never
// clobbered, and the endpoint stays a single, small, testable concern.
//
// Body carries EXACTLY ONE of:
//   { end_at: "<ISO>" }     → set an absolute new end time
//   { extend_minutes: N }   → shift the CURRENT end by N minutes (negative shortens)
//   { end_now: true }       → end_at := now AND force-end every non-ended session
//                             in the current contest scope. Their next heartbeat
//                             409s session_ended → the recorder self-stops (B1).
//
// Students pick a new end time up via the heartbeat response (≤15 s) — no
// reload. A plain end_at/extend change NEVER force-ends sessions: recording
// keeps running so candidates end their own test (manifest upload intact);
// end_now is the explicit hard stop.
async function adminExamTime(req) {
  requireAdmin(req);
  const body = parseBody(req);

  const provided = ["end_at", "extend_minutes", "end_now"].filter(
    (key) => body[key] !== undefined && body[key] !== null && body[key] !== ""
  );
  if (provided.length !== 1) {
    return badRequest("Provide exactly one of end_at, extend_minutes, end_now");
  }
  const field = provided[0];

  const settings = await getSettings();
  if (!settings?.start_at || !settings?.end_at) {
    return badRequest("Proctoring schedule is not configured yet.");
  }
  const startMs = Date.parse(settings.start_at);
  const currentEndMs = Date.parse(settings.end_at);
  const now = new Date().toISOString();

  let newEndMs;
  if (field === "end_now") {
    if (body.end_now !== true) return badRequest("end_now must be true");
    newEndMs = Date.parse(now);
  } else if (field === "end_at") {
    newEndMs = Date.parse(String(body.end_at));
    if (!Number.isFinite(newEndMs)) return badRequest("end_at must be a valid ISO 8601 date");
  } else {
    const delta = Number(body.extend_minutes);
    if (!Number.isFinite(delta) || delta === 0) return badRequest("extend_minutes must be a non-zero number");
    if (!Number.isFinite(currentEndMs)) return badRequest("Stored end time is invalid; set an absolute end_at instead.");
    newEndMs = currentEndMs + delta * 60_000;
  }

  // Window sanity: the end must stay after the start (also rejects an end-now
  // pressed before the exam ever started).
  if (!Number.isFinite(startMs) || newEndMs <= startMs) {
    return badRequest("End time must be after the start time.");
  }
  const newEndAt = new Date(newEndMs).toISOString();

  // merge:true → ONLY the end-time fields change; everything else on the
  // settings doc survives (parallel features add their own keys to this doc).
  await settingsRef().set({ end_at: newEndAt, end_at_updated_at: now, updated_at: now }, { merge: true });

  let endedCount = 0;
  if (field === "end_now") {
    const contestSlug = settings.contest_slug || contestSlugFromUrl(settings.contest_url);
    endedCount = await endAllLiveSessions(contestSlug, now);
  }

  return { ok: true, start_at: settings.start_at, end_at: newEndAt, server_now: now, ended_count: endedCount };
}

// S5: end every non-ended session in the given contest scope ("" matches
// legacy/no-contest sessions). Mirrors applySessionAction("end") — status:ended
// + ended_at + live-slot release — with a distinct ended_reason for the audit
// trail, applied with bounded concurrency so an 800-session end-now never fans
// out unbounded. Returns the number of sessions ended.
async function endAllLiveSessions(contestSlug, now) {
  const snapshot = await firestore
    .collection(SESSION_COLLECTION)
    .where("contest_slug", "==", contestSlug || "")
    .limit(SESSIONS_QUERY_LIMIT)
    .get();
  const live = snapshot.docs.map((doc) => doc.data()).filter((doc) => doc.status !== "ended");
  await mapWithConcurrency(live, 12, async (session) => {
    await sessionRef(session.session_id).update({
      status: "ended", ended_at: now, updated_at: now, ended_reason: "exam_ended_by_admin"
    });
    await releaseLiveSlot(session);
  });
  return live.length;
}
```

- [ ] **Step 2.4: Run — expect PASS:**

```bash
cd /home/karthi/arogara/proctor/backend && node --test test/examTime.test.mjs
```

Expected: `tests 8` / `pass 8` / `fail 0`.

- [ ] **Step 2.5: Full backend suite:**

```bash
cd /home/karthi/arogara/proctor/backend && npm test
```

Expected: all files pass, `fail 0`.

- [ ] **Step 2.6: Commit:**

```bash
cd /home/karthi/arogara/proctor && git add backend/src/handler.mjs backend/test/examTime.test.mjs && git commit -m "S5: POST /api/admin/exam-time — set/extend end time + end-now force-end

Merge-writes ONLY the end-time fields on the settings doc (never
clobbers keys other features own). end_now also force-ends every
non-ended session in the contest scope (ended_reason
exam_ended_by_admin, live slots released, bounded concurrency).
adminStats now carries end_at + server_now for the console card.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: Frontend — pure exam-time math module (vitest)

**Files:** Create `frontend/src/examTime.ts`, `frontend/src/examTime.test.ts`.

- [ ] **Step 3.1: Write the failing tests.** Create `frontend/src/examTime.test.ts`:

```typescript
// frontend/src/examTime.test.ts — pure exam-time math (S5).
import { describe, expect, it } from "vitest";
import { classifyEndAtChange, computeClockSkewMs, formatRemaining, remainingMs } from "./examTime";

describe("computeClockSkewMs", () => {
  it("is server minus client", () => {
    expect(computeClockSkewMs("2026-06-09T10:00:10.000Z", Date.parse("2026-06-09T10:00:00.000Z"))).toBe(10_000);
    expect(computeClockSkewMs("2026-06-09T09:59:55.000Z", Date.parse("2026-06-09T10:00:00.000Z"))).toBe(-5_000);
  });
  it("degrades to 0 when the server stamp is missing or invalid", () => {
    expect(computeClockSkewMs(undefined, 123)).toBe(0);
    expect(computeClockSkewMs("", 123)).toBe(0);
    expect(computeClockSkewMs("garbage", 123)).toBe(0);
  });
});

describe("remainingMs", () => {
  const now = Date.parse("2026-06-09T10:00:00.000Z");
  it("returns ms until end_at on the server clock", () => {
    expect(remainingMs("2026-06-09T11:00:00.000Z", now, 0)).toBe(3_600_000);
    // client clock 10 s behind the server → less real time left
    expect(remainingMs("2026-06-09T11:00:00.000Z", now, 10_000)).toBe(3_590_000);
  });
  it("goes negative when time is up", () => {
    expect(remainingMs("2026-06-09T09:59:00.000Z", now, 0)).toBe(-60_000);
  });
  it("returns null when end_at is missing or invalid (no countdown shown)", () => {
    expect(remainingMs(undefined, now, 0)).toBeNull();
    expect(remainingMs("", now, 0)).toBeNull();
    expect(remainingMs("garbage", now, 0)).toBeNull();
  });
});

describe("formatRemaining", () => {
  it("formats H:MM:SS", () => {
    expect(formatRemaining(3_661_000)).toBe("1:01:01");
    expect(formatRemaining(59_000)).toBe("0:00:59");
    expect(formatRemaining(3_600_000 * 11 + 5 * 60_000 + 9_000)).toBe("11:05:09");
  });
  it("clamps at zero (never shows negative time)", () => {
    expect(formatRemaining(0)).toBe("0:00:00");
    expect(formatRemaining(-5_000)).toBe("0:00:00");
  });
  it("floors sub-second remainders", () => {
    expect(formatRemaining(1_999)).toBe("0:00:01");
  });
});

describe("classifyEndAtChange", () => {
  it("initial when nothing was shown before", () => {
    expect(classifyEndAtChange(undefined, "2026-06-09T11:00:00.000Z")).toBe("initial");
    expect(classifyEndAtChange("", "2026-06-09T11:00:00.000Z")).toBe("initial");
  });
  it("unchanged for the same instant or an unusable next value", () => {
    expect(classifyEndAtChange("2026-06-09T11:00:00.000Z", "2026-06-09T11:00:00.000Z")).toBe("unchanged");
    expect(classifyEndAtChange("2026-06-09T11:00:00.000Z", "")).toBe("unchanged");
    expect(classifyEndAtChange("2026-06-09T11:00:00.000Z", "garbage")).toBe("unchanged");
  });
  it("extended / shortened by comparing instants", () => {
    expect(classifyEndAtChange("2026-06-09T11:00:00.000Z", "2026-06-09T11:30:00.000Z")).toBe("extended");
    expect(classifyEndAtChange("2026-06-09T11:00:00.000Z", "2026-06-09T10:45:00.000Z")).toBe("shortened");
  });
});
```

- [ ] **Step 3.2: Run — expect FAIL** (module does not exist):

```bash
cd /home/karthi/arogara/proctor/frontend && npx vitest run src/examTime.test.ts
```

Expected: failure to resolve `./examTime`.

- [ ] **Step 3.3: Implement.** Create `frontend/src/examTime.ts`:

```typescript
// Pure exam-time math for the student countdown and the admin remaining-time
// display (S5). The SERVER is the time authority: every payload that carries
// end_at also carries server_now; remaining time is computed against the server
// clock via a skew offset so a wrong local clock cannot fake more (or less)
// exam time. No React, no I/O — unit-tested with vitest.

export type EndAtChange = "initial" | "unchanged" | "extended" | "shortened";

// Server-minus-client clock skew in ms. 0 when the server stamp is missing or
// unparseable (degrades to trusting the local clock).
export function computeClockSkewMs(serverNowIso: string | undefined, clientNowMs: number): number {
  if (!serverNowIso) return 0;
  const serverMs = Date.parse(serverNowIso);
  if (!Number.isFinite(serverMs)) return 0;
  return serverMs - clientNowMs;
}

// Milliseconds until end_at on the SERVER clock (clientNow + skew). null when
// end_at is missing/invalid (no countdown shown). Negative once time is up.
export function remainingMs(endAtIso: string | undefined, clientNowMs: number, skewMs: number): number | null {
  if (!endAtIso) return null;
  const endMs = Date.parse(endAtIso);
  if (!Number.isFinite(endMs)) return null;
  return endMs - (clientNowMs + skewMs);
}

// "H:MM:SS" with unpadded hours, clamped at zero so an overrun never renders a
// negative time.
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

// Classify a newly-received end_at against the one already shown, so the UI can
// announce "extended" / "shortened" exactly once per change. An unusable next
// value is "unchanged" (keep what we have); a first usable value is "initial".
export function classifyEndAtChange(prevEndAt: string | undefined, nextEndAt: string | undefined): EndAtChange {
  const prevMs = prevEndAt ? Date.parse(prevEndAt) : NaN;
  const nextMs = nextEndAt ? Date.parse(nextEndAt) : NaN;
  if (!Number.isFinite(nextMs)) return "unchanged";
  if (!Number.isFinite(prevMs)) return "initial";
  if (nextMs === prevMs) return "unchanged";
  return nextMs > prevMs ? "extended" : "shortened";
}
```

- [ ] **Step 3.4: Run — expect PASS:**

```bash
cd /home/karthi/arogara/proctor/frontend && npx vitest run src/examTime.test.ts
```

Expected: 4 suites, all tests pass.

- [ ] **Step 3.5: Commit:**

```bash
cd /home/karthi/arogara/proctor && git add frontend/src/examTime.ts frontend/src/examTime.test.ts && git commit -m "S5: pure exam-time math (clock skew, remaining, H:MM:SS, change classification)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: Frontend — types + api plumbing (`adjustExamTime`, demo branches)

**Files:** Modify `frontend/src/types.ts`, `frontend/src/api.ts`.

There are no unit tests for `api.ts` (repo convention: vitest covers pure logic only); validation for this task = the TypeScript build.

- [ ] **Step 4.1: types.ts — four edits.**

**(a)** In `SessionStartResponse`, after the line `heartbeat_interval_seconds: number;` add:

```typescript
  // S5: authoritative exam end time + the server clock at response time (for
  // client skew correction). Empty/absent when no schedule is configured or
  // the backend predates S5.
  end_at?: string;
  server_now?: string;
```

**(b)** In `HeartbeatResponse`, after the line `newly_changed?: boolean;` add:

```typescript
  // S5: current exam end time + server clock — the live update channel.
  end_at?: string;
  server_now?: string;
```

**(c)** In `AdminStatsResponse`, after the line `disconnected_staleness_ms?: number;` add:

```typescript
  // S5: current exam end time + server clock for the console exam-time card.
  end_at?: string;
  server_now?: string;
```

**(d)** Immediately AFTER the closing `};` of `AdminStatsResponse`, add:

```typescript
// S5: POST /api/admin/exam-time — live end-time control. EXACTLY ONE field set:
// an absolute end_at, a signed extend_minutes delta, or end_now (force-end).
export type ExamTimeRequest = {
  end_at?: string;
  extend_minutes?: number;
  end_now?: true;
};

export type ExamTimeResponse = {
  ok: boolean;
  start_at: string;
  end_at: string;
  server_now: string;
  // Sessions force-ended by end_now (0 for plain time changes).
  ended_count: number;
};
```

- [ ] **Step 4.2: api.ts — four edits.**

**(a)** Add `ExamTimeRequest,` and `ExamTimeResponse,` to the existing `import type { ... } from "./types";` list (alphabetical position near `HeartbeatResponse` — exact order does not matter).

**(b)** In `demoSessionResponse`, replace:

```typescript
    heartbeat_interval_seconds: 15
  };
}
```

with:

```typescript
    heartbeat_interval_seconds: 15,
    // S5: demo sessions read the exam end time from the demo settings store.
    end_at: getDemoSettings()?.end_at || "",
    server_now: new Date().toISOString()
  };
}
```

**(c)** In the demo branch of `heartbeat`, replace:

```typescript
    return { ok: true, status: session?.status ?? "active", start_ip: "demo.local", current_ip: "demo.local", ip_changed: false, newly_changed: false };
```

with:

```typescript
    // S5: mirror the real heartbeat — carry the current demo end time so the
    // student countdown updates live when the demo admin changes it.
    return { ok: true, status: session?.status ?? "active", start_ip: "demo.local", current_ip: "demo.local", ip_changed: false, newly_changed: false, end_at: getDemoSettings()?.end_at || "", server_now: new Date().toISOString() };
```

**(d)** In the demo branch of `fetchAdminStats`, replace:

```typescript
    return { contest_slug: contestSlug || null, room: room || null, stats, rooms: demoRooms, disconnected_staleness_ms: 45000 };
```

with:

```typescript
    return { contest_slug: contestSlug || null, room: room || null, stats, rooms: demoRooms, disconnected_staleness_ms: 45000, end_at: getDemoSettings()?.end_at || "", server_now: new Date().toISOString() };
```

**(e)** Immediately AFTER the closing brace of the `sessionAction` function (before the comment `// Mirror the backend applySessionAction semantics against the demo store`), add:

```typescript
// S5: live exam-time control — set an absolute end_at, shift it by
// extend_minutes, or end_now (which also force-ends every live session). The
// demo branch mirrors the backend exactly: merge-update the demo settings, and
// for end_now mark every non-ended demo session ended so the demo heartbeat
// throws the same 409 session_ended the real backend would (B8 parity).
export async function adjustExamTime(password: string, body: ExamTimeRequest): Promise<ExamTimeResponse> {
  if (demoMode) {
    await wait(150);
    assertDemoAdmin(password);
    const settings = getDemoSettings();
    if (!settings?.start_at || !settings?.end_at) {
      throw new Error("Proctoring schedule is not configured yet.");
    }
    const now = new Date().toISOString();
    let newEndMs: number;
    if (body.end_now === true) {
      newEndMs = Date.parse(now);
    } else if (body.end_at) {
      newEndMs = Date.parse(body.end_at);
      if (!Number.isFinite(newEndMs)) throw new Error("end_at must be a valid ISO 8601 date");
    } else {
      const delta = Number(body.extend_minutes);
      if (!Number.isFinite(delta) || delta === 0) throw new Error("extend_minutes must be a non-zero number");
      newEndMs = Date.parse(settings.end_at) + delta * 60_000;
    }
    if (newEndMs <= Date.parse(settings.start_at)) {
      throw new Error("End time must be after the start time.");
    }
    const newEndAt = new Date(newEndMs).toISOString();
    window.localStorage.setItem(demoSettingsKey, JSON.stringify({ ...settings, end_at: newEndAt, updated_at: now }));
    let endedCount = 0;
    if (body.end_now === true) {
      for (const session of readDemoSessions()) {
        if (session.status !== "ended") {
          upsertDemoSession({ ...session, status: "ended", blocked_by_session_id: null });
          endedCount += 1;
        }
      }
    }
    return { ok: true, start_at: settings.start_at, end_at: newEndAt, server_now: now, ended_count: endedCount };
  }

  return request<ExamTimeResponse>("/api/admin/exam-time", {
    method: "POST",
    headers: { "x-admin-password": password },
    body: JSON.stringify(body)
  });
}
```

- [ ] **Step 4.3: Typecheck — expect PASS:**

```bash
cd /home/karthi/arogara/proctor/frontend && npm run lint
```

Expected: exit 0, no errors. Also re-run the vitest suite (`npx vitest run`) — still green.

- [ ] **Step 4.4: Commit:**

```bash
cd /home/karthi/arogara/proctor && git add frontend/src/types.ts frontend/src/api.ts && git commit -m "S5: exam-time API plumbing — types, adjustExamTime, demo end_at branches

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: Frontend student — heartbeat callback, countdown, change notice, time-up

**Files:** Modify `frontend/src/useProctorRecorder.ts`, `frontend/src/App.tsx`.

- [ ] **Step 5.1: useProctorRecorder.ts — two edits.**

**(a)** In `RecorderOptions`, after the line `onIpStatusChange?: (status: { startIp: string; currentIp: string; ipChanged: boolean; newlyChanged: boolean }) => void;` add:

```typescript
  // S5: every heartbeat echoes the authoritative exam end time + server clock;
  // the host updates its countdown so a proctor's live time change propagates
  // within one heartbeat interval (no reload).
  onExamTimeChange?: (info: { endAt: string; serverNow: string }) => void;
```

**(b)** In `startHeartbeat`, inside the `.then((response) => {` block, immediately BEFORE the comment `// B1: an active heartbeat reports the live status; if a proctor` add:

```typescript
        // S5: surface the current exam end time on every heartbeat.
        if (response.end_at) {
          options.onExamTimeChange?.({ endAt: response.end_at, serverNow: response.server_now ?? "" });
        }
```

- [ ] **Step 5.2: App.tsx — student-side edits (all inside `StudentApp` unless noted).**

**(a)** Imports — after the line `import { RecordingReview } from "./RecordingReview";` add:

```typescript
import { classifyEndAtChange, computeClockSkewMs, formatRemaining, remainingMs } from "./examTime";
```

**(b)** State — after the line `const [elapsedSeconds, setElapsedSeconds] = useState(0);` add:

```typescript
  // S5: authoritative exam end time + server-clock skew, fed by start/resume
  // responses and refreshed by every heartbeat (≤15 s — the existing student
  // polling channel). examEndAtRef mirrors examEndAt for the recorder-callback
  // closure (the recorder options are built once); timeUpAnnouncedRef makes the
  // time-up voice warning fire exactly once.
  const [examEndAt, setExamEndAt] = useState("");
  const [clockSkewMs, setClockSkewMs] = useState(0);
  const [examTimeNotice, setExamTimeNotice] = useState("");
  const examEndAtRef = useRef("");
  const timeUpAnnouncedRef = useRef(false);
```

**(c)** Helper — immediately BEFORE the comment `// Bring up the recorder for an active session. Shared by first-start and by` add:

```typescript
  // S5: apply a server-reported exam end time + clock stamp. Announces a
  // mid-exam change (extended/shortened) exactly once per change; the notice
  // stays visible until the next change. The first end_at received is silent.
  const applyExamTime = (endAt?: string, serverNow?: string) => {
    if (!endAt) return;
    setClockSkewMs(computeClockSkewMs(serverNow, Date.now()));
    const change = classifyEndAtChange(examEndAtRef.current, endAt);
    examEndAtRef.current = endAt;
    setExamEndAt(endAt);
    if (change !== "extended" && change !== "shortened") return;
    const at = new Date(endAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (change === "extended") {
      timeUpAnnouncedRef.current = false; // more time: a past "time is up" no longer holds
      setExamTimeNotice(`The proctor extended the exam — new end time ${at}.`);
    } else {
      setExamTimeNotice(`The proctor moved the exam end earlier — new end time ${at}.`);
      speakWarning("Attention: the exam end time has been moved earlier. Check the timer.");
    }
  };
```

**(d)** Wire the recorder — in `beginRecording`, inside the `createProctorRecorder({ ... })` options, immediately AFTER the full `onIpStatusChange: (ipStatus) => { ... },` block add:

```typescript
      // S5: heartbeat-delivered exam end time → live countdown update.
      onExamTimeChange: ({ endAt, serverNow }) => applyExamTime(endAt, serverNow),
```

**(e)** Seed from the bootstrap responses — three one-line insertions:
- In `start()`, immediately AFTER `window.localStorage.setItem(sessionStorageKey, session.session_id);` add:

```typescript
      applyExamTime(session.end_at, session.server_now);
```

- In `resumeRecording()`, immediately AFTER `session = await resumeSession(sessionConfig.session_id);` add:

```typescript
      applyExamTime(session.end_at, session.server_now);
```

- In `refreshStatus()`, immediately AFTER `const session = await resumeSession(sessionConfig.session_id);` add:

```typescript
      applyExamTime(session.end_at, session.server_now);
```

**(f)** Time-up announcement — immediately AFTER the elapsed-ticker effect (the `useEffect` whose body sets `setElapsedSeconds(...)` and whose dep list is `[recordingStartedAt, status]`), add:

```typescript
  // S5: announce "time is up" once when the countdown crosses zero while
  // recording. Soft enforcement by design: the recording continues so the
  // candidate ends their own test (manifest intact); the hard stop is the
  // admin's End-now (which 409s the heartbeat → B1 self-stop).
  useEffect(() => {
    if (status !== "recording" || !examEndAt) return;
    const check = () => {
      const left = remainingMs(examEndAt, Date.now(), clockSkewMs);
      if (left === null || left > 0 || timeUpAnnouncedRef.current) return;
      timeUpAnnouncedRef.current = true;
      speakWarning("Time is up. Please end your test now.");
      const event = createUiEvent("exam_time_up", { end_at: examEndAt });
      addEvent(event);
      if (sessionId) void sendEvents(sessionId, [event]);
    };
    check();
    const timer = window.setInterval(check, 1000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, examEndAt, clockSkewMs, sessionId]);
```

**(g)** Derived values — replace:

```typescript
  // gate === "form" (no session yet) or "running" (active session)
  const isFormStage = gate === "form" && status !== "recording" && status !== "ending";
```

with:

```typescript
  // gate === "form" (no session yet) or "running" (active session)
  const isFormStage = gate === "form" && status !== "recording" && status !== "ending";

  // S5: remaining time on the SERVER clock. Recomputed every render — the 1 s
  // elapsed ticker already re-renders while recording, so this stays live
  // without another interval. null (no end_at yet / old backend) → no countdown.
  const examRemainingMs = status === "recording" || status === "ending" ? remainingMs(examEndAt, Date.now(), clockSkewMs) : null;
  const examTimeUp = examRemainingMs !== null && examRemainingMs <= 0;
```

**(h)** Timer bar + banners — replace:

```tsx
      {status === "recording" || status === "ending" ? (
        <TimerBar status={status} elapsedSeconds={elapsedSeconds} startIp={startIp} currentIp={currentIp} ipChanged={ipChanged} />
      ) : null}
```

with:

```tsx
      {status === "recording" || status === "ending" ? (
        <TimerBar status={status} elapsedSeconds={elapsedSeconds} startIp={startIp} currentIp={currentIp} ipChanged={ipChanged} remainingLabel={examRemainingMs !== null ? formatRemaining(examRemainingMs) : null} timeUp={examTimeUp} />
      ) : null}
      {examTimeNotice && (status === "recording" || status === "ending") ? (
        <div className="mb-5 rounded-lg border border-accent/30 bg-accent/10 p-4 text-sm text-ink">{examTimeNotice}</div>
      ) : null}
      {examTimeUp && status === "recording" ? (
        <div className="mb-5 rounded-lg border border-danger/40 bg-danger/10 p-4">
          <p className="text-sm font-semibold text-danger">Time is up</p>
          <p className="mt-1 text-sm leading-6 text-ink">The exam has ended. Stop working now and end your test from this page — your recording continues until you end it.</p>
        </div>
      ) : null}
```

**(i)** `TimerBar` component (top-level in App.tsx) — replace the WHOLE existing `function TimerBar({ ... }) { ... }` with:

```tsx
function TimerBar({ status, elapsedSeconds, startIp, currentIp, ipChanged, remainingLabel, timeUp }: { status: SessionStatus; elapsedSeconds: number; startIp: string; currentIp: string; ipChanged: boolean; remainingLabel: string | null; timeUp: boolean }) {
  return (
    <div className={`sticky top-0 z-10 mb-5 rounded-lg border px-4 py-3 text-white shadow-subtle ${ipChanged || timeUp ? "border-danger/40 bg-danger" : "border-ink/10 bg-ink"}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <span className="text-sm font-semibold">{timeUp ? "Time is up — end your test now" : "Proctoring active"}</span>
          <div className="mt-1 flex flex-wrap gap-2 text-xs text-white/80">
            <span>Start IP: <span className="font-mono text-white">{startIp || "pending"}</span></span>
            <span>Current IP: <span className="font-mono text-white">{currentIp || startIp || "pending"}</span></span>
          </div>
        </div>
        <div className="flex items-center gap-5">
          {remainingLabel !== null ? (
            <span className="text-right">
              <span className="block text-[10px] uppercase tracking-wide text-white/70">Time left</span>
              <span className="font-mono text-lg font-semibold">{remainingLabel}</span>
            </span>
          ) : null}
          <span className="text-right">
            <span className="block text-[10px] uppercase tracking-wide text-white/70">Elapsed</span>
            <span className="font-mono text-lg font-semibold">{formatElapsed(elapsedSeconds)}</span>
          </span>
        </div>
        <span className="rounded-full border border-white/20 px-3 py-1 text-xs uppercase">{timeUp ? "time up" : ipChanged ? "ip changed" : status}</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 5.3: Typecheck + tests — expect PASS:**

```bash
cd /home/karthi/arogara/proctor/frontend && npm run lint && npx vitest run
```

Expected: exit 0, all vitest suites green.

- [ ] **Step 5.4: Commit:**

```bash
cd /home/karthi/arogara/proctor && git add frontend/src/useProctorRecorder.ts frontend/src/App.tsx && git commit -m "S5: student live countdown, end-time change notice, time-up state

Heartbeat-fed skew-corrected 'Time left' in the timer bar; spoken+visual
notice when the proctor moves the end time; red time-up bar+banner with
a single exam_time_up event. No new polling loop (reuses the 15s
heartbeat and the existing 1s elapsed ticker).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6: Frontend admin — Exam time card on Live stats

**Files:** Modify `frontend/src/App.tsx`.

- [ ] **Step 6.1: Edits (all in App.tsx).**

**(a)** Imports: add `adjustExamTime` to the existing `import { ... } from "./api";` list. Add `ExamTimeRequest` and `AdminStatsResponse` to the existing `import type { ... } from "./types";` list (if `AdminStatsResponse` is already imported, keep one occurrence).

**(b)** State — in `AdminApp`, after the line `const [statsLoading, setStatsLoading] = useState(false);` add:

```typescript
  // S5: exam-time card state. examEndAt/examSkewMs refresh from every stats
  // response (incl. the 5 s auto-poll), so another admin's change shows live.
  // endNowArmed = the two-click confirm for "End exam now".
  const [examEndAt, setExamEndAt] = useState("");
  const [examSkewMs, setExamSkewMs] = useState(0);
  const [examTimeBusy, setExamTimeBusy] = useState(false);
  const [endNowArmed, setEndNowArmed] = useState(false);
  const [examTimeInput, setExamTimeInput] = useState("");
```

**(c)** Helpers — immediately AFTER the closing brace of the `loadStats` function add:

```typescript
  // S5: capture the exam end time + clock skew from a stats response. Skew is
  // computed at receipt time (server_now vs local now) — recomputing later
  // against a stale stamp would drift.
  const captureExamTime = (response: AdminStatsResponse) => {
    if (response.end_at === undefined) return; // backend without S5 yet
    setExamEndAt(response.end_at);
    setExamSkewMs(computeClockSkewMs(response.server_now, Date.now()));
  };

  // S5: apply an exam-time change; outcomes surface through the existing
  // actionMessage banner, and stats reload so counts reflect an end-now.
  const runExamTime = async (body: ExamTimeRequest) => {
    setExamTimeBusy(true);
    setError("");
    setActionMessage("");
    try {
      const response = await adjustExamTime(password, body);
      setExamEndAt(response.end_at);
      setExamSkewMs(computeClockSkewMs(response.server_now, Date.now()));
      setEndNowArmed(false);
      setExamTimeInput("");
      setActionMessage(body.end_now
        ? `Exam ended — ${response.ended_count} live session(s) force-ended. Students see the end within ~15 seconds.`
        : `Exam end time set to ${new Date(response.end_at).toLocaleString()}. Students see it within ~15 seconds.`);
      await loadStats();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setExamTimeBusy(false);
    }
  };
```

**(d)** Feed the card from every stats fetch — there are THREE places that call `setStats(response.stats);` (the `loadStats` function, the first-load `useEffect`, and the auto-poll `tick`). In EACH of the three, add this line immediately after `setStats(response.stats);`:

```typescript
        captureExamTime(response);
```

(Indentation: match the surrounding lines. In `loadStats` the indent is 6 spaces; in the two effects it is 8.)

**(e)** Render — replace the stats-view block:

```tsx
      {view === "stats" ? (
        <StatsDashboard
          stats={stats}
          loading={statsLoading}
          onRefresh={() => loadStats()}
          rooms={rooms}
          room={alertFilters.room ?? ""}
          onRoomChange={(room) => {
            const next = { ...alertFilters, room: room || undefined };
            setAlertFilters(next);
            void loadStats(next);
          }}
          onDrill={drillToSessions}
        />
      ) : null}
```

with:

```tsx
      {view === "stats" ? (
        <>
          <ExamTimeCard
            endAt={examEndAt}
            skewMs={examSkewMs}
            busy={examTimeBusy}
            endNowArmed={endNowArmed}
            onArmEndNow={setEndNowArmed}
            absoluteInput={examTimeInput}
            onAbsoluteInputChange={setExamTimeInput}
            onAdjust={(body) => void runExamTime(body)}
          />
          <StatsDashboard
            stats={stats}
            loading={statsLoading}
            onRefresh={() => loadStats()}
            rooms={rooms}
            room={alertFilters.room ?? ""}
            onRoomChange={(room) => {
              const next = { ...alertFilters, room: room || undefined };
              setAlertFilters(next);
              void loadStats(next);
            }}
            onDrill={drillToSessions}
          />
        </>
      ) : null}
```

**(f)** Component — immediately BEFORE `function StatsDashboard(` add:

```tsx
// S5: live exam-time control on the Live stats view. Remaining time is computed
// against the SERVER clock (skew captured when the stats/exam-time response
// arrived) so the admin display agrees with the students'. The 1 s ticker only
// re-renders this card. "End exam now" is a deliberate two-click confirm.
function ExamTimeCard({ endAt, skewMs, busy, endNowArmed, onArmEndNow, absoluteInput, onAbsoluteInputChange, onAdjust }: {
  endAt: string;
  skewMs: number;
  busy: boolean;
  endNowArmed: boolean;
  onArmEndNow: (armed: boolean) => void;
  absoluteInput: string;
  onAbsoluteInputChange: (value: string) => void;
  onAdjust: (body: ExamTimeRequest) => void;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const left = remainingMs(endAt, Date.now(), skewMs);
  const over = left !== null && left <= 0;
  const buttonClass = "focus-ring inline-flex h-10 items-center justify-center rounded-md border border-line px-3 text-sm font-medium disabled:opacity-50";
  return (
    <section className="mb-5 rounded-lg border border-line bg-panel p-5 shadow-subtle">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-ink">Exam time</h2>
          {endAt ? (
            <p className="mt-1 text-sm text-muted">
              Ends {new Date(endAt).toLocaleString()} ·{" "}
              <span className={`font-mono font-semibold ${over ? "text-danger" : "text-ink"}`}>
                {over ? "time is up" : `${formatRemaining(left ?? 0)} left`}
              </span>
            </p>
          ) : (
            <p className="mt-1 text-sm text-muted">No schedule configured yet — set the gate in Settings.</p>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <button className={buttonClass} disabled={busy || !endAt} onClick={() => onAdjust({ extend_minutes: 15 })}>+15 min</button>
          <button className={buttonClass} disabled={busy || !endAt} onClick={() => onAdjust({ extend_minutes: 5 })}>+5 min</button>
          <button className={buttonClass} disabled={busy || !endAt} onClick={() => onAdjust({ extend_minutes: -5 })}>−5 min</button>
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">New end time</span>
            <input className="focus-ring mt-1 h-10 rounded-md border border-line bg-white px-3 text-sm" type="datetime-local" value={absoluteInput} onChange={(event) => onAbsoluteInputChange(event.target.value)} />
          </label>
          <button className={buttonClass} disabled={busy || !absoluteInput} onClick={() => onAdjust({ end_at: localInputToIso(absoluteInput) })}>Set</button>
          {endNowArmed ? (
            <>
              <button className="focus-ring inline-flex h-10 items-center justify-center rounded-md bg-danger px-3 text-sm font-medium text-white disabled:opacity-50" disabled={busy} onClick={() => onAdjust({ end_now: true })}>Confirm: end for everyone</button>
              <button className={buttonClass} disabled={busy} onClick={() => onArmEndNow(false)}>Cancel</button>
            </>
          ) : (
            <button className="focus-ring inline-flex h-10 items-center justify-center rounded-md border border-danger/40 px-3 text-sm font-medium text-danger disabled:opacity-50" disabled={busy || !endAt} onClick={() => onArmEndNow(true)}>End exam now…</button>
          )}
        </div>
      </div>
      <p className="mt-3 text-xs text-muted">Changes reach students within ~15 seconds via their heartbeat — no reload needed. "End exam now" also force-ends every live session in the contest.</p>
    </section>
  );
}
```

- [ ] **Step 6.2: Typecheck + tests + build — expect PASS:**

```bash
cd /home/karthi/arogara/proctor/frontend && npm run lint && npx vitest run && npm run build
```

Expected: exit 0 on all three.

- [ ] **Step 6.3: Commit:**

```bash
cd /home/karthi/arogara/proctor && git add frontend/src/App.tsx && git commit -m "S5: admin Exam time card — live remaining, +/-min, exact set, two-click end-now

Rides the existing 5s stats poll (end_at + server_now now on the stats
response) so the card stays live, including changes by another admin.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 7: Verification — full suites + browser integration (demo mode)

- [ ] **Step 7.1: Full automated pass:**

```bash
cd /home/karthi/arogara/proctor/backend && npm test
cd /home/karthi/arogara/proctor/frontend && npm run lint && npx vitest run && npm run build
```

Expected: everything green, build succeeds.

- [ ] **Step 7.2: Browser integration (demo mode, via the :9222 Chrome MCP).** Start the dev server:

```bash
cd /home/karthi/arogara/proctor/frontend && VITE_DEMO_MODE=true npm run dev
```

Then in the browser:
1. **Admin tab** → `http://localhost:5173/admin` → unlock (demo password `dev`, or per `LOCAL_DEV.md`) → Settings → set start in the past, end ~+30 min → Save → Live stats: the **Exam time** card shows "Ends … · 0:29:xx left" counting down each second.
2. Card actions: **+15 min** → remaining jumps +15 and `actionMessage` confirms; **−5 min** → drops; exact **Set** with the datetime-local input works; **End exam now…** shows **Confirm: end for everyone** + **Cancel** (do NOT confirm yet).
3. **Student tab** → `http://localhost:5173/` → register + consent → Start → grant screen share (real share dialog; pick Entire Screen). Timer bar shows **Time left** counting down beside **Elapsed**. *(If the share dialog cannot be automated from the MCP, do this leg manually or skip to step 5 and rely on the unit suites for the student visuals — note whichever you did in MORNING-NOTES.)*
4. In the admin tab press **+5 min** → within ≤15 s (next demo heartbeat) the student countdown jumps +5 and the notice "The proctor extended the exam — new end time …" appears, **without reload**. Press **−15 min** → notice "…moved the exam end earlier…" + one spoken warning.
5. Admin **End exam now…** → **Confirm** → message reports N session(s) force-ended; within ≤15 s the student tab lands on the existing **"Test ended"** screen (recorder self-stopped via the 409 → B1 path).
6. Shorten the end to ~1 min ahead and let it expire on a fresh student session: at zero the timer bar turns red ("Time is up — end your test now"), the danger banner shows, one voice warning plays, and the **End test** flow still works normally.

- [ ] **Step 7.3: Update `night-run/MORNING-NOTES.md`** — under section 1 record S5 done + evidence (test counts, browser steps performed); under section 2 record the judgment calls: (a) soft enforcement at end_at (no auto-force-end; End-now is the hard stop), (b) no exec-gate on end_at (S3 owns those functions tonight), (c) end-now scope = current contest_slug.

- [ ] **Step 7.4: Commit the notes (and any fixups) — LOCAL only, never push.**
