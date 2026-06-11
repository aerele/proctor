// OMR P1 — the pure marker placement map + adaptive sizing (2026-06-12
// overlay-detection design §4). Fixtures pin the §4.2 size table, the §4.3
// 16-marker placement (4 corner anchors + 8 edge points + top-strip center +
// 3 interior midline), tone assignment, capture projection and the render
// geometry MarkerLayer maps over. What is NOT testable here (and is covered
// by the manual/persona E2E pass instead): markers actually visible in a real
// recorded chunk on real hardware, and the visual unobtrusiveness judgment.
import { describe, expect, it } from "vitest";
import {
  MARKER_EDGE_INSET_CSS,
  MARKER_LAYOUT_VERSION,
  MARKER_TONES,
  adaptiveMarkerSizeCss,
  computeMarkerLayout,
  markerLayoutEventDetail,
  markerNodeStyles,
  projectMarkerToCapture
} from "./markerLayout";

const FHD = { viewportW: 1920, viewportH: 1080, dpr: 1, screenW: 1920, screenH: 1080, trackWidth: 960 };

function markerById(layout: ReturnType<typeof computeMarkerLayout>, id: string) {
  const spot = layout.markers.find((marker) => marker.id === id);
  if (!spot) throw new Error(`marker ${id} missing`);
  return spot;
}

describe("adaptiveMarkerSizeCss — the §4.2 detectability budget", () => {
  // The design's size table, expressed as (screen device width, dpr) fixtures.
  // captureScale = dpr × min(1, 960 / deviceW).
  it("matches the §4.2 table: common laptop/desktop screens stay at the 24px floor", () => {
    expect(adaptiveMarkerSizeCss(1 * (960 / 1366))).toBe(24); // 1366×768 @1 → 17 cap px
    expect(adaptiveMarkerSizeCss(1 * (960 / 1920))).toBe(24); // 1920×1080 @1 → 12 cap px
    expect(adaptiveMarkerSizeCss(2 * (960 / 2880))).toBe(24); // 2880×1800 @2 (Mac) → 16 cap px
  });

  it("grows on 4K so the checker still captures ≥10 px per side", () => {
    expect(adaptiveMarkerSizeCss(1 * (960 / 3840))).toBe(40); // 0.25 → ceil(40) → 40
    // 10 captured px at scale 0.25 = exactly the budget.
    expect(40 * 0.25).toBeGreaterThanOrEqual(10);
  });

  it("rounds odd sizes UP to even so quadrants are integer CSS px", () => {
    // scale 0.37 → ceil(10/0.37) = 28 (even, stays); scale 0.345 → 29 → 30.
    expect(adaptiveMarkerSizeCss(0.345) % 2).toBe(0);
    expect(adaptiveMarkerSizeCss(0.345)).toBe(30);
  });

  it("garbage scale falls back to the floor (never throws, never 0)", () => {
    expect(adaptiveMarkerSizeCss(0)).toBe(24);
    expect(adaptiveMarkerSizeCss(Number.NaN)).toBe(24);
    expect(adaptiveMarkerSizeCss(-1)).toBe(24);
  });
});

