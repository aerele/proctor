// frontend/src/admin/SystemHealthPanel.tsx
// System Health → Pre-flight. A one-button readiness probe the admin runs
// BEFORE opening a round: it asks the backend to exercise every dependency
// (datastore, storage, signer, Judge0, …) and returns a single green/red
// verdict plus a per-probe breakdown. The "Full check" toggle opts into the
// paid Judge0 executions; the default (light) skips them.
//
// The panel renders `checks[]` GENERICALLY — it does NOT know or hardcode any
// probe id/label/order — so the backend can add, remove, or reword probes
// without a frontend change. Self-contained (own state + password prop)
// following the ProblemBank / Templates conventions.
import { Activity, AlertTriangle, CheckCircle2, MinusCircle, Play, RefreshCw } from "lucide-react";
import { useState } from "react";
import { runHealthCheck, type HealthCheckItem, type HealthCheckResponse, type HealthCheckStatus } from "../api";

function StatusIcon({ status }: { status: HealthCheckStatus }) {
  if (status === "green") return <CheckCircle2 size={18} className="text-emerald-600" aria-label="pass" />;
  if (status === "red") return <AlertTriangle size={18} className="text-danger" aria-label="fail" />;
  return <MinusCircle size={18} className="text-muted" aria-label="skipped" />;
}

function fmtLatency(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function CheckRow({ check }: { check: HealthCheckItem }) {
  const red = check.status === "red";
  return (
    <li
      className={
        "flex flex-wrap items-start gap-3 rounded-md border p-3 text-sm " +
        (red ? "border-danger/40 bg-danger/5" : "border-line bg-white")
      }
    >
      <span className="mt-0.5 shrink-0">
        <StatusIcon status={check.status} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-ink">{check.label || check.id}</span>
          <span className="font-mono text-xs text-muted">{check.id}</span>
          {check.status === "skip" ? (
            <span className="rounded-full bg-neutral-200 px-2 py-0.5 text-xs font-semibold text-muted">skipped</span>
          ) : null}
        </div>
        {check.detail ? (
          <p className={"mt-1 break-words " + (red ? "font-medium text-danger" : "text-muted")}>{check.detail}</p>
        ) : null}
      </div>
      <span className="shrink-0 whitespace-nowrap font-mono text-xs text-muted" title="latency">
        {fmtLatency(check.latency_ms)}
      </span>
    </li>
  );
}

function Verdict({ result }: { result: HealthCheckResponse }) {
  const green = result.overall === "green";
  return (
    <div
      className={
        "flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4 " +
        (green ? "border-emerald-300 bg-emerald-50" : "border-danger/40 bg-danger/10")
      }
    >
      <div className="flex items-center gap-3">
        {green ? (
          <CheckCircle2 size={32} className="text-emerald-600" />
        ) : (
          <AlertTriangle size={32} className="text-danger" />
        )}
        <div>
          <div className={"text-2xl font-bold " + (green ? "text-emerald-700" : "text-danger")}>
            {green ? "All systems go" : "Not ready"}
          </div>
          <div className="text-xs text-muted">
            {result.mode === "full" ? "Full check" : "Light check"} · ran {new Date(result.ran_at).toLocaleString()} · took{" "}
            {fmtLatency(result.duration_ms)}
          </div>
        </div>
      </div>
      <span
        className={
          "rounded-full px-3 py-1 text-sm font-bold uppercase tracking-wide " +
          (green ? "bg-emerald-600 text-white" : "bg-danger text-white")
        }
      >
        {result.overall}
      </span>
    </div>
  );
}

export function SystemHealthPanel({ password }: { password: string }) {
  const [full, setFull] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<HealthCheckResponse | null>(null);

  const run = async () => {
    setRunning(true);
    setError("");
    try {
      const res = await runHealthCheck(password, full ? "full" : "light");
      setResult(res);
    } catch (cause) {
      setResult(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Activity size={20} />
          <div>
            <h1 className="text-2xl font-semibold">Pre-flight check</h1>
            <p className="mt-1 text-sm text-muted">
              Probe every dependency before opening a round. A single green verdict means the stack is ready; on red, each
              failing probe shows the real error so you can fix it fast.
            </p>
          </div>
        </div>
        <button
          className="focus-ring inline-flex h-10 items-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => void run()}
          disabled={running || !password}
        >
          {running ? <RefreshCw size={16} className="animate-spin" /> : <Play size={16} />}
          {running ? "Running…" : "Run pre-flight check"}
        </button>
      </div>

      <label className="mb-4 flex items-start gap-3 rounded-md border border-line bg-white/60 p-3 text-sm leading-6 text-muted">
        <input
          className="mt-1 h-4 w-4 accent-accent"
          type="checkbox"
          checked={full}
          disabled={running}
          onChange={(event) => setFull(event.target.checked)}
        />
        <span>
          <span className="font-medium text-ink">Full check (runs Judge0 — 2 paid executions)</span> — also exercises the
          code-execution backend end to end. Leave off for a fast, free readiness probe.
        </span>
      </label>

      {error ? (
        <div className="mb-4 rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
          Health check could not run: {error}
        </div>
      ) : null}

      {running && !result ? <p className="text-sm text-muted">Running probes…</p> : null}

      {result ? (
        <div className="space-y-4">
          <Verdict result={result} />

          <ul className="space-y-2">
            {result.checks.map((check) => (
              <CheckRow key={check.id} check={check} />
            ))}
            {!result.checks.length ? <li className="text-sm text-muted">The backend returned no probes.</li> : null}
          </ul>

          <div
            className={
              "rounded-md border p-3 text-sm " +
              (result.cleanup.ok ? "border-line bg-white text-muted" : "border-danger/40 bg-danger/5 text-danger")
            }
          >
            <span className="font-medium">{result.cleanup.ok ? "Cleanup OK" : "Cleanup issue"}</span>
            {result.cleanup.detail ? <span> — {result.cleanup.detail}</span> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
