// backend/test/envLint.test.mjs — env-lint guard (decomp B0, A3).
//
// process.env may be read in EXACTLY two files: handler.mjs (the HTTP entry,
// which destructures loadConfig() once at module scope) and config.mjs (the
// single home of env reads). Every other module under backend/src takes its
// configuration by getter-injection / factory ctx, which is what keeps the
// per-`?buster` test-isolation semantics permanent: a module that captured an
// env value at its own (cached, un-bustered) load time would silently break the
// canary collection-name overrides and invigilator.test.mjs's per-instance
// credential probes. A new `process.env.X` anywhere else fails this test until
// the value is threaded through config.mjs + the module's ctx instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const ENV_PATTERN = /process\.env\b/g;
// The ONLY two files allowed to read process.env (paths relative to SRC_DIR).
const ALLOWLIST = new Set(["handler.mjs", "config.mjs"]);

function collectMjsFiles(dir) {
  const out = [];
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, dirent.name);
    if (dirent.isDirectory()) out.push(...collectMjsFiles(full));
    else if (dirent.isFile() && dirent.name.endsWith(".mjs")) out.push(relative(SRC_DIR, full));
  }
  return out;
}

test("env-lint: process.env appears ONLY in handler.mjs and config.mjs", () => {
  const offenders = [];
  for (const file of collectMjsFiles(SRC_DIR).sort()) {
    if (ALLOWLIST.has(file)) continue;
    const matches = readFileSync(join(SRC_DIR, file), "utf8").match(ENV_PATTERN);
    if (matches) offenders.push(`${file} (${matches.length})`);
  }
  assert.deepEqual(
    offenders, [],
    "process.env must be read only in handler.mjs + config.mjs — thread new env " +
    "through config.mjs's loadConfig() and inject it via the module's ctx/getter " +
    `instead. Offending file(s): ${offenders.join(", ")}`
  );
});
