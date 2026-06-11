// frontend/src/markers/markerLayout.ts — OMR P1 (2026-06-12 overlay-detection
// design §4): the PURE marker placement map + adaptive sizing + capture-pixel
// projection. One source of truth shared by the rendering MarkerLayer, the
// marker_layout telemetry event (the P2 detector's ground truth — it never
// reverse-engineers geometry from pixels) and, later, the P2 detector itself.
// No React, no IO — vitest target.
//
// The fiducial (§4.1): a luminance-only 2×2 checkerboard ("X-corner") inside a
// 1-cell quiet border. The checker survives VP8/VP9 at our 960px/4fps/400kbps
// settings because the polarity test compares QUADRANT MEANS (robust to the
// deblocking filter) in the LUMA plane (immune to 4:2:0 chroma subsampling).
// Layout coordinates (xCss/yCss) address the CHECKER square's top-left; the
// quiet border extends half a checker (one cell) beyond on every side and may
// clip at the viewport edge (the layer host clips overflow).

export type MarkerTone = "dark" | "light";

export type MarkerSpot = {
  id: string;
  /** Top-left of the 2×2 checker square, CSS px, viewport-fixed (§4.3). */
  xCss: number;
  yCss: number;
  tone: MarkerTone;
};

export type MarkerLayout = {
  /** Placement-map algorithm version, carried in marker_layout events. */
  version: number;
  /** Side of the 2×2 checker square in CSS px (quadrant = sizeCss / 2). */
  sizeCss: number;
  viewportW: number;
  viewportH: number;
  dpr: number;
  /** window.screen dims in CSS px (the recording captures the whole monitor). */
  screenW: number;
  screenH: number;
  /** The CONFIGURED screen-track width (upload_config.max_width). */
  trackWidth: number;
  /** Captured px per CSS px: dpr × min(1, trackWidth / (screenW × dpr)). */
  captureScale: number;
  markers: MarkerSpot[];
};

export const MARKER_LAYOUT_VERSION = 1;

// §4.3: corners inset 4 px from the viewport edge so encoder edge artefacts
// never clip the checker.
export const MARKER_EDGE_INSET_CSS = 4;
// §4.2 detectability budget: ≥10 captured px per checker side (≥5/quadrant).
export const MARKER_TARGET_CAPTURED_PX = 10;
export const MARKER_MIN_SIZE_CSS = 24;

// §4.2 tone-on-tone contrast (ΔY ≥ 40 between quadrant means, W1: the
// workspace is the page — markers must read as a faint texture, not UI):
//   dark  — matched to the page's only dark chrome, the bg-ink (#0a1a3f)
//           ExamTopBar strip; the raised quadrants are ink lightened to
//           Y≈66 vs ink's Y≈25 (Rec.601), ΔY≈40.
//   light — the design's light pair (#ffffff / #d4d4d4, ΔY≈43) over the
//           bg-paper (#f7f8fb) margins; the quiet border matches paper.
// `quiet` is the 1-cell border ring; `hi` fills the main-diagonal quadrants,
// `lo` the anti-diagonal (the fixed polarity the P2 detector asserts).
export const MARKER_TONES: Record<MarkerTone, { quiet: string; hi: string; lo: string }> = {
  dark: { quiet: "#0a1a3f", hi: "#2e4274", lo: "#0a1a3f" },
  light: { quiet: "#f7f8fb", hi: "#ffffff", lo: "#d4d4d4" }
};

