#!/usr/bin/env python3
"""test_monitoring — self-contained test suite for the unattended poller stack.

Run:   python3 monitoring/test_monitoring.py
Exit:  0 iff every test passes, nonzero on the first/any failure.

Covers (no network, no browser, no GCP — pure offline):
  1. PARAMETERIZED CORE reproduces the committed clone_analysis.json byte-for-byte
     for every MCET slot whose fixtures are present (slot is skipped if its
     committed artifacts are not checked out — never a silent pass).
  2. VERDICT SEAM round-trip: request -> pending; a written terminal verdict in
     done/ resolves to that status (and drains pending/); a request with NO
     responder verdict stays {status:"pending"} up to and past the timeout budget
     (NEVER blocks).
  3. ALERT idempotency (re-running build_alerts yields identical, unique ids that
     merge) + id format == "<source>:<type>:<username_norm>:<slug>:<dedupe>"
     (exactly 5 colon segments, username/ slug normalized).

It also smoke-checks that cdp.py imports and exposes the unattended entry points
(without touching the network).
"""
import json
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import contest_eval_core as core
import alerts as alertmod
from verdict_seam import VerdictSeam, is_ambiguous


# ---------------------------------------------------------------------------
# tiny test harness (no pytest dependency)
# ---------------------------------------------------------------------------
class T:
    def __init__(self):
        self.passed = 0
        self.failed = 0

    def check(self, cond, name, detail=""):
        if cond:
            self.passed += 1
            print(f"  PASS  {name}")
        else:
            self.failed += 1
            print(f"  FAIL  {name}" + (f"\n        {detail}" if detail else ""))

    def section(self, title):
        print("\n" + "=" * 70)
        print(title)
        print("=" * 70)


FIX_BASE = Path("/home/karthi/arogara/contest-eval/MCET-06-26")
SLOTS = [
    ("386521-slot1", "386521", "coding-contest-mcet-june-2026"),
    ("386562-slot2", "386562", "coding-contest-mcet-june-2026"),
]
CLONE_SECTIONS = ("recurring_pairs", "exact_clusters", "skeleton_clusters", "tight")


def _slot_available(slot, cid):
    base = FIX_BASE / slot / "data"
    return (
        (base / "raw" / f"contest_{cid}_meta.json").exists()
        and (base / "raw" / f"code_{cid}.json").exists()
        and (base / "processed" / "clone_analysis.json").exists()
    )


# ---------------------------------------------------------------------------
# 1. parameterized core reproduces committed clone_analysis.json
# ---------------------------------------------------------------------------
def test_core_reproduces_clone_analysis(t):
    t.section("1. parameterized core reproduces committed clone_analysis.json")
    any_slot = False
    for slot, cid, _slug in SLOTS:
        if not _slot_available(slot, cid):
            print(f"  SKIP  [{slot}] committed fixtures not checked out")
            continue
        any_slot = True
        base = FIX_BASE / slot / "data"
        meta = json.loads((base / "raw" / f"contest_{cid}_meta.json").read_text())
        code = json.loads((base / "raw" / f"code_{cid}.json").read_text())
        committed = json.loads((base / "processed" / "clone_analysis.json").read_text())
        got = core.clone_analysis_canonical(meta, code)
        for k in CLONE_SECTIONS:
            a = json.dumps(got.get(k), sort_keys=True)
            b = json.dumps(committed.get(k), sort_keys=True)
            t.check(a == b, f"[{slot}] {k} reproduces committed "
                            f"(n={len(got.get(k) or [])} vs {len(committed.get(k) or [])})",
                    detail="first mismatch — parameterized core diverged from canonical")
        # the canonical dict must NOT leak the internal _records extra
        t.check("_records" not in got, f"[{slot}] canonical dict drops _records extra")
    # at least one slot must have actually run, or this whole section is vacuous
    t.check(any_slot, "at least one MCET slot's fixtures were available to reproduce",
            detail=f"no slot under {FIX_BASE} had raw+processed artifacts")


# ---------------------------------------------------------------------------
# 2. verdict seam round-trip
# ---------------------------------------------------------------------------
def _fake_alert(aid="contest-eval:web_paste:alice:slug:paste-x-1",
                atype="web_paste", sev="warning"):
    return {
        "id": aid, "type": atype, "severity": sev,
        "contest_slug": "slug", "hackerrank_username": "Alice",
        "username_norm": "alice", "title": "t", "detail": "d",
        "data": {"ch": "x"},
    }


