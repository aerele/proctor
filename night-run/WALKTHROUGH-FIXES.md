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
| M0 | admin | E2E #8 — admin datetime picker resists keyboard/programmatic entry (calendar popover works). Make it keyboard-friendly. (Section-C minor, Karthi-approved TG 1843.) | fixed (agent B) — DateTimeField: text input (typed/ISO/day-first paste) + calendar button; awaiting frontend commit | — |
| W1 | candidate | Coding must be THE central thing: problems list front-and-center → click → coding screen. All proctoring chrome (recording status, rules, etc.) collapsible / out of the way. Once the contest starts: zero distractions, only essentials around the editor. (TG 1851) | dispatched (agent A) | — |
| W2 | candidate | FLIP the proctoring visual cue: normal operation = subtle indicator (still distinctive enough to recognize from afar); on a real issue = the BIG bar appears with the actual issue. Not the other way around. (TG 1851) | dispatched (agent A) | — |
| W3 | admin | Contest filter currently sits BELOW the screen-select buttons (Live stats / Contest / Live alerts…). It's common to all screens → must sit ABOVE them (e.g. top-right). Also: two rows of buttons is too many — rethink and reorganize the admin page header/nav properly. (TG 1851) | fixed (agent B) — 6 grouped section tabs (Live/Contest/Evidence/Authoring/People/Settings) + contest picker top-right; awaiting frontend commit | — |
| W4 | admin | Test code: alongside Regenerate, add **Set custom test code**. Server-enforced uniqueness among ACTIVE contests — checked when setting the code, when activating a contest (block activation with a clear error until the code is changed), and on create. (TG 1851) | backend COMMITTED b43fd5a (712/712); frontend UI awaiting commit with agent A's batch | b43fd5a |

| W5 | candidate | Fullscreen out/in + alert behavior is buggy: when an alert shows / doesn't show / what happens after, there's a looping problem and unexpected behavior here and there. Review the whole fullscreen-alert state machine fully and fix. (TG 1853) | dispatched (agent A, bundled W1+W2+W5) | — |

**2026-06-11 ~22:25 — Karthi asleep (TG 1855). Overnight order: finish these → deploy → exhaustive browser E2E of deployed product via :9222 (candidate flow above all, keystroke data verified) → fix/redeploy/retest until clean → triple review + morning summary → stretch: OMR (F2). First agent attempts died on API 529-Overloaded (tree verified clean); both relaunched.**

_(W6 … appended live as Karthi comments arrive.)_
