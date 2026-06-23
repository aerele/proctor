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
- ☐ **REC-4** — Admin "chunks uploaded" count is wrong. It increments on every
  upload-URL mint (incl. retries) before the PUT (`sessionTelemetry.mjs`), so it
  counts URL requests, not stored objects — inflated/misleading. Make it reflect
  actual stored chunks. *(B6)*
- ☐ **REC-5** — Surface pending-upload count in admin session details, so a proctor
  can see when a recording isn't flushing (pairs with REC-4). *(F1)*
- ☐ **TEST-1** — Why didn't tests / system-health catch REC-1? Analysis + harden:
  add a real check that actually PUTs a chunk through the bucket-CORS path. *(R1)*

## Fixes — candidate UI
- ☐ **CAM-1** — Auto-collapse the camera widget when the camera is unavailable
  (today it shows a blue "not available" panel with manual collapse/expand). The
  pop-out button that caused false "switched-away" alerts is already removed. *(B5)*
- ☐ **STUB-1** — Identify which problem stubs return `none` (the 2–3 bad questions
  from the 06-19 dry-run). Run **all** stubs through Judge0, list the offenders, fix
  them. Diagnosis task, not a release blocker. *(B4)*

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
- ☐ **EVID-1** — Filter notable paste/keystroke events and surface them as
  clickable timeline markers in the recording Evidence tab. *(F10)*
- ☐ **BANK-1** — Bulk export/import of problems + templates: multi-select, select a
  template → all its questions; upload them back; handle dedup + cross-instance
  versioning. Spec: `docs/proposed/bulk-problem-template-io.md`. *(F11 — the
  originally-dropped request.)*
- ☐ **EVAL-1** — Data-driven eval rule registry: one function per rule so a rule
  can be added/removed without a code change. Spec:
  `docs/proposed/eval-rule-registry.md` (build on `eval-logic-and-logs/`). *(F14 —
  ⚠️ confirm vs F13 auto-verify, see Open decisions.)*

## Process (the anti-slip backbone — in progress)
- ◑ **PROC-1** — Unified `ROADMAP.md` + this `BACKLOG.md` + `AGENTS.md`/`CLAUDE.md`
  + `docs/proposed/` convention + cleanup of redundant tracking docs. *(M1 + M3)*

---

## Open decisions (need the owner)
- **F13 vs F14:** EVAL-1 above = data-driven rule registry (F14, as instructed). If
  you meant **F13 — automatic AI verification after every test** (task #144, in
  progress), say so and I'll pull that into v1.1 too / instead.
- **M2 — candidate-visible leaderboard:** undecided; sits in `ROADMAP.md` v2 as
  ⚠️ NEEDS DECISION (was agreed, then a doc deletion left the tree reading it as
  "rejected").
