#!/usr/bin/env python3
"""post_submission_events — push SUBMISSION-TIME MARKERS to the proctor backend.

Reads a contest metadata JSON (the poller's cached live meta, or a fixtures
slot's raw contest_<id>_meta.json) and POSTs every code submission a student
made to <api-base>/api/submission-events, so the admin recording-review timeline
can overlay GREEN (valid / Accepted) and RED (invalid / terminal failure) markers
at each submission's REAL time.

The backend de-dups by submission_id (one doc per username_norm:contest_slug),
so this is idempotent — re-running merges rather than duplicating.

Usage:
  post_submission_events.py --contest-slug <slug> --api-base <url> --api-key <key>
      [--meta monitoring/.data/live/results/meta.json]   # default (poller cache)
      [--fixtures <slotDir>]                              # read contest_<id>_meta.json
      [--batch 500] [--dry-run]

CLASSIFICATION (matches the backend contract):
  - "Accepted"                          -> valid = True
  - terminal failures (Wrong Answer,
    Compilation error, Runtime Error,
    Segmentation Fault, Terminated due
    to timeout, Abort Called, ...)      -> valid = False
  - transient (Processing, Queued)      -> SKIPPED (no marker yet)

`created` is a Unix epoch; values < 1e11 are treated as SECONDS (x1000), else ms.

Secrets are NEVER hardcoded — pass --api-key (or via your shell). Reuses urllib
exactly like poller.py / enrich.py.
"""
import argparse
import datetime
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_META = HERE / ".data" / "live" / "results" / "meta.json"

# Terminal statuses that are unambiguously "not accepted" → RED marker. Anything
# NOT in TRANSIENT_STATUSES and NOT "Accepted" is treated as a terminal failure
# (so a new HackerRank failure label we haven't enumerated still renders RED
# rather than silently vanishing). TRANSIENT is the only "skip" set.
TRANSIENT_STATUSES = {"processing", "queued"}
ACCEPTED_STATUS = "accepted"


def log(msg):
    print(f"[submission-events] {msg}", flush=True)


def classify(status):
    """Return 'valid' | 'invalid' | 'skip' for a HackerRank submission status.

    Accepted        -> 'valid'
    Processing/Queued -> 'skip' (transient; no marker yet)
    everything else -> 'invalid' (terminal failure)
    """
    s = str(status or "").strip().lower()
    if s in TRANSIENT_STATUSES:
        return "skip"
    if s == ACCEPTED_STATUS:
        return "valid"
    return "invalid"


def epoch_to_iso(created):
    """Normalize a Unix epoch (DETECT seconds vs ms) to an ISO 8601 UTC string.

    Values < 1e11 are seconds (x1000); larger values are already milliseconds.
    """
    value = int(created)
    if value < 100_000_000_000:  # 1e11 — anything smaller is seconds
        value *= 1000
    dt = datetime.datetime.fromtimestamp(value / 1000, tz=datetime.timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def load_meta(meta_path=None, fixtures_dir=None):
    """Load a contest meta dict from an explicit --meta path or a --fixtures slot.

    --fixtures resolves the slot's raw contest_<id>_meta.json (accepting either
    <dir>/data/raw/<file> or <dir>/<file>), mirroring acquire.py's layout.
    """
    if fixtures_dir:
        base = Path(fixtures_dir)
        candidates = sorted(base.glob("data/raw/contest_*_meta.json")) \
            or sorted(base.glob("contest_*_meta.json"))
        if not candidates:
            raise FileNotFoundError(f"no contest_*_meta.json under {base}")
        path = candidates[0]
    else:
        path = Path(meta_path or DEFAULT_META)
    if not path.exists():
        raise FileNotFoundError(f"meta json not found: {path}")
    return json.loads(path.read_text())


def build_events(meta, contest_slug):
    """Turn a meta dict's `submissions` into backend event objects.

    Groups by user (for the summary), classifies valid/invalid, skips transient,
    normalizes `created`→ISO. Returns (events, summary) where summary has
    per-status counts and the distinct user set.
    """
    submissions = meta.get("submissions") or []
    events = []
    users = set()
    valid_n = invalid_n = skipped_n = 0
    for sub in submissions:
        verdict = classify(sub.get("status"))
        if verdict == "skip":
            skipped_n += 1
            continue
        user = sub.get("user")
        if not user:
            continue
        users.add(user)
        is_valid = verdict == "valid"
        if is_valid:
            valid_n += 1
        else:
            invalid_n += 1
        events.append({
            "hackerrank_username": str(user),
            "contest_slug": contest_slug,
            "submission_id": int(sub["id"]),
            "challenge_slug": sub.get("ch") or "",
            "challenge_name": sub.get("chName") or "",
            "lang": sub.get("lang") or "",
            "status": str(sub.get("status") or ""),
            "valid": is_valid,
            "submitted_at": epoch_to_iso(sub.get("created") or 0),
        })
    summary = {
        "users": len(users),
        "valid": valid_n,
        "invalid": invalid_n,
        "skipped": skipped_n,
        "total_events": len(events),
    }
    return events, summary


def post_submission_events(api_base, api_key, events, timeout=20):
    """POST one batch to <api-base>/api/submission-events. Returns (ok, info)."""
    url = api_base.rstrip("/") + "/api/submission-events"
    body = json.dumps({"events": events}).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("content-type", "application/json")
    req.add_header("x-api-key", api_key or "")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return True, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:500]
        return False, f"HTTP {e.code}: {detail}"
    except (urllib.error.URLError, OSError) as e:
        return False, f"network error: {e}"


def chunked(seq, size):
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


def build_argparser():
    p = argparse.ArgumentParser(description="post contest submission-time markers to the proctor backend")
    p.add_argument("--meta", default=None,
                   help=f"contest meta json (default: {DEFAULT_META})")
    p.add_argument("--fixtures", default=None,
                   help="fixtures slot dir; reads its raw contest_<id>_meta.json")
    p.add_argument("--contest-slug", required=True,
                   help="contest slug used to key the backend docs (REQUIRED)")
    p.add_argument("--api-base", default="http://127.0.0.1:8080",
                   help="proctor backend base URL")
    p.add_argument("--api-key", default="", help="x-api-key for ingest")
    p.add_argument("--batch", type=int, default=500, help="events per POST (default 500)")
    p.add_argument("--dry-run", action="store_true",
                   help="classify + build events but do not POST")
    return p


def main(argv=None):
    args = build_argparser().parse_args(argv)
    if args.meta and args.fixtures:
        build_argparser().error("--meta and --fixtures are mutually exclusive")

    meta = load_meta(meta_path=args.meta, fixtures_dir=args.fixtures)
    events, summary = build_events(meta, args.contest_slug)
    log(f"slug={args.contest_slug} users={summary['users']} "
        f"valid={summary['valid']} invalid={summary['invalid']} "
        f"skipped(transient)={summary['skipped']} events={summary['total_events']}")

    if not events:
        log("no events to post (all transient or no submissions).")
        return 0

    if args.dry_run:
        log(f"dry-run: would POST {summary['total_events']} events in "
            f"{(len(events) + args.batch - 1) // args.batch} batch(es); not posting.")
        return 0

    posted = 0
    for batch in chunked(events, max(1, args.batch)):
        ok, info = post_submission_events(args.api_base, args.api_key, batch)
        if not ok:
            log(f"POST failed: {info}")
            return 1
        stored = info.get("stored", len(batch)) if isinstance(info, dict) else len(batch)
        posted += stored
        log(f"posted batch: stored={stored}")

    log(f"done: posted={posted} valid={summary['valid']} invalid={summary['invalid']} "
        f"users={summary['users']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
