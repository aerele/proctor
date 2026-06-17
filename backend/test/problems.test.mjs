// backend/test/problems.test.mjs
// PURE unit tests of the problem bank module — no handler import, no env, no
// GCP. Store-less tests run FIRST; configureProblemStore is module-global and
// stays set for the rest of this file (own process, so no cross-file leakage).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  configureProblemStore, getBankProblem, getProblem, isValidProblemId,
  scoreSubmission, validateProblemInput, LANGUAGE_IDS
} from "../src/problems.mjs";

function makeFakeProblemFirestore(docs) {
  // docs: { "<collection>/<id>": data }
  return {
    collection(name) {
      return {
        doc(id) {
          return {
            async get() {
              const data = docs[`${name}/${id}`];
              return { exists: Boolean(data), data: () => data };
            }
          };
        }
      };
    }
  };
}

function validInput(overrides = {}) {
  return {
    id: "rev-str", title: "Reverse", statement: "Reverse the input line.",
    languages: ["python", "cpp"], cpuTimeLimit: 2, memoryLimit: 64000,
    points: 80, scoring: "per_test", status: "published",
    sampleTests: [{ input: "ab\n", expected: "ba" }],
    hiddenTests: [{ input: "xyz\n", expected: "zyx" }],
    ...overrides
  };
}

// ---- isValidProblemId -------------------------------------------------------

test("isValidProblemId: slugs pass, everything else fails", () => {
  assert.equal(isValidProblemId("sum-two"), true);
  assert.equal(isValidProblemId("a"), true);
  assert.equal(isValidProblemId("Bad_ID"), false);
  assert.equal(isValidProblemId(""), false);
  assert.equal(isValidProblemId("-leading-hyphen"), false);
  assert.equal(isValidProblemId("x".repeat(65)), false);
});

// ---- validateProblemInput ---------------------------------------------------

test("validateProblemInput: valid payload -> normalized allow-listed problem", () => {
  const r = validateProblemInput({ ...validInput(), evil: "dropped" });
  assert.equal(r.ok, true);
  assert.equal(r.problem.id, "rev-str");
  assert.equal(r.problem.evil, undefined); // never spread client input
  assert.deepEqual(r.problem.sampleTests, [{ input: "ab\n", expected: "ba" }]);
  assert.equal(r.problem.status, "published");
});

test("validateProblemInput: defaults applied (points 100, per_test, draft)", () => {
  const r = validateProblemInput(validInput({ points: undefined, scoring: undefined, status: undefined }));
  assert.equal(r.ok, true);
  assert.equal(r.problem.points, 100);
  assert.equal(r.problem.scoring, "per_test");
  assert.equal(r.problem.status, "draft");
});

test("validateProblemInput: languages de-duped, unknown language rejected", () => {
  const ok = validateProblemInput(validInput({ languages: ["python", "python"] }));
  assert.deepEqual(ok.problem.languages, ["python"]);
  const bad = validateProblemInput(validInput({ languages: ["python", "rust"] }));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /unsupported language/);
});

test("validateProblemInput: rejections carry specific errors", () => {
  assert.match(validateProblemInput(validInput({ id: "Bad_ID" })).error, /id/);
  assert.match(validateProblemInput(validInput({ title: "  " })).error, /title/);
  assert.match(validateProblemInput(validInput({ statement: "x".repeat(20001) })).error, /statement/);
  assert.match(validateProblemInput(validInput({ languages: [] })).error, /languages/);
  assert.match(validateProblemInput(validInput({ cpuTimeLimit: 30 })).error, /cpuTimeLimit/);
  assert.match(validateProblemInput(validInput({ memoryLimit: 64000.5 })).error, /memoryLimit/);
  assert.match(validateProblemInput(validInput({ points: -1 })).error, /points/);
  assert.match(validateProblemInput(validInput({ scoring: "bonus" })).error, /scoring/);
  assert.match(validateProblemInput(validInput({ status: "live" })).error, /status/);
  assert.match(validateProblemInput(validInput({ hiddenTests: [] })).error, /hiddenTests/);
  assert.match(validateProblemInput(validInput({ sampleTests: [{ input: "x" }] })).error, /sampleTests\[0\]/);
});

// ---- tags (S-I §1.2, vision §2.5) --------------------------------------------

