# monitoring/ — contest-eval live poller + LLM verdict seam

A standalone poller that watches a live HackerRank contest, runs the deterministic
contest-eval cheating analysis each cycle, and POSTs integrity **alerts** to the
proctor backend (`/api/alerts`). Ambiguous flags are routed through a file-queue
**LLM verdict seam** (subscription only, no paid API) that a human-driven Claude Code
`/loop` resolves.

This is the contest-eval *source* half of the shared proctor↔contest-eval alert feed.
The proctor side already validates and stores these alerts (`backend/src/handler.mjs`).

## Components

| File | Role |
|------|------|
| `poller.py` | the live poller (CLI). One cycle = metadata fetch → deterministic analyze → lazy 429-safe code fetch for flagged-only → clone/web-paste detect → build alerts → POST + route ambiguous to the seam. |
| `contest_eval_core.py` | **parameterized copy** of the analysis logic from `contest-eval/analyze_meta.py` + `clone_detect.py` (pure functions over in-memory dicts). |
| `cdp.py` | dependency-light Chrome DevTools Protocol client (hand-rolled minimal RFC6455 websocket over stdlib `socket`). Opens its OWN background tab on `hackerrank.com`, runs a same-origin credentialed fetch, returns parsed JSON, and closes only that tab. This is what makes the live poller **unattended**. |
| `acquire.py` | acquisition layer: `FixturesAcquirer` (offline) and `LiveAcquirer` (UNATTENDED via `cdp.py`; legacy file-drop bridge available with `use_cdp=False`). Owns the field renames + the 429-safe fetch JS. |
| `mock_alert_server.py` | stdlib in-memory stand-in for the backend's two alert routes, used only by `run-demo.sh` for the offline end-to-end demo (the real backend needs Firestore). Mirrors the ingest contract exactly. |
| `test_monitoring.py` | runnable unit suite: core reproduces `clone_analysis.json`, verdict-seam round-trip, alert idempotency + id format. |
| `run-demo.sh` | one-command offline end-to-end demo (poller → ingest → admin read), self-cleaning. |
| `alerts.py` | builds Alert objects per the shared contract; mirrors backend required-field validation; stable idempotent ids. |
| `verdict_seam.py` | swappable file-queue LLM seam (`VerdictSeam.request()` / `.poll()`); never blocks the poller. |
| `verdict-responder-prompt.md` | ready-to-paste Claude Code `/loop` instruction that drains `pending/` → writes strict-schema verdicts to `done/`. |
| `validate_fixtures.py` | proves the analysis reproduces the committed `clone_analysis.json` and the poller runs end-to-end offline. |

## Why a parameterized copy (wrapper-over-fork, logged)

The canonical scripts in `/home/karthi/arogara/contest-eval/` hardcode their input
paths (`data/raw/contest_386562_meta.json`, `code_386562.json`) and run as side-effecting
`__main__` scripts (read files, write files, print). They are **not importable** as a
contest-agnostic library, and the task forbids editing the originals. So
`contest_eval_core.py` is a parameterized copy of *only the analysis functions*, kept
logically identical so results reproduce byte-for-byte (proven by `validate_fixtures.py`).
The originals are never modified.

## The shared ALERT CONTRACT

All three subsystems (this poller, the proctor backend ingest, the dashboard) agree on:

```jsonc
{
  "id": "<source>:<type>:<username_norm>:<contest_slug>:<dedupe>",  // stable + idempotent
  "source": "contest-eval",                  // or "proctor"
  "type": "peer_copy_cluster|recurring_pair|web_paste|first_attempt_solve|tough_first_attempt",
  "severity": "critical|warning|info",
  "timestamp": "<ISO 8601>",
  "contest_slug": "<slug>",
  "hackerrank_username": "<raw>",
  "username_norm": "<lowercased/sanitized>",
  "title": "<headline>",
  "detail": "<explanation>",
  "data": { /* cluster members, shared problems, submission ids, signals … */ },
  "verdict": { "status": "pending|real|false_positive|inconclusive", "reason"?, "by"? }
}
```

Required on ingest: `source, type, severity, timestamp, hackerrank_username, title`.
`username_norm` matches the backend's `normalizeUsername` (lowercase, trim, non-`[a-z0-9._-]`→`_`).
The id is deterministic so retried/repeat cycles **merge** in Firestore instead of duplicating.

### contest-eval alert types
- **`peer_copy_cluster`** (critical on HARD, warning on MED) — >1 distinct user with identical
  (skeleton) code on one problem. EASY/SQL clusters are intentionally dropped (weak evidence).
- **`recurring_pair`** (critical if 2+ shared problems, warning if single hard) — a pair sharing
  identical code; the methodology's most conclusive signal.
- **`web_paste`** (warning) — strong web/editorial provenance signature (GfG/LeetCode/foreign
  driver/raw smart-quotes/NBSP/zero-width/BOM) in fetched accepted code. The Java
  `public class Solution` template false positive is suppressed.
