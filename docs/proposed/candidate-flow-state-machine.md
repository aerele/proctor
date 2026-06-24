# Candidate-flow state machine — v1.1 lock / fullscreen / recording + onboarding redesign

Status: **proposed (design spec only — no code changed by this doc).**
Scope: the candidate runtime in `frontend/src/candidate/StudentApp.tsx`, its
shell (`frontend/src/shell/*`), the recorder (`frontend/src/useProctorRecorder.ts`),
and one backend upload-auth guard. It drives the build steps **B1–B7** (§6).

Every "current behaviour" claim below cites a real `file:line` against the `v1.1`
branch. Re-verified in the self-critique pass (§7).

---

## 0. Why this spec exists — the two structural gaps today

1. **The workspace is not gated on `fullscreen && recording`.** The exam UI (W1)
   renders when `hasProblem && status === "recording" && gate === "running" &&
   !examGateActive && recordingState?.examViewAllowed`
   (`StudentApp.tsx:2062`). There is **no `shell.fullscreen` term** in that guard.
   Fullscreen is enforced *only* by overlay components painted on top
   (`FullscreenGate` at stage 2, `EnforcementOverlay` on exit) while the workspace
   stays mounted underneath (W1 keeps every capture/preview host mounted —
   `StudentApp.tsx:2139-2148`). A gap in overlay coverage = a candidate seeing
   questions out of fullscreen. **LT-1 closes this by making the render itself
   require `fullscreen && recording`.**

2. **Onboarding double-prompts for the screen + camera.** The browser-check stage
   acquires a screen stream and **immediately stops it** — `probeScreenCapture`
   acquires then `stopStream(stream)` in its `finally`
   (`browserPreflightProbe.ts:110-119`); `probeCameraMic` does the same
   (`browserPreflightProbe.ts:130-146`). Then a **separate** stage,
   `PermissionsGate`, re-acquires screen + camera/mic + clipboard via
   `runPermissionsSetup` (`StudentApp.tsx:442-453`) before the live streams are
   finally handed to the recorder as `acquired` (`StudentApp.tsx:1136-1160`,
   consumed at `useProctorRecorder.ts:1091-1113`). So the candidate picks "Entire
   Screen" at least twice. **DEC-2/T1/LT-2/LT-5 collapse this to one acquire.**

Two additional locked decisions:

3. **Re-entry from an exception must NOT show a countdown** (DEC-2/LT-1/LT-5). The
   countdown is a recovery affordance for a *genuine mid-exam exit*; a re-entry
   after a forced re-share or after a server lock must be a plain "return to
   fullscreen" block. Today the only non-idle fullscreen states are
   `blocking` (which *always* shows a countdown — `EnforcementOverlay.tsx:175-180`,
   `enforcementRemainingSeconds` `enforcement.ts:294-297`), `locking`,
   `alert_hold`, and the take-home `soft` nudge (`enforcement.ts:73`). There is no
   "blocked, no countdown, not a violation" state. **LT-5 introduces one.**

4. **Recording + uploads must survive a lock** (DEC-1/LT-4/T7). Today a lock
   *stops* the recorder: the enforcement `onLocked` callback calls `active.stop()`
   (`StudentApp.tsx:518-536`, stop at the `recorderRef` it captured) and the
   recorder also self-stops when a heartbeat/upload returns the server lock
   (`useProctorRecorder.ts:522-527` `handleFatalStatus` → `controls.stop()`, fed by
   `fatalStatusFromError` mapping `403`/`session_locked`→`"locked"`
   `useProctorRecorder.ts:328-336`). And even if it kept running, the backend
   **rejects chunk uploads while locked**: `requireWritableSession` throws
   `httpError(403, "session_locked")` at `backend/src/lib/sessionStore.mjs:36`,
   reached from the upload-URL handler `createUploadUrl` at
   `backend/src/routes/sessionTelemetry.mjs:96`. **LT-4 keeps the recorder alive
   and adds a locked-tolerant upload path.**

---

## 1. States

The candidate screen today is selected by an ordered cascade of early-`return`
branches at the end of `StudentApp` (`StudentApp.tsx:1823-2462`), keyed on two
orthogonal atoms — `gate: StudentGate` (`"form" | "pending_approval" | "locked" |
"ended" | "running"`, `StudentApp.tsx:79`) and `status: SessionStatus`
(`StudentApp.tsx:92`) — plus a derived numbered `stage` 1–5
(`examShell.ts deriveStage:51-60`) that picks the onboarding overlay. This spec
keeps that two-axis model and adds the explicit named screen-states below. "New?"
marks a state this redesign introduces.

