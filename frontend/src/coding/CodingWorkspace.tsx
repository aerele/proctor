// frontend/src/coding/CodingWorkspace.tsx
import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { execRun, execSubmit, sendEditorEvents } from "../api";
import { EventBatcher } from "./editorEvents";
import type { EditorEvent, RunResult, SubmitResult } from "../types";

const MonacoEditor = lazy(() => import("./MonacoEditor").then((m) => ({ default: m.MonacoEditor })));

const STARTERS: Record<string, string> = {
  python: "a, b = map(int, input().split())\nprint(a + b)\n",
  cpp: "#include <bits/stdc++.h>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a+b;}\n",
  java: "import java.util.*;\npublic class Main{public static void main(String[] a){Scanner s=new Scanner(System.in);System.out.print(s.nextLong()+s.nextLong());}}\n",
  javascript: "const [a,b]=require('fs').readFileSync(0,'utf8').trim().split(' ').map(Number);console.log(a+b);\n"
};

export function CodingWorkspace({ sessionId, problem }: {
  sessionId: string;
  problem: { id: string; title: string; statement: string; languages: readonly ("python"|"cpp"|"java"|"javascript")[] };
}) {
  const [language, setLanguage] = useState(problem.languages[0]);
  const [code, setCode] = useState(STARTERS[language]);
  const [run, setRun] = useState<RunResult | null>(null);
  const [submit, setSubmit] = useState<SubmitResult | null>(null);
  const [busy, setBusy] = useState<"" | "run" | "submit">("");

  const batcher = useMemo(() => new EventBatcher({
    maxSize: 40, maxMs: 4000,
    onFlush: (events: EditorEvent[]) => { void sendEditorEvents(sessionId, problem.id, events); }
  }), [sessionId, problem.id]);
  const lastCode = useRef(code);

  const onEvent = (e: EditorEvent) => batcher.add(e);

  const doRun = async () => {
    setBusy("run"); onEvent({ type: "code_run", timestamp: new Date().toISOString(), detail: { language } }); batcher.flush();
    try { setRun(await execRun({ session_id: sessionId, problem_id: problem.id, language, source_code: code })); }
    finally { setBusy(""); }
  };
  const doSubmit = async () => {
    setBusy("submit"); onEvent({ type: "code_submit", timestamp: new Date().toISOString(), detail: { language } }); batcher.flush();
    try { setSubmit(await execSubmit({ session_id: sessionId, problem_id: problem.id, language, source_code: code })); }
    finally { setBusy(""); }
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <section className="rounded-lg border border-line bg-panel p-5">
        <h2 className="text-lg font-semibold">{problem.title}</h2>
        <p className="mt-2 whitespace-pre-wrap text-sm text-muted">{problem.statement}</p>
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
        {submit && (
          <div className={`rounded-md border p-3 text-sm ${submit.verdict==="accepted" ? "border-green-300 bg-green-50" : "border-red-300 bg-red-50"}`}>
            Verdict: <span className="font-semibold">{submit.verdict}</span> — {submit.passed_count}/{submit.total} hidden tests passed.
          </div>
        )}
      </section>
    </div>
  );
}
