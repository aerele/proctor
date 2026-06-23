// frontend/src/admin/views/SessionDetailCard.tsx
// Session detail modal card, extracted verbatim from App.tsx (F3).
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertTriangle, Bell, Camera, CheckCircle2, Clock, Film, Lock, Mic, MonitorUp, RefreshCw, UploadCloud, Video, X } from "lucide-react";
import { fetchSessionCardDetail, fetchSubmissionEvents, recordingDataAvailable } from "../../api";
import { candidateIdOf } from "../../identity";
import { validSessionActionsFor } from "../alertActions";
import { alertsForSession, approxRecordingSeconds, captureSourceLabel, formatApproxDuration, pendingUploadAffordance, storedCameraChunkCount, storedChunkCount, viewEventsAffordance, viewRecordingAffordance } from "../sessionDetail";
import type { Alert, EnforcementExemptions, RecordingSession, SessionAction, SessionCardDetail, SubmissionEvent } from "../../types";
import { Metric } from "../../ui/Metric";
import { ActionTooltip } from "../../ui/ActionTooltip";
import { ActionGroup, SessionActionButton } from "../actions";
import { AlertField } from "./AlertField";

export function SessionDetailCard({ password, session, alerts, alertsLoaded, onClose, onAction, onViewRecording, onViewAlerts }: {
  password: string;
  session: RecordingSession;
  alerts: Alert[];
  alertsLoaded: boolean;
  onClose: () => void;
  onAction: (action: SessionAction, opts: { sessionId?: string; usernames?: string[]; exemptions?: EnforcementExemptions }) => Promise<void>;
  onViewRecording: (session: RecordingSession) => void;
  onViewAlerts: (session: RecordingSession) => void;
}) {
  const [detail, setDetail] = useState<SessionCardDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [submissions, setSubmissions] = useState<SubmissionEvent[] | null>(null);
  // Bumped after an action so the detail refetches even when the (possibly
  // filtered-out) list row no longer changes underneath us.
  const [refreshNonce, setRefreshNonce] = useState(0);

  // Load the least-privilege backend detail; a null (endpoint not deployed)
  // leaves `detail` empty and the card renders from the list row alone.
  useEffect(() => {
    let cancelled = false;
    setDetailLoading(true);
    void (async () => {
      try {
        const next = await fetchSessionCardDetail(password, session.session_id);
        if (!cancelled) setDetail(next);
      } catch {
        // Non-fatal: the card still shows the list-row fields.
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [password, session.session_id, session.status, refreshNonce]);

  // Submission-time markers for this candidate+contest (existing endpoint; the
  // recordings timeline uses the same source). null = still loading / none.
  useEffect(() => {
    let cancelled = false;
    setSubmissions(null);
    void (async () => {
      try {
        const events = await fetchSubmissionEvents(password, candidateIdOf(session), session.contest_slug || undefined);
        if (!cancelled) setSubmissions(events ?? []);
      } catch {
        if (!cancelled) setSubmissions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [password, session.hackerrank_username, session.candidate_id, session.contest_slug]);

  // The truthful status: the refetched detail wins over the click-time row.
  const status = detail?.status || session.status;
  // REC-4: the headline "Chunks" + duration math read the GROUND-TRUTH stored
  // count (GCS-listed objects that actually exist), not the over-counting mint
  // counter. Falls back to chunk_count / the list-row value for an older backend.
  const chunkCount = storedChunkCount(detail, session.chunk_count);
  // F10.1: the separate camera stream's chunk counter (0 for legacy sessions /
  // older backends). REC-4: prefer the stored count here too.
  const cameraChunkCount = storedCameraChunkCount(detail, session.camera_chunk_count);
  // REC-5: chunks the candidate produced but the server can't prove are stored.
  const pending = pendingUploadAffordance(detail, status);
  const actions = validSessionActionsFor(status);
  const sessionAlerts = useMemo(() => alertsForSession(alerts, session), [alerts, session]);
  const sortedSubmissions = useMemo(
    () => (submissions ? [...submissions].sort((a, b) => a.submitted_at.localeCompare(b.submitted_at)) : []),
    [submissions]
  );
  const rosterId = detail?.roster_unique_id || detail?.roll_number || "";

  const runCardAction = (action: SessionAction) => {
    void (async () => {
      await onAction(action, { sessionId: session.session_id });
      setRefreshNonce((n) => n + 1);
    })();
  };

  // F5.5: per-session enforcement exemption toggle (action "exempt" with a
  // one-key payload; the server merges, so the other toggle is untouched).
  const toggleExemption = (key: keyof EnforcementExemptions) => {
    void (async () => {
      await onAction("exempt", {
        sessionId: session.session_id,
        exemptions: { [key]: !(detail?.enforcement_exemptions?.[key] === true) }
      });
      setRefreshNonce((n) => n + 1);
    })();
  };

  // F6 review: Recordings-tab deep links. "View events" stays usable for
  // zero-chunk sessions (the activity log needs no chunks); both disable in
  // demo mode for candidates outside the seeded recording dataset.
  const dataAvailable = recordingDataAvailable(candidateIdOf(session));
  const recordingLink = viewRecordingAffordance(chunkCount, dataAvailable);
  const eventsLink = viewEventsAffordance(dataAvailable);

  // F6 review — modal a11y, mirroring the M10 FullscreenGate fix: focus moves
  // into the dialog on open (the close button), Escape closes, and Tab /
  // Shift+Tab cycle within the card so the page behind stays unreachable.
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);
  const onDialogKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const items = focusables ? Array.from(focusables) : [];
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !dialogRef.current?.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    // Modal overlay: click-outside, Escape, or the X closes; clicks inside
    // don't bubble out.
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Session detail for ${candidateIdOf(session)}`}
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 sm:p-10"
      onClick={onClose}
      onKeyDown={onDialogKeyDown}
    >
      <section
        ref={dialogRef}
        tabIndex={-1}
        className="focus:outline-none w-full max-w-3xl rounded-lg border border-line bg-panel p-5 shadow-subtle"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold">{candidateIdOf(session)}</h2>
              <span className="rounded-full border border-line px-2.5 py-0.5 text-xs font-medium text-ink">{status}</span>
              {detailLoading ? <RefreshCw size={14} className="animate-spin text-muted" /> : null}
            </div>
            {session.name ? <p className="mt-1 text-sm text-muted">{session.name}</p> : null}
            <p className="mt-1 font-mono text-xs text-muted">{session.session_id}</p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Close session detail"
            className="focus-ring rounded-md border border-line p-2 text-ink hover:border-ink/40"
          >
            <X size={16} />
          </button>
        </div>

        {/* INFO — identity + where/when + the IP block. */}
        <div className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <AlertField label="Roster ID" value={rosterId || "—"} mono />
          <AlertField label="Room" value={session.room || "—"} />
          <AlertField label="Contest" value={session.contest_slug || "—"} mono />
          <AlertField label="Started" value={session.created_at ? new Date(session.created_at).toLocaleString() : "—"} />
          <AlertField label="Start IP" value={detail?.start_ip || "—"} mono />
          <AlertField label="Current IP" value={detail?.current_ip || "—"} mono />
        </div>
        {detail && detail.ip_change_count > 0 ? (
          <p className="mt-3 inline-flex items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            <AlertTriangle size={14} /> IP changed {detail.ip_change_count} time{detail.ip_change_count === 1 ? "" : "s"} mid-exam.
          </p>
        ) : null}
        {/* REC-5: a pending backlog on a STILL-ACTIVE session is the loud
            "recording may not be flushing" signal a proctor needs to catch. */}
        {pending.show && pending.tone === "warning" ? (
          <p className="mt-3 inline-flex items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            <UploadCloud size={14} /> {pending.count} chunk{pending.count === 1 ? "" : "s"} not yet uploaded — recording may not be flushing.
          </p>
        ) : null}

        {/* F5.3: locked-by-enforcement context — the candidate self-locked via
            the fullscreen ladder; the room's UNLOCK code (invigilator portal)
            or Unlock here releases it. */}
        {status === "locked" && detail?.locked_reason === "fullscreen_enforcement" ? (
          <p className="mt-3 inline-flex items-center gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            <Lock size={14} /> Locked by FULLSCREEN ENFORCEMENT (countdown expired or exit limit) — the room proctor's unlock code (or Unlock here / on the invigilator portal) releases it.
          </p>
        ) : null}

        {/* F5.5: per-session enforcement exemptions (legit environment problems). */}
        {detail && status !== "ended" ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-line bg-white/60 px-3 py-2 text-xs">
            <span className="font-semibold uppercase tracking-wide text-muted">Enforcement exemptions</span>
            <ActionTooltip tip="Exempt this session from the fullscreen hard-block (exits then log as plain events).">
              <button
                type="button"
                onClick={() => toggleExemption("fullscreen")}
                className={`focus-ring rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
                  detail.enforcement_exemptions?.fullscreen === true ? "border-warning/50 bg-warning/15 text-warning" : "border-line bg-white/60 text-muted"
                }`}
              >
                Fullscreen{detail.enforcement_exemptions?.fullscreen === true ? ": exempt" : ""}
              </button>
            </ActionTooltip>
            <ActionTooltip tip="Exempt this session from switch-away (tab_away) alerting — episodes still log as events.">
              <button
                type="button"
                onClick={() => toggleExemption("switch_away")}
                className={`focus-ring rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
                  detail.enforcement_exemptions?.switch_away === true ? "border-warning/50 bg-warning/15 text-warning" : "border-line bg-white/60 text-muted"
                }`}
              >
                Switch-away{detail.enforcement_exemptions?.switch_away === true ? ": exempt" : ""}
              </button>
            </ActionTooltip>
          </div>
        ) : null}

        {/* STATS — recording, alerts join, submissions, doc activity counters. */}
        <div className="mt-4 flex flex-wrap gap-3 text-sm">
          <Metric icon={<Video size={16} />} label="Chunks" value={String(chunkCount)} />
          <Metric icon={<Clock size={16} />} label="Recorded" value={formatApproxDuration(approxRecordingSeconds(chunkCount))} />
          {/* F10.1: the separate camera stream's own chunk counter (only shown
              when this session actually uploaded camera chunks). */}
          {cameraChunkCount > 0 ? <Metric icon={<Camera size={16} />} label="Camera chunks" value={String(cameraChunkCount)} /> : null}
          {/* REC-5: pending-upload backlog — only meaningful when > 0 (chunks
              produced but not provably stored). Warning tone while active. */}
          {pending.show ? (
            <Metric
              icon={<UploadCloud size={16} className={pending.tone === "warning" ? "text-warning" : "text-muted"} />}
              label="Pending upload"
              value={`${pending.count} chunk${pending.count === 1 ? "" : "s"}`}
            />
          ) : null}
          <Metric icon={<Bell size={16} />} label="Alerts" value={alertsLoaded ? String(sessionAlerts.length) : "…"} />
          <Metric icon={<CheckCircle2 size={16} />} label="Submissions" value={submissions === null ? "…" : String(sortedSubmissions.length)} />
          {detail ? <Metric icon={<Activity size={16} />} label="Events" value={`${detail.event_count} (${detail.clipboard_event_count} clipboard · ${detail.focus_event_count} focus)`} /> : null}
        </div>

        {/* CAPTURE — F6.6: last-reported per-source capture state (from the
            heartbeat's composite recording_state). The recorded webm is the
            direct screen stream with mic audio mixed in. F10.1: when this
            session uploaded camera chunks the camera row reads as a real
            (separate, low-res) recording; otherwise the camera was
            live-monitor only and the labels say so plainly. Hidden until a
            composite heartbeat reported it. */}
        {detail?.capture_state ? (
          <div className="mt-4 rounded-md border border-line bg-white/60 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Capture — last reported</p>
            <ul className="mt-2 space-y-1.5 text-xs">
              <li className="flex flex-wrap items-center gap-2">
                <MonitorUp size={14} className="shrink-0 text-muted" aria-hidden />
                <span className="w-24 font-medium text-ink">Screen</span>
                <span className="text-muted">{captureSourceLabel("screen", detail.capture_state.screen)}</span>
              </li>
              <li className="flex flex-wrap items-center gap-2">
                <Camera size={14} className="shrink-0 text-muted" aria-hidden />
                <span className="w-24 font-medium text-ink">Camera</span>
                <span className="text-muted">{captureSourceLabel("camera", detail.capture_state.camera, cameraChunkCount > 0)}</span>
              </li>
              <li className="flex flex-wrap items-center gap-2">
                <Mic size={14} className="shrink-0 text-muted" aria-hidden />
                <span className="w-24 font-medium text-ink">Microphone</span>
                <span className="text-muted">{captureSourceLabel("microphone", detail.capture_state.microphone)}</span>
              </li>
            </ul>
          </div>
        ) : null}

        {/* SUBMISSION TIMES — newest-last, capped so a heavy solver stays tidy. */}
        {sortedSubmissions.length ? (
          <div className="mt-4 rounded-md border border-line bg-white/60 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Submissions</p>
            <ul className="mt-2 space-y-1 text-xs">
              {sortedSubmissions.slice(0, 8).map((event) => (
                <li key={event.submission_id} className="flex flex-wrap items-center gap-2">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${event.valid ? "bg-accent" : "bg-danger"}`} aria-hidden />
                  <time className="font-mono text-muted" dateTime={event.submitted_at}>{new Date(event.submitted_at).toLocaleString()}</time>
                  {event.challenge_name ? <span className="font-medium text-ink">{event.challenge_name}</span> : null}
                  {event.status ? <span className="text-muted">{event.status}</span> : null}
                </li>
              ))}
            </ul>
            {sortedSubmissions.length > 8 ? (
              <p className="mt-2 text-xs text-muted">+{sortedSubmissions.length - 8} more — see the recording timeline markers.</p>
            ) : null}
          </div>
        ) : null}

        {/* ACTIONS + LINKS — only the status-valid session actions render
            (ended → none, view-only); links jump to the scoped tabs. */}
        <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-line pt-4">
          {actions.length ? (
            <ActionGroup label={`Session — ${status}`}>
              {actions.map((action) => (
                <SessionActionButton
                  key={action}
                  action={action}
                  targetLabel={candidateIdOf(session)}
                  onRun={runCardAction}
                />
              ))}
            </ActionGroup>
          ) : (
            <span className="text-xs text-muted">
              {status === "ended" ? "This session has ended — view-only." : "No session actions apply to this status."}
            </span>
          )}
          <div className="ml-auto flex flex-wrap gap-2">
            <ActionTooltip tip={recordingLink.tip}>
              <button
                type="button"
                onClick={() => onViewRecording(session)}
                disabled={recordingLink.disabled}
                title={recordingLink.disabled ? recordingLink.tip : undefined}
                className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs font-medium text-ink hover:border-ink/40 disabled:opacity-50"
              >
                <Film size={14} /> View recording
              </button>
            </ActionTooltip>
            {/* F6 review: the chunk-free events path — same deep link, the
                Recordings tab's activity log renders without any chunks. */}
            <ActionTooltip tip={eventsLink.tip}>
              <button
                type="button"
                onClick={() => onViewRecording(session)}
                disabled={eventsLink.disabled}
                title={eventsLink.disabled ? eventsLink.tip : undefined}
                className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs font-medium text-ink hover:border-ink/40 disabled:opacity-50"
              >
                <Activity size={14} /> View events
              </button>
            </ActionTooltip>
            <ActionTooltip tip="Open the Live alerts tab filtered to this candidate's alerts.">
              <button
                type="button"
                onClick={() => onViewAlerts(session)}
                className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs font-medium text-ink hover:border-ink/40"
              >
                <Bell size={14} /> View alerts{alertsLoaded ? ` (${sessionAlerts.length})` : ""}
              </button>
            </ActionTooltip>
          </div>
        </div>
      </section>
    </div>
  );
}

