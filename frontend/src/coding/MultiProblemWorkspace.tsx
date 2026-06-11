// frontend/src/coding/MultiProblemWorkspace.tsx
//
// S-I §4: the multi-problem candidate workspace container (C6 rework).
// Owns: the ordered problem switcher (sidebar ≥2 problems; single-problem and
// legacy contests render EXACTLY the old single-pane layout — no sidebar, no
// header), the per-problem state map (language/code/run/submit/judgeError/
// cooldowns — a response lands in the ORIGINATING problem's slot even after a
// switch), per-problem localStorage drafts (proctor-draft::{session}::{problem},
// ~2s debounce), per-problem editor-event batchers with problem_switched
// markers (§3.5), per-problem SERVER-driven cooldown/budget rendering (§4.3)
// and the workspace header (current problem + solved x/y + score total).
// The S1 ExamTopBar is deliberately NOT touched (spec §0).
import { useEffect, useMemo, useRef, useState } from "react";
import { execRun, execSubmit, sendEditorEvents } from "../api";
import { ProblemBatchers } from "./editorEvents";
import { JUDGE_UNREACHABLE_MESSAGE } from "./judgeAttempt";
import {
  MAX_DRAFT_CODE_CHARS,
  chipFor,
  cooldownSecondsRemaining,
  draftKey,
  execRetryAfterSeconds,
  mergeSubmitOutcome,
  restoreDraft,
  serializeDraft,
  showProblemSidebar,
  workspaceTotals
} from "./problemSwitch";
import { ProblemPane, nextCodeOnLanguageSwitch, starterFor } from "./CodingWorkspace";
import type { EditorEvent, ProblemSubmissionSummary, PublicProblem, RunResult, SubmitResult } from "../types";

type Language = "python" | "cpp" | "java" | "javascript";

type PaneState = {
  language: Language;
  code: string;
  run: RunResult | null;
  submit: SubmitResult | null;
  judgeError: string;
  /** Server-driven cooldown deadlines (epoch ms), per button — §4.3. */
  cooldownUntil: { run: number | null; submit: number | null };
};

type BusyState = { problemId: string; kind: "run" | "submit" } | null;

const CHIP_CLASSES: Record<string, string> = {
  none: "text-muted",
  partial: "text-amber-600",
  solved: "text-green-700",
  zero: "text-red-400"
};

function initialPane(sessionId: string, problem: PublicProblem): PaneState {
  // §4.2 restore guards: bad language / oversize / corrupt JSON → starter.
  let draft = null;
  try {
    draft = restoreDraft(window.localStorage.getItem(draftKey(sessionId, problem.id)), problem.languages);
  } catch {
    draft = null;
  }
  const language = (draft?.language as Language) ?? problem.languages[0];
  return {
    language,
    // F12.2: a saved draft still wins (resume precedence); else the problem's
    // per-language stub, falling back to the generic STARTERS scaffold.
    code: draft?.code ?? starterFor(problem, language),
    run: null,
    submit: null,
    judgeError: "",
    cooldownUntil: { run: null, submit: null }
  };
}

