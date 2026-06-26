# Proctor — v1.1 Backlog (active cut)

The committed v1.1 worklist. **Direction + deferred (v2) work → [`ROADMAP.md`](ROADMAP.md).
Maintenance rules → [`AGENTS.md`](AGENTS.md).** This is the only active worklist —
nothing is tracked elsewhere.

Status: `☐` todo · `◑` in progress · `✅` done. When an item ships it moves to
`ROADMAP.md` → Done. IDs are stable handles for dispatching work.

---

## Fixes — recording / integrity
- ✅ **REC-1** — Chunk-upload CORS regression. The v1.1 size-cap header
  (`x-goog-content-length-range`) wasn't in the evidence-bucket CORS allowlist, so
  the browser preflight blocked every screen-recording upload. *Fixed: live bucket
  + `backend/gcs-cors.json`. Branch `fix/recording-drain-gate` (765fb9e).*
- ✅ **REC-2** — "Safe to exit" shown with the recording unsaved. The drain gate
  could abort on a status flip and falsely report complete; status-driven paths set
  "ended" with no buffer check; completion copy was hardcoded. *Fixed + 13 tests;
  completion can only say "safe to exit" when the buffer is provably empty, else a
  loud "recording NOT saved — keep tab open, contact invigilator" + Retry. Branch
  `fix/recording-drain-gate` (6dfa081).*
- ✅ **REC-3** — Escape → instant-lock race. *Fixed (`496af04`): humane recovery
  FLOOR on the blocking deadline (`max(reentrySeconds, 15s)`) so an accidental
  fullscreen exit always leaves time to re-enter before the lock; default (20s)
  unchanged, exit-limit ladder unchanged (no enforcement hole, invariant-tested).
  Note: JS can't veto the native Esc → fix is the recovery window + "paused, not
  locked" UX, not a keypress veto. (triage B3)* **Needs a maintainer browser test.**
- ✅ **REC-4** — Admin "chunks uploaded" count is wrong. *Fixed (`6741a58`): admin
  session-detail now reports the ground-truth stored count from a paginated GCS
  prefix listing (`countStoredChunks`), not the over-counting mint counter; mint
  counter kept verbatim for the picker filter + hwm. Spec
  `docs/proposed/admin-upload-telemetry.md`. Backend 1041/1041; card headline reads
  stored count. (B6)* **Card needs the maintainer's morning browser confirm post-deploy.**
- ✅ **REC-5** — Surface pending-upload count in admin session details. *Fixed
  (`6741a58`): `pending_upload_count` = client-reported `buffer_pending_chunks`
  (NOT mints − stored, which is retry inflation — caught + regression-guarded), plus
  raw backlog fields + `last_heartbeat_at`; warning banner + Pending metric when >0
  on an active session. sessionDetail vitest 40/40. (F1)*
- ✅ **TEST-1** — Why tests/health missed REC-1 + a regression guard. Diagnosed
  (`docs/proposed/recording-upload-healthcheck.md`); added
  `backend/test/corsHeaderParity.test.mjs` — asserts every header the backend signs
  on the chunk PUT is in `gcs-cors.json`'s CORS allowlist (fails loudly on drift).
  Verified: 1007/1007 backend tests pass; regression-proven. *(R1; Layer B live
  preflight probe = optional follow-up.)*

## Fixes — candidate UI
- ✅ **CAM-1** — Auto-collapse the camera widget when the camera is unavailable.
  *Fixed (`8feeeb9`): edge-triggered `shouldAutoCollapseCameraDock(prev,next)` →
  collapses to the minimal pill on the transition into "unavailable", respects a
  manual re-expand, available-state behaviour unchanged. CameraDock 3/3. (B5)*
  (Note: current dock has no blue panel — expanded = self-view tile, collapsed =
  pill; auto-collapse drops the dead tile to the pill.)
