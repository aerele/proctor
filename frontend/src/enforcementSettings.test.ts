// frontend/src/enforcementSettings.test.ts
//
// Wave-3 fix: the Settings form bound the fullscreen-enforcement number fields
// through Number(value), so CLEARING a field silently saved 0 — for the exit
// limit the HARSHEST possible setting (first exit locks), persisted without the
// admin ever typing it (the backend's minimum is 0, so nothing corrected it).
// Blank/invalid text now maps to the DEFAULTS at save time, floor 1 — the same
// rule as cameraRecordingFromForm (the wave-2 blank-saves-0 finding).
import { describe, it, expect } from "vitest";
import {
  FULLSCREEN_EXIT_LIMIT_DEFAULT,
  FULLSCREEN_REENTRY_DEFAULT_SECONDS,
  enforcementSettingsFromForm
} from "./enforcementSettings";

describe("enforcementSettingsFromForm", () => {
  it("valid integers pass through", () => {
    expect(enforcementSettingsFromForm({ reentrySeconds: "30", exitLimit: "5" })).toEqual({
      fullscreen_reentry_seconds: 30,
      fullscreen_exit_limit: 5
    });
  });

  it("a CLEARED field saves the default, never 0 (the silent-harshest hazard)", () => {
    expect(enforcementSettingsFromForm({ reentrySeconds: "", exitLimit: "" })).toEqual({
      fullscreen_reentry_seconds: FULLSCREEN_REENTRY_DEFAULT_SECONDS,
      fullscreen_exit_limit: FULLSCREEN_EXIT_LIMIT_DEFAULT
    });
    expect(enforcementSettingsFromForm({ reentrySeconds: "  ", exitLimit: "  " })).toEqual({
      fullscreen_reentry_seconds: 20,
      fullscreen_exit_limit: 2
    });
  });

  it("values below 1 fall back to the defaults (UI floor is 1)", () => {
    expect(enforcementSettingsFromForm({ reentrySeconds: "0", exitLimit: "0" })).toEqual({
      fullscreen_reentry_seconds: 20,
      fullscreen_exit_limit: 2
    });
    expect(enforcementSettingsFromForm({ reentrySeconds: "-5", exitLimit: "-1" })).toEqual({
      fullscreen_reentry_seconds: 20,
      fullscreen_exit_limit: 2
    });
  });

  it("garbage and fractional text falls back to the defaults", () => {
    expect(enforcementSettingsFromForm({ reentrySeconds: "abc", exitLimit: "2.5" })).toEqual({
      fullscreen_reentry_seconds: 20,
      fullscreen_exit_limit: 2
    });
  });

  it("each field falls back independently", () => {
    expect(enforcementSettingsFromForm({ reentrySeconds: "", exitLimit: "4" })).toEqual({
      fullscreen_reentry_seconds: 20,
      fullscreen_exit_limit: 4
    });
    expect(enforcementSettingsFromForm({ reentrySeconds: "45", exitLimit: "" })).toEqual({
      fullscreen_reentry_seconds: 45,
      fullscreen_exit_limit: 2
    });
  });
});
