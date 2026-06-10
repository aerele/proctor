import { Activity, AlertTriangle, Archive, ArchiveRestore, Bell, Camera, CheckCircle2, ClipboardCheck, ClipboardList, Clock, Cookie, Copy, Download, ExternalLink, Eye, Film, KeyRound, ListChecks, ListFilter, Lock, MailWarning, Mic, MonitorUp, Network, PictureInPicture2, RefreshCw, Search, ShieldCheck, Square, UploadCloud, UserCheck, Users, Video, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { adjustExamTime, adminPassword, adminPasswordHash, alertAction, clearRoster, endSession, fetchAdminSessions, fetchAdminStats, fetchAlertSettings, fetchAlerts, fetchAllReviews, fetchAttendance, fetchExamConfig, fetchIpReport, fetchProctorSettings, fetchReviewRoster, fetchRosterStatus, fetchSessionDetails, fetchSessionsList, parseRosterInput, pollRoomGate, resumeSession, rosterLookup, saveAlertSettings, saveProctorSettings, saveReviewRoster, sendEvents, sendSessionBeacon, sessionAction, sha256Hex, startSession, uploadReviewFile, uploadRoster, validateEndSession } from "./api";
import { RecordingReview } from "./RecordingReview";
import { addAllToSelection, isAllSelected, removeFromSelection, toggleId, usernamesForSelection } from "./alertSelection";
import { ALERT_ACTION_INFO, SESSION_ACTION_INFO, SESSION_ACTION_ORDER, bulkSessionActionsFor, sessionForAlert, validSessionActionsFor } from "./admin/alertActions";
import { classifyEndAtChange, computeClockSkewMs, formatRemaining, remainingMs } from "./examTime";
import { InvigilatorApp } from "./InvigilatorApp";
import { ProblemBankSection } from "./admin/ProblemBank";
import { CodingWorkspace } from "./coding/CodingWorkspace";
import { buildAbsenteesCsv, type AttendanceReport } from "./attendance/computeAttendance";
import * as studentCopy from "./studentCopy";
import { topBarVisible } from "./shell/examShell";
import { ExamShellChrome } from "./shell/ExamShellChrome";
import { useExamShell } from "./shell/useExamShell";
import { classifyStartError, createProctorRecorder, type MediaCaptureState, type RecorderStartErrorKind } from "./useProctorRecorder";
import type { AdminStats, AdminStatsResponse, Alert, AlertFilters, AlertSettings, AlertSeverity, AlertSource, ExamConfig, ExamTimeRequest, IpReportResponse, IpReportScope, ProctorAlertTypeConfig, ProctorEvent, ProctorSettings, RecordingSession, ReviewRosterSummary, RosterLookupResult, RosterStatus, RosterUploadResponse, ServerSessionStatus, SessionAction, SessionDetail, SessionStartResponse, SessionStatus, StudentForm, UploadManifestItem } from "./types";
import { parseRoster, suggestMapping, type ParsedRoster, type RosterFieldMapping } from "./roster/parseRoster";
import type { ApiError } from "./api";
import { isCompleteOtp, normalizeOtpInput } from "./invigilator/gateLogic";

// S4: the contest problem is SERVER-DRIVEN — it arrives as `problem` inside the
// start/resume response (admin assigns settings.problem_id → public view; see
// docs/superpowers/specs/2026-06-09-s4-problem-authoring-design.md). No problem
// assigned → the legacy contest_url link flow renders instead.
//
// Candidate-facing copy is surface-specific (studentCopy.ts): with a problem
// assigned, no student string may direct the candidate to HackerRank. The copy
// keys off Boolean(sessionConfig?.problem) per session — before a session
// exists the client cannot know, so pre-session copy uses the legacy variant.

// Auto-poll interval for the admin Live stats / Live alerts views.
const ADMIN_POLL_INTERVAL_MS = 5000;

// Read-only reference list — contest-eval alert types are configured in
// monitoring/alert-config.json, NOT through this console.
const CONTEST_EVAL_ALERT_TYPES = ["peer_copy_cluster", "recurring_pair", "web_paste", "first_attempt_solve", "tough_first_attempt"] as const;

const sessionStorageKey = "aerele-proctor-session-id";

const initialForm: StudentForm = {
  hackerrank_username: "",
  name: "",
  roll_number: "",
  email: "",
  room: "",
  consent_accepted: false,
  roster_unique_id: ""
};

const checkpointMessages = [
  "Confirm immediately that you are present and working alone.",
  "Confirm your phone is away and not being used for this assessment.",
  "Confirm you are not using AI tools, search engines, or external help.",
  "Confirm your screen share is active and you have not hidden any assessment activity.",
  "Confirm you are the registered candidate solving this assessment yourself."
];

type IntegrityCheckpoint = {
  id: string;
  message: string;
  expiresAt: number;
};

export function App() {
  // S3: the invigilator portal lives on its own path, like /admin.
  if (window.location.pathname.startsWith("/invigilator")) return <InvigilatorApp />;
  const isAdmin = window.location.pathname.startsWith("/admin");
  return isAdmin ? <AdminApp /> : <StudentApp />;
}

// Student gate state — the server-reported lifecycle status, separate from the
// recorder UI status. "form" is the very first screen (no session yet).
type StudentGate = "form" | "pending_approval" | "locked" | "ended" | "running";

function StudentApp() {
  const [form, setForm] = useState<StudentForm>(initialForm);
  const [status, setStatus] = useState<SessionStatus>("idle");
  const [gate, setGate] = useState<StudentGate>("form");
  const [resuming, setResuming] = useState(true);
  const [sessionId, setSessionId] = useState("");
  const [sessionConfig, setSessionConfig] = useState<SessionStartResponse | null>(null);
  const [identity, setIdentity] = useState<{ name: string; username: string; room: string } | null>(null);
  const [contestUrl, setContestUrl] = useState("");
  const [startIp, setStartIp] = useState("");
  const [currentIp, setCurrentIp] = useState("");
  const [ipChanged, setIpChanged] = useState(false);
  const [events, setEvents] = useState<ProctorEvent[]>([]);
  const [queueDepth, setQueueDepth] = useState(0);
  const [uploadedCount, setUploadedCount] = useState(0);
  const [error, setError] = useState("");
  // Recoverable screen-share/start failure (invalid surface, share cancelled,
  // permission denied, unsupported, etc.). When set, the student is clearly NOT
  // recording and an inline "Try again" re-invokes the share — never a reload.
  const [startError, setStartError] = useState<{ kind: RecorderStartErrorKind; message: string } | null>(null);
  const [reloadWarning, setReloadWarning] = useState("");
  const [manifest, setManifest] = useState<UploadManifestItem[]>([]);
  const [clipboardText, setClipboardText] = useState("");
  const [clipboardAudit, setClipboardAudit] = useState("Not collected yet.");
  const [tabAudit, setTabAudit] = useState("Not collected yet.");
  const [cookieAudit, setCookieAudit] = useState("Not collected yet.");
  const [checkpoint, setCheckpoint] = useState<IntegrityCheckpoint | null>(null);
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
  const [mediaCapture, setMediaCapture] = useState<MediaCaptureState>({ screen: "inactive", camera: "inactive", microphone: "inactive" });
  const [pipAvailable, setPipAvailable] = useState(false);
  const [pipMessage, setPipMessage] = useState("");
  // S3 room gate: whether THIS session has been released into the exam (room
  // OTP / invigilator start-now / gate disabled). Starts false when the gate is
  // enabled; the poll effect corrects it (also after reload/resume).
  const [examStarted, setExamStarted] = useState(false);
  const [gateCode, setGateCode] = useState("");
  const [gateError, setGateError] = useState("");
  const [gateBusy, setGateBusy] = useState(false);
  // S2 roster login state. examConfig is the public pre-session config; the
  // unique-ID -> confirm flow fills form.roster_unique_id, which the server
  // re-verifies at /api/session/start (this client gate is UX only).
  const [examConfig, setExamConfig] = useState<ExamConfig | null>(null);
  const [uniqueIdInput, setUniqueIdInput] = useState("");
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupError, setLookupError] = useState("");
  const [rosterMatch, setRosterMatch] = useState<RosterLookupResult | null>(null);
  // S4: the assigned problem rides in on the start/resume response. hasProblem
  // drives every own-editor-vs-HackerRank copy fork (studentCopy.ts, stageHint).
  const activeProblem = sessionConfig?.problem ?? null;
  const hasProblem = activeProblem !== null;
  const recorderRef = useRef<ReturnType<typeof createProctorRecorder> | null>(null);
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);

  const rosterRequired = Boolean(examConfig?.roster_required);
  const rosterConfirmed = Boolean(form.roster_unique_id);
  // S2: while a roster is required and unconfirmed, the details form stays
  // hidden behind the identity-confirm step.
  const rosterGateActive = rosterRequired && !rosterConfirmed;

  const canStart = useMemo(() => {
    return Boolean(
      (!rosterRequired || form.roster_unique_id) &&
      form.hackerrank_username.trim() &&
      form.name.trim() &&
      form.roll_number.trim() &&
      form.email.trim() &&
      form.room.trim() &&
      form.consent_accepted
    );
  }, [form, rosterRequired]);

  // S1 exam shell: EVERY proctor event (recorder onEvent + createUiEvent call
  // sites) already flows through this single funnel, so the shell taps it here
  // for anomaly classification (spec §6). The ref breaks the definition cycle —
  // the shell hook itself emits events through addEvent.
  const shellTapRef = useRef<(event: ProctorEvent) => void>(() => undefined);
  const addEvent = (event: ProctorEvent) => {
    shellTapRef.current(event);
    setEvents((current) => [event, ...current].slice(0, 16));
  };

  // S3 room gate: enabled for this contest AND this session not yet released.
  // While active, the candidate holds at the RoomCodePanel waiting room — the
  // coding workspace / contest link stay hidden and the shell stage stays 3.
  const examGateActive = Boolean(sessionConfig?.room_gate_enabled) && !examStarted;

  // S1 exam shell: fullscreen truth, 1-5 stage, top-bar vanish/restore.
  // examReleased is the S3 room-gate seam: released once the room code (or an
  // invigilator start-now) admits this session, or when the gate is disabled.
  const shell = useExamShell({ gate, status, sessionId, examReleased: !examGateActive, addEvent });
  shellTapRef.current = shell.onShellEvent;

  // S5: remaining time on the SERVER clock. Recomputed every render — the 1 s
  // elapsed ticker already re-renders while recording, so this stays live
  // without another interval. null (no end_at yet / old backend) → no countdown.
  // (Plan anchored this at isFormStage; it lives here because the shell chrome
  // below consumes it — the S1 exam shell replaced the old TimerBar.)
  const examRemainingMs = status === "recording" || status === "ending" ? remainingMs(examEndAt, Date.now(), clockSkewMs) : null;
  const examTimeUp = examRemainingMs !== null && examRemainingMs <= 0;

  // The shared shell chrome — rendered FIRST inside <Shell> on every branch.
  const shellChrome = (
    <ExamShellChrome
      shell={shell}
      gate={gate}
      status={status}
      identity={identity}
      elapsedSeconds={elapsedSeconds}
      examReleased={!examGateActive}
      ownEditor={hasProblem}
      remainingLabel={examRemainingMs !== null ? formatRemaining(examRemainingMs) : null}
      timeUp={examTimeUp}
    />
  );
  // The fixed bar needs page top padding only while it is actually rendered.
  const shellPadTop = topBarVisible(shell.barHidden, gate);

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
    setContestUrl(session.contest_url || "");
    // S3: gate disabled (or absent on an older backend) → released immediately.
    setExamStarted(!session.room_gate_enabled);
    setIdentity({
      name: session.name || form.name.trim(),
      username: session.hackerrank_username || form.hackerrank_username.trim(),
      room: session.room || form.room.trim()
    });
    const serverStatus: ServerSessionStatus = session.status || "active";
    if (serverStatus === "pending_approval") setGate("pending_approval");
    else if (serverStatus === "locked") setGate("locked");
    else if (serverStatus === "ended") setGate("ended");
    else setGate("running");
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
    const stored = window.localStorage.getItem(sessionStorageKey);
    if (!stored) {
      setResuming(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const session = await resumeSession(stored);
        if (cancelled) return;
        const serverStatus = applyServerStatus(session);
        setStartIp(session.start_ip || "unavailable");
        setCurrentIp(session.start_ip || "unavailable");
        if (serverStatus === "ended") {
          setStatus("ended");
          window.localStorage.removeItem(sessionStorageKey);
        }
      } catch {
        // Unknown/expired token — drop it and fall back to the form.
        window.localStorage.removeItem(sessionStorageKey);
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
  useEffect(() => {
    let cancelled = false;
    void fetchExamConfig().then((config) => {
      if (!cancelled) setExamConfig(config);
    });
    return () => {
      cancelled = true;
    };
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

  useEffect(() => {
    if (status !== "recording" || !sessionId) return;
    let closed = false;
    let promptTimer: number | undefined;
    let expiryTimer: number | undefined;

    const scheduleNext = () => {
      if (closed) return;
      const delay = 45_000 + Math.floor(Math.random() * 35_000);
      promptTimer = window.setTimeout(() => {
        if (closed) return;
        const nextCheckpoint = {
          id: crypto.randomUUID(),
          message: checkpointMessages[Math.floor(Math.random() * checkpointMessages.length)],
          expiresAt: Date.now() + 45_000
        };
        setCheckpoint(nextCheckpoint);
        const shownEvent = createUiEvent("integrity_checkpoint_shown", {
          checkpoint_id: nextCheckpoint.id,
          message: nextCheckpoint.message,
          expires_at: new Date(nextCheckpoint.expiresAt).toISOString()
        });
        addEvent(shownEvent);
        void sendEvents(sessionId, [shownEvent]);

        expiryTimer = window.setTimeout(() => {
          setCheckpoint((current) => {
            if (!current || current.id !== nextCheckpoint.id) return current;
            const missedEvent = createUiEvent("integrity_checkpoint_missed", {
              checkpoint_id: nextCheckpoint.id,
              message: nextCheckpoint.message
            });
            addEvent(missedEvent);
            void sendEvents(sessionId, [missedEvent]);
            scheduleNext();
            return null;
          });
        }, 45_000);
      }, delay);
    };

    scheduleNext();
    return () => {
      closed = true;
      if (promptTimer) window.clearTimeout(promptTimer);
      if (expiryTimer) window.clearTimeout(expiryTimer);
      setCheckpoint(null);
    };
  }, [sessionId, status]);

  useEffect(() => {
    if (status !== "recording" || !recordingStartedAt) return;
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - recordingStartedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [recordingStartedAt, status]);

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
      if (sessionId) void sendEvents(sessionId, [event]);
    };
    check();
    const timer = window.setInterval(check, 1000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, examEndAt, clockSkewMs, sessionId]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (status !== "recording" && status !== "ending") return;
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
  useEffect(() => {
    if (!sessionId) return;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") sendSessionBeacon(sessionId, "hidden");
      else if (document.visibilityState === "visible") sendSessionBeacon(sessionId, "visible");
    };
    const onPageHide = () => sendSessionBeacon(sessionId, "closing");
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [sessionId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (status !== "recording" && status !== "ending") return;
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
      if (sessionId) void sendEvents(sessionId, [reloadEvent]);
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [sessionId, status]);

  useEffect(() => {
    const video = cameraVideoRef.current;
    if (!video) return;
    video.srcObject = cameraStream;
    setPipAvailable(Boolean(cameraStream && "requestPictureInPicture" in HTMLVideoElement.prototype));
    if (cameraStream) {
      void video.play().catch(() => undefined);
    }
  }, [cameraStream]);

  const requestCameraPictureInPicture = async () => {
    const video = cameraVideoRef.current;
    if (!video || !("requestPictureInPicture" in video)) {
      setPipMessage("Camera pop-out is not supported in this browser.");
      return;
    }
    try {
      await video.play();
      if (document.pictureInPictureElement !== video) {
        await video.requestPictureInPicture();
      }
      setPipMessage("Camera pop-out is active. Keep it visible while working in other tabs.");
      addEvent(createUiEvent("camera_picture_in_picture_started"));
    } catch (cause) {
      setPipMessage("Use the camera pop-out button to keep your camera visible over other tabs.");
      addEvent(createUiEvent("camera_picture_in_picture_failed", { message: cause instanceof Error ? cause.message : String(cause) }));
    }
  };

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
      setExamTimeNotice(`The proctor extended the exam — new end time ${at}.`);
    } else {
      setExamTimeNotice(`The proctor moved the exam end earlier — new end time ${at}.`);
      speakWarning("Attention: the exam end time has been moved earlier. Check the timer.");
    }
  };

  // Bring up the recorder for an active session. Shared by first-start and by
  // "Resume recording" after a reload (both need a fresh getDisplayMedia gesture).
  const beginRecording = async (session: SessionStartResponse) => {
    // If a prior recorder is still around (e.g. screen share dropped mid-session
    // and the student is retrying), tear it down first so we don't leave a second
    // heartbeat/upload loop running against the same session.
    if (recorderRef.current) {
      await recorderRef.current.stop().catch(() => undefined);
      recorderRef.current = null;
    }
    setStartIp(session.start_ip || "unavailable");
    setCurrentIp(session.start_ip || "unavailable");
    setIpChanged(false);
    // ownEditor comes from the response itself — the sessionConfig state set
    // moments ago has not re-rendered into this closure yet.
    await collectEntryReviewEvidence(session.session_id, Boolean(session.problem));

    const recorder = createProctorRecorder({
      sessionId: session.session_id,
      config: session.upload_config,
      heartbeatSeconds: session.heartbeat_interval_seconds,
      onEvent: addEvent,
      onUploadChange: (depth, uploaded) => {
        setQueueDepth(depth);
        setUploadedCount(uploaded);
      },
      onFatalError: (message) => {
        if (message.includes("Screen sharing stopped")) {
          // Recoverable: the session is still active server-side; the student can
          // re-share their screen inline (no reload) to resume recording.
          setStatus("idle");
          setStartError({
            kind: "share_cancelled",
            message: "Screen sharing stopped, so recording is paused. This is logged. Press Resume screen share and choose your Entire Screen to continue — do not close this tab."
          });
          speakWarning("Screen sharing stopped. Return to the proctor app and resume your screen share immediately.");
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
        if (serverStatus === "ended") {
          setStatus("ended");
          setGate("ended");
          window.localStorage.removeItem(sessionStorageKey);
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
      onCameraStream: (stream) => {
        setCameraStream(stream);
        const video = cameraVideoRef.current;
        if (video) {
          video.srcObject = stream;
          if (stream) {
            setPipAvailable("requestPictureInPicture" in HTMLVideoElement.prototype);
          }
        }
      }
    });
    recorderRef.current = recorder;
    await recorder.start();
    const startedAt = Date.now();
    setRecordingStartedAt(startedAt);
    setElapsedSeconds(0);
    setStatus("recording");
  };

  // Translate a recorder start failure into recoverable, human-readable copy. The
  // student is left in a clear NOT-RECORDING state with an inline Try-again button
  // (no page reload). Server/registration errors keep the generic message.
  const handleStartFailure = (cause: unknown) => {
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
    setLookupBusy(true);
    setLookupError("");
    try {
      setRosterMatch(await rosterLookup(uniqueIdInput.trim()));
    } catch (cause) {
      setRosterMatch(null);
      const status = (cause as ApiError)?.status;
      setLookupError(
        status === 404
          ? "We could not find that ID on the student list. Check it and try again, or call an invigilator."
          : cause instanceof Error ? cause.message : String(cause)
      );
    } finally {
      setLookupBusy(false);
    }
  };

  // "Yes, this is me": prefill the form from the roster record. Roster-sourced
  // fields render disabled; the server overrides them again at start anyway
  // (the roster is the identity source of truth — this is just honest UI).
  const confirmRosterMatch = () => {
    if (!rosterMatch) return;
    setForm({
      ...form,
      roster_unique_id: rosterMatch.unique_id,
      hackerrank_username: rosterMatch.hackerrank_username || form.hackerrank_username,
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
      session = await startSession({
        ...form,
        hackerrank_username: form.hackerrank_username.trim(),
        name: form.name.trim(),
        roll_number: form.roll_number.trim(),
        email: form.email.trim(),
        room: form.room.trim()
      });
      // Persist the token so a reload resumes the same session (Epic 2).
      window.localStorage.setItem(sessionStorageKey, session.session_id);
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
      const code = (cause as ApiError)?.code;
      setError(
        code === "not_on_roster" || code === "roster_id_required"
          ? "Your ID was not matched on the student list. Use “Not you? Re-enter ID” to redo the identity step, or call an invigilator."
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
      session = await resumeSession(sessionConfig.session_id);
      applyExamTime(session.end_at, session.server_now);
      const serverStatus = applyServerStatus(session);
      if (serverStatus !== "active") {
        setStatus("idle");
        if (serverStatus === "ended") window.localStorage.removeItem(sessionStorageKey);
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
      const session = await resumeSession(sessionConfig.session_id);
      applyExamTime(session.end_at, session.server_now);
      const serverStatus = applyServerStatus(session);
      if (serverStatus === "ended") {
        setStatus("ended");
        window.localStorage.removeItem(sessionStorageKey);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

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

    try {
      if (!navigator.clipboard?.readText) {
        throw new Error("Clipboard read is not supported by this browser.");
      }
      const text = await navigator.clipboard.readText();
      setClipboardText(text);
      setClipboardAudit(text ? "Clipboard captured and uploaded." : "Clipboard is empty; empty value uploaded.");
      await uploadReviewFile(activeSessionId, "clipboard", [{
        type: "initial_clipboard_snapshot",
        timestamp: new Date().toISOString(),
        text,
        text_length: text.length,
        visibility_state: document.visibilityState
      }]);
      addEvent({
        type: "clipboard_review_uploaded",
        timestamp: new Date().toISOString(),
        visibility_state: document.visibilityState,
        detail: { text_length: text.length }
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setClipboardText("");
      setClipboardAudit(`Clipboard could not be read: ${message}`);
      await uploadReviewFile(activeSessionId, "clipboard", [{
        type: "initial_clipboard_snapshot_failed",
        timestamp: new Date().toISOString(),
        reason: message,
        visibility_state: document.visibilityState
      }]);
      addEvent({
        type: "clipboard_review_failed",
        timestamp: new Date().toISOString(),
        visibility_state: document.visibilityState,
        detail: { reason: message }
      });
    }

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
      const uploads = finalManifest ?? [];
      setManifest(uploads);
      if (sessionId) {
        await endSession({ sessionId, manifest: uploads, assuranceAccepted });
      }
      window.localStorage.removeItem(sessionStorageKey);
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
      if (sessionId) {
        await endSession({ sessionId, manifest, assuranceAccepted });
      }
      window.localStorage.removeItem(sessionStorageKey);
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

  const confirmCheckpoint = () => {
    if (!checkpoint || !sessionId) return;
    const confirmedEvent = createUiEvent("integrity_checkpoint_confirmed", {
      checkpoint_id: checkpoint.id,
      message: checkpoint.message,
      response_time_remaining_ms: Math.max(0, checkpoint.expiresAt - Date.now())
    });
    addEvent(confirmedEvent);
    void sendEvents(sessionId, [confirmedEvent]);
    setCheckpoint(null);
  };

  // ---- Blocked / non-running gate screens -------------------------------
  if (resuming) {
    return (
      <Shell padTop={shellPadTop}>
        {shellChrome}
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
            "Another session is already active for your HackerRank username.",
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
    return (
      <Shell padTop={shellPadTop}>
        {shellChrome}
        {identity ? <IdentityCard identity={identity} /> : null}
        <BlockedScreen
          tone="danger"
          icon={<Lock size={22} />}
          title="Your test is locked"
          lines={[
            "A proctor has locked this session. You cannot record until it is unlocked.",
            "Raise your hand and call a proctor to your room. When they unlock you, press Check again."
          ]}
          onRefresh={refreshStatus}
          error={error}
        />
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
          <h1 className="mt-3 text-2xl font-semibold text-ink">Test ended</h1>
          <p className="mt-2 text-sm leading-6 text-muted">
            Your proctoring session is complete and the recording has been submitted for review. You may now close this tab.
          </p>
          {manifest.length ? <p className="mt-3 text-xs text-muted">{manifest.length} recording segment(s) uploaded.</p> : null}
        </section>
      </Shell>
    );
  }

  // gate === "form" (no session yet) or "running" (active session)
  const isFormStage = gate === "form" && status !== "recording" && status !== "ending";

  return (
    <Shell padTop={shellPadTop}>
      {shellChrome}
      {identity && !isFormStage ? <IdentityCard identity={identity} /> : null}

      {/* S5: end-time change notice + time-up banner. The countdown itself lives
          in the shell's ExamTopBar (the S1 replacement for the old TimerBar). */}
      {examTimeNotice && (status === "recording" || status === "ending") ? (
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
      {isFormStage ? <PreStartRules hasProblem={hasProblem} /> : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-accent">Aerele Proctor</p>
              <h1 className="mt-2 text-2xl font-semibold text-ink">
                {isFormStage ? "Register and start recording" : activeProblem ? "Proctored coding test" : "HackerRank companion recording"}
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
                {isFormStage
                  ? studentCopy.formStageIntro(hasProblem)
                  : activeProblem
                    ? "Keep this tab open. Solve the problem in the coding workspace below and end the test here when you finish."
                    : "Keep this tab open. Open HackerRank with the Start test button and end the test here after you submit."}
              </p>
            </div>
            <StatusPill status={status} />
          </div>

          {isFormStage ? (
            <>
              {rosterRequired ? (
                <IdentityLookupPanel
                  label={examConfig?.unique_id_label ?? ""}
                  value={uniqueIdInput}
                  onChange={setUniqueIdInput}
                  busy={lookupBusy}
                  error={lookupError}
                  match={rosterMatch}
                  confirmed={rosterConfirmed}
                  confirmedId={form.roster_unique_id}
                  onLookup={() => void lookupRosterId()}
                  onConfirm={confirmRosterMatch}
                  onReject={rejectRosterMatch}
                  onReset={resetRosterIdentity}
                />
              ) : null}
              {!rosterGateActive ? (
                <>
                  <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Your details</p>
                  <div className="grid gap-4 md:grid-cols-2">
                    <Field label="HackerRank username" value={form.hackerrank_username} disabled={rosterConfirmed && Boolean(rosterMatch?.hackerrank_username)} onChange={(value) => setForm({ ...form, hackerrank_username: value })} />
                    <Field label="Full name" value={form.name} disabled={rosterConfirmed && Boolean(rosterMatch?.name)} onChange={(value) => setForm({ ...form, name: value })} />
                    <Field label="Roll number" value={form.roll_number} disabled={rosterConfirmed && Boolean(rosterMatch?.roll_number)} onChange={(value) => setForm({ ...form, roll_number: value })} />
                    <Field label="Email" type="email" value={form.email} disabled={rosterConfirmed && Boolean(rosterMatch?.email_masked)} onChange={(value) => setForm({ ...form, email: value })} />
                    <RoomField rooms={examConfig?.rooms ?? []} value={form.room} onChange={(value) => setForm({ ...form, room: value })} />
                  </div>

                  <label className="mt-5 flex gap-3 rounded-lg border border-line bg-white/60 p-4 text-sm leading-6 text-muted">
                    <input
                      className="mt-1 h-4 w-4 accent-accent"
                      type="checkbox"
                      checked={form.consent_accepted}
                      onChange={(event) => setForm({ ...form, consent_accepted: event.target.checked })}
                    />
                    <span>
                      {studentCopy.consentDisclosure(hasProblem)}
                    </span>
                  </label>
                </>
              ) : null}
            </>
          ) : null}

          {/* Prominent, recoverable screen-share / start failure — never dead-ends
              and never asks for a reload. Shown above the action buttons. */}
          {startError ? (
            <ScreenShareErrorPanel
              startError={startError}
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
            <EndRetryPanel error={error} busy={status === "ending"} onRetry={() => void retryEnd()} />
          ) : null}

          {reloadWarning ? (
            <div className="mt-5 rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm font-medium text-warning">
              {reloadWarning}
            </div>
          ) : null}

          {checkpoint ? (
            <IntegrityCheckpointPanel checkpoint={checkpoint} onConfirm={confirmCheckpoint} />
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
            {gate === "running" && status !== "recording" && status !== "ending" && !startError ? (
              <button className="focus-ring inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50" disabled={status === "starting"} onClick={resumeRecording}>
                <MonitorUp size={16} /> {status === "starting" ? "Resuming…" : "Resume recording"}
              </button>
            ) : null}
            {status === "recording" && pipAvailable ? (
              <button className="focus-ring inline-flex items-center gap-2 rounded-md border border-line px-4 py-2 text-sm font-medium" onClick={requestCameraPictureInPicture}>
                <PictureInPicture2 size={16} /> Camera pop-out
              </button>
            ) : null}
            {/* Legacy external-contest fallback: shown ONLY when no SERVER
                problem is assigned. With a problem assigned the own-editor
                CodingWorkspace below replaces this link entirely. */}
            {!activeProblem && status === "recording" && mediaCapture.screen === "recording" && contestUrl && !error && !examGateActive ? (
              <a
                className="focus-ring inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white"
                href={contestUrl}
                rel="noreferrer"
                target="_blank"
              >
                <ExternalLink size={16} /> Start test
              </a>
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
              hasProblem={hasProblem}
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
            <WhatIsRecordedPanel hasProblem={hasProblem} />
          ) : (
            <>
              <CameraSelfView videoRef={cameraVideoRef} mediaCapture={mediaCapture} pipMessage={pipMessage} onPopOut={requestCameraPictureInPicture} pipAvailable={pipAvailable} />
              <HealthPanel status={status} sessionId={sessionId} config={sessionConfig} queueDepth={queueDepth} uploadedCount={uploadedCount} manifest={manifest} mediaCapture={mediaCapture} startIp={startIp} currentIp={currentIp} ipChanged={ipChanged} />
              <EntryReviewPanel clipboardAudit={clipboardAudit} clipboardText={clipboardText} tabAudit={tabAudit} cookieAudit={cookieAudit} />
              <RulesPanel hasProblem={hasProblem} />
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

      {/* S4: own coding workspace (Monaco + Run/Submit), live only while
          recording so every editor event is tied to an actively recorded
          session. The problem comes from the server (settings.problem_id);
          when assigned it REPLACES the contest_url Start-test surface. S3:
          held back while the room gate is still active (candidate in the
          RoomCodePanel waiting room above). */}
      {activeProblem && sessionId && status === "recording" && !examGateActive && (
        <div className="mt-5">
          <CodingWorkspace sessionId={sessionId} problem={activeProblem} />
        </div>
      )}

      <section className="mt-5 rounded-lg border border-line bg-panel p-5">
        <div className="mb-4 flex items-center gap-2">
          <ClipboardList size={18} />
          <h2 className="text-base font-semibold">Recent proctor events</h2>
        </div>
        <div className="space-y-2">
          {events.length ? events.map((event, index) => <EventRow key={`${event.timestamp}-${index}`} event={event} />) : <p className="text-sm text-muted">Events will appear after recording starts.</p>}
        </div>
      </section>
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

// Prominent identity confirmation (Epic 3): the student sees exactly who the
// session is registered to before and during the test.
function IdentityCard({ identity }: { identity: { name: string; username: string; room: string } }) {
  return (
    <section className="mb-5 rounded-lg border border-accent/40 bg-accent/5 p-5 shadow-subtle">
      <div className="flex flex-wrap items-center gap-3">
        <UserCheck size={22} className="text-accent" />
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-accent">You are taking the test as</p>
          <p className="mt-1 text-lg font-semibold text-ink">
            {identity.name} <span className="font-mono text-base text-muted">({identity.username})</span>
          </p>
          <p className="mt-1 text-sm text-muted">Room {identity.room || "—"} · Confirm this is you. If anything is wrong, call a proctor before continuing.</p>
        </div>
      </div>
    </section>
  );
}

// Shared blocked-state screen for pending_approval and locked. Self-service:
// the student can re-check status without staff once a proctor acts.
function BlockedScreen({ tone, icon, title, lines, onRefresh, error }: { tone: "warning" | "danger"; icon: React.ReactNode; title: string; lines: string[]; onRefresh: () => void; error: string }) {
  const toneStyles = tone === "danger" ? "border-danger/30 bg-danger/5 text-danger" : "border-warning/40 bg-warning/5 text-warning";
  return (
    <section className={`mx-auto max-w-xl rounded-lg border p-6 text-center shadow-subtle ${toneStyles}`}>
      <div className="mx-auto flex items-center justify-center">{icon}</div>
      <h1 className="mt-3 text-2xl font-semibold text-ink">{title}</h1>
      <div className="mt-3 space-y-2 text-sm leading-6 text-muted">
        {lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      <button className="focus-ring mt-5 inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-sm font-medium text-white" onClick={onRefresh}>
        <RefreshCw size={16} /> Check again
      </button>
      {error ? <div className="mt-4 rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{error}</div> : null}
    </section>
  );
}

function EndTestPanel({ assuranceAccepted, hasProblem, onAssuranceChange, onCancel, onEnd }: { assuranceAccepted: boolean; hasProblem: boolean; onAssuranceChange: (value: boolean) => void; onCancel: () => void; onEnd: () => void }) {
  return (
    <div className="mt-5 rounded-lg border border-danger/30 bg-danger/10 p-4">
      <p className="text-sm font-semibold text-danger">End test confirmation</p>
      <p className="mt-1 text-sm leading-6 text-ink">{studentCopy.endTestConfirmation(hasProblem)}</p>
      <label className="mt-4 flex gap-3 rounded-md border border-line bg-white/70 p-3 text-sm leading-6 text-muted">
        <input className="mt-1 h-4 w-4 accent-danger" type="checkbox" checked={assuranceAccepted} onChange={(event) => onAssuranceChange(event.target.checked)} />
        <span>I assure that I worked independently, did not copy, did not use AI/external help, and submitted only my own solution.</span>
      </label>
      <div className="mt-4 flex flex-wrap gap-3">
        <button className="focus-ring inline-flex items-center gap-2 rounded-md bg-danger px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50" disabled={!assuranceAccepted} onClick={onEnd}>
          <Square size={16} /> End and close session
        </button>
        <button className="focus-ring rounded-md border border-line px-4 py-2 text-sm font-medium" onClick={onCancel}>
          Continue test
        </button>
      </div>
    </div>
  );
}

type AdminView = "stats" | "alerts" | "sessions" | "attendance" | "review" | "recordings" | "problems" | "settings" | "ips";

// A2: the status a stat-card drill-down filters the Sessions list to. Mirrors the
// AdminStats card labels. "" = no status filter (the Total card). "disconnected"
// has no literal session-doc status (it is a derived liveness state), so the
// Sessions list treats it as the active sessions and shows an explanatory note.
type SessionsStatusFilter = "" | "active" | "locked" | "pending_approval" | "ended" | "disconnected";

// S3: the waiting room between "recording started" and "exam released". Shows a
// big 6-digit entry (the invigilator writes the room code on the board) and
// auto-advances when the invigilator opens the whole room.
function RoomCodePanel(props: {
  room: string;
  code: string;
  error: string;
  busy: boolean;
  onCodeChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const { room, code, error, busy, onCodeChange, onSubmit } = props;
  return (
    <section className="rounded-lg border border-accent/40 bg-accent/5 p-6 text-center shadow-subtle">
      <KeyRound size={26} className="mx-auto text-accent" />
      <h2 className="mt-3 text-xl font-semibold text-ink">Waiting for your room code</h2>
      <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-muted">
        Recording has started. Your invigilator will announce a 6-digit start code for room {room ? <strong>{room}</strong> : "(not set)"} just before the test begins. Enter it below — or simply wait: if your invigilator starts the whole room, this screen advances automatically.
      </p>
      <div className="mx-auto mt-4 flex max-w-xs items-center gap-3">
        <input
          className="focus-ring h-12 w-full rounded-md border border-line bg-white px-4 text-center text-2xl font-semibold tracking-[0.4em] text-ink"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="000000"
          value={code}
          onChange={(event) => onCodeChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && isCompleteOtp(code) && !busy) onSubmit();
          }}
        />
        <button
          className="focus-ring inline-flex h-12 items-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!isCompleteOtp(code) || busy}
          onClick={onSubmit}
        >
          {busy ? "Checking…" : "Start"}
        </button>
      </div>
      {error ? <p className="mt-3 text-sm font-medium text-danger">{error}</p> : null}
      <p className="mt-3 text-xs text-muted">Stay in this tab. Your screen is being recorded while you wait.</p>
    </section>
  );
}

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
  const [alertFilters, setAlertFilters] = useState<AlertFilters>({});
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

  // S7: IP report state — the report payload, scope (live = non-ended only),
  // loading flag, and the 404-degrade marker (endpoint not deployed yet).
  const [ipReport, setIpReport] = useState<IpReportResponse | null>(null);
  const [ipReportLoading, setIpReportLoading] = useState(false);
  const [ipScope, setIpScope] = useState<IpReportScope>("live");
  const [ipReportUnavailable, setIpReportUnavailable] = useState(false);

  // F6.4: ALL session docs (status "" = no filter) under the current contest
  // scope, used by the alerts console to join each alert to its candidate's
  // CURRENT session status so rows render only the actions valid for it.
  // null = not loaded yet OR sessions-list not deployed → rows fall back to the
  // full action set (a stale backend must not lose admin capability).
  const [alertSessions, setAlertSessions] = useState<RecordingSession[] | null>(null);

  const loadAlerts = async (filters?: AlertFilters) => {
    setAlertsLoading(true);
    setError("");
    try {
      const response = await fetchAlerts(password, filters ?? alertFilters);
      const sorted = [...response.alerts].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
      setAlerts(sorted);
      if (response.rooms) setRooms(response.rooms);
      setAlertsLoaded(true);
      await loadAlertSessions(filters);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAlertsLoading(false);
    }
  };

  // F6.4: refresh the status-join data for the alerts console. Errors are
  // non-fatal (the join is an enhancement; alerts stay usable without it) and a
  // 404 keeps null via fetchSessionsList's graceful-degrade contract.
  const loadAlertSessions = async (filters?: AlertFilters) => {
    try {
      const active = filters ?? alertFilters;
      const list = await fetchSessionsList(password, { status: "", contestSlug: active.contest_slug });
      setAlertSessions(list);
    } catch {
      // Keep the previous join data — stale statuses beat dropping the buttons.
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

  // S5: apply an exam-time change; outcomes surface through the existing
  // actionMessage banner, and stats reload so counts reflect an end-now.
  const runExamTime = async (body: ExamTimeRequest) => {
    setExamTimeBusy(true);
    setError("");
    setActionMessage("");
    try {
      const response = await adjustExamTime(password, body);
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
      setSessionsList(list);
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
      try {
        // F6.4: the status-join data loads alongside the alerts themselves so
        // the first render already shows the contextual action buttons.
        const [response, sessions] = await Promise.all([
          fetchAlerts(password, alertFilters),
          fetchSessionsList(password, { status: "", contestSlug: alertFilters.contest_slug })
        ]);
        if (cancelled) return;
        const sorted = [...response.alerts].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
        setAlerts(sorted);
        setAlertSessions(sessions);
        if (response.rooms) setRooms(response.rooms);
        setAlertsLoaded(true);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setAlertsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlocked, view, alertsLoaded, password]);

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
          // the contextual buttons track live status changes.
          const [response, sessions] = await Promise.all([
            fetchAlerts(password, alertFilters),
            fetchSessionsList(password, { status: "", contestSlug: alertFilters.contest_slug })
          ]);
          if (cancelled) return;
          const sorted = [...response.alerts].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
          setAlerts(sorted);
          setAlertSessions(sessions);
          if (response.rooms) setRooms(response.rooms);
          setAlertsLoaded(true);
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

  const loadSettings = async () => {
    setSettingsLoading(true);
    setError("");
    setSettingsMessage("");
    try {
      const response = await fetchProctorSettings(password);
      setSettings({
        start_at: isoToLocalInput(response.start_at),
        end_at: isoToLocalInput(response.end_at),
        contest_url: response.contest_url || "",
        room_gate_enabled: Boolean(response.room_gate_enabled),
        problem_id: response.problem_id || "",
        updated_at: response.updated_at
      });
      setRoomsText((response.rooms ?? []).join(", "));
      setSettingsMessage("Loaded current gate.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSettingsLoading(false);
    }
  };

  const saveSettings = async () => {
    setSettingsLoading(true);
    setError("");
    setSettingsMessage("");
    try {
      const response = await saveProctorSettings(password, {
        start_at: localInputToIso(settings.start_at),
        end_at: localInputToIso(settings.end_at),
        contest_url: settings.contest_url,
        room_gate_enabled: settings.room_gate_enabled === true,
        problem_id: settings.problem_id,
        // parseRosterInput = the existing comma/newline split + trim + dedupe.
        rooms: parseRosterInput(roomsText)
      });
      setSettings({
        start_at: isoToLocalInput(response.start_at),
        end_at: isoToLocalInput(response.end_at),
        contest_url: response.contest_url || "",
        room_gate_enabled: Boolean(response.room_gate_enabled),
        problem_id: response.problem_id || "",
        updated_at: response.updated_at
      });
      setRoomsText((response.rooms ?? []).join(", "));
      setSettingsMessage("Saved. The time window is now the only start gate (no passcode).");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSettingsLoading(false);
    }
  };

  const search = async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetchAdminSessions(username, password);
      setResult(response.sessions);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  // Per-candidate or bulk remote action against the backend session-action API.
  // After it runs we refresh whatever data the current view is showing.
  const runAction = async (action: SessionAction, opts: { sessionId?: string; usernames?: string[] }) => {
    setError("");
    setActionMessage("");
    try {
      const response = await sessionAction(password, {
        action,
        ...(opts.sessionId ? { session_id: opts.sessionId } : {}),
        ...(opts.usernames ? { usernames: opts.usernames } : {})
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
        ...(sessionId ? { session_id: sessionId } : { usernames: [alert.hackerrank_username] }),
        ...(alert.contest_slug ? { contest_slug: alert.contest_slug } : {})
      });
      await alertAction(password, { action: "archive", ids: [alert.id] });
      setActionMessage(`Approved ${alert.hackerrank_username} and archived the alert.`);
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
      setActionMessage(`Approved ${session.hackerrank_username} (${response.updated.length} session(s)).`);
      await loadSessions();
      await loadStats();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
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
      setRosterMessage(`Saved roster with ${result.count} username${result.count === 1 ? "" : "s"}.`);
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
  // username (POST /api/admin/session-details), build a CSV
  // (header username,name,email,roll_number,room) with ONE row per INPUT username
  // (blank cells when the candidate was not found, so the operator sees who is
  // missing), and trigger a client download — mirrors exportReviewsCsv.
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
        `Exported details for ${details.length} username${details.length === 1 ? "" : "s"} to candidate-details.csv${missing ? ` (${missing} not found)` : ""}.`
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
    <Shell>
      <nav className="mb-5 flex flex-wrap gap-2" aria-label="Admin views">
        <AdminTab active={view === "stats"} onClick={() => setView("stats")} icon={<ShieldCheck size={16} />} label="Live stats" />
        <AdminTab active={view === "alerts"} onClick={() => setView("alerts")} icon={<Bell size={16} />} label="Live alerts" badge={alerts.length} />
        <AdminTab active={view === "sessions"} onClick={() => { setView("sessions"); void loadSessions(); }} icon={<Users size={16} />} label="Sessions" />
        <AdminTab active={view === "ips"} onClick={() => { setView("ips"); void loadIpReport(); }} icon={<Network size={16} />} label="IP report" />
        <AdminTab active={view === "attendance"} onClick={() => setView("attendance")} icon={<UserCheck size={16} />} label="Attendance" />
        <AdminTab active={view === "review"} onClick={() => setView("review")} icon={<Search size={16} />} label="Review" />
        <AdminTab active={view === "recordings"} onClick={() => setView("recordings")} icon={<Film size={16} />} label="Recordings" />
        <AdminTab active={view === "problems"} onClick={() => setView("problems")} icon={<ClipboardList size={16} />} label="Problems" />
        <AdminTab active={view === "settings"} onClick={() => setView("settings")} icon={<Lock size={16} />} label="Settings" />
      </nav>

      {/* A1: GLOBAL CONTEST FILTER — below the nav so it scopes EVERY tab. */}
      <ContestFilterBanner
        contestSlug={alertFilters.contest_slug ?? ""}
        onApply={(slug) => {
          const next = { ...alertFilters, contest_slug: slug };
          setAlertFilters(next);
          void loadStats(next);
          if (alertsLoaded) void loadAlerts(next);
          if (sessionsList !== null) void loadSessions(next);
          if (ipReport !== null) void loadIpReport(undefined, next);
        }}
        onClear={() => {
          const next = { ...alertFilters, contest_slug: undefined };
          setAlertFilters(next);
          void loadStats(next);
          if (alertsLoaded) void loadAlerts(next);
          if (sessionsList !== null) void loadSessions(next);
          if (ipReport !== null) void loadIpReport(undefined, next);
        }}
      />

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
        />
      ) : null}

      {view === "attendance" ? (
        <AttendancePanel password={password} contestSlug={alertFilters.contest_slug ?? ""} />
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
        />
      ) : null}

      {view === "alerts" ? (
        <AlertsConsole
          alerts={alerts}
          sessions={alertSessions}
          loading={alertsLoading}
          loaded={alertsLoaded}
          filters={alertFilters}
          rooms={rooms}
          selected={selected}
          onToggleSelected={toggleSelected}
          onSelectAll={(ids) => setSelected((current) => addAllToSelection(current, ids))}
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

      {view === "problems" ? <ProblemBankSection password={password} /> : null}

      {view === "settings" ? (
      <div className="space-y-5">
      <section className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
        <div className="mb-5 flex items-center gap-3">
          <Lock size={20} />
          <div>
            <h1 className="text-2xl font-semibold">Proctoring gate</h1>
            <p className="mt-1 text-sm text-muted">Set the allowed window and contest URL. The time window is the only start gate — there is no passcode and no end code.</p>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-[1fr_1fr_1fr]">
          <Field label="Start time" type="datetime-local" value={settings.start_at} onChange={(value) => setSettings({ ...settings, start_at: value })} />
          <Field label="End time" type="datetime-local" value={settings.end_at} onChange={(value) => setSettings({ ...settings, end_at: value })} />
          <Field label="Contest URL" type="url" value={settings.contest_url ?? ""} onChange={(value) => setSettings({ ...settings, contest_url: value })} />
          <Field label="Active problem ID" value={settings.problem_id ?? ""} onChange={(value) => setSettings({ ...settings, problem_id: value })} />
          <Field label="Rooms (comma-separated)" value={roomsText} onChange={setRoomsText} />
          <label className="flex items-start gap-3 rounded-md border border-line bg-white/60 p-4 text-sm leading-6 text-muted md:col-span-3">
            <input
              className="mt-1 h-4 w-4 accent-accent"
              type="checkbox"
              checked={settings.room_gate_enabled === true}
              onChange={(event) => setSettings({ ...settings, room_gate_enabled: event.target.checked })}
            />
            <span>
              <span className="font-medium text-ink">Room start codes (invigilator gate)</span> — after recording starts, candidates wait until their room's invigilator releases a 6-digit code (or presses "Start now") from <code>/invigilator</code>. Unchecking this releases everyone.
            </span>
          </label>
          <div className="mt-6 flex flex-wrap gap-3 md:col-span-3">
            <button className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md border border-line px-4 text-sm font-medium" onClick={loadSettings} disabled={settingsLoading}>
              Load current
            </button>
            <button className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white disabled:opacity-50" onClick={saveSettings} disabled={settingsLoading || !settings.start_at || !settings.end_at}>
              Save gate
            </button>
          </div>
        </div>
        {settingsMessage ? <div className="mt-4 rounded-lg border border-accent/30 bg-accent/10 p-4 text-sm text-accent">{settingsMessage}</div> : null}
        {settings.updated_at ? <p className="mt-3 text-xs text-muted">Last updated: {new Date(settings.updated_at).toLocaleString()}</p> : null}
      </section>

      <CandidateRosterSection password={password} />

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
            <p className="mt-1 text-sm text-muted">Search by HackerRank username to inspect sessions, events, and uploaded evidence — and run remote actions.</p>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
          <Field label="HackerRank username" value={username} onChange={setUsername} />
          <button className="focus-ring mt-6 inline-flex h-10 items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white" onClick={search} disabled={loading || !username || !password}>
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

      {view === "recordings" ? <RecordingReview password={password} contestSlug={alertFilters.contest_slug} /> : null}
    </Shell>
  );
}

// SETTINGS tab — S2 candidate roster upload. The admin picks a CSV/TSV file, we
// parse it CLIENT-SIDE (roster/parseRoster.ts), preview the first rows, choose
// the unique-ID column (+ optional identity-field mappings, pre-suggested from
// the headers), and POST structured rows to /api/admin/roster. While a roster
// is configured, student login REQUIRES a roster match (enforced server-side).
function CandidateRosterSection({ password }: { password: string }) {
  const [status, setStatus] = useState<RosterStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [parsed, setParsed] = useState<ParsedRoster | null>(null);
  const [fileName, setFileName] = useState("");
  const [uniqueIdColumn, setUniqueIdColumn] = useState("");
  const [mapping, setMapping] = useState<RosterFieldMapping>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const refresh = async () => {
    setBusy(true);
    setError("");
    try {
      const next = await fetchRosterStatus(password);
      if (next === null) setUnavailable(true);
      else {
        setUnavailable(false);
        setStatus(next);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onFile = async (file: File | null) => {
    setMessage("");
    setError("");
    if (!file) return;
    const text = await file.text();
    const result = parseRoster(text);
    if (!result.columns.length || !result.rows.length) {
      setParsed(null);
      setError(result.errors[0] || "Could not read any rows from that file.");
      return;
    }
    const suggestion = suggestMapping(result.columns);
    setParsed(result);
    setFileName(file.name);
    setUniqueIdColumn(suggestion.uniqueIdColumn);
    setMapping(suggestion.mapping);
  };

  const upload = async () => {
    if (!parsed || !uniqueIdColumn) return;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const response = await uploadRoster(password, {
        unique_id_column: uniqueIdColumn,
        columns: parsed.columns,
        column_mapping: mapping,
        rows: parsed.rows
      });
      if (response === null) {
        setUnavailable(true);
        return;
      }
      setMessage(
        `Roster saved: ${response.count} students` +
        (response.skipped.length ? `; ${response.skipped.length} row(s) skipped (${summarizeSkipped(response.skipped)})` : "") +
        ". Student login now requires a roster match."
      );
      setParsed(null);
      setFileName("");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const response = await clearRoster(password);
      if (response === null) {
        setUnavailable(true);
        return;
      }
      setMessage("Roster cleared — student login no longer requires a roster match.");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const mappingSelect = (field: keyof RosterFieldMapping, label: string) => (
    <label className="block">
      <span className="text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
      <select
        className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-3 text-sm"
        value={mapping[field] ?? ""}
        onChange={(event) => setMapping({ ...mapping, [field]: event.target.value || undefined })}
      >
        <option value="">— not in this file —</option>
        {(parsed?.columns ?? []).map((column) => (
          <option key={column} value={column}>{column}</option>
        ))}
      </select>
    </label>
  );

  return (
    <section className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Users size={20} />
          <div>
            <h2 className="text-2xl font-semibold">Candidate roster</h2>
            <p className="mt-1 text-sm text-muted">
              Upload the student list (CSV/TSV, any columns) and pick the unique-ID column. While a roster is active, students must match it to log in.
            </p>
          </div>
        </div>
        <button className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md border border-line px-4 text-sm font-medium disabled:opacity-50" onClick={() => void refresh()} disabled={busy}>
          <RefreshCw size={16} className={busy ? "animate-spin" : undefined} /> Reload
        </button>
      </div>

      {unavailable ? (
        <div className="rounded-lg border border-line bg-white p-4 text-sm text-muted">
          The roster endpoints are not deployed on this backend yet.
        </div>
      ) : (
        <>
          <div className="rounded-md border border-line bg-white/60 p-3 text-sm">
            {status?.configured ? (
              <span>
                <span className="font-semibold text-accent">Roster active:</span> {status.count} students · ID column <span className="font-mono">{status.unique_id_column}</span>
                {status.updated_at ? <span className="text-muted"> · updated {new Date(status.updated_at).toLocaleString()}</span> : null}
              </span>
            ) : (
              <span className="text-muted">No roster uploaded — student login is open (legacy form).</span>
            )}
          </div>

          <div className="mt-4">
            <label className="focus-ring inline-flex cursor-pointer items-center gap-2 rounded-md border border-line px-4 py-2 text-sm font-medium">
              <UploadCloud size={16} /> Choose roster file (.csv / .tsv)
              <input
                type="file"
                accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values"
                className="hidden"
                onChange={(event) => void onFile(event.target.files?.[0] ?? null)}
              />
            </label>
            {fileName ? <span className="ml-3 text-sm text-muted">{fileName}</span> : null}
          </div>

          {parsed ? (
            <div className="mt-4 space-y-4">
              {parsed.errors.length ? (
                <div className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
                  {parsed.errors.slice(0, 5).map((line) => <div key={line}>{line}</div>)}
                  {parsed.errors.length > 5 ? <div>…and {parsed.errors.length - 5} more.</div> : null}
                </div>
              ) : null}

              <div className="overflow-x-auto rounded-md border border-line">
                <table className="w-full text-left text-sm">
                  <thead className="bg-white/60 text-xs uppercase tracking-wide text-muted">
                    <tr>{parsed.columns.map((column) => <th key={column} className="px-3 py-2">{column}</th>)}</tr>
                  </thead>
                  <tbody>
                    {parsed.rows.slice(0, 5).map((row, index) => (
                      <tr key={index} className="border-t border-line">
                        {parsed.columns.map((column) => <td key={column} className="px-3 py-2">{row[column]}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted">Showing first {Math.min(5, parsed.rows.length)} of {parsed.rows.length} rows.</p>

              <div className="grid gap-3 md:grid-cols-3">
                <label className="block">
                  <span className="text-xs font-medium uppercase tracking-wide text-accent">Unique-ID column (required)</span>
                  <select
                    className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-3 text-sm"
                    value={uniqueIdColumn}
                    onChange={(event) => setUniqueIdColumn(event.target.value)}
                  >
                    {parsed.columns.map((column) => <option key={column} value={column}>{column}</option>)}
                  </select>
                </label>
                {mappingSelect("name", "Name column")}
                {mappingSelect("email", "Email column")}
                {mappingSelect("roll_number", "Roll-number column")}
                {mappingSelect("hackerrank_username", "HackerRank-username column")}
                {mappingSelect("room", "Room column")}
              </div>

              <button
                className="focus-ring inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => void upload()}
                disabled={busy || !uniqueIdColumn}
              >
                <UploadCloud size={16} /> {busy ? "Uploading…" : `Upload roster (${parsed.rows.length} students)`}
              </button>
            </div>
          ) : null}

          {status?.configured ? (
            <div className="mt-4">
              <button className="focus-ring inline-flex items-center gap-2 rounded-md border border-danger/40 px-4 py-2 text-sm font-medium text-danger disabled:opacity-50" onClick={() => void clear()} disabled={busy}>
                <X size={16} /> Clear roster (open login)
              </button>
            </div>
          ) : null}

          {message ? <div className="mt-4 rounded-lg border border-accent/30 bg-accent/10 p-4 text-sm text-accent">{message}</div> : null}
          {error ? <div className="mt-4 rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger">{error}</div> : null}
        </>
      )}
    </section>
  );
}

function summarizeSkipped(skipped: Array<{ row: number; reason: string }>) {
  const counts = new Map<string, number>();
  for (const item of skipped) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  return [...counts.entries()].map(([reason, count]) => `${count}× ${reason}`).join(", ");
}

// SETTINGS tab — per-type proctor alert configuration (enable/disable + severity)
// backed by GET/POST /api/admin/alert-settings. Each toggle/severity change saves
// the FULL config immediately so a partial payload can never be sent.
function ProctorAlertTypesSection({ settings, loading, message, onReload, onSave }: { settings: AlertSettings | null; loading: boolean; message: string; onReload: () => void; onSave: (next: AlertSettings) => void }) {
  const types = settings ? Object.keys(settings.proctor) : [];
  const updateType = (type: string, patch: Partial<ProctorAlertTypeConfig>) => {
    if (!settings) return;
    const next: AlertSettings = {
      proctor: { ...settings.proctor, [type]: { ...settings.proctor[type], ...patch } }
    };
    onSave(next);
  };
  return (
    <section className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Bell size={20} />
          <div>
            <h2 className="text-2xl font-semibold">Proctor alert types</h2>
            <p className="mt-1 text-sm text-muted">Enable or disable each proctor sure-shot and override its severity. Changes save immediately.</p>
          </div>
        </div>
        <button className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md border border-line px-4 text-sm font-medium disabled:opacity-50" onClick={onReload} disabled={loading}>
          <RefreshCw size={16} className={loading ? "animate-spin" : undefined} /> Reload
        </button>
      </div>

      {settings === null ? (
        <div className="rounded-lg border border-line bg-white p-4 text-sm text-muted">{loading ? "Loading alert settings…" : "No alert settings loaded yet."}</div>
      ) : (
        <div className="space-y-2">
          {types.map((type) => {
            const config = settings.proctor[type];
            return (
              <div key={type} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-white/60 p-3">
                <div className="flex items-center gap-3">
                  <label className="inline-flex items-center gap-2 text-sm font-medium">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-accent"
                      checked={config.enabled}
                      disabled={loading}
                      onChange={(event) => updateType(type, { enabled: event.target.checked })}
                    />
                    <span className="font-mono">{type}</span>
                  </label>
                  {!config.enabled ? <span className="rounded-full border border-line px-2 py-0.5 text-xs text-muted">disabled</span> : null}
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  {/* tab_away alone exposes a configurable threshold: the minimum
                      continuous "HackerRank not visible" span (seconds) the
                      monitoring tab-away detector must observe before alerting.
                      Saved with the rest of alert-settings (source of truth for
                      the detector's --min-gap-seconds). */}
                  {type === "tab_away" ? (
                    <label className="flex items-center gap-2 text-xs text-muted">
                      Threshold
                      <input
                        type="number"
                        min={1}
                        step={1}
                        className="focus-ring h-9 w-20 rounded-md border border-line bg-white px-2 text-sm"
                        value={config.threshold_seconds ?? 12}
                        disabled={loading}
                        onChange={(event) => {
                          const next = Number(event.target.value);
                          updateType(type, { threshold_seconds: Number.isFinite(next) && next > 0 ? next : 12 });
                        }}
                      />
                      seconds
                    </label>
                  ) : null}
                  <label className="flex items-center gap-2 text-xs text-muted">
                    Severity
                    <select
                      className="focus-ring h-9 w-32 rounded-md border border-line bg-white px-2 text-sm"
                      value={config.severity}
                      disabled={loading}
                      onChange={(event) => updateType(type, { severity: event.target.value as AlertSeverity })}
                    >
                      <option value="critical">critical</option>
                      <option value="warning">warning</option>
                      <option value="info">info</option>
                    </select>
                  </label>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {message ? <div className="mt-4 rounded-lg border border-accent/30 bg-accent/10 p-4 text-sm text-accent">{message}</div> : null}
    </section>
  );
}

// SETTINGS tab — read-only reference for the contest-eval alert types, which are
// configured in monitoring/alert-config.json (NOT through this console).
function ContestEvalAlertTypesSection() {
  return (
    <section className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
      <div className="mb-4 flex items-center gap-3">
        <Search size={20} />
        <div>
          <h2 className="text-2xl font-semibold">Contest-eval alert types</h2>
          <p className="mt-1 text-sm text-muted">Read-only. These are configured in <span className="font-mono">monitoring/alert-config.json</span>, not here.</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {CONTEST_EVAL_ALERT_TYPES.map((type) => (
          <span key={type} className="rounded-full border border-line bg-white px-3 py-1.5 font-mono text-xs text-muted">{type}</span>
        ))}
      </div>
    </section>
  );
}

// Escape one CSV field per RFC-4180 AND neutralize spreadsheet formula injection.
// A candidate-controlled cell (name/username) starting with = + - @ — or a leading
// tab / carriage return that some apps strip before re-checking — executes as a
// formula when the export is opened in Excel/Sheets. Prefix any such cell with a
// single quote (') so the spreadsheet treats it as literal text, THEN apply the
// RFC-4180 quoting (wrap in quotes + double embedded quotes for comma/quote/CR/LF).
export function csvField(value: string): string {
  const neutralized = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (/[",\n\r]/.test(neutralized)) return `"${neutralized.replace(/"/g, '""')}"`;
  return neutralized;
}

// Build the reviews CSV: header `username,reviewer_name,verdict`, one row per
// review record, verdict rendered as 1/0. Exported by the Settings page.
function buildReviewsCsv(reviews: Array<{ username: string; reviewer_name: string; verdict: number }>): string {
  const header = "username,reviewer_name,verdict";
  const rows = reviews.map((r) => `${csvField(r.username)},${csvField(r.reviewer_name)},${r.verdict === 1 ? 1 : 0}`);
  return [header, ...rows].join("\n");
}

// Build the candidate-details CSV: header `username,name,email,roll_number,room`,
// one row per INPUT username (blank cells when the candidate was not found so the
// operator can see who is missing). Every field goes through csvField (escaping).
function buildDetailsCsv(details: SessionDetail[]): string {
  const header = "username,name,email,roll_number,room";
  const rows = details.map((d) =>
    [
      csvField(d.username),
      csvField(d.found ? d.name : ""),
      csvField(d.found ? d.email : ""),
      csvField(d.found ? d.roll_number : ""),
      csvField(d.found ? d.room : "")
    ].join(",")
  );
  return [header, ...rows].join("\n");
}

// SETTINGS tab — REVIEW ROSTER. The operator pastes the usernames to be reviewed
// (comma or newline separated; parsed/deduped client-side too), saves them, sees
// a coverage summary, and exports all collected verdicts as a CSV. Degrades to a
// clear "not deployed yet" note when the review endpoints 404.
function ReviewRosterSection({
  text,
  onTextChange,
  summary,
  loading,
  exporting,
  downloadingDetails,
  message,
  unavailable,
  onSave,
  onReload,
  onExport,
  onDownloadDetails
}: {
  text: string;
  onTextChange: (value: string) => void;
  summary: ReviewRosterSummary | null;
  loading: boolean;
  exporting: boolean;
  downloadingDetails: boolean;
  message: string;
  unavailable: boolean;
  onSave: () => void;
  onReload: () => void;
  onExport: () => void;
  onDownloadDetails: () => void;
}) {
  // Live client-side count of what's currently in the textarea (after split/dedupe).
  const parsedCount = useMemo(() => parseRosterInput(text).length, [text]);
  return (
    <section className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <ListChecks size={20} />
          <div>
            <h2 className="text-2xl font-semibold">Review roster</h2>
            <p className="mt-1 text-sm text-muted">Paste the HackerRank usernames to be reviewed (comma or newline separated). Reviewers open Recordings → Review mode and are served these students one-by-one.</p>
          </div>
        </div>
        <button
          className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md border border-line px-4 text-sm font-medium disabled:opacity-50"
          onClick={onReload}
          disabled={loading}
        >
          <RefreshCw size={16} className={loading ? "animate-spin" : undefined} /> Reload
        </button>
      </div>

      {unavailable ? (
        <div className="rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm text-warning">
          <AlertTriangle size={16} className="mr-2 inline" />
          The review workflow endpoints are not deployed yet. Once the backend exposes the review-roster / reviews APIs, this section becomes active.
        </div>
      ) : (
        <>
          <textarea
            className="focus-ring min-h-[140px] w-full rounded-md border border-line bg-white p-3 font-mono text-sm"
            placeholder={"Asha_R, Karan_V, Neha_S\nVikram_T"}
            value={text}
            onChange={(event) => onTextChange(event.target.value)}
          />
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white disabled:opacity-50"
              onClick={onSave}
              disabled={loading || !parsedCount}
            >
              <ListChecks size={16} /> Save roster ({parsedCount})
            </button>
            <button
              className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md border border-line px-4 text-sm font-medium disabled:opacity-50"
              onClick={onExport}
              disabled={exporting}
            >
              <Download size={16} className={exporting ? "animate-pulse" : undefined} /> {exporting ? "Exporting…" : "Export reviews CSV"}
            </button>
            <button
              className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md border border-line px-4 text-sm font-medium disabled:opacity-50"
              onClick={onDownloadDetails}
              disabled={downloadingDetails || !parsedCount}
            >
              <Download size={16} className={downloadingDetails ? "animate-pulse" : undefined} /> {downloadingDetails ? "Downloading…" : "Download all details"}
            </button>
          </div>

          {/* SUMMARY LINE from GET review-roster. */}
          {summary ? (
            <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
              <span className="font-semibold text-ink">{summary.total}</span> total
              <span className="text-muted/50">·</span>
              <span className="font-semibold text-ink">{summary.with_0_reviews}</span> with 0 reviews
              <span className="text-muted/50">·</span>
              <span className="font-semibold text-ink">{summary.with_1_review}</span> with 1
              <span className="text-muted/50">·</span>
              <span className="font-semibold text-ink">{summary.with_2plus_reviews}</span> with 2+
              <span className="text-muted/50">·</span>
              <span className="font-semibold text-ink">{summary.active_claims}</span> active reviewer{summary.active_claims === 1 ? "" : "s"}
            </div>
          ) : (
            <p className="mt-4 text-sm text-muted">{loading ? "Loading roster…" : "No roster summary loaded yet."}</p>
          )}

          {message ? <div className="mt-4 rounded-lg border border-accent/30 bg-accent/10 p-4 text-sm text-accent">{message}</div> : null}
        </>
      )}
    </section>
  );
}

// A1: GLOBAL CONTEST FILTER banner, rendered below the nav so it shows on EVERY
// tab. When a slug is set it shows an active chip with a Clear button; when empty
// it shows a compact labeled input. Applying/clearing rescopes Stats, Alerts,
// Sessions, and Recordings (the parent re-loads loaded data; the 5s poll re-keys
// for Stats/Alerts only). Sessions is NOT auto-polled — the poll effect guards on
// view==='stats'||'alerts' — so the parent re-loads the Sessions list explicitly
// (on tab-open, stat-card drill, status change, Refresh, and post-approve).
function ContestFilterBanner({ contestSlug, onApply, onClear }: { contestSlug: string; onApply: (slug: string) => void; onClear: () => void }) {
  const [draft, setDraft] = useState("");
  if (contestSlug) {
    return (
      <div className="mb-5 flex flex-wrap items-center gap-3 rounded-lg border border-accent/30 bg-accent/5 p-3 text-sm">
        <span className="inline-flex items-center gap-2 text-accent">
          <ListFilter size={16} />
          <span className="font-medium text-ink">Contest filter active:</span>
          <span className="font-mono font-semibold text-ink">{contestSlug}</span>
        </span>
        <button
          type="button"
          onClick={onClear}
          className="focus-ring ml-auto inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-white px-3 text-xs font-medium text-ink hover:border-ink/40"
        >
          <X size={14} /> Clear
        </button>
      </div>
    );
  }
  return (
    <form
      className="mb-5 flex flex-wrap items-end gap-3 rounded-lg border border-line bg-panel p-3 shadow-subtle"
      onSubmit={(event) => {
        event.preventDefault();
        const next = draft.trim();
        if (next) {
          onApply(next);
          setDraft("");
        }
      }}
    >
      <label className="block">
        <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted">
          <ListFilter size={13} /> Filter by contest slug
        </span>
        <input
          className="focus-ring mt-1 h-9 w-56 rounded-md border border-line bg-white px-3 text-sm"
          value={draft}
          placeholder="all contests"
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <button
        type="submit"
        disabled={!draft.trim()}
        className="focus-ring inline-flex h-9 items-center gap-1.5 rounded-md bg-ink px-4 text-xs font-medium text-white disabled:opacity-50"
      >
        Apply
      </button>
    </form>
  );
}

// S5: live exam-time control on the Live stats view. Remaining time is computed
// against the SERVER clock (skew captured when the stats/exam-time response
// arrived) so the admin display agrees with the students'. The 1 s ticker only
// re-renders this card. "End exam now" is a deliberate two-click confirm.
function ExamTimeCard({ endAt, skewMs, busy, endNowArmed, onArmEndNow, absoluteInput, onAbsoluteInputChange, onAdjust }: {
  endAt: string;
  skewMs: number;
  busy: boolean;
  endNowArmed: boolean;
  onArmEndNow: (armed: boolean) => void;
  absoluteInput: string;
  onAbsoluteInputChange: (value: string) => void;
  onAdjust: (body: ExamTimeRequest) => void;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const left = remainingMs(endAt, Date.now(), skewMs);
  const over = left !== null && left <= 0;
  const buttonClass = "focus-ring inline-flex h-10 items-center justify-center rounded-md border border-line px-3 text-sm font-medium disabled:opacity-50";
  return (
    <section className="mb-5 rounded-lg border border-line bg-panel p-5 shadow-subtle">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-ink">Exam time</h2>
          {endAt ? (
            <p className="mt-1 text-sm text-muted">
              Ends {new Date(endAt).toLocaleString()} ·{" "}
              <span className={`font-mono font-semibold ${over ? "text-danger" : "text-ink"}`}>
                {over ? "time is up" : `${formatRemaining(left ?? 0)} left`}
              </span>
            </p>
          ) : (
            <p className="mt-1 text-sm text-muted">No schedule configured yet — set the gate in Settings.</p>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <button className={buttonClass} disabled={busy || !endAt} onClick={() => onAdjust({ extend_minutes: 15 })}>+15 min</button>
          <button className={buttonClass} disabled={busy || !endAt} onClick={() => onAdjust({ extend_minutes: 5 })}>+5 min</button>
          <button className={buttonClass} disabled={busy || !endAt} onClick={() => onAdjust({ extend_minutes: -5 })}>−5 min</button>
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">New end time</span>
            <input className="focus-ring mt-1 h-10 rounded-md border border-line bg-white px-3 text-sm" type="datetime-local" value={absoluteInput} onChange={(event) => onAbsoluteInputChange(event.target.value)} />
          </label>
          <button className={buttonClass} disabled={busy || !absoluteInput} onClick={() => onAdjust({ end_at: localInputToIso(absoluteInput) })}>Set</button>
          {endNowArmed ? (
            <>
              <button className="focus-ring inline-flex h-10 items-center justify-center rounded-md bg-danger px-3 text-sm font-medium text-white disabled:opacity-50" disabled={busy} onClick={() => onAdjust({ end_now: true })}>Confirm: end for everyone</button>
              <button className={buttonClass} disabled={busy} onClick={() => onArmEndNow(false)}>Cancel</button>
            </>
          ) : (
            <button className="focus-ring inline-flex h-10 items-center justify-center rounded-md border border-danger/40 px-3 text-sm font-medium text-danger disabled:opacity-50" disabled={busy || !endAt} onClick={() => onArmEndNow(true)}>End exam now…</button>
          )}
        </div>
      </div>
      <p className="mt-3 text-xs text-muted">Changes reach students within ~15 seconds via their heartbeat — no reload needed. "End exam now" also force-ends every live session in the contest.</p>
    </section>
  );
}

function StatsDashboard({ stats, loading, onRefresh, rooms, room, onRoomChange, onDrill }: { stats: AdminStats | null; loading: boolean; onRefresh: () => void; rooms: string[]; room: string; onRoomChange: (room: string) => void; onDrill: (status: SessionsStatusFilter) => void }) {
  return (
    <section className="space-y-5">
      <div className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <ShieldCheck size={20} />
            <div>
              <h1 className="text-2xl font-semibold">Live stats</h1>
              <p className="mt-1 text-sm text-muted">Current session counts by status across the contest. Auto-refreshes every 5s; Refresh to update now.</p>
            </div>
          </div>
          <button className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white disabled:opacity-50" onClick={onRefresh} disabled={loading}>
            <RefreshCw size={16} className={loading ? "animate-spin" : undefined} /> {loading ? "Refreshing" : "Refresh"}
          </button>
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <RoomFilter rooms={rooms} value={room} onChange={onRoomChange} />
          {room ? <p className="text-xs text-muted">Counts scoped to room <span className="font-medium">{room}</span>.</p> : null}
        </div>
      </div>

      {stats === null ? (
        <div className="rounded-lg border border-line bg-panel p-5 text-sm text-muted">{loading ? "Loading stats…" : "No stats loaded yet."}</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
          <StatCard label="Live" value={stats.live} tone="accent" icon={<MonitorUp size={18} />} onClick={() => onDrill("active")} />
          <StatCard label="Disconnected" value={stats.disconnected ?? 0} tone="danger" icon={<Activity size={18} />} onClick={() => onDrill("disconnected")} />
          <StatCard label="Locked" value={stats.locked} tone="danger" icon={<Lock size={18} />} onClick={() => onDrill("locked")} />
          <StatCard label="Pending approval" value={stats.pending_approval} tone="warning" icon={<Clock size={18} />} onClick={() => onDrill("pending_approval")} />
          <StatCard label="Finished" value={stats.finished} tone="muted" icon={<CheckCircle2 size={18} />} onClick={() => onDrill("ended")} />
          <StatCard label="Total" value={stats.total} tone="ink" icon={<Users size={18} />} onClick={() => onDrill("")} />
          <StatCard label="Not started / total" value={stats.not_started_or_total ?? stats.total} tone="muted" icon={<Users size={18} />} />
        </div>
      )}
    </section>
  );
}

// A2: status-filter options for the Sessions drill-down. "disconnected" has no
// literal session-doc status (derived liveness), so the list treats it as the
// active sessions and the view shows an explanatory note.
const SESSIONS_STATUS_OPTIONS: Array<{ value: SessionsStatusFilter; label: string }> = [
  { value: "", label: "All statuses" },
  { value: "active", label: "Live" },
  { value: "disconnected", label: "Disconnected" },
  { value: "locked", label: "Locked" },
  { value: "pending_approval", label: "Pending approval" },
  { value: "ended", label: "Finished" }
];

// A2/A4: the GCS-free SESSIONS drill-down — a lightweight table of sessions from
// fetchSessionsList (ALL session docs classified server-side to match the stat
// cards), scoped to the global contest filter and room. The status filter is now
// SERVER-side: changing it reloads from the server, so the rows already arrive
// status-filtered and we render them directly (no client-side double-filtering).
// When filtered to pending_approval, each row shows an Approve quick action (A4) —
// which now reaches zero-chunk pending_approval sessions. Opened by clicking a stat
// card on the Live stats dashboard.
function SessionsView({ sessions, loading, unavailable, statusFilter, onStatusFilterChange, contestSlug, onRefresh, onApprove }: {
  sessions: RecordingSession[] | null;
  loading: boolean;
  unavailable: boolean;
  statusFilter: SessionsStatusFilter;
  onStatusFilterChange: (status: SessionsStatusFilter) => void;
  contestSlug: string;
  onRefresh: () => void;
  onApprove: (session: RecordingSession) => void;
}) {
  // The server already returns the rows status-filtered (classified to match the
  // stat-card counts), so render them directly — no client-side re-filtering.
  const rows = sessions ?? [];

  return (
    <section className="space-y-5">
      <div className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Users size={20} />
            <div>
              <h1 className="text-2xl font-semibold">Sessions</h1>
              <p className="mt-1 text-sm text-muted">
                Drill into sessions by status{contestSlug ? <> for contest <span className="font-mono font-medium">{contestSlug}</span></> : null}. Click a stat card on Live stats to jump straight to a status.
              </p>
            </div>
          </div>
          <button className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white disabled:opacity-50" onClick={onRefresh} disabled={loading}>
            <RefreshCw size={16} className={loading ? "animate-spin" : undefined} /> {loading ? "Refreshing" : "Refresh"}
          </button>
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <FilterSelect
            label="Status"
            value={statusFilter}
            options={SESSIONS_STATUS_OPTIONS}
            onChange={(value) => onStatusFilterChange(value as SessionsStatusFilter)}
          />
          <p className="text-xs text-muted">
            Showing <span className="font-medium text-ink">{rows.length}</span> session{rows.length === 1 ? "" : "s"}.
          </p>
        </div>
        {statusFilter === "disconnected" ? (
          <p className="mt-3 inline-flex items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            <AlertTriangle size={14} /> "Disconnected" is a derived liveness state — the server classifies these as active sessions whose latest liveness signal has gone stale.
          </p>
        ) : null}
      </div>

      {unavailable ? (
        <div className="rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm text-warning">
          <AlertTriangle size={16} className="mr-2 inline" />
          The sessions-list endpoint is not deployed yet, so the Sessions list is unavailable. Live stats still work; deploy the sessions-list API to enable this drill-down.
        </div>
      ) : sessions === null ? (
        <div className="rounded-lg border border-line bg-panel p-5 text-sm text-muted">{loading ? "Loading sessions…" : "No sessions loaded yet."}</div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-line bg-panel p-5 text-sm text-muted">No sessions match this status.</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-panel shadow-subtle">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-3 font-semibold">Candidate</th>
                <th className="px-4 py-3 font-semibold">Room</th>
                <th className="px-4 py-3 font-semibold">Contest</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold">Chunks</th>
                <th className="px-4 py-3 font-semibold">Started</th>
                {statusFilter === "pending_approval" ? <th className="px-4 py-3 font-semibold">Action</th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.session_id} className="border-b border-line/60 last:border-0">
                  <td className="px-4 py-3">
                    <div className="font-semibold text-ink">{s.hackerrank_username}</div>
                    {s.name ? <div className="text-xs text-muted">{s.name}</div> : null}
                  </td>
                  <td className="px-4 py-3 text-muted">{s.room || "—"}</td>
                  <td className="px-4 py-3 font-mono text-xs text-muted">{s.contest_slug || "—"}</td>
                  <td className="px-4 py-3">
                    <span className="rounded-full border border-line px-2.5 py-0.5 text-xs font-medium text-ink">{s.status}</span>
                  </td>
                  <td className="px-4 py-3 font-mono text-muted">{s.chunk_count}</td>
                  <td className="px-4 py-3 text-xs text-muted">{s.created_at ? new Date(s.created_at).toLocaleString() : "—"}</td>
                  {statusFilter === "pending_approval" ? (
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => onApprove(s)}
                        disabled={s.status !== "pending_approval"}
                        className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs font-medium text-ink hover:border-ink/40 disabled:opacity-50"
                      >
                        <CheckCircle2 size={14} /> Approve
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// S6 ATTENDANCE — roster-based attendance from GET /api/admin/attendance: taken /
// not-taken counts (in-progress vs completed) + the absentee list with CSV export.
// Self-contained (own load/error state, like ContestEvalAlertTypesSection): loads
// when the tab mounts and when the global contest filter changes; manual Refresh
// only — NO auto-poll (each call scans the whole roster + session set). Degrades
// to "not deployed yet" when fetchAttendance returns null (endpoint 404).
function AttendancePanel({ password, contestSlug }: { password: string; contestSlug: string }) {
  const [report, setReport] = useState<AttendanceReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const next = await fetchAttendance(password, contestSlug || undefined);
      if (next === null) {
        setUnavailable(true);
        setReport(null);
        return;
      }
      setUnavailable(false);
      setReport(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load is stable per render inputs
  }, [contestSlug]);

  const downloadCsv = () => {
    if (!report || !report.configured) return;
    const csv = buildAbsenteesCsv(report.absentees);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "absentees.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const needle = filter.trim().toLowerCase();
  const rows = report && report.configured
    ? report.absentees.filter(
        (a) =>
          !needle ||
          a.unique_id.toLowerCase().includes(needle) ||
          a.name.toLowerCase().includes(needle) ||
          a.roll_number.toLowerCase().includes(needle) ||
          a.room.toLowerCase().includes(needle)
      )
    : [];

  return (
    <section className="space-y-5">
      <div className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <UserCheck size={20} />
            <div>
              <h1 className="text-2xl font-semibold">Attendance</h1>
              <p className="mt-1 text-sm text-muted">
                Roster-based attendance{contestSlug ? <> for contest <span className="font-mono font-medium">{contestSlug}</span></> : null}: who has taken the test, who is still in it, and who never showed up. Loads on open; Refresh to update.
              </p>
            </div>
          </div>
          <button className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white disabled:opacity-50" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={16} className={loading ? "animate-spin" : undefined} /> {loading ? "Refreshing" : "Refresh"}
          </button>
        </div>
      </div>

      {error ? <div className="rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger">{error}</div> : null}

      {unavailable ? (
        <div className="rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm text-warning">
          <AlertTriangle size={16} className="mr-2 inline" />
          The attendance endpoint is not deployed yet. Deploy the backend to enable attendance stats.
        </div>
      ) : report === null ? (
        <div className="rounded-lg border border-line bg-panel p-5 text-sm text-muted">{loading ? "Loading attendance…" : "No attendance loaded yet."}</div>
      ) : !report.configured ? (
        <div className="rounded-lg border border-line bg-panel p-5 text-sm text-muted">
          No student roster is configured, so attendance cannot be computed. Upload a roster in Settings → Candidate roster first.
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <StatCard label="On roster" value={report.roster_total} tone="ink" icon={<Users size={18} />} />
            <StatCard label="Taken" value={report.taken.total} tone="accent" icon={<UserCheck size={18} />} />
            <StatCard label="In progress" value={report.taken.in_progress} tone="warning" icon={<Clock size={18} />} />
            <StatCard label="Completed" value={report.taken.completed} tone="muted" icon={<CheckCircle2 size={18} />} />
            <StatCard label="Not taken" value={report.not_taken} tone="danger" icon={<AlertTriangle size={18} />} />
          </div>

          {report.unmatched_sessions > 0 ? (
            <p className="inline-flex items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              <AlertTriangle size={14} /> {report.unmatched_sessions} session{report.unmatched_sessions === 1 ? "" : "s"} could not be tied to the roster (started before the roster was uploaded, or under a replaced roster) — not counted as attendance.
            </p>
          ) : null}

          <div className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Absentees</h2>
                <p className="mt-1 text-xs text-muted">
                  {report.not_taken} roster student{report.not_taken === 1 ? "" : "s"} with no session — as of {new Date(report.generated_at).toLocaleString()}.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <input
                  className="focus-ring h-9 rounded-md border border-line px-3 text-sm"
                  placeholder="Filter by ID, name, roll, room"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
                <button
                  className="focus-ring inline-flex h-9 items-center justify-center gap-2 rounded-md border border-line px-3 text-sm font-medium disabled:opacity-50"
                  onClick={downloadCsv}
                  disabled={report.not_taken === 0}
                >
                  <Download size={14} /> Download CSV
                </button>
              </div>
            </div>

            {report.not_taken === 0 ? (
              <p className="mt-4 rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-accent">Full house — every roster student has a session.</p>
            ) : rows.length === 0 ? (
              <p className="mt-4 text-sm text-muted">No absentees match this filter.</p>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                      <th className="px-4 py-3 font-semibold">Unique ID</th>
                      <th className="px-4 py-3 font-semibold">Name</th>
                      <th className="px-4 py-3 font-semibold">Roll number</th>
                      <th className="px-4 py-3 font-semibold">Room</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((a) => (
                      <tr key={a.unique_id} className="border-b border-line/60 last:border-0">
                        <td className="px-4 py-3 font-mono text-xs font-semibold text-ink">{a.unique_id}</td>
                        <td className="px-4 py-3">{a.name || "—"}</td>
                        <td className="px-4 py-3 text-muted">{a.roll_number || "—"}</td>
                        <td className="px-4 py-3 text-muted">{a.room || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

// S7: scope options for the IP report — "live" (non-ended = logged-in users)
// vs "all" (adds ended sessions for after-the-exam forensics).
const IP_SCOPE_OPTIONS: Array<{ value: IpReportScope; label: string }> = [
  { value: "live", label: "Logged-in (live)" },
  { value: "all", label: "All sessions" }
];

// S7: IP-wise report of logged-in users — the proxy-detection signal surface.
// One row per IP, biggest clusters first: on campus, rooms collapse to a few
// NAT IPs with many users, so an unexpected solo IP (off-campus candidate) or
// an unexpected cluster (many candidates through one box) stands out. Rows
// with 2+ distinct users get a warning tint; candidates whose IP changed
// mid-exam get a warning icon. Interpretation stays with the admin — the
// report never auto-flags.
function IpReportView({ report, loading, unavailable, scope, onScopeChange, contestSlug, onRefresh }: {
  report: IpReportResponse | null;
  loading: boolean;
  unavailable: boolean;
  scope: IpReportScope;
  onScopeChange: (scope: IpReportScope) => void;
  contestSlug: string;
  onRefresh: () => void;
}) {
  return (
    <section className="space-y-5">
      <div className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Network size={20} />
            <div>
              <h1 className="text-2xl font-semibold">IP report</h1>
              <p className="mt-1 text-sm text-muted">
                IP-wise count of logged-in users{contestSlug ? <> for contest <span className="font-mono font-medium">{contestSlug}</span></> : null}. Many candidates on one unexpected IP — or a candidate on an IP nobody else uses — is a proxy/off-campus signal; a shared campus NAT is normal.
              </p>
            </div>
          </div>
          <button className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white disabled:opacity-50" onClick={onRefresh} disabled={loading}>
            <RefreshCw size={16} className={loading ? "animate-spin" : undefined} /> {loading ? "Refreshing" : "Refresh"}
          </button>
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <FilterSelect label="Scope" value={scope} options={IP_SCOPE_OPTIONS} onChange={(value) => onScopeChange(value as IpReportScope)} />
          {report ? (
            <p className="text-xs text-muted">
              <span className="font-medium text-ink">{report.distinct_ips}</span> distinct IP{report.distinct_ips === 1 ? "" : "s"} across{" "}
              <span className="font-medium text-ink">{report.total_sessions}</span> session{report.total_sessions === 1 ? "" : "s"} ·{" "}
              <span className="font-medium text-ink">{report.multi_user_ips}</span> multi-user IP{report.multi_user_ips === 1 ? "" : "s"} ·{" "}
              <span className="font-medium text-ink">{report.ip_changed_sessions}</span> session{report.ip_changed_sessions === 1 ? "" : "s"} with a mid-exam IP change
            </p>
          ) : null}
        </div>
      </div>

      {unavailable ? (
        <div className="rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm text-warning">
          <AlertTriangle size={16} className="mr-2 inline" />
          The ip-report endpoint is not deployed yet, so the IP report is unavailable. Deploy the backend to enable it.
        </div>
      ) : report === null ? (
        <div className="rounded-lg border border-line bg-panel p-5 text-sm text-muted">{loading ? "Loading IP report…" : "No report loaded yet."}</div>
      ) : report.ips.length === 0 ? (
        <div className="rounded-lg border border-line bg-panel p-5 text-sm text-muted">No sessions match this scope.</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-panel shadow-subtle">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-3 font-semibold">IP address</th>
                <th className="px-4 py-3 font-semibold">Users</th>
                <th className="px-4 py-3 font-semibold">Sessions</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold">Rooms</th>
                <th className="px-4 py-3 font-semibold">Candidates</th>
              </tr>
            </thead>
            <tbody>
              {report.ips.map((entry) => (
                <tr key={entry.ip} className={`border-b border-line/60 last:border-0 ${entry.users >= 2 ? "bg-warning/5" : ""}`}>
                  <td className="px-4 py-3 font-mono text-ink">{entry.ip}</td>
                  <td className="px-4 py-3 font-semibold text-ink">{entry.users}</td>
                  <td className="px-4 py-3 font-mono text-muted">{entry.sessions}</td>
                  <td className="px-4 py-3 text-xs text-muted">
                    {entry.active ? <span className="mr-2">{entry.active} live</span> : null}
                    {entry.locked ? <span className="mr-2">{entry.locked} locked</span> : null}
                    {entry.pending_approval ? <span className="mr-2">{entry.pending_approval} pending</span> : null}
                    {entry.ended ? <span>{entry.ended} ended</span> : null}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted">{entry.rooms.length ? entry.rooms.join(", ") : "—"}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      {entry.candidates.map((candidate) => (
                        <span
                          key={candidate.session_id}
                          className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-xs text-ink"
                          title={`${candidate.name || candidate.hackerrank_username} · ${candidate.status}${candidate.ip_change_count > 0 ? ` · IP changed ${candidate.ip_change_count}×` : ""}`}
                        >
                          {candidate.hackerrank_username}
                          {candidate.ip_change_count > 0 ? <AlertTriangle size={12} className="text-warning" /> : null}
                        </span>
                      ))}
                      {entry.candidates_truncated ? <span className="text-xs text-muted">+{entry.sessions - entry.candidates.length} more</span> : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {report.ips_truncated ? (
            <p className="border-t border-line px-4 py-3 text-xs text-muted">Showing the {report.ips.length} largest IP groups; more exist beyond the cap.</p>
          ) : null}
        </div>
      )}
    </section>
  );
}

// Shared room dropdown — populated from the response `rooms` list (full contest
// scope) so it always lists every room even while one is selected.
function RoomFilter({ rooms, value, onChange }: { rooms: string[]; value: string; onChange: (room: string) => void }) {
  return (
    <label className="block">
      <span className="text-xs font-medium uppercase tracking-wide text-muted">Room</span>
      <select className="focus-ring mt-1 h-10 w-44 rounded-md border border-line bg-white px-3 text-sm" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">All rooms</option>
        {rooms.map((label) => (
          <option key={label} value={label}>{label}</option>
        ))}
      </select>
    </label>
  );
}

function StatCard({ label, value, tone, icon, onClick }: { label: string; value: number; tone: "accent" | "danger" | "warning" | "muted" | "ink"; icon: React.ReactNode; onClick?: () => void }) {
  const toneStyles: Record<typeof tone, string> = {
    accent: "border-accent/30 bg-accent/5 text-accent",
    danger: "border-danger/30 bg-danger/5 text-danger",
    warning: "border-warning/40 bg-warning/5 text-warning",
    muted: "border-line bg-white text-muted",
    ink: "border-ink/20 bg-ink/5 text-ink"
  };
  const inner = (
    <>
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide">{label}</span>
        {icon}
      </div>
      <p className="mt-3 text-3xl font-semibold text-ink">{value}</p>
    </>
  );
  // A2: clickable cards become buttons (cursor-pointer + hover ring); plain cards
  // keep the existing div. Tone styles are identical in both branches.
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`focus-ring block w-full cursor-pointer rounded-lg border p-5 text-left shadow-subtle transition hover:ring-2 hover:ring-ink/20 ${toneStyles[tone]}`}
      >
        {inner}
      </button>
    );
  }
  return <div className={`rounded-lg border p-5 shadow-subtle ${toneStyles[tone]}`}>{inner}</div>;
}

// F6.4: design-system hover tooltip (CSS-only, shows on hover AND keyboard
// focus). Every action button is wrapped in one so the plain-language
// explanation from SESSION_ACTION_INFO / ALERT_ACTION_INFO is one hover away.
function ActionTooltip({ tip, children }: { tip: string; children: React.ReactNode }) {
  return (
    <span className="group relative inline-flex">
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1.5 w-60 -translate-x-1/2 rounded-md bg-ink px-3 py-2 text-xs font-normal leading-5 text-white opacity-0 shadow-subtle transition-opacity duration-100 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {tip}
      </span>
    </span>
  );
}

// F6.4: visually separated, labeled cluster of action buttons (session actions
// vs alert actions on an alert row).
function ActionGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-white/60 p-1.5 pl-2.5">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">{label}</span>
      {children}
    </div>
  );
}

// One session-action button: label + tooltip from SESSION_ACTION_INFO, confirm
// dialog on destructive actions (end, lock). targetLabel names the confirm target.
function SessionActionButton({ action, targetLabel, onRun }: { action: SessionAction; targetLabel: string; onRun: (action: SessionAction) => void }) {
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
// `actions` defaults to the FULL set (Review tab shows every action; the alerts
// console passes the status-filtered valid set instead).
function ActionButtons({ onAction, sessionId, username, actions = SESSION_ACTION_ORDER }: { onAction: (action: SessionAction, opts: { sessionId?: string; usernames?: string[] }) => void; sessionId?: string; username?: string; actions?: SessionAction[] }) {
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

function ReviewSessionCard({ session, onAction }: { session: Record<string, unknown>; onAction: (action: SessionAction, opts: { sessionId?: string; usernames?: string[] }) => void }) {
  const sessionId = session.session_id ? String(session.session_id) : undefined;
  return (
    <div className="rounded-lg border border-line bg-panel p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-xs text-muted">{sessionId ?? ""}</p>
          <h2 className="mt-1 text-lg font-semibold">{String(session.hackerrank_username ?? "")}</h2>
          {session.room ? <p className="text-xs text-muted">Room {String(session.room)}</p> : null}
        </div>
        <span className="rounded-full border border-line px-3 py-1 text-xs font-medium">{String(session.status ?? "unknown")}</span>
      </div>
      <div className="mt-4">
        <ActionButtons onAction={onAction} sessionId={sessionId} />
      </div>
      <pre className="mt-4 max-h-96 overflow-auto rounded-md bg-ink p-4 text-xs text-white">{JSON.stringify(session, null, 2)}</pre>
    </div>
  );
}

function AdminTab({ active, onClick, icon, label, badge }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; badge?: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`focus-ring inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium ${active ? "border-ink bg-ink text-white" : "border-line bg-panel text-ink hover:border-ink/40"}`}
    >
      {icon}
      {label}
      {badge ? <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${active ? "bg-white/20 text-white" : "bg-ink/10 text-ink"}`}>{badge}</span> : null}
    </button>
  );
}

const severityStyles: Record<AlertSeverity, string> = {
  critical: "border-danger/30 bg-danger/10 text-danger",
  warning: "border-warning/30 bg-warning/10 text-warning",
  info: "border-accent/30 bg-accent/10 text-accent"
};

function SeverityPill({ severity }: { severity: AlertSeverity }) {
  return <span className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wide ${severityStyles[severity]}`}>{severity}</span>;
}

function AlertsConsole({ alerts, sessions, loading, loaded, filters, rooms, selected, onToggleSelected, onSelectAll, onClearSelection, onFiltersChange, onRefresh, onAction, onArchive, onApproveArchive }: {
  alerts: Alert[];
  /** F6.4 status-join data; null = sessions-list unavailable → full action set. */
  sessions: RecordingSession[] | null;
  loading: boolean;
  loaded: boolean;
  filters: AlertFilters;
  rooms: string[];
  selected: Set<string>;
  onToggleSelected: (key: string) => void;
  onSelectAll: (ids: string[]) => void;
  onClearSelection: () => void;
  onFiltersChange: (filters: AlertFilters) => void;
  onRefresh: () => void;
  onAction: (action: SessionAction, opts: { sessionId?: string; usernames?: string[] }) => void;
  onArchive: (ids: string[], action?: "archive" | "unarchive") => void;
  onApproveArchive: (alert: Alert, targetSessionId?: string) => void;
}) {
  // Unique candidate usernames in the current (selected) alert set, for bulk actions.
  const selectedUsernames = useMemo(() => usernamesForSelection(alerts, selected), [alerts, selected]);
  // F6.2: ids of the CURRENTLY FILTERED list — the scope of "Select all". The
  // selected Set may also hold off-screen ids (selection survives refresh and
  // filter changes); bulk archive acts on ALL selected ids, not just visible ones.
  const visibleIds = useMemo(() => alerts.map((alert) => alert.id), [alerts]);
  const allSelected = isAllSelected(selected, visibleIds);
  // F6.4: bulk buttons show only the UNION of actions valid for the selected
  // candidates' live sessions (no join data → full set, same fallback as rows).
  const bulkActions = useMemo(
    () => (sessions === null ? SESSION_ACTION_ORDER : bulkSessionActionsFor(selectedUsernames, sessions)),
    [sessions, selectedUsernames]
  );

  return (
    <>
      <section className="mb-5 rounded-lg border border-line bg-panel p-5 shadow-subtle">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Bell size={20} />
            <div>
              <h1 className="text-2xl font-semibold">Live alerts console</h1>
              <p className="mt-1 text-sm text-muted">Proctoring and contest-eval signals across all rooms, newest first. Auto-refreshes every 5s. Click a clip to open the recorded evidence.</p>
            </div>
          </div>
          <button className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white disabled:opacity-50" onClick={onRefresh} disabled={loading}>
            <RefreshCw size={16} className={loading ? "animate-spin" : undefined} /> {loading ? "Refreshing" : "Refresh"}
          </button>
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-3">
          <FilterSelect
            label="Source"
            value={filters.source ?? ""}
            options={[{ value: "", label: "All sources" }, { value: "proctor", label: "Proctor" }, { value: "contest-eval", label: "Contest-eval" }]}
            onChange={(value) => onFiltersChange({ ...filters, source: value ? (value as AlertSource) : undefined })}
          />
          <FilterSelect
            label="Severity"
            value={filters.severity ?? ""}
            options={[{ value: "", label: "All severities" }, { value: "critical", label: "Critical" }, { value: "warning", label: "Warning" }, { value: "info", label: "Info" }]}
            onChange={(value) => onFiltersChange({ ...filters, severity: value ? (value as AlertSeverity) : undefined })}
          />
          <RoomFilter rooms={rooms} value={filters.room ?? ""} onChange={(room) => onFiltersChange({ ...filters, room: room || undefined })} />
          {/* A1: the contest filter is now the GLOBAL banner below the nav; the
              per-console contest input was removed to avoid two sources of truth. */}
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
          <Metric icon={<Bell size={16} />} label="Total" value={String(alerts.length)} />
          <Metric icon={<AlertTriangle size={16} />} label="Critical" value={String(alerts.filter((alert) => alert.severity === "critical").length)} />
          <Metric icon={<AlertTriangle size={16} />} label="Warning" value={String(alerts.filter((alert) => alert.severity === "warning").length)} />
        </div>

        {/* F6.1-2 selection bar: select-all over the CURRENTLY FILTERED list,
            selected count, clear, and bulk archive/unarchive on ALL selected ids. */}
        {alerts.length || selected.size ? (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-md border border-ink/20 bg-ink/5 p-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                className="h-4 w-4 accent-accent"
                type="checkbox"
                checked={allSelected}
                onChange={() => (allSelected ? onClearSelection() : onSelectAll(visibleIds))}
              />
              Select all ({alerts.length})
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
            <BulkActionButtons usernames={selectedUsernames} actions={bulkActions} onAction={onAction} />
          </div>
        ) : null}
      </section>

      <section className="space-y-3">
        {!loaded && loading ? (
          <div className="rounded-lg border border-line bg-panel p-5 text-sm text-muted">Loading alerts…</div>
        ) : alerts.length === 0 ? (
          <div className="rounded-lg border border-line bg-panel p-5 text-sm text-muted">No alerts match the current filters. New proctoring and contest-eval signals appear here as they arrive.</div>
        ) : (
          alerts.map((alert) => (
            <AlertRow
              key={alert.id}
              alert={alert}
              sessions={sessions}
              selected={selected.has(alert.id)}
              onToggleSelected={() => onToggleSelected(alert.id)}
              onAction={onAction}
              onArchive={onArchive}
              onApproveArchive={onApproveArchive}
            />
          ))
        )}
      </section>
    </>
  );
}

// Bulk actions operate on the live session of each selected candidate username.
// F6.4: only the actions valid for at least one selected candidate render
// (union — the backend applies each action per-candidate and skips the rest).
function BulkActionButtons({ usernames, actions, onAction }: { usernames: string[]; actions: SessionAction[]; onAction: (action: SessionAction, opts: { usernames?: string[] }) => void }) {
  if (!actions.length) {
    return <span className="text-xs text-muted">No session actions apply — the selected candidates have no live sessions.</span>;
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

function FilterSelect({ label, value, options, onChange }: { label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void }) {
  return (
    <label className="block">
      <span className="text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
      <select className="focus-ring mt-1 h-10 w-44 rounded-md border border-line bg-white px-3 text-sm" value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

function AlertRow({ alert, sessions, selected, onToggleSelected, onAction, onArchive, onApproveArchive }: { alert: Alert; sessions: RecordingSession[] | null; selected: boolean; onToggleSelected: () => void; onAction: (action: SessionAction, opts: { sessionId?: string; usernames?: string[] }) => void; onArchive: (ids: string[], action?: "archive" | "unarchive") => void; onApproveArchive: (alert: Alert, targetSessionId?: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const hasData = alert.data && Object.keys(alert.data).length > 0;
  // F6.4: join the alert to the session its actions would target (the alert's
  // own session_id, else the candidate's latest live session) and render ONLY
  // the actions valid for that session's status. sessions === null means the
  // sessions-list endpoint is unavailable → fall back to the full action set so
  // a stale backend never costs admin capability. Contest-eval alerts whose
  // candidate has no session resolve to joined === null → alert actions only.
  const joined = sessions === null ? null : sessionForAlert(alert, sessions);
  const sessionActions = sessions === null ? SESSION_ACTION_ORDER : validSessionActionsFor(joined?.status);
  const sessionGroupLabel = sessions === null ? "Session" : `Session — ${joined?.status ?? "none"}`;
  // Actions target the JOINED session (never a stale alert.session_id whose doc
  // fell back to a newer live one); without join data, legacy targeting applies.
  const actionTarget = joined
    ? { sessionId: joined.session_id }
    : alert.session_id
      ? { sessionId: alert.session_id }
      : { usernames: [alert.hackerrank_username] };
  const archiveInfo = alert.archived ? ALERT_ACTION_INFO.unarchive : ALERT_ACTION_INFO.archive;
  return (
    <div className={`rounded-lg border bg-panel p-5 shadow-subtle ${alert.archived ? "opacity-70" : ""} ${alert.severity === "critical" ? "border-danger/40" : selected ? "border-ink/50" : "border-line"}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          <input className="mt-1.5 h-4 w-4 shrink-0 accent-accent" type="checkbox" checked={selected} onChange={onToggleSelected} aria-label={`Select ${alert.hackerrank_username}`} />
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
        <AlertField label="Candidate" value={alert.hackerrank_username} mono />
        {alert.room ? <AlertField label="Room" value={alert.room} /> : null}
        {alert.contest_slug ? <AlertField label="Contest" value={alert.contest_slug} mono /> : null}
        {alert.session_id ? <AlertField label="Session" value={alert.session_id} mono /> : null}
        {/* F6.4: the joined status explains WHY the row offers these actions. */}
        {sessions !== null ? <AlertField label="Session status" value={joined?.status ?? "no live session"} /> : null}
        {alert.verdict ? <AlertField label="Verdict" value={alert.verdict.status} /> : null}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
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
                  <SessionActionButton key={action} action={action} targetLabel={alert.hackerrank_username} onRun={(chosen) => onAction(chosen, actionTarget)} />
                )
              )}
            </ActionGroup>
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
          </ActionGroup>
        </div>
      </div>

      {expanded && hasData ? (
        <pre className="mt-4 max-h-72 overflow-auto rounded-md bg-ink p-4 text-xs text-white">{JSON.stringify(alert.data, null, 2)}</pre>
      ) : null}
    </div>
  );
}

function AlertField({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line pb-1.5 last:border-0">
      <span className="text-xs uppercase tracking-wide text-muted">{label}</span>
      <span className={`truncate font-medium ${mono ? "font-mono text-xs" : ""}`}>{value}</span>
    </div>
  );
}

// padTop: StudentApp sets it while the fixed S1 ExamTopBar (64px) is rendered,
// so the header/content start below the bar. AdminApp never passes it.
function Shell({ children, padTop = false }: { children: React.ReactNode; padTop?: boolean }) {
  return (
    <main className={`min-h-screen bg-paper px-4 py-5 text-ink md:px-8 ${padTop ? "pt-20" : ""}`}>
      <div className="mx-auto max-w-6xl">
        <header className="mb-5 flex items-center justify-between border-b border-line pb-4">
          <div className="flex items-center gap-3">
            <img src="/aerele-logo.png" alt="Aerele" className="h-9 w-9 rounded-md" />
            <div>
              <p className="text-sm font-semibold">Aerele Proctor</p>
              <p className="text-xs text-muted">Evidence collection for coding assessments</p>
            </div>
          </div>
        </header>
        {children}
      </div>
    </main>
  );
}

function isoToLocalInput(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function localInputToIso(value: string) {
  if (!value) return "";
  return new Date(value).toISOString();
}

function Field({ label, value, onChange, type = "text", disabled = false }: { label: string; value: string; onChange: (value: string) => void; type?: string; disabled?: boolean }) {
  return (
    <label className="block">
      <span className="text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
      <input className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-3 text-sm disabled:bg-neutral-100" type={type} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

// S2 — roster identity gate (form stage, before the details form). Three
// states: enter-ID, confirm-match, confirmed. The server re-verifies the ID at
// /api/session/start, so this panel is UX only — never a security boundary.
function IdentityLookupPanel({ label, value, onChange, busy, error, match, confirmed, confirmedId, onLookup, onConfirm, onReject, onReset }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  busy: boolean;
  error: string;
  match: RosterLookupResult | null;
  confirmed: boolean;
  confirmedId: string;
  onLookup: () => void;
  onConfirm: () => void;
  onReject: () => void;
  onReset: () => void;
}) {
  const idLabel = label || "Unique ID";
  if (confirmed) {
    return (
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-accent/30 bg-accent/5 p-4">
        <div className="flex items-center gap-2 text-sm">
          <UserCheck size={18} className="text-accent" />
          <span className="font-medium">Identity confirmed:</span>
          <span className="font-mono">{confirmedId}</span>
        </div>
        <button className="focus-ring inline-flex items-center gap-2 rounded-md border border-line px-3 py-2 text-xs font-medium" onClick={onReset}>
          Not you? Re-enter ID
        </button>
      </div>
    );
  }
  return (
    <div className="mb-5 rounded-lg border border-line bg-white/60 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-accent">Step 1 — confirm your identity</p>
      <p className="mt-1 text-sm text-muted">
        This exam uses a pre-registered student list. Enter your {idLabel} exactly as registered, then confirm the matched record.
      </p>
      {!match ? (
        <>
          <div className="mt-3 grid gap-3 md:grid-cols-[1fr_auto]">
            <Field label={idLabel} value={value} onChange={onChange} />
            <button
              className="focus-ring mt-5 inline-flex h-10 items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
              onClick={onLookup}
              disabled={busy || !value.trim()}
            >
              <Search size={16} /> {busy ? "Checking…" : "Find me"}
            </button>
          </div>
          {error ? <div className="mt-3 rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{error}</div> : null}
        </>
      ) : (
        <div className="mt-3 rounded-lg border border-accent/30 bg-accent/5 p-4">
          <p className="text-sm font-semibold text-ink">Is this you?</p>
          <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm md:grid-cols-2">
            <div><dt className="inline text-muted">{idLabel}: </dt><dd className="inline font-medium">{match.unique_id}</dd></div>
            {match.name ? <div><dt className="inline text-muted">Name: </dt><dd className="inline font-medium">{match.name}</dd></div> : null}
            {match.roll_number && match.roll_number !== match.unique_id ? (
              <div><dt className="inline text-muted">Roll number: </dt><dd className="inline font-medium">{match.roll_number}</dd></div>
            ) : null}
            {match.email_masked ? <div><dt className="inline text-muted">Email: </dt><dd className="inline font-medium">{match.email_masked}</dd></div> : null}
            {match.hackerrank_username ? <div><dt className="inline text-muted">HackerRank: </dt><dd className="inline font-medium">{match.hackerrank_username}</dd></div> : null}
            {match.room ? <div><dt className="inline text-muted">Room: </dt><dd className="inline font-medium">{match.room}</dd></div> : null}
          </dl>
          <div className="mt-4 flex flex-wrap gap-3">
            <button className="focus-ring inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-sm font-medium text-white" onClick={onConfirm}>
              <UserCheck size={16} /> Yes, this is me
            </button>
            <button className="focus-ring inline-flex items-center gap-2 rounded-md border border-line px-4 py-2 text-sm font-medium" onClick={onReject}>
              No — search again
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// S2 — pre-fed room dropdown (+ "Other" free text). Falls back to the legacy
// free-text field when the admin has not configured any rooms.
function RoomField({ rooms, value, onChange }: { rooms: string[]; value: string; onChange: (value: string) => void }) {
  const [otherMode, setOtherMode] = useState(() => value !== "" && !rooms.includes(value));
  if (!rooms.length) {
    return <Field label="Room number" value={value} onChange={onChange} />;
  }
  return (
    <label className="block">
      <span className="text-xs font-medium uppercase tracking-wide text-muted">Room number</span>
      <select
        className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-3 text-sm"
        value={otherMode ? "__other__" : value}
        onChange={(event) => {
          if (event.target.value === "__other__") {
            setOtherMode(true);
            onChange("");
          } else {
            setOtherMode(false);
            onChange(event.target.value);
          }
        }}
      >
        <option value="">Select your room…</option>
        {rooms.map((room) => (
          <option key={room} value={room}>{room}</option>
        ))}
        <option value="__other__">Other…</option>
      </select>
      {otherMode ? (
        <input
          className="focus-ring mt-2 h-10 w-full rounded-md border border-line bg-white px-3 text-sm"
          placeholder="Type your room"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : null}
    </label>
  );
}

function StatusPill({ status }: { status: SessionStatus }) {
  const styles: Record<SessionStatus, string> = {
    idle: "border-line bg-white text-muted",
    starting: "border-warning/30 bg-warning/10 text-warning",
    recording: "border-accent/30 bg-accent/10 text-accent",
    ending: "border-warning/30 bg-warning/10 text-warning",
    ended: "border-accent/30 bg-accent/10 text-accent",
    error: "border-danger/30 bg-danger/10 text-danger"
  };
  return <span className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase ${styles[status]}`}>{status}</span>;
}

function CameraSelfView({ videoRef, mediaCapture, pipMessage, onPopOut, pipAvailable }: { videoRef: React.RefObject<HTMLVideoElement>; mediaCapture: MediaCaptureState; pipMessage: string; onPopOut: () => void; pipAvailable: boolean }) {
  return (
    <section className="rounded-lg border border-line bg-panel p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Camera size={18} />
          <h2 className="font-semibold">Camera self-view</h2>
        </div>
        <span className={`rounded-full border px-2 py-1 text-xs font-medium ${mediaCapture.camera === "recording" ? "border-accent/30 bg-accent/10 text-accent" : "border-warning/30 bg-warning/10 text-warning"}`}>{mediaCapture.camera}</span>
      </div>
      <div className="overflow-hidden rounded-md border border-line bg-ink">
        <video ref={videoRef} className="aspect-video w-full object-cover" autoPlay muted playsInline />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className="focus-ring inline-flex items-center gap-2 rounded-md border border-line px-3 py-2 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50" onClick={onPopOut} disabled={!pipAvailable}>
          <PictureInPicture2 size={14} /> Pop out
        </button>
        <span className="text-xs leading-5 text-muted">{pipMessage || (mediaCapture.camera === "unavailable" ? "No camera was detected. Screen recording continues." : "The camera preview stays here and can pop out over other tabs in supported browsers.")}</span>
      </div>
    </section>
  );
}

// Map the raw recorder status to plain candidate-facing language so the health
// panel reads "Recording" / "Not recording" rather than internal status strings.
function recordingStateLabel(status: SessionStatus): { label: string; recording: boolean } {
  if (status === "recording") return { label: "Recording", recording: true };
  if (status === "ending") return { label: "Finishing up…", recording: true };
  return { label: "Not recording", recording: false };
}

// startIp/currentIp moved here from the deleted TimerBar (S1): close-up
// diagnostics, not at-a-distance content. The ip-changed red treatment is
// superseded by the shell's anomaly flow (ip_address_changed vanishes the bar).
function HealthPanel({ status, sessionId, config, queueDepth, uploadedCount, manifest, mediaCapture, startIp, currentIp, ipChanged }: { status: SessionStatus; sessionId: string; config: SessionStartResponse | null; queueDepth: number; uploadedCount: number; manifest: UploadManifestItem[]; mediaCapture: MediaCaptureState; startIp: string; currentIp: string; ipChanged: boolean }) {
  const state = recordingStateLabel(status);
  return (
    <section className="rounded-lg border border-line bg-panel p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ShieldCheck size={18} />
          <h2 className="font-semibold">Recording health</h2>
        </div>
        <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${state.recording ? "border-accent/30 bg-accent/10 text-accent" : "border-warning/30 bg-warning/10 text-warning"}`}>
          {state.label}
        </span>
      </div>
      <div className="space-y-3 text-sm">
        <Metric icon={<CheckCircle2 size={16} />} label="State" value={state.label} />
        <Metric icon={<UploadCloud size={16} />} label="Uploaded chunks" value={`${uploadedCount}${queueDepth ? ` (${queueDepth} pending)` : ""}`} />
        <Metric icon={<MonitorUp size={16} />} label="Chunk interval" value={config ? `${config.upload_config.chunk_seconds}s` : "Not started"} />
        <Metric icon={<MonitorUp size={16} />} label="Screen" value={mediaCapture.screen} />
        <Metric icon={<Camera size={16} />} label="Camera" value={mediaCapture.camera} />
        <Metric icon={<Mic size={16} />} label="Microphone" value={mediaCapture.microphone} />
        <Metric icon={<ClipboardList size={16} />} label="Manifest items" value={String(manifest.length)} />
        <Metric icon={<Activity size={16} />} label="Start IP" value={startIp || "pending"} />
        <Metric icon={<Activity size={16} />} label="Current IP" value={`${currentIp || startIp || "pending"}${ipChanged ? " (changed)" : ""}`} />
      </div>
      {sessionId ? <p className="mt-4 break-all font-mono text-xs text-muted">{sessionId}</p> : null}
    </section>
  );
}

function IntegrityCheckpointPanel({ checkpoint, onConfirm }: { checkpoint: IntegrityCheckpoint; onConfirm: () => void }) {
  const [remaining, setRemaining] = useState(Math.max(0, checkpoint.expiresAt - Date.now()));

  useEffect(() => {
    const timer = window.setInterval(() => {
      setRemaining(Math.max(0, checkpoint.expiresAt - Date.now()));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [checkpoint.expiresAt]);

  return (
    <div className="mt-5 rounded-lg border border-warning/40 bg-warning/10 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-warning">Integrity checkpoint</p>
          <p className="mt-1 text-sm leading-6 text-ink">{checkpoint.message}</p>
          <p className="mt-1 text-xs text-muted">Missed checkpoints are logged as integrity anomalies. Time remaining: {Math.ceil(remaining / 1000)}s</p>
        </div>
        <button className="focus-ring inline-flex items-center gap-2 rounded-md bg-warning px-4 py-2 text-sm font-medium text-white" onClick={onConfirm}>
          <CheckCircle2 size={16} /> Confirm now
        </button>
      </div>
    </div>
  );
}

function EntryReviewPanel({ clipboardAudit, clipboardText, tabAudit, cookieAudit }: { clipboardAudit: string; clipboardText: string; tabAudit: string; cookieAudit: string }) {
  return (
    <section className="rounded-lg border border-line bg-panel p-5">
      <div className="mb-4 flex items-center gap-2">
        <ClipboardList size={18} />
        <h2 className="font-semibold">Entry review files</h2>
      </div>
      <div className="space-y-4 text-sm">
        <div>
          <p className="font-medium">Tabs</p>
          <p className="mt-1 leading-6 text-muted">{tabAudit}</p>
        </div>
        <div>
          <p className="font-medium">Clipboard</p>
          <p className="mt-1 leading-6 text-muted">{clipboardAudit}</p>
          {clipboardText ? (
            <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-white p-3 font-mono text-xs text-ink">{clipboardText}</pre>
          ) : null}
        </div>
        <div>
          <p className="flex items-center gap-2 font-medium"><Cookie size={15} /> Cookies and storage</p>
          <p className="mt-1 leading-6 text-muted">{cookieAudit}</p>
        </div>
      </div>
    </section>
  );
}

// Single source of truth for the test rules. The prominent PreStartRules block
// (pre-start) and the compact RulesPanel reminder (during recording) both read
// this so the rules never drift between the two surfaces. The TEXT lives in
// studentCopy.testRules (own-editor vs HackerRank variants, unit-tested); this
// zips it with one icon per rule, in the same fixed order. ownEditor is
// server-driven per session (S4: Boolean(sessionConfig?.problem)), so the
// rules are a function of it instead of a module constant.
const TEST_RULE_ICONS: React.ReactNode[] = [
  <MonitorUp size={18} />,   // Share your ENTIRE SCREEN
  <Video size={18} />,       // Keep recording running
  <Eye size={18} />,         // Stay on (HackerRank and) this tab
  <Copy size={18} />,        // No copy / paste or outside help
  <Camera size={18} />,      // Keep your camera visible
  <ClipboardCheck size={18} /> // End the test here when done
];
const testRulesWithIcons = (ownEditor: boolean): Array<{ icon: React.ReactNode; title: string; body: string }> =>
  studentCopy.testRules(ownEditor).map((rule, index) => ({ icon: TEST_RULE_ICONS[index], ...rule }));

// PROMINENT pre-start rules — the candidate reads this before the form. This is
// the headline of the page at the form stage, not a sidebar afterthought.
// hasProblem is always false pre-session today (the problem arrives with the
// start response), so this renders the legacy-variant rules; the prop keeps the
// wiring honest if a pre-session problem signal is ever added.
function PreStartRules({ hasProblem }: { hasProblem: boolean }) {
  const rules = testRulesWithIcons(hasProblem);
  return (
    <section className="mb-5 rounded-lg border border-warning/40 bg-warning/5 p-6 shadow-subtle">
      <div className="flex items-start gap-3">
        <AlertTriangle size={22} className="mt-0.5 shrink-0 text-warning" />
        <div>
          <h2 className="text-xl font-semibold text-ink">Read the rules before you start</h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            This session is proctored and recorded for a hiring assessment. Follow every rule below — violations are logged and reviewed before shortlisting.
          </p>
        </div>
      </div>
      <ol className="mt-5 grid gap-3 sm:grid-cols-2">
        {rules.map((rule, index) => (
          <li key={rule.title} className="flex gap-3 rounded-lg border border-line bg-panel p-4">
            <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink/5 text-accent">{rule.icon}</span>
            <div>
              <p className="text-sm font-semibold text-ink">
                <span className="mr-1.5 font-mono text-xs text-muted">{index + 1}.</span>
                {rule.title}
              </p>
              <p className="mt-1 text-sm leading-6 text-muted">{rule.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

// Compact rules reminder kept in the sidebar DURING recording so the candidate
// can re-check the rules at a glance without losing the live panels.
function RulesPanel({ hasProblem }: { hasProblem: boolean }) {
  const rules = testRulesWithIcons(hasProblem);
  return (
    <section className="rounded-lg border border-line bg-panel p-5">
      <div className="mb-4 flex items-center gap-2">
        <AlertTriangle size={18} />
        <h2 className="font-semibold">Rules reminder</h2>
      </div>
      <ul className="space-y-2.5 text-sm leading-6 text-muted">
        {rules.map((rule) => (
          <li key={rule.title} className="flex gap-2">
            <CheckCircle2 size={16} className="mt-1 shrink-0 text-accent" />
            <span><span className="font-medium text-ink">{rule.title}.</span> {rule.body}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// What the proctoring captures — shown in the form-stage sidebar so the candidate
// knows exactly what is recorded before they consent and start. Replaces the
// empty live panels (camera/health/evidence) that have nothing to show yet.
function WhatIsRecordedPanel({ hasProblem }: { hasProblem: boolean }) {
  const items: Array<{ icon: React.ReactNode; label: string; detail: string }> = [
    { icon: <MonitorUp size={16} />, label: "Your entire screen", detail: "Recorded continuously and uploaded in short segments throughout the test." },
    { icon: <Camera size={16} />, label: "Camera (if available)", detail: "A small self-view; keep your face visible. Skipped if no camera is present." },
    { icon: <Mic size={16} />, label: "Microphone (if available)", detail: "Audio is captured alongside the screen when a microphone is present." },
    { icon: <Copy size={16} />, label: "Clipboard & paste activity", detail: "Copy/cut/paste inside the session is part of the integrity record." },
    // Own-editor only: Slice 1 records every keystroke (full text + timing) in
    // the coding workspace. The HackerRank fallback has no own editor, so this
    // line is omitted there.
    ...(hasProblem
      ? [{ icon: <KeyRound size={16} />, label: "Editor keystrokes", detail: "Everything you type in the coding editor, including keystroke timing, is recorded." }]
      : []),
    { icon: <Activity size={16} />, label: "Focus & network signals", detail: "Tab switches, hidden states, refreshes, exits, and IP changes are logged." }
  ];
  return (
    <section className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
      <div className="mb-4 flex items-center gap-2">
        <ShieldCheck size={18} className="text-accent" />
        <h2 className="font-semibold">What is recorded</h2>
      </div>
      <ul className="space-y-3 text-sm">
        {items.map((item) => (
          <li key={item.label} className="flex gap-3">
            <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink/5 text-ink">{item.icon}</span>
            <div>
              <p className="font-medium text-ink">{item.label}</p>
              <p className="mt-0.5 leading-6 text-muted">{item.detail}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// PROMINENT, recoverable screen-share / start failure. Always offers an inline
// Try-again that re-invokes the share prompt — never a page reload. The headline
// makes the NOT-RECORDING state unmistakable.
function ScreenShareErrorPanel({ startError, busy, onRetry, onDismiss }: { startError: { kind: RecorderStartErrorKind; message: string }; busy: boolean; onRetry: () => void; onDismiss: () => void }) {
  const isInvalidSurface = startError.kind === "invalid_surface";
  const heading = isInvalidSurface
    ? "Recording has NOT started — share your entire screen"
    : startError.kind === "unsupported"
      ? "Recording has NOT started — unsupported browser"
      : "Recording has NOT started";
  return (
    <div className="mt-5 rounded-lg border-2 border-danger/50 bg-danger/5 p-5 shadow-subtle">
      <div className="flex items-start gap-3">
        <MailWarning size={22} className="mt-0.5 shrink-0 text-danger" />
        <div className="min-w-0">
          <p className="text-base font-semibold text-danger">{heading}</p>
          <p className="mt-1.5 text-sm leading-6 text-ink">{startError.message}</p>
          {isInvalidSurface ? (
            <p className="mt-2 text-xs leading-5 text-muted">
              Tip: in the share dialog, open the <span className="font-medium">Entire Screen</span> tab (not Window or Chrome Tab), pick your screen, then choose Share.
            </p>
          ) : null}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-3">
        <button
          className="focus-ring inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          onClick={onRetry}
          disabled={busy}
        >
          <MonitorUp size={16} /> {busy ? "Opening share…" : "Try again — share entire screen"}
        </button>
        <button
          className="focus-ring rounded-md border border-line px-4 py-2 text-sm font-medium text-muted hover:border-ink/40"
          onClick={onDismiss}
          disabled={busy}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

// Recording already stopped but the final end/manifest submit failed. Recoverable
// inline — re-send the end without reloading (a reload could orphan the session).
function EndRetryPanel({ error, busy, onRetry }: { error: string; busy: boolean; onRetry: () => void }) {
  return (
    <div className="mt-5 rounded-lg border-2 border-danger/50 bg-danger/5 p-5 shadow-subtle">
      <div className="flex items-start gap-3">
        <MailWarning size={22} className="mt-0.5 shrink-0 text-danger" />
        <div className="min-w-0">
          <p className="text-base font-semibold text-danger">Couldn't submit the end of your test</p>
          <p className="mt-1.5 text-sm leading-6 text-ink">
            Your recording has stopped and the segments are uploaded, but confirming the end of the session failed. Do not close this tab — press Retry to finish submitting.
          </p>
          {error ? <p className="mt-2 break-words text-xs leading-5 text-muted">{error}</p> : null}
        </div>
      </div>
      <div className="mt-4">
        <button
          className="focus-ring inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          onClick={onRetry}
          disabled={busy}
        >
          <RefreshCw size={16} className={busy ? "animate-spin" : undefined} /> {busy ? "Submitting…" : "Retry submitting"}
        </button>
      </div>
    </div>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line pb-2 last:border-0 last:pb-0">
      <span className="flex items-center gap-2 text-muted">{icon}{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function EventRow({ event }: { event: ProctorEvent }) {
  const message = typeof event.detail?.message === "string" ? event.detail.message : event.detail ? JSON.stringify(event.detail) : event.visibility_state;
  return (
    <div className="grid gap-2 rounded-md border border-line bg-white/60 p-3 text-sm md:grid-cols-[180px_180px_1fr]">
      <span className="font-mono text-xs text-muted">{new Date(event.timestamp).toLocaleTimeString()}</span>
      <span className="font-medium">{event.type}</span>
      <span className="truncate text-muted">{message}</span>
    </div>
  );
}
