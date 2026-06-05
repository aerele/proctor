#!/usr/bin/env python3
"""validate_fixtures — prove the parameterized analysis reproduces the committed
clone_analysis.json for the MCET fixtures, and prove the full poller pipeline runs
end-to-end offline via --fixtures and emits well-formed alerts.

Run: python3 validate_fixtures.py
Exit 0 iff every committed clone section reproduces byte-for-byte AND the poller
cycle produces only contract-valid alerts.

This reads the fixtures READ-ONLY (never writes into the contest-eval repo).
"""
import json
import sys
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import contest_eval_core as core
import alerts as alertmod

FIX_BASE = Path("/home/karthi/arogara/contest-eval/MCET-06-26")
SLOTS = [("386521-slot1", "386521", "coding-contest-mcet-june-2026"),
         ("386562-slot2", "386562", "coding-contest-mcet-june-2026")]


def reproduce(slot, cid):
    base = FIX_BASE / slot
    meta = json.loads((base / "data/raw" / f"contest_{cid}_meta.json").read_text())
    code = json.loads((base / "data/raw" / f"code_{cid}.json").read_text())
    committed = json.loads((base / "data/processed/clone_analysis.json").read_text())
    got = core.clone_analysis_canonical(meta, code)
    results = {}
    for k in ("recurring_pairs", "exact_clusters", "skeleton_clusters", "tight"):
        a = json.dumps(got[k], sort_keys=True)
        b = json.dumps(committed[k], sort_keys=True)
        results[k] = {"match": a == b, "got": len(got[k]), "committed": len(committed[k])}
    return meta, code, results


def main():
    all_ok = True
    print("=" * 70)
    print("PART 1 — clone_analysis.json reproduction (parameterized core vs committed)")
    print("=" * 70)
    metas = {}
    for slot, cid, slug in SLOTS:
        meta, code, res = reproduce(slot, cid)
        metas[slot] = (meta, code, slug)
        ok = all(v["match"] for v in res.values())
        all_ok = all_ok and ok
        print(f"\n[{slot}]  {'PASS' if ok else 'FAIL'}")
        for k, v in res.items():
            mark = "ok" if v["match"] else "MISMATCH"
            print(f"   {k:20} {mark:9} (n={v['got']} vs committed {v['committed']})")

    print("\n" + "=" * 70)
    print("PART 2 — full alert build over fixtures (contract validation)")
    print("=" * 70)
    for slot, cid, slug in SLOTS:
        meta, code, _ = reproduce(slot, cid)
        chal_by_slug = {c["slug"]: c for c in meta["challenges"]}
        ma = core.analyze_meta(meta)
        flagged = core.metadata_flag_candidates(ma)
        clone = core.analyze_clones(meta, code)
        alert_list = alertmod.build_alerts(
            slug, clone, ma, flagged, set(code.keys()), chal_by_slug=chal_by_slug)
        bad = [(a["id"], alertmod.validate_alert(a)) for a in alert_list]
        bad = [(i, e) for i, e in bad if e]
        by_type = {}
        for a in alert_list:
            by_type[a["type"]] = by_type.get(a["type"], 0) + 1
        # id uniqueness check (idempotency precondition)
        ids = [a["id"] for a in alert_list]
        dup = len(ids) != len(set(ids))
        ok = (not bad) and (not dup)
        all_ok = all_ok and ok
        print(f"\n[{slot}]  {'PASS' if ok else 'FAIL'}  "
              f"flagged={len(flagged)} alerts={len(alert_list)} by_type={by_type}")
        if bad:
            print(f"   INVALID alerts: {bad[:5]}")
        if dup:
            print(f"   DUPLICATE alert ids present (idempotency broken)")

    print("\n" + "=" * 70)
    print("PART 3 — poller end-to-end via --fixtures --once --no-post")
    print("=" * 70)
    slot, cid, slug = SLOTS[0]
    cmd = [sys.executable, str(HERE / "poller.py"),
           "--fixtures", str(FIX_BASE / slot),
           "--contest-id", cid, "--slug", slug,
           "--once", "--no-post",
           "--data-dir", str(HERE / ".data" / "validate")]
    print("$ " + " ".join(cmd))
    r = subprocess.run(cmd, capture_output=True, text=True)
    print(r.stdout[-2000:])
    if r.returncode != 0:
        print("STDERR:", r.stderr[-1000:])
    poller_ok = r.returncode == 0 and '"status": "ok"' in r.stdout
    all_ok = all_ok and poller_ok
    print(f"poller exit={r.returncode} status_ok={poller_ok}")

    print("\n" + "=" * 70)
    print(f"OVERALL: {'PASS' if all_ok else 'FAIL'}")
    print("=" * 70)
    return 0 if all_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
