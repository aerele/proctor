import { Activity, AlertTriangle, Archive, ArchiveRestore, Bell, Camera, CheckCircle2, ClipboardCheck, ClipboardList, Clock, Cookie, Copy, ExternalLink, Eye, Film, Lock, MailWarning, Mic, MonitorUp, PictureInPicture2, RefreshCw, Search, ShieldCheck, Square, UploadCloud, UserCheck, Users, Video } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { adminPassword, adminPasswordHash, alertAction, endSession, fetchAdminSessions, fetchAdminStats, fetchAlertSettings, fetchAlerts, fetchProctorSettings, resumeSession, saveAlertSettings, saveProctorSettings, sendEvents, sendSessionBeacon, sessionAction, sha256Hex, startSession, uploadReviewFile, validateEndSession } from "./api";
import { RecordingReview } from "./RecordingReview";
import { classifyStartError, createProctorRecorder, type MediaCaptureState, type RecorderStartErrorKind } from "./useProctorRecorder";
import type { AdminStats, Alert, AlertFilters, AlertSettings, AlertSeverity, AlertSource, ProctorAlertTypeConfig, ProctorEvent, ProctorSettings, ServerSessionStatus, SessionAction, SessionStartResponse, SessionStatus, StudentForm, UploadManifestItem } from "./types";

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
  consent_accepted: false
};

