// frontend/src/roster/parseRoster.test.ts — pure logic, vitest (like coding/editorEvents.test.ts)
import { describe, it, expect } from "vitest";
import { detectDelimiter, parseRoster, splitDelimitedLine, suggestMapping } from "./parseRoster";

describe("detectDelimiter", () => {
  it("picks comma for CSV headers", () => expect(detectDelimiter("Roll No,Name,Email")).toBe(","));
  it("picks tab for Excel-paste TSV", () => expect(detectDelimiter("Roll No\tName\tEmail")).toBe("\t"));
  it("picks semicolon for EU-locale CSV", () => expect(detectDelimiter("Roll No;Name;Email")).toBe(";"));
});

describe("splitDelimitedLine", () => {
  it("keeps commas inside quoted cells and unescapes doubled quotes", () => {
    expect(splitDelimitedLine('"Raman, Asha",21CS001,"He said ""hi"""', ",")).toEqual([
      "Raman, Asha", "21CS001", 'He said "hi"'
    ]);
  });
});

describe("parseRoster", () => {
  it("parses a quoted CSV with BOM and blank lines into columns/rows", () => {
    const text = '\uFEFFRoll No,Student Name,Email\n21CS001,"Raman, Asha",asha@example.com\n\n21CS002,Vivek,vivek@example.com\n';
    const result = parseRoster(text);
    expect(result.columns).toEqual(["Roll No", "Student Name", "Email"]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]["Student Name"]).toBe("Raman, Asha");
    expect(result.errors).toEqual([]);
  });
  it("reports ragged rows but keeps the padded data", () => {
    const result = parseRoster("A,B\n1\n2,3");
    expect(result.errors).toHaveLength(1);
    expect(result.rows).toEqual([{ A: "1", B: "" }, { A: "2", B: "3" }]);
  });
  it("names blank headers and de-dupes duplicate headers", () => {
    const result = parseRoster("Name,,Name\nx,y,z");
    expect(result.columns[1]).toBe("Column 2");
    expect(result.columns[2]).not.toBe("Name");
  });
  it("returns an error for an empty file", () => {
    expect(parseRoster("  \n ").errors[0]).toMatch(/empty/i);
  });
});

describe("suggestMapping", () => {
  it("maps the common college headers and prefers roll number as the unique id", () => {
    const { mapping, uniqueIdColumn } = suggestMapping([
      "S.No", "Register Number", "Student Name", "Email ID", "HackerRank Username", "Room"
    ]);
    expect(mapping.roll_number).toBe("Register Number");
    expect(mapping.name).toBe("Student Name");
    expect(mapping.email).toBe("Email ID");
    expect(mapping.hackerrank_username).toBe("HackerRank Username");
    expect(mapping.room).toBe("Room");
    expect(uniqueIdColumn).toBe("Register Number");
  });
  it("falls back to email, then the first column, for the unique id", () => {
    expect(suggestMapping(["Email", "Name"]).uniqueIdColumn).toBe("Email");
    expect(suggestMapping(["Foo", "Bar"]).uniqueIdColumn).toBe("Foo");
  });
  // S-C: the COMPULSORY college column (vision §2.8) auto-maps from common headers.
  it("maps college/institution headers onto the college field", () => {
    expect(suggestMapping(["College", "Roll No", "Name"]).mapping.college).toBe("College");
    expect(suggestMapping(["Institution Name", "Roll No", "Name"]).mapping.college).toBe("Institution Name");
    // The college pattern claims its column BEFORE the broad /name/ pattern.
    expect(suggestMapping(["College Name", "Roll No", "Student Name"]).mapping.name).toBe("Student Name");
  });
  // F8.3: an explicit unique-ID header (the roster template ships one) beats
  // the roll-number/email fallbacks — but a mere "id" SUBSTRING must not
  // (e.g. "Candidate" contains "id").
  it("prefers an explicit unique-id column over roll number / email", () => {
    expect(suggestMapping(["unique_id", "name", "roll_number", "email", "room"]).uniqueIdColumn).toBe("unique_id");
    expect(suggestMapping(["Roll No", "Unique ID", "Name"]).uniqueIdColumn).toBe("Unique ID");
    expect(suggestMapping(["ID", "Email"]).uniqueIdColumn).toBe("ID");
    expect(suggestMapping(["Candidate", "Register Number"]).uniqueIdColumn).toBe("Register Number");
  });
});
