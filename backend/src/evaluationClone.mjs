// backend/src/evaluationClone.mjs — pure JS (ESM) port of
// monitoring/contest_eval_core.py, byte-parity. No I/O, no env reads, no
// imports. The cross-candidate clone passes (evaluationMetrics) call these.
//
// PARITY NOTES (Python re → JS RegExp):
//   - Python `re` `\s`, `\w`, `\d` are Unicode-aware; JS `\s`/`\w`/`\d` are
//     ASCII-ish (and JS `\s` additionally matches U+FEFF/BOM, which Python's
//     does NOT). To reproduce Python's character classes exactly we build
//     explicit classes:
//       PY_WS  — every codepoint Python `\s` matches (verified by full-range
//                enumeration): tab/LF/VT/FF/CR, U+1C–U+1F, space, U+85 (NEL),
//                U+A0 (NBSP), U+1680, U+2000–U+200A, U+2028, U+2029, U+202F,
//                U+205F, U+3000.  (JS `\s` differs: it omits U+1C–U+1F & U+85
//                and wrongly includes U+FEFF.)
//       \w  →  [\p{L}\p{N}_]   (full-range enumeration: identical 142940 cps)
//       \d  →  \p{Nd}          (full-range enumeration: identical 760 cps)
//   - COMMENT uses Python flags re.M | re.S → JS flags `m` + `s` (dotAll).
//   - Python dict insertion-order iteration is mirrored with Map insertion
//     order; Python `list.sort` is stable, and so is JS `Array.sort`.

// Every codepoint Python's `\s` matches (see PARITY NOTES). Used in a char
// class; the leading `\\` escapes keep it literal inside the class.
const PY_WS = "\\t\\n\\x0b\\f\\r\\x1c\\x1d\\x1e\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

// ---------------------------------------------------------------------------
// difficulty bucketing (identical thresholds to the Python original)
// ---------------------------------------------------------------------------
export function makeHardness(challenges) {
  // chal = {c["slug"]: c for c in challenges} — last write wins, like Python.
  const chal = new Map();
  for (const c of challenges) chal.set(c.slug, c);
  return function hardness(slug) {
    const c = chal.get(slug);
    const raw = c ? c.solved : 0;
    // Python: `s = chal.get(slug, {}).get("solved", 0) or 0` — None/0/undefined → 0.
    const s = raw || 0;
    if (s <= 10) return "hard";
    if (s <= 40) return "med";
    return "easy";
  };
}

// ---------------------------------------------------------------------------
// normalization (verbatim from clone_detect.py)
// ---------------------------------------------------------------------------
// COMMENT = re.compile(r'//.*?$|/\*.*?\*/|#.*?$|--.*?$', re.M | re.S)
const COMMENT = /\/\/.*?$|\/\*.*?\*\/|#.*?$|--.*?$/gms;

const KW = new Set(
  ("for while if else elif return def class public private static void int long " +
    "float double char string str list dict set map vector array new import from " +
    "include using namespace std int main print println printf scanf cout cin endl " +
    "system out in range len append sort sorted reversed function var let const " +
    "select from where group by order having count sum max min as join on and or " +
    "not null true false def lambda yield try except finally with break continue " +
    "pass switch case default struct typedef").split(/ /)
);

export function stripBoiler(c) {
  // BOILER mirrors the Python line filter; `^\s*` uses Python whitespace.
  const BOILER = new RegExp(
    `^[${PY_WS}]*#!|^[${PY_WS}]*import |os\\.environ|OUTPUT_PATH|__main__|fptr|^[${PY_WS}]*package |^[${PY_WS}]*using System`
  );
  const out = [];
  for (const l of c.split("\n")) {
    if (BOILER.test(l)) continue;
    out.push(l);
  }
  return out.join("\n");
}

