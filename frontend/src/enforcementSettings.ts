// frontend/src/enforcementSettings.ts — F5.3 admin-form enforcement knobs.
//
// Wave-3 fix: the Settings form bound these number fields through
// Number(value), so CLEARING a field silently saved 0 — for the exit limit the
// HARSHEST possible setting (the first accidental exit locks the candidate),
// persisted without the admin ever typing it (the backend's minimum is 0, so
// nothing corrected it server-side). Blank or invalid text now falls back to
// the DEFAULT (20 s / 2 exits) and the UI floor is 1 — mirrors
// cameraRecordingFromForm (the wave-2 blank-saves-0 rule). Pure module,
// vitest-covered, consumed by the admin Settings form.

export const FULLSCREEN_REENTRY_DEFAULT_SECONDS = 20;
export const FULLSCREEN_EXIT_LIMIT_DEFAULT = 2;

// Blank means "use the default"; anything that is not an integer >= 1 falls
// BACK to the default (not clamped) — the same "garbage falls back" rule as
// the backend's intSettingOr, with a UI-side floor of 1 so the harshest
// settings are always an explicit choice, never an accident.
function fieldFromForm(text: string, fallback: number): number {
  const trimmed = text.trim();
  if (trimmed === "") return fallback;
  const num = Number(trimmed);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num < 1) return fallback;
  return num;
}

/** Settings-form text fields → the enforcement knobs the save request sends. */
export function enforcementSettingsFromForm(form: { reentrySeconds: string; exitLimit: string }): {
  fullscreen_reentry_seconds: number;
  fullscreen_exit_limit: number;
} {
  return {
    fullscreen_reentry_seconds: fieldFromForm(form.reentrySeconds, FULLSCREEN_REENTRY_DEFAULT_SECONDS),
    fullscreen_exit_limit: fieldFromForm(form.exitLimit, FULLSCREEN_EXIT_LIMIT_DEFAULT)
  };
}
