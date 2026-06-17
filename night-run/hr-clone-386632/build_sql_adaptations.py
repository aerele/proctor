#!/usr/bin/env python3
"""Adapt the 3 SQL challenges to stdin/stdout problems with generated, validated cases."""
import json, os

BASE = os.path.dirname(os.path.abspath(__file__))

# ---------------- reference solvers ----------------

def solve_ws5(text):
    lines = text.rstrip("\n").split("\n")
    n = int(lines[0])
    cities = lines[1:1 + n]
    shortest = sorted(cities, key=lambda c: (len(c), c))[0]
    longest = sorted(cities, key=lambda c: (-len(c), c))[0]
    return f"{shortest} {len(shortest)}\n{longest} {len(longest)}"

def solve_occ(text):
    lines = text.rstrip("\n").split("\n")
    n = int(lines[0])
    cols = {"Doctor": [], "Professor": [], "Singer": [], "Actor": []}
    for ln in lines[1:1 + n]:
        name, occ = ln.split()
        cols[occ].append(name)
    for k in cols:
        cols[k].sort()
    rows = max(len(v) for v in cols.values())
    out = []
    for i in range(rows):
        out.append(" ".join(
            cols[k][i] if i < len(cols[k]) else "NULL"
            for k in ("Doctor", "Professor", "Singer", "Actor")))
    return "\n".join(out)

def solve_15d(text):
    lines = text.rstrip("\n").split("\n")
    h, s = map(int, lines[0].split())
    names = {}
    for ln in lines[1:1 + h]:
        hid, name = ln.split()
        names[int(hid)] = name
    subs_by_day = {d: [] for d in range(1, 16)}
    for ln in lines[1 + h:1 + h + s]:
        day, hid = map(int, ln.split())
        subs_by_day[day].append(hid)
    out = []
    streak = None  # set of hackers who submitted every day so far
    for d in range(1, 16):
        if not subs_by_day[d]:
            continue
        today = set(subs_by_day[d])
        streak = today if streak is None else (streak & today)
        counts = {}
        for hid in subs_by_day[d]:
            counts[hid] = counts.get(hid, 0) + 1
        best = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
        out.append(f"2016-03-{d:02d} {len(streak)} {best} {names[best]}")
    return "\n".join(out)

# ---------------- case builders ----------------

def case(inp, solver, prov):
    return {"input": inp, "expected": solver(inp), "provenance": prov}

# ---- Weather Observation Station 5 ----
ws5_sample = case(
    "7\nAmo\nDelhi\nMarine On Saint Croix\nPune\nGoa\nKochi\nChennai\n",
    solve_ws5, "generated")
assert ws5_sample["expected"] == "Amo 3\nMarine On Saint Croix 21", ws5_sample["expected"]
ws5_hidden = [
    case("4\nGoa\nAmo\nPuri\nAgra\n", solve_ws5, "generated"),            # 3-len tie -> Amo; 4-len tie -> Agra
    case("1\nHyderabad\n", solve_ws5, "generated"),                        # single city both lines
    case("5\nChennai\nKolkata\nMumbai\nJaipur\nNagpur\n", solve_ws5, "generated"),  # ties both ends
    case("6\nOoty\nNew Delhi Cantonment Area\nEast Godavari District\nPort Blair\nAlibag\nPuri\n", solve_ws5, "generated"),
    case("3\nab\nzb\naa\n", solve_ws5, "generated"),                       # alphabetical tiebreak strictness
]
assert ws5_hidden[0]["expected"] == "Amo 3\nAgra 4"
assert ws5_hidden[1]["expected"] == "Hyderabad 9\nHyderabad 9"
assert ws5_hidden[4]["expected"] == "aa 2\naa 2"  # all same length: alphabetical pick on both ends

# ---- Occupations ----
# Official judge data reconstructed from the official expected output:
occ_official_rows = []
official_cols = {
    "Doctor": ["Aamina", "Julia", "Priya"],
    "Professor": ["Ashley", "Belvet", "Britney", "Maria", "Meera", "Naomi", "Priyanka"],
    "Singer": ["Christeen", "Jane", "Jenny", "Kristeen"],
    "Actor": ["Eve", "Jennifer", "Ketty", "Samantha"],
}
for occ, ns in official_cols.items():
    for nm in ns:
        occ_official_rows.append(f"{nm} {occ}")
