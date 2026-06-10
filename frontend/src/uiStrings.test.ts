// frontend/src/uiStrings.test.ts
//
// S-A CI GATE (F9 spec §5 stage S-A / F10 vision §7 row 1): the word
// "username" must never appear in USER-RENDERED frontend strings. The interim
// label is "Candidate ID" until the contest-driven identity_label arrives
// (S-C/S-D). This test scans frontend/src and FAILS listing file:line for
// every rendered occurrence of /username/i.
//
// SCAN SCOPE — precise by construction (TypeScript AST, not line regexes), so
// the gate is reliable rather than flaky:
//   1. jsx-text       JSX text nodes in .tsx files — anything React renders
//                     as visible text.
//   2. rendered-prop  String literals inside JSX props that render to the
//                     user: label / placeholder / title / aria-label / alt
//                     (covers ternaries and template-literal parts).
//   3. student-copy   ALL string literals in studentCopy.ts — that whole
//                     module is candidate-facing copy by contract.
//   4. prose-literal  Any string/template literal chunk anywhere in non-test
//                     source that contains /username/i AND whitespace — i.e.
//                     a sentence fragment. Catches confirm()s, toasts, error
//                     strings, and label arguments passed through helpers.
//
// EXEMPT by construction (NOT scanned): identifiers and variable names,
// comments, and bare wire-field tokens ("hackerrank_username",
// "username_norm", "usernames", "?username=" query keys) — none of these are
// whitespace-bearing string literals, JSX text, or rendered props.
//
// ALLOWLIST: exact-string escape hatch for an internal string that
// legitimately matches a scope above. Keep it TIGHT — every entry needs a
// reason — and prefer renaming the string over allowlisting it.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC_ROOT = path.dirname(fileURLToPath(import.meta.url));

const USERNAME = /username/i;
const RENDERED_PROPS = new Set(["label", "placeholder", "title", "aria-label", "alt"]);
const STUDENT_COPY_BASENAMES = new Set(["studentCopy.ts"]);

// { file: relative path, text: the EXACT literal text, reason: why it's OK }
const ALLOWLIST: ReadonlyArray<{ file: string; text: string; reason: string }> = [
  // (empty — rendered "username" strings were renamed to "Candidate ID" in S-A)
];

type Violation = { file: string; line: number; scope: string; text: string };

function isAllowed(file: string, text: string): boolean {
  return ALLOWLIST.some((entry) => entry.file === file && entry.text === text);
}

// Every raw text chunk of a string-ish literal: plain string, no-substitution
// template, or the head/middle/tail parts of a substitution template.
function literalChunks(node: ts.Node): string[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
  }
  return [];
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

// Scan ONE source text. Exported shape is (fileName, text) so the meta-test
// below can feed fixtures and prove the scanner actually detects violations.
export function scanSource(relFile: string, text: string): Violation[] {
  const violations: Violation[] = [];
  const kind = relFile.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(relFile, text, ts.ScriptTarget.Latest, true, kind);
  const isStudentCopy = STUDENT_COPY_BASENAMES.has(path.basename(relFile));

  const add = (node: ts.Node, scope: string, chunk: string) => {
    if (isAllowed(relFile, chunk)) return;
    violations.push({ file: relFile, line: lineOf(sourceFile, node), scope, text: chunk });
  };

  // Scope 2 helper: all literal chunks anywhere under a rendered prop's value.
  const literalChunksDeep = (node: ts.Node): Array<{ node: ts.Node; chunk: string }> => {
    const found: Array<{ node: ts.Node; chunk: string }> = [];
    const visit = (current: ts.Node) => {
      for (const chunk of literalChunks(current)) found.push({ node: current, chunk });
      current.forEachChild(visit);
    };
    visit(node);
    return found;
  };

  const visit = (node: ts.Node) => {
    // 1. JSX text nodes.
    if (ts.isJsxText(node) && USERNAME.test(node.text)) {
      add(node, "jsx-text", node.text.trim());
    }
    // 2. Rendered string props.
    if (ts.isJsxAttribute(node) && RENDERED_PROPS.has(node.name.getText(sourceFile)) && node.initializer) {
      for (const { node: literalNode, chunk } of literalChunksDeep(node.initializer)) {
        if (USERNAME.test(chunk)) add(literalNode, "rendered-prop", chunk);
      }
    }
    // 3. studentCopy.ts: every string literal is candidate-facing.
    // 4. Prose heuristic: a literal chunk with "username" AND whitespace.
    for (const chunk of literalChunks(node)) {
      if (!USERNAME.test(chunk)) continue;
      if (isStudentCopy) add(node, "student-copy", chunk);
      else if (/\s/.test(chunk)) add(node, "prose-literal", chunk);
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);

  // De-dupe (a studentCopy string with whitespace would otherwise double-report).
  const seen = new Set<string>();
  return violations.filter((v) => {
    const key = `${v.file}:${v.line}:${v.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (/\.test\.(ts|tsx)$/.test(entry.name)) continue;
    if (entry.name.endsWith(".d.ts")) continue;
    files.push(full);
  }
  return files;
}

function scanAll(): Violation[] {
  const violations: Violation[] = [];
  for (const file of sourceFiles(SRC_ROOT)) {
    const rel = path.relative(SRC_ROOT, file);
    violations.push(...scanSource(rel, readFileSync(file, "utf8")));
  }
  return violations;
}

describe("S-A username gate — no rendered 'username' strings in frontend/src", () => {
  it("finds zero rendered /username/i occurrences (interim label: Candidate ID)", () => {
    const formatted = scanAll().map(
      (v) => `${v.file}:${v.line} [${v.scope}] ${JSON.stringify(v.text.replace(/\s+/g, " ").trim().slice(0, 90))}`
    );
    expect(
      formatted,
      "Rendered 'username' strings found. Rename the LABEL to \"Candidate ID\" " +
        "(wire fields like hackerrank_username stay frozen until S-E). " +
        "Only allowlist a string if it is provably never rendered."
    ).toEqual([]);
  });

  // META-TEST: prove the scanner detects each scope, so an AST/API change can
  // never silently turn the gate into a no-op that passes vacuously.
  it("scanner self-check: detects planted violations in every scope", () => {
    const tsxFixture = [
      'export function Fixture({ x }: { x: string }) {',
      '  return (',
      '    <div title={x ? "Candidate username" : "ok"}>',
      '      <label aria-label="Your username here">Enter your HackerRank username</label>',
      '      <input placeholder="Search username, name, or room" />',
      '      {window.confirm("Approve this username now?") ? null : null}',
      '    </div>',
      '  );',
      '}'
    ].join("\n");
    const tsxScopes = scanSource("fixture.tsx", tsxFixture).map((v) => v.scope).sort();
    expect(tsxScopes).toContain("jsx-text");
    expect(tsxScopes).toContain("rendered-prop");
    expect(tsxScopes).toContain("prose-literal");

    const copyScopes = scanSource("studentCopy.ts", 'export const COPY = ["Suspicious username behavior", "username"];')
      .map((v) => v.scope);
    expect(copyScopes).toContain("student-copy");
    // single-word internal tokens stay exempt OUTSIDE studentCopy
    expect(scanSource("api.ts", 'const q = "username"; const wire = "hackerrank_username";')).toEqual([]);
    // template-literal prose is caught too
    expect(scanSource("App.tsx", "const msg = `Saved roster with ${1} username${\"s\"}.`;").map((v) => v.scope))
      .toContain("prose-literal");
  });
});