const integrityNotices = [
  "Your screen recording is being uploaded throughout the assessment for review.",
  "The shared screen is recorded directly so capture continues while this proctor tab is hidden.",
  "If a camera is available, keep your face visible in the self-view throughout the assessment.",
  "Clipboard snapshot and paste activity inside this session are part of the integrity record.",
  "Focus changes, hidden page states, refreshes, and exits are logged and may require explanation.",
  "Stopping screen sharing before submission is treated as a serious proctoring violation.",
  "HackerRank submissions may be checked for similarity, unusual structure, and copied code patterns.",
  "Shortlisted candidates must be ready to explain and modify their submitted code live.",
  "Suspicious username/session behavior may lead to manual verification before shortlisting.",
  "Upload gaps, missing recording chunks, and interrupted sessions are reviewed before results are accepted.",
  "Any unexplained proctoring anomaly can affect shortlisting even if the code passes all tests.",
  "Selection depends on score, originality, explanation, and clean proctoring evidence."
];

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
  const [endRequested, setEndRequested] = useState(false);
  // Recording already stopped but the final end/manifest submit failed — show an
  // inline "Retry submitting" instead of dead-ending in the error state.
  const [endFailed, setEndFailed] = useState(false);
  const [assuranceAccepted, setAssuranceAccepted] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [mediaCapture, setMediaCapture] = useState<MediaCaptureState>({ screen: "inactive", camera: "inactive", microphone: "inactive" });
  const [pipAvailable, setPipAvailable] = useState(false);
  const [pipMessage, setPipMessage] = useState("");
  const recorderRef = useRef<ReturnType<typeof createProctorRecorder> | null>(null);
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);

  const canStart = useMemo(() => {
    return Boolean(
      form.hackerrank_username.trim() &&
      form.name.trim() &&
      form.roll_number.trim() &&
      form.email.trim() &&
      form.room.trim() &&
      form.consent_accepted
    );
  }, [form]);

  const addEvent = (event: ProctorEvent) => {
    setEvents((current) => [event, ...current].slice(0, 16));
  };

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

  useEffect(() => {
    if (status !== "recording") return;
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
    await collectEntryReviewEvidence(session.session_id);

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
      const serverStatus = applyServerStatus(session);
      if (serverStatus !== "active") {
        // pending_approval / locked / ended — do not start the recorder.
        setStatus("idle");
        return;
      }
    } catch (cause) {
      // Registration/gate failure (time window, network, etc.) — generic error.
      setError(cause instanceof Error ? cause.message : String(cause));
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
      const serverStatus = applyServerStatus(session);
      if (serverStatus === "ended") {
        setStatus("ended");
        window.localStorage.removeItem(sessionStorageKey);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const collectEntryReviewEvidence = async (activeSessionId: string) => {
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
    setTabAudit("Tab/focus review active. Keep only HackerRank and this proctor session open; other activity may be visible in the shared-screen recording.");
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
      <Shell>
        <section className="mx-auto max-w-md rounded-lg border border-line bg-panel p-6 text-center shadow-subtle">
          <RefreshCw size={22} className="mx-auto animate-spin text-accent" />
          <p className="mt-3 text-sm text-muted">Restoring your proctoring session…</p>
        </section>
      </Shell>
    );
  }

  if (gate === "pending_approval") {
    return (
      <Shell>
        <StudentStepBanner gate={gate} status={status} />
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
      <Shell>
        <StudentStepBanner gate={gate} status={status} />
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
      <Shell>
        <StudentStepBanner gate="ended" status="ended" />
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
    <Shell>
      <StudentStepBanner gate={gate} status={status} />
      {status === "recording" || status === "ending" ? (
        <TimerBar status={status} elapsedSeconds={elapsedSeconds} startIp={startIp} currentIp={currentIp} ipChanged={ipChanged} />
      ) : null}
      {identity && !isFormStage ? <IdentityCard identity={identity} /> : null}

      {/* Pre-start: the rules are the headline, not a sidebar afterthought. The
          candidate reads exactly what is required and what is recorded before the
          form, so the rules are unmissable. */}
      {isFormStage ? <PreStartRules /> : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-accent">Aerele Proctor</p>
              <h1 className="mt-2 text-2xl font-semibold text-ink">
                {isFormStage ? "Register and start recording" : "HackerRank companion recording"}
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
                {isFormStage
                  ? "Enter your details below, then start proctoring before you open the contest. When you start, your browser will ask which screen to share — choose Entire Screen."
                  : "Keep this tab open. Open HackerRank with the Start test button and end the test here after you submit."}
              </p>
            </div>
            <StatusPill status={status} />
          </div>

          {isFormStage ? (
            <>
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Your details</p>
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="HackerRank username" value={form.hackerrank_username} onChange={(value) => setForm({ ...form, hackerrank_username: value })} />
                <Field label="Full name" value={form.name} onChange={(value) => setForm({ ...form, name: value })} />
                <Field label="Roll number" value={form.roll_number} onChange={(value) => setForm({ ...form, roll_number: value })} />
                <Field label="Email" type="email" value={form.email} onChange={(value) => setForm({ ...form, email: value })} />
                <Field label="Room number" value={form.room} onChange={(value) => setForm({ ...form, room: value })} />
              </div>

              <label className="mt-5 flex gap-3 rounded-lg border border-line bg-white/60 p-4 text-sm leading-6 text-muted">
                <input
                  className="mt-1 h-4 w-4 accent-accent"
                  type="checkbox"
                  checked={form.consent_accepted}
                  onChange={(event) => setForm({ ...form, consent_accepted: event.target.checked })}
                />
                <span>
                  I have read the rules above and consent to screen recording and, where available, camera and microphone recording for this hiring assessment. I understand that suspicious activity, stopped recording, copied code, or failed verification may lead to disqualification.
                </span>
              </label>
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
            {status === "recording" && mediaCapture.screen === "recording" && contestUrl && !error ? (
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
            <WhatIsRecordedPanel />
          ) : (
            <>
              <CameraSelfView videoRef={cameraVideoRef} mediaCapture={mediaCapture} pipMessage={pipMessage} onPopOut={requestCameraPictureInPicture} pipAvailable={pipAvailable} />
              <HealthPanel status={status} sessionId={sessionId} config={sessionConfig} queueDepth={queueDepth} uploadedCount={uploadedCount} manifest={manifest} mediaCapture={mediaCapture} />
              <EntryReviewPanel clipboardAudit={clipboardAudit} clipboardText={clipboardText} tabAudit={tabAudit} cookieAudit={cookieAudit} />
              <RulesPanel />
            </>
          )}
        </aside>
      </div>

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

// Guided step indicator (Epic 3): always shows the student where they are and
// what the next action is, so they do not need to ask a proctor.
function StudentStepBanner({ gate, status }: { gate: StudentGate; status: SessionStatus }) {
  const steps = [
    { key: "details", label: "Enter details" },
    { key: "record", label: "Record + take test" },
    { key: "end", label: "End test" }
  ];
  let activeIndex = 0;
  let hint = "Fill in your details and consent, then start proctoring.";
  if (status === "recording" || status === "ending") {
    activeIndex = 1;
    hint = "Recording is active. Open HackerRank with the Start test button and keep this tab running. End the test here when you submit.";
  } else if (gate === "running") {
    activeIndex = 1;
    hint = "Your session was restored. Press Resume recording to share your screen again and continue.";
  } else if (gate === "pending_approval") {
    activeIndex = 1;
    hint = "Waiting for a proctor to approve this device. Stay on this page.";
  } else if (gate === "locked") {
    activeIndex = 1;
    hint = "Your session is locked. Call a proctor to unlock you.";
  } else if (gate === "ended" || status === "ended") {
    activeIndex = 2;
    hint = "Your test is complete. You may close this tab.";
  }

  return (
    <section className="mb-5 rounded-lg border border-line bg-panel p-4 shadow-subtle">
      <div className="flex flex-wrap items-center gap-2">
        {steps.map((step, index) => (
          <div key={step.key} className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold ${
                index < activeIndex
                  ? "border-accent/30 bg-accent/10 text-accent"
                  : index === activeIndex
                    ? "border-ink bg-ink text-white"
                    : "border-line bg-white text-muted"
              }`}
            >
              <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-white/20 text-[10px]">{index + 1}</span>
              {step.label}
            </span>
            {index < steps.length - 1 ? <span className="text-muted">›</span> : null}
          </div>
        ))}
      </div>
      <p className="mt-3 text-sm leading-6 text-muted">{hint}</p>
    </section>
  );
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

function TimerBar({ status, elapsedSeconds, startIp, currentIp, ipChanged }: { status: SessionStatus; elapsedSeconds: number; startIp: string; currentIp: string; ipChanged: boolean }) {
  return (
    <div className={`sticky top-0 z-10 mb-5 rounded-lg border px-4 py-3 text-white shadow-subtle ${ipChanged ? "border-danger/40 bg-danger" : "border-ink/10 bg-ink"}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <span className="text-sm font-semibold">Proctoring active</span>
          <div className="mt-1 flex flex-wrap gap-2 text-xs text-white/80">
            <span>Start IP: <span className="font-mono text-white">{startIp || "pending"}</span></span>
            <span>Current IP: <span className="font-mono text-white">{currentIp || startIp || "pending"}</span></span>
          </div>
        </div>
        <span className="font-mono text-lg font-semibold">{formatElapsed(elapsedSeconds)}</span>
        <span className="rounded-full border border-white/20 px-3 py-1 text-xs uppercase">{ipChanged ? "ip changed" : status}</span>
      </div>
    </div>
  );
}

function EndTestPanel({ assuranceAccepted, onAssuranceChange, onCancel, onEnd }: { assuranceAccepted: boolean; onAssuranceChange: (value: boolean) => void; onCancel: () => void; onEnd: () => void }) {
  return (
    <div className="mt-5 rounded-lg border border-danger/30 bg-danger/10 p-4">
      <p className="text-sm font-semibold text-danger">End test confirmation</p>
      <p className="mt-1 text-sm leading-6 text-ink">End the proctoring session only after submitting HackerRank. Closing the tab before this step is logged as an incomplete session. No code is needed — just confirm the assurance below.</p>
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

type AdminView = "stats" | "alerts" | "review" | "recordings" | "settings";

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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [actionMessage, setActionMessage] = useState("");
  const [alertSettings, setAlertSettings] = useState<AlertSettings | null>(null);
  const [alertSettingsLoading, setAlertSettingsLoading] = useState(false);
  const [alertSettingsMessage, setAlertSettingsMessage] = useState("");

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
      if (response.rooms) setRooms(response.rooms);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStatsLoading(false);
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
        const response = await fetchAlerts(password, alertFilters);
        if (cancelled) return;
        const sorted = [...response.alerts].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
        setAlerts(sorted);
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
          if (response.rooms) setRooms(response.rooms);
        } else {
          const response = await fetchAlerts(password, alertFilters);
          if (cancelled) return;
          const sorted = [...response.alerts].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
          setAlerts(sorted);
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
        updated_at: response.updated_at
      });
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
        contest_url: settings.contest_url
      });
      setSettings({
        start_at: isoToLocalInput(response.start_at),
        end_at: isoToLocalInput(response.end_at),
        contest_url: response.contest_url || "",
        updated_at: response.updated_at
      });
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
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // ARCHIVE a single alert (or a set of ids) then refresh the alerts list so the
  // change is visible immediately. In demo mode the api mutates the demo store, so
  // the reload reflects the archive flag.
  const archiveAlerts = async (ids: string[], action: "archive" | "unarchive" = "archive") => {
    if (!ids.length) return;
    setError("");
    setActionMessage("");
    try {
      const response = await alertAction(password, { action, ids });
      setActionMessage(`${action === "archive" ? "Archived" : "Unarchived"} ${response.updated.length} alert(s)${response.missing.length ? ` (${response.missing.length} missing)` : ""}.`);
      await loadAlerts();
      setSelected(new Set());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  // APPROVE-then-ARCHIVE: the Approve button on an alert row both approves the
  // session (session-action) AND archives that alert (alert-action), orchestrated
  // here on the frontend. runAction already refreshes stats/alerts afterward.
  const approveAndArchive = async (alert: Alert) => {
    setError("");
    setActionMessage("");
    try {
      await sessionAction(password, {
        action: "approve",
        ...(alert.session_id ? { session_id: alert.session_id } : { usernames: [alert.hackerrank_username] }),
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
          <Field label="Admin password" type="password" value={passwordInput} onChange={setPasswordInput} />
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
        <AdminTab active={view === "review"} onClick={() => setView("review")} icon={<Search size={16} />} label="Review" />
        <AdminTab active={view === "recordings"} onClick={() => setView("recordings")} icon={<Film size={16} />} label="Recordings" />
        <AdminTab active={view === "settings"} onClick={() => setView("settings")} icon={<Lock size={16} />} label="Settings" />
      </nav>

      {error ? <div className="mb-5 rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger">{error}</div> : null}
      {actionMessage ? <div className="mb-5 rounded-lg border border-accent/30 bg-accent/10 p-4 text-sm text-accent">{actionMessage}</div> : null}

      {view === "stats" ? (
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
        />
      ) : null}

      {view === "alerts" ? (
        <AlertsConsole
          alerts={alerts}
          loading={alertsLoading}
          loaded={alertsLoaded}
          filters={alertFilters}
          rooms={rooms}
          selected={selected}
          onToggleSelected={toggleSelected}
          onFiltersChange={(next) => {
            setAlertFilters(next);
            void loadAlerts(next);
          }}
          onRefresh={() => loadAlerts()}
          onAction={runAction}
          onArchive={(ids, action) => void archiveAlerts(ids, action)}
          onApproveArchive={(alert) => void approveAndArchive(alert)}
        />
      ) : null}

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

      {view === "recordings" ? <RecordingReview password={password} /> : null}
    </Shell>
  );
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

function StatsDashboard({ stats, loading, onRefresh, rooms, room, onRoomChange }: { stats: AdminStats | null; loading: boolean; onRefresh: () => void; rooms: string[]; room: string; onRoomChange: (room: string) => void }) {
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
          <StatCard label="Live" value={stats.live} tone="accent" icon={<MonitorUp size={18} />} />
          <StatCard label="Disconnected" value={stats.disconnected ?? 0} tone="danger" icon={<Activity size={18} />} />
          <StatCard label="Locked" value={stats.locked} tone="danger" icon={<Lock size={18} />} />
          <StatCard label="Pending approval" value={stats.pending_approval} tone="warning" icon={<Clock size={18} />} />
          <StatCard label="Finished" value={stats.finished} tone="muted" icon={<CheckCircle2 size={18} />} />
          <StatCard label="Total" value={stats.total} tone="ink" icon={<Users size={18} />} />
          <StatCard label="Not started / total" value={stats.not_started_or_total ?? stats.total} tone="muted" icon={<Users size={18} />} />
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

function StatCard({ label, value, tone, icon }: { label: string; value: number; tone: "accent" | "danger" | "warning" | "muted" | "ink"; icon: React.ReactNode }) {
  const toneStyles: Record<typeof tone, string> = {
    accent: "border-accent/30 bg-accent/5 text-accent",
    danger: "border-danger/30 bg-danger/5 text-danger",
    warning: "border-warning/40 bg-warning/5 text-warning",
    muted: "border-line bg-white text-muted",
    ink: "border-ink/20 bg-ink/5 text-ink"
  };
  return (
    <div className={`rounded-lg border p-5 shadow-subtle ${toneStyles[tone]}`}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide">{label}</span>
        {icon}
      </div>
      <p className="mt-3 text-3xl font-semibold text-ink">{value}</p>
    </div>
  );
}

const ACTION_LABELS: Array<{ action: SessionAction; label: string; destructive: boolean }> = [
  { action: "approve", label: "Approve", destructive: false },
  { action: "unlock", label: "Unlock", destructive: false },
  { action: "lock", label: "Lock", destructive: true },
  { action: "bypass", label: "Bypass", destructive: false },
  { action: "end", label: "End", destructive: true }
];

// Compact per-candidate remote-action buttons. Destructive actions confirm first.
function ActionButtons({ onAction, sessionId, username, actions = ACTION_LABELS }: { onAction: (action: SessionAction, opts: { sessionId?: string; usernames?: string[] }) => void; sessionId?: string; username?: string; actions?: typeof ACTION_LABELS }) {
  const run = (action: SessionAction, destructive: boolean) => {
    if (destructive) {
      const target = sessionId ? `session ${sessionId.slice(0, 8)}…` : `${username}`;
      if (!window.confirm(`Apply "${action}" to ${target}? This affects the live session.`)) return;
    }
    onAction(action, sessionId ? { sessionId } : username ? { usernames: [username] } : {});
  };
  return (
    <div className="flex flex-wrap gap-2">
      {actions.map((item) => (
        <button
          key={item.action}
          type="button"
          onClick={() => run(item.action, item.destructive)}
          className={`focus-ring rounded-md border px-2.5 py-1.5 text-xs font-medium ${item.destructive ? "border-danger/40 text-danger hover:bg-danger/10" : "border-line text-ink hover:border-ink/40"}`}
        >
          {item.label}
        </button>
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

function AlertsConsole({ alerts, loading, loaded, filters, rooms, selected, onToggleSelected, onFiltersChange, onRefresh, onAction, onArchive, onApproveArchive }: {
  alerts: Alert[];
  loading: boolean;
  loaded: boolean;
  filters: AlertFilters;
  rooms: string[];
  selected: Set<string>;
  onToggleSelected: (key: string) => void;
  onFiltersChange: (filters: AlertFilters) => void;
  onRefresh: () => void;
  onAction: (action: SessionAction, opts: { sessionId?: string; usernames?: string[] }) => void;
  onArchive: (ids: string[], action?: "archive" | "unarchive") => void;
  onApproveArchive: (alert: Alert) => void;
}) {
  // Unique candidate usernames in the current (selected) alert set, for bulk actions.
  const selectedUsernames = useMemo(() => {
    const usernames = new Set<string>();
    for (const alert of alerts) {
      if (selected.has(alert.id)) usernames.add(alert.hackerrank_username);
    }
    return [...usernames];
  }, [alerts, selected]);

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
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">Contest slug</span>
            <input
              className="focus-ring mt-1 h-10 w-48 rounded-md border border-line bg-white px-3 text-sm"
              value={filters.contest_slug ?? ""}
              placeholder="all contests"
              onChange={(event) => onFiltersChange({ ...filters, contest_slug: event.target.value || undefined })}
            />
          </label>
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

        {selectedUsernames.length ? (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-md border border-ink/20 bg-ink/5 p-3">
            <span className="text-sm font-medium">{selectedUsernames.length} candidate(s) selected:</span>
            <span className="font-mono text-xs text-muted">{selectedUsernames.join(", ")}</span>
            <BulkActionButtons usernames={selectedUsernames} onAction={onAction} />
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
function BulkActionButtons({ usernames, onAction }: { usernames: string[]; onAction: (action: SessionAction, opts: { usernames?: string[] }) => void }) {
  const run = (action: SessionAction, destructive: boolean) => {
    if (destructive && !window.confirm(`Apply "${action}" to ${usernames.length} candidate(s)? This affects their live sessions.`)) return;
    onAction(action, { usernames });
  };
  return (
    <div className="flex flex-wrap gap-2">
      {ACTION_LABELS.map((item) => (
        <button
          key={item.action}
          type="button"
          onClick={() => run(item.action, item.destructive)}
          className={`focus-ring rounded-md border px-2.5 py-1.5 text-xs font-medium ${item.destructive ? "border-danger/40 text-danger hover:bg-danger/10" : "border-line text-ink hover:border-ink/40"}`}
        >
          Bulk {item.label}
        </button>
      ))}
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

// Session actions shown on an alert row EXCLUDING approve — approve is handled
// by the dedicated Approve button below, which also archives the alert.
const ALERT_ROW_ACTIONS = ACTION_LABELS.filter((item) => item.action !== "approve");

function AlertRow({ alert, selected, onToggleSelected, onAction, onArchive, onApproveArchive }: { alert: Alert; selected: boolean; onToggleSelected: () => void; onAction: (action: SessionAction, opts: { sessionId?: string; usernames?: string[] }) => void; onArchive: (ids: string[], action?: "archive" | "unarchive") => void; onApproveArchive: (alert: Alert) => void }) {
  const [expanded, setExpanded] = useState(false);
  const hasData = alert.data && Object.keys(alert.data).length > 0;
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
        <div className="flex flex-wrap items-center gap-2">
          {/* Approve also archives this alert (frontend orchestrates approve → archive). */}
          <button
            type="button"
            onClick={() => onApproveArchive(alert)}
            className="focus-ring rounded-md border border-line px-2.5 py-1.5 text-xs font-medium text-ink hover:border-ink/40"
          >
            Approve
          </button>
          {alert.archived ? (
            <button
              type="button"
              onClick={() => onArchive([alert.id], "unarchive")}
              className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs font-medium text-ink hover:border-ink/40"
            >
              <ArchiveRestore size={14} /> Unarchive
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onArchive([alert.id], "archive")}
              className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs font-medium text-ink hover:border-ink/40"
            >
              <Archive size={14} /> Archive
            </button>
          )}
          <ActionButtons onAction={onAction} username={alert.hackerrank_username} sessionId={alert.session_id} actions={ALERT_ROW_ACTIONS} />
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

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-paper px-4 py-5 text-ink md:px-8">
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

function formatElapsed(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

function Field({ label, value, onChange, type = "text", disabled = false }: { label: string; value: string; onChange: (value: string) => void; type?: string; disabled?: boolean }) {
  return (
    <label className="block">
      <span className="text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
      <input className="focus-ring mt-1 h-10 w-full rounded-md border border-line bg-white px-3 text-sm disabled:bg-neutral-100" type={type} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
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

function HealthPanel({ status, sessionId, config, queueDepth, uploadedCount, manifest, mediaCapture }: { status: SessionStatus; sessionId: string; config: SessionStartResponse | null; queueDepth: number; uploadedCount: number; manifest: UploadManifestItem[]; mediaCapture: MediaCaptureState }) {
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
// this so the rules never drift between the two surfaces.
const TEST_RULES: Array<{ icon: React.ReactNode; title: string; body: string }> = [
  {
    icon: <MonitorUp size={18} />,
    title: "Share your ENTIRE SCREEN",
    body: "When prompted, choose Entire Screen — not a tab, window, or browser. Tab/window sharing is rejected and recording will not start."
  },
  {
    icon: <Video size={18} />,
    title: "Keep recording running",
    body: "Screen recording is mandatory and continues even when this tab is hidden. Do not stop sharing until you have fully submitted on HackerRank."
  },
  {
    icon: <Eye size={18} />,
    title: "Stay on HackerRank and this tab",
    body: "Don't switch to other tabs, apps, or windows. Focus changes, hidden states, and exits are logged and may need explanation."
  },
  {
    icon: <Copy size={18} />,
    title: "No copy / paste or outside help",
    body: "Clipboard and paste activity is recorded. Copied code, AI-assisted answers, search engines, or another person can lead to disqualification."
  },
  {
    icon: <Camera size={18} />,
    title: "Keep your camera visible",
    body: "If a camera is available, keep the self-view (or its pop-out) visible while you work in HackerRank. Microphone is captured when available."
  },
  {
    icon: <ClipboardCheck size={18} />,
    title: "End the test here when done",
    body: "After you submit on HackerRank, return and press End test. Closing the tab early is logged as an incomplete session."
  }
];

// PROMINENT pre-start rules — the candidate reads this before the form. This is
// the headline of the page at the form stage, not a sidebar afterthought.
function PreStartRules() {
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
        {TEST_RULES.map((rule, index) => (
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
function RulesPanel() {
  return (
    <section className="rounded-lg border border-line bg-panel p-5">
      <div className="mb-4 flex items-center gap-2">
        <AlertTriangle size={18} />
        <h2 className="font-semibold">Rules reminder</h2>
      </div>
      <ul className="space-y-2.5 text-sm leading-6 text-muted">
        {TEST_RULES.map((rule) => (
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
function WhatIsRecordedPanel() {
  const items: Array<{ icon: React.ReactNode; label: string; detail: string }> = [
    { icon: <MonitorUp size={16} />, label: "Your entire screen", detail: "Recorded continuously and uploaded in short segments throughout the test." },
    { icon: <Camera size={16} />, label: "Camera (if available)", detail: "A small self-view; keep your face visible. Skipped if no camera is present." },
    { icon: <Mic size={16} />, label: "Microphone (if available)", detail: "Audio is captured alongside the screen when a microphone is present." },
    { icon: <Copy size={16} />, label: "Clipboard & paste activity", detail: "Copy/cut/paste inside the session is part of the integrity record." },
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