| State | New? | One-line definition |
|---|---|---|
| `ENTRY_FORM` | — | Pre-session form stage: identity + consent. `gate==="form"`, `status` not recording. Today this is also where preflight/permissions/fullscreen overlays stack. |
| `ONBOARDING` | reshaped | **The single onboarding screen (LT-2).** Browser checks 1–4 run, then screen-share + camera/mic + clipboard are acquired **once**; those live streams are carried into the recorder. Replaces the BrowserPreflightGate→PermissionsGate double-acquire. |
| `IN_EXAM` | — | The workspace/questions are rendered. **Guarded by `fullscreen && recording` (LT-1).** Maps to the W1 branch `StudentApp.tsx:2062` plus the new fullscreen term. |
| `FS_BLOCK_NO_COUNTDOWN` | **yes** | A fullscreen block with a "Return to fullscreen" button and **no countdown** (LT-5). Shown on *re-entry after an exception* — post forced re-share, or after a lock is served while the candidate is out of fullscreen. Not a violation; consumes no exit budget; sets no deadline. |
| `BLOCKING_COUNTDOWN` | — | The genuine mid-exam fullscreen-exit recovery: red takeover with the ticking deadline + typed-ack (or simplified re-enter). `enforcement.phase==="blocking"`, `EnforcementOverlay.tsx:175-180`. **Reached ONLY from a mid-exam exit while recording** (LT-5 keeps the countdown scoped to this path). |
| `ALERT_HOLD` | — | `alert_first` mode hold after a violation: proctor alerted, overlay holds, no lock. `enforcement.phase==="alert_hold"`, `enforcement.ts:142`. |
| `LOCKING` | — | Transient: a violation fired in `block` mode; the report POST is in flight and will lock server-side. `enforcement.phase==="locking"`, `enforcement.ts:142`. |
| `LOCKED` | reshaped | `gate==="locked"` (`StudentApp.tsx:1860`). The locked screen owns the viewport. **DEC-1: the recorder + uploads stay ALIVE here.** `UnlockCodePanel` renders for an enforcement lock — **now gated behind being in fullscreen (LT-4)**. |
| `RECOVERY` | — | The anomaly-episode re-entry surface (`AnomalyPanel`) used by share-drop / blur episodes; restore requires `fullscreen && visible && recording` (`AnomalyPanel.tsx:35`). Distinct from the enforcement overlay. REC-3 floor lives here-adjacent. |
| `SOFT_NUDGE` | — | Take-home pre-T0 nudge: calm "back to fullscreen", no countdown, nothing counted. `enforcement.phase==="soft"` (`enforcement.ts:73`, overlay `EnforcementOverlay.tsx:108-148`). Unchanged. |
| `WAITING_ROOM` / `COME_BACK_LATER` | — | Take-home pre-T0 holds while recording (`StudentApp.tsx:2034`, `2011`). Unchanged. |
| `PENDING_APPROVAL` / `ENDED` / `ERROR` | — | Lifecycle terminals. Unchanged. |

**Key relationship:** `FS_BLOCK_NO_COUNTDOWN` and `BLOCKING_COUNTDOWN` are *both*
"you are not in fullscreen, recording is live, fix it" — they differ only in
**whether a deadline is armed**. The redesign encodes that difference as a new
enforcement phase (§3) rather than a UI flag, so the no-countdown property is a
state invariant the reducer enforces, not a render-time branch that can drift.

---

## 2. Transitions

`(from-state, event, guard, to-state, side-effects)`. Events are the existing
`EnforcementAction`s (`enforcement.ts:116-127`) plus shell/lifecycle events, with
the new actions/phase this redesign adds. Side-effects name the concrete call.

