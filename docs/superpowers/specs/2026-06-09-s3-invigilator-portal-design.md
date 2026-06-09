# S3 — Invigilator Portal (no signed-QR) — design

**Status:** READY for tonight's build (STRETCH item 3 of the 2026-06-09 night run).
**Author:** architect subagent. **Date:** 2026-06-09.
**Parent design:** `docs/superpowers/specs/2026-06-09-own-editor-design.md` (§6, §7, §8 — invigilator portal minus signed-QR).
**Guardrails:** `night-run/MORNING-NOTES.md` — scope is LOCKED to: room OTP/passcode distribution, start-now/allow-all bypass, basic room stats, selective alerts. **Signed-QR ID verification is DEFERRED — not designed here.**

---

## 1. Vision

Each exam room has an invigilator with a phone/laptop. They open a separate link (`/invigilator`), unlock with a shared invigilator password, enter their name, and pick their room. From there they can:

1. **Distribute the room start code** — generate a 6-digit OTP for their room and write/announce it just before the test starts (after confirming everyone is logged in and recording). Pre-generation is the same action done earlier.
2. **Start now / allow all** — release the whole room immediately, skipping the OTP (mis-distributed code, everyone ready early). This is the room-scoped parallel of the admin's master control (see §4.3).
3. **See basic room stats** — who's logged in / recording / disconnected / locked / waiting approval / finished, as counts plus a per-student list.
4. **See their room's alerts** — a selective, room-scoped view of open proctor alerts (no recordings, no archive workflow, no verdicts).

Candidates, after starting proctoring (recording already running), wait at a **"Waiting for your room code"** screen. Entering the room code — or the invigilator pressing "Start now" — releases them into the coding workspace. The screen also auto-advances by polling, so "allow all" requires zero typing from candidates.

## 2. How "start" works today (found in code, drives the design)

- Candidate start (`POST /api/session/start`, `backend/src/handler.mjs`) is gated **only by the contest time window** (`validateProctorGate()` reads `start_at`/`end_at` from the settings doc). There is no per-candidate admin "start" action; the admin's "start" is the settings window itself.
- Admin auth is a shared password in the `x-admin-password` header vs the `ADMIN_PASSWORD` env (`requireAdmin`). The admin console (in `App.tsx`) verifies client-side via `VITE_ADMIN_PASSWORD` / `VITE_ADMIN_PASSWORD_HASH` and then sends the typed password on every request.
- `room` is already a free-text sanitized label on every session doc (`sanitizeRoom`), already used for filtering in `adminStats` / `adminAlerts` / `adminSessionsList` (`distinctRooms`, `normalizeRoomFilter`).
- Session lifecycle (`active` / `pending_approval` / `locked` / `ended`) plus the derived `disconnected` (stale-liveness) signal already exist; the portal reuses them unchanged.

**Therefore:** the room OTP is a NEW gate that sits AFTER session start (recording must already be running while candidates wait — that is the §6 design intent: "released ~2 min before start, after confirming everyone's logged in + fullscreen") and BEFORE the coding workspace / contest link.

## 3. Locked decisions

