// frontend/src/candidate/StudentApp.tsx
// Candidate exam root (moved WHOLE + verbatim from App.tsx, F4). Per the #87
// decomp plan §2.1, StudentApp is moved as ONE unit and NOT internally
// decomposed: it uses render-phase ref-mirrors (statusRef/shellTapRef/
// enforcementTapRef written during render) feeding once-built closures, so
// pulling its state/effects into new hooks would silently reorder them. Only
// its props-driven leaf children were extracted (candidate/panels/*, F2).
import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Clock, Copy, Lock, MonitorUp, RefreshCw, ShieldCheck, Square } from "lucide-react";
import { endSession, fetchContestExamConfig, pollRoomGate, resumeSession, rosterLookup, sendEvents, sendSessionBeacon, startSession, uploadReviewFile, validateEndSession } from "../api";
import type { ApiError } from "../api";
import { normalizeCameraRecording } from "../cameraRecording";
import { clearChunkBuffer } from "../chunkBuffer";
import { chunkIndexBase, clearChunkContinuity, mergeManifest, readChunkHwm, readStintManifest, writeStintManifest } from "../chunkContinuity";
import { MultiProblemWorkspace } from "../coding/MultiProblemWorkspace";
import { clearSessionDrafts } from "../coding/problemSwitch";
import { classifyEndAtChange, computeClockSkewMs, formatRemaining, recordingPreExamState, remainingMs, sessionElapsedAnchorMs, waitingRoomGate } from "../examTime";
import { candidateIdOf } from "../identity";
import { normalizeOtpInput } from "../invigilator/gateLogic";
import { MarkerLayer } from "../markers/MarkerLayer";
import { EnforcementOverlay } from "../shell/EnforcementOverlay";
import { ExamShellChrome } from "../shell/ExamShellChrome";
import { candidateFormMode, candidateFormReady, rosterLookupErrorMessage, sessionStorageKeyFor } from "../shell/candidateRouting";
import { awayBeaconActive, elapsedTimerActive, shellHeaderMode } from "../shell/examShell";
import { allPermissionsGranted, initialPermissionChecklist, primeClipboardWithTimeout, screenShareFailureMessage, screenStatusFromErrorKind } from "../shell/permissions";
import type { PermissionChecklist, PermissionKey } from "../shell/permissions";
import { useEnforcement } from "../shell/useEnforcement";
import { useExamShell } from "../shell/useExamShell";
import * as studentCopy from "../studentCopy";
import type { CollegeChoice, ContestExamConfig, EnforcementConfigPayload, EnforcementExemptions, ExamConfig, ProctorEvent, RosterLookupResult, ServerSessionStatus, SessionStartResponse, SessionStatus, StudentForm, UploadManifestItem } from "../types";
import { BufferRequiredError, SETUP_SCREEN_CONSTRAINTS, acquireCameraMicrophone, acquireScreenShareStream, classifyStartError, createProctorRecorder } from "../useProctorRecorder";
import type { AcquiredMedia, BufferStatus, MediaCaptureState, RecorderStartErrorKind } from "../useProctorRecorder";
import { Field } from "../ui/Field";
import { Shell } from "../ui/Shell";
import { StatusPill } from "../ui/StatusPill";
import { BlockedScreen } from "./panels/BlockedScreen";
import { CameraDock } from "./panels/CameraDock";
import { CameraSelfView } from "./panels/CameraSelfView";
import { ComeBackLaterPanel } from "./panels/ComeBackLaterPanel";
import { EndRetryPanel } from "./panels/EndRetryPanel";
import { EndTestPanel } from "./panels/EndTestPanel";
import { EntryReviewPanel } from "./panels/EntryReviewPanel";
import { FinishingOverlay } from "./panels/FinishingOverlay";
import { HealthPanel } from "./panels/HealthPanel";
import { IdentityCard } from "./panels/IdentityCard";
import { ProctorHelpLine } from "./panels/ProctorHelpLine";
import { RecentEventsPanel } from "./panels/RecentEventsPanel";
import { RoomCodePanel } from "./panels/RoomCodePanel";
import { RoomField } from "./panels/RoomField";
import { PreStartRules, RulesPanel, WhatIsRecordedPanel } from "./panels/Rules";
import { ScreenShareErrorPanel } from "./panels/ScreenShareErrorPanel";
import { UnlockCodePanel } from "./panels/UnlockCodePanel";
import { WaitingRoomPanel } from "./panels/WaitingRoomPanel";

