# S1 — Candidate Exam Shell Implementation Plan (fullscreen-first + unique top bar + 1–5 stage indicator)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** READY (stretch item S1 of the 2026-06-09 night run). Paired spec: `docs/superpowers/specs/2026-06-09-s1-exam-shell-design.md`.

**Goal:** The candidate flow becomes fullscreen-first (a blank dark gate with one "Enter fullscreen" button is the FIRST screen); every `StudentApp` branch carries a unique fixed dark top bar (stage block 1–5 color-coded + name/roll/room + ticking wall clock + elapsed exam timer + pulsing REC dot); ANY anomaly while recording vanishes the bar instantly and shows a red panel; restore is candidate-self-serve (preconditions + explicit acknowledge) and permanently increments a red ⚑ flag chip. An invigilator at the back of the room reads everything without walking over — and a missing bar IS the walk-over signal.

**Architecture:** Frontend-only. Pure logic (`deriveStage`, `anomalyFromEvent`, `topBarReducer`, `stageHint`, formatters) in `frontend/src/shell/examShell.ts`, vitest-tested. One thin React hook `useExamShell` owns the single `fullscreenchange` listener and taps StudentApp's existing `addEvent` funnel. Three thin components (`ExamTopBar`, `FullscreenGate`, `AnomalyPanel`) plus a `ExamShellChrome` composition component so `App.tsx` gets wiring only. **Zero backend changes** — new event types (`fullscreen_enter`, `fullscreen_exit`, `onboarding_stage`, `topbar_hidden`, `topbar_restored`) ride the existing `POST /api/events` (backend stores arbitrary type strings; verified in `backend/src/handler.mjs` `recordEvents`).

**Tech stack:** React 18 / Vite / TS / Tailwind (theme `extend` — default `red-600`/`amber-500`/`sky-500`/`emerald-600`/`indigo-600` available alongside the custom `ink`/`paper`/`panel`/... palette); vitest 4 for pure logic (convention per `frontend/src/coding/` — NO jsdom/component tests, components stay thin).

---

## Verified integration points at HEAD (re-checked against landed Slice 1 code, 2026-06-10)

The spec was written before Slice 1 landed and ordered a re-verification. Done; anchors below are quoted from the working tree at `352e094`:

- `StudentApp` (`frontend/src/App.tsx`) has **five return branches**, each wrapped in `<Shell>`: `resuming` spinner, `gate === "pending_approval"`, `gate === "locked"`, `gate === "ended" || status === "ended"`, and the main form/running return. All five get the shell chrome.
- The Slice 1 workspace render condition is exactly: `{SLICE1_PROBLEM && sessionId && status === "recording" && (` — **unchanged by this plan** (the shell wraps, never touches, workspace internals).
- The single event funnel is `const addEvent = (event: ProctorEvent) => { setEvents((current) => [event, ...current].slice(0, 16)); };` — recorder `onEvent: addEvent` plus every `createUiEvent(...)` call site goes through it. The shell taps here.
- Candidate copy gating: `const OWN_EDITOR = SLICE1_PROBLEM !== null;` + `frontend/src/studentCopy.ts`. The shell's only surface-dependent string (the stage-4 hint) takes an `ownEditor` boolean, fed from `OWN_EDITOR`. No string may direct the candidate to HackerRank when `ownEditor` is true (tested).
- `React.StrictMode` is ON (`frontend/src/main.tsx`) — the hook must not put side effects inside setState updaters (effects run from an explicit dispatch function over a ref).
- `frontend/tsconfig.json` has `"noEmit": true`, no project references → `npx tsc --noEmit` is the typecheck command (equivalent to `npm run lint`).
- Demo mode: `sendEvents` in `frontend/src/api.ts` already no-ops under `VITE_DEMO_MODE=true`. The shell needs no new demo branches.

**The anomaly set (exact existing event-type strings, re-verified):**

| Event type | Emitted by (verified) | Anomaly? |
|---|---|---|
| `fullscreen_exit` | NEW — shell hook (this plan) | YES, unless `detail.expected === true` (end-of-test exit) |
| `window_blur` | `useProctorRecorder.ts` `emit("window_blur")` | YES |
| `visibility_change` | recorder `emit("visibility_change", { state: document.visibilityState })` | YES iff `detail.state === "hidden"` |
| `page_hide` | recorder `emit("page_hide")` | YES |
| `screen_share_stopped` | recorder `emit("screen_share_stopped", { reason: "track_ended" })` | YES |
| `recording_error` | recorder `emit("recording_error", ...)` | YES |
| `ip_address_changed` | recorder `emit("ip_address_changed", ...)` | YES |
| `integrity_checkpoint_missed` | App.tsx `createUiEvent("integrity_checkpoint_missed", ...)` | YES |

Everything else flowing through the funnel is a NON-anomaly by construction (not in the classifier map): `window_focus`, `visibility_change: visible`, `before_unload`, `clipboard_activity`, `reload_shortcut_blocked`, `chunk_uploaded`, `upload_error`, `event_upload_error`, `heartbeat_error`, `small_video_chunk_detected`, `invalid_share_surface`, `integrity_checkpoint_shown/confirmed`, `integrity_notice`, all `camera_*`/`microphone_*`/`media_preview_*` events, `combined_recording_started`, `direct_screen_recording_stream_started`, `session_stop_requested`, `tabs/clipboard/cookie review` events, and the shell's own `fullscreen_enter`/`onboarding_stage`/`topbar_hidden`/`topbar_restored`. (Editor `editor_*` events never reach `addEvent` at all — they batch to `/api/editor-events` — but the classifier returns `{anomaly:false}` for them defensively.)

**Spec→code resolutions made while planning** (each also commented at the code site):

