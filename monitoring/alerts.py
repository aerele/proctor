#!/usr/bin/env python3
"""alerts — build Alert objects from deterministic contest-eval analysis.

Implements the SHARED ALERT CONTRACT (must agree with the proctor backend
ingest in backend/src/handler.mjs and the frontend types). Required-on-ingest
fields: source, type, severity, timestamp, hackerrank_username, title.

contest-eval alert types:
  peer_copy_cluster  — >1 distinct user with identical (skeleton) code on a problem
  recurring_pair     — a pair sharing identical code on 2+ problems OR 1+ hard (conclusive)
  web_paste          — strong web/editorial provenance signature in accepted code
  fast_solve         — single-attempt full solve on a HARD problem (metadata only)

id is stable+idempotent: "<source>:<type>:<username_norm>:<contest_slug>:<dedupe>"
so re-running a poll cycle merges instead of duplicating in Firestore.
"""
import re
import datetime


def normalize_username(value):
    """Match backend normalizeUsername(): trim, lowercase, non-[a-z0-9._-]->'_', slice 120."""
    s = str(value).strip().lower()
    s = re.sub(r'[^a-z0-9._-]', '_', s)
    return s[:120]


def _now_iso():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _dedupe_segment(*parts):
    """Build a stable dedupe tail from sorted, normalized parts."""
    seg = "-".join(str(p) for p in parts if p is not None)
    seg = re.sub(r'[^a-zA-Z0-9._:-]', '_', seg)
    return seg[:200]


def _alert(source, atype, severity, username, title, slug,
           detail=None, data=None, dedupe="", timestamp=None):
    norm = normalize_username(username)
    aid = f"{source}:{atype}:{norm}:{slug or '_'}:{dedupe}"
    a = {
        "id": aid,
        "source": source,
        "type": atype,
        "severity": severity,
        "timestamp": timestamp or _now_iso(),
        "hackerrank_username": str(username),
        "username_norm": norm,
        "title": title,
        "verdict": {"status": "pending"},
    }
    if slug:
        a["contest_slug"] = slug
    if detail:
        a["detail"] = detail
    if data:
        a["data"] = data
    return a


