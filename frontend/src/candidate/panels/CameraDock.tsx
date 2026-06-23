// frontend/src/candidate/panels/CameraDock.tsx
// Candidate leaf panel (extracted verbatim from App.tsx, F2). Props-driven.
import type React from "react";
import { Camera, ChevronDown } from "lucide-react";
import * as studentCopy from "../../studentCopy";
import type { MediaCaptureState } from "../../useProctorRecorder";

// CAM-1: when the camera is unavailable the expanded dock is just a dead 224px
// tile that the candidate has to collapse by hand — wasted space and a poor
// signal. Instead we auto-collapse the dock to its minimal pill the moment
// availability flips to "unavailable". Pure transition predicate so it can be
// unit-tested without a DOM: true only on the EDGE into "unavailable" (any
// non-unavailable previous state → "unavailable"), never while it stays
// unavailable. Keeping it edge-only is what avoids fighting the candidate — a
// manual re-expand after the collapse is respected because a steady-state
// "unavailable" → "unavailable" render returns false.
export function shouldAutoCollapseCameraDock(
  prev: MediaCaptureState["camera"],
  next: MediaCaptureState["camera"]
): boolean {
  return next === "unavailable" && prev !== "unavailable";
}

// W1 — the floating camera dock for the exam view: a small bottom-right tile
// (HackerRank-style) that keeps the rule-mandated self-view visible without
// stealing layout space. The <video> host stays MOUNTED in BOTH visual states
// (minimize is CSS-only) — the camera CAPTURE itself lives in the recorder and
// never depends on this preview.
export function CameraDock({ videoRef, mediaCapture, cameraRecorded, collapsed, onToggle }: {
  videoRef: React.Ref<HTMLVideoElement>;
  mediaCapture: MediaCaptureState;
  cameraRecorded: boolean;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const stateLabel = studentCopy.cameraStateLabel(mediaCapture.camera, cameraRecorded);
  return (
    <div className="fixed bottom-4 right-4 z-40">
      <div className={collapsed ? "hidden" : "w-56 overflow-hidden rounded-lg border border-line bg-ink shadow-subtle"}>
        <div className="flex items-center justify-between gap-2 px-2.5 py-1.5">
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold text-white/80">
            <Camera size={12} className="shrink-0" /> <span className="truncate">Camera · {stateLabel}</span>
          </span>
          <span className="flex shrink-0 items-center gap-0.5">
            <button title="Minimize camera tile" className="focus-ring rounded p-1 text-white/70 hover:bg-white/10" onClick={onToggle}>
              <ChevronDown size={14} />
            </button>
          </span>
        </div>
        <video ref={videoRef} className="aspect-video w-full object-cover" autoPlay muted playsInline />
      </div>
      {collapsed ? (
        <button onClick={onToggle} className="focus-ring flex items-center gap-2 rounded-full bg-ink px-3 py-2 text-xs font-medium text-white shadow-subtle">
          <Camera size={14} /> Camera · {stateLabel}
        </button>
      ) : null}
    </div>
  );
}
