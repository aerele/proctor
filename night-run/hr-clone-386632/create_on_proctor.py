#!/usr/bin/env python3
"""POST the 12 cloned problems + the contest template to the proctor dev API."""
import json, os, sys, urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))
API = "https://proctor-api-ej4cpz43iq-el.a.run.app"
PW = os.environ.get("ADMIN_PASSWORD")
if not PW:
    sys.exit("ADMIN_PASSWORD not in env")

def call(method, path, body=None):
    req = urllib.request.Request(
        API + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"x-admin-password": PW, "Content-Type": "application/json"},
        method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")

aerele = json.load(open(f"{BASE}/extraction-aerele.json"))
adapted = json.load(open(f"{BASE}/extraction-sql-adapted.json"))

entries = []  # (order, problem_id)
for e in aerele:
    payload = {
        "id": e["hr_slug"],
        "title": e["title"],
        "statement": e["statement_md"],
        "statement_format": "markdown",
        "languages": ["python", "cpp", "java", "javascript"],
        "cpuTimeLimit": 5,
        "memoryLimit": 128000,
        "points": e["points"],
        "scoring": e["scoring"],
        "status": "published",
        "sampleTests": [{"input": t["input"], "expected": t["expected"]} for t in e["sample_tests"]],
        "hiddenTests": [{"input": t["input"], "expected": t["expected"]} for t in e["hidden_tests"]],
        "stubs": e["stubs"],
        "tags": ["hr-clone", "kec-aerele"],
    }
    status, resp = call("POST", "/api/admin/problems", payload)
    print(f"problem {payload['id']}: HTTP {status} -> {resp.get('ok', resp)}")
    if status != 200 or not resp.get("ok"):
        print(json.dumps(resp, indent=2)); sys.exit(1)
    entries.append((e["order"], payload["id"]))

for p in adapted:
    payload = {
        "id": p["id"],
        "title": p["title"],
        "statement": p["statement_md"],
        "statement_format": "markdown",
        "languages": ["python", "cpp", "java", "javascript"],
        "cpuTimeLimit": 5,
        "memoryLimit": 128000,
        "points": p["points"],
        "scoring": p["scoring"],
        "status": "published",
        "sampleTests": [{"input": t["input"], "expected": t["expected"]} for t in p["sample_tests"]],
        "hiddenTests": [{"input": t["input"], "expected": t["expected"]} for t in p["hidden_tests"]],
        "stubs": p["stubs"],
        "tags": ["hr-clone", "kec-aerele", "sql-adapted"],
    }
    status, resp = call("POST", "/api/admin/problems", payload)
    print(f"problem {payload['id']}: HTTP {status} -> {resp.get('ok', resp)}")
    if status != 200 or not resp.get("ok"):
        print(json.dumps(resp, indent=2)); sys.exit(1)
    entries.append((p["order"], payload["id"]))

entries.sort()
template_payload = {
    "name": "KEC - Aerele Coding Contest",
    "description": "Cloned from HackerRank contest #386632 (kec-aerele-coding-contest) on 2026-06-12. "
                   "12 problems, 10 points each, per-test scoring. Problems 10-12 are stdin/stdout "
                   "adaptations of the original SQL challenges.",
    "problems": [{"problem_id": pid, "points": None, "order": order} for order, pid in entries],
    "defaults": {
        "duration_minutes": 120,
        "languages": ["python", "cpp", "java", "javascript"],
    },
}
status, resp = call("POST", "/api/admin/templates", template_payload)
print(f"template: HTTP {status} -> slug={resp.get('template', {}).get('slug')}")
if status != 200 or not resp.get("ok"):
    print(json.dumps(resp, indent=2)); sys.exit(1)
json.dump(resp, open(f"{BASE}/created-template-response.json", "w"), indent=2)
print("DONE")
