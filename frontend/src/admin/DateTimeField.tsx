// frontend/src/admin/DateTimeField.tsx
// M0 (E2E finding #8): admin datetime entry. The native datetime-local's
// segmented field resists typed and programmatic entry, so the primary
// control is a plain TEXT input (typing and test-tool fills just work) parsed
// by dateTimeText.ts; the native calendar popover stays one click away via a
// visually-hidden datetime-local + showPicker().
import { Calendar } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatDateTimeText, parseDateTimeText } from "./dateTimeText";

export function DateTimeField({ label, value, onChange, disabled = false, className = "" }: {
  /** Field caption; also names the calendar button for screen readers. */
  label?: string;
  /** Canonical datetime-local string ("YYYY-MM-DDTHH:mm") or "" (unset). */
  value: string;
  /** Receives the canonical string, or "" while the text is blank/incomplete. */
  onChange: (next: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [text, setText] = useState(() => formatDateTimeText(value));
  const pickerRef = useRef<HTMLInputElement>(null);

  // External value changes (form load, +15 min buttons, calendar picks in
  // another control) re-seed the text — but never clobber an in-progress edit
  // that already means the same value, or a not-yet-complete typed draft.
  useEffect(() => {
    setText((current) => {
      const parsed = current.trim() === "" ? "" : parseDateTimeText(current);
      if (parsed === value) return current;          // already in sync
      if (parsed === null && value === "") return current; // mid-edit draft; we reported "" ourselves
      return formatDateTimeText(value);
    });
  }, [value]);

  const handleText = (next: string) => {
    setText(next);
    onChange(next.trim() === "" ? "" : parseDateTimeText(next) ?? "");
  };

  // Calendar button → native popover on the hidden input. showPicker() needs
  // a user gesture (this click) and can throw in older browsers — fall back
  // to focusing the native input, whose keyboard popover shortcut still works.
  const openPicker = () => {
    const picker = pickerRef.current;
    if (!picker) return;
    try {
      (picker as HTMLInputElement & { showPicker?: () => void }).showPicker?.();
    } catch {
      picker.focus();
    }
  };

  const invalid = text.trim() !== "" && parseDateTimeText(text) === null;

  return (
    <label className={`block ${className}`}>
      {label ? <span className="text-xs font-medium uppercase tracking-wide text-muted">{label}</span> : null}
      <div className="relative mt-1 flex items-center gap-1.5">
        <input
          className={`focus-ring h-10 w-full rounded-md border bg-white px-3 text-sm disabled:bg-neutral-100 ${invalid ? "border-warning" : "border-line"}`}
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="YYYY-MM-DD HH:mm"
          value={text}
          disabled={disabled}
          onChange={(event) => handleText(event.target.value)}
        />
        <button
          type="button"
          className="focus-ring inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-line bg-white text-ink hover:border-ink/40 disabled:opacity-50"
          onClick={openPicker}
          disabled={disabled}
          title="Pick from calendar"
          aria-label={label ? `Pick ${label} from calendar` : "Pick from calendar"}
        >
          <Calendar size={15} />
        </button>
        {/* The native control survives ONLY as the calendar popover's anchor —
            invisible, out of the tab order, synced both ways. */}
        <input
          ref={pickerRef}
          type="datetime-local"
          className="pointer-events-none absolute bottom-0 right-0 h-px w-px opacity-0"
          tabIndex={-1}
          aria-hidden="true"
          value={value}
          disabled={disabled}
          onChange={(event) => {
            setText(formatDateTimeText(event.target.value));
            onChange(event.target.value);
          }}
        />
      </div>
      {invalid ? (
        <span className="mt-1 block text-xs text-warning">Could not read that — use YYYY-MM-DD HH:mm (24-hour), e.g. 2026-06-12 09:30.</span>
      ) : null}
    </label>
  );
}