| # | From | Event | Guard | To | Side-effects |
|---|---|---|---|---|---|
| T-a | `ENTRY_FORM` | "Check & set up" gesture | browser checks 1–4 pass | `ONBOARDING` (acquiring) | run passive+active checks, then **acquire once**: `acquireScreenShareStream` + `acquireCameraMicrophone` + clipboard primer (the `runPermissionsSetup` body `StudentApp.tsx:442-453`), store into `acquiredMediaRef` (`StudentApp.tsx:281,379,405-406`). **No `stopStream`.** |
| T-b | `ONBOARDING` | screen+confirm done | `permissionsReady` true (`StudentApp.tsx:482-483`) AND consent complete | `ENTRY_FORM`→enter-fullscreen | `confirmPermissions()` (`StudentApp.tsx:468-472`); stage advances 1→2 (`deriveStage:53→54`). |
| T-c | enter-fullscreen | "Enter fullscreen" gesture | `requestFullscreen` resolves (`useExamShell.ts:241`) | start recording | `beginRecording(session)` → `createProctorRecorder({...acquired})` `.start()` (`StudentApp.tsx:1139-1266`); streams reused, **no second prompt** (`useProctorRecorder.ts:1095-1103`). `setStatus("recording")` (`StudentApp.tsx:1284`). |
| T-d | start recording | recorder started, exam released | `hasProblem && status==="recording" && gate==="running" && !examGateActive && recordingState?.examViewAllowed && fullscreen` (**LT-1: `&& fullscreen` is the new term**) | `IN_EXAM` | render W1 workspace (`StudentApp.tsx:2152-2157`). |
| T-1 | `IN_EXAM` | `fullscreen_exit` | `recording && !expected && !exemptFullscreen && !softMode` AND `exitCount+1 <= exitLimit` AND **a genuine mid-exam exit** | `BLOCKING_COUNTDOWN` | `enforcementReducer` fullscreen_exit branch (`enforcement.ts:207-240`): `exitCount+1`, **fresh** `deadlineMs = now + max(reentrySeconds, MIN_RECOVERY_SECONDS)*1000` (`enforcement.ts:47,230-232`). Overlay shows countdown (`EnforcementOverlay.tsx:175-180`). |
| T-2 | `BLOCKING_COUNTDOWN` | `fullscreen_change{fullscreen:true}` + ack matched (or simplified) | `tryResolve` ack && fullscreen (`enforcement.ts:162-170`) | `IN_EXAM` | `released(state)` → phase `idle` (`enforcement.ts:154-156`); **LT-3: episode reset** (deadline cleared); emit `fullscreen_enforcement_ack`; `onResolved()` → `shell.restoreBar()` (`StudentApp.tsx:540`, `useEnforcement.ts:147-149`). |
| T-3 | `BLOCKING_COUNTDOWN` | `tick` past deadline OR `exitCount > exitLimit` | block mode | `LOCKING` | `violate(...)` (`enforcement.ts:138-150`) → POST `report_violation` (`useEnforcement.ts:161-164`). |
| T-3' | `BLOCKING_COUNTDOWN` | same | `alert_first` mode | `ALERT_HOLD` | `violate(...)` sets phase `alert_hold` (`enforcement.ts:142`). |
| T-4 | `LOCKING` | `violation_result{locked:true}` OR heartbeat `status==="locked"` | server locked | `LOCKED` | `onLocked` (`StudentApp.tsx:518-536`): `setLockedReason`, `setStatus("idle")`, `setGate("locked")`. **LT-4: do NOT call `active.stop()` — keep recording (see §3/B5).** |
| T-5 | `IN_EXAM` | screen-share `track ended` (candidate stops share) | not `stopping` | `RECOVERY` (anomaly) | recorder `onFatalError` (`useProctorRecorder.ts:1120-1142`); `AnomalyPanel` screen-share branch. |
| T-6 | `RECOVERY` | "Try again — share entire screen" | new share acquired, surface = monitor | re-enter → **`FS_BLOCK_NO_COUNTDOWN`** then `IN_EXAM` | `retryScreenShare` → `resumeRecording()`/`beginRecording` (`StudentApp.tsx:1496,1505-1509`). **LT-5: the post-re-share fullscreen prompt is the NO-countdown block, not a countdown.** |
| T-7 | `LOCKED` | `UnlockCodePanel` submit OK (in fullscreen) | enforcement lock + valid unlock code + **`fullscreen` true (LT-4 gate)** | `FS_BLOCK_NO_COUNTDOWN`→`IN_EXAM` | `unlockEnforcementGate` (`UnlockCodePanel.tsx:25`); `onUnlocked` clears `lockedReason`, `refreshStatus` (`StudentApp.tsx:1888-1898`); `useEnforcement` gate-left-locked effect resets the ladder to a fresh episode (`useEnforcement.ts:266-275`). |
| T-7' | `LOCKED` | candidate NOT in fullscreen | — | `LOCKED` + `FS_BLOCK_NO_COUNTDOWN` shown first | **LT-4: `UnlockCodePanel` is hidden until the candidate is in fullscreen.** Show the no-countdown "return to fullscreen" block; reveal the unlock panel once `fullscreen` true. |
| T-8 | any active enforcement phase | `config_change` exemptFullscreen | `exemptFullscreen` set live (`enforcement.ts:182-184`) | `IN_EXAM` | `released(state)`. Unchanged. |
| T-9 | `SOFT_NUDGE` | `config_change` softMode→false (T0) | `!softMode && phase==="soft"` (`enforcement.ts:201-203`) | `IN_EXAM`/`WAITING_ROOM`→`IN_EXAM` | phase→`idle`, ladder starts clean at `exitCount=0`. Unchanged. |

**The genuine-vs-return distinction (T-1 vs T-6/T-7).** Today every exit while
recording goes through the one `fullscreen_exit`→`blocking` path
(`enforcement.ts:207-240`), which always sets a deadline. This spec splits the
re-entry trigger: a *fullscreen exit during the exam* (T-1) arms the countdown; a
*re-entry demanded by an exception we already handled* — post-re-share (T-6) and
post-unlock (T-7) — must NOT arm a countdown (LT-5). See §3 for the encoding.

---

## 3. The enforcement-phase change for the no-countdown re-entry (LT-5 + LT-3)

The cleanest encoding that keeps the no-countdown property a *reducer invariant*
(not a fragile render flag) is a new non-deadline phase:

