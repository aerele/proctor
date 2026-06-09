// backend/src/problems.mjs
// Slice 1 ships ONE problem as config. Problem authoring is Slice 2.
// NOTE: verify language_ids against the live instance via GET /languages before a real run;
// these are the common Judge0 CE ids.
export const LANGUAGE_IDS = { python: 71, cpp: 54, java: 62, javascript: 63 };

const PROBLEMS = {
  "sum-two": {
    id: "sum-two",
    title: "Sum of Two Numbers",
    statement: "Read two integers a and b on one line separated by a space. Print a + b.",
    languages: ["python", "cpp", "java", "javascript"],
    cpuTimeLimit: 5, memoryLimit: 128000,
    sampleTests: [
      { input: "2 3\n", expected: "5" },
      { input: "10 20\n", expected: "30" }
    ],
    hiddenTests: [
      { input: "0 0\n", expected: "0" },
      { input: "-5 5\n", expected: "0" },
      { input: "1000000 1\n", expected: "1000001" },
      { input: "-100 -200\n", expected: "-300" }
    ]
  }
};

export function getProblem(id) {
  // Own-key check: a prototype key like "constructor" indexes Object.prototype
  // and would pass a truthiness test, returning a function → 500 in handlers.
  return Object.hasOwn(PROBLEMS, id) ? PROBLEMS[id] : null;
}
