# TODO — Admin polish + tooling (admin-polish batch)

Owner: **Ram**. Started 2026-06-08. **Batch COMPLETE + committed LOCALLY 2026-06-09 (NOT pushed — Karthi retracted the push: he is deploying and wants nothing pushed to GitHub).**

## Roll-out plan
1. [x] Ship admin polish A + B + C — committed **locally** on `master`. **NOT pushed** (do not push; Karthi deploys from his side).
2. [ ] **Stretch goal: own-editor build** (our own editor + full keystroke/mouse recording + analytics — the only way to capture keystrokes, since you can't read events from a cross-origin site like HackerRank). Discussed/built next. See `RESUME.md`.
3. [ ] **Multi-test / multi-session** is DEFERRED to **after the own-editor stretch goal** (Karthi: today's two-college problem is handled by deploying **two separate instances**, NOT by multi-test in-app).

---

## Item A — Admin / review UI polish (spec §2) — ✅ DONE + visually verified
- [x] **A1. Contest-filter banner** on every tab (chip "Contest filter active: <slug>" + Clear, or input + Apply). Removed the duplicate input from the Alerts console. Scopes Stats + Alerts + Sessions + Recordings.
- [x] **A2. Clickable live-stats cards** → new GCS-free **Sessions** drill-down list (`/api/admin/sessions-list`, all docs classified to match the card counts), filterable by status, contest- and room-scoped.
- [x] **A3. Recording review: summary-stats card** above the scrubber (total chunks / sessions covered / events valid+invalid / time range / recording gaps), with a "Show/Hide timeline detail" toggle. 2-hour timeline verified.
- [x] **A4. Approval-pending** first-class: the Pending card drills into the Sessions list filtered to `pending_approval` with an inline **Approve** action (reaches zero-chunk 2nd-device sessions — the bug the review caught).

## Item B — Username list → details CSV — ✅ DONE
- [x] **B.** "Download all details" button in the Review-roster Settings section → `POST /api/admin/session-details` (batch, GCS-free, dual-norm `@`-prefix handling, degenerate-input guard) → CSV `username,name,email,roll_number,room`, one row per input username (blank when not found).

## Item C — Submission-event DOWNLOAD + UPLOAD tooling — ✅ DONE
- [x] **C1/C2/C3.** `monitoring/download_submission_events.sh` + `monitoring/upload_submission_events.sh` + `monitoring/SUBMISSION-EVENTS-RUNBOOK.md`. `post_submission_events.py` unchanged. Gotchas baked in (snapshot-before-upload + the data-dir-not-private caveat, dry-run-first, api-key sourcing, idempotent re-run, batch ≤ 500).

## Verify gates
- [x] Backend tests: **155/155 pass** (8+7 new).
- [x] Frontend build clean (tsc -b && vite build).
- [x] **Adversarial code review** (3 reviewers) — caught 1 major bug (Sessions drill-down recording-only data source) → FIXED (new `sessions-list` endpoint) + several minors fixed.
- [x] **Visual review** in headless browser (demo mode): banner, clickable cards, Sessions+Approve, summary card, download button — all confirmed; demo made coherent.
- [x] Commit **locally** on `master`.
- [ ] ~~Push to GitHub~~ — **explicitly NOT done; Karthi retracted the push instruction.**

---

## BACKLOG — deferred (do NOT start without Karthi; rough order)
1. **Own-editor stretch goal** (next major) — our editor + keystroke/mouse capture + analytics. The load-bearing reason to own the origin. See `RESUME.md` + the spec `hiring-round-software-developer-internship-summary`.
2. **Multi-test / multi-session** (AFTER the own editor) — a LIST of tests instead of typing one contest slug: select a stub from the list, mark active/inactive, multi-select where applicable; per-test settings (2 links, 2 timings) via a stub-selector on single-test features. (Today handled by deploying two separate instances.)
3. **Alerts page — high-volume management** — bulk-select, grouping, easier triage when many alerts arrive at once.
4. **CodeEval / contest-eval adapter** — make it an easily-startable program; **investigate why the last run produced NO contest-eval alerts** and at least partially fix. (Two alert sources: proctor alerts + contest-eval alerts.)
5. ~~**Yesterday's forwarded voice messages**~~ — RESOLVED as phantom (2026-06-10 verification sweep): the forwarded voice (TG 1581) was already triaged into items 3+4 above. ONE residue: Telegram TEXT msgs 1574/1575 (Jun-8 evening, broker outage) never reached any session and their content is unrecoverable locally — **Karthi: scroll the proctor topic just above your Jun-9 ~08:32 voice note to confirm they were just pings.** Sweep also flagged: ROADMAP 6.1 (WebSockets live events — superseded by 5s polling?) needs a keep-dead-or-backlog decision from Karthi; ROADMAP 4.5 (event→action matrix) is re-covered by F6 item 4.

## Proctoring / exam features — from the 2026-06-09 test-day feedback (do "right after"; several feed the own-editor slices)
F1. **IP-address report.** Admin screen/status showing IP-wise count of logged-in users (catch candidates testing from *outside* the college). Group sessions by IP, flag clusters / off-campus IPs.
F2. **OMR-style screen markers + local overlay detection.** Render OMR-like markers on screen — cover ALL edges (overlay/cheat tools are small and hug edges) plus a few middle/top/bottom points. A lightweight LOCAL process (JS, or a small packaged efficient binary) runs image recognition on the recorded screen frames (even on a weak CPU) to detect when markers are occluded/missing → an overlay tool is covering part of the screen. Emit **timestamped** alerts (jump-to-timestamp in the recording) naming WHICH markers vanished.
F2.1 **Correlate with focus-change.** Marker-missing *without* a focus change = overlay tool for sure → the real, must-see alert. Marker-missing *with* a focus change + quick return (e.g. one accidental fullscreen exit) = mostly fine → tag the clip for review, not a hard alert.
F2.2 **Fullscreen-exit handling (two alert types).** (a) the overlay alert above; (b) a big/scary/red **fullscreen-exit warning** — reuse the challenge from the earlier iframe session: candidate must type "I will not exit full screen again" within N seconds or the test is blocked/paused until someone re-admits them. Looked good before; polish it.
F3. **Candidate intake + exam shell.**
   - Room number = **pre-fed dropdown** + an "Other" free option.
   - **Compulsory pre-fed student list upload.** Flexible columns (some colleges give email / extra fields). Designate a **unique-ID column**; candidate enters the unique ID first → the rest pre-fills → candidate confirms "yes, this is me" → enters. (This is the candidate-identity model — roster-based, NOT pure self-asserted; answers the own-editor Slice-1 identity question.)
   - **Fullscreen-FIRST anti-proxy.** On opening the link: blank screen, "Go fullscreen now" BEFORE entering name; start proctoring/recording first, then proceed. Then "Welcome" + instructions (don't exit fullscreen / don't switch away → warning 1st time, blocked 2nd; warning-or-not is a configurable setting).
   - **Unique test screen.** A full top bar showing time + candidate name + room; the bar **disappears on any anomaly** so invigilators can spot trouble from across the room. Name + ID on the bar → enables random ID-card spot-checks.
   - **Attendance stats** from the uploaded list — taken / not-taken / absentees list (for the colleges).
F4. **Dynamic time control.** Admin can update the test end-time live, and **"end now"** for everyone (set a new time or end immediately).

NOTE: F3 (roster + ID-confirm login + fullscreen-first + unique top bar) and F4 (live time + end-now) are essentially the own-editor's **candidate-flow + contest-orchestration (Slice 3)**. F2/F2.1/F2.2 are proctoring-integrity features that pair with the editor's fullscreen lockdown. F1 is proctor admin analytics. Fold the overlapping ones into the relevant own-editor slices rather than building twice.

## Decisions log (admin-polish batch)
- Backend + frontend CAN be changed/redeployed now (the "frozen, don't redeploy" rule was situational).
- A2/A4 drill-down is powered by a NEW all-docs `GET /api/admin/sessions-list` (NOT `recording-sessions`, which omits zero-chunk sessions) so card counts == list counts and pending Approve reaches 2nd-device (zero-chunk) sessions.
- `session-details` altNorm derives the de-`@` form ONLY when the raw input starts with `@` (so a real `_alice` username is not conflated with `alice`); degenerate `_` input returns found:false without querying.
- A3 "missing chunks" = recording-gap count + duration (time-gap model), labeled "Recording gaps".
- Demo mode: both stat cards and the Sessions list derive from ONE shared `DEMO_ALL_SESSIONS`; "disconnected" is a deterministic per-row `stale` flag (no wall-clock drift).

## 2026-06-10 morning live-test feedback (Karthi voice, TG ~10:33) — exam-shell UX/enforcement rework [F5]
Fix AFTER the night-run tasks close. From live testing the deployed proctor:
1. **Permission order**: clipboard/camera/screen-share prompts kick the candidate OUT of fullscreen. Rework onboarding: request ALL permissions + screen share FIRST, THEN enter fullscreen (gate order swap in the S1 shell).
2. **Integrity checkpoint popups** ("attendance check"): pops mid-test, candidates are focused — likely useless. Investigate what it actually records (frontend + backend); if it's click-only with no signal value, remove it. Discuss first.
3. **Fullscreen exit = HARD BLOCK, not "status bar hidden"**: full-screen takeover that (a) forces re-entering fullscreen, (b) requires TYPING an acknowledgement ("I will not exit full screen after this") to resume, (c) countdown — if not back in fullscreen within N seconds (default 20, admin-configurable) the test is DISABLED. The current soft anomaly-panel + hidden-bar treatment is too weak.
4. **Switch-away**: long/frequent switch-aways → backend notification to proctor (review video, then decide) instead of auto-blocking with no reason; avoid repeated spurious blocks when something environmental retriggers it.
5. **Per-session enforcement override**: admin/invigilator can disable a specific anomaly enforcement for ONE user session (legit environment problems).
6. **Escalation ladder**: L1 = typed-warning acknowledgement (self-serve); L2 = locked, requires a code from the room proctor (ties into S3 invigilator portal). Optionally "get approval before block" mode.
7. **Top-bar timer ignores test end** (TG voice ~11:32): after the test has ended, the top bar keeps a count-up timer running. The timer must follow the current test status — stop/replace it when the session is ended (and generally reflect status, not wall-clock-since-start).

## 2026-06-10 morning live-test feedback round 2 (Karthi voice, TG ~11:25 + ~11:28) — admin panel [F6]
Karthi reviewed the DEPLOYED admin panel (stale image, predates S2-S7). Do BEFORE resuming the night-run close-out walkthrough; redeploy addresses item 5.
1. **Alerts: bulk archive** — bulk actions exist but bulk archive is missing. Add it.
2. **Alerts: bulk select** — explicitly asked before (BACKLOG item 3 below: "bulk-select, grouping, easier triage") but never built. Add checkboxes + select-all-over-current-filter + bulk actions on the selection. ALSO: run a verification sweep over ALL past asks (incl. BACKLOG item 5's 2026-06-09 forwarded voice messages) to confirm nothing else was lost. **Sweep done 2026-06-10: include alert GROUPING too** — the original ask (TG msg 1581) was "some kind of grouping, some kind of bulk selecting": group related alerts (by candidate and/or type) for easier triage. Build with the F8 admin batch. **GROUPING DONE 2026-06-10** ("Group by" none/candidate/type on the alerts console; collapsible sections with count + worst-severity chip + group-select feeding the existing selection model).
3. **Session detail card/page** — clicking a session in the Sessions list opens a card/page: basic info + current status, basic stats (events, submissions count + times, chunks/duration), view recordings / view events from there, and ONLY the actions valid for the current status (ended → view recordings/events; pending_approval → approve; live → end; etc.).
4. **Alert actions rework** — unclear what "bypass" does. Rethink the per-alert actions: hover tooltips explaining each action, group them, show only actions that make sense for that alert kind/status (no Approve on everything). Be smart per alert type.
5. **Roster/room upload not visible on deployed** — it IS in local commits (S2); fix = redeploy both images. Deploy and tell Karthi; he'll test later.
6. **Camera/other recordings** — screen recordings are visible in review; if camera or other recording sources are saved too, surface that they exist and make them viewable somewhere.
7. **Recordings timeline: events + alerts overlay** — show tagged events AND alerts on the recording timeline, time-coded, filterable (beyond the existing summary): a log list where clicking an entry jumps the scrubber to that timestamp. "Make it very usable" — user-POV usability is the bar.

## 2026-06-10 morning live-test feedback round 3 (Karthi voice, TG ~11:47) — [F8]
0. **PROCESS: stop auto-redeploying.** Deploy only when needed for testing, or when Karthi asks. He'll say when he wants a deploy round.
1. **IP report must be actionable** — like the live-stats cards: click an IP row → drill into which users/sessions are on that IP → take per-user action from there. **DONE 2026-06-10** (row click expands candidate sessions: name/roster id/room/status/start + status-valid actions + "Open session card" deep link).
2. **Drop the HackerRank dependency ENTIRELY** — we are fully off HackerRank. (a) The Review tab still asks for a HackerRank username: redo that feature's purpose without HR usernames. (b) Full-codebase sweep: find every hackerrank_username / HR-URL / HR-naming dependency and remove/rename it (identity should rest on roster unique_id / our own usernames). Research sweep first, then staged removal.
3. **Roster template file** — ship a downloadable template CSV with the compulsory columns + the most-used optional columns pre-named (mark which are compulsory); avoids building a column-mapping UI. (S2 parser already takes flexible columns; this is UX + docs + template download button.) **DONE 2026-06-10** ("Download template CSV" in Settings → Candidate roster; headers unique_id,name + roll_number,email,room, 2 example rows, round-trips through the parser with unique_id auto-picked).
4. **Multi-test support — ACTIVATED** (was BACKLOG item 2, deferred; Karthi says start now): multiple contests instead of the single settings doc. Each contest gets a NAME; the slug is derived from the name. The contest URL field is obsolete (no HackerRank) — remove it as part of F8.2. Per-test settings (incl. the 2-links/2-timings idea from the earlier note), select/activate from a list, per-test scoping of sessions/alerts/roster/problems/reports (contest_slug plumbing already exists everywhere).
5. **Execute the rest of the written-but-unexecuted backlog** — sweep TODO lists for actionable items (e.g. BACKLOG 4: contest-eval adapter + why-no-alerts investigation) and do what can be done without Karthi.

## 2026-06-10 feedback round 4 (Karthi voice, TG ~11:55) — invigilator portal + identity/data-model rethink [F9]
Invigilator portal UX (small, build with the post-F6 wave):
1. **Hide the room-start-gate block when gate is disabled** — only show it when it's actually in use; don't confuse invigilators.
2. **Clickable status counters** — clicking a status stat on top filters the student list below to that status.
3. **Admin-configurable invigilator alerts** — which alert types show on the invigilator room dashboard must be configurable from the admin board.
4. **Alert click → details** — clicking a room alert shows more candidate detail (roll number etc.) within invigilator least-privilege limits.

Identity + data-model RETHINK (big — design-first, Karthi offered a discussion round):
5. **Unique-column identity**: admin designates which roster column is the unique column (e.g. roll number); that value becomes the internal identity (may internally still be called username but NEVER shown as "username" in UI); the configured column LABEL drives every frontend prompt ("Enter your roll number"); uniqueness enforced on that column per contest; cross-contest collisions (same roll number, different colleges/tests) must be impossible by scoping (composite key with contest). S2's unique_id + unique_id_label groundwork exists — this makes it THE identity and kills username-as-concept.
6. **Multi-college, no data bleed**: simultaneous AND sequential college runs with proper settings/filters everywhere (multi-test F8.4 covers the model; this is the acceptance bar).
7. **Per-contest data lifecycle in the admin UI** (today an AI agent pokes the database directly — replace that): download a contest's DB data (scores, sessions, attendance — the light data) as files, then clear/delete it; support re-upload/relocate. Video/evidence files handled separately: retention ~3-4 days after selection, then purge (GCS lifecycle).
8. **Process**: complete rethink with proper methods BEFORE building ("not something random"); consolidated design doc; Karthi available for a discussion round if needed.

## LAST GOAL (after everything else) — recording encoding optimization [F7]
Research-first, then DISCUSS with Karthi before building: best encoding/codec + settings for screen recordings where most of the frame is static (small incremental updates). Evaluate size vs quality vs CPU on candidate laptops (weak CPUs), browser MediaRecorder support (VP9/AV1/H.264 profiles, keyframe interval, bitrate modes), and what the review pipeline/video worker can ingest. Deliverable: comparison + recommendation, NOT an unilateral implementation.
