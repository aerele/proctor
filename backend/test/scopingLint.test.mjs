// backend/test/scopingLint.test.mjs — S-B scoping lint (F9 §2.3.2–2.3.3).
// THE chokepoint rule: every contest_slug equality filter belongs in
// scopedQuery (src/contests.mjs). The pre-existing legacy call sites in
// handler.mjs are pinned by EXACT per-file count below; a NEW raw
// `.where("contest_slug", ...)` anywhere in backend/src fails this test until
// the read goes through scopedQuery — or is deliberately re-pinned here in the
// same reviewable diff (the count bump IS the review flag).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

// Walk backend/src RECURSIVELY so route bodies relocated into subdirectories
// (e.g. src/routes/*.mjs) are still scanned for raw contest_slug filters — a
// flat top-level scan would let the chokepoint guard go blind the moment a
// raw-where moved into a folder. Returns paths RELATIVE to SRC_DIR (so the
// allowlist keys read "routes/session.mjs", not just "session.mjs").
function collectMjsFiles(dir) {
  const out = [];
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, dirent.name);
    if (dirent.isDirectory()) out.push(...collectMjsFiles(full));
    else if (dirent.isFile() && dirent.name.endsWith(".mjs")) {
      out.push(relative(SRC_DIR, full));
    }
  }
  return out;
}
// Matches .where("contest_slug"... in any quote style, any whitespace.
const RAW_FILTER_PATTERN = /\.where\(\s*["'`]contest_slug["'`]/g;
const CHOKEPOINT_FILE = "contests.mjs";
// Legacy call sites grandfathered at S-B (pre-contests code paths; they migrate
// through scopedQuery stage by stage). Counts are exact on purpose: additions
// AND removals both surface here.
// S-C migrated all 12 admin/invigilator READ sites through scopedQuery
// (16 → 4). The 4 that stay raw are deliberate:
//   - findLiveSessionFor      start-path lock check; slug comes from the
//                             session context, "" IS the legacy scope
//   - endAllLiveSessions      settings-driven end-now sweep, same "" semantics
//   - resolveActionTargets    bulk POST body where an EXPLICIT "" filter is a
//                             meaningful value (legacy scope), unlike the GETs
//   - adminSessionDetails     same explicit-"" body contract
const LEGACY_ALLOWLIST = { "handler.mjs": 4 };

test("scoping lint: contest_slug filters = pinned legacy sites + exactly one chokepoint", () => {
  const counts = {};
  for (const file of collectMjsFiles(SRC_DIR).sort()) {
    const matches = readFileSync(join(SRC_DIR, file), "utf8").match(RAW_FILTER_PATTERN);
    if (matches) counts[file] = matches.length;
  }
  const { [CHOKEPOINT_FILE]: chokepointCount = 0, ...others } = counts;
  assert.equal(
    chokepointCount, 1,
    `src/${CHOKEPOINT_FILE} must contain EXACTLY one contest_slug filter (the scopedQuery chokepoint); found ${chokepointCount}`
  );
  assert.deepEqual(
    others, LEGACY_ALLOWLIST,
    "raw .where(\"contest_slug\"...) call-site counts changed — route new contest-scoped reads through scopedQuery (src/contests.mjs), or re-pin the allowlist in this same diff"
  );
});