- **`first_attempt_solve`** (info) — candidate got a problem ACCEPTED on their FIRST submission
  attempt (zero prior wrong attempts) on a NORMAL (non-tough) problem. A corroborator only;
  never a standalone accusation (per methodology: zero-iteration is not a flag alone).
- **`tough_first_attempt`** (critical) — a first-attempt accepted solve on a TOUGH problem.
  "Tough" = the challenge slug/id is operator-marked in `alert-config.json`'s `tough_questions`
  list **OR** it is data-derived hard (≤10 solvers); the manual list wins/augments the
  derivation. This is the real "solved a tough question on the first attempt" flag and is
  emitted *instead of* `first_attempt_solve` for tough problems.
  (The former `fast_solve` type is retained only as a deprecated config alias of
  `first_attempt_solve`; no alerts are emitted under that name anymore.)

#### Marking tough questions (`tough_questions`)
`alert-config.json` carries a top-level `"tough_questions": []` array. Add challenge slugs/ids
the operator considers tough; any first-attempt solve on those fires `tough_first_attempt`
(critical) instead of `first_attempt_solve` (info). Leave it empty to fall back purely to the
auto ≤10-solver hard derivation.

## Usage

```bash
# offline (no browser, no HR network) — validation / replay
python3 poller.py --fixtures /home/karthi/arogara/contest-eval/MCET-06-26/386521-slot1 \
  --contest-id 386521 --slug coding-contest-mcet-june-2026 --once --no-post

# live loop, posting to the backend
python3 poller.py --slug coding-contest-mcet-june-2026 --contest-id 386521 \
  --api-base https://<backend> --api-key "$ALERTS_INGEST_API_KEY" --interval 60

# single live cycle, dry run (writes alerts to .data/, no POST)
python3 poller.py --slug <slug> --contest-id <id> --once --dry-run
```

Flags: `--contest-id --slug --api-base --api-key --interval --once --fixtures DIR
--data-dir --verdict-queue --verdict-max-cycles --no-post --dry-run`.

### Live acquisition (UNATTENDED, via cdp.py, non-disruptive)

`python3 poller.py --live ...` drives the authenticated Chromium on `:9222` **by itself** —
no agent, no chrome-devtools MCP. Each cycle `LiveAcquirer` calls `cdp.run_fetch(...)`, which
opens its **own** background tab on `hackerrank.com`, runs the same-origin credentialed
`fetch()` JS (metadata + 429-safe hardest-first code fetch), returns the parsed JSON, and
closes **only that tab**. The user's existing tabs are never navigated, activated, or closed,
and the browser is never closed. If `:9222` is unreachable or the tab never reaches the HR
origin, the fetch raises and the poller converts it to `LiveUnavailable` → fall back to
`--fixtures`. (`--live-bridge` keeps the legacy agent-driven file-drop path for a machine with
no debuggable Chrome.)

The 429-safe code fetch (per `contest-eval/METHOD-handoff.md`): detect HTTP 429 explicitly and
**never store a failed fetch**, ~1.2s between fetches, 8s back-off on 429, hardest-accepted-first,
accumulate on `window.__code` + `localStorage` (survives navigation, survives tool-timeout).

## Verdict seam (LLM judgment, subscription only)

Ambiguous alerts (`web_paste`, single-hard `recurring_pair`, MED `peer_copy_cluster`) are
written to `night-run/verdict-queue/pending/<id>.json`. Run the `/loop` in
`verdict-responder-prompt.md`; it reads the actual code, applies the difficulty-weighting +
Java-template rules, and writes `done/<id>.json` (`status ∈ {real, false_positive, inconclusive}`).
The poller reads `done/` each cycle and attaches the verdict. If no verdict appears within
`--verdict-max-cycles`, the verdict stays `{status:"pending"}` — **the poller never blocks**.

The seam interface (`request` / `poll`) is swappable: a future C3 transport can plug in without
touching `poller.py`. (C3 is intentionally **not** built here.)

## Validation

```bash
python3 validate_fixtures.py
```
Proves: (1) the parameterized core reproduces the committed `clone_analysis.json` byte-for-byte
for both MCET slots (recurring_pairs / exact / skeleton / tight), (2) the full alert build
produces only contract-valid, unique-id alerts, (3) the poller runs end-to-end via `--fixtures`.

Live acquisition was confirmed once read-only against `:9222` (leaderboard total 291, judge total
1569, renamed fields present), then the agent's own tab was closed — user tab untouched.

## PII / git hygiene (HARD constraints)

- `monitoring/.data/` (live alerts carry candidate usernames + code) is **gitignored**.
- `night-run/verdict-queue/` is gitignored.
- The MCET fixtures and any candidate code/meta pulled into this repo are gitignored
  (`monitoring/**/data/raw/`, `code_*.json`, `contest_*_meta.json`).
- No deploy. The poller only POSTs to whatever `--api-base` you pass.
