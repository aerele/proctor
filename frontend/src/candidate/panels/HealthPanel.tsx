// frontend/src/candidate/panels/HealthPanel.tsx
// Candidate leaf panel (extracted verbatim from App.tsx, F2). Props-driven.
import { Activity, Camera, CheckCircle2, ClipboardList, Mic, MonitorUp, ShieldCheck, UploadCloud } from "lucide-react";
import { resolveBufferCaps } from "../../chunkBuffer";
import * as studentCopy from "../../studentCopy";
import type { SessionStartResponse, SessionStatus, UploadManifestItem } from "../../types";
import type { BufferStatus, MediaCaptureState } from "../../useProctorRecorder";
import { Metric } from "../../ui/Metric";

// Map the raw recorder status to plain candidate-facing language so the health
// panel reads "Recording" / "Not recording" rather than internal status strings.
function recordingStateLabel(status: SessionStatus): { label: string; recording: boolean } {
  if (status === "recording") return { label: "Recording", recording: true };
  if (status === "ending") return { label: "Finishing up…", recording: true };
  // Tier-1: the end-of-test drain wait — still "finishing", recording shown true
  // so the chrome dot/labels stay consistent with the blocking overlay.
  if (status === "ending_draining") return { label: "Finishing — uploading…", recording: true };
  return { label: "Not recording", recording: false };
}

// startIp/currentIp moved here from the deleted TimerBar (S1): close-up
// diagnostics, not at-a-distance content. The ip-changed red treatment is
// superseded by the shell's anomaly flow (ip_address_changed vanishes the bar).
export function HealthPanel({ status, sessionId, config, queueDepth, uploadedCount, manifest, mediaCapture, startIp, currentIp, ipChanged, bufferStatus }: { status: SessionStatus; sessionId: string; config: SessionStartResponse | null; queueDepth: number; uploadedCount: number; manifest: UploadManifestItem[]; mediaCapture: MediaCaptureState; startIp: string; currentIp: string; ipChanged: boolean; bufferStatus: BufferStatus }) {
  const state = recordingStateLabel(status);
  // Tier-1: amber reassurance when the buffer holds pending chunks (a live
  // upload is failing but footage is saved locally + uploading automatically).
  // Near-cap (>80% of either cap) escalates the copy to "keep this tab open".
  const pending = bufferStatus.mode === "buffering" ? bufferStatus.pendingCount : 0;
  const caps = resolveBufferCaps(config?.upload_config);
  const nearCap =
    pending > 0 &&
    (bufferStatus.pendingBytes > caps.maxBytes * 0.8 || bufferStatus.pendingCount > caps.maxCount * 0.8);
  const pendingMb = bufferStatus.pendingBytes / (1024 * 1024);
  return (
    <section className="rounded-lg border border-line bg-panel p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ShieldCheck size={18} />
          <h2 className="font-semibold">Recording health</h2>
        </div>
        <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${state.recording ? "border-accent/30 bg-accent/10 text-accent" : "border-warning/30 bg-warning/10 text-warning"}`}>
          {state.label}
        </span>
      </div>
      {pending > 0 ? (
        <div className="mb-4 rounded-md border border-warning/30 bg-warning/10 p-3 text-xs leading-5 text-warning">
          <strong>{uploadedCount} uploaded · {pending} pending</strong> ({pendingMb.toFixed(1)} MB saved locally, uploading automatically).
          {nearCap
            ? " Your connection has been down a while — keep this tab open so your recording can finish uploading."
            : " Your connection is slow; your recording is safe on this computer and will upload when it recovers."}
        </div>
      ) : null}
      <div className="space-y-3 text-sm">
        <Metric icon={<CheckCircle2 size={16} />} label="State" value={state.label} />
        <Metric icon={<UploadCloud size={16} />} label="Uploaded chunks" value={`${uploadedCount}${queueDepth ? ` (${queueDepth} pending)` : ""}`} />
        <Metric icon={<MonitorUp size={16} />} label="Chunk interval" value={config ? `${config.upload_config.chunk_seconds}s` : "Not started"} />
        <Metric icon={<MonitorUp size={16} />} label="Screen" value={mediaCapture.screen} />
        {/* Camera = live monitor only; its stream is never recorded. */}
        <Metric icon={<Camera size={16} />} label="Camera" value={studentCopy.cameraStateLabel(mediaCapture.camera, config?.upload_config.camera?.enabled === true)} />
        <Metric icon={<Mic size={16} />} label="Microphone" value={mediaCapture.microphone} />
        <Metric icon={<ClipboardList size={16} />} label="Manifest items" value={String(manifest.length)} />
        <Metric icon={<Activity size={16} />} label="Start IP" value={startIp || "pending"} />
        <Metric icon={<Activity size={16} />} label="Current IP" value={`${currentIp || startIp || "pending"}${ipChanged ? " (changed)" : ""}`} />
      </div>
      {sessionId ? <p className="mt-4 break-all font-mono text-xs text-muted">{sessionId}</p> : null}
    </section>
  );
}
