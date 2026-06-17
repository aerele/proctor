# S5 — Dynamic exam time + "End now" (admin) — Design

**Status:** Night-run stretch item 5 (locked scope: `night-run/MORNING-NOTES.md` → STRETCH 5; intent: platform design §8 "Dynamic time control: update end-time live; **end now** for everyone (new time or immediate)").
**Author:** Ram (architect subagent). **Date:** 2026-06-09.
**Paired plan:** `docs/superpowers/plans/2026-06-09-s5-dynamic-time-end-now.md`.

---

## 1. Vision

The proctor admin can change the exam's remaining time **while the exam is running** — extend it ("+15 min"), shorten it, or set an exact new end time — and can **force-end the exam for everyone** with one (confirmed) click. Students see the change **without reloading**: a live skew-corrected countdown in their timer bar updates within one heartbeat interval (≤15 s), with a spoken + visual notice when the proctor moves the end time, and a clear "Time is up" state when the countdown crosses zero. The admin watches the same remaining time on the Live stats view, computed against the same server clock.

## 2. How the system works today (studied 2026-06-09)

- **Schedule:** ONE settings doc (`proctor_settings/active`) with `start_at` / `end_at` / `contest_url` / `contest_slug`. `validateProctorGate()` enforces the window **only at session START** (`backend/src/handler.mjs`). Nothing enforces `end_at` mid-exam, and students are never shown it.
- **The student's only live channel is the 15 s heartbeat** (`POST /api/heartbeat`, interval from `startResponse.heartbeat_interval_seconds`). Its response already carries the session lifecycle `status`; `useProctorRecorder.ts` self-stops the recorder and flips the UI gate when status ≠ active (the "B1" path), including on a 409 `session_ended` write rejection. **This is the existing polling/refresh mechanism S5 reuses.**
- **Admin force-end exists per-session/per-username** (`POST /api/admin/session-action`, action `"end"` → status `ended` + `ended_reason:"admin_action"` + `releaseLiveSlot`), but there is no "end everyone" and no end-time control beyond re-saving the whole settings form.
- **Admin Live stats auto-polls every 5 s** (`ADMIN_POLL_INTERVAL_MS` in `App.tsx`) via `GET /api/admin/stats`.
- Student UI shows **elapsed** time only (`TimerBar` + `formatElapsed`); no remaining time, no end-time awareness.

## 3. Decisions

1. **Propagation channel = the existing heartbeat (≤15 s), not SSE/websockets.** The heartbeat response (and the start/resume responses) additionally carry `end_at` + `server_now`. Zero new client polling loops; works for every already-running session.
2. **Server clock is the time authority.** Every payload carrying `end_at` pairs it with `server_now`; the client computes a skew offset once per receipt (`computeClockSkewMs`) and counts down against the server clock. A wrong local clock cannot fake more (or less) time.
3. **Dedicated endpoint `POST /api/admin/exam-time` with a merge-write — NOT a change to `adminSaveSettings`.** Reasons: (a) single concern → small test surface; (b) `merge:true` touches ONLY `end_at`/`end_at_updated_at`/`updated_at`, so fields other night-run items add to the settings doc (S2 `rooms`, S3 `room_gate_enabled`) are never clobbered; (c) avoids parallel-edit collisions — S2 and S3 both edit `adminSaveSettings`, S5 deliberately does not.
4. **"End now" = `end_at := now` + force-end every non-ended session in the current contest scope.** Ending reuses the proven semantics of the existing admin end action (status `ended`, `ended_at`, `releaseLiveSlot`) with a distinct `ended_reason: "exam_ended_by_admin"` for the audit trail, applied with bounded concurrency (`mapWithConcurrency`, 12). The student's next heartbeat then 409s `session_ended` → the existing B1 path stops the recorder and shows the ended screen. Scope = the settings doc's `contest_slug` (`""` matches legacy/no-contest sessions); sessions from other contests are untouched.
5. **Soft enforcement at `end_at`; the hard stop is explicit.** When the countdown hits zero the student gets a red timer bar, a "Time is up — end your test now" banner, and ONE spoken warning — but the recording keeps running and the student ends their own test (preserving the manifest-upload end flow). A plain end-time change never force-ends sessions. Rationale: auto-cutting sessions at a timestamp risks killing evidence finalization for a clock blip; the admin's End-now is the deliberate hard stop and is one click away. *(Flagged as a judgment call for morning review.)*
6. **No exec (Run/Submit) gating on `end_at` in S5.** S3 is concurrently adding a room-gate to `execRun`/`execSubmit`; touching the same functions tonight is a collision risk. After End-now, exec is already blocked (the session is `ended` → `requireWritableSession` 409s). The soft window between a passed `end_at` and the admin pressing End-now is accepted and documented.
7. **Admin control lives on the Live stats view** (the screen the admin watches during the exam): an "Exam time" card with the live remaining time, quick `+15/+5/−5 min` buttons, an exact `datetime-local` setter, and a **two-click** "End exam now…" → "Confirm: end for everyone". `GET /api/admin/stats` additionally returns `end_at` + `server_now`, so the existing 5 s poll keeps the card live (including changes made by another admin or via the Settings form).
8. **Any `end_at` change propagates** — even one made through the old Settings form — because the heartbeat reads the settings doc fresh. The exam-time endpoint is the safe/ergonomic path, not the only one.

