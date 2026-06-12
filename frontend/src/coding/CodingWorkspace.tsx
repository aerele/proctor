// frontend/src/coding/CodingWorkspace.tsx
//
// S-I §4: the former single-problem CodingWorkspace body, now the
// PRESENTATIONAL ProblemPane — statement + Monaco + Run/Submit for ONE
// problem. All exec calls, per-problem state, cooldowns and drafts live in
// MultiProblemWorkspace (the container) so a response always lands in the
// originating problem's state slot even when the candidate switched away.
import { lazy, Suspense } from "react";
import { presentSubmitResult, type SubmitTone } from "./submitVerdict";
import { StatementView } from "../problems/StatementView";
import type { EditorEvent, RunResult, StatementFormat, SubmitResult } from "../types";

const MonacoEditor = lazy(() => import("./MonacoEditor").then((m) => ({ default: m.MonacoEditor })));

// Banner styling per submit tone. "neutral" (verdict "error": judging infra
// failed) deliberately avoids the red failure styling — it is not a wrong answer.
const SUBMIT_TONE_CLASSES: Record<SubmitTone, string> = {
  success: "border-green-300 bg-green-50",
  failure: "border-red-300 bg-red-50",
  neutral: "border-line bg-panel text-muted"
};

// Generic read-stdin/print-stdout scaffolds — the FALLBACK when a problem ships
// no per-language stub. F12.2 layers problem-specific stubs on top (see
// starterFor); these stay the floor every problem inherits.
export const STARTERS: Record<string, string> = {
  python: "# Read from standard input, print the answer to standard output.\n",
  cpp: "#include <bits/stdc++.h>\nusing namespace std;\nint main() {\n    // Read from stdin, print the answer to stdout.\n    return 0;\n}\n",
  java: "import java.util.*;\npublic class Main {\n    public static void main(String[] args) {\n        // Read from System.in, print the answer to System.out.\n    }\n}\n",
  javascript: "// Read from stdin, print the answer to stdout.\nconst input = require(\"fs\").readFileSync(0, \"utf8\");\n",
  // SQL problems run against a pre-seeded SQLite database (no stdin) — the
  // candidate submits just the query.
  sql: "-- Write your SQL query below.\n"
};

export type StarterLanguage = "python"|"cpp"|"java"|"javascript"|"sql";

export type PaneProblem = {
  id: string; title: string; statement: string;
  /** W6: statement render format — absent (older payloads) = plain. */
  statement_format?: StatementFormat;
  languages: readonly StarterLanguage[];
  sampleTests?: readonly { input: string; expected: string }[];
  /** F12.2: optional per-language starter stubs (author-supplied). */
  stubs?: Partial<Record<StarterLanguage, string>>;
};

// F12.2: THE single source of truth for a candidate editor's initial code in a
// given language. A problem-specific stub wins; otherwise fall back to the
// generic STARTERS scaffold. ONE resolver used by BOTH the initial-code pick
// and the untouched-swap-on-language-change check, so "is it untouched?" and
// "what do we replace it with?" can never drift apart.
export function starterFor(
  problem: { stubs?: Partial<Record<StarterLanguage, string>> } | null | undefined,
  language: StarterLanguage
): string {
  const stub = problem?.stubs?.[language];
  return typeof stub === "string" ? stub : STARTERS[language];
}

// F12.2: the pure language-switch transition. The candidate's code is replaced
// with the next language's starter ONLY when it is still the previous
// language's untouched starter (so we never clobber real work). Both sides use
// starterFor, so a problem's per-language stub is honored on each end. Returns
// `null` when the code must be preserved (no replacement).
export function nextCodeOnLanguageSwitch(
  problem: { stubs?: Partial<Record<StarterLanguage, string>> } | null | undefined,
  code: string,
  prev: StarterLanguage,
  next: StarterLanguage
): string | null {
  const untouched = code === starterFor(problem, prev);
  return untouched ? starterFor(problem, next) : null;
}

