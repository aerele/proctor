#!/usr/bin/env python3
"""mock_alert_server — a tiny, stdlib-only stand-in for the proctor backend's
TWO alert endpoints, for the offline FIXTURES end-to-end demo (run-demo.sh).

WHY THIS EXISTS
---------------
The real backend (backend/src/handler.mjs) is the source of truth, but its
/api/alerts and /api/admin/alerts routes write/read Firestore. On a laptop with
no gcloud / no Firestore emulator / no GCP credentials, a real
`functions-framework --target=api` run cannot serve those two routes end-to-end
(it 500s at request time on `new Firestore()`). So run-demo.sh — whose whole
point is to prove the poller -> ingest -> admin-read loop with ZERO external
deps — talks to this in-memory mock instead.

The mock mirrors the real backend's CONTRACT exactly (same required fields, same
enums, same x-api-key / x-admin-password auth, same idempotent merge keyed on
alert.id, same {ok,ingested,ids} / {alerts:[...]} response shapes) so a green
demo here is a faithful proxy for the deployed backend. It is NOT used in
production and is never deployed. HOW-TO-RUN.md documents the real
functions-framework path for a machine that has Firestore.

Usage:
  ALERTS_INGEST_API_KEY=... ADMIN_PASSWORD=... \
    python3 mock_alert_server.py --port 8799
"""
import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ALERT_SOURCES = ("proctor", "contest-eval")
ALERT_SEVERITIES = ("critical", "warning", "info")
ALERT_VERDICT_STATUSES = ("pending", "real", "false_positive", "inconclusive")
ALERT_REQUIRED = ("source", "type", "severity", "timestamp", "hackerrank_username", "title")

# in-memory alert store keyed on id (mirrors Firestore doc-by-id merge)
STORE = {}
API_KEY = os.environ.get("ALERTS_INGEST_API_KEY", "")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")


def normalize_username(value):
    s = re.sub(r'[^a-zA-Z0-9._-]', '_', str(value).strip().lower())
    return s[:120]


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


class BadRequest(Exception):
    def __init__(self, code, msg):
        self.code = code
        self.msg = msg


def normalize_alert(alert, index, received_at):
    if not isinstance(alert, dict):
        raise BadRequest(400, f"alerts[{index}] must be an object")
    for f in ALERT_REQUIRED:
        v = alert.get(f)
        if v is None or v == "":
            raise BadRequest(400, f"alerts[{index}].{f} is required")
    if alert["source"] not in ALERT_SOURCES:
        raise BadRequest(400, f"alerts[{index}].source must be one of {', '.join(ALERT_SOURCES)}")
    if alert["severity"] not in ALERT_SEVERITIES:
        raise BadRequest(400, f"alerts[{index}].severity must be one of {', '.join(ALERT_SEVERITIES)}")
    # ISO timestamp sanity (cheap)
    try:
        datetime.fromisoformat(str(alert["timestamp"]).replace("Z", "+00:00"))
    except ValueError:
        raise BadRequest(400, f"alerts[{index}].timestamp must be a valid ISO 8601 date")

    username = str(alert["hackerrank_username"]).strip()
    username_norm = normalize_username(alert.get("username_norm") or username)
    aid = alert.get("id")
    if aid is None or aid == "":
        aid = f"{alert['source']}:{alert['type']}:{username_norm}:{alert.get('contest_slug') or '_'}:{alert['timestamp']}"
    item = {
        "id": str(aid),
        "source": str(alert["source"]),
        "type": str(alert["type"]),
        "severity": str(alert["severity"]),
        "timestamp": str(alert["timestamp"]),
        "hackerrank_username": username,
        "username_norm": username_norm,
        "title": str(alert["title"]),
        "received_at": received_at,
    }
    for k in ("contest_slug", "session_id", "room", "detail", "video_key"):
        if alert.get(k):
            item[k] = str(alert[k])
    if isinstance(alert.get("data"), dict):
        item["data"] = alert["data"]
    if isinstance(alert.get("verdict"), dict):
        status = alert["verdict"].get("status")
        v = {"status": status if status in ALERT_VERDICT_STATUSES else "pending"}
        if alert["verdict"].get("reason"):
            v["reason"] = str(alert["verdict"]["reason"])[:2000]
        if alert["verdict"].get("by"):
            v["by"] = str(alert["verdict"]["by"])[:200]
        item["verdict"] = v
    return item


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # silence default access logging
        pass

    def _send(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("access-control-allow-origin", "*")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        n = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(n) if n else b""
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/admin/alerts":
            return self._admin_alerts(parse_qs(parsed.query))
        if parsed.path == "/healthz":
            return self._send(200, {"ok": True})
        return self._send(404, {"error": "Not found"})

    def do_POST(self):
        if urlparse(self.path).path == "/api/alerts":
            return self._ingest()
        return self._send(404, {"error": "Not found"})

    def _ingest(self):
        # closed-by-default: reject if no key configured or key mismatch
        if not API_KEY:
            return self._send(401, {"error": "Unauthorized"})
        if (self.headers.get("x-api-key") or "") != API_KEY:
            return self._send(401, {"error": "Unauthorized"})
        try:
            body = self._read_json()
        except ValueError:
            return self._send(400, {"error": "invalid JSON"})
        raw = body.get("alerts") if isinstance(body, dict) and isinstance(body.get("alerts"), list) else [body]
        if not raw:
            return self._send(400, {"error": "No alerts provided"})
        if len(raw) > 500:
            return self._send(400, {"error": "Too many alerts in one request (max 500)"})
        received_at = now_iso()
        try:
            normalized = [normalize_alert(a, i, received_at) for i, a in enumerate(raw)]
        except BadRequest as e:
            return self._send(e.code, {"error": e.msg})
        for item in normalized:  # idempotent merge keyed on id
            STORE[item["id"]] = {**STORE.get(item["id"], {}), **item}
        return self._send(200, {"ok": True, "ingested": len(normalized),
                                "ids": [a["id"] for a in normalized]})

    def _admin_alerts(self, q):
        if not ADMIN_PASSWORD or (self.headers.get("x-admin-password") or "") != ADMIN_PASSWORD:
            return self._send(401, {"error": "Unauthorized"})
        alerts = list(STORE.values())
        if "contest_slug" in q:
            alerts = [a for a in alerts if a.get("contest_slug") == q["contest_slug"][0]]
        if "severity" in q:
            alerts = [a for a in alerts if a.get("severity") == q["severity"][0]]
        if "source" in q:
            alerts = [a for a in alerts if a.get("source") == q["source"][0]]
        alerts.sort(key=lambda a: str(a.get("timestamp") or ""), reverse=True)
        for a in alerts:
            a.setdefault("download_url", None)
        return self._send(200, {"alerts": alerts})


def main(argv=None):
    p = argparse.ArgumentParser(description="mock proctor alert backend (demo only)")
    p.add_argument("--port", type=int, default=8799)
    p.add_argument("--host", default="127.0.0.1")
    args = p.parse_args(argv)
    if not API_KEY:
        print("WARNING: ALERTS_INGEST_API_KEY unset; ingest will reject all requests",
              file=sys.stderr)
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[mock-backend] listening on http://{args.host}:{args.port} "
          f"(ingest x-api-key {'set' if API_KEY else 'UNSET'}, "
          f"admin x-admin-password {'set' if ADMIN_PASSWORD else 'UNSET'})",
          flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
