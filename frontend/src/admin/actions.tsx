// frontend/src/admin/actions.tsx
// Admin session-action button cluster, extracted verbatim from App.tsx (F3).
import type React from "react";
import { SESSION_ACTION_INFO } from "./alertActions";
import type { SessionAction } from "../types";
import { ActionTooltip } from "../ui/ActionTooltip";

// F6.4: visually separated, labeled cluster of action buttons (session actions
// vs alert actions on an alert row).
export function ActionGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-white/60 p-1.5 pl-2.5">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">{label}</span>
      {children}
    </div>
  );
}

// One session-action button: label + tooltip from SESSION_ACTION_INFO, confirm
// dialog on destructive actions (end, lock). targetLabel names the confirm target.
export function SessionActionButton({ action, targetLabel, onRun }: { action: SessionAction; targetLabel: string; onRun: (action: SessionAction) => void }) {
  const info = SESSION_ACTION_INFO[action];
  const run = () => {
    if (info.destructive && !window.confirm(`Apply "${info.label}" to ${targetLabel}? This affects the live session.`)) return;
    onRun(action);
  };
  return (
    <ActionTooltip tip={info.tooltip}>
      <button
        type="button"
        onClick={run}
        className={`focus-ring rounded-md border px-2.5 py-1.5 text-xs font-medium ${info.destructive ? "border-danger/40 text-danger hover:bg-danger/10" : "border-line text-ink hover:border-ink/40"}`}
      >
        {info.label}
      </button>
    </ActionTooltip>
  );
}

// Compact per-candidate remote-action buttons. Destructive actions confirm first.
// Callers pass the status-valid `actions` set (validSessionActionsFor) — there
// is no full-set default left; every surface knows its session's status.
export function ActionButtons({ onAction, sessionId, username, actions }: { onAction: (action: SessionAction, opts: { sessionId?: string; usernames?: string[] }) => void; sessionId?: string; username?: string; actions: SessionAction[] }) {
  const targetLabel = sessionId ? `session ${sessionId.slice(0, 8)}…` : `${username}`;
  return (
    <div className="flex flex-wrap gap-2">
      {actions.map((action) => (
        <SessionActionButton
          key={action}
          action={action}
          targetLabel={targetLabel}
          onRun={(chosen) => onAction(chosen, sessionId ? { sessionId } : username ? { usernames: [username] } : {})}
        />
      ))}
    </div>
  );
}

// Bulk actions operate on the live session of each selected candidate username.
// F6.4: only the actions valid for at least one selected candidate render
// (union — the backend applies each action per-candidate and skips the rest).
// `noActionsNote` overrides the empty-state copy when the actions are hidden
// for a DIFFERENT reason than "no live sessions" (join data unavailable).
export function BulkActionButtons({ usernames, actions, noActionsNote, onAction }: { usernames: string[]; actions: SessionAction[]; noActionsNote?: string; onAction: (action: SessionAction, opts: { usernames?: string[] }) => void }) {
  if (!actions.length) {
    return <span className="text-xs text-muted">{noActionsNote ?? "No session actions apply — the selected candidates have no live sessions."}</span>;
  }
  const run = (action: SessionAction) => {
    const info = SESSION_ACTION_INFO[action];
    if (info.destructive && !window.confirm(`Apply "${info.label}" to ${usernames.length} candidate(s)? This affects their live sessions.`)) return;
    onAction(action, { usernames });
  };
  return (
    <div className="flex flex-wrap gap-2">
      {actions.map((action) => {
        const info = SESSION_ACTION_INFO[action];
        return (
          <ActionTooltip key={action} tip={`${info.tooltip} Applies to each selected candidate's latest live session.`}>
            <button
              type="button"
              onClick={() => run(action)}
              className={`focus-ring rounded-md border px-2.5 py-1.5 text-xs font-medium ${info.destructive ? "border-danger/40 text-danger hover:bg-danger/10" : "border-line text-ink hover:border-ink/40"}`}
            >
              Bulk {info.label}
            </button>
          </ActionTooltip>
        );
      })}
    </div>
  );
}
