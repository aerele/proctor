# Candidate-flow state machine — v1.1 lock / fullscreen / recording + onboarding redesign

Status: **proposed (design spec only — no code changed by this doc).** **Critique pass 2 folded — GO (see §8).**
Scope: the candidate runtime in `frontend/src/candidate/StudentApp.tsx`, its
shell (`frontend/src/shell/*`), the recorder (`frontend/src/useProctorRecorder.ts`),
and two backend upload/heartbeat-auth guards. It drives the build steps **B1–B7** (§6).

Every "current behaviour" claim below cites a real `file:line` against the `v1.1`
branch, re-verified line-by-line in the critique-pass-2 code-grounding sweep (§7,
§8). Where the previous draft's paths/lines had drifted, they are corrected here
(e.g. `StudentApp.tsx` is `frontend/src/candidate/StudentApp.tsx`; `UnlockCodePanel`
is `frontend/src/candidate/panels/UnlockCodePanel.tsx`).

---

## 0. Why this spec exists — the two structural gaps today

1. **The workspace is not gated on `fullscreen && recording`.** The exam UI (W1)
   renders when `hasProblem && status === "recording" && gate === "running" &&
   !examGateActive && recordingState?.examViewAllowed`
   (`frontend/src/candidate/StudentApp.tsx:2062`). There is **no `shell.fullscreen`
   term** in that guard. Fullscreen is enforced *only* by overlay components painted
   on top (`FullscreenGate` at stage 2, `EnforcementOverlay` on exit) while the
   workspace stays mounted underneath (W1 keeps every capture/preview host mounted —
   `StudentApp.tsx:2139-2148`). A gap in overlay coverage = a candidate seeing
   questions out of fullscreen. **LT-1 closes this by making the render itself
   require `fullscreen && recording`.**

2. **Onboarding double-prompts for the screen + camera.** The browser-check stage
   acquires a screen stream and **immediately stops it** — `probeScreenCapture`
   acquires then `stopStream(stream)` in its `finally`
   (`frontend/src/shell/browserPreflightProbe.ts:105-119`); `probeCameraMic` does
   the same (`browserPreflightProbe.ts:125-146`). Then a **separate** stage,
   `PermissionsGate`, re-acquires screen + camera/mic + clipboard via
   `runPermissionsSetup` (`StudentApp.tsx:442-453`) before the live streams are
   finally handed to the recorder as `acquired` and reused
   (`useProctorRecorder.ts:1091-1113`). So the candidate picks "Entire Screen" at
   least twice. **DEC-2/T1/LT-2 collapse this to one acquire.**

   **Critical (MA-4): the merged single acquire must be the SURFACE-GUARDED one.**
   `probeScreenCapture` calls `getDisplayMedia({ video: true })` with **no
   `displaySurface` guard** — it only checks the track is not `ended`
   (`browserPreflightProbe.ts:112-114`). The real anti-spoof guard lives in
   `acquireScreenShareStream`, which rejects any `displaySurface !== "monitor"`
   (`useProctorRecorder.ts:219-225`). The recorder's reuse path checks ONLY
   `readyState === "live"` (`useProctorRecorder.ts:1095`) — **not** surface — and
   re-aligns constraints without re-checking the surface (`:1099-1103`). So if the
   single acquire were the un-guarded probe, a candidate could pick "This Tab",
   have it pass `readyState === "live"`, and that tab-share becomes the recording —
   defeating the entire-screen block. **The one acquire MUST be
   `acquireScreenShareStream` (monitor-surface-guarded), never `probeScreenCapture`.**

Two additional locked decisions:

3. **Re-entry from an exception must NOT show a countdown** (DEC-2/LT-5). The
   countdown is a recovery affordance for a *genuine mid-exam exit*; a re-entry
   after a server lock (post-unlock) must be a plain "return to fullscreen" block,
   not a ticking deadline. Today the only non-idle fullscreen states are
   `blocking` (which *always* shows a countdown — `EnforcementOverlay.tsx:175-180`,
   driven by `enforcementRemainingSeconds` `enforcement.ts:294-297`), `locking`,
   `alert_hold`, and the take-home `soft` nudge (phase declared at
   `enforcement.ts:73`, overlay branch `EnforcementOverlay.tsx:108-148`). There is
   no "blocked, no countdown, not a violation" state. **LT-5 introduces one
   (`fs_block`).**

4. **Recording + uploads must survive a lock** (DEC-1/LT-4/T7). Today a lock
   *stops* the recorder by **two independent paths**, both of which must change:
   - the enforcement `onLocked` callback calls `active.stop()`
     (`StudentApp.tsx:518-536`, stop at `:525`) and `setStatus("idle")` (`:529`);
   - the recorder also self-stops when an upload/events/drain error maps to a lock —
     `fatalStatusFromError` maps `403`/`session_locked`→`"locked"`
     (`useProctorRecorder.ts:328-336`) and the 6 error consumers feed that to
     `handleFatalStatus`→`controls.stop()` (`:522-527`); **AND separately**, the
     heartbeat-**SUCCESS** path passes the raw status string straight to
     `handleFatalStatus(response.status)` (`useProctorRecorder.ts:1006-1008`) — this
     does **NOT** go through `fatalStatusFromError`, so it must be de-fatalized on
     its own (see BL-1/B5).

   And even if the recorder kept running, the backend **rejects chunk uploads while
   locked**: `requireWritableSession` throws `httpError(403, "session_locked")` at
   `backend/src/lib/sessionStore.mjs:36`, reached from the upload-URL handler
   `createUploadUrl` at `backend/src/routes/sessionTelemetry.mjs:96`. **LT-4 keeps
   the recorder alive and adds a BOUNDED locked-tolerant upload path (MA-1/MA-2).**

---

## 1. States

The candidate screen today is selected by an ordered cascade of early-`return`
branches at the end of `StudentApp` (`frontend/src/candidate/StudentApp.tsx`),
keyed on two orthogonal atoms — `gate: StudentGate` (`"form" | "pending_approval" |
"locked" | "ended" | "running"`) and `status: SessionStatus` — plus a derived
numbered `stage` 1–5 (`examShell.ts deriveStage:51-60`) that picks the onboarding
overlay. This spec keeps that two-axis model and adds the explicit named
screen-states below. "New?" marks a state this redesign introduces.

