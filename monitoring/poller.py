#!/usr/bin/env python3
"""poller — contest-eval LIVE POLLER.

Standalone, parameterized. Each cycle:
  1. fetch leaderboard + judge_submissions metadata (UNTHROTTLED) via the acquirer
  2. deterministic analysis (reuse analyze_meta + clone_detect logic, parameterized
     in contest_eval_core) — purely metadata where possible
  3. for FLAGGED candidates ONLY, lazily fetch submission code (429-SAFE: never store
     a failed fetch; hardest-accepted-first; throttled; persisted per batch by the
     browser-side JS) and run clone / web-paste detection on it
  4. build Alert objects (shared contract) and POST them to <api-base>/api/alerts
     with header x-api-key. Ambiguous alerts also go through the verdict seam.

WRAPPER-OVER-FORK: the deterministic analysis is a PARAMETERIZED COPY of the
contest-eval scripts (see contest_eval_core.py docstring for why the originals
could not be imported as-is). The originals in the other repo are NOT edited.

Usage:
  poller.py --slug <slug> --contest-id <id> --api-base <url> --api-key <key>
            [--interval 60] [--once] [--fixtures DIR] [--data-dir DIR]
            [--no-post] [--dry-run]

If --fixtures is given, acquisition is fully offline (no browser, no network for
HR). --no-post / --dry-run skip the alert POST (writes alerts to .data/ instead).
"""
import argparse
import json
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import contest_eval_core as core
import alerts as alertmod
import acquire as acq
from verdict_seam import VerdictSeam, is_ambiguous


def log(msg):
    print(f"[poller] {msg}", flush=True)


def post_alerts(api_base, api_key, alert_list, timeout=20):
    """POST alerts to <api-base>/api/alerts with x-api-key. Returns (ok, info)."""
    url = api_base.rstrip("/") + "/api/alerts"
    body = json.dumps({"alerts": alert_list}).encode("utf-8")
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


def select_code_targets(meta, flagged, chal_by_slug):
    """Accepted submission ids of FLAGGED candidates ONLY, hardest-first.
    This is the lazy/expensive set we ask the acquirer to fetch code for."""
    def solved(slug):
        return chal_by_slug.get(slug, {}).get("solved", 999) or 999
    targets = []
    flagged_users = set(flagged)
    for s in meta["submissions"]:
        if s["user"] not in flagged_users:
            continue
        if s["status"] != "Accepted":
            continue
        targets.append((solved(s["ch"]), str(s["id"])))
    # hardest (fewest solvers) first
    targets.sort(key=lambda t: t[0])
    return [sid for _, sid in targets]


def run_cycle(args, acquirer, seam, cycle_idx):
    chal_by_slug = {}
    log(f"cycle {cycle_idx}: fetching metadata (mode={acquirer.mode})")
    try:
        meta = acquirer.fetch_metadata()
    except acq.LiveUnavailable as e:
        log(f"metadata unavailable: {e}")
        return {"cycle": cycle_idx, "status": "metadata-unavailable"}
    slug = meta.get("slug") or args.slug
    chal_by_slug = {c["slug"]: c for c in meta["challenges"]}
    log(f"  participants={len(meta['leaderboard'])} subs={len(meta['submissions'])} "
        f"challenges={len(meta['challenges'])}")

    # deterministic metadata analysis (all participants)
    ma = core.analyze_meta(meta)
    flagged = core.metadata_flag_candidates(ma)
    log(f"  metadata-flagged candidates (code-fetch shortlist): {len(flagged)}")

    # lazily fetch code for flagged candidates' accepted subs only (429-safe)
    code = {}
    code_targets = select_code_targets(meta, flagged, chal_by_slug)
    if code_targets:
        log(f"  fetching code for {len(code_targets)} accepted subs (flagged only, hardest-first)")
        try:
            code = acquirer.fetch_code(code_targets)
        except acq.LiveUnavailable as e:
            log(f"  code unavailable this cycle (will retry next cycle): {e}")
            code = {}
        log(f"  code fetched: {len(code)} subs (429-safe: failed fetches not stored)")

    # clone / web-paste detection on whatever code we actually have
    clone = core.analyze_clones(meta, code)
    code_present_ids = set(code.keys())

    # build alerts (shared contract)
    alert_list = alertmod.build_alerts(
        slug, clone, ma, flagged, code_present_ids, chal_by_slug=chal_by_slug)
    # client-side validate (mirror backend)
    bad = [(a["id"], alertmod.validate_alert(a)) for a in alert_list]
    bad = [(i, e) for i, e in bad if e]
    if bad:
        log(f"  WARNING: {len(bad)} alerts failed client validation: {bad[:3]}")
        valid_ids = {i for i, e in bad}
        alert_list = [a for a in alert_list if a["id"] not in valid_ids]

    # verdict seam: route ambiguous ones; attach any resolved verdict
    n_routed = 0
    for a in alert_list:
        if is_ambiguous(a):
            seam.request(a)
            v = seam.poll(a)
            a["verdict"] = v
            n_routed += 1
    log(f"  alerts built: {len(alert_list)} (ambiguous routed to verdict seam: {n_routed}); "
        f"seam stats: {seam.stats()}")

    by_type = {}
    for a in alert_list:
        by_type[a["type"]] = by_type.get(a["type"], 0) + 1
    log(f"  alert types: {by_type}")

    # persist this cycle's alerts to .data (PII -> gitignored)
    outdir = Path(args.data_dir) / "alerts"
    outdir.mkdir(parents=True, exist_ok=True)
    (outdir / f"cycle-{cycle_idx:04d}.json").write_text(json.dumps(alert_list, indent=1))

    # POST
    posted = None
    if alert_list and not (args.no_post or args.dry_run):
        ok, info = post_alerts(args.api_base, args.api_key, alert_list)
        posted = {"ok": ok, "info": info}
        log(f"  POST /api/alerts -> ok={ok} info={info if not ok else info}")
    elif alert_list:
        log(f"  (post skipped: {'--no-post' if args.no_post else '--dry-run'}); "
            f"alerts written to {outdir}")

    return {
        "cycle": cycle_idx, "status": "ok", "slug": slug,
        "n_flagged": len(flagged), "n_code": len(code),
        "n_alerts": len(alert_list), "by_type": by_type,
        "posted": posted, "seam": seam.stats(),
    }