1. **S3 has NOT landed** (only its plan exists). Spec §4 says `examReleased` comes "from S3's release state when it lands". Resolution: `App.tsx` passes `examReleased: true` as a documented constant seam; `deriveStage` fully implements (and tests) the `examReleased: false → stage 3` branch so S3 only swaps the input.
2. **Spec §4 "locked keeps the last pre-lock stage"** — impossible for a pure function of current inputs. Resolution: `deriveStage` returns 3 for `locked`; the bar is hidden on the locked screen regardless (spec's own rule), so the value is unobservable. Documented in code.
3. **Spec §9 hook signature** listed `identity`/`elapsedSeconds` as hook inputs. The hook never uses them (render-only data) — they flow as props to `ExamTopBar`. Behavior contract unchanged.
4. **Two files added** beyond spec §3.9's layout: `shell/useExamShell.ts` (React glue; the spec's `useExamShell()` needed a home that isn't the pure module) and `shell/ExamShellChrome.tsx` (composition, so `App.tsx` stays wiring-only).
5. **Reducer gained a `session_ended` action** (spec silent): if the test ends mid-hide-episode, the DONE bar must still render; it unhides (flag count kept) and emits an honest `topbar_restored`.
6. **Fixed 64px bar vs existing `Shell` header**: the fixed bar would overlap the Aerele header. `Shell` gets an opt-in `padTop` prop (default `false`; `AdminApp`'s two `Shell` usages untouched).
7. **`status === "ending"` keeps the bar / stage 4** ("IN EXAM"): the spec gates anomalies on `status === "recording"` literally — implemented literally; excursions while "ending" don't vanish the bar.
8. **`formatElapsed` in App.tsx is deleted** with `TimerBar` (its only caller — verified); the shell has its own tested `formatExamElapsed` (H:MM:SS, hours unpadded per spec §7.1).

**Scope guard (spec §12):** NO signed-QR, NO OMR markers, NO recording-before-identity, NO "type the sentence" challenge, NO blocking/escalation, NO backend `SURE_SHOT_EVENT_TYPES` change, NO session-doc stage stamping, NO S2/S3 internals. All commits LOCAL — **never push**.

---

## File structure

**Create:**
- `frontend/src/shell/examShell.ts` — pure: stage derivation + meta, hints, formatters, anomaly classification, top-bar reducer, event helpers. No React, no DOM calls.
- `frontend/src/shell/examShell.test.ts` — vitest (60 tests when complete).
- `frontend/src/shell/useExamShell.ts` — the one React hook (fullscreenchange owner, funnel tap, pre-session buffer, emissions).
- `frontend/src/shell/ExamTopBar.tsx`, `frontend/src/shell/FullscreenGate.tsx`, `frontend/src/shell/AnomalyPanel.tsx` — thin components.
- `frontend/src/shell/ExamShellChrome.tsx` — composition (bar/panel/hint/gate per §9 render structure).

**Modify:**
- `frontend/src/App.tsx` — StudentApp wiring only: funnel tap + hook + chrome on all five branches; DELETE `StudentStepBanner`, `TimerBar`, `formatElapsed`; `HealthPanel` gains the two IP rows; `Shell` gains `padTop`.
- `frontend/src/types.ts` — comment documenting the new shell event-type strings.

**Full check per task** (run from `/home/karthi/arogara/proctor/frontend`): `npx tsc --noEmit && npx vitest run && npm run build` — all three must be clean before the task's commit.

---

## Task 1: Pure stage logic — derivation, labels, hints, clock formatters

**Files:**
- Create: `frontend/src/shell/examShell.ts`
- Test: `frontend/src/shell/examShell.test.ts`

- [ ] **Step 1.1: Write the failing test**

```typescript
// frontend/src/shell/examShell.test.ts
import { describe, it, expect } from "vitest";
import {
  deriveStage, stageHint, topBarVisible, STAGE_META,
  formatWallClock, formatExamElapsed,
  type StageInput
} from "./examShell";

const base: StageInput = { fullscreen: true, gate: "form", status: "idle", examReleased: true };

describe("deriveStage", () => {
  it("1 FULLSCREEN: not in fullscreen, in any pre-end state", () => {
    expect(deriveStage({ ...base, fullscreen: false })).toBe(1);
    expect(deriveStage({ ...base, fullscreen: false, gate: "running", status: "recording" })).toBe(1);
    expect(deriveStage({ ...base, fullscreen: false, gate: "pending_approval" })).toBe(1);
  });
  it("2 DETAILS: fullscreen OK, no session yet (gate form), incl. registration in flight", () => {
    expect(deriveStage(base)).toBe(2);
    expect(deriveStage({ ...base, status: "starting" })).toBe(2);
  });
  it("3 GET READY: session exists but surface not live (resume needed / share starting / pending approval)", () => {
    expect(deriveStage({ ...base, gate: "running", status: "idle" })).toBe(3);
    expect(deriveStage({ ...base, gate: "running", status: "starting" })).toBe(3);
    expect(deriveStage({ ...base, gate: "pending_approval", status: "idle" })).toBe(3);
  });
  it("3 GET READY: recording but the room gate has not released the exam (S3 seam)", () => {
    expect(deriveStage({ ...base, gate: "running", status: "recording", examReleased: false })).toBe(3);
  });
  it("4 IN EXAM: recording (and ending) with the exam released", () => {
    expect(deriveStage({ ...base, gate: "running", status: "recording" })).toBe(4);
    expect(deriveStage({ ...base, gate: "running", status: "ending" })).toBe(4);
  });
  it("5 DONE: ended wins over everything, even out of fullscreen", () => {
    expect(deriveStage({ ...base, gate: "ended", status: "ended", fullscreen: false })).toBe(5);
    expect(deriveStage({ ...base, gate: "running", status: "ended" })).toBe(5);
  });
  it("locked reports 3 (the bar is hidden on the locked screen anyway)", () => {
    expect(deriveStage({ ...base, gate: "locked", status: "idle" })).toBe(3);
  });
});

describe("STAGE_META", () => {
  it("carries the spec §4 label + color block per stage", () => {
    expect(STAGE_META[1]).toEqual({ label: "FULLSCREEN", blockClass: "bg-red-600" });
    expect(STAGE_META[2]).toEqual({ label: "DETAILS", blockClass: "bg-amber-500" });
    expect(STAGE_META[3]).toEqual({ label: "GET READY", blockClass: "bg-sky-500" });
    expect(STAGE_META[4]).toEqual({ label: "IN EXAM", blockClass: "bg-emerald-600" });
    expect(STAGE_META[5]).toEqual({ label: "DONE", blockClass: "bg-indigo-600" });
  });
});

describe("topBarVisible", () => {
  it("bar renders unless an anomaly episode is active or the session is locked", () => {
    expect(topBarVisible(false, "form")).toBe(true);
    expect(topBarVisible(false, "running")).toBe(true);
    expect(topBarVisible(false, "ended")).toBe(true);
    expect(topBarVisible(true, "running")).toBe(false);
    expect(topBarVisible(false, "locked")).toBe(false);
  });
});

describe("stageHint", () => {
  it("stage 1: fullscreen instruction", () => {
    expect(stageHint({ ...base, fullscreen: false, ownEditor: true })).toMatch(/fullscreen/i);
  });
  it("stage 2: details + start proctoring", () => {
    expect(stageHint({ ...base, ownEditor: true })).toMatch(/details/i);
  });
  it("stage 3 variants: pending approval / locked / resume / share prompt / end-retry / waiting for release", () => {
    expect(stageHint({ ...base, gate: "pending_approval", ownEditor: true })).toMatch(/approve/i);
    expect(stageHint({ ...base, gate: "locked", ownEditor: true })).toMatch(/locked/i);
    expect(stageHint({ ...base, gate: "running", status: "idle", ownEditor: true })).toMatch(/resume recording/i);
    expect(stageHint({ ...base, gate: "running", status: "starting", ownEditor: true })).toMatch(/entire screen/i);
    expect(stageHint({ ...base, gate: "running", status: "error", ownEditor: true })).toMatch(/retry/i);
    expect(stageHint({ ...base, gate: "running", status: "recording", examReleased: false, ownEditor: true })).toMatch(/room/i);
  });
  it("stage 4: own-editor copy never mentions HackerRank; legacy copy does", () => {
    const own = stageHint({ ...base, gate: "running", status: "recording", ownEditor: true });
    expect(own).toMatch(/coding workspace/i);
    expect(own).not.toMatch(/hackerrank/i);
    expect(stageHint({ ...base, gate: "running", status: "recording", ownEditor: false })).toMatch(/HackerRank/);
  });
  it("stage 5: complete", () => {
    expect(stageHint({ ...base, gate: "ended", status: "ended", ownEditor: true })).toMatch(/complete/i);
  });
});

describe("formatWallClock", () => {
  it("renders HH:MM:SS local time, zero-padded", () => {
    expect(formatWallClock(new Date(2026, 5, 10, 9, 5, 3))).toBe("09:05:03");
    expect(formatWallClock(new Date(2026, 5, 10, 23, 59, 59))).toBe("23:59:59");
  });
});

describe("formatExamElapsed", () => {
  it("renders H:MM:SS with unpadded hours", () => {
    expect(formatExamElapsed(0)).toBe("0:00:00");
    expect(formatExamElapsed(61)).toBe("0:01:01");
    expect(formatExamElapsed(3723)).toBe("1:02:03");
  });
  it("clamps negatives to zero", () => {
    expect(formatExamElapsed(-5)).toBe("0:00:00");
  });
});
```

- [ ] **Step 1.2: Run test to verify it fails**

Run: `cd /home/karthi/arogara/proctor/frontend && npx vitest run src/shell/examShell.test.ts`
Expected: FAIL — `Cannot find module './examShell'` (or unresolved import).

- [ ] **Step 1.3: Write the implementation**

```typescript
// frontend/src/shell/examShell.ts
//
// S1 exam shell — PURE logic only (no React, no DOM calls): onboarding-stage
// derivation, the per-stage hint line, bar-presence rule, and small display
// formatters. (Task 2 adds anomaly classification + the top-bar reducer.)
// Everything here is vitest-tested; the React hook (useExamShell.ts) and the
// shell components stay thin.
//
// Design: docs/superpowers/specs/2026-06-09-s1-exam-shell-design.md

import type { SessionStatus } from "../types";

// Mirrors StudentApp's `StudentGate` union (App.tsx) — declared here, not
// imported, so the pure module has no dependency on App.tsx. The two unions
// are structurally identical, so App's gate value is directly assignable.
export type ShellGate = "form" | "pending_approval" | "locked" | "ended" | "running";

export type Stage = 1 | 2 | 3 | 4 | 5;

// Spec §4: the five onboarding stages — at-a-distance label + stage-block color.
export const STAGE_META: Record<Stage, { label: string; blockClass: string }> = {
  1: { label: "FULLSCREEN", blockClass: "bg-red-600" },
  2: { label: "DETAILS", blockClass: "bg-amber-500" },
  3: { label: "GET READY", blockClass: "bg-sky-500" },
  4: { label: "IN EXAM", blockClass: "bg-emerald-600" },
  5: { label: "DONE", blockClass: "bg-indigo-600" }
};

export type StageInput = {
  fullscreen: boolean;
  gate: ShellGate;
  status: SessionStatus;
  // S3 room-gate seam: true when the room gate is not enabled/built (tonight:
  // S3 has not landed, so App.tsx always passes true) or the invigilator has
  // released the room code. false => recording candidates wait at stage 3.
  examReleased: boolean;
};

// Spec §4 derivation contract. Priority: ended wins; then the fullscreen gate;
// then session progress. `locked` reports 3 — the spec's "keeps the last
// pre-lock stage" is unimplementable in a pure function, and the bar never
// renders while locked (see topBarVisible), so the value is unobservable.
export function deriveStage({ fullscreen, gate, status, examReleased }: StageInput): Stage {
  if (gate === "ended" || status === "ended") return 5;
  if (!fullscreen) return 1;
  if (gate === "form") return 2;
  // A session exists (running / pending_approval / locked).
  if (status === "recording" || status === "ending") return examReleased ? 4 : 3;
  return 3;
}

// Spec §7: bar presence semantics — the bar renders on EVERY branch except
// during an anomaly episode and on the locked screen (absence = walk over;
// the locked hide is a render rule, not a reducer episode — no flag increment).
export function topBarVisible(barHidden: boolean, gate: ShellGate): boolean {
  return !barHidden && gate !== "locked";
}

// Spec §7.4: the one-line close-up hint under the bar — survives from the
// deleted StudentStepBanner. ownEditor mirrors App.tsx's OWN_EDITOR; only the
// in-exam hint is surface-specific (own-editor copy must not say HackerRank).
export function stageHint(input: StageInput & { ownEditor: boolean }): string {
  const stage = deriveStage(input);
  const { gate, status, ownEditor } = input;
  if (stage === 5) return "Your test is complete. You may close this tab.";
  if (stage === 1) return "The exam runs in fullscreen from start to finish. Enter fullscreen to continue.";
  if (stage === 2) return "Read the rules, fill in your details and consent, then start proctoring.";
  if (stage === 4) {
    return ownEditor
      ? "Recording is active. Solve the problem in the coding workspace below and keep this tab running. End the test here when you submit."
      : "Recording is active. Open HackerRank with the Start test button and keep this tab running. End the test here when you submit.";
  }
  // Stage 3 — GET READY variants.
  if (gate === "pending_approval") return "Waiting for a proctor to approve this device. Stay on this page.";
  if (gate === "locked") return "Your session is locked. Call a proctor to unlock you.";
  if (status === "starting") return "Follow the browser prompt and share your Entire Screen.";
  if (status === "error") return "Recording has stopped. Use the Retry button on this page to finish ending your test.";
  if (status === "recording" || status === "ending") return "Recording is active. Waiting for your room's exam code to be released.";
  return "Your session was restored. Press Resume recording to share your screen again and continue.";
}

// Right side of the bar: a ticking local wall clock — every stage gets a
// ticking element (a screenshot or printout cannot tick).
export function formatWallClock(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// Elapsed exam time, H:MM:SS (hours unpadded — reads as "0:14:09"). Spec §7.1.
// (App.tsx's formatElapsed dies with TimerBar; this is the shell's own.)
export function formatExamElapsed(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${hours}:${pad(minutes)}:${pad(seconds)}`;
}
```

- [ ] **Step 1.4: Run test to verify it passes**

Run: `cd /home/karthi/arogara/proctor/frontend && npx vitest run src/shell/examShell.test.ts`
Expected: PASS — 17 tests.

- [ ] **Step 1.5: Full check**

Run: `cd /home/karthi/arogara/proctor/frontend && npx tsc --noEmit && npx vitest run && npm run build`
Expected: all clean (existing coding/ suites stay green).

- [ ] **Step 1.6: Commit**

```bash
cd /home/karthi/arogara/proctor
git add frontend/src/shell/examShell.ts frontend/src/shell/examShell.test.ts
git commit -m "feat(shell): pure 1-5 stage derivation, labels, hints, clock formatters (S1)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: Pure anomaly classification + top-bar vanish/restore reducer

**Files:**
- Modify: `frontend/src/shell/examShell.ts` (append)
- Modify: `frontend/src/shell/examShell.test.ts` (append)

- [ ] **Step 2.1: Write the failing tests**

In `frontend/src/shell/examShell.test.ts`, replace the import block at the top:

```typescript
import { describe, it, expect } from "vitest";
import {
  deriveStage, stageHint, topBarVisible, STAGE_META,
  formatWallClock, formatExamElapsed,
  type StageInput
} from "./examShell";
```

with:

```typescript
import { describe, it, expect } from "vitest";
import {
  deriveStage, stageHint, topBarVisible, STAGE_META,
  formatWallClock, formatExamElapsed,
  anomalyFromEvent, topBarReducer, initialTopBarState,
  makeShellEvent, appendToBuffer,
  type StageInput, type RestorePreconditions
} from "./examShell";
import type { ProctorEvent } from "../types";
```

then APPEND to the end of the file:

```typescript
describe("anomalyFromEvent", () => {
  const anomalyCases: Array<[string, Record<string, unknown> | undefined, string]> = [
    ["fullscreen_exit", undefined, "You left fullscreen."],
    ["window_blur", undefined, "You switched to another window or application."],
    ["page_hide", undefined, "This exam tab was hidden or closed."],
    ["screen_share_stopped", { reason: "track_ended" }, "Screen sharing stopped."],
    ["recording_error", { kind: "screen" }, "Screen recording hit an error."],
    ["ip_address_changed", { previous: "1.2.3.4", current: "5.6.7.8" }, "Your network connection changed."],
    ["integrity_checkpoint_missed", { checkpoint_id: "c1" }, "You missed an attendance check."]
  ];
  it.each(anomalyCases)("%s is an anomaly", (type, detail, message) => {
    expect(anomalyFromEvent(type, detail)).toEqual({ anomaly: true, reason: type, message });
  });
  it("visibility_change is an anomaly ONLY when state is hidden", () => {
    expect(anomalyFromEvent("visibility_change", { state: "hidden" })).toEqual({
      anomaly: true, reason: "visibility_change", message: "This exam tab was hidden."
    });
    expect(anomalyFromEvent("visibility_change", { state: "visible" })).toEqual({ anomaly: false });
  });
  it("the expected end-of-test fullscreen_exit is NOT an anomaly", () => {
    expect(anomalyFromEvent("fullscreen_exit", { expected: true })).toEqual({ anomaly: false });
  });
  it.each([
    "fullscreen_enter", "window_focus", "before_unload", "clipboard_activity",
    "reload_shortcut_blocked", "upload_error", "event_upload_error", "heartbeat_error",
    "chunk_uploaded", "small_video_chunk_detected", "invalid_share_surface",
    "integrity_checkpoint_shown", "integrity_checkpoint_confirmed", "integrity_notice",
    "camera_microphone_optional_capture_failed", "camera_stopped", "microphone_stopped",
    "editor_blur", "editor_focus", "editor_paste",
    "onboarding_stage", "topbar_hidden", "topbar_restored"
  ])("%s is NOT an anomaly", (type) => {
    expect(anomalyFromEvent(type)).toEqual({ anomaly: false });
  });
});

const evt = (type: string, detail?: Record<string, unknown>, at = "2026-06-10T01:00:00.000Z"): ProctorEvent =>
  ({ type, timestamp: at, detail });

const allClear: RestorePreconditions = { fullscreen: true, visible: true, recording: true };

describe("topBarReducer", () => {
  it("first anomaly while recording: hides the bar, increments the flag, emits ONE topbar_hidden", () => {
    const { state, emit } = topBarReducer(initialTopBarState, { kind: "event", event: evt("window_blur"), recording: true, nowMs: 1000 });
    expect(state.barHidden).toBe(true);
    expect(state.flagCount).toBe(1);
    expect(state.activeReasons).toEqual([
      { type: "window_blur", message: "You switched to another window or application.", at: "2026-06-10T01:00:00.000Z" }
    ]);
    expect(emit).toEqual({
      type: "topbar_hidden",
      detail: { reason: "You switched to another window or application.", trigger_type: "window_blur" }
    });
  });
  it("anomaly while NOT recording: no-op (pre-recording exits only re-show the gate)", () => {
    const { state, emit } = topBarReducer(initialTopBarState, { kind: "event", event: evt("fullscreen_exit"), recording: false, nowMs: 1000 });
    expect(state).toBe(initialTopBarState);
    expect(emit).toBeNull();
  });
  it("non-anomaly events never touch the bar", () => {
    const { state, emit } = topBarReducer(initialTopBarState, { kind: "event", event: evt("window_focus"), recording: true, nowMs: 1000 });
    expect(state).toBe(initialTopBarState);
    expect(emit).toBeNull();
  });
  it("episode dedupe: blur+hidden+fullscreen_exit in one excursion = ONE flag, reasons deduped by type, no second emission", () => {
    let r = topBarReducer(initialTopBarState, { kind: "event", event: evt("window_blur"), recording: true, nowMs: 1000 });
    r = topBarReducer(r.state, { kind: "event", event: evt("visibility_change", { state: "hidden" }), recording: true, nowMs: 1100 });
    expect(r.emit).toBeNull();
    r = topBarReducer(r.state, { kind: "event", event: evt("fullscreen_exit"), recording: true, nowMs: 1200 });
    expect(r.emit).toBeNull();
    const again = topBarReducer(r.state, { kind: "event", event: evt("window_blur"), recording: true, nowMs: 1300 });
    expect(again.emit).toBeNull();
    expect(again.state.flagCount).toBe(1);
    expect(again.state.activeReasons.map((x) => x.type)).toEqual(["window_blur", "visibility_change", "fullscreen_exit"]);
  });
  it("fullscreen_enter never auto-restores the bar", () => {
    const hidden = topBarReducer(initialTopBarState, { kind: "event", event: evt("fullscreen_exit"), recording: true, nowMs: 1000 }).state;
    const { state, emit } = topBarReducer(hidden, { kind: "event", event: evt("fullscreen_enter"), recording: true, nowMs: 2000 });
    expect(state.barHidden).toBe(true);
    expect(emit).toBeNull();
  });
  it("restore: rejected until ALL preconditions hold", () => {
    const hidden = topBarReducer(initialTopBarState, { kind: "event", event: evt("window_blur"), recording: true, nowMs: 1000 }).state;
    for (const broken of [
      { ...allClear, fullscreen: false },
      { ...allClear, visible: false },
      { ...allClear, recording: false }
    ]) {
      const r = topBarReducer(hidden, { kind: "restore", preconditions: broken, nowMs: 9000 });
      expect(r.state.barHidden).toBe(true);
      expect(r.emit).toBeNull();
    }
  });
  it("restore with preconditions met: bar back, reasons cleared, flag persists, emits topbar_restored with hidden_ms + reasons", () => {
    let r = topBarReducer(initialTopBarState, { kind: "event", event: evt("window_blur"), recording: true, nowMs: 1000 });
    r = topBarReducer(r.state, { kind: "event", event: evt("visibility_change", { state: "hidden" }), recording: true, nowMs: 1500 });
    const restored = topBarReducer(r.state, { kind: "restore", preconditions: allClear, nowMs: 61_000 });
    expect(restored.state).toEqual({ barHidden: false, flagCount: 1, activeReasons: [], hiddenAtMs: null });
    expect(restored.emit).toEqual({
      type: "topbar_restored",
      detail: { hidden_ms: 60_000, reasons: ["window_blur", "visibility_change"] }
    });
  });
  it("a SECOND episode after restore increments the flag to 2", () => {
    let r = topBarReducer(initialTopBarState, { kind: "event", event: evt("window_blur"), recording: true, nowMs: 1000 });
    r = topBarReducer(r.state, { kind: "restore", preconditions: allClear, nowMs: 2000 });
    r = topBarReducer(r.state, { kind: "event", event: evt("page_hide"), recording: true, nowMs: 3000 });
    expect(r.state.barHidden).toBe(true);
    expect(r.state.flagCount).toBe(2);
    expect(r.emit?.type).toBe("topbar_hidden");
  });
  it("restore while not hidden: no-op, no emission", () => {
    const r = topBarReducer(initialTopBarState, { kind: "restore", preconditions: allClear, nowMs: 1000 });
    expect(r.state).toBe(initialTopBarState);
    expect(r.emit).toBeNull();
  });
  it("session_ended while hidden: unhides (the DONE bar must render), flag persists, logs the restore", () => {
    const hidden = topBarReducer(initialTopBarState, { kind: "event", event: evt("window_blur"), recording: true, nowMs: 1000 }).state;
    const r = topBarReducer(hidden, { kind: "session_ended", nowMs: 5000 });
    expect(r.state.barHidden).toBe(false);
    expect(r.state.flagCount).toBe(1);
    expect(r.emit).toEqual({ type: "topbar_restored", detail: { hidden_ms: 4000, reasons: ["window_blur"] } });
  });
});

describe("makeShellEvent / appendToBuffer", () => {
  it("makeShellEvent builds a ProctorEvent in the createUiEvent shape", () => {
    expect(makeShellEvent("fullscreen_enter", { via: "gate" }, "2026-06-10T01:00:00.000Z", "visible")).toEqual({
      type: "fullscreen_enter",
      timestamp: "2026-06-10T01:00:00.000Z",
      detail: { via: "gate" },
      visibility_state: "visible"
    });
  });
  it("appendToBuffer caps at 50, dropping the oldest", () => {
    let buf: ProctorEvent[] = [];
    for (let i = 0; i < 55; i++) buf = appendToBuffer(buf, makeShellEvent(`e${i}`, undefined, "t", "visible"));
    expect(buf.length).toBe(50);
    expect(buf[0].type).toBe("e5");
    expect(buf[49].type).toBe("e54");
  });
});
```

- [ ] **Step 2.2: Run test to verify it fails**

Run: `cd /home/karthi/arogara/proctor/frontend && npx vitest run src/shell/examShell.test.ts`
Expected: FAIL — `anomalyFromEvent` (etc.) has no exported member.

- [ ] **Step 2.3: Write the implementation**

In `frontend/src/shell/examShell.ts`, replace the import line:

```typescript
import type { SessionStatus } from "../types";
```

with:

```typescript
import type { ProctorEvent, SessionStatus } from "../types";
```

then APPEND to the end of the file:

```typescript
// ---- Spec §6: anomaly classification ---------------------------------------

export type AnomalyVerdict =
  | { anomaly: true; reason: string; message: string }
  | { anomaly: false };

// Friendly panel copy per anomaly event type (spec §6 table). Every event type
// NOT in this map (editor_*, clipboard_activity, window_focus, infra errors,
// the shell's own bookkeeping events, …) is a non-anomaly by construction.
const ANOMALY_MESSAGES: Record<string, string> = {
  fullscreen_exit: "You left fullscreen.",
  window_blur: "You switched to another window or application.",
  page_hide: "This exam tab was hidden or closed.",
  screen_share_stopped: "Screen sharing stopped.",
  recording_error: "Screen recording hit an error.",
  ip_address_changed: "Your network connection changed.",
  integrity_checkpoint_missed: "You missed an attendance check."
};

export function anomalyFromEvent(type: string, detail?: Record<string, unknown>): AnomalyVerdict {
  if (type === "visibility_change") {
    return detail?.state === "hidden"
      ? { anomaly: true, reason: "visibility_change", message: "This exam tab was hidden." }
      : { anomaly: false };
  }
  // The end-of-test exitFullscreen() is logged with detail.expected === true
  // (spec §5.2) — never an anomaly.
  if (type === "fullscreen_exit" && detail?.expected === true) return { anomaly: false };
  const message = ANOMALY_MESSAGES[type];
  return message ? { anomaly: true, reason: type, message } : { anomaly: false };
}

// ---- Spec §6/§7: top-bar vanish/restore reducer -----------------------------

export type AnomalyReason = { type: string; message: string; at: string };

export type TopBarState = {
  barHidden: boolean;
  // Permanent ⚑ chip: hide EPISODES this session (transitions count, not events).
  flagCount: number;
  // Current episode's reasons, deduped by type, in arrival order.
  activeReasons: AnomalyReason[];
  hiddenAtMs: number | null;
};

export const initialTopBarState: TopBarState = {
  barHidden: false,
  flagCount: 0,
  activeReasons: [],
  hiddenAtMs: null
};

export type RestorePreconditions = {
  fullscreen: boolean;
  visible: boolean;
  recording: boolean;
};

export type TopBarAction =
  // Every event flowing through StudentApp's addEvent funnel. `recording` is
  // sampled at dispatch time — anomalies vanish the bar ONLY while recording
  // (spec decision 4; the share-picker "starting" moment is therefore safe).
  | { kind: "event"; event: ProctorEvent; recording: boolean; nowMs: number }
  // Candidate clicked "I have fixed this". Preconditions are re-checked here —
  // restore is a no-op unless ALL hold (spec §7.3).
  | { kind: "restore"; preconditions: RestorePreconditions; nowMs: number }
  // Test ended mid-episode: unhide so the DONE bar (with its permanent flag
  // chip) renders. Not in the spec — see plan "resolutions" item 5.
  | { kind: "session_ended"; nowMs: number };

// Emissions the caller must send through the events pipeline (spec §6 episode
// semantics: ONE topbar_hidden per excursion, ONE topbar_restored on restore).
export type ShellEmission =
  | { type: "topbar_hidden"; detail: { reason: string; trigger_type: string } }
  | { type: "topbar_restored"; detail: { hidden_ms: number; reasons: string[] } };

export type TopBarResult = { state: TopBarState; emit: ShellEmission | null };

export function topBarReducer(state: TopBarState, action: TopBarAction): TopBarResult {
  if (action.kind === "event") {
    const verdict = anomalyFromEvent(action.event.type, action.event.detail);
    if (!verdict.anomaly || !action.recording) return { state, emit: null };
    const reason: AnomalyReason = { type: verdict.reason, message: verdict.message, at: action.event.timestamp };
    if (!state.barHidden) {
      // First anomaly of an episode: ONE topbar_hidden + ONE flag increment.
      return {
        state: { barHidden: true, flagCount: state.flagCount + 1, activeReasons: [reason], hiddenAtMs: action.nowMs },
        emit: { type: "topbar_hidden", detail: { reason: verdict.message, trigger_type: verdict.reason } }
      };
    }
    // Already hidden: append the reason (deduped by type) — no double-counting
    // a single excursion that fires blur+hidden+fullscreen_exit together.
    if (state.activeReasons.some((r) => r.type === reason.type)) return { state, emit: null };
    return { state: { ...state, activeReasons: [...state.activeReasons, reason] }, emit: null };
  }

  if (action.kind === "restore") {
    const { fullscreen, visible, recording } = action.preconditions;
    if (!state.barHidden || !fullscreen || !visible || !recording) return { state, emit: null };
    return restoreState(state, action.nowMs);
  }

  // session_ended
  if (!state.barHidden) return { state, emit: null };
  return restoreState(state, action.nowMs);
}

function restoreState(state: TopBarState, nowMs: number): TopBarResult {
  return {
    state: { ...state, barHidden: false, activeReasons: [], hiddenAtMs: null },
    emit: {
      type: "topbar_restored",
      detail: {
        hidden_ms: state.hiddenAtMs == null ? 0 : Math.max(0, nowMs - state.hiddenAtMs),
        reasons: state.activeReasons.map((r) => r.type)
      }
    }
  };
}

// ---- Spec §8: shell event helpers -------------------------------------------

// Shell-emitted ProctorEvent — mirrors App.tsx createUiEvent, but pure:
// timestamp and visibility_state are passed in by the DOM-aware caller.
export function makeShellEvent(
  type: string,
  detail: Record<string, unknown> | undefined,
  nowIso: string,
  visibilityState: DocumentVisibilityState
): ProctorEvent {
  return { type, timestamp: nowIso, detail, visibility_state: visibilityState };
}

// Pre-session event buffer (spec §8): cap 50, oldest dropped. Best-effort
// audit, not evidence of record — dropped silently if no session ever exists.
export const SHELL_EVENT_BUFFER_CAP = 50;

export function appendToBuffer(
  buffer: ProctorEvent[],
  event: ProctorEvent,
  cap: number = SHELL_EVENT_BUFFER_CAP
): ProctorEvent[] {
  const next = [...buffer, event];
  return next.length > cap ? next.slice(next.length - cap) : next;
}
```

- [ ] **Step 2.4: Run test to verify it passes**

Run: `cd /home/karthi/arogara/proctor/frontend && npx vitest run src/shell/examShell.test.ts`
Expected: PASS — 60 tests (17 from Task 1 + 43 new).

- [ ] **Step 2.5: Full check**

Run: `cd /home/karthi/arogara/proctor/frontend && npx tsc --noEmit && npx vitest run && npm run build`
Expected: all clean.

- [ ] **Step 2.6: Commit**

```bash
cd /home/karthi/arogara/proctor
git add frontend/src/shell/examShell.ts frontend/src/shell/examShell.test.ts
git commit -m "feat(shell): anomaly classification + top-bar vanish/restore reducer (S1)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: `useExamShell` — the one React hook

**Files:**
- Create: `frontend/src/shell/useExamShell.ts`

No vitest here by convention (no jsdom/component tests — see `frontend/src/coding/`): every decision this hook takes is already pure-tested in Task 1/2; the hook is DOM/React glue verified by tsc + build + the Task 6 browser run.

- [ ] **Step 3.1: Write the hook**

```typescript
// frontend/src/shell/useExamShell.ts
//
// S1 exam shell — the ONE React hook (spec §9). Owns: the single
// fullscreenchange listener (fullscreen truth + fullscreen_enter/_exit
// emission), the visibilitychange mirror for restore preconditions, the
// pre-session event buffer, stage-transition emission, and the end-of-test
// exitFullscreen. ALL decisions live in the pure examShell.ts reducer/
// classifier (vitest-tested) — this file is thin glue.
//
// Event flow (single classification path, no double dispatch):
//   recorder/UI events -> StudentApp addEvent -> tap -> onShellEvent -> reducer
//   shell emissions    -> addEvent (same tap classifies them) + sendEvents/buffer
//
// StrictMode-safe: no side effects inside setState updaters; the reducer is
// driven through an explicit dispatch over a ref.

import { useEffect, useMemo, useRef, useState } from "react";
import { sendEvents } from "../api";
import type { ProctorEvent, SessionStatus } from "../types";
import {
  appendToBuffer, deriveStage, initialTopBarState, makeShellEvent, topBarReducer, STAGE_META,
  type AnomalyReason, type RestorePreconditions, type ShellGate, type Stage,
  type TopBarAction, type TopBarState
} from "./examShell";

export type ExamShellApi = {
  fullscreen: boolean;
  stage: Stage;
  barHidden: boolean;
  flagCount: number;
  activeReasons: AnomalyReason[];
  // Live precondition view for the AnomalyPanel (button enable + guidance).
  preconditions: RestorePreconditions;
  enterFullscreen: () => Promise<void>;
  restoreBar: () => void;
  // Tap point: StudentApp's addEvent funnel calls this for EVERY event.
  onShellEvent: (event: ProctorEvent) => void;
};

export function useExamShell(opts: {
  gate: ShellGate;
  status: SessionStatus;
  sessionId: string;
  examReleased: boolean;
  addEvent: (event: ProctorEvent) => void;
}): ExamShellApi {
  const { gate, status, sessionId, examReleased, addEvent } = opts;

  const [fullscreen, setFullscreen] = useState<boolean>(() => Boolean(document.fullscreenElement));
  const [pageVisible, setPageVisible] = useState<boolean>(() => document.visibilityState === "visible");
  const [barState, setBarState] = useState<TopBarState>(initialTopBarState);

  // Refs so the stable listeners/callbacks always see current values.
  const barRef = useRef<TopBarState>(initialTopBarState);
  const statusRef = useRef(status);
  const sessionIdRef = useRef(sessionId);
  const addEventRef = useRef(addEvent);
  const bufferRef = useRef<ProctorEvent[]>([]);
  const expectedExitRef = useRef(false);
  statusRef.current = status;
  sessionIdRef.current = sessionId;
  addEventRef.current = addEvent;

  // Emit a shell event into the funnel + network (buffered pre-session, §8).
  // The funnel tap classifies it — emission itself never touches the reducer.
  const emitShellEvent = useMemo(() => {
    return (type: string, detail?: Record<string, unknown>) => {
      const event = makeShellEvent(type, detail, new Date().toISOString(), document.visibilityState);
      addEventRef.current(event);
      const sid = sessionIdRef.current;
      if (sid) void sendEvents(sid, [event]); // fire-and-forget, like createUiEvent call sites
      else bufferRef.current = appendToBuffer(bufferRef.current, event);
    };
  }, []);

  // Single dispatch path into the pure reducer; emissions happen here (outside
  // any React state updater). Reentrancy is safe: barRef is updated BEFORE the
  // emission, and the emitted bookkeeping events classify as non-anomalies.
  const dispatch = useMemo(() => {
    return (action: TopBarAction) => {
      const { state, emit } = topBarReducer(barRef.current, action);
      if (state !== barRef.current) {
        barRef.current = state;
        setBarState(state);
      }
      if (emit) emitShellEvent(emit.type, emit.detail);
    };
  }, [emitShellEvent]);

  const onShellEvent = useMemo(() => {
    return (event: ProctorEvent) => {
      dispatch({ kind: "event", event, recording: statusRef.current === "recording", nowMs: Date.now() });
    };
  }, [dispatch]);

  // THE single fullscreenchange listener (spec §5.2) — owns fullscreen truth.
  useEffect(() => {
    const onFullscreenChange = () => {
      const fs = Boolean(document.fullscreenElement);
      setFullscreen(fs);
      if (fs) {
        emitShellEvent("fullscreen_enter");
      } else {
        const expected = expectedExitRef.current;
        expectedExitRef.current = false;
        emitShellEvent("fullscreen_exit", expected ? { expected: true } : undefined);
      }
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, [emitShellEvent]);

  // Mirror tab visibility for the AnomalyPanel's live precondition display.
  useEffect(() => {
    const onVisibility = () => setPageVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Flush the pre-session buffer once a session exists (§8). Best-effort.
  useEffect(() => {
    if (!sessionId || bufferRef.current.length === 0) return;
    const buffered = bufferRef.current;
    bufferRef.current = [];
    void sendEvents(sessionId, buffered);
  }, [sessionId]);

  const stage = deriveStage({ fullscreen, gate, status, examReleased });

  // Spec §4: emit onboarding_stage on every transition (buffered pre-session).
  const prevStageRef = useRef<Stage | null>(null);
  useEffect(() => {
    const from = prevStageRef.current;
    prevStageRef.current = stage;
    if (from === null || from === stage) return;
    emitShellEvent("onboarding_stage", { from, to: stage, label: STAGE_META[stage].label });
  }, [stage, emitShellEvent]);

  // Spec §5.2 test end: clear any hide episode so the DONE bar renders, then
  // leave fullscreen ourselves — marked expected so it is logged with
  // detail {expected:true} and never classified as an anomaly.
  useEffect(() => {
    if (stage !== 5) return;
    dispatch({ kind: "session_ended", nowMs: Date.now() });
    if (document.fullscreenElement) {
      expectedExitRef.current = true;
      void document.exitFullscreen().catch(() => {
        expectedExitRef.current = false; // already exited / rejected — swallow
      });
    }
  }, [stage, dispatch]);

  // Click = fresh user gesture, always valid (gate + panel buttons call this).
  // Rejection (browser policy) is surfaced inline by the caller; never auto-loops.
  const enterFullscreen = useMemo(() => {
    return async () => {
      await document.documentElement.requestFullscreen();
    };
  }, []);

  // Panel acknowledge — preconditions are sampled live from the DOM and
  // re-checked inside the pure reducer (no restore unless all hold).
  const restoreBar = useMemo(() => {
    return () => {
      dispatch({
        kind: "restore",
        nowMs: Date.now(),
        preconditions: {
          fullscreen: Boolean(document.fullscreenElement),
          visible: document.visibilityState === "visible",
          recording: statusRef.current === "recording"
        }
      });
    };
  }, [dispatch]);

  return {
    fullscreen,
    stage,
    barHidden: barState.barHidden,
    flagCount: barState.flagCount,
    activeReasons: barState.activeReasons,
    preconditions: { fullscreen, visible: pageVisible, recording: status === "recording" },
    enterFullscreen,
    restoreBar,
    onShellEvent
  };
}
```

- [ ] **Step 3.2: Full check**

Run: `cd /home/karthi/arogara/proctor/frontend && npx tsc --noEmit && npx vitest run && npm run build`
Expected: all clean (the hook is not yet imported anywhere; tsc still type-checks it via `include: ["src"]`).

- [ ] **Step 3.3: Commit**

```bash
cd /home/karthi/arogara/proctor
git add frontend/src/shell/useExamShell.ts
git commit -m "feat(shell): useExamShell hook — fullscreen truth, stage transitions, funnel tap (S1)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: Shell components — ExamTopBar, FullscreenGate, AnomalyPanel

**Files:**
- Create: `frontend/src/shell/ExamTopBar.tsx`
- Create: `frontend/src/shell/FullscreenGate.tsx`
- Create: `frontend/src/shell/AnomalyPanel.tsx`

Thin presentational components (convention: no component tests; the labels/colors/formatters they render are pure-tested).

- [ ] **Step 4.1: ExamTopBar**

```tsx
// frontend/src/shell/ExamTopBar.tsx
//
// S1 — the unique dark top bar (spec §7): fixed, full-width, ~64px, the ONLY
// dark chrome in the otherwise light app — instantly recognizable across a
// room. Left: §4 stage color block (the at-a-distance element). Center:
// name + roll + room (random ID-card spot checks). Right: liveness — a ticking
// wall clock on EVERY stage (screenshots can't tick); elapsed exam timer +
// pulsing REC dot while recording; permanent red ⚑ chip when flagCount > 0.
// Its ABSENCE is the alarm — ExamShellChrome unmounts it entirely on anomaly.

import { useEffect, useState } from "react";
import { formatExamElapsed, formatWallClock, STAGE_META, type Stage } from "./examShell";

export function ExamTopBar({ stage, identity, elapsedSeconds, recording, flagCount }: {
  stage: Stage;
  identity: { name: string; username: string; room: string } | null;
  elapsedSeconds: number;
  recording: boolean;
  flagCount: number;
}) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const meta = STAGE_META[stage];
  return (
    <div className="fixed inset-x-0 top-0 z-50 flex h-16 items-stretch bg-ink text-white shadow-subtle">
      {/* Stage block — number + label readable from the back of the room. */}
      <div className={`flex h-full shrink-0 items-center gap-3 px-5 ${meta.blockClass}`}>
        <span className="text-3xl font-bold leading-none">{stage}</span>
        <span className="text-sm font-semibold uppercase tracking-widest">{meta.label}</span>
      </div>
      {/* Identity — enables walk-by ID checks without interrupting. */}
      <div className="flex min-w-0 flex-1 items-center gap-3 px-5">
        {identity ? (
          <>
            <span className="truncate text-lg font-semibold">{identity.name}</span>
            <span className="truncate font-mono text-sm text-white/70">{identity.username}</span>
            <span className="shrink-0 text-sm text-white/70">Room {identity.room || "—"}</span>
          </>
        ) : (
          <span className="text-sm text-white/60">Not signed in</span>
        )}
      </div>
      {/* Liveness — flag chip, REC dot, ticking clock(s). */}
      <div className="flex shrink-0 items-center gap-4 px-5">
        {flagCount > 0 ? (
          <span className="rounded-full bg-red-600 px-2.5 py-1 text-xs font-bold">⚑ {flagCount}</span>
        ) : null}
        {recording ? (
          <span className="flex items-center gap-2">
            <span className="relative flex h-3 w-3">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-red-600" />
            </span>
            <span className="text-xs font-bold text-red-400">REC</span>
          </span>
        ) : null}
        {recording ? (
          <span className="text-right">
            {/* S5 seam: this slot later shows remaining time instead of elapsed. */}
            <span className="block font-mono text-xl font-semibold leading-none">{formatExamElapsed(elapsedSeconds)}</span>
            <span className="block font-mono text-[11px] text-white/60">{formatWallClock(now)}</span>
          </span>
        ) : (
          <span className="font-mono text-xl font-semibold">{formatWallClock(now)}</span>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4.2: FullscreenGate**

```tsx
// frontend/src/shell/FullscreenGate.tsx
//
// S1 §5.1 — the fullscreen-first gate: a near-blank dark overlay that is the
// candidate's FIRST screen, and that re-covers the app whenever fullscreen is
// lost BEFORE recording (whatever was active stays mounted underneath — form
// state is preserved). Renders below the fixed ExamTopBar (z-40 < z-50) so the
// red stage-1 bar stays readable over it. While an anomaly episode is active
// the AnomalyPanel owns re-entry instead (ExamShellChrome suppresses this gate).

import { useState } from "react";

export function FullscreenGate({ onEnter }: { onEnter: () => Promise<void> }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Same browser floor as the recorder (getDisplayMedia): latest Chrome/Edge on
  // a laptop/desktop. No Fullscreen API => dead-end copy, no button (spec §3.10).
  const supported = typeof document.documentElement.requestFullscreen === "function";

  const enter = async () => {
    setBusy(true);
    setError("");
    try {
      await onEnter();
    } catch {
      // Browser policy/permission rejection — inline retry, never an auto-loop.
      setError("Your browser blocked fullscreen. Click the button again to retry — if it keeps failing, call an invigilator.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink px-6 text-center text-white">
      <div className="max-w-md">
        <img src="/aerele-logo.png" alt="Aerele" className="mx-auto h-12 w-12 rounded-md" />
        <h1 className="mt-5 text-2xl font-semibold">This is a proctored exam</h1>
        {supported ? (
          <>
            <p className="mt-3 text-sm leading-6 text-white/70">
              The exam runs in fullscreen from start to finish. Enter fullscreen to begin.
            </p>
            <button
              className="focus-ring mt-6 rounded-md bg-white px-6 py-3 text-base font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-50"
              disabled={busy}
              onClick={() => void enter()}
            >
              Enter fullscreen to begin
            </button>
            {error ? <p className="mt-4 text-sm text-red-300">{error}</p> : null}
          </>
        ) : (
          <p className="mt-3 text-sm leading-6 text-white/70">
            This browser cannot run the fullscreen exam. Open this page in the latest Chrome or Edge on a laptop or desktop.
          </p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4.3: AnomalyPanel**

```tsx
// frontend/src/shell/AnomalyPanel.tsx
//
// S1 §7.3 — the red panel shown while the top bar is vanished. Lists the
// episode's friendly reason(s) with timestamps; exactly ONE primary action
// ("I have fixed this — restore my status bar") that stays disabled until
// every restore precondition holds. Re-enter fullscreen gets its own button
// (a fresh click is always a valid gesture). Share-restart is NEVER offered
// here — that stays with the existing ScreenShareErrorPanel (no duplicate CTA).

import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import type { AnomalyReason, RestorePreconditions } from "./examShell";

export function AnomalyPanel({ reasons, preconditions, onRestore, onEnterFullscreen }: {
  reasons: AnomalyReason[];
  preconditions: RestorePreconditions;
  onRestore: () => void;
  onEnterFullscreen: () => Promise<void>;
}) {
  const [fsError, setFsError] = useState("");
  const ready = preconditions.fullscreen && preconditions.visible && preconditions.recording;

  const pending: string[] = [];
  if (!preconditions.fullscreen) pending.push("Re-enter fullscreen.");
  if (!preconditions.visible) pending.push("Keep this exam tab visible.");
  if (!preconditions.recording) pending.push("Recording must be running — use the Try again / Resume button on this page to restart your screen share.");

  return (
    <div className="mb-5 rounded-lg border-2 border-danger bg-danger/10 p-5">
      <div className="flex items-start gap-3">
        <AlertTriangle size={24} className="mt-0.5 shrink-0 text-danger" />
        <div className="min-w-0 flex-1">
          <p className="text-base font-bold uppercase tracking-wide text-danger">Status bar hidden — anomaly detected</p>
          <ul className="mt-2 space-y-1 text-sm text-ink">
            {reasons.map((reason) => (
              <li key={reason.type}>
                <span className="font-medium">{reason.message}</span>{" "}
                <span className="font-mono text-xs text-muted">{new Date(reason.at).toLocaleTimeString()}</span>
              </li>
            ))}
          </ul>
          {!ready ? (
            <ul className="mt-3 list-inside list-disc text-sm text-danger">
              {pending.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-3">
            {!preconditions.fullscreen ? (
              <button
                className="focus-ring rounded-md bg-ink px-4 py-2 text-sm font-medium text-white"
                onClick={() => {
                  setFsError("");
                  void onEnterFullscreen().catch(() => setFsError("Your browser blocked fullscreen. Click again to retry."));
                }}
              >
                Re-enter fullscreen
              </button>
            ) : null}
            <button
              className="focus-ring rounded-md bg-danger px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!ready}
              onClick={onRestore}
            >
              I have fixed this — restore my status bar
            </button>
          </div>
          {fsError ? <p className="mt-2 text-sm text-danger">{fsError}</p> : null}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4.4: Full check**

Run: `cd /home/karthi/arogara/proctor/frontend && npx tsc --noEmit && npx vitest run && npm run build`
Expected: all clean.

- [ ] **Step 4.5: Commit**

```bash
cd /home/karthi/arogara/proctor
git add frontend/src/shell/ExamTopBar.tsx frontend/src/shell/FullscreenGate.tsx frontend/src/shell/AnomalyPanel.tsx
git commit -m "feat(shell): ExamTopBar, FullscreenGate, AnomalyPanel components (S1)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: ExamShellChrome + StudentApp wiring (App.tsx, types.ts)

**Files:**
- Create: `frontend/src/shell/ExamShellChrome.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/types.ts`

> All App.tsx anchors below were verified UNIQUE in the working tree at `352e094`. If another stretch item edited the same region first, re-anchor by the quoted landmark text, never by position. The CodingWorkspace render condition is NOT touched.

- [ ] **Step 5.1: ExamShellChrome**

```tsx
// frontend/src/shell/ExamShellChrome.tsx
//
// S1 §9 render structure, shared by EVERY StudentApp branch (gate screens
// included): ExamTopBar (or nothing while vanished/locked) → AnomalyPanel
// (while vanished) → one-line stage hint → FullscreenGate overlay → the
// branch's own content (rendered by StudentApp after this component).
// Bar presence semantics: bar = all good; NO bar = walk over.

import type { SessionStatus } from "../types";
import { stageHint, topBarVisible, type ShellGate } from "./examShell";
import { AnomalyPanel } from "./AnomalyPanel";
import { ExamTopBar } from "./ExamTopBar";
import { FullscreenGate } from "./FullscreenGate";
import type { ExamShellApi } from "./useExamShell";

export function ExamShellChrome({ shell, gate, status, identity, elapsedSeconds, examReleased, ownEditor }: {
  shell: ExamShellApi;
  gate: ShellGate;
  status: SessionStatus;
  identity: { name: string; username: string; room: string } | null;
  elapsedSeconds: number;
  examReleased: boolean;
  ownEditor: boolean;
}) {
  const barVisible = topBarVisible(shell.barHidden, gate);
  // While an anomaly episode is active the AnomalyPanel owns fullscreen
  // re-entry; the pre-recording gate overlay stays out of its way (§5.2).
  const gateVisible = !shell.fullscreen && shell.stage < 5 && !shell.barHidden;

  return (
    <>
      {barVisible ? (
        <ExamTopBar
          stage={shell.stage}
          identity={identity}
          elapsedSeconds={elapsedSeconds}
          recording={status === "recording" || status === "ending"}
          flagCount={shell.flagCount}
        />
      ) : null}
      {shell.barHidden ? (
        <AnomalyPanel
          reasons={shell.activeReasons}
          preconditions={shell.preconditions}
          onRestore={shell.restoreBar}
          onEnterFullscreen={shell.enterFullscreen}
        />
      ) : null}
      {barVisible ? (
        <p className="mb-5 text-sm leading-6 text-muted">
          {stageHint({ fullscreen: shell.fullscreen, gate, status, examReleased, ownEditor })}
        </p>
      ) : null}
      {gateVisible ? <FullscreenGate onEnter={shell.enterFullscreen} /> : null}
    </>
  );
}
```

- [ ] **Step 5.2: App.tsx — imports**

Find:
```typescript
import * as studentCopy from "./studentCopy";
```
insert AFTER it:
```typescript
import { topBarVisible } from "./shell/examShell";
import { ExamShellChrome } from "./shell/ExamShellChrome";
import { useExamShell } from "./shell/useExamShell";
```

- [ ] **Step 5.3: App.tsx — funnel tap + hook + shared chrome element**

Find (unique, inside `StudentApp`):
```typescript
  const addEvent = (event: ProctorEvent) => {
    setEvents((current) => [event, ...current].slice(0, 16));
  };
```
replace with:
```typescript
  // S1 exam shell: EVERY proctor event (recorder onEvent + createUiEvent call
  // sites) already flows through this single funnel, so the shell taps it here
  // for anomaly classification (spec §6). The ref breaks the definition cycle —
  // the shell hook itself emits events through addEvent.
  const shellTapRef = useRef<(event: ProctorEvent) => void>(() => undefined);
  const addEvent = (event: ProctorEvent) => {
    shellTapRef.current(event);
    setEvents((current) => [event, ...current].slice(0, 16));
  };

  // S1 exam shell: fullscreen truth, 1-5 stage, top-bar vanish/restore.
  // examReleased is the S3 room-gate seam — S3 has NOT landed at HEAD, so the
  // exam is always "released" (recording => stage 4 IN EXAM). When S3 lands,
  // its waiting-room release state replaces this constant.
  const shell = useExamShell({ gate, status, sessionId, examReleased: true, addEvent });
  shellTapRef.current = shell.onShellEvent;

  // The shared shell chrome — rendered FIRST inside <Shell> on every branch.
  const shellChrome = (
    <ExamShellChrome
      shell={shell}
      gate={gate}
      status={status}
      identity={identity}
      elapsedSeconds={elapsedSeconds}
      examReleased={true}
      ownEditor={OWN_EDITOR}
    />
  );
  // The fixed bar needs page top padding only while it is actually rendered.
  const shellPadTop = topBarVisible(shell.barHidden, gate);
```

- [ ] **Step 5.4: App.tsx — wrap all five StudentApp branches**

(a) Resuming spinner. Find:
```tsx
  if (resuming) {
    return (
      <Shell>
        <section className="mx-auto max-w-md rounded-lg border border-line bg-panel p-6 text-center shadow-subtle">
```
replace with:
```tsx
  if (resuming) {
    return (
      <Shell padTop={shellPadTop}>
        {shellChrome}
        <section className="mx-auto max-w-md rounded-lg border border-line bg-panel p-6 text-center shadow-subtle">
```

(b) Pending approval. Find:
```tsx
    return (
      <Shell>
        <StudentStepBanner gate={gate} status={status} />
        {identity ? <IdentityCard identity={identity} /> : null}
        <BlockedScreen
          tone="warning"
```
replace with:
```tsx
    return (
      <Shell padTop={shellPadTop}>
        {shellChrome}
        {identity ? <IdentityCard identity={identity} /> : null}
        <BlockedScreen
          tone="warning"
```

(c) Locked. Find:
```tsx
    return (
      <Shell>
        <StudentStepBanner gate={gate} status={status} />
        {identity ? <IdentityCard identity={identity} /> : null}
        <BlockedScreen
          tone="danger"
```
replace with:
```tsx
    return (
      <Shell padTop={shellPadTop}>
        {shellChrome}
        {identity ? <IdentityCard identity={identity} /> : null}
        <BlockedScreen
          tone="danger"
```

(d) Ended. Find:
```tsx
    return (
      <Shell>
        <StudentStepBanner gate="ended" status="ended" />
        {identity ? <IdentityCard identity={identity} /> : null}
```
replace with:
```tsx
    return (
      <Shell padTop={shellPadTop}>
        {shellChrome}
        {identity ? <IdentityCard identity={identity} /> : null}
```

(e) Main return. Find:
```tsx
  return (
    <Shell>
      <StudentStepBanner gate={gate} status={status} />
      {status === "recording" || status === "ending" ? (
        <TimerBar status={status} elapsedSeconds={elapsedSeconds} startIp={startIp} currentIp={currentIp} ipChanged={ipChanged} />
      ) : null}
      {identity && !isFormStage ? <IdentityCard identity={identity} /> : null}
```
replace with:
```tsx
  return (
    <Shell padTop={shellPadTop}>
      {shellChrome}
      {identity && !isFormStage ? <IdentityCard identity={identity} /> : null}
```

- [ ] **Step 5.5: App.tsx — Shell gains `padTop` (AdminApp untouched: default false)**

Find:
```tsx
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-paper px-4 py-5 text-ink md:px-8">
```
replace with:
```tsx
// padTop: StudentApp sets it while the fixed S1 ExamTopBar (64px) is rendered,
// so the header/content start below the bar. AdminApp never passes it.
function Shell({ children, padTop = false }: { children: React.ReactNode; padTop?: boolean }) {
  return (
    <main className={`min-h-screen bg-paper px-4 py-5 text-ink md:px-8 ${padTop ? "pt-20" : ""}`}>
```

- [ ] **Step 5.6: App.tsx — delete the superseded components**

Delete these three blocks ENTIRELY (each from the quoted signature line through its closing `}` — spec §7.4 consolidation):

1. The `StudentStepBanner` function (starts `function StudentStepBanner({ gate, status }: { gate: StudentGate; status: SessionStatus }) {`, including the `// Guided step indicator (Epic 3): ...` comment above it).
2. The `TimerBar` function (starts `function TimerBar({ status, elapsedSeconds, startIp, currentIp, ipChanged }: ...`).
3. The `formatElapsed` function (starts `function formatElapsed(totalSeconds: number) {`) — its ONLY caller was TimerBar (verified); the shell has its own tested `formatExamElapsed`.

- [ ] **Step 5.7: App.tsx — IP diagnostics move into HealthPanel (spec §7.4)**

Find the HealthPanel call site:
```tsx
              <HealthPanel status={status} sessionId={sessionId} config={sessionConfig} queueDepth={queueDepth} uploadedCount={uploadedCount} manifest={manifest} mediaCapture={mediaCapture} />
```
replace with:
```tsx
              <HealthPanel status={status} sessionId={sessionId} config={sessionConfig} queueDepth={queueDepth} uploadedCount={uploadedCount} manifest={manifest} mediaCapture={mediaCapture} startIp={startIp} currentIp={currentIp} ipChanged={ipChanged} />
```

Find the HealthPanel signature:
```tsx
function HealthPanel({ status, sessionId, config, queueDepth, uploadedCount, manifest, mediaCapture }: { status: SessionStatus; sessionId: string; config: SessionStartResponse | null; queueDepth: number; uploadedCount: number; manifest: UploadManifestItem[]; mediaCapture: MediaCaptureState }) {
```
replace with:
```tsx
// startIp/currentIp moved here from the deleted TimerBar (S1): close-up
// diagnostics, not at-a-distance content. The ip-changed red treatment is
// superseded by the shell's anomaly flow (ip_address_changed vanishes the bar).
function HealthPanel({ status, sessionId, config, queueDepth, uploadedCount, manifest, mediaCapture, startIp, currentIp, ipChanged }: { status: SessionStatus; sessionId: string; config: SessionStartResponse | null; queueDepth: number; uploadedCount: number; manifest: UploadManifestItem[]; mediaCapture: MediaCaptureState; startIp: string; currentIp: string; ipChanged: boolean }) {
```

Find (unique):
```tsx
        <Metric icon={<ClipboardList size={16} />} label="Manifest items" value={String(manifest.length)} />
```
insert AFTER it:
```tsx
        <Metric icon={<Activity size={16} />} label="Start IP" value={startIp || "pending"} />
        <Metric icon={<Activity size={16} />} label="Current IP" value={`${currentIp || startIp || "pending"}${ipChanged ? " (changed)" : ""}`} />
```
(`Activity` is already imported from lucide-react.)

- [ ] **Step 5.8: types.ts — document the new event-type strings**

Find:
```typescript
export type ProctorEvent = {
```
insert ABOVE it:
```typescript
// Event `type` is an open string (the backend stores arbitrary types). S1
// exam-shell client-emitted types riding this same pipeline:
//   "fullscreen_enter" | "fullscreen_exit" (detail.expected=true at test end)
//   "onboarding_stage" ({from,to,label}) | "topbar_hidden" | "topbar_restored".
```

- [ ] **Step 5.9: Full check**

Run: `cd /home/karthi/arogara/proctor/frontend && npx tsc --noEmit && npx vitest run && npm run build`
Expected: all clean — tsc proves the deleted components left no dangling references; the 59 shell tests + all coding/ tests stay green.

- [ ] **Step 5.10: Commit**

```bash
cd /home/karthi/arogara/proctor
git add frontend/src/shell/ExamShellChrome.tsx frontend/src/App.tsx frontend/src/types.ts
git commit -m "feat(student): exam shell wired into StudentApp — fullscreen-first gate + 5-stage bar replaces StudentStepBanner/TimerBar (S1)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6: Demo-mode browser verification on :9222

**Files:** none modified (fixes, if any, get their own commits).

- [ ] **Step 6.1: Full test pass**

```bash
cd /home/karthi/arogara/proctor/frontend && npx tsc --noEmit && npx vitest run && npm run build
```
(No backend change in S1 — `node --test` untouched, but running it costs nothing if other lanes touched backend tonight: `cd /home/karthi/arogara/proctor/backend && node --test test/*.test.mjs`.)

- [ ] **Step 6.2: Run the app in demo mode** (background it; URL typically http://localhost:5173)

```bash
cd /home/karthi/arogara/proctor/frontend && VITE_DEMO_MODE=true npm run dev
```

- [ ] **Step 6.3: Prepare the :9222 page with BOTH init scripts**

Use the chrome-devtools MCP against the debug browser on :9222. Before loading the app, install two scripts (via `evaluate_script` immediately after navigation, before interacting — or CDP `Page.addScriptToEvaluateOnNewDocument` if available):

**(a) Fake getDisplayMedia** — same demo-only technique as the Slice 1 smoke (NIGHT-LOG 00:15: "fake getDisplayMedia monitor stream via initScript — picker can't render in remote browser"). The recorder requires `displaySurface: "monitor"`:

```javascript
(() => {
  const canvas = document.createElement("canvas");
  canvas.width = 1280; canvas.height = 720;
  const ctx = canvas.getContext("2d");
  setInterval(() => { ctx.fillStyle = "#123456"; ctx.fillRect(0, 0, 1280, 720); }, 500);
  const stream = canvas.captureStream(5);
  const track = stream.getVideoTracks()[0];
  track.getSettings = () => ({ displaySurface: "monitor", width: 1280, height: 720, frameRate: 5 });
  navigator.mediaDevices.getDisplayMedia = async () => stream;
})();
```

**(b) Fullscreen stub** — CDP clicks are trusted gestures so real `requestFullscreen` usually resolves, but a remote/headless harness may not HOLD fullscreen; if stage 1 reappears spontaneously, stub it (demo-only, no product change — spec §11 sanctions this):

```javascript
(() => {
  let fake = false;
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    get: () => (fake ? document.documentElement : null)
  });
  Element.prototype.requestFullscreen = function () {
    fake = true; document.dispatchEvent(new Event("fullscreenchange")); return Promise.resolve();
  };
  document.exitFullscreen = () => {
    fake = false; document.dispatchEvent(new Event("fullscreenchange")); return Promise.resolve();
  };
  window.__setFullscreen = (v) => { fake = v; document.dispatchEvent(new Event("fullscreenchange")); };
})();
```

- [ ] **Step 6.4: Drive the full flow — screenshot at EVERY numbered point** (evidence → `night-run/evidence/s1-*.png`; inspect each screenshot yourself before counting it as done):

1. **Gate (stage 1):** open `http://localhost:5173/` → dark FullscreenGate overlay ("This is a proctored exam", one button) with the red **1 FULLSCREEN** bar fixed above it, "Not signed in" center, wall clock right. Take TWO screenshots ~2s apart and confirm the clock TICKED.
2. **Enter fullscreen (stage 2):** click "Enter fullscreen to begin" → overlay clears, PreStartRules + details form visible, bar flips to amber **2 DETAILS**, hint line under the bar reads the details/consent instruction.
3. **Start (stage 3→4):** fill the five fields, tick consent, click "Start proctoring" → with the fake share the recorder starts → bar flips to emerald **4 IN EXAM**; center shows name + username + Room; right shows pulsing REC dot + elapsed `0:00:0x` ticking + small wall clock. The Slice 1 CodingWorkspace (Sum of Two Numbers + Monaco) renders below, NOT overlapped by the fixed bar; HealthPanel sidebar now shows the Start IP / Current IP rows.
4. **Anomaly — bar vanishes:** `evaluate_script`: `window.dispatchEvent(new Event("blur"))` → the bar UNMOUNTS (plain page top, no red strip) and the red AnomalyPanel appears: "You switched to another window or application." + timestamp. Restore button is ENABLED (blur breaks no precondition).
5. **Stacked reason + precondition gating:** `evaluate_script`: `window.__setFullscreen(false)` (or press ESC if real fullscreen) → panel now ALSO lists "You left fullscreen.", restore button DISABLED, "Re-enter fullscreen" button + pending-list shown. Confirm NO FullscreenGate overlay (the panel owns re-entry during an episode).
6. **Restore:** click "Re-enter fullscreen" → restore button enables → click "I have fixed this — restore my status bar" → bar remounts: emerald **4 IN EXAM** now carrying the red **⚑ 1** chip.
7. **Event audit:** "Recent proctor events" list shows `fullscreen_enter`, `fullscreen_exit`, `topbar_hidden`, `topbar_restored`, and `onboarding_stage` entries among the recorder events.
8. **Second episode count:** repeat the blur → panel → restore cycle once → chip reads **⚑ 2**.
9. **End (stage 5):** End test → tick the assurance → "End and close session" → ended screen with indigo **5 DONE** bar (chip still **⚑ 2**), fullscreen exited (`window.__setFullscreen` stub: confirm `document.fullscreenElement` is null via evaluate), and NO gate overlay on the ended screen.
10. **Pre-recording exit is NOT an anomaly:** fresh page (clear `localStorage` key `aerele-proctor-session-id`, reload, re-install stubs) → enter fullscreen → at the form (stage 2) type a name → `window.__setFullscreen(false)` → the GATE overlay returns (stage 1 red bar, no AnomalyPanel, no flag) → re-enter → form still shows the typed name (state preserved).

- [ ] **Step 6.5: Record results**

Append the S1 outcome (what passed, screenshots taken, any deviations + judgment calls) to `night-run/NIGHT-LOG.md` and `night-run/MORNING-NOTES.md` §1/§2, then commit:

```bash
cd /home/karthi/arogara/proctor
git add night-run/NIGHT-LOG.md night-run/MORNING-NOTES.md night-run/evidence
git commit -m "S1: record exam-shell build + browser verification results in night-run notes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Verification summary (done bar)

- [ ] `frontend: npx vitest run` — 60 shell tests green, coding/ suites untouched and green.
- [ ] `frontend: npx tsc --noEmit` + `npm run build` — clean.
- [ ] Demo-mode :9222 flow (Step 6.4, all 10 points) verified with screenshots, each visually inspected.
- [ ] CodingWorkspace render condition (`SLICE1_PROBLEM && sessionId && status === "recording"`) byte-identical to HEAD.
- [ ] Zero backend diffs (`git diff master -- backend/` empty for S1 commits).
- [ ] All commits LOCAL; **nothing pushed**.

## Open items already flagged for morning review (spec §13 — do NOT resolve tonight)

Recording-before-identity deferral; self-serve restore vs invigilator restore; `ip_address_changed` + `integrity_checkpoint_missed` in the vanish set; `clipboard_activity` excluded; StudentStepBanner/TimerBar consolidation; `fullscreen_exit` as a backend sure-shot alert type.
