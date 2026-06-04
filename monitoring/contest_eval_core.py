#!/usr/bin/env python3
"""contest_eval_core — parameterized port of the deterministic analysis logic from
contest-eval/analyze_meta.py + contest-eval/clone_detect.py.

WHY THIS EXISTS (wrapper-over-fork, logged decision):
  The canonical scripts in /home/karthi/arogara/contest-eval/ hardcode their input
  paths (data/raw/contest_386562_meta.json, data/raw/code_386562.json) and run as
  __main__ side-effecting scripts that read/write files and print. They are NOT
  importable as a contest-agnostic library. The task forbids editing the originals.
  So this module is a PARAMETERIZED COPY of *only the analysis functions* (the
  normalization, clone clustering, recurring-pairs, tight-gap, artifact/provenance
  passes, and the metadata-iteration profile). The logic is kept byte-for-byte
  equivalent to the originals so results reproduce the committed clone_analysis.json.

  The meta-JSON field contract is the post-acquisition shape (renames already applied
  by the acquisition layer):
      slug, leaderboard[{user,score,time_taken,rank,school,lang}],
      challenges[{slug,name,solved,total,max_score,difficulty,...}],
      submissions[{id,user,ch,chName,lang,status,score,tfs,created}]
  Code JSON: {submission_id(str): code(str)}  (only fetched subs present).

This module is pure functions over in-memory dicts — no file I/O, no argv, no print.
It is reused by poller.py (live loop) and validate_fixtures.py (reproduction proof).
"""
import re
import collections
import itertools


# ---------------------------------------------------------------------------
# difficulty bucketing (identical thresholds to both originals)
# ---------------------------------------------------------------------------
def make_hardness(challenges):
    """Return a hardness(slug) closure. <=10 solvers=hard, <=40=med, else easy."""
    chal = {c["slug"]: c for c in challenges}

    def hardness(slug):
        s = chal.get(slug, {}).get("solved", 0) or 0
        if s <= 10:
            return "hard"
        if s <= 40:
            return "med"
        return "easy"

    return hardness


# ---------------------------------------------------------------------------
# normalization (verbatim from clone_detect.py)
# ---------------------------------------------------------------------------
COMMENT = re.compile(r'//.*?$|/\*.*?\*/|#.*?$|--.*?$', re.M | re.S)
KW = set(
    "for while if else elif return def class public private static void int long "
    "float double char string str list dict set map vector array new import from "
    "include using namespace std int main print println printf scanf cout cin endl "
    "system out in range len append sort sorted reversed function var let const "
    "select from where group by order having count sum max min as join on and or "
    "not null true false def lambda yield try except finally with break continue "
    "pass switch case default struct typedef".split()
)


def strip_boiler(c):
    out = []
    for l in c.split('\n'):
        if re.search(r'^\s*#!|^\s*import |os\.environ|OUTPUT_PATH|__main__|fptr|^\s*package |^\s*using System', l):
            continue
        out.append(l)
    return '\n'.join(out)


def core_exact(c):
    s = strip_boiler(c)
    s = COMMENT.sub('', s)
    s = re.sub(r"'''[\s\S]*?'''", '', s)
    s = re.sub(r'\s+', ' ', s)
    s = re.sub(r'\s*([=+\-*/(),:;<>\[\]{}%&|!])\s*', r'\1', s)
    return s.strip().lower()


TOKEN = re.compile(r'[A-Za-z_]\w*|\d+|[^\sA-Za-z0-9_]')


def skeleton(c):
    """identifiers -> V (catches renamed-variable copies); keywords & structure kept."""
    s = strip_boiler(c)
    s = COMMENT.sub('', s)
    toks = []
    for t in TOKEN.findall(s):
        if re.match(r'^[A-Za-z_]\w*$', t):
            toks.append(t.lower() if t.lower() in KW else 'V')
        elif re.match(r'^\d+$', t):
            toks.append('N')
        else:
            toks.append(t)
    return ''.join(toks)