- **Add phase `"fs_block"`** to `EnforcementPhase` (`enforcement.ts:73`): "must be
  in fullscreen to proceed, but this is NOT a violation episode — no deadline, no
  exit-count increment, no report."
- **`enforcementRemainingSeconds`** (`enforcement.ts:294-297`) already returns
  `null` for any phase other than `"blocking"`, so `fs_block` renders **no
  countdown** with zero overlay changes — the `phase === "blocking" &&
  remainingSeconds !== null` guard (`EnforcementOverlay.tsx:175`) is already false
  for it. The overlay shows the "Return to fullscreen" button block
  (`EnforcementOverlay.tsx:218-239`) and headline (`enforcementHeadline`
  `enforcement.ts:313-320` gains an `fs_block` arm: "Return to fullscreen to
  continue", no "exit #N" / no "test will be locked").
- **Entry into `fs_block`** is driven by the host, not by a `fullscreen_exit`:
  after `resumeRecording`/unlock the host dispatches a new action
  `{ kind: "require_fullscreen" }` (or reuses `config_change` carrying current
  fullscreen truth) that sets `phase: "fs_block"` **iff** `!fullscreen`, and
  clears to `idle` once back in fullscreen. It never touches `exitCount`,
  `deadlineMs`, or `violation`.
- **`fs_block` is ephemeral / never persisted** — mirror the `soft` precedent
  (`enforcement.ts:394-395, 409-410`): serialize `fs_block` AS `idle`, and leave
  it out of the `PHASES` allowlist (`enforcement.ts:410`) so a reload re-derives it
  from live fullscreen truth, never resurrecting a stale block.

**LT-3 — re-entry resets the episode.** This already holds for the
`blocking`→`idle` path: `tryResolve` calls `released(state)` which clears
`deadlineMs`/`violation`/`ackOk` (`enforcement.ts:154-170`), so the *next* exit
starts a brand-new episode with a fresh `now + max(reentrySeconds, FLOOR)` deadline
(`enforcement.ts:230-232`). The redesign preserves this. For the served-lock path,
the gate-left-locked effect resets the whole state to `initialEnforcementState`
(`useEnforcement.ts:266-275`), which is the strongest form of episode reset.

**Exit-limit ladder invariant is preserved (LT-3).** `exitCount` is **session-
cumulative, never reset by an episode resolving** (`enforcement.ts:80-82, 219`).
`fs_block` deliberately does NOT increment it (it is not a violation), and the
`blocking` path's `exitCount+1` / `exitCount > exitLimit` hard-lock
(`enforcement.ts:219-221`) is untouched. So the escalating exit budget cannot be
defeated by repeatedly bouncing through `fs_block` — only a genuine
`fullscreen_exit` (T-1) ever consumes budget.

---

## 4. Invariants

1. **Render-gate (LT-1).** The workspace (problems/editor) renders **only** when
   `fullscreen && recording` hold. Concretely the W1 guard `StudentApp.tsx:2062`
   gains a `&& shell.fullscreen` term (`shell.fullscreen` is already in scope —
   used at `StudentApp.tsx:618`), so a candidate out of fullscreen never sees
   questions even if an overlay fails to paint. `recording` is the existing
   `status === "recording"` term.
2. **One acquire (LT-2).** Screen + camera/mic are acquired exactly once during
   `ONBOARDING` and the *same live `MediaStream`* is carried into the recorder via
   `acquired` (`useProctorRecorder.ts:1095-1103, 1145-1147`). No probe-then-stop
   (`browserPreflightProbe.ts:117-119, 144-146` no longer stop a stream that will
   be reused). The recorder's existing reuse path (`screenStream === preScreen`,
   `useProctorRecorder.ts:1099`) is the mechanism.
3. **No-countdown re-entry (LT-5).** A re-entry block after an exception
   (`FS_BLOCK_NO_COUNTDOWN`) has `deadlineMs == null` and therefore
   `enforcementRemainingSeconds === null` (`enforcement.ts:294-297`) — the overlay
   countdown (`EnforcementOverlay.tsx:175-180`) cannot render. The countdown is
   reachable **only** from a genuine mid-exam `fullscreen_exit` (T-1).
4. **Deadline reset on fullscreen re-entry (LT-3).** Re-entering fullscreen
   resolves the episode to `idle` (`enforcement.ts:154-170`); a later exit arms a
   **fresh** deadline (`enforcement.ts:230-232`). No stale deadline survives
   re-entry.
5. **Record-through-lock (DEC-1/LT-4/T7).** When `LOCKED`, the recorder keeps
   running and chunk uploads keep succeeding: (a) the host does **not** stop the
   recorder on lock; (b) the recorder does **not** self-stop on a `locked` status
   (`fatalStatusFromError` must stop treating `locked` as a stop trigger for the
   recording path — §6/B5); (c) the backend upload-URL handler accepts uploads
   while `status==="locked"` via a locked-tolerant bypass (§6/B5,
   `sessionTelemetry.mjs:96`).
