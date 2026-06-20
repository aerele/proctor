// frontend/src/candidate/panels/EndTestPanel.tsx
// Candidate leaf panel (extracted verbatim from App.tsx, F2). Props-driven.
import { Square } from "lucide-react";
import * as studentCopy from "../../studentCopy";

export function EndTestPanel({ assuranceAccepted, hasProblem, onAssuranceChange, onCancel, onEnd }: { assuranceAccepted: boolean; hasProblem: boolean; onAssuranceChange: (value: boolean) => void; onCancel: () => void; onEnd: () => void }) {
  return (
    <div className="mt-5 rounded-lg border border-danger/30 bg-danger/10 p-4">
      <p className="text-sm font-semibold text-danger">End test confirmation</p>
      <p className="mt-1 text-sm leading-6 text-ink">{studentCopy.endTestConfirmation(hasProblem)}</p>
      <label className="mt-4 flex gap-3 rounded-md border border-line bg-white/70 p-3 text-sm leading-6 text-muted">
        <input className="mt-1 h-4 w-4 accent-danger" type="checkbox" checked={assuranceAccepted} onChange={(event) => onAssuranceChange(event.target.checked)} />
        <span>I assure that I worked independently, did not copy, did not use AI/external help, and submitted only my own solution.</span>
      </label>
      <div className="mt-4 flex flex-wrap gap-3">
        <button className="focus-ring inline-flex items-center gap-2 rounded-md bg-danger px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50" disabled={!assuranceAccepted} onClick={onEnd}>
          <Square size={16} /> End and close session
        </button>
        <button className="focus-ring rounded-md border border-line px-4 py-2 text-sm font-medium" onClick={onCancel}>
          Continue test
        </button>
      </div>
    </div>
  );
}