| State | New? | One-line definition |
|---|---|---|
| `ENTRY_FORM` | — | Pre-session form stage: identity + consent. `gate==="form"`, `status` not recording. Today this is also where preflight/permissions/fullscreen overlays stack. |
| `ONBOARDING` | reshaped | **The single onboarding screen (LT-2).** Browser checks 1–4 run, then screen-share + camera/mic + clipboard are acquired **once via the surface-guarded `acquireScreenShareStream` (MA-4)**; those live streams are carried into the recorder. Replaces the BrowserPreflightGate→PermissionsGate double-acquire. |
| `IN_EXAM` | — | The workspace/questions are rendered. **Guarded by `fullscreen && recording` (LT-1).** Maps to the W1 branch `StudentApp.tsx:2062` plus the new `&& shell.fullscreen` term. |
| `FS_BLOCK_NO_COUNTDOWN` | **yes** | A fullscreen block with a "Return to fullscreen" button and **no countdown** (LT-5). Shown **POST-unlock** (after a valid unlock flips gate locked→running while the candidate is out of fullscreen) and after a forced re-share. Not a violation; consumes no exit budget; sets no deadline. Encoded as enforcement phase `fs_block` (§3). |
| `BLOCKING_COUNTDOWN` | — | The genuine mid-exam fullscreen-exit recovery: red takeover with the ticking deadline + typed-ack (or simplified re-enter). `enforcement.phase==="blocking"`, `EnforcementOverlay.tsx:175-180`. **Reached ONLY from a mid-exam exit while recording** (T-1). |
| `ALERT_HOLD` | — | `alert_first` mode hold after a violation: proctor alerted, overlay holds, no lock. `enforcement.phase==="alert_hold"` (`enforcement.ts:142`). |
| `LOCKING` | — | Transient: a violation fired in `block` mode; the report POST is in flight and will lock server-side. `enforcement.phase==="locking"` (`enforcement.ts:142`). |
| `LOCKED` | reshaped | `gate==="locked"` (`StudentApp.tsx:1860`). The locked screen owns the viewport (early return at `:1860-1901`). **DEC-1: the recorder + uploads stay ALIVE here** (status stays `"recording"`, see §3/B5). **The `UnlockCodePanel` stays ALWAYS visible while locked (BL-3 — no pre-unlock fullscreen gate).** Fullscreen is enforced POST-unlock, not here. |
| `RECOVERY` | — | The anomaly-episode re-entry surface (`AnomalyPanel`) used by share-drop / blur episodes; restore requires `fullscreen && visible && recording`. Distinct from the enforcement overlay. REC-3 floor lives here-adjacent. |
| `SOFT_NUDGE` | — | Take-home pre-T0 nudge: calm "back to fullscreen", no countdown, nothing counted. `enforcement.phase==="soft"` (declared `enforcement.ts:73`, overlay `EnforcementOverlay.tsx:108-148`). Unchanged. |
| `WAITING_ROOM` / `COME_BACK_LATER` | — | Take-home pre-T0 holds while recording. Unchanged. |
| `PENDING_APPROVAL` / `ENDED` / `ERROR` | — | Lifecycle terminals. Unchanged. |

**Key relationship:** `FS_BLOCK_NO_COUNTDOWN` and `BLOCKING_COUNTDOWN` are *both*
"you are not in fullscreen, recording is live, fix it" — they differ only in
**whether a deadline is armed**. The redesign encodes that difference as a new
enforcement phase (`fs_block`, §3) rather than a UI flag, so the no-countdown
property is a state invariant the reducer enforces, not a render-time branch that
can drift.

**Why `LOCKED` no longer hides the unlock panel (BL-3).** The earlier draft hid the
`UnlockCodePanel` until the candidate was in fullscreen. That **hard-locks an honest
candidate**: while `gate==="locked"` the codebase *deliberately* suppresses **every**
fullscreen affordance — `enforcementOverlayVisible` returns false when
`gate==="locked"` (`enforcement.ts:288-290`) and `fullscreenGateVisible` is
suppressed-when-locked (`examShell.ts:92-98`, the `input.gate !== "locked"` term at
`:98`). The locked branch itself (`StudentApp.tsx:1860-1901`) renders only
`shellChrome` + `BlockedScreen` + (conditionally) `UnlockCodePanel` and returns
EARLY — it paints **no** enforcement overlay and **no** fullscreen gate. So a locked,
out-of-fullscreen candidate with the panel hidden would see neither the panel nor any
way to re-enter fullscreen → deadlock. **Fix: keep the unlock panel always visible
while locked; move the fullscreen requirement to a POST-unlock step (§3, B6).**

---

## 2. Transitions

`(from-state, event, guard, to-state, side-effects)`. Events are the existing
`EnforcementAction`s (`enforcement.ts:116-127`) plus shell/lifecycle events, with
the new action/phase this redesign adds. Side-effects name the concrete call.

| # | From | Event | Guard | To | Side-effects |
|---|---|---|---|---|---|
| T-a | `ENTRY_FORM` | "Check & set up" gesture | browser checks 1–4 pass | `ONBOARDING` (acquiring) | run passive+active checks, then **acquire once via the monitor-surface-guarded `acquireScreenShareStream` (`useProctorRecorder.ts:203-228`)** + `acquireCameraMicrophone` + clipboard primer (the `runPermissionsSetup` body `StudentApp.tsx:442-453`), store into `acquiredMediaRef`. **No `stopStream` on the streams that will be reused.** |
| T-b | `ONBOARDING` | screen+confirm done | `permissionsReady` true AND consent complete | `ENTRY_FORM`→enter-fullscreen | `confirmPermissions()`; stage advances 1→2 (`deriveStage:53→54`). |
| T-c | enter-fullscreen | "Enter fullscreen" gesture | `requestFullscreen` resolves | start recording | `beginRecording(session)` → `createProctorRecorder({...acquired})` `.start()`; streams reused, **no second prompt** (`useProctorRecorder.ts:1094-1103`). `setStatus("recording")`. |
| T-d | start recording | recorder started, exam released | `hasProblem && status==="recording" && gate==="running" && !examGateActive && recordingState?.examViewAllowed && shell.fullscreen` (**LT-1: `&& shell.fullscreen` is the new term on the W1 guard `StudentApp.tsx:2062`**) | `IN_EXAM` | render W1 workspace (`MultiProblemWorkspace`, `StudentApp.tsx:2152-2157`). |
| T-1 | `IN_EXAM` | `fullscreen_exit` | `recording && !expected && !exemptFullscreen && !softMode` (the `softMode` early-return is `enforcement.ts:208,212`) AND a genuine mid-exam exit | `BLOCKING_COUNTDOWN` | `enforcementReducer` fullscreen_exit branch (`enforcement.ts:207-240`): `exitCount+1`, **fresh** `deadlineMs = now + max(reentrySeconds, MIN_RECOVERY_SECONDS)*1000` (`enforcement.ts:47,230-232`). Overlay shows countdown (`EnforcementOverlay.tsx:175-180`). |
| T-2 | `BLOCKING_COUNTDOWN` | `fullscreen_change{fullscreen:true}` + ack matched (or simplified) | `tryResolve` ack && fullscreen (`enforcement.ts:162-169`) | `IN_EXAM` | `released(state)` → phase `idle` (`enforcement.ts:154-156`); deadline cleared; emit `fullscreen_enforcement_ack`; `onResolved()` → `shell.restoreBar()` (`StudentApp.tsx:540`). |
| T-3 | `BLOCKING_COUNTDOWN` | `tick` past deadline OR `exitCount > exitLimit` | block mode | `LOCKING` | `violate(...)` (`enforcement.ts:138-150`) → POST `report_violation`. |
| T-3' | `BLOCKING_COUNTDOWN` | same | `alert_first` mode | `ALERT_HOLD` | `violate(...)` sets phase `alert_hold` (`enforcement.ts:142`). |
| T-4 | `LOCKING` | `violation_result{locked:true}` OR heartbeat reports `status==="locked"` | server locked | `LOCKED` | `onLocked` (`StudentApp.tsx:518-536`): `setLockedReason`, `setGate("locked")`. **LT-4 (B5): do NOT call `active.stop()` (`:525`) and do NOT `setStatus("idle")` (`:529`) — keep `status==="recording"` so the recorder + heartbeat + upload loop stay live.** |
| T-5 | `IN_EXAM` | screen-share `track ended` (candidate stops share) | not `stopping` | `RECOVERY` (anomaly) | recorder `onFatalError` (`useProctorRecorder.ts:1120-1142`); `AnomalyPanel` screen-share branch. |
| T-6 | `RECOVERY` | "Try again — share entire screen" | new share acquired, **surface = monitor** (`acquireScreenShareStream`) | re-enter → **`FS_BLOCK_NO_COUNTDOWN`** then `IN_EXAM` | `retryScreenShare` → `resumeRecording()`/`beginRecording`. **LT-5: the post-re-share fullscreen prompt is the NO-countdown `fs_block`, not a countdown.** |
| **T-7** | `LOCKED` | `UnlockCodePanel` submit OK | enforcement lock + valid unlock code | `running` (gate flips locked→running, **status stays `"recording"`**) → **`FS_BLOCK_NO_COUNTDOWN` if out of fullscreen, else `IN_EXAM`** | `unlockEnforcementGate` (`frontend/src/candidate/panels/UnlockCodePanel.tsx`); `onUnlocked` clears `lockedReason` + `refreshStatus` (`StudentApp.tsx:1893-1896`). The gate-left-locked effect resets the ladder to a fresh episode (`useEnforcement.ts:266-275`). **Then** the host dispatches `require_fullscreen` (§3) — if `!fullscreen`, phase → `fs_block` and the W1 render-gate (B2) keeps the workspace from rendering; the `fs_block` overlay shows until the candidate re-enters fullscreen. |
| T-8 | any active enforcement phase | `config_change` exemptFullscreen | `exemptFullscreen` set live (`enforcement.ts:183-184`) | `IN_EXAM` | `released(state)`. Unchanged. |
| T-9 | `SOFT_NUDGE` | `config_change` softMode→false (T0) | `!softMode && phase==="soft"` (`enforcement.ts:201-203`) | `IN_EXAM`/`WAITING_ROOM`→`IN_EXAM` | phase→`idle`, ladder starts clean at `exitCount=0`. Unchanged. |