6. **Unlock gate behind fullscreen (LT-4).** `UnlockCodePanel`
   (`StudentApp.tsx:1888-1898`) renders **only** when `fullscreen` is true; out of
   fullscreen the candidate sees `FS_BLOCK_NO_COUNTDOWN` first.
7. **Exit-limit ladder preserved (LT-3).** `exitCount` stays session-cumulative
   (`enforcement.ts:80-82, 219`); only T-1 consumes budget; `fs_block` and re-entry
   never do; the `exitCount > exitLimit` hard-lock (`enforcement.ts:220-221`) is
   byte-identical.
8. **REC-3 recovery floor preserved.** The fresh-episode deadline stays floored at
   `MIN_RECOVERY_SECONDS = 15` (`enforcement.ts:47, 230-232`). `fs_block` has no
   deadline so the floor is irrelevant to it; the genuine-exit path keeps the floor
   exactly.
9. **ALERT-1 dispute Escape-cancel preserved.** The dispute-note input's Escape
   handler (`EnforcementOverlay.tsx:288`) and the dispute-send
   (`EnforcementOverlay.tsx:294-298`) are untouched; the dispute never clears the
   block or bypasses recovery. (Note: the `ConsentDocModal` also has its own Escape
   close — `ConsentGate.tsx:46-48` — independent and untouched.)

---

## 5. Traceability — requirement → states/transitions/invariants

| Req | Satisfied by |
|---|---|
| **T1** (one onboarding screen; checks then acquire-once; carry live streams to recorder) | State `ONBOARDING`; T-a, T-b, T-c; Invariant 2; build B1. Mechanism: drop `stopStream` for reused streams (`browserPreflightProbe.ts:117-119,144-146`), single `runPermissionsSetup` (`StudentApp.tsx:442-453`), carry via `acquired` (`useProctorRecorder.ts:1091-1147`). |
| **T7** (record + uploads alive when locked; backend accepts chunk uploads while `status=locked`) | State `LOCKED` (recorder alive); T-4 (no `active.stop()`); Invariant 5; build B5. Backend guard `sessionStore.mjs:36` reached at `sessionTelemetry.mjs:96` → add locked-tolerant bypass. |
| **LT-1** (workspace never renders unless `fullscreen && recording`; re-entry shows no-countdown block) | Invariant 1 (+ W1 guard `StudentApp.tsx:2062` gains `&& shell.fullscreen`); State `FS_BLOCK_NO_COUNTDOWN`; T-d; build B2 + B3. |
| **LT-2** (screen-share + camera/mic + clipboard acquired ONCE, carried into recorder) | Same as T1: State `ONBOARDING`; Invariant 2; build B1. |
| **LT-3** (re-enter fullscreen resets episode → fresh deadline next exit; exit-limit ladder not defeated) | Invariant 4 + 7; T-2; T-7 ladder reset (`useEnforcement.ts:266-275`); reducer `released`/fresh-deadline (`enforcement.ts:154-170, 230-232`); build B4. |
| **LT-4** (locked keeps recorder+uploads alive; `UnlockCodePanel` gated behind fullscreen) | State `LOCKED`; Invariant 5 + 6; T-4, T-7, T-7'; build B5 + B6. |
| **LT-5** (re-entry from exception = fullscreen block with NO countdown; countdown ONLY for a genuine mid-exam exit) | State `FS_BLOCK_NO_COUNTDOWN` vs `BLOCKING_COUNTDOWN`; phase `fs_block` (§3); Invariant 3; T-1 (countdown) vs T-6/T-7 (no-countdown); build B3. |

---

## 6. Build change-points (B1–B7) — exact files/functions/line regions

> Re-grounded in §7. Line numbers are the `v1.1` snapshot; treat them as anchors —
> match on the quoted code, not the bare number, in case of drift.

### B1 — Merged onboarding (acquire-once, carry streams)
- **`frontend/src/shell/browserPreflightProbe.ts`**
  - `probeScreenCapture` (lines `105-120`) and `probeCameraMic` (lines `125-147`):
    stop calling `stopStream(...)` in the `finally` (lines `117-119`, `144-146`)
    **for streams that will be reused**. Cleanest: have the active probes *return*
    the acquired `MediaStream`s (a new shape `{ result, stream }`) so the gate can
    pass them straight to `acquiredMediaRef` instead of re-acquiring. Keep
    `stopStream` only for the demo/short-circuit and failure paths.
  - `runActiveProbes` (lines `158-167`): thread the live streams out.
- **`frontend/src/candidate/panels/BrowserPreflightGate.tsx`**
  - `runCheck` (lines `46-61`): on pass, hand the live streams up via a new
    `onAcquired(streams)` prop (or fold the browser-check list into the onboarding
    screen) instead of `onPass()` alone. The component becomes the *checks* portion
    of the single onboarding screen rather than a separate gate.
