#!/usr/bin/env python3
"""Build normalized extraction JSON for the 9 aerele challenges from raw HR data."""
import json, re, os, html as htmllib, glob

BASE = os.path.dirname(os.path.abspath(__file__))
RAW = json.load(open(f"{BASE}/raw-contest-and-challenges.json"))
MODELS = json.load(open(f"{BASE}/raw-challenge-models.json"))

AERELE = [f"challenge-{i}-aerele" for i in range(1, 10)]

# ---------- HTML -> Markdown ----------

def html_to_md(fragment):
    s = fragment
    s = re.sub(r"<style[^>]*>.*?</style>", "", s, flags=re.S)
    s = re.sub(r"<svg[^>]*>.*?</svg>", "", s, flags=re.S)
    # code/pre blocks -> fenced
    def pre_repl(m):
        inner = re.sub(r"<[^>]+>", "", m.group(1))
        return "\n```\n" + htmllib.unescape(inner).strip("\n") + "\n```\n"
    s = re.sub(r"<div class=\"highlight\"><pre>(.*?)</pre></div>", pre_repl, s, flags=re.S)
    s = re.sub(r"<pre[^>]*>(.*?)</pre>", pre_repl, s, flags=re.S)
    s = re.sub(r"<strong>(.*?)</strong>", r"**\1**", s, flags=re.S)
    s = re.sub(r"<em>(.*?)</em>", r"*\1*", s, flags=re.S)
    s = re.sub(r"<code>(.*?)</code>", r"`\1`", s, flags=re.S)
    s = re.sub(r"<li>(.*?)</li>", r"- \1\n", s, flags=re.S)
    s = re.sub(r"</?(ul|ol)[^>]*>", "\n", s)
    s = re.sub(r"<br\s*/?>", "\n", s)
    s = re.sub(r"<p>(.*?)</p>", lambda m: m.group(1).strip() + "\n\n", s, flags=re.S)
    s = re.sub(r"<[^>]+>", "", s)  # drop remaining tags
    s = htmllib.unescape(s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()

SECTION_TITLES = {
    "problem_statement": None,  # no heading, it's the lead
    "input_format": "Input Format",
    "constraints": "Constraints",
    "output_format": "Output Format",
}

def parse_statement(body_html):
    """Split body_html into its challenge_* section divs (they are siblings)."""
    # find top-level section divs in order
    parts = re.split(r"<div class='challenge_([a-z_]+)'>", body_html)
    # parts: [prefix, name1, html1, name2, html2, ...]
    sections = []
    for i in range(1, len(parts), 2):
        sections.append((parts[i], parts[i + 1]))
    md_chunks = []
    samples = []  # list of dicts {idx, input, output}
    cur = {}
    for name, frag in sections:
        # title text e.g. "Sample Input 0"
        title_m = re.search(r"_title'>\s*<p><strong>(.*?)</strong></p>", frag)
        title = title_m.group(1).strip() if title_m else None
        body_m = re.search(r"_body'>(.*)$", frag, flags=re.S)
        body = body_m.group(1) if body_m else frag
        md = html_to_md(body)
        if name == "problem_statement":
            md_chunks.append(md)
        elif name in ("input_format", "constraints", "output_format"):
            md_chunks.append(f"### {SECTION_TITLES[name]}\n\n{md}")
        elif name == "sample_input":
            idx = int(re.search(r"(\d+)", title).group(1)) if title and re.search(r"\d+", title) else len(samples)
            code = re.search(r"```\n(.*?)\n```", md, flags=re.S)
            cur = {"idx": idx, "input": code.group(1) if code else md}
            md_chunks.append(f"### {title or 'Sample Input'}\n\n{md}")
        elif name == "sample_output":
            code = re.search(r"```\n(.*?)\n```", md, flags=re.S)
            cur["output"] = code.group(1) if code else md
            samples.append(cur)
            cur = {}
            md_chunks.append(f"### {title or 'Sample Output'}\n\n{md}")
        elif name == "explanation":
            md_chunks.append(f"### {title or 'Explanation'}\n\n{md}")
        else:
            md_chunks.append((f"### {title}\n\n" if title else "") + md)
    return "\n\n".join(md_chunks), samples

# ---------- stub composition (OUTPUT_PATH -> stdout) ----------

def compose_stub(m, hr_lang, proctor_lang):
    head = m.get(f"{hr_lang}_template_head") or ""
    body = m.get(f"{hr_lang}_template") or ""
    tail = m.get(f"{hr_lang}_template_tail") or ""
    full = head.rstrip("\n") + "\n\n" + body.rstrip("\n") + "\n\n" + tail.rstrip("\n") + "\n"
    if proctor_lang == "python":
        new = full.replace("fptr = open(os.environ['OUTPUT_PATH'], 'w')", "fptr = sys.stdout")
        assert new != full, f"python OUTPUT_PATH pattern missing"
        new = new.replace("\n    fptr.close()", "")
        return new
    if proctor_lang == "cpp":
        new = full.replace('ofstream fout(getenv("OUTPUT_PATH"));', "ostream& fout = cout;")
        assert new != full, "cpp OUTPUT_PATH pattern missing"
        new2 = new.replace("\n    fout.close();", "")
        assert new2 != new, "cpp fout.close pattern missing"
        return new2
    if proctor_lang == "java":
        new = full.replace(
            'BufferedWriter bufferedWriter = new BufferedWriter(new FileWriter(System.getenv("OUTPUT_PATH")));',
            "BufferedWriter bufferedWriter = new BufferedWriter(new OutputStreamWriter(System.out));")
        assert new != full, "java OUTPUT_PATH pattern missing"
        new2 = new.replace("public class Solution {", "public class Main {")
        assert new2 != new, "java Solution class pattern missing"
        return new2
    if proctor_lang == "javascript":
        new = full.replace(
            "const ws = fs.createWriteStream(process.env.OUTPUT_PATH);",
            "const ws = { write: (s) => process.stdout.write(s), end: () => {} };")
        assert new != full, "js OUTPUT_PATH pattern missing"
        return new
    raise ValueError(proctor_lang)

# ---------- testcases ----------

def load_cases(slug):
    cases = []
    for inp in sorted(glob.glob(f"{BASE}/testcases/{slug}/input/input*.txt")):
        n = re.search(r"input(\d+)\.txt", inp).group(1)
        out = f"{BASE}/testcases/{slug}/output/output{n}.txt"
        cases.append({
            "hr_index": int(n),
            "input": open(inp).read(),
            "expected": open(out).read(),
        })
    return cases

# ---------- main ----------

order_by_slug = {c["slug"]: i for i, c in enumerate(RAW["challenges"]["models"])}
weight_by_slug = {c["slug"]: c["weight"] for c in RAW["challenges"]["models"]}
binary_by_slug = {c["slug"]: c["binary_scoring"] for c in RAW["challenges"]["models"]}

extractions = []
for slug in AERELE:
    m = MODELS[slug]["model"]
    statement_md, samples = parse_statement(m["body_html"])
    cases = load_cases(slug)
    # classify: a downloaded case whose input matches a statement sample -> sample
    sample_inputs = {s["input"].rstrip("\n"): s for s in samples}
    sample_tests, hidden_tests = [], []
    for c in cases:
        key = c["input"].rstrip("\n")
        if key in sample_inputs:
            sample_tests.append(c)
            del sample_inputs[key]
        else:
            hidden_tests.append(c)
    stubs = {}
    for proctor_lang, hr_lang in [("python", "python3"), ("cpp", "cpp"), ("java", "java"), ("javascript", "javascript")]:
        stubs[proctor_lang] = compose_stub(m, hr_lang, proctor_lang)
    extractions.append({
        "hr_slug": slug,
        "hr_challenge_id": m["id"],
        "title": m["name"],
        "order": order_by_slug[slug],
        "points": weight_by_slug[slug],
        "scoring": "all_or_nothing" if binary_by_slug[slug] else "per_test",
        "hr_languages": m["languages"],
        "proctor_languages": ["python", "cpp", "java", "javascript"],
        "statement_md": statement_md,
        "statement_samples_found": len(samples),
        "sample_tests": sample_tests,
        "hidden_tests": hidden_tests,
        "stubs": stubs,
        "tests_provenance": "copied_from_hackerrank",
    })
    print(f"{slug}: order={order_by_slug[slug]} samples={len(sample_tests)} hidden={len(hidden_tests)} stmt_md={len(statement_md)} chars")

json.dump(extractions, open(f"{BASE}/extraction-aerele.json", "w"), indent=2)
print("wrote extraction-aerele.json")
