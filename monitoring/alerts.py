#!/usr/bin/env python3
"""alerts — build Alert objects from deterministic contest-eval analysis.

Implements the SHARED ALERT CONTRACT (must agree with the proctor backend
ingest in backend/src/handler.mjs and the frontend types). Required-on-ingest
fields: source, type, severity, timestamp, hackerrank_username, title.

contest-eval alert types:
  peer_copy_cluster   — >1 distinct user with identical (skeleton) code on a problem
  recurring_pair      — a pair sharing identical code on 2+ problems OR 1+ hard (conclusive)
  web_paste           — strong web/editorial provenance signature in accepted code
  first_attempt_solve — candidate got a problem ACCEPTED on their FIRST submission
                        attempt (zero prior attempts on that problem). info-only.
  tough_first_attempt — a first_attempt_solve on a TOUGH problem (operator-marked
                        in alert-config.json tough_questions, OR data-derived hard).
                        This is the real "solved a tough question on attempt #1"
                        FLAG — default severity critical.

  fast_solve is RETAINED as a back-compat ALIAS of first_attempt_solve: it still
  loads/validates from alert-config.json, and a fast_solve config entry seeds the
  first_attempt_solve defaults when first_attempt_solve is itself absent. New
  alerts are emitted under first_attempt_solve / tough_first_attempt only.

id is stable+idempotent: "<source>:<type>:<username_norm>:<contest_slug>:<dedupe>"
so re-running a poll cycle merges instead of duplicating in Firestore.
"""
import re
import json
import datetime
from pathlib import Path

# Canonical contest-eval alert types and their built-in defaults. This is the
# source of truth used when alert-config.json is missing a type (or absent
# entirely): every type enabled, severity=None => keep the dynamic HARD/MED
# mapping that build_alerts computes (i.e. legacy behavior, fully back-compat).
#
# first_attempt_solve defaults to info; tough_first_attempt defaults to critical
# (it IS the real flag). fast_solve is kept ONLY as a deprecated alias so old
# configs keep loading — no alert is emitted under that type anymore.
ALERT_TYPES = ("peer_copy_cluster", "recurring_pair", "web_paste",
               "first_attempt_solve", "tough_first_attempt")
# Deprecated alias accepted in alert-config.json. A fast_solve entry seeds
# first_attempt_solve's defaults when the latter is not explicitly configured.
ALIAS_TYPES = {"fast_solve": "first_attempt_solve"}
_DEFAULT_TYPE_CFG = {t: {"enabled": True, "severity": None} for t in ALERT_TYPES}

# Each type's DYNAMIC (built-in) default severity, used when the config does not
# pin one (severity=null/absent => keep dynamic). build_alerts emits these.
# first_attempt_solve is an info-only corroborator; tough_first_attempt IS the
# real flag, so it defaults to critical. The shipped alert-config.json pins both
# explicitly too, but the dynamic defaults keep missing-file behavior sensible.
_DYNAMIC_SEVERITY = {"first_attempt_solve": "info", "tough_first_attempt": "critical"}

# Default config-file location: monitoring/alert-config.json (next to this file).
DEFAULT_ALERT_CONFIG_PATH = Path(__file__).resolve().parent / "alert-config.json"

_VALID_SEVERITIES = ("critical", "warning", "info")