**The genuine-vs-return distinction (T-1 vs T-6/T-7).** Today every exit while
recording goes through the one `fullscreen_exit`→`blocking` path
(`enforcement.ts:207-240`), which always sets a deadline. This spec splits the
re-entry trigger: a *fullscreen exit during the exam* (T-1) arms the countdown; a
*re-entry demanded by an exception we already handled* — post-re-share (T-6) and
post-unlock (T-7) — must NOT arm a countdown (LT-5), so it routes through the new
`fs_block` phase (§3) instead.

**T-7 is the redesigned path (BL-3).** Old design (drop): hide the unlock panel
until fullscreen. New design: the unlock panel is always visible while locked; the
candidate unlocks first (gate locked→running, status still recording); only THEN —
once they are back in a writable, running session — is fullscreen enforced, via the
B2 render-gate plus the `fs_block` overlay. The exam workspace still **never renders
outside fullscreen** (the W1 guard B2 forbids it regardless of phase), so T7's intent
("no exam content outside fullscreen") is fully preserved — without the deadlock.

---

## 3. The enforcement-phase change for the no-countdown re-entry (`fs_block`)

The cleanest encoding that keeps the no-countdown property a *reducer invariant*
(not a fragile render flag) is a new non-deadline phase:

- **Add phase `"fs_block"`** to `EnforcementPhase` (`enforcement.ts:73`): "must be
  in fullscreen to proceed, but this is NOT a violation episode — no deadline, no
  exit-count increment, no report."
- **`enforcementRemainingSeconds`** (`enforcement.ts:294-297`) already returns
  `null` for any phase other than `"blocking"`, so `fs_block` renders **no
  countdown** with zero change there — the `phase === "blocking" && remainingSeconds
  !== null` guard (`EnforcementOverlay.tsx:175`) is already false for it.
- **Add an `EnforcementAction` `{ kind: "require_fullscreen"; fullscreen: boolean }`**
  to the action union (`enforcement.ts:116-127`) with a dedicated reducer arm:
  - sets `phase: "fs_block"` when `!fullscreen` and `phase` is `idle`/`fs_block`;
  - clears to `idle` once `fullscreen` is true;
  - **never** touches `exitCount`, `deadlineMs`, `violation`, `reportPending`.
  - **MI-2 (REDUCER invariant, not a host convention):** the arm is a **no-op when
    `config.softMode` is true** — a `soft`/pre-T0 candidate must never be forced into
    `fs_block`. Place this `softMode` short-circuit FIRST in the arm's ordered
    precedence, mirroring the `fullscreen_exit` softMode early-return at
    `enforcement.ts:208,212`. (Do not also clobber an existing `soft`/`blocking`/
    `alert_hold`/`locking` phase — `require_fullscreen` only ever transitions
    `idle↔fs_block`.)
- **`enforcementHeadline` (`enforcement.ts:313-320`) + `enforcementSubline`
  (`enforcement.ts:327-353`) get an `fs_block` arm placed ABOVE the `!fullscreen`
  check (BL-2b).** This is load-bearing: today `enforcementHeadline` returns "You
  left fullscreen" for **any** `!fullscreen` phase (`enforcement.ts:318`), which DEC-2
  forbids as accusatory for a re-entry block. The `fs_block` arm must sit **before**
  line 318 (and the `enforcementSubline` `fs_block` arm before its `!fullscreen` path
  at `enforcement.ts:342+`) so it is not shadowed. Copy: headline "Return to
  fullscreen to continue"; subline a calm "You're not in fullscreen — return to
  fullscreen to continue your exam." with **no** "exit #N", **no** "test will be
  locked".
- **`fs_block` is ephemeral / never persisted** — mirror the `soft` precedent
  (`enforcement.ts:389-410`): serialize `fs_block` AS `idle`
  (`serializeEnforcementState` ternary at `:395` extends to
  `state.phase === "soft" || state.phase === "fs_block" ? "idle" : state.phase`),
  and leave it OUT of the `PHASES` allowlist (`enforcement.ts:410`) so a reload
  re-derives it from live fullscreen truth on the next `require_fullscreen` dispatch,
  never resurrecting a stale block.

**Re-entry resets the episode (LT-3).** This already holds for the `blocking`→`idle`
path: `tryResolve` calls `released(state)` which clears `deadlineMs`/`violation`/
`ackOk` (`enforcement.ts:154-169`), so the *next* exit starts a brand-new episode
with a fresh `now + max(reentrySeconds, FLOOR)` deadline (`enforcement.ts:230-232`).
For the served-lock path, the gate-left-locked effect resets the whole state to
`initialEnforcementState` (`useEnforcement.ts:266-275`) — the strongest reset.

**Ordering note (post-unlock, T-7).** The gate-left-locked effect
(`useEnforcement.ts:266-275`) fires when gate leaves `"locked"` and resets
enforcement to `idle`. The host's `require_fullscreen` dispatch must therefore run
**after** that reset settles (next effect/tick), so it lands on a clean `idle` state
and produces `fs_block` iff `!fullscreen`. (If already in fullscreen, the dispatch is
a no-op and the candidate goes straight to `IN_EXAM`.)

