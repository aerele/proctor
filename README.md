<div align="center">

# Aerele Proctor

### Run a coding exam you can actually trust — and find the people worth hiring.

**An integrity-first coding-assessment platform for hiring and campus drives.**
Candidates code inside your own editor while you watch live; afterwards you get a
ranked board, evidence-backed integrity flags, and a defensible hire
recommendation per candidate — remote take-home *or* on-site.

</div>

---

## The problem

A coding test gives you a leaderboard. A leaderboard lies in both directions.

- **Cheaters float to the top.** Pasted editorial solutions, a second device, a
  friend on a call, an LLM in another tab — the score looks great, the candidate
  can't reproduce a line of it in the room.
- **Real talent gets buried.** The careful problem-solver who wrote clean,
  original code under pressure ranks *below* the copier and never gets the call.

So the score you trust most is often the one you should trust least — and the
hire you'd actually want walks away. You need to know two things a raw board can't
tell you: **is the work their own, and who is genuinely good?**

## What Aerele Proctor does

Aerele Proctor turns a coding round into **defensible evidence and a recommendation
you can stand behind in a review** — not just a number.

- **Candidates stay in your editor.** Registration, identity confirmation, the
  full coding workspace, and Run/Submit all happen inside one app you host. No tab
  to a third-party site, no leaving your environment.
- **You watch the whole room from one console.** Live status, screen and camera
  streams, integrity signals, and remote actions — all in a single admin view,
  for one candidate or a thousand.
- **It catches cheating with evidence, not theatre.** Fullscreen enforcement, the
  recorded screen, tab/recording/IP signals, and a deterministic post-exam analysis
  that clusters copied code, spots editorial pastes, and flags the "solved a hard
  problem on the first try" pattern.
- **It surfaces the talent a leaderboard hides.** A calibrated engine scores
  *genuine problem-solving* on its own axis — so the honest, capable candidate
  rises whether or not they topped the raw board.
- **It ends with a recommendation you can defend.** Each candidate gets a hire
  recommendation backed by a FOR / AGAINST argument and the underlying evidence —
  something a reviewer can interrogate, not a black-box verdict.

## The honest promise — evidence, never an automatic verdict

Aerele Proctor is built on one principle: **it gives you evidence to review, never
a sentence to execute.** Integrity and talent are scored on **separate axes that
are never averaged** — a flagged score is never silently "corrected," and a clean
candidate is never quietly demoted. Calibration is deliberately conservative: an
honest candidate is **~never excluded**, only conclusive copying excludes, and a
single shared problem is a desk-check note, not a disqualification. Treat every
flag as triage for a human — a supervised pen-and-paper round or a reviewer is the
ground truth, and the platform is designed to make *that* round sharper, not to
replace it.

It is also **honest about what a browser can do.** This is real, browser-based
proctoring — evidence collection and human review, not lockdown spyware. It will
not enumerate your other tabs, read your OS clipboard, or police a second monitor;
no web app can. What it does do — hold fullscreen, record the entire screen, watch
the live feed, track the signals that matter, and turn all of it into a reviewable
case — is enough to run a coding round you can trust and defend.

## Who it's for

- **Engineering hiring teams** running take-home or on-site coding rounds who need
  a shortlist they can defend — not a leaderboard they have to second-guess.
- **Campus & placement drives** assessing hundreds of students at once, where the
  goal is to find the genuine problem-solvers and reconcile against a pen-and-paper
  round.
- **Anyone who wants to own their assessment stack** — self-hosted on your own
  Google Cloud, your data, your editor, no per-seat SaaS bill.

Use it **remote** (candidates self-serve with an access code from anywhere) or
**on-site** (a tokenized per-room invigilator portal for floor staff) — the same
platform, the same evidence, either way.

## See it in 60 seconds — no backend, no cloud

The fastest way to understand the product is to run the UI. Demo mode runs the
entire experience on a local fake — real screen capture, everything else simulated.

```bash
npm install
VITE_DEMO_MODE=true VITE_ADMIN_PASSWORD=dev npm run dev
# candidate:    http://localhost:5173/        (take the exam)
# admin:        http://localhost:5173/admin    (watch + review — unlock with: dev)
# invigilator:  http://localhost:5173/invigilator
```

Open it in a Chromium-based browser (Chrome / Edge). The full local-dev guide,
including running against a real backend, is in [`LOCAL_DEV.md`](LOCAL_DEV.md).

When you're ready to run it for real, the from-scratch Google Cloud deploy is in
[`docs/DEPLOY.md`](docs/DEPLOY.md).

## A look at the product

> Every screenshot uses fabricated personas — this public repository contains **no
> real candidate data**.

| Watch the room live | Ranked results with integrity |
|---|---|
| ![Admin live stats](docs/assets/harness/admin-review/01-live-stats.png) | ![Ranked results with integrity](docs/assets/harness/admin-review/07-results-ranked-table.png) |

| Review the recording | The hire recommendation |
|---|---|
| ![Recording review dashboard](docs/assets/harness/admin-review/03-review-dashboard.png) | ![Evaluation recommendation report](docs/assets/harness/evaluation/01-recommendation-report.png) |

## Where to go next

- **Run it locally** → [`LOCAL_DEV.md`](LOCAL_DEV.md)
- **Deploy it for real** → [`docs/DEPLOY.md`](docs/DEPLOY.md)
- **Run an exam day** → [`docs/EXAM-DAY-OPS.md`](docs/EXAM-DAY-OPS.md) (operators) ·
  [`docs/CONDUCTOR-GUIDE.md`](docs/CONDUCTOR-GUIDE.md) (on-site room staff)
- **Understand how it all works** → [`docs/`](docs/README.md) — the full,
  code-verified documentation set (architecture, every feature, the integrity +
  talent engine, the API, and the threat-model research behind the design)
- **Contribute** → [`CONTRIBUTING.md`](CONTRIBUTING.md) ·
  **Report a vulnerability** → [`SECURITY.md`](SECURITY.md)

## How it's built (the short version)

Three surfaces — candidate, admin, invigilator — in one self-hosted React app,
backed by a Node service on Google Cloud Run with Firestore + Cloud Storage, real
code execution via Judge0, and a separate evaluation service for the integrity +
talent engine. The full picture is in
[`docs/features/architecture-overview.md`](docs/features/architecture-overview.md).

## License

Released under the [MIT License](LICENSE). Copyright (c) 2026 Aerele.