# ---------------------------------------------------------------------------
# raw-byte paste artifacts + provenance (verbatim from clone_detect.py)
# ---------------------------------------------------------------------------
def artifacts(c):
    flags = []
    if '\r\n' in c:
        flags.append('CRLF')
    if '﻿' in c:
        flags.append('BOM')
    if ' ' in c:
        flags.append('NBSP')
    if any(ch in c for ch in '​‌‍⁠'):
        flags.append('zero-width')
    if any(ch in c for ch in '‘’“”'):
        flags.append('smart-quotes')
    if any(ch in c for ch in '–—'):
        flags.append('en/em-dash')
    has_tab = any(l.startswith('\t') for l in c.split('\n'))
    has_spc = any(l.startswith('  ') for l in c.split('\n'))
    if has_tab and has_spc:
        flags.append('mixed-indent')
    return flags


PROV = [
    (r'class\s+Solution', 'class-Solution(LeetCode)'),
    (r'Driver\s*Code', 'Driver-Code-banner(GfG)'),
    (r'def\s+\w+\s*\(\s*self', 'self-method(OOP-wrapper)'),
    (r'ios_base::sync_with_stdio', 'cp-fastio(weak)'),
    (r'#define\s+ll\b', 'cp-macro-ll(weak)'),
    (r'bits/stdc\+\+\.h', 'bits-stdc++(weak)'),
    (r'GeeksforGeeks|geeksforgeeks', 'GfG-mention'),
    (r'leetcode', 'leetcode-mention'),
]


def provenance(c):
    return [name for pat, name in PROV if re.search(pat, c)]


# ---------------------------------------------------------------------------
# CLONE ANALYSIS — port of clone_detect.py main body, parameterized.
# Returns the same dict that clone_detect.py writes to clone_analysis.json:
#   {recurring_pairs, exact_clusters, skeleton_clusters, tight}
# Plus an extra "_records" key (per-sub artifacts/provenance) for alert building;
# callers that want byte-for-byte clone_analysis.json should drop "_records".
# ---------------------------------------------------------------------------
def analyze_clones(meta, code):
    sub_by_id = {str(s["id"]): s for s in meta["submissions"]}
    chal = {c["slug"]: c for c in meta["challenges"]}
    lb_rank = {m["user"]: m["rank"] for m in meta["leaderboard"]}
    hardness = make_hardness(meta["challenges"])

    def rank(u):
        return lb_rank.get(u, 999)

    # per-submission records (only those with real code, len>=15)
    recs = []
    for sid, c in code.items():
        s = sub_by_id.get(sid)
        if not s or not isinstance(c, str) or len(c) < 15:
            continue
        recs.append({
            "id": sid, "user": s["user"], "ch": s["ch"], "status": s["status"],
            "score": s["score"], "tfs": s["tfs"], "created": s["created"], "lang": s["lang"],
            "exact": core_exact(c), "skel": skeleton(c),
            "artifacts": artifacts(c), "prov": provenance(c), "len": len(c),
        })

    acc = [r for r in recs if r["status"] == "Accepted"]

    def clusters(records, key):
        out = []
        by_ch = collections.defaultdict(list)
        for r in records:
            by_ch[r["ch"]].append(r)
        for ch, arr in by_ch.items():
            groups = collections.defaultdict(list)
            for r in arr:
                groups[r[key]].append(r)
            for sig, members in groups.items():
                users = {m["user"] for m in members}
                if len(users) > 1:
                    ms = sorted(members, key=lambda m: (m["created"] or 0))
                    out.append({
                        "ch": ch, "hardness": hardness(ch), "n_users": len(users),
                        "members": [
                            {"user": m["user"], "rank": rank(m["user"]), "tfs": m["tfs"],
                             "created": m["created"], "lang": m["lang"], "id": m["id"]}
                            for m in ms
                        ],
                    })
        out.sort(key=lambda g: (g["hardness"] != "hard", -g["n_users"]))
        return out

    exact_cl = clusters(acc, "exact")
    skel_cl = clusters(acc, "skel")

    # recurring pairs (angle 13)
    def pair_problems(cluster_list):
        pp = collections.defaultdict(set)
        pp_hard = collections.defaultdict(set)
        for g in cluster_list:
            users = sorted({m["user"] for m in g["members"]})
            for a, b in itertools.combinations(users, 2):
                pp[(a, b)].add(g["ch"])
                if g["hardness"] == "hard":
                    pp_hard[(a, b)].add(g["ch"])
        return pp, pp_hard

    pp, pp_hard = pair_problems(skel_cl)
    recurring = []
    for pair, chs in pp.items():
        hard_chs = pp_hard.get(pair, set())
        if len(chs) >= 2 or len(hard_chs) >= 1:
            recurring.append({
                "pair": pair, "ranks": [rank(pair[0]), rank(pair[1])],
                "n_problems": len(chs), "problems": sorted(chs),
                "n_hard": len(hard_chs), "hard_problems": sorted(hard_chs),
            })
    recurring.sort(key=lambda x: (-x["n_hard"], -x["n_problems"]))

    # same-minute / tight-gap on hard clusters (angles 15-16)
    tight = []
    for g in skel_cl:
        if hardness(g["ch"]) != "hard":
            continue
        ms = g["members"]
        for a, b in itertools.combinations(ms, 2):
            if a["created"] and b["created"]:
                dt = abs(a["created"] - b["created"])
                if dt <= 300:
                    kind = "SAME-MINUTE" if dt <= 60 else "tight-gap"
                    tight.append((kind, dt, g["ch"], a, b))
    tight.sort(key=lambda x: x[1])

    out = {
        "recurring_pairs": [{**r, "pair": list(r["pair"])} for r in recurring],
        "exact_clusters": exact_cl,
        "skeleton_clusters": skel_cl,
        "tight": [{"kind": k, "dt": d, "ch": ch, "a": a["user"], "b": b["user"]}
                  for k, d, ch, a, b in tight],
    }
    # extra (not part of the canonical clone_analysis.json contract)
    out["_records"] = recs
    return out


