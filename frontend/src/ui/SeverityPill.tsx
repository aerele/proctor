// frontend/src/ui/SeverityPill.tsx
// Domain-free presentational primitive (extracted from App.tsx, F1). Renders an
// alert severity badge.
import type { AlertSeverity } from "../types";

const severityStyles: Record<AlertSeverity, string> = {
  critical: "border-danger/30 bg-danger/10 text-danger",
  warning: "border-warning/30 bg-warning/10 text-warning",
  info: "border-accent/30 bg-accent/10 text-accent"
};

export function SeverityPill({ severity }: { severity: AlertSeverity }) {
  return <span className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wide ${severityStyles[severity]}`}>{severity}</span>;
}
