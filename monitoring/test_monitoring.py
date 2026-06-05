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
import enrich as enrichmod
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
        t.check(not is_ambiguous(_fake_alert(atype="first_attempt_solve", sev="info")),
                "first_attempt_solve (info corroborator) is NOT routed alone")
        t.check(not is_ambiguous(_fake_alert(atype="tough_first_attempt", sev="critical")),
                "tough_first_attempt (critical flag) is NOT routed (goes straight through)")


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
        "first_attempt_solve": ("enabled", "info"),
        "tough_first_attempt": ("enabled", "critical"),
    }
    cat_ok = all(
        shipped.enabled(t_) and shipped.severity_override(t_) == sev
        for t_, (_en, sev) in expect.items()
    )
    t.check(cat_ok, "committed alert-config.json matches the documented defaults "
            "(pcc/rp/tough_first_attempt critical, web_paste warning, "
            "first_attempt_solve info, all enabled)",
            detail=str(shipped.as_dict()))
    # the deprecated fast_solve key resolves to the same first_attempt_solve config
    t.check(shipped.enabled("fast_solve") and shipped.severity_override("fast_solve") == "info",
            "deprecated 'fast_solve' alias resolves to first_attempt_solve config")


# ---------------------------------------------------------------------------
# 6. first_attempt_solve / tough_first_attempt detection (synthetic, fixture-free)
# ---------------------------------------------------------------------------
def _synthetic_meta_analysis():
    """meta_analysis-shaped dict with one participant who first-attempt-solved a
    NORMAL problem ('easy-prob') and a DATA-HARD problem ('hard-prob'). The
    data-hard subset is reported in single_attempt_HARD_problems (as analyze_meta
    would). 'manual-prob' is NOT data-hard — it only becomes tough via the
    operator tough_questions list."""
    return {
        "challenges": [],
        "profiles_by_user": {
            "carol": {
                "user": "carol",
                "single_attempt_problems": ["easy-prob", "hard-prob", "manual-prob"],
                "single_attempt_HARD_problems": ["hard-prob"],
            }
        },
    }


def _build_first_attempt(alert_config=None):
    """build_alerts over a clone result that fires NO clone/paste alerts, so the
    only alerts produced are the first-attempt family."""
    clone = {"recurring_pairs": [], "skeleton_clusters": [], "_records": []}
    ma = _synthetic_meta_analysis()
    chal_by_slug = {
        "easy-prob": {"slug": "easy-prob", "name": "Easy Problem"},
        "hard-prob": {"slug": "hard-prob", "name": "Hard Problem"},
        "manual-prob": {"slug": "manual-prob", "name": "Manual Tough Problem"},
    }
    return alertmod.build_alerts(
        "demo-slug", clone, ma, {}, set(), chal_by_slug=chal_by_slug,
        alert_config=alert_config)


