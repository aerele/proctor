# HOW-TO-RUN — contest-eval monitoring (Phase 1, unattended)

Copy-pasteable runbook for the four moving parts: **backend**, **admin frontend**,
**poller** (fixtures + live), and the **LLM verdict responder**. Everything below
is local; nothing deploys.

Repo root assumed: `/home/karthi/arogara/proctor`.

> **Fastest sanity check first:** `bash monitoring/run-demo.sh` runs the whole
> poller → ingest → admin-read loop offline (fixtures + a stdlib mock backend),
> self-cleaning. If that is green, the pipeline is wired. The sections below are
> the full manual stack.

---

## 0. One-time

```bash
cd /home/karthi/arogara/proctor
npm install          # installs backend + frontend deps (workspaces)
```

---

## (a) Backend — alerts API, locally

The real backend serves `POST /api/alerts` (header `x-api-key`) and
`GET /api/admin/alerts` (header `x-admin-password`).

```bash
cd /home/karthi/arogara/proctor/backend
ALERTS_INGEST_API_KEY='dev-ingest-key-not-a-secret' \
ADMIN_PASSWORD='dev' \
EVIDENCE_BUCKET='local-proctor-evidence' \
PUBLIC_APP_ORIGIN='*' \
PORT=8080 \
npx @google-cloud/functions-framework --target=api
# (equivalently: npm start --workspace backend, from the repo root, with the same env)
```

- Listens on **http://127.0.0.1:8080**.
- Use **long, unique** real values for `ALERTS_INGEST_API_KEY` / `ADMIN_PASSWORD`
  in any non-local setting (`openssl rand -base64 32`). The values above are
  throwaway local placeholders.

> **Firestore caveat (read this).** `/api/alerts` and `/api/admin/alerts` write
> and read **Firestore**. On a machine **with** GCP credentials (ADC) or a running
> Firestore emulator (`FIRESTORE_EMULATOR_HOST=...`), the commands above serve the
> alert routes for real. On a laptop **without** gcloud / emulator / creds (this
> box), those two routes 500 at request time on `new Firestore()`. For a fully
> offline demo of the same contract, use `monitoring/run-demo.sh` (section (c2)),
> which swaps in `monitoring/mock_alert_server.py` — an in-memory stand-in that
> mirrors the backend contract exactly. The poller and frontend do not care which
> backend answers, as long as the two routes behave.

---

## (b) Frontend — admin Alerts Console (demo mode)

```bash
cd /home/karthi/arogara/proctor
VITE_DEMO_MODE=true VITE_ADMIN_PASSWORD=dev npm run dev
```

- Open **http://localhost:5173/admin**, unlock with `dev`.
- Demo mode runs the full admin UI without a backend (fake data in `localStorage`).
  To point the admin console at a **real** backend instead, set
  `VITE_API_BASE_URL=http://127.0.0.1:8080` (and **not** `VITE_DEMO_MODE`) in
  `frontend/.env.local`, with `VITE_ADMIN_PASSWORD` = the backend `ADMIN_PASSWORD`.

---

## (c1) Poller — FIXTURES mode (offline, no browser, no GCP)

Deterministic replay against the committed MCET fixtures. Proves analysis + alert
build + POST without any network to HackerRank.

```bash
cd /home/karthi/arogara/proctor
python3 monitoring/poller.py \
  --fixtures /home/karthi/arogara/contest-eval/MCET-06-26/386521-slot1 \
  --contest-id 386521 --slug coding-contest-mcet-june-2026 \
  --once \
  --api-base http://127.0.0.1:8080 \
  --api-key 'dev-ingest-key-not-a-secret'
# add --no-post to skip the POST and just write alerts to monitoring/.data/.
```

## (c2) Poller — LIVE mode (UNATTENDED, drives Chrome on :9222)

This is the headline change: the poller now fetches HackerRank data **by itself**
through `monitoring/cdp.py` (a dependency-light Chrome DevTools Protocol client).
Each cycle it opens its **own** background tab on `hackerrank.com`, runs the
same-origin credentialed fetch, and **closes only that tab** — it never touches
your other tabs.

