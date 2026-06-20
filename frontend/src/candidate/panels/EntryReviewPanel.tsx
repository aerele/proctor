// frontend/src/candidate/panels/EntryReviewPanel.tsx
// Candidate leaf panel (extracted verbatim from App.tsx, F2). Props-driven.
import { ClipboardList, Cookie } from "lucide-react";

export function EntryReviewPanel({ clipboardAudit, tabAudit, cookieAudit }: { clipboardAudit: string; tabAudit: string; cookieAudit: string }) {
  return (
    <section className="rounded-lg border border-line bg-panel p-5">
      <div className="mb-4 flex items-center gap-2">
        <ClipboardList size={18} />
        <h2 className="font-semibold">Entry review files</h2>
      </div>
      <div className="space-y-4 text-sm">
        <div>
          <p className="font-medium">Tabs</p>
          <p className="mt-1 leading-6 text-muted">{tabAudit}</p>
        </div>
        <div>
          {/* M6: clipboard CONTENT is never snapshotted at entry — this only
              describes the in-exam monitoring scope, never any pasted text. */}
          <p className="font-medium">Clipboard</p>
          <p className="mt-1 leading-6 text-muted">{clipboardAudit}</p>
        </div>
        <div>
          <p className="flex items-center gap-2 font-medium"><Cookie size={15} /> Cookies and storage</p>
          <p className="mt-1 leading-6 text-muted">{cookieAudit}</p>
        </div>
      </div>
    </section>
  );
}
