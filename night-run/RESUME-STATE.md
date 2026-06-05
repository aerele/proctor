# RESUME STATE — read this FIRST after a context compaction

Operational snapshot so the live monitoring keeps being managed correctly. Secrets are in the
gitignored `monitoring/.data/session.local` (admin password etc.). Updated 2026-06-05.

## 🔴 LIVE RIGHT NOW (the thing compaction must not lose)
- **A real contest is being monitored live:** `kec-aerele-coding-contest`, contest-id **386632**, on HackerRank.
- **I am running + managing the poller** as a background process (Bash `run_in_background`, job id `bc3wxzc2y`, log `/tmp/proctor-poller.log`). It polls HackerRank via the user's logged-in Chrome on `:9222`, evaluates, and POSTs alerts to the deployed backend every 60s.
  - Check it: `pgrep -af "poller.py --live"` ; `grep -E "cycle [0-9]+:|POST .*ok=" /tmp/proctor-poller.log | tail`.
  - Restart it: re-scrape the full command (incl. `--api-key`) from `pgrep -af "poller.py --live"`, or rebuild from `monitoring/.data/session.local`. Run from the repo root. It **hot-reloads `monitoring/alert-config.json` every cycle** — live tuning needs no restart.
  - If `:9222` is down or a cycle errors, the poller self-recovers / falls back; it does not crash.
- **Deployed backend:** `https://aerele-proctor-api-6wcofu4ula-el.a.run.app`. Verify alerts landed:
  `curl -fsS "$BACKEND_URL/api/admin/alerts" -H "x-admin-password: <see monitoring/.data/session.local>" -o /tmp/a.json` then summarize by type/severity (cap 500; do NOT print usernames).
- **Proctor app is also live** — students recording; `recording_stopped` / `ip_changed` sure-shot alerts are flowing into the same backend.
- **LLM verdict /loop:** runs in the USER's separate `claude --model opus --add-dir /home/karthi/arogara/contest-eval` session via the `/loop 1m …` prompt (see `night-run/HOW-TO-RUN.md` §d). Not confirmed running; many alerts show `verdict: pending` (most don't need a verdict — first-attempt/proctor alerts are conclusive).

## CONFIG DECISIONS (current, in monitoring/alert-config.json)
- `tough_questions` = **ONLY `challenge-7-aerele`, `challenge-8-aerele`, `challenge-9-aerele`** (per Karthi). The list is AUTHORITATIVE — `tough_first_attempt` fires ONLY for first-attempt solves on those three; the noisy ≤10-solver auto-rule is ignored when the list is non-empty (avoids false positives early in a contest).
- `first_attempt_solve` = **enabled** (info). `tough_first_attempt` = critical. peer_copy_cluster/recurring_pair = critical, web_paste = warning.
- To tune: edit `monitoring/alert-config.json` → applies on the poller's next cycle.

## PROJECT STATE
- Branch **`feat/roadmap-and-contest-eval`**, **PR #1 open** (base `master`; `main` is divergent — don't use it).
- Built + reviewed + tested: full `docs/ROADMAP.md` minus iframe + the contest-eval monitoring tool. Tests: backend **111**, monitoring **60**, frontend lint+build green. All morning feedback rounds (archive, room filters, alert-settings UI, near-live beacon/auto-poll, C1 admin-password hashing, student-UX recovery + prominent rules, contest-eval first_attempt/tough_first_attempt) done + pushed.
- The repo is self-documenting: top-level `README.md` + component READMEs + `night-run/HOW-TO-RUN.md`.

## OPEN / TODO
- See `night-run/MORNING-REVIEW.md` for the curated decisions + must-test items.
- **Rotate the ingest API key after the contest** (it was exposed in `ps`).
- S1 (logo→tab-away detector) tuning is HELD for a real recording + logo crop. S2 (extension) dropped.
- Verify alerts in the admin console: deployed `/admin`, password = `ADMIN_PASSWORD` (session.local).

## HOW TO KEEP MANAGING
Keep the poller background job alive (I'm notified if it exits). Periodically check the log + the backend alert counts. Apply any of Karthi's tuning by editing `alert-config.json`. The contest-eval pipeline + proctor app + backend are all live — treat changes carefully.
