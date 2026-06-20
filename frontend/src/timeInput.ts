// frontend/src/timeInput.ts
// Date <-> <input type="datetime-local"> conversion helpers, extracted from
// App.tsx (F3) so ExamTimeCard (admin/views) can use localInputToIso without an
// App.tsx ↔ view import cycle.

export function isoToLocalInput(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

export function localInputToIso(value: string) {
  if (!value) return "";
  return new Date(value).toISOString();
}
