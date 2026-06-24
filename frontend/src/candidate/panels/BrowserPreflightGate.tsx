// frontend/src/candidate/panels/BrowserPreflightGate.tsx
//
// G2 (v1.1 anti-cheat) — the candidate-facing browser/codec PREFLIGHT gate. It
// runs the passive probes on mount and, on the "Check my browser" gesture, the
// active anti-spoof probes (which actually open the screen picker + webcam). On
// a REQUIRED-capability failure it HARD-BLOCKS with the recommended-browser
// message; the candidate cannot proceed until the checks pass. Optional failures
// (camera/mic) only warn.
//
// The verdict logic is pure (browserPreflight.ts evaluatePreflight); this is the
// render + probe-runner glue. See browserPreflight.ts for the honesty model.
import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, MonitorCheck, XCircle } from "lucide-react";
import {
  evaluatePreflight,
  classifyUserAgent,
  uaAdvisoryLine,
  PREFLIGHT_MATRIX,
  PREFLIGHT_ORDER,
  type ProbeResult,
  type PreflightVerdict
} from "../../shell/browserPreflight";
import { runActiveProbes, runPassiveProbes } from "../../shell/browserPreflightProbe";

type Phase = "idle" | "checking" | "done";

export function BrowserPreflightGate({ onPass, onResult, takeHome, proctorPhone }: {
  /** Called once the preflight passes — the entry flow proceeds. */
  onPass: () => void;
  /** Telemetry hook: every completed verdict (pass or block) for the proctor. */
  onResult?: (verdict: PreflightVerdict, results: ProbeResult[]) => void;
  takeHome?: boolean;
  proctorPhone?: string;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [results, setResults] = useState<ProbeResult[]>(() => runPassiveProbes());
  const [verdict, setVerdict] = useState<PreflightVerdict | null>(null);
  const uaAdvisory = classifyUserAgent(typeof navigator !== "undefined" ? navigator.userAgent : "");
  const advisoryLine = uaAdvisoryLine(uaAdvisory);

  // Re-run passive probes on mount (covers an SSR/static first paint).
  useEffect(() => {
    setResults(runPassiveProbes());
  }, []);

  const runCheck = async () => {
    setPhase("checking");
    const passive = runPassiveProbes();
    const active = await runActiveProbes();
    // Active results win for the capabilities they cover (screen_capture,
    // camera_mic); keep the passive ones for the rest.
    const byCap = new Map<string, ProbeResult>();
    [...passive, ...active].forEach((r) => byCap.set(r.capability, r));
    const merged = PREFLIGHT_ORDER.map((cap) => byCap.get(cap)).filter(Boolean) as ProbeResult[];
    const v = evaluatePreflight(merged);
    setResults(merged);
    setVerdict(v);
    setPhase("done");
    onResult?.(v, merged);
    if (v.passed) onPass();
  };

  const blocked = phase === "done" && verdict !== null && !verdict.passed;

  return (
    <section className="mx-auto max-w-2xl rounded-lg border border-line bg-panel p-6 shadow-subtle">
      <div className="flex items-start gap-3">
        <MonitorCheck size={22} className="mt-0.5 shrink-0 text-accent" />
        <div>
          <h1 className="text-2xl font-semibold text-ink">Browser check</h1>
          <p className="mt-1 text-sm leading-6 text-muted">
            Before you start, we make sure your browser can record the test. This actually tries to share your screen and use your camera.
          </p>
        </div>
      </div>

      {advisoryLine ? (
        <div className="mt-4 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm leading-6 text-warning">
          <AlertTriangle size={15} className="mr-1 inline" /> {advisoryLine}
        </div>
      ) : null}

      <ul className="mt-5 space-y-2">
        {PREFLIGHT_ORDER.map((cap) => {
          const r = results.find((x) => x.capability === cap);
          const meta = PREFLIGHT_MATRIX[cap];
          const ok = r?.ok ?? false;
          const checked = phase === "done" || (r && (cap === "secure_context" || cap === "media_recorder" || cap === "fullscreen" || cap === "keystroke" || cap === "cursor"));
          return (
            <li key={cap} className="flex items-start gap-3 rounded-md border border-line bg-white/60 px-3 py-2 text-sm">
              <span className="mt-0.5 shrink-0">
                {!checked ? (
                  <span className="inline-block h-4 w-4 rounded-full border border-line" />
                ) : ok ? (
                  <CheckCircle2 size={16} className="text-emerald-600" />
                ) : meta.required ? (
                  <XCircle size={16} className="text-danger" />
                ) : (
                  <AlertTriangle size={16} className="text-warning" />
                )}
              </span>
              <span>
                <span className="font-medium text-ink">{meta.label}</span>
                {!meta.required ? <span className="ml-1 text-xs text-muted">(optional)</span> : null}
                {checked && !ok && r?.detail ? <span className="block text-xs text-muted">{r.detail}</span> : null}
              </span>
            </li>
          );
        })}
      </ul>

      {blocked ? (
        <div className="mt-5 rounded-md border border-danger/40 bg-danger/10 p-4 text-sm leading-6 text-danger">
          <p className="font-semibold">You cannot start the test in this browser.</p>
          <p className="mt-1">{verdict?.message}</p>
          {takeHome && proctorPhone ? (
            <p className="mt-2">Stuck? Call your proctor at {proctorPhone}.</p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          className="focus-ring inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
          disabled={phase === "checking"}
          onClick={() => void runCheck()}
        >
          {phase === "checking" ? <Loader2 size={16} className="animate-spin" /> : <MonitorCheck size={16} />}
          {phase === "checking" ? "Checking…" : blocked ? "Check again" : "Check my browser"}
        </button>
        <span className="text-xs text-muted">You will be asked to share your Entire Screen — pick the whole screen and Allow.</span>
      </div>
    </section>
  );
}