def test_first_attempt_alerts(t):
    t.section("6. first_attempt_solve / tough_first_attempt detection (synthetic)")

    # --- baseline: no tough_questions => only DATA-HARD problem is tough ---
    base = _build_first_attempt(alert_config=None)
    by_type = {}
    for a in base:
        by_type.setdefault(a["type"], []).append(a)
    fa = by_type.get("first_attempt_solve", [])
    tfa = by_type.get("tough_first_attempt", [])
    t.check(len(fa) == 1 and len(tfa) == 1,
            "baseline: one first_attempt_solve + one tough_first_attempt",
            detail=str({k: len(v) for k, v in by_type.items()}))
    # the info alert covers the NORMAL problems (easy-prob + manual-prob, since
    # manual-prob is not data-hard and not yet operator-marked)
    fa_probs = set(fa[0]["data"]["problems"]) if fa else set()
    t.check(fa_probs == {"easy-prob", "manual-prob"},
            "first_attempt_solve carries the normal (non-tough) problems",
            detail=str(fa_probs))
    t.check(fa and fa[0]["severity"] == "info",
            "first_attempt_solve default severity is info", detail=str(fa))
    # the tough flag covers only the DATA-HARD problem, at critical
    tfa_probs = set(tfa[0]["data"]["tough_problems"]) if tfa else set()
    t.check(tfa_probs == {"hard-prob"},
            "tough_first_attempt fires on the data-hard problem", detail=str(tfa_probs))
    t.check(tfa and tfa[0]["severity"] == "critical",
            "tough_first_attempt default severity is critical (the real flag)",
            detail=str(tfa))

    # --- manual tough_questions: marking 'manual-prob' (not data-hard) makes it
    #     tough, moving it out of first_attempt_solve into tough_first_attempt ---
    cfg_manual = alertmod.AlertConfig(tough_questions=["manual-prob"])
    got = _build_first_attempt(alert_config=cfg_manual)
    fa2 = [a for a in got if a["type"] == "first_attempt_solve"]
    tfa2 = [a for a in got if a["type"] == "tough_first_attempt"]
    fa2_probs = set(fa2[0]["data"]["problems"]) if fa2 else set()
    tfa2_probs = set(tfa2[0]["data"]["tough_problems"]) if tfa2 else set()
    t.check(fa2_probs == {"easy-prob", "hard-prob"},
            "non-empty tough_questions is AUTHORITATIVE: data-hard 'hard-prob' stays a normal first_attempt_solve",
            detail=str(fa2_probs))
    t.check(tfa2_probs == {"manual-prob"},
            "tough_first_attempt covers ONLY operator-marked problems when a list is set (data-hard ignored)",
            detail=str(tfa2_probs))
    # provenance: only operator-marked; data_hard is empty because it is ignored when a list is set
    t.check(tfa2 and set(tfa2[0]["data"]["operator_marked"]) == {"manual-prob"}
            and set(tfa2[0]["data"].get("data_hard", [])) == set(),
            "tough_first_attempt provenance: operator_marked only (data_hard ignored under authoritative list)",
            detail=str((tfa2 or [{}])[0].get("data")))

    # --- tough_questions empty => falls back to data-hard derivation only ---
    cfg_empty = alertmod.AlertConfig(tough_questions=[])
    got_empty = _build_first_attempt(alert_config=cfg_empty)
    tfa_empty = [a for a in got_empty if a["type"] == "tough_first_attempt"]
    t.check(len(tfa_empty) == 1
            and set(tfa_empty[0]["data"]["tough_problems"]) == {"hard-prob"},
            "empty tough_questions => only the data-hard problem is tough (fallback)",
            detail=str([a["data"].get("tough_problems") for a in tfa_empty]))

    # --- disabling first_attempt_solve suppresses ONLY the info type ---
    cfg_no_info = alertmod.AlertConfig(
        {"first_attempt_solve": {"enabled": False, "severity": None}})
    got_ni = _build_first_attempt(alert_config=cfg_no_info)
    types_ni = {a["type"] for a in got_ni}
    t.check("first_attempt_solve" not in types_ni and "tough_first_attempt" in types_ni,
            "disabling first_attempt_solve suppresses info alerts but keeps the tough flag",
            detail=str(sorted(types_ni)))

    # --- disabling tough_first_attempt suppresses ONLY the flag ---
    cfg_no_flag = alertmod.AlertConfig(
        {"tough_first_attempt": {"enabled": False, "severity": None}})
    got_nf = _build_first_attempt(alert_config=cfg_no_flag)
    types_nf = {a["type"] for a in got_nf}
    t.check("tough_first_attempt" not in types_nf and "first_attempt_solve" in types_nf,
            "disabling tough_first_attempt suppresses the flag but keeps info alerts",
            detail=str(sorted(types_nf)))

    # --- severity override applies to the new types (precedence: config wins) ---
    cfg_ov = alertmod.AlertConfig(
        {"tough_first_attempt": {"enabled": True, "severity": "warning"}})
    got_ov = _build_first_attempt(alert_config=cfg_ov)
    tfa_ov = next((a for a in got_ov if a["type"] == "tough_first_attempt"), None)
    t.check(tfa_ov is not None and tfa_ov["severity"] == "warning",
            "explicit severity override on tough_first_attempt replaces dynamic critical",
            detail=(tfa_ov or {}).get("severity"))
    cfg_ov2 = alertmod.AlertConfig(
        {"first_attempt_solve": {"enabled": True, "severity": "warning"}})
    fa_ov = next((a for a in _build_first_attempt(alert_config=cfg_ov2)
                  if a["type"] == "first_attempt_solve"), None)
    t.check(fa_ov is not None and fa_ov["severity"] == "warning",
            "explicit severity override on first_attempt_solve replaces dynamic info",
            detail=(fa_ov or {}).get("severity"))

    # --- deprecated fast_solve alias still configures first_attempt_solve ---
    cfg_alias = alertmod.AlertConfig(
        {"fast_solve": {"enabled": False, "severity": None}})
    got_alias = _build_first_attempt(alert_config=cfg_alias)
    t.check("first_attempt_solve" not in {a["type"] for a in got_alias},
            "configuring the deprecated 'fast_solve' alias disables first_attempt_solve")

    # --- ids are well-formed (5 colon segments) for the new types ---
    bad = [a["id"] for a in base if len(a["id"].split(":")) != 5]
    t.check(not bad, "first-attempt alert ids keep the 5-segment id format", detail=str(bad))