- **`frontend/src/shell/PermissionsGate.tsx`** — merge its checklist UI into the
  one onboarding screen; it stops being a stage-2-preceding standalone overlay. Its
  copy ("Your browser will ask a few times" `PermissionsGate.tsx:94-98`) updates to
  "we'll ask once".
- **`frontend/src/candidate/StudentApp.tsx`**
  - `acquireScreenPermission` / `acquireCameraMicPermission`
    (lines `373-408`): accept already-acquired streams from the merged checks
    instead of re-acquiring (`acquireScreenShareStream` `StudentApp.tsx:377`,
    `acquireCameraMicrophone` `:403`). Store into `acquiredMediaRef`
    (lines `281, 379, 405-406`) as today.
  - `runPermissionsSetup` (lines `442-453`): becomes the post-checks confirm, not a
    fresh acquire, when streams are already live.
  - The BrowserPreflightGate render branch (`StudentApp.tsx:1969-1973`) and the
    PermissionsGate/FullscreenGate render in `ExamShellChrome.tsx:89-90` reorganise
    into the one onboarding screen.
- **`frontend/src/useProctorRecorder.ts`** — **no change needed**; the reuse path
  already exists: `acquired?.screen` live-track check + `screenStream === preScreen`
  (lines `1094-1103`), camera reuse (lines `1145-1147`). B1 just guarantees those
  streams are the ones the candidate already approved.

### B2 — Render-gate (`fullscreen && recording`)
- **`frontend/src/candidate/StudentApp.tsx:2062`** — add `&& shell.fullscreen` to
  the W1 guard:
  `if (hasProblem && status === "recording" && gate === "running" &&
  !examGateActive && recordingState?.examViewAllowed && shell.fullscreen) {`.
  `shell.fullscreen` is already in scope (used at `:618`). When false, fall through
  to the no-countdown fullscreen block (B3) rather than rendering W1.
