// F8.3 — roster template CSV (client-side download, no IO here). The headers
// are EXACTLY the roster field names the S2 upload pipeline accepts (backend
// ROSTER_MAPPABLE_FIELDS minus the deprecated hackerrank_username — F8.2 drops
// HackerRank entirely), ordered compulsory-first, so a filled template
// re-uploads with every column auto-mapped and unique_id pre-picked as the ID
// column (suggestMapping prefers an explicit unique-id header).
export type RosterTemplateColumn = {
  header: string;
  required: boolean;
};

export const ROSTER_TEMPLATE_COLUMNS: RosterTemplateColumn[] = [
  { header: "unique_id", required: true },
  { header: "name", required: true },
  { header: "roll_number", required: false },
  { header: "email", required: false },
  { header: "room", required: false }
];

// Two plausible example rows so colleges see the expected shape (the roll
// number doubling as the unique id is the common case). Values stay free of
// commas/quotes — the template needs no RFC-4180 escaping.
const EXAMPLE_ROWS: string[][] = [
  ["23BCS101", "Arav Menon", "23BCS101", "arav.menon@example.edu", "Lab A-1"],
  ["23BEC042", "Divya Pillai", "23BEC042", "divya.p@example.edu", "Lab B-2"]
];

/** The downloadable template: header line + 2 example rows (CRLF for Excel). */
export function buildRosterTemplateCsv(): string {
  const lines = [ROSTER_TEMPLATE_COLUMNS.map((column) => column.header).join(",")];
  for (const row of EXAMPLE_ROWS) lines.push(row.join(","));
  return lines.join("\r\n") + "\r\n";
}
