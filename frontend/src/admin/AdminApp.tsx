// frontend/src/admin/AdminApp.tsx
// Admin console root (moved WHOLE + verbatim from App.tsx, F5). Per the #87
// decomp plan §2.2, AdminApp is moved as one unit; it already delegates to the
// extracted smart-panels (ContestsPanel/TemplatesPanel/ProblemBank/...) and the
// F3 leaf views (StatsDashboard/SessionsView/AlertsConsole/...). Its body is
// state + effects + the view-switch chain plus the W3 nav chrome
// (GROUP_ICONS/VIEW_ICONS/GroupTab/AdminTab).
import { useEffect, useRef, useState } from "react";
import { Activity, Award, Bell, BrainCircuit, ClipboardList, Download, Film, LayoutTemplate, ListChecks, Lock, Network, Search, ShieldCheck, UserCheck, Users } from "lucide-react";
import { adjustContestExamTime, adminPassword, adminPasswordHash, alertAction, fetchAdminSessions, fetchAdminStats, fetchAlertSettings, fetchAlerts, fetchAllReviews, fetchContests, fetchIpReport, fetchReviewRoster, fetchSessionDetails, fetchSessionsList, parseRosterInput, saveAlertSettings, saveReviewRoster, sessionAction, sha256Hex } from "../api";
import { RecordingReview } from "../RecordingReview";
import { addAllToSelection, removeFromSelection, toggleId } from "../alertSelection";
import { alertJoinState, joinableSessions } from "./alertActions";
import { computeClockSkewMs } from "../examTime";
import { ProblemBankSection } from "./ProblemBank";
import { ContestsPanel } from "./ContestsPanel";
import { TemplatesPanel } from "./TemplatesPanel";
import { SystemHealthPanel } from "./SystemHealthPanel";
import { ResultsPanel } from "./ResultsPanel";
import { EvaluationPanel } from "./EvaluationPanel";
import { PeoplePanel } from "./PeoplePanel";
import { defaultContestSelection, searchWithContestParam } from "./contestAdmin";
import { ADMIN_NAV_GROUPS, groupOfView, type AdminView } from "./adminNav";
import { cameraRecordingFromForm } from "../cameraRecording";
import { enforcementSettingsFromForm } from "../enforcementSettings";
import type { AdminStats, AdminStatsResponse, Alert, AlertFilters, AlertSettings, ContestSummary, EnforcementExemptions, ExamTimeRequest, IpReportCandidate, IpReportResponse, IpReportScope, ProctorSettings, RecordingSession, ReviewRosterSummary, SessionAction } from "../types";
import { candidateIdOf } from "../identity";
import { Field } from "../ui/Field";
import { Shell } from "../ui/Shell";
import type { SessionsStatusFilter } from "../sessionFilters";
import { buildReviewsCsv, buildDetailsCsv } from "./csv";
import { StatsDashboard } from "./views/StatsDashboard";
import { SessionsView } from "./views/SessionsView";
import { SessionDetailCard } from "./views/SessionDetailCard";
import { AttendancePanel } from "./views/AttendancePanel";
import { IpReportView } from "./views/IpReportView";
import { ContestScopePicker } from "./views/ContestScopePicker";
import { ExamTimeCard, type ExamTimeCardScope } from "./views/ExamTimeCard";
import { ReviewSessionCard } from "./views/ReviewSessionCard";
import { AlertsConsole } from "./views/AlertsConsole";
import { CandidateRosterSection, ProctorAlertTypesSection, ContestEvalAlertTypesSection, ReviewRosterSection } from "./views/Settings";

// Auto-poll interval for the admin Live stats / Live alerts views.
const ADMIN_POLL_INTERVAL_MS = 5000;

