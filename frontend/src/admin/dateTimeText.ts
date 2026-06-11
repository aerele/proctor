// frontend/src/admin/dateTimeText.ts
// M0 (E2E finding #8): the native datetime-local input's segmented field
// resists typed and programmatic entry — only the calendar popover worked.
// Admin datetime fields are now a plain TEXT input backed by these pure
// parsers (DateTimeField.tsx), with the native calendar one button away.
//
// The exchange format stays the canonical datetime-local string
// ("YYYY-MM-DDTHH:mm", LOCAL time, no timezone suffix) the surrounding forms
// already store and convert via isoToLocalInput/localInputToIso.

// Year-first: "2026-06-12 09:30", "2026-06-12T09:30", optional ":ss" ignored.
const YEAR_FIRST = /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::\d{2})?(?:\s*([ap]m))?$/i;
// Day-first: "12/06/2026 09:30", "12-06-2026 9.30 pm", "12.06.2026, 21:30" —
// unambiguous because the 4-digit year comes LAST (this audience writes
// dates day-first; US month-first input is NOT accepted to avoid silent swaps).
const DAY_FIRST = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})[,\s]+(\d{1,2})[:.](\d{2})(?:\s*([ap]m))?$/i;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function build(year: number, month: number, day: number, hourRaw: number, minute: number, ampm: string | undefined): string | null {
  let hour = hourRaw;
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    if (ampm.toLowerCase() === "pm" && hour !== 12) hour += 12;
    if (ampm.toLowerCase() === "am" && hour === 12) hour = 0;
  }
  if (hour > 23 || minute > 59) return null;
  // Date round-trip rejects out-of-range day/month (e.g. 31/02, month 13).
  const date = new Date(year, month - 1, day, hour, minute);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
}

/**
 * Lenient typed-datetime parser → canonical "YYYY-MM-DDTHH:mm" (local), or
 * null when the text is not (yet) a complete valid datetime.
 */
export function parseDateTimeText(raw: string): string | null {
  const text = raw.trim().replace(/\s+/g, " ");
  if (!text) return null;
  let match = YEAR_FIRST.exec(text);
  if (match) {
    return build(Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]), match[6]);
  }
  match = DAY_FIRST.exec(text);
  if (match) {
    return build(Number(match[3]), Number(match[2]), Number(match[1]), Number(match[4]), Number(match[5]), match[6]);
  }
  return null;
}

/** Canonical "YYYY-MM-DDTHH:mm" → the display form "YYYY-MM-DD HH:mm". */
export function formatDateTimeText(localInput: string): string {
  return localInput ? localInput.slice(0, 16).replace("T", " ") : "";
}

/**
 * F10 (E2E live): canonical echo for a finished edit (field blur / save).
 * A parseable text snaps to the canonical display form
 * ("12/06/2026 9:30 pm" → "2026-06-12 21:30"); blank or incomplete text is
 * returned UNCHANGED so a draft the admin is still fixing never gets clobbered.
 * Deliberately NOT applied while typing — mid-edit normalization would rewrite
 * "12/06/2026 9:30" under the admin's cursor before they add " pm".
 */
export function normalizeDateTimeText(raw: string): string {
  const parsed = parseDateTimeText(raw);
  return parsed === null ? raw : formatDateTimeText(parsed);
}
