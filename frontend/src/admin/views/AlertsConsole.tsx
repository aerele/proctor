// frontend/src/admin/views/AlertsConsole.tsx
// Live alerts console + alert row, extracted verbatim from App.tsx (F3).
import { useMemo, useState } from "react";
import { AlertTriangle, Archive, ArchiveRestore, Bell, BellOff, ChevronDown, ChevronRight, ExternalLink, Film, RefreshCw, Undo2, Video, X } from "lucide-react";
import { isAllSelected, usernamesForSelection } from "../../alertSelection";
import { groupAlerts, type AlertGroupBy } from "../../alertGrouping";
import { ALERT_ACTION_INFO, SESSION_ACTION_INFO, SESSION_ACTION_ORDER, alertJoinState, bulkSessionActionsFor, normalizeJoinUsername, sessionForAlert, suppressionTypeForAlert, validSessionActionsFor, type AlertJoinState } from "../alertActions";
import { candidateIdOf } from "../../identity";
import type { Alert, AlertFilters, AlertSeverity, AlertSuppressionEntry, AlertSuppressionRequest, RecordingSession, SessionAction } from "../../types";
import { FilterSelect } from "../../ui/FilterSelect";
import { SeverityPill } from "../../ui/SeverityPill";
import { Metric } from "../../ui/Metric";
import { ActionTooltip } from "../../ui/ActionTooltip";
import { ActionGroup, BulkActionButtons, SessionActionButton } from "../actions";
import { RoomFilter } from "./RoomFilter";
import { AlertField } from "./AlertField";

