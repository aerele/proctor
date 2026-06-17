#!/usr/bin/env python3
"""GET back every created problem + the template and diff against extraction."""
import json, os, sys, urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))
API = "https://proctor-api-ej4cpz43iq-el.a.run.app"
PW = os.environ.get("ADMIN_PASSWORD")
if not PW:
    sys.exit("ADMIN_PASSWORD not in env")

def get(path):
    req = urllib.request.Request(API + path, headers={"x-admin-password": PW})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())

aerele = json.load(open(f"{BASE}/extraction-aerele.json"))
adapted = json.load(open(f"{BASE}/extraction-sql-adapted.json"))

expected = {}
for e in aerele:
    expected[e["hr_slug"]] = e
for p in adapted:
    expected[p["id"]] = p

LANGS = ["python", "cpp", "java", "javascript"]
rows = []
all_ok = True
for pid, exp in expected.items():
    got = get(f"/api/admin/problem?id={pid}")["problem"]
    checks = {
        "title": got["title"] == exp["title"],
        "stmt_nonempty": bool(got["statement"].strip()),
        "stmt_exact": got["statement"] == exp["statement_md"],
        "fmt_md": got.get("statement_format") == "markdown",
        "languages": sorted(got["languages"]) == sorted(LANGS),
        "stubs_all4": sorted((got.get("stubs") or {}).keys()) == sorted(LANGS)
                      and all((got["stubs"][l] or "").strip() for l in LANGS),
        "stubs_exact": got.get("stubs") == exp["stubs"],
        "samples": [{"input": t["input"], "expected": t["expected"]} for t in exp["sample_tests"]]
                   == got["sampleTests"],
        "hidden": [{"input": t["input"], "expected": t["expected"]} for t in exp["hidden_tests"]]
                  == got["hiddenTests"],
        "points": got["points"] == exp["points"],
        "scoring": got["scoring"] == exp["scoring"],
        "published": got["status"] == "published",
        "limits": got["cpuTimeLimit"] == 5 and got["memoryLimit"] == 128000,
    }
    ok = all(checks.values())
    all_ok &= ok
    rows.append((pid, len(got["sampleTests"]), len(got["hiddenTests"]), checks))
    flags = " ".join(k for k, v in checks.items() if not v) or "ALL-PASS"
    print(f"{pid:32s} samples={len(got['sampleTests'])} hidden={len(got['hiddenTests'])} -> {flags}")

print()
tpl = get("/api/admin/template?slug=kec-aerele-coding-contest")["template"]
order_expected = [(e["order"], e["hr_slug"]) for e in aerele] + [(p["order"], p["id"]) for p in adapted]
order_expected.sort()
tpl_problems = sorted(tpl["problems"], key=lambda x: x["order"])
tpl_ok = (
    tpl["name"] == "KEC - Aerele Coding Contest"
    and [p["problem_id"] for p in tpl_problems] == [pid for _, pid in order_expected]
    and all(p["points"] is None for p in tpl_problems)
    and tpl["defaults"]["duration_minutes"] == 120
    and sorted(tpl["defaults"]["languages"]) == sorted(LANGS)
    and not tpl["archived"]
)
print(f"template slug={tpl['slug']} name={tpl['name']!r} entries={len(tpl_problems)} "
      f"order={[p['problem_id'] for p in tpl_problems]}")
print(f"template defaults: duration={tpl['defaults']['duration_minutes']} langs={tpl['defaults']['languages']}")
print("TEMPLATE OK" if tpl_ok else "TEMPLATE MISMATCH")
json.dump({"problems": [{ "id": r[0], "samples": r[1], "hidden": r[2], "checks": r[3]} for r in rows],
           "template": tpl}, open(f"{BASE}/verification.json", "w"), indent=2)
print("ALL VERIFIED" if (all_ok and tpl_ok) else "VERIFICATION FAILURES")