export function AdminApp() {
  const [view, setView] = useState<AdminView>("stats");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [settings, setSettings] = useState<ProctorSettings>({ start_at: "", end_at: "" });
  const [settingsMessage, setSettingsMessage] = useState("");
  const [result, setResult] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [alertsLoading, setAlertsLoading] = useState(false);
  const [alertsLoaded, setAlertsLoaded] = useState(false);
  // S-D (A1): the global contest scope seeds from THIS TAB's URL ?contest=
  // param, so two browser tabs run two parallel drives independently.
  const [alertFilters, setAlertFilters] = useState<AlertFilters>(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("contest")?.trim() ?? "";
    return fromUrl ? { contest_slug: fromUrl } : {};
  });
  // S-D: the contests list feeding the selector dropdown (and the Contests
  // tab keeps it fresh via onContestsChanged).
  const [adminContests, setAdminContests] = useState<ContestSummary[] | null>(null);
  // One-shot guard: the single-open-contest auto-default applies once per tab.
  const contestDefaultApplied = useRef(false);
  const [rooms, setRooms] = useState<string[]>([]);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  // S5: exam-time card state. examEndAt/examSkewMs refresh from every stats
  // response (incl. the 5 s auto-poll), so another admin's change shows live.
  // endNowArmed = the two-click confirm for "End exam now".
  const [examEndAt, setExamEndAt] = useState("");
  const [examSkewMs, setExamSkewMs] = useState(0);
  const [examTimeBusy, setExamTimeBusy] = useState(false);
  const [endNowArmed, setEndNowArmed] = useState(false);
  const [examTimeInput, setExamTimeInput] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [actionMessage, setActionMessage] = useState("");
  const [alertSettings, setAlertSettings] = useState<AlertSettings | null>(null);
  const [alertSettingsLoading, setAlertSettingsLoading] = useState(false);
  const [alertSettingsMessage, setAlertSettingsMessage] = useState("");
  // S2: room labels for the student room dropdown, edited as comma-separated text.
  const [roomsText, setRoomsText] = useState("");
  // F10.1: camera-recording knobs. fps/width are TEXT state so a cleared field
  // stays blank while typing; cameraRecordingFromForm maps blank/invalid text
  // to the defaults at save time (never 0 — the wave-2 blank-saves-0 finding).
  const [cameraRecEnabled, setCameraRecEnabled] = useState(true);
  const [cameraFpsText, setCameraFpsText] = useState("10");
  const [cameraWidthText, setCameraWidthText] = useState("640");
  // OMR P1: screen-marker fiducials flag — default OFF (the live exam runs
  // with this stack flag-off; only an explicit save turns it on).
  const [screenMarkersEnabled, setScreenMarkersEnabled] = useState(false);
  // Wave-3: the F5.3 enforcement knobs get the same TEXT-state treatment —
  // clearing "Fullscreen exit limit" used to save 0 (lock on the FIRST exit)
  // silently; enforcementSettingsFromForm maps blank/invalid to 20 s / 2 exits.
  const [reentrySecondsText, setReentrySecondsText] = useState("20");
  const [exitLimitText, setExitLimitText] = useState("2");
  // Review roster (multi-reviewer workflow): pasted usernames + the coverage
  // summary. `rosterUnavailable` flags a 404 (endpoint not deployed yet).
  const [rosterText, setRosterText] = useState("");
  const [rosterSummary, setRosterSummary] = useState<ReviewRosterSummary | null>(null);
  const [rosterLoading, setRosterLoading] = useState(false);
  const [rosterMessage, setRosterMessage] = useState("");
  const [rosterUnavailable, setRosterUnavailable] = useState(false);
  const [exportingReviews, setExportingReviews] = useState(false);
  // B: "Download all details" CSV button busy state (mirrors exportingReviews).
  const [downloadingDetails, setDownloadingDetails] = useState(false);
  // A2/A4: the GCS-free Sessions drill-down — its list, loading flag, and the
  // status the active stat-card drilled into ("" = Total, no status filter).
  const [sessionsList, setSessionsList] = useState<RecordingSession[] | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsStatusFilter, setSessionsStatusFilter] = useState<SessionsStatusFilter>("");
  const [sessionsUnavailable, setSessionsUnavailable] = useState(false);
  // F6.3: the session whose detail card is open (a snapshot of the clicked row;
  // the render prefers the fresh sessionsList match so the card tracks reloads).
  const [detailSession, setDetailSession] = useState<RecordingSession | null>(null);
  // F6.3 state-based deep link Sessions → Recordings: load this candidate (and
  // prefer this exact session) when the Recordings tab mounts; one-shot (the
  // RecordingReview consumes it and we clear it).
  const [recordingDeepLink, setRecordingDeepLink] = useState<{ username: string; usernameNorm?: string; sessionId?: string } | null>(null);
  // F6.3 one-shot client-side candidate filter for the alerts console ("View
  // alerts" on the detail card). "" = off; cleared via the chip in the console.
  const [alertCandidateFilter, setAlertCandidateFilter] = useState("");

  // S7: IP report state — the report payload, scope (live = non-ended only),
  // loading flag, and the 404-degrade marker (endpoint not deployed yet).
  const [ipReport, setIpReport] = useState<IpReportResponse | null>(null);
  const [ipReportLoading, setIpReportLoading] = useState(false);
  const [ipScope, setIpScope] = useState<IpReportScope>("live");
  const [ipReportUnavailable, setIpReportUnavailable] = useState(false);

  // F6.4: ALL session docs (status "" = no filter) under the current contest
  // scope, used by the alerts console to join each alert to its candidate's
  // CURRENT session status so rows render only the actions valid for it.
  // null = not loaded yet, sessions-list not deployed, OR the list came back
  // truncated (live rows may be missing — joinableSessions) → rows fall back
  // to the full action set (incomplete data must not lose admin capability).
  const [alertSessions, setAlertSessions] = useState<RecordingSession[] | null>(null);
  // F6 review: true when the last sessions-list fetch FAILED (non-404). With
  // no join data to keep, rows degrade to archive-only + a "session status
  // unavailable" note (alertJoinState) instead of guessing at actions.
  const [alertSessionsFailed, setAlertSessionsFailed] = useState(false);

  // F6 review: the join fetch is DECOUPLED from the alerts load — a failing
  // sessions-list must never blank the alerts console (the join is an
  // enhancement; the alerts are the product).
  const loadAlerts = async (filters?: AlertFilters) => {
    setAlertsLoading(true);
    setError("");
    try {
      const response = await fetchAlerts(password, filters ?? alertFilters);
      const sorted = [...response.alerts].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
      setAlerts(sorted);
      if (response.rooms) setRooms(response.rooms);
      setAlertsLoaded(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAlertsLoading(false);
    }
    await loadAlertSessions(filters);
  };

  // F6.4: refresh the status-join data for the alerts console. Errors are
  // non-fatal (the join is an enhancement; alerts stay usable without it); a
  // 404 or a TRUNCATED list maps to null via joinableSessions → rows fall back
  // to the full action set rather than trusting an incomplete join.
  const loadAlertSessions = async (filters?: AlertFilters) => {
    try {
      const active = filters ?? alertFilters;
      const list = await fetchSessionsList(password, { status: "", contestSlug: active.contest_slug });
      setAlertSessions(joinableSessions(list));
      setAlertSessionsFailed(false);
    } catch {
      // Keep any previous join data — stale statuses beat dropping the buttons.
      // The failed flag only bites when there is nothing kept (alertJoinState).
      setAlertSessionsFailed(true);
    }
  };

  const loadStats = async (filters?: AlertFilters) => {
    setStatsLoading(true);
    setError("");
    try {
      // B7: scope the live counts to the same contest the admin filtered alerts by;
      // also pass the room filter so counts and the alerts view share scope.
      const active = filters ?? alertFilters;
      const response = await fetchAdminStats(password, active.contest_slug, active.room);
      setStats(response.stats);
      captureExamTime(response);
      if (response.rooms) setRooms(response.rooms);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStatsLoading(false);
    }
  };

  // S5: capture the exam end time + clock skew from a stats response. Skew is
  // computed at receipt time (server_now vs local now) — recomputing later
  // against a stale stamp would drift.
  const captureExamTime = (response: AdminStatsResponse) => {
    if (response.end_at === undefined) return; // backend without S5 yet
    setExamEndAt(response.end_at);
    setExamSkewMs(computeClockSkewMs(response.server_now, Date.now()));
  };

  // F3 (E2E live): the Live exam-time card follows the GLOBAL contest scope.
  // Where its display value comes from and where its quick-actions write:
  //   - no scope            → the global settings schedule shown read-only
  //                           (clearly labeled; editing disabled)
  //   - scoped, real row    → THAT contest's window via contest-exam-time —
  //                           the same API the Contest → Detail panel uses
  //   - scoped, unknown slug (deep link / list still loading) → editor disabled,
  //     never silently writing the wrong schedule
  const examTimeScope: ExamTimeCardScope = (() => {
    const slug = alertFilters.contest_slug ?? "";
    // Exam-time is per-contest: with no scoped contest there is nothing to edit.
    if (!slug) return { kind: "unscoped" as const };
    const match = (adminContests ?? []).find((contest) => contest.slug === slug) ?? null;
    if (!match) return { kind: "unknown" as const, slug };
    return { kind: "contest" as const, slug };
  })();

  // S5: apply an exam-time change; outcomes surface through the existing
  // actionMessage banner, and stats reload so counts reflect an end-now.
  // F3: exam-time is per-contest — only a scoped real contest can be edited,
  // writing through contest-exam-time (its OWN end_at + end-now sweep over ITS
  // sessions); any other scope is rejected before the request.
  const runExamTime = async (body: ExamTimeRequest) => {
    if (examTimeScope.kind !== "contest") {
      setError("Select a contest from the filter to adjust its exam time.");
      return;
    }
    setExamTimeBusy(true);
    setError("");
    setActionMessage("");
    try {
      const response = await adjustContestExamTime(password, examTimeScope.slug, body);
      setExamEndAt(response.end_at);
      setExamSkewMs(computeClockSkewMs(response.server_now, Date.now()));
      setEndNowArmed(false);
      setExamTimeInput("");
      setActionMessage(body.end_now
        ? `Exam ended — ${response.ended_count} live session(s) force-ended. Students see the end within ~15 seconds.`
        : `Exam end time set to ${new Date(response.end_at).toLocaleString()}. Students see it within ~15 seconds.`);
      await loadStats();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setExamTimeBusy(false);
    }
  };

  // A2/A4: load the GCS-free Sessions drill-down list from the sessions-list
  // endpoint, which returns ALL session docs classified by the SAME rules as the
  // stat cards (so the list matches the card counts) and reaches zero-chunk
  // pending_approval sessions the recorded-chunks-only picker would hide. The status
  // is SERVER-driven: callers pass it explicitly via statusOverride to dodge the
  // setState race (drillToSessions / the status dropdown set the filter state and
  // load in the same tick, so reading sessionsStatusFilter here would be stale).
  // A null response means the sessions-list endpoint is not deployed yet → the
  // Sessions view shows a "not available" note.
  const loadSessions = async (filters?: AlertFilters, statusOverride?: SessionsStatusFilter) => {
    setSessionsLoading(true);
    setError("");
    try {
      const active = filters ?? alertFilters;
      const status = statusOverride ?? sessionsStatusFilter;
      const list = await fetchSessionsList(password, {
        status,
        contestSlug: active.contest_slug,
        room: active.room
      });
      if (list === null) {
        setSessionsUnavailable(true);
        setSessionsList([]);
        return;
      }
      setSessionsUnavailable(false);
      setSessionsList(list.sessions);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSessionsLoading(false);
    }
  };

  // A2: open the Sessions drill-down from a clicked stat card. Sets the status
  // filter, switches to the Sessions view, and loads the list under the current
  // contest scope. The chosen status is passed EXPLICITLY into loadSessions so the
  // right status loads without depending on the just-set (and still-stale) state.
  const drillToSessions = (status: SessionsStatusFilter) => {
    setSessionsStatusFilter(status);
    setView("sessions");
    void loadSessions(undefined, status);
  };

  // S7: load the IP-wise report. The scope is passed EXPLICITLY (same
  // stale-state dodge as loadSessions); the contest scope follows the global
  // filter. A null response = endpoint not deployed → "unavailable" note.
  const loadIpReport = async (scopeOverride?: IpReportScope, filters?: AlertFilters) => {
    setIpReportLoading(true);
    setError("");
    try {
      const active = filters ?? alertFilters;
      const scope = scopeOverride ?? ipScope;
      const report = await fetchIpReport(password, { contestSlug: active.contest_slug, scope });
      if (report === null) {
        setIpReportUnavailable(true);
        setIpReport(null);
        return;
      }
      setIpReportUnavailable(false);
      setIpReport(report);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIpReportLoading(false);
    }
  };

  // Auto-load alerts the first time the unlocked admin opens the alerts tab.
  useEffect(() => {
    if (!unlocked || view !== "alerts" || alertsLoaded) return;
    let cancelled = false;
    void (async () => {
      setAlertsLoading(true);
      setError("");
      // F6.4: the status-join data loads alongside the alerts themselves so the
      // first render already shows the contextual action buttons. F6 review:
      // the two fetches are DECOUPLED (allSettled) — a non-404 sessions-list
      // failure must not blank the console; the alerts render and the rows
      // degrade per alertJoinState (archive-only + note).
      const [alertsResult, sessionsResult] = await Promise.allSettled([
        fetchAlerts(password, alertFilters),
        fetchSessionsList(password, { status: "", contestSlug: alertFilters.contest_slug })
      ]);
      if (cancelled) return;
      if (alertsResult.status === "fulfilled") {
        const response = alertsResult.value;
        const sorted = [...response.alerts].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
        setAlerts(sorted);
        if (response.rooms) setRooms(response.rooms);
        setAlertsLoaded(true);
      } else {
        const cause = alertsResult.reason;
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      if (sessionsResult.status === "fulfilled") {
        setAlertSessions(joinableSessions(sessionsResult.value));
        setAlertSessionsFailed(false);
      } else {
        setAlertSessionsFailed(true);
      }
      setAlertsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlocked, view, alertsLoaded, password]);

  // S-D (A1): load the contests list for the selector once unlocked; apply the
  // single-open-contest auto-default ONCE per tab (an explicit URL ?contest=
  // always wins inside defaultContestSelection).
  useEffect(() => {
    if (!unlocked) return;
    let cancelled = false;
    void fetchContests(password, true)
      .then((list) => {
        if (cancelled) return;
        setAdminContests(list);
        if (!contestDefaultApplied.current) {
          contestDefaultApplied.current = true;
          const fromUrl = new URLSearchParams(window.location.search).get("contest")?.trim() ?? "";
          const selection = defaultContestSelection(list, fromUrl);
          if (selection && selection !== fromUrl) selectContest(selection);
        }
      })
      .catch(() => {
        if (!cancelled) setAdminContests([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlocked, password]);

  // Auto-load stats the first time the unlocked admin opens the stats tab.
  useEffect(() => {
    if (!unlocked || view !== "stats" || stats !== null) return;
    let cancelled = false;
    void (async () => {
      setStatsLoading(true);
      setError("");
      try {
        const response = await fetchAdminStats(password, alertFilters.contest_slug, alertFilters.room);
        if (cancelled) return;
        setStats(response.stats);
        captureExamTime(response);
        if (response.rooms) setRooms(response.rooms);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setStatsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlocked, view, stats, password]);

  // ADMIN AUTO-POLL: while on Live stats or Live alerts, refresh on a ~5s
  // interval IN ADDITION to the manual Refresh button. The interval is cleared on
  // unmount and whenever the view/filters change (a new effect run replaces it).
  // Loading flags are deliberately NOT in the dep list (avoids the B0 self-cancel
  // bug); the poll fires its own request each tick regardless of in-flight state.
  useEffect(() => {
    if (!unlocked || (view !== "stats" && view !== "alerts")) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        if (view === "stats") {
          const response = await fetchAdminStats(password, alertFilters.contest_slug, alertFilters.room);
          if (cancelled) return;
          setStats(response.stats);
          captureExamTime(response);
          if (response.rooms) setRooms(response.rooms);
        } else {
          // F6.4: the join data refreshes on the same cadence as the alerts so
          // the contextual buttons track live status changes. F6 review:
          // decoupled (allSettled) — one stream failing must not drop the other.
          const [alertsResult, sessionsResult] = await Promise.allSettled([
            fetchAlerts(password, alertFilters),
            fetchSessionsList(password, { status: "", contestSlug: alertFilters.contest_slug })
          ]);
          if (cancelled) return;
          if (alertsResult.status === "fulfilled") {
            const response = alertsResult.value;
            const sorted = [...response.alerts].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
            setAlerts(sorted);
            if (response.rooms) setRooms(response.rooms);
            setAlertsLoaded(true);
          }
          if (sessionsResult.status === "fulfilled") {
            setAlertSessions(joinableSessions(sessionsResult.value));
            setAlertSessionsFailed(false);
          } else {
            // Keep any previous join data (stale beats dropping the buttons);
            // the flag only bites when nothing was ever kept (alertJoinState).
            setAlertSessionsFailed(true);
          }
        }
      } catch {
        // Swallow poll errors so a transient failure doesn't spam the banner;
        // the manual Refresh surfaces real errors.
      }
    };
    const timer = window.setInterval(() => void tick(), ADMIN_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlocked, view, password, alertFilters]);

  // C1: when VITE_ADMIN_PASSWORD_HASH is set, verify the typed password by hashing
  // it (sha256 hex via crypto.subtle) and comparing to the embedded hash — the
  // plain password is never shipped in the bundle. On match we KEEP the typed
  // password in state to send as x-admin-password (backend is unchanged). FALLBACK
  // (hash unset): the existing plain VITE_ADMIN_PASSWORD compare, so the :5173
  // demo with 'dev' still works.
  const unlockAdmin = async () => {
    setError("");
    const typed = passwordInput;
    if (adminPasswordHash) {
      let typedHash = "";
      try {
        typedHash = await sha256Hex(typed);
      } catch {
        setError("This browser cannot hash the password (crypto.subtle unavailable).");
        return;
      }
      if (typedHash !== adminPasswordHash) {
        setError("Invalid admin password.");
        return;
      }
    } else if (typed !== adminPassword) {
      setError("Invalid admin password.");
      return;
    }
    setPassword(typed);
    setUnlocked(true);
    setPasswordInput("");
  };

  // S-D (A1): the review search is scoped by the GLOBAL contest selector like
  // every other tab. `filters` mirrors loadStats/loadAlerts — selectContest
  // passes the NEXT filters explicitly because setState is async.
  // F4 (E2E live): a roster/person-mode candidate's STORED key is the
  // person_id ("{college}~{uid}"), which the typed display id can never
  // normalize to — so when the direct lookup comes back empty, resolve the
  // typed id against the sessions list (the same stored-key join the
  // Recordings picker uses) and re-query by the EXACT username_norm.
  const search = async (filters?: AlertFilters) => {
    setLoading(true);
    setError("");
    try {
      const contestSlug = (filters ?? alertFilters).contest_slug;
      const response = await fetchAdminSessions(username, password, contestSlug);
      let sessions = response.sessions;
      if (!sessions.length && username.trim()) {
        const typed = username.trim().toLowerCase();
        const list = await fetchSessionsList(password, { status: "", contestSlug }).catch(() => null);
        const norms = [...new Set((list?.sessions ?? [])
          .filter((row) => candidateIdOf(row).toLowerCase() === typed)
          .map((row) => row.username_norm || "")
          .filter(Boolean))];
        // Same display id under several stored keys (e.g. two colleges sharing
        // a roll number across contests when unscoped) → union a bounded few.
        for (const norm of norms.slice(0, 3)) {
          const resolved = await fetchAdminSessions(username, password, contestSlug, norm);
          sessions = sessions.concat(resolved.sessions);
        }
      }
      setResult(sessions);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  // Per-candidate or bulk remote action against the backend session-action API.
  // After it runs we refresh whatever data the current view is showing.
  // F5.5: "exempt" carries an exemptions payload (merged server-side).
  const runAction = async (action: SessionAction, opts: { sessionId?: string; usernames?: string[]; exemptions?: EnforcementExemptions }) => {
    setError("");
    setActionMessage("");
    try {
      const response = await sessionAction(password, {
        action,
        ...(opts.sessionId ? { session_id: opts.sessionId } : {}),
        ...(opts.usernames ? { usernames: opts.usernames } : {}),
        ...(opts.exemptions ? { exemptions: opts.exemptions } : {})
      });
      setActionMessage(`${action} applied to ${response.updated.length} session(s).`);
      await loadStats();
      if (view === "alerts") await loadAlerts();
      if (view === "review" && username) await search();
      setSelected(new Set());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const toggleSelected = (key: string) => {
    setSelected((current) => toggleId(current, key));
  };

  // ARCHIVE a single alert (or a set of ids) then refresh the alerts list so the
  // change is visible immediately. In demo mode the api mutates the demo store, so
  // the reload reflects the archive flag. F6.2: only the just-archived ids leave
  // the selection — the rest survives (it's ids-based, so auto-refresh keeps it);
  // unarchive keeps the selection so the admin can act on the restored alerts.
  const archiveAlerts = async (ids: string[], action: "archive" | "unarchive" = "archive") => {
    if (!ids.length) return;
    setError("");
    setActionMessage("");
    try {
      const response = await alertAction(password, { action, ids });
      setActionMessage(`${action === "archive" ? "Archived" : "Unarchived"} ${response.updated.length} alert(s)${response.missing.length ? ` (${response.missing.length} missing)` : ""}.`);
      await loadAlerts();
      if (action === "archive") setSelected((current) => removeFromSelection(current, ids));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  // APPROVE-then-ARCHIVE: the Approve button on an alert row both approves the
  // session (session-action) AND archives that alert (alert-action), orchestrated
  // here on the frontend. F6.4: when the row's status-join resolved a DIFFERENT
  // session than the alert references (e.g. the alert's session ended and the
  // candidate has a newer pending one), the caller passes that joined session id
  // so approve targets the session the buttons were rendered for — never an
  // ended doc.
  const approveAndArchive = async (alert: Alert, targetSessionId?: string) => {
    setError("");
    setActionMessage("");
    try {
      const sessionId = targetSessionId ?? alert.session_id;
      await sessionAction(password, {
        action: "approve",
        ...(sessionId ? { session_id: sessionId } : { usernames: [candidateIdOf(alert)] }),
        ...(alert.contest_slug ? { contest_slug: alert.contest_slug } : {})
      });
      await alertAction(password, { action: "archive", ids: [alert.id] });
      setActionMessage(`Approved ${candidateIdOf(alert)} and archived the alert.`);
      await loadStats();
      await loadAlerts();
      setSelected(new Set());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  // A4: APPROVE a pending session from the Sessions drill-down. Reuses the
  // sessionAction plumbing ({action:'approve', session_id}), shows a transient
  // success/error, then reloads the Sessions list and the live stats.
  const approveSession = async (session: RecordingSession) => {
    setError("");
    setActionMessage("");
    try {
      const response = await sessionAction(password, { action: "approve", session_id: session.session_id });
      setActionMessage(`Approved ${candidateIdOf(session)} (${response.updated.length} session(s)).`);
      await loadSessions();
      await loadStats();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  // ---- F6.3 Session detail card ------------------------------------------
  // Open the card for a clicked Sessions row. Alerts are lazily loaded the
  // first time a card opens so its "Alerts" stat can join the live alert list
  // (the alerts tab may never have been visited yet).
  const openSessionDetail = (session: RecordingSession) => {
    setDetailSession(session);
    if (!alertsLoaded && !alertsLoading) void loadAlerts();
  };

  // Run a session action from the detail card, then refresh the Sessions list
  // (and stats/alerts via runAction) so the row + card reflect the new status.
  const runDetailAction = async (action: SessionAction, opts: { sessionId?: string; usernames?: string[] }) => {
    await runAction(action, opts);
    await loadSessions();
  };

  // F8.1: "Open session card" from an IP-report candidate row — jump to the
  // Sessions tab with the detail card seeded from the drill-down row (the
  // fields the report carries; chunk_count arrives via the card's own
  // session-detail fetch). The fresh sessions list loads in parallel and its
  // row takes over as soon as it lands (same layering as a Sessions click).
  const openSessionCardFromIp = (candidate: IpReportCandidate) => {
    setView("sessions");
    void loadSessions();
    openSessionDetail({
      session_id: candidate.session_id,
      hackerrank_username: candidateIdOf(candidate),
      name: candidate.name,
      room: candidate.room,
      contest_slug: ipReport?.contest_slug ?? "",
      chunk_count: 0,
      created_at: candidate.created_at,
      status: candidate.status
    });
  };

  // F8.1: a session action from the IP-report drill-down refreshes the report
  // (and stats/alerts via runAction) so the row reflects the new status.
  const runIpReportAction = async (action: SessionAction, opts: { sessionId?: string; usernames?: string[] }) => {
    await runAction(action, opts);
    await loadIpReport();
  };

  // "View recording" — jump to the Recordings tab pre-scoped to this candidate
  // and session (state-based deep link; RecordingReview consumes + clears it).
  const jumpToRecording = (session: RecordingSession) => {
    // FIX-B1: carry the STORED key (username_norm) so the player resolves
    // person-mode sessions; candidate_id stays the display label. Older
    // backends omit username_norm → loadUser falls back to candidate_id.
    setRecordingDeepLink({
      username: candidateIdOf(session),
      usernameNorm: session.username_norm || undefined,
      sessionId: session.session_id
    });
    setDetailSession(null);
    setView("recordings");
  };

  // "View alerts" — jump to the Alerts tab filtered to this candidate (no
  // server-side username filter exists, so it's a one-shot client-side filter).
  const jumpToAlerts = (session: RecordingSession) => {
    setAlertCandidateFilter(candidateIdOf(session));
    setDetailSession(null);
    setView("alerts");
  };

  const loadAlertSettings = async () => {
    setAlertSettingsLoading(true);
    setError("");
    setAlertSettingsMessage("");
    try {
      const response = await fetchAlertSettings(password);
      setAlertSettings(response);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAlertSettingsLoading(false);
    }
  };

  const saveAlertSettingsNow = async (next: AlertSettings) => {
    setAlertSettingsLoading(true);
    setError("");
    setAlertSettingsMessage("");
    try {
      const response = await saveAlertSettings(password, next);
      setAlertSettings(response);
      setAlertSettingsMessage("Saved proctor alert settings.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAlertSettingsLoading(false);
    }
  };

  // ---- Review roster (multi-reviewer workflow) --------------------------
  const loadReviewRoster = async () => {
    setRosterLoading(true);
    setRosterMessage("");
    try {
      const summary = await fetchReviewRoster(password);
      if (summary === null) {
        setRosterUnavailable(true);
        setRosterSummary(null);
        return;
      }
      setRosterUnavailable(false);
      setRosterSummary(summary);
      // Prefill the textarea with the existing roster so an operator edits in place.
      setRosterText(summary.usernames.join("\n"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRosterLoading(false);
    }
  };

  const saveReviewRosterNow = async () => {
    setRosterLoading(true);
    setRosterMessage("");
    setError("");
    try {
      // parseRosterInput splits on comma OR newline, trims, and dedupes.
      const usernames = parseRosterInput(rosterText);
      const result = await saveReviewRoster(password, usernames);
      if (result === null) {
        setRosterUnavailable(true);
        return;
      }
      setRosterUnavailable(false);
      setRosterMessage(`Saved roster with ${result.count} Candidate ID${result.count === 1 ? "" : "s"}.`);
      // Refresh the coverage summary after saving.
      const summary = await fetchReviewRoster(password);
      if (summary) {
        setRosterSummary(summary);
        setRosterText(summary.usernames.join("\n"));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRosterLoading(false);
    }
  };

  // EXPORT REVIEWS CSV: GET all review records → build a CSV (header
  // username,reviewer_name,verdict; verdict as 1/0; one row per record) and
  // trigger a client download via a Blob + a temporary <a download>.
  const exportReviewsCsv = async () => {
    setExportingReviews(true);
    setRosterMessage("");
    setError("");
    try {
      const reviews = await fetchAllReviews(password);
      if (reviews === null) {
        setRosterUnavailable(true);
        return;
      }
      setRosterUnavailable(false);
      const csv = buildReviewsCsv(reviews);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "reviews.csv";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setRosterMessage(`Exported ${reviews.length} review record${reviews.length === 1 ? "" : "s"} to reviews.csv.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setExportingReviews(false);
    }
  };

  // DOWNLOAD ALL DETAILS CSV: resolve a candidate-detail row for each pasted
  // Candidate ID (POST /api/admin/session-details), build a CSV
  // (header candidate_id,name,email,roll_number,room) with ONE row per INPUT
  // Candidate ID (blank cells when the candidate was not found, so the operator
  // sees who is missing), and trigger a client download — mirrors exportReviewsCsv.
  const downloadDetailsCsv = async () => {
    setDownloadingDetails(true);
    setRosterMessage("");
    setError("");
    try {
      const usernames = parseRosterInput(rosterText);
      const details = await fetchSessionDetails(password, usernames, alertFilters.contest_slug);
      if (details === null) {
        setRosterUnavailable(true);
        return;
      }
      setRosterUnavailable(false);
      const csv = buildDetailsCsv(details);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "candidate-details.csv";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      const missing = details.filter((d) => !d.found).length;
      setRosterMessage(
        `Exported details for ${details.length} Candidate ID${details.length === 1 ? "" : "s"} to candidate-details.csv${missing ? ` (${missing} not found)` : ""}.`
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDownloadingDetails(false);
    }
  };

  // Auto-load the review roster summary the first time the Settings tab opens.
  useEffect(() => {
    if (!unlocked || view !== "settings" || rosterSummary !== null || rosterUnavailable) return;
    let cancelled = false;
    void (async () => {
      setRosterLoading(true);
      try {
        const summary = await fetchReviewRoster(password);
        if (cancelled) return;
        if (summary === null) {
          setRosterUnavailable(true);
        } else {
          setRosterSummary(summary);
          setRosterText(summary.usernames.join("\n"));
        }
      } catch {
        // Non-fatal — the operator can press Reload to retry.
      } finally {
        if (!cancelled) setRosterLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlocked, view, rosterSummary, rosterUnavailable, password]);

  // Auto-load the proctor alert settings the first time the Settings tab opens.
  useEffect(() => {
    if (!unlocked || view !== "settings" || alertSettings !== null) return;
    let cancelled = false;
    void (async () => {
      setAlertSettingsLoading(true);
      try {
        const response = await fetchAlertSettings(password);
        if (!cancelled) setAlertSettings(response);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setAlertSettingsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlocked, view, alertSettings, password]);

  // S-D (A1): apply a contest selection everywhere — state, the loaded tabs,
  // and THIS TAB's URL (?contest=) so a reload or duplicated tab keeps its
  // scope (two tabs = two parallel drives).
  const selectContest = (slug: string) => {
    const next = { ...alertFilters, contest_slug: slug || undefined };
    setAlertFilters(next);
    window.history.replaceState(null, "", `${window.location.pathname}${searchWithContestParam(window.location.search, slug)}`);
    void loadStats(next);
    if (alertsLoaded) void loadAlerts(next);
    if (sessionsList !== null) void loadSessions(next);
    if (ipReport !== null) void loadIpReport(undefined, next);
    // The review search re-runs under the new scope (same condition as
    // runAction's refresh) so displayed results never outlive the selector.
    if (view === "review" && username) void search(next);
  };

  // W3: ONE navigation chokepoint for the grouped nav — carries the per-view
  // load side effects the old flat tabs had inline. The per-group memory means
  // switching sections returns to the view you were last on in that section
  // (covers EVERY view change, including drill-downs, via the effect below).
  const lastViewByGroup = useRef<Partial<Record<string, AdminView>>>({});
  useEffect(() => {
    lastViewByGroup.current[groupOfView(view).key] = view;
  }, [view]);
  const goTo = (next: AdminView) => {
    setView(next);
    if (next === "sessions") void loadSessions();
    if (next === "ips") void loadIpReport();
  };

  if (!unlocked) {
    return (
      <Shell>
        <section className="mx-auto max-w-md rounded-lg border border-line bg-panel p-5 shadow-subtle">
          <div className="mb-5 flex items-center gap-3">
            <Lock size={20} />
            <div>
              <h1 className="text-2xl font-semibold">Admin locked</h1>
              <p className="mt-1 text-sm text-muted">Enter the admin password to view proctoring controls.</p>
            </div>
          </div>
          <div onKeyDown={(e) => { if (e.key === "Enter" && passwordInput) void unlockAdmin(); }}>
            <Field label="Admin password" type="password" value={passwordInput} onChange={setPasswordInput} />
          </div>
          <button className="focus-ring mt-4 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white" onClick={unlockAdmin} disabled={!passwordInput}>
            <Lock size={16} /> Unlock admin
          </button>
          {error ? <div className="mt-4 rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger">{error}</div> : null}
        </section>
      </Shell>
    );
  }

  return (
    // #116: ALL admin views share ONE container width (the "wide"
    // max-w-screen-2xl). Previously only Recordings + Results were wide and every
    // other view was max-w-6xl, so navigating between admin pages SNAPPED the
    // container width. A single width across views makes navigation feel calm; a
    // page whose CONTENT would look stretched at full width constrains itself
    // internally (an inner max-width wrapper), never by shrinking the shell.
    <Shell variant="wide">
      {/* W3: grouped admin nav. Top row: SECTIONS (left) + the global contest
          scope (top-right — it scopes EVERY screen, so it sits ABOVE them all;
          A1/S-D: the selection persists in this tab's URL ?contest= param).
          Second row: the views of the active section (hidden for single-view
          sections), so the header is never more than two slim rows. */}
      <div className="mb-5 rounded-lg border border-line bg-panel shadow-subtle">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2">
          <nav className="flex flex-wrap items-center gap-1" aria-label="Admin sections">
            {ADMIN_NAV_GROUPS.map((group) => (
              <GroupTab
                key={group.key}
                active={groupOfView(view).key === group.key}
                onClick={() => goTo(lastViewByGroup.current[group.key] ?? group.views[0].view)}
                icon={GROUP_ICONS[group.key]}
                label={group.label}
                badge={group.key === "live" ? alerts.length : undefined}
              />
            ))}
          </nav>
          <ContestScopePicker
            contests={adminContests}
            contestSlug={alertFilters.contest_slug ?? ""}
            onSelect={selectContest}
          />
        </div>
        {groupOfView(view).views.length > 1 ? (
          <nav className="flex flex-wrap items-center gap-1 rounded-b-lg border-t border-line bg-paper/70 px-3 py-1.5" aria-label="Admin views">
            {groupOfView(view).views.map((entry) => (
              <AdminTab
                key={entry.view}
                active={view === entry.view}
                onClick={() => goTo(entry.view)}
                icon={VIEW_ICONS[entry.view]}
                label={entry.label}
                badge={entry.view === "alerts" ? alerts.length : undefined}
              />
            ))}
          </nav>
        ) : null}
      </div>

      {error ? <div className="mb-5 rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger">{error}</div> : null}
      {actionMessage ? <div className="mb-5 rounded-lg border border-accent/30 bg-accent/10 p-4 text-sm text-accent">{actionMessage}</div> : null}

      {view === "stats" ? (
        <>
          <ExamTimeCard
            endAt={examEndAt}
            skewMs={examSkewMs}
            busy={examTimeBusy}
            endNowArmed={endNowArmed}
            onArmEndNow={setEndNowArmed}
            absoluteInput={examTimeInput}
            onAbsoluteInputChange={setExamTimeInput}
            onAdjust={(body) => void runExamTime(body)}
            scope={examTimeScope}
          />
          <StatsDashboard
            stats={stats}
            loading={statsLoading}
            onRefresh={() => loadStats()}
            rooms={rooms}
            room={alertFilters.room ?? ""}
            onRoomChange={(room) => {
              const next = { ...alertFilters, room: room || undefined };
              setAlertFilters(next);
              void loadStats(next);
            }}
            onDrill={drillToSessions}
          />
        </>
      ) : null}

      {view === "sessions" ? (
        <>
          <SessionsView
            sessions={sessionsList}
            loading={sessionsLoading}
            unavailable={sessionsUnavailable}
            statusFilter={sessionsStatusFilter}
            onStatusFilterChange={(status) => {
              // The status filter is SERVER-side now: update the state AND reload the
              // list with the new status passed explicitly (the state is still stale
              // this tick), so the list re-matches the server-classified counts.
              setSessionsStatusFilter(status);
              void loadSessions(undefined, status);
            }}
            contestSlug={alertFilters.contest_slug ?? ""}
            onRefresh={() => loadSessions()}
            onApprove={(session) => void approveSession(session)}
            onOpenDetail={openSessionDetail}
          />
          {/* F6.3: the detail card prefers the FRESH sessionsList row (reloads
              after an action update it); the click-time snapshot is the fallback
              when a status-filtered reload dropped the row from the list. */}
          {detailSession ? (
            <SessionDetailCard
              password={password}
              session={sessionsList?.find((s) => s.session_id === detailSession.session_id) ?? detailSession}
              alerts={alerts}
              alertsLoaded={alertsLoaded}
              onClose={() => setDetailSession(null)}
              onAction={runDetailAction}
              onViewRecording={jumpToRecording}
              onViewAlerts={jumpToAlerts}
            />
          ) : null}
        </>
      ) : null}

      {view === "attendance" ? (
        <AttendancePanel password={password} contestSlug={alertFilters.contest_slug ?? ""} />
      ) : null}

      {view === "results" ? (
        <ResultsPanel password={password} contestSlug={alertFilters.contest_slug ?? ""} />
      ) : null}

      {/* Evaluation is rendered ENTIRELY by proctor-eval and embedded in an
          iframe — the SPA fetches nothing for this view. */}
      {view === "evaluation" ? (
        <EvaluationPanel contestSlug={alertFilters.contest_slug ?? ""} />
      ) : null}

      {/* People tab is CROSS-ROUND by design — it ignores the contest selector. */}
      {view === "people" ? (
        <PeoplePanel password={password} />
      ) : null}

      {view === "ips" ? (
        <IpReportView
          report={ipReport}
          loading={ipReportLoading}
          unavailable={ipReportUnavailable}
          scope={ipScope}
          onScopeChange={(scope) => {
            setIpScope(scope);
            void loadIpReport(scope);
          }}
          contestSlug={alertFilters.contest_slug ?? ""}
          onRefresh={() => loadIpReport()}
          onAction={(action, opts) => void runIpReportAction(action, opts)}
          onOpenSessionCard={openSessionCardFromIp}
        />
      ) : null}

      {view === "alerts" ? (
        <AlertsConsole
          alerts={alerts}
          sessions={alertSessions}
          sessionsFailed={alertSessionsFailed}
          loading={alertsLoading}
          loaded={alertsLoaded}
          filters={alertFilters}
          rooms={rooms}
          candidateFilter={alertCandidateFilter}
          onClearCandidateFilter={() => setAlertCandidateFilter("")}
          selected={selected}
          onToggleSelected={toggleSelected}
          onSelectAll={(ids) => setSelected((current) => addAllToSelection(current, ids))}
          onDeselectAll={(ids) => setSelected((current) => removeFromSelection(current, ids))}
          onClearSelection={() => setSelected(new Set())}
          onFiltersChange={(next) => {
            setAlertFilters(next);
            void loadAlerts(next);
          }}
          onRefresh={() => loadAlerts()}
          onAction={runAction}
          onArchive={(ids, action) => void archiveAlerts(ids, action)}
          onApproveArchive={(alert, targetSessionId) => void approveAndArchive(alert, targetSessionId)}
        />
      ) : null}

      {view === "contests" ? (
        <ContestsPanel
          password={password}
          renderRoster={(slug) => <CandidateRosterSection password={password} contestSlug={slug} />}
          onContestsChanged={setAdminContests}
        />
      ) : null}

      {view === "problems" ? <ProblemBankSection password={password} /> : null}

      {view === "templates" ? <TemplatesPanel password={password} /> : null}

      {view === "settings" ? (
      <div className="space-y-5">
      {/* S-C: the global contest filter (A1) doubles as the roster target —
          set it to a person contest's slug to upload THAT contest's roster
          (college column compulsory); clear it for the global (no-contest)
          roster. */}
      <CandidateRosterSection password={password} contestSlug={alertFilters.contest_slug ?? ""} />

      <ReviewRosterSection
        text={rosterText}
        onTextChange={setRosterText}
        summary={rosterSummary}
        loading={rosterLoading}
        exporting={exportingReviews}
        downloadingDetails={downloadingDetails}
        message={rosterMessage}
        unavailable={rosterUnavailable}
        onSave={() => void saveReviewRosterNow()}
        onReload={() => void loadReviewRoster()}
        onExport={() => void exportReviewsCsv()}
        onDownloadDetails={() => void downloadDetailsCsv()}
      />

      <ProctorAlertTypesSection
        settings={alertSettings}
        loading={alertSettingsLoading}
        message={alertSettingsMessage}
        onReload={loadAlertSettings}
        onSave={saveAlertSettingsNow}
      />

      <ContestEvalAlertTypesSection />
      </div>
      ) : null}

      {view === "review" ? (
      <>
      <section className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
        <div className="mb-5 flex items-center gap-3">
          <Search size={20} />
          <div>
            <h1 className="text-2xl font-semibold">Review dashboard</h1>
            <p className="mt-1 text-sm text-muted">Search by Candidate ID to inspect sessions, events, and uploaded evidence — and run remote actions.</p>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
          <Field label="Candidate ID" value={username} onChange={setUsername} />
          <button className="focus-ring mt-6 inline-flex h-10 items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white" onClick={() => void search()} disabled={loading || !username || !password}>
            <Search size={16} /> Search
          </button>
        </div>
      </section>

      <section className="mt-5 space-y-3">
        {result.map((session, index) => (
          <ReviewSessionCard key={String(session.session_id ?? index)} session={session} onAction={runAction} />
        ))}
      </section>
      </>
      ) : null}

      {view === "recordings" ? (
        <RecordingReview
          password={password}
          contestSlug={alertFilters.contest_slug}
          deepLink={recordingDeepLink}
          onDeepLinkConsumed={() => setRecordingDeepLink(null)}
        />
      ) : null}

      {view === "health" ? <SystemHealthPanel password={password} /> : null}
    </Shell>
  );
}

// W3: nav icons. Group icons key the primary (sections) row; view icons key
// the secondary row of the active section.
const GROUP_ICONS: Record<string, React.ReactNode> = {
  live: <ShieldCheck size={15} />,
  contest: <ListChecks size={15} />,
  evidence: <Film size={15} />,
  authoring: <ClipboardList size={15} />,
  people: <Users size={15} />,
  health: <Activity size={15} />,
  settings: <Lock size={15} />
};
const VIEW_ICONS: Record<AdminView, React.ReactNode> = {
  stats: <ShieldCheck size={15} />,
  alerts: <Bell size={15} />,
  sessions: <Users size={15} />,
  ips: <Network size={15} />,
  contests: <ListChecks size={15} />,
  attendance: <UserCheck size={15} />,
  results: <Award size={15} />,
  evaluation: <BrainCircuit size={15} />,
  review: <Search size={15} />,
  recordings: <Film size={15} />,
  problems: <ClipboardList size={15} />,
  templates: <LayoutTemplate size={15} />,
  people: <Users size={15} />,
  health: <Activity size={15} />,
  settings: <Lock size={15} />
};

// W3 primary row: one tab per SECTION — active section is ink-filled.
function GroupTab({ active, onClick, icon, label, badge }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; badge?: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={`focus-ring inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium ${active ? "bg-ink text-white" : "text-ink hover:bg-ink/5"}`}
    >
      {icon}
      {label}
      {badge ? <span className={`rounded-full px-1.5 py-0.5 text-xs font-semibold leading-none ${active ? "bg-white/20 text-white" : "bg-danger/10 text-danger"}`}>{badge}</span> : null}
    </button>
  );
}

// W3 secondary row: the active section's views as a segmented strip — active
// view is a raised white pill.
function AdminTab({ active, onClick, icon, label, badge }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; badge?: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`focus-ring inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm ${active ? "border-line bg-white font-semibold text-ink shadow-subtle" : "border-transparent font-medium text-muted hover:text-ink"}`}
    >
      {icon}
      {label}
      {badge ? <span className={`rounded-full px-1.5 py-0.5 text-xs font-semibold leading-none ${active ? "bg-danger/10 text-danger" : "bg-ink/10 text-ink"}`}>{badge}</span> : null}
    </button>
  );
}

