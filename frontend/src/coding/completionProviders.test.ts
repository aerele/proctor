// frontend/src/coding/completionProviders.test.ts
//
// F12.3 — unit tests for the PURE data layer of the curated autocomplete.
// We do NOT test Monaco registration here (it needs a live editor); the
// registration glue is kept thin and the data kept pure precisely so this
// table can be tested in isolation.
import { describe, it, expect } from "vitest";
import {
  getCompletions,
  COMPLETION_LANGUAGES,
  type CompletionKind,
  type CompletionSpec,
} from "./completionProviders";

const VALID_KINDS = new Set<CompletionKind>(["function", "method", "class", "keyword", "module"]);

function labels(specs: CompletionSpec[]): Set<string> {
  return new Set(specs.map((s) => s.label));
}

describe("getCompletions — per-language curated lists", () => {
  it("returns a non-trivial list for each of the 4 languages", () => {
    for (const lang of COMPLETION_LANGUAGES) {
      const specs = getCompletions(lang);
      expect(specs.length, `${lang} should have a substantial list`).toBeGreaterThan(20);
    }
  });

  it("returns an empty list for an unknown language (no crash)", () => {
    expect(getCompletions("rust")).toEqual([]);
    expect(getCompletions("")).toEqual([]);
  });

  it("every spec has valid kind and non-empty label/insertText/detail", () => {
    for (const lang of COMPLETION_LANGUAGES) {
      for (const s of getCompletions(lang)) {
        expect(VALID_KINDS.has(s.kind), `${lang}:${s.label} kind ${s.kind}`).toBe(true);
        expect(s.label.length, `${lang} label`).toBeGreaterThan(0);
        expect(s.insertText.length, `${lang}:${s.label} insertText`).toBeGreaterThan(0);
        expect(s.detail.length, `${lang}:${s.label} detail`).toBeGreaterThan(0);
      }
    }
  });

  it("has no duplicate labels within a language", () => {
    for (const lang of COMPLETION_LANGUAGES) {
      const specs = getCompletions(lang);
      expect(labels(specs).size, `${lang} should have unique labels`).toBe(specs.length);
    }
  });

  it("python covers builtins, math, collections, itertools, heapq, bisect, sys", () => {
    const py = labels(getCompletions("python"));
    for (const anchor of [
      "input", "print", "sorted", "enumerate", "range", "len", "sum", "min", "max", "abs",
      "sqrt", "gcd", "factorial", "ceil", "floor", "hypot",
      "deque", "Counter", "defaultdict", "OrderedDict",
      "permutations", "combinations", "product", "accumulate",
      "heappush", "heappop", "heapify", "nlargest", "nsmallest",
      "bisect_left", "bisect_right", "insort",
      "setrecursionlimit", "ascii_lowercase",
    ]) {
      expect(py.has(anchor), `python missing ${anchor}`).toBe(true);
    }
  });

  it("cpp covers containers, <algorithm>, member ops, io", () => {
    const cpp = labels(getCompletions("cpp"));
    for (const anchor of [
      "vector", "map", "unordered_map", "set", "unordered_set", "pair", "queue", "stack",
      "priority_queue", "string",
      "sort", "lower_bound", "upper_bound", "max_element", "min_element", "accumulate",
      "reverse", "unique", "__gcd",
      "push_back", "pop_back", "begin", "end", "size", "empty", "find", "count",
      "cin", "cout", "getline",
    ]) {
      expect(cpp.has(anchor), `cpp missing ${anchor}`).toBe(true);
    }
  });

  it("java covers java.util, io, common methods", () => {
    const java = labels(getCompletions("java"));
    for (const anchor of [
      "Scanner", "ArrayList", "HashMap", "HashSet", "TreeMap", "TreeSet", "Collections",
      "Arrays", "PriorityQueue", "Deque",
      "System.out.println", "BufferedReader",
      "add", "get", "put", "containsKey", "size",
    ]) {
      expect(java.has(anchor), `java missing ${anchor}`).toBe(true);
    }
  });

  it("javascript covers Array methods, Math, string methods, globals", () => {
    const js = labels(getCompletions("javascript"));
    for (const anchor of [
      "push", "pop", "map", "filter", "reduce", "sort", "slice", "splice", "indexOf", "includes",
      "max", "min", "floor", "ceil", "abs", "sqrt", "pow",
      "split", "charCodeAt", "padStart",
      "console.log", "parseInt",
    ]) {
      expect(js.has(anchor), `javascript missing ${anchor}`).toBe(true);
    }
  });
});
