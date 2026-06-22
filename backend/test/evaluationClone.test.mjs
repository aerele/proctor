// backend/test/evaluationClone.test.mjs — byte-parity proof for the JS port of
// monitoring/contest_eval_core.py. Every fixture under
// test/fixtures/clone-parity/ was produced by running the Python reference
// (via /tmp/gen_clone_fixtures.py); each <case>.json carries the EXACT
// cloneAnalysisCanonical output the JS port must reproduce. functions.json
// carries direct coreExact/skeleton/artifacts/provenance input→output pairs.
//
// PURE unit test — no handler, no env, no GCP.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  makeHardness,
  stripBoiler,
  coreExact,
  skeleton,
  artifacts,
  provenance,
  analyzeClones,
  cloneAnalysisCanonical,
  CANONICAL_MAX_FORMS,
  CANONICAL_MAX_LEN,
  CANONICAL_MIN_SOLVERS,
} from "../src/evaluationClone.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX_DIR = join(HERE, "fixtures", "clone-parity");

function loadJson(name) {
  return JSON.parse(readFileSync(join(FIX_DIR, name), "utf8"));
}

// ---- canonical-output parity (one test per case fixture) ------------------
const caseFiles = readdirSync(FIX_DIR)
  .filter((f) => f.endsWith(".json") && f !== "functions.json")
  .sort();

assert.ok(caseFiles.length >= 8, `expected >=8 case fixtures, found ${caseFiles.length}`);

for (const file of caseFiles) {
  test(`cloneAnalysisCanonical parity: ${file}`, () => {
    const { meta, code, expected } = loadJson(file);
    const got = cloneAnalysisCanonical(meta, code);
    assert.deepEqual(got, expected);
  });
}

// analyzeClones must equal canonical PLUS a _records array (canonical drops it)
// PLUS the JS-only conclusiveness enrichments (canonical map + per-pair
// n_exact/exact_problems/n_hard_conclusive/hard_conclusive_problems, PENDING-1/2)
// which cloneAnalysisCanonical also strips for the Python byte-parity contract.
test("analyzeClones returns canonical fields plus _records plus JS enrichments", () => {
  const { meta, code, expected } = loadJson("boundaries_and_exclusions.json");
  const full = analyzeClones(meta, code);
  assert.ok(Array.isArray(full._records), "_records must be an array");
  assert.ok(full.canonical && typeof full.canonical === "object", "canonical map present");
  // Strip the JS-only fields, then the remainder must byte-match the Python ref.
  const { _records, canonical, ...rest } = full;
  rest.recurring_pairs = rest.recurring_pairs.map((r) => {
    const {
      n_exact, exact_problems, n_exact_noncanonical, exact_noncanonical_problems,
      n_hard_conclusive, hard_conclusive_problems, ...keep
    } = r;
    return keep;
  });
  assert.deepEqual(rest, expected);
});

// ---- function-level parity (coreExact / skeleton / artifacts / provenance) -
test("function-level parity: coreExact / skeleton / artifacts / provenance", () => {
  const fns = loadJson("functions.json");
  const impls = { coreExact, skeleton, artifacts, provenance };
  let asserted = 0;
  for (const [fnName, cases] of Object.entries(fns)) {
    const fn = impls[fnName];
    assert.ok(fn, `no impl for ${fnName}`);
    for (const { input, output } of cases) {
      assert.deepEqual(fn(input), output, `${fnName}(${JSON.stringify(input)})`);
      asserted++;
    }
  }
  assert.ok(asserted >= 20, `expected >=20 function-level assertions, ran ${asserted}`);
});

// ---- makeHardness boundary table ------------------------------------------
test("makeHardness: <=10 hard, <=40 med, else easy; null/missing → easy default", () => {
  const hardness = makeHardness([
    { slug: "h10", solved: 10 },
    { slug: "m11", solved: 11 },
    { slug: "m40", solved: 40 },
    { slug: "e41", solved: 41 },
    { slug: "nz", solved: 0 },
    { slug: "nul", solved: null },
  ]);
  assert.equal(hardness("h10"), "hard");
  assert.equal(hardness("m11"), "med");
  assert.equal(hardness("m40"), "med");
  assert.equal(hardness("e41"), "easy");
  assert.equal(hardness("nz"), "hard"); // solved 0 → hard
  assert.equal(hardness("nul"), "hard"); // null → 0 → hard
  assert.equal(hardness("absent"), "hard"); // missing slug → 0 → hard
});

