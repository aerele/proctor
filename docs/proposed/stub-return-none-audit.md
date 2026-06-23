# Stub "returns none" audit — STUB-1 diagnostic (2026-06-23)

**Question (the owner):** of the stubs we ship, which return `none` vs which return `zero` when run against their sample test(s)? The 2-3 bad questions from the 2026-06-19 dry-run are the ones that return **none**.

**Method.** Pulled every published problem (31) from the live dev bank via
`GET /api/admin/problem?id=<id>` (`your-gcp-project-id`, `proctor_problems`
collection). 16 carry per-language stubs. Executed each stub **exactly as the
exec harness does** — `backend/src/routes/exec.mjs:239` `buildExecItems` runs the
candidate source as-is with the test's `input` on stdin (SQL composes
prelude+seed+query, `problems.mjs:33`); pass = `stdout.trim() === expected.trim()`
(`judge0Adapter.mjs:242`). Ran the DEFAULT (unmodified) stub against each
problem's **first sample test** locally: `python3` 3.14, `node` v20, `g++` 16
(compiled+run), `sqlite3` 3.53. Java has no `javac` here → classified statically
from class-name + return-body + output-line (cross-validated against the
same-shaped python/cpp bodies). Nothing was modified in the bank.

The bucket is a pure property of the stub: a stub whose function returns `0` and
prints it → **ZERO**; a stub that returns `None`/`""`/`undefined`, or has no
output statement at all → **NONE**; a stub that writes to HackerRank's
`OUTPUT_PATH` env file (never adapted to stdout) → **BROKEN** (crashes on Judge0,
emits nothing).

## Dry-run problem set (2026-06-19, reconstructed from `local-notes/tridots-contest-20260619/`)

`challenge-3..9-aerele`, `challenge-10-top-customers-sql` (SQL), `0626-8-challenge`,
`0626-9-challenge`. (`challenge-1/2-aerele` are in the bank but were NOT in this
contest — still broken, flagged below.)

## Executed results — dry-run problems

| Problem | python | javascript | cpp | java (static) | Verdict |
|---|---|---|---|---|---|
| **0626-8-challenge** | **NONE** (empty) | **NONE** (empty) | **NONE** (empty) | **BROKEN** (class Solution, no output) | **NONE — offender** |
| **0626-9-challenge** | **NONE** (empty) | **NONE** (empty) | **NONE** (empty) | **BROKEN** (class Solution, no output) | **NONE — offender** |
| **challenge-7-aerele** | **NONE** (`""`) | **NONE** (`undefined`) | ZERO (`0`) | **NONE** (`return ""`) | **NONE — offender** |
| challenge-3-aerele | ZERO (`0`) | NONE (`undefined`) | ZERO (`0`) | ZERO (`return 0`) | zero (mixed JS) |
| challenge-4-aerele | ZERO (`0`) | NONE (`undefined`) | ZERO (`0`) | ZERO (`return 0`) | zero (mixed JS) |
| challenge-5-aerele | ZERO (`0`) | NONE (`undefined`) | ZERO (`0`) | ZERO (`return 0`) | zero (mixed JS) |
| challenge-6-aerele | ZERO (`0`) | NONE (`undefined`) | ZERO (`0`) | ZERO (`return 0`) | zero (mixed JS) |
| challenge-8-aerele | ZERO (`0`) | NONE (`undefined`) | ZERO (`0`) | ZERO (`return 0`) | zero (mixed JS) |
| challenge-9-aerele | ZERO (`0`) | NONE (`undefined`) | ZERO (`0`) | ZERO (`return 0`) | zero (mixed JS) |
| challenge-10-top-customers-sql | NO STUB (blank editor) | — | — | — | n/a (no stub) |

## The offenders (the "bad questions")

**Two whose ENTIRE stub set returns none:**

1. **`0626-8-challenge`** ("0626-8 Challenge") — python/js/cpp all print nothing;
   java is also broken (wrong class name). **NONE in every language.**
2. **`0626-9-challenge`** ("0626-9 Challenge") — same: **NONE in every language.**

   Root cause: these two stubs are *truncated*. There is no `solve()` function and
   **no output statement at all** — the `main` reads the input and stops. A default
   submit therefore prints empty → "none". Even a candidate who computes the answer
   has to hand-write the print line. Worst class of the three.

