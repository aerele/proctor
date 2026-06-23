// frontend/src/candidate/panels/RecordingNotSavedPanel.tsx
// Candidate leaf panel (props-driven). Release-blocker Tier-1 drain gate: the
// session reached an "end" path but the durable screen-recording buffer still
// has pending (un-uploaded) chunks. We must NOT show the green "safe to exit"
// completion — this is the loud, truthful "your recording is NOT fully saved"
// state. It KEEPS the durable buffer intact and offers a Retry that re-kicks the
// drainer. The candidate must keep the tab open and contact their invigilator.
import { AlertTriangle, RefreshCw } from "lucide-react";

export function RecordingNotSavedPanel({
  pendingCount,
  busy,
  onRetry,
  proctorPhone
}: {
  pendingCount: number;
  busy: boolean;
  onRetry: () => void;
  proctorPhone?: string;
}) {
  return (
    <div className="mt-5 rounded-lg border-2 border-danger/60 bg-danger/5 p-5 shadow-subtle" role="alert">
      <div className="flex items-start gap-3">
        <AlertTriangle size={22} className="mt-0.5 shrink-0 text-danger" />
        <div className="min-w-0">
          <p className="text-base font-semibold text-danger">Your recording is NOT fully saved</p>
          <p className="mt-1.5 text-sm leading-6 text-ink">
            Some of your screen recording has not finished uploading
            {pendingCount > 0 ? ` (${pendingCount} segment${pendingCount === 1 ? "" : "s"} still pending)` : ""}.
            Do <span className="font-semibold">not</span> close this tab or exit fullscreen — keep this tab open and
            contact your invigilator
            {proctorPhone ? <> at <a className="font-medium underline" href={`tel:${proctorPhone}`}>{proctorPhone}</a></> : null}.
          </p>
          <p className="mt-2 text-xs leading-5 text-muted">
            Your recording is safely buffered on this device and will keep retrying. Press Retry to attempt the upload
            again now.
          </p>
        </div>
      </div>
      <div className="mt-4">
        <button
          className="focus-ring inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          onClick={onRetry}
          disabled={busy}
        >
          <RefreshCw size={16} className={busy ? "animate-spin" : undefined} /> {busy ? "Retrying…" : "Retry saving recording"}
        </button>
      </div>
    </div>
  );
}
