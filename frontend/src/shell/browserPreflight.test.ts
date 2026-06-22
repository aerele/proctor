// frontend/src/shell/browserPreflight.test.ts
// G2 (v1.1 anti-cheat): the PURE preflight verdict + UA advisory.
import { describe, expect, it } from "vitest";
import {
  classifyUserAgent,
  evaluatePreflight,
  PREFLIGHT_MATRIX,
  RECOMMENDED_BROWSER_LINE,
  uaAdvisoryLine,
  type ProbeResult
} from "./browserPreflight";

const probe = (capability: ProbeResult["capability"], ok: boolean): ProbeResult => ({
  capability,
  ok,
  required: PREFLIGHT_MATRIX[capability].required
});

const allOk = (): ProbeResult[] => [
  probe("secure_context", true),
  probe("screen_capture", true),
  probe("media_recorder", true),
  probe("fullscreen", true),
  probe("keystroke", true),
  probe("cursor", true),
  probe("camera_mic", true)
];

describe("evaluatePreflight", () => {
  it("passes when every required capability is ok", () => {
    const v = evaluatePreflight(allOk());
    expect(v.passed).toBe(true);
    expect(v.blockingFailures).toEqual([]);
    expect(v.warnings).toEqual([]);
  });

  it("a single REQUIRED failure hard-blocks and names the capability + recommended browser", () => {
    const results = allOk().map((r) => (r.capability === "screen_capture" ? { ...r, ok: false } : r));
    const v = evaluatePreflight(results);
    expect(v.passed).toBe(false);
    expect(v.blockingFailures).toEqual(["screen_capture"]);
    expect(v.message).toContain(PREFLIGHT_MATRIX.screen_capture.label);
    expect(v.message).toContain(RECOMMENDED_BROWSER_LINE);
  });

  it("an OPTIONAL failure (camera_mic) only warns, never blocks", () => {
    const results = allOk().map((r) => (r.capability === "camera_mic" ? { ...r, ok: false } : r));
    const v = evaluatePreflight(results);
    expect(v.passed).toBe(true);
    expect(v.warnings).toEqual(["camera_mic"]);
    expect(v.blockingFailures).toEqual([]);
  });

  it("lists multiple blocking failures readably", () => {
    const results = allOk().map((r) =>
      r.capability === "media_recorder" || r.capability === "keystroke" ? { ...r, ok: false } : r
    );
    const v = evaluatePreflight(results);
    expect(v.passed).toBe(false);
    expect(v.blockingFailures.sort()).toEqual(["keystroke", "media_recorder"]);
    expect(v.message).toContain(" and ");
  });

  it("required floor = secure_context, screen_capture, media_recorder, fullscreen, keystroke, cursor; camera_mic optional", () => {
    expect(PREFLIGHT_MATRIX.secure_context.required).toBe(true);
    expect(PREFLIGHT_MATRIX.screen_capture.required).toBe(true);
    expect(PREFLIGHT_MATRIX.media_recorder.required).toBe(true);
    expect(PREFLIGHT_MATRIX.fullscreen.required).toBe(true);
    expect(PREFLIGHT_MATRIX.keystroke.required).toBe(true);
    expect(PREFLIGHT_MATRIX.cursor.required).toBe(true);
    expect(PREFLIGHT_MATRIX.camera_mic.required).toBe(false);
  });
});

describe("classifyUserAgent (secondary advisory, never the gate)", () => {
  it("flags iOS (no getDisplayMedia)", () => {
    expect(classifyUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari")).toBe("ios");
    expect(classifyUserAgent("Mozilla/5.0 (iPad; CPU OS 17_0) Safari")).toBe("ios");
  });

  it("flags in-app webviews", () => {
    expect(classifyUserAgent("Mozilla/5.0 Instagram 300.0")).toBe("in_app_webview");
    expect(classifyUserAgent("Mozilla/5.0 ... FBAN/FBIOS")).toBe("in_app_webview");
  });

  it("flags firefox as a soft note", () => {
    expect(classifyUserAgent("Mozilla/5.0 (X11; Linux) Gecko Firefox/120.0")).toBe("firefox");
  });

  it("a normal desktop Chrome is ok (no advisory line)", () => {
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36";
    expect(classifyUserAgent(ua)).toBe("ok");
    expect(uaAdvisoryLine("ok")).toBe("");
  });

  it("empty UA is unknown", () => {
    expect(classifyUserAgent("")).toBe("unknown");
  });
});
