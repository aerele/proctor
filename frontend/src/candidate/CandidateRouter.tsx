// frontend/src/candidate/CandidateRouter.tsx
// Candidate root router (moved verbatim from App.tsx, F4). Resolves the
// ?contest= param and branches to StudentApp / AccessCodeLanding.
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { fetchContestExamConfig } from "../api";
import type { ApiError } from "../api";
import { contestParamOf, routeForPinnedOutcome } from "../shell/candidateRouting";
import type { CandidateRoute } from "../shell/candidateRouting";
import type { ContestExamConfig } from "../types";
import { StudentApp } from "./StudentApp";
import { AccessCodeLanding } from "./AccessCodeLanding";

// S-D candidate routing (vision C1 + §10.3). ?contest=<slug> pins the student
// app to that contest's exam-config; a present-but-bad param shows the
// access-code landing page; an ABSENT param shows the access-code landing page.
// Decisions are pure (shell/candidateRouting.ts); this component only fetches.
export function CandidateRouter() {
  const slug = useMemo(() => contestParamOf(window.location.search), []);
  const [route, setRoute] = useState<CandidateRoute | null>(null);
  const [pinnedConfig, setPinnedConfig] = useState<ContestExamConfig | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!slug) {
        // No ?contest= → the access-code landing page (every test is reached by
        // a pinned slug URL or a typed access code).
        if (!cancelled) setRoute({ kind: "landing", notice: "" });
        return;
      }
      try {
        const config = await fetchContestExamConfig(slug);
        if (cancelled) return;
        setPinnedConfig(config);
        setRoute(routeForPinnedOutcome(slug, { ok: true }));
      } catch (cause) {
        const error = cause as ApiError;
        if (!cancelled) setRoute(routeForPinnedOutcome(slug, { ok: false, status: error?.status, code: error?.code }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, retryNonce]);

  if (!route) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted">Loading…</p>
      </main>
    );
  }
  if (route.kind === "landing") return <AccessCodeLanding notice={route.notice} />;
  if (route.kind === "config_error") {
    return (
      <main className="flex min-h-screen items-center justify-center px-4">
        <section className="w-full max-w-md rounded-lg border border-line bg-panel p-6 text-center shadow-subtle">
          <AlertTriangle size={24} className="mx-auto text-warning" />
          <h1 className="mt-3 text-lg font-semibold text-ink">Could not load this test</h1>
          <p className="mt-2 text-sm leading-6 text-muted">
            The test link looks right, but the configuration could not be loaded. Check that you are online, then try again.
          </p>
          <button
            className="focus-ring mt-4 inline-flex h-10 items-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white"
            onClick={() => {
              setRoute(null);
              setRetryNonce((nonce) => nonce + 1);
            }}
          >
            <RefreshCw size={16} /> Try again
          </button>
        </section>
      </main>
    );
  }
  if (route.kind === "contest" && pinnedConfig) {
    return <StudentApp pinned={{ slug: route.slug, config: pinnedConfig }} />;
  }
  // No resolvable pinned contest → the access-code landing page.
  return <AccessCodeLanding notice="" />;
}

