// OMR P1 — screen-marker feature-flag logic (pure; mirrors the backend's
// normalizeScreenMarkers rules exactly so demo mode and the settings form
// behave like production). THE rule under test: default OFF — only an
// explicit boolean true enables; no malformed payload can ever turn the
// marker layer on (2026-06-12 overlay-detection design §5.2/§11).
import { describe, expect, it } from "vitest";
import { SCREEN_MARKERS_DEFAULTS, normalizeScreenMarkers } from "./screenMarkers";

describe("normalizeScreenMarkers", () => {
  it("defaults to DISABLED when nothing is stored", () => {
    expect(normalizeScreenMarkers(undefined)).toEqual({ enabled: false });
    expect(normalizeScreenMarkers(null)).toEqual(SCREEN_MARKERS_DEFAULTS);
    expect(normalizeScreenMarkers({})).toEqual(SCREEN_MARKERS_DEFAULTS);
  });

  it("only an explicit boolean true enables", () => {
    expect(normalizeScreenMarkers({ enabled: true })).toEqual({ enabled: true });
    expect(normalizeScreenMarkers({ enabled: false })).toEqual({ enabled: false });
  });

  it("garbage shapes and truthy non-booleans fall back to DISABLED", () => {
    expect(normalizeScreenMarkers({ enabled: "true" }).enabled).toBe(false);
    expect(normalizeScreenMarkers({ enabled: 1 }).enabled).toBe(false);
    expect(normalizeScreenMarkers({ enabled: {} }).enabled).toBe(false);
    expect(normalizeScreenMarkers("enabled").enabled).toBe(false);
    expect(normalizeScreenMarkers(42).enabled).toBe(false);
    expect(normalizeScreenMarkers([{ enabled: true }]).enabled).toBe(false);
  });
});