Prereq: a Chromium already running with remote debugging and a **logged-in
HackerRank session**:

```bash
# (Karthi launches Chrome himself with the debugging port; e.g.)
# chromium --remote-debugging-port=9222 --user-data-dir=/path/to/profile
curl -s http://127.0.0.1:9222/json/version   # should print Browser/…; confirms :9222 is up
```

Run the live poller:

```bash
cd /home/karthi/arogara/proctor
python3 monitoring/poller.py --live \
  --slug coding-contest-mcet-june-2026 --contest-id 386521 \
  --api-base http://127.0.0.1:8080 \
  --api-key 'dev-ingest-key-not-a-secret' \
  --interval 60
# one live cycle, no POST (writes alerts to monitoring/.data/):
python3 monitoring/poller.py --live --once --dry-run \
  --slug coding-contest-mcet-june-2026 --contest-id 386521
```

- If `:9222` is down or the tab never reaches the HR origin, the live fetch raises
  a clear error and that cycle reports `metadata-unavailable` (or skips code) —
  **fall back to fixtures** (section c1). The loop never crashes on a transient
  browser hiccup.
- `--live-bridge` selects the **legacy** agent-driven file-drop path instead of
  the unattended CDP driver (only for a machine with no debuggable Chrome).
- `--devtools-url http://127.0.0.1:9222` overrides the DevTools endpoint.

Live output (alerts carry candidate usernames + code) is written under the
**gitignored** `monitoring/.data/`.

---

## (d) LLM verdict responder — `claude` + `/loop`

Ambiguous flags (`web_paste`, single-hard `recurring_pair`, MED
`peer_copy_cluster`) are written to `night-run/verdict-queue/pending/`. A
human-launched Claude Code `/loop` drains them, reads the actual candidate code,
and writes strict-schema verdicts to `done/`. **Subscription only — no paid API.**

Launch Claude Code (Opus) with read access to the contest-eval run dirs, then run
`/loop`:

```bash
cd /home/karthi/arogara/proctor
claude --model opus --add-dir /home/karthi/arogara/contest-eval
```

Inside that session, paste:

```
/loop 1m Act as the contest-eval verdict responder per
monitoring/verdict-responder-prompt.md: each iteration, drain
night-run/verdict-queue/pending/ — for every request that has no matching
done/<id>.json, read the actual code for the cited submissions, apply the
difficulty-weighting + Java-template false-positive rules, and write a
strict-schema verdict ({id,status,reason,by}, status ∈ real|false_positive|
inconclusive) atomically to night-run/verdict-queue/done/<id>.json. Do not touch
pending/. Stop after pending/ has been empty for two iterations.
```

- `/loop 1m` re-runs the instruction every minute. The poller reads `done/` each
  cycle and attaches the verdict; if none appears within `--verdict-max-cycles`,
  the alert stays `{status:"pending"}` and is **never blocked**.
- The full rubric (the load-bearing judgment rules) lives in
  `monitoring/verdict-responder-prompt.md` — that file is the source of truth; the
  one-liner above just points the loop at it.

---

## Future: C3 transport (one-line note)

The verdict seam depends only on `VerdictSeam.request()` / `.poll()`. A future
**C3** transport can implement those two methods to route verdict requests over
Telegram/DM instead of the `pending/`→`done/` filesystem queue — **`poller.py`
would not change**. C3 is intentionally not built in Phase 1.

---

## Quick verification (run these to self-check)

```bash
python3 monitoring/test_monitoring.py     # unit suite (core repro, seam, idempotency, id format)
bash    monitoring/run-demo.sh            # full fixtures end-to-end loop (self-cleaning)
python3 monitoring/cdp.py                 # live :9222 smoke (own tab, read-only; exit 2 if :9222 down)
python3 monitoring/validate_fixtures.py   # byte-for-byte clone_analysis.json reproduction
```