// ---- stripBoiler removes the boilerplate lines the Python original does ----
test("stripBoiler drops shebang/import/__main__/package/using System/env lines", () => {
  const src = [
    "#!/usr/bin/env python3",
    "import os",
    "keepme = 1",
    "if __name__ == '__main__':",
    "    os.environ['X']",
    "package com.foo;",
    "using System;",
    "    fptr.write(str(res))",
    "final = 2",
  ].join("\n");
  const out = stripBoiler(src);
  assert.equal(out, "keepme = 1\nfinal = 2");
});

// ---- code <15 chars excluded; non-accepted excluded from clusters ---------
test("records exclude code <15 chars and non-accepted from accepted clusters", () => {
  const { meta, code } = loadJson("boundaries_and_exclusions.json");
  const full = analyzeClones(meta, code);
  const recIds = full._records.map((r) => r.id);
  // sub "65" has code "x=1" (<15 chars) → excluded from records entirely.
  assert.ok(!recIds.includes("65"), "sub 65 (<15 chars) must be excluded");
  // sub "62" (carol, Wrong Answer) is a record but must NOT appear in any
  // accepted cluster member list.
  assert.ok(recIds.includes("62"), "sub 62 should be a record");
  const clusterUsers = full.exact_clusters
    .flatMap((g) => g.members.map((m) => m.user))
    .concat(full.skeleton_clusters.flatMap((g) => g.members.map((m) => m.user)));
  assert.ok(!clusterUsers.includes("carol"), "non-accepted carol must not cluster");
});

// ===========================================================================
// PENDING-1/2 (2026-06-22): canonical/low-entropy guard + per-pair coreExact /
// non-canonical conclusiveness enrichments on recurring pairs.
// ===========================================================================

// Build a synthetic meta+code for N accepted solvers on a single problem.
// solvers: [{user, code}]. `solved` drives hardness.
function singleProblemMeta(ch, solvers, solved) {
  const submissions = solvers.map((s, i) => ({
    id: String(i + 1), user: s.user, ch, status: "Accepted", score: 100,
    tfs: i + 1, created: 1000 * (i + 1), lang: s.lang || "sql",
  }));
  const code = {};
  solvers.forEach((s, i) => { code[String(i + 1)] = s.code; });
  const leaderboard = solvers.map((s, i) => ({ user: s.user, rank: i + 1 }));
  return { meta: { submissions, leaderboard, challenges: [{ slug: ch, solved }] }, code };
}

test("CANONICAL constants present", () => {
  assert.equal(CANONICAL_MAX_FORMS, 8);
  assert.equal(CANONICAL_MAX_LEN, 200);
  assert.equal(CANONICAL_MIN_SOLVERS, 5);
});

test("PENDING-2: canonical guard fires on few-short-forms with ENOUGH solvers", () => {
  // 6 solvers, 3 distinct SHORT forms (canonical SQL one-liner pattern). ≤8
  // forms, median len ≤200, ≥5 solvers → canonical.
  const forms = [
    "select city from station order by length(city) limit 1",
    "select city from station order by length(city) desc limit 1",
    "select city from station group by city order by length(city) limit 1",
  ];
  const solvers = [];
  for (let i = 0; i < 6; i++) solvers.push({ user: `u${i}`, code: forms[i % 3] });
  const { meta, code } = singleProblemMeta("wos5", solvers, 6); // solved 6 ≤10 → hard
  const r = analyzeClones(meta, code);
  assert.equal(r.canonical.wos5, true, "few short forms + ≥5 solvers ⇒ canonical");
  // every same-form pair: exact match but NOT hard-conclusive (canonical).
  const p = r.recurring_pairs.find((x) => x.n_exact >= 1);
  assert.ok(p, "an exact pair exists");
  assert.equal(p.n_hard_conclusive, 0, "canonical hard problem is NOT hard-conclusive");
  assert.equal(p.n_exact_noncanonical, 0, "canonical exact match is not non-canonical");
});

