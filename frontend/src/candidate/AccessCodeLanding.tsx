// frontend/src/candidate/AccessCodeLanding.tsx
// Candidate root (moved verbatim from App.tsx, F4). The bare access-code landing
// page — props-driven, no shared state with StudentApp.
import { useState } from "react";
import { resolveAccessCodeApi } from "../api";
import type { ApiError } from "../api";
import { accessCodeReady, contestUrlFor, landingErrorMessage, normalizeAccessCodeInput } from "../shell/candidateRouting";

// S-D §10.3: the BARE access-code landing page — weak lab machines type a
// 6-char code instead of a slug URL. Resolves via the public (rate-limited)
// POST /api/access-code and redirects to the pinned ?contest= URL.
export function AccessCodeLanding(props: { notice: string }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    if (!accessCodeReady(code) || busy) return;
    setBusy(true);
    setError("");
    try {
      const resolved = await resolveAccessCodeApi(code);
      window.location.assign(contestUrlFor(resolved.slug));
      // No setBusy(false): the page is navigating away.
    } catch (cause) {
      const apiError = cause as ApiError;
      setError(landingErrorMessage(apiError?.status, apiError?.code));
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <section className="w-full max-w-md rounded-lg border border-line bg-panel p-8 text-center shadow-subtle">
        <p className="text-xs font-semibold uppercase tracking-wide text-accent">Aerele Proctor</p>
        <h1 className="mt-2 text-2xl font-semibold text-ink">Enter your test code</h1>
        <p className="mt-2 text-sm leading-6 text-muted">
          Type the 6-character code you were given for your test.
        </p>
        {props.notice ? (
          <p className="mt-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">{props.notice}</p>
        ) : null}
        <input
          className="focus-ring mt-5 h-14 w-full rounded-md border border-line bg-white text-center font-mono text-3xl font-bold uppercase tracking-[0.35em] text-ink"
          autoFocus
          aria-label="Test code"
          autoComplete="off"
          spellCheck={false}
          maxLength={6}
          value={code}
          onChange={(event) => setCode(normalizeAccessCodeInput(event.target.value))}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submit();
          }}
        />
        <button
          className="focus-ring mt-4 inline-flex h-11 w-full items-center justify-center rounded-md bg-ink text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!accessCodeReady(code) || busy}
          onClick={() => void submit()}
        >
          {busy ? "Checking…" : "Continue"}
        </button>
        {error ? <p className="mt-3 text-sm font-medium text-danger">{error}</p> : null}
      </section>
    </main>
  );
}

// Student gate state — the server-reported lifecycle status, separate from the
// recorder UI status. "form" is the very first screen (no session yet).