def build_alerts(slug, clone, meta_analysis, flagged, code_present_ids,
                 chal_by_slug=None, timestamp=None):
    """Produce the full list of contest-eval Alert dicts for one poll cycle.

    Args:
      slug: contest slug.
      clone: dict from contest_eval_core.analyze_clones (has _records).
      meta_analysis: dict from contest_eval_core.analyze_meta.
      flagged: dict user -> reasons from metadata_flag_candidates.
      code_present_ids: set of submission ids we actually fetched code for
                        (so peer_copy/web_paste only fire where evidence is real).
      chal_by_slug: optional {slug: challenge} for human-readable names.
    Returns: list[Alert].
    """
    chal_by_slug = chal_by_slug or {}
    out = []
    seen_ids = set()

    def add(a):
        if a["id"] in seen_ids:
            return
        seen_ids.add(a["id"])
        out.append(a)

    def chname(ch):
        return chal_by_slug.get(ch, {}).get("name", ch)

    code_present_ids = set(str(x) for x in (code_present_ids or []))

    # ---- recurring_pair (conclusive: shares 2+ problems OR 1+ hard) ----
    for r in clone.get("recurring_pairs", []):
        a_u, b_u = r["pair"]
        conclusive = r["n_problems"] >= 2
        severity = "critical" if conclusive else "warning"
        problems = r.get("problems", [])
        hard = r.get("hard_problems", [])
        # emit one alert per participant in the pair so each candidate carries it
        for me, other in ((a_u, b_u), (b_u, a_u)):
            dedupe = _dedupe_segment("with", normalize_username(other),
                                     *sorted(problems))
            detail = (f"Identical code with {other} on {r['n_problems']} problem(s) "
                      f"({r['n_hard']} hard): {', '.join(chname(p) for p in problems)}. "
                      + ("CONCLUSIVE (2+ shared)." if conclusive else "single-hard match."))
            add(_alert(
                "contest-eval", "recurring_pair", severity, me,
                f"Recurring identical-code pair with {other}", slug,
                detail=detail,
                data={"with": other, "n_problems": r["n_problems"],
                      "n_hard": r["n_hard"], "problems": problems,
                      "hard_problems": hard, "ranks": r.get("ranks")},
                dedupe=dedupe, timestamp=timestamp,
            ))

    # ---- peer_copy_cluster (one alert per cluster member; hard/med only) ----
    # Use skeleton clusters (superset: renamed-variable copies). Only fire on
    # clusters where the problem is hard or med — identical EASY/SQL code is weak.
    for g in clone.get("skeleton_clusters", []):
        if g["hardness"] == "easy":
            continue
        users = sorted({m["user"] for m in g["members"]})
        if len(users) < 2:
            continue
        severity = "critical" if g["hardness"] == "hard" else "warning"
        member_ids = [m["id"] for m in g["members"]]
        for u in users:
            dedupe = _dedupe_segment("cluster", g["ch"])
            others = [x for x in users if x != u]
            detail = (f"Identical ({g['hardness']}) code on {chname(g['ch'])} shared "
                      f"with {len(others)} other(s): {', '.join(others)}.")
            add(_alert(
                "contest-eval", "peer_copy_cluster", severity, u,
                f"Peer-copy cluster on {chname(g['ch'])}", slug,
                detail=detail,
                data={"ch": g["ch"], "hardness": g["hardness"],
                      "cluster_users": users, "with": others,
                      "n_users": g["n_users"], "submission_ids": member_ids},
                dedupe=dedupe, timestamp=timestamp,
            ))

    # ---- web_paste (strong provenance signature in fetched accepted code) ----
    for rec in clone.get("_records", []):
        if str(rec["id"]) not in code_present_ids:
            continue
        strong_prov = [p for p in rec.get("prov", []) if "weak" not in p]
        strong_art = [x for x in rec.get("artifacts", [])
                      if x in ("smart-quotes", "NBSP", "zero-width", "BOM", "en/em-dash")]
        if not (strong_prov or strong_art):
            continue
        # class-Solution alone in Java is HR's own template -> known false positive.
        # Only treat class-Solution as a signal alongside a corroborating tell.
        signals = list(strong_prov) + [f"artifact:{x}" for x in strong_art]
        only_java_template = (
            strong_prov == ["class-Solution(LeetCode)"]
            and not strong_art
            and (rec.get("lang") or "").lower().startswith("java")
        )
        if only_java_template:
            continue
        severity = "warning"
        dedupe = _dedupe_segment("paste", rec["ch"], rec["id"])
        detail = (f"Web/editorial provenance signals on {chname(rec['ch'])} "
                  f"[{rec['status']}]: {', '.join(signals)}.")
        add(_alert(
            "contest-eval", "web_paste", severity, rec["user"],
            f"Possible web/editorial paste on {chname(rec['ch'])}", slug,
            detail=detail,
            data={"ch": rec["ch"], "signals": signals,
                  "provenance": strong_prov, "artifacts": strong_art,
                  "submission_id": rec["id"], "lang": rec["lang"]},
            dedupe=dedupe, timestamp=timestamp,
        ))

    # ---- fast_solve (metadata-only: single-attempt full solve on HARD) ----
    # info severity on its own (methodology: zero-iteration is NOT a flag alone),
    # it only corroborates. We still surface it so the dashboard can cross-ref.
    for u, reasons in flagged.items():
        for r in reasons:
            if r["kind"] != "single_attempt_hard":
                continue
            probs = r["problems"]
            dedupe = _dedupe_segment("fastsolve", *sorted(probs))
            detail = (f"Single-attempt full solve on HARD problem(s) "
                      f"(zero iteration): {', '.join(chname(p) for p in probs)}. "
                      f"Corroborate with clone/paste evidence before acting.")
            add(_alert(
                "contest-eval", "fast_solve", "info", u,
                f"One-shot HARD solve ({len(probs)} problem(s))", slug,
                detail=detail,
                data={"hard_problems": probs, "note": "metadata-only corroborator"},
                dedupe=dedupe, timestamp=timestamp,
            ))

    return out


def validate_alert(a):
    """Cheap client-side mirror of backend required-field validation."""
    required = ["source", "type", "severity", "timestamp", "hackerrank_username", "title"]
    missing = [f for f in required if not a.get(f)]
    if missing:
        return f"missing required fields: {missing}"
    if a["source"] not in ("proctor", "contest-eval"):
        return f"bad source {a['source']!r}"
    if a["severity"] not in ("critical", "warning", "info"):
        return f"bad severity {a['severity']!r}"
    return None
