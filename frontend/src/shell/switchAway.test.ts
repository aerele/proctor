// frontend/src/shell/switchAway.test.ts
//
// F5.4 — switch-away DEBOUNCE (pure reducer). Repeated window_blur /
// visibility_change(hidden) within a rolling 30 s window collapse into ONE
// episode; the episode closes (and emits a single switch_away_episode event
// with count + duration detail) only after the window passes with no further
// away signal. NEVER blocks — emission only.
import { describe, it, expect } from "vitest";
import {
  SWITCH_AWAY_WINDOW_MS,
  initialSwitchAwayState,
  switchAwayReducer,
  isSwitchAwaySignal
} from "./switchAway";

const T0 = 5_000_000;

describe("isSwitchAwaySignal", () => {
  it("window_blur and visibility hidden count as away; focus/visible do not", () => {
    expect(isSwitchAwaySignal({ type: "window_blur", timestamp: "t" })).toBe("away");
    expect(isSwitchAwaySignal({ type: "visibility_change", timestamp: "t", detail: { state: "hidden" } })).toBe("away");
    expect(isSwitchAwaySignal({ type: "visibility_change", timestamp: "t", detail: { state: "visible" } })).toBe("back");
    expect(isSwitchAwaySignal({ type: "window_focus", timestamp: "t" })).toBe("back");
    expect(isSwitchAwaySignal({ type: "clipboard_activity", timestamp: "t" })).toBe(null);
  });
});

describe("switchAwayReducer — episode debounce", () => {
  it("first away signal opens an episode, no emission yet", () => {
    const { state, episode } = switchAwayReducer(initialSwitchAwayState, { kind: "away", nowMs: T0 });
    expect(state.episodeStartMs).toBe(T0);
    expect(state.count).toBe(1);
    expect(episode).toBe(null);
  });

  it("repeated away signals inside the rolling window collapse into ONE episode", () => {
    let state = switchAwayReducer(initialSwitchAwayState, { kind: "away", nowMs: T0 }).state;
    state = switchAwayReducer(state, { kind: "away", nowMs: T0 + 10_000 }).state;
    const third = switchAwayReducer(state, { kind: "away", nowMs: T0 + 25_000 });
    expect(third.episode).toBe(null);
    expect(third.state.count).toBe(3);
    expect(third.state.episodeStartMs).toBe(T0);
  });

  it("an away signal AFTER the window closes the previous episode and opens a new one", () => {
    let state = switchAwayReducer(initialSwitchAwayState, { kind: "away", nowMs: T0 }).state;
    state = switchAwayReducer(state, { kind: "back", nowMs: T0 + 2_000 }).state;
    const next = switchAwayReducer(state, { kind: "away", nowMs: T0 + SWITCH_AWAY_WINDOW_MS + 1 });
    expect(next.episode).toEqual({ count: 1, duration_ms: 2_000 });
    expect(next.state.count).toBe(1);
    expect(next.state.episodeStartMs).toBe(T0 + SWITCH_AWAY_WINDOW_MS + 1);
  });

  it("tick past the window closes the episode with count + duration", () => {
    let state = switchAwayReducer(initialSwitchAwayState, { kind: "away", nowMs: T0 }).state;
    state = switchAwayReducer(state, { kind: "away", nowMs: T0 + 8_000 }).state;
    state = switchAwayReducer(state, { kind: "back", nowMs: T0 + 12_000 }).state;
    const closed = switchAwayReducer(state, { kind: "tick", nowMs: T0 + 8_000 + SWITCH_AWAY_WINDOW_MS + 1 });
    expect(closed.episode).toEqual({ count: 2, duration_ms: 12_000 });
    expect(closed.state).toEqual(initialSwitchAwayState);
  });

  it("tick inside the window keeps the episode open", () => {
    const open = switchAwayReducer(initialSwitchAwayState, { kind: "away", nowMs: T0 }).state;
    const ticked = switchAwayReducer(open, { kind: "tick", nowMs: T0 + 10_000 });
    expect(ticked.episode).toBe(null);
    expect(ticked.state).toBe(open);
  });

  it("tick with no open episode is a no-op", () => {
    const ticked = switchAwayReducer(initialSwitchAwayState, { kind: "tick", nowMs: T0 });
    expect(ticked.episode).toBe(null);
    expect(ticked.state).toBe(initialSwitchAwayState);
  });

  it("flush (session end / recording stop) closes an open episode immediately", () => {
    let state = switchAwayReducer(initialSwitchAwayState, { kind: "away", nowMs: T0 }).state;
    state = switchAwayReducer(state, { kind: "back", nowMs: T0 + 3_000 }).state;
    const flushed = switchAwayReducer(state, { kind: "flush", nowMs: T0 + 5_000 });
    expect(flushed.episode).toEqual({ count: 1, duration_ms: 3_000 });
    expect(flushed.state).toEqual(initialSwitchAwayState);
  });

  it("duration never goes below the away-instant itself (no return marker)", () => {
    const open = switchAwayReducer(initialSwitchAwayState, { kind: "away", nowMs: T0 }).state;
    const flushed = switchAwayReducer(open, { kind: "flush", nowMs: T0 + 100 });
    expect(flushed.episode).toEqual({ count: 1, duration_ms: 0 });
  });

  it("back signals without an open episode are ignored", () => {
    const { state, episode } = switchAwayReducer(initialSwitchAwayState, { kind: "back", nowMs: T0 });
    expect(state).toBe(initialSwitchAwayState);
    expect(episode).toBe(null);
  });
});
