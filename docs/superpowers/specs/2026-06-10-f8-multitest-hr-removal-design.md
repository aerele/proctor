# F8 design — multi-test (named contests) + HackerRank de-dependency

Status: APPROVED-BY-DEFAULT (Karthi activated both asks by voice 2026-06-10 ~11:47; decision defaults below sent to him on Telegram for async veto). Research basis: HR-dependency + single-contest inventory sweep (agent report, 2026-06-10).

## Key research facts (verified by sweep)
- `(username_norm, contest_slug)` is the universal join key — sessions, alerts, alert ids, submission-events, live-locks, GCS evidence paths (`contests/{slug}/sessions/{username_norm}/{session_id}/`) are ALREADY contest-scoped. Multi-test needs no session/alert/evidence migration.
- Sessions persist `storage_prefix` at creation → old evidence stays readable forever regardless of future path-shape changes.
- The single-contest assumption lives ONLY in: the `SETTINGS_ID="active"` settings doc (+ its readers: exam-time, problem assignment, start/end gates, rooms list, exam-config), the GLOBAL roster (one active version, meta in settings), the GLOBAL review roster/reviews/claims (`<username_norm>::<reviewerKey>` ids, no contest), and the GLOBAL alert-settings doc.
- HR dependency classes: UI labels (~50 strings, RENAME-ONLY), `hackerrank_username` field in form/session/DTOs (rename w/ dual-read adapters), `contest_url` + `contestSlugFromUrl` (DEAD — Karthi: name → slug, URL obsolete), `username_norm` (KEEP — it's an internal normalized key, not HR-specific).

## Decisions (defaults chosen for Karthi's stated scenario: 2 colleges running in parallel)
1. **Contest model**: new `contests` collection, doc id = slug derived from admin-entered NAME (slugify: lowercase, trim, spaces→`-`, strip non `[a-z0-9-]`, collision → `-2` suffix). Fields: `name, slug, start_at, end_at, problem_id, room_gate_enabled, rooms[], created_at, updated_at, archived`. NO `contest_url` (dead).
2. **Roster: PER-CONTEST.** Two parallel colleges = two rosters; global roster would collide. Roster meta + versions keyed by contest. Legacy global roster readable via shim until migrated.
3. **Rooms: PER-CONTEST** (live on the contest doc, as today on settings).
4. **Review roster/reviews/claims: PER-CONTEST** (append `::<contest_slug>` to ids for new data; legacy ids stay readable).
5. **Alert settings: GLOBAL for now** (simplest ops; per-contest override is a later flag).
6. **Problem bank: GLOBAL**, per-contest `problem_id` assignment (problems reusable across colleges).
7. **Identity going forward**: roster `unique_id` is THE identity when a roster exists (status quo S2 server-override, strengthened); typed field renamed `candidate_username` and used only when no roster. `username_norm` stays the internal key (derived from candidate_username or roster-provided username). Reviewers see name + unique_id + username.
8. **Candidate routing**: candidate URL carries the contest — `?contest=<slug>` (and a contest picker fallback listing OPEN contests when absent). Resume includes contest_slug.
9. **Invigilator portal**: contest picker at login; one active contest per portal session.
10. **Past-exam data**: KEEP READABLE, no migration, no deletion — dual-read adapters translate `hackerrank_username` → `candidate_username` in DTOs; legacy sessions with old settings-derived slug keep working.
11. **Admin UX**: Contests tab (CRUD list: name, slug, window, status chips, activate/archive); the existing global "contest filter" banner becomes the contest SELECTOR that scopes every tab (sessions/alerts/recordings/problems/attendance/IP/exam-time) — those are already slug-filtered.

## Build stages (each: spec→TDD→commit; no push)
- **S-A (rename pass, frontend-only)**: all "HackerRank username" labels → "Candidate username"; `StudentForm.hackerrank_username` → `candidate_username` with API-layer compat (send both / accept both during transition). DTO display renames.
- **S-B (contests collection, backend)**: contests CRUD endpoints (admin), slugify util, per-contest settings readers (exam-time, start/end gates, problem serve, exam-config?contest=), `SETTINGS_ID="active"` becomes a read-shim for the single legacy contest. node:test TDD throughout.
- **S-C (scoping moves)**: per-contest roster (meta+versions+endpoints+admin UI), per-contest review state ids, invigilator contest picker.
- **S-D (admin+candidate UX)**: Contests tab, global selector wiring, candidate `?contest=` routing + picker, demo parity.
- **S-E (HR field cleanup)**: backend stores `candidate_username` on NEW sessions; dual-read adapters for old docs; `contest_url`/`contestSlugFromUrl` removed (legacy fallback read only); monitoring scripts renamed field with accept-both ingest.
- **S-F**: contest-eval adapter restart-ability + zero-alerts investigation (BACKLOG 4 / task #32) — after S-E so it lands on the new field names.

## Out of scope here
F5 exam-shell rework (separate), F6 admin batch (in flight), encoding (F7).
