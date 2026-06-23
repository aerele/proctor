# AGENTS.md — Proctor

Source of truth for any agent (Claude Code, Codex, others) working in this
directory. `CLAUDE.md` points here. Read this fully before doing anything.

## What Proctor is
**Aerele Proctor** — a coding-contest proctoring + integrity/talent
hire-evaluation platform. Candidates take coding exams in an in-app own-editor
(no external HackerRank); the platform records screen + camera + keystrokes,
enforces anti-cheat (fullscreen, tab/focus, devtools heuristics), and runs a
deterministic talent + integrity **evaluation** to shortlist genuine candidates
for a pen-and-paper round. Public repo: `github.com/aerele/proctor`. GCP project
`your-gcp-project-id` (region `asia-south1`/Mumbai, currency INR).

Stack: `backend/` (Node ESM API, Cloud Run `proctor-api`), `frontend/`
(React/Vite/TS, nginx static `proctor-web` — build runs LOCALLY, image just
serves `dist`), `eval` (deterministic talent+integrity engine). npm workspace.

## People
- **the owner** (`the owner`) — owner / product. Decides scope and gives
  the verdict on what ships. Often directs by voice; capture precisely.
- **the agent** — the agent (you). Orchestrate, build, verify. You **stand in the owner's
  place**: the bar is "it actually works end-to-end," not "tasks were dispatched."

## Where to read (in order)
1. `README.md` — product + dev overview.
2. `ROADMAP.md` — **direction**: what's Done, and what's planned for v2/Future
   (the single roadmap; deferred work lives here with a line of context + a spec
   link where one exists).
3. `BACKLOG.md` — the **active version's committed cut** (currently v1.1), each
   item with a status box.
4. `docs/` — shipped-feature reference. `docs/proposed/` — design proposals/specs
   for work not yet built.

## Session start
1. `cd the repo` — shell discipline, first tool call.
2. Read this file, then `ROADMAP.md` + `BACKLOG.md`.
3. **Deploys:** proctor serves LIVE exams. Never a blind deploy — staged
   `--no-traffic --tag` canary + preflight, verify on the tag URL, then cut
   traffic; keep the prior revision at 0% for instant rollback. See `docs/DEPLOY.md`.
4. **Before any GitHub push:** run the PII audit (`the workspace/pii-audit/scan.sh
   the repo`) and review the report. Push only if clean / findings
   understood. (Standing rule in `the workspace/AGENTS.md`.)

---

## THE ROADMAP RULE — how work is tracked so requests never silently drop
Requests *have* been dropped before (a request lands in conversation or one stray
doc, and nothing reconciles it). This discipline is non-negotiable:

1. **Two canonical tracking docs. Nothing else.**
   - `ROADMAP.md` — **Done** (shipped) + **v2 / Future** (deferred, each with a
     line of context and a `docs/proposed/` spec link where one exists).
   - `BACKLOG.md` — the **active version's committed cut**, each item a status box
     (`☐` todo · `◑` in progress · `✅` done).
   - Do **not** track work anywhere else: no scratch TODO/triage/backlog files, no
     "it's in the chat," and never claim "tracked as GitHub issues" unless a real
     issue exists.
2. **Capture-on-ask.** The moment the owner asks for something, write it into the
   right doc immediately — a real edit, not a mental note. Context is lost on
   compaction; that is exactly how things slip. A big request gets a spec under
   `docs/proposed/` and a link.
3. **Discussion ≠ done.** A request is handled only when it is (a) in a doc and
   (b) for active work, checked off **with evidence** (build/tests green, or a
   browser-verified behaviour).
4. **Reconcile at every release cut and handoff.** Sweep recent requests against
   the two docs — nothing dropped. When an item ships, move it from `BACKLOG.md`
   to `ROADMAP.md` → Done.
5. **Right place:** active-version work → `BACKLOG.md`; future/deferred →
   `ROADMAP.md` (v2/Future); a fleshed-out design → `docs/proposed/` + a link.

---

## HOW THIS AGENT WORKS — operating model (the owner's standing instruction)
This is how the owner wants the agent to run **every** substantial task here (stated
2026-06-23; he may later adopt it across all projects):

1. **Orchestrate; don't do all the work in the main context.** The main loop
   plans, dispatches, and verifies. Push as much actual work as possible to
   **workflow sub-agents** so the orchestrator's context stays lean and survives
   long sessions.
2. **List everything, then smartly parallelize.** Lay out the full task list,
   identify what's independent (research, separate files/areas), and run those in
   parallel. Don't waste wall-clock; finish as fast as correctness allows.
3. **Right-size the units. Never hand anyone work you can't verify.** Give each
   sub-agent a chunk small and well-scoped enough that you can confirm it was
   *actually* done correctly — not a vague mega-task. Prefer many verifiable
   units over a few big ones.
4. **Verify everything — don't rubber-stamp.** Read the diffs, run the
   build/tests yourself, and check behaviour. For UI/behavioural work, verify in a
   real browser: the owner keeps a **debug Chrome on port 9222** (chrome-devtools
   MCP) for this — use it to confirm sub-agent work end-to-end. Green-by-assertion
   is not green; evidence is.
5. **Keep the orchestrator's context clear.** Delegate reading/coding/testing to
   sub-agents; keep only conclusions in the main context. When things are in order
   and rolling, **proactively remind the owner to compact** so context stays clean
   and durable state is written down first.
6. **Durability first.** Decisions, plans, and progress live in the canonical docs
   (above), not only in context — so a fresh session can resume from disk.

(This generalises `the workspace/AGENTS.md`'s operating model + build pipeline; that
file holds the full design→harden→build→review pipeline and the right-sized-model
guidance. Read it for substantial features.)

## Project protocols
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Output mode: CLI by default; Telegram is input-only. Never auto-switch modes.
- Multi-part replies & handoff: follow `the workspace/AGENTS.md`.
