// frontend/src/markers/MarkerLayer.tsx — OMR P1 (2026-06-12 overlay-detection
// design §4.4/§5.1): the on-screen fiducial layer. Renders the 16 placement-map
// markers (markerLayout.ts) viewport-fixed at MAXIMUM z-index, above every
// overlay we own (EnforcementOverlay z-[100], EndTestPanel, CameraDock…) —
// the self-occlusion rule: if our own chrome could cover a marker, every
// enforcement overlay would manufacture a fake "occlusion" in the recording.
// With markers on top, any marker absence in an anchored frame is caused by
// something OUTSIDE our page — exactly the P2 signal.
//
// Flag plumbing (§5.2): `enabled` comes from the session start/resume
// response's optional screen_markers key — absent (flag off / older backend)
// means this component returns null: ZERO DOM impact, the flag-off render
// tree is identical to today. Markers render only while the session is
// recording — pre-session screens never show them.
import { useEffect, useRef, useState } from "react";
import {
  computeMarkerLayout,
  markerLayoutEventDetail,
  markerNodeStyles,
  type MarkerLayout
} from "./markerLayout";

export function MarkerLayer({ enabled, recording, trackWidth, getScreenTrackSettings, onLayout }: {
  /** The screen_markers flag from the start/resume response (default off). */
  enabled: boolean;
  /** True while status === "recording" — markers exist only on recorded frames. */
  recording: boolean;
  /** Configured screen-track width (upload_config.max_width) for §4.2 sizing. */
  trackWidth: number;
  /** Reads the live screen track's getSettings() (null when unavailable) —
   * reported in marker_layout so the P2 detector never guesses geometry. */
  getScreenTrackSettings: () => { width?: number; height?: number } | null;
  /** Emits the additive marker_layout telemetry event (§5.3). */
  onLayout: (detail: Record<string, unknown>) => void;
}) {
  const active = enabled && recording;
  const [layout, setLayout] = useState<MarkerLayout | null>(null);

  // Recompute on mount + resize + fullscreenchange (§5.1 — layout is cheap).
  useEffect(() => {
    if (!active) {
      setLayout(null);
      return;
    }
    const compute = () =>
      setLayout(
        computeMarkerLayout({
          viewportW: window.innerWidth,
          viewportH: window.innerHeight,
          dpr: window.devicePixelRatio || 1,
          screenW: window.screen?.width || window.innerWidth,
          screenH: window.screen?.height || window.innerHeight,
          trackWidth
        })
      );
    compute();
    window.addEventListener("resize", compute);
    document.addEventListener("fullscreenchange", compute);
    return () => {
      window.removeEventListener("resize", compute);
      document.removeEventListener("fullscreenchange", compute);
    };
  }, [active, trackWidth]);

  // Emit marker_layout at recording start (first layout) and on every layout
  // CHANGE, deduped by content so re-renders never re-emit (telemetry stays
  // strictly additive). The ref resets when the layer deactivates so the next
  // recording stint re-reports its ground truth.
  const lastEmittedRef = useRef("");
  useEffect(() => {
    if (!layout) {
      lastEmittedRef.current = "";
      return;
    }
    const detail = markerLayoutEventDetail(layout, getScreenTrackSettings());
    const signature = JSON.stringify(detail);
    if (signature === lastEmittedRef.current) return;
    lastEmittedRef.current = signature;
    onLayout(detail);
  }, [layout, getScreenTrackSettings, onLayout]);

  if (!active || !layout) return null;
  return (
    <div
      aria-hidden="true"
      data-marker-layer=""
      className="pointer-events-none fixed inset-0 overflow-hidden"
      style={{ zIndex: 2147483647 }}
    >
      {markerNodeStyles(layout).map((node) => (
        <div
          key={node.id}
          data-marker-id={node.id}
          className="absolute"
          style={{
            left: node.left,
            top: node.top,
            width: node.outer,
            height: node.outer,
            padding: node.pad,
            backgroundColor: node.quiet
          }}
        >
          {/* The 2×2 checker — hi on the main diagonal, lo on the anti-diagonal
              (the fixed polarity the P2 quadrant-mean test asserts, §4.1). */}
          <div className="grid h-full w-full grid-cols-2 grid-rows-2">
            <div style={{ backgroundColor: node.hi }} />
            <div style={{ backgroundColor: node.lo }} />
            <div style={{ backgroundColor: node.lo }} />
            <div style={{ backgroundColor: node.hi }} />
          </div>
        </div>
      ))}
    </div>
  );
}
