import { Activity, AlertTriangle, Award, Bell, BrainCircuit, CheckCircle2, ChevronDown, ChevronRight, ClipboardList, Clock, Copy, Download, Film, LayoutTemplate, ListChecks, Lock, MonitorUp, Network, RefreshCw, Search, ShieldCheck, Square, UserCheck, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { adjustContestExamTime, adminPassword, adminPasswordHash, alertAction, endSession, fetchAdminSessions, fetchAdminStats, fetchAlertSettings, fetchAlerts, fetchAllReviews, fetchContests, fetchContestExamConfig, fetchIpReport, fetchReviewRoster, fetchSessionDetails, fetchSessionsList, parseRosterInput, pollRoomGate, resolveAccessCodeApi, resumeSession, rosterLookup, saveAlertSettings, saveReviewRoster, sendEvents, sendSessionBeacon, sessionAction, sha256Hex, startSession, uploadReviewFile, validateEndSession } from "./api";
import { RecordingReview } from "./RecordingReview";
import { addAllToSelection, removeFromSelection, toggleId } from "./alertSelection";
import { alertJoinState, joinableSessions } from "./admin/alertActions";
import { chunkIndexBase, clearChunkContinuity, mergeManifest, readChunkHwm, readStintManifest, writeStintManifest } from "./chunkContinuity";
import { clearChunkBuffer } from "./chunkBuffer";
import { classifyEndAtChange, computeClockSkewMs, formatRemaining, remainingMs, sessionElapsedAnchorMs } from "./examTime";
import { InvigilatorApp } from "./InvigilatorApp";
import { ProblemBankSection } from "./admin/ProblemBank";
import { ContestsPanel } from "./admin/ContestsPanel";
import { TemplatesPanel } from "./admin/TemplatesPanel";
import { SystemHealthPanel } from "./admin/SystemHealthPanel";
import { ResultsPanel } from "./admin/ResultsPanel";
import { EvaluationPanel } from "./admin/EvaluationPanel";
import { PeoplePanel } from "./admin/PeoplePanel";
import { defaultContestSelection, searchWithContestParam } from "./admin/contestAdmin";
import { ADMIN_NAV_GROUPS, groupOfView, type AdminView } from "./admin/adminNav";
import { MultiProblemWorkspace } from "./coding/MultiProblemWorkspace";
import { clearSessionDrafts } from "./coding/problemSwitch";
import { csvField } from "./csvField";
import * as studentCopy from "./studentCopy";
import { cameraRecordingFromForm, normalizeCameraRecording } from "./cameraRecording";
import { MarkerLayer } from "./markers/MarkerLayer";
import { enforcementSettingsFromForm } from "./enforcementSettings";
import { awayBeaconActive, elapsedTimerActive, shellHeaderMode } from "./shell/examShell";
import { EnforcementOverlay } from "./shell/EnforcementOverlay";
import { ExamShellChrome } from "./shell/ExamShellChrome";
import { allPermissionsGranted, initialPermissionChecklist, primeClipboardWithTimeout, screenShareFailureMessage, screenStatusFromErrorKind, type PermissionChecklist, type PermissionKey } from "./shell/permissions";
import { accessCodeReady, candidateFormMode, candidateFormReady, contestParamOf, contestUrlFor, landingErrorMessage, normalizeAccessCodeInput, rosterLookupErrorMessage, routeForPinnedOutcome, sessionStorageKeyFor, type CandidateRoute } from "./shell/candidateRouting";
import { useEnforcement } from "./shell/useEnforcement";
import { useExamShell } from "./shell/useExamShell";
import { acquireCameraMicrophone, acquireScreenShareStream, BufferRequiredError, classifyStartError, createProctorRecorder, SETUP_SCREEN_CONSTRAINTS, type AcquiredMedia, type BufferStatus, type MediaCaptureState, type RecorderStartErrorKind } from "./useProctorRecorder";
import type { AdminStats, AdminStatsResponse, Alert, AlertFilters, AlertSettings, CollegeChoice, ContestExamConfig, ContestSummary, EnforcementConfigPayload, EnforcementExemptions, ExamConfig, ExamTimeRequest, IpReportCandidate, IpReportResponse, IpReportScope, ProctorEvent, ProctorSettings, RecordingSession, ReviewRosterSummary, RosterLookupResult, ServerSessionStatus, SessionAction, SessionStartResponse, SessionStatus, StudentForm, UploadManifestItem } from "./types";
import type { ApiError } from "./api";
import { candidateIdOf } from "./identity";
import { normalizeOtpInput } from "./invigilator/gateLogic";
import { Field } from "./ui/Field";
import { StatusPill } from "./ui/StatusPill";
import { Shell } from "./ui/Shell";
import { IdentityCard } from "./candidate/panels/IdentityCard";
import { BlockedScreen } from "./candidate/panels/BlockedScreen";
import { UnlockCodePanel } from "./candidate/panels/UnlockCodePanel";
import { EndTestPanel } from "./candidate/panels/EndTestPanel";
import { FinishingOverlay } from "./candidate/panels/FinishingOverlay";
import { RoomCodePanel } from "./candidate/panels/RoomCodePanel";
import { RoomField } from "./candidate/panels/RoomField";
import { CameraSelfView } from "./candidate/panels/CameraSelfView";
import { CameraDock } from "./candidate/panels/CameraDock";
import { RecentEventsPanel } from "./candidate/panels/RecentEventsPanel";
import { HealthPanel } from "./candidate/panels/HealthPanel";
import { EntryReviewPanel } from "./candidate/panels/EntryReviewPanel";
import { PreStartRules, RulesPanel, WhatIsRecordedPanel } from "./candidate/panels/Rules";
import { ScreenShareErrorPanel } from "./candidate/panels/ScreenShareErrorPanel";
import { EndRetryPanel } from "./candidate/panels/EndRetryPanel";
// F3: admin leaf views + action cluster + csv builders (extracted from App.tsx).
import { SessionsStatusFilter } from "./sessionFilters";
import { buildReviewsCsv, buildDetailsCsv } from "./admin/csv";
import { StatsDashboard } from "./admin/views/StatsDashboard";
import { SessionsView } from "./admin/views/SessionsView";
import { SessionDetailCard } from "./admin/views/SessionDetailCard";
import { AttendancePanel } from "./admin/views/AttendancePanel";
import { IpReportView } from "./admin/views/IpReportView";
import { ContestScopePicker } from "./admin/views/ContestScopePicker";
import { ExamTimeCard, type ExamTimeCardScope } from "./admin/views/ExamTimeCard";
import { ReviewSessionCard } from "./admin/views/ReviewSessionCard";
import { AlertsConsole } from "./admin/views/AlertsConsole";
import { CandidateRosterSection, ProctorAlertTypesSection, ContestEvalAlertTypesSection, ReviewRosterSection } from "./admin/views/settings";

// S4: the contest problem is SERVER-DRIVEN — it arrives as `problem` inside the
// start/resume response (the contest's problems[] → public view; see
// docs/superpowers/specs/2026-06-09-s4-problem-authoring-design.md).
//
// Candidate-facing copy is surface-specific (studentCopy.ts): with a problem
// assigned, no student string may direct the candidate to HackerRank. The copy
// keys off ownEditorCopy (UX-H1): Boolean(sessionConfig?.problem) once a
// session exists, with a pinned ?contest= link selecting the own-editor
// variant pre-session too (pinned contests are own-editor sessions).

// Auto-poll interval for the admin Live stats / Live alerts views.
const ADMIN_POLL_INTERVAL_MS = 5000;

const initialForm: StudentForm = {
  candidate_id: "",
  name: "",
  roll_number: "",
  email: "",
  room: "",
  consent_accepted: false,
  roster_unique_id: ""
};

export function App() {
  // S3: the invigilator portal lives on its own path, like /admin.
  if (window.location.pathname.startsWith("/invigilator")) return <InvigilatorApp />;
  const isAdmin = window.location.pathname.startsWith("/admin");
  return isAdmin ? <AdminApp /> : <CandidateRouter />;
}

// S-D candidate routing (vision C1 + §10.3). ?contest=<slug> pins the student
// app to that contest's exam-config; a present-but-bad param shows the
// access-code landing page; an ABSENT param shows the access-code landing page.
// Decisions are pure (shell/candidateRouting.ts); this component only fetches.
function CandidateRouter() {
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

// S-D §10.3: the BARE access-code landing page — weak lab machines type a
// 6-char code instead of a slug URL. Resolves via the public (rate-limited)
// POST /api/access-code and redirects to the pinned ?contest= URL.
function AccessCodeLanding(props: { notice: string }) {
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
          Type the 6-character code your invigilator gave you.
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
type StudentGate = "form" | "pending_approval" | "locked" | "ended" | "running";

// S-D: the candidate app pinned to ONE contest by ?contest= (null = legacy).
type PinnedContest = { slug: string; config: ContestExamConfig };

function StudentApp({ pinned }: { pinned: PinnedContest | null }) {
  const pinnedSlug = pinned?.slug ?? "";
  // Every contest is person-mode: the start/resume contest rides the body when
  // a contest is pinned. Per-contest resume token keyed by slug so two browser
  // tabs can run two contests without evicting each other's token.
  const personPinned = Boolean(pinned);
  const sessionKey = sessionStorageKeyFor(pinnedSlug);
  const [form, setForm] = useState<StudentForm>(initialForm);
  const [status, setStatus] = useState<SessionStatus>("idle");
  const [gate, setGate] = useState<StudentGate>("form");
  const [resuming, setResuming] = useState(true);
  const [sessionId, setSessionId] = useState("");
  const [sessionConfig, setSessionConfig] = useState<SessionStartResponse | null>(null);
  const [identity, setIdentity] = useState<{ name: string; candidate_id: string; room: string } | null>(null);
  const [startIp, setStartIp] = useState("");
  const [currentIp, setCurrentIp] = useState("");
  const [ipChanged, setIpChanged] = useState(false);
  const [events, setEvents] = useState<ProctorEvent[]>([]);
  const [queueDepth, setQueueDepth] = useState(0);
  const [uploadedCount, setUploadedCount] = useState(0);
  // Tier-1 persistent chunk buffer: live pending count/bytes + the circuit-
  // breaker mode, surfaced by the recorder. Drives the amber HealthPanel state
  // and the end-of-test drain wait gate (ending_draining). {fallback,0,0} = the
  // buffer is off (self-test failed or runtime-degraded) → today's behavior.
  const [bufferStatus, setBufferStatus] = useState<BufferStatus>({ mode: "fallback", pendingCount: 0, pendingBytes: 0 });
  const [error, setError] = useState("");
  // Recoverable screen-share/start failure (invalid surface, share cancelled,
  // permission denied, unsupported, etc.). When set, the student is clearly NOT
  // recording and an inline "Try again" re-invokes the share — never a reload.
  const [startError, setStartError] = useState<{ kind: RecorderStartErrorKind; message: string } | null>(null);
  const [reloadWarning, setReloadWarning] = useState("");
  const [manifest, setManifest] = useState<UploadManifestItem[]>([]);
  const [clipboardAudit, setClipboardAudit] = useState("Not collected yet.");
  const [tabAudit, setTabAudit] = useState("Not collected yet.");
  const [cookieAudit, setCookieAudit] = useState("Not collected yet.");
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  // S5: authoritative exam end time + server-clock skew, fed by start/resume
  // responses and refreshed by every heartbeat (≤15 s — the existing student
  // polling channel). examEndAtRef mirrors examEndAt for the recorder-callback
  // closure (the recorder options are built once); timeUpAnnouncedRef makes the
  // time-up voice warning fire exactly once.
  const [examEndAt, setExamEndAt] = useState("");
  const [clockSkewMs, setClockSkewMs] = useState(0);
  const [examTimeNotice, setExamTimeNotice] = useState("");
  const examEndAtRef = useRef("");
  const timeUpAnnouncedRef = useRef(false);
  const [endRequested, setEndRequested] = useState(false);
  // Recording already stopped but the final end/manifest submit failed — show an
  // inline "Retry submitting" instead of dead-ending in the error state.
  const [endFailed, setEndFailed] = useState(false);
  const [assuranceAccepted, setAssuranceAccepted] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  // Mirror for the attachCameraVideo callback ref (same pattern as statusRef).
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const [mediaCapture, setMediaCapture] = useState<MediaCaptureState>({ screen: "inactive", camera: "inactive", microphone: "inactive" });
  // W1: exam-view chrome state — the collapsible proctoring panel (its panels
  // stay MOUNTED when collapsed; the collapse is CSS-only) and the floating
  // camera dock's minimized state (the <video> host stays mounted in both).
  const [proctorPanelOpen, setProctorPanelOpen] = useState(false);
  const [cameraDockCollapsed, setCameraDockCollapsed] = useState(false);
  // S3 room gate: whether THIS session has been released into the exam (room
  // OTP / invigilator start-now / gate disabled). Starts false when the gate is
  // enabled; the poll effect corrects it (also after reload/resume).
  const [examStarted, setExamStarted] = useState(false);
  const [gateCode, setGateCode] = useState("");
  const [gateError, setGateError] = useState("");
  const [gateBusy, setGateBusy] = useState(false);
  // F5.3/F5.5: enforcement knobs (exam-config → start/resume → heartbeat keep
  // them fresh), this session's exemptions, and the server's lock reason (an
  // enforcement lock offers the room-code unlock; an admin lock does not).
  const [enforcementPayload, setEnforcementPayload] = useState<EnforcementConfigPayload | null>(null);
  const [enforcementExemptions, setEnforcementExemptions] = useState<EnforcementExemptions>({});
  const [lockedReason, setLockedReason] = useState<string | null>(null);
  // S2 roster login state. examConfig is the public pre-session config; the
  // unique-ID -> confirm flow fills form.roster_unique_id, which the server
  // re-verifies at /api/session/start (this client gate is UX only).
  const [examConfig, setExamConfig] = useState<ExamConfig | null>(null);
  const [uniqueIdInput, setUniqueIdInput] = useState("");
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupError, setLookupError] = useState("");
  // Wave-6 review: epoch-ms until which the Find-me button stays disabled after a
  // 429, so re-clicks during the rate-limit window don't burn more budget (the
  // M3 limiter has no success refund for the MISS path that 429s).
  const [lookupCooldownUntil, setLookupCooldownUntil] = useState(0);
  const [rosterMatch, setRosterMatch] = useState<RosterLookupResult | null>(null);
  // S4: the assigned problem rides in on the start/resume response. hasProblem
  // drives every own-editor-vs-HackerRank copy fork (studentCopy.ts, stageHint).
  // S-I: newer backends serve the ORDERED problems[]; `problem` is the
  // one-release alias (= problems[0]) older payloads still carry. Either one
  // makes this an own-editor session.
  const sessionProblems = sessionConfig?.problems ?? (sessionConfig?.problem ? [sessionConfig.problem] : []);
  const activeProblem = sessionConfig?.problem ?? sessionProblems[0] ?? null;
  const hasProblem = activeProblem !== null;
  // UX-H1: which COPY variant (own-editor vs legacy HackerRank) the candidate
  // sees. The problem only arrives with the start/resume response, so keying
  // copy off hasProblem alone left the pre-start rules + consent page on the
  // legacy variants (and silently dropped the keystroke-recording consent
  // clause). Every pinned ?contest= candidate is an own-editor session, so a
  // pinned contest selects own-editor copy too (the public exam-config payload
  // carries no own-editor flag to gate on instead; a pinned legacy-HackerRank
  // contest would mis-show own-editor copy — that flow is not in use).
  // Behavior gates (the W1 exam branch) still key off hasProblem.
  const ownEditorCopy = hasProblem || pinned !== null;
  // F10.1: is the separate low-res camera RECORDING enabled? Pre-session the
  // public exam-config carries it (the consent disclosure renders before any
  // session exists); once a session starts, its upload_config is authoritative.
  // normalizeCameraRecording defaults to ENABLED, matching the server default.
  const cameraRecordingOn = sessionConfig?.upload_config.camera
    ? sessionConfig.upload_config.camera.enabled
    : normalizeCameraRecording(examConfig?.camera_recording).enabled;
  const recorderRef = useRef<ReturnType<typeof createProctorRecorder> | null>(null);
  // F1 (e2e finding): manifest items accumulated across EVERY recording stint
  // of this session (each recorder instance only knows its own uploads). The
  // accumulator is persisted to sessionStorage so a same-tab refresh-resume
  // keeps the earlier stints; the end-of-test manifest merges this with the
  // final recorder's list, de-duplicated by (kind, index).
  const stintManifestRef = useRef<UploadManifestItem[]>([]);
  const collectStintManifest = (items: UploadManifestItem[] | undefined, forSessionId: string) => {
    if (!items?.length || !forSessionId) return;
    stintManifestRef.current = mergeManifest(stintManifestRef.current, items);
    writeStintManifest(window.sessionStorage, forSessionId, stintManifestRef.current);
  };
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  cameraStreamRef.current = cameraStream;
  // Live mirror of `status` for the beacon listener (mounted once on sessionId).
  // The away-signal beacon must read the CURRENT status without re-subscribing —
  // same statusRef pattern useExamShell uses to gate anomaly dispatch on
  // `recording`. Why this exists: the tab_hidden alert is raised SOLELY by the
  // backend on a hidden/closing beacon (visibility_change via /api/events is
  // never a sure-shot). The beacon below must therefore only fire while the exam
  // is genuinely live — once End is pressed (status ending/ended/error) the
  // recorder teardown, fullscreen exit, or the candidate switching away to close
  // the tab all flip visibilityState to hidden, and without this gate each one
  // raised a spurious end-of-session tab_hidden.
  const statusRef = useRef(status);
  statusRef.current = status;
  // F5.1 permissions-first onboarding (stage 1, before fullscreen): the
  // checklist mirrors the per-permission prompt results; the acquired streams
  // wait here until beginRecording hands them to the recorder (start() then
  // reuses them — no second prompt). Streams never survive a reload, so a
  // resumed session naturally reruns stage 1+2 without re-asking the form.
  const [permissions, setPermissions] = useState<PermissionChecklist>(initialPermissionChecklist);
  const [permissionsConfirmed, setPermissionsConfirmed] = useState(false);
  const [permissionsBusy, setPermissionsBusy] = useState<PermissionKey | "all" | null>(null);
  const [screenSetupMessage, setScreenSetupMessage] = useState("");
  const acquiredMediaRef = useRef<AcquiredMedia>({ screen: null, cameraMic: null, cameraMicMode: null });
  // Setup-stage audit events queued until a session exists (mirrors the
  // shell's own pre-session buffer), flushed in beginRecording.
  const preSessionEventsRef = useRef<ProctorEvent[]>([]);

  const rosterRequired = Boolean(examConfig?.roster_required);
  // S-D: which identity form this candidate sees — person_roster (typed id
  // resolved SERVER-side at start) or person_open (no-roster person contest:
  // id + details). Pure (candidateRouting.ts). Every contest is person-mode.
  const formMode = candidateFormMode(rosterRequired);
  // S-C/S-D: a person-contest start can 409 with college_choices — the picker
  // renders those choices and the pick rides the retried start as `college`.
  const [collegeChoices, setCollegeChoices] = useState<CollegeChoice[] | null>(null);
  const [collegeChoice, setCollegeChoice] = useState("");

  const canStart = useMemo(
    () => candidateFormReady(formMode, form) && (!collegeChoices || Boolean(collegeChoice)),
    [form, formMode, collegeChoices, collegeChoice]
  );

  // S1 exam shell: EVERY proctor event (recorder onEvent + createUiEvent call
  // sites) already flows through this single funnel, so the shell taps it here
  // for anomaly classification (spec §6). The ref breaks the definition cycle —
  // the shell hook itself emits events through addEvent.
  const shellTapRef = useRef<(event: ProctorEvent) => void>(() => undefined);
  // F5.3/F5.4: the enforcement hook taps the SAME funnel (fullscreen exits →
  // hard-block ladder; blur/hide runs → switch-away debounce).
  const enforcementTapRef = useRef<(event: ProctorEvent) => void>(() => undefined);
  const addEvent = (event: ProctorEvent) => {
    shellTapRef.current(event);
    enforcementTapRef.current(event);
    setEvents((current) => [event, ...current].slice(0, 16));
  };

  // S3 room gate: enabled for this contest AND this session not yet released.
  // While active, the candidate holds at the RoomCodePanel waiting room — the
  // coding workspace / contest link stay hidden and the shell stage stays 3.
  const examGateActive = Boolean(sessionConfig?.room_gate_enabled) && !examStarted;

  // ---- F5.1 stage-1 permission acquisition (all prompts BEFORE fullscreen) --
  // No session exists during setup, so fullscreen-exit/blur from the prompts
  // can never be an anomaly (the reducer only fires while recording) — and the
  // events emitted here are queued and flushed once the session is created.
  const recordSetupEvent = (type: string, detail?: Record<string, unknown>) => {
    const event = createUiEvent(type, detail);
    addEvent(event);
    // F9: best-effort audit post — a locked/ended session 403/409s these by
    // design; swallow so expected rejections never hit the console unhandled.
    if (sessionId) void sendEvents(sessionId, [event]).catch(() => undefined);
    else preSessionEventsRef.current = [...preSessionEventsRef.current, event].slice(-50);
  };

  // OMR P1 (design §5.3): the additive camera_pip event — the camera pop-out
  // is an OS always-on-top window that occludes screen markers in the
  // recording, so P3's correlation needs to know PiP was active to downgrade.
  // Ref-bridged because the listeners attach inside the once-memoized
  // attachCameraVideo callback (same pattern as cameraStreamRef).
  const cameraPipEmitRef = useRef<(active: boolean) => void>(() => undefined);
  cameraPipEmitRef.current = (active: boolean) => recordSetupEvent("camera_pip", { active });

  const acquireScreenPermission = async (): Promise<void> => {
    setPermissions((c) => ({ ...c, screen: "requesting" }));
    setScreenSetupMessage("");
    try {
      const stream = await acquireScreenShareStream(SETUP_SCREEN_CONSTRAINTS, recordSetupEvent);
      acquiredMediaRef.current.screen?.getTracks().forEach((track) => track.stop());
      acquiredMediaRef.current.screen = stream;
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        // Killed between setup and start. Once beginRecording hands the stream
        // to the recorder this listener disarms (identity check) — the recorder
        // owns the fatal-stop path from then on.
        if (acquiredMediaRef.current.screen !== stream) return;
        acquiredMediaRef.current.screen = null;
        setPermissions((c) => ({ ...c, screen: "pending" }));
        recordSetupEvent("setup_screen_share_ended");
      });
      setPermissions((c) => ({ ...c, screen: "granted" }));
      recordSetupEvent("setup_screen_share_granted", {
        display_surface: (stream.getVideoTracks()[0]?.getSettings() as MediaTrackSettings & { displaySurface?: string })?.displaySurface || "unknown"
      });
    } catch (cause) {
      const kind = classifyStartError(cause);
      setPermissions((c) => ({ ...c, screen: screenStatusFromErrorKind(kind) }));
      setScreenSetupMessage(screenShareFailureMessage(kind));
      recordSetupEvent("setup_screen_share_failed", { kind, message: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const acquireCameraMicPermission = async (): Promise<void> => {
    setPermissions((c) => ({ ...c, camera: "requesting", microphone: "requesting" }));
    const result = await acquireCameraMicrophone(recordSetupEvent);
    acquiredMediaRef.current.cameraMic?.getTracks().forEach((track) => track.stop());
    acquiredMediaRef.current.cameraMic = result.stream;
    acquiredMediaRef.current.cameraMicMode = result.captureMode;
    setPermissions((c) => ({ ...c, camera: result.camera, microphone: result.microphone }));
  };

  const acquireClipboardPermission = async (): Promise<void> => {
    setPermissions((c) => ({ ...c, clipboard: "requesting" }));
    if (!navigator.clipboard?.readText) {
      setPermissions((c) => ({ ...c, clipboard: "unavailable" }));
      recordSetupEvent("setup_clipboard_permission_failed", { message: "Clipboard read is not supported by this browser." });
      return;
    }
    // Permission primer only: the read triggers the browser grant so the
    // recorder can log in-exam copy/cut/paste once the session starts. The
    // pre-session clipboard CONTENT is outside the disclosed monitoring scope
    // (M6), so we keep neither the text nor its length — only the grant.
    // FIX-B3 #1: clipboard is OPTIONAL and must never wedge onboarding. Race
    // readText() against a short timeout so a hung/slow grant prompt can't
    // strand the "Requesting permissions…" state forever — a timeout is
    // recorded identically to a denial (not-granted, non-blocking).
    const outcome = await primeClipboardWithTimeout(() => navigator.clipboard.readText());
    if (outcome === "granted") {
      setPermissions((c) => ({ ...c, clipboard: "granted" }));
      recordSetupEvent("setup_clipboard_permission_granted", {});
    } else {
      setPermissions((c) => ({ ...c, clipboard: "denied" }));
      recordSetupEvent("setup_clipboard_permission_failed", {
        message: outcome === "timeout"
          ? "Clipboard grant prompt did not respond in time — recorded as not granted (non-blocking)."
          : "Clipboard read was blocked."
      });
    }
  };

  // The single stage-1 gesture: screen share first (the required one), then
  // the camera/mic ladder, then the clipboard primer. Skips already-granted
  // items so the same button doubles as "request the remaining permissions".
  const runPermissionsSetup = async () => {
    setPermissionsBusy("all");
    try {
      if (permissions.screen !== "granted" || !acquiredMediaRef.current.screen) await acquireScreenPermission();
      if (permissions.camera !== "granted" || permissions.microphone !== "granted" || !acquiredMediaRef.current.cameraMic) {
        await acquireCameraMicPermission();
      }
      if (permissions.clipboard !== "granted") await acquireClipboardPermission();
    } finally {
      setPermissionsBusy(null);
    }
  };

  const retryPermission = (key: PermissionKey) => {
    setPermissionsBusy(key);
    void (async () => {
      try {
        if (key === "screen") await acquireScreenPermission();
        else if (key === "clipboard") await acquireClipboardPermission();
        else await acquireCameraMicPermission();
      } finally {
        setPermissionsBusy(null);
      }
    })();
  };

  const confirmPermissions = () => {
    if (permissionsConfirmed) return;
    setPermissionsConfirmed(true);
    recordSetupEvent("setup_permissions_confirmed", { ...permissions });
  };

  // A flawless run needs no extra click — auto-continue to the fullscreen step.
  useEffect(() => {
    if (!permissionsConfirmed && allPermissionsGranted(permissions)) confirmPermissions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permissions, permissionsConfirmed]);

  // Stage-1 gate satisfied: the required screen share is live and confirmed —
  // or recording already runs (streams were handed to the recorder).
  const permissionsReady = status === "recording" || status === "ending" || status === "ending_draining" ||
    (permissionsConfirmed && permissions.screen === "granted");

  // S1 exam shell: fullscreen truth, 1-5 stage, top-bar vanish/restore.
  // examReleased is the S3 room-gate seam: released once the room code (or an
  // invigilator start-now) admits this session, or when the gate is disabled.
  const shell = useExamShell({ gate, status, sessionId, examReleased: !examGateActive, permissionsReady, addEvent });
  shellTapRef.current = shell.onShellEvent;

  // F5.3-6: fullscreen HARD-BLOCK ladder + switch-away debounce. The server's
  // violation verdict locks the session in block mode; the candidate-side
  // release is the room's UNLOCK code (UnlockCodePanel on the locked screen).
  const enforcement = useEnforcement({
    gate,
    status,
    sessionId,
    config: {
      reentrySeconds: enforcementPayload?.fullscreen_reentry_seconds ?? 20,
      exitLimit: enforcementPayload?.fullscreen_exit_limit ?? 2,
      mode: enforcementPayload?.mode ?? "block",
      exemptFullscreen: enforcementExemptions.fullscreen === true,
      // #71: heartbeat-delivered (enforcementPayload refreshes each interval), so
      // an admin flipping the toggle reaches live sessions within ~15s.
      simplifiedFullscreenRecovery: enforcementPayload?.simplified_fullscreen_recovery ?? false
    },
    addEvent,
    onLocked: (reason) => {
      setLockedReason(reason);
      // Stop the recorder NOW (the heartbeat's 403 would catch it within one
      // interval anyway, but the lock should be immediate and audible).
      // F1: bank the stint's manifest once the stop has flushed its uploads.
      const active = recorderRef.current;
      if (active) {
        void active.stop()
          .then((items) => collectStintManifest(items, sessionId))
          .catch(() => undefined);
      }
      setStatus("idle");
      setGate("locked");
      speakWarning("Your test has been locked for leaving fullscreen. Raise your hand and call your room proctor.");
    },
    // L1 resolved (typed phrase + back in fullscreen): the typed ack is a
    // stronger acknowledgement than the AnomalyPanel button, so restore the
    // top bar in the same gesture (the reducer still re-checks preconditions).
    onResolved: () => shell.restoreBar()
  });
  enforcementTapRef.current = enforcement.onShellEvent;

  // S5: remaining time on the SERVER clock. Recomputed every render — the 1 s
  // elapsed ticker already re-renders while recording, so this stays live
  // without another interval. null (no end_at yet / old backend) → no countdown.
  // (Plan anchored this at isFormStage; it lives here because the shell chrome
  // below consumes it — the S1 exam shell replaced the old TimerBar.)
  const examRemainingMs = status === "recording" || status === "ending" || status === "ending_draining" ? remainingMs(examEndAt, Date.now(), clockSkewMs) : null;
  const examTimeUp = examRemainingMs !== null && examRemainingMs <= 0;

  // The shared shell chrome — rendered FIRST inside <Shell> on every branch.
  // Kept as a props object so the W1 exam branch can render the same chrome
  // with its extra strip actions + suppressed stage hint.
  const shellChromeProps = {
    shell,
    gate,
    status,
    identity,
    contestName: pinned?.config.contest_name ?? null,
    elapsedSeconds,
    examReleased: !examGateActive,
    permissionsReady,
    permissionsGate: {
      checklist: permissions,
      busy: permissionsBusy,
      screenMessage: screenSetupMessage,
      onRun: () => void runPermissionsSetup(),
      onRetry: retryPermission,
      onContinue: confirmPermissions
    },
    ownEditor: ownEditorCopy,
    remainingLabel: examRemainingMs !== null ? formatRemaining(examRemainingMs) : null,
    timeUp: examTimeUp
  };
  const shellChrome = <ExamShellChrome {...shellChromeProps} />;

  // F5.3: the hard-block takeover renders ABOVE everything on every branch
  // (its own visibility rule already yields to the locked/ended screens).
  const enforcementOverlay = enforcement.overlayVisible ? (
    <EnforcementOverlay
      phase={enforcement.phase}
      violation={enforcement.violation}
      remainingSeconds={enforcement.remainingSeconds}
      exitCount={enforcement.exitCount}
      ackOk={enforcement.ackOk}
      fullscreen={shell.fullscreen}
      simplifiedRecovery={enforcementPayload?.simplified_fullscreen_recovery ?? false}
      onAckChange={enforcement.submitAck}
      onEnterFullscreen={shell.enterFullscreen}
    />
  ) : null;
  // OMR P1 (design §5.1/§5.2): the screen-marker fiducial layer, mounted in
  // BOTH candidate branches that can be on-screen while status === "recording"
  // (the W1 exam view and the classic fallback). The flag arrives ONLY via the
  // start/resume response's optional screen_markers key — absent (flag off /
  // older backend) renders null, so today's live build is bit-for-bit
  // unaffected. marker_layout rides the same additive event funnel.
  const screenMarkersOn = Boolean(sessionConfig?.screen_markers?.enabled);
  const markerLayer = (
    <MarkerLayer
      enabled={screenMarkersOn}
      recording={status === "recording"}
      trackWidth={sessionConfig?.upload_config.max_width ?? SETUP_SCREEN_CONSTRAINTS.maxWidth}
      getScreenTrackSettings={() => recorderRef.current?.getScreenTrackSettings() ?? null}
      onLayout={(detail) => recordSetupEvent("marker_layout", detail)}
    />
  );

  // W2: page top padding follows which fixed header is rendered — the slim
  // strip needs a small offset, the big alert banner a larger one, the locked
  // screen none ("hidden").
  const headerMode = shellHeaderMode(shell.barHidden, gate);
  const shellPadTop: boolean | "alert" = headerMode === "alert" ? "alert" : headerMode === "strip";

  const speakIpChangeWarning = () => {
    const message = "Your IP is changing. Please be attended by our engineer at your institution.";
    speakWarning(message);
  };

  const speakWarning = (message: string) => {
    setReloadWarning(message);
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(message);
    utterance.rate = 0.9;
    utterance.pitch = 1;
    utterance.volume = 1;
    window.speechSynthesis.speak(utterance);
  };

  // Apply the lifecycle status returned by start/resume to the student gate.
  // active → resume/continue recording; pending/locked/ended → blocked screens.
  const applyServerStatus = (session: SessionStartResponse) => {
    setSessionConfig(session);
    setSessionId(session.session_id);
    // S3: gate disabled (or absent on an older backend) → released immediately.
    setExamStarted(!session.room_gate_enabled);
    // F5.3/F5.5: enforcement knobs + exemptions + lock reason ride start/resume
    // (the heartbeat keeps them fresh afterwards).
    if (session.enforcement) setEnforcementPayload(session.enforcement);
    if (session.enforcement_exemptions) setEnforcementExemptions(session.enforcement_exemptions);
    setLockedReason(session.locked_reason ?? null);
    setIdentity({
      name: session.name || form.name.trim(),
      candidate_id: candidateIdOf(session) || form.candidate_id.trim(),
      room: session.room || form.room.trim()
    });
    const serverStatus: ServerSessionStatus = session.status || "active";
    if (serverStatus === "pending_approval") setGate("pending_approval");
    else if (serverStatus === "locked") setGate("locked");
    else if (serverStatus === "ended") setGate("ended");
    else setGate("running");
    // F5 (e2e finding): the warning strip must reflect LIVE state. The server
    // reporting ACTIVE invalidates any lock-episode message ("Your test has
    // been locked…") that would otherwise sit stale over a recovered session.
    if (serverStatus === "active") setReloadWarning("");
    return serverStatus;
  };

  // S3 room gate: while recording with the gate enabled and not yet released,
  // poll every 5 s so an invigilator "Start now" admits the candidate with zero
  // typing. The first tick runs immediately (covers resume-after-reload where
  // the server may already have released this session).
  useEffect(() => {
    if (status !== "recording" || !sessionConfig?.room_gate_enabled || examStarted) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const response = await pollRoomGate(sessionConfig.session_id);
        if (!cancelled && response.exam_started) setExamStarted(true);
      } catch {
        // transient poll errors are silent; the explicit submit surfaces errors
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [status, sessionConfig, examStarted]);

  const submitGateCode = async () => {
    if (!sessionConfig) return;
    setGateBusy(true);
    setGateError("");
    try {
      const response = await pollRoomGate(sessionConfig.session_id, gateCode.trim());
      if (response.exam_started) {
        setExamStarted(true);
        setGateCode("");
      }
    } catch (cause) {
      const apiError = cause as ApiError;
      if (apiError.code === "invalid_code") {
        setGateError("That code is not correct for your room. Check the board or ask your invigilator.");
      } else if (apiError.code === "too_many_attempts") {
        setGateError("Too many wrong attempts. Wait — your invigilator can admit the whole room.");
      } else {
        setGateError(apiError.message || String(cause));
      }
    } finally {
      setGateBusy(false);
    }
  };

  // On load: if a stored session_id exists, resume it WITHOUT re-collecting
  // details (Epic 2). Recording itself is not auto-restarted (getDisplayMedia
  // needs a fresh user gesture) — the student presses "Resume recording".
  useEffect(() => {
    const stored = window.localStorage.getItem(sessionKey);
    if (!stored) {
      setResuming(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        // S-D: person-contest resumes are CONTEST-PINNED (F9 D8) — a token
        // from another contest is indistinguishable from an unknown one.
        const session = await resumeSession(stored, undefined, personPinned ? { contest: pinnedSlug } : undefined);
        if (cancelled) return;
        const serverStatus = applyServerStatus(session);
        setStartIp(session.start_ip || "unavailable");
        setCurrentIp(session.start_ip || "unavailable");
        if (serverStatus === "ended") {
          setStatus("ended");
          window.localStorage.removeItem(sessionKey);
          clearSessionDrafts(stored, window.localStorage);
        }
      } catch {
        // Unknown/expired token — drop it and fall back to the form.
        window.localStorage.removeItem(sessionKey);
        clearSessionDrafts(stored, window.localStorage);
      } finally {
        if (!cancelled) setResuming(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // S2: fetch the public exam config (roster gate + room list) once for the
  // pre-session form. Fail-open on error: the server still enforces the roster
  // at /api/session/start; a fetch failure only degrades the form UI.
  // F5.3: the same payload seeds the enforcement knobs pre-session (start/
  // resume + heartbeat overwrite them later).
  // S-D: a PINNED contest already carries its exam-config (the router fetched
  // it via ?contest=) — no second fetch, the contest doc is authoritative.
  useEffect(() => {
    if (!pinned) return;
    setExamConfig(pinned.config);
    if (pinned.config.enforcement) setEnforcementPayload((current) => current ?? pinned.config.enforcement ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (status !== "recording") return;
    // Computed when recording starts — sessionConfig (and its problem) is
    // already set by then, so the notices match the active surface.
    const integrityNotices = studentCopy.integrityNotices(Boolean(sessionConfig?.problem));
    let noticeIndex = Math.floor(Math.random() * integrityNotices.length);
    const addNotice = () => {
      const text = integrityNotices[noticeIndex % integrityNotices.length];
      noticeIndex += 1 + Math.floor(Math.random() * 3);
      addEvent({
        type: "integrity_notice",
        timestamp: new Date().toISOString(),
        visibility_state: document.visibilityState,
        detail: { message: text }
      });
    };

    addNotice();
    const timer = window.setInterval(addNotice, 12_000 + Math.floor(Math.random() * 8_000));
    return () => window.clearInterval(timer);
  }, [status]);

  // F5.7: the elapsed ticker is bound to the live test status — the pure
  // elapsedTimerActive rule stops it the moment status OR gate reports ended
  // (the last value freezes; the bar never shows a count-up after test end).
  // The cleanup also covers unmount, so no interval survives the component.
  useEffect(() => {
    if (!elapsedTimerActive({ status, gate }) || !recordingStartedAt) return;
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - recordingStartedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [recordingStartedAt, status, gate]);

  // S5: announce "time is up" once when the countdown crosses zero while
  // recording. Soft enforcement by design: the recording continues so the
  // candidate ends their own test (manifest intact); the hard stop is the
  // admin's End-now (which 409s the heartbeat → B1 self-stop).
  useEffect(() => {
    if (status !== "recording" || !examEndAt) return;
    const check = () => {
      const left = remainingMs(examEndAt, Date.now(), clockSkewMs);
      if (left === null || left > 0 || timeUpAnnouncedRef.current) return;
      timeUpAnnouncedRef.current = true;
      speakWarning("Time is up. Please end your test now.");
      const event = createUiEvent("exam_time_up", { end_at: examEndAt });
      addEvent(event);
      // F9: best-effort — expected 403/409 once the session is locked/ended.
      if (sessionId) void sendEvents(sessionId, [event]).catch(() => undefined);
    };
    check();
    const timer = window.setInterval(check, 1000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, examEndAt, clockSkewMs, sessionId]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (status !== "recording" && status !== "ending" && status !== "ending_draining") return;
      const message = "You must end the test from the proctor page before closing this tab.";
      event.preventDefault();
      event.returnValue = message;
      return message;
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [status]);

  // STUDENT TAB-CLOSE BEACON: stamp liveness and raise the tab_hidden sure-shot.
  // visibilitychange→hidden sends kind:'hidden'; pagehide sends kind:'closing'.
  // Guarded on having an active session_id so the form/ended screens stay silent.
  // navigator.sendBeacon survives unload; demo mode no-ops the network call.
  //
  // Away-signal beacons (hidden/closing) only fire while the exam is GENUINELY
  // live (statusRef.current === "recording"). Once End is pressed the status
  // moves to ending → ended (or error), and the recorder teardown, fullscreen
  // exit, and the candidate switching away to close the tab each flip the tab to
  // hidden — none of those are a mid-exam tab-switch, so gating here is what
  // stops the end-of-session tab_hidden false positive (the backend raises that
  // alert SOLELY from this beacon). A 'visible' return-to-foreground beacon stays
  // unconditional liveness — it never raises an alert.
  useEffect(() => {
    if (!sessionId) return;
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        sendSessionBeacon(sessionId, "visible");
      } else if (document.visibilityState === "hidden" && awayBeaconActive(statusRef.current)) {
        sendSessionBeacon(sessionId, "hidden");
      }
    };
    const onPageHide = () => {
      if (awayBeaconActive(statusRef.current)) sendSessionBeacon(sessionId, "closing");
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [sessionId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (status !== "recording" && status !== "ending" && status !== "ending_draining") return;
      const key = event.key.toLowerCase();
      const isReloadShortcut = key === "f5" || ((event.metaKey || event.ctrlKey) && key === "r");
      if (!isReloadShortcut) return;

      event.preventDefault();
      event.stopPropagation();
      const message = "Reload is blocked during proctoring. If you reload by accident, your session resumes automatically — just press Resume recording.";
      setReloadWarning(message);
      const reloadEvent = createUiEvent("reload_shortcut_blocked", {
        key: event.key,
        ctrl_key: event.ctrlKey,
        meta_key: event.metaKey
      });
      addEvent(reloadEvent);
      // F9: best-effort — expected 403/409 once the session is locked/ended.
      if (sessionId) void sendEvents(sessionId, [reloadEvent]).catch(() => undefined);
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [sessionId, status]);

  useEffect(() => {
    const video = cameraVideoRef.current;
    if (!video) return;
    video.srcObject = cameraStream;
    if (cameraStream) {
      void video.play().catch(() => undefined);
    }
  }, [cameraStream]);

  // W1: the camera <video> host moves between layouts (sidebar self-view in
  // the waiting/legacy views ↔ the floating dock in the exam view). The effect
  // above only re-attaches the stream when cameraStream CHANGES, so a
  // remounted element would stay black after a branch switch. This callback
  // ref re-attaches the live stream whenever a new node mounts. The camera
  // CAPTURE itself lives in the recorder (off-DOM) — this is preview-only.
  const attachCameraVideo = useMemo(() => {
    // OMR P1: enter/leave PiP listeners ride every mounted camera node so the
    // camera_pip event fires however the pop-out starts or ends (button, the
    // PiP window's own close control, node unmount). Additive only — the
    // existing stream re-attach behavior is unchanged.
    let pipAttached: HTMLVideoElement | null = null;
    const onPipEnter = () => cameraPipEmitRef.current(true);
    const onPipLeave = () => cameraPipEmitRef.current(false);
    return (node: HTMLVideoElement | null) => {
      if (pipAttached && pipAttached !== node) {
        pipAttached.removeEventListener("enterpictureinpicture", onPipEnter);
        pipAttached.removeEventListener("leavepictureinpicture", onPipLeave);
      }
      if (node && node !== pipAttached) {
        node.addEventListener("enterpictureinpicture", onPipEnter);
        node.addEventListener("leavepictureinpicture", onPipLeave);
      }
      pipAttached = node;
      cameraVideoRef.current = node;
      const stream = cameraStreamRef.current;
      if (node && node.srcObject !== stream) {
        node.srcObject = stream;
        if (stream) void node.play().catch(() => undefined);
      }
    };
  }, []);

  // S5: apply a server-reported exam end time + clock stamp. Announces a
  // mid-exam change (extended/shortened) exactly once per change; the notice
  // stays visible until the next change. The first end_at received is silent.
  const applyExamTime = (endAt?: string, serverNow?: string) => {
    if (!endAt) return;
    setClockSkewMs(computeClockSkewMs(serverNow, Date.now()));
    const change = classifyEndAtChange(examEndAtRef.current, endAt);
    examEndAtRef.current = endAt;
    setExamEndAt(endAt);
    if (change !== "extended" && change !== "shortened") return;
    const at = new Date(endAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (change === "extended") {
      timeUpAnnouncedRef.current = false; // more time: a past "time is up" no longer holds
      // F5: an extension also invalidates a lingering "Time is up" strip.
      setReloadWarning("");
      setExamTimeNotice(`The proctor extended the exam — new end time ${at}.`);
    } else {
      setExamTimeNotice(`The proctor moved the exam end earlier — new end time ${at}.`);
      speakWarning("Attention: the exam end time has been moved earlier. Check the timer.");
    }
  };

  // Bring up the recorder for an active session. Shared by first-start and by
  // "Resume recording" after a reload. F5.1: recording starts IMMEDIATELY from
  // the streams the stage-1 PermissionsGate already acquired — start() only
  // re-prompts when the candidate killed the share in between.
  const beginRecording = async (session: SessionStartResponse) => {
    // If a prior recorder is still around (e.g. screen share dropped mid-session
    // and the student is retrying), tear it down first so we don't leave a second
    // heartbeat/upload loop running against the same session.
    if (recorderRef.current) {
      const prior = recorderRef.current;
      recorderRef.current = null;
      await prior.stop().catch(() => undefined);
      // F1: bank the finished stint's manifest before the new stint starts.
      collectStintManifest(prior.getManifest(), session.session_id);
    }
    // F1: restore prior stints banked before a same-tab refresh (idempotent —
    // the merge de-duplicates by (kind, index)).
    stintManifestRef.current = mergeManifest(
      readStintManifest(window.sessionStorage, session.session_id),
      stintManifestRef.current
    );
    // Flush the queued setup-stage audit events now that a session exists.
    const queuedSetupEvents = preSessionEventsRef.current;
    preSessionEventsRef.current = [];
    // F9: best-effort — expected 403/409 if the session got blocked meanwhile.
    if (queuedSetupEvents.length) void sendEvents(session.session_id, queuedSetupEvents).catch(() => undefined);
    setStartIp(session.start_ip || "unavailable");
    setCurrentIp(session.start_ip || "unavailable");
    setIpChanged(false);
    // ownEditor comes from the response itself — the sessionConfig state set
    // moments ago has not re-rendered into this closure yet.
    await collectEntryReviewEvidence(session.session_id, Boolean(session.problem));

    // Hand the stage-1 streams over to the recorder. Clearing the ref disarms
    // the setup ended-listener (identity check) — from here the recorder owns
    // stream lifecycle, and recorder.stop() owns cleanup even on a failed start.
    const acquired = acquiredMediaRef.current;
    acquiredMediaRef.current = { screen: null, cameraMic: null, cameraMicMode: null };

    const recorder = createProctorRecorder({
      sessionId: session.session_id,
      config: session.upload_config,
      heartbeatSeconds: session.heartbeat_interval_seconds,
      // F1: chunk indexes CONTINUE from the prior stint's high-water mark —
      // max over the server's knowledge (start/resume counts + exact hwm) and
      // the local sessionStorage hwm — so a restarted recording never reuses
      // an index and never overwrites earlier chunks. All legs are 0 for a
      // fresh session (indexes start at 1, exactly as before).
      chunkIndexBase: {
        screen: chunkIndexBase([
          session.chunk_count,
          session.screen_chunk_index_hwm,
          readChunkHwm(window.sessionStorage, session.session_id, "screen")
        ]),
        camera: chunkIndexBase([
          session.camera_chunk_count,
          session.camera_chunk_index_hwm,
          readChunkHwm(window.sessionStorage, session.session_id, "camera")
        ])
      },
      acquired,
      onEvent: addEvent,
      onUploadChange: (depth, uploaded) => {
        setQueueDepth(depth);
        setUploadedCount(uploaded);
      },
      // Tier-1: the recorder reports buffer mode + live pending count/bytes on
      // every write/drain/evict/mode-flip. Drives the amber HealthPanel state +
      // the end-of-test drain wait gate.
      onBufferChange: setBufferStatus,
      onFatalError: (message) => {
        if (message.includes("Screen sharing stopped")) {
          // Recoverable: the session is still active server-side; the student can
          // re-share their screen inline (no reload) to resume recording.
          setStatus("idle");
          setStartError({
            kind: "share_cancelled",
            message: "Screen sharing stopped, so recording is paused. This is logged. Press Resume screen share and choose your Entire Screen to continue — do not close this tab."
          });
          speakWarning("Screen sharing stopped. Press 'Try again — share entire screen' below to continue.");
        } else {
          // A local capture failure (e.g. MediaRecorder error). Still recoverable
          // via Try again, but surface the raw reason for transparency.
          setStatus("idle");
          setStartError({ kind: "unknown", message: `${message} You can press Try again to restart recording without reloading.` });
        }
      },
      // B1: the server locked/ended/paused this session — the recorder has
      // already stopped itself. Flip the gate to the matching blocked screen so
      // the UI stops claiming "recording".
      onStatusChange: (serverStatus) => {
        // F1: bank whatever this stint managed to upload (idempotent merge; a
        // later teardown/end re-collects and fills in any still-in-flight tail).
        collectStintManifest(recorderRef.current?.getManifest(), session.session_id);
        if (serverStatus === "ended") {
          setStatus("ended");
          setGate("ended");
          window.localStorage.removeItem(sessionKey);
          clearSessionDrafts(session.session_id, window.localStorage);
        } else if (serverStatus === "locked") {
          setStatus("idle");
          setGate("locked");
          speakWarning("Your test has been locked by a proctor. Recording has stopped.");
        } else if (serverStatus === "pending_approval") {
          setStatus("idle");
          setGate("pending_approval");
        }
      },
      onMediaStateChange: setMediaCapture,
      onIpStatusChange: (ipStatus) => {
        setStartIp(ipStatus.startIp);
        setCurrentIp(ipStatus.currentIp);
        setIpChanged(ipStatus.ipChanged);
        if (ipStatus.newlyChanged) speakIpChangeWarning();
      },
      // S5: heartbeat-delivered exam end time → live countdown update.
      onExamTimeChange: ({ endAt, serverNow }) => applyExamTime(endAt, serverNow),
      // F5.3/F5.5: heartbeat-delivered enforcement config + exemptions — an
      // admin/invigilator exemption applies live within one interval.
      onEnforcementChange: ({ enforcement: config, exemptions }) => {
        if (config) setEnforcementPayload(config);
        if (exemptions) setEnforcementExemptions(exemptions);
      },
      onCameraStream: (stream) => {
        setCameraStream(stream);
        const video = cameraVideoRef.current;
        if (video) {
          video.srcObject = stream;
        }
      }
    });
    recorderRef.current = recorder;
    await recorder.start();
    // F7 (e2e finding): ELAPSED anchors on the SESSION's server-side start
    // (skew-corrected), not on this stint — a recording restart or a reload
    // resumes the count instead of resetting to 0:00. Pre-F7 backends send no
    // created_at → the anchor degrades to "now" (the old per-stint behavior).
    const anchor = sessionElapsedAnchorMs(session.created_at, session.server_now, Date.now());
    setRecordingStartedAt(anchor);
    setElapsedSeconds(Math.max(0, Math.floor((Date.now() - anchor) / 1000)));
    // F5 (e2e finding): recording is LIVE again — any prior episode's warning
    // strip ("Screen sharing stopped…", "…locked…", reload notice) is stale now.
    setReloadWarning("");
    setStatus("recording");
  };

  // Translate a recorder start failure into recoverable, human-readable copy. The
  // student is left in a clear NOT-RECORDING state with an inline Try-again button
  // (no page reload). Server/registration errors keep the generic message.
  const handleStartFailure = (cause: unknown) => {
    // Tier-1: require_buffer venue + a failed buffer self-test → block start with
    // the buffer remediation copy (only reachable when an admin opted in; default
    // require_buffer=false never throws this — the session just runs in fallback).
    if (cause instanceof BufferRequiredError) {
      setStartError({ kind: "unknown", message: cause.message });
      setStatus("idle");
      return;
    }
    const kind = classifyStartError(cause);
    let message: string;
    if (kind === "invalid_surface") {
      message = "You must share your ENTIRE SCREEN — you selected a tab or window. Recording has not started. Press Try again and choose Entire Screen.";
    } else if (kind === "share_cancelled") {
      message = "Screen share was cancelled or blocked, so recording has not started. Press Try again, then choose Entire Screen and allow access.";
    } else if (kind === "unsupported") {
      message = "This browser cannot record your screen. Open this page in the latest Chrome or Edge on a laptop or desktop, then press Try again.";
    } else {
      message = cause instanceof Error ? cause.message : String(cause);
    }
    setStartError({ kind, message });
    setStatus("idle");
  };

  // S2: look up the typed unique ID against the server-side roster.
  const lookupRosterId = async () => {
    // Re-clicking during the post-429 cooldown would just burn more budget.
    if (Date.now() < lookupCooldownUntil) return;
    setLookupBusy(true);
    setLookupError("");
    try {
      setRosterMatch(await rosterLookup(uniqueIdInput.trim()));
    } catch (cause) {
      setRosterMatch(null);
      const err = cause as ApiError;
      const retryAfter = Number(err?.body?.retry_after_seconds);
      // On a 429 (M3 shared-network throttle) keep the button disabled for the
      // retry window so re-clicks don't extend the lockout; cap the cooldown so a
      // bogus huge value can't trap the candidate.
      if (err?.status === 429 || err?.code === "rate_limited") {
        const waitMs = (Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 120) : 60) * 1000;
        setLookupCooldownUntil(Date.now() + waitMs);
      }
      setLookupError(
        err?.status !== undefined || err?.code !== undefined
          ? rosterLookupErrorMessage(err?.status, err?.code, retryAfter)
          : cause instanceof Error ? cause.message : String(cause)
      );
    } finally {
      setLookupBusy(false);
    }
  };

  // Drive the post-429 cooldown: `lookupCooldownActive` is true while the window
  // is open, and an effect re-renders once it elapses so the Find-me button
  // re-enables without the candidate having to interact.
  const [cooldownTick, setCooldownTick] = useState(0);
  const lookupCooldownActive = lookupCooldownUntil > Date.now();
  useEffect(() => {
    if (!lookupCooldownActive) return;
    const id = window.setTimeout(() => setCooldownTick((t) => t + 1), Math.max(250, lookupCooldownUntil - Date.now()));
    return () => window.clearTimeout(id);
    // cooldownTick re-arms the timer after each elapse check.
  }, [lookupCooldownActive, lookupCooldownUntil, cooldownTick]);

  // "Yes, this is me": prefill the form from the roster record. Roster-sourced
  // fields render disabled; the server overrides them again at start anyway
  // (the roster is the identity source of truth — this is just honest UI).
  const confirmRosterMatch = () => {
    if (!rosterMatch) return;
    setForm({
      ...form,
      roster_unique_id: rosterMatch.unique_id,
      candidate_id: candidateIdOf(rosterMatch) || form.candidate_id,
      name: rosterMatch.name || form.name,
      roll_number: rosterMatch.roll_number || form.roll_number,
      email: rosterMatch.email_masked || form.email,
      room: rosterMatch.room || form.room
    });
  };

  const rejectRosterMatch = () => {
    setRosterMatch(null);
    setLookupError("");
  };

  const resetRosterIdentity = () => {
    setRosterMatch(null);
    setUniqueIdInput("");
    setLookupError("");
    setForm({ ...initialForm });
  };

  const start = async () => {
    setError("");
    setStartError(null);
    setStatus("starting");
    let session: SessionStartResponse;
    try {
      session = await startSession(
        {
          ...form,
          candidate_id: form.candidate_id.trim(),
          name: form.name.trim(),
          roll_number: form.roll_number.trim(),
          email: form.email.trim(),
          room: form.room.trim()
        },
        undefined,
        // S-D: a pinned PERSON contest rides the start body (server-side
        // identity resolution); a college pick answers a 409 college_choices.
        personPinned ? { contest: pinnedSlug, college: collegeChoice || undefined } : undefined
      );
      setCollegeChoices(null);
      setCollegeChoice("");
      // Persist the token so a reload resumes the same session (Epic 2).
      window.localStorage.setItem(sessionKey, session.session_id);
      applyExamTime(session.end_at, session.server_now);
      const serverStatus = applyServerStatus(session);
      if (serverStatus !== "active") {
        // pending_approval / locked / ended — do not start the recorder.
        setStatus("idle");
        return;
      }
    } catch (cause) {
      // Registration/gate failure (time window, roster, network, ...). Roster
      // codes get a specific human message; everything else stays generic.
      const apiError = cause as ApiError;
      const code = apiError?.code;
      // S-C/S-D: GENUINE ambiguity — the same id exists under two colleges.
      // Render the picker; the next Start retries with the pick as `college`.
      if (code === "college_choices" && Array.isArray(apiError.body?.college_choices)) {
        setCollegeChoices(apiError.body.college_choices as CollegeChoice[]);
        setCollegeChoice("");
        setError("");
        setStatus("idle");
        return;
      }
      setError(
        code === "not_on_roster" || code === "roster_id_required"
          ? formMode === "person_roster"
            ? `Your ${examConfig?.unique_id_label || "ID"} was not found on the list for this test. Check it and try again, or call an invigilator.`
            : "Your ID was not matched on the student list. Use “Not you? Re-enter ID” to redo the identity step, or call an invigilator."
          : cause instanceof Error ? cause.message : String(cause)
      );
      setStatus("idle");
      return;
    }

    // Screen-share / capture phase. A failure here is recoverable inline — the
    // session exists, the student just needs to re-share (no reload, no re-entry).
    try {
      await beginRecording(session);
    } catch (cause) {
      handleStartFailure(cause);
    }
  };

  // Resume recording for an already-active session restored on reload. Re-checks
  // the server status (in case a proctor locked/ended it) before recording.
  const resumeRecording = async () => {
    if (!sessionConfig) return;
    setError("");
    setStartError(null);
    setStatus("starting");
    let session: SessionStartResponse;
    try {
      session = await resumeSession(sessionConfig.session_id, undefined, personPinned ? { contest: pinnedSlug } : undefined);
      applyExamTime(session.end_at, session.server_now);
      const serverStatus = applyServerStatus(session);
      if (serverStatus !== "active") {
        setStatus("idle");
        if (serverStatus === "ended") {
          window.localStorage.removeItem(sessionKey);
          clearSessionDrafts(sessionConfig.session_id, window.localStorage);
        }
        return;
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus("idle");
      return;
    }

    try {
      await beginRecording(session);
    } catch (cause) {
      handleStartFailure(cause);
    }
  };

  // Inline "Try again" for a failed screen share — re-invokes the share prompt
  // WITHOUT a page reload. Routes to resume when a session was already restored,
  // otherwise re-runs the first-start share for the just-created session.
  const retryScreenShare = () => {
    setStartError(null);
    if (gate === "running" && sessionConfig) void resumeRecording();
    else void start();
  };

  // Re-poll the server status from a blocked screen (pending/locked) so the
  // student can self-serve once a proctor acts, without staff intervention.
  const refreshStatus = async () => {
    if (!sessionConfig) return;
    setError("");
    try {
      const session = await resumeSession(sessionConfig.session_id, undefined, personPinned ? { contest: pinnedSlug } : undefined);
      applyExamTime(session.end_at, session.server_now);
      const serverStatus = applyServerStatus(session);
      if (serverStatus === "ended") {
        setStatus("ended");
        window.localStorage.removeItem(sessionKey);
        clearSessionDrafts(sessionConfig.session_id, window.localStorage);
      }
      // Wave-3 walkthrough residue: a release back to ACTIVE must not carry a
      // red error line from the lock episode into the running view — the
      // stale message sat above the workspace until the next state change.
      // start()/resumeRecording() clear these themselves; this is the
      // blocked-screen path (Check again / unlock code).
      if (serverStatus === "active") setStartError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  // F5.3: a lock arriving via the heartbeat channel (403 session_locked)
  // carries no reason — fetch it once so the locked screen knows whether to
  // offer the room-code unlock (enforcement lock) or not (admin lock).
  useEffect(() => {
    if (gate !== "locked" || lockedReason !== null || !sessionConfig) return;
    void refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gate, lockedReason]);

  const collectEntryReviewEvidence = async (activeSessionId: string, ownEditor: boolean) => {
    const now = new Date().toISOString();
    const tabRecord = {
      type: "browser_tab_audit",
      timestamp: now,
      current_url: window.location.href,
      current_title: document.title,
      visibility_state: document.visibilityState,
      status: "screen_and_focus_review_active",
      explanation: "Candidate-facing UI shows tab/focus review as active. Browser tab inventory requires a managed browser extension; full-screen recording and focus events are used in this web-only build."
    };
    setTabAudit(studentCopy.tabAuditMessage(ownEditor));
    await uploadReviewFile(activeSessionId, "tabs", [tabRecord]);
    addEvent({
      type: "tabs_review_uploaded",
      timestamp: now,
      visibility_state: document.visibilityState,
      detail: { message: "Tab/focus review active. Shared-screen recording and focus changes are logged." }
    });

    // M6 (privacy): we DO NOT snapshot the candidate's clipboard at entry. The
    // entry read captured whatever was copied BEFORE the session/consent — that
    // is pre-session content outside the disclosed monitoring scope. Clipboard
    // monitoring instead begins with the session: the recorder logs in-exam
    // copy/cut/paste (clipboard_activity) once recording starts. We record only
    // a NON-CONTENT note here so the proctor knows the scope, never the text.
    setClipboardAudit("Clipboard content is not captured at entry. Copy, cut, and paste actions during the test are logged for review.");
    await uploadReviewFile(activeSessionId, "clipboard", [{
      type: "clipboard_monitoring_in_exam_only",
      timestamp: new Date().toISOString(),
      note: "Entry-time clipboard content is not snapshotted (pre-session scope). In-exam copy/cut/paste is logged as clipboard_activity.",
      visibility_state: document.visibilityState
    }]);
    addEvent({
      type: "clipboard_monitoring_in_exam_only",
      timestamp: new Date().toISOString(),
      visibility_state: document.visibilityState,
      detail: { note: "Entry-time clipboard content not captured; in-exam copy/cut/paste is logged." }
    });

    const cookieRecord = {
      type: "app_cookie_storage_audit",
      timestamp: new Date().toISOString(),
      app_cookie_length: document.cookie.length,
      app_cookies: document.cookie,
      local_storage_keys: Object.keys(window.localStorage),
      session_storage_keys: Object.keys(window.sessionStorage),
      limitation: "A normal website can only read cookies and storage for its own origin. HackerRank cookies, AI-site cookies, browser history, and other-site sessions require a managed browser extension or endpoint agent."
    };
    setCookieAudit("App cookies/storage captured. Other-site cookies and browser history are blocked by browser isolation and cannot be read by this web page.");
    await uploadReviewFile(activeSessionId, "cookies", [cookieRecord]);
    addEvent({
      type: "cookie_storage_review_uploaded",
      timestamp: new Date().toISOString(),
      visibility_state: document.visibilityState,
      detail: { message: "App-origin cookies/storage captured; other-site cookies are browser-protected." }
    });
  };

  // Tier-1 END-OF-TEST WAIT GATE: in buffering mode, BLOCK close while the
  // session's pending buffer is non-empty. The recorder's drainer keeps running
  // after recorder.stop() (it is gated by its own dispose flag, not stopping),
  // so we just kick it and poll until pendingCount hits 0 — onBufferChange live-
  // updates the overlay counters meanwhile. Returns when drained (or the buffer
  // degraded to fallback mid-wait, in which case the gate releases = floor).
  // FALLBACK mode never enters here (caller checks mode first), so the end path
  // stays exactly today's behavior when buffering is off.
  const waitForBufferDrain = async () => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.getBufferMode() !== "buffering") return;
    let initial = await recorder.getBufferStatus();
    if (initial.mode !== "buffering" || initial.pendingCount <= 0) return;
    setStatus("ending_draining");
    {
      const event = createUiEvent("end_wait_for_drain", { pending_count: initial.pendingCount, pending_bytes: initial.pendingBytes });
      addEvent(event);
      if (sessionId) void sendEvents(sessionId, [event]).catch(() => undefined);
    }
    try {
      // Poll until empty. The drainer (online + 12s timer + post-success kicks)
      // owns the actual uploads; we kick once per poll as a belt-and-braces wake.
      // The wait is intentionally long (the candidate must not close while
      // footage is still pending — the overlay says "tell your invigilator"),
      // but it BREAKS if a proctor admin-ends/locks the session mid-wait (the
      // recorder self-stops + onStatusChange flips status away from
      // ending_draining), so we never orphan an endless poll after the UI moved on.
      for (let guard = 0; guard < 100_000; guard += 1) {
        if (statusRef.current !== "ending_draining") break;
        recorder.kickDrain();
        const current = await recorder.getBufferStatus();
        if (current.mode !== "buffering" || current.pendingCount <= 0) {
          initial = current;
          break;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
      }
    } finally {
      const event = createUiEvent("end_drain_complete", { pending_count: initial.pendingCount });
      addEvent(event);
      if (sessionId) void sendEvents(sessionId, [event]).catch(() => undefined);
    }
  };

  const stop = async () => {
    if (!assuranceAccepted) {
      setError("Integrity assurance is required before ending the test.");
      return;
    }
    setStatus("ending");
    setError("");
    setEndFailed(false);
    let recorderStopped = false;
    try {
      if (sessionId) {
        await validateEndSession({ sessionId, assuranceAccepted });
      }
      const finalManifest = await recorderRef.current?.stop();
      recorderStopped = true;
      // Tier-1: BLOCK on the buffer drain BEFORE endSession (buffering mode
      // only; no-op in fallback). The final chunks landed in `pending` during
      // recorder.stop(); we do not call endSession until they are all in GCS.
      await waitForBufferDrain();
      // F1: the submitted manifest covers EVERY stint of this session — the
      // banked prior stints merged with the final recorder's own list. After the
      // drain wait the recorder's manifest includes the drained chunks too.
      const uploads = mergeManifest(stintManifestRef.current, recorderRef.current?.getManifest() ?? finalManifest ?? []);
      setManifest(uploads);
      if (sessionId) {
        await endSession({ sessionId, manifest: uploads, assuranceAccepted });
      }
      window.localStorage.removeItem(sessionKey);
      if (sessionId) {
        clearSessionDrafts(sessionId, window.localStorage);
        clearChunkContinuity(window.sessionStorage, sessionId);
        // Tier-1: drop the durable buffer ONLY now — confirmed-empty drain +
        // successful endSession. Both the recorder's handle and a standalone
        // pass (in case the recorder is already gone) so the store is reclaimed.
        await recorderRef.current?.clearBuffer();
        await clearChunkBuffer(sessionId);
      }
      setStatus("ended");
      setGate("ended");
      setEndRequested(false);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      if (recorderStopped) {
        // The recording is already stopped but submitting the end failed (network,
        // server). Stay on a recoverable "error" state with an inline Retry — never
        // force a reload, which could orphan the session as incomplete.
        setStatus("error");
        setEndFailed(true);
      } else {
        // Nothing stopped yet — drop straight back to recording so the student can
        // re-press End. Keep the End panel open for an immediate retry.
        setStatus("recording");
      }
    }
  };

  // Retry submitting the end after the recording already stopped but the final
  // end/manifest call failed. No reload, no re-recording — just re-send the end.
  const retryEnd = async () => {
    setStatus("ending");
    setError("");
    try {
      // Tier-1: re-drain BEFORE re-submitting end (buffering mode only). The
      // durable buffer survived the failed first attempt, so a stuck chunk gets
      // another chance and the gate releases only at empty.
      await waitForBufferDrain();
      if (sessionId) {
        await endSession({ sessionId, manifest, assuranceAccepted });
      }
      window.localStorage.removeItem(sessionKey);
      if (sessionId) {
        clearSessionDrafts(sessionId, window.localStorage);
        clearChunkContinuity(window.sessionStorage, sessionId);
        // Tier-1: drop the durable buffer ONLY after confirmed-empty + endSession.
        await recorderRef.current?.clearBuffer();
        await clearChunkBuffer(sessionId);
      }
      setEndFailed(false);
      setStatus("ended");
      setGate("ended");
      setEndRequested(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus("error");
      setEndFailed(true);
    }
  };

  // ---- Blocked / non-running gate screens -------------------------------
  if (resuming) {
    return (
      <Shell padTop={shellPadTop}>
        {shellChrome}
        {enforcementOverlay}
        <section className="mx-auto max-w-md rounded-lg border border-line bg-panel p-6 text-center shadow-subtle">
          <RefreshCw size={22} className="mx-auto animate-spin text-accent" />
          <p className="mt-3 text-sm text-muted">Restoring your proctoring session…</p>
        </section>
      </Shell>
    );
  }

  if (gate === "pending_approval") {
    return (
      <Shell padTop={shellPadTop}>
        {shellChrome}
        {identity ? <IdentityCard identity={identity} /> : null}
        <BlockedScreen
          tone="warning"
          icon={<Clock size={22} />}
          title="Waiting for proctor approval"
          lines={[
            "Another session is already active for your Candidate ID.",
            "A proctor must approve this device before you can begin — or you can wait for the other session to be unlocked.",
            "Stay on this page. When the proctor approves you, press Check again to continue."
          ]}
          onRefresh={refreshStatus}
          error={error}
        />
      </Shell>
    );
  }

  if (gate === "locked") {
    const enforcementLock = lockedReason === "fullscreen_enforcement";
    return (
      <Shell padTop={shellPadTop}>
        {shellChrome}
        {identity ? <IdentityCard identity={identity} /> : null}
        <BlockedScreen
          tone="danger"
          icon={<Lock size={22} />}
          title={enforcementLock ? "Your test is locked — fullscreen rule" : "Your test is locked"}
          lines={enforcementLock
            ? [
                "You did not return to fullscreen in time (or exited fullscreen too many times), so this session locked itself.",
                "Raise your hand and call your room proctor. They can read you a 6-digit unlock code to enter here, or unlock you from their console."
              ]
            : [
                "A proctor has locked this session. You cannot record until it is unlocked.",
                "Raise your hand and call a proctor to your room. When they unlock you, press Check again."
              ]}
          onRefresh={refreshStatus}
          error={error}
        />
        {enforcementLock && sessionId ? (
          <UnlockCodePanel
            sessionId={sessionId}
            onUnlocked={() => {
              setLockedReason(null);
              void refreshStatus();
            }}
          />
        ) : null}
      </Shell>
    );
  }

  if (gate === "ended" || status === "ended") {
    return (
      <Shell padTop={shellPadTop}>
        {shellChrome}
        {identity ? <IdentityCard identity={identity} /> : null}
        <section className="mx-auto max-w-xl rounded-lg border border-accent/30 bg-accent/5 p-6 text-center shadow-subtle">
          <CheckCircle2 size={28} className="mx-auto text-accent" />
          <h1 className="mt-3 text-2xl font-semibold text-ink">Done — it&rsquo;s safe to exit</h1>
          <p className="mt-2 text-sm leading-6 text-muted">
            Your proctoring session is complete and the recording has been fully uploaded for review. It is now
            safe to exit fullscreen and close this tab.
          </p>
          {manifest.length ? <p className="mt-3 text-xs text-muted">{manifest.length} recording segment(s) uploaded.</p> : null}
        </section>
      </Shell>
    );
  }

  // gate === "form" (no session yet) or "running" (active session)
  const isFormStage = gate === "form" && status !== "recording" && status !== "ending" && status !== "ending_draining";

  // W1 — the exam itself: an own-editor session, actively recording, released
  // into the exam. The coding workspace IS the page. Everything else tucks
  // into the slim strip (W2 — proctoring-panel toggle + End test live there),
  // the collapsible proctoring panel, and the floating camera dock. All
  // capture/preview hosts stay MOUNTED — every collapse is CSS-only. Legacy
  // (HackerRank-link) sessions and all waiting/error states keep the classic
  // proctoring-first layout below.
  if (hasProblem && status === "recording" && gate === "running" && !examGateActive) {
    return (
      <Shell padTop={shellPadTop} variant="exam">
        <ExamShellChrome
          {...shellChromeProps}
          hideStageHint
          actions={
            <span className="flex items-center gap-2">
              <button
                className="focus-ring flex items-center gap-1 rounded-md border border-white/25 px-2.5 py-1 text-xs font-medium text-white/85 hover:bg-white/10"
                aria-expanded={proctorPanelOpen}
                onClick={() => {
                  // The panel opens at the top of the content — surface it even
                  // when the candidate is scrolled deep into a problem.
                  setProctorPanelOpen((open) => !open);
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
              >
                <ShieldCheck size={13} /> Proctoring {proctorPanelOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </button>
              <button
                className="focus-ring flex items-center gap-1 rounded-md bg-danger px-2.5 py-1 text-xs font-semibold text-white hover:bg-danger/90"
                onClick={() => {
                  setEndRequested(true);
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
              >
                <Square size={11} /> End test
              </button>
            </span>
          }
        />
        {enforcementOverlay}
        {markerLayer}

        {/* Functional notices only — nothing else sits above the workspace. */}
        {examTimeNotice ? (
          <div className="mb-5 rounded-lg border border-accent/30 bg-accent/10 p-4 text-sm text-ink">{examTimeNotice}</div>
        ) : null}
        {examTimeUp ? (
          <div className="mb-5 rounded-lg border border-danger/40 bg-danger/10 p-4">
            <p className="text-sm font-semibold text-danger">Time is up</p>
            <p className="mt-1 text-sm leading-6 text-ink">The exam has ended. Stop working now and end your test from this page — your recording continues until you end it.</p>
          </div>
        ) : null}
        {reloadWarning ? (
          <div className="mb-5 rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm font-medium text-warning">{reloadWarning}</div>
        ) : null}
        {error ? (
          <div className="mb-5 rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger">{error}</div>
        ) : null}
        {endRequested ? (
          <div className="mb-5 [&>*]:mt-0">
            <EndTestPanel
              assuranceAccepted={assuranceAccepted}
              hasProblem={ownEditorCopy}
              onAssuranceChange={setAssuranceAccepted}
              onCancel={() => setEndRequested(false)}
              onEnd={stop}
            />
          </div>
        ) : null}

        {/* The collapsible proctoring panel — ALWAYS MOUNTED (css-hidden when
            collapsed) so no telemetry/preview host ever unmounts. */}
        <div className={proctorPanelOpen ? "mb-5 space-y-5" : "hidden"}>
          <div className="grid gap-5 lg:grid-cols-3">
            <HealthPanel status={status} sessionId={sessionId} config={sessionConfig} queueDepth={queueDepth} uploadedCount={uploadedCount} manifest={manifest} mediaCapture={mediaCapture} startIp={startIp} currentIp={currentIp} ipChanged={ipChanged} bufferStatus={bufferStatus} />
            <EntryReviewPanel clipboardAudit={clipboardAudit} tabAudit={tabAudit} cookieAudit={cookieAudit} />
            <RulesPanel hasProblem={ownEditorCopy} />
          </div>
          <RecentEventsPanel events={events} />
        </div>

        {/* S4/S-I: the workspace — THE page (W1). Same conditions as before
            the redesign: own-editor problems, live session, recording. */}
        <MultiProblemWorkspace
          sessionId={sessionId}
          problems={sessionProblems}
          submissionsSummary={sessionConfig?.submissions_summary}
          submitBudget={sessionConfig?.submit_budget ?? null}
        />

        <CameraDock
          videoRef={attachCameraVideo}
          mediaCapture={mediaCapture}
          cameraRecorded={cameraRecordingOn}
          collapsed={cameraDockCollapsed}
          onToggle={() => setCameraDockCollapsed((collapsed) => !collapsed)}
        />
      </Shell>
    );
  }

  return (
    <Shell padTop={shellPadTop}>
      {shellChrome}
      {enforcementOverlay}
      {status === "ending" ? <FinishingOverlay /> : null}
      {/* Tier-1: the end-of-test drain wait gate — same blocking takeover with
          live remaining segments/MB. awayBeaconActive() returns false for
          ending_draining (it is NOT "recording"), so this long wait never fires
          a spurious tab_hidden/closing beacon. */}
      {status === "ending_draining" ? <FinishingOverlay draining={{ pendingCount: bufferStatus.pendingCount, pendingBytes: bufferStatus.pendingBytes }} /> : null}
      {markerLayer}
      {identity && !isFormStage ? <IdentityCard identity={identity} /> : null}

      {/* S5: end-time change notice + time-up banner. The countdown itself lives
          in the shell's ExamTopBar (the S1 replacement for the old TimerBar). */}
      {examTimeNotice && (status === "recording" || status === "ending" || status === "ending_draining") ? (
        <div className="mb-5 rounded-lg border border-accent/30 bg-accent/10 p-4 text-sm text-ink">{examTimeNotice}</div>
      ) : null}
      {examTimeUp && status === "recording" ? (
        <div className="mb-5 rounded-lg border border-danger/40 bg-danger/10 p-4">
          <p className="text-sm font-semibold text-danger">Time is up</p>
          <p className="mt-1 text-sm leading-6 text-ink">The exam has ended. Stop working now and end your test from this page — your recording continues until you end it.</p>
        </div>
      ) : null}

      {/* Pre-start: the rules are the headline, not a sidebar afterthought. The
          candidate reads exactly what is required and what is recorded before the
          form, so the rules are unmissable. */}
      {isFormStage ? <PreStartRules hasProblem={ownEditorCopy} /> : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-accent">
                Aerele Proctor{pinned ? ` — ${pinned.config.contest_name}` : ""}
              </p>
              <h1 className="mt-2 text-2xl font-semibold text-ink">
                {isFormStage ? "Register and start recording" : activeProblem ? "Proctored coding test" : "HackerRank companion recording"}
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
                {isFormStage
                  ? studentCopy.formStageIntro(ownEditorCopy)
                  : activeProblem
                    // UX-H3: with a problem assigned but recording down (share
                    // dropped / resume pending), "solve the problem below" points
                    // at a hidden workspace — name the paused state and the fix.
                    ? status === "recording" || status === "ending" || status === "ending_draining"
                      ? "Keep this tab open. Solve the problem in the coding workspace below and end the test here when you finish."
                      : "Your exam is paused — your work is saved. Restart your screen share below to get back to your code."
                    : "Keep this tab open. Open HackerRank with the Start test button and end the test here after you submit."}
              </p>
            </div>
            <StatusPill status={status} />
          </div>

          {isFormStage ? (
            <>
              {/* Every contest is person-mode: the server resolves the typed id
                  at /api/session/start (no public per-contest lookup endpoint). */}
              <>
                <>
                  <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Your details</p>
                  <div className="grid gap-4 md:grid-cols-2">
                    {formMode === "person_roster" ? (
                      <>
                        {/* S-D label-driven identity (F9 §1.5): ONE typed id —
                            the server resolves the rest from the contest
                            roster at start (name/roll/email never typed). */}
                        <Field
                          label={examConfig?.unique_id_label || "Candidate ID"}
                          value={form.roster_unique_id}
                          onChange={(value) => setForm({ ...form, roster_unique_id: value, candidate_id: value })}
                        />
                        <RoomField rooms={examConfig?.rooms ?? []} value={form.room} onChange={(value) => setForm({ ...form, room: value })} />
                      </>
                    ) : (
                      <>
                        {/* No-roster person contest (F9 §1.4): id + name +
                            email — no separate roll field (the identity label
                            is often "Roll Number" itself). */}
                        <Field label={examConfig?.unique_id_label || "Candidate ID"} value={form.candidate_id} onChange={(value) => setForm({ ...form, candidate_id: value })} />
                        <Field label="Full name" value={form.name} onChange={(value) => setForm({ ...form, name: value })} />
                        <Field label="Email" type="text" inputMode="email" value={form.email} onChange={(value) => setForm({ ...form, email: value })} />
                        <RoomField rooms={examConfig?.rooms ?? []} value={form.room} onChange={(value) => setForm({ ...form, room: value })} />
                      </>
                    )}
                  </div>
                  {formMode === "person_roster" ? (
                    <p className="mt-2 text-xs text-muted">
                      Your name and details come from the official list — type your {examConfig?.unique_id_label || "ID"} exactly as registered.
                    </p>
                  ) : null}

                  {/* S-C/S-D: genuine ambiguity — the typed id exists under
                      more than one college. The pick rides the retried start. */}
                  {collegeChoices ? (
                    <div className="mt-5 rounded-lg border border-warning/40 bg-warning/10 p-4">
                      <p className="text-sm font-semibold text-ink">Select your college</p>
                      <p className="mt-1 text-sm leading-6 text-muted">
                        Your {examConfig?.unique_id_label || "ID"} is registered under more than one college. Pick yours, then press Start again.
                      </p>
                      <div className="mt-3 space-y-2">
                        {collegeChoices.map((choice) => (
                          <label key={choice.college_norm} className="flex items-center gap-3 rounded-md border border-line bg-white/60 px-3 py-2 text-sm">
                            <input
                              type="radio"
                              name="college-choice"
                              className="h-4 w-4 accent-accent"
                              checked={collegeChoice === choice.college_norm}
                              onChange={() => setCollegeChoice(choice.college_norm)}
                            />
                            <span className="font-medium text-ink">{choice.name || choice.college || choice.college_norm}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <label className="mt-5 flex gap-3 rounded-lg border border-line bg-white/60 p-4 text-sm leading-6 text-muted">
                    <input
                      className="mt-1 h-4 w-4 accent-accent"
                      type="checkbox"
                      checked={form.consent_accepted}
                      onChange={(event) => setForm({ ...form, consent_accepted: event.target.checked })}
                    />
                    <span>
                      {studentCopy.consentDisclosure(ownEditorCopy, cameraRecordingOn)}
                    </span>
                  </label>
                </>
              </>
            </>
          ) : null}

          {/* Prominent, recoverable screen-share / start failure — never dead-ends
              and never asks for a reload. Shown above the action buttons. */}
          {startError ? (
            <ScreenShareErrorPanel
              startError={startError}
              stopped={gate === "running"}
              busy={status === "starting"}
              onRetry={retryScreenShare}
              onDismiss={() => setStartError(null)}
            />
          ) : null}

          {error && !endFailed ? (
            <div className="mt-5 rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
              {error}
            </div>
          ) : null}

          {/* Recording stopped but the final submit failed — inline retry, no reload. */}
          {endFailed ? (
            <EndRetryPanel error={error} busy={status === "ending" || status === "ending_draining"} onRetry={() => void retryEnd()} />
          ) : null}

          {reloadWarning ? (
            <div className="mt-5 rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm font-medium text-warning">
              {reloadWarning}
            </div>
          ) : null}

          <div className="mt-5 flex flex-wrap gap-3">
            {/* While the recoverable share-error panel is up it owns the retry, so
                we hide the duplicate Start/Resume buttons to avoid two CTAs. */}
            {isFormStage && !startError ? (
              <button className="focus-ring inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50" disabled={!canStart || status === "starting"} onClick={start}>
                <MonitorUp size={16} /> {status === "starting" ? "Starting…" : "Start proctoring"}
              </button>
            ) : null}
            {/* Active session restored on reload but recorder not yet running. */}
            {gate === "running" && status !== "recording" && status !== "ending" && status !== "ending_draining" && !startError ? (
              <button className="focus-ring inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50" disabled={status === "starting"} onClick={resumeRecording}>
                <MonitorUp size={16} /> {status === "starting" ? "Resuming…" : "Resume recording"}
              </button>
            ) : null}
            {status === "recording" ? (
              <button className="focus-ring inline-flex items-center gap-2 rounded-md bg-danger px-4 py-2 text-sm font-medium text-white" onClick={() => setEndRequested(true)}>
                <Square size={16} /> End test
              </button>
            ) : null}
          </div>

          {endRequested && status === "recording" ? (
            <EndTestPanel
              assuranceAccepted={assuranceAccepted}
              hasProblem={ownEditorCopy}
              onAssuranceChange={setAssuranceAccepted}
              onCancel={() => setEndRequested(false)}
              onEnd={stop}
            />
          ) : null}
        </section>

        <aside className="space-y-5">
          {/* Form stage: keep the sidebar focused on "what's being recorded" — the
              live camera/health/evidence panels are empty until recording starts,
              so we show a compact preview of what monitoring will capture instead.
              Recording stage: the live panels take over. */}
          {isFormStage ? (
            <WhatIsRecordedPanel hasProblem={ownEditorCopy} />
          ) : (
            <>
              <CameraSelfView videoRef={attachCameraVideo} mediaCapture={mediaCapture} cameraRecorded={cameraRecordingOn} />
              <HealthPanel status={status} sessionId={sessionId} config={sessionConfig} queueDepth={queueDepth} uploadedCount={uploadedCount} manifest={manifest} mediaCapture={mediaCapture} startIp={startIp} currentIp={currentIp} ipChanged={ipChanged} bufferStatus={bufferStatus} />
              <EntryReviewPanel clipboardAudit={clipboardAudit} tabAudit={tabAudit} cookieAudit={cookieAudit} />
              <RulesPanel hasProblem={ownEditorCopy} />
            </>
          )}
        </aside>
      </div>

      {/* S3 room gate: recording runs while the candidate waits; the workspace
          and the contest link stay hidden until the room code (or an
          invigilator start-now) releases this session. */}
      {status === "recording" && examGateActive ? (
        <div className="mt-5">
          <RoomCodePanel
            room={identity?.room || ""}
            code={gateCode}
            error={gateError}
            busy={gateBusy}
            onCodeChange={(value) => setGateCode(normalizeOtpInput(value))}
            onSubmit={() => void submitGateCode()}
          />
        </div>
      ) : null}

      {/* S4/S-I: the own-editor workspace now renders in the dedicated W1
          exam branch above (coding-central layout). This classic branch keeps
          only the pre-start / waiting / legacy / error surfaces. */}

      <div className="mt-5">
        <RecentEventsPanel events={events} />
      </div>
    </Shell>
  );
}

function createUiEvent(type: string, detail?: Record<string, unknown>): ProctorEvent {
  return {
    type,
    timestamp: new Date().toISOString(),
    visibility_state: document.visibilityState,
    detail
  };
}

// W3: AdminView + the grouped nav model live in admin/adminNav.ts.

function AdminApp() {
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

// csvField (CSV-injection neutralizer, M8) lives in ./csvField; re-exported here
// for the existing csvField.test.ts which imports it from "./App".
export { csvField };

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

