// frontend/src/admin/toastState.ts
// LT-10: pure state for the floating admin toast. The interactive bits
// (rendering, the setTimeout that auto-dismisses) live in Toast.tsx; everything
// that decides WHAT happens — the toast list reducer, the per-kind dismiss
// policy, the id generator — is pure and unit-tested here (the repo has no jsdom,
// so the testable logic must be free of the DOM/timers).

export type ToastKind = "success" | "error";

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
}

// Auto-dismiss policy. Success toasts are transient confirmations — they fade
// on their own so the operator is never left clearing chrome. Errors are
// STICKY: a blocked delete ("Problem referenced") or a failed save must stay on
// screen until the operator reads it and dismisses it, exactly the scroll-away
// bug LT-10 set out to kill. `null` ⇒ never auto-dismiss.
export const SUCCESS_DISMISS_MS = 5000;

export function autoDismissMs(kind: ToastKind): number | null {
  return kind === "success" ? SUCCESS_DISMISS_MS : null;
}

export function isAutoDismissed(kind: ToastKind): boolean {
  return autoDismissMs(kind) !== null;
}

// Monotonic id source so two toasts raised in the same millisecond never
// collide (Date.now() alone can). Module-scoped counter — the provider is a
// singleton at the admin root, so one sequence is enough.
let seq = 0;
export function nextToastId(): string {
  seq += 1;
  return `toast-${seq}`;
}

export type ToastAction =
  | { type: "add"; toast: Toast }
  | { type: "dismiss"; id: string }
  | { type: "clear" };

// Reducer over the live toast list. `add` appends (newest renders last/at the
// bottom of the stack); a same-kind duplicate of the message already on screen
// is COLLAPSED rather than stacked, so a retried action that re-raises the same
// error doesn't pile identical banners. `dismiss` drops one by id; `clear`
// empties the stack (used on view/context teardown).
export function toastReducer(state: Toast[], action: ToastAction): Toast[] {
  switch (action.type) {
    case "add": {
      const duplicate = state.some(
        (t) => t.kind === action.toast.kind && t.message === action.toast.message
      );
      if (duplicate) return state;
      return [...state, action.toast];
    }
    case "dismiss":
      return state.filter((t) => t.id !== action.id);
    case "clear":
      return state.length ? [] : state;
    default:
      return state;
  }
}

// Build a toast from a (kind, message). Blank/whitespace messages produce null
// — callers funnel cleared error/success state ("") through showError/showSuccess
// and an empty string must NOT raise an empty banner.
export function makeToast(kind: ToastKind, message: string): Toast | null {
  const text = message.trim();
  if (!text) return null;
  return { id: nextToastId(), kind, message: text };
}
