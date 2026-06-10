// F10.1 — camera-recording config logic (pure; mirrors the backend's
// normalizeCameraRecording rules exactly so demo mode and the settings form
// behave like production).
import { describe, expect, it } from "vitest";
import {
  CAMERA_RECORDING_DEFAULTS,
  cameraRecordingFromForm,
  cameraTrackConstraints,
  normalizeCameraRecording,
  shouldRecordCamera
} from "./cameraRecording";

describe("normalizeCameraRecording", () => {
  it("defaults to ENABLED, 10 fps, 640 width when nothing is stored", () => {
    expect(normalizeCameraRecording(undefined)).toEqual({ enabled: true, fps: 10, width: 640 });
    expect(normalizeCameraRecording(null)).toEqual(CAMERA_RECORDING_DEFAULTS);
    expect(normalizeCameraRecording({})).toEqual(CAMERA_RECORDING_DEFAULTS);
  });

  it("passes through valid values", () => {
    expect(normalizeCameraRecording({ enabled: false, fps: 5, width: 800 }))
      .toEqual({ enabled: false, fps: 5, width: 800 });
    expect(normalizeCameraRecording({ enabled: true, fps: 1, width: 320 }))
      .toEqual({ enabled: true, fps: 1, width: 320 });
    expect(normalizeCameraRecording({ enabled: true, fps: 15, width: 1280 }))
      .toEqual({ enabled: true, fps: 15, width: 1280 });
  });

  it("only an explicit boolean false disables (default-on)", () => {
    expect(normalizeCameraRecording({ enabled: "no" }).enabled).toBe(true);
    expect(normalizeCameraRecording({ enabled: 0 }).enabled).toBe(true);
    expect(normalizeCameraRecording({ enabled: false }).enabled).toBe(false);
  });

  it("out-of-range / garbage / zero values fall back to the defaults (never 0)", () => {
    expect(normalizeCameraRecording({ fps: 0, width: 0 })).toEqual(CAMERA_RECORDING_DEFAULTS);
    expect(normalizeCameraRecording({ fps: 16, width: 5000 })).toEqual(CAMERA_RECORDING_DEFAULTS);
    expect(normalizeCameraRecording({ fps: -2, width: 100 })).toEqual(CAMERA_RECORDING_DEFAULTS);
    expect(normalizeCameraRecording({ fps: "garbage", width: "" })).toEqual(CAMERA_RECORDING_DEFAULTS);
    expect(normalizeCameraRecording({ fps: 7.5, width: 640.5 })).toEqual(CAMERA_RECORDING_DEFAULTS);
  });
});

describe("cameraRecordingFromForm", () => {
  it("parses valid numeric text", () => {
    expect(cameraRecordingFromForm({ enabled: false, fps: "8", width: "480" }))
      .toEqual({ enabled: false, fps: 8, width: 480 });
  });

  it("blank fields fall back to the defaults — the wave-2 blank-saves-0 hazard", () => {
    expect(cameraRecordingFromForm({ enabled: true, fps: "", width: "  " }))
      .toEqual({ enabled: true, fps: 10, width: 640 });
  });

  it("zero / out-of-range / non-numeric text falls back to the defaults", () => {
    expect(cameraRecordingFromForm({ enabled: true, fps: "0", width: "0" }))
      .toEqual(CAMERA_RECORDING_DEFAULTS);
    expect(cameraRecordingFromForm({ enabled: true, fps: "99", width: "10000" }))
      .toEqual(CAMERA_RECORDING_DEFAULTS);
    expect(cameraRecordingFromForm({ enabled: true, fps: "abc", width: "12px" }))
      .toEqual(CAMERA_RECORDING_DEFAULTS);
  });
});

describe("shouldRecordCamera", () => {
  it("records only when the server enabled it AND a live camera track exists", () => {
    expect(shouldRecordCamera({ enabled: true, fps: 10, width: 640 }, true)).toBe(true);
    expect(shouldRecordCamera({ enabled: true, fps: 10, width: 640 }, false)).toBe(false);
    expect(shouldRecordCamera({ enabled: false, fps: 10, width: 640 }, true)).toBe(false);
  });

  it("an OLDER backend (no camera block in upload_config) never records — its upload-url would count camera chunks into chunk_count", () => {
    expect(shouldRecordCamera(undefined, true)).toBe(false);
    expect(shouldRecordCamera(null, true)).toBe(false);
  });
});

describe("cameraTrackConstraints", () => {
  it("builds applyConstraints input from the server config (fps capped, width ideal)", () => {
    expect(cameraTrackConstraints({ enabled: true, fps: 10, width: 640 })).toEqual({
      frameRate: { ideal: 10, max: 10 },
      width: { ideal: 640 }
    });
  });
});
