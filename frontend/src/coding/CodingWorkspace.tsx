// frontend/src/coding/CodingWorkspace.tsx
import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { execRun, execSubmit, sendEditorEvents } from "../api";
import { EventBatcher } from "./editorEvents";
import { runJudgeAttempt } from "./judgeAttempt";
import { presentSubmitResult, type SubmitTone } from "./submitVerdict";
import type { EditorEvent, RunResult, SubmitResult } from "../types";

const MonacoEditor = lazy(() => import("./MonacoEditor").then((m) => ({ default: m.MonacoEditor })));

// Banner styling per submit tone. "neutral" (verdict "error": judging infra
// failed) deliberately avoids the red failure styling — it is not a wrong answer.
const SUBMIT_TONE_CLASSES: Record<SubmitTone, string> = {
  success: "border-green-300 bg-green-50",
  failure: "border-red-300 bg-red-50",
  neutral: "border-line bg-panel text-muted"
};

// Generic read-stdin/print-stdout scaffolds. Problem-specific starter code is
// deliberately NOT a thing yet (see the S4 spec, OUT of scope).
const STARTERS: Record<string, string> = {
  python: "# Read from standard input, print the answer to standard output.\n",
  cpp: "#include <bits/stdc++.h>\nusing namespace std;\nint main() {\n    // Read from stdin, print the answer to stdout.\n    return 0;\n}\n",
  java: "import java.util.*;\npublic class Main {\n    public static void main(String[] args) {\n        // Read from System.in, print the answer to System.out.\n    }\n}\n",
  javascript: "// Read from stdin, print the answer to stdout.\nconst input = require(\"fs\").readFileSync(0, \"utf8\");\n"
};

export function CodingWorkspace({ sessionId, problem }: {
  sessionId: string;
  problem: {
    id: string; title: string; statement: string;
    languages: readonly ("python"|"cpp"|"java"|"javascript")[];
    sampleTests?: readonly { input: string; expected: string }[];
  };
}) {
  const [language, setLanguage] = useState(problem.languages[0]);
  const [code, setCode] = useState(STARTERS[language]);
  const [run, setRun] = useState<RunResult | null>(null);
  const [submit, setSubmit] = useState<SubmitResult | null>(null);
  const [busy, setBusy] = useState<"" | "run" | "submit">("");
  // M9: a failed Run/Submit must surface an inline error, cleared on next attempt.
  const [judgeError, setJudgeError] = useState("");

  const batcher = useMemo(() => new EventBatcher({
    maxSize: 40, maxMs: 4000,
    onFlush: (events: EditorEvent[]) => { void sendEditorEvents(sessionId, problem.id, events); }
  }), [sessionId, problem.id]);
  const lastCode = useRef(code);

  const onEvent = (e: EditorEvent) => batcher.add(e);

  const doRun = async () => {
    setBusy("run"); setJudgeError(""); onEvent({ type: "code_run", timestamp: new Date().toISOString(), detail: { language } }); batcher.flush();
    try {
      const outcome = await runJudgeAttempt(() => execRun({ session_id: sessionId, problem_id: problem.id, language, source_code: code }));
      if (outcome.ok) setRun(outcome.value);
      else setJudgeError(outcome.error);
    } finally { setBusy(""); }
  };
  const doSubmit = async () => {
    setBusy("submit"); setJudgeError(""); onEvent({ type: "code_submit", timestamp: new Date().toISOString(), detail: { language } }); batcher.flush();
    try {
      const outcome = await runJudgeAttempt(() => execSubmit({ session_id: sessionId, problem_id: problem.id, language, source_code: code }));
      if (outcome.ok) setSubmit(outcome.value);
      else setJudgeError(outcome.error);
    } finally { setBusy(""); }
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <section className="rounded-lg border border-line bg-panel p-5">
        <h2 className="text-lg font-semibold">{problem.title}</h2>
        <p className="mt-2 whitespace-pre-wrap text-sm text-muted">{problem.statement}</p>
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
        <div className="flex items-center gap-3">
          <select value={language} onChange={(e) => { const l = e.target.value as typeof language; setLanguage(l); if (lastCode.current === STARTERS[language]) { setCode(STARTERS[l]); lastCode.current = STARTERS[l]; } }}
                  className="rounded-md border border-line px-2 py-1 text-sm">
            {problem.languages.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
          <button onClick={doRun} disabled={!!busy} className="rounded-md border border-line px-3 py-1.5 text-sm">{busy==="run"?"Running…":"Run"}</button>
          <button onClick={doSubmit} disabled={!!busy} className="rounded-md bg-ink px-3 py-1.5 text-sm text-white">{busy==="submit"?"Submitting…":"Submit"}</button>
        </div>
        {judgeError && (
          <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700">
            {judgeError}
          </div>
        )}
        <Suspense fallback={<div className="text-sm text-muted">Loading editor…</div>}>
          <MonacoEditor language={language} value={code} onChange={(v) => { setCode(v); lastCode.current = v; }} onEvent={onEvent} />
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
        {submit && (() => {
          const presentation = presentSubmitResult(submit);
          return (
            <div className={`rounded-md border p-3 text-sm ${SUBMIT_TONE_CLASSES[presentation.tone]}`}>
              {presentation.message}
            </div>
          );
        })()}
      </section>
    </div>
  );
}
