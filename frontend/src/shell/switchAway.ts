// frontend/src/shell/switchAway.ts
//
// F5.4 — switch-away DEBOUNCE: pure episode reducer. Repeated window_blur /
// visibility_change(hidden) signals within a rolling window collapse into ONE
// episode; when the window passes with no further away signal the episode
// closes and the caller emits a single `switch_away_episode` event carrying
// {count, duration_ms}. The backend's tab_away alerting (threshold-based,
// admin-configurable) decides whether the episode is alert-worthy — the client
// NEVER blocks on switch-away (explicit F5.4 decision: proctor reviews video,
// then acts).

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
};

export const initialSwitchAwayState: SwitchAwayState = {
  episodeStartMs: null,
  lastAwayMs: null,
  lastSeenMs: null,
  count: 0
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

function closeEpisode(state: SwitchAwayState): SwitchAwayEpisode | null {
  if (state.episodeStartMs == null) return null;
  const end = Math.max(state.lastSeenMs ?? state.episodeStartMs, state.episodeStartMs);
  return { count: state.count, duration_ms: end - state.episodeStartMs };
}

export function switchAwayReducer(state: SwitchAwayState, action: SwitchAwayAction): SwitchAwayResult {
  const open = state.episodeStartMs != null;
  const windowPassed = open && state.lastAwayMs != null && action.nowMs - state.lastAwayMs > SWITCH_AWAY_WINDOW_MS;

  if (action.kind === "away") {
    if (open && !windowPassed) {
      // Same episode: extend the rolling window.
      return { state: { ...state, lastAwayMs: action.nowMs, lastSeenMs: action.nowMs, count: state.count + 1 }, episode: null };
    }
    // Window passed (or no episode): close any previous episode, open a new one.
    return {
      state: { episodeStartMs: action.nowMs, lastAwayMs: action.nowMs, lastSeenMs: action.nowMs, count: 1 },
      episode: windowPassed ? closeEpisode(state) : null
    };
  }

  if (action.kind === "back") {
    if (!open) return { state, episode: null };
    return { state: { ...state, lastSeenMs: action.nowMs }, episode: null };
  }

  // tick / flush
  if (!open) return { state, episode: null };
  if (action.kind === "tick" && !windowPassed) return { state, episode: null };
  return { state: initialSwitchAwayState, episode: closeEpisode(state) };
}