const initialForm: StudentForm = {
  candidate_id: "",
  name: "",
  roll_number: "",
  email: "",
  room: "",
  consent_accepted: false,
  roster_unique_id: ""
};

type StudentGate = "form" | "pending_approval" | "locked" | "ended" | "running";

// S-D: the candidate app pinned to ONE contest by ?contest= (null = legacy).
export type PinnedContest = { slug: string; config: ContestExamConfig };

export function StudentApp({ pinned }: { pinned: PinnedContest | null }) {
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
  // #135 take-home: the official exam start (T0), the remote-mode flag, and the
  // proctor contact phone. examStartAt seeds from the pre-session exam-config and
  // is refreshed (skew-safe) by every start/resume/heartbeat response; the gate
  // (waitingRoomActive/tooEarly) is derived from it below. examStartAtRef mirrors
  // it for the once-built recorder-callback closure, like examEndAtRef.
  const [examStartAt, setExamStartAt] = useState("");
  const examStartAtRef = useRef("");
  const [takeHome, setTakeHome] = useState(false);
  const [proctorPhone, setProctorPhone] = useState("");
  const examStartAnnouncedRef = useRef(false);
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

  // #135 take-home: the pre-T0 WAITING ROOM gate (D6, skew-safe via clockSkewMs /
  // D7). The boundary math is the pure waitingRoomGate() helper; the remaining
  // gates are the live take-home flag + lifecycle. Recomputed every render — the
  // 1 s elapsed ticker (active while recording) re-renders the countdown without
  // a new interval, exactly like examRemainingMs. waitingRoomActive holds the
  // candidate at the WaitingRoom (recording, fullscreen, soft enforcement) until
  // T0; tooEarly (>15 min out, pre-session) shows the come-back-later screen.
  // C-1: soft enforcement is driven by waitingRoomActive, NOT examGateActive
  // (room_gate_enabled is OFF in remote mode, so examGateActive is always false).
  const { msUntilStart: waitingRoomStartMs, waitingRoomActive: withinWaitingWindow, tooEarly: beyondWaitingWindow } =
    waitingRoomGate(examStartAt, Date.now(), clockSkewMs);
  const waitingRoomActive =
    takeHome &&
    status === "recording" &&
    gate === "running" &&
    !examGateActive &&
    withinWaitingWindow;
  // tooEarly governs the form-stage come-back-later replacement (A5). It is a
  // pure-time fact (only needs the take-home flag) so it holds before a session
  // exists, while the candidate is still on the form.
  const tooEarly = takeHome && beyondWaitingWindow;

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
      setScreenSetupMessage(screenShareFailureMessage(kind, { takeHome, phone: proctorPhone }));
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
  // #135 take-home: the WaitingRoom folds into the same stage-3 "not yet
  // released" seam as the room gate, so the onboarding strip reads "DETAILS"
  // (waiting), not "IN EXAM", until T0 hands off to W1 (examShell.ts deriveStage).
  const examReleased = !examGateActive && !waitingRoomActive;
  const shell = useExamShell({ gate, status, sessionId, examReleased, permissionsReady, addEvent });
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
      simplifiedFullscreenRecovery: enforcementPayload?.simplified_fullscreen_recovery ?? false,
      // #135 take-home (C-1): SOFT pre-T0 mode is driven by waitingRoomActive,
      // NOT examGateActive (room_gate_enabled is OFF remote, so examGateActive is
      // always false). At T0 waitingRoomActive flips false → the softMode edge
      // dispatches config_change, the reducer clears any soft nudge, and the real
      // ladder starts clean at exitCount=0.
      softMode: waitingRoomActive
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
      // #135 take-home: route the spoken lock warning to the remote proctor phone
      // instead of "raise your hand" (no invigilator in the room).
      speakWarning(takeHome
        ? `Your test has been locked for leaving fullscreen. Call your proctor at ${proctorPhone || "the number provided"}.`
        : "Your test has been locked for leaving fullscreen. Raise your hand and call your room proctor.");
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

  // W2: page top padding follows which fixed header is rendered — the slim
  // strip needs a small offset, the big alert banner a larger one, the locked
  // screen none ("hidden"). Defined before the shell chrome so the persistent
  // take-home help strip can gate on the strip header mode.
  const headerMode = shellHeaderMode(shell.barHidden, gate);
  const shellPadTop: boolean | "alert" = headerMode === "alert" ? "alert" : headerMode === "strip";

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
    examReleased,
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
    timeUp: examTimeUp,
    // #135 take-home (A10): route the FullscreenGate's fullscreen-blocked error
    // to the proctor phone for remote candidates; both shell-chrome call sites
    // spread shellChromeProps so this covers them in one place.
    takeHome,
    proctorPhone
  };
  // #135 take-home (D4b / §5b-4): the persistent "Need help? Call your proctor"
  // strip — rendered with the shell chrome so it shows on BOTH the WaitingRoom
  // and the in-exam W1 view. Only on the slim strip header (not the red anomaly
  // banner / locked screen, which carry their own phone CTA), and only for
  // take-home with a configured number.
  const proctorHelpChrome = takeHome && proctorPhone && headerMode === "strip"
    ? <ProctorHelpLine proctorPhone={proctorPhone} className="mb-4 justify-center rounded-md border border-line bg-white/60 px-3 py-2" />
    : null;
  const shellChrome = (
    <>
      <ExamShellChrome {...shellChromeProps} />
      {proctorHelpChrome}
    </>
  );

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
      takeHome={takeHome}
      proctorPhone={proctorPhone}
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

  const speakIpChangeWarning = () => {
    // #135 take-home: a remote candidate has no on-site engineer — reassure and
    // point at the proctor phone instead of "attended by our engineer".
    const message = takeHome
      ? `Your internet connection just changed networks. This is fine — stay in fullscreen and keep working. If the test stops responding, call your proctor at ${proctorPhone || "the number provided"}.`
      : "Your IP is changing. Please be attended by our engineer at your institution.";
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
    // #135 take-home: the runtime contract carries the remote-mode flag, the
    // proctor phone, and the official start (T0). applyExamStart refreshes the
    // shared skew off the session server_now, keeping the waiting-room countdown
    // skew-safe against the live session (not just the pre-session config seed).
    setTakeHome(Boolean(session.take_home));
    setProctorPhone(session.proctor_contact_phone || "");
    applyExamStart(session.start_at, session.server_now);
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
    // #135 take-home: seed the remote-mode flag, proctor phone, and official
    // start (T0) from the pre-session config so the come-back-later / waiting-room
    // gate is correct from first render — before any session exists. A4: seed the
    // shared clock skew from the config server_now via computeClockSkewMs (NOT 0)
    // so the 15-min boundary uses SERVER time immediately.
    setTakeHome(Boolean(pinned.config.take_home_enabled));
    setProctorPhone(pinned.config.proctor_contact_phone || "");
    setExamStartAt(pinned.config.start_at || "");
    examStartAtRef.current = pinned.config.start_at || "";
    setClockSkewMs(computeClockSkewMs(pinned.config.server_now, Date.now()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // #135 take-home (A4): a periodic exam-config re-fetch (~30s) ONLY on the
  // take-home pre-session stages (no session yet). It re-stamps server_now (so
  // the skew stays fresh even if the tab sat open for 20 min) and re-seeds
  // start_at, which re-evaluates the 15-min boundary — the come-back-later screen
  // therefore AUTO-ADVANCES into the waiting room when the clock crosses ≤15min.
  // It stops the moment a session exists (sessionId set): the heartbeat takes
  // over as the live skew/start channel from then on. Gated on take-home so a
  // non-remote contest never polls (behavior-preserving).
  useEffect(() => {
    if (!pinned || !takeHome || sessionId) return;
    let cancelled = false;
    const refetch = async () => {
      try {
        const fresh = await fetchContestExamConfig(pinned.slug);
        if (cancelled) return;
        setClockSkewMs(computeClockSkewMs(fresh.server_now, Date.now()));
        if (fresh.start_at) {
          examStartAtRef.current = fresh.start_at;
          setExamStartAt(fresh.start_at);
        }
        setProctorPhone(fresh.proctor_contact_phone || "");
        setTakeHome(Boolean(fresh.take_home_enabled));
      } catch {
        // Transient fetch failure — keep the last-known skew/start and retry on
        // the next tick; the candidate stays on the current pre-session screen.
      }
    };
    const timer = window.setInterval(() => void refetch(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pinned, takeHome, sessionId]);

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

  // #135 take-home (D8): announce "your exam has started" once at the T0
  // crossing. Purely cosmetic — the WaitingRoom→W1 hand-off is derived
  // (waitingRoomActive flips false on the next 1 s tick); this only adds the
  // voice cue at the exact crossing. Mirrors the time-up announce effect.
  useEffect(() => {
    if (!takeHome || status !== "recording" || !examStartAt) return;
    const check = () => {
      const left = remainingMs(examStartAt, Date.now(), clockSkewMs);
      if (left === null || left > 0 || examStartAnnouncedRef.current) return;
      examStartAnnouncedRef.current = true;
      speakWarning("Your exam has started. Your questions are on the page now.");
    };
    check();
    const timer = window.setInterval(check, 1000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [takeHome, status, examStartAt, clockSkewMs]);

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

  // #135 take-home: apply a server-reported exam START (T0) + clock stamp. The
  // SAME clockSkewMs is refreshed here (start_at and end_at share one server_now,
  // so a single skew offset is correct for both); the waiting-room gate then
  // derives off the fresh start_at. Sibling of applyExamTime — called from the
  // three sites that call applyExamTime (start/resume/refreshStatus) plus the
  // heartbeat hook. A missing start_at (non-take-home / older backend) is a noop.
  const applyExamStart = (startAt?: string, serverNow?: string) => {
    if (serverNow) setClockSkewMs(computeClockSkewMs(serverNow, Date.now()));
    if (!startAt) return;
    examStartAtRef.current = startAt;
    setExamStartAt(startAt);
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
      // #135 take-home: the same heartbeat refreshes the start (T0), the remote-
      // mode flag, and the proctor phone, keeping the waiting-room countdown +
      // phone skew-safe against the live session. applyExamStart refreshes the
      // shared skew off server_now even when endAt is empty (take-home may have
      // no end_at), which applyExamTime's early-return would otherwise skip.
      onExamTimeChange: ({ endAt, serverNow, startAt, takeHome: th, proctorPhone: ph }) => {
        applyExamTime(endAt, serverNow);
        applyExamStart(startAt, serverNow);
        if (th !== undefined) setTakeHome(Boolean(th));
        if (ph !== undefined) setProctorPhone(ph || "");
      },
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
    // #135 take-home (A7): a take-home session records ~10 min before T0, so
    // anchoring on created_at would read ~10:00 the instant the exam opens.
    // Anchor on start_at (T0) instead so the elapsed reads 00:00 at exam open
    // (sessionElapsedAnchorMs clamps a future anchor to "now" → 00:00 during the
    // pre-T0 waiting room, then counts up from T0). "Time remaining"
    // (end_at - now) is already correct and unaffected.
    const elapsedAnchorIso = session.take_home && session.start_at ? session.start_at : session.created_at;
    const anchor = sessionElapsedAnchorMs(elapsedAnchorIso, session.server_now, Date.now());
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
    // #135 take-home (§5a): append the remote help tail to the share-error copy
    // (the recoverable kinds, not the raw fallback) so a stuck remote candidate
    // has the proctor phone in front of them.
    if (takeHome && proctorPhone && kind !== "unknown") {
      message = `${message} Stuck? Call your proctor at ${proctorPhone}.`;
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
          // #135 take-home: route the roster-lookup error tail to the proctor phone.
          ? rosterLookupErrorMessage(err?.status, err?.code, retryAfter, takeHome ? { takeHome: true, phone: proctorPhone } : undefined)
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
      // #135 take-home (A10): the roster-not-found tail routes to the proctor
      // phone instead of "call an invigilator" for remote contests.
      const callForHelp = takeHome ? `call your proctor at ${proctorPhone || "the number provided"}` : "call an invigilator";
      setError(
        code === "not_on_roster" || code === "roster_id_required"
          ? formMode === "person_roster"
            ? `Your ${examConfig?.unique_id_label || "ID"} was not found on the list for this test. Check it and try again, or ${callForHelp}.`
            : `Your ID was not matched on the student list. Use “Not you? Re-enter ID” to redo the identity step, or ${callForHelp}.`
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
            // #135 take-home: route approval to the remote proctor phone (§5a).
            takeHome
              ? `A proctor must approve this device before you can begin. Call your proctor at ${proctorPhone || "the number provided"} to be approved, or wait for the other session to be released.`
              : "A proctor must approve this device before you can begin — or you can wait for the other session to be unlocked.",
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
          // #135 take-home: the locked-screen body routes to the proctor phone
          // (tel link in the UnlockCodePanel below) instead of "raise your hand".
          lines={enforcementLock
            ? [
                "You did not return to fullscreen in time (or exited fullscreen too many times), so this session locked itself.",
                takeHome
                  ? `Call your proctor at ${proctorPhone || "the number provided"}. They can read you a 6-digit unlock code to enter below, or unlock you from their console.`
                  : "Raise your hand and call your room proctor. They can read you a 6-digit unlock code to enter here, or unlock you from their console."
              ]
            : [
                "A proctor has locked this session. You cannot record until it is unlocked.",
                takeHome
                  ? `Call your proctor at ${proctorPhone || "the number provided"}. When they unlock you, press Check again.`
                  : "Raise your hand and call a proctor to your room. When they unlock you, press Check again."
              ]}
          onRefresh={refreshStatus}
          error={error}
        />
        {enforcementLock && sessionId ? (
          <UnlockCodePanel
            sessionId={sessionId}
            takeHome={takeHome}
            proctorPhone={proctorPhone}
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

  // #135 take-home (D6 / C-6 / A5): the ">15 min early" screen REPLACES the
  // registration form (early-return, full-screen) so the candidate never
  // acquires screen share / starts a recording for a long dead wait. The A4
  // periodic re-fetch re-evaluates the boundary every ~30s, so this auto-advances
  // into the waiting room when the clock crosses inside the 15-min window.
  if (tooEarly && isFormStage) {
    const startDate = examStartAt ? new Date(examStartAt) : null;
    // No shellChrome here: this is a terminal "close the tab" screen before any
    // setup, so the permissions / fullscreen gate overlays must NOT prompt — the
    // candidate is meant to leave and return ~10 min before T0 (A5).
    return (
      <Shell padTop={false}>
        <ComeBackLaterPanel
          contestName={pinned?.config.contest_name ?? null}
          startAtLabel={startDate ? startDate.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null}
          startDateLabel={startDate ? startDate.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) : null}
          proctorPhone={proctorPhone}
        />
      </Shell>
    );
  }

  // #135 defense-in-depth (spec §4d): a recording session whose start_at is
  // pushed >15 min out mid-wait must HOLD, not fall through to the live exam.
  // "Should be unreachable" via the form-stage guard above (tooEarly && isFormStage),
  // but that guard requires gate==="form"/!recording, so it can't catch an
  // in-session heartbeat re-stamp of examStartAt while status==="recording".
  // Keep shellChrome/enforcementOverlay/markerLayer here (unlike the form-stage
  // version): recording is already live, so the fullscreen/permission hold persists.
  // recordingPreExamState centralizes the precedence (hold → waiting room → exam)
  // so the "tooEarly must never reach the exam" invariant is unit-tested in isolation.
  const recordingState = status === "recording"
    ? recordingPreExamState({ tooEarly, waitingRoomActive })
    : null;
  if (recordingState?.holdWhileRecording) {
    const startDate = examStartAt ? new Date(examStartAt) : null;
    return (
      <Shell padTop={shellPadTop}>
        {shellChrome}
        {enforcementOverlay}
        {markerLayer}
        <ComeBackLaterPanel
          contestName={pinned?.config.contest_name ?? null}
          startAtLabel={startDate ? startDate.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null}
          startDateLabel={startDate ? startDate.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) : null}
          proctorPhone={proctorPhone}
        />
      </Shell>
    );
  }

  // #135 take-home (D1 / D9): the WAITING ROOM — recording is live and fullscreen
  // is held, but the exam hasn't opened (pre-T0, ≤15min). The enforcement overlay
  // here is the SOFT nudge (softMode: waitingRoomActive). At T0 waitingRoomActive
  // flips false on the next 1 s tick and the W1 branch below renders
  // automatically — already fullscreen, already recording, problems revealed, no
  // re-permission/re-fullscreen prompt (the seamless T0 hand-off, D8).
  if (waitingRoomActive) {
    return (
      <Shell padTop={shellPadTop}>
        {shellChrome}
        {enforcementOverlay}
        {markerLayer}
        {identity ? <IdentityCard identity={identity} /> : null}
        <WaitingRoomPanel
          contestName={pinned?.config.contest_name ?? null}
          startsInMs={waitingRoomStartMs}
          startAtLabel={examStartAt ? new Date(examStartAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null}
          proctorPhone={proctorPhone}
        />
        <div className="mx-auto mt-5 max-w-2xl">
          <CameraSelfView videoRef={attachCameraVideo} mediaCapture={mediaCapture} cameraRecorded={cameraRecordingOn} />
        </div>
      </Shell>
    );
  }

  // W1 — the exam itself: an own-editor session, actively recording, released
  // into the exam. The coding workspace IS the page. Everything else tucks
  // into the slim strip (W2 — proctoring-panel toggle + End test live there),
  // the collapsible proctoring panel, and the floating camera dock. All
  // capture/preview hosts stay MOUNTED — every collapse is CSS-only. Legacy
  // (HackerRank-link) sessions and all waiting/error states keep the classic
  // proctoring-first layout below. #135: !waitingRoomActive keeps the pre-T0
  // take-home hold on the WaitingRoom branch above until T0.
  if (hasProblem && status === "recording" && gate === "running" && !examGateActive && recordingState?.examViewAllowed) {
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
        {/* #135 take-home (D4b): the persistent proctor-phone help strip rides
            the W1 exam view too (gated on take-home + a configured number). */}
        {proctorHelpChrome}
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
      {status === "ending" ? <FinishingOverlay proctorPhone={takeHome ? proctorPhone : ""} /> : null}
      {/* Tier-1: the end-of-test drain wait gate — same blocking takeover with
          live remaining segments/MB. awayBeaconActive() returns false for
          ending_draining (it is NOT "recording"), so this long wait never fires
          a spurious tab_hidden/closing beacon. */}
      {status === "ending_draining" ? <FinishingOverlay draining={{ pendingCount: bufferStatus.pendingCount, pendingBytes: bufferStatus.pendingBytes }} proctorPhone={takeHome ? proctorPhone : ""} /> : null}
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
