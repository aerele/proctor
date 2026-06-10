// S2 roster upload — pure CSV/TSV parsing + column-mapping heuristics.
// No React, no IO: the admin page reads the file, this module turns the text
// into {columns, rows} and suggests which column is which identity field.
// (Structurally identical to RosterColumnMapping in ../types — kept local so
// this pure module has zero app imports.)
export type RosterFieldMapping = {
  name?: string;
  email?: string;
  roll_number?: string;
  hackerrank_username?: string;
  room?: string;
};

export type ParsedRoster = {
  columns: string[];
  rows: Array<Record<string, string>>;
  errors: string[];
};

// Pick the delimiter that splits the header into the most cells: rosters come
// as comma CSV, Excel-paste TSV, or semicolon CSV (EU locales). Ties keep the
// earlier candidate, so a single-column file defaults to comma.
export function detectDelimiter(headerLine: string): string {
  const candidates = [",", "\t", ";"];
  let best = ",";
  let bestCount = 0;
  for (const candidate of candidates) {
    const count = splitDelimitedLine(headerLine, candidate).length;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

// RFC-4180-ish single-line splitter: quoted cells, embedded delimiters inside
// quotes, "" escapes. Embedded NEWLINES inside quotes are not supported (rare
// in rosters; such a file surfaces as ragged-row errors, not silent data loss).
export function splitDelimitedLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === "") {
      inQuotes = true;
    } else if (ch === delimiter) {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells.map((value) => value.trim());
}

export function parseRoster(text: string): ParsedRoster {
  const errors: string[] = [];
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r\n|\r|\n/)
    .filter((line) => line.trim() !== "");
  if (!lines.length) return { columns: [], rows: [], errors: ["The file is empty."] };

  const delimiter = detectDelimiter(lines[0]);
  const rawColumns = splitDelimitedLine(lines[0], delimiter);
  // Fill blank headers and de-dupe duplicates so every column has a stable,
  // unique name (rows are keyed by header).
  const seen = new Set<string>();
  const columns = rawColumns.map((name, index) => {
    let column = name || `Column ${index + 1}`;
    while (seen.has(column.toLowerCase())) column = `${column} (${index + 1})`;
    seen.add(column.toLowerCase());
    return column;
  });

  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitDelimitedLine(lines[i], delimiter);
    if (cells.length !== columns.length) {
      // Keep what we can (pad/truncate) — one ragged row must not kill the upload.
      errors.push(`Row ${i + 1}: expected ${columns.length} cells, got ${cells.length}.`);
    }
    const row: Record<string, string> = {};
    columns.forEach((column, c) => {
      row[column] = cells[c] ?? "";
    });
    if (Object.values(row).some((value) => value !== "")) rows.push(row); // skip fully-empty rows
  }
  return { columns, rows, errors };
}

// Header-name heuristics → suggested mapping. The admin can override every
// suggestion in the UI; these just save clicks on the common college formats.
// ORDER MATTERS: hackerrank/email/roll/room claim their columns BEFORE the
// broad /name/ pattern, so "Username"/"Student Name" resolve correctly.
const FIELD_PATTERNS: Array<{ field: keyof RosterFieldMapping; pattern: RegExp }> = [
  { field: "hackerrank_username", pattern: /hacker|user.?name|handle/i },
  { field: "email", pattern: /mail/i },
  { field: "roll_number", pattern: /roll|regist|reg\.?\s*no|admission/i },
  { field: "room", pattern: /room|lab|hall|venue/i },
  { field: "name", pattern: /name/i }
];

export function suggestMapping(columns: string[]): { mapping: RosterFieldMapping; uniqueIdColumn: string } {
  const mapping: RosterFieldMapping = {};
  const taken = new Set<string>();
  for (const { field, pattern } of FIELD_PATTERNS) {
    if (mapping[field]) continue;
    const match = columns.find((column) => !taken.has(column) && pattern.test(column));
    if (match) {
      mapping[field] = match;
      taken.add(match);
    }
  }
  // Unique-ID preference: an EXPLICIT unique-id header first (the F8.3 template
  // ships "unique_id"; whole-word "id"/"uid" count, but not a mere substring —
  // "Candidate" contains "id"), then roll/register number, email, first column.
  const explicitId = columns.find((column) => /unique|^\s*u?id\s*$/i.test(column));
  const uniqueIdColumn = explicitId || mapping.roll_number || mapping.email || columns[0] || "";
  return { mapping, uniqueIdColumn };
}