class AlertConfig:
    """Per-type alert configuration (enable/disable + optional severity override).

    Loaded from alert-config.json. Backward-compatible: a missing file (or a
    missing/blank key for a given type) yields {enabled: True, severity: None},
    where severity=None means "keep the dynamic HARD/MED severity build_alerts
    already computes". Only an EXPLICIT, valid severity string overrides it.

    PRECEDENCE (documented): if the config sets a non-null severity for a type,
    that value WINS over the dynamic severity build_alerts would otherwise emit.
    Because verdict-seam routing (is_ambiguous) keys off severity, an override
    can also change whether that alert is routed for human review.
    """

    def __init__(self, by_type=None, tough_questions=None, source="<defaults>"):
        # start from built-in defaults, then overlay anything provided
        self._by_type = {t: dict(c) for t, c in _DEFAULT_TYPE_CFG.items()}
        for t, c in (by_type or {}).items():
            canon = ALIAS_TYPES.get(t, t)
            if canon in self._by_type:
                # an explicit canonical entry must win over an alias entry: only
                # apply an alias if the canonical key was not also provided.
                if t in ALIAS_TYPES and (by_type or {}).get(canon) is not None:
                    continue
                self._by_type[canon].update(c)
        # operator-marked tough challenge slugs/ids (manual list). A problem is
        # "tough" if it is in this set OR data-derived hard (see is_tough()).
        self.tough_questions = set(str(q) for q in (tough_questions or []))
        self.source = source

    def enabled(self, atype):
        atype = ALIAS_TYPES.get(atype, atype)
        return self._by_type.get(atype, {"enabled": True}).get("enabled", True)

    def severity_override(self, atype):
        """Return an explicit severity for this type, or None to keep dynamic."""
        atype = ALIAS_TYPES.get(atype, atype)
        return self._by_type.get(atype, {}).get("severity")

    def is_tough(self, slug, data_hard=False):
        """Is this challenge TOUGH? Manual tough_questions list wins/augments the
        data-derived hardness: tough iff slug is operator-marked OR data_hard."""
        return str(slug) in self.tough_questions or bool(data_hard)

    def as_dict(self):
        return {t: dict(c) for t, c in self._by_type.items()}


