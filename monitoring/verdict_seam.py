#!/usr/bin/env python3
"""verdict_seam — file-queue LLM judgment seam (subscription only, NO paid API).

Ambiguous flagged cases are written as scoped requests to
  night-run/verdict-queue/pending/<id>.json
A human-driven Claude Code /loop (see verdict-responder-prompt.md) drains pending/,
reads the actual candidate code/evidence, and writes a strict-schema verdict to
  night-run/verdict-queue/done/<id>.json

The poller reads done/ on each cycle. If a verdict is absent after N cycles, the
verdict stays {status: 'pending'} and the alert is NEVER blocked — the dashboard
shows it as pending. This seam never makes a network call and never spends money.

INTERFACE IS SWAPPABLE: VerdictSeam is the only contract the poller depends on
(request / poll). A future C3 transport (or any other backend) can implement the
same two methods without touching poller.py. We deliberately do NOT build C3 here.

Verdict schema (what the responder MUST write to done/<id>.json):
  {
    "id": "<same id>",
    "status": "real" | "false_positive" | "inconclusive",  # never "pending" from responder
    "reason": "<= 2000 chars human explanation",
    "by": "<responder identity, e.g. 'claude-code/verdict-loop'>"
  }
Anything else (missing/extra status, malformed json) is treated as still-pending.
"""
import json
import re
import time
import hashlib
from pathlib import Path

VALID_STATUSES = ("real", "false_positive", "inconclusive")
RESPONDER_STATUSES = VALID_STATUSES  # responder must NOT emit "pending"


def _safe_id(s):
    s = re.sub(r'[^A-Za-z0-9._-]', '_', str(s))
    return s[:180]


class VerdictSeam:
    """File-queue implementation of the swappable verdict transport."""

    def __init__(self, queue_dir, max_cycles=8):
        """queue_dir = .../night-run/verdict-queue ; max_cycles = give-up budget."""
        self.root = Path(queue_dir)
        self.pending = self.root / "pending"
        self.done = self.root / "done"
        self.pending.mkdir(parents=True, exist_ok=True)
        self.done.mkdir(parents=True, exist_ok=True)
        self.max_cycles = max_cycles
        # in-memory cycle counter per request id (poller process lifetime)
        self._cycles = {}

    # ----- request -----------------------------------------------------
    def request(self, alert):
        """Enqueue a scoped verdict request for an ambiguous alert.

        Idempotent: same alert id -> same pending file (overwrite-merge). If a
        verdict already exists in done/, we do not re-enqueue.
        Returns the request id (the alert id), or None if already resolved.
        """
        rid = _safe_id(alert["id"])
        if (self.done / f"{rid}.json").exists():
            return None
        payload = self._scope(alert)
        tmp = self.pending / f".{rid}.json.tmp"
        tmp.write_text(json.dumps(payload, indent=1))
        tmp.replace(self.pending / f"{rid}.json")  # atomic
        self._cycles.setdefault(rid, 0)
        return rid

    def _scope(self, alert):
        """Build the bounded request the responder reads. No raw PII beyond what
        the alert already carries; the responder fetches code from the bundle by id."""
        return {
            "id": alert["id"],
            "requested_at": _now_iso(),
            "kind": "verdict-request",
            "alert_type": alert.get("type"),
            "severity": alert.get("severity"),
            "contest_slug": alert.get("contest_slug"),
            "hackerrank_username": alert.get("hackerrank_username"),
            "username_norm": alert.get("username_norm"),
            "title": alert.get("title"),
            "detail": alert.get("detail"),
            "evidence": alert.get("data", {}),
            "question": (
                "Is this a REAL integrity violation, a FALSE_POSITIVE, or "
                "INCONCLUSIVE? Read the actual code for the cited submission ids / "
                "cluster members, apply the difficulty-weighting + Java-template "
                "false-positive rules from the methodology, and write a strict-schema "
                "verdict to done/<id>.json."
            ),
            "schema": {
                "id": "string (echo this id)",
                "status": "real | false_positive | inconclusive",
                "reason": "string <=2000 chars",
                "by": "string responder identity",
            },
        }

    # ----- poll --------------------------------------------------------
    def poll(self, alert):
        """Return a verdict dict for the alert's id.

        - If a valid verdict file exists in done/ -> return it (and clear pending).
        - Else increment the per-id cycle counter; if under budget -> {status:pending}.
        - If over budget -> {status:pending, reason:'verdict timeout'} (NEVER blocks).
        """
        rid = _safe_id(alert["id"])
        v = self._read_done(rid)
        if v is not None:
            # resolved -> remove the pending request so the queue drains
            p = self.pending / f"{rid}.json"
            if p.exists():
                try:
                    p.unlink()
                except OSError:
                    pass
            return v
        n = self._cycles.get(rid, 0) + 1
        self._cycles[rid] = n
        if n >= self.max_cycles:
            return {"status": "pending", "reason": "verdict timeout (responder not run)"}
        return {"status": "pending"}

    def _read_done(self, rid):
        f = self.done / f"{rid}.json"
        if not f.exists():
            return None
        try:
            d = json.loads(f.read_text())
        except (json.JSONDecodeError, OSError):
            return None
        status = d.get("status")
        if status not in RESPONDER_STATUSES:
            # responder must not write "pending"; malformed -> treat as unresolved
            return None
        out = {"status": status}
        if d.get("reason"):
            out["reason"] = str(d["reason"])[:2000]
        out["by"] = str(d.get("by") or "verdict-loop")[:200]
        return out

    # ----- introspection ----------------------------------------------
    def stats(self):
        return {
            "pending": len(list(self.pending.glob("*.json"))),
            "done": len(list(self.done.glob("*.json"))),
            "tracked": len(self._cycles),
        }


def _now_iso():
    import datetime
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# Which alerts are "ambiguous" enough to route through the LLM seam.
# Decisive evidence (conclusive recurring pair = critical) does NOT need an LLM;
# it goes straight to the dashboard. The seam is for the judgment calls:
#   - single-hard recurring pair (warning) — one shared hard problem, could be convergent
#   - web_paste (warning) — provenance signal needs code-level confirmation
#   - peer_copy_cluster on MED problems (warning) — difficulty-weighting judgment
# first_attempt_solve (info) is a corroborator, not routed alone. tough_first_attempt
# (critical) is a decisive flag and, like a conclusive recurring_pair, goes straight
# to the dashboard rather than through the seam.
def is_ambiguous(alert):
    t = alert.get("type")
    sev = alert.get("severity")
    if t == "web_paste":
        return True
    if t == "recurring_pair" and sev == "warning":
        return True
    if t == "peer_copy_cluster" and sev == "warning":
        return True
    return False