def build_argparser():
    p = argparse.ArgumentParser(description="contest-eval live poller")
    p.add_argument("--contest-id", help="HackerRank numeric contest id")
    p.add_argument("--slug", help="contest slug (required for live mode)")
    p.add_argument("--api-base", default="http://127.0.0.1:8080",
                   help="proctor backend base url")
    p.add_argument("--api-key", default="", help="x-api-key for /api/alerts ingest")
    p.add_argument("--interval", type=float, default=60.0,
                   help="seconds between cycles (loop mode)")
    p.add_argument("--once", action="store_true", help="run a single cycle and exit")
    p.add_argument("--live", action="store_true",
                   help="explicit UNATTENDED live mode: drive Chrome on :9222 via "
                        "monitoring/cdp.py (own tab, non-disruptive). Default when "
                        "--fixtures is absent; requires --slug.")
    p.add_argument("--live-bridge", action="store_true",
                   help="legacy file-drop bridge instead of cdp.py (agent runs the "
                        "fetch JS and writes results into .data/live/results/)")
    p.add_argument("--devtools-url", default=None,
                   help="Chrome DevTools base url (default http://127.0.0.1:9222)")
    p.add_argument("--fixtures", help="offline mode: contest-eval run dir with data/raw/")
    p.add_argument("--data-dir", default=str(HERE / ".data"),
                   help="local PII output dir (gitignored)")
    p.add_argument("--verdict-queue",
                   default=str(HERE.parent / "night-run" / "verdict-queue"),
                   help="file-queue dir for the LLM verdict seam")
    p.add_argument("--verdict-max-cycles", type=int, default=8,
                   help="cycles to wait for a verdict before timing out (stays pending)")
    p.add_argument("--no-post", action="store_true", help="do not POST alerts")
    p.add_argument("--dry-run", action="store_true", help="alias for --no-post")
    return p


def main(argv=None):
    args = build_argparser().parse_args(argv)
    if args.fixtures and (args.live or args.live_bridge):
        build_argparser().error("--fixtures cannot be combined with --live/--live-bridge")
    if not args.fixtures and not args.slug:
        build_argparser().error("--slug is required in live mode (or pass --fixtures DIR)")
    Path(args.data_dir).mkdir(parents=True, exist_ok=True)

    acquirer = acq.make_acquirer(args)
    seam = VerdictSeam(args.verdict_queue, max_cycles=args.verdict_max_cycles)

    log(f"start: slug={args.slug} contest-id={args.contest_id} api-base={args.api_base} "
        f"mode={acquirer.mode} interval={args.interval}s "
        f"post={'OFF' if (args.no_post or args.dry_run) else 'ON'}")

    cycle = 0
    last = None
    while True:
        cycle += 1
        try:
            last = run_cycle(args, acquirer, seam, cycle)
        except Exception as e:
            import traceback
            log(f"cycle {cycle} ERROR: {e}\n{traceback.format_exc()}")
            last = {"cycle": cycle, "status": "error", "error": str(e)}
        if args.once:
            break
        time.sleep(max(1.0, args.interval))

    # emit a machine-readable last-cycle summary on stdout
    print(json.dumps({"last_cycle": last}, indent=1))
    return 0 if (last and last.get("status") in ("ok",)) else 1


if __name__ == "__main__":
    raise SystemExit(main())
