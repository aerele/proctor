# S1 — Exam shell: fullscreen-first onboarding + unique top bar + 1–5 stage indicator — design

**Status:** READY for tonight's build (STRETCH item 1 of the 2026-06-09 night run). SPEC ONLY — the implementation plan is written separately, after verifying integration points against landed Slice 1 code.
**Author:** architect subagent. **Date:** 2026-06-09.
**Parent design:** `docs/superpowers/specs/2026-06-09-own-editor-design.md` (§6 fullscreen-first anti-proxy, §8 unique top bar + onboarding progress).
**Guardrails:** `night-run/MORNING-NOTES.md` — scope LOCKED to: fullscreen-first onboarding, unique top bar that disappears on any anomaly, 1–5 color-coded onboarding progress readable at a distance. The fullscreen-exit "type-the-sentence" challenge / blocking escalation, OMR markers, and signed-QR are DEFERRED — not designed here.

---

## 1. Vision

An invigilator standing at the back of a lab must read every candidate's status **without walking over**: a distinctive dark top bar on every screen, a big color-coded stage number (1–5) showing exactly where each candidate is in onboarding (and that they are mid-exam / done), the candidate's name + roll + room for spot ID checks, and a ticking clock proving the screen is live (a screenshot or printout cannot tick).

The bar's **absence is the alarm**: any anomaly — fullscreen exit, focus loss, tab hidden, screen share stopped, recording error — makes the bar vanish instantly and stay vanished until the candidate visibly fixes the condition and acknowledges. A screen without the bar = walk over. After restoration the bar carries a permanent red flag-count chip, so a later glance still shows history.

The whole candidate flow becomes **fullscreen-first**: the very first screen is a blank gate with a single "Enter fullscreen" button. Details entry, waiting screens, the coding workspace, and the end screen all live inside fullscreen. Leaving fullscreen mid-exam is an anomaly.

This is the candidate **exam shell**. It composes with (does not modify the internals of) the Slice 1 coding workspace, the S2 roster login, and the S3 room-gate waiting room.

---

## 2. What exists at HEAD (code findings that drive this design)

Verified in the working tree (Slice 1 has landed; still **verify each anchor against landed code when planning** — parallel slices are also editing `App.tsx`):

- **No fullscreen handling exists anywhere** in `frontend/src` (grep clean). This item introduces it.
- `frontend/src/App.tsx` `StudentApp`:
  - Gate states: `gate: "form" | "pending_approval" | "locked" | "ended" | "running"` + recorder `status: SessionStatus` (`idle|starting|recording|ending|ended|error`).
  - `StudentStepBanner` — an existing **3-step** banner (Enter details / Record + take test / End test) with hint text. Superseded by this design (see §7.4).
  - `TimerBar` — sticky bar shown only while `recording|ending`, with elapsed time + start/current IP; turns red on `ipChanged`. Superseded by this design (see §7.4).
  - `IdentityCard` — shows name/username/room; stays (close-up identity confirmation).
  - The Slice 1 workspace renders at `SLICE1_PROBLEM && sessionId && status === "recording"` (App.tsx ~line 942).
  - `identity` state `{name, username, room}` is set by `applyServerStatus`; `recordingStartedAt`/`elapsedSeconds` already tick once a second while recording.
  - `createUiEvent(type, detail)` + `addEvent` + `sendEvents(sessionId, [event])` is the established pattern for UI-originated proctor events (used by reload-block, checkpoints, PiP).
