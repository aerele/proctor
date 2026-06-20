// frontend/src/admin/views/ReviewSessionCard.tsx
// Review-mode session card, extracted verbatim from App.tsx (F3).
import { candidateIdOf } from "../../identity";
import { validSessionActionsFor } from "../alertActions";
import type { SessionAction } from "../../types";
import { ActionButtons } from "../actions";

export function ReviewSessionCard({ session, onAction }: { session: Record<string, unknown>; onAction: (action: SessionAction, opts: { sessionId?: string; usernames?: string[] }) => void }) {
  const sessionId = session.session_id ? String(session.session_id) : undefined;
  // F6 review: the status is in hand — render only the status-valid actions
  // (same table as the alerts console / session detail card), not all five.
  const status = session.status ? String(session.status) : "";
  const actions = validSessionActionsFor(status);
  return (
    <div className="rounded-lg border border-line bg-panel p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-xs text-muted">{sessionId ?? ""}</p>
          <h2 className="mt-1 text-lg font-semibold">{candidateIdOf(session)}</h2>
          {session.room ? <p className="text-xs text-muted">Room {String(session.room)}</p> : null}
        </div>
        <span className="rounded-full border border-line px-3 py-1 text-xs font-medium">{status || "unknown"}</span>
      </div>
      <div className="mt-4">
        {actions.length ? (
          <ActionButtons onAction={onAction} sessionId={sessionId} actions={actions} />
        ) : (
          <span className="text-xs text-muted">
            {status === "ended" ? "This session has ended — view-only." : "No session actions apply to this status."}
          </span>
        )}
      </div>
      <pre className="mt-4 max-h-96 overflow-auto rounded-md bg-ink p-4 text-xs text-white">{JSON.stringify(session, null, 2)}</pre>
    </div>
  );
}
