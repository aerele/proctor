# Submission-Events Runbook

How to populate the proctor recording-review timeline with **submission-time
markers** — one GREEN (Accepted / valid) or RED (terminal failure / invalid)
marker at each student's REAL submission time, overlaid on the recording.

This is **two SEPARATE steps**, run as two SEPARATE instructions:

1. **DOWNLOAD** — produce a snapshot of the contest's submission metadata
   (`meta.json`) from the live HackerRank API.
2. **UPLOAD** — POST that snapshot's markers to the proctor backend.

Do them one at a time. The download step writes a snapshot file; the upload step
reads that exact file. They share state ONLY through the snapshot path you carry
from step 1 to step 2.

---

## Pipeline at a glance

```
DOWNLOAD                                         UPLOAD
--------                                         ------
poller.py --once --no-post                       post_submission_events.py
  drives Chromium :9222 over CDP                   reads the snapshot meta.json
  fetches leaderboard + judge_submissions          classifies each submission
  writes <data-dir>/live/results/meta.json         GREEN(Accepted) / RED(failure)
        |                                           POST /api/submission-events
        v                                           x-api-key == ALERTS_INGEST_API_KEY
  SNAPSHOT to /tmp/<slug>-meta-<ts>.json  ───────►  de-dups by submission_id (merge)
```

- `<data-dir>` default = `monitoring/.data`, so the live meta lands at
  `monitoring/.data/live/results/meta.json`. That path equals
  `post_submission_events.py` `DEFAULT_META`.
