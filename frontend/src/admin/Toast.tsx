// frontend/src/admin/Toast.tsx
// LT-10: a reusable, accessible FLOATING toast for admin error/success messages.
//
// Today these messages render inline at the TOP of a list and scroll out of view
// — a blocked delete ("Problem referenced") on the long Problem bank, or a save
// error on the long Contest detail, disappears the moment the operator scrolls to
// the row they were acting on. This pins the message to the viewport so it stays
// visible regardless of scroll.
//
// Design:
//  - ToastProvider mounts ONCE at the admin root (AdminApp) and renders a single
//    fixed viewport (top-center). useToast() gives any descendant showError /
//    showSuccess / dismiss. Provider + hook because the message sites are spread
//    across many panels and AdminApp already centralizes error/message state —
//    one container beats N local fixed divs fighting over z-index.
//  - Success auto-dismisses (transient confirmation); errors are STICKY and
//    manually dismissible (the operator must read a failure). Policy + the toast
//    list reducer are pure (./toastState) and unit-tested; this file owns only
//    the React/DOM/timer wiring.
//  - a11y: success ⇒ role="status" aria-live="polite"; error ⇒ role="alert"
//    aria-live="assertive". Each toast has a labelled dismiss button.
import { X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useReducer, useRef, type ReactNode } from "react";
import { autoDismissMs, makeToast, toastReducer, type Toast, type ToastKind } from "./toastState";

interface ToastApi {
  showSuccess: (message: string) => void;
  showError: (message: string) => void;
  dismiss: (id: string) => void;
  clear: () => void;
}

const ToastContext = createContext<ToastApi | null>(null);

// useToast() — the consumer hook. Throws if used outside a ToastProvider so a
// missing mount is a loud build/test failure, never a silently swallowed message.
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast must be used within a <ToastProvider>");
  return api;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, dispatch] = useReducer(toastReducer, []);
  // Track the live auto-dismiss timers so they're cleared on manual dismiss and
  // on unmount (no setState-after-unmount, no leaked timers across view changes).
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const clearTimer = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const dismiss = useCallback((id: string) => {
    clearTimer(id);
    dispatch({ type: "dismiss", id });
  }, [clearTimer]);

  const clear = useCallback(() => {
    timers.current.forEach((timer) => clearTimeout(timer));
    timers.current.clear();
    dispatch({ type: "clear" });
  }, []);

  const show = useCallback((kind: ToastKind, message: string) => {
    const toast = makeToast(kind, message);
    if (!toast) return; // blank/whitespace ⇒ no banner (cleared "" state).
    dispatch({ type: "add", toast });
    const ms = autoDismissMs(kind);
    if (ms !== null) {
      const timer = setTimeout(() => dismiss(toast.id), ms);
      timers.current.set(toast.id, timer);
    }
  }, [dismiss]);

  const showSuccess = useCallback((message: string) => show("success", message), [show]);
  const showError = useCallback((message: string) => show("error", message), [show]);

  // Clear every pending timer when the provider unmounts.
  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((timer) => clearTimeout(timer));
      map.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={{ showSuccess, showError, dismiss, clear }}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

// The pinned container. Fixed top-center, above the page chrome but BELOW the
// candidate enforcement overlay (z-[100]) by convention. pointer-events-none on
// the wrapper so the strip never blocks clicks on the page beneath the gap;
// each toast re-enables pointer events for its own dismiss button.
function ToastViewport({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  if (!toasts.length) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-4 z-50 flex flex-col items-center gap-2 px-4" aria-label="Notifications">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

const TONE: Record<ToastKind, string> = {
  success: "border-accent/30 bg-accent/10 text-accent",
  error: "border-danger/30 bg-danger/10 text-danger"
};

// Exported for static-markup tests (the repo has no jsdom, so the interactive
// provider can't be driven in a test; the presentational item's a11y wiring —
// role/aria-live per kind — is asserted directly).
export function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  const isError = toast.kind === "error";
  return (
    <div
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      className={`pointer-events-auto flex w-full max-w-xl items-start gap-3 rounded-lg border p-3 text-sm shadow-subtle ${TONE[toast.kind]}`}
    >
      <span className="min-w-0 flex-1 whitespace-pre-line break-words">{toast.message}</span>
      <button
        type="button"
        className="focus-ring -m-1 shrink-0 rounded-md p-1 opacity-70 hover:opacity-100"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
      >
        <X size={15} />
      </button>
    </div>
  );
}
