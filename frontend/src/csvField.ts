// frontend/src/csvField.ts
//
// M8 (CSV formula injection): admin exports run candidate-controlled cells
// (name, candidate ID, roll number, room) through csvField. A cell starting with
// = + - @ — or a leading tab / carriage return some apps strip before
// re-checking — executes as a formula when the export is opened in Excel/Sheets.
// Prefix any such cell with a single quote (') so the spreadsheet treats it as
// literal text, THEN apply RFC-4180 quoting (wrap in quotes + double embedded
// quotes for comma/quote/CR/LF). Null-guarded so a null/undefined cell never
// throws.
export function csvField(value: string): string {
  let v = String(value ?? "");
  if (v && /^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}