**Exit-limit ladder invariant is preserved (LT-3).** `exitCount` is **session-
cumulative, never reset by an episode resolving** (`enforcement.ts:80-82, 219`).
`fs_block` deliberately does NOT increment it, and the `blocking` path's `exitCount+1`
/ `exitCount > exitLimit` hard-lock (`enforcement.ts:219-221`) is untouched. So the
escalating exit budget cannot be defeated by bouncing through `fs_block` — only a
genuine `fullscreen_exit` (T-1) ever consumes budget.

---

## 4. Invariants

1. **Render-gate (LT-1).** The workspace (problems/editor) renders **only** when
   `fullscreen && recording` hold. The W1 guard `StudentApp.tsx:2062` gains a
   `&& shell.fullscreen` term (`shell.fullscreen` is already in scope — passed to the
   overlay at `StudentApp.tsx:618`), so a candidate out of fullscreen never sees
   questions even if an overlay fails to paint, **and regardless of enforcement
   phase** (including the post-unlock `running` state). `recording` is the existing
   `status === "recording"` term.
2. **One surface-guarded acquire (LT-2 + MA-4).** Screen + camera/mic are acquired
   exactly once during `ONBOARDING` via the **monitor-surface-guarded**
   `acquireScreenShareStream` (`useProctorRecorder.ts:203-228`, surface check at
   `:219-225`), and the *same live `MediaStream`* is carried into the recorder via
   `acquired` and reused (`useProctorRecorder.ts:1094-1103`). The reuse path checks
   only `readyState === "live"` (`:1095`), so the surface guarantee MUST come from
   the acquire — never from the un-guarded `probeScreenCapture`
   (`browserPreflightProbe.ts:112`). No probe-then-stop for reused streams.
3. **No-countdown re-entry (LT-5).** A re-entry block after an exception
   (`FS_BLOCK_NO_COUNTDOWN` = phase `fs_block`) has `deadlineMs == null` and
   therefore `enforcementRemainingSeconds === null` (`enforcement.ts:294-297`) — the
   overlay countdown (`EnforcementOverlay.tsx:175`) cannot render. The countdown is
   reachable **only** from a genuine mid-exam `fullscreen_exit` (T-1).
4. **Deadline reset on fullscreen re-entry (LT-3).** Re-entering fullscreen resolves
   the episode to `idle` (`enforcement.ts:154-169`); a later exit arms a **fresh**
   deadline (`enforcement.ts:230-232`). No stale deadline survives re-entry.
5. **Record-through-lock (DEC-1/LT-4/T7).** When `LOCKED`, the recorder keeps
   running and chunk uploads keep succeeding **within a bounded window**:
   (a) the host does **not** stop the recorder and does **not** flip `status` off
   `"recording"` on lock (B5, `StudentApp.tsx:518-536`);
   (b) the recorder does **not** self-stop on a `locked` status — BOTH the
   error-mapper path (`fatalStatusFromError` `useProctorRecorder.ts:328-336`) AND the
   heartbeat-SUCCESS direct path (`useProctorRecorder.ts:1006-1008`, BL-1) treat
   `locked` as non-stopping while keeping `ended`/`pending_approval` fatal;
   (c) the backend upload-URL + heartbeat handlers accept writes while
   `status==="locked"` via a **BOUNDED** locked-tolerant bypass (B5/MA-1) — keyed on
   the existing `locked_at` timestamp + an N-minute window. **A locked session still
   cannot exec or submit (those stay 403).**
6. **Unlock panel always visible while locked; fullscreen enforced POST-unlock
   (BL-3/LT-4).** The `UnlockCodePanel` (`StudentApp.tsx:1888-1898`) renders whenever
   `enforcementLock && sessionId` — **no fullscreen pre-gate** (it would deadlock,
   §1/§2). Fullscreen is enforced only AFTER a valid unlock (gate locked→running)
   via the B2 render-gate + the `fs_block` overlay.
7. **Exit-limit ladder preserved (LT-3).** `exitCount` stays session-cumulative
   (`enforcement.ts:80-82, 219`); only T-1 consumes budget; `fs_block`,
   `require_fullscreen`, and re-entry never do; the `exitCount > exitLimit` hard-lock
   (`enforcement.ts:220-221`) is byte-identical.
8. **REC-3 recovery floor preserved.** The fresh-episode deadline stays floored at
   `MIN_RECOVERY_SECONDS = 15` (`enforcement.ts:47, 230-232`). `fs_block` has no
   deadline so the floor is irrelevant to it; the genuine-exit path keeps the floor
   exactly.
9. **ALERT-1 dispute Escape-cancel preserved (MI-4).** The dispute-note input's
   Escape handler (`EnforcementOverlay.tsx:288`) and the dispute-send / Cancel
   (`EnforcementOverlay.tsx:294-308`) are untouched. Because the `fs_block` overlay is
   a **separate early-return branch** (modelled on `soft` at `EnforcementOverlay.tsx:
   108-148`, placed ABOVE the red `:150` block) and not an edit to the shared red
   body, the dispute block (`:246-313`) stays byte-identical.
10. **FLOW-1 expected-exit preserved.** The `fullscreen_exit` reducer still honours
    `action.expected` (`enforcement.ts:208`) — an expected/teardown exit is a no-op
    and never produces a block. `fs_block` is driven only by `require_fullscreen`,
    not by an expected exit.

---

## 5. Traceability — requirement → states/transitions/invariants

| Req | Satisfied by |
|---|---|
| **T1** (one onboarding screen; checks then acquire-once via the surface-guarded acquire; carry live streams to recorder) | State `ONBOARDING`; T-a, T-b, T-c; Invariant 2; build B1. Mechanism: drop `stopStream` for reused streams (`browserPreflightProbe.ts:117-119,144-146`), single **`acquireScreenShareStream`** (`useProctorRecorder.ts:203-228`), carry via `acquired` (`useProctorRecorder.ts:1091-1147`). |
| **T7** (record + uploads alive when locked; backend accepts chunk uploads while `status=locked`; **no exam content outside fullscreen**) | State `LOCKED` (recorder alive, status stays recording); T-4 (no `active.stop()`/no `setStatus("idle")`); Invariant 1 + 5 + 6; build B2 + B5 + B6. **No-deadlock redesign (BL-3):** unlock panel always visible; fullscreen enforced POST-unlock by the B2 render-gate (workspace never renders out of fullscreen, any phase) + `fs_block`. Backend guard `sessionStore.mjs:36` reached at `sessionTelemetry.mjs:96` (upload) + `:303` (heartbeat) → add **bounded** locked-tolerant bypass. |
| **LT-1** (workspace never renders unless `fullscreen && recording`; re-entry shows no-countdown block) | Invariant 1 (W1 guard `StudentApp.tsx:2062` gains `&& shell.fullscreen`); State `FS_BLOCK_NO_COUNTDOWN`; T-d; build B2 + B3. |
| **LT-2** (screen-share + camera/mic + clipboard acquired ONCE via the surface-guarded acquire, carried into recorder) | Same as T1: State `ONBOARDING`; Invariant 2; build B1. |
| **LT-3** (re-enter fullscreen resets episode → fresh deadline next exit; exit-limit ladder not defeated) | Invariant 4 + 7; T-2; T-7 ladder reset (`useEnforcement.ts:266-275`); reducer `released`/fresh-deadline (`enforcement.ts:154-169, 230-232`); build B4. |
| **LT-4** (locked keeps recorder+uploads alive within a bound; unlock panel stays visible; fullscreen POST-unlock) | State `LOCKED`; Invariant 5 + 6; T-4, T-7; build B5 + B6. |
| **LT-5** (re-entry from exception = fullscreen block with NO countdown; countdown ONLY for a genuine mid-exam exit) | State `FS_BLOCK_NO_COUNTDOWN` vs `BLOCKING_COUNTDOWN`; phase `fs_block` (§3); Invariant 3 + 10; T-1 (countdown) vs T-6/T-7 (no-countdown); build B3. |