## 4. Data model

No new collections.

- **`proctor_settings/active`** (existing): `end_at` is now mutable mid-exam via the exam-time endpoint. New audit field `end_at_updated_at` (ISO). Merge-written only.
- **Session docs** (existing): End-now stamps `status:"ended"`, `ended_at`, `updated_at`, and `ended_reason:"exam_ended_by_admin"` (vs `"admin_action"` from per-session end, `"superseded_by_approval"` from approve).
- **Live-slot locks** (existing): released per ended session, mirroring the existing end action.

## 5. API surface

### Extended responses (additive, backward-compatible — no existing test asserts exact key sets on these)

| Endpoint | Added fields |
|---|---|
| `POST /api/session/start`, `POST /api/session/resume` (via `startResponse`) | `end_at` (ISO or `""`), `server_now` (ISO) |
| `POST /api/heartbeat` | `end_at`, `server_now` (one extra Firestore settings read per heartbeat — same doc the start gate reads; ~4/min/student, negligible cost) |
| `GET /api/admin/stats` | `end_at`, `server_now` |

### New: `POST /api/admin/exam-time` (admin auth: `x-admin-password`)

Body carries **exactly one** of:

```json
{ "end_at": "2026-06-10T12:30:00.000Z" }   // absolute new end time
{ "extend_minutes": 15 }                    // signed delta vs the CURRENT end (negative shortens)
{ "end_now": true }                         // end_at := now AND force-end all non-ended sessions
```

Response `200`:

```json
{ "ok": true, "start_at": "<ISO>", "end_at": "<new ISO>", "server_now": "<ISO>", "ended_count": 0 }
```

`ended_count` > 0 only for `end_now` (number of sessions force-ended).

### Error handling

| Condition | Response |
|---|---|
| Missing/wrong admin password | `401 Unauthorized` |
| No configured schedule (`start_at`/`end_at` absent) | `400 Proctoring schedule is not configured yet.` |
| Zero or 2+ of the three fields supplied | `400 Provide exactly one of end_at, extend_minutes, end_now` |
| Unparseable `end_at` | `400 end_at must be a valid ISO 8601 date` |
| `extend_minutes` zero/NaN | `400 extend_minutes must be a non-zero number` |
| `extend_minutes` with a corrupted stored end | `400 Stored end time is invalid; set an absolute end_at instead.` |
| `end_now` not literally `true` | `400 end_now must be true` |
| Resulting end ≤ `start_at` (incl. End-now before the exam starts) | `400 End time must be after the start time.` |