describe("computeMarkerLayout — the §4.3 placement map", () => {
  it("produces exactly the 16 design markers with unique ids", () => {
    const layout = computeMarkerLayout(FHD);
    expect(layout.markers).toHaveLength(16);
    expect(new Set(layout.markers.map((marker) => marker.id)).size).toBe(16);
    expect(layout.markers.map((marker) => marker.id).sort()).toEqual([
      "b-30", "b-70", "bl", "br", "c-mid", "c-up", "l-13", "l-23",
      "r-13", "r-23", "s-bar", "strip-c", "t-13", "t-23", "tl", "tr"
    ]);
    expect(layout.version).toBe(MARKER_LAYOUT_VERSION);
  });

  it("corner anchors are inset 4 px from every viewport edge", () => {
    const layout = computeMarkerLayout(FHD);
    const size = layout.sizeCss;
    expect(markerById(layout, "tl")).toMatchObject({ xCss: 4, yCss: 4 });
    expect(markerById(layout, "tr")).toMatchObject({ xCss: 1920 - 4 - size, yCss: 4 });
    expect(markerById(layout, "bl")).toMatchObject({ xCss: 4, yCss: 1080 - 4 - size });
    expect(markerById(layout, "br")).toMatchObject({ xCss: 1920 - 4 - size, yCss: 1080 - 4 - size });
    expect(MARKER_EDGE_INSET_CSS).toBe(4);
  });

  it("edge points sit at ⅓/⅔ — EXCEPT the bottom edge at 30/70 % (Chrome share-pill caveat)", () => {
    const layout = computeMarkerLayout(FHD);
    const half = layout.sizeCss / 2;
    expect(markerById(layout, "t-13").xCss).toBe(Math.round(1920 / 3 - half));
    expect(markerById(layout, "t-23").xCss).toBe(Math.round((2 * 1920) / 3 - half));
    expect(markerById(layout, "l-13").yCss).toBe(Math.round(1080 / 3 - half));
    expect(markerById(layout, "r-23").yCss).toBe(Math.round((2 * 1080) / 3 - half));
    // Bottom: 30/70 %, NOT thirds, NOT 50 % — the share pill parks bottom-center.
    expect(markerById(layout, "b-30").xCss).toBe(Math.round(0.3 * 1920 - half));
    expect(markerById(layout, "b-70").xCss).toBe(Math.round(0.7 * 1920 - half));
    const bottomCenterX = 1920 / 2 - half;
    for (const marker of layout.markers) {
      if (marker.yCss > 1000) expect(marker.xCss).not.toBe(Math.round(bottomCenterX));
    }
  });

  it("strip + interior trio ride the vertical midline at the design's y stops", () => {
    const layout = computeMarkerLayout(FHD);
    const half = layout.sizeCss / 2;
    const midX = Math.round(1920 / 2 - half);
    expect(markerById(layout, "strip-c")).toMatchObject({ xCss: midX, yCss: 4 });
    expect(markerById(layout, "c-up")).toMatchObject({ xCss: midX, yCss: Math.round(0.25 * 1080 - half) });
    expect(markerById(layout, "c-mid")).toMatchObject({ xCss: midX, yCss: Math.round(0.45 * 1080 - half) });
    expect(markerById(layout, "s-bar")).toMatchObject({ xCss: midX, yCss: Math.round(0.88 * 1080 - half) });
  });

  it("tone-on-tone assignment: the top-strip row is dark, everything else light", () => {
    const layout = computeMarkerLayout(FHD);
    const dark = layout.markers.filter((marker) => marker.tone === "dark").map((marker) => marker.id).sort();
    expect(dark).toEqual(["strip-c", "t-13", "t-23", "tl", "tr"]);
    // Both tone pairs hold the §4.2 ΔY≈40 floor (Rec.601 luma).
    const luma = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
    };
    expect(luma(MARKER_TONES.dark.hi) - luma(MARKER_TONES.dark.lo)).toBeGreaterThanOrEqual(40);
    expect(luma(MARKER_TONES.light.hi) - luma(MARKER_TONES.light.lo)).toBeGreaterThanOrEqual(40);
  });

  it("is deterministic — identical inputs yield deep-equal layouts (resize stability)", () => {
    expect(computeMarkerLayout(FHD)).toEqual(computeMarkerLayout({ ...FHD }));
  });

  it("a screen narrower than the track never upscales (captureScale caps at dpr)", () => {
    const layout = computeMarkerLayout({ viewportW: 800, viewportH: 600, dpr: 1, screenW: 800, screenH: 600, trackWidth: 960 });
    expect(layout.captureScale).toBe(1);
    expect(layout.sizeCss).toBe(24);
  });

  it("survives garbage inputs with the documented fallbacks (never throws, never NaN)", () => {
    const layout = computeMarkerLayout({ viewportW: 0, viewportH: Number.NaN, dpr: 0, screenW: -5, screenH: 0, trackWidth: 0 });
    expect(layout.markers).toHaveLength(16);
    for (const marker of layout.markers) {
      expect(Number.isFinite(marker.xCss)).toBe(true);
      expect(Number.isFinite(marker.yCss)).toBe(true);
    }
    expect(layout.sizeCss).toBeGreaterThanOrEqual(24);
  });
});

