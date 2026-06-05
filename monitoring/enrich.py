#!/usr/bin/env python3
"""enrich — candidate NAME + ROOM enrichment for contest-eval poller alerts.

POLLER-ONLY. The deployed backend AND frontend are FROZEN/live and CANNOT be
redeployed. Contest-eval alerts as built by alerts.build_alerts carry only the
HackerRank username. Karthi wants every alert row to ALSO show the candidate's
NAME and ROOM so he can act on it directly.

HOW THIS SURFACES WITH NO BACKEND/FRONTEND CHANGE
-------------------------------------------------
The deployed backend's normalizeAlert PERSISTS `room`, `detail`, and `data` on
any ingested alert (verified in backend/src/handler.mjs:1218-1220). The frozen
frontend already DISPLAYS `detail` and `room` on each alert row. So the only way
to surface name+room without a redeploy is to bake them into the alert BEFORE the
POST: lead the `detail` with "Candidate: {name}, {username}, {room} — ", set the
top-level `room`, and stash candidate_name / candidate_room in `data` for any API
consumer. This module does exactly that, for contest-eval alerts only (the poller
does not build proctor-source alerts, and we never touch those).

SOURCE OF NAME + ROOM
---------------------
GET <api-base>/api/admin/sessions?username=<HACKERRANK_USERNAME> with header
x-admin-password: <admin pw>. The endpoint REQUIRES the username param (per-user
lookup; there is NO bulk list). It returns {sessions:[{name, room,
hackerrank_username, username_norm, ...}]}; we use the FIRST (most recent)
session's name + room. A 200 with an empty `sessions` list means that candidate
has no proctor session — we record that as a resolved None (username-only) and
never re-query. A 503 (occasional, under load) is transient: retry once, else
skip and let a later cycle try again.

PROTECTING THE LIVE BACKEND
---------------------------
This endpoint is per-user (no bulk), so a naive implementation could hammer it.
We therefore:
  * CACHE forever: username_norm -> {name, room} | None. Once resolved (incl. the
    no-session None), we never query that candidate again.
  * RATE-LIMIT: ~0.3s between lookups (configurable).
  * CAP per cycle: at most N NEW lookups per cycle (default 20). Unresolved
    candidates simply stay username-only this cycle and get enriched later. The
    re-POST is idempotent (same alert id), so the merge fills them in over time.
  * PRIORITISE: critical/warning alert candidates are looked up BEFORE info ones,
    so actionable alerts get name+room first.

PII / SECRETS
-------------
The admin password is NEVER hardcoded or logged. It comes from --admin-password,
else env ADMIN_PASSWORD, else monitoring/.data/session.local (KEY=VALUE lines,
gitignored). If none is available, enrichment is DISABLED with a clear log line —
it never crashes the poller. We never print candidate PII to stdout beyond what
the alert already contains (we log counts and username_norms, not names/rooms).
"""
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent

# Default credential file (gitignored). KEY=VALUE lines; we read ADMIN_PASSWORD.
DEFAULT_SESSION_LOCAL = HERE / ".data" / "session.local"

# Severity ordering for lookup priority: critical first, then warning, then info.
_SEVERITY_RANK = {"critical": 0, "warning": 1, "info": 2}


def _log(msg):
    print(f"[enrich] {msg}", flush=True)


def parse_session_local(path):
    """Parse a KEY=VALUE file (skips blanks and #comments). Returns a dict.
    Missing/unreadable file -> {} (never raises). Values are NOT logged."""
    out = {}
    try:
        text = Path(path).read_text()
    except OSError:
        return out
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        out[k.strip()] = v.strip()
    return out


def resolve_admin_password(cli_value=None, env=None, session_local=None):
    """Resolve the admin password WITHOUT logging it.

    Precedence: explicit --admin-password > env ADMIN_PASSWORD >
    monitoring/.data/session.local ADMIN_PASSWORD. Returns (password|None,
    source_label) — source_label is a human-readable provenance string with NO
    secret in it, safe to log.
    """
    import os
    env = env if env is not None else os.environ
    if cli_value:
        return cli_value, "--admin-password"
    env_pw = env.get("ADMIN_PASSWORD")
    if env_pw:
        return env_pw, "env ADMIN_PASSWORD"
    path = Path(session_local) if session_local else DEFAULT_SESSION_LOCAL
    kv = parse_session_local(path)
    pw = kv.get("ADMIN_PASSWORD")
    if pw:
        return pw, f"{path} (ADMIN_PASSWORD)"
    return None, "<none: enrichment disabled>"


