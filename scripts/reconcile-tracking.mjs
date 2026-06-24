#!/usr/bin/env node
// scripts/reconcile-tracking.mjs — the scripted reconcile gate (anti-slip auditor).
//
// WHY THIS EXISTS
//   A request captured as a tracking item (e.g. "T1") was once silently dropped
//   when BACKLOG.md was rewritten from scratch: the ID vanished with no terminal
//   disposition, so the worklist never built it and nobody noticed. The manual
//   "reconcile at every release cut" rule had no teeth. This script gives it teeth.
//
// WHAT IT DOES
//   Compares the PRIOR committed tracking docs (BACKLOG.md + ROADMAP.md) against
//   the CURRENT ones and FAILS (non-zero exit) on any tracking ID that existed
//   before but has DISAPPEARED with no terminal disposition.
//
//   A "terminal disposition" is satisfied whenever the ID still has ANY occurrence
//   in the current docs — because an ID that is still present is, by construction,
//   either still active (☐/◑) or carries a done/deferred/dropped/folded annotation.
//   The one illegal state — the exact T1 failure — is an ID that is present in the
//   prior docs but ENTIRELY ABSENT from the current docs. Vanishing from the file
//   is never legal: a dropped item must be left behind with an explicit disposition
//   (BUILT/DEFERRED/DROPPED/FOLDED), not deleted.
//
// HOW TO RUN IT (pre-release / handoff gate)
//   node scripts/reconcile-tracking.mjs            # working tree vs HEAD
//   node scripts/reconcile-tracking.mjs <baseRef>  # working tree vs an explicit
//                                                   # base ref, e.g. a release tag:
//   node scripts/reconcile-tracking.mjs v1.0
//
//   Exit 0 = clean (no orphaned IDs). Exit 1 = at least one orphan (build blocker).
//   Exit 2 = the script itself could not run (e.g. base ref / git failure).
//
// SUGGESTED WIRING: run it at every release cut and at handoff, before clearing
//   context, and in CI for any commit that touches BACKLOG.md / ROADMAP.md. See the
//   AGENTS.md "THE ROADMAP RULE" section.
//
// No external dependencies — node:child_process for git, node:fs for the working tree.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The tracking docs this gate guards. Both are read as one combined corpus: an ID
// is "present" if it appears in EITHER doc (items legitimately move BACKLOG↔ROADMAP).
const TRACKING_DOCS = ["BACKLOG.md", "ROADMAP.md"];

// Bold worklist handles. The handle is the LEADING token of a markdown-bold span
// and has the shape: an uppercase letter prefix (must START with a letter, so a bare
// "**42**" is never an ID), an OPTIONAL `-<number>` (dashed forms like REC-4 /
// FLOW-1 / LT-14 / ALERT-1) OR a trailing number (plain forms like T1 / S5 / F13 /
// M2). Crucially, the handle may be followed by INLINE ANNOTATION still inside the
// bold — the real docs carry handles like:
//     **T1 (page-merge half)**   **STUB-1 — APPROVED 2026-06-23**
//     **M2 — candidate-visible leaderboard:**   **F13 vs F14:**
// so we anchor on the opening `**`, capture the handle, then require it be terminated
// by a handle-boundary: a closing `**`, or any char that is not part of a handle
// (whitespace, em/en-dash, slash, paren, colon, …). The boundary lookahead also
// stops "**T1abc**" or "**FLOW-1A**" from being mis-read — a letter/digit immediately
// continuing the token means it is not this handle.
//
// A real handle ALWAYS ends in a number group: plain `[A-Z]+\d+` (T1, S5, F13, M2,
// T10) or dashed `[A-Z]+-\d+` (REC-4, FLOW-1, LT-14, ALERT-1). Requiring the terminal
// digits is what keeps all-caps DISPOSITION words and shouty prose — **DEFERRED**,
// **DROPPED**, **FOLDED**, **BUILT** — out of the ID set (they carry no number).
const ID_RE = /\*\*([A-Z]+-?\d+)(?=\*\*|[^A-Za-z0-9-])/g;

// Repo root = parent of this script's dir (scripts/..).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Extract the set of bold tracking IDs from a blob of markdown. */
function extractIds(text) {
  const ids = new Set();
  if (!text) return ids;
  for (const m of text.matchAll(ID_RE)) ids.add(m[1]);
  return ids;
}

/** Read a tracking doc from a git ref (e.g. "HEAD", "v1.0"). "" if absent at that ref. */
function readAtRef(ref, relPath) {
  try {
    return execFileSync("git", ["show", `${ref}:${relPath}`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // File did not exist at that ref (new doc) — treat as empty, not an error.
    return "";
  }
}

/** Read a tracking doc from the current working tree. "" if absent. */
function readWorkingTree(relPath) {
  const abs = join(REPO_ROOT, relPath);
  return existsSync(abs) ? readFileSync(abs, "utf8") : "";
}

/**
 * Core comparison. Pure function over (base text per doc, current text per doc) so
 * the test can drive it directly with fixtures, no git needed.
 * @returns {{ priorIds: string[], currentIds: string[], orphans: string[] }}
 */
export function reconcile({ baseTexts, currentTexts }) {
  const priorIds = new Set();
  for (const t of baseTexts) for (const id of extractIds(t)) priorIds.add(id);

  const currentIds = new Set();
  for (const t of currentTexts) for (const id of extractIds(t)) currentIds.add(id);

  // FAILURE: a prior ID with no occurrence at all in the current combined corpus.
  const orphans = [...priorIds].filter((id) => !currentIds.has(id));

  return {
    priorIds: [...priorIds].sort(),
    currentIds: [...currentIds].sort(),
    orphans: orphans.sort(),
  };
}

/** Drive the comparison from git (base ref) vs the working tree (current). */
function run(baseRef) {
  // Confirm the base ref resolves before we start, so we fail with a clear message.
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    console.error(
      `reconcile-tracking: base ref "${baseRef}" does not resolve to a commit.\n` +
        `Pass a valid ref (default HEAD), e.g. a release tag: ` +
        `node scripts/reconcile-tracking.mjs v1.0`
    );
    process.exit(2);
  }

  const baseTexts = TRACKING_DOCS.map((d) => readAtRef(baseRef, d));
  const currentTexts = TRACKING_DOCS.map((d) => readWorkingTree(d));

  const { priorIds, currentIds, orphans } = reconcile({ baseTexts, currentTexts });

  const docList = TRACKING_DOCS.join("+");
  console.log(`reconcile-tracking — tracking docs: ${docList}`);
  console.log(`  base ref:  ${baseRef}`);
  console.log(`  IDs in base:    ${priorIds.length} (${priorIds.join(", ") || "none"})`);
  console.log(`  IDs in current: ${currentIds.length} (${currentIds.join(", ") || "none"})`);

  if (orphans.length === 0) {
    console.log(`\nOK — every ID present in ${baseRef} is still present in the current ${docList}.`);
    process.exit(0);
  }

  console.error(`\nFAIL — ${orphans.length} orphaned tracking ID(s):`);
  for (const id of orphans) {
    console.error(
      `  ${id}: present in ${baseRef} but absent from current ${docList} — ` +
        `add a terminal disposition (BUILT/DEFERRED/DROPPED/FOLDED) or restore it.`
    );
  }
  process.exit(1);
}

// Only run when invoked directly (not when imported by the test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const baseRef = process.argv[2] || "HEAD";
  run(baseRef);
}
