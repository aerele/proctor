# E2E persona test — verdict + findings (2026-06-11, deployed rev 00005 = HEAD 9b95dac)

Real deployed-stack walkthrough, 4 personas, against a real seeded contest `e2e-test-round-1` (2 problems w/ stubs + hidden tests, person-roster, college, Room A, open window). Screenshots under `night-run/evidence/e2e/<persona>/`. Each persona's full `docs_markdown` is in the agent task outputs (feeds F11 docs).

## Verdict: the product WORKS end-to-end. Core flows are clean and demo-ready.
- **Admin setup** ✅ — problem authoring (+per-language stubs F12.2), slug auto-derive, ordered multi-problem, rooms, two-stage college-aware roster upload, contest open. Strong UX.
- **Candidate** ✅ — permissions-first onboarding → fullscreen → roster identity resolve (TEC001→"Asha Rao") → multi-problem workspace → stubs load+swap (F12.2) → curated autocomplete (F12.3) → Run sample → Submit **live Judge0**: P1 accepted 100/100, P2 wrong 0/100 then accepted (200/200) → fullscreen enforcement overlay → correct L2 lock. **F12.1 confirmed** (ID field focus does not drop fullscreen). **Zero product bugs in the core flow.**
- **Invigilator** ✅ (network-verified) — tokenized name-only auth, room/candidate view, clickable status-counter filters (F9.2), **unlock-code mint** (6-digit, audit, "NOT the start code"), enforcement-exemption toggles (F5.5), hidden room-gate when off (F9.1), empty-alerts = correct default-OFF sharing.
- **Admin review** ✅ 8/9 — Live stats, Sessions + detail card (10 screen + 10 camera chunks, 32 events), Live alerts (bulk-over-filter, group-by, archive), IP drill-down (F8.1), Attendance, Results (rank/per-problem/integrity/selection + Mark-selection-done freezes snapshot), People cross-round scorecard, Data lifecycle (real export → enabled purge gate). **1 surface FAIL: recording review.**

## Findings → fix list
| # | Sev | Area | What | Fix |
|---|-----|------|------|-----|
| 1 | **HIGH** | Recording review | Player resolves sessions by `candidate_id`→`username_norm=normalize(candidate_id)`, but person-mode sessions store `username_norm=person_id` (`{college}~{uid}`) → no match → screen+camera playback, event/alert timeline, click-to-jump, review-queue all show nothing; cascades to "No recording attached" on every alert. | recording-sessions picker carries the session's real `username_norm` (and session_id); RecordingReview.loadUser uses that, not `candidateIdOf`; adminSessions accepts an exact `username_norm` (or session_id) lookup. Regression test for a person-mode session. |
| 2 | MED | Templates | No UI to author/store a named reusable template (only Blank + preset). Gap vs F10.5. | Templates tab CRUD (#58). |
| 3 | MED | Onboarding | Setup clipboard `navigator.clipboard.readText()` primer can WEDGE onboarding ("Requesting permissions…" stuck) if the prompt hangs/slow. Clipboard is optional/non-blocking by design. | Race readText() with a timeout; never block the gate on clipboard. |
| 4 | LOW | Candidate top bar | Room renders "Room **Room A**" (UI prefixes "Room " onto room name "Room A"). | Don't double-prefix. |
| 5 | LOW | Invigilator console | Same candidate shows as 2 undistinguished rows (stale + re-join); TOTAL counts sessions not candidates. | Show session-start disambiguator / dedupe-by-latest; clarify counter. |
| 6 | LOW | Results | "Mark selection done" disabled-tooltip says "select a candidate" but it's gated on a persisted Selected/Rejected mark. | Fix the disabled-state tooltip wording. |
| 7 | INFO | Invigilator entry copy | Mentions "release the start code" when the room-gate is OFF (no start-code panel renders). | Make the blurb conditional on room_gate_enabled. |
| 8 | LOW | Admin date picker | Segmented datetime field resists keyboard/programmatic entry (calendar popover works). | Minor; optional. |
| 9 | UX | Invigilator alerts | Empty feed gives no hint that sharing is admin-controlled/off. | One-line "no alert types shared with invigilators for this contest". |

## Next: ONE fix wave (recording-review HIGH + Templates CRUD + clipboard + cosmetics) → redeploy → re-test recording review + candidate clipboard → triple review + docs.
