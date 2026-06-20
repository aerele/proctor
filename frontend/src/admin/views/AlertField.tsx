// frontend/src/admin/views/AlertField.tsx
// Shared admin label/value field (used by SessionDetailCard + AlertRow),
// extracted verbatim from App.tsx (F3).
export function AlertField({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line pb-1.5 last:border-0">
      <span className="text-xs uppercase tracking-wide text-muted">{label}</span>
      <span className={`truncate font-medium ${mono ? "font-mono text-xs" : ""}`}>{value}</span>
    </div>
  );
}