- That default `meta.json` is **OVERWRITTEN every poller cycle** (and by every
  other contest's poll). The download wrapper **snapshots it immediately** so a
  later poll can't clobber the data you're about to upload.

---

## STEP 1 — DOWNLOAD (one instruction)

### Precondition (live mode)

- Chromium must be running with `--remote-debugging-port=9222`, **and** have a
  tab logged in as a **HackerRank moderator** for the contest. The poller's CDP
  client opens its OWN background tab on `hackerrank.com` and runs a same-origin
  credentialed `fetch()`; without the moderator session the API returns nothing.
- If `:9222` is down or the HR session expired, no `meta.json` is produced and
  the wrapper exits with a clear error.

### Command

```bash
monitoring/download_submission_events.sh \
    --slug <CONTEST_SLUG> \
    --contest-id <CONTEST_ID> \
    [--data-dir monitoring/.data] \
    [--out /tmp/<slug>-meta-<unix-ts>.json] \
    [--devtools-url http://127.0.0.1:9222]
```

What it runs under the hood:

```bash
python3 monitoring/poller.py \
    --slug <CONTEST_SLUG> --contest-id <CONTEST_ID> \
    --once --no-post --no-enrich --data-dir <DIR>
# then: cp <DIR>/live/results/meta.json <OUT>
```

- `--once` — single cycle, then exit.
- `--no-post` — do NOT emit alerts; we only want the `meta.json` side-effect.
- `--no-enrich` — skip the admin name+room lookups (irrelevant to a pure meta
  download; avoids needless load on the live backend).

The wrapper prints the snapshot path and the submission count. **Carry that
snapshot path to step 2.**

### Offline alternative (no browser, no :9222)

```bash
monitoring/download_submission_events.sh \
    --fixtures /path/to/<contest-eval-slot-dir> \
    [--contest-id <CONTEST_ID>] \
    [--out /tmp/<slot>-meta-<unix-ts>.json]
```

Reads `data/raw/contest_<id>_meta.json` from a committed contest-eval run dir.
The slug is derived from the meta, so `--slug` is not required (use
`--contest-id` to disambiguate a dir holding multiple contests).

### Rate-limit rule (DOWNLOAD) — NO tight loop

If the poller logs **HTTP 429** or an **empty leaderboard**, HackerRank is
throttling you. **WAIT** (tens of seconds to a couple of minutes) and re-run the
download with `--once` again. **Do NOT tight-loop** — re-hitting `:9222` back to
back only deepens the 429. The snapshot will show `0 submissions` when this
happens; that is your signal to wait and retry, not to upload.

---

## STEP 2 — UPLOAD (a separate instruction)

### The slug-must-match rule (READ THIS)

`--contest-slug` **MUST equal the proctor sessions' `contest_slug`.** The backend
stores each marker under `username_norm:contest_slug`, and the admin
recording-review timeline reads markers back by that **same** slug. If the slug
doesn't match the sessions, the markers store fine but the timeline shows
**NOTHING** — no error, just an empty overlay. Verify the slug against the
sessions BEFORE uploading. (The download slug and the sessions slug are usually
the same string, but they are independent — confirm it.)

### Command

```bash
monitoring/upload_submission_events.sh \
    --meta /tmp/<slug>-meta-<unix-ts>.json \
    --contest-slug <SLUG-MATCHING-PROCTOR-SESSIONS> \
    --api-base <BACKEND_URL> \
    [--api-key <KEY>] \
    [--batch 500] \
    [--yes]
```

The wrapper **always runs a `--dry-run` first** (classifies valid / invalid /
skipped + prints counts, no POST). Unless you pass `--yes`, it then prompts you
to confirm before the real POST. On confirm it re-runs the SAME command
**without** `--dry-run`.

Under the hood (dry-run, then real):

```bash
python3 monitoring/post_submission_events.py \
    --meta <PATH> --contest-slug <SLUG> --api-base <URL> \
    --api-key <KEY> --batch 500 --dry-run     # classify + counts, no POST
python3 monitoring/post_submission_events.py \
    --meta <PATH> --contest-slug <SLUG> --api-base <URL> \
    --api-key <KEY> --batch 500               # real POST
```

### API-key sourcing (never hardcode / commit)

`--api-key` is the `x-api-key` header and **must equal the backend env
`ALERTS_INGEST_API_KEY`** (the backend's `requireApiKey` gate).

- If you pass `--api-key`, that value is used.
- If you DON'T, the wrapper tries to read it from a **running poller's** args via
  `pgrep -af poller.py` (extracting the `--api-key` value). A poller monitoring
  the same contest is already holding the right key.
- If no poller is running, fetch the backend env `ALERTS_INGEST_API_KEY` yourself
  and pass it via `--api-key`. **Never** hardcode or commit the key.

### Idempotent re-run rule (UPLOAD)

The uploader has **NO retry**. On a transient **503** or a network error, just
**RE-RUN the exact same command** — the backend upsert de-dups by
`submission_id` (it MERGES rather than duplicating), so re-runs never create
duplicate markers. Keep `--batch` **at or below 500** (the backend caps
5000/request; the proven safe chunk is 500 — a real run posted **6549 events in
14 batches of 500**).

### Args-too-long note — the uploader is IMMUNE

You do **not** need to worry about `ARG_MAX` ("Argument list too long") here. The
uploader streams the meta from a **FILE** (read inside `post_submission_events.py`)
and the events go in the **request body**, never through `argv`. The only place
that ever hit `ARG_MAX` was the old demo summary script that passed a giant JSON
blob on the command line — and that is already fixed to read the response from a
file. Nothing in the download/upload path puts contest data on the command line.

---

## End-to-end example (live)

```bash
# STEP 1 — DOWNLOAD (Chromium on :9222 logged in as HR moderator)
monitoring/download_submission_events.sh \
    --slug coding-contest-mcet-june-2026 \
    --contest-id 386521
# -> prints: SNAPSHOT WRITTEN: /tmp/coding-contest-mcet-june-2026-meta-1717900000.json

# STEP 2 — UPLOAD (slug MUST match the proctor sessions)
monitoring/upload_submission_events.sh \
    --meta /tmp/coding-contest-mcet-june-2026-meta-1717900000.json \
    --contest-slug coding-contest-mcet-june-2026 \
    --api-base https://<proctor-backend>
# -> dry-run summary -> confirm y -> POSTs in batches of 500
```

---

## Quick checklist

DOWNLOAD:
- [ ] Chromium on `:9222`, logged-in HackerRank-moderator tab (live mode)
- [ ] Ran `download_submission_events.sh` with `--slug` + `--contest-id`
- [ ] Snapshot path captured; submission count looks right (not 0)
- [ ] If 429 / empty leaderboard: WAITED and re-ran `--once` (no tight loop)

UPLOAD:
- [ ] `--contest-slug` equals the proctor sessions' `contest_slug`
- [ ] `--api-key` provided OR a poller is running to source it
- [ ] Reviewed the `--dry-run` counts before confirming
- [ ] `--batch` <= 500
- [ ] On 503 / network error: RE-RAN the same command (idempotent merge)
