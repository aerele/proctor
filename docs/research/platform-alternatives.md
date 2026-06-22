# Embeddable + scalable coding-contest platforms (research, 2026-06-04)

Question: is there a HackerRank alternative that (a) reliably runs ~500 concurrent students AND (b) can be
**embedded** in our proctoring app (so we host the exam in an iframe and get full fullscreen/lockdown control)?

## Empirical header check (same test that killed HackerRank)

`curl -sSI` against each SaaS app URL. **Almost every SaaS coding platform blocks cross-origin iframing**, exactly like HackerRank:

| Platform | Header result | Iframe-able by our app? |
|---|---|---|
| HackerRank | `x-frame-options: SAMEORIGIN` | No (original blocker) |
| HackerEarth | `XFO: SAMEORIGIN` + `frame-ancestors 'self'` | No |
| Codility | `XFO: SAMEORIGIN` | No |
| CodinGame | `XFO: SAMEORIGIN` + `frame-ancestors 'self'` | No |
| iMocha | `XFO: SAMEORIGIN` + `frame-ancestors 'self'` | No |
| CoderPad | `XFO: SAMEORIGIN` + `frame-ancestors 'self'` | No |
| Codeforces | `XFO: sameorigin` | No |
| SPOJ / Codewars | `XFO: SAMEORIGIN` | No |
| CodeSignal | `frame-ancestors 'self' <fixed partner allowlist>` | No — partner-gated (Crossover, proctoring.online, Greenhouse, Lever, Canvas) |
| TestGorilla | `frame-ancestors 'self' *.testgorilla.com …` | No |
| **Judge0** (`ide.judge0.com`, `ce.judge0.com`) | **NO X-Frame-Options, NO restrictive frame-ancestors, `access-control-allow-origin: *`** | **Yes** |

**So "switch to another SaaS exam app and iframe its app URL" does NOT work** — they near-universally set SAMEORIGIN.
The only clean routes: (i) self-host open-source on our own origin, or (ii) use a vendor that ships a real **embed SDK/widget** (a component to drop in our page, not an app to iframe).

## (i) Self-hosted / open-source — we own the origin → iframing + lockdown trivial

- **Judge0 ★** — open-source (GPLv3) execution+judging engine + an **official embeddable IDE** (iframe to `ide.judge0.com` driven by `postMessage`; verified: no XFO, ACAO `*`). 40+ languages, sandboxed (isolate). Horizontally scalable worker pool → add workers for 500 concurrent. **It's an engine, not a turnkey contest UI** — we build contest/auth/leaderboard (but we'd rebuild eval anyway, and we get a clean submission API to poll). Free + infra. https://github.com/judge0/judge0 · https://github.com/judge0/ide/tree/master/embed
- **DOMjudge ★** — open-source self-hosted **turnkey ICPC contest system** (Symfony). It IS our app on our origin → iframe trivially. Proven at **1000+ teams**; ~1 judgehost/20 teams → ~6–8 for 500. ICPC-style grading (accept/reject), more manual authoring, no commercial problem bank. Free + infra. https://www.domjudge.org · https://github.com/DOMjudge/domjudge/wiki/Scaling-and-load-testing
- **CMS (IOI)** — heaviest; IOI-grade subtasks/partial scoring; more ops than DOMjudge. https://cms.readthedocs.io

## (ii) SaaS with an OFFICIAL embed SDK (drop a component into our page)

- **Sphere Engine** — official **Problems Widget** (a JS web component, not an iframe-app); security is the *inverse* of HackerRank: **we whitelist our domains + sign with a shared secret** → embedding in our app is the intended use. Mature judge (SPOJ/ideone origin), problem authoring, "infinite scaling" tier, on-prem option. Custom quote. https://docs.sphere-engine.com/problems/widget/quickstart · https://docs.sphere-engine.com/problems/widget/security
- **Qualified.io** — documented **Embed SDK** (`QualifiedEmbeddedChallenge` + full embedded assessments mount in our page, save/restore code, read-only mode). Project-based challenges, TDD autograding. The `frame-ancestors *.webflow.com` we saw was only their marketing site. Custom quote; confirm 500-concurrent + one-off-contest licensing. https://docs.qualified.io/integrations/custom-integrations/embed/ · https://www.qualified.io/embed/api-docs/
- **HackerEarth** — app is SAMEORIGIN (no app embed) but exposes a **Code Evaluation API** (managed Judge0-equivalent) if we want a managed backend without self-hosting. https://www.hackerearth.com/recruit/api

## Ranked shortlist (embeddable + scalable 500)

1. **Judge0 self-hosted + our own contest UI** — only option that is fully embeddable (verified), fully controlled, and free. Best for max lockdown control given we're rebuilding eval anyway.
2. **DOMjudge self-hosted** — ready-made contest system, proven at scale, iframe-able (our origin). Tradeoff: ICPC grading, manual authoring.
3. **Sphere Engine / Qualified.io** — if we'd rather not run judge infra: real embed components designed to live in our page. Pick these over "iframe a SaaS app," which doesn't work.

## Bottom line

There are only two clean routes to a fully-controllable **embedded** exam: **self-host open-source on our
origin (Judge0 best, or DOMjudge for turnkey)**, or **use an embed-SDK vendor (Sphere Engine / Qualified)**.
Self-hosting Judge0/DOMjudge is the most robust + cheapest for owning fullscreen/lockdown — at the cost of
**running judge infrastructure on contest day** and losing HackerRank's problem bank + our existing
HackerRank-polling eval pipeline. The embed-SDK vendors are the fastest path if we'd rather not run infra
(cost + dependency instead).
