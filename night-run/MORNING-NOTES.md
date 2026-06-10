# Morning Notes — for Karthi to review (own-editor night run)

This is the first thing to read in the morning. Three sections, kept current through the night.

## 1. What's done + tested (with evidence)
<!-- per slice/feature: built? unit-tested? integration-tested in browser? committed? -->

## 2. Judgment calls I made autonomously (review these)
<!-- decisions taken without you while you slept, with the reasoning, so you can veto/adjust -->

## 3. Open questions / blockers / what I deliberately did NOT do
<!-- anything I couldn't resolve, deferred, or that needs your call -->

---
## Decisions locked BEFORE the run (2026-06-09 pre-compact discussion) — RUN GUARDRAILS

### Scope
- **FIRM** (must be DONE + browser-integration-tested + audited by morning): **Slice 1** — Monaco editor in `StudentApp` (same-origin) + Judge0 adapter Run(sample)/Submit(hidden→verdict) + full editor-event capture (keystroke/insert/delete/paste/cursor/selection/focus/run/submit), all tied to the proctor `session_id`.
- **STRETCH** (build in this priority order; each gets its own spec→plan→build→test; ship as far as quality allows):
  1. Fullscreen-first onboarding + unique top bar (disappears on any anomaly) + 1–5 onboarding progress (at-a-distance invigilation).
  2. Roster upload (flexible columns + designated unique-ID) + unique-ID-confirm login + room dropdown (+ "Other").
  3. Invigilator portal **MINUS the server-signed-QR verification** — room OTP/passcode distribution + a "start now / allow all" bypass (like the admin) + basic room stats + selective alerts.
  4. Problem authoring = **question bank + sample/hidden test cases + time/memory limits + scoring** (replaces Slice 1's placeholder problem). [Confirmed this is what "problem authoring" means.]
  5. Dynamic time + "end now" (admin).
  6. Attendance stats from the roster (taken / not-taken / absentees).
  7. IP-address report (IP-wise count of logged-in users).
- **DEFER** (NOT tonight — own design night): server-signed-QR ID verification; OMR markers + local overlay detection (+ focus-correlation, fullscreen-exit challenge, alert screenshots + jump-to-chunk); keystroke analytics (Slice 4 — needs captured data first).

### Process / policy
- **Commits: LOCAL only, frequent (per task). NO push.** Karthi pushes one-shot in the morning.
- **Done bar:** every shipped piece is a real working app — unit-tested AND browser integration-tested (via the :9222 MCP) — and committed locally.
- **Final audits** (after the build): (a) code review via `~/arogara/code-review` with project-specific guidelines (React/Vite/TS frontend + Node/GCP backend + Judge0 integration + exam UI); (b) security audit; (c) **PII/privacy audit** — use the PII-audit folder under the code-review project.
- **Defaults taken:** Slice 1 placeholder problem "sum-two"; raw editor events → GCS NDJSON per session; candidates see only pass/fail counts on hidden tests (never hidden inputs).

### Dependencies / logistics
- **Judge0 key:** Karthi provides; kept SERVER-SIDE (backend env); used only for live integration tests. Build + test against mocks/demo until then — never block on it.
- **Browser:** Chrome on :9222 (verified UP) for MCP integration testing.
- **Machine must stay AWAKE** — the run only progresses while the machine is awake (it slept ~11h last night).

---
## §1 progress (as of ~01:25) — FIRM Slice 1: BUILT + FIXED + VERIFIED
- **All 11 plan tasks done via TDD** (commits e5c0d2b…0328ef9), then **two adversarial review rounds fixed everything found**: round 1 (13 findings) → F1-F6 fix commits (d199ad5, fb670be, 5960988, aea48b2, 9c8923f); round 2 re-review (6 follow-ons) → 3a8a688 + 792eed9.
- **Suites green at HEAD:** backend 183/183 (node:test), frontend vitest 30/30 + tsc clean + build OK.
- **Browser demo verified on :9222** (student flow → RECORDING → Monaco → typed sum-two → Run 2/2 samples → Submit accepted 4/4 counts-only). Evidence: `night-run/evidence/slice1-workspace-typed.png`, `slice1-submit-accepted.png`. (Screen-share picker can't render in a remote-controlled browser, so the demo stubs getDisplayMedia with a fake monitor canvas stream via CDP initScript — demo technique only, no product change.)
- Key hardening already in: enable_network:false + full explicit limits + ≤20 chunking + 90s poll budget + judging_timeout; UA header (RapidAPI 403 workaround); submit response = counts only (§9 lock); editor-event sanitization preserving 2000-char paste text; source cap 64KB; Object.hasOwn guards; Cloud Run timeout 30s→120s; own-editor copy gating (studentCopy.ts).

## §2 judgment calls (review these)
1. **judging_timeout → candidate verdict "error"** (neutral "Judging failed — submit again"), never wrong_answer: infra failures shouldn't read as candidate failures.
2. **Hidden-test detail**: response carries verdict+counts ONLY; full per-test detail stays in the stored Firestore submission (admin-side).
3. **Editor event text capped at 2000 chars/event** (text_truncated flag beyond) — paste forensics intact, storage bounded.
4. **Submission doc ids = randomUUID()** (was session_id-composed — injection-shaped).
5. **Cloud Run request timeout 120s** to fit the 90s judge poll budget.
6. **Workspace REPLACES the HackerRank link** when a problem is configured; all candidate-facing copy switches via studentCopy.ts (HackerRank wording kept when no problem configured).
7. **Usage throttle** (per your TG ask): one workflow at a time, gate at 90% of measured ceiling, idle till window reset if crossed.

---
## S1 exam shell — BUILT + BROWSER-VERIFIED (~02:10)
- 5 TDD commits (a79b326, 14bb70a, 9ce1526, 8d7a7c6, 0ce7640): pure stage logic + anomaly reducer (61 vitest tests), useExamShell hook, ExamTopBar/FullscreenGate/AnomalyPanel, StudentApp wiring. Suites: 91/91 vitest + tsc + build + backend 232/232.
- **Full 10-point demo browser walkthrough PASSED on :9222** (evidence: night-run/evidence/s1-01…s1-10*.png): gate(ticking clock)→DETAILS→IN EXAM bar(name/room/REC/elapsed)→blur vanishes bar + anomaly panel→stacked fullscreen reason gates restore→restore ⚑1→event audit (topbar_hidden/restored, onboarding_stage, fullscreen_enter/exit)→second episode ⚑2→END: 5 DONE bar persists chip, fullscreen exited→pre-recording exit returns GATE (no anomaly, form value preserved).
- Live bonus finding: integrity checkpoint expiring mid-end-flow counted as a third ⚑ — correct per the pinned anomaly list (session_ended reducer path exercised live).
- Review findings being fixed (wsc2n21df): ⚑ persistence across reload (was React-state-only — evadable); locked screen vs gate overlay precedence. Judgment call: client-side persistence is a deterrent, server events remain the durable record.

---
## DEPLOYED-STACK E2E — PASSED (~04:55) — task #18
- **Both services live on aerele-proctor-dev:** backend https://proctor-api-238846959672.asia-south1.run.app (rev 00001-snb, Judge0 env baked), frontend https://proctor-web-238846959672.asia-south1.run.app (admin unlock = hash of the ADMIN_PASSWORD in .env.deploy.local).
- **Full candidate flow on the deployed stack:** fullscreen gate → details → real session → RECORDING (real public IPv6 captured; camera degraded gracefully to permission_denied; screen chunk-00001.webm in real GCS) → Monaco → **Run 2/2 + Submit accepted 4/4 via LIVE Judge0 through Cloud Run** → submission doc in real Firestore → End test → 5 DONE bar with ⚑ persisting.
- **KEYSTROKE FORENSICS PROVEN ON REAL INFRA:** per-character editor_insert events (text+position+timestamp) + focus + coalesced cursor batched to /api/editor-events → GCS NDJSON; reconstructed the typed string '#api-probe\n' byte-for-byte from the stored events.
- **False alarm survived (important methodology note):** initial deployed runs showed NO keystroke events — root cause was the TEST INSTRUMENT, not the product: CDP type_text does not reach Monaco's hidden textarea in an unfocused remote window (and the demo "typed" screenshot was actually the starter code, which is identical to the solution). Driving Monaco via editor.trigger('keyboard','type',…) proved the full pipeline works. ALL future remote-browser Monaco tests must use editor.trigger.
- **Two items for your review:**
  1. Screen chunk-2+ PUTs to GCS signed URLs intermittently fail with net::ERR_CONNECTION_CLOSED on my home IPv6; chunk-1 succeeded. Pre-existing recorder code (untouched tonight) and it does NOT retry failed chunks — consider a retry queue as a follow-up.
  2. Remote-walkthrough stubs used (demo-only, no product change): fake getDisplayMedia, camera NotFoundError, clipboard stub (clipboard.readText would hang awaiting a permission prompt on the new origin — REAL candidates will see the prompt and click it; not a product bug).

---
## S2 roster login — BUILT + BROWSER-VERIFIED (~05:10)
- **All 7 build tasks done via TDD** (commits 5b7c38f, 6118289, 0d59f47, 782b566, 5979d46, 925a160, f93b94a): backend roster store (versioned-replace, meta-written-last) + public exam-config + masked lookup + /api/session/start roster gate with server-side identity override; frontend pure CSV/TSV parser + mapping heuristics, types + api client with demo parity, admin rooms field + CandidateRosterSection, student IdentityLookupPanel + RoomField.
- **Full suites green at HEAD:** backend 249/249 (node:test, incl. 17 new roster tests), frontend vitest 117/117 + tsc clean + `npm run lint` clean + build OK.
- **Demo-mode browser walkthrough PASSED on :9222** (evidence: night-run/evidence/s2-verify-01…10.png), all 6 plan checks:
  1. Settings: window around now + Rooms "Lab A-1, Lab B-2" saved; rooms text persists after Load current (also confirmed in demo localStorage).
  2. Roster upload via hidden file input: preview 3/3 rows (quoted cell "Raman, Divya" parsed correctly), unique-ID auto-suggests Roll No, mappings auto-suggest Name/Email/Roll/Room (HR username correctly "not in this file") → "Roster saved: 3 students" + status "Roster active: 3 students · ID column Roll No".
  3. Student page: "STEP 1 — CONFIRM YOUR IDENTITY" with label "Roll No"; wrong ID 99XX999 → "could not find that ID" error; lowercase `21cs001` → confirm card 21CS001 / Asha Raman / `as**@example.com` / Lab A-1 (normalization proven). **DOM-asserted: raw email + phone appear NOWHERE in the page HTML; only the masked email renders.**
  4. After "Yes, this is me": name/roll/email prefilled + disabled, username editable (unmapped), room dropdown pre-selected Lab A-1 with both labs + "Other…" (selecting Other reveals free-text input); consent + username → "Start proctoring" enables (screen-share intentionally not completed — needs human gesture; gate itself is unit-test-verified server/demo-side).
  5. "Not you? Re-enter ID" → full reset to the identity step (empty ID, Find me + Start disabled).
  6. Admin "Clear roster" → "Roster cleared — student login no longer requires a roster match"; student reload → legacy details form (no identity step), room dropdown still present.

### S2 judgment calls (review these)
1. **Reused the already-running :5173 demo dev server** (VITE_DEMO_MODE=true, VITE_ADMIN_PASSWORD=dev) instead of starting a second instance with password "admin" as the plan literally said — per the leave-the-dev-server instruction; unlocked with "dev".
2. **S1 FullscreenGate interaction noted, not a bug:** on the student page the first "Find me" click is consumed by the gate (enters fullscreen, stage 1→2); the second click performs the lookup. Expected S1 behavior (any click is the fullscreen gesture); real candidates hit the gate's own button first.
3. Committed the 10 evidence screenshots alongside the notes (repo convention from S1/E2E sections), though the plan's commit listed only MORNING-NOTES.md.

## S2 roster login — BUILT + VERIFIED (~05:05)
- 8/8 plan tasks (5b7c38f…da8c99b): roster store w/ versioned replace, public exam-config + masked lookup, server-side roster gate on session start (identity override + roster_verified stamp), pure CSV/TSV parser (10 vitest), api client + demo parity, admin rooms+roster UI, student identity-confirm + room dropdown, demo browser verification (done by the workflow's own final task on :5173).
- Suites: backend 249/249, frontend 117/117 + tsc + build.
- Review minors being fixed in the S3 workflow's first step: exact-norm check after sanitized-doc-id lookup; version-prefixed entry ids (re-upload window); mapped-blank-cell → ignore typed for name/email/roll. **Morning call:** hackerrank_username KEEPS the typed fallback when roster cell is blank (session key; blank would strand the candidate) — veto if you want strict.

---
## S3 invigilator portal — BUILT + BROWSER-VERIFIED (~06:30)
- 8/8 plan tasks (e1d4402…c5cee18): invigilator auth + overview, room gate release-code/open-room, candidate room-gate poll/unlock + exec block until `exam_started_at`, room dashboard (stats/students/gate/alerts), gate types + pure gateLogic (12 vitest), `/invigilator` portal UI + admin checkbox, student waiting room. **No signed-QR anything** (deferred scope, as planned).
- Suites: backend **271/271**, frontend **121/121** + `tsc --noEmit` clean + `vite build` clean.
- Browser integration (demo mode, Chromium :9222, fresh server on **:5174** with `VITE_DEMO_MODE=true VITE_ADMIN_PASSWORD=dev VITE_INVIGILATOR_PASSWORD=invig`): all 9 checklist items pass — evidence `night-run/evidence/s3-verify-*.png`:
  1. Admin settings: window + **Room start codes** ticked → Save → Load current keeps it ticked (01).
  2. `/invigilator` unlock with `invig` + name Priya → room picker lists Lab A-1 / Lab B-2 / Other… (02).
  3. Lab A-1 dashboard: Recording 3 / Total 12 tiles, students table, room-scoped non-archived alerts only (03).
  4. Release code → 6-digit `824475` rendered huge; **reload + re-unlock re-displays the SAME code** (idempotent); Regenerate (confirm) → fresh `068629` (04, 05).
  5. Start now — allow all (confirm) → badge **"Room OPEN — everyone admitted"**, STARTED EXAM 0→12, every row flips to Started (06).
  6. Student in Lab B-2 (not open): recording starts → **"Waiting for your room code"** panel, coding workspace hidden (07, 07b).
  7. Wrong code → inline "That code is not correct for your room…" (08); released Lab B-2 code `380471` typed → workspace appears (Sum of Two Numbers, Run/Submit) (09).
  8. Fresh student in Lab C-3 + portal **Start now** → student auto-advances to IN EXAM within ~5 s, zero typing (10).
  9. Admin unticks the gate checkbox + Save → fresh waiting student (Lab D-4) auto-released on the next poll, IN EXAM ~1–2 s after save (11). Admin master bypass works.
- **1 fix found by browser verification, own commit c5cee18:** demo `demoSessionResponse` omitted `room_gate_enabled`, so in demo mode every candidate was released instantly and the waiting room could never appear. One-line parity fix mirroring the backend startResponse; lint+vitest+build green after.

### S3 judgment calls (review these)
1. **Plaintext OTP in `proctor_room_gates`** (per plan): it's a short-lived room-coordination code that must be re-displayable, not a credential; online guessing bounded by the 20-attempt per-session cap (429 even with the right code at the cap).
2. **Admin password accepted on invigilator endpoints, in either header** (per plan) — an admin can always open the portal; the invigilator password is closed-by-default when `INVIGILATOR_PASSWORD` is unset.
3. **Re-arm-after-open semantics** (per plan): releasing a code on an OPEN room re-arms the OTP gate for late arrivals only; already-released candidates keep `exam_started_at`.
4. **Roll numbers visible to invigilators** (per plan): room rows show name/username/roll for desk checks; NO email, NO IPs, NO media URLs (verified in Task-4 tests).
5. **Ran browser checks on a second dev server :5174** instead of touching the protected :5173 instance (it lacks `VITE_INVIGILATOR_PASSWORD`; admin-password fallback would have skipped the invig-credential path). :5173 left untouched; :5174 killed after the run.
6. **Screen share + clipboard automated via page stubs** (canvas `captureStream` for `getDisplayMedia`, stubbed `clipboard.readText`): the OS share picker and the clipboard permission prompt cannot be driven by CDP. The plan explicitly allowed an alternate for the share dialog. Side-finding, NOT a bug: a never-answered clipboard permission prompt parks the start flow in "starting" (`collectEntryReviewEvidence` awaits `readText`); real users answer the prompt and rejections are handled.
7. **Demo invigilator dashboard reads the curated fixture sessions (`DEMO_ALL_SESSIONS`), not live demo sessions** — deliberate "demo approximation" from Task 5/6; a live demo student (e.g. Lab C-3) doesn't appear in the demo room table, though gates/poll/release still work against it (that's how items 8–9 passed). Left as designed; flag if you want live-store merge in demo.

---
## AUDIT (front-loaded morning gate) — full report: night-run/AUDIT-REPORT.md
**0 blockers / 11 major / 18 minor / 14 nit** over acdba86..84b1c24 (S3-late + S4 get a delta-audit). gitleaks clean (Judge0 key only in gitignored files, verified untracked). PII scanner clean except the items below.

### ⚠️ PUSH GATE — M1 done in tree, HISTORY scrub still needed by YOU before push
65 contest-eval verdict files with REAL student usernames + cheating verdicts were accidentally committed at acdba86 (my run-prep commit swept all of night-run/ in). I removed them from the tree (commit 6640247) + gitignored, but they REMAIN in history at acdba86. Before pushing, run ONE of:
- `git filter-repo --path night-run/archive-2026-06-05-sshgate-v12/verdict-queue/ --invert-paths` (cleanest; rewrites tonight's commits — all unpushed so safe), OR
- keep the repo PRIVATE and accept the history. 
Do NOT push until this is decided. (I did not rewrite history autonomously — it would disrupt the in-flight S3/S4 lanes sharing this repo, and it's your call.)

### DESIGN-CALL majors for you to decide (NOT auto-fixed — need your judgment)
- **M3 — public /api/roster/lookup is enumerable (bulk PII harvest of up to 5000 students).** The S2 spec itself accepted this for self-serve UX. Options: Cloud Armor/LB path rate-limit, coarse per-IP Firestore counter, a weak 2nd factor (name initial), collapse the two 404 codes. Pick the mitigation.
- **M4 — unauthenticated session start + enumerable unique-id ⇒ impersonation + live-slot pre-emption.** No per-candidate secret since the passcode was removed. Fix needs a per-candidate token (e.g. short-lived token issued by roster lookup) — an auth-design decision. Note this interacts with S3's room-OTP gate (recording runs while waiting; OTP gates exec) which already raises the bar.
- **M6 — initial clipboard snapshot captures PRE-session clipboard content** (App.tsx ~693). Either stop capturing the entry clipboard or disclose it. Privacy call.

### Mechanical majors — QUEUED to auto-fix once S3 frees handler.mjs/App.tsx (no design call)
M2 disclose keystroke capture in consent/rules/what-is-recorded copy · M5 make "clear roster" actually delete entry docs · M7 store validated language not raw body.language · M8 CSV formula-injection guard on admin exports · M9 surface Run/Submit API errors to the candidate · M10 FullscreenGate real modal (focus trap) · M11 AnomalyPanel role=alert/aria-live.

## S4 problem authoring — BUILT in worktree (branch feat/s4-problem-authoring, ~06:25), MERGE PENDING
- 9/9 plan tasks (41e4506…1045d34): Firestore-backed problem bank (validation, scoring per_test/all_or_nothing, async getProblem with sum-two seed fallback), admin problem CRUD endpoints, active-problem assignment in settings, exec reads the bank + submit-time scoring, frontend types + draft logic, api client + demo store, admin "Problems" tab, server-driven candidate problem replacing the SLICE1_PROBLEM constant.
- Worktree suites green: backend 293/293, frontend 128/128 + tsc + build.
- **Built in an ISOLATED git worktree** (parallel to S3 on master) → will be merged into master after S3 lands; handler.mjs/App.tsx conflicts resolved at merge, then re-verified.
- Infra note: the worktree's hardlinked node_modules was broken (cross-filesystem /home→/tmp drops files); a lane repaired it via rsync. Future worktrees on /tmp need a real npm/rsync, not cp -al.
- Deferred to post-merge: S4 demo-browser walkthrough + real-backend smoke (the :5173 dev server is the master checkout).

## S3 delta-audit (the deferred invigilator review) — done
- **Security: CLEAN** — invigilator auth timing-safe + closed-by-default + admin fallback; room-OTP gate enforced SERVER-SIDE on exec/run+submit (waiting-room hide is UX-only, not bypassable); 20-attempt brute-force cap real (429); room_gate_enabled=false = byte-identical legacy. Nits only (extra getSettings() read per exec when gate disabled; OTP plaintext is a documented deliberate choice for a re-displayable room code).
- **PII: one MAJOR (queued to fix)** — M12: `ip_changed` alert embeds "IP changed from X to Y" in alert.detail, and invigilatorRoom projects detail verbatim → a room invigilator sees candidate IPs, violating the handler's own "NO IP addresses" promise. Fix: drop `detail` from the invigilator alert projection (invigilators need only type/severity/title/timestamp) + regression test seeding an ip_changed alert. Also M12b (minor): the projection trusts producer-supplied title/detail generally — scrub to a minimal field set.

## Audit-fix batch — DONE (~07:50)
All mechanically-fixable majors landed in 3 parallel lanes (e0cce53 backend, b02f9ca disclosure/CSV, 1bcb9c2 components), suites 299 backend + 143 frontend green, adversarial re-check confirmed every fix real:
- M12/M13: invigilator responses carry NO session_id (bearer credential) and NO free-text alert detail (was leaking IPs) — regression-tested with a seeded ip_changed alert.
- M7 validated language stored · M5 roster clear actually deletes current-version entries · GATE_ATTEMPT_LIMIT NaN guard · exec hot-path no longer pays a settings read when the gate already passed.
- M2: keystroke-capture disclosure now in consent sentence + rules + What-is-recorded panel (own-editor copy only).
- M8: csvField neutralizes =+-@ formula injection (new pure tests).
- M9: judge failures show "Couldn't reach the judge — try again." (role=alert) · M10: FullscreenGate is a real dialog (aria-modal, focus trap, on-mount focus) · M11: AnomalyPanel announces via role=alert.
- Residual minor (accepted): gate background not literally `inert` — Tab is trapped and aria-modal set; full inert needs DOM test infra we don't have tonight.

---
## S5 dynamic exam time + "End now" — BUILT + SUITE-VERIFIED (~07:40); browser walkthrough DEFERRED
- **All 6 build tasks done via TDD** (commits ec046a6, b30b5f4, 25d846c, e5c4433, 3b9a3c2, 5fe4e40): backend `end_at`+`server_now` on start/resume/heartbeat/stats responses; new `POST /api/admin/exam-time` (set absolute / extend±minutes / end-now) merge-writing ONLY the end-time fields, with `end_now` force-ending every non-ended session in the contest scope (ended_reason `exam_ended_by_admin`, live slots released, bounded concurrency); pure `examTime.ts` math (skew, remaining, H:MM:SS, change classification); types + `adjustExamTime` api client with full demo parity; student skew-corrected countdown in TimerBar + extended/shortened notice (spoken on shorten) + red time-up state + single `exam_time_up` event; admin ExamTimeCard on Live stats (live remaining on the 5 s poll, +15/+5/−5, datetime-local Set, two-click End-now).
- **Full suites green at HEAD (Task 7 verification pass):** backend **307/307** (node:test; incl. 8 new examTime tests), frontend **159/159** vitest (incl. 11 new examTime tests) + `tsc --noEmit` clean + `npm run lint` clean + `vite build` clean.
- **Browser integration (plan step 7.2, demo-mode :9222 walkthrough) NOT performed — deferred per the orchestrator's instruction for this task** (suites only). The 6-step demo checklist (admin card countdown/+15/−5/Set/arm-cancel; student Time-left in the timer bar; ≤15 s heartbeat propagation of extend/shorten notices without reload; End-now → "Test ended" via the 409→B1 self-stop; natural expiry → red time-up bar + voice + End-test still works) remains open for a follow-up session or your morning manual pass.

### S5 judgment calls (review these)
1. **Soft enforcement at end_at:** when the countdown hits zero the student gets the red bar + banner + one voice warning, but recording continues and NOTHING is auto-force-ended — the candidate ends their own test so the manifest upload stays intact. The hard stop is the admin's explicit **End exam now** (force-ends sessions; the next heartbeat 409s → recorder self-stops via the existing B1 path).
2. **No exec-gate on end_at:** Run/Submit are NOT blocked after the end time passes — S3 owned the exec functions tonight (room-OTP gate), so S5 deliberately did not touch them. If you want "judge rejects after end_at", that's a small follow-up in execRun/execSubmit.
3. **End-now scope = current contest_slug** (empty slug matches legacy/no-contest sessions): sessions of OTHER contests are untouched, mirroring the adminStats scoping.

---
## S6 attendance stats — BUILT + SUITE-VERIFIED (~10:10); browser walkthrough DEFERRED
- **All 4 build tasks done via TDD** (commits 8bab193, 0c8f973, 15d52f3, 1f24082): backend `GET /api/admin/attendance` joining the active-version S2 roster against session `roster_unique_id` (taken total/in-progress/completed, not-taken, sorted absentee list with ONLY mapped identity fields, unmatched_sessions for legacy/blank/stale-version ids, optional contest_slug scoping); pure `computeAttendance.ts` (attendance math + RFC-4180 absentees CSV builder, mirrors backend semantics exactly); `fetchAttendance` api client with demo parity (`roster_unique_id` stamped on demo sessions, demo branch reuses the same pure module so demo ≡ production by construction); admin **Attendance** tab — 5 stat cards, unmatched-sessions warning, filterable absentee table, CSV download, 404→"not deployed yet" degrade.
- **Full suites green at HEAD (Task 5 verification pass):** backend **330/330** (node:test; incl. the 10 new attendance tests), frontend **168/168** vitest (incl. the 9 new computeAttendance tests) + `tsc --noEmit` clean + `npm run lint` clean + `vite build` clean.
- **Browser integration (plan steps 5.1–5.7, demo-mode :9222 walkthrough + `night-run/evidence/s6-attendance-demo.png`) NOT performed — deferred per the orchestrator's instruction for this task** (suites only). The demo checklist (empty-state "no roster configured" card; seeded roster of 3 + 1 matched-active + 1 legacy session → cards 3/1/1/0/2 + "1 session could not be tied" note + sorted 2-row absentee table; `vik` filter → 1 row; matched session ended → Completed 1 / In progress 0; CSV button enabled; evidence screenshot) remains open for a follow-up session or your morning manual pass.

### S6 judgment calls (review these)
1. **`pending_approval` and `locked` sessions count as "taken / in progress"** — the student showed up; only `ended` counts as completed, and a student with ANY non-ended session is in-progress.
2. **No auto-poll on the Attendance tab:** loads on tab-open + contest-filter change + manual Refresh only — each call scans the whole roster + session set, so no 5 s polling like Live stats.
3. **Absentee rows exclude email** (PII minimization): exactly unique_id / name / roll_number / room, both in the API response and the CSV.
4. **New top-level Attendance tab** rather than a section inside Live stats (per plan/spec).

---
## S7 IP report — BUILT + SUITE-VERIFIED (~10:25); browser walkthrough DEFERRED
- **All 5 build tasks done via TDD** (commits 8181b83, 3cd4cc5, 78c09b8, 6d53d30, 1c74f3b): backend pure `ipReport.mjs` (group by current_ip||start_ip||"unknown", distinct users via username_norm, per-status counts, rooms, newest-first candidate sample capped at 25, IP groups capped at 200 biggest-first) + `GET /api/admin/ip-report` (scope=live default excludes ended; scope=all for forensics; contest_slug + room filters; invalid scope → 400) + the `getClientIp` last-hop hardening; frontend `ipReport.ts` pure grouping (mirrors backend semantics), `IpReport*` types, `fetchIpReport` with demo branch over `DEMO_ALL_SESSIONS` (404 → null degrade), and the admin **IP report** tab (clusters-first table, multi-user rows warning-tinted, candidate chips with mid-exam-IP-change warning icons, live/all scope toggle, contest-filter re-scope).
- **Full suites green at HEAD (Task 6 verification pass):** backend **330/330** (node:test; incl. the 13 ipReport tests — they landed mid-night, so S6's 330 count already contained them), frontend **174/174** vitest (incl. the 5 ipReport tests) + `tsc --noEmit` clean + `npm run lint` clean + `vite build` clean.
- **Browser integration (plan step 6.2, demo-mode :9222 walkthrough + `night-run/evidence/s7-ip-report.png`) NOT performed — deferred per the orchestrator's instruction for this task** (suites only). The demo checklist (admin → IP report tab: summary "3 distinct IPs across 9 sessions · 2 multi-user IPs · 1 mid-exam IP change" at scope=live; 203.0.113.10/.11 warning-tinted with chips; Divya_P chip carries the IP-changed warning; 198.51.100.42 solo Sneha_B off-campus signal; scope=All grows to 23 sessions / 4 IPs with ended Vikram_T on 192.0.2.77; evidence screenshots) remains open for a follow-up session or your morning manual pass.

### S7 judgment calls (review these)
1. **S7 changed `getClientIp` to trust the LAST `x-forwarded-for` hop (Cloud Run-appended) instead of the spoofable first; existing tests unaffected (single-hop headers).** Local dev (no proxy) still falls back to the socket address.

## S5-S7 final delta-review (4 minors, 3 nits — post-compaction fix list)
- **D1 (minor)**: stale admin Settings-form save can silently revert a live exam-time change (saveSettings writes full settings incl cached end_at). Fix shape: omit end_at from the settings save unless the field was edited, or merge-write.
- **D2 (minor)**: end-now flips sessions to ended server-side BEFORE the student's recorder stops → final chunk + manifest upload 409 (lost) for force-ended sessions. Fix shape: grace window for uploads on admin-ended sessions.
- **D3 (minor)**: endAllLiveSessions query capped at 2000 docs — live sessions beyond the cap never ended (multi-day slug reuse). Paginate.
- **D4 (minor)**: getClientIp last-hop is correct ONLY for direct Cloud Run; any future LB/CDN silently breaks the IP report + ip_changed (needs a trusted-hop count env when infra changes). Documented in code; revisit on infra change.
- Nits: requireAdmin not timing-safe (pre-existing; align with safeEqual) · demo ipReport grouping ignores its own 200-cap · end-now race can overwrite a self-ended session's ended_reason.

## Live-test items from Karthi (~10:35, while testing the DEPLOYED 04:35 image)
- ✅ FIXED (5c850a5): Enter key now submits the admin unlock password. (Note: the deployed instance he tested predates this + S3-S7 — redeploy pending.)
- F5 backlog filed (TODO-admin-polish.md): permission-order before fullscreen, integrity-checkpoint review/removal, fullscreen-exit hard-block + typed ack + 20s countdown, switch-away → proctor notification, per-session enforcement override, L1/L2 escalation ladder.
