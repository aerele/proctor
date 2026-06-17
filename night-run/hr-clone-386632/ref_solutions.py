#!/usr/bin/env python3
"""Reference solutions for the 9 aerele challenges; validates official testcases."""
import json, os, heapq

BASE = os.path.dirname(os.path.abspath(__file__))

def ch1(lines):  # min coins 25/10/5/1
    n = int(lines[0])
    c = 0
    for d in (25, 10, 5, 1):
        c += n // d
        n %= d
    return [str(c)]

def ch2(lines):  # tower of boxes
    n = int(lines[0]); ws = list(map(int, lines[1].split()))
    count = 0; top = None
    for w in ws:
        if top is None or w <= top:
            count += 1; top = w
    return [str(count)]

def ch3(lines):  # lucky tickets
    m = int(lines[0]); c = 0
    for t in lines[1:1+m]:
        t = t.strip()
        if sum(map(int, t[:3])) == sum(map(int, t[3:])):
            c += 1
    return [str(c)]

def ch4(lines):  # tanker refills
    n, cap = map(int, lines[0].split()); a = list(map(int, lines[1].split()))
    cur = cap; refills = 0
    for need in a:
        if cur < need:
            refills += 1; cur = cap
        cur -= need
    return [str(refills)]

def ch5(lines):  # josephus
    n, k = map(int, lines[0].split())
    f = 0
    for i in range(2, n + 1):
        f = (f + k) % i
    return [str(f + 1)]

def ch6(lines):  # max profit one transaction
    n = int(lines[0]); p = list(map(int, lines[1].split()))
    best = 0; lo = p[0]
    for x in p[1:]:
        best = max(best, x - lo); lo = min(lo, x)
    return [str(best)]

def ch7(lines):  # equal partition
    n = int(lines[0]); w = list(map(int, lines[1].split()))
    s = sum(w)
    if s % 2:
        return ["NO"]
    bits = 1
    for x in w:
        bits |= bits << x
    return ["YES" if (bits >> (s // 2)) & 1 else "NO"]

def ch8(lines):  # painted cells union
    l, q = map(int, lines[0].split())
    diff = [0] * (l + 2)
    for i in range(1, q + 1):
        a, b = map(int, lines[i].split())
        diff[a] += 1; diff[b + 1] -= 1
    cur = 0; painted = 0
    for i in range(1, l + 1):
        cur += diff[i]
        if cur > 0:
            painted += 1
    return [str(painted)]

def ch9(lines):  # min rooms with cooldown
    n, g = map(int, lines[0].split())
    ms = sorted(tuple(map(int, lines[1 + i].split())) for i in range(n))
    heap = []  # earliest reusable time per room
    for s, e in ms:
        if heap and heap[0] <= s:
            heapq.heappop(heap)
        heapq.heappush(heap, e + g)
    return [str(len(heap))]

SOLVERS = {f"challenge-{i}-aerele": f for i, f in
           [(1, ch1), (2, ch2), (3, ch3), (4, ch4), (5, ch5), (6, ch6), (7, ch7), (8, ch8), (9, ch9)]}

if __name__ == "__main__":
    extr = json.load(open(f"{BASE}/extraction-aerele.json"))
    all_ok = True
    for e in extr:
        solver = SOLVERS[e["hr_slug"]]
        for kind in ("sample_tests", "hidden_tests"):
            for c in e[kind]:
                lines = c["input"].split("\n")
                got = "\n".join(solver(lines)).strip()
                want = c["expected"].strip()
                ok = got == want
                all_ok &= ok
                print(f"{e['hr_slug']} {kind[:6]} hr#{c['hr_index']}: {'OK' if ok else f'MISMATCH got={got!r} want={want!r}'}")
    print("ALL OK" if all_ok else "FAILURES PRESENT")