def clone_analysis_canonical(meta, code):
    """Exactly the dict clone_detect.py serializes (drops the _records extra)."""
    out = dict(analyze_clones(meta, code))
    out.pop("_records", None)
    return out


# ---------------------------------------------------------------------------
# METADATA PROFILE — port of analyze_meta.py, parameterized.
# Computes per-user iteration metrics over ALL participants (not just top-N)
# from metadata alone (no code). Returns {challenges, profiles_by_user}.
# This is the deterministic "who looks suspicious" pass that decides which
# candidates get their code lazily fetched.
# ---------------------------------------------------------------------------
def analyze_meta(meta, topn=None):
    subs = meta["submissions"]
    chal = {c["slug"]: c for c in meta["challenges"]}
    lb = meta["leaderboard"]
    lb_by_user = {m["user"]: m for m in lb}
    hardness = make_hardness(meta["challenges"])

    def is_accept(s, cslug):
        mx = chal.get(cslug, {}).get("max_score")
        if s["status"] == "Accepted":
            return True
        if mx and s["score"] is not None and s["score"] >= mx:
            return True
        return False

    # group submissions per (user, challenge)
    g = collections.defaultdict(list)
    for s in subs:
        g[(s["user"], s["ch"])].append(s)
    for k in g:
        g[k].sort(key=lambda s: (s["created"] or 0, s["id"]))

    ranked = sorted(lb, key=lambda m: m["rank"])
    target_users = [m["user"] for m in ranked]
    if topn is not None:
        target_users = target_users[:topn]

    # index (user,ch) keys per user for speed
    keys_by_user = collections.defaultdict(list)
    for (uu, cs) in g:
        keys_by_user[uu].append((uu, cs))

    profiles = {}
    for u in target_users:
        rec = {
            "user": u,
            "rank": lb_by_user.get(u, {}).get("rank"),
            "score": lb_by_user.get(u, {}).get("score"),
            "time_taken": lb_by_user.get(u, {}).get("time_taken"),
            "school": lb_by_user.get(u, {}).get("school"),
        }
        langs = set()
        solved_full = []
        genuine_iter = []
        single_attempt = []
        single_attempt_hard = []
        never_solved_attempts = []
        redundant_reaccepts = 0
        accept_times = []
        first_tfs = None
        for key in keys_by_user.get(u, []):
            cs = key[1]
            arr = g[key]
            for s in arr:
                if s["lang"]:
                    langs.add(s["lang"])
                if s["tfs"] is not None:
                    first_tfs = s["tfs"] if first_tfs is None else min(first_tfs, s["tfs"])
            acc_idx = next((i for i, s in enumerate(arr) if is_accept(s, cs)), None)
            if acc_idx is None:
                never_solved_attempts.append((cs, len(arr)))
                continue
            solved_full.append(cs)
            wrong_before = sum(1 for s in arr[:acc_idx] if not is_accept(s, cs))
            reaccepts = sum(1 for s in arr[acc_idx + 1:] if is_accept(s, cs))
            redundant_reaccepts += reaccepts
            if arr[acc_idx]["tfs"] is not None:
                accept_times.append(arr[acc_idx]["tfs"])
            if wrong_before >= 1:
                genuine_iter.append(cs)
            elif acc_idx == 0:
                single_attempt.append(cs)
                if hardness(cs) == "hard":
                    single_attempt_hard.append(cs)
        accept_times.sort()
        gaps = [round(accept_times[i + 1] - accept_times[i], 1) for i in range(len(accept_times) - 1)]
        rec.update({
            "languages": sorted(langs),
            "n_solved_full": len(solved_full),
            "solved_full": solved_full,
            "n_genuine_iteration": len(genuine_iter),
            "genuine_iteration_problems": genuine_iter,
            "n_single_attempt": len(single_attempt),
            "single_attempt_problems": single_attempt,
            "single_attempt_HARD_problems": single_attempt_hard,
            "n_never_solved_attempts": len(never_solved_attempts),
            "never_solved": never_solved_attempts,
            "redundant_reaccepts": redundant_reaccepts,
            "first_submission_tfs_min": first_tfs,
            "accept_times_min": accept_times,
            "accept_gaps_min": gaps,
            "zero_iteration": len(genuine_iter) == 0 and len(solved_full) > 0,
        })
        profiles[u] = rec

    return {"challenges": meta["challenges"], "profiles_by_user": profiles}


# ---------------------------------------------------------------------------
# FLAG SELECTION — purely metadata-driven shortlist of candidates whose code
# is worth fetching (the 429-expensive step). Deterministic, conservative.
# A candidate is flagged-for-code-fetch if ANY of:
#   - single-attempt full solve on a HARD problem (zero-iteration on hard)
#   - zero_iteration across a non-trivial solve set (>=3 solves, no failures)
# These mirror the methodology's "primary metadata flags". We fetch code for
# these candidates' ACCEPTED submissions to confirm/clear via clone detection.
# ---------------------------------------------------------------------------
def metadata_flag_candidates(meta_analysis, min_solves_for_zero_iter=3):
    flagged = {}
    for u, p in meta_analysis["profiles_by_user"].items():
        reasons = []
        if p.get("single_attempt_HARD_problems"):
            reasons.append({
                "kind": "single_attempt_hard",
                "problems": p["single_attempt_HARD_problems"],
            })
        if p.get("zero_iteration") and p.get("n_solved_full", 0) >= min_solves_for_zero_iter:
            reasons.append({
                "kind": "zero_iteration",
                "n_solved": p["n_solved_full"],
            })
        if reasons:
            flagged[u] = reasons
    return flagged