**One whose primary languages return none:**

3. **`challenge-7-aerele`** ("Challenge 7", parity/"YES") — the function is `return ""`
   (python) / `return ""` (java) / empty body → `undefined` (js). Output is empty/
   `undefined` → "none". Only cpp returns the placeholder `0`. Because the expected
   output is a STRING ("YES"), the author seeded `return ""` rather than `return 0`,
   so the placeholder *is* none. **NONE in python, js, java.**

That's the **2-3 bad questions** the owner remembers: **0626-8, 0626-9, challenge-7**.

## Why "none" vs "zero" (root cause)

It is a **stub-CONTENT issue, not a harness issue.** The harness is correct: it
runs the stub verbatim and compares trimmed output. The buckets come straight from
how each stub's placeholder body was authored:

- **ZERO** — adapted stub, body `return 0`, prints `0`. (challenge-3/4/5/6/8/9, all
  langs except JS.) Looks like a candidate "wrote something" → reads as a wrong
  answer of `0`.
- **NONE (empty / "")** — adapted stub but the placeholder returns nothing the
  harness can print: `return ""` (challenge-7 py/java), empty JS body → `undefined`
  printed verbatim (challenge-3..9 **all** in JS — JS stubs were never given a
  `return 0`), or **no output line at all** (0626-8/9). Output is empty/`undefined`.
- **BROKEN (unadapted)** — `challenge-1/2-aerele` (NOT in the dry-run) ship the raw
  HackerRank stub that writes to `os.environ['OUTPUT_PATH']` / `process.env.OUTPUT_PATH`
  / `FileWriter(System.getenv("OUTPUT_PATH"))`, and Java `class Solution`. On Judge0
  (no OUTPUT_PATH, class must be `Main`) these **crash** (Python IndentationError on
  the empty body, JS `createWriteStream(undefined)`, C++ `bad_alloc`/`free(): invalid
  size`, Java NPE/wrong-class) and emit nothing. Same class as 0626-8/9's Java leg.

## Cross-cutting findings (beyond the 3 offenders)

- **Every JS stub returns none.** In all of challenge-3..9, the JS `solve()` body is
  empty (no `return 0`), so the harness prints the literal `undefined`. The
  python/cpp/java legs of 3/4/5/6/8/9 print `0`, but JS prints `undefined`. So a
  candidate who opens any of these in JavaScript and submits the untouched stub gets
  "none", not "zero" — language-inconsistent placeholders.
- **`challenge-1/2-aerele` are fully broken** (unadapted OUTPUT_PATH stubs, all
  languages). Not in the 2026-06-19 contest, but they will fail for any candidate if
  ever used. The clone skill's "Stub adaptation rule" (`.claude/skills/clone-hackerrank-contest/SKILL.md`)
  was applied to challenge-3+ but skipped on 1/2.
- **SQL stubs (`occupations`, `weather…5`, `15-days…`) returning empty is BY DESIGN** —
  they are comment-only schema hints; the candidate writes the query. Not offenders.
- `challenge-10-top-customers-sql` has **no stub** (blank editor) — also fine for SQL,
  just noting it wasn't a stub-none case.

## Recommendation (NOT applied — no data was modified)

Re-author the placeholder bodies so the default stub prints a benign, well-formed
value of the right type in **every** language:

- 0626-8 / 0626-9: add the missing `solve()` + output line (and adapt Java to
  `class Main` + stdout) so the default prints `0` / a placeholder string.
- challenge-7 (and the integer ones for consistency): give the JS body a
  `return 0;` (or `return "";` for string problems) so JS stops printing `undefined`.
- challenge-1 / challenge-2: re-run the SKILL.md stub-adaptation (OUTPUT_PATH →
  stdout, `class Solution` → `class Main`, empty python body → `pass`/`return 0`).

Reproduction (no network/Judge0 key needed — pure local replication of the harness):
fetch the bank with `GET /api/admin/problem?id=<id>` (`x-admin-password`), then run
each `stubs[lang]` with the first sample `input` on stdin via `python3` / `node` /
`g++` / `sqlite3` and compare trimmed stdout to `sampleTests[0].expected`. Scratch
runners used: `runner.mjs` (py/js), `runcpp.mjs`, `runsql.mjs`.