export function AlertsConsole({ alerts, sessions, sessionsFailed, loading, loaded, filters, rooms, candidateFilter, onClearCandidateFilter, selected, onToggleSelected, onSelectAll, onDeselectAll, onClearSelection, onFiltersChange, onRefresh, onAction, onArchive, onApproveArchive, onJumpToRecordingAtAlert, suppressions, onSuppress }: {
  alerts: Alert[];
  /** F6.4 status-join data; null = not loaded / 404 / truncated (see alertJoinState). */
  sessions: RecordingSession[] | null;
  /** F6 review: the join fetch failed (non-404) — with no kept data, rows
   * degrade to archive-only with a "session status unavailable" note. */
  sessionsFailed: boolean;
  loading: boolean;
  loaded: boolean;
  filters: AlertFilters;
  rooms: string[];
  /** F6.3: one-shot client-side candidate filter ("View alerts" on the session
   * detail card). "" = off. Cleared via the chip rendered with the filters. */
  candidateFilter: string;
  onClearCandidateFilter: () => void;
  selected: Set<string>;
  onToggleSelected: (key: string) => void;
  onSelectAll: (ids: string[]) => void;
  /** F6 review: un-checking "Select all" removes ONLY the currently-filtered
   * ids — off-screen ids selected under another filter survive. */
  onDeselectAll: (ids: string[]) => void;
  onClearSelection: () => void;
  onFiltersChange: (filters: AlertFilters) => void;
  onRefresh: () => void;
  onAction: (action: SessionAction, opts: { sessionId?: string; usernames?: string[] }) => void;
  onArchive: (ids: string[], action?: "archive" | "unarchive") => void;
  onApproveArchive: (alert: Alert, targetSessionId?: string) => void;
  /** LT-12: jump to the Recordings tab for this alert's session, seeked to the
   *  alert's exact wall-clock moment. AdminApp resolves the target session +
   *  carries the alert timestamp; a session-less alert is a no-op. */
  onJumpToRecordingAtAlert: (alert: Alert) => void;
  /** ALERT-1: the shared per-(user, test, type) suppression list (for the panel
   *  + per-row "already suppressed" state). null = not loaded / endpoint absent. */
  suppressions: AlertSuppressionEntry[] | null;
  /** ALERT-1: suppress/unsuppress one entry. From a row, derive the entry from
   *  the alert; from the panel, pass the entry's own fields. */
  onSuppress: (request: AlertSuppressionRequest) => void;
}) {
  // F6.3: the rendered list — the candidate filter is CLIENT-side (the alerts
  // API has no username filter), matched on normalized usernames the same way
  // the status join works. Everything below (metrics, select-all scope, rows)
  // operates on this visible list.
  const visibleAlerts = useMemo(() => {
    if (!candidateFilter) return alerts;
    const norm = normalizeJoinUsername(candidateFilter);
    return alerts.filter((alert) => (alert.username_norm || normalizeJoinUsername(candidateIdOf(alert))) === norm);
  }, [alerts, candidateFilter]);
  // Unique candidate usernames in the current (selected) alert set, for bulk actions.
  const selectedUsernames = useMemo(() => usernamesForSelection(alerts, selected), [alerts, selected]);
  // F6.2: ids of the CURRENTLY FILTERED list — the scope of "Select all". The
  // selected Set may also hold off-screen ids (selection survives refresh and
  // filter changes); bulk archive acts on ALL selected ids, not just visible ones.
  const visibleIds = useMemo(() => visibleAlerts.map((alert) => alert.id), [visibleAlerts]);
  const allSelected = isAllSelected(selected, visibleIds);
  // F6 review: how rows/bulk treat the join data — contextual ("joined"), full
  // fallback ("fallback": not loaded / 404 / truncated), or archive-only with a
  // note ("unavailable": the join fetch failed and nothing was kept).
  const joinState = alertJoinState(sessions, sessionsFailed);
  // F6.4: bulk buttons show only the UNION of actions valid for the selected
  // candidates' live sessions (fallback → full set, same degrade as rows).
  const bulkActions = useMemo(
    () =>
      joinState === "joined" && sessions !== null
        ? bulkSessionActionsFor(selectedUsernames, sessions)
        : joinState === "fallback"
          ? SESSION_ACTION_ORDER
          : [],
    [joinState, sessions, selectedUsernames]
  );

  // TG-1581 grouping: none (flat, default) | candidate | type. Pure grouping
  // (alertGrouping.ts) over the VISIBLE list, so the room/severity/candidate
  // filters scope the groups too. collapsedGroups is keyed by group key and
  // reset when the mode changes (candidate keys and type keys could collide).
  const [groupBy, setGroupBy] = useState<AlertGroupBy>("none");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  // ALERT-1: the "Suppressed alerts" disclosure (like "Show archived").
  const [showSuppressed, setShowSuppressed] = useState(false);
  const suppressionCount = suppressions?.length ?? 0;
  const groups = useMemo(
    () => (groupBy === "none" ? null : groupAlerts(visibleAlerts, groupBy)),
    [groupBy, visibleAlerts]
  );
  const toggleGroupCollapsed = (key: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  // The same row everywhere — the grouped sections must render EXACTLY what the
  // flat list renders (selection, actions, archive all keep working).
  const renderAlertRow = (alert: Alert) => (
    <AlertRow
      key={alert.id}
      alert={alert}
      sessions={sessions}
      joinState={joinState}
      selected={selected.has(alert.id)}
      onToggleSelected={() => onToggleSelected(alert.id)}
      onAction={onAction}
      onArchive={onArchive}
      onApproveArchive={onApproveArchive}
      onJumpToRecordingAtAlert={onJumpToRecordingAtAlert}
      suppressions={suppressions}
      onSuppress={onSuppress}
    />
  );

  return (
    <>
      <section className="mb-5 rounded-lg border border-line bg-panel p-5 shadow-subtle">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Bell size={20} />
            <div>
              <h1 className="text-2xl font-semibold">Live alerts console</h1>
              <p className="mt-1 text-sm text-muted">Proctoring signals across all rooms, newest first. Auto-refreshes every 5s. Click a clip to open the recorded evidence.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* ALERT-1: the shared Suppressed-alerts list — every (user, test,
                type) suppression lives behind this one disclosure. */}
            <button
              type="button"
              className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md border border-line px-3 text-sm font-medium text-ink hover:border-ink/40"
              onClick={() => setShowSuppressed((value) => !value)}
              aria-expanded={showSuppressed}
            >
              <BellOff size={16} /> Suppressed ({suppressionCount})
            </button>
            <button className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white disabled:opacity-50" onClick={onRefresh} disabled={loading}>
              <RefreshCw size={16} className={loading ? "animate-spin" : undefined} /> {loading ? "Refreshing" : "Refresh"}
            </button>
          </div>
        </div>

        {showSuppressed ? (
          <SuppressedPanel suppressions={suppressions} onSuppress={onSuppress} />
        ) : null}

        <div className="mt-4 flex flex-wrap items-end gap-3">
          {/* HR-poller removal: the Source filter was dropped — "proctor" is now
              the only alert source (the contest-eval poller was removed). */}
          <FilterSelect
            label="Severity"
            value={filters.severity ?? ""}
            options={[{ value: "", label: "All severities" }, { value: "critical", label: "Critical" }, { value: "warning", label: "Warning" }, { value: "info", label: "Info" }]}
            onChange={(value) => onFiltersChange({ ...filters, severity: value ? (value as AlertSeverity) : undefined })}
          />
          <RoomFilter rooms={rooms} value={filters.room ?? ""} onChange={(room) => onFiltersChange({ ...filters, room: room || undefined })} />
          {/* TG-1581: group related alerts for easier triage (client-side). */}
          <FilterSelect
            label="Group by"
            value={groupBy}
            options={[{ value: "none", label: "No grouping" }, { value: "candidate", label: "Candidate" }, { value: "type", label: "Alert type" }]}
            onChange={(value) => {
              setGroupBy(value as AlertGroupBy);
              setCollapsedGroups(new Set());
            }}
          />
          {/* A1: the contest filter is now the GLOBAL banner below the nav; the
              per-console contest input was removed to avoid two sources of truth. */}
          {/* F6.3: one-shot candidate filter chip (set by the session detail card). */}
          {candidateFilter ? (
            <span className="mb-2 inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent">
              Candidate: <span className="font-mono">{candidateFilter}</span>
              <button type="button" onClick={onClearCandidateFilter} aria-label="Clear candidate filter" className="focus-ring rounded-full hover:text-ink">
                <X size={12} />
              </button>
            </span>
          ) : null}
          <label className="mb-2 flex items-center gap-2 text-sm">
            <input
              className="h-4 w-4 accent-accent"
              type="checkbox"
              checked={Boolean(filters.include_archived)}
              onChange={(event) => onFiltersChange({ ...filters, include_archived: event.target.checked || undefined })}
            />
            <span className="font-medium">Show archived</span>
          </label>
        </div>

        <div className="mt-4 flex flex-wrap gap-3 text-sm">
          <Metric icon={<Bell size={16} />} label="Total" value={String(visibleAlerts.length)} />
          <Metric icon={<AlertTriangle size={16} />} label="Critical" value={String(visibleAlerts.filter((alert) => alert.severity === "critical").length)} />
          <Metric icon={<AlertTriangle size={16} />} label="Warning" value={String(visibleAlerts.filter((alert) => alert.severity === "warning").length)} />
        </div>

        {/* F6 review: the status join failed (non-404) with nothing kept —
            alerts stay fully readable, session actions hide until a refresh
            succeeds (auto-retry every poll tick). */}
        {joinState === "unavailable" ? (
          <p className="mt-4 inline-flex items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            <AlertTriangle size={14} /> Session status unavailable — the sessions list could not be loaded, so session actions are hidden (archiving still works). Retrying on the next refresh.
          </p>
        ) : null}

        {/* F6.1-2 selection bar: select-all over the CURRENTLY FILTERED list,
            selected count, clear, and bulk archive/unarchive on ALL selected ids. */}
        {visibleAlerts.length || selected.size ? (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-md border border-ink/20 bg-ink/5 p-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                className="h-4 w-4 accent-accent"
                type="checkbox"
                checked={allSelected}
                // F6 review: un-checking removes only the CURRENTLY FILTERED ids;
                // off-screen ids picked under another filter stay selected
                // ("Clear selection" is the explicit clear-everything action).
                onChange={() => (allSelected ? onDeselectAll(visibleIds) : onSelectAll(visibleIds))}
              />
              Select all ({visibleAlerts.length})
            </label>
            <span className="text-sm font-medium">{selected.size} selected</span>
            {selected.size ? (
              <>
                <button
                  type="button"
                  onClick={onClearSelection}
                  className="focus-ring rounded-md border border-line px-2.5 py-1.5 text-xs font-medium text-ink hover:border-ink/40"
                >
                  Clear selection
                </button>
                <button
                  type="button"
                  onClick={() => onArchive([...selected], "archive")}
                  className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs font-medium text-ink hover:border-ink/40"
                >
                  <Archive size={14} /> Archive selected
                </button>
                <button
                  type="button"
                  onClick={() => onArchive([...selected], "unarchive")}
                  className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs font-medium text-ink hover:border-ink/40"
                >
                  <ArchiveRestore size={14} /> Unarchive selected
                </button>
              </>
            ) : null}
          </div>
        ) : null}

        {selectedUsernames.length ? (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-md border border-ink/20 bg-ink/5 p-3">
            <span className="text-sm font-medium">{selectedUsernames.length} candidate(s) selected:</span>
            <span className="font-mono text-xs text-muted">{selectedUsernames.join(", ")}</span>
            <BulkActionButtons
              usernames={selectedUsernames}
              actions={bulkActions}
              noActionsNote={joinState === "unavailable"
                ? "Session status unavailable — bulk session actions are hidden; bulk archive above still works."
                : undefined}
              onAction={onAction}
            />
          </div>
        ) : null}
      </section>

      <section className="space-y-3">
        {!loaded && loading ? (
          <div className="rounded-lg border border-line bg-panel p-5 text-sm text-muted">Loading alerts…</div>
        ) : visibleAlerts.length === 0 ? (
          <div className="rounded-lg border border-line bg-panel p-5 text-sm text-muted">
            {candidateFilter
              ? <>No alerts for candidate <span className="font-mono">{candidateFilter}</span> under the current filters. Clear the candidate chip above to see everyone.</>
              : "No alerts match the current filters. New proctoring signals appear here as they arrive."}
          </div>
        ) : groups === null ? (
          visibleAlerts.map(renderAlertRow)
        ) : (
          // TG-1581 grouped view: collapsible sections, same AlertRow inside.
          groups.map((group) => {
            const collapsed = collapsedGroups.has(group.key);
            const allGroupSelected = isAllSelected(selected, group.ids);
            return (
              <section key={group.key} className="rounded-lg border border-line bg-white/40">
                <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                  {/* Group-select feeds the SAME selection model as the
                      select-all bar (union add / filtered remove), so bulk
                      archive + bulk session actions work across groups. */}
                  <input
                    className="h-4 w-4 accent-accent"
                    type="checkbox"
                    checked={allGroupSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = !allGroupSelected && group.ids.some((id) => selected.has(id));
                    }}
                    onChange={() => (allGroupSelected ? onDeselectAll(group.ids) : onSelectAll(group.ids))}
                    aria-label={`Select all alerts for ${group.label}`}
                  />
                  <button
                    type="button"
                    onClick={() => toggleGroupCollapsed(group.key)}
                    aria-expanded={!collapsed}
                    className="focus-ring flex flex-wrap items-center gap-2 rounded-md text-left"
                  >
                    {collapsed ? <ChevronRight size={16} className="text-muted" /> : <ChevronDown size={16} className="text-muted" />}
                    <span className={`font-semibold ${groupBy === "candidate" ? "" : "font-mono text-sm"}`}>{group.label}</span>
                    <span className="rounded-full bg-ink/10 px-2 py-0.5 text-xs font-semibold text-ink">{group.alerts.length}</span>
                    <SeverityPill severity={group.worstSeverity} />
                  </button>
                </div>
                {!collapsed ? <div className="space-y-3 px-3 pb-3">{group.alerts.map(renderAlertRow)}</div> : null}
              </section>
            );
          })
        )}
      </section>
    </>
  );
}

