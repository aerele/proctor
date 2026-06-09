# S6 — Attendance stats from the roster (design)

**Status:** READY — night-run stretch item 6 (see `night-run/MORNING-NOTES.md` §Scope).
**Author:** Ram. **Date:** 2026-06-09.
**Parent design:** `docs/superpowers/specs/2026-06-09-own-editor-design.md` §8 ("Attendance stats (from the roster): taken / not-taken / absentees list").
**Depends on:** S2 — `docs/superpowers/specs/2026-06-09-s2-roster-login-design.md` (roster store + `roster_unique_id` on sessions). **S6 must NOT be built until S2's backend (Tasks 1–3 of its plan) has landed** — the plan gates on this.
**Plan:** `docs/superpowers/plans/2026-06-09-s6-attendance-stats.md`.

---

## 1. Vision

The admin uploaded a roster (S2), so the platform finally KNOWS who was *supposed* to sit the exam. S6 closes the loop: one admin screen that answers, at a glance and mid-exam,

- **How many roster students have taken / are taking the test** (taken = in-progress + completed),
- **How many have not**, and
- **Exactly who the absentees are** (unique ID, name, roll number, room) — as a filterable table and a downloadable CSV for the exam-day report.

This is a **read-only, derived view**. No new writes, no new stored state — one new admin endpoint that joins the active roster against the session docs that S2 already stamps with `roster_unique_id`.

## 2. Locked decisions

1. **Definitions.** A roster student has **taken** the test when at least one session doc carries their `roster_unique_id` (matched via normalized unique ID, against the ACTIVE roster version). Any session counts — `pending_approval` and `locked` included: the student physically showed up and started. Split: **in progress** = any of their sessions is non-`ended`; **completed** = all of their sessions are `ended`. **Not taken / absentees** = roster students with no matching session; the absentee LIST is these students' identity rows.
2. **One new admin endpoint, computed on demand** — `GET /api/admin/attendance` (admin password). One roster-entries query (version-filtered, ≤ 5000 docs) + one sessions query (≤ `SESSIONS_QUERY_LIMIT`), joined in memory. No aggregation docs, no caching, no Firestore composite index needed (both filters are single-field equalities). At our scale (≤ 5000 roster, ≤ 2000 sessions) this is a sub-second call; therefore **NO auto-poll** — the Attendance tab loads on open and on manual Refresh only.
3. **Optional `contest_slug` scope** — same query-param pattern as `/api/admin/stats`, wired to the admin console's global contest filter. No `room` filter (see Out of scope): an absentee has no session and hence no actual room; absentee rows instead CARRY the roster-mapped room so invigilators can locate no-shows.
4. **`unmatched_sessions` sanity counter.** Sessions that can't be tied to the active roster (legacy pre-roster sessions, `roster_unique_id` empty, or IDs from a replaced roster version) are counted and surfaced as a warning note — never silently dropped, never counted as attendance.
5. **PII minimization on the absentee list:** rows expose ONLY `{unique_id, name, roll_number, room}` (the S2 column-mapped values; unmapped → `""`). **No email, no raw `fields`** — the absentee table is exactly what gets projected/printed in an exam hall.
6. **Frontend = new admin tab "Attendance"** (`AdminView` + `AdminTab`, icon `UserCheck`), rendering a self-contained `AttendancePanel` (own load/error state, like `ContestEvalAlertTypesSection`): count cards (reusing `StatCard`), unmatched-sessions note, absentee table with client-side text filter, and a **Download CSV** button (client-built Blob, same pattern as `exportReviewsCsv`).
7. **Attendance math lives in ONE pure frontend module** — `frontend/src/attendance/computeAttendance.ts` — mirroring the backend semantics exactly; it is vitest-tested and is ALSO what the `api.ts` demo branch executes, so demo mode and production agree by construction. The CSV builder (`buildAbsenteesCsv`) lives there too.
8. **Demo mode computes from real demo state:** the demo roster (`aerele-proctor-demo-roster`, S2) joined against the demo session store (`aerele-proctor-demo-sessions`). This requires stamping `roster_unique_id` on `DemoSession` at demo `startSession` — a small additive extension of S2's demo gate (S2's plan did not store it; the backend does).

## 3. Roster read-interface consumed from S2 (the dependency contract)

S6 reads ONLY these S2 artifacts (all locked in the S2 spec §2–§3; plan Task 0 verifies they exist in `backend/src/handler.mjs` before building):

