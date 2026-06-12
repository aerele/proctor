// frontend/src/problems/problemDraft.ts
// Pure form-state logic for the admin problem editor: draft <-> doc mapping and
// client-side validation MIRRORING backend validateProblemInput bounds (the
// backend stays the authority). No React; vitest-covered.
import type { ProblemDoc, ProblemLanguage, ProblemScoring, ProblemStatus, ProblemTest, StatementFormat } from "../types";

export const PROBLEM_LANGUAGES: ProblemLanguage[] = ["python", "cpp", "java", "javascript", "sql"];
export const PROBLEM_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Numeric fields are kept as STRINGS in the draft (raw <input> values) and
// parsed at validate/serialize time.
export type ProblemDraft = {
  id: string;
  title: string;
  statement: string;
  /** W6: statement render format — "plain" (default) or "markdown". Serialized
   * to the doc ONLY when markdown (absent field == plain, back-compat). */
  statementFormat: StatementFormat;
  languages: ProblemLanguage[];
  cpuTimeLimit: string;
  memoryLimit: string;
  points: string;
  scoring: ProblemScoring;
  status: ProblemStatus;
  /** F12.2: per-language starter stubs, kept as a full keyed map of raw
   * <textarea> strings (blank = no stub for that language). Serialized to the
   * doc with the blanks dropped. */
  stubs: Record<ProblemLanguage, string>;
  sampleTests: ProblemTest[];
  hiddenTests: ProblemTest[];
};

function emptyStubs(): Record<ProblemLanguage, string> {
  return { python: "", cpp: "", java: "", javascript: "", sql: "" };
}

// F12.2: lift a doc's sparse stubs map into the full keyed draft map (missing
// languages become blank textareas).
function stubsFromDoc(stubs: ProblemDoc["stubs"]): Record<ProblemLanguage, string> {
  const draft = emptyStubs();
  if (stubs) {
    for (const lang of PROBLEM_LANGUAGES) {
      const value = stubs[lang];
      if (typeof value === "string") draft[lang] = value;
    }
  }
  return draft;
}

export function emptyProblemDraft(): ProblemDraft {
  return {
    id: "", title: "", statement: "", statementFormat: "plain",
    languages: [...PROBLEM_LANGUAGES],
    cpuTimeLimit: "5", memoryLimit: "128000", points: "100",
    scoring: "per_test", status: "draft",
    stubs: emptyStubs(),
    sampleTests: [{ input: "", expected: "" }],
    hiddenTests: [{ input: "", expected: "" }]
  };
}

export function draftFromDoc(doc: ProblemDoc): ProblemDraft {
  return {
    id: doc.id, title: doc.title, statement: doc.statement,
    // W6: docs without the field (every pre-W6 problem) edit as plain.
    statementFormat: doc.statement_format === "markdown" ? "markdown" : "plain",
    languages: [...doc.languages],
    cpuTimeLimit: String(doc.cpuTimeLimit), memoryLimit: String(doc.memoryLimit), points: String(doc.points),
    scoring: doc.scoring, status: doc.status,
    stubs: stubsFromDoc(doc.stubs),
    sampleTests: doc.sampleTests.map((t) => ({ ...t })),
    hiddenTests: doc.hiddenTests.map((t) => ({ ...t }))
  };
}

// F12.2: collapse the full keyed draft map back to a sparse doc map — blank
// stubs are dropped so a stub-less problem stays byte-identical (no `stubs`
// field at all, mirroring the backend's empty-map-is-absent rule).
export function stubsToDoc(stubs: Record<ProblemLanguage, string>): ProblemDoc["stubs"] {
  const out: Partial<Record<ProblemLanguage, string>> = {};
  for (const lang of PROBLEM_LANGUAGES) {
    if (stubs[lang] !== "") out[lang] = stubs[lang];
  }
  return Object.keys(out).length ? out : undefined;
}

function validateTests(tests: ProblemTest[], max: number, label: string): string | null {
  if (!tests.length) return `${label} tests: add at least one.`;
  if (tests.length > max) return `${label} tests: max ${max}.`;
  for (const [index, t] of tests.entries()) {
    if (t.input.length > 10000 || t.expected.length > 10000) {
      return `${label} test ${index + 1}: input/expected max 10000 characters.`;
    }
  }
  return null;
}

// First validation error, or null when the draft is saveable.
export function validateProblemDraft(d: ProblemDraft): string | null {
  if (!PROBLEM_ID_PATTERN.test(d.id)) return "ID must be 1-64 lowercase letters/digits/hyphens.";
  if (!d.title.trim()) return "Title is required.";
  if (d.title.trim().length > 200) return "Title: max 200 characters.";
  if (!d.statement.trim()) return "Statement is required.";
  if (d.statement.length > 20000) return "Statement: max 20000 characters.";
  if (!d.languages.length) return "Pick at least one language.";
  const cpu = Number(d.cpuTimeLimit);
  if (!Number.isFinite(cpu) || cpu < 0.5 || cpu > 15) return "CPU time limit must be 0.5-15 seconds.";
  const mem = Number(d.memoryLimit);
  if (!Number.isInteger(mem) || mem < 16000 || mem > 512000) return "Memory limit must be an integer 16000-512000 KB.";
  const points = Number(d.points);
  if (!Number.isInteger(points) || points < 0 || points > 1000) return "Points must be an integer 0-1000.";
  const sampleError = validateTests(d.sampleTests, 10, "Sample");
  if (sampleError) return sampleError;
  return validateTests(d.hiddenTests, 50, "Hidden");
}

// Serialize a VALIDATED draft into the API payload. `stubs` is omitted entirely
// when every language is blank (back-compat: a stub-less problem is identical
// to today).
export function draftToDoc(d: ProblemDraft): ProblemDoc {
  const stubs = stubsToDoc(d.stubs);
  return {
    id: d.id, title: d.title.trim(), statement: d.statement,
    languages: [...d.languages],
    cpuTimeLimit: Number(d.cpuTimeLimit), memoryLimit: Number(d.memoryLimit), points: Number(d.points),
    scoring: d.scoring, status: d.status,
    ...(stubs ? { stubs } : {}),
    // W6: omit when plain — mirrors the backend's absent-field == plain rule.
    ...(d.statementFormat === "markdown" ? { statement_format: "markdown" as const } : {}),
    sampleTests: d.sampleTests.map((t) => ({ ...t })),
    hiddenTests: d.hiddenTests.map((t) => ({ ...t }))
  };
}
