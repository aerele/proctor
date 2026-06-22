// frontend/src/shell/devtoolsDetect.ts
//
// P1 (v1.1 anti-cheat, decision 2489) — DevTools / Inspect detection.
//
// ⚠️ HONEST about the model (read this before trusting it): there is NO reliable,
// bypass-proof way to detect DevTools from a web page. Every technique here is a
// HEURISTIC and every one is EVADABLE (undocked/detached DevTools, remote
// debugging, a patched console, disabling the timing check, etc.). The decision
// (internal design notes) acknowledges this: "Honest answer: no 100%
// reliable API; heuristics exist … all evadable. Implement best-effort + log."
//
// So the contract is: on a POSITIVE signal we LOG it (telemetry) and WARN the
// candidate to close DevTools to continue — we do NOT hard-block (a false
// positive must never trap an honest candidate behind an unclearable wall), and
// we do NOT claim this is tamper-proof anywhere in the UI or the comments.
//
// Three independent heuristics, combined (any one firing = "open"):
//   1. Window outer/inner-size delta — DOCKED DevTools shrinks the viewport
//      relative to the window by more than the chrome/scrollbar baseline. Misses
//      undocked DevTools entirely (separate window → no delta). Cheap, passive.
//   2. console getter trick — logging an object whose `id` getter fires only
//      when the console panel actually renders it. Fires for an OPEN console.
//      Evadable; some browsers render lazily.
//   3. debugger-timing — a `debugger;` statement pauses ~instantly when DevTools
//      is open; we measure the wall-clock around it. OPT-IN only (it freezes the
//      tab when DevTools IS open, which is jarring) — off by default.
//
// This module is split PURE (the size-delta decision, the state machine for
// edge-triggered logging) from the live `window`/`console` glue so the decision
// logic is unit-tested.

export type DevtoolsSignal = "size_delta" | "console_getter" | "debugger_timing";

export type DevtoolsProbeInput = {
  outerWidth: number;
  innerWidth: number;
  outerHeight: number;
  innerHeight: number;
};

// The docked-DevTools size-delta threshold. A docked panel steals ≥ ~100px from
// the viewport on the docked axis. Normal browser chrome + scrollbars are well
// under this, so the threshold avoids false positives from a thin scrollbar.
// Tunable; intentionally conservative (prefer a miss over a false alarm — the
// honest candidate must not be nagged). devicePixelRatio is NOT factored in
// because outer/inner are in the same CSS-pixel space.
export const DEVTOOLS_SIZE_DELTA_PX = 160;

/**
 * PURE: the docked-DevTools size-delta heuristic. True when the window/viewport
 * gap on EITHER axis exceeds the threshold. Guards against bogus zero/negative
 * dimensions (some embeddings report 0 outer size) which would false-positive.
 */
export function sizeDeltaSuggestsDevtools(
  input: DevtoolsProbeInput,
  thresholdPx: number = DEVTOOLS_SIZE_DELTA_PX
): boolean {
  const { outerWidth, innerWidth, outerHeight, innerHeight } = input;
  // Ignore implausible measurements (0 / negative) — they are not evidence.
  if (outerWidth <= 0 || innerWidth <= 0 || outerHeight <= 0 || innerHeight <= 0) return false;
  const widthDelta = outerWidth - innerWidth;
  const heightDelta = outerHeight - innerHeight;
  return widthDelta > thresholdPx || heightDelta > thresholdPx;
}

// ---- edge-triggered logging state machine (PURE) -----------------------------
//
// We must LOG a DevTools open ONCE per open episode (telemetry, not a flood), and
// warn while it stays open. This pure reducer turns a stream of boolean "is
// currently open" samples into the discrete EVENTS the caller acts on:
//   - opened: the rising edge → log telemetry + show the warning
//   - closed: the falling edge → clear the warning
//   - unchanged: no action
export type DevtoolsWatchState = { open: boolean };

export type DevtoolsTransition = "opened" | "closed" | "unchanged";

export function devtoolsTransition(prev: DevtoolsWatchState, currentlyOpen: boolean): {
  next: DevtoolsWatchState;
  transition: DevtoolsTransition;
} {
  if (currentlyOpen && !prev.open) return { next: { open: true }, transition: "opened" };
  if (!currentlyOpen && prev.open) return { next: { open: false }, transition: "closed" };
  return { next: prev, transition: "unchanged" };
}

export const DEVTOOLS_WARNING_MESSAGE =
  "Developer Tools (Inspect) appear to be open. Close them to continue — this is recorded for the proctor. Using the browser's developer/inspect tools during the test is not allowed.";

// ---- live glue (best-effort; not unit-tested) --------------------------------

// Heuristic 1: live size-delta read off the real window.
export function liveSizeDeltaOpen(win: Window = window, thresholdPx: number = DEVTOOLS_SIZE_DELTA_PX): boolean {
  return sizeDeltaSuggestsDevtools(
    {
      outerWidth: win.outerWidth,
      innerWidth: win.innerWidth,
      outerHeight: win.outerHeight,
      innerHeight: win.innerHeight
    },
    thresholdPx
  );
}

// Heuristic 2: the console-getter trick. When the console panel is OPEN and
// renders a logged object, reading its `id` getter fires our callback. We log a
// throwaway object and clear the console so this leaves no candidate-visible
// noise. Returns true if the getter fired (console was rendering). Best-effort:
// some browsers render the console lazily (only when focused), so a miss is
// common — this is one signal of three, never the sole gate.
export function consoleGetterOpen(consoleObj: Console = console): boolean {
  let fired = false;
  const bait: Record<string, unknown> = {};
  Object.defineProperty(bait, "id", {
    get() {
      fired = true;
      return "";
    },
    configurable: true
  });
  try {
    // table/log force the console to inspect the object's properties if a panel
    // is actively rendering it.
    consoleObj.log(bait);
    // Clearing keeps the candidate console clean; ignore if unavailable.
    if (typeof (consoleObj as Console).clear === "function") consoleObj.clear();
  } catch {
    /* console may be locked down; treat as no-signal */
  }
  return fired;
}

// Heuristic 3 (OPT-IN): debugger-timing. With DevTools open, a `debugger;`
// statement pauses execution; the wall-clock across it spikes. We DON'T enable
// this by default — it FREEZES the tab whenever DevTools is open, which is a
// terrible experience for the (logged) candidate we are only WARNING. Exposed so
// the integration can opt in if Karthi wants a stronger-but-jarring signal.
//
// Implemented with a literal `debugger` statement (NOT new Function/eval — no
// dynamic code, no injection surface, CSP-safe). When DevTools is closed the
// statement is a no-op and the elapsed time stays near zero.
export function debuggerTimingOpen(thresholdMs = 100): boolean {
  const start = performance.now();
  // eslint-disable-next-line no-debugger
  debugger;
  return performance.now() - start > thresholdMs;
}

// Combine the two NON-freezing heuristics into a single "currently open" sample.
// (debugger-timing is excluded here by default — opt-in only.)
export function sampleDevtoolsOpen(win: Window = window, consoleObj: Console = console): boolean {
  // Size-delta is the cheap first pass; the console getter is the corroborator.
  return liveSizeDeltaOpen(win) || consoleGetterOpen(consoleObj);
}
