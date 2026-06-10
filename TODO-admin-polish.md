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
5. **Yesterday's forwarded voice messages** (Karthi forwarded them to the proctor topic 2026-06-09) — triage + detail into items here.

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