occ_official_rows.sort()  # deterministic but arbitrary input order
occ_official_input = f"{len(occ_official_rows)}\n" + "\n".join(occ_official_rows) + "\n"
occ_official = case(occ_official_input, solve_occ, "copied-derived (rebuilt from official expected output; reformatted without trailing spaces)")
# sanity: matches official output modulo per-line trailing spaces
official_expected = open(f"{BASE}/testcases/occupations/output/output000.txt").read()
norm = "\n".join(l.rstrip() for l in official_expected.strip("\n").split("\n"))
assert occ_official["expected"] == norm, (occ_official["expected"], norm)

occ_sample = case(
    "10\nSamantha Doctor\nJulia Actor\nMaria Actor\nMeera Singer\nAshley Professor\nKetty Professor\nChristeen Professor\nJane Actor\nJenny Singer\nPriya Singer\n",
    solve_occ, "generated (mirrors the original statement's worked example)")
occ_hidden = [
    occ_official,
    case("4\nZoe Doctor\nAmy Professor\nBea Singer\nCal Actor\n", solve_occ, "generated"),  # one each, single row
    case("5\nEve Doctor\nAda Doctor\nBob Doctor\nCid Doctor\nDan Singer\n", solve_occ, "generated"),  # heavy skew + NULLs
    case("8\nHari Actor\nGita Actor\nFarah Actor\nElla Actor\nDev Professor\nChitra Singer\nBala Doctor\nAsha Doctor\n", solve_occ, "generated"),
]

# ---- 15 Days of Learning SQL ----
d15_sample = case(
    "4 13\n"
    "11 Rose\n12 Angela\n13 Frank\n14 Patrick\n"
    "1 11\n1 12\n1 13\n1 14\n"
    "2 11\n2 12\n2 12\n"
    "3 11\n3 13\n3 13\n"
    "4 11\n4 11\n4 14\n",
    solve_15d, "generated")
# day1: streak {11,12,13,14}=4, max subs: all 1 -> lowest id 11
# day2: streak {11,12}=2, max: 12 (2 subs)
# day3: streak {11}=1, max: 13 (2 subs)
# day4: streak {11}=1, max: 11 (2 subs)
assert d15_sample["expected"] == (
    "2016-03-01 4 11 Rose\n2016-03-02 2 12 Angela\n"
    "2016-03-03 1 13 Frank\n2016-03-04 1 11 Rose"), d15_sample["expected"]

def gen_15d_full():
    # 5 hackers, 15 days; hacker 21 submits every day; 22 misses day 8;
    # 23 only first 3 days; 24 random-ish bursts; 25 every day, ties with 21 some days.
    hackers = {21: "Asha", 22: "Bram", 23: "Chen", 24: "Devi", 25: "Egan"}
    subs = []
    for d in range(1, 16):
        subs.append((d, 21))
        if d != 8:
            subs.append((d, 22))
        if d <= 3:
            subs += [(d, 23), (d, 23)]
        if d % 4 == 0:
            subs += [(d, 24)] * 3
        subs.append((d, 25))
        if d in (5, 9):
            subs.append((d, 25))
    h = len(hackers); s = len(subs)
    inp = f"{h} {s}\n" + "".join(f"{i} {n}\n" for i, n in hackers.items()) + "".join(f"{d} {i}\n" for d, i in subs)
    return case(inp, solve_15d, "generated")

d15_hidden = [
    gen_15d_full(),
    case("1 15\n31 Solo\n" + "".join(f"{d} 31\n" for d in range(1, 16)), solve_15d, "generated"),  # one hacker all days
    case("3 6\n41 Ana\n42 Ben\n43 Cleo\n1 41\n1 42\n1 43\n2 43\n2 41\n3 42\n", solve_15d, "generated"),  # streak shrink to 0
    case("2 5\n51 Mira\n52 Noor\n1 52\n1 51\n1 52\n2 51\n2 52\n", solve_15d, "generated"),  # tie day2 -> lowest id 51
]
# verify streak-to-zero behavior: day3 only 42 submitted, streak {41,43}&{42} = 0
got = d15_hidden[2]["expected"]
assert got == "2016-03-01 3 41 Ana\n2016-03-02 2 41 Ana\n2016-03-03 0 42 Ben", got

# ---------------- statements ----------------