def test_verdict_seam(t):
    t.section("2. verdict seam round-trip (pending -> done; timeout stays pending)")
    with tempfile.TemporaryDirectory() as tmp:
        q = Path(tmp) / "verdict-queue"
        seam = VerdictSeam(q, max_cycles=3)

        # --- request enqueues to pending/, poll returns pending ---
        a1 = _fake_alert(aid="contest-eval:web_paste:bob:slug:paste-y-2")
        rid = seam.request(a1)
        t.check(rid is not None, "request() returns a request id")
        pend_file = q / "pending" / f"{rid}.json"
        t.check(pend_file.exists(), "request() writes pending/<id>.json")
        v0 = seam.poll(a1)
        t.check(v0.get("status") == "pending", "poll() before any verdict -> pending",
                detail=str(v0))

        # --- a written terminal verdict resolves and drains pending ---
        done_file = q / "done" / f"{rid}.json"
        done_file.write_text(json.dumps({
            "id": a1["id"], "status": "real",
            "reason": "identical hard code on 2 problems", "by": "test",
        }))
        v1 = seam.poll(a1)
        t.check(v1.get("status") == "real", "poll() after done/ verdict -> real",
                detail=str(v1))
        t.check(v1.get("by") == "test", "verdict carries responder identity 'by'")
        t.check(not pend_file.exists(), "resolved verdict drains pending/<id>.json")

        # --- malformed / non-terminal status is treated as still-pending ---
        a2 = _fake_alert(aid="contest-eval:web_paste:carol:slug:paste-z-3")
        seam.request(a2)
        (q / "done" / f"{_safe(a2['id'])}.json").write_text(
            json.dumps({"id": a2["id"], "status": "pending"}))  # responder must NOT emit pending
        v2 = seam.poll(a2)
        t.check(v2.get("status") == "pending",
                "a done/ file with status='pending' is rejected (stays pending)",
                detail=str(v2))

        # --- a request that NEVER gets a verdict stays pending past the budget ---
        a3 = _fake_alert(aid="contest-eval:web_paste:dave:slug:paste-w-4")
        seam.request(a3)
        statuses = [seam.poll(a3).get("status") for _ in range(seam.max_cycles + 2)]
        t.check(all(s == "pending" for s in statuses),
                "no-verdict request stays 'pending' for every cycle (never blocks)",
                detail=str(statuses))
        last = seam.poll(a3)
        t.check(last.get("status") == "pending" and "timeout" in (last.get("reason") or ""),
                "past the budget the seam reports a pending timeout (still not blocking)",
                detail=str(last))

        # --- is_ambiguous routing matches the contract ---
        t.check(is_ambiguous(_fake_alert(atype="web_paste", sev="warning")),
                "web_paste is routed to the seam")
        t.check(is_ambiguous(_fake_alert(atype="recurring_pair", sev="warning")),
                "single-hard recurring_pair (warning) is routed")
        t.check(not is_ambiguous(_fake_alert(atype="recurring_pair", sev="critical")),
                "conclusive recurring_pair (critical) is NOT routed (goes straight through)")
        t.check(not is_ambiguous(_fake_alert(atype="fast_solve", sev="info")),
                "fast_solve (info corroborator) is NOT routed alone")


def _safe(s):
    import re
    return re.sub(r'[^A-Za-z0-9._-]', '_', str(s))[:180]


# ---------------------------------------------------------------------------
# 3. alert idempotency + id format
# ---------------------------------------------------------------------------
def _build_for_slot(slot, cid, slug):
    base = FIX_BASE / slot / "data" / "raw"
    meta = json.loads((base / f"contest_{cid}_meta.json").read_text())
    code = json.loads((base / f"code_{cid}.json").read_text())
    chal_by_slug = {c["slug"]: c for c in meta["challenges"]}
    ma = core.analyze_meta(meta)
    flagged = core.metadata_flag_candidates(ma)
    clone = core.analyze_clones(meta, code)
    return alertmod.build_alerts(slug, clone, ma, flagged, set(code.keys()),
                                 chal_by_slug=chal_by_slug)


