// frontend/src/ui/StatusPill.tsx
// Domain-free presentational primitive (extracted from App.tsx, F1). Renders a
// session status badge.
import type { SessionStatus } from "../types";

export function StatusPill({ status }: { status: SessionStatus }) {
  const styles: Record<SessionStatus, string> = {
    idle: "border-line bg-white text-muted",
    starting: "border-warning/30 bg-warning/10 text-warning",
    recording: "border-accent/30 bg-accent/10 text-accent",
    ending: "border-warning/30 bg-warning/10 text-warning",
    // Tier-1: the end-of-test drain wait — same warning styling as "ending".
    ending_draining: "border-warning/30 bg-warning/10 text-warning",
    ended: "border-accent/30 bg-accent/10 text-accent",
    error: "border-danger/30 bg-danger/10 text-danger"
  };
  return <span className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase ${styles[status]}`}>{status}</span>;
}
