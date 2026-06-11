// backend/test/routesAuthLint.test.mjs — routes auth-first lint (decomp B1, A3).
//
// Make "every admin/invigilator route checks its credential BEFORE it touches
// data" a CI fact rather than a convention. We text-scan backend/src/routes/*.mjs
// and, for every EXPORTED-from-the-factory route function whose name starts with
// `admin` or `invigilator`, assert its `require<Guard>(req...)` call is the first
// real statement — modulo a single sanctioned auth-context preamble line that
// RESOLVES the credential's scope (e.g. `const contest = await
// invigilatorContestOf(req)`, whose only job is to fetch the contest the guard
// then authenticates against). A route that read or mutated Firestore before its
// guard would push the guard past statement #2 (or omit it) and fail here.
//
// This is the routes/ analogue of the canary/scoping/env guards: a cheap,
// self-describing assertion that turns the decomposition into a measurable
// security property and keeps future route moves honest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROUTES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "routes");

// A route function is admin/invigilator-guarded iff its name starts with one of
// these. (Public/session/exec routes authenticate by the unguessable session
// token or an API key, not a require* credential guard, so they are out of scope.)
const GUARDED_PREFIXES = ["admin", "invigilator"];
// The credential guards a guarded route may open with.
const REQUIRE_GUARD = /^\s*require[A-Z]\w*\(\s*req\b/;
// The ONE sanctioned preamble that may precede the guard: resolving the auth
// CONTEXT the guard authenticates against (the optional ?contest= a portal
// passes). It reads no candidate evidence — it resolves the credential scope.
const AUTH_CONTEXT_PREAMBLE = /^\s*const\s+\w+\s*=\s*await\s+\w*ContestOf\(\s*req\s*\)\s*;?\s*$/;

// Pull every `async function name(req) { ... }` / `function name(req) { ... }`
// body out of a module by brace-matching from the opening `{`.
function extractFunctions(source) {
  const out = [];
  const sigRe = /(?:async\s+)?function\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{/g;
  let match;
  while ((match = sigRe.exec(source)) !== null) {
    const name = match[1];
    const params = match[2];
    let depth = 1;
    let i = sigRe.lastIndex;
    for (; i < source.length && depth > 0; i++) {
      const ch = source[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
    }
    out.push({ name, params, body: source.slice(sigRe.lastIndex, i - 1) });
  }
  return out;
}

// The real (non-comment, non-blank) statement lines of a function body, in order.
function statementLines(body) {
  return body
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (trimmed.startsWith("//")) return false;
      if (trimmed.startsWith("*") || trimmed.startsWith("/*")) return false;
      return true;
    });
}

test("routes auth-lint: every admin/invigilator route opens with its require* guard", () => {
  const files = readdirSync(ROUTES_DIR).filter((name) => name.endsWith(".mjs"));
  assert.ok(files.length >= 1, `no route modules found under src/routes — found: ${files.join(", ")}`);

  let checked = 0;
  const offenders = [];
  for (const file of files) {
    const source = readFileSync(join(ROUTES_DIR, file), "utf8");
    for (const fn of extractFunctions(source)) {
      // Only request handlers: name-prefixed AND taking a `req` parameter.
      const isGuardedName = GUARDED_PREFIXES.some((prefix) => fn.name.startsWith(prefix));
      const takesReq = /\breq\b/.test(fn.params);
      if (!isGuardedName || !takesReq) continue;
      // Internal helpers (e.g. invigilatorContestOf / invigilatorContestSlug) are
      // NOT route handlers — they resolve scope and carry no require* guard. A
      // route handler is one wired into the dispatch table; we approximate that
      // by "name starts with the prefix AND is not itself a *ContestOf/*ContestSlug
      // scope resolver". Keep this allowlist tight and self-describing.
      if (/ContestOf$|ContestSlug$/.test(fn.name)) continue;
      checked += 1;

      const lines = statementLines(fn.body);
      let idx = 0;
      // Skip at most one sanctioned auth-context preamble line.
      if (lines[idx] && AUTH_CONTEXT_PREAMBLE.test(lines[idx])) idx += 1;
      if (!lines[idx] || !REQUIRE_GUARD.test(lines[idx])) {
        offenders.push(`${file}:${fn.name} — first statement is not a require*(req) guard: ${JSON.stringify(lines.slice(0, 2))}`);
      }
    }
  }

  assert.ok(checked >= 7, `expected to check at least the 7 invigilator routes; checked ${checked}`);
  assert.deepEqual(
    offenders, [],
    "Some admin/invigilator route does not authenticate FIRST. Put its " +
    "require<Guard>(req...) call before any data access (an optional single " +
    `*ContestOf(req) scope-resolution line may precede it). Offenders: ${offenders.join("; ")}`
  );
});