| Artifact | What S6 uses |
|---|---|
| `getRosterMeta()` | `null` → respond `{configured:false}`; else `meta.version`, `meta.column_mapping` |
| `ROSTER_COLLECTION` entry docs | `.where("roster_version", "==", meta.version)` scan; fields `unique_id`, `unique_id_norm`, `fields` |
| `normalizeUniqueId(value)` | normalize session `roster_unique_id` before matching `unique_id_norm` |
| `ROSTER_LIMIT` (5000) | cap on the entries query |
| Session docs' `roster_unique_id` | stamped by S2's start gate (entry's display `unique_id`; `""` legacy) |

## 4. API surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/admin/attendance` | admin password (`x-admin-password`) | Attendance report; optional `?contest_slug=` scopes the sessions side. |

**Response (roster configured):**
```json
{
  "configured": true,
  "contest_slug": null,
  "roster_total": 120,
  "taken": { "total": 100, "in_progress": 80, "completed": 20 },
  "not_taken": 20,
  "absentees": [ { "unique_id": "21CS003", "name": "Meera S", "roll_number": "R3", "room": "Lab A" } ],
  "unmatched_sessions": 2,
  "generated_at": "2026-06-09T21:00:00.000Z"
}
```
**Response (no roster):** `{ "configured": false }` (200 — a state, not an error). **401** without/with wrong admin password. Absentees are sorted ascending by `unique_id`. Invariants: `taken.total + not_taken == roster_total`; `taken.in_progress + taken.completed == taken.total`; `absentees.length == not_taken`. Worst-case response ≈ 5000 absentee rows (~500 KB) — acceptable for an authed admin tool, documented here.

## 5. UI behavior

- **Nav:** new tab "Attendance" between "Sessions" and "Review". The global contest filter banner scopes it like every other tab (panel reloads when the filter changes).
- **Loaded + roster configured:** five `StatCard`s — On roster (ink) / Taken (accent) / In progress (warning) / Completed (muted) / Not taken (danger); a warning note when `unmatched_sessions > 0`; the **Absentees** card with: as-of timestamp, text filter (matches ID/name/roll/room, client-side), **Download CSV** (`absentees.csv`, header `unique_id,name,roll_number,room`, disabled when zero), and the table (Unique ID / Name / Roll number / Room, `—` for blanks). Zero absentees → "Full house" note instead of the table.
- **No roster:** guidance card pointing to Settings → Candidate roster.
- **Endpoint 404 (not deployed):** warning card, same degrade pattern as `SessionsView`/`ReviewRosterSection` (api returns `null`).
- **Fetch error:** inline error banner inside the panel; Refresh retries.
- **Demo mode:** identical behavior against the localStorage roster + sessions (decision 8), so the whole tab is browser-integration-testable offline.

## 6. Error handling

- Backend: `requireAdmin` → 401; no other failure modes beyond Firestore errors (existing top-level handler maps to 500). Missing/empty `contest_slug` → unscoped. No roster → `{configured:false}`, never a throw.
- Frontend: `fetchAttendance` returns `null` on 404 (degrade card); throws otherwise (error banner). Old persisted demo sessions without `roster_unique_id` are read defensively (`?? ""`) and land in `unmatched_sessions`.

## 7. Security & PII

- Endpoint is admin-authed (`x-admin-password`), same gate as every `/api/admin/*` route.
- Absentee rows are the **minimum locating set** (ID, name, roll, mapped room). Raw roster `fields` (phone numbers, emails, extra columns) never leave via this route — flag the absentee-list shape in the PII audit alongside S2's roster items.
- Read-only: no state transitions, no enumeration value beyond what the authed admin already has via S2's roster meta + sessions list.

## 8. Testing

- **Backend** (`backend/test/attendance.test.mjs`, conventions: env-before-import + `?attendance` cache-buster, inline fakes, `__setClientsForTest`): 401; `configured:false`; counts + mapped absentee fields; normalization matching; pending/locked-count-as-taken; multi-session dedupe; stale-version invisibility + unmatched; legacy-session unmatched; contest scoping; absentee sort + unmapped-field blanks + exact row shape (PII).
- **Frontend pure** (`frontend/src/attendance/computeAttendance.test.ts`, vitest): all-absent, taken split, normalization, dedupe, pending/locked, unmatched, sort, CSV header + escaping.
- **Browser integration** (demo mode via the :9222 MCP): empty state → seed demo roster → all absent → seed sessions (one matched active + one legacy) → counts/unmatched-note/filter/table verified → screenshot evidence in `night-run/evidence/`.

## 9. Out of scope (S6)

- Room-filtered attendance and any invigilator-portal room attendance view (S3 owns room-scoped stats).
- Auto-poll / live attendance refresh; push notification on absence.
- The "taken" students list view (the Sessions tab already serves it), CSV of taken students, per-student attendance timeline.
- Contacting absentees (email/SMS) and exposing absentee emails at all.
- Aggregation/caching for rosters beyond 5000 (S2 caps uploads at 5000).
- Backfilling `roster_unique_id` onto sessions started before the roster upload (they surface as `unmatched_sessions` by design).

## 10. Interactions with parallel night-run items

- **Hard dependency on S2** backend Tasks 1–3 (helpers + session stamping). Plan Task 0 greps for them and ABORTS if absent.
- **Do not touch** `frontend/src/coding/*` (Slice 1 owns those files).
- S2 (and possibly S1/S3/S5) also edit `frontend/src/App.tsx` and the `api.ts` import block — every S6 edit there is anchored on landmarks with re-anchoring instructions, and S6 adds a NEW tab + NEW component rather than modifying any S2 section.
- S5 (dynamic time/end-now) edits settings handlers only — no overlap with the attendance route or panel.