1. **Invigilator auth = a second shared password**, exactly parallel to the admin pattern: env `INVIGILATOR_PASSWORD`, header `x-invigilator-password`, compared with the existing `safeEqual` (NOT plain `!==` — match the `requireApiKey` discipline, which is stricter than `requireAdmin`). The **admin password is also accepted** (in either header) so an admin can open the portal. **Closed-by-default:** when `INVIGILATOR_PASSWORD` is unset, the invigilator header is always rejected (mirrors `ALERTS_INGEST_API_KEY`); only the admin credential can pass.
2. **Invigilator identity is recorded, not authenticated**: they type their name; it is stored on gate actions (`released_by` / `opened_by`) for audit. Per-invigilator accounts are out of scope.
3. **The gate is opt-in per contest** via a new boolean `room_gate_enabled` on the existing settings doc (default **false** → zero behavior change for current flows, Slice-1 tests, and the KEC-style runs until an admin turns it on). It must be ON before invigilators can release codes.
4. **Gate state is one Firestore doc per (contest, room)** in a new collection `proctor_room_gates`. Deterministic id (`gate:<contest_slug||_>:<room_key>`) like the live-lock pattern, so re-releases upsert.
5. **OTP is stored in plaintext** in the gate doc. Reason: it is a short-lived room-coordination code that the invigilator must be able to **re-display** (portal reload, second device, writing it on the board) — not a credential guarding stored data. Online guessing is bounded by a per-session attempt cap (20 → HTTP 429). Flagged as an open question for morning review.
6. **Release is per-session and server-enforced**: a successful code entry / open-room poll stamps `exam_started_at` on the session doc, and `/api/exec/run` + `/api/exec/submit` reject (`403 exam_not_started`) while the gate is enabled and the session is unstamped. Recording, events, heartbeats, uploads are deliberately NOT gated — candidates are recorded while they wait.
7. **Invigilator scope is always the ACTIVE contest** (from the settings doc). Invigilators never pick a contest.
8. **Least-privilege reads**: invigilator endpoints expose NO emails, NO IP addresses, NO signed recording URLs, NO GCS access. Name + username + roll number + status only (roll number is needed for physical ID checks). Alerts come without `video_key`/`download_url`.
9. **Frontend**: new top-level route `/invigilator` → new file `frontend/src/InvigilatorApp.tsx` (App.tsx gets a 2-line route change only — keeps merge surface with the parallel slices minimal). Unlock mirrors the admin gate, including the `VITE_INVIGILATOR_PASSWORD_HASH` hashed-bundle variant. Demo-mode branches for every new api.ts function (localStorage gate store) so the whole flow is browser-testable offline.
10. **Candidates with no room** (legacy/edge) map to the reserved room key `"_"`; the portal can select "(no room set)" to manage them. (Once S2's room dropdown ships, this is rare.)

## 4. Data model

### 4.1 New collection `proctor_room_gates` (env `ROOM_GATES_COLLECTION`)

Doc id: `gate:<contest_slug||_>:<room_key>` where `room_key = sanitizeRoom(room) || "_"`.

```
{
  contest_slug: "kec-2026",
  room: "Lab A-1",          // display label ("" for the unassigned pseudo-room)
  room_key: "Lab A-1",      // sanitized; "_" for blank
  mode: "otp" | "open",     // "open" = start-now / allow-all
  otp: "483920",            // plaintext, 6 digits; "" when never released
  released_at: ISO | null,  // when the OTP was (re)generated
  released_by: "Priya",     // invigilator-typed name (audit)
  opened_at: ISO | null,    // when start-now was pressed
  opened_by: "Priya",
  updated_at: ISO
}
```

Mode transitions: `(none) → otp` (release-code), `(none|otp) → open` (open-room), `open → otp` (release-code re-arms the gate — useful for late arrivals after a start-now; already-released candidates keep their `exam_started_at` and are unaffected).

### 4.2 Session doc additions (existing `proctor_sessions`)

- `exam_started_at: ISO` — set once when the gate releases this session. Absent = not released.
- `exam_start_method: "otp" | "room_open"` — audit of how it was released.
- `gate_attempt_count: number` — incremented per wrong code; at `GATE_ATTEMPT_LIMIT` (env, default 20) further attempts get 429.

### 4.3 Settings doc addition (existing `proctor_settings/active`)

- `room_gate_enabled: boolean` (default false). Saved by `adminSaveSettings` (`body.room_gate_enabled === true`), returned by `publicSettings`, and included in the start/resume response (`startResponse`) so the candidate client knows whether to show the waiting room. **The admin checkbox doubles as the admin-side master bypass:** unchecking it releases everyone on their next poll (the gate check re-reads settings per request).

## 5. API surface

### 5.1 Invigilator endpoints (auth: `requireInvigilator` — `x-invigilator-password` or admin credential)

- `GET /api/invigilator/overview` → `{ contest_slug, room_gate_enabled, rooms: string[], has_unassigned: boolean }`. Room-picker bootstrap; `rooms` via the existing `distinctRooms` over the active contest's session docs.
- `GET /api/invigilator/room?room=<label>` → the one-call dashboard (one request per 5 s poll):
  - `stats`: `{ live, locked, pending_approval, finished, disconnected, started, total }` — same classification rules as `adminStats` (including `isStaleSession`), scoped to the room; `started` counts sessions with `exam_started_at`.
  - `sessions[]` (≤500, name-sorted): `{ session_id, name, hackerrank_username, roll_number, status, stale, exam_started_at, created_at }`.
  - `gate`: the public gate projection (see 4.1) or null.
  - `alerts[]` (≤100, newest first): room-scoped, non-archived, `{ id, type, severity, timestamp, title, detail, hackerrank_username, session_id }` — **no** video/download fields. Same index-free query pattern as `adminAlerts` (one `contest_slug` equality filter; rest in memory).
  - `room=_` selects blank-room sessions.
- `POST /api/invigilator/release-code` body `{ room, invigilator_name, regenerate? }` → `{ ok, contest_slug, gate }`. Generates a 6-digit OTP (`crypto.randomInt`), upserts the gate with `mode:"otp"`. **Idempotent by default**: if an OTP already exists it is returned unchanged (portal reload never silently invalidates the code on the board); `regenerate:true` mints a fresh one. 400 `room_gate_disabled` when the admin toggle is off.
- `POST /api/invigilator/open-room` body `{ room, invigilator_name }` → `{ ok, contest_slug, gate }`. Sets `mode:"open"` (start-now / allow-all). 400 `room_gate_disabled` when the toggle is off.

### 5.2 Candidate endpoint (auth: session token, like `/api/events`)

- `POST /api/session/room-gate` body `{ session_id, code? }`:
  - unknown session → 404; ended → 409; locked/pending → 403 (existing `requireWritableSession`).
  - gate disabled → `{ gate_enabled:false, exam_started:true }`.
  - already stamped → `{ gate_enabled:true, exam_started:true, exam_started_at }` (idempotent).
  - room gate `mode:"open"` → stamps `exam_started_at` (`method:"room_open"`) → started.
  - `code` matches the room OTP → stamps (`method:"otp"`) → started.
  - `code` wrong or no gate released yet → `403 invalid_code` (+ `gate_attempt_count` increment; at the cap → `429 too_many_attempts`).
  - no `code`, gate not open → `{ gate_enabled:true, exam_started:false, room }` (client re-polls every 5 s).

### 5.3 Enforcement on existing endpoints

- `execRun` / `execSubmit`: after `requireWritableSession`, `await requireExamStarted(session)` → 403 `exam_not_started` when `settings.room_gate_enabled && !session.exam_started_at`. (Existing exec tests are unaffected: they seed no settings doc, so the flag is falsy.)
- CORS: `x-invigilator-password` added to `access-control-allow-headers`.

## 6. UI behavior

### 6.1 Invigilator portal (`/invigilator`, new `InvigilatorApp.tsx`)

1. **Unlock**: password + "your name" fields. Password verified client-side against `VITE_INVIGILATOR_PASSWORD_HASH` (sha256 via the existing `sha256Hex`) or plain `VITE_INVIGILATOR_PASSWORD`, falling back to the admin hash/plain so an admin can enter; the typed password is kept in state and sent as `x-invigilator-password` on every call.
2. **Room pick**: dropdown from `overview.rooms` + "(no room set)" when `has_unassigned` + an "Other…" free-text input. Selection is saved to localStorage; re-selection allowed behind a confirm ("Changing rooms moves your view; your gate actions stay attributed to you.").
3. **Dashboard** (auto-poll 5 s, mirroring `ADMIN_POLL_INTERVAL_MS`):
   - **Gate card**: state badge ("No code released yet" / "Code active" / "Room OPEN"); when armed shows the **code huge** (board-readable); buttons: *Release room code* → *Regenerate* (confirm) and *Start now — allow all* (confirm). When the admin toggle is off, the card explains the admin must enable room start codes.
   - **Stat tiles**: logged in (live), disconnected, locked, waiting approval, finished, started, total.
   - **Students table**: name, username, roll number, status badge (+ stale marker), started tick.
   - **Alerts list**: severity-badged title/time/student rows; read-only.
4. If `room_gate_enabled` is false, the stats/alerts views still work (a portal is useful even without the gate); only the gate actions are disabled.

### 6.2 Candidate waiting room (in `StudentApp`)

- `startResponse.room_gate_enabled` drives a new `examStarted` state (initialized true when the gate is disabled).
- While `status === "recording"` and not released: the `CodingWorkspace` and the contest-URL "Start test" link are hidden; a **RoomCodePanel** shows instead — 6-digit input (numeric, `one-time-code`), Start button, and a note that the screen auto-advances; polls `POST /api/session/room-gate` every 5 s (first tick immediate, which also restores state after reload/resume).
- Wrong code → inline error ("That code is not correct for your room…"); cap reached → "Too many wrong attempts. Wait for your invigilator…".
- Everything else about the student flow (recording, events, heartbeats, end test) is untouched.

### 6.3 Admin console (one small addition)

- Settings view: a "Room start codes (invigilator gate)" checkbox wired to `room_gate_enabled` (load + save + demo branch).

## 7. Error handling

- All new failures use the existing `httpError` convention (intentional 4xx carries `detail`; 500s stay generic).
- Machine-readable codes the client switches on: `invalid_code` (403), `too_many_attempts` (429), `exam_not_started` (403), `room_gate_disabled` (400), `Unauthorized` (401).
- Invigilator poll errors are swallowed (transient) exactly like the admin auto-poll; manual actions surface errors inline.
- Candidate gate-poll errors are silent; the explicit code submit surfaces errors.

## 8. Security & PII posture

- Invigilator credential is separate from admin; compromise of it exposes only room-scoped names/rolls/statuses and gate controls — no recordings, no emails, no IPs, no settings writes.
- All password compares in new code use `safeEqual` (timing-safe).
- OTP guessing: 6 digits, per-session cap of 20 attempts (then 429), and the code's useful life is minutes. Plaintext storage is accepted (decision 3.5) and flagged for review.
- The waiting room never blocks evidence collection — a candidate "waiting" is still recorded (anti-gaming: you can't avoid recording by not entering the code).

## 9. Testing

- **Backend** (`backend/test/invigilator.test.mjs`): node:test, env-before-import with a `?invigilator` cache-buster, pasted fake Firestore/Storage + `__setClientsForTest`, stub Judge0 via `__setJudge0AdapterForTest` for the exec-gate tests. Covers: auth matrix (invig pass / admin pass in either header / wrong / unset-closed-by-default via a second cache-busted import), settings round-trip of `room_gate_enabled`, release-code (shape, idempotency, regenerate, disabled→400), open-room, room dashboard (stats correctness, row field allow-list — explicitly asserts NO email/IP keys, alert filtering incl. archived-excluded and no video fields, `_` room), candidate gate poll (all branches incl. attempt cap), exec enforcement (403 before, 200 after release).
- **Frontend**: vitest on the pure module `frontend/src/invigilator/gateLogic.ts` (OTP input normalization, room-key mirror, gate badge). UI verified in the browser (demo mode) per the plan's final task.

## 10. Out of scope (do NOT build tonight)

- **Signed-QR ID verification** (deferred by decree — §10 of the parent design).
- Per-invigilator accounts/logins, invigilator action audit log UI.
- Roster-based attendance (S6) — "not started" counts stay roster-less (`total` only).
- Invigilator-initiated session actions (lock/approve/end) — admin console only, for now.
- Pre-generated multi-room OTP batch export for the admin (pre-generation = invigilator/admin calling release-code earlier).
- OTP expiry/rotation policy; rate-limiting beyond the per-session attempt cap.
- Leaderboards, dynamic time / end-now (S5), IP report (S7).

## 11. Open questions (for morning review)

1. **Plaintext OTP in Firestore** (vs hash + losing re-display). Chosen: plaintext (coordination code, not a credential). Veto = store hash and regenerate on every portal view.
2. Admin password accepted on invigilator endpoints — convenience vs strict separation. Chosen: accept.
3. `release-code` after `open-room` re-arms the gate for not-yet-released candidates. Chosen: allow (late-arrival use case) and document in the portal UI copy.
4. Roll numbers shown to invigilators (needed for physical ID checks) — confirm this PII exposure is acceptable.