WS5_STATEMENT = """*(Adapted from the SQL challenge: same task, expressed over standard input.)*

You are given the list of *CITY* names from the **STATION** table. Find the two cities with the **shortest** and **longest** city names, as well as their respective lengths (i.e. number of characters in the name, spaces included).

If there is more than one smallest or largest city, choose the one that comes first when ordered alphabetically.

### Input Format

The first line contains an integer N, the number of cities. Each of the next N lines contains one city name. Names may contain spaces, but have no leading or trailing spaces.

### Constraints

1 <= N <= 10000
Each city name is 1 to 50 characters: uppercase/lowercase letters and spaces only.

### Output Format

Two lines:
- Line 1: the city with the shortest name, a single space, then the length of its name.
- Line 2: the city with the longest name, a single space, then the length of its name.

(If N = 1, the same city appears on both lines.)

### Sample Input 0

```
7
Amo
Delhi
Marine On Saint Croix
Pune
Goa
Kochi
Chennai
```

### Sample Output 0

```
Amo 3
Marine On Saint Croix 21
```

### Explanation 0

The shortest name is "Amo" (3 characters; "Goa" also has 3 but "Amo" comes first alphabetically). The longest is "Marine On Saint Croix" (21 characters, spaces included)."""

OCC_STATEMENT = """*(Adapted from the SQL challenge: same task, expressed over standard input.)*

[Pivot](https://en.wikipedia.org/wiki/Pivot_table) the *Occupation* column of the **OCCUPATIONS** table so that each *Name* is sorted alphabetically and displayed underneath its corresponding *Occupation*. The output should consist of four columns — **Doctor**, **Professor**, **Singer**, and **Actor** — in that specific order, with names listed alphabetically (top to bottom) under each column.

**Note:** Print **NULL** when there are no more names corresponding to an occupation.

### Input Format

The first line contains an integer N, the number of rows in OCCUPATIONS. Each of the next N lines contains a name and an occupation separated by a single space. *Occupation* is always one of: Doctor, Professor, Singer or Actor.

### Constraints

1 <= N <= 1000
Names contain only letters (no spaces) and are unique.

### Output Format

Print the pivot table row by row. Each row contains exactly four values (Doctor column, Professor column, Singer column, Actor column) separated by single spaces, with **NULL** filling columns that have run out of names. Do not print trailing spaces. The number of rows equals the size of the largest occupation group.

### Sample Input 0

```
10
Samantha Doctor
Julia Actor
Maria Actor
Meera Singer
Ashley Professor
Ketty Professor
Christeen Professor
Jane Actor
Jenny Singer
Priya Singer
```

### Sample Output 0

```
Samantha Ashley Jenny Jane
NULL Christeen Meera Julia
NULL Ketty Priya Maria
```

### Explanation 0

The only Doctor is Samantha. The Professors, alphabetically, are Ashley, Christeen, Ketty. The Singers are Jenny, Meera, Priya. The Actors are Jane, Julia, Maria. Columns shorter than the longest (3 rows) are padded with NULL."""

D15_STATEMENT = """*(Adapted from the SQL challenge: same task, expressed over standard input.)*

Julia conducted a 15 days of learning SQL contest. The start date of the contest was March 01, 2016 and the end date was March 15, 2016 (day 1 through day 15).

For each day of the contest, print:

1. the total number of unique hackers who made at least 1 submission **each day** (starting on the first day of the contest, up to and including that day), and
2. the *hacker_id* and *name* of the hacker who made the **maximum** number of submissions **on that day**. If more than one hacker has the maximum number of submissions on a day, print the one with the **lowest** *hacker_id*.

Print this information for each day of the contest, sorted by the date.

### Input Format

The first line contains two integers H and S: the number of hackers and the number of submissions. Each of the next H lines contains an integer *hacker_id* and a string *name*. Each of the next S lines describes one submission: an integer *day* (1 to 15, meaning 2016-03-01 to 2016-03-15) and the *hacker_id* of the submitter.

### Constraints

1 <= H <= 1000
1 <= S <= 50000
Hacker ids are unique positive integers; names contain only letters.
Every day from 1 to 15 that appears in the output is guaranteed to have at least one submission; days are not guaranteed to appear in sorted order in the input.

### Output Format

For each day (in date order) that has at least one submission, print one line with four values separated by single spaces: the date in `2016-03-DD` format, the count of hackers who submitted every day so far, and the *hacker_id* and *name* of that day's top submitter.

### Sample Input 0

```
4 13
11 Rose
12 Angela
13 Frank
14 Patrick
1 11
1 12
1 13
1 14
2 11
2 12
2 12
3 11
3 13
3 13
4 11
4 11
4 14
```

### Sample Output 0

```
2016-03-01 4 11 Rose
2016-03-02 2 12 Angela
2016-03-03 1 13 Frank
2016-03-04 1 11 Rose
```

### Explanation 0

On day 1 all four hackers submitted (count 4); all made 1 submission, so the lowest id (11, Rose) is the top submitter. On day 2 only hackers 11 and 12 kept their every-day streak (count 2); Angela made 2 submissions, the most. On day 3 only hacker 11 has submitted every day (count 1); Frank made 2 submissions. On day 4 the streak count is still 1; Rose made 2 submissions, the most that day."""

