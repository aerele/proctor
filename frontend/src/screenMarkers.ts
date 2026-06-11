// frontend/src/screenMarkers.ts — OMR P1 screen-marker feature-flag logic.
//
// The flag gates the on-screen OMR fiducial layer (markers/MarkerLayer.tsx)
// that rides into the screen recording for the P2 overlay-occlusion detector.
// Mirrors cameraRecording.ts exactly, except the default is DISABLED — a
// deployment that never touches the flag must behave byte-identically to
// today (2026-06-12 overlay-detection design §5.2/§11). v1 is boolean-only;
// marker size/contrast/count are code constants in markers/markerLayout.ts
// (design Open Question 4). normalizeScreenMarkers mirrors the backend's
// rules exactly so demo mode and the settings form behave like production.
// Pure module — vitest-covered, shared by the demo api, the admin settings
// form and the candidate marker layer.

export type ScreenMarkersConfig = {
  enabled: boolean;
};

export const SCREEN_MARKERS_DEFAULTS: ScreenMarkersConfig = { enabled: false };

/** Backend-parity normalization: default DISABLED — only an explicit boolean
 * true enables; every garbage shape falls back to off (the flag can never be
 * turned on by a malformed payload). */
export function normalizeScreenMarkers(raw: unknown): ScreenMarkersConfig {
  const source = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : SCREEN_MARKERS_DEFAULTS.enabled
  };
}