def test_alert_idempotency_and_id_format(t):
    t.section("3. alert idempotency + id format <source>:<type>:<user>:<slug>:<dedupe>")
    slot = next((s for s in SLOTS if _slot_available(s[0], s[1])), None)
    if slot is None:
        # Fall back to a synthetic build so the id-format checks still run.
        print("  NOTE  no fixtures available; using a synthetic clone result")
        t.check(False, "fixtures available for the idempotency test",
                detail="cannot prove idempotency over real data without fixtures")
        return
    slotname, cid, slug = slot

    a1 = _build_for_slot(slotname, cid, slug)
    a2 = _build_for_slot(slotname, cid, slug)
    ids1 = [a["id"] for a in a1]
    ids2 = [a["id"] for a in a2]

    # uniqueness within a build (idempotency precondition for the backend merge)
    t.check(len(ids1) == len(set(ids1)),
            f"alert ids are unique within one build (n={len(ids1)})",
            detail="duplicate ids would double-write in Firestore")

    # determinism across rebuilds (timestamps aside, ids must match exactly)
    t.check(ids1 == ids2, "ids are byte-identical across two independent builds "
            "(deterministic => idempotent merge)",
            detail="re-poll would create new docs instead of merging")

    # id format: exactly 5 colon segments, source/type valid, user+slug normalized
    bad_fmt = []
    for a in a1:
        parts = a["id"].split(":")
        if len(parts) != 5:
            bad_fmt.append((a["id"], "not 5 segments"))
            continue
        src, typ, user, sl, _dedupe = parts
        if src != a["source"]:
            bad_fmt.append((a["id"], f"segment0 {src!r} != source {a['source']!r}"))
        if typ != a["type"]:
            bad_fmt.append((a["id"], f"segment1 {typ!r} != type {a['type']!r}"))
        if user != alertmod.normalize_username(a["hackerrank_username"]):
            bad_fmt.append((a["id"], f"segment2 {user!r} != normalized username"))
        if user != a.get("username_norm"):
            bad_fmt.append((a["id"], f"segment2 {user!r} != username_norm field"))
        if sl != slug:
            bad_fmt.append((a["id"], f"segment3 {sl!r} != slug {slug!r}"))
    t.check(not bad_fmt, f"every id matches <source>:<type>:<username_norm>:<slug>:<dedupe>",
            detail=f"{len(bad_fmt)} malformed: {bad_fmt[:3]}")

    # all alerts pass the client-side contract mirror
    invalid = [(a["id"], alertmod.validate_alert(a)) for a in a1]
    invalid = [x for x in invalid if x[1]]
    t.check(not invalid, "every alert passes the client-side contract validation",
            detail=f"{invalid[:3]}")


# ---------------------------------------------------------------------------
# 4. cdp.py imports and exposes the unattended entry points (no network)
# ---------------------------------------------------------------------------
def test_cdp_importable(t):
    t.section("4. cdp.py imports and exposes unattended entry points (offline)")
    try:
        import cdp
        ok = (hasattr(cdp, "run_fetch") and hasattr(cdp, "is_devtools_up")
              and hasattr(cdp, "CDPError") and hasattr(cdp, "CDPSession"))
        t.check(ok, "cdp exposes run_fetch / is_devtools_up / CDPSession / CDPError")
        # is_devtools_up must be safe to call even when nothing is listening
        res = cdp.is_devtools_up("http://127.0.0.1:1", timeout=1.0)
        t.check(res is False, "is_devtools_up() returns False for an unreachable port "
                "(graceful, no raise)")
    except Exception as e:  # noqa: BLE001
        t.check(False, "import cdp", detail=repr(e))


# ---------------------------------------------------------------------------
# 5. alert-config: disable suppresses a type; severity override is applied;
#    missing file is back-compat; malformed file fails loud.
# ---------------------------------------------------------------------------
def _synthetic_clone():
    """A minimal clone result that fires exactly one peer_copy_cluster (hard,
    severity 'critical' dynamically) and one recurring_pair (1 hard problem =>
    'warning' dynamically). Fixture-independent so this test always runs."""
    clone = {
        "recurring_pairs": [{
            "pair": ["alice", "bob"], "ranks": [1, 2],
            "n_problems": 1, "problems": ["hard-prob"],
            "n_hard": 1, "hard_problems": ["hard-prob"],
        }],
        "skeleton_clusters": [{
            "ch": "hard-prob", "hardness": "hard", "n_users": 2,
            "members": [{"user": "alice", "id": "111"}, {"user": "bob", "id": "222"}],
        }],
        "_records": [],
    }
    return clone


def _build_synth(alert_config=None):
    clone = _synthetic_clone()
    chal_by_slug = {"hard-prob": {"slug": "hard-prob", "name": "Hard Problem"}}
    return alertmod.build_alerts(
        "demo-slug", clone, {}, {}, set(), chal_by_slug=chal_by_slug,
        alert_config=alert_config)