---

## 6. Build change-points (B1–B7) — exact files/functions/line regions

> Re-grounded in §7/§8. Line numbers are the `v1.1` snapshot; treat them as anchors —
> match on the quoted code, not the bare number, in case of drift.

### B1 — Merged onboarding (acquire-once via the surface-guarded acquire, carry streams)
- **`frontend/src/shell/browserPreflightProbe.ts`**
  - `probeScreenCapture` (lines `105-120`) and `probeCameraMic` (lines `125-147`):
    stop calling `stopStream(...)` in the `finally` (lines `117-119`, `144-146`)
    **for streams that will be reused**. Cleanest: have the active probes *return*
    the acquired `MediaStream`s so the gate can pass them straight to
    `acquiredMediaRef`. Keep `stopStream` only for the demo/short-circuit and failure
    paths.
  - **MA-4:** the screen stream handed onward MUST satisfy the monitor-surface guard.
    `probeScreenCapture` (`:112`) is **un-guarded** (`getDisplayMedia({video:true})`,
    only a `readyState !== "ended"` check). So either (i) keep `probeScreenCapture` as
    a pure capability test and perform the **real** acquire via
    `acquireScreenShareStream` (`useProctorRecorder.ts:203-228`) as the single
    surface-guarded acquire whose stream is reused, OR (ii) replace the probe's
    `getDisplayMedia` with the surface-guarded acquire. Do **not** let an un-guarded
    probe stream become the reused recording stream — the reuse path only checks
    `readyState === "live"` (`useProctorRecorder.ts:1095`).
  - `runActiveProbes` (lines `158-167`): thread the live (surface-validated) streams
    out.
- **`frontend/src/candidate/panels/BrowserPreflightGate.tsx`**
  - On pass, hand the live streams up via a new `onAcquired(streams)` prop (or fold
    the browser-check list into the onboarding screen) instead of `onPass()` alone.
- **`frontend/src/shell/PermissionsGate.tsx`** — merge its checklist UI into the one
  onboarding screen; update copy ("we'll ask once").
- **`frontend/src/candidate/StudentApp.tsx`**
  - `runPermissionsSetup` (lines `442-453`): becomes the post-checks confirm, not a
    fresh acquire, when streams are already live. The acquire it performs MUST remain
    `acquireScreenShareStream` (surface-guarded) for the screen leg.
  - Store the live streams into `acquiredMediaRef` as today.
- **`frontend/src/useProctorRecorder.ts`** — **no change needed**; the reuse path
  already exists: `acquired?.screen` live-track check + `screenStream === preScreen`
  (lines `1094-1103`), camera reuse (lines `1145-1147`). B1 just guarantees those
  streams are the surface-validated ones the candidate already approved.

### B2 — Render-gate (`fullscreen && recording`)
- **`frontend/src/candidate/StudentApp.tsx:2062`** — add `&& shell.fullscreen` to
  the W1 guard:
  `if (hasProblem && status === "recording" && gate === "running" &&
  !examGateActive && recordingState?.examViewAllowed && shell.fullscreen) {`.
  `shell.fullscreen` is already in scope (used at `:618`). When false, fall through
  to the no-countdown fullscreen block (B3) rather than rendering W1. This gate is
  phase-agnostic — it holds in the post-unlock `running` state too, so it is the
  primary guarantee that no exam content renders outside fullscreen.
- Mirror the same `&& shell.fullscreen` term on any other branch that renders the
  workspace/questions if one is added later. (Today only W1 renders the editor.)

### B3 — No-countdown re-entry block (`fs_block` / `FS_BLOCK_NO_COUNTDOWN`)
- **`frontend/src/shell/enforcement.ts`**
  - `EnforcementPhase` (line `73`): add `"fs_block"`.
  - `EnforcementAction` (lines `116-127`): add
    `{ kind: "require_fullscreen"; fullscreen: boolean }`, with a reducer arm that:
    (a) **MI-2:** is a **no-op when `config.softMode` is true** — placed FIRST in the
    arm (mirrors the `fullscreen_exit` softMode early-return at `enforcement.ts:208,
    212`); (b) sets `phase: "fs_block"` when `!fullscreen` and `phase ∈ {idle,
    fs_block}`; (c) clears to `idle` when `fullscreen`; (d) never touches
    `exitCount`/`deadlineMs`/`violation`/`reportPending`.
  - `enforcementHeadline` (lines `313-320`): add an `fs_block` arm **ABOVE** the
    `if (!fullscreen) return "You left fullscreen"` line (`:318`) — "Return to
    fullscreen to continue" (BL-2b — must precede `:318` or it is shadowed).
  - `enforcementSubline` (lines `327-353`): add an `fs_block` arm **ABOVE** the
    `!fullscreen` path (`:342+`) — calm "You're not in fullscreen — return to
    fullscreen to continue your exam.", no "exit #N", no "test will be locked".
  - Persistence: serialize `fs_block` AS `idle` (`serializeEnforcementState` ternary
    at `:395`) and keep it OUT of the `PHASES` allowlist (`:410`) — same ephemerality
    as `soft`.
  - `enforcementRemainingSeconds` (lines `294-297`): **no change** — already returns
    `null` for non-`blocking`, which is exactly the no-countdown property.
- **`frontend/src/shell/EnforcementOverlay.tsx`** — **add a dedicated `fs_block`
  EARLY-RETURN branch (BL-2a)** modelled on the calm `soft` branch (`:108-148`),
  placed **ABOVE** the red `role="alertdialog"` violation block (`:150`). It renders
  the calm (non-red) card with the `enforcementHeadline`/`enforcementSubline`
  `fs_block` copy + a single "Return to fullscreen" button (`onEnterFullscreen`) —
  **no** countdown, **no** typed-ack, **no** "test will be locked", **no** dispute
  block. The shared red body (countdown `:175`, steps `:187-239`, dispute `:246-313`)
  is left byte-identical, preserving ALERT-1 (Invariant 9).
- **`frontend/src/candidate/StudentApp.tsx`** — after `resumeRecording`/unlock,
  dispatch `require_fullscreen` (via the `enforcementTapRef`/`useEnforcement`
  surface, `StudentApp.tsx:498-542`) once the gate-left-locked reset has settled
  (§3 ordering note), so the no-countdown block shows until the candidate is back in
  fullscreen.

