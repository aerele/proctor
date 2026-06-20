// frontend/src/candidate/panels/BlockedScreen.tsx
// Candidate leaf panel (extracted verbatim from App.tsx, F2). Props-driven.
import type React from "react";
import { RefreshCw } from "lucide-react";

// Shared blocked-state screen for pending_approval and locked. Self-service:
// the student can re-check status without staff once a proctor acts.
export function BlockedScreen({ tone, icon, title, lines, onRefresh, error }: { tone: "warning" | "danger"; icon: React.ReactNode; title: string; lines: string[]; onRefresh: () => void; error: string }) {
  const toneStyles = tone === "danger" ? "border-danger/30 bg-danger/5 text-danger" : "border-warning/40 bg-warning/5 text-warning";
  return (
    <section className={`mx-auto max-w-xl rounded-lg border p-6 text-center shadow-subtle ${toneStyles}`}>
      <div className="mx-auto flex items-center justify-center">{icon}</div>
      <h1 className="mt-3 text-2xl font-semibold text-ink">{title}</h1>
      <div className="mt-3 space-y-2 text-sm leading-6 text-muted">
        {lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      <button className="focus-ring mt-5 inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-sm font-medium text-white" onClick={onRefresh}>
        <RefreshCw size={16} /> Check again
      </button>
      {error ? <div className="mt-4 rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{error}</div> : null}
    </section>
  );
}