- Mirror the same `&& shell.fullscreen` term on any other branch that renders the
  workspace/questions if one is added later. (Today only W1 renders the editor;
  the classic branch's workspace was removed — comment `StudentApp.tsx:2454-2456`.)

### B3 — No-countdown re-entry block (`FS_BLOCK_NO_COUNTDOWN`)
- **`frontend/src/shell/enforcement.ts`**
  - `EnforcementPhase` (line `73`): add `"fs_block"`.
  - Add an `EnforcementAction` `{ kind: "require_fullscreen"; fullscreen: boolean }`
    (or extend the `config_change` arm `enforcement.ts:181-205`) that sets
    `phase: "fs_block"` when `!fullscreen`, clears to `idle` when `fullscreen`,
    and **never** touches `exitCount`/`deadlineMs`/`violation`.
  - `enforcementHeadline` (lines `313-320`) + `enforcementSubline` (lines
    `327-353`): add an `fs_block` arm — "Return to fullscreen to continue", no
    "exit #N", no "test will be locked".
  - Persistence: serialize `fs_block` AS `idle` (line `395`) and keep it OUT of the
    `PHASES` allowlist (line `410`) — same ephemerality as `soft`.
  - `enforcementRemainingSeconds` (lines `294-297`): **no change** — already returns
    `null` for non-`blocking`, which is exactly the no-countdown property.
- **`frontend/src/shell/EnforcementOverlay.tsx`** — the existing render already
  handles a non-`blocking`/non-`locking` phase (countdown guard at `:175`, the
  re-enter button block at `:218-239`). Add an `fs_block` copy path so the headline
  reads as a calm re-entry block (no Step-1 typed-ack — render the simplified
  "Return to fullscreen" block, `:218-239`).
- **`frontend/src/candidate/StudentApp.tsx`** — after `resumeRecording`/unlock,
  dispatch `require_fullscreen` (via the `enforcementTapRef`/`useEnforcement`
  surface, `StudentApp.tsx:498-542`) so the no-countdown block shows until the
  candidate is back in fullscreen.

### B4 — Timer-reset on re-entry (episode reset)
- **`frontend/src/shell/enforcement.ts`** — already correct:
  `tryResolve`→`released` (lines `154-170`) clears the deadline on re-entry, and the
  fresh-episode deadline (lines `230-232`) re-arms on the next exit with the
  `MIN_RECOVERY_SECONDS` floor. **Verify (don't rewrite)** the existing
  `enforcement.test.ts` "deadline not extended on re-exit" + "fresh episode floored"
  cases still pass; add a case asserting `fs_block` neither sets nor inherits a
  deadline. The served-lock ladder reset (`useEnforcement.ts:266-275`) is the
  strongest reset and stays.

### B5 — Record-through-lock
- **`frontend/src/candidate/StudentApp.tsx:518-536`** — `onLocked`: **remove the
  `active.stop()`** (line `525`) so the recorder keeps running; still
  `setLockedReason` + `setGate("locked")`, but keep `status` at `"recording"` (do
  NOT `setStatus("idle")` at `:529`) so the recorder/heartbeat loop and the
  record-through path stay live. (Audit: the W1 render must still fall through to
  `LOCKED` because `gate==="locked"` short-circuits at `:1860` before the W1 branch
  at `:2062`.)
- **`frontend/src/useProctorRecorder.ts`**
  - `fatalStatusFromError` (lines `328-336`): stop mapping `locked`/`403` to a
    *stop* trigger for the recording path — return `null` (or a new non-fatal
    `"locked_recording"`) so `handleFatalStatus` (lines `522-527`) does **not**
    call `controls.stop()` on a lock. Keep `ended`/`409` and `pending_approval`
    fatal.
  - The heartbeat self-stop (lines `1006-1008`) and upload-error self-stop
    (`enqueueUpload onError` `:615-619`, camera `:655-658`, drain `:861-867`) follow
    from `fatalStatusFromError`, so the single change above covers them. Confirm the
    heartbeat keeps POSTing while locked (it will 403 today — see backend change).
- **Backend — `backend/src/routes/sessionTelemetry.mjs:96`** (`createUploadUrl`):
  add a **locked-tolerant bypass** modelled on the existing `inAdminEndGrace`
  pattern (`backend/src/handler.mjs:1630-1635`):
  `const session = (inAdminEndGrace(fetched) || recordingThroughLock(fetched)) ?
  fetched : requireWritableSession(fetched);`
  where `recordingThroughLock` returns true for `status === "locked"`. **Do NOT**
  edit the shared guard `backend/src/lib/sessionStore.mjs:36` — that gate is used by
  events / editor-events / review-file / heartbeat / exec
  (`sessionTelemetry.mjs:96,198,245,278,303`, `exec.mjs:254,344`,
  `sessionGates.mjs:80,140`, `session.mjs:693,709`); a blanket edit would unlock all
  candidate writes, not just chunk uploads. Apply the same bypass at the **heartbeat
  handler** (`sessionTelemetry.mjs:303`) so the recorder's heartbeat keeps the
  upload loop alive while locked (the beacon handler `sessionTelemetry.mjs:437` is
  already status-tolerant — precedent). Keep the response `status` honest so the
  client still *knows* it's locked (`sessionTelemetry.mjs:399`).

### B6 — Unlock-gate behind fullscreen
- **`frontend/src/candidate/StudentApp.tsx:1888-1898`** — gate the
  `UnlockCodePanel` render on `fullscreen`:
  `{enforcementLock && sessionId && shell.fullscreen ? (<UnlockCodePanel .../>) :
  null}`. When out of fullscreen, render the `FS_BLOCK_NO_COUNTDOWN` overlay
  (B3) inside the locked branch so the candidate must re-enter fullscreen *before*
  the code panel appears. `shell.fullscreen` is in scope at the component top
  (`:618`).

### B7 — Integration notes
- **Branch ordering is load-bearing.** The render cascade short-circuits in this
  order: `ended`/`pending_approval` → `locked` (`:1860`) → resuming/error → tooEarly
  (`:1945`) → recordingState hold (`:2011`) → waiting-room (`:2034`) → W1 (`:2062`)
  → classic fallback (`:2170`). Adding `&& shell.fullscreen` to W1 (B2) makes a
  not-fullscreen recording candidate fall to the **classic fallback** branch —
  ensure that branch (or a new `FS_BLOCK_NO_COUNTDOWN` branch placed *above* W1)
  renders the no-countdown block, not a half-built workspace.
- **`EnforcementOverlay` is injected into W1, resuming, hold, waiting-room, and
  classic branches** (`:1827, 2016, 2038, 2108, 2173`) — `fs_block` rides the same
  injection, so it paints in `LOCKED`/fallback too once added to those branches.
- **Persistence sanity (B3).** Because `fs_block` serializes as `idle`, a mid-block
  reload re-derives it from live fullscreen on the next `require_fullscreen`
  dispatch — same ephemerality contract as `soft` (`enforcement.ts:394-395`). No
  stale `fs_block` can be restored.
- **Server still authoritative.** The backend re-enforces consent (`ConsentGate`
  header note) and the writable gate everywhere except the two surgical bypasses;
  the client gates are UX, not security. The lock remains a real server state — the
  candidate still cannot *submit* or *end* differently; only chunk-upload +
  heartbeat are made locked-tolerant.
- **Tests to update:** `enforcement.test.ts` (new `fs_block` cases + existing
  deadline/floor cases unchanged), `EnforcementOverlay.test.tsx` (no-countdown
  render), `examShell.test.ts` (stage/gate unaffected), backend telemetry tests for
  the locked-tolerant upload/heartbeat bypass.

---

## 7. Self-critique — code-grounding pass + risk flags

**Citations re-opened and confirmed accurate:**
- `MIN_RECOVERY_SECONDS = 15` (`enforcement.ts:47`); fresh-deadline floor
  `Math.max(config.reentrySeconds, MIN_RECOVERY_SECONDS)` (`enforcement.ts:230-232`)
  — REC-3 floor confirmed; `enforcementRemainingSeconds` returns `null` off
  `blocking` (`enforcement.ts:294-297`) — the no-countdown encoding is sound.
- Phases `idle|blocking|locking|alert_hold|soft` (`enforcement.ts:73`);
  `soft` serialize-as-idle + omit-from-allowlist (`enforcement.ts:394-395, 409-410`)
  — the `fs_block` ephemerality plan mirrors a real precedent.
- W1 guard verbatim (`StudentApp.tsx:2062`) — confirmed **no `fullscreen` term**;
  `shell.fullscreen` available (`:618`).
- Onboarding double-acquire: probe stop in `finally` (`browserPreflightProbe.ts:
  117-119, 144-146`) then `runPermissionsSetup` re-acquire (`StudentApp.tsx:442-453`,
  `:377, :403`) then recorder `acquired` reuse (`useProctorRecorder.ts:1091-1147`)
  — confirmed.
- Lock stops recorder today: `onLocked` `active.stop()` + `setStatus("idle")`
  (`StudentApp.tsx:518-536`); recorder self-stop `handleFatalStatus`→`controls.stop()`
  (`useProctorRecorder.ts:522-527`) keyed on `fatalStatusFromError` `locked`/`403`
  (`:328-336`) — confirmed; B5 removes both.
- Backend lock rejection: `requireWritableSession` `httpError(403,"session_locked")`
  (`sessionStore.mjs:36`) reached from `createUploadUrl` (`sessionTelemetry.mjs:96`)
  + heartbeat (`:303`); `inAdminEndGrace` precedent (`handler.mjs:1630-1635`);
  beacon already status-tolerant (`sessionTelemetry.mjs:437`) — confirmed.
- `UnlockCodePanel` render (`StudentApp.tsx:1888-1898`), no fullscreen check today —
  confirmed; B6 adds the gate.
- ALERT-1 dispute Escape-cancel (`EnforcementOverlay.tsx:288`) + send
  (`:294-298`) — confirmed untouched.

**Risk flags (places the redesign could break an existing invariant):**

1. **Record-through-lock vs the exit-limit hard-lock.** Today a block-mode lock is
   terminal for the session's *recording* (the recorder stops). Keeping recording
   alive (B5) means a candidate can sit on the `LOCKED` screen still being recorded
   — desirable (evidence continuity) but it changes the chunk-count / cost profile
   of a locked session. **Mitigation:** unchanged exit-limit ladder
   (`enforcement.ts:220-221`) — a re-lock still requires going back through the
   gate; the locked-tolerant backend bypass is upload-URL + heartbeat **only**, so
   the candidate still can't submit/exec while locked.

2. **`fatalStatusFromError` is also the events/submit fatal predicate.** If B5
   makes `locked`/`403` non-fatal globally, an *admin* lock or a *submit* 403 might
   stop self-stopping where it should. **Mitigation:** scope the change to the
   *recording/upload* path — return a distinct non-fatal `"locked_recording"` for
   the upload/heartbeat chains only, and keep `403` fatal for non-recording writes
   (or keep the recorder running but let exec/submit 403 surface as before). Treat
   this as the single highest-risk edit; cover it with a test that a locked session
   keeps uploading chunks but still blocks exec/submit.

3. **Render-gate fall-through (B2).** Adding `&& shell.fullscreen` to W1 makes a
   not-fullscreen recording candidate fall to the classic-fallback branch
   (`StudentApp.tsx:2170`), which historically rendered proctoring-first surfaces.
   **Mitigation:** add an explicit `FS_BLOCK_NO_COUNTDOWN` branch *above* W1
   (`< :2062`) so the no-countdown block, not the fallback, owns the
   recording-but-not-fullscreen case. (The `EnforcementOverlay` already paints over
   the fallback at `:2173`, so behaviourally the block shows even without a new
   branch — but an explicit branch is clearer and avoids the legacy surface
   flashing.)

4. **`soft`/take-home vs `fs_block`.** Both are no-deadline, no-count phases. Ensure
   the host dispatches `require_fullscreen` only in non-take-home / post-T0 contexts
   so it never clobbers the `soft` nudge (`enforcement.ts:201-203, 248-251`). The
   reducer should treat a `require_fullscreen` while `softMode` as a no-op (defer to
   `soft`).

5. **REC-3 floor + LT-3 interaction.** `fs_block` having no deadline is correct, but
   the *next genuine exit* after an unlock must still floor at 15 s. The ladder reset
   (`useEnforcement.ts:266-275`) returns `initialEnforcementState`, so the next
   `fullscreen_exit` re-derives a floored fresh deadline (`enforcement.ts:230-232`)
   — confirmed safe.

6. **ALERT-1 Escape-cancel.** Untouched by all of B1–B7 — but B3's overlay copy
   edits sit in the same component (`EnforcementOverlay.tsx`); keep the dispute
   block (`:246-313`) and its Escape handler (`:288`) byte-identical when adding the
   `fs_block` copy arm.