- ✅ **STUB-1 — PATCHED (live dev bank, 2026-06-24 night-run).** All 3 approved
  offenders **0626-8, 0626-9, challenge-7** written back via the admin API (HTTP 200,
  round-trip-verified all 4 langs; `status`/`hiddenTests` preserved → no live-edit
  409). 0626-8 default now prints `0`, 0626-9 + challenge-7 print `NO`; java fixed to
  `class Main`. challenge-7 cpp corrected to `return "NO"` (string), NOT the spec's
  `0` (expected output is YES/NO). **Same-root-cause but DEFERRED (need the maintainer's OK):
  challenge-3,4,5,6,8,9 JS-`undefined` legs (1-liner each) + challenge-1/2 fully
  broken (unadapted OUTPUT_PATH, not in active use)** — see night-run log. Original
  approved scope below.
- ☑ **STUB-1 — APPROVED 2026-06-23 (night-run).** Offenders confirmed
  (`docs/proposed/stub-return-none-audit.md`): **0626-8, 0626-9, challenge-7** (the
  Python stub crashes with `IndentationError`; JS `solve(){}` → `undefined`;
  JS-`undefined` spans challenge-3..9). Problem stubs are **not version-controlled** —
  they live only in the live problem bank (datastore, written via the admin API) — so
  the fix is a write-back to the live **dev** bank: read each offender, fix the stub
  bodies, rebuild 0626-8/9 scaffold from their live input signature, verify by
  replaying vs sample tests. Prevention (committed problem-seed source) → ROADMAP v2.
  *(B4)*

## Candidate exam flow + copy (consolidated)
- ✅ **FLOW-1** — *Fixed (`496af04`):* clean re-share on manual screen-share stop
  (intentional expected fullscreen-exit via `shell.markExpectedExit` + workspace
  hidden → re-share back through the gate, no reload / no re-prompt for granted
  camera+mic); recovery overlay "paused, not locked" + auto-focused Enter-fullscreen;
  best-effort Escape guard (preserves ALERT-1 dispute-note cancel); in-UI "Refresh
  data" (re-pull config/timer without reload); F5/Ctrl+R + beforeunload kept.
  Permission-drop audit: no rogue drop (streams persist today). **DEFERRED (need
  the maintainer):** record-THROUGH-lock (backend upload-auth policy) — recorder still stops
  on lock. **Needs a maintainer browser test.** Original requirements below:
- ☑ **FLOW-1** — Permission persistence + clean re-share + fullscreen gating
  (merges U1 + U6 + U4). One coherent flow:
  - Once screen + camera + permissions are granted at the start, **never re-ask**
    for the whole session — keep them running.
  - **Block whole-window refresh** (warn on navigate-away: "everything must be
    redone — don't, unless required"); provide an **in-UI data refresh** instead;
    never reload the whole site → never give up screen/camera.
  - **Audit every place we drop permissions on our own** and stop doing it.
  - If the candidate manually stops sharing (out of our control): clean flow — drop
    out of fullscreen, **hide the questions**, ask to re-share, then back to
    fullscreen. No confusion at any step.
  - **Confirm-on-Escape** guard so fullscreen isn't exited by mistake.
  - *Why recording stops on lock* is part of this — keep recording while locked
    where possible; gate questions behind fullscreen.
- ✅ **COPY-1** — Consolidated user-facing copy pass. *Done (`af4761b`): D5 tone
  (clear/calm/respectful/non-accusatory/action-first). Rules page reworded + red-bar
  mention; "I have fixed this" → "I have fixed it — continue my test"; removed "No
  code is needed"; integrity notices de-alarmed to factual "recorded for the proctor
  to review" (stakes kept); share-stop message aligned to FLOW-1. Copy-only; tests
  updated; 1071/1071.* Final strings logged in the night-run log. **Maintainer: sanity-
  check the softened "violation" tone in the morning if you want more deterrence.**

## Features pulled into v1.1
- ✅ **ALERT-1** — Candidate alert feedback + per-user alert suppression. *Fixed
  (`1e63f98`): two-button alert response (acknowledge / "Report a problem with this
  alert" — genuine-fault-only, never unlocks recovery); dispute → server-derived
  `dispute_raised` flag alert (`POST /api/session/dispute-alert`, candidate-token
  auth); admin suppression as a COMMON feature — per-(user,test,type) shared list,
  guard at the single `upsertProctorAlert` chokepoint, contest-scoped, hot-path
  cached. Backend 1062/1062; 41 frontend tests. (F4)* **Dispute-button + admin
  Suppress click need the maintainer's morning browser confirm (no jsdom).**
  - On an alert, a **second button**: "I understand / won't repeat" vs "This alert
    is not correct / unfair / a bug." Copy must make the complain option
    unambiguously for genuine software-mistake / unfair cases only (not for
    everyone).
  - Clicking complain **raises a new alert alongside** (flagging the dispute) → the
    admin alerts dashboard.
  - Admin can **suppress that alert for that user, for that test.** Make suppression
    a **common feature** (like the existing fullscreen suppression): suppressed
    alerts go to a shared list and are suppressed thereafter. Also feeds
    platform-improvement.
- ✅ **ALERT-2** — Per-alert screenshot — capture the last frame (incl. when
  recording has stopped); jump-to-chunk already exists. *Fixed (`247341b`):
  rolling last-good-frame cache in the recorder (works post-`ended`), distinct
  `screenshot/` GCS prefix (no REC-4 collision, neither chunk counter bumped),
  cross-session key guard (fail-closed), signed `screenshot_url`, admin thumbnail.
  Backend 1054/1054; frameCapture 13. (F6)* **Candidate-capture path + admin
  thumbnail need the maintainer's morning browser confirm (no jsdom to unit-test the
  recorder wiring).**
- ✅ **EVID-1** — Filter notable paste/keystroke events and surface them as
  clickable timeline markers in the recording Evidence tab. *Fixed (`11e2965`): new
  admin `GET /api/admin/session-editor-events` (requireAdmin, text blobs excluded,
  8000-cap) + pure `notableEditorMarkers.ts` classifier (large_paste/paste/
  keystroke_burst, thresholds mirrored from eval REPLAY) → amber marker lane in the
  Evidence tab, click-to-seek via existing primitive. Backend 1046/1046; markers
  19 tests. (F10)* **Needs the maintainer's morning browser confirm (Evidence tab) post-deploy.**
- ◑ **BANK-1** — Bulk export/import of problems + templates: multi-select, select a
  template → all its questions; upload them back; handle dedup + cross-instance
  versioning. Spec: `docs/proposed/bulk-problem-template-io.md`. *(F11 — the
  originally-dropped request.)* **Backend done + committed (`8b21ea7`)** — 3 admin
  endpoints, content-hash dedup, preview/commit, fork-to-`-2`, 23 tests. **Admin UI
  DONE (`3838e97`)** — multi-select export + upload→preview→commit dialog wired to
  the live contracts, per-row disposition + override, Apply-gated on dangling refs;
  26 new tests. **Needs the maintainer's morning browser confirm (export/import) post-deploy.**
- ✅ **EVAL-1** — Data-driven eval rule registry: one function per rule so a rule
  can be added/removed/retuned without a code change. *Done (Wave 2a, `034491d`):
  12 detectors → registry, thresholds → config data, behaviour-preserving
  (EVALUATOR_VERSION `4`); golden-parity 45/45 byte-identical vs pre-refactor + full
  suite 1035/1035.* Phase 2 cross-candidate analysis → v2. Spec:
  `docs/proposed/eval-rule-registry.md`. *(F14.)*

## Process (the anti-slip backbone — in progress)
- ✅ **PROC-1** — Unified `ROADMAP.md` + `BACKLOG.md` + `AGENTS.md`/`CLAUDE.md` +
  `docs/proposed/` convention + redundant tracking docs removed. *(M1 + M3)*

---

## Decisions — resolved (2026-06-23)
- **F13 vs F14:** EVAL-1 = the **F14** rule-registry refactor → **v1.1** (in build).
  **F13** (automatic AI verification after every test, task #144) → **v2** (see
  `ROADMAP.md`). They are disjoint: F14 is the behaviour-preserving eval-math
  refactor; F13 is a new auto-run + LLM-judgment capability.
- **M2 — candidate-visible leaderboard:** → **v2** (`ROADMAP.md`).

---

## Live-test review — 2026-06-24 (maintainer's own exam run on the deployed build)
Filed walking the deployed candidate + admin flows. All v1.1 active. Captured
**before** any build (THE ROADMAP RULE / capture-on-ask) so none can slip again.

### Candidate flow — lock / fullscreen / recording (one connected redesign)
- ◑ **LT-1** (BUG, code-complete `c3a0939` — needs browser test) — Coding screen renders while NOT in fullscreen. After a manual
  stop-share → re-share, the workspace/questions showed without fullscreen. **Hard
  rule:** code must NEVER render unless in fullscreen AND recording. (FLOW-1/T7 — the
  gate overlay exists but doesn't gate the re-share render path.)
- ◑ **LT-2** (code-complete `6dd8507`+`c3a0939` — needs browser test) — No-countdown re-entry state. When a candidate returns from an
  exception (re-share, post-lock, came-from-another-state), show a fullscreen block
  "enter full screen to continue" with **no countdown** — don't count them into a
  surprise lock. Countdown applies only to a genuine mid-exam fullscreen exit.
- ◑ **LT-3** (BUG, code-complete `6dd8507` — needs browser test) — Fullscreen-exit lock timer doesn't RESET on re-entry. First
  exit recovers fine; re-enter fullscreen; the *next* exit locks immediately — the
  deadline isn't reset when fullscreen is regained (enforcement.ts: phase not
  returning to idle / deadline reused across episodes).
- ◑ **LT-4** (code-complete `54ea1ef` — 15-min bounded record-through-lock; needs browser test) — Don't give up screen-share when LOCKED. Preferred: keep recording AND
  uploading while locked (we most want to see what they do during a lock); at minimum
  keep the screen-share stream alive (upload may pause). Today the recorder stops on
  lock. **This was yesterday's T7 ask — investigate why it was missed.** (FLOW-1
  record-through-lock, was deferred → pull in.)
- ◑ **LT-5** (code-complete: spec `2abb31a` + B-I/II/III — needs browser test) — Re-express the WHOLE lock/fullscreen/recording flow as a simple,
  explicit state machine: enumerate the few screen states + the exact transition
  conditions. Umbrella over LT-1..LT-4. Design-first.

### Alerts (candidate + admin)
- ◑ **LT-6** (code-complete `87457c5` — needs browser test) — Optional comments field on the in-session red-bar alert (the dispute
  "report a problem" panel has one; the red-bar alert doesn't). (ALERT-1.)
- ◑ **LT-11** (BUG, HIGH, code-complete `a51f71a` — needs browser test) — Dispute + suppression broken in the live build:
  (a) dispute records `window_blur` while the alert shown is `tab_away` — alert_type
  mismatch; (b) Suppress in the dispute → error "a valid alert type, user name and
  candidate ID are required"; (c) suppressed alerts still fire (red bar + new alerts
  keep generating). **ALERT-1 passes unit tests but does NOT work end-to-end —
  REOPEN ALERT-1, fix the live integration, browser-verify.**
- ◑ **LT-12** (code-complete `719bbca` — deep-link floor shipped; needs browser test) — Alert → jump to the relevant chunk/playback at that exact timestamp.
  Ideal: a playback popup that jumps to the chunk with front/back scrubbing;
  acceptable fallback: deep-link to the evidence screen at that timestamp.
  Long-standing ask (≈ old #61; ALERT-2 claims "jump-to-chunk exists" — verify, it
  isn't usable from an alert today).

### Admin — recordings / evidence
- ◑ **LT-7** (BUG, code-complete `46ad737` — needs browser test) — Chunk-count mismatch in LIST views. A session shows 587 chunks
  in the session list AND the evidence/recordings (find-students) list, but the
  detail view shows 0. REC-4 fixed the DETAIL view to the GCS ground-truth count;
  the **list views still read the stale mint count** — point them at the same source.
- ◑ **LT-8** (BUG, code-complete `f85b897` — needs browser test) — Recording review opens the wrong session. Clicking a student in
  the left list always loads that student's LATEST session, not the specific row
  clicked (multiple attempts per student). The session dropdown above the player
  works; the left-list click must target the clicked session.

### Admin — authoring / global UX
- ◑ **LT-9** (code-complete `3e8eb17` — needs browser eyeball) — Select-all / deselect-all checkbox atop the bulk-select lists for
  BOTH problems and templates. (BANK-1.)
- ◑ **LT-10** (code-complete `2452fea` — core pages done; ResultsPanel/Settings/AttendancePanel/SystemHealthPanel/BankImportDialog still inline + tracked; needs browser eyeball) — Floating toast for error/success messages. Today they render at the
  top of the list and scroll out of view (e.g. "Problem referenced" on a blocked
  delete; long contest page). Replace with a pinned/floating toast that stays in
  view; rework the notification element platform-wide.

### Admin — evaluation
- ◑ **LT-13** (BUG, code-complete `759062e` — needs deploy+browser) — "Run evaluation" on the result page errors `VITE_API_BASE_URL
  is not configured.` The run-evaluation call's API base URL isn't baked into the
  deployed frontend build (cf. the build-config bake guard — every `VITE_*` the prod
  build needs must be baked, else the call has no base). Find which `VITE_*` var the
  run-evaluation path reads and make the deploy bake it (extend the bake guard).
- ◑ **LT-14** (BUG, code-complete `759062e` — needs deploy+browser; deploy MUST export EVAL_API_URL=<proctor-eval URL>) — The contest **Evaluation tab** loads the CANDIDATE screen in
  its iframe instead of the eval UI. Eval was split into a separate `proctor-eval`
  service serving `/eval-ui`; the tab's iframe `src` / eval-UI base URL is wrong or
  unset, so it falls back to the candidate origin. Point the iframe at `proctor-eval`
  `/eval-ui` and bake its base URL (likely same root cause as LT-13).

## Forensic audit — 2026-06-24 (reconciliation of the 2026-06-23 morning triage)
28-agent sweep of the morning triage (T1–T11, S1–S6) vs the consolidated docs +
live code, after T1 (page-merge) was found silently dropped in the `e4ca2b9`
from-scratch BACKLOG rewrite. Only the gaps are listed; everything else is BUILT or
legitimately DEFERRED in `ROADMAP.md` (F2/F3/M2/R2/R3).
- ◑ **T1 (page-merge half)** (code-complete `c3a0939` — the originally-dropped item, now BUILT; needs browser test) — Merge browser-check + permission
  setup into ONE onboarding screen; acquire screen-share/cam/mic ONCE and carry the
  live streams forward instead of stop-and-re-ask (today BrowserPreflightGate grabs
  then stops the screen stream, PermissionsGate re-prompts). Copy-half fixed
  (`3f26a58`). Overlaps LT-1/LT-2/LT-5.
- ◑ **T3** (code-complete `87457c5`) — Unlock-button still presumes fault ("I have fixed it"). Reword to a
  no-fault action ("Return to exam"/"Dismiss"); accidental triggers shouldn't admit
  fault. ~1-line in `AnomalyPanel.tsx` + test.
- ◑ **T7** (code-complete `c3a0939` — REVISED: no pre-gate; fullscreen enforced post-unlock via the render-gate, avoiding the BL-3 deadlock; needs browser test) — Gate the unlock-code panel behind being in fullscreen (today it renders
  on lock with no fullscreen precondition). Record-through-lock = LT-4.
- ✅ **T10** (`bf8226c`) — Admin + invigilator copy never audited (COPY-1 swept candidate-side
  only). Sweep those strings.
- ✅ **S5** (`0de7d3f`) — The anti-slip auditor is manual-only (`AGENTS.md` "reconcile at every
  release cut"). Build the **scripted reconcile gate**: diff prior IDs vs the docs,
  fail on any ID with no terminal disposition (BUILT/DEFERRED/DROPPED/FOLDED). This
  is what would have caught T1.
- ✅ **STUB-1 — RESOLVED (Phase C; diffs in `local-notes/stub-diffs-2026-06-24.md`).** All deferred offenders fixed in the live dev bank (challenge-1/2 all langs + challenge-3..9 JS leg), 0 active sessions, status/hiddenTests preserved, re-GET+replay verified. Earlier overclaim: only 3 of 11 known-bad stubs were patched
  (live bank, repo-unverifiable self-report); challenge-1/2 + JS-undefined legs of
  challenge-3..9 are DEFERRED. Verify via a live GET of the 3 offenders; decide the 8.
- → **T9** → `ROADMAP.md` v2 (DSL-driven stub generation — silently dropped, never
  built).

### Reopened (was ✅, but live-test/audit shows incomplete)
- ◑ **ALERT-1** — dispute/suppress fix landed server-side (`a51f71a`, LT-11); needs browser test.
- ◑ **FLOW-1 / T7** — fullscreen render-gate + recovery + record-through-lock all
  built (B-I/II/III, through `54ea1ef`); needs browser test (LT-1..LT-5, LT-4).
- ◑ **REC-4** — list-view chunk counts fixed to GCS ground-truth (`46ad737`, LT-7); needs browser test.

## Live-test review — 2026-06-26 (foreign-paste false positives + activity-log noise)
Owner re-reviewed candidate `REDACTED-ROSTER-ID`'s two `foreign_paste` flags; both are
FALSE POSITIVES (his own typed-then-copied code). Root-caused (proven via the real
`replaySession` on his 8.4k-event stream): the eval's **document reconstruction**
garbles on real edit streams, so `isForeign` can't find self/on-page content. Full
design + proof: [`docs/proposed/paste-detection-and-activity-log.md`](docs/proposed/paste-detection-and-activity-log.md).
- ☐ **EVAL-2** — Fix the foreign-paste detector permanently. Replace the flat-offset
  doc model (`evaluationReplay.mjs` `lineColToOffset`/`applyChange`/`TextBuffer`, which
  clamps out-of-range positions and compounds drift) with a faithful line/column model
  (proven to reconstruct the candidate's real code); also thread the problem
  **statement + sample I/O** into `isForeign`'s on-page sources (`evaluation.mjs:205`
  passes only stubs today) with a markdown-stripped statement variant. Add a candidate's
  occupations + challenge-8 slices as regression fixtures (assert reconstruction = ground
  truth AND not-foreign) + a genuine-external fixture that stays foreign. Re-run eval on
  affected contests to clear historical FPs. Ships with backend deploy.
- ☐ **LOG-1** — Activity log below the recording: classify neutral signals (the normal
  paste marker, focus/blur, cursor bursts, …) as **info**, hidden by default, with a
  **"Show info activities"** filter chip defaulting OFF (info shown only when toggled).
  Raw telemetry stays logged; only prominence changes. Needs a UI code-map first
  (`RecordingReview.tsx` / `notableEditorMarkers.ts`). Ships with frontend deploy.
