// frontend/src/ui/ActionTooltip.tsx
// Domain-free presentational primitive (extracted from App.tsx, F1). CSS-only
// hover/focus tooltip wrapper for action buttons.
import type React from "react";

// F6.4: design-system hover tooltip (CSS-only, shows on hover AND keyboard
// focus). Every action button is wrapped in one so the plain-language
// explanation from SESSION_ACTION_INFO / ALERT_ACTION_INFO is one hover away.
export function ActionTooltip({ tip, children }: { tip: string; children: React.ReactNode }) {
  return (
    <span className="group relative inline-flex">
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1.5 w-60 -translate-x-1/2 rounded-md bg-ink px-3 py-2 text-xs font-normal leading-5 text-white opacity-0 shadow-subtle transition-opacity duration-100 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {tip}
      </span>
    </span>
  );
}
