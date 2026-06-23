// frontend/src/candidate/panels/CameraDock.test.ts
//
// CAM-1: the camera dock auto-collapses to its minimal pill when the camera
// becomes unavailable, but must NOT fight a candidate who manually re-expands
// it. shouldAutoCollapseCameraDock is the pure transition predicate that the
// dock's host effect keys on — it fires only on the EDGE into "unavailable",
// so a steady-state "unavailable" render (where the candidate may have re-
// expanded) returns false. This test pins that contract without a DOM.
import { describe, it, expect } from "vitest";
import { shouldAutoCollapseCameraDock } from "./CameraDock";
import type { MediaCaptureState } from "../../useProctorRecorder";

type CameraState = MediaCaptureState["camera"];

const NON_UNAVAILABLE: CameraState[] = [
  "inactive",
  "recording",
  "stopped",
  "error",
  "permission_denied"
];

describe("shouldAutoCollapseCameraDock", () => {
  it("collapses on every transition INTO unavailable from a non-unavailable state", () => {
    for (const prev of NON_UNAVAILABLE) {
      expect(shouldAutoCollapseCameraDock(prev, "unavailable")).toBe(true);
    }
  });

  it("does NOT re-collapse while the camera stays unavailable (respects a manual re-expand)", () => {
    expect(shouldAutoCollapseCameraDock("unavailable", "unavailable")).toBe(false);
  });

  it("never collapses when the camera is or becomes available", () => {
    for (const next of NON_UNAVAILABLE) {
      // recovering from unavailable, or any available -> available render
      expect(shouldAutoCollapseCameraDock("unavailable", next)).toBe(false);
      for (const prev of NON_UNAVAILABLE) {
        expect(shouldAutoCollapseCameraDock(prev, next)).toBe(false);
      }
    }
  });
});