def test_alert_config(t):
    t.section("5. alert-config: disable suppresses; severity override applied; "
              "missing file = back-compat; malformed = fail loud")

    # --- baseline: no config == built-in defaults == legacy dynamic severity ---
    base = _build_synth(alert_config=None)
    base_types = {a["type"] for a in base}
    t.check("peer_copy_cluster" in base_types and "recurring_pair" in base_types,
            "baseline (no config) builds both synthetic alert types",
            detail=str(sorted(base_types)))
    pcc_base = next(a for a in base if a["type"] == "peer_copy_cluster")
    rp_base = next(a for a in base if a["type"] == "recurring_pair")
    t.check(pcc_base["severity"] == "critical",
            "baseline peer_copy_cluster keeps DYNAMIC severity (hard => critical)",
            detail=pcc_base["severity"])
    t.check(rp_base["severity"] == "warning",
            "baseline single-hard recurring_pair keeps DYNAMIC severity (=> warning)",
            detail=rp_base["severity"])

    # --- disabling a type suppresses every alert of that type ---
    cfg_disable = alertmod.AlertConfig(
        {"peer_copy_cluster": {"enabled": False, "severity": None}})
    got = _build_synth(alert_config=cfg_disable)
    types = {a["type"] for a in got}
    t.check("peer_copy_cluster" not in types,
            "disabling peer_copy_cluster suppresses all its alerts",
            detail=str(sorted(types)))
    t.check("recurring_pair" in types,
            "disabling one type does not suppress the others",
            detail=str(sorted(types)))

    # --- explicit severity override wins over the dynamic HARD/MED mapping ---
    cfg_override = alertmod.AlertConfig(
        {"recurring_pair": {"enabled": True, "severity": "info"}})
    got2 = _build_synth(alert_config=cfg_override)
    rp = next((a for a in got2 if a["type"] == "recurring_pair"), None)
    t.check(rp is not None and rp["severity"] == "info",
            "explicit severity override ('info') replaces dynamic 'warning'",
            detail=(rp or {}).get("severity"))
    # a None severity in config must NOT override (stays dynamic)
    cfg_none = alertmod.AlertConfig(
        {"peer_copy_cluster": {"enabled": True, "severity": None}})
    pcc = next(a for a in _build_synth(alert_config=cfg_none)
               if a["type"] == "peer_copy_cluster")
    t.check(pcc["severity"] == "critical",
            "severity=null keeps the dynamic severity (no override)",
            detail=pcc["severity"])

    # --- missing file => back-compat (all enabled, dynamic severity) ---
    with tempfile.TemporaryDirectory() as tmp:
        missing = Path(tmp) / "does-not-exist.json"
        cfg_missing = alertmod.load_alert_config(missing)
        t.check(all(cfg_missing.enabled(x) for x in alertmod.ALERT_TYPES),
                "missing config file => every type enabled (back-compat)")
        t.check(all(cfg_missing.severity_override(x) is None
                    for x in alertmod.ALERT_TYPES),
                "missing config file => no severity overrides (dynamic kept)")
        bm = _build_synth(alert_config=cfg_missing)
        t.check({a["type"] for a in bm} == base_types
                and next(a for a in bm if a["type"] == "peer_copy_cluster")["severity"]
                    == "critical",
                "missing-file config reproduces the no-config baseline exactly")

        # --- malformed JSON fails loud (do not silently mis-classify alerts) ---
        bad = Path(tmp) / "bad.json"
        bad.write_text("{ this is not json")
        raised = False
        try:
            alertmod.load_alert_config(bad)
        except ValueError:
            raised = True
        t.check(raised, "malformed alert-config JSON raises ValueError (fail loud)")

        # --- invalid severity value fails loud ---
        bad2 = Path(tmp) / "bad2.json"
        bad2.write_text(json.dumps(
            {"web_paste": {"enabled": True, "severity": "MEGA"}}))
        raised2 = False
        try:
            alertmod.load_alert_config(bad2)
        except ValueError:
            raised2 = True
        t.check(raised2, "an out-of-range severity in config raises ValueError")

    # --- the committed default catalog loads and matches the spec'd defaults ---
    shipped = alertmod.load_alert_config(alertmod.DEFAULT_ALERT_CONFIG_PATH)
    expect = {
        "peer_copy_cluster": ("enabled", "critical"),
        "recurring_pair": ("enabled", "critical"),
        "web_paste": ("enabled", "warning"),
        "fast_solve": ("enabled", "info"),
    }
    cat_ok = all(
        shipped.enabled(t_) and shipped.severity_override(t_) == sev
        for t_, (_en, sev) in expect.items()
    )
    t.check(cat_ok, "committed alert-config.json matches the documented defaults "
            "(pcc/rp critical, web_paste warning, fast_solve info, all enabled)",
            detail=str(shipped.as_dict()))


def main():
    t = T()
    test_core_reproduces_clone_analysis(t)
    test_verdict_seam(t)
    test_alert_idempotency_and_id_format(t)
    test_cdp_importable(t)
    test_alert_config(t)
    print("\n" + "=" * 70)
    total = t.passed + t.failed
    print(f"RESULT: {t.passed}/{total} passed, {t.failed} failed")
    print("=" * 70)
    return 0 if t.failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
