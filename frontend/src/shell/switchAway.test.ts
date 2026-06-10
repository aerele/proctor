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

  it("repeated away/back excursions inside the rolling window collapse into ONE episode", () => {
    let state = switchAwayReducer(initialSwitchAwayState, { kind: "away", nowMs: T0 }).state;
    state = switchAwayReducer(state, { kind: "back", nowMs: T0 + 5_000 }).state;
    state = switchAwayReducer(state, { kind: "away", nowMs: T0 + 10_000 }).state;
    state = switchAwayReducer(state, { kind: "back", nowMs: T0 + 20_000 }).state;
    const third = switchAwayReducer(state, { kind: "away", nowMs: T0 + 25_000 });
    expect(third.episode).toBe(null);
    expect(third.state.count).toBe(3);
    expect(third.state.episodeStartMs).toBe(T0);
  });

  // Wave-3 fix: ONE tab switch fires BOTH window_blur and visibility_change
  // (hidden). The pair must count as ONE excursion — double-counting meant the
  // backend's frequent-switch trigger (3) tripped on just 2 real switches.
  it("a blur+hidden pair from a single tab switch counts ONE excursion (count stays 1)", () => {
    let state = switchAwayReducer(initialSwitchAwayState, { kind: "away", nowMs: T0 }).state; // window_blur
    state = switchAwayReducer(state, { kind: "away", nowMs: T0 + 20 }).state; // visibility hidden
    expect(state.count).toBe(1);
    expect(state.episodeStartMs).toBe(T0);
  });

  it("an away AFTER a return marker is a NEW excursion (count 2); the raw signal pairs stay deduped", () => {
    let state = switchAwayReducer(initialSwitchAwayState, { kind: "away", nowMs: T0 }).state;
    state = switchAwayReducer(state, { kind: "away", nowMs: T0 + 20 }).state;
    state = switchAwayReducer(state, { kind: "back", nowMs: T0 + 5_000 }).state; // visible
    state = switchAwayReducer(state, { kind: "back", nowMs: T0 + 5_020 }).state; // focus
    state = switchAwayReducer(state, { kind: "away", nowMs: T0 + 10_000 }).state;
    state = switchAwayReducer(state, { kind: "away", nowMs: T0 + 10_020 }).state;
    expect(state.count).toBe(2);
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
    state = switchAwayReducer(state, { kind: "back", nowMs: T0 + 4_000 }).state;
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

  // Wave-2 review fix: an away-only episode (the candidate NEVER returned) used
  // to close with duration ≈ 0 because the duration anchored at the blur
  // instant — the single prolonged switch-away, F5.4's primary target, produced
  // no tab_away alert at all. Still-away episodes now report up to close time.
  it("an away-only episode closed by the window tick reports the FULL away duration", () => {
    const open = switchAwayReducer(initialSwitchAwayState, { kind: "away", nowMs: T0 }).state;
    const closed = switchAwayReducer(open, { kind: "tick", nowMs: T0 + SWITCH_AWAY_WINDOW_MS + 1_000 });
    expect(closed.episode).toEqual({ count: 1, duration_ms: SWITCH_AWAY_WINDOW_MS + 1_000 });
    expect(closed.state).toEqual(initialSwitchAwayState);
  });

  it("an away-only episode flushed early reports up to the flush instant", () => {
    const open = switchAwayReducer(initialSwitchAwayState, { kind: "away", nowMs: T0 }).state;
    const flushed = switchAwayReducer(open, { kind: "flush", nowMs: T0 + 7_500 });
    expect(flushed.episode).toEqual({ count: 1, duration_ms: 7_500 });
  });

  it("an away→back episode still anchors duration at the RETURN time, not the close time", () => {
    let state = switchAwayReducer(initialSwitchAwayState, { kind: "away", nowMs: T0 }).state;
    state = switchAwayReducer(state, { kind: "back", nowMs: T0 + 4_000 }).state;
    const closed = switchAwayReducer(state, { kind: "tick", nowMs: T0 + SWITCH_AWAY_WINDOW_MS + 5_000 });
    expect(closed.episode).toEqual({ count: 1, duration_ms: 4_000 });
  });

  it("a new away past the window closes a STILL-AWAY previous episode at the new away instant", () => {
    const open = switchAwayReducer(initialSwitchAwayState, { kind: "away", nowMs: T0 }).state;
    const next = switchAwayReducer(open, { kind: "away", nowMs: T0 + SWITCH_AWAY_WINDOW_MS + 9_000 });
    expect(next.episode).toEqual({ count: 1, duration_ms: SWITCH_AWAY_WINDOW_MS + 9_000 });
    expect(next.state.episodeStartMs).toBe(T0 + SWITCH_AWAY_WINDOW_MS + 9_000);
  });

  it("back signals without an open episode are ignored", () => {
    const { state, episode } = switchAwayReducer(initialSwitchAwayState, { kind: "back", nowMs: T0 });
    expect(state).toBe(initialSwitchAwayState);
    expect(episode).toBe(null);
  });
});