export function coreExact(c) {
  let s = stripBoiler(c);
  s = s.replace(COMMENT, "");
  // re.sub(r"'''[\s\S]*?'''", '', s) — [\s\S] is "any char"; no flag needed in JS
  // because the class itself spans newlines. `gms` would also work but plain `g`
  // + the class matches Python exactly.
  s = s.replace(/'''[\s\S]*?'''/g, "");
  // re.sub(r'\s+', ' ', s) — Python whitespace class
  s = s.replace(new RegExp(`[${PY_WS}]+`, "g"), " ");
  // re.sub(r'\s*([=+\-*/(),:;<>\[\]{}%&|!])\s*', r'\1', s)
  s = s.replace(
    new RegExp(`[${PY_WS}]*([=+\\-*/(),:;<>\\[\\]{}%&|!])[${PY_WS}]*`, "g"),
    "$1"
  );
  // s.strip().lower() — Python .strip() trims Python whitespace.
  s = s.replace(new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g"), "");
  return s.toLowerCase();
}

// TOKEN = re.compile(r'[A-Za-z_]\w*|\d+|[^\sA-Za-z0-9_]')
// \w → [\p{L}\p{N}_]; \d → \p{Nd}; \s → PY_WS (parity). `u` flag for \p escapes.
const TOKEN = new RegExp(
  `[A-Za-z_][\\p{L}\\p{N}_]*|\\p{Nd}+|[^${PY_WS}A-Za-z0-9_]`,
  "gu"
);
// re.match(r'^[A-Za-z_]\w*$', t) — anchored full-token identifier test.
const IDENT_RE = /^[A-Za-z_][\p{L}\p{N}_]*$/u;
// re.match(r'^\d+$', t)
const DIGITS_RE = /^\p{Nd}+$/u;

export function skeleton(c) {
  // identifiers -> V (catches renamed-variable copies); keywords & structure kept.
  let s = stripBoiler(c);
  s = s.replace(COMMENT, "");
  const toks = [];
  for (const match of s.matchAll(TOKEN)) {
    const t = match[0];
    if (IDENT_RE.test(t)) {
      const lower = t.toLowerCase();
      toks.push(KW.has(lower) ? lower : "V");
    } else if (DIGITS_RE.test(t)) {
      toks.push("N");
    } else {
      toks.push(t);
    }
  }
  return toks.join("");
}

// ---------------------------------------------------------------------------
// raw-byte paste artifacts + provenance (verbatim from clone_detect.py)
// ---------------------------------------------------------------------------
export function artifacts(c) {
  const flags = [];
  if (c.includes("\r\n")) flags.push("CRLF");
  if (c.includes("﻿")) flags.push("BOM");
  if (c.includes(" ")) flags.push("NBSP");
  // zero-width: U+200B U+200C U+200D U+2060
  if (/[​‌‍⁠]/.test(c)) flags.push("zero-width");
  // smart-quotes: ‘ ’ “ ”  (U+2018 U+2019 U+201C U+201D)
  if (/[‘’“”]/.test(c)) flags.push("smart-quotes");
  // en/em-dash: – —  (U+2013 U+2014)
  if (/[–—]/.test(c)) flags.push("en/em-dash");
  const lines = c.split("\n");
  const hasTab = lines.some((l) => l.startsWith("\t"));
  const hasSpc = lines.some((l) => l.startsWith("  "));
  if (hasTab && hasSpc) flags.push("mixed-indent");
  return flags;
}

// PROV — pattern/name pairs, in order. Python re.search (unanchored).
const PROV = [
  [/class\s+Solution/, "class-Solution(LeetCode)"],
  [/Driver\s*Code/, "Driver-Code-banner(GfG)"],
  [/def\s+\w+\s*\(\s*self/, "self-method(OOP-wrapper)"],
  [/ios_base::sync_with_stdio/, "cp-fastio(weak)"],
  [/#define\s+ll\b/, "cp-macro-ll(weak)"],
  [/bits\/stdc\+\+\.h/, "bits-stdc++(weak)"],
  [/GeeksforGeeks|geeksforgeeks/, "GfG-mention"],
  [/leetcode/, "leetcode-mention"],
];

export function provenance(c) {
  const out = [];
  for (const [pat, name] of PROV) {
    if (pat.test(c)) out.push(name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLONE ANALYSIS — port of clone_detect.py main body, parameterized.
// Returns {recurring_pairs, exact_clusters, skeleton_clusters, tight, _records}.
// ---------------------------------------------------------------------------
export function analyzeClones(meta, code) {
  // sub_by_id = {str(s["id"]): s for s in meta["submissions"]}
  const subById = new Map();
  for (const s of meta.submissions) subById.set(String(s.id), s);
  const lbRank = new Map();
  for (const m of meta.leaderboard) lbRank.set(m.user, m.rank);
  const hardness = makeHardness(meta.challenges);

  const rank = (u) => (lbRank.has(u) ? lbRank.get(u) : 999);

  // per-submission records (only those with real code, len>=15).
  // Iterate `code` in insertion order (Python dict.items()).
  const recs = [];
  for (const [sid, c] of objectEntriesInOrder(code)) {
    const s = subById.get(sid);
    if (!s || typeof c !== "string" || c.length < 15) continue;
    recs.push({
      id: sid,
      user: s.user,
      ch: s.ch,
      status: s.status,
      score: s.score,
      tfs: s.tfs,
      created: s.created,
      lang: s.lang,
      exact: coreExact(c),
      skel: skeleton(c),
      artifacts: artifacts(c),
      prov: provenance(c),
      len: c.length,
    });
  }

  const acc = recs.filter((r) => r.status === "Accepted");

  function clusters(records, key) {
    const out = [];
    // by_ch = collections.defaultdict(list) — preserve first-seen ch order.
    const byCh = new Map();
    for (const r of records) {
      if (!byCh.has(r.ch)) byCh.set(r.ch, []);
      byCh.get(r.ch).push(r);
    }
    for (const [ch, arr] of byCh) {
      // groups = defaultdict(list) keyed by r[key]; preserve first-seen order.
      const groups = new Map();
      for (const r of arr) {
        const sig = r[key];
        if (!groups.has(sig)) groups.set(sig, []);
        groups.get(sig).push(r);
      }
      for (const members of groups.values()) {
        const users = new Set(members.map((m) => m.user));
        if (users.size > 1) {
          // ms = sorted(members, key=lambda m: (m["created"] or 0)) — stable.
          const ms = stableSort(members, (m) => [m.created || 0]);
          out.push({
            ch,
            hardness: hardness(ch),
            n_users: users.size,
            members: ms.map((m) => ({
              user: m.user,
              rank: rank(m.user),
              tfs: m.tfs,
              created: m.created,
              lang: m.lang,
              id: m.id,
            })),
          });
        }
      }
    }
    // out.sort(key=lambda g: (g["hardness"] != "hard", -g["n_users"])) — stable.
    return stableSort(out, (g) => [g.hardness !== "hard" ? 1 : 0, -g.n_users]);
  }

  const exactCl = clusters(acc, "exact");
  const skelCl = clusters(acc, "skel");

  // recurring pairs (angle 13)
  function pairProblems(clusterList) {
    const pp = new Map(); // pairKey -> {pair, set of ch}
    const ppHard = new Map();
    for (const g of clusterList) {
      // users = sorted({m["user"] for m in g["members"]})
      const users = [...new Set(g.members.map((m) => m.user))].sort(pyStrCmp);
      for (const [a, b] of combinations2(users)) {
        const k = pairKey(a, b);
        if (!pp.has(k)) pp.set(k, { pair: [a, b], chs: new Set() });
        pp.get(k).chs.add(g.ch);
        if (g.hardness === "hard") {
          if (!ppHard.has(k)) ppHard.set(k, { pair: [a, b], chs: new Set() });
          ppHard.get(k).chs.add(g.ch);
        }
      }
    }
    return { pp, ppHard };
  }

  const { pp, ppHard } = pairProblems(skelCl);
  const recurring = [];
  // Iterate pp in insertion order (Python dict iteration over pp.items()).
  for (const [k, entry] of pp) {
    const pair = entry.pair;
    const chs = entry.chs;
    const hardEntry = ppHard.get(k);
    const hardChs = hardEntry ? hardEntry.chs : new Set();
    if (chs.size >= 2 || hardChs.size >= 1) {
      recurring.push({
        pair, // [a, b]
        ranks: [rank(pair[0]), rank(pair[1])],
        n_problems: chs.size,
        problems: [...chs].sort(pyStrCmp),
        n_hard: hardChs.size,
        hard_problems: [...hardChs].sort(pyStrCmp),
      });
    }
  }
  // recurring.sort(key=lambda x: (-x["n_hard"], -x["n_problems"])) — stable.
  const recurringSorted = stableSort(recurring, (x) => [-x.n_hard, -x.n_problems]);

  // same-minute / tight-gap on hard clusters (angles 15-16)
  const tight = [];
  for (const g of skelCl) {
    if (hardness(g.ch) !== "hard") continue;
    const ms = g.members;
    for (const [a, b] of combinations2(ms)) {
      if (a.created && b.created) {
        const dt = Math.abs(a.created - b.created);
        if (dt <= 300) {
          const kind = dt <= 60 ? "SAME-MINUTE" : "tight-gap";
          tight.push([kind, dt, g.ch, a, b]);
        }
      }
    }
  }
  // tight.sort(key=lambda x: x[1]) — stable, by dt.
  const tightSorted = stableSort(tight, (x) => [x[1]]);

  const out = {
    // recurring already carries pair as a list ([a,b]); Python does
    // {**r, "pair": list(r["pair"])}. Our pair is already an array.
    recurring_pairs: recurringSorted.map((r) => ({ ...r, pair: [...r.pair] })),
    exact_clusters: exactCl,
    skeleton_clusters: skelCl,
    tight: tightSorted.map(([k, d, ch, a, b]) => ({
      kind: k,
      dt: d,
      ch,
      a: a.user,
      b: b.user,
    })),
  };
  out._records = recs;
  return out;
}

export function cloneAnalysisCanonical(meta, code) {
  // Exactly the dict clone_detect.py serializes (drops the _records extra).
  const out = analyzeClones(meta, code);
  delete out._records;
  return out;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// Iterate a `code` mapping in insertion order. Accepts a Map or a plain object.
function objectEntriesInOrder(code) {
  if (code instanceof Map) return code;
  return Object.entries(code);
}

// itertools.combinations(seq, 2) — index-ordered pairs, preserving sequence order.
function* combinations2(seq) {
  for (let i = 0; i < seq.length; i++) {
    for (let j = i + 1; j < seq.length; j++) {
      yield [seq[i], seq[j]];
    }
  }
}

// Stable sort by a key that returns an array of comparable scalars (numbers or
// strings), compared lexicographically — mirrors Python tuple-key sorting on a
// stable sort. Numbers compare numerically; strings via Python codepoint order.
function stableSort(arr, keyFn) {
  return arr
    .map((v, i) => [keyFn(v), i, v])
    .sort((A, B) => {
      const ka = A[0];
      const kb = B[0];
      for (let i = 0; i < ka.length; i++) {
        const x = ka[i];
        const y = kb[i];
        if (typeof x === "number" && typeof y === "number") {
          if (x < y) return -1;
          if (x > y) return 1;
        } else {
          const c = pyStrCmp(String(x), String(y));
          if (c !== 0) return c;
        }
      }
      return A[1] - B[1]; // stable tiebreak by original index
    })
    .map((t) => t[2]);
}

// Python compares strings by Unicode codepoint. JS default `<`/`>` on strings
// compares by UTF-16 code unit, which diverges for astral (>U+FFFF) chars. For
// parity we compare by codepoint. (ASCII identifiers/slugs compare identically
// either way; this only matters for exotic inputs.)
function pyStrCmp(a, b) {
  if (a === b) return 0;
  const ia = [...a]; // iterate by codepoint
  const ib = [...b];
  const n = Math.min(ia.length, ib.length);
  for (let i = 0; i < n; i++) {
    const ca = ia[i].codePointAt(0);
    const cb = ib[i].codePointAt(0);
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  return ia.length - ib.length;
}

// Stable, collision-free key for a user pair (both are strings).
function pairKey(a, b) {
  return JSON.stringify([a, b]);
}
