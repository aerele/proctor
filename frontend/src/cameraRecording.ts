// frontend/src/cameraRecording.ts — F10.1 camera-recording config logic.
//
// The separate low-res camera stream exists to catch eye movement (a candidate
// repeatedly glancing down at notes/a phone), so the defaults are ~10 fps and
// just enough width to read eye direction. The admin tunes fps/width within
// tight bounds; every invalid or blank value falls back to its DEFAULT (never
// 0 — the wave-2 blank-saves-0 hazard). normalizeCameraRecording mirrors the
// backend's rules exactly so demo mode and the settings form behave like
// production. Pure module — vitest-covered, shared by the recorder, the demo
// api and the admin settings form.

export type CameraRecordingConfig = {
  enabled: boolean;
  fps: number;
  width: number;
};

export const CAMERA_RECORDING_DEFAULTS: CameraRecordingConfig = { enabled: true, fps: 10, width: 640 };
export const CAMERA_FPS_MIN = 1;
export const CAMERA_FPS_MAX = 15;
export const CAMERA_WIDTH_MIN = 320;
export const CAMERA_WIDTH_MAX = 1280;

// Integer within [min, max] or the fallback — out-of-range values fall BACK
// (not clamped), matching the backend's "garbage falls back to the default"
// settings rule (handler.mjs boundedIntOr).
function boundedIntOr(raw: unknown, fallback: number, minimum: number, maximum: number): number {
  const num = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num < minimum || num > maximum) return fallback;
  return num;
}

/** Backend-parity normalization: default ENABLED — only an explicit boolean
 * false disables; fps/width fall back to 10/640 outside 1-15 / 320-1280. */
export function normalizeCameraRecording(raw: unknown): CameraRecordingConfig {
  const source = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : CAMERA_RECORDING_DEFAULTS.enabled,
    fps: boundedIntOr(source.fps, CAMERA_RECORDING_DEFAULTS.fps, CAMERA_FPS_MIN, CAMERA_FPS_MAX),
    width: boundedIntOr(source.width, CAMERA_RECORDING_DEFAULTS.width, CAMERA_WIDTH_MIN, CAMERA_WIDTH_MAX)
  };
}

/** Settings-form text fields → config. A blank/invalid field means "use the
 * default", never 0 (the wave-2 finding: Number("") === 0 must not persist). */
export function cameraRecordingFromForm(form: { enabled: boolean; fps: string; width: string }): CameraRecordingConfig {
  const parse = (text: string): unknown => {
    const trimmed = text.trim();
    return trimmed === "" ? undefined : Number(trimmed);
  };
  return normalizeCameraRecording({ enabled: form.enabled === true, fps: parse(form.fps), width: parse(form.width) });
}

/** The recorder starts the second (camera) MediaRecorder only when the server
 * enabled it AND a live camera track exists. An absent config block means an
 * OLDER backend: never record — its upload-url would count camera chunks into
 * chunk_count and corrupt the admin UI's recording-duration math. */
export function shouldRecordCamera(
  config: CameraRecordingConfig | null | undefined,
  cameraTrackLive: boolean
): boolean {
  return config?.enabled === true && cameraTrackLive;
}

/** applyConstraints() input for the camera track: hard-cap the frame rate at
 * the configured fps (the low-res bar), let the browser pick the nearest
 * supported width to the configured ideal. */
export function cameraTrackConstraints(config: CameraRecordingConfig): MediaTrackConstraints {
  return {
    frameRate: { ideal: config.fps, max: config.fps },
    width: { ideal: config.width }
  };
}
