// F8.3 — roster template CSV download. The template must round-trip through the
// S2 parser (parseRoster + suggestMapping) with zero manual fixing: compulsory
// headers first, optional after, two plausible example rows, and every header
// auto-mapped to the right roster field on re-upload.
import { describe, expect, it } from "vitest";
import { parseRoster, suggestMapping } from "./parseRoster";
import { ROSTER_TEMPLATE_COLUMNS, buildRosterTemplateCsv } from "./rosterTemplate";

describe("ROSTER_TEMPLATE_COLUMNS", () => {
  it("lists the compulsory columns (unique_id, name) FIRST, then the optional ones", () => {
    expect(ROSTER_TEMPLATE_COLUMNS.map((column) => column.header)).toEqual([
      "unique_id",
      "name",
      "roll_number",
      "email",
      "room"
    ]);
    expect(ROSTER_TEMPLATE_COLUMNS.filter((column) => column.required).map((column) => column.header)).toEqual([
      "unique_id",
      "name"
    ]);
  });
});

describe("buildRosterTemplateCsv", () => {
  it("emits the headers plus two example rows", () => {
    const lines = buildRosterTemplateCsv().split(/\r\n|\r|\n/).filter((line) => line.trim() !== "");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("unique_id,name,roll_number,email,room");
  });

  it("round-trips through parseRoster with no errors and full cells", () => {
    const parsed = parseRoster(buildRosterTemplateCsv());
    expect(parsed.errors).toEqual([]);
    expect(parsed.columns).toEqual(ROSTER_TEMPLATE_COLUMNS.map((column) => column.header));
    expect(parsed.rows).toHaveLength(2);
    for (const row of parsed.rows) {
      for (const column of parsed.columns) expect(row[column]).not.toBe("");
    }
  });

  it("re-uploads cleanly: suggestMapping picks unique_id as the ID column and maps every optional field", () => {
    const parsed = parseRoster(buildRosterTemplateCsv());
    const { mapping, uniqueIdColumn } = suggestMapping(parsed.columns);
    expect(uniqueIdColumn).toBe("unique_id");
    expect(mapping.name).toBe("name");
    expect(mapping.roll_number).toBe("roll_number");
    expect(mapping.email).toBe("email");
    expect(mapping.room).toBe("room");
    // No header may be claimed by the (deprecated) HackerRank-username pattern.
    expect(mapping.hackerrank_username).toBeUndefined();
  });
});
