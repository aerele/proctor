# Aerele Proctor — Feature Roadmap (captured, not yet designed)

Status: **requirements capture only.** This is the organized version of Karthi's feature dump.
Nothing here is committed to a design or build order yet — see "Open decisions" per epic.
Convention: each item notes **current state in the code** where relevant so we don't re-build what exists.

Last updated from voice notes on 2026-06-04.

---

## Epic 0 — Cleanups to the current flow

| # | Want | Current state in code | Note |
|---|------|----------------------|------|
| 0.1 | **Remove the entry passcode and the exit passcode** (the two codes a student types) | `proctor_passcode` gates *start* (`frontend/src/App.tsx:474`, checked `api.ts:57`); `end_code` gates *end* (`App.tsx:608`, checked `api.ts:214/238`). Both are admin-set in settings. | **DECIDED (2026-06-04):** delete both — they were publicly announced and entered wrong anyway, so they added nothing. **No replacement gate.** Instead enforce **single-session-per-username** (see 0.3). |
| 0.3 | **Single active session per HackerRank username** (replaces the passcodes) | Not present. | **DECIDED.** Two sessions with the same HackerRank username must not run concurrently. A new login for an already-active username prompts *"log out the old one?"* → requires **our admin approval** (works because we hold the persistent session — Epic 2). Different browser / genuine case → approve from the admin panel **or** issue a one-time generated code. |
| 0.2 | **Test link as an admin setting** (paste & store, not hardcoded) | **Already done.** `contest_url` is an admin field (`App.tsx:750`), stored via backend (`handler.mjs:319–330`), shown to the student as a link once recording starts (`App.tsx:521–524`). Not hardcoded. | The real ask is to **embed** this URL in an iframe rather than link out — that's Epic 1, not a config change. |

**Open decision (0.1):** with both routine passcodes gone, what gates start and end? Options: (a) nothing — admin opens a time window + student just enters details; (b) the new session/approval model handles it; (c) keep only an unlock code for locked tests. Probably (a)+(c).

---

## Epic 1 — Lockdown test experience inside an iframe  ⚠️ FEASIBILITY SPIKE FIRST

> Karthi: *"I want to go for a test. Just don't go and build it. Maybe you can build a test page for me separately just to see the feasibility."*
> **Build a throwaway test page only. Do not build the production feature until the spike answers the feasibility question.**

| # | Want |
|---|------|
| 1.1 | Embed the **whole HackerRank contest in an iframe** on a standalone test page; probe what's possible vs. blocked. |
| 1.2 | Force the page **fullscreen**; on exit-fullscreen, show a warning overlay with a **configurable countdown** (e.g. 5–8s) before the test locks. |
| 1.3 | **Escalation policy:** 1st violation → warning + student must type `"I will not exit full screen"` to continue; 2nd violation → **locked out**, must call us for a passcode/unlock. |
| 1.4 | Keep the **screen recording** (current feature): recording starts, then the student enters the locked test flow. |

**🚩 Critical unknown the spike must answer first:** major sites (HackerRank almost certainly included) send `X-Frame-Options: DENY` or a CSP `frame-ancestors` that **forbids being iframed at all**. If so, embedding the live contest is impossible and the whole "control the page lifecycle via iframe" premise needs a different approach (e.g. a separate popup window we monitor, or a browser extension). The spike's #1 job: load the real contest URL in an iframe and see whether it renders or is refused. Everything else in Epic 1 depends on that answer.

**Also probe in the spike:** fullscreen API behaviour + re-prompt rules, whether we can detect focus/visibility loss on a cross-origin iframe, and what events we can/can't see across the origin boundary.

---

## Epic 2 — Sessions & resilience (no more "reload loses everything")

| # | Want | Current state |
|---|------|---------------|
| 2.1 | **Persistent session** that survives reload; ends when invalid or when the test ends. Reloading returns the student to their test. | Today reload is *blocked* with a warning (`App.tsx:204`) and there's no resume — details are re-entered. Opposite of desired. |
| 2.2 | Once details are entered, **don't keep asking** for them (tie to the session). | Details re-entered each load. |
| 2.3 | **Resume approval:** restarting a session needs permission; admin can approve **in bulk or one-by-one** (e.g. for an internet outage, unlock everyone or individually instead of handing out codes). UI states: "wait for unlock" / "ask for the code" when disconnected. | Not present. |
| 2.4 | **Identity confirmation:** show the student's **username + name prominently** so they confirm it's them, then continue. | Name is collected but not shown back prominently. |

**Open decision (2.x):** how much *test state* to preserve vs. just the session/auth. Karthi: session preservation is the floor; actual test-state restoration is "discuss later."

---

## Epic 3 — Student UX / guided flow

> Karthi (follow-up): the login/onboarding UX must be **really well done** — at every step the student clearly knows *what's happening, what to do now, and what's next*, so they can self-serve without asking staff.

