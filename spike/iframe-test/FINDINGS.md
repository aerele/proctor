# Iframe lockdown spike — findings (2026-06-04)

Test page: `spike/iframe-test/index.html`, served locally at **http://localhost:5180/**.
Contest tested: `https://www.hackerrank.com/coding-contest-mcet-june-2026-slot-2`.

## Q1 — Can the HackerRank contest be embedded in an iframe? → **NO.**

Two independent blockers, either of which alone kills it:

1. **`X-Frame-Options: SAMEORIGIN`** — confirmed on the real 200 response via header inspection
   (`curl` with a normal browser UA). This header tells the browser to render the page in a frame
   **only** if the parent is also `hackerrank.com`. Our proctor app is a different origin, so a real
   browser **refuses to render** the contest in our iframe ("refused to connect").
2. **Akamai bot/WAF** — when the headless test browser loaded the contest in the frame, HackerRank's
   edge returned an **"Access Denied"** page (`errors.edgesuite.net`) instead of the contest. So even
   setting framing aside, HackerRank actively blocks automated/embedded access.

> Headless caveat: the automated browser hit blocker #2 (Akamai) before #1 (XFO) could even apply, so
> the headless screenshot shows "Access Denied", not the XFO "refused to connect". In a **real logged-in
> Chrome** you'll see the XFO refusal instead. Either way: **not embeddable.**

> ✅ **CONFIRMED in a real logged-in Chrome (Karthi, 2026-06-04):** the frame rendered blank with a
> **"refused to connect"** error — the X-Frame-Options block, exactly as the header predicted. All three
> signals agree (header `XFO:SAMEORIGIN` · headless Akamai "Access Denied" · real-browser XFO refusal).
> The verdict is final: **not embeddable.**

**Implication:** the original premise — "put the contest in an iframe so we control its page lifecycle"
— is not achievable. We cannot host HackerRank inside our page.

## Q2 — Is fullscreen-exit detection reliable? → **YES (for the tab running the code).**

`fullscreenchange` + `document.fullscreenElement` fire on every fullscreen exit (Esc, F11, OS gesture).
The spike demonstrates the full UX: exit → configurable countdown warning → type-to-continue on 1st
violation → hard lock (needs unlock code) on 2nd. This is reliable.

## Q3 — Is tab-away / window-away detection reliable? → **YES (for the tab running the code).**

- `visibilitychange` → `document.visibilityState === 'hidden'`: fires on tab switch and window minimize.
- `window` `blur`/`focus`: fires on alt-tab to another app/window.
Both are reliable and demonstrated with live counters in the spike.

## The catch that decides the architecture

Q2/Q3 detection only sees **the tab that runs our code**. Because the contest **cannot** be embedded
(Q1), the contest must live in a **separate tab/window** — which our web page **cannot observe or
control**. A plain web page can only lock *itself*, not the HackerRank tab. So "force fullscreen + lock
when they leave the contest" is **not deliverable as a plain web app.**

### Options to actually get lockdown control

| Option | Control level | Student friction | Notes |
|---|---|---|---|
| **A. Browser extension (MV3)** ✅ recommended | **Strong** — see active tab, detect tab switches/new tabs across the whole browser, force/monitor fullscreen, inject a content script into the HackerRank tab to watch visibility/blur/copy-paste *on the contest itself*, verify they're on the right contest URL, optionally block other tabs | Must install our extension (Chrome/Edge); unpacked or via Web Store | This is how real lockdown proctoring works. The Q2/Q3 primitives become browser-wide instead of one-tab. |
| **B. Popup-window monitoring** | **Weak** — detect popup closed, refocus it, keep proctor page fullscreen | Low | Cannot read the cross-origin popup, cannot detect tab-away inside it or other tabs; popups easily blocked/closed. Easily defeated. |
| **C. Web-only, evidence-first (today's model)** | **None (lockdown)** — just screen recording + our-page signals | Low | This is essentially the current app: record the screen, flag when *our* tab is hidden. No real lock. |
| **D. Reverse-proxy the contest through our origin** (a.k.a. proxy mode) | Would give same-origin DOM/screenshot/inject — but… | — | The only way to make a foreign site embeddable+inspectable. For HackerRank it breaks on **OAuth login**, **Akamai WAF/IP-rep**, **WebSocket IDE**, hostname checks, and is **ToS-risky/fragile**. **Not viable for a live contest.** See `REFERENCE-velbridge-proxy-notes.md`. |

**Recommendation:** a **browser extension (Option A)** is the only web-deliverable path that provides the
control described in Epic 1. The spike proves the *detection primitives* (fullscreen-exit, tab-away) are
reliable; an extension is what makes them apply to the whole browser and the contest tab rather than only
our own page.

**Important:** browser-based proctoring is defense-in-depth, never absolute (second device, disabled JS,
etc.) — consistent with the repo README's own framing ("evidence collection for review, not automatic
disqualification"). An extension raises the bar a lot; it doesn't make cheating impossible.

### What is NOT blocked by this finding

Most of the roadmap is independent of the iframe/lockdown question and can be built regardless:
sessions + single-session-per-username (Epic 2 / 0.3), student UX (Epic 3), admin live alerts + room
numbers (Epic 4), live submission evaluation (Epic 5), websockets + inbound alerts API (Epic 6). Only the
**Epic 1 lockdown mechanism** depends on the A/B/C decision above.

## Decision needed before the lockdown build

Pick the lockdown direction: **A (extension)** for real control, or **C (web-only evidence)** to keep
zero-install and lean on recording + live eval for deterrence. (B is not worth building.)