describe("capture projection + the marker_layout event detail (§5.3)", () => {
  it("projects CSS positions into capture px via captureScale", () => {
    const layout = computeMarkerLayout(FHD); // scale 0.5
    expect(layout.captureScale).toBe(0.5);
    expect(projectMarkerToCapture(markerById(layout, "tl"), layout)).toEqual({ xCap: 2, yCap: 2, sizeCap: 12 });
    const br = markerById(layout, "br");
    expect(projectMarkerToCapture(br, layout)).toEqual({ xCap: Math.round(br.xCss * 0.5), yCap: Math.round(br.yCss * 0.5), sizeCap: 12 });
  });

  it("hidpi: CSS coordinates scale by dpr×s into the captured frame", () => {
    const layout = computeMarkerLayout({ viewportW: 1440, viewportH: 900, dpr: 2, screenW: 1440, screenH: 900, trackWidth: 960 });
    expect(layout.captureScale).toBeCloseTo(2 * (960 / 2880), 10);
    const cap = projectMarkerToCapture(markerById(layout, "tl"), layout);
    expect(cap.sizeCap).toBe(16); // the §4.2 Mac row: 24 CSS px → 16 captured px
  });

  it("event detail carries the full detector ground truth — layout, dims, dpr, ACTUAL track settings", () => {
    const layout = computeMarkerLayout(FHD);
    const detail = markerLayoutEventDetail(layout, { width: 960, height: 540 });
    expect(detail).toMatchObject({
      version: MARKER_LAYOUT_VERSION,
      size_css: 24,
      viewport_w: 1920,
      viewport_h: 1080,
      screen_w: 1920,
      screen_h: 1080,
      dpr: 1,
      track_width: 960,
      capture_scale: 0.5,
      track_settings: { width: 960, height: 540 }
    });
    const markers = detail.markers as Array<Record<string, unknown>>;
    expect(markers).toHaveLength(16);
    expect(markers.find((marker) => marker.id === "tl")).toEqual({
      id: "tl", tone: "dark", x_css: 4, y_css: 4, x_cap: 2, y_cap: 2, size_cap: 12
    });
  });

  it("event detail reports null track settings when the track is unavailable", () => {
    const detail = markerLayoutEventDetail(computeMarkerLayout(FHD), null);
    expect(detail.track_settings).toBeNull();
  });
});

describe("markerNodeStyles — the render geometry MarkerLayer maps over", () => {
  it("outer node = checker + 1-cell quiet border ring, positioned around the checker", () => {
    const layout = computeMarkerLayout(FHD);
    const nodes = markerNodeStyles(layout);
    expect(nodes).toHaveLength(16);
    const tl = nodes.find((node) => node.id === "tl");
    expect(tl).toEqual({
      id: "tl",
      left: 4 - 12,
      top: 4 - 12,
      outer: 48,
      pad: 12,
      quiet: MARKER_TONES.dark.quiet,
      hi: MARKER_TONES.dark.hi,
      lo: MARKER_TONES.dark.lo
    });
  });

  it("light markers use the light tone trio", () => {
    const layout = computeMarkerLayout(FHD);
    const cMid = markerNodeStyles(layout).find((node) => node.id === "c-mid");
    expect(cMid).toMatchObject(MARKER_TONES.light);
  });
});