export function ProblemPane({
  problem, language, code, run, submit, judgeError,
  busyKind, anyBusy, busyNote,
  runCooldownSeconds, submitCooldownSeconds,
  attempts, submitBudget,
  stubReloadAvailable, undoSeconds,
  onLanguageChange, onCodeChange, onEvent, onRun, onSubmit, onReloadStub, onUndoStubReload
}: {
  problem: PaneProblem;
  language: "python"|"cpp"|"java"|"javascript"|"sql";
  code: string;
  run: RunResult | null;
  submit: SubmitResult | null;
  judgeError: string;
  /** Exec in flight FOR THIS problem ("" when idle or busy elsewhere). */
  busyKind: "" | "run" | "submit";
  /** ANY exec in flight for this session — every exec button disables
   * (mirrors the server's one-in-flight-per-session guard honestly). */
  anyBusy: boolean;
  /** "Running Q2…" note when the in-flight exec belongs to ANOTHER problem. */
  busyNote: string;
  /** Server-driven cooldown countdowns (0 = none) — spec §4.3. */
  runCooldownSeconds: number;
  submitCooldownSeconds: number;
  attempts: number;
  submitBudget: number | null;
  /** W9: this problem ships an author stub for the current language. */
  stubReloadAvailable: boolean;
  /** W9: seconds left on the post-reload Undo window (0 = no affordance). */
  undoSeconds: number;
  onLanguageChange: (language: "python"|"cpp"|"java"|"javascript"|"sql") => void;
  onCodeChange: (code: string) => void;
  onEvent: (e: EditorEvent) => void;
  onRun: () => void;
  onSubmit: () => void;
  /** W9: container owns confirm + snapshot + replace (pane stays presentational). */
  onReloadStub: () => void;
  onUndoStubReload: () => void;
}) {
  const atCap = submitBudget !== null && attempts >= submitBudget;
  const runLabel = busyKind === "run" ? "Running…" : runCooldownSeconds > 0 ? `Run (${runCooldownSeconds}s)` : "Run";
  const submitLabel = busyKind === "submit" ? "Submitting…" : submitCooldownSeconds > 0 ? `Submit (${submitCooldownSeconds}s)` : "Submit";

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <section className="rounded-lg border border-line bg-panel p-5">
        <h2 className="text-lg font-semibold">{problem.title}</h2>
        {/* W6: the shared statement renderer — plain problems keep the exact
            pre-W6 <p> path; markdown problems opt into react-markdown. */}
        <StatementView statement={problem.statement} format={problem.statement_format} className="mt-2" />
        {problem.sampleTests?.length ? (
          <div className="mt-4 space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted">Sample tests</div>
            {problem.sampleTests.map((t, i) => (
              <div key={i} className="rounded-md border border-line bg-white p-2 text-xs">
                <div className="font-medium text-muted">Input</div>
                <pre className="whitespace-pre-wrap font-mono">{t.input}</pre>
                <div className="mt-1 font-medium text-muted">Expected output</div>
                <pre className="whitespace-pre-wrap font-mono">{t.expected}</pre>
              </div>
            ))}
          </div>
        ) : null}
      </section>
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <select value={language} onChange={(e) => onLanguageChange(e.target.value as "python"|"cpp"|"java"|"javascript"|"sql")}
                  className="rounded-md border border-line px-2 py-1 text-sm">
            {problem.languages.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
          <button onClick={onRun} disabled={anyBusy || runCooldownSeconds > 0} className="rounded-md border border-line px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50">{runLabel}</button>
          <button onClick={onSubmit} disabled={anyBusy || submitCooldownSeconds > 0 || atCap} className="rounded-md bg-ink px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50">{submitLabel}</button>
          {/* §4.3 attempts meter: live count vs the server's stored-submission budget. */}
          {submitBudget !== null && attempts > 0 ? (
            <span className="text-xs text-muted">Attempt {attempts} / {submitBudget}</span>
          ) : null}
          {busyNote ? <span className="text-xs text-muted">{busyNote}</span> : null}
          {/* W9: "Reload stub" sits at the right edge of the toolbar — present
              only when the problem ships a stub for this language. The Undo
              countdown appears beside it right after a reload, exactly where
              the candidate just clicked. */}
          {stubReloadAvailable ? (
            <span className="ml-auto flex items-center gap-2">
              {undoSeconds > 0 ? (
                <button onClick={onUndoStubReload}
                        className="rounded-md border border-amber-400 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700">
                  Undo ({undoSeconds}s)
                </button>
              ) : null}
              <button onClick={onReloadStub} title="Replace your code with this problem's latest starter stub"
                      className="rounded-md border border-line px-2 py-1 text-xs text-muted hover:text-ink">
                Reload stub
              </button>
            </span>
          ) : null}
        </div>
        {/* UX-H2: the submit verdict renders directly under the Run/Submit row
            (not at the end of the column) so the floating camera dock can never
            cover it and the candidate sees it next to the button they pressed. */}
        {submit && (() => {
          const presentation = presentSubmitResult(submit);
          return (
            <div className={`rounded-md border p-3 text-sm ${SUBMIT_TONE_CLASSES[presentation.tone]}`}>
              {presentation.message}
            </div>
          );
        })()}
        {atCap ? (
          <div className="rounded-md border border-line bg-panel p-3 text-sm text-muted">
            Submission limit reached for this problem — your best score so far is kept.
          </div>
        ) : null}
        {judgeError && (
          <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700">
            {judgeError}
          </div>
        )}
        <Suspense fallback={<div className="text-sm text-muted">Loading editor…</div>}>
          <MonacoEditor language={language} value={code} onChange={onCodeChange} onEvent={onEvent} />
        </Suspense>
        {run && (
          <div className="rounded-md border border-line bg-panel p-3 text-sm">
            <div className="font-medium">Sample results</div>
            {run.results.map((r, i) => (
              <div key={i} className={r.passed ? "text-green-700" : "text-red-700"}>
                Test {i+1}: {r.passed ? "passed" : "failed"} — got <span className="font-mono">{r.stdout.trim() || "(none)"}</span>{r.compileOutput ? ` · ${r.compileOutput}` : ""}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
