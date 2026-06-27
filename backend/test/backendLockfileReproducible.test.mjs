// backend/test/backendLockfileReproducible.test.mjs
//
// HARDEN-1 regression guard. The Cloud Run backend image is built from the
// backend/ dir as a STANDALONE package (see backend/Dockerfile) — `npm ci`
// against a COMMITTED backend/package-lock.json, so the deployed artifact
// exactly matches an audited tree. This test locks in the two properties that
// make that safe:
//
//   1. the committed lockfile pins uuid >= 11.1.1 everywhere (the security floor
//      for GHSA-w5hq-g745-h8pq — it must never creep back below the patch), and
//      backend/package.json still carries the override that produces it;
//   2. the Dockerfiles actually use `npm ci` against the committed lock (not a
//      drifting `npm install`), and every declared dep is present in the lock.
//
// PURE unit test — reads the files, no install, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BACKEND = dirname(dirname(fileURLToPath(import.meta.url))); // backend/
const pkg = JSON.parse(readFileSync(join(BACKEND, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(BACKEND, "package-lock.json"), "utf8"));

// "a.b.c" >= "11.1.1" without pulling in a semver dep. parseInt (not Number)
// takes the numeric prefix of each segment so a prerelease like "11.1.1-0"
// compares as 11.1.1 instead of collapsing to NaN.
function gte(version, floor) {
  const num = (s) => {
    const n = parseInt(s, 10);
    return Number.isNaN(n) ? 0 : n;
  };
  const a = version.split(".").map(num);
  const b = floor.split(".").map(num);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return true;
}

const UUID_FLOOR = "11.1.1";

test("committed backend lockfile exists and is lockfileVersion 3", () => {
  assert.equal(lock.lockfileVersion, 3, "lockfileVersion 3 (npm ci reads this)");
  assert.ok(lock.packages && lock.packages[""], "has a root package node");
});

test("every uuid in the backend lockfile is >= 11.1.1 (GHSA-w5hq-g745-h8pq floor)", () => {
  const uuidNodes = Object.entries(lock.packages || {}).filter(([p]) => /(^|\/)uuid$/.test(p));
  assert.ok(uuidNodes.length > 0, "uuid is present in the lockfile (a transitive dep of the google-cloud stack)");
  for (const [path, meta] of uuidNodes) {
    assert.ok(
      gte(meta.version, UUID_FLOOR),
      `uuid at ${path} is ${meta.version} — must be >= ${UUID_FLOOR} (vulnerable range is < 11.1.1)`,
    );
  }
});

test("backend/package.json carries the uuid override that produces the floor", () => {
  const ov = (pkg.overrides && pkg.overrides.uuid) || "";
  assert.ok(ov, "backend/package.json declares an overrides.uuid (the standalone image build honors it)");
  // the declared override must pin to major >= 11 — match the leading integer so
  // valid specs like "^11", ">=11", "11.x" or "^11.1.1" all pass.
  const m = String(ov).match(/(\d+)/);
  assert.ok(m && Number(m[1]) >= 11, `overrides.uuid (${ov}) must pin to >= 11.x`);
});

test("every dependency declared in backend/package.json is resolved in the lockfile (drift smoke)", () => {
  const declared = Object.keys(pkg.dependencies || {});
  assert.ok(declared.length >= 3, "the google-cloud deps are declared");
  for (const dep of declared) {
    const present = Object.keys(lock.packages || {}).some((p) => p === `node_modules/${dep}`);
    assert.ok(present, `declared dependency ${dep} is missing from the lockfile — package.json/lock have drifted`);
  }
});

test("both backend Dockerfiles use `npm ci` against the committed lockfile (reproducible build)", () => {
  for (const name of ["Dockerfile", "Dockerfile.eval"]) {
    const df = readFileSync(join(BACKEND, name), "utf8");
    // Only inspect actual RUN instructions — comments may legitimately mention
    // `npm install` to explain why we don't use it.
    const runLines = df.split("\n").filter((l) => /^\s*RUN\b/.test(l));
    const npmRun = runLines.filter((l) => /\bnpm\b/.test(l));
    assert.ok(npmRun.length > 0, `${name} has an npm RUN step`);
    assert.ok(
      npmRun.every((l) => /\bnpm ci\b/.test(l)),
      `${name} must install with \`npm ci\` (deterministic) in every npm RUN step, got: ${npmRun.join(" | ")}`,
    );
    assert.ok(
      !npmRun.some((l) => /\bnpm install\b/.test(l)),
      `${name} must not \`npm install\` (re-resolves, defeats the lock)`,
    );
    assert.match(df, /COPY[^\n]*package-lock\.json/, `${name} must COPY the committed package-lock.json into the build`);
  }
});
