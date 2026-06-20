// frontend/src/ui/Field.tsx
// Domain-free presentational primitive (extracted from App.tsx, F1). No api
// calls, no domain state — labelled text input with autofill suppression.
import type React from "react";
import { autofillSuppressionProps } from "../shell/autofill";

export function Field({ label, value, onChange, type = "text", disabled = false, inputMode }: { label: string; value: string; onChange: (value: string) => void; type?: string; disabled?: boolean; inputMode?: React.ComponentProps<"input">["inputMode"] }) {
  // F12.1: spread the autofill-suppression set so Chrome's email/address popup
  // (which drops fullscreen) can never fire on focus. See shell/autofill.ts.
  return (
    <label className="block">
      <span className="text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
      <input className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-3 text-sm disabled:bg-neutral-100" type={type} inputMode={inputMode} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} {...autofillSuppressionProps(label)} />
    </label>
  );
}
