// frontend/src/csvField.test.ts
//
// M8 (CSV formula injection): admin exports (buildDetailsCsv / buildReviewsCsv)
// run candidate-controlled cells — name, HackerRank username — through csvField.
// A cell starting with = + - @ (or a leading tab / carriage return some apps
// strip before re-checking) executes as a formula when the CSV is opened in
// Excel or Google Sheets. csvField must prefix any such cell with a single
// quote (') so the spreadsheet treats it as literal text, while still applying
// RFC-4180 quoting for embedded commas / quotes / newlines.
import { describe, it, expect } from "vitest";
import { csvField } from "./App";

describe("csvField — formula-injection neutralization (M8)", () => {
  it("prefixes a leading = with a single quote", () => {
    expect(csvField("=cmd()")).toBe("'=cmd()");
  });

  it("prefixes the other dangerous leading characters + - @", () => {
    expect(csvField("+1+1")).toBe("'+1+1");
    expect(csvField("-2+3")).toBe("'-2+3");
    expect(csvField("@SUM(A1)")).toBe("'@SUM(A1)");
  });

  it("prefixes leading tab and carriage return (strip-then-evaluate vectors)", () => {
    // Tab is not an RFC-4180 quote trigger, so the prefixed cell stays unquoted;
    // the leading ' alone already defuses the formula.
    expect(csvField("\t=evil()")).toBe("'\t=evil()");
    // CR IS a quote trigger, so the prefixed cell is also wrapped in quotes.
    expect(csvField("\r=evil()")).toBe("\"'\r=evil()\"");
  });

  it("a dangerous-leading cell that also needs RFC-4180 quoting gets both", () => {
    // "=HYPERLINK(\"x\")" → prefix ' then wrap in quotes, doubling the inner quotes.
    expect(csvField('=HYPERLINK("x")')).toBe("\"'=HYPERLINK(\"\"x\"\")\"");
  });

  it("leaves a normal username untouched", () => {
    expect(csvField("alice_99")).toBe("alice_99");
  });

  it("does not prefix when the dangerous character is not leading", () => {
    expect(csvField("a=b")).toBe("a=b");
    expect(csvField("user-name")).toBe("user-name");
  });

  it("still applies RFC-4180 quoting for embedded comma / quote / newline", () => {
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('he said "hi"')).toBe('"he said ""hi"""');
    expect(csvField("line1\nline2")).toBe('"line1\nline2"');
  });

  it("leaves an empty cell empty", () => {
    expect(csvField("")).toBe("");
  });
});