# ---------------- stubs ----------------

def stubs_for(read_hint_py, read_hint_js):
    return {
        "python": f"""#!/bin/python3

import sys

def main():
    data = sys.stdin.read().split("\\n")
    # {read_hint_py}
    # Write your code here

if __name__ == '__main__':
    main()
""",
        "cpp": f"""#include <bits/stdc++.h>

using namespace std;

int main() {{
    // Read from cin, write the answer to cout.
    // {read_hint_py}
    // Write your code here

    return 0;
}}
""",
        "java": f"""import java.io.*;
import java.util.*;

public class Main {{
    public static void main(String[] args) throws IOException {{
        BufferedReader br = new BufferedReader(new InputStreamReader(System.in));
        // {read_hint_py}
        // Write your code here

    }}
}}
""",
        "javascript": f"""'use strict';

process.stdin.resume();
process.stdin.setEncoding('utf-8');

let inputString = '';
process.stdin.on('data', (d) => inputString += d);
process.stdin.on('end', () => {{
    const lines = inputString.split('\\n');
    // {read_hint_js}
    // Write your code here

}});
""",
    }

problems = [
    {
        "hr_slug": "weather-observation-station-5",
        "id": "weather-observation-station-5",
        "title": "Weather Observation Station 5",
        "order": 9,
        "points": 10,
        "scoring": "per_test",
        "statement_md": WS5_STATEMENT,
        "sample_tests": [ws5_sample],
        "hidden_tests": ws5_hidden,
        "stubs": stubs_for("Line 1: N. Next N lines: one city name each (may contain spaces).",
                            "lines[0] = N; lines[1..N] = city names (may contain spaces)."),
        "tests_provenance": "generated (original is a SQL challenge; DB data not exportable)",
    },
    {
        "hr_slug": "occupations",
        "id": "occupations",
        "title": "Occupations",
        "order": 10,
        "points": 10,
        "scoring": "per_test",
        "statement_md": OCC_STATEMENT,
        "sample_tests": [occ_sample],
        "hidden_tests": occ_hidden,
        "stubs": stubs_for("Line 1: N. Next N lines: 'Name Occupation'.",
                            "lines[0] = N; lines[1..N] = 'Name Occupation'."),
        "tests_provenance": "generated + 1 copied-derived (official expected output rebuilt as a hidden case)",
    },
    {
        "hr_slug": "15-days-of-learning-sql",
        "id": "15-days-of-learning-sql",
        "title": "15 Days of Learning SQL",
        "order": 11,
        "points": 10,
        "scoring": "per_test",
        "statement_md": D15_STATEMENT,
        "sample_tests": [d15_sample],
        "hidden_tests": d15_hidden,
        "stubs": stubs_for("Line 1: H S. Next H lines: 'hacker_id name'. Next S lines: 'day hacker_id'.",
                            "lines[0] = 'H S'; then H hacker lines; then S submission lines."),
        "tests_provenance": "generated (original is a SQL challenge; DB data not exportable)",
    },
]

json.dump(problems, open(f"{BASE}/extraction-sql-adapted.json", "w"), indent=2)
for p in problems:
    print(f"{p['id']}: samples={len(p['sample_tests'])} hidden={len(p['hidden_tests'])} stmt={len(p['statement_md'])} chars")
print("wrote extraction-sql-adapted.json")