- `frontend/src/useProctorRecorder.ts` already emits, via `onEvent` → `addEvent`, the events: `visibility_change` (`{state}`), `window_blur`, `window_focus`, `page_hide`, `before_unload`, `clipboard_activity`, `screen_share_stopped`, `recording_error`, `ip_address_changed`, `heartbeat_error`, `chunk_uploaded`, `upload_error`, plus camera/mic events. **These are the anomaly inputs — reused, not duplicated.**
- `backend/src/handler.mjs` `recordEvents` (~line 508) accepts **arbitrary** event `type` strings (`String(item.type || "unknown")`), stores them as JSONL under the session prefix, and raises alerts only for the `SURE_SHOT_EVENT_TYPES` map (`recording_stopped`, `screen_share_stopped`, `recording_error`). → **New client event types need ZERO backend change.** (Adding `fullscreen_exit` to the sure-shot alert map is a deliberate non-goal tonight; see §10.)
- `frontend/src/studentCopy.ts` — candidate copy switching pattern (`ownEditor` flag); new candidate-facing strings introduced here follow the same file/pattern only if they differ per surface (they don't — the shell is surface-independent, so its copy can live with its components).
- Demo mode: `frontend/src/api.ts` `demoMode = import.meta.env.VITE_DEMO_MODE === "true"`; every API function has a demo branch. The shell is pure client logic — it works in demo mode with no new branches except where it calls `sendEvents` (which already no-ops in demo).
- Sibling night-run specs (coordinate, don't collide):
  - **S2** (`2026-06-09-s2-roster-login-design.md`) replaces the form contents (unique-ID-confirm login + room dropdown). Its §"merge order" note already says S2's `StudentApp` form edits execute **after** S1 lands. The shell treats the form as a black box inside stage 2.
  - **S3** (`2026-06-09-s3-invigilator-portal-design.md`) adds a "Waiting for your room code" screen AFTER recording starts and BEFORE the workspace, gated by `room_gate_enabled` + per-session `exam_started_at`. That waiting room maps to stage 3 (see §4) — by design, the invigilator releases the room code when every screen shows a sky-blue **3**.
  - **S5** (dynamic time) will later swap the bar's elapsed timer for remaining time; the bar exposes one time slot for it (see §7.2).

---

## 3. Locked decisions

1. **Fullscreen = element fullscreen** via `document.documentElement.requestFullscreen()` on a user click, tracked with `document.fullscreenElement` + the `fullscreenchange` event. (F11 browser-fullscreen does not satisfy the gate — it is invisible to the page; the gate button is the only path.) Fullscreening `documentElement` keeps the top bar and all app UI inside fullscreen.
2. **Fullscreen gate is the FIRST screen** — before the details form, exactly per parent §6 ("blank screen, Go fullscreen now", before entering name). Rules + form render only after fullscreen is entered.
3. **Recording-before-identity is NOT built tonight.** Parent §6's literal "start proctoring/recording first, then proceed" requires sessions that exist before identity is known (anonymous/provisional sessions — a backend session-model change colliding with S2's login rework). Tonight: fullscreen first → details inside fullscreen → recording starts immediately after registration (the existing order). The anti-proxy property substantially holds — nothing happens outside fullscreen, and a fullscreen exit during details entry throws the candidate back to the gate. **Flagged for morning review.**
4. **Anomalies vanish the bar only while `status === "recording"`** (which includes the S3 waiting room — recording runs there). Before recording, a fullscreen exit simply returns the candidate to the gate overlay (logged when a session exists, but no bar-vanish flag) — this also makes the share-picker moment (status `"starting"`) safe if a platform drops fullscreen around the picker.
5. **The anomaly set reuses existing event types** (§6). One NEW pair of client event types is introduced for the capability that does not exist yet: `fullscreen_enter` / `fullscreen_exit`. Shell state transitions additionally emit `onboarding_stage`, `topbar_hidden`, `topbar_restored`. All ride the existing `/api/events` pipeline unchanged.
6. **Bar restoration is candidate-self-serve with preconditions + a permanent flag chip**: the bar stays hidden until (a) fullscreen is re-entered AND the tab is visible AND recording is running, and (b) the candidate clicks an explicit acknowledge button on the red anomaly panel. Every hide episode permanently increments a red "⚑ n" chip on the restored bar. No invigilator/admin action is needed to restore (escalation/blocking is deferred per guardrails).
7. **The new `ExamTopBar` replaces both `TimerBar` and `StudentStepBanner`** in `StudentApp` (two competing step/status bars would defeat at-a-distance reading). The IP start/current diagnostics that lived on `TimerBar` move into the existing sidebar `HealthPanel`; the ip-changed condition becomes an anomaly (§6). The per-stage hint text the old banner provided survives as one short line directly under the bar (close-up guidance, not at-a-distance content).
8. **Frontend-only item.** No new backend routes, no new collections, no session-doc fields. Stage is NOT stamped on the session doc tonight (S3's room stats derive their own states); if the admin later wants stage-at-a-glance, that is a follow-up.
9. **File layout** mirrors the `coding/` convention — pure logic split from components, vitest beside the logic:
   - `frontend/src/shell/examShell.ts` — pure: stage derivation, anomaly classification, top-bar state reducer. No React.
   - `frontend/src/shell/examShell.test.ts` — vitest.
   - `frontend/src/shell/FullscreenGate.tsx`, `frontend/src/shell/ExamTopBar.tsx`, `frontend/src/shell/AnomalyPanel.tsx` — components.
   - `frontend/src/App.tsx` — `StudentApp` wiring only.
   - `frontend/src/types.ts` — add the new event-type strings to the documented unions/comments if present.
10. **Unsupported browsers** (no `requestFullscreen`, e.g. iPhone Safari): a dead-end screen mirroring the recorder's existing "open this page in the latest Chrome or Edge on a laptop" copy. The recorder already imposes the same floor (getDisplayMedia), so this excludes nobody new.

---

## 4. The five onboarding stages

Stage is a **pure function** of state StudentApp already holds (plus fullscreen + the S3 release flag). It names the step the candidate is **currently on**:

| # | Label (on the bar) | Color (Tailwind) | Active when |
|---|--------------------|------------------|-------------|
| 1 | `FULLSCREEN` | red-600 | Not in fullscreen (gate showing), in any pre-end state |
| 2 | `DETAILS` | amber-500 | Fullscreen OK, no session yet (`gate === "form"`, filling/confirming identity) |
| 3 | `GET READY` | sky-500 | Session exists but the exam surface is not live: starting/resuming screen share, `pending_approval`, or (S3) recording + waiting for the room code |
| 4 | `IN EXAM` | emerald-600 | `status === "recording"` + workspace visible (room gate passed or not enabled) |
| 5 | `DONE` | indigo-600 | `gate === "ended"` / `status === "ended"` |

Reading the room: **red/amber = not started, sky = setting up / waiting for release, green = on track, indigo = finished.** The S3 flow falls out naturally: the invigilator releases the room code when every screen shows a sky **3**; the room flips green together.

Derivation contract (pure, vitest-tested):

```
deriveStage({ fullscreen, gate, status, examReleased }) -> 1|2|3|4|5
```

- `examReleased` is `true` when the S3 room gate is not enabled or not yet built, and comes from S3's release state when it lands — **verify against landed S3 code when planning** (S3 §"Release is per-session": `exam_started_at` stamped, client learns via its waiting-room poll).
- `ended` wins over everything; `locked` keeps the last pre-lock stage but the bar is hidden anyway (§6 — a locked screen shows no bar, which IS the invigilator signal).
- Stage transitions emit an `onboarding_stage` event (`detail: { from, to, label }`) through the existing `sendEvents` once a `sessionId` exists, so the screen recording and the event log can be correlated (parent §8: "usable during the test too (and by the recording)").

---

## 5. Fullscreen gating — behavior

### 5.1 The gate screen (stage 1)

- Near-blank, dark, centered: the Aerele logo, one heading ("This is a proctored exam"), one line ("The exam runs in fullscreen from start to finish. Enter fullscreen to begin."), and a single large button **"Enter fullscreen to begin"**.
- The ExamTopBar renders above it showing stage **1 FULLSCREEN** in red (so a not-started screen is readable from the back of the room).
- Button click → `document.documentElement.requestFullscreen()`. On resolve: gate clears, the normal flow (rules + form at HEAD; S2 login once landed) renders, stage becomes 2. Emits `fullscreen_enter` (buffered until a session exists; see §8 error handling for the no-session case).
- On reject (browser policy/permission): inline error on the gate ("Your browser blocked fullscreen. Click the button again…") + the same button retries. Never auto-loops.
- No `requestFullscreen` API at all → unsupported-browser dead-end (decision 10).

### 5.2 Staying fullscreen

- A single `fullscreenchange` listener owns truth. `document.fullscreenElement == null` means OUT.
- **Before recording** (stages 1–3 pre-share, incl. `pending_approval`): leaving fullscreen re-shows the gate as a full-screen overlay on top of whatever screen was active (form state preserved — nothing is unmounted). Stage indicator returns to 1. Logged as `fullscreen_exit` when a session exists; **no anomaly flag**.
- **While recording** (stage 3-waiting, 4): leaving fullscreen is an **anomaly** (§6): bar vanishes, red AnomalyPanel demands re-entry, `fullscreen_exit` is sent. Re-entry button on the panel calls `requestFullscreen()` again (click = fresh user gesture, always valid).
- **Reload/resume:** a reload drops fullscreen by nature. The restored-session screen ("Resume recording") sits behind the same gate overlay — the candidate re-enters fullscreen first, then resumes the share. No anomaly flag for the reload-exit itself (the reload is already separately logged/blocked by the existing handlers).
- **Test end (stage 5):** on `ended`, the app calls `document.exitFullscreen()` (logged as `fullscreen_exit` with `detail: { expected: true }`). The DONE bar remains visible in the normal window.
- ESC is the browser's native exit path — it cannot be intercepted; it simply lands in the rules above. The existing reload-shortcut blocker is untouched.

---

## 6. What counts as an anomaly (the bar-vanish set)

All inputs are events ALREADY flowing through `StudentApp`'s single `addEvent` funnel (recorder `onEvent` + UI events), plus the shell's own fullscreen listener. Classification is a pure function:

```
anomalyFromEvent(type, detail) -> { anomaly: true, reason } | { anomaly: false }
```

**Anomalies (vanish the bar; only evaluated while `status === "recording"`):**

| Event type (existing unless marked) | Reason shown on the panel |
|---|---|
| `fullscreen_exit` **(NEW, shell-emitted)** | "You left fullscreen." |
| `window_blur` | "You switched to another window or application." |
| `visibility_change` with `detail.state === "hidden"` | "This exam tab was hidden." |
| `page_hide` | "This exam tab was hidden or closed." |
| `screen_share_stopped` | "Screen sharing stopped." (fix path = existing ScreenShareErrorPanel, §7.3) |
| `recording_error` | "Screen recording hit an error." |
| `ip_address_changed` | "Your network connection changed." |
| `integrity_checkpoint_missed` | "You missed an attendance check." |

Additionally, the server flipping the session to **`locked`** hides the bar (the locked gate screen renders without it — absence = walk over). `pending_approval` does NOT (benign, pre-exam).

**Explicit NON-anomalies** (logged/handled as today, never vanish the bar): `editor_blur`/`editor_focus` (clicking the problem statement is normal), all editor keystroke/cursor/paste events (paste forensics is Slice 1/4 review material, not an invigilator walk-over), `clipboard_activity` (in-editor copy/paste of one's own code is legitimate), `window_focus` / `visibility_change: visible` (recoveries), `reload_shortcut_blocked` (already blocked + warned), `before_unload`, `upload_error`/`heartbeat_error`/`small_video_chunk_detected` (infra, not candidate behavior), camera/mic optional-capture failures, `integrity_checkpoint_shown/confirmed`, `chunk_uploaded`.

**Episode semantics:** transitions are what count. `visible → hidden` emits ONE `topbar_hidden` event (`detail: { reason, trigger_type }`) and increments the flag count by one; further anomaly events while already hidden only append their reason to the panel (deduped by type) — no double-counting a single excursion that fires blur+hidden+fullscreen_exit together. Restore emits `topbar_restored` (`detail: { hidden_ms, reasons }`).

---

## 7. The unique top bar (`ExamTopBar`)

### 7.1 Look (the "unique" signature)

A fixed, full-width, **dark (bg-ink) bar ~64px tall** at the very top — the only dark chrome in the otherwise light app, instantly recognizable across a room:

- **Left — stage block:** a solid colored block (the §4 stage color) the full bar height, containing the stage numeral at ≥28px bold + the uppercase label ("3 GET READY"). The color block is the at-a-distance element.
- **Center — identity:** candidate name (large semibold white), roll number (mono, dimmed), "Room {room}". Before registration: "Not signed in" placeholder. (Name + roll on the bar enables the parent-§8 random ID-card checks.)
- **Right — liveness:** a ticking clock. Always the local wall time `HH:MM:SS` (every stage gets a ticking element — a static screenshot/printout fails); while recording, the elapsed exam timer `H:MM:SS` is the big element with the wall clock small beside it. A pulsing red ● REC dot while recording. The red **⚑ n** flag chip when `n > 0`. *(S5 integration slot: the elapsed timer's position later shows remaining time — single component seam, verify when S5 lands.)*

The bar renders on **every** `StudentApp` branch (gate screens included) except when hidden by an anomaly. `AdminApp` is untouched. The bar is part of the shared screen, so the recording captures stage transitions visually as well.

Content below gets top padding so the fixed bar never overlaps the workspace/Monaco.

### 7.2 Vanish behavior

On the first anomaly of an episode: the bar unmounts **completely** — no red bar, no placeholder; the page top is plain background (per Karthi's locked intent: bar presence = all good, absence = anomaly; an imitation overlay can fake a red strip more easily than it can fake an absence the invigilator was told to look for). Simultaneously a full-width red **AnomalyPanel** appears at the top of the content flow.

### 7.3 The AnomalyPanel + restore

- Red, prominent, listing the friendly reason(s) (§6 table) with timestamps, and exactly one primary action: **"I have fixed this — restore my status bar"**.
- The button is **disabled until preconditions clear**: `document.fullscreenElement` set, `document.visibilityState === "visible"`, `status === "recording"`. While unmet, the panel shows what is still wrong, with a "Re-enter fullscreen" button when that is the missing piece (fresh click = valid gesture).
- `screen_share_stopped` / `recording_error` route through the EXISTING ScreenShareErrorPanel "Try again" flow to restart the share; the AnomalyPanel sits alongside it and its restore button stays disabled until recording is actually running again. No duplicate retry CTA: the AnomalyPanel never offers its own share-restart.
- `ip_address_changed` / `integrity_checkpoint_missed` don't break the preconditions, so for them restore = acknowledge (one click) — but the flag chip still increments and the events are already alerted/logged server-side.
- Restore: bar remounts with the incremented ⚑ chip; `topbar_restored` sent.

### 7.4 What it replaces

- `TimerBar` — deleted from the running branch (elapsed timer + recording status move onto the bar; start/current IP move into `HealthPanel` as two small mono rows; the ip-changed red treatment is superseded by the anomaly flow).
- `StudentStepBanner` — deleted from all branches (3-step model superseded by the 5-stage bar). Its per-state hint sentence survives as a single muted line rendered directly under the bar (`stageHint(stage, gate, status)` in `examShell.ts`), preserving the self-service guidance ("Press Resume recording…", "Waiting for a proctor…").
- `IdentityCard`, `PreStartRules`, `RulesPanel`, `HealthPanel`, the form, the end-test flow: unchanged.

---

## 8. Data model & API surface

**None new.** Zero backend changes.

- New client-emitted event types over the existing `POST /api/events` (which stores arbitrary types — verified §2): `fullscreen_enter`, `fullscreen_exit`, `onboarding_stage`, `topbar_hidden`, `topbar_restored`. They appear in the existing events JSONL under the session prefix and in the session's `event_count`.
- Events emitted before a session exists (gate interactions on the very first screen) are **buffered in memory** by the shell and flushed with the first post-registration batch — `sendEvents` requires a `session_id`. Buffer cap 50, oldest dropped; this is best-effort audit, not evidence of record.
- Demo mode: no new API branches needed (`sendEvents` already no-ops; the shell is pure client).

---

## 9. UI behavior — state machine summary

Shell state lives in one `useExamShell()` hook inside `StudentApp` (composition over new context providers — StudentApp already owns `gate`/`status`/`identity`/`elapsedSeconds`):

```
useExamShell({ gate, status, sessionId, identity, elapsedSeconds, examReleased }) -> {
  fullscreen: boolean,            // live, from fullscreenchange
  stage: 1|2|3|4|5,               // deriveStage(...)
  barHidden: boolean,
  flagCount: number,              // hide episodes this session
  activeReasons: AnomalyReason[], // for the panel
  enterFullscreen(): Promise,     // gate + panel button
  restoreBar(): void,             // panel acknowledge (precondition-checked)
  onShellEvent(e: ProctorEvent),  // tap point: StudentApp's addEvent funnel calls this
}
```

- `onShellEvent` is called from the existing `addEvent` (one-line tap), running `anomalyFromEvent` on every event — the recorder events are reused, not re-listened.
- The hook owns the only `fullscreenchange` listener and emits `fullscreen_enter`/`fullscreen_exit` itself.
- The reducer behind `barHidden`/`flagCount`/`activeReasons` is the pure `topBarReducer(state, action)` in `examShell.ts` — fully vitest-tested (episode dedupe, precondition gating, flag counting, stage-change events).
- Render structure of `StudentApp` becomes: `<Shell>` → `<ExamTopBar … />` or `<AnomalyPanel … />` → stage hint line → `<FullscreenGate>` overlay when `!fullscreen && stage < 5` → existing branch content. The CodingWorkspace render condition (`SLICE1_PROBLEM && sessionId && status === "recording"`) is **unchanged** — **verify the exact landed condition + variable names in App.tsx when planning** (parallel slices are editing the same region; re-anchor by landmark, not line number).

---

## 10. Error handling

- `requestFullscreen()` rejection → inline retry on the gate/panel; never an auto-retry loop; never blocks the candidate from reading instructions.
- Missing Fullscreen API → unsupported-browser dead-end (same copy family as the recorder's `unsupported` path).
- Fullscreen flapping (rapid exit/enter): episode semantics (§6) — one flag per excursion; the reducer ignores `fullscreen_enter` as an anomaly-clearer only (it never auto-restores the bar; the candidate must acknowledge).
- Event-send failures: `sendEvents` is already fire-and-forget (`void`); shell events follow the same pattern — UI state never waits on the network.
- `exitFullscreen()` at test end may reject (already exited) — swallow.
- Clock skew: the wall clock is purely client-local display; no server dependency.
- The pre-session event buffer (§8) is dropped silently if the candidate never registers (no session to attach it to).

## 11. Testing

- **vitest** (pure logic, `frontend/src/shell/examShell.test.ts`): `deriveStage` across the full `{fullscreen, gate, status, examReleased}` matrix incl. S3-waiting → 3 and ended → 5; `anomalyFromEvent` for every §6 row + every listed non-anomaly; `topBarReducer` episode dedupe, flag counting, restore preconditions, `onboarding_stage` transition emission.
- **tsc + build** clean, as Slice 1 established.
- **Browser integration on :9222 (demo mode):** drive the full flow — gate screen shows stage 1 red bar; CDP click on "Enter fullscreen" (CDP input events are trusted gestures, so `requestFullscreen` resolves; if the harness cannot hold fullscreen, stub `document.documentElement.requestFullscreen`/`fullscreenElement` via a CDP initScript — same demo-only technique as Slice 1's getDisplayMedia stub, no product change); form → stage 2 amber; start (stubbed share) → 3 → 4 green with name/roll/room + ticking clocks; simulate blur (`window.dispatchEvent(new Event('blur'))` or page-switch) → bar gone + red panel; restore → bar back with ⚑ 1; end test → indigo 5. Screenshot evidence per MORNING-NOTES done-bar.

## 12. OUT of scope (tonight)

- Recording before identity / anonymous sessions (decision 3 — morning question).
- Blocking/pausing escalation, the "type the sentence" fullscreen-exit challenge, warning-vs-block configurability (parent §8 — all DEFER per guardrails).
- Adding `fullscreen_exit` (or `topbar_hidden`) to backend `SURE_SHOT_EVENT_TYPES` so admins get alerts — a deliberate ~5-line follow-up once Karthi confirms desired severity/noise; tonight the events are stored but raise no alerts.
- Stamping the current stage on the session doc / admin or invigilator stage-at-a-glance dashboards (S3 derives its own room stats).
- Per-session unique bar hue / cryptographic bar liveness (OMR-marker territory — deferred design night).
- OS-level multi-monitor enforcement (existing limitation; blur events still fire and are anomalies).
- Any change to the Slice 1 workspace internals, the S2 form internals, or the S3 waiting-room internals — the shell only wraps them.

## 13. Open questions for morning review

1. **Recording-before-identity deferred** (decision 3) — accept details-inside-fullscreen as the anti-proxy compromise, or schedule anonymous sessions?
2. **Self-serve bar restore** (acknowledge + preconditions + permanent ⚑ chip) vs requiring an invigilator/admin action to restore — chose self-serve to avoid blocking flows tonight.
3. **`ip_address_changed` and `integrity_checkpoint_missed` included** in the vanish set — too aggressive? (Both are one-click restores.)
4. **`clipboard_activity` excluded** from the vanish set (in-editor copy/paste of own code is legitimate; it stays logged) — confirm.
5. Replacing `StudentStepBanner` (3-step) and `TimerBar` with the single 5-stage bar — confirm the consolidation.
6. Should `fullscreen_exit` become a sure-shot admin alert type now (small backend follow-up) or wait for the deferred escalation design?
