# Live flow-walkthrough → fixes ledger

**Mode (active 2026-06-11):** Karthi walks through each flow himself (admin / candidate / invigilator /
review) and fires comments. For each: I (1) log it here with an id `W#`, (2) dispatch an Opus subagent to
fix it, (3) verify (backend `cd backend && npm test`; frontend `cd frontend && npx vitest run && npm run build`
as relevant), (4) commit locally. He keeps them coming — handle each promptly; batch only when truly independent.

**Priority:** the **2026-06-12 live test must run flawlessly** — as smooth as HackerRank for students, no
glitches in workflow or code, and clean **keystroke/event data** captured for analysis. Nothing from
`PRODUCT-BACKLOG.md` is in scope unless it blocks this.

**Commit discipline:** commits serialize through the coordinator — **no concurrent `git commit`** while the
docs workflow (`wf_145b15ad-957`) is still committing. Subagents edit + verify; the coordinator owns the commit
(or tells the agent to commit only when the repo is free). **Never push.**

## Ledger
| id | flow | comment | status | commit |
|----|------|---------|--------|--------|
| M0 | admin | E2E #8 — admin datetime picker resists keyboard/programmatic entry (calendar popover works). Make it keyboard-friendly. (Section-C minor, Karthi-approved TG 1843.) | queued | — |

_(W1, W2 … appended live as Karthi comments arrive.)_