# ---------------------------------------------------------------------------
# 7. candidate name+room enrichment (POLLER-ONLY; mocked admin/sessions lookup)
# ---------------------------------------------------------------------------
def _enrich_alert(un, sev="critical", detail="orig detail.", username=None):
    """A minimal contest-eval alert as build_alerts would emit (pre-enrichment)."""
    username = username or un
    return {
        "id": f"contest-eval:web_paste:{un}:slug:dx",
        "source": "contest-eval", "type": "web_paste", "severity": sev,
        "timestamp": "2026-06-05T00:00:00Z",
        "hackerrank_username": username, "username_norm": un,
        "title": "t", "detail": detail, "data": {"ch": "x"},
    }


def test_enrichment(t):
    t.section("7. candidate NAME+ROOM enrichment (mocked admin/sessions lookup)")

    # A scripted lookup_fn: maps username -> a `sessions` list. Records every
    # call so we can prove the cache prevents re-query and the cap is respected.
    calls = []

    def make_lookup(table):
        def lookup(username):
            calls.append(username)
            return table.get(str(username), [])
        return lookup

    # --- resolved candidate: name+room baked into detail/room/data ---
    table = {"alice": [{"name": "Alice Smith", "room": "Lab-3",
                        "hackerrank_username": "alice", "username_norm": "alice"}]}
    e = enrichmod.CandidateEnricher("http://x", "pw", rate_limit_s=0,
                                    lookup_fn=make_lookup(table))
    t.check(e.enabled, "enricher with api-base + password is enabled")
    a = _enrich_alert("alice", detail="Web/editorial provenance signals.")
    summary = e.enrich_alerts([a])
    t.check(summary["applied"] == 1 and summary["new_lookups"] == 1,
            "resolved candidate: one lookup, one applied", detail=str(summary))
    t.check(a["room"] == "Lab-3", "alert.room set to the candidate's room", detail=a.get("room"))
    t.check(a["detail"].startswith("Candidate: Alice Smith, alice, Lab-3 — "),
            "detail leads with 'Candidate: {name}, {username}, {room} — '",
            detail=a["detail"])
    t.check(a["detail"].endswith("Web/editorial provenance signals."),
            "original detail is preserved after the candidate prefix", detail=a["detail"])
    t.check(a["data"].get("candidate_name") == "Alice Smith"
            and a["data"].get("candidate_room") == "Lab-3",
            "data carries candidate_name + candidate_room for API consumers",
            detail=str(a.get("data")))
    t.check(a["data"].get("ch") == "x",
            "pre-existing data keys are preserved (not clobbered)", detail=str(a.get("data")))

    # --- cache prevents re-query: a second cycle for alice does NOT call lookup ---
    calls.clear()
    a2 = _enrich_alert("alice", detail="another alert for alice.")
    s2 = e.enrich_alerts([a2])
    t.check(calls == [], "cached candidate is NOT looked up again (no live query)",
            detail=str(calls))
    t.check(a2["detail"].startswith("Candidate: Alice Smith, alice, Lab-3 — "),
            "cached enrichment is applied to a NEW alert without re-query",
            detail=a2["detail"])
    t.check(s2["new_lookups"] == 0 and s2["applied"] == 1,
            "second cycle: zero new lookups, still applied from cache", detail=str(s2))

    # --- idempotent re-POST: re-enriching the SAME alert does not double the prefix ---
    e.enrich_alerts([a])
    t.check(a["detail"].count("Candidate: ") == 1,
            "re-enriching an already-enriched alert does not double the prefix",
            detail=a["detail"])

    # --- empty sessions => resolved no-session => username-only, never re-queried ---
    calls.clear()
    e2 = enrichmod.CandidateEnricher("http://x", "pw", rate_limit_s=0,
                                     lookup_fn=make_lookup({}))  # bob -> []
    b = _enrich_alert("bob", detail="bob alert.")
    sb = e2.enrich_alerts([b])
    t.check("Candidate:" not in b["detail"] and b["detail"] == "bob alert.",
            "empty sessions list => alert stays username-only (detail untouched)",
            detail=b["detail"])
    t.check("room" not in b and "candidate_name" not in b.get("data", {}),
            "no-session candidate gets no room / candidate_name", detail=str(b))
    t.check(sb["new_lookups"] == 1, "no-session candidate counts exactly one lookup",
            detail=str(sb))
    # second cycle: the None cache entry prevents a re-query
    calls.clear()
    e2.enrich_alerts([_enrich_alert("bob", detail="bob alert 2.")])
    t.check(calls == [], "no-session result is cached (not re-queried next cycle)",
            detail=str(calls))

    # --- per-cycle CAP: only N new lookups happen; the rest stay username-only ---
    big = {f"u{i}": [{"name": f"N{i}", "room": f"R{i}"}] for i in range(10)}
    e3 = enrichmod.CandidateEnricher("http://x", "pw", rate_limit_s=0,
                                     max_per_cycle=3, lookup_fn=make_lookup(big))
    alerts = [_enrich_alert(f"u{i}", sev="info", detail=f"d{i}") for i in range(10)]
    s3 = e3.enrich_alerts(alerts)
    t.check(s3["new_lookups"] == 3,
            "cap respected: exactly max_per_cycle (3) new lookups this cycle",
            detail=str(s3))
    t.check(s3["skipped_cap"] == 7, "remaining 7 candidates deferred to a later cycle",
            detail=str(s3))
    enriched = sum(1 for a in alerts if a["detail"].startswith("Candidate: "))
    t.check(enriched == 3, "exactly the 3 looked-up candidates were enriched this cycle",
            detail=str(enriched))
    # a later cycle enriches more (cache keeps the first 3, looks up 3 new ones)
    s3b = e3.enrich_alerts(alerts)
    t.check(s3b["new_lookups"] == 3 and len(e3.cache) == 6,
            "next cycle looks up 3 MORE (cap again); cache grows to 6", detail=str(s3b))

    # --- severity priority: critical/warning are looked up BEFORE info ---
    pr = {"crit": [{"name": "C", "room": "RC"}], "warn": [{"name": "W", "room": "RW"}],
          "info1": [{"name": "I", "room": "RI"}]}
    order = []

    def lookup_order(username):
        order.append(str(username))
        return pr.get(str(username), [])
    e4 = enrichmod.CandidateEnricher("http://x", "pw", rate_limit_s=0,
                                     max_per_cycle=1, lookup_fn=lookup_order)
    mixed = [_enrich_alert("info1", sev="info"),
             _enrich_alert("crit", sev="critical"),
             _enrich_alert("warn", sev="warning")]
    e4.enrich_alerts(mixed)
    t.check(order == ["crit"],
            "with cap=1, the CRITICAL candidate is looked up first (before warning/info)",
            detail=str(order))

    # --- disabled enricher (no password) is a clean no-op ---
    e5 = enrichmod.CandidateEnricher("http://x", "", lookup_fn=make_lookup(table))
    a5 = _enrich_alert("alice", detail="should be untouched.")
    s5 = e5.enrich_alerts([a5])
    t.check(not e5.enabled and s5["applied"] == 0 and a5["detail"] == "should be untouched.",
            "no admin password => enricher disabled, alerts untouched (no crash)",
            detail=str(s5))

    # --- non-contest-eval alerts are NEVER touched ---
    e6 = enrichmod.CandidateEnricher("http://x", "pw", rate_limit_s=0,
                                     lookup_fn=make_lookup({"alice": table["alice"]}))
    proctor_alert = {"source": "proctor", "username_norm": "alice",
                     "hackerrank_username": "alice", "severity": "critical",
                     "detail": "proctor detail.", "data": {}}
    e6.enrich_alerts([proctor_alert])
    t.check(proctor_alert["detail"] == "proctor detail." and "room" not in proctor_alert,
            "proctor-source alerts are never enriched (poller doesn't build those)",
            detail=str(proctor_alert))

    # --- transient (503) => retry once then skip, candidate stays UNcached ---
    state = {"n": 0}

    def always_503(username):
        state["n"] += 1
        raise enrichmod.CandidateEnricher.Transient("503")
    e7 = enrichmod.CandidateEnricher("http://x", "pw", rate_limit_s=0,
                                     lookup_fn=always_503)
    a7 = _enrich_alert("zoe", detail="zoe alert.")
    e7.enrich_alerts([a7])
    t.check(state["n"] == 2, "a persistent 503 is retried exactly once (2 attempts)",
            detail=str(state["n"]))
    t.check("zoe" not in e7.cache and a7["detail"] == "zoe alert.",
            "a transiently-failing candidate stays UNcached (retried a later cycle)",
            detail=str((list(e7.cache), a7["detail"])))

    # --- credential resolution precedence (no secret logged) ---
    pw, src = enrichmod.resolve_admin_password(cli_value="cli-pw", env={})
    t.check(pw == "cli-pw" and src == "--admin-password",
            "credential precedence: --admin-password wins", detail=src)
    pw2, src2 = enrichmod.resolve_admin_password(cli_value=None,
                                                 env={"ADMIN_PASSWORD": "env-pw"})
    t.check(pw2 == "env-pw" and "env" in src2,
            "credential precedence: env ADMIN_PASSWORD used when no flag", detail=src2)
    with tempfile.TemporaryDirectory() as tmp:
        sl = Path(tmp) / "session.local"
        sl.write_text("# comment\nADMIN_PASSWORD=file-pw\nOTHER=1\n")
        pw3, src3 = enrichmod.resolve_admin_password(cli_value=None, env={},
                                                     session_local=sl)
        t.check(pw3 == "file-pw" and "ADMIN_PASSWORD" in src3,
                "credential precedence: session.local read when no flag/env", detail=src3)
    pw4, src4 = enrichmod.resolve_admin_password(
        cli_value=None, env={}, session_local="/nonexistent/session.local")
    t.check(pw4 is None and "disabled" in src4,
            "no credential anywhere => None (enrichment disabled, no crash)", detail=src4)


def main():
    t = T()
    test_core_reproduces_clone_analysis(t)
    test_verdict_seam(t)
    test_alert_idempotency_and_id_format(t)
    test_cdp_importable(t)
    test_alert_config(t)
    test_first_attempt_alerts(t)
    test_enrichment(t)
    print("\n" + "=" * 70)
    total = t.passed + t.failed
    print(f"RESULT: {t.passed}/{total} passed, {t.failed} failed")
    print("=" * 70)
    return 0 if t.failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
