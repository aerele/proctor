# Deployed-product E2E checklist — pre-live-test (2026-06-12)

Run against the DEPLOYED dev stack via Chromium :9222 AFTER the walkthrough fixes deploy.
Web `https://proctor-web-ej4cpz43iq-el.a.run.app` · API `https://proctor-api-ej4cpz43iq-el.a.run.app`
Existing test contest: `e2e-test-round-1` (access code 2V6CIQ — may change if W4 testing alters it; invigilator link in RESUME-ANCHOR §3).
Evidence: screenshots → `night-run/evidence/e2e-live/`. Every ✗ → fix → commit → redeploy → re-run the FULL candidate pass.

RUN 2026-06-11/12 (rev 00007): full report in `evidence/e2e-live/FINDINGS.md` — VERDICT: SHIP-WITH-NOTES.

## A. Candidate (above all — must be flawless)
- [x] Landing via `?contest=` + access code; bad code rejected cleanly (a1; note F6: bare `/` shows legacy shell while legacy settings exist — code box only on pinned-bad links)
- [x] Onboarding: details form, permissions-first stages, email validation (a2/a3; roster mode = Candidate ID + room, no email field; bad roster ID rejected cleanly)
- [x] Fullscreen gate: enforced BEFORE test starts; W5 — exit/re-enter cycles 4x: alert shows on exit, clears on re-enter, NO looping/stuck/double overlays; phrase resets each engage; expiry-mid-typing swaps cleanly to lock screen (✗-adjacent note F5: `reloadWarning` strip never clears after recovery — stale "locked" text while active)
- [x] W1 layout: problems list front-and-center → click → editor IS the page; proctoring chrome collapsed; no distractions (a4/a5)
- [x] W2 cue: subtle indicator when normal; big bar ONLY on real issue (killed screen-share → big alert + recovery; restore cleared it) (a11/a12; F5 stale strip is the one blemish)
- [x] Editor: Monaco typing, language switch, stubs (autocomplete not explicitly exercised; typing via Monaco command path — EditContext swallows synthetic CDP keys, real keyboards fine; N2: seeded stubs ARE solutions)
- [x] Run (visible tests) + Submit (hidden tests): verdicts correct (accepted 3/3, wrong_answer 0/2, fix → accepted 2/2), cooldown respected (Submit "(5s)" countdown; server retry_after) (a6–a10)
- [x] Multi-problem: switch problems, per-problem state survives (code + language per problem; per-problem attempt budgets)
- [x] **Keystroke/event data lands in backend**: 1094 editor events (504 per-char inserts, ms timestamps, per-problem split 405/689, problem_switched/code_run/code_submit markers), 183 shell events (fullscreen exits/enters, share-stop, IP change), 97 heartbeats — all timestamps sane (FINDINGS.md numbers section)
- [x] Recording: screen+camera chunks uploaded (49+49 uploads); admin player plays them on a true timeline ✗ **F1 HIGH: chunk indexes restart on recording resume and OVERWRITE prior stint files — 24+24 survive of 49+49; manifest covers last stint only; gap summary under-reports** (b6)
- [~] Timer + end-of-window behavior; finish/lock flow — LEFT/ELAPSED timers ok (✗ F7 LOW: ELAPSED resets per recording stint); lock flow exercised 3x (countdown expiry → lock → unlock-code release); finish flow clean (assurance checkbox → Test ended, a16). End-of-window expiry NOT directly observed (N7 — would have ended the contest under test)
- [x] Refresh mid-test → resumes cleanly (same session, no re-onboarding, editor code + scores intact; recording restart correctly requires a fresh gesture) (a15)

## B. Admin (sanity + new features)
- [x] W3 nav: contest filter ABOVE screen buttons; reorganized header reads clean; every screen reachable (Live stats/Live alerts/Sessions/IP report/Contests/Attendance/Results/Review/Recordings/Problems/Templates/People/Settings) (b1) ✗ **F3 HIGH: Live-screen "Exam time" card ignores the contest scope — shows/writes the LEGACY schedule; use Contest→Detail panel instead** · ✗ F4 MED: Evidence→Review search by Candidate ID empty for roster contests (Recordings list works)
- [x] W4: custom test code happy path (KEC226 on draft); clash vs open contest rejected with precise error (b7); activation blocked on clash ("Cannot open this contest: its test code KEC226 is already used by the open contest…"); regenerate works (drafts archived after test)
- [x] M0: typed datetime entry — `2026-06-11 22:30` and `12/06/2026 9:30 pm` both parsed and saved correctly (verified via API); calendar popover still opens (b2/b3; F10 COSMETIC: field shows raw typed text after save)
- [x] Live stats reflect the candidate session in real time (LIVE 1 while in exam; ended afterwards); live alerts fired for fullscreen exits (3x fullscreen_enforcement critical) + share-stop + recording-stop + REAL ip_changed + tab_hidden (b5)
- [x] Results: rank/per-problem/integrity for the test session (TEC002 rank 2, 100+100, 5C+2W badges; CSV export, selection states) (b8)
- [x] Recording review: played the just-recorded session — video renders + advances, chunk placed at true recorded time (stub's in-frame timestamp matched timeline position), event/alert lanes + jump-to work (b6; gap summary misleading per F1)

## C. Invigilator (sanity)
- [x] Tokenized portal loads; room stats render (status chips + student rows); shared alerts appear per share-config (verified by toggling fullscreen_enforcement sharing → 6 alerts appeared; restored to off) (c1/c2). OTP/start-now path: room start gate disabled for this contest — unlock-code path exercised instead (3 successful candidate-typed releases) ✗ **F2 HIGH: per-row Unlock/Exempt buttons broken for roster contests (identity mismatch + `~`→`_` mangling); room unlock code and admin unlock both work** · ✗ F8 LOW: EXAM column always "Waiting"

## D. Cross-cutting
- [x] No console errors on any page during the passes — admin: only a 409 from a deliberate negative test; invigilator: the F2 404; candidate: expected 403/409/429 from locked-phase + cooldown probes ✗ F9 LOW: those rejections also surface as unhandled promise rejections + one Monaco aria-hidden warning
- [~] One FULL clean candidate pass (A top-to-bottom) — completed top-to-bottom (onboard → solve both → end, 200/200) with deliberate fault-injection mid-pass per W2/W5; no unexpected ✗ in the happy path itself. Bugs found are listed above and in FINDINGS.md.
