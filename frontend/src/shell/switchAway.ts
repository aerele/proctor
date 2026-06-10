// frontend/src/shell/switchAway.ts
//
// F5.4 — switch-away DEBOUNCE: pure episode reducer. Repeated window_blur /
// visibility_change(hidden) signals within a rolling window collapse into ONE
// episode; when the window passes with no further away signal the episode
// closes and the caller emits a single `switch_away_episode` event carrying
// {count, duration_ms}. `count` is the number of DISTINCT excursions
// (not-away → away transitions), not raw signals — one tab switch fires both
// window_blur and visibility_change(hidden), and double-counting the pair
// made 2 real switches trip the backend's frequent-switch trigger of 3
// (wave-3 fix; the raw events still flow to evidence individually). The
// backend's tab_away alerting (threshold-based, admin-configurable) decides
// whether the episode is alert-worthy — the client NEVER blocks on
// switch-away (explicit F5.4 decision: proctor reviews video, then acts).

import type { ProctorEvent } from "../types";

export const SWITCH_AWAY_WINDOW_MS = 30_000;

export type SwitchAwayState = {
  episodeStartMs: number | null;
  // Last away signal — the rolling window anchors here.
  lastAwayMs: number | null;
  // Last activity incl. return markers (focus/visible) — duration anchors here
  // so "blurred at T, came back at T+12s" reports ~12s even though blur is an
  // instant.
  lastSeenMs: number | null;
  count: number;
  // Wave-2 review fix: still away (no return marker since the last away
  // signal). An away-only episode must report its duration up to the CLOSE
  // time, not the blur instant — the candidate who leaves and never returns is
  // F5.4's primary target and used to close with duration ≈ 0 (no alert).
  away: boolean;
};

export const initialSwitchAwayState: SwitchAwayState = {
  episodeStartMs: null,
  lastAwayMs: null,
  lastSeenMs: null,
  count: 0,
  away: false
};

export type SwitchAwayEpisode = { count: number; duration_ms: number };

export type SwitchAwayAction =
  | { kind: "away"; nowMs: number }
  | { kind: "back"; nowMs: number }
  | { kind: "tick"; nowMs: number }
  | { kind: "flush"; nowMs: number };

export type SwitchAwayResult = { state: SwitchAwayState; episode: SwitchAwayEpisode | null };

// Classify a proctor event as an away signal, a return marker, or unrelated.
export function isSwitchAwaySignal(event: ProctorEvent): "away" | "back" | null {
  if (event.type === "window_blur") return "away";
  if (event.type === "window_focus") return "back";
  if (event.type === "visibility_change") {
    return event.detail?.state === "hidden" ? "away" : "back";
  }
  return null;
}

// Close at `nowMs`: a STILL-AWAY episode (no return marker after the last away
// signal) extends to the close instant — that is the real away span for the
// candidate who never came back. A returned episode anchors at the return time.
function closeEpisode(state: SwitchAwayState, nowMs: number): SwitchAwayEpisode | null {
  if (state.episodeStartMs == null) return null;
  const end = state.away
    ? Math.max(nowMs, state.episodeStartMs)
    : Math.max(state.lastSeenMs ?? state.episodeStartMs, state.episodeStartMs);
  return { count: state.count, duration_ms: end - state.episodeStartMs };
}

export function switchAwayReducer(state: SwitchAwayState, action: SwitchAwayAction): SwitchAwayResult {
  const open = state.episodeStartMs != null;
  const windowPassed = open && state.lastAwayMs != null && action.nowMs - state.lastAwayMs > SWITCH_AWAY_WINDOW_MS;

  if (action.kind === "away") {
    if (open && !windowPassed) {
      // Same episode: extend the rolling window. Wave-3 fix: an away signal
      // while STILL AWAY is the same excursion — one tab switch fires BOTH
      // window_blur and visibility_change(hidden), and double-counting the
      // pair made 2 real switches look like the backend's frequent-switch
      // trigger (3). Count only not-away → away transitions.
      return {
        state: { ...state, lastAwayMs: action.nowMs, lastSeenMs: action.nowMs, count: state.away ? state.count : state.count + 1, away: true },
        episode: null
      };
    }
    // Window passed (or no episode): close any previous episode, open a new one.
    return {
      state: { episodeStartMs: action.nowMs, lastAwayMs: action.nowMs, lastSeenMs: action.nowMs, count: 1, away: true },
      episode: windowPassed ? closeEpisode(state, action.nowMs) : null
    };
  }

  if (action.kind === "back") {
    if (!open) return { state, episode: null };
    return { state: { ...state, lastSeenMs: action.nowMs, away: false }, episode: null };
  }

  // tick / flush
  if (!open) return { state, episode: null };
  if (action.kind === "tick" && !windowPassed) return { state, episode: null };
  return { state: initialSwitchAwayState, episode: closeEpisode(state, action.nowMs) };
}
