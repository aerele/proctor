# MORNING REVIEW — for Karthi

Curated list of **decisions that may need your attention** and **things that must be tested**, from the overnight build.
Only non-trivial items go here. Chronological detail is in `NIGHT-LOG.md`.

_Last updated: 2026-06-04 (goal-set)._

---

## ⚠️ MUST TEST IN THE MORNING (cannot be verified autonomously)

1. **GCS contest-folder storage change — UNTESTED against a live bucket.** No GCP access overnight. Change is surgical + backward-compatible (slug prefix only, legacy fallback when no contest URL). **Verify a real upload lands at `contests/<contest-slug>/sessions/<username>/<session_id>/…`** and that the existing upload/signing/admin-evidence flow is intact. Also confirm `video-worker` still finds chunks (its merge path was updated to match).
2. **Live HackerRank polling** — coded + validated against fixtures; live-validated against your `:9222` session only if it stayed open. Re-run a live poll cycle to confirm leaderboard/people/submissions fetch + the 429-safe code-fetch behave on real data.
3. **Backend deploy** — alerts API + contest-folder change need `./backend/deploy-gcp.sh` with your authenticated gcloud + the new `ALERTS_INGEST_API_KEY` env var (see below). Nothing was deployed overnight.
4. **Real backend alert routes couldn't run offline** — `/api/alerts` + `/api/admin/alerts` hit Firestore (`new Firestore()`), and there's no gcloud/emulator/creds here, so a real `functions-framework` run 500s on those routes. They're **fully unit-tested (23/23, mocked Firestore)** and the end-to-end demo passes against `monitoring/mock_alert_server.py` (mirrors the contract exactly). **In the morning, validate against the real backend** (set `FIRESTORE_EMULATOR_HOST`, or deploy) so a real POST→Firestore→GET round-trip is confirmed.

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

**Phase 1 (monitoring slice):**
- **Unattended live acquisition** — built `monitoring/cdp.py` (hand-rolled stdlib WebSocket CDP client) so the poller drives Chrome on `:9222` ITSELF (deterministic loop, no agent-in-the-loop), per your "just keep looping and fetching" intent. Tested live: 291 participants / 1569 subs, your tabs untouched (opens + closes its own background tab).
- **`requireApiKey` is timing-safe** (crypto.timingSafeEqual). I left the existing `requireAdmin` as-is (plain `!==`) to not change current behavior — say if you want it hardened too (one-liner).
- **Poller heuristics** (sensible defaults, confirm): lazy code-fetch only for single-attempt HARD solves or zero-iteration ≥3 solves; severity — `recurring_pair` critical if 2+ shared problems else warning, `peer_copy_cluster` critical on HARD / warning on MED / dropped on EASY, `web_paste` warning, `fast_solve` info. Ambiguous cases (web_paste, single-hard recurring_pair, MED cluster) route to the LLM verdict seam; conclusive criticals skip it.
- **`frontend/public/sample.webm`** is a 2s ffmpeg placeholder clip for the demo video link — swap for a real clip if desired.

**Phase 2 (backend roadmap completion) — decisions/assumptions to confirm:**
- **Passcodes fully removed** (0.1): start gated by the contest **time window only**; end gated by the **assurance checkbox only**. The settings fields (`passcode_hash`/`end_code_hash`) are left present-but-unenforced (still persisted if an older admin UI posts them) — say if you want them deleted outright.
- **Single-session conflict → `pending_approval`** (0.3): a 2nd start (no/other `session_id`) for an already-active `(username_norm, contest_slug)` is created as `pending_approval` with `blocked_by_session_id`. `approve` ends the old + activates the new; `bypass` activates the new WITHOUT ending the old (contingency). Confirm that bypass-keeps-both is the behaviour you want.
- **Resume key** = `session_id` the browser stores; `POST /api/session/resume` returns the session verbatim (no re-collection). A replayed `session_id` on `/start` is also idempotent. The replay match also requires the same `contest_slug` — if you change `contest_url` mid-test, in-flight students would fall to `pending_approval` instead of resuming (don't change contest_url mid-test).
- **Stats "yet-to-start":** no student roster is stored, so the backend can't compute yet-to-start; `/api/admin/stats` returns `not_started_or_total = total` (session docs). The frontend can estimate once a roster exists. Confirm that's acceptable, or give me a roster source.
- **`video_key` on sure-shot alerts** = merged review video if present, else the raw `…/screen/` chunk PREFIX (a folder, not a single file) so the console can still deep-link to the evidence folder before the merge runs. Confirm folder-prefix deep-link is OK pre-merge.
- **Firestore composite index** (`username_norm`+`contest_slug`) is REQUIRED by the new queries. `backend/firestore.indexes.json` + a `deploy-gcp.sh` step create it idempotently. **Must run on the real project** before the single-session / stats / bulk-action queries work — otherwise Firestore returns an error with a one-click create URL. Verify after deploy.
- **video-worker** now scans BOTH `sessions/<user>/` and `contests/<slug>/sessions/<user>/` and writes the merged video beside its chunks; manifest/result carry `contest_slug`. Re-confirm a real merge against the new layout in the morning (no GCP overnight).

**Phase 2 — NOT yet committed.** Files changed: `backend/src/handler.mjs`, `backend/deploy-gcp.sh`, `backend/firestore.indexes.json` (new), `backend/test/phase2.test.mjs` (new), `video-worker/src/server.mjs`, `README.md`. Tests: **52/52 green** (23 Phase-1 + 29 Phase-2).

_(more appended as phases complete)_
