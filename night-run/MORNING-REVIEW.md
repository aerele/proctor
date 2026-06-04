# MORNING REVIEW — for Karthi

Curated list of **decisions that may need your attention** and **things that must be tested**, from the overnight build.
Only non-trivial items go here. Chronological detail is in `NIGHT-LOG.md`.

_Last updated: 2026-06-04 (goal-set)._

---

## ⚠️ MUST TEST IN THE MORNING (cannot be verified autonomously)

1. **GCS contest-folder storage change — UNTESTED against a live bucket.** No GCP access overnight. Change is surgical + backward-compatible (slug prefix only, legacy fallback when no contest URL). **Verify a real upload lands at `contests/<contest-slug>/sessions/<username>/<session_id>/…`** and that the existing upload/signing/admin-evidence flow is intact. Also confirm `video-worker` still finds chunks (its merge path was updated to match).
2. **Live HackerRank polling** — coded + validated against fixtures; live-validated against your `:9222` session only if it stayed open. Re-run a live poll cycle to confirm leaderboard/people/submissions fetch + the 429-safe code-fetch behave on real data.
3. **Backend deploy** — alerts API + contest-folder change need `./backend/deploy-gcp.sh` with your authenticated gcloud + the new `ALERTS_INGEST_API_KEY` env var (see below). Nothing was deployed overnight.

---

## ❓ OPEN DECISIONS — I proceeded on a sensible DEFAULT; confirm or correct

1. **Alert taxonomy (live console):** surface **deterministic** `clone_analysis.json` flags (peer-copy clusters, recurring pairs, web-paste artifacts) live; **defer the LLM verdict layer** (it was an interactive agent workflow, not a committed script). → confirm you don't want per-poll LLM verdicts.
2. **Min-solver difficulty guard:** early in a live contest every problem looks "hard" (few solvers) → false clone significance. Default: a problem only counts as conclusive-for-clones after **≥ 8 accepted solvers**. → pick your number.
3. **Sure-shot proctor alert severity:** `recording_stopped` / `screen_share_stopped` / `invalid_share_surface` / `recording_error` = **CRITICAL**; `ip_address_changed` = **WARNING**; visibility/blur/focus/clipboard = **not surfaced** (noisy). → confirm.
4. **Poll cadence:** metadata-first (leaderboard + judge_submissions, unthrottled) every cycle; lazy code-fetch only for **flagged** candidates, hardest-accepted-first, ~1s/8s sleeps, 429-drop. → confirm cadence.
5. **Join key (alert → session):** `contest_slug + username_norm` (`username_norm = lowercase/sanitized hackerrank_username`). Added `contest_slug` to the session doc at start. → confirm.
6. **GCS prefix cutover:** clean cutover (old objects auto-expire in 3 days) **and** I store `storage_prefix` on the session doc for robustness. → confirm clean cutover is OK.
7. **Alert storage:** new Firestore collection **`proctor_alerts`** (carries candidate PII; same handling as session docs). → confirm.
8. **LLM-judgment transport — per your correction (no paid API; subscription only):** deterministic loop is the backbone; LLM verdicts are decoupled via a **file-queue** (`night-run/verdict-queue/pending|done`). **Default responder = a Claude Code session you keep open running `/loop 1m`** that drains pending requests → writes fixed-schema verdicts (your subscription, no API). **Option B (built alongside) = C3 "ContestEval" injection** — inject scoped context into a CC session via the C3 broker, capture the fixed-format reply (more token-efficient). Config-selectable; graceful-degrades to deterministic-only (verdict stays `pending`) if no responder runs. → In the morning: pick which transport to run; the `/loop` prompt + steps are in `HOW-TO-RUN.md`.

## 🔑 KEYS / SECRETS YOU SET AT DEPLOY (I did NOT invent real secrets)
- **`ALERTS_INGEST_API_KEY`** — a NEW secret for the alerts-ingestion API, **separate from `ADMIN_PASSWORD`** (which is baked into the frontend bundle = effectively public). I used a placeholder dev key for local tests; **you generate the real one** (`openssl rand -base64 32`) and set it on Cloud Run + in the laptop poller.

## ❓ DECISIONS HELD FOR YOU (not started)
1. **Extension (stretch #2) permissions** — held entirely per your instruction. Tell me the extension's *one-line job* and I'll scaffold MV3 with the **minimum** permissions for exactly that (smoothest CWS approval).
2. **Stretch #1 (logo-missing tab-away detection)** — needs a **sample recording `.webm` + a canonical HackerRank-logo crop** from you to tune the matcher. I'll build the scaffold + matcher interface; tuning waits on the sample.

---

## 🟢 DECISIONS I MADE AND PROCEEDED ON (FYI — reversible, flag if you disagree)

_(appended during the night)_
