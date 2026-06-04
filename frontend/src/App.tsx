import { AlertTriangle, Bell, Camera, CheckCircle2, ClipboardList, Cookie, ExternalLink, Lock, Mic, MonitorUp, PictureInPicture2, RefreshCw, Search, ShieldCheck, Square, UploadCloud, Video } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { adminPassword, endSession, fetchAdminSessions, fetchAlerts, fetchProctorSettings, saveProctorSettings, sendEvents, startSession, uploadReviewFile, validateEndSession } from "./api";
import { createProctorRecorder, type MediaCaptureState } from "./useProctorRecorder";
import type { Alert, AlertSeverity, ProctorEvent, ProctorSettings, SessionStartResponse, SessionStatus, StudentForm, UploadManifestItem } from "./types";

const initialForm: StudentForm = {
  hackerrank_username: "",
  name: "",
  roll_number: "",
  email: "",
  proctor_passcode: "",
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

function StudentApp() {
  const [form, setForm] = useState<StudentForm>(initialForm);
  const [status, setStatus] = useState<SessionStatus>("idle");
  const [sessionId, setSessionId] = useState("");
  const [sessionConfig, setSessionConfig] = useState<SessionStartResponse | null>(null);
  const [contestUrl, setContestUrl] = useState("");
  const [startIp, setStartIp] = useState("");
  const [currentIp, setCurrentIp] = useState("");
  const [ipChanged, setIpChanged] = useState(false);
  const [events, setEvents] = useState<ProctorEvent[]>([]);
  const [queueDepth, setQueueDepth] = useState(0);
  const [uploadedCount, setUploadedCount] = useState(0);
  const [error, setError] = useState("");
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
  const [endCode, setEndCode] = useState("");
  const [assuranceAccepted, setAssuranceAccepted] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [mediaCapture, setMediaCapture] = useState<MediaCaptureState>({ screen: "inactive", camera: "inactive", microphone: "inactive" });
  const [pipAvailable, setPipAvailable] = useState(false);
  const [pipMessage, setPipMessage] = useState("");
  const recorderRef = useRef<ReturnType<typeof createProctorRecorder> | null>(null);
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);

  const canStart = useMemo(() => {
    return form.hackerrank_username.trim() && form.name.trim() && form.roll_number.trim() && form.email.trim() && form.proctor_passcode.trim() && form.consent_accepted;
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (status !== "recording" && status !== "ending") return;
      const key = event.key.toLowerCase();
      const isReloadShortcut = key === "f5" || ((event.metaKey || event.ctrlKey) && key === "r");
      if (!isReloadShortcut) return;

      event.preventDefault();
      event.stopPropagation();
      const message = "Reload is blocked during proctoring. Use End test with the proctoring end code before closing or refreshing.";
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

  const start = async () => {
    setError("");
    setStatus("starting");
    try {
      const session = await startSession({
        ...form,
        hackerrank_username: form.hackerrank_username.trim(),
        name: form.name.trim(),
        roll_number: form.roll_number.trim(),
        email: form.email.trim(),
        proctor_passcode: form.proctor_passcode.trim()
      });
      setSessionId(session.session_id);
      setSessionConfig(session);
      setContestUrl(session.contest_url || "");
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
          setError(message);
          setStatus("error");
          if (message.includes("Screen sharing stopped")) {
            speakWarning("Screen sharing stopped. Return to the proctor app immediately.");
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
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      if (message.toLowerCase().includes("end code")) {
        setStatus("recording");
        setEndRequested(true);
        return;
      }
      setStatus("recording");
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
    if (!endCode.trim()) {
      setError("Enter the proctoring end code before ending the test.");
      return;
    }
    setStatus("ending");
    setError("");
    let recorderStopped = false;
    try {
      if (sessionId) {
        await validateEndSession({
          sessionId,
          endCode: endCode.trim(),
          assuranceAccepted
        });
      }
      const finalManifest = await recorderRef.current?.stop();
      recorderStopped = true;
      const uploads = finalManifest ?? [];
      setManifest(uploads);
      if (sessionId) {
        await endSession({
          sessionId,
          manifest: uploads,
          endCode: endCode.trim(),
          assuranceAccepted
        });
      }
      setStatus("ended");
      setEndRequested(false);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      if (!recorderStopped && message.toLowerCase().includes("end code")) {
        setStatus("recording");
        setEndRequested(true);
        return;
      }
      setStatus(recorderStopped ? "error" : "recording");
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

  return (
    <Shell>
      {status === "recording" || status === "ending" || status === "ended" ? (
        <TimerBar status={status} elapsedSeconds={elapsedSeconds} startIp={startIp} currentIp={currentIp} ipChanged={ipChanged} />
      ) : null}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-accent">Aerele Proctor</p>
              <h1 className="mt-2 text-2xl font-semibold text-ink">HackerRank companion recording</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
                Start this before opening the contest. Select Entire Screen only. Any interruption, hidden activity, or unexplained anomaly may be reviewed before shortlisting.
              </p>
            </div>
            <StatusPill status={status} />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Proctoring passcode" type="password" value={form.proctor_passcode} onChange={(value) => setForm({ ...form, proctor_passcode: value })} disabled={status !== "idle"} />
            <Field label="HackerRank username" value={form.hackerrank_username} onChange={(value) => setForm({ ...form, hackerrank_username: value })} disabled={status !== "idle"} />
            <Field label="Full name" value={form.name} onChange={(value) => setForm({ ...form, name: value })} disabled={status !== "idle"} />
            <Field label="Roll number" value={form.roll_number} onChange={(value) => setForm({ ...form, roll_number: value })} disabled={status !== "idle"} />
            <Field label="Email" type="email" value={form.email} onChange={(value) => setForm({ ...form, email: value })} disabled={status !== "idle"} />
          </div>

          <label className="mt-5 flex gap-3 rounded-lg border border-line bg-white/60 p-4 text-sm leading-6 text-muted">
            <input
              className="mt-1 h-4 w-4 accent-accent"
              type="checkbox"
              checked={form.consent_accepted}
              disabled={status !== "idle"}
              onChange={(event) => setForm({ ...form, consent_accepted: event.target.checked })}
            />
            <span>
              I consent to screen recording and, where available, camera and microphone recording for this hiring assessment. I understand that suspicious activity, stopped recording, copied code, or failed verification may lead to disqualification.
            </span>
          </label>

          {error ? (
            <div className="mt-5 rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
              {error}
            </div>
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
            {status === "idle" || status === "error" ? (
              <button className="focus-ring inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50" disabled={!canStart} onClick={start}>
                <MonitorUp size={16} /> Start proctoring
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
              endCode={endCode}
              assuranceAccepted={assuranceAccepted}
              onEndCodeChange={setEndCode}
              onAssuranceChange={setAssuranceAccepted}
              onCancel={() => setEndRequested(false)}
              onEnd={stop}
            />
          ) : null}
        </section>

        <aside className="space-y-5">
          <CameraSelfView videoRef={cameraVideoRef} mediaCapture={mediaCapture} pipMessage={pipMessage} onPopOut={requestCameraPictureInPicture} pipAvailable={pipAvailable} />
          <HealthPanel status={status} sessionId={sessionId} config={sessionConfig} queueDepth={queueDepth} uploadedCount={uploadedCount} manifest={manifest} mediaCapture={mediaCapture} />
          <EntryReviewPanel clipboardAudit={clipboardAudit} clipboardText={clipboardText} tabAudit={tabAudit} cookieAudit={cookieAudit} />
          <RulesPanel />
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

function EndTestPanel({ endCode, assuranceAccepted, onEndCodeChange, onAssuranceChange, onCancel, onEnd }: { endCode: string; assuranceAccepted: boolean; onEndCodeChange: (value: string) => void; onAssuranceChange: (value: boolean) => void; onCancel: () => void; onEnd: () => void }) {
  return (
    <div className="mt-5 rounded-lg border border-danger/30 bg-danger/10 p-4">
      <p className="text-sm font-semibold text-danger">End test confirmation</p>
      <p className="mt-1 text-sm leading-6 text-ink">End the proctoring session only after submitting HackerRank. Closing the tab before this step is logged as an incomplete session.</p>
      <label className="mt-4 flex gap-3 rounded-md border border-line bg-white/70 p-3 text-sm leading-6 text-muted">
        <input className="mt-1 h-4 w-4 accent-danger" type="checkbox" checked={assuranceAccepted} onChange={(event) => onAssuranceChange(event.target.checked)} />
        <span>I assure that I worked independently, did not copy, did not use AI/external help, and submitted only my own solution.</span>
      </label>
      <div className="mt-4 max-w-sm">
        <Field label="Proctoring end code" type="password" value={endCode} onChange={onEndCodeChange} />
      </div>
      <div className="mt-4 flex flex-wrap gap-3">
        <button className="focus-ring inline-flex items-center gap-2 rounded-md bg-danger px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50" disabled={!assuranceAccepted || !endCode.trim()} onClick={onEnd}>
          <Square size={16} /> End and close session
        </button>
        <button className="focus-ring rounded-md border border-line px-4 py-2 text-sm font-medium" onClick={onCancel}>
          Continue test
        </button>
      </div>
    </div>
  );
}

type AdminView = "alerts" | "review" | "settings";

function AdminApp() {
  const [view, setView] = useState<AdminView>("alerts");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [settings, setSettings] = useState<ProctorSettings>({ start_at: "", end_at: "", passcode: "", end_code: "" });
  const [settingsMessage, setSettingsMessage] = useState("");
  const [result, setResult] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [alertsLoading, setAlertsLoading] = useState(false);
  const [alertsLoaded, setAlertsLoaded] = useState(false);

  const loadAlerts = async () => {
    setAlertsLoading(true);
    setError("");
    try {
      const response = await fetchAlerts(password);
      const sorted = [...response.alerts].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
      setAlerts(sorted);
      setAlertsLoaded(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAlertsLoading(false);
    }
  };

  // Auto-load alerts the first time the unlocked admin opens the alerts tab.
  // Subsequent refreshes are manual via the Refresh button.
  useEffect(() => {
    if (!unlocked || view !== "alerts" || alertsLoaded || alertsLoading) return;
    let cancelled = false;
    void (async () => {
      setAlertsLoading(true);
      setError("");
      try {
        const response = await fetchAlerts(password);
        if (cancelled) return;
        const sorted = [...response.alerts].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
        setAlerts(sorted);
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
  }, [unlocked, view, alertsLoaded, alertsLoading, password]);

  const unlockAdmin = () => {
    setError("");
    if (passwordInput !== adminPassword) {
      setError("Invalid admin password.");
      return;
    }
    setPassword(passwordInput);
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
        passcode: "",
        end_code: "",
        passcode_set: response.passcode_set,
        passcode_preview: response.passcode_preview,
        end_code_set: response.end_code_set,
        end_code_preview: response.end_code_preview,
        updated_at: response.updated_at
      });
      setSettingsMessage(response.passcode_set ? `Current passcode: ${response.passcode_preview}; end code: ${response.end_code_preview || "not set"}` : "No passcode set yet.");
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
        passcode: settings.passcode,
        end_code: settings.end_code
      });
      setSettings({
        start_at: isoToLocalInput(response.start_at),
        end_at: isoToLocalInput(response.end_at),
        contest_url: response.contest_url || "",
        passcode: "",
        end_code: "",
        passcode_set: response.passcode_set,
        passcode_preview: response.passcode_preview,
        end_code_set: response.end_code_set,
        end_code_preview: response.end_code_preview,
        updated_at: response.updated_at
      });
      setSettingsMessage(`Saved. Current passcode: ${response.passcode_preview}; end code: ${response.end_code_preview}`);
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
        <AdminTab active={view === "alerts"} onClick={() => setView("alerts")} icon={<Bell size={16} />} label="Live alerts" badge={alerts.length} />
        <AdminTab active={view === "review"} onClick={() => setView("review")} icon={<Search size={16} />} label="Review" />
        <AdminTab active={view === "settings"} onClick={() => setView("settings")} icon={<Lock size={16} />} label="Settings" />
      </nav>

      {error ? <div className="mb-5 rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger">{error}</div> : null}

      {view === "alerts" ? (
        <AlertsConsole alerts={alerts} loading={alertsLoading} loaded={alertsLoaded} onRefresh={loadAlerts} />
      ) : null}

      {view === "settings" ? (
      <section className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
        <div className="mb-5 flex items-center gap-3">
          <Lock size={20} />
          <div>
            <h1 className="text-2xl font-semibold">Proctoring gate</h1>
            <p className="mt-1 text-sm text-muted">Set the allowed window and passcode. Student sessions cannot start outside this gate.</p>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-[1fr_1fr_1fr]">
          <Field label="Start time" type="datetime-local" value={settings.start_at} onChange={(value) => setSettings({ ...settings, start_at: value })} />
          <Field label="End time" type="datetime-local" value={settings.end_at} onChange={(value) => setSettings({ ...settings, end_at: value })} />
          <Field label="Contest URL" type="url" value={settings.contest_url ?? ""} onChange={(value) => setSettings({ ...settings, contest_url: value })} />
          <Field label={settings.passcode_set ? "New passcode (optional)" : "Proctoring passcode"} type="password" value={settings.passcode ?? ""} onChange={(value) => setSettings({ ...settings, passcode: value })} />
          <Field label={settings.end_code_set ? "New end code (optional)" : "Proctoring end code"} type="password" value={settings.end_code ?? ""} onChange={(value) => setSettings({ ...settings, end_code: value })} />
          <div className="mt-6 flex flex-wrap gap-3 md:col-span-2">
            <button className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md border border-line px-4 text-sm font-medium" onClick={loadSettings} disabled={settingsLoading}>
              Load current
            </button>
            <button className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white" onClick={saveSettings} disabled={settingsLoading || !settings.start_at || !settings.end_at || (!settings.passcode_set && !settings.passcode) || (!settings.end_code_set && !settings.end_code)}>
              Save gate
            </button>
          </div>
        </div>
        {settingsMessage ? <div className="mt-4 rounded-lg border border-accent/30 bg-accent/10 p-4 text-sm text-accent">{settingsMessage}</div> : null}
        {settings.updated_at ? <p className="mt-3 text-xs text-muted">Last updated: {new Date(settings.updated_at).toLocaleString()}</p> : null}
      </section>
      ) : null}

      {view === "review" ? (
      <>
      <section className="rounded-lg border border-line bg-panel p-5 shadow-subtle">
        <div className="mb-5 flex items-center gap-3">
          <Search size={20} />
          <div>
            <h1 className="text-2xl font-semibold">Review dashboard</h1>
            <p className="mt-1 text-sm text-muted">Search by HackerRank username to inspect sessions, events, and uploaded evidence.</p>
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
          <div key={String(session.session_id ?? index)} className="rounded-lg border border-line bg-panel p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-mono text-xs text-muted">{String(session.session_id ?? "")}</p>
                <h2 className="mt-1 text-lg font-semibold">{String(session.hackerrank_username ?? "")}</h2>
              </div>
              <span className="rounded-full border border-line px-3 py-1 text-xs font-medium">{String(session.status ?? "unknown")}</span>
            </div>
            <pre className="mt-4 max-h-96 overflow-auto rounded-md bg-ink p-4 text-xs text-white">{JSON.stringify(session, null, 2)}</pre>
          </div>
        ))}
      </section>
      </>
      ) : null}
    </Shell>
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

function AlertsConsole({ alerts, loading, loaded, onRefresh }: { alerts: Alert[]; loading: boolean; loaded: boolean; onRefresh: () => void }) {
  return (
    <>
      <section className="mb-5 rounded-lg border border-line bg-panel p-5 shadow-subtle">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Bell size={20} />
            <div>
              <h1 className="text-2xl font-semibold">Live alerts console</h1>
              <p className="mt-1 text-sm text-muted">Proctoring and contest-eval signals across all rooms, newest first. Click a clip to open the recorded evidence.</p>
            </div>
          </div>
          <button className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-white disabled:opacity-50" onClick={onRefresh} disabled={loading}>
            <RefreshCw size={16} className={loading ? "animate-spin" : undefined} /> {loading ? "Refreshing" : "Refresh"}
          </button>
        </div>
        <div className="mt-4 flex flex-wrap gap-3 text-sm">
          <Metric icon={<Bell size={16} />} label="Total" value={String(alerts.length)} />
          <Metric icon={<AlertTriangle size={16} />} label="Critical" value={String(alerts.filter((alert) => alert.severity === "critical").length)} />
          <Metric icon={<AlertTriangle size={16} />} label="Warning" value={String(alerts.filter((alert) => alert.severity === "warning").length)} />
        </div>
      </section>

      <section className="space-y-3">
        {!loaded && loading ? (
          <div className="rounded-lg border border-line bg-panel p-5 text-sm text-muted">Loading alerts…</div>
        ) : alerts.length === 0 ? (
          <div className="rounded-lg border border-line bg-panel p-5 text-sm text-muted">No alerts yet. New proctoring and contest-eval signals appear here as they arrive.</div>
        ) : (
          alerts.map((alert) => <AlertRow key={alert.id} alert={alert} />)
        )}
      </section>
    </>
  );
}

function AlertRow({ alert }: { alert: Alert }) {
  return (
    <div className={`rounded-lg border bg-panel p-5 shadow-subtle ${alert.severity === "critical" ? "border-danger/40" : "border-line"}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <SeverityPill severity={alert.severity} />
            <span className="rounded-full border border-line px-2.5 py-1 text-xs font-medium capitalize text-muted">{alert.source}</span>
            <span className="rounded-full border border-line px-2.5 py-1 font-mono text-xs text-muted">{alert.type}</span>
          </div>
          <h2 className="mt-2 text-lg font-semibold">{alert.title}</h2>
          {alert.detail ? <p className="mt-1 text-sm leading-6 text-muted">{alert.detail}</p> : null}
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

      <div className="mt-4 flex flex-wrap items-center gap-3">
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
      </div>
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

function HealthPanel({ status, sessionId, config, queueDepth, uploadedCount, manifest, mediaCapture }: { status: SessionStatus; sessionId: string; config: SessionStartResponse | null; queueDepth: number; uploadedCount: number; manifest: UploadManifestItem[]; mediaCapture: MediaCaptureState }) {
  return (
    <section className="rounded-lg border border-line bg-panel p-5">
      <div className="mb-4 flex items-center gap-2">
        <ShieldCheck size={18} />
        <h2 className="font-semibold">Recording health</h2>
      </div>
      <div className="space-y-3 text-sm">
        <Metric icon={<CheckCircle2 size={16} />} label="State" value={status} />
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

function RulesPanel() {
  return (
    <section className="rounded-lg border border-line bg-panel p-5">
      <div className="mb-4 flex items-center gap-2">
        <AlertTriangle size={18} />
        <h2 className="font-semibold">Test rules</h2>
      </div>
      <ul className="space-y-2 text-sm leading-6 text-muted">
        <li>Select Entire Screen only. Tab/window sharing is not accepted.</li>
        <li>Screen sharing is mandatory and is recorded directly for reliability. Microphone is included when available.</li>
        <li>If a camera is available, keep the camera preview or pop-out visible when you move to HackerRank.</li>
        <li>Do not stop screen sharing until the assessment is fully submitted.</li>
        <li>Keep this proctor app open. Focus changes and interruptions are logged.</li>
        <li>Copied code, AI-assisted answers, or unexplained anomalies may lead to disqualification.</li>
        <li>Shortlisted candidates must explain and modify their code live.</li>
      </ul>
    </section>
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