class CandidateEnricher:
    """Persistent name+room lookup with a forever-cache, rate-limit, and per-cycle
    cap. One instance lives for the poller's whole run (pass it on args).

    Cache semantics: cache[username_norm] is either {"name","room"} (resolved with
    a session), None (resolved, NO session -> stay username-only), or ABSENT
    (never looked up). Both resolved states are terminal; we never re-query.

    `lookup_fn` is injectable for tests: lookup_fn(username) -> a sessions list
    (the `sessions` array from the admin endpoint) OR raises Transient to signal a
    503-style transient error (retried once). The default lookup_fn hits the live
    admin endpoint via urllib.
    """

    class Transient(RuntimeError):
        """Raised by a lookup_fn to signal a retry-once-then-skip transient (503)."""

    def __init__(self, api_base, admin_password, *, rate_limit_s=0.3,
                 max_per_cycle=20, timeout=20.0, lookup_fn=None):
        self.api_base = (api_base or "").rstrip("/")
        self._admin_password = admin_password
        self.rate_limit_s = float(rate_limit_s)
        self.max_per_cycle = int(max_per_cycle)
        self.timeout = float(timeout)
        # username_norm -> {"name","room"} | None  (None == resolved, no session)
        self.cache = {}
        self._lookup_fn = lookup_fn or self._live_lookup
        # lightweight run-wide counters (no PII)
        self.stats = {"resolved": 0, "no_session": 0, "transient_skips": 0,
                      "lookups": 0}

    @property
    def enabled(self):
        return bool(self._admin_password) and bool(self.api_base)

    # ----- the live lookup (real backend) -----
    def _live_lookup(self, username):
        """GET /api/admin/sessions?username=<username>. Returns the `sessions`
        list. Raises Transient on 503; other HTTP/network errors propagate as the
        caller treats unknowns conservatively (skip, retry next cycle)."""
        url = (self.api_base + "/api/admin/sessions?username="
               + urllib.parse.quote(str(username), safe=""))
        req = urllib.request.Request(url, method="GET")
        req.add_header("x-admin-password", self._admin_password or "")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                data = json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 503:
                raise self.Transient("503") from e
            raise
        return (data or {}).get("sessions", []) or []

    def _lookup_once(self, username):
        """Run lookup_fn, retrying ONCE on a Transient. On terminal success returns
        the resolved value ({"name","room"} or None for no-session). On a
        persistent transient or any other error, returns the sentinel UNRESOLVED so
        the caller leaves the candidate username-only this cycle."""
        for attempt in (1, 2):
            try:
                sessions = self._lookup_fn(username)
            except self.Transient:
                if attempt == 1:
                    # brief backoff, then one retry
                    if self.rate_limit_s:
                        time.sleep(self.rate_limit_s)
                    continue
                self.stats["transient_skips"] += 1
                return _UNRESOLVED
            except (urllib.error.URLError, OSError, ValueError) as e:
                # Non-transient failure: don't poison the cache, just skip this
                # cycle. (Counts only; never log the candidate's PII.)
                _log(f"  lookup error for {self._mask(username)} (skip, retry "
                     f"next cycle): {type(e).__name__}")
                return _UNRESOLVED
            # success
            if not sessions:
                return None  # resolved: no proctor session -> stay username-only
            first = sessions[0] if isinstance(sessions[0], dict) else {}
            name = str(first.get("name") or "").strip()
            room = str(first.get("room") or "").strip()
            return {"name": name, "room": room}
        return _UNRESOLVED

    @staticmethod
    def _mask(username):
        """Username_norm is already in the alert; log it directly (no extra PII)."""
        return str(username)

    def enrich_alerts(self, alerts):
        """Enrich a list of contest-eval alert dicts IN PLACE. Returns a small
        summary dict. Safe to call when disabled (no-op). Honors the per-cycle cap
        and severity priority; never re-queries a cached candidate."""
        if not alerts:
            return {"enabled": self.enabled, "applied": 0, "new_lookups": 0,
                    "cached_hits": 0, "skipped_cap": 0}
        if not self.enabled:
            return {"enabled": False, "applied": 0, "new_lookups": 0,
                    "cached_hits": 0, "skipped_cap": 0,
                    "reason": "no admin password / api-base"}

        # Group alerts by candidate username_norm, tracking the BEST (lowest-rank)
        # severity seen for that candidate so we can prioritise lookups.
        by_user = {}
        for a in alerts:
            if a.get("source") != "contest-eval":
                continue  # never touch non-contest-eval alerts
            un = a.get("username_norm") or ""
            if not un:
                continue
            rank = _SEVERITY_RANK.get(a.get("severity"), 99)
            cur = by_user.get(un)
            if cur is None or rank < cur:
                by_user[un] = rank

        # Order candidates needing a NEW lookup by severity priority (critical
        # first). Candidates already cached are applied without counting a lookup.
        need_lookup = [un for un in by_user if un not in self.cache]
        need_lookup.sort(key=lambda un: (by_user[un], un))

        new_lookups = 0
        skipped_cap = 0
        for un in need_lookup:
            if new_lookups >= self.max_per_cycle:
                skipped_cap = len(need_lookup) - new_lookups
                break
            # rate-limit BETWEEN live lookups (not before the first)
            if new_lookups > 0 and self.rate_limit_s:
                time.sleep(self.rate_limit_s)
            # pick a representative username for the lookup: use the original
            # hackerrank_username from any alert for this candidate (the endpoint
            # normalizes server-side anyway, but the readable form is harmless).
            username = self._username_for(alerts, un)
            result = self._lookup_once(username)
            new_lookups += 1
            self.stats["lookups"] += 1
            if result is _UNRESOLVED:
                continue  # leave uncached -> retried a later cycle
            self.cache[un] = result
            if result is None:
                self.stats["no_session"] += 1
            else:
                self.stats["resolved"] += 1

        # Apply whatever the cache now knows to EVERY contest-eval alert.
        applied = 0
        cached_hits = 0
        for a in alerts:
            if a.get("source") != "contest-eval":
                continue
            un = a.get("username_norm") or ""
            if un not in self.cache:
                continue
            cached_hits += 1
            info = self.cache[un]
            if info is None:
                continue  # resolved no-session: stay username-only
            if self._apply(a, info):
                applied += 1

        return {"enabled": True, "applied": applied, "new_lookups": new_lookups,
                "cached_hits": cached_hits, "skipped_cap": skipped_cap}

    @staticmethod
    def _username_for(alerts, username_norm):
        for a in alerts:
            if a.get("username_norm") == username_norm:
                return a.get("hackerrank_username") or username_norm
        return username_norm

    @staticmethod
    def _apply(alert, info):
        """Bake name+room into one alert. Idempotent: re-applying does not double
        the 'Candidate: ...' prefix. Returns True if it modified the alert."""
        name = (info or {}).get("name") or ""
        room = (info or {}).get("room") or ""
        username = alert.get("hackerrank_username") or alert.get("username_norm") or ""
        # the three fields, comma-separated, so Karthi can read them off the row
        fields = [p for p in (name, username, room) if p]
        prefix = f"Candidate: {', '.join(fields)} — "

        # already enriched? (idempotent re-POST across cycles) -> no-op
        existing_detail = alert.get("detail") or ""
        if existing_detail.startswith("Candidate: "):
            return False

        if room:
            alert["room"] = room
        alert["detail"] = prefix + existing_detail
        data = alert.get("data")
        if not isinstance(data, dict):
            data = {}
            alert["data"] = data
        if name:
            data["candidate_name"] = name
        if room:
            data["candidate_room"] = room
        return True


# Sentinel: a lookup that did not terminally resolve this cycle (transient/error).
# Distinct from None (None == resolved, candidate has NO proctor session).
_UNRESOLVED = object()


# urllib.parse is only needed by the live lookup; import here to keep the module
# import-light for the test path (which injects lookup_fn).
import urllib.parse  # noqa: E402