export function MultiProblemWorkspace({ sessionId, problems, submissionsSummary, submitBudget }: {
  sessionId: string;
  /** ORDERED contest problems (server order; ≥1). */
  problems: PublicProblem[];
  /** start/resume submissions_summary — restores chips/attempts/total. */
  submissionsSummary?: Record<string, ProblemSubmissionSummary>;
  /** Server's stored-submission budget per (session, problem); null = unknown
   * (older backend) → no attempts meter, no client-side cap. */
  submitBudget: number | null;
}) {
  const [activeId, setActiveId] = useState(problems[0].id);
  const [panes, setPanes] = useState<Record<string, PaneState>>(() => {
    const map: Record<string, PaneState> = {};
    for (const problem of problems) map[problem.id] = initialPane(sessionId, problem);
    return map;
  });
  const [summaries, setSummaries] = useState<Record<string, ProblemSubmissionSummary>>(() => ({ ...(submissionsSummary ?? {}) }));
  const [busy, setBusy] = useState<BusyState>(null);
  // Cooldown countdown clock — ticks only while some cooldown is in the future.
  const [nowMs, setNowMs] = useState(() => Date.now());

  const activeProblem = problems.find((p) => p.id === activeId) ?? problems[0];
  const activeIndex = problems.findIndex((p) => p.id === activeProblem.id);
  const pane = panes[activeProblem.id] ?? initialPane(sessionId, activeProblem);

  // §3.5: one batcher per problem; flush outgoing on switch; problem_switched
  // rides the incoming batch; dispose flushes everything on unmount.
  const batchers = useMemo(() => new ProblemBatchers({
    maxSize: 40, maxMs: 4000,
    onFlush: (problemId: string, events: EditorEvent[]) => { void sendEditorEvents(sessionId, problemId, events); }
  }), [sessionId]);
  useEffect(() => () => batchers.dispose(), [batchers]);

  // §4.2: debounce-written localStorage drafts, per problem.
  const draftTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const panesRef = useRef(panes);
  panesRef.current = panes;
  const writeDraft = (problemId: string) => {
    const state = panesRef.current[problemId];
    if (!state || state.code.length > MAX_DRAFT_CODE_CHARS) return;
    try {
      window.localStorage.setItem(draftKey(sessionId, problemId), serializeDraft({ language: state.language, code: state.code }, new Date().toISOString()));
    } catch {
      // storage full/blocked — drafts are best-effort
    }
  };
  const scheduleDraft = (problemId: string) => {
    const timers = draftTimers.current;
    const existing = timers.get(problemId);
    if (existing) clearTimeout(existing);
    timers.set(problemId, setTimeout(() => { timers.delete(problemId); writeDraft(problemId); }, 2000));
  };
  useEffect(() => () => {
    // Unmount: flush pending draft writes immediately (nothing lost).
    for (const [problemId, timer] of draftTimers.current) { clearTimeout(timer); writeDraft(problemId); }
    draftTimers.current.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tick the cooldown clock while any deadline is in the future.
  const anyCooldownActive = Object.values(panes).some((p) =>
    (p.cooldownUntil.run ?? 0) > nowMs || (p.cooldownUntil.submit ?? 0) > nowMs);
  useEffect(() => {
    if (!anyCooldownActive) return;
    const timer = setInterval(() => setNowMs(Date.now()), 500);
    return () => clearInterval(timer);
  }, [anyCooldownActive]);

  const updatePane = (problemId: string, patch: Partial<PaneState>) => {
    setPanes((prev) => ({ ...prev, [problemId]: { ...(prev[problemId] ?? initialPane(sessionId, problems.find((p) => p.id === problemId) ?? activeProblem)), ...patch } }));
  };

  const switchTo = (problemId: string) => {
    if (problemId === activeId) return;
    batchers.switchTo(activeId, problemId, new Date().toISOString());
    setActiveId(problemId);
  };

  const onLanguageChange = (problemId: string, next: Language) => {
    const state = panesRef.current[problemId];
    if (!state) return;
    // Only-replace-if-untouched starter rule, per problem. F12.2: the pure
    // transition resolves BOTH the "is it untouched?" check and the replacement
    // through starterFor, so a problem's per-language stub (or the generic
    // fallback) is honored consistently — the two sides can never disagree
    // about what "the starter" is for a language.
    const problem = problems.find((p) => p.id === problemId) ?? activeProblem;
    const replacement = nextCodeOnLanguageSwitch(problem, state.code, state.language, next);
    updatePane(problemId, { language: next, ...(replacement !== null ? { code: replacement } : {}) });
    scheduleDraft(problemId);
  };

  const onCodeChange = (problemId: string, code: string) => {
    updatePane(problemId, { code });
    scheduleDraft(problemId);
  };

  // §4.3: failures map to — rate_limited: per-problem button countdown from
  // the SERVER's retry_after_seconds (no client-side double accounting);
  // everything else: today's inline judgeError treatment, scoped per problem.
  const handleExecError = (problemId: string, kind: "run" | "submit", cause: unknown) => {
    const retryAfter = execRetryAfterSeconds(cause);
    const code = (cause as { code?: string } | null)?.code;
    if (retryAfter !== null && code === "rate_limited") {
      const until = Date.now() + retryAfter * 1000;
      setPanes((prev) => {
        const state = prev[problemId];
        if (!state) return prev;
        return { ...prev, [problemId]: { ...state, judgeError: "", cooldownUntil: { ...state.cooldownUntil, [kind]: until } } };
      });
      setNowMs(Date.now());
      return;
    }
    updatePane(problemId, { judgeError: JUDGE_UNREACHABLE_MESSAGE });
  };

  const doRun = async (problemId: string) => {
    if (busy) return;
    const state = panesRef.current[problemId];
    if (!state) return;
    batchers.add(problemId, { type: "code_run", timestamp: new Date().toISOString(), detail: { language: state.language } });
    batchers.flush(problemId);
    setBusy({ problemId, kind: "run" });
    updatePane(problemId, { judgeError: "" });
    try {
      const result = await execRun({ session_id: sessionId, problem_id: problemId, language: state.language, source_code: state.code });
      updatePane(problemId, { run: result });
    } catch (cause) {
      handleExecError(problemId, "run", cause);
    } finally {
      setBusy(null);
    }
  };

  const doSubmit = async (problemId: string) => {
    if (busy) return;
    const state = panesRef.current[problemId];
    if (!state) return;
    batchers.add(problemId, { type: "code_submit", timestamp: new Date().toISOString(), detail: { language: state.language } });
    batchers.flush(problemId);
    setBusy({ problemId, kind: "submit" });
    updatePane(problemId, { judgeError: "" });
    try {
      const result: SubmitResult = await execSubmit({ session_id: sessionId, problem_id: problemId, language: state.language, source_code: state.code });
      updatePane(problemId, { submit: result });
      // A successful submit updates that problem's chip + the total immediately.
      setSummaries((prev) => ({ ...prev, [problemId]: mergeSubmitOutcome(prev[problemId], result, new Date().toISOString()) }));
    } catch (cause) {
      handleExecError(problemId, "submit", cause);
    } finally {
      setBusy(null);
    }
  };

  const sidebar = showProblemSidebar(problems.length);
  const totals = workspaceTotals(problems, summaries);
  const busyElsewhere = busy && busy.problemId !== activeProblem.id;
  const busyIndex = busy ? problems.findIndex((p) => p.id === busy.problemId) : -1;
  const busyNote = busyElsewhere
    ? `${busy!.kind === "run" ? "Running" : "Submitting"} Q${busyIndex + 1}… buttons re-enable when it finishes.`
    : "";

  const paneView = (
    <ProblemPane
      key={activeProblem.id}
      problem={activeProblem}
      language={pane.language}
      code={pane.code}
      run={pane.run}
      submit={pane.submit}
      judgeError={pane.judgeError}
      busyKind={busy && busy.problemId === activeProblem.id ? busy.kind : ""}
      anyBusy={busy !== null}
      busyNote={busyNote}
      runCooldownSeconds={cooldownSecondsRemaining(pane.cooldownUntil.run, nowMs)}
      submitCooldownSeconds={cooldownSecondsRemaining(pane.cooldownUntil.submit, nowMs)}
      attempts={summaries[activeProblem.id]?.attempts ?? 0}
      submitBudget={submitBudget}
      onLanguageChange={(language) => onLanguageChange(activeProblem.id, language)}
      onCodeChange={(code) => onCodeChange(activeProblem.id, code)}
      onEvent={(event) => batchers.add(activeProblem.id, event)}
      onRun={() => void doRun(activeProblem.id)}
      onSubmit={() => void doSubmit(activeProblem.id)}
    />
  );

  // §3 pin: single-problem contests + the legacy deployment render EXACTLY the
  // pre-S-I layout — no sidebar, no workspace header.
  if (!sidebar) return paneView;

  return (
    <div className="space-y-4">
      {/* Workspace header: current problem indicator + overall progress.
          (The S1 ExamTopBar stays frozen — spec §0.) */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-panel px-4 py-3">
        <div className="text-sm font-semibold text-ink">
          Q{activeIndex + 1} · {activeProblem.title}
        </div>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-muted">Solved {totals.solved}/{totals.count}</span>
          <span className="font-semibold text-ink">Total: {totals.earned} / {totals.possible}</span>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
        {/* The switcher: ordered list with per-problem status chips. Free
            switching at any time, including while a request is in flight. */}
        <nav aria-label="Problems" className="flex gap-2 overflow-x-auto lg:flex-col lg:overflow-visible">
          {problems.map((problem, index) => {
            const chip = chipFor(summaries[problem.id]);
            const active = problem.id === activeProblem.id;
            return (
              <button
                key={problem.id}
                onClick={() => switchTo(problem.id)}
                aria-current={active ? "true" : undefined}
                className={`focus-ring flex min-w-44 items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm lg:min-w-0 ${
                  active ? "border-accent bg-accent/10 font-semibold text-ink" : "border-line bg-panel text-ink hover:bg-white"
                }`}
              >
                <span className="truncate">
                  Q{index + 1} · {problem.title}
                  <span className="ml-1 whitespace-nowrap text-xs text-muted">{problem.points} pts</span>
                </span>
                <span className={`whitespace-nowrap font-mono text-xs ${CHIP_CLASSES[chip.state]}`}>{chip.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="min-w-0">{paneView}</div>
      </div>
    </div>
  );
}