test("validateProblemInput: tags trimmed, lowercased, deduped; default []", () => {
  const r = validateProblemInput(validInput({ tags: ["  Arrays ", "dp", "DP", "arrays"] }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.problem.tags, ["arrays", "dp"]);
  const none = validateProblemInput(validInput({ tags: undefined }));
  assert.deepEqual(none.problem.tags, []);
});

test("validateProblemInput: tag bounds — charset, length 1..30, max 10", () => {
  assert.match(validateProblemInput(validInput({ tags: ["Bad Tag!"] })).error || "", /tags/);
  assert.match(validateProblemInput(validInput({ tags: ["x".repeat(31)] })).error || "", /tags/);
  assert.match(validateProblemInput(validInput({ tags: [""] })).error || "", /tags/);
  assert.match(validateProblemInput(validInput({ tags: "graphs" })).error || "", /tags/);
  const eleven = Array.from({ length: 11 }, (_, i) => `tag-${i}`);
  assert.match(validateProblemInput(validInput({ tags: eleven })).error || "", /tags/);
  const ten = Array.from({ length: 10 }, (_, i) => `tag-${i}`);
  assert.equal(validateProblemInput(validInput({ tags: ten })).ok, true);
});

// ---- scoreSubmission --------------------------------------------------------

test("scoreSubmission: per_test is proportional and floored", () => {
  assert.equal(scoreSubmission({ points: 100, scoring: "per_test" }, 3, 4), 75);
  assert.equal(scoreSubmission({ points: 50, scoring: "per_test" }, 1, 3), 16);
  assert.equal(scoreSubmission({ points: 100, scoring: "per_test" }, 0, 4), 0);
});

test("scoreSubmission: all_or_nothing pays only on a clean sweep", () => {
  assert.equal(scoreSubmission({ points: 80, scoring: "all_or_nothing" }, 4, 4), 80);
  assert.equal(scoreSubmission({ points: 80, scoring: "all_or_nothing" }, 3, 4), 0);
});

test("scoreSubmission: defaults (points 100, per_test) and zero-total guard", () => {
  assert.equal(scoreSubmission({}, 2, 4), 50);
  assert.equal(scoreSubmission({ points: 100 }, 0, 0), 0);
});

// ---- getProblem, store-LESS (seeds only) — keep these BEFORE the store tests -

test("getProblem (no store): seed sum-two served; unknown/invalid/prototype ids -> null", async () => {
  const p = await getProblem("sum-two");
  assert.equal(p.id, "sum-two");
  assert.ok(Array.isArray(p.sampleTests) && p.sampleTests.length >= 1);
  assert.ok(Array.isArray(p.hiddenTests) && p.hiddenTests.length >= 3);
  assert.equal(p.status, "published");
  assert.equal(await getProblem("nope"), null);
  assert.equal(await getProblem("Bad_ID"), null);
  assert.equal(await getProblem("constructor"), null); // never a prototype member
  for (const lang of ["python", "cpp", "java", "javascript"]) assert.ok(LANGUAGE_IDS[lang]);
});

// ---- getProblem, store-backed ----------------------------------------------

test("getProblem (store): published bank doc served; draft hidden; bank shadows seed; miss falls back to seed", async () => {
  const published = { ...validInput(), id: "rev-str" };
  const draftSum = { ...validInput(), id: "sum-two", status: "draft" };
  const fake = makeFakeProblemFirestore({
    "bank/rev-str": published,
    "bank/sum-two": draftSum
  });
  configureProblemStore({ getFirestore: () => fake, collection: "bank" });

  const served = await getProblem("rev-str");
  assert.equal(served.title, "Reverse");
  // a DRAFT bank doc owns its id: it hides the published seed entirely
  assert.equal(await getProblem("sum-two"), null);
  // no doc at all -> seed fallback still answers (swap to an empty store)
  configureProblemStore({ getFirestore: () => makeFakeProblemFirestore({}), collection: "bank" });
  assert.equal((await getProblem("sum-two")).id, "sum-two");
  // invalid id never reaches the store (would throw on a real doc path)
  assert.equal(await getProblem("a/b"), null);
});

// ---- getBankProblem (S-I): doc-or-seed, ANY status — admin/guard read only ---

test("getBankProblem: returns drafts and published docs alike; seed fallback; null on miss", async () => {
  const draft = { ...validInput(), id: "drafty", status: "draft" };
  configureProblemStore({
    getFirestore: () => makeFakeProblemFirestore({ "bank/drafty": draft }),
    collection: "bank"
  });
  // a DRAFT bank doc IS visible here (unlike getProblem) — guard/template
  // existence checks must see drafts.
  assert.equal((await getBankProblem("drafty")).status, "draft");
  // seed fallback (any status) still answers
  assert.equal((await getBankProblem("sum-two")).id, "sum-two");
  // misses and invalid ids are null, same shape rules as getProblem
  assert.equal(await getBankProblem("ghost"), null);
  assert.equal(await getBankProblem("a/b"), null);
  assert.equal(await getBankProblem("constructor"), null);
});