function positiveOr(value: number | undefined | null, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** §4.2: sizeCss = max(24, ceil(10 / (s × dpr))), where s × dpr = captured px
 * per CSS px — rounded UP to an even number so the four quadrants land on
 * integer CSS px (crisp rendering at any dpr).
 *   1366×768@1 → 24 (17 cap px)   1920×1080@1 → 24 (12 cap px)
 *   2880×1800@2 → 24 (16 cap px)  3840×2160@1 → 40 (10 cap px) */
export function adaptiveMarkerSizeCss(captureScale: number): number {
  const scale = positiveOr(captureScale, 1);
  const needed = Math.ceil(MARKER_TARGET_CAPTURED_PX / scale);
  const size = Math.max(MARKER_MIN_SIZE_CSS, needed);
  return size % 2 === 0 ? size : size + 1;
}

/** The §4.3 placement map — 16 markers: 4 corner anchors + 8 edge points +
 * 1 top-strip center + 3 interior midline points.
 *   - Corners inset 4 px (the P2 anchors).
 *   - Edge points at ⅓/⅔ along each edge — EXCEPT the bottom edge, placed at
 *     30/70 % because Chrome's "sharing your screen" pill parks bottom-center.
 *   - STRIP-C sits at x 50 % inside the always-rendered dark top strip.
 *   - Interior trio on the vertical midline (design Open Question 1 option b):
 *     c-up (y 25 %) covers the strip→center band, c-mid the §4.3 viewport
 *     center (y 45 %), s-bar the workspace status-bar zone (y ~88 %).
 *   - Tones: everything in the dark top strip is dark-on-dark; the rest sits
 *     over the light page (§4.2).
 * Deterministic: same inputs ⇒ deep-equal output (resize stability). */
export function computeMarkerLayout(input: {
  viewportW: number;
  viewportH: number;
  dpr: number;
  screenW: number;
  screenH: number;
  trackWidth: number;
}): MarkerLayout {
  const viewportW = positiveOr(input.viewportW, 1280);
  const viewportH = positiveOr(input.viewportH, 720);
  const dpr = positiveOr(input.dpr, 1);
  const screenW = positiveOr(input.screenW, viewportW);
  const screenH = positiveOr(input.screenH, viewportH);
  const trackWidth = positiveOr(input.trackWidth, 960);
  // §4.2 capture scale s = track_width / screen_device_width, capped at 1 (the
  // recorder never upscales a screen narrower than the configured track).
  const s = Math.min(1, trackWidth / (screenW * dpr));
  const captureScale = s * dpr;
  const sizeCss = adaptiveMarkerSizeCss(captureScale);

  const half = sizeCss / 2;
  const inset = MARKER_EDGE_INSET_CSS;
  const right = viewportW - inset - sizeCss;
  const bottom = viewportH - inset - sizeCss;
  const midX = viewportW / 2 - half;
  const spot = (id: string, x: number, y: number, tone: MarkerTone): MarkerSpot =>
    ({ id, xCss: Math.round(x), yCss: Math.round(y), tone });

  const markers: MarkerSpot[] = [
    // 4 corners — the detector's anchors (§7.3).
    spot("tl", inset, inset, "dark"),
    spot("tr", right, inset, "dark"),
    spot("bl", inset, bottom, "light"),
    spot("br", right, bottom, "light"),
    // 8 edge points (top/side at ⅓ and ⅔; bottom at 30/70 %).
    spot("t-13", viewportW / 3 - half, inset, "dark"),
    spot("t-23", (2 * viewportW) / 3 - half, inset, "dark"),
    spot("l-13", inset, viewportH / 3 - half, "light"),
    spot("l-23", inset, (2 * viewportH) / 3 - half, "light"),
    spot("r-13", right, viewportH / 3 - half, "light"),
    spot("r-23", right, (2 * viewportH) / 3 - half, "light"),
    spot("b-30", 0.3 * viewportW - half, bottom, "light"),
    spot("b-70", 0.7 * viewportW - half, bottom, "light"),
    // 1 in the top strip center (always-rendered chrome — invisible by design).
    spot("strip-c", midX, inset, "dark"),
    // 3 interior, vertical midline.
    spot("c-up", midX, 0.25 * viewportH - half, "light"),
    spot("c-mid", midX, 0.45 * viewportH - half, "light"),
    spot("s-bar", midX, 0.88 * viewportH - half, "light")
  ];

  return {
    version: MARKER_LAYOUT_VERSION,
    sizeCss,
    viewportW,
    viewportH,
    dpr,
    screenW,
    screenH,
    trackWidth,
    captureScale,
    markers
  };
}

/** Project a marker's checker square into capture (recorded-frame) pixels —
 * valid while fullscreen holds (page edge ≈ screen edge, §2). The P2 detector
 * additionally anchor-fits ±8 px around these, so rounding here is fine. */
export function projectMarkerToCapture(
  spot: MarkerSpot,
  layout: Pick<MarkerLayout, "captureScale" | "sizeCss">
): { xCap: number; yCap: number; sizeCap: number } {
  return {
    xCap: Math.round(spot.xCss * layout.captureScale),
    yCap: Math.round(spot.yCss * layout.captureScale),
    sizeCap: Math.round(layout.sizeCss * layout.captureScale)
  };
}

/** The marker_layout telemetry event detail (§5.3) — the P2 detector's ground
 * truth: full layout (CSS + projected capture px), screen dims, dpr and the
 * screen track's ACTUAL getSettings() dims so detection never guesses. */
export function markerLayoutEventDetail(
  layout: MarkerLayout,
  trackSettings: { width?: number; height?: number } | null
): Record<string, unknown> {
  return {
    version: layout.version,
    size_css: layout.sizeCss,
    viewport_w: layout.viewportW,
    viewport_h: layout.viewportH,
    screen_w: layout.screenW,
    screen_h: layout.screenH,
    dpr: layout.dpr,
    track_width: layout.trackWidth,
    capture_scale: layout.captureScale,
    track_settings: trackSettings
      ? { width: trackSettings.width ?? null, height: trackSettings.height ?? null }
      : null,
    markers: layout.markers.map((marker) => {
      const cap = projectMarkerToCapture(marker, layout);
      return {
        id: marker.id,
        tone: marker.tone,
        x_css: marker.xCss,
        y_css: marker.yCss,
        x_cap: cap.xCap,
        y_cap: cap.yCap,
        size_cap: cap.sizeCap
      };
    })
  };
}

/** Pure render geometry for MarkerLayer: the OUTER node is the checker plus
 * the 1-cell quiet border ring (padding = half the checker, background =
 * quiet tone); the inner 2×2 grid is the checker. Kept here so the placement
 * a node actually renders at is unit-testable without a DOM. */
export type MarkerNodeStyle = {
  id: string;
  left: number;
  top: number;
  /** Outer square side = 2 × sizeCss (checker + border ring). */
  outer: number;
  /** Border-ring thickness = sizeCss / 2 (one checker cell). */
  pad: number;
  quiet: string;
  hi: string;
  lo: string;
};

export function markerNodeStyles(layout: MarkerLayout): MarkerNodeStyle[] {
  const pad = layout.sizeCss / 2;
  return layout.markers.map((marker) => ({
    id: marker.id,
    left: marker.xCss - pad,
    top: marker.yCss - pad,
    outer: layout.sizeCss * 2,
    pad,
    ...MARKER_TONES[marker.tone]
  }));
}