test("PENDING-2: NOT canonical when too few solvers (2 identical = suspicious, not convergence)", () => {
  // Only 2 solvers with identical short code — convergence cannot be demonstrated,
  // so it is NOT down-weighted as canonical (it is suspicious copying).
  const short = "select city from station order by length(city) limit 1";
  const { meta, code } = singleProblemMeta("p", [{ user: "A", code: short }, { user: "B", code: short }], 2);
  const r = analyzeClones(meta, code);
  assert.equal(r.canonical.p, false, "2 solvers < min ⇒ not canonical");
  const p = r.recurring_pairs[0];
  assert.equal(p.n_hard_conclusive, 1, "short identical with <5 solvers stays hard-conclusive");
});

test("PENDING-2: NOT canonical when solutions are LONG (substantive algorithm)", () => {
  // 6 solvers, few distinct forms, but LONG code (>200) → a substantive algorithm,
  // an identical long match is copying, NOT convergence. (challenge-5 Josephus.)
  const longA = "class result{public static int solve(int n,int k){int s=0;for(int i=2;i<=n;i++){s=(s+k)%i;}return s+1;}}" +
    "public class main{public static void main(string[]a){scanner sc=new scanner(system.in);int n=sc.nextint();int k=sc.nextint();system.out.println(result.solve(n,k));}}";
  const longB = longA.replace("int s=0", "int win=0").replace(/s=\(s/g, "win=(win").replace("return s+1", "return win+1");
  const solvers = [];
  for (let i = 0; i < 6; i++) solvers.push({ user: `u${i}`, code: i < 3 ? longA : longB, lang: "java" });
  const { meta, code } = singleProblemMeta("ch5", solvers, 6);
  const r = analyzeClones(meta, code);
  assert.equal(r.canonical.ch5, false, "long substantive forms ⇒ NOT canonical even with few forms");
  const p = r.recurring_pairs.find((x) => x.n_exact >= 1);
  assert.equal(p.n_hard_conclusive, 1, "long identical match stays hard-conclusive");
});

test("PENDING-1: skeleton-only single-problem pair has n_exact=0 (coreExact differs)", () => {
  // Same algorithm SHAPE (skeleton), different variable names → skeleton clusters
  // but NO exact cluster → recurring pair n_exact=0, n_hard_conclusive=0.
  const a = "def f(n):\n  total=0\n  for x in range(n):\n    total=total+x\n  return total";
  const b = "def f(n):\n  acc=0\n  for y in range(n):\n    acc=acc+y\n  return acc";
  const { meta, code } = singleProblemMeta("p", [{ user: "A", code: a, lang: "python" }, { user: "B", code: b, lang: "python" }], 2);
  const r = analyzeClones(meta, code);
  const p = r.recurring_pairs[0];
  assert.ok(p, "skeleton match surfaces a recurring pair");
  assert.equal(p.n_exact, 0, "skeleton-only ⇒ no coreExact match");
  assert.equal(p.n_hard_conclusive, 0, "skeleton-only single problem ⇒ not hard-conclusive");
});

test("cloneAnalysisCanonical strips JS-only enrichments (Python byte-parity)", () => {
  const { meta, code } = singleProblemMeta("p", [{ user: "A", code: "select 1 from t where x=1" }, { user: "B", code: "select 1 from t where x=1" }], 2);
  const canon = cloneAnalysisCanonical(meta, code);
  assert.ok(!("canonical" in canon), "canonical map stripped from canonical output");
  for (const rp of canon.recurring_pairs) {
    for (const k of ["n_exact", "exact_problems", "n_exact_noncanonical", "exact_noncanonical_problems", "n_hard_conclusive", "hard_conclusive_problems"]) {
      assert.ok(!(k in rp), `${k} stripped from canonical recurring_pairs`);
    }
  }
});