Client-side: the student silently ignores missing `end_at` (old backend → no countdown, exactly today's UI); heartbeat failures already degrade via the existing B1/error paths. Admin errors surface in the console's existing error banner.

## 6. UI behavior

### Student (`StudentApp`)

- **Countdown:** `TimerBar` gains a "Time left H:MM:SS" readout beside "Elapsed" while recording/ending. Computed every render from `end_at` + skew (the existing 1 s elapsed ticker already re-renders; **no new interval**). No `end_at` → no countdown (unchanged UI).
- **Live change notice:** when a heartbeat delivers a *different* `end_at` (`classifyEndAtChange` → `extended`/`shortened`), a notice bar appears under the timer bar ("The proctor extended the exam — new end time HH:MM." / "…moved the exam end earlier…"), persisting until the next change. Shortening also speaks one warning (existing `speakWarning`). The first-ever `end_at` (`initial`) is silent.
- **Time up:** timer bar turns red ("Time is up — end your test now"), a danger banner instructs the student to stop and end the test, one spoken warning fires, and an `exam_time_up` proctor event is logged via the existing event pipeline. Recording continues until the student (or admin) ends.
- **End-now experience:** next heartbeat 409s → existing B1 flow → recorder stops, gate flips to the existing "Test ended" screen. Nothing new to build on this leg.

### Admin (`AdminApp`, Live stats view)

- **Exam time card** above the stat cards: "Ends \<local time\> · H:MM:SS left" (1 s ticker local to the card; "time is up" in red once over), buttons `+15 min` / `+5 min` / `−5 min`, a `datetime-local` + **Set** for an exact time, and **End exam now…** requiring a second **Confirm: end for everyone** click (Cancel disarms). All controls disabled while a request is in flight or when no schedule exists ("No schedule configured yet — set the gate in Settings.").
- Outcomes report through the existing `actionMessage` banner ("Exam end time set to … Students see it within ~15 seconds." / "Exam ended — N live session(s) force-ended."), and stats reload.

### Demo mode (`VITE_DEMO_MODE=true`)

Full loop works offline: demo settings live in localStorage; demo heartbeat/start return `end_at` from them; `adjustExamTime` demo branch mutates demo settings, and `end_now` marks every demo session `ended` (the demo heartbeat then throws the same 409 `session_ended` the real backend would — B8 parity).

## 7. New frontend module

`frontend/src/examTime.ts` — pure, vitest-covered: `computeClockSkewMs`, `remainingMs`, `formatRemaining` (H:MM:SS, clamped at 0), `classifyEndAtChange` (`initial|unchanged|extended|shortened`). Shared by student and admin.

## 8. Out of scope (deliberate)

- **No auto-force-end when `end_at` passes** (Decision 5) and **no exec-gate on `end_at`** (Decision 6).
- **No per-room or per-student time extensions** — one global end time (the §8 backlog intent is contest-wide; per-room time belongs with S3's room model later).
- **No changes to `adminSaveSettings` / the Settings form** (Decision 3).
- **No countdown on pre-start/blocked/pending screens** — only during recording/ending (the blocked-screen "Check again" already re-fetches status, and start is still gated by the window).
- **No push channel** (SSE/websocket) — 15 s staleness is accepted.
- **No leaderboard/submission-deadline semantics** — that's Slice-2/3 problem-authoring territory.

## 9. Test strategy

- **Backend** (`backend/test/examTime.test.mjs`, node:test + pasted fakes + `__setClientsForTest` + env-before-import + `?examtime` cache-buster): start/resume/heartbeat carry `end_at`+`server_now`; exam-time endpoint validation matrix (§5 table); absolute set merge-preserves unrelated settings fields; extend/shorten math + window-inversion rejection; end_now ends exactly the non-ended sessions in the contest scope, stamps the reason, releases live locks, leaves other contests + already-ended sessions untouched, and returns `ended_count`; stats carries `end_at`.
- **Frontend** (`frontend/src/examTime.test.ts`, vitest): pure math (skew, remaining incl. null/negative, formatting clamp, change classification).
- **Integration (browser, demo mode):** admin extends → student countdown updates ≤15 s with notice; admin End-now → student lands on the ended screen without reload.
