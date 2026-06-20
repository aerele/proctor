// frontend/src/candidate/panels/CameraSelfView.tsx
// Candidate leaf panel (extracted verbatim from App.tsx, F2). Props-driven.
import type React from "react";
import { Camera } from "lucide-react";
import * as studentCopy from "../../studentCopy";
import type { MediaCaptureState } from "../../useProctorRecorder";

export function CameraSelfView({ videoRef, mediaCapture, cameraRecorded }: { videoRef: React.Ref<HTMLVideoElement>; mediaCapture: MediaCaptureState; cameraRecorded: boolean }) {
  return (
    <section className="rounded-lg border border-line bg-panel p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Camera size={18} />
          <h2 className="font-semibold">Camera self-view</h2>
        </div>
        {/* F10.1: with the camera-recording setting ON, a working camera reads
            "recording" (a separate low-res stream IS recorded); with it off
            the camera is a live monitor only — "monitored, not recorded". */}
        <span className={`rounded-full border px-2 py-1 text-xs font-medium ${mediaCapture.camera === "recording" ? "border-accent/30 bg-accent/10 text-accent" : "border-warning/30 bg-warning/10 text-warning"}`}>{studentCopy.cameraStateLabel(mediaCapture.camera, cameraRecorded)}</span>
      </div>
      <div className="overflow-hidden rounded-md border border-line bg-ink">
        <video ref={videoRef} className="aspect-video w-full object-cover" autoPlay muted playsInline />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-xs leading-5 text-muted">{mediaCapture.camera === "unavailable" ? "No camera was detected. Screen recording continues." : "The camera preview stays here while you work."}</span>
      </div>
    </section>
  );
}