### B4 — Timer-reset on re-entry (episode reset)
- **`frontend/src/shell/enforcement.ts`** — already correct:
  `tryResolve`→`released` (lines `154-169`) clears the deadline on re-entry, and the
  fresh-episode deadline (lines `230-232`) re-arms on the next exit with the
  `MIN_RECOVERY_SECONDS` floor. **Verify (don't rewrite)** the existing
  `enforcement.test.ts` deadline-not-extended + fresh-episode-floored cases still
  pass; add a case asserting `fs_block` (via `require_fullscreen`) neither sets nor
  inherits a deadline. The served-lock ladder reset (`useEnforcement.ts:266-275`)
  stays.

### B5 — Record-through-lock (frontend de-fatalize + BOUNDED backend bypass)
**Frontend — host (`frontend/src/candidate/StudentApp.tsx:518-536`):** `onLocked`:
- **remove `active.stop()`** (line `525`) so the recorder keeps running;
- **do NOT `setStatus("idle")`** (line `529`) — keep `status` at `"recording"` so the
  recorder/heartbeat loop and the record-through path stay live;
- still `setLockedReason` (`:519`) + `setGate("locked")` (`:530`).
- (Audit: the locked branch render still owns the viewport because `gate==="locked"`
  short-circuits at `StudentApp.tsx:1860` BEFORE the W1 branch at `:2062`.)

**Frontend — recorder (`frontend/src/useProctorRecorder.ts`):** make `"locked"`
non-stopping while keeping `ended`/`pending_approval` fatal. **MA-3 contract:**
introduce a distinct non-fatal sentinel for the record-through-lock case so the
intent is explicit:
- **`fatalStatusFromError` (lines `328-336`):** for the lock case (`code ===
  "session_locked"` `:331`; `status === 403` `:334`) return the non-fatal sentinel
  `"locked_recording"` (add it to the `ServerSessionStatus` union in
  `frontend/src/types.ts:42`, or return a recorder-local sentinel type) instead of
  `"locked"`. Keep `session_ended`/`409`→`"ended"` (`:330,333`) and
  `waiting_for_approval`→`"pending_approval"` (`:332`) fatal.
- **`handleFatalStatus` (lines `522-527`):** treat `"locked_recording"` as a no-op
  (do NOT call `controls.stop()` `:525`, do NOT fire `onStatusChange` as a stop) — or
  equivalently have `fatalStatusFromError` return `null` for the lock case so
  `handleFatalStatus` already no-ops on `:523`. Either way, the **5 error consumers**
  of `fatalStatusFromError` all become non-fatal-on-lock together:
  1. events flush catch — `:538`;
  2. screen chunk-upload `onError` — `:618`;
  3. camera chunk-upload `onError` — `:657`;
  4. heartbeat-error catch — `:1010-1012`;
  5. drain path (`onError` `:746-750` + drain-catch `:862-865`).
- **BL-1 — the heartbeat-SUCCESS self-stop (lines `1006-1008`):** this calls
  `handleFatalStatus(response.status)` with the **literal `"locked"` string** from
  the heartbeat body — it does **NOT** go through `fatalStatusFromError`, so changing
  only the mapper leaves the recorder stopping on the first post-lock heartbeat
  (≤15s). Fix here explicitly: when `response.status === "locked"`, **do not**
  `handleFatalStatus` (treat as non-stopping, keep recording); keep `"ended"` and
  `"pending_approval"` fatal (still call `handleFatalStatus`). This and the mapper
  change together are the complete frontend de-fatalize.
- **Admin-lock AND enforcement-lock both keep recording (MA-3 consistency):** the
  recorder de-fatalize keys on the `"locked"` status / `session_locked` code, which
  both an admin lock (`adminSessions.mjs:987`) and an enforcement lock
  (`enforcement.mjs:104-109`) produce identically, so both keep recording. The
  backend bound below covers both (both set `locked_at`).

**Backend — BOUNDED locked-tolerant bypass (MA-1/MA-2).** The bypass must NOT be an
unconditional `status === "locked"`. The upload path is authed **only by the
`session_id` token** — `createUploadUrl` takes `body.session_id` and runs
`requireWritableSession` with no ownership/contest-scope check
(`sessionTelemetry.mjs:90-96`). So an unbounded locked bypass would let any
locked/abandoned/leaked session mint signed write URLs + create GCS objects
**indefinitely** (cost = object count). Therefore the token-only auth IS the threat,
and the bound IS the real protection.
- **`locked_at` EXISTS** — both lock paths set it: enforcement lock
  (`backend/src/enforcement.mjs:104-109`: `status:"locked", locked_at:now`) and admin
  lock (`backend/src/routes/adminSessions.mjs:987-988`: `status:"locked",
  locked_at:now`). No new timestamp needs adding.
- Add a bounded predicate modelled on `inAdminEndGrace`
  (`backend/src/handler.mjs:1634-1639` — status + reason allowlist + 5-min window
  from `ended_at`):
  ```js
  const LOCK_RECORD_GRACE_MS = N * 60_000; // pick N (e.g. 5)
  function recordingThroughLock(session) {
    if (session?.status !== "locked") return false;
    const lockedMs = Date.parse(session.locked_at || "");
    return Number.isFinite(lockedMs) && Date.now() - lockedMs <= LOCK_RECORD_GRACE_MS;
  }
  ```
  (Alternative/in-addition: cap total post-lock chunks per session. The time bound is
  simpler given `locked_at` already exists.)
- **`createUploadUrl` (`backend/src/routes/sessionTelemetry.mjs:96`):**
  `const session = (inAdminEndGrace(fetched) || recordingThroughLock(fetched)) ?
  fetched : requireWritableSession(fetched);`
- **`recordHeartbeat` (`backend/src/routes/sessionTelemetry.mjs:303`):** apply the
  same bounded bypass so the recorder's heartbeat keeps the upload loop alive while
  locked. Keep the response `status` honest (`sessionTelemetry.mjs:399` —
  `reconciledStatus || session.status`) so the client still *knows* it's locked.
- **Do NOT** edit the shared guard `backend/src/lib/sessionStore.mjs:36` — it is used
  by events / editor-events / review-file / heartbeat / exec / session-gates / session
  (`sessionTelemetry.mjs:96,198,245,278,303`; `exec.mjs:254,344`;
  `sessionGates.mjs:84,144`; `session.mjs:693,709`). A blanket edit would unlock
  **all** candidate writes — including exec/submit. **The locked session must still
  fail exec/submit with 403** (those handlers keep `requireWritableSession`
  unchanged). The beacon handler (`sessionTelemetry.mjs:437`) is already
  status-tolerant — precedent that selectively-tolerant handlers are the established
  pattern.

### B6 — Unlock panel always visible while locked; fullscreen enforced POST-unlock (BL-3 redesign)
- **`frontend/src/candidate/StudentApp.tsx:1888-1898`** — **keep the
  `UnlockCodePanel` render gated only on `enforcementLock && sessionId` (NO
  fullscreen pre-gate).** The earlier "hide until fullscreen" gate is DROPPED: the
  locked branch (`:1860-1901`) returns early and renders neither the enforcement
  overlay nor the fullscreen gate (both suppressed-when-locked —
  `enforcement.ts:288-290`, `examShell.ts:98`), so hiding the panel would strand an
  honest candidate with no path forward (deadlock).
- Fullscreen is enforced **after** unlock: `onUnlocked` (`:1893-1896`) clears
  `lockedReason` + `refreshStatus`; the gate flips locked→running (status stays
  `"recording"`); the host dispatches `require_fullscreen` (B3) once the
  gate-left-locked reset settles. If `!fullscreen`, the B2 render-gate keeps W1 from
  rendering and the `fs_block` overlay shows until the candidate re-enters fullscreen.
  T7's "no exam content outside fullscreen" intent is satisfied by the B2 render-gate
  (phase-agnostic), without the deadlock.

### B7 — Integration notes + post-unlock render trace (MA-5)
- **Branch ordering is load-bearing.** The render cascade short-circuits in this
  order: `ended`/`pending_approval` → `locked` (`StudentApp.tsx:1860`) →
  resuming/error → tooEarly → recordingState hold → waiting-room → W1 (`:2062`) →
  classic fallback (`:2170`). Adding `&& shell.fullscreen` to W1 (B2) makes a
  not-fullscreen recording candidate fall past W1.
- **MI-1 — explicit `FS_BLOCK_NO_COUNTDOWN` branch above W1.** Add an explicit
  early-return branch **above** the W1 guard (`< :2062`) that, when `status ===
  "recording" && gate === "running" && !shell.fullscreen` (and not soft/waiting),
  renders the `fs_block` overlay shell — the clean fix. (The classic fallback at
  `:2170` *does* already inject `enforcementOverlay` at `:2173`, so behaviourally the
  block paints even without a new branch — but the explicit branch is cleaner and
  avoids a flash of the legacy fallback surface.)
- **MA-5 — post-unlock render trace (under the new "status stays recording while
  locked" semantics):** valid unlock → gate `locked→running`, `status==="recording"`,
  gate-left-locked reset → enforcement `idle` → host dispatches `require_fullscreen`.
  If `!fullscreen`: phase → `fs_block`; the W1 guard `:2062` is **false** (because
  `!shell.fullscreen`), so W1 does **not** render — there is **no flash of the
  workspace W1**; control lands in the explicit `FS_BLOCK_NO_COUNTDOWN` branch
  (MI-1), not the classic fallback. Once the candidate re-enters fullscreen:
  `require_fullscreen`/`fullscreen_change` → phase `idle`, W1 guard true → `IN_EXAM`.
- **`EnforcementOverlay` is injected on the W1, resuming, hold, waiting-room, and
  classic branches** (`StudentApp.tsx:1827, 2016, 2038, 2108, 2173`) — the
  `fs_block` overlay rides the same injection, so it paints wherever those branches
  render.
- **Persistence sanity (B3/MI-3).** Because `fs_block` serializes as `idle` and is
  omitted from `PHASES`, a mid-block reload re-derives it from live fullscreen on the
  next `require_fullscreen` dispatch — same ephemerality contract as `soft`. No stale
  `fs_block` can be restored.
- **Server still authoritative.** The backend re-enforces the writable gate
  everywhere except the two surgical, **bounded** bypasses (upload-URL + heartbeat).
  The client gates are UX, not security. The lock remains a real server state — the
  candidate still cannot exec/submit while locked (those keep `requireWritableSession`
  → 403); only chunk-upload + heartbeat are made locked-tolerant, and only within the
  `locked_at` + N-minute bound.

### Consolidated test list

**Backend (telemetry / session tests):**
1. A `status==="locked"` session **within** `LOCK_RECORD_GRACE_MS` of `locked_at`
   gets a signed upload URL from `createUploadUrl` (`sessionTelemetry.mjs:96`).
2. A `status==="locked"` session **past** the bound is **refused 403
   `session_locked`** (post-lock upload stops after the bound).
3. The same bounded tolerance applies to `recordHeartbeat`
   (`sessionTelemetry.mjs:303`); the heartbeat response `status` stays honest
   (`:399`).
4. Bound covers **both** lock origins: an enforcement lock (`enforcement.mjs:104-109`)
   and an admin lock (`adminSessions.mjs:987`) — both set `locked_at`, both tolerate
   uploads within the window.
5. A locked session **still cannot exec or submit** — `exec.mjs:254,344` and the
   submit/session paths (`session.mjs:693,709`) keep returning 403 (the shared
   `requireWritableSession` at `sessionStore.mjs:36` is unchanged).
6. `inAdminEndGrace` behaviour is unchanged (the new predicate is OR-ed alongside it,
   not in place of it).

**Frontend:**
7. `enforcement.test.ts` — existing deadline-not-extended-on-re-exit + fresh-episode-
   floored (REC-3, `:230-232`) cases still pass.
8. `enforcement.test.ts` — `require_fullscreen` with `!fullscreen` → phase `fs_block`,
   `deadlineMs == null`, `exitCount` unchanged; with `fullscreen` → `idle`.
9. `enforcement.test.ts` — `require_fullscreen` is a **no-op when `softMode`** (MI-2):
   a `soft`/idle candidate under `softMode` is never forced into `fs_block`.
10. `enforcement.test.ts` (MI-3) — a persisted `"fs_block"` **deserializes to `idle`**
    (mirror the soft test at `enforcement.test.ts:739-768`); serializing an
    `fs_block` state round-trips to `idle`; `fs_block` is absent from the `PHASES`
    allowlist (`:410`).
11. `enforcement.test.ts` — `enforcementHeadline`/`enforcementSubline` for `fs_block`
    return the calm "return to fullscreen" copy (NOT "You left fullscreen") even
    though `fullscreen` is false (BL-2b — arm precedes `:318`/`:342`).
12. `EnforcementOverlay.test.tsx` — the `fs_block` branch renders the calm card with
    **no** countdown, **no** typed-ack, **no** dispute block; the red `blocking`
    branch + its dispute Escape-cancel (`:288`) are unchanged (MI-4).
13. Recorder test (`useProctorRecorder`) — a heartbeat-SUCCESS with
    `response.status === "locked"` does **NOT** stop the recorder (BL-1, `:1006-1008`);
    `"ended"`/`"pending_approval"` still stop it.
14. Recorder test — `fatalStatusFromError` returns the non-fatal `"locked_recording"`
    (or `null`) for `session_locked`/`403` and keeps `ended`/`pending_approval` fatal;
    a 403 on a chunk upload no longer stops the recorder, but exec/submit 403s
    (separate handlers, not routed through this mapper) still surface as before
    (MA-3).
15. `examShell.test.ts` — stage/gate derivation unaffected by the changes.

---

## 7. Self-critique — code-grounding citations (re-confirmed)

- `MIN_RECOVERY_SECONDS = 15` (`enforcement.ts:47`); fresh-deadline floor
  `Math.max(config.reentrySeconds, MIN_RECOVERY_SECONDS)` (`enforcement.ts:230-232`)
  — REC-3 floor confirmed; `enforcementRemainingSeconds` returns `null` off
  `blocking` (`enforcement.ts:294-297`) — the no-countdown encoding is sound.
- Phases `idle|blocking|locking|alert_hold|soft` (`enforcement.ts:73`);
  `soft` serialize-as-idle (`:395`) + omit-from-`PHASES` (`:410`); soft-deserialize
  test (`enforcement.test.ts:739-768`) — the `fs_block` ephemerality plan mirrors a
  real precedent.
- W1 guard verbatim (`StudentApp.tsx:2062`) — confirmed **no `fullscreen` term**;
  `shell.fullscreen` in scope (used at `:618`).
- Surface guard: `acquireScreenShareStream` rejects `displaySurface !== "monitor"`
  (`useProctorRecorder.ts:219-225`); `probeScreenCapture` has **no** such guard
  (`browserPreflightProbe.ts:112-114`); reuse path checks only `readyState === "live"`
  (`useProctorRecorder.ts:1095`) — MA-4 confirmed.
- Lock stops recorder today by TWO paths: `onLocked` `active.stop()` (`:525`) +
  `setStatus("idle")` (`:529`) (`StudentApp.tsx:518-536`); recorder self-stop via
  `fatalStatusFromError`→`handleFatalStatus`→`controls.stop()`
  (`useProctorRecorder.ts:328-336, 522-527`) AND the heartbeat-success direct call
  `handleFatalStatus(response.status)` (`:1006-1008`, BL-1) — all confirmed; B5
  addresses all three.
- The 5 `fatalStatusFromError` consumers: `:538`, `:618`, `:657`, `:1010-1012`, drain
  (`:746-750`, `:862-865`) — confirmed (MA-3).
- Backend lock rejection: `requireWritableSession` `httpError(403,"session_locked")`
  (`sessionStore.mjs:36`) reached from `createUploadUrl` (`sessionTelemetry.mjs:96`),
  `recordEvents` (`:198`), `ingestEditorEvents` (`:245`), `recordReviewFile` (`:278`),
  `recordHeartbeat` (`:303`), `exec.mjs:254,344`, `sessionGates.mjs:84,144`,
  `session.mjs:693,709`; `inAdminEndGrace` precedent (`handler.mjs:1634-1639`); beacon
  already status-tolerant (`sessionTelemetry.mjs:437`) — confirmed.
- `locked_at` exists on both lock paths: `enforcement.mjs:104-109`,
  `adminSessions.mjs:987-988` — confirmed (MA-1 bound is implementable with the
  existing field).
- Locked-screen suppression of fullscreen affordances:
  `enforcementOverlayVisible` false when `gate==="locked"` (`enforcement.ts:288-290`);
  `fullscreenGateVisible` false when `gate==="locked"` (`examShell.ts:92-98`, term at
  `:98`); locked branch early-return renders no overlay/gate
  (`StudentApp.tsx:1860-1901`) — confirmed (BL-3 deadlock is real).
- `UnlockCodePanel` render (`StudentApp.tsx:1888-1898`), no fullscreen check today —
  confirmed; B6 keeps it visible.
- ALERT-1 dispute Escape-cancel (`EnforcementOverlay.tsx:288`) + send/Cancel
  (`:294-308`) — confirmed untouched; the `fs_block` overlay is a separate
  early-return branch (modelled on `soft` `:108-148`) above the red body (`:150`).
- FLOW-1 expected-exit no-op (`enforcement.ts:208`) — confirmed preserved.

---

## 8. Critique-pass-2 resolutions

| Finding | Resolution |
|---|---|
| **BL-1** (heartbeat-success self-stop bypasses the mapper) | B5 / §3 / Invariant 5: the heartbeat-SUCCESS path (`useProctorRecorder.ts:1006-1008`) is de-fatalized **separately** — `response.status === "locked"` does NOT call `handleFatalStatus`; `"ended"`/`"pending_approval"` stay fatal. Listed as an explicit change-point + test 13. |
| **BL-2** (`fs_block` falls through to red overlay; "You left fullscreen" shadows it) | B3: (a) a **dedicated `fs_block` EARLY-RETURN branch** in `EnforcementOverlay.tsx` modelled on the calm `soft` branch (`:108`), placed ABOVE the red `:150` block; (b) `fs_block` arms in `enforcementHeadline` AND `enforcementSubline` placed **ABOVE** the `!fullscreen` check (`:318`/`:342`) so they aren't shadowed. |
| **BL-3** (hide-unlock-until-fullscreen hard-locks an honest candidate) | **Redesign:** drop the pre-unlock fullscreen gate. Unlock panel stays ALWAYS visible while locked (B6); fullscreen enforced POST-unlock via the B2 render-gate + `fs_block` (T-7). Confirmed against the locked-screen suppression of all fullscreen affordances (`enforcement.ts:288-290`, `examShell.ts:98`, `StudentApp.tsx:1860-1901`). T7 intent preserved (B2 render-gate is phase-agnostic — no exam content outside fullscreen) without the deadlock. |
| **MA-1 / MA-2** (unbounded locked bypass = unbounded object minting on a token-only path) | B5 backend: **BOUNDED** bypass keyed on the existing `locked_at` (`enforcement.mjs:104-109`, `adminSessions.mjs:987`) + an N-minute window (`recordingThroughLock`, modelled on `inAdminEndGrace`). `locked_at` EXISTS — no new field needed. Path is token-only (`sessionTelemetry.mjs:90-96`), so the bound is the real protection. Tests 1–2 (within/past bound), test 5 (exec/submit still 403). |
| **MA-3** (`fatalStatusFromError` feeds 5 consumers; need an explicit contract) | B5: explicit `"locked_recording"` non-fatal sentinel; the 5 consumers (`:538,:618,:657,:1010,drain :746/:862`) enumerated; exec/submit 403s confirmed to NOT flow through this mapper (separate handlers). Admin-lock + enforcement-lock both keep recording; the backend bound covers both. Test 14. |
| **MA-4** (single acquire must be surface-guarded, not the un-guarded probe) | §0 / B1 / Invariant 2: the one acquire is `acquireScreenShareStream` (monitor-surface guard `useProctorRecorder.ts:219-225`), never `probeScreenCapture` (`:112`, no guard); reuse path checks only `readyState` (`:1095`). |
| **MA-5** (post-unlock render trace under "status stays recording") | B7: explicit trace — gate `locked→running`, `status==="recording"`, reset→`idle`→`require_fullscreen`; if `!fullscreen`, W1 guard false (no W1 flash), lands in the explicit `FS_BLOCK_NO_COUNTDOWN` branch (MI-1), not the classic fallback. |
| **MI-1** (explicit `FS_BLOCK_NO_COUNTDOWN` branch above W1) | B7: explicit early-return branch above the W1 guard (`< :2062`); note the classic fallback (`:2170`) already injects the overlay (`:2173`) but the explicit branch is cleaner / avoids a legacy-surface flash. |
| **MI-2** (`require_fullscreen` no-op under `softMode` as a REDUCER invariant) | B3 / §3 / Invariant 10: the `softMode` no-op is FIRST in the `require_fullscreen` reducer arm's ordered precedence (mirrors `fullscreen_exit` softMode at `:208,212`) — not a host convention. Test 9. |
| **MI-3** (`fs_block` deserialize-to-`idle` test) | B3 / test 10: serialize `fs_block` AS `idle` (`:395`), omit from `PHASES` (`:410`); add a deserialize-`"fs_block"`→`idle` test mirroring the soft test (`enforcement.test.ts:739-768`). |
| **MI-4** (preserved invariants: REC-3 floor, ALERT-1 Escape-cancel, FLOW-1 expected-exit) | Invariants 8/9/10: REC-3 floor `max(reentrySeconds,15)` (`:47,230-232`) untouched; ALERT-1 dispute Escape-cancel (`EnforcementOverlay.tsx:288`) byte-identical because `fs_block` is a SEPARATE early-return branch (not an edit to the shared red body); FLOW-1 expected-exit no-op (`enforcement.ts:208`) preserved. |

**Verdict: GO.** Every blocker, major, and minor from critique pass 2 is folded with
corrected, code-grounded change-points. The design is build-ready.
