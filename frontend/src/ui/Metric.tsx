// frontend/src/ui/Metric.tsx
// Domain-free presentational primitive (extracted from App.tsx, F1). Labelled
// metric row used in candidate/admin detail panels.
import type React from "react";

export function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line pb-2 last:border-0 last:pb-0">
      <span className="flex items-center gap-2 text-muted">{icon}{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