| # | Want |
|---|------|
| 3.1 | Clear, linear, instructional flow: each screen states current status + next action. |
| 3.2 | Self-service: minimize the need for students to ask proctors questions. |
| 3.3 | Applies across the whole journey: details → permissions/recording → entering the test → during → ending. |

(Cross-cutting; informs the UI of Epics 1, 2, 4.)

---

## Epic 4 — Admin live monitoring & alerts  *(Karthi's "heading 1", more depth later)*

| # | Want |
|---|------|
| 4.1 | **Real-time alerts** (usable from a mobile phone) instead of record-and-forget. Triggers include: student moving away from the tab, student getting locked, disconnects, … (full event taxonomy TBD). |
| 4.2 | **Room assignment:** ask the student for a **room name/number** on the initial screen (or assign one). Alerts carry **room # + name** so staff can physically go to the room and call the student by name. |
| 4.3 | **Remote actions:** approve / disapprove / continue / bypass / lock from admin — per-candidate or in bulk — for genuine issues and contingencies. |
| 4.4 | **Live stats dashboard:** live counts of currently-live / locked / finished / yet-to-start, updating in real time. |
| 4.5 | Define the **event → action matrix:** which events merely notify vs. which warrant physically going to the room. |

---

## Epic 5 — Live submission evaluation & anti-cheat during the test  *(Karthi's "heading 2", more depth later)*

| # | Want |
|---|------|
| 5.1 | **Evaluate submissions as they arrive**, not post-contest. An external poller (Karthi's laptop) polls HackerRank for new submissions, downloads them, and evaluates immediately against the existing contest-eval criteria. *(Karthi will point to the files that show how to poll + evaluate — see `contest-eval/` methodology.)* |
| 5.2 | **Pre-download known/online "readymade" solutions** per question; compare each submission: **exact match → "surely copied" alert**; **high match → investigate**. |
| 5.3 | **Early-window enforcement:** catch copying in the first ~10–30 min, go to the room, do an on-the-spot inquiry (who copied from whom), enforce (one stays / the other leaves) → **deterrence**. |
| 5.4 | **Admin lock control** per candidate from the panel. |

---

## Epic 6 — Platform & integration architecture  *(cross-cutting; discuss before building)*

| # | Want |
|---|------|
| 6.1 | **WebSockets** for live events/stats on **both** the student client and the admin panel. |
| 6.2 | **Inbound alerts API + API keys:** the admin panel exposes an authenticated API and can **generate an API key** that Karthi stores in his laptop's Claude Code. The external evaluator **pushes alert payloads** (a user's evaluation-so-far, who-copied-whom, full details) into the panel for action. |
| 6.3 | **Proctoring-side alerts = deterministic rule-based code** (most/all of them), not ML. |
| 6.4 | *(Implication, flagged by us)* This turns the app from today's mostly-stateless Cloud Run + GCS + Firestore-settings design into a **stateful, real-time system** (sessions, live events, locks, stats, websocket server, inbound alert ingestion). That's a significant backend expansion to plan deliberately. |

---

## Architecture: how the external evaluation loop fits

```
Karthi's laptop                          Proctor backend (this app)          Admin (phone/laptop)
┌─────────────────────────┐              ┌──────────────────────────┐        ┌───────────────────┐
│ Claude Code             │  poll        │                          │  WS    │ Live stats        │
│  + browser MCP ─────────┼──HackerRank  │  /api/alerts (API key) ◀─┼────────┤ Live alerts       │
│  download submission    │              │  sessions / locks / stats│        │ Remote approve/   │
│  evaluate (contest-eval)│  push alerts │  websocket hub           │───WS──▶│   lock / bypass   │
│  if match ──────────────┼─────────────▶│                          │        └───────────────────┘
└─────────────────────────┘   HTTPS+key  └──────────────────────────┘
```

---

## Cross-epic open decisions (for our discussion, not now)

1. **Iframe feasibility** (Epic 1) — the gating unknown. Spike answers it before any of Epic 1's UX is designed.
2. **Passcode model** (0.1 vs 1.3/2.3/4.3) — remove routine codes, but keep a single "unlock" path for locked/contingency cases. Confirm the exact gates for start/end.
3. **Backend platform** (Epic 6.4) — keep Cloud Run + add a websocket service + persistent session store, or move to something that holds long-lived connections more naturally. Decide before Epics 2/4/5 backends.
4. **State vs session preservation** (2.x) — how much test state to restore on resume.
5. **Event taxonomy** (4.1/4.5) — enumerate proctoring events and map each to notify-only vs go-to-room.

## Suggested first step (proposal)

Start with the **Epic 1 iframe feasibility spike** as a standalone throwaway page — it's the highest-uncertainty, highest-leverage unknown, and its result reshapes Epics 1–3. Everything else (passcode removal, sessions, alerts, live eval) is buildable regardless, so it can be sequenced after we know the iframe answer.
