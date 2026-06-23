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
- ☐ **REC-3** — Escape → instant-lock race. Pressing Esc exits fullscreen, then the
  session locks within ~5s **before** the unlock code can be entered. *(triage B3)*
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
- ☐ **CAM-1** — Auto-collapse the camera widget when the camera is unavailable
  (today it shows a blue "not available" panel with manual collapse/expand). The
  pop-out button that caused false "switched-away" alerts is already removed. *(B5)*
- ☐ **STUB-1 — APPROVED 2026-06-23 (night-run).** Offenders confirmed
  (`docs/proposed/stub-return-none-audit.md`): **0626-8, 0626-9, challenge-7** (the
  Python stub crashes with `IndentationError`; JS `solve(){}` → `undefined`;
  JS-`undefined` spans challenge-3..9). Problem stubs are **not version-controlled** —
  they live only in the live problem bank (datastore, written via the admin API) — so
  the fix is a write-back to the live **dev** bank: read each offender, fix the stub
  bodies, rebuild 0626-8/9 scaffold from their live input signature, verify by
  replaying vs sample tests. Prevention (committed problem-seed source) → ROADMAP v2.
  *(B4)*

## Candidate exam flow + copy (consolidated)
- ☐ **FLOW-1** — Permission persistence + clean re-share + fullscreen gating
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
- ☐ **COPY-1** — Consolidated user-facing copy pass (merges U2 + U3 + U5): reword
  the rules page ("keep your screen shared / don't stop", mention the red top bar,
  relevant rules only); reword the "I have fixed this" unlock button (it can fire by
  accident); remove "no code is needed"; **audit ALL user-facing strings** for sense
  and "nothing the user doesn't need to see."

## Features pulled into v1.1
- ☐ **ALERT-1** — Candidate alert feedback + per-user alert suppression. *(F4)*
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
- ☐ **ALERT-2** — Per-alert screenshot — capture the last frame (incl. when
  recording has stopped); jump-to-chunk already exists. **Build now.** *(F6)*
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
  = Wave 2b** (multi-select export + import dialog; browser-verified on :9222).
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
