# E2E live-product findings — rev 00007 (dev), run 2026-06-11 23:15 → 2026-06-12 00:45 IST

Driver: automated browser session (Chromium :9222, CDP). Candidate run as roster student
**TEC002 / Bharath K**, session `7a7daada-ca6c-4f35-b855-9514ea3e4de8`, contest `e2e-test-round-1`.
Automation note: `getDisplayMedia`/`getUserMedia` were stubbed with live canvas/oscillator streams
(the Chrome picker is browser UI, unreachable for automation; everything downstream — recorder,
chunk upload, surface checks, playback — ran for real). Monaco typing was driven through the
editor's own keyboard-type command (this Chromium runs Monaco in EditContext mode, which ignores
synthetic CDP keys; real keyboards are unaffected).

## VERDICT: SHIP-WITH-NOTES

The candidate path — landing, code entry, roster validation, permissions/fullscreen/details
onboarding, W1 exam shell, Monaco, run/submit/verdicts/cooldowns, multi-problem state,
refresh-resume, end-test — worked end to end with zero blockers. Keystroke/event/heartbeat
telemetry (the live test's core deliverable) is landing fully and with sane timestamps.
Three HIGH findings need awareness/ops-workarounds for tomorrow (all have working workarounds);
F1 deserves a fix as soon as feasible because it silently costs video evidence whenever a
candidate's recording restarts.

## Keystroke / evidence verification numbers (session 7a7daada…, TEC002)

- **Editor events: 1094** in 44 NDJSON batches under `…/editor-events/` (GCS):
  editor_insert **504** (single-character granularity, millisecond timestamps),
  editor_cursor 536, editor_replace 28, editor_delete 3, editor_selection 3,
  editor_focus 3 / editor_blur 5, problem_switched 3, code_run 3, code_submit 6.
  Per-problem split: e2e-sum-of-two-numbers 405 · e2e-reverse-a-string 689.
  First 18:02:28Z → last 18:09:26Z — consistent with actual typing times.
- **Shell events: 183** via `/api/admin/session-events` — fullscreen_exit 4, fullscreen_enter 6,
  screen_share_stopped 1, enforcement ack 1, ip_address_changed 2, chunk_uploaded 98,
  onboarding stages, setup grants. Timestamps 17:56Z–18:36Z, all sane.
- **Heartbeats: 97** (`heartbeat_count` on the session doc).
- **Recording:** 49 screen + 49 camera chunk uploads recorded; 24+24 files in GCS (see F1),
  manifest.json present; review/{tabs,clipboard,cookies}.jsonl present.
- **Judging:** Q1 accepted 3/3 hidden (3 attempts), Q2 wrong_answer 0/2 then accepted 2/2
  (2 attempts); per-problem attempt budgets (n/50) and 20s submit cooldown enforced server-side.
- Admin Results: TEC002 rank 2, 200/200, integrity 5C+2W — matches alerts exactly.

## Findings

### F1 · HIGH — recording chunks are OVERWRITTEN on every recording restart
- **What:** chunk indexes restart at 0 each time recording restarts inside one session
  (share-drop recovery, lock/unlock recovery, refresh-resume). New `chunk-0000N.webm` uploads
  overwrite the previous stint's files at the same indexes. This session made 49+49 uploads but
  GCS holds 24+24 files; files 1–14 carry the FINAL stint's bytes (18:30–18:36Z creation times)
  while 15–24 still carry the FIRST stint (18:05–18:10Z); all intermediate stints are gone.
  `manifest.json` only describes the last stint (28 entries). The review player is honest about
  what survives (plays chunks at their true recorded position) but the "RECORDING GAPS: 4 / 6s"
  summary wildly under-reports ~14 minutes of lost video.
- **Where:** GCS `contests/e2e-test-round-1/sessions/…/7a7daada…/screen/` + Recordings screen.
- **Repro:** candidate session → kill screen share → resume recording → compare session
  `chunk_count` (49) vs `gcloud storage ls` (24); check file `timeCreated` interleaving.
- **Screenshot:** b6-recording-playback-chunk1.png (player at 32:00 playing "chunk 1").
- **Suspected code:** `frontend/src/useProctorRecorder.ts` — chunk index resets with each
  recorder instance; upload key derives from index only. Fix direction: per-stint prefix or a
  monotonic index persisted across restarts; manifest should append, not replace.
- **Live-day impact:** every candidate hiccup (guaranteed at scale) silently destroys the prior
  stint's tail video. Editor/keystroke/event evidence is NOT affected.

### F2 · HIGH — invigilator row actions (Unlock, Exempt) broken for roster/person contests
- **What:** clicking Unlock on a locked student errors `no_locked_session_in_room` (Exempt:
  `no_live_session_in_room`) and the student stays locked. The UI sends the display Candidate ID
  ("TEC002"); the backend matches `username_norm`, which for person-model sessions is the
  person_id ("testengineeringcollege~tec002"); additionally `normalizeUsername()` mangles the
  tilde to underscore, so even a person_id can never match. No input can succeed for roster contests.
- **Where:** /invigilator room console, student rows.
- **Repro:** lock a session via fullscreen expiry → invigilator console → Unlock → error chip.
- **Screenshot:** c1-invigilator-room-console.png (error visible after the click).
- **Suspected code:** `backend/src/routes/invigilator.mjs` `invigilatorUnlock`/`invigilatorExempt`
  (username_norm query ~line 275+); `frontend/src/InvigilatorApp.tsx` `unlockStudent` sends
  `candidateIdOf(row)`. Same identity-mismatch class as F4.
- **WORKING workarounds (both verified):** (a) room **unlock code** read to the student
  (6-digit, reusable — released TEC002 three times); (b) **admin** Unlock on the alert card /
  sessions screen ("unlock applied to 1 session(s)"). Brief hall staff accordingly.

### F3 · HIGH — admin Live screen "Exam time" card ignores the contest scope (legacy-wired)
- **What:** with the scope picker on e2e-test-round-1, the Live-stats Exam time card showed
  "Ends 6/11/2026, 1:00:00 AM · time is up" — the LEGACY schedule — while the contest actually
  had ~22h left. Its +15/+5/−5/Set/"End exam now" buttons post to legacy `/api/admin/exam-time`,
  not the scoped contest. An admin extending time here on live day would silently adjust the
  wrong schedule (and End-now would force-end legacy sessions).
- **Where:** /admin → Live → Live stats (top card).
- **Repro:** scope to e2e-test-round-1 → Live stats → compare card vs contest window. API:
  `/api/admin/stats?contest_slug=e2e-test-round-1` returns scoped counts but legacy `end_at`.
- **Screenshot:** b4-livestats-wrong-examtime-card.png.
- **Suspected code:** `frontend/src/App.tsx` ExamTimeCard endAt from stats `end_at`;
  `runExamTime` → `adjustExamTime` (api.ts → `/api/admin/exam-time`); backend `adminStats`
  returns legacy settings end_at regardless of scope.
- **Workaround (verified):** Contest → Detail → Exam window controls are contest-scoped and work
  (this is where the M0 field lives). Use ONLY that panel tomorrow.

### F4 · MED — Evidence → Review dashboard search by Candidate ID silently empty for roster contests
- **What:** searching "TEC002" returns nothing (no error either). The search calls
  `fetchAdminSessions(username…)` without the stored-key `username_norm` param, hitting the same
  person-model identity mismatch as F2. The backend's exact-key path (FIX-B1) exists but is only
  used when navigating from rows that carry `username_norm`.
- **Where:** /admin → Evidence → Review. **Workaround:** Evidence → Recordings student list works
  (verified, used for playback), as do alert-card jumps.
- **Suspected code:** `frontend/src/App.tsx` ~2542; `frontend/src/api.ts` fetchAdminSessions.

### F5 · MED — candidate warning strip (`reloadWarning`) never clears; shows stale/wrong state
- **What:** any spoken warning sets a persistent strip under the top bar that is NEVER reset.
  After full recovery from a share-drop it kept saying "Screen sharing stopped…"; after an
  unlock+resume it said "Your test has been locked for leaving fullscreen…" while the candidate
  was active and recording. Only a page reload clears it. Confusing for candidates and roaming
  invigilators glancing at screens.
- **Where:** candidate exam shell, below the top strip.
- **Screenshot:** a14-stale-locked-strip-while-active.png.
- **Suspected code:** `frontend/src/App.tsx` `reloadWarning` (line ~248) — `speakWarning()` sets
  it (~595); no `setReloadWarning("")` on recovery anywhere.

### F6 · MED (ops, env-dependent) — bare-domain landing shows the legacy shell, not the code box
- **What:** admin UI copy tells candidates they can "type the code on the landing page at
  <root URL>", but while a legacy settings doc exists, `/` routes to the legacy HackerRank-era
  register shell (by design, candidateRouting.ts fails open). The access-code box is only
  reachable via a bad/absent-contest pinned link. If the prod env still has legacy settings
  tomorrow, students sent to the bare domain cannot enter their code.
- **Action:** verify the live env has no legacy settings doc, or distribute only the full
  `?contest=` link.

### F7 · LOW — ELAPSED timer resets to 0:00 on every recording restart
  Top-strip ELAPSED tracks the recording stint, not the exam. After recovery a candidate 30 min
  in sees "0:00:30". Screenshot a12 (post-restore) vs a10.

### F8 · LOW — invigilator EXAM column always "Waiting"
  With the room start gate disabled, every row (even Finished) shows EXAM "Waiting" in the room
  console. Misleading; suggest "—" or the session phase.

### F9 · LOW — unhandled promise rejections + a11y warning on candidate page
  Locked-phase API rejections (403/409) surface as `Uncaught (in promise)` console errors (5x),
  plus an aria-hidden-on-focused-element warning from Monaco's ime-text-area. Cosmetic; app
  behavior recovered correctly everywhere.

### F10 · COSMETIC — M0 field keeps the raw typed text after save
  After "Save window" the END field still displayed `12/06/2026 9:30 pm` instead of a normalized
  form. The parsed/saved value was correct (verified via API). Consider echoing the canonical
  format on blur/save.

## Notes (not bugs)

- **N1 — 20s re-entry countdown is brutally tight.** Typing the 38-char phrase AND re-entering
  within 20s is hard even for a human; this driver only beat it with an auto-typer. It is
  per-contest config (`fullscreen_reentry_seconds`). Suggest 45–60s for tomorrow unless the
  tightness is deliberate. The ladder itself is correct: every expiry locked exactly as designed,
  and the W5 fix held — the typed phrase resets on each engage, the modal swaps atomically to the
  lock screen on expiry mid-typing (no stale text, no dead overlay), and a completed
  type+re-enter clears everything with no loops.
- **N2 — seeded e2e problems ship solution-complete starter stubs** (python stub for Sum of Two
  Numbers IS the solution). Authoring artifact of the test bank; double-check tomorrow's real
  problems have skeleton stubs.
- **N3 — IP-change detection verified with a REAL mid-session IP change** (IPv6 → 42.104.207.3):
  warning alert + events fired, "Current IP …(changed)" in recording health. Solid.
- **N4 — duplicate-session gate works:** starting TEC001 with an existing locked session went to
  "Waiting for proctor approval / Check again" with identity banner. (Approval path not driven
  end-to-end this run.)
- **N5 — invigilator alert sharing is config-off by default;** enabling "Share with invigilator"
  for fullscreen_enforcement in Settings made all 6 alerts appear in the room console within one
  5s poll (then restored to off). Decide the sharing set before tomorrow.
- **N6 — submit cooldown:** Submit disabled with live countdown "(5s)…" after back-to-back
  submits; server returns retry_after (an earlier 24s-spaced resubmit correctly passed — 20s window).
- **N7 — checklist item "end-of-window behavior" was not directly observed** (would have
  force-ended the contest under test); timer math, +15/+30 live controls (contest panel), and the
  exam_time_up client handler were verified by inspection/config instead.
- **N8 — Monaco in EditContext mode** swallows synthetic CDP keystrokes (automation-only issue;
  this Chromium runs --enable-experimental-web-platform-features). Real keyboards unaffected.

## Screenshot index (night-run/evidence/e2e-live/)

- a1-landing-bad-code-rejected.png — access-code landing + bad-code error
- a2-permissions-stage-done.png — permissions stage all granted (clipboard non-blocking fail)
- a3-roster-bad-id-rejected.png — roster mismatch rejection (TEC999)
- a4-w1-exam-shell.png — W1 shell: collapsed chrome, problems nav, statement, editor, camera tile
- a5-w2-proctoring-expanded.png — Proctoring panel expanded (recording health, chunks)
- a6-run-sample-passed.png — Run verdict (sample passed)
- a7-submit-accepted-q1.png — Submit accepted 3/3 hidden
- a8-submit-cooldown.png — Submit disabled with countdown
- a9-wrong-answer-verdict.png — wrong_answer 0/2 verdict
- a10-both-solved-200.png — 2/2 solved, 200/200
- a11-screenshare-killed-alert.png — share-kill big alert + recovery screen
- a12-screenshare-restored-clear.png — restored, back IN EXAM
- a13-locked-fullscreen-rule.png — lock screen (fullscreen rule) with unlock-code box
- a14-stale-locked-strip-while-active.png — F5 stale "locked" strip while active
- a15-resumed-after-refresh.png — refresh-resume, state intact
- a16-test-ended.png — end-test DONE screen, 28 segments
- b1-admin-nav-live.png — W3 grouped nav + scope picker
- b2-m0-datetime-typed.png — M0 typed datetimes (both formats)
- b3-m0-calendar-popover.png — M0 calendar popover still opens
- b4-livestats-wrong-examtime-card.png — F3 wrong exam-time card
- b5-live-alerts-console.png — live alerts incl. fullscreen enforcement
- b6-recording-playback-chunk1.png — playback playing (stub timestamp visible) + gap summary
- b7-w4-clash-rejected.png — W4 set-code clash rejection
- b8-results-ranked.png — Results: rank/per-problem/integrity
- b9-attendance.png — Attendance
- b10-sessions-drilldown.png — Sessions drill-down
- c1-invigilator-room-console.png — invigilator console (+F2 error chip)
- c2-invigilator-shared-alerts.png — shared alerts visible after config

## State left behind

- e2e-test-round-1 window now 2026-06-11 22:30 → 2026-06-12 21:30 IST; access code 2V6CIQ unchanged.
- TEC002 session ended (200/200); TEC001 old session unlocked→active (admin unlock test);
  two TEC001 pending_approval sessions remain; TEC001 selection snapshot unchanged.
- W4 test contests e2e-w4-draft + e2e-w4-draft-two archived.
- Alert-sharing setting restored to OFF. Admin alert list: 10 entries (testing artifacts).

## RETEST rev 00008 (fix wave 5ef8f9a) — run 2026-06-12 02:45 → 03:30 IST

Driver: same automation rig (Chromium :9222 CDP, canvas/oscillator media stubs, Monaco
keyboard-type). Candidate run as roster student **TEC003 / Chitra M**, session
`da7ddf72-e1ef-4ef5-beba-4cfb3488bc5d`. All three app pages HARD-refreshed onto the new
bundle first; revisions confirmed `proctor-api-00008-m8f` / `proctor-web-00008-sbn`.

### VERDICT: ALL FIXES HOLD — R1–R6 PASS

| # | Item | Result |
|---|------|--------|
| R1 | F1 chunk continuity across recording restarts | **PASS** |
| R2 | F2 invigilator per-row Unlock / Exempt (person-mode) | **PASS** |
| R3 | F3 scoped Exam-time card | **PASS** |
| R4 | F5 stale reload-warning strip | **PASS** |
| R5a | F4 Review search by Candidate ID | **PASS** |
| R5b | F8 invigilator EXAM column | **PASS** |
| R5c | F10 datetime canonical echo | **PASS** |
| R5d | F7 ELAPSED across restarts | **PASS** |
| R6 | clean candidate pass + telemetry | **PASS** |

### R1 — F1 chunk continuity (the big one): PASS

Four stints in one session (start → share-kill/Try-again → refresh/Resume-recording →
lock/unlock/resume → end). Chunk indexes were MONOTONIC the whole way (sessionStorage
HWM observed 4 → 8 → 12 → 24; final indexes reach 29). **Zero overwrites.**

- **Events ledger vs GCS:** screen 22 chunk_uploaded events = **22 files** (1–4, 8,
  12–20, 22–29); camera 25 chunk_uploaded events + 1 success whose event was lost to the
  refresh (index 11, file present) = **26 files** (1–4, 6–8, 10–20, 22–29). Every
  successful upload survives at its own index. On rev 00007 the same scenario produced
  49+49 uploads → 24+24 files with cross-era bytes; that failure mode is gone.
- **Missing indexes are honest, LOGGED losses, not overwrites:** screen 5,6,7,9,10 +
  camera 5,9 failed with `TypeError: Failed to fetch` (preserved console shows paired
  `net::ERR_CONNECTION_CLOSED` — transient connection drops at the kill/refresh
  boundaries, plus one steady-state pair at 02:52:37); screen+camera 21 failed 403
  `session_locked` during the lock blackout (by design). All 9 failures appear as
  `upload_error` events AND as "Chunk upload failed" markers on the review timeline.
- **manifest.json is cumulative across stints** (44 items covering stints 1/2/3/4; on
  rev 00007 it described only the last stint).
- **Playback:** Evidence → Recordings → session plays for real (1280×720 stub frames
  with stint-correct wall-clock timestamps); timeline honestly reports "7 gaps · 10:07
  total" which exactly matches 22×30s = 11:00 of footage on a 21:00 session; jump to
  18:30 lands in stint-4 footage (chunk 18/22) — cross-stint playback works.

### R2 — F2 per-row Unlock/Exempt: PASS

Locked TEC003 via fullscreen-ladder expiry (server `locked_reason: fullscreen_enforcement`).
Invigilator console (tokenized link, hard refresh): per-row **Unlock** on the locked row
succeeded — LOCKED count 1→0, row released, **no `no_locked_session_in_room`**. Per-row
**Fullscreen Exempt** toggled on ("Fullscreen: exempt — click to re-enable") and back off,
no error chips. Candidate "Check again" → Resume recording → re-enter fullscreen → back
IN EXAM with state intact.

### R3 — F3 scoped Exam-time card: PASS

With scope = e2e-test-round-1: card shows green chip "Contest: e2e-test-round-1",
"Ends 6/12/2026, 9:30:00 PM · 18:49:32 left" (NOT legacy/"time is up"). **+5 min** moved
the CONTEST window 16:00Z → 16:05Z (verified via /api/admin/contests); **−5 min** restored
16:00Z; legacy settings end_at (2026-06-10T19:30Z) untouched throughout. Scope = All
contests: card swaps to an explicit grey "Legacy schedule" chip with the legacy
"6/11/2026 1:00 AM · time is up" (buttons not touched).

### R4 — F5 stale warning strip: PASS

After share-drop recovery: no residual "Screen sharing stopped…" strip. After refresh-
resume and after lock→unlock→resume: no residual "Your test has been locked…" strip
(the exact rev-00007 repro). Alert banners clear fully via "I have fixed this".

### R5 — quick sweeps: PASS (all four)

- (a) F4: Evidence → Review search "TEC002" returns session 7a7daada with full detail.
- (b) F8: invigilator EXAM column shows "—" for waiting/disconnected/locked rows and
  "Finished" for finished rows — no stuck "Waiting".
- (c) F10: typed `12/06/2026 9:30 pm` → blur → field echoes canonical `2026-06-12 21:30`.
- (d) F7: ELAPSED continued across every restart (0:02:45 at share-kill → 0:04:00 after
  recovery → 0:07:12 after refresh-resume → 0:18:29 after unlock; never reset to 0:00).

### R6 — clean candidate pass: PASS

Q1 typed char-by-char (real code), Run "Test 1: passed — got 5", Submit
"accepted — 3/3 hidden, 100/100" (attempt 1/50), End test → DONE screen ("44 recording
segment(s) uploaded"). Telemetry for the session: **551 editor events** in 22 NDJSON
batches (editor_insert 275, editor_cursor 259, code_run 1, code_submit 1, focus/blur
across stints), **98 shell events**, **55 heartbeats** — all landed. Console: only
known-expected noise (lock-window 403s; the known-F9 409/unhandled-rejection pattern,
unchanged — F9 was not in this fix wave).

### Residual observations (new, none blocking)

- **RT-1 · MED — chunk uploads are single-shot; no retry.** 9 of 57 chunk uploads this
  session died on transient `ERR_CONNECTION_CLOSED` / lock-window 403 and that video is
  permanently lost (~4.5 min). The losses are now honest (logged + timeline-visible)
  instead of silent overwrites, but a retry-with-backoff would save real evidence at
  candidate scale. One failure pair hit during steady-state recording, not just at
  restart boundaries.
- **RT-2 · LOW — manifest/end-screen under-count surviving files.** Manifest 44 items &
  "44 segments" vs 48 files in GCS: the 4 items of the refresh-interrupted stint (screen
  8; camera 8,10,11) never got persisted to the stint manifest. Files are safe and the
  player (which lists GCS evidence, not the manifest) plays them; bookkeeping only.
- **RT-3 · LOW — Recordings timeline merges the person's OTHER sessions' alerts.**
  "SESSIONS COVERED 2": yesterday's TEC003 session's two lock alerts render at 00:00
  with their own (PM) timestamps on this session's timeline. Honest but potentially
  confusing for a reviewer. Likely by design (person-level review).

### Retest screenshot index (r-*)

- r1-stint1-in-exam.png — stint 1 typing, REC, ELAPSED 0:02:21
- r1-sharedrop-alert.png — share-kill big alert + recovery screen
- r1-stint2-resumed.png — back IN EXAM after Try again
- r1-stint3-after-refresh-resume.png — refresh-resume, clean strip, editor intact
- r1-playback-stint1.png — review player playing stint-1 footage (00:33, chunk 1/22)
- r1-playback-stint4-crossstint.png — jump to 18:30 plays stint-4 footage (chunk 18/22)
- r2-candidate-locked.png — lock screen (fullscreen rule)
- r2-row-unlock-success.png — console after per-row Unlock (LOCKED 0, row released)
- r2-row-exempt-on.png — per-row "Fullscreen: exempt" active
- r3-scoped-examtime.png — scoped card with Contest chip + correct window
- r3-allcontests-legacy-chip.png — "Legacy schedule" chip under All contests
- r4-no-stale-strip-after-unlock.png — post-unlock IN EXAM, no stale strip
- r5a-review-search-tec002.png — Review search returns TEC002
- r5b-invigilator-exam-column.png — EXAM column truthful ("—"/Finished)
- r5c-datetime-normalized.png — canonical datetime echo after blur
- r6-q1-accepted.png — accepted 3/3 hidden, 100/100
- r6-test-ended.png — DONE screen, 44 segments

### State left behind (retest)

- Contest window restored: ends 2026-06-12 21:30 IST; access code 2V6CIQ unchanged.
- TEC003 retest session da7ddf72 ended cleanly (100/200, Q1 solved); old TEC001 sessions
  untouched (1 active-disconnected + 2 pending_approval, all pre-existing); no candidate
  left locked; fullscreen exemption toggled back OFF.
- Invigilator room unlock code unchanged (was already released pre-retest).
