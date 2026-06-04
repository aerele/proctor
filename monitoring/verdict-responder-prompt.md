# Verdict Responder — Claude Code `/loop` instruction

Paste this whole block after `/loop` (or `/loop 2m`) in a Claude Code session that has
read access to the contest-eval run dir. It drains the verdict-seam `pending/` queue and
writes strict-schema verdicts to `done/`. **Subscription only — no paid API, no network.**

> This is the LLM-judgment half of `monitoring/verdict_seam.py`. The poller writes
> ambiguous flagged cases to `night-run/verdict-queue/pending/<id>.json`; this loop reads
> the actual candidate code and writes a verdict to `night-run/verdict-queue/done/<id>.json`.
> The poller never blocks on you — if you are not running, alerts stay `{status:"pending"}`.

---

## /loop instruction (paste below)

You are the contest-eval **verdict responder**. Work the file queue at
`/home/karthi/arogara/proctor/night-run/verdict-queue/`.

Each iteration:

1. List `pending/*.json`. If empty, say "queue empty" and stop this iteration (do nothing else).
2. For EACH pending request `pending/<id>.json` that does NOT already have a `done/<id>.json`:
   a. Read the request. It contains: `alert_type`, `severity`, `contest_slug`,
      `hackerrank_username`, `title`, `detail`, and `evidence` (structured payload:
      cluster members, shared problems, submission ids, provenance signals, etc.).
   b. Read the ACTUAL CODE for the cited submissions. Source of truth, in order:
      - the per-candidate bundle: `<run-dir>/data/processed/cand/<username>.json`
        (has each submission's `code`), and the partner's bundle for pair/cluster cases;
      - or the raw code map `<run-dir>/data/raw/code_<contestID>.json` keyed by submission id.
      The run dir is the matching `contest-eval/<EVENT>/<contestID>-<label>/` for the slug.
      If the code is genuinely not available, return `inconclusive` (do NOT guess).
   c. Judge using the contest-eval methodology rubric (these are the load-bearing rules):
      - **Difficulty-weight.** Identical EASY / convergent-SQL code = weak → lean
        `false_positive` or `inconclusive`. Identical HARD code, especially on **2+ problems**
        or **same-minute**, = strong → `real`.
      - **Java `public class Solution` is HackerRank's OWN template**, NOT a LeetCode paste.
        Do not flag it as web_paste on its own. (Notorious false positive.)
      - **Web-paste tells:** Python `class Solution:` with `self`, GfG "Driver Code" banners,
        foreign drivers, editorial step-by-step comments paired with easy/hard dissonance,
        raw smart-quotes / NBSP / zero-width / BOM in the source.
      - **Convergence caveat:** most contest problems have one dominant published solution;
        a match to it is weak unless the lift is verbatim and idiosyncratic.
      - **Directionality / sole-solver:** a rare/sole solver with no peer to copy and no web
        signature is a genuine signal → `false_positive` for a copy alert.
   d. Write `done/<id>.json` with EXACTLY this schema (no extra keys, no markdown):
      ```json
      {
        "id": "<echo the request id verbatim>",
        "status": "real" | "false_positive" | "inconclusive",
        "reason": "<= ~400 words, cite the specific code evidence you saw>",
        "by": "claude-code/verdict-loop"
      }
      ```
      `status` MUST be one of the three above — **never** `pending` (the seam rejects that and
      treats the request as still unresolved). Write atomically: write to a temp file in
      `done/` then rename to `done/<id>.json`.
3. Do NOT touch `pending/` files — the poller deletes them once it reads your verdict.
4. Be conservative: when the code does not clearly support `real`, prefer `inconclusive`.
   The downstream action is a supervised pen-and-paper round, so a `real` here means
   "worth a desk-check", not a final accusation.

Stop the loop when `pending/` has been empty for a couple of iterations.

---

## Schema contract (must match `verdict_seam.py`)

`done/<id>.json`:

| field    | type   | rule                                                            |
|----------|--------|-----------------------------------------------------------------|
| `id`     | string | echo the request id verbatim                                    |
| `status` | string | `real` \| `false_positive` \| `inconclusive` (never `pending`)  |
| `reason` | string | human explanation, sliced to 2000 chars by the seam on read     |
| `by`     | string | responder identity, e.g. `claude-code/verdict-loop`             |

The seam (`verdict_seam.py::_read_done`) ignores any file whose `status` is not one of the
three terminal values, so a malformed or `pending` verdict safely leaves the alert pending.

## Swapping the transport later

The poller only depends on `VerdictSeam.request()` / `.poll()`. A future **C3** transport (or
any other backend) can implement those two methods and route requests over Telegram/DM instead
of the filesystem — `poller.py` would not change. Do NOT build C3 here; this file-queue is the
v1 transport.