def load_alert_config(path=None):
    """Load alert configuration from JSON. Returns an AlertConfig.

    - path=None             -> DEFAULT_ALERT_CONFIG_PATH (monitoring/alert-config.json)
    - file missing          -> all types enabled, dynamic severity (legacy behavior)
    - malformed/invalid file -> raises ValueError (fail loud; do not silently
                                 mis-classify integrity alerts)

    Per-type entries are validated: 'enabled' must be bool; 'severity' must be
    one of critical|warning|info or null/absent (null => keep dynamic severity).
    The deprecated 'fast_solve' key is accepted as an alias of first_attempt_solve
    (an explicit first_attempt_solve entry wins if both are present).
    'tough_questions' (top level) must be a list of slug/id strings; it marks the
    problems an operator considers tough (see AlertConfig.is_tough).
    Unknown top-level keys (e.g. '_README') and unknown alert types are ignored.
    """
    p = Path(path) if path is not None else DEFAULT_ALERT_CONFIG_PATH
    if not p.exists():
        return AlertConfig(source=f"{p} (absent -> all enabled, dynamic severity)")
    try:
        raw = json.loads(p.read_text())
    except (json.JSONDecodeError, OSError) as e:
        raise ValueError(f"alert-config {p}: cannot read/parse JSON: {e}") from e
    if not isinstance(raw, dict):
        raise ValueError(f"alert-config {p}: top level must be a JSON object")

    def _parse_entry(atype, entry):
        if not isinstance(entry, dict):
            raise ValueError(f"alert-config {p}: {atype!r} must be an object")
        enabled = entry.get("enabled", True)
        if not isinstance(enabled, bool):
            raise ValueError(
                f"alert-config {p}: {atype}.enabled must be true/false, got {enabled!r}")
        sev = entry.get("severity")
        if sev is not None and sev not in _VALID_SEVERITIES:
            raise ValueError(
                f"alert-config {p}: {atype}.severity must be one of "
                f"{_VALID_SEVERITIES} or null, got {sev!r}")
        return {"enabled": enabled, "severity": sev}

    by_type = {}
    # deprecated aliases first (so an explicit canonical entry can override below)
    for alias, canon in ALIAS_TYPES.items():
        if alias in raw and canon not in raw:
            by_type[canon] = _parse_entry(alias, raw[alias])
    for atype in ALERT_TYPES:
        if atype not in raw:
            continue  # fall back to built-in (or alias-seeded) default for this type
        by_type[atype] = _parse_entry(atype, raw[atype])

    tough = raw.get("tough_questions", [])
    if not isinstance(tough, list) or not all(isinstance(q, (str, int)) for q in tough):
        raise ValueError(
            f"alert-config {p}: tough_questions must be a list of slug/id strings")

    return AlertConfig(by_type, tough_questions=tough, source=str(p))


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
                 chal_by_slug=None, timestamp=None, alert_config=None):
    """Produce the full list of contest-eval Alert dicts for one poll cycle.

    Args:
      slug: contest slug.
      clone: dict from contest_eval_core.analyze_clones (has _records).
      meta_analysis: dict from contest_eval_core.analyze_meta (has profiles_by_user;
                     first-attempt solves are read from here for ALL participants).
      flagged: dict user -> reasons from metadata_flag_candidates.
      code_present_ids: set of submission ids we actually fetched code for
                        (so peer_copy/web_paste only fire where evidence is real).
      chal_by_slug: optional {slug: challenge} for human-readable names.
      alert_config: optional AlertConfig. If None, defaults to all-enabled /
                    dynamic-severity (legacy behavior). When a type is disabled
                    its alerts are skipped entirely; when a type sets an explicit
                    severity that value OVERRIDES the dynamic HARD/MED severity.
                    Also supplies the operator tough_questions list.
    Returns: list[Alert].
    """
    chal_by_slug = chal_by_slug or {}
    cfg = alert_config or AlertConfig()
    out = []
    seen_ids = set()

    def add(a):
        # config gate: drop disabled types entirely (back-compat: default enabled)
        if not cfg.enabled(a["type"]):
            return
        # config severity override: an explicit severity wins over the dynamic
        # HARD/MED value computed below. None => keep the dynamic severity.
        ov = cfg.severity_override(a["type"])
        if ov is not None:
            a["severity"] = ov
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

    # ---- first_attempt_solve / tough_first_attempt -----------------------
    # FIRST-ATTEMPT detection: a candidate got a problem ACCEPTED on their FIRST
    # submission attempt (zero prior wrong attempts on that problem). This is the
    # analyze_meta "single_attempt" signal (acc_idx==0 with no wrong_before),
    # exposed per user as single_attempt_problems (and the data-hard subset
    # single_attempt_HARD_problems). We read it for ALL profiled participants
    # (not just code-fetch-flagged ones) so first-attempt solves always surface.
    #
    #   - normal problem  -> first_attempt_solve (info; methodology: a one-shot
    #     solve is a corroborator, not a standalone flag).
    #   - TOUGH problem   -> tough_first_attempt (critical FLAG). "Tough" = the
    #     slug is operator-marked in alert-config.json tough_questions OR it is
    #     data-derived hard (<=10 solvers). Manual list wins/augments the
    #     derivation (cfg.is_tough). This is the real "solved a tough question on
    #     the first attempt" signal Karthi wants raised, not just info.
    profiles = (meta_analysis or {}).get("profiles_by_user", {}) or {}
    for u, p in profiles.items():
        first_attempt = p.get("single_attempt_problems") or []
        data_hard = set(p.get("single_attempt_HARD_problems") or [])
        # partition this user's first-attempt solves into tough vs normal
        tough_probs, normal_probs = [], []
        for ch in first_attempt:
            if cfg.is_tough(ch, data_hard=ch in data_hard):
                tough_probs.append(ch)
            else:
                normal_probs.append(ch)

        if tough_probs:
            tough_probs = sorted(tough_probs)
            dedupe = _dedupe_segment("toughfirst", *tough_probs)
            detail = (f"First-attempt (zero prior attempts) ACCEPTED solve on "
                      f"TOUGH problem(s): {', '.join(chname(c) for c in tough_probs)}. "
                      f"Solved a tough question on the first try — corroborate with "
                      f"clone/paste evidence before acting.")
            add(_alert(
                "contest-eval", "tough_first_attempt",
                _DYNAMIC_SEVERITY["tough_first_attempt"], u,
                f"Tough question solved on first attempt ({len(tough_probs)} problem(s))",
                slug, detail=detail,
                data={"tough_problems": tough_probs,
                      "data_hard": sorted(p_ for p_ in tough_probs if p_ in data_hard),
                      "operator_marked": sorted(
                          p_ for p_ in tough_probs if p_ not in data_hard),
                      "note": "first-attempt solve on a tough problem (FLAG)"},
                dedupe=dedupe, timestamp=timestamp,
            ))

        if normal_probs:
            normal_probs = sorted(normal_probs)
            dedupe = _dedupe_segment("firstattempt", *normal_probs)
            detail = (f"First-attempt (zero prior attempts) ACCEPTED solve on "
                      f"problem(s): {', '.join(chname(c) for c in normal_probs)}. "
                      f"Metadata corroborator, not a standalone flag.")
            add(_alert(
                "contest-eval", "first_attempt_solve",
                _DYNAMIC_SEVERITY["first_attempt_solve"], u,
                f"First-attempt solve ({len(normal_probs)} problem(s))", slug,
                detail=detail,
                data={"problems": normal_probs, "note": "metadata-only corroborator"},
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
