// frontend/src/ui/StatCard.tsx
// Domain-free presentational primitive (extracted from App.tsx, F1). Tone-styled
// metric card; becomes a button when onClick is supplied.
import type React from "react";

export function StatCard({ label, value, tone, icon, onClick }: { label: string; value: number; tone: "accent" | "danger" | "warning" | "muted" | "ink"; icon: React.ReactNode; onClick?: () => void }) {
  const toneStyles: Record<typeof tone, string> = {
    accent: "border-accent/30 bg-accent/5 text-accent",
    danger: "border-danger/30 bg-danger/5 text-danger",
    warning: "border-warning/40 bg-warning/5 text-warning",
    muted: "border-line bg-white text-muted",
    ink: "border-ink/20 bg-ink/5 text-ink"
  };
  const inner = (
    <>
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide">{label}</span>
        {icon}
      </div>
      <p className="mt-3 text-3xl font-semibold text-ink">{value}</p>
    </>
  );
  // A2: clickable cards become buttons (cursor-pointer + hover ring); plain cards
  // keep the existing div. Tone styles are identical in both branches.
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`focus-ring block w-full cursor-pointer rounded-lg border p-5 text-left shadow-subtle transition hover:ring-2 hover:ring-ink/20 ${toneStyles[tone]}`}
      >
        {inner}
      </button>
    );
  }
  return <div className={`rounded-lg border p-5 shadow-subtle ${toneStyles[tone]}`}>{inner}</div>;
}
