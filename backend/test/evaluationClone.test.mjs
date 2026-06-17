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

// analyzeClones must equal canonical PLUS a _records array (canonical drops it).
test("analyzeClones returns canonical fields plus _records", () => {
  const { meta, code, expected } = loadJson("boundaries_and_exclusions.json");
  const full = analyzeClones(meta, code);
  assert.ok(Array.isArray(full._records), "_records must be an array");
  const { _records, ...rest } = full;
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