// ALERT-1: the shared "Suppressed alerts" list — every (user, test, type)
// suppression (dispute-driven or proactive admin) lives here. Each row carries a
// "Stop suppressing" button (POST unsuppress). null = not loaded / endpoint
// absent (the panel says so instead of implying "none suppressed").
function SuppressedPanel({ suppressions, onSuppress }: { suppressions: AlertSuppressionEntry[] | null; onSuppress: (request: AlertSuppressionRequest) => void }) {
  if (suppressions === null) {
    return <p className="mt-4 rounded-md border border-line bg-white/50 p-4 text-sm text-muted">Suppressed list unavailable.</p>;
  }
  if (!suppressions.length) {
    return <p className="mt-4 rounded-md border border-line bg-white/50 p-4 text-sm text-muted">No alerts are suppressed. Use the <span className="font-medium">Suppress</span> button on a row to stop raising a specific alert type for a candidate in a test.</p>;
  }
  return (
    <div className="mt-4 overflow-x-auto rounded-md border border-line">
      <table className="min-w-full text-sm">
        <thead className="bg-white/60 text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="px-3 py-2 font-medium">Candidate</th>
            <th className="px-3 py-2 font-medium">Test</th>
            <th className="px-3 py-2 font-medium">Alert type</th>
            <th className="px-3 py-2 font-medium">Reason</th>
            <th className="px-3 py-2 font-medium">By / when</th>
            <th className="px-3 py-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          {suppressions.map((entry) => (
            <tr key={`${entry.username_norm}:${entry.contest_slug}:${entry.alert_type}`} className="border-t border-line">
              <td className="px-3 py-2 font-mono">{entry.candidate_id || entry.username_norm}</td>
              <td className="px-3 py-2 font-mono">{entry.contest_slug || "—"}</td>
              <td className="px-3 py-2 font-mono">{entry.alert_type}</td>
              <td className="px-3 py-2 text-muted">{entry.reason || "—"}</td>
              <td className="px-3 py-2 text-xs text-muted">{entry.created_by}{entry.created_at ? ` · ${new Date(entry.created_at).toLocaleString()}` : ""}</td>
              <td className="px-3 py-2">
                <ActionTooltip tip={ALERT_ACTION_INFO.unsuppress.tooltip}>
                  <button
                    type="button"
                    onClick={() => onSuppress({
                      action: "unsuppress",
                      username_norm: entry.username_norm,
                      candidate_id: entry.candidate_id,
                      ...(entry.contest_slug ? { contest_slug: entry.contest_slug } : {}),
                      alert_type: entry.alert_type
                    })}
                    className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs font-medium text-ink hover:border-ink/40"
                  >
                    <Undo2 size={14} /> {ALERT_ACTION_INFO.unsuppress.label}
                  </button>
                </ActionTooltip>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AlertRow({ alert, sessions, joinState, selected, onToggleSelected, onAction, onArchive, onApproveArchive, onJumpToRecordingAtAlert, suppressions, onSuppress }: { alert: Alert; sessions: RecordingSession[] | null; joinState: AlertJoinState; selected: boolean; onToggleSelected: () => void; onAction: (action: SessionAction, opts: { sessionId?: string; usernames?: string[] }) => void; onArchive: (ids: string[], action?: "archive" | "unarchive") => void; onApproveArchive: (alert: Alert, targetSessionId?: string) => void; onJumpToRecordingAtAlert: (alert: Alert) => void; suppressions: AlertSuppressionEntry[] | null; onSuppress: (request: AlertSuppressionRequest) => void }) {
  const [expanded, setExpanded] = useState(false);
  const hasData = alert.data && Object.keys(alert.data).length > 0;
  // F6.4: join the alert to the session its actions would target (the alert's
  // own LIVE session_id, else the candidate's latest live session) and render
  // ONLY the actions valid for that session's status. F6 review (joinState):
  // "fallback" (no list yet / 404 / truncated) → full action set so a stale
  // backend never costs admin capability; "unavailable" (join fetch failed) →
  // archive-only with a note. Contest-eval alerts whose candidate has no
  // session resolve to joined === null → alert actions only.
  const joined = joinState === "joined" && sessions !== null ? sessionForAlert(alert, sessions) : null;
  // LT-12: this alert can deep-link into the recording at its exact moment when
  // there's a session to open — the alert's own session_id, or a joined live
  // session (a session-less contest-eval signal has no recording to jump to).
  // AdminApp re-resolves the precise target + carries the timestamp on click.
  const canJumpToRecording = Boolean(alert.session_id || joined);
  const sessionActions =
    joinState === "joined" ? validSessionActionsFor(joined?.status) : joinState === "fallback" ? SESSION_ACTION_ORDER : [];
  const sessionGroupLabel = joinState === "joined" ? `Session — ${joined?.status ?? "none"}` : "Session";
  // Actions target the JOINED session (never a stale alert.session_id whose doc
  // fell back to a newer live one); without join data, legacy targeting applies.
  const actionTarget = joined
    ? { sessionId: joined.session_id }
    : alert.session_id
      ? { sessionId: alert.session_id }
      : { usernames: [candidateIdOf(alert)] };
  const archiveInfo = alert.archived ? ALERT_ACTION_INFO.unarchive : ALERT_ACTION_INFO.archive;
  // ALERT-1: which (user, test, type) this row's Suppress button targets (a
  // dispute_raised row suppresses the DISPUTED type) + whether it is already
  // suppressed. The contest_slug "" / "_" pair is one unscoped bucket, matching
  // the backend's isAlertSuppressed equivalence.
  const suppressType = suppressionTypeForAlert(alert);
  const suppressUserNorm = alert.username_norm || normalizeJoinUsername(candidateIdOf(alert));
  const suppressSlug = alert.contest_slug && alert.contest_slug !== "_" ? alert.contest_slug : "";
  const alreadySuppressed = (suppressions ?? []).some(
    (entry) => entry.username_norm === suppressUserNorm
      && entry.alert_type === suppressType
      && (entry.contest_slug === "_" ? "" : entry.contest_slug) === suppressSlug
  );
  const suppressInfo = alreadySuppressed ? ALERT_ACTION_INFO.unsuppress : ALERT_ACTION_INFO.suppress;
  const suppressRequest: AlertSuppressionRequest = {
    action: alreadySuppressed ? "unsuppress" : "suppress",
    candidate_id: candidateIdOf(alert),
    username_norm: suppressUserNorm,
    ...(suppressSlug ? { contest_slug: suppressSlug } : {}),
    alert_type: suppressType,
    source_alert_id: alert.id
  };
  return (
    <div className={`rounded-lg border bg-panel p-5 shadow-subtle ${alert.archived ? "opacity-70" : ""} ${alert.severity === "critical" ? "border-danger/40" : selected ? "border-ink/50" : "border-line"}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          <input className="mt-1.5 h-4 w-4 shrink-0 accent-accent" type="checkbox" checked={selected} onChange={onToggleSelected} aria-label={`Select ${candidateIdOf(alert)}`} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <SeverityPill severity={alert.severity} />
              <span className="rounded-full border border-line px-2.5 py-1 text-xs font-medium capitalize text-muted">{alert.source}</span>
              <span className="rounded-full border border-line px-2.5 py-1 font-mono text-xs text-muted">{alert.type}</span>
              {alert.archived ? <span className="rounded-full border border-ink/20 bg-ink/5 px-2.5 py-1 text-xs font-medium text-muted">Archived</span> : null}
            </div>
            <h2 className="mt-2 text-lg font-semibold">{alert.title}</h2>
            {alert.detail ? <p className="mt-1 text-sm leading-6 text-muted">{alert.detail}</p> : null}
          </div>
        </div>
        <time className="shrink-0 font-mono text-xs text-muted" dateTime={alert.timestamp}>{new Date(alert.timestamp).toLocaleString()}</time>
      </div>

      <div className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <AlertField label="Candidate" value={candidateIdOf(alert)} mono />
        {alert.room ? <AlertField label="Room" value={alert.room} /> : null}
        {alert.contest_slug ? <AlertField label="Contest" value={alert.contest_slug} mono /> : null}
        {alert.session_id ? <AlertField label="Session" value={alert.session_id} mono /> : null}
        {/* F6.4: the joined status explains WHY the row offers these actions;
            "unavailable" = the join fetch failed (F6 review). */}
        {joinState === "joined" ? <AlertField label="Session status" value={joined?.status ?? "no live session"} /> : null}
        {joinState === "unavailable" ? <AlertField label="Session status" value="unavailable" /> : null}
        {alert.verdict ? <AlertField label="Verdict" value={alert.verdict.status} /> : null}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          {/* ALERT-2: still image of the screen at the alert moment (captured
              from the cached last frame even when the recording had already
              stopped). Clicking opens the full-size image in a new tab — same
              UX as the evidence-clip link. */}
          {alert.screenshot_url ? (
            <a
              className="focus-ring inline-block overflow-hidden rounded-md border border-line hover:border-ink/40"
              href={alert.screenshot_url}
              target="_blank"
              rel="noreferrer"
              title="Screen at alert time"
            >
              <img
                src={alert.screenshot_url}
                alt="Screen at alert time"
                className="h-20 w-auto object-cover"
                loading="lazy"
              />
            </a>
          ) : null}
          {alert.download_url ? (
            <a
              className="focus-ring inline-flex items-center gap-2 rounded-md border border-line px-3 py-2 text-xs font-medium text-ink hover:border-ink/40"
              href={alert.download_url}
              target="_blank"
              rel="noreferrer"
            >
              <Video size={14} /> Open evidence clip <ExternalLink size={12} />
            </a>
          ) : (
            <span className="text-xs text-muted">No recording attached.</span>
          )}
          {/* LT-12: jump INTO the recording-review player for this session,
              seeked to the alert's exact moment (front/back scrubbing + the
              full activity timeline there) — distinct from the raw "Open
              evidence clip" file link above. Shown whenever there's a session
              to open. */}
          {canJumpToRecording ? (
            <button
              type="button"
              onClick={() => onJumpToRecordingAtAlert(alert)}
              className="focus-ring inline-flex items-center gap-2 rounded-md border border-line px-3 py-2 text-xs font-medium text-ink hover:border-ink/40"
              title="Open the recording review for this session, seeked to this alert's moment"
            >
              <Film size={14} /> View recording at this moment
            </button>
          ) : null}
          {hasData ? (
            <button type="button" onClick={() => setExpanded((value) => !value)} className="focus-ring rounded-md border border-line px-3 py-2 text-xs font-medium text-ink hover:border-ink/40">
              {expanded ? "Hide details" : "Show details"}
            </button>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {/* F6.4: session actions and alert actions are separate labeled groups;
              the session group renders only when an action is valid for the
              joined session's status. */}
          {sessionActions.length ? (
            <ActionGroup label={sessionGroupLabel}>
              {sessionActions.map((action) =>
                action === "approve" ? (
                  // Approve also archives this alert (frontend orchestrates
                  // approve → archive), targeting the JOINED session.
                  <ActionTooltip key="approve" tip={`${SESSION_ACTION_INFO.approve.tooltip} Also archives this alert.`}>
                    <button
                      type="button"
                      onClick={() => onApproveArchive(alert, joined?.session_id)}
                      className="focus-ring rounded-md border border-line px-2.5 py-1.5 text-xs font-medium text-ink hover:border-ink/40"
                    >
                      {SESSION_ACTION_INFO.approve.label}
                    </button>
                  </ActionTooltip>
                ) : (
                  <SessionActionButton key={action} action={action} targetLabel={candidateIdOf(alert)} onRun={(chosen) => onAction(chosen, actionTarget)} />
                )
              )}
            </ActionGroup>
          ) : joinState === "unavailable" ? (
            // F6 review: the join fetch failed — say so instead of guessing.
            <span className="text-xs text-muted">Session status unavailable — archive only.</span>
          ) : null}
          <ActionGroup label="Alert">
            <ActionTooltip tip={archiveInfo.tooltip}>
              <button
                type="button"
                onClick={() => onArchive([alert.id], alert.archived ? "unarchive" : "archive")}
                className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs font-medium text-ink hover:border-ink/40"
              >
                {alert.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />} {archiveInfo.label}
              </button>
            </ActionTooltip>
            {/* ALERT-1: one-click Suppress derived from the row's own fields
                (no typing). For a dispute_raised row this hushes the DISPUTED
                type. Suppresses the alert only — never the lock/evidence. */}
            <ActionTooltip tip={`${suppressInfo.tooltip}${suppressType !== alert.type ? ` (type: ${suppressType})` : ""}`}>
              <button
                type="button"
                onClick={() => onSuppress(suppressRequest)}
                className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs font-medium text-ink hover:border-ink/40"
              >
                {alreadySuppressed ? <Undo2 size={14} /> : <BellOff size={14} />} {suppressInfo.label}
              </button>
            </ActionTooltip>
          </ActionGroup>
        </div>
      </div>

      {expanded && hasData ? (
        <pre className="mt-4 max-h-72 overflow-auto rounded-md bg-ink p-4 text-xs text-white">{JSON.stringify(alert.data, null, 2)}</pre>
      ) : null}
    </div>
  );
}
