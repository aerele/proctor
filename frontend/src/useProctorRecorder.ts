import { getUploadUrl, heartbeat, sendEvents, uploadBlob } from "./api";
import type { ApiError } from "./api";
import { cameraTrackConstraints, shouldRecordCamera } from "./cameraRecording";
import { writeChunkHwm } from "./chunkContinuity";
import { advanceUploadChain, runUploadWithRetry } from "./chunkUploadRetry";
import type { EnforcementConfigPayload, EnforcementExemptions, ProctorEvent, ServerSessionStatus, SessionStartResponse, UploadManifestItem } from "./types";

type RecorderOptions = {
  sessionId: string;
  config: SessionStartResponse["upload_config"];
  heartbeatSeconds: number;
  // F1 (e2e finding): per-kind chunk-index continuation bases. The recorder's
  // first chunk of THIS instance is base+1, so a restarted recording (share-
  // drop recovery, refresh-resume) continues the prior stint's count instead
  // of re-counting from 1 and OVERWRITING its GCS objects. The host computes
  // the base as max(server-reported count/hwm, sessionStorage hwm); absent →
  // 0 (fresh session, identical to the old behavior). Chunk cadence, content
  // and event semantics are unchanged — only where the indexes start.
  chunkIndexBase?: { screen: number; camera: number };
  // F5.1 permissions-first onboarding: streams already acquired by the stage-1
  // PermissionsGate. start() claims and reuses them instead of re-prompting;
  // a stream the candidate killed between setup and start falls back to the
  // prompting path (the submit click's activation usually still covers it).
  acquired?: AcquiredMedia;
  onEvent: (event: ProctorEvent) => void;
  onUploadChange: (depth: number, uploaded: number) => void;
  onFatalError: (message: string) => void;
  // B1: the session was locked/ended/paused server-side (heartbeat status or a
  // 403/409 from any write). The recorder has been stopped; the host flips its
  // gate to match. Distinct from onFatalError, which is a local capture failure.
  onStatusChange?: (status: ServerSessionStatus) => void;
  onMediaStateChange?: (state: MediaCaptureState) => void;
  onCameraStream?: (stream: MediaStream | null) => void;
  onIpStatusChange?: (status: { startIp: string; currentIp: string; ipChanged: boolean; newlyChanged: boolean }) => void;
  // S5: every heartbeat echoes the authoritative exam end time + server clock;
  // the host updates its countdown so a proctor's live time change propagates
  // within one heartbeat interval (no reload).
  onExamTimeChange?: (info: { endAt: string; serverNow: string }) => void;
  // F5.3/F5.5: every heartbeat echoes the enforcement config + this session's
  // exemptions, so an admin/invigilator exemption applies live (no reload).
  onEnforcementChange?: (info: { enforcement?: EnforcementConfigPayload; exemptions?: EnforcementExemptions }) => void;
};

type RecorderControls = {
  start: () => Promise<void>;
  stop: () => Promise<UploadManifestItem[]>;
  getManifest: () => UploadManifestItem[];
  getQueueDepth: () => number;
};

export type MediaCaptureState = {
  screen: "inactive" | "recording" | "stopped" | "error";
  camera: "inactive" | "recording" | "stopped" | "error" | "permission_denied" | "unavailable";
  microphone: "inactive" | "recording" | "stopped" | "error" | "permission_denied" | "unavailable";
};

// Thrown by recorder.start() BEFORE any MediaRecorder is created when the student
// shares a tab/window/browser surface instead of the entire monitor. The caller
// MUST treat this as "recording did NOT start" (no status flip to "recording")
// and offer an inline retry. Distinct from a generic start failure so the host UI
// can show the precise "share your ENTIRE SCREEN" guidance.
export class InvalidShareSurfaceError extends Error {
  /** The surface the student actually selected: 'window' | 'browser' | undefined. */
  readonly displaySurface: string;
  constructor(displaySurface: string) {
    super("You must share your ENTIRE SCREEN — you selected a tab/window. Recording has not started.");
    this.name = "InvalidShareSurfaceError";
    this.displaySurface = displaySurface;
  }
}

// Categorize a getDisplayMedia / getUserMedia rejection into a stable kind the
// host can map to recoverable, human-readable copy. Permission-denied and the
// user pressing Cancel both surface as NotAllowedError/AbortError on most
// browsers; we keep them under one "share_cancelled" bucket because the recovery
// (press Try again, pick Entire Screen, Allow) is identical.
export type RecorderStartErrorKind = "unsupported" | "share_cancelled" | "invalid_surface" | "unknown";

export function classifyStartError(error: unknown): RecorderStartErrorKind {
  if (error instanceof InvalidShareSurfaceError) return "invalid_surface";
  if (error instanceof Error) {
    if (error.message.includes("Screen recording is not supported")) return "unsupported";
    if (error.name === "NotAllowedError" || error.name === "AbortError" || error.name === "NotFoundError") {
      return "share_cancelled";
    }
  }
  return "unknown";
}

// ---- F5.1 permissions-first stream acquisition ------------------------------
//
// The stage-1 PermissionsGate acquires every stream BEFORE the session exists
// (and before fullscreen), then hands them to the recorder at start(). These
// standalone helpers are shared by the gate (via App.tsx) and by start()'s
// own prompting/re-prompt path so the surface guard and the camera fallback
// ladder live in exactly one place.

export type AcquiredMedia = {
  screen: MediaStream | null;
  cameraMic: MediaStream | null;
  // The fallback-ladder label of the cameraMic acquisition (for the
  // camera_microphone_started audit event).
  cameraMicMode: string | null;
};

// Pre-session screen constraints — mirror of the backend uploadConfig defaults
// (handler.mjs). start() re-applies the session's authoritative values via
// applyConstraints, so a server-side change still wins.
export const SETUP_SCREEN_CONSTRAINTS = { maxWidth: 960, maxFrameRate: 4 };

type EmitFn = (type: string, detail?: Record<string, unknown>) => void;

// Prompt for the screen share and enforce the ENTIRE-SCREEN surface. Throws
// (classifiable via classifyStartError) on cancel/denial/invalid surface; an
// invalid tab/window share is stopped and rejected BEFORE anything observes it.
export async function acquireScreenShareStream(
  constraints: { maxWidth: number; maxFrameRate: number },
  emit: EmitFn
): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("Screen recording is not supported. Use latest Chrome or Edge.");
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      width: { ideal: constraints.maxWidth },
      frameRate: { ideal: constraints.maxFrameRate, max: constraints.maxFrameRate }
    },
    audio: false
  });
  const [track] = stream.getVideoTracks();
  const settings = track?.getSettings() as (MediaTrackSettings & { displaySurface?: string }) | undefined;
  if (settings?.displaySurface && settings.displaySurface !== "monitor") {
    emit("invalid_share_surface", {
      display_surface: settings.displaySurface,
      required_surface: "monitor"
    });
    stream.getTracks().forEach((t) => t.stop());
    throw new InvalidShareSurfaceError(settings.displaySurface);
  }
  return stream;
}

export type CameraMicAcquireResult = {
  stream: MediaStream | null;
  captureMode: string | null;
  camera: "granted" | "denied" | "unavailable";
  microphone: "granted" | "denied" | "unavailable";
};

// The optional camera+microphone fallback ladder (camera+mic -> camera-only ->
// mic-only). NEVER throws: camera/mic stay optional — failures are returned as
// statuses (and audited via emit) so the candidate is never blocked by them.
export async function acquireCameraMicrophone(emit: EmitFn): Promise<CameraMicAcquireResult> {
  if (!navigator.mediaDevices?.getUserMedia) {
    emit("camera_microphone_unavailable", { reason: "getUserMedia not supported" });
    return { stream: null, captureMode: null, camera: "unavailable", microphone: "unavailable" };
  }

  const devices = await navigator.mediaDevices.enumerateDevices?.().catch(() => []);
  const hasCamera = !devices?.length || devices.some((device) => device.kind === "videoinput");
  const hasMicrophone = !devices?.length || devices.some((device) => device.kind === "audioinput");

  if (!hasCamera && !hasMicrophone) {
    emit("camera_microphone_unavailable", { reason: "No camera or microphone devices detected" });
    return { stream: null, captureMode: null, camera: "unavailable", microphone: "unavailable" };
  }

  const preferredVideo: MediaTrackConstraints = {
    width: { ideal: 320, max: 640 },
    height: { ideal: 240, max: 480 },
    frameRate: { ideal: 6, max: 10 }
  };
  const preferredAudio: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  };
  const attempts: Array<{ label: string; constraints: MediaStreamConstraints }> = [];

  if (hasCamera && hasMicrophone) {
    attempts.push({ label: "camera_and_microphone", constraints: { video: preferredVideo, audio: preferredAudio } });
  }
  if (hasCamera) attempts.push({ label: "camera_only", constraints: { video: preferredVideo, audio: false } });
  if (hasMicrophone) attempts.push({ label: "microphone_only", constraints: { video: false, audio: preferredAudio } });

  let lastError: unknown = null;
  for (const attempt of attempts) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(attempt.constraints);
      return {
        stream,
        captureMode: attempt.label,
        camera: stream.getVideoTracks().length ? "granted" : hasCamera ? "denied" : "unavailable",
        microphone: stream.getAudioTracks().length ? "granted" : hasMicrophone ? "denied" : "unavailable"
      };
    } catch (error) {
      lastError = error;
      emit("optional_media_capture_attempt_failed", { attempt: attempt.label, message: String(error) });
    }
  }

  emit("camera_microphone_optional_capture_failed", {
    message: String(lastError),
    camera_available: hasCamera,
    microphone_available: hasMicrophone
  });
  return {
    stream: null,
    captureMode: null,
    camera: hasCamera ? "denied" : "unavailable",
    microphone: hasMicrophone ? "denied" : "unavailable"
  };
}

function streamFullyLive(stream: MediaStream | null): boolean {
  if (!stream) return false;
  const tracks = stream.getTracks();
  return tracks.length > 0 && tracks.every((track) => track.readyState === "live");
}

function createEvent(type: string, detail?: Record<string, unknown>): ProctorEvent {
  return {
    type,
    timestamp: new Date().toISOString(),
    visibility_state: document.visibilityState,
    detail
  };
}

// F10.1: bitrate for the separate low-res camera stream. At ~10 fps / 640 w
// this keeps eye direction legible while staying far below the screen
// stream's budget (admin tunes fps/width via settings; bitrate scales little
// at this size so it stays fixed).
const CAMERA_VIDEO_BITS_PER_SECOND = 250_000;

// B1: map a backend write rejection (403 session_locked / waiting_for_approval,
// 409 session_ended) to the lifecycle status the host should flip to. Returns
// null for ordinary network/transient errors (no self-stop). Pure (no recorder
// state) — module-scope and exported (RT-4) so the chain tests pin the EXACT
// fatal predicate the screen upload chain composes from it.
export function fatalStatusFromError(error: unknown): ServerSessionStatus | null {
  const err = error as ApiError;
  if (err?.code === "session_ended") return "ended";
  if (err?.code === "session_locked") return "locked";
  if (err?.code === "waiting_for_approval") return "pending_approval";
  if (err?.status === 409) return "ended";
  if (err?.status === 403) return "locked";
  return null;
}

export function createProctorRecorder(options: RecorderOptions): RecorderControls {
  let screenStream: MediaStream | null = null;
  let cameraStream: MediaStream | null = null;
  let combinedStream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let segmentTimer: number | undefined;
  let stopping = false;
  // F1: indexes continue from the prior stint's high-water mark (0 = fresh).
  let chunkIndex = Math.max(0, Math.floor(options.chunkIndexBase?.screen ?? 0));
  let uploadQueue = Promise.resolve();
  let queueDepth = 0;
  let uploadedCount = 0;
  let heartbeatTimer: number | undefined;
  let eventBuffer: ProctorEvent[] = [];
  const manifest: UploadManifestItem[] = [];
  const mediaState: MediaCaptureState = {
    screen: "inactive",
    camera: "inactive",
    microphone: "inactive"
  };

  // NOTE: the old camera-over-screen canvas compositor was removed — the ONLY
  // SCREEN recording path is startDirectScreenRecordingStream (direct display
  // stream + mixed mic audio), chosen so capture survives a hidden proctor tab.
  //
  // F10.1: when the server-side camera_recording setting is enabled AND a live
  // camera track exists, a SECOND MediaRecorder runs directly on a video-only
  // MediaStream of the camera track (again no canvas — a raw track keeps
  // capturing while the tab is hidden). Independent 30s segment loop, own
  // chunk series (kind "camera" → camera/chunk-*.webm) and OWN upload chain:
  // any camera failure degrades to mediaState.camera "error" + an audit event
  // and never touches the screen recording (no onFatalError, no retry loop).
  let cameraRecorder: MediaRecorder | null = null;
  let cameraSegmentTimer: number | undefined;
  // F1: same continuation rule as the screen series (independent counter).
  let cameraChunkIndex = Math.max(0, Math.floor(options.chunkIndexBase?.camera ?? 0));
  let cameraUploadQueue = Promise.resolve();
  let cameraOnlyStream: MediaStream | null = null;
  let cameraRecordingFailed = false;

  let fatalStatusHandled = false;

  const emit = (type: string, detail?: Record<string, unknown>) => {
    const event = createEvent(type, detail);
    eventBuffer.push(event);
    options.onEvent(event);
  };

  // B1: stop the recorder and notify the host exactly once when the session is no
  // longer writable. Guards against the multiple concurrent writes (heartbeat +
  // chunk upload + event flush) all tripping the same 403 at the same time.
  const handleFatalStatus = (status: ServerSessionStatus | null) => {
    if (!status || fatalStatusHandled || stopping) return;
    fatalStatusHandled = true;
    void controls.stop();
    options.onStatusChange?.(status);
  };

  const flushEvents = async () => {
    const batch = eventBuffer;
    eventBuffer = [];
    try {
      await sendEvents(options.sessionId, batch);
    } catch (error) {
      eventBuffer = [...batch, ...eventBuffer].slice(-200);
      options.onEvent(createEvent("event_upload_error", { message: String(error) }));
      // B1: a 403/409 on the events write means the session is no longer writable.
      handleFatalStatus(fatalStatusFromError(error));
    }
  };

  const updateUploadState = () => {
    options.onUploadChange(queueDepth, uploadedCount);
  };

  const updateMediaState = (kind: keyof MediaCaptureState, state: MediaCaptureState[keyof MediaCaptureState]) => {
    mediaState[kind] = state as never;
    options.onMediaStateChange?.({ ...mediaState });
  };

  // RT-1 (rev-00008 retest): one chunk's upload with bounded TRANSIENT-failure
  // retries, shared by both kinds. Each attempt re-requests a FRESH signed URL
  // for the SAME already-allocated index and the SAME bytes (the old URL may be
  // expired/consumed; the backend hwm guard maps the re-request to an unused
  // object key — never an overwrite — and the returned storage_key is what the
  // manifest records, so the bookkeeping stays truthful). By-design 401/403/409
  // rejections are NOT retried — they reject immediately into the existing
  // catch path (upload_error + handleFatalStatus), unchanged. Retries run
  // INSIDE this chunk's slot of the serial per-kind chain, so at most one retry
  // sequence is in flight per kind and exhaustion (~7s of backoff) falls
  // through to the exact same honest-gap path as a single failure today.
  const uploadChunkWithRetry = async (kind: "screen" | "camera", blob: Blob, index: number) => {
    let retried = 0;
    const upload = await runUploadWithRetry(
      async () => {
        const fresh = await getUploadUrl({
          session_id: options.sessionId,
          kind,
          chunk_index: index,
          content_type: blob.type || "video/webm"
        });
        await uploadBlob(fresh.upload_url, blob);
        return fresh;
      },
      {
        onRetry: ({ attempt, delayMs, error }) => {
          retried = attempt;
          emit("chunk_upload_retry", { kind, index, bytes: blob.size, attempt, delay_ms: delayMs, message: String(error) });
        }
      }
    );
    return { upload, retried };
  };

  // RT-4: the slot still SEQUENCES on the serial chain, but a NON-fatal
  // exhausted failure no longer propagates to later chunks — that one chunk
  // emits its own upload_error (honest gap, timeline marker) and the chain
  // recovers, so the NEXT chunk attempts its OWN upload instead of inheriting
  // the rejection until the next recorder restart. ONLY a fatal-status
  // rejection (401/403/409 → lock/pending/ended) keeps the chain rejected,
  // so stop()'s `await uploadQueue.catch(...)` still surfaces it through
  // onFatalError exactly as before.
  const enqueueUpload = (blob: Blob, index: number) => {
    const startedAt = new Date().toISOString();
    queueDepth += 1;
    updateUploadState();

    uploadQueue = advanceUploadChain(uploadQueue, {
      run: async () => {
        const { upload, retried } = await uploadChunkWithRetry("screen", blob, index);
        manifest.push({
          kind: "screen",
          index,
          storage_key: upload.storage_key,
          bytes: blob.size,
          started_at: startedAt,
          completed_at: new Date().toISOString()
        });
        uploadedCount += 1;
        // RT-1: identical event; `retried` rides only when a retry happened.
        emit("chunk_uploaded", { kind: "screen", index, bytes: blob.size, storage_key: upload.storage_key, ...(retried ? { retried } : {}) });
      },
      onError: (error) => {
        emit("upload_error", { kind: "screen", index, bytes: blob.size, message: String(error) });
        // B1: a 403/409 on upload means the session is no longer writable.
        handleFatalStatus(fatalStatusFromError(error));
      },
      isFatal: (error) => fatalStatusFromError(error) !== null,
      onSettled: () => {
        queueDepth = Math.max(0, queueDepth - 1);
        updateUploadState();
      }
    });
  };

  // F10.1: camera chunks ride the SAME upload-url flow but on their OWN chain.
  // The screen chain stays rejected ONLY on a fatal-status failure (RT-4 —
  // stop() surfaces that via onFatalError); the camera chain SWALLOWS every
  // failure after auditing, so one failed camera chunk neither poisons later
  // camera chunks nor fails the session. A session-level 403/409 still
  // self-stops via handleFatalStatus.
  const enqueueCameraUpload = (blob: Blob, index: number) => {
    const startedAt = new Date().toISOString();
    queueDepth += 1;
    updateUploadState();

    cameraUploadQueue = cameraUploadQueue
      .then(async () => {
        // RT-1: same bounded retry as the screen chain (own serial chain, so a
        // camera retry never delays a screen chunk and vice versa).
        const { upload, retried } = await uploadChunkWithRetry("camera", blob, index);
        manifest.push({
          kind: "camera",
          index,
          storage_key: upload.storage_key,
          bytes: blob.size,
          started_at: startedAt,
          completed_at: new Date().toISOString()
        });
        uploadedCount += 1;
        emit("chunk_uploaded", { kind: "camera", index, bytes: blob.size, storage_key: upload.storage_key, ...(retried ? { retried } : {}) });
      })
      .catch((error) => {
        emit("upload_error", { kind: "camera", index, bytes: blob.size, message: String(error) });
        handleFatalStatus(fatalStatusFromError(error));
      })
      .finally(() => {
        queueDepth = Math.max(0, queueDepth - 1);
        updateUploadState();
      });
  };

  const bindPageEvents = () => {
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("copy", onClipboard);
    document.addEventListener("cut", onClipboard);
    document.addEventListener("paste", onClipboard);
  };

  const unbindPageEvents = () => {
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("beforeunload", onBeforeUnload);
    document.removeEventListener("copy", onClipboard);
    document.removeEventListener("cut", onClipboard);
    document.removeEventListener("paste", onClipboard);
  };

  const onVisibilityChange = () => emit("visibility_change", { state: document.visibilityState });
  const onBlur = () => emit("window_blur");
  const onFocus = () => emit("window_focus");
  const onPageHide = () => emit("page_hide");
  const onBeforeUnload = () => emit("before_unload");
  const onClipboard = (event: ClipboardEvent) => {
    const text = event.clipboardData?.getData("text") ?? "";
    emit("clipboard_activity", {
      action: event.type,
      text_length: text.length,
      text_preview: text.slice(0, 80)
    });
  };

  const startHeartbeat = () => {
    heartbeatTimer = window.setInterval(() => {
      void heartbeat({
        session_id: options.sessionId,
        recording_state: `combined:${recorder?.state ?? "inactive"};screen:${mediaState.screen};camera:${mediaState.camera};microphone:${mediaState.microphone}`,
        visibility_state: document.visibilityState,
        upload_queue_depth: queueDepth,
        client_time: new Date().toISOString(),
        network_online: navigator.onLine,
        // F5.3 wave-2 fix: corrective fullscreen truth for the server-side
        // enforcement countdown (clears a stale open exit / starts the clock
        // when the exit event itself was lost).
        fullscreen: Boolean(document.fullscreenElement)
      }).then((response) => {
        if (response.start_ip && response.current_ip) {
          options.onIpStatusChange?.({
            startIp: response.start_ip,
            currentIp: response.current_ip,
            ipChanged: Boolean(response.ip_changed),
            newlyChanged: Boolean(response.newly_changed)
          });
        }
        if (response.newly_changed) {
          emit("ip_address_changed", {
            start_ip: response.start_ip,
            current_ip: response.current_ip,
            message: "IP address changed after the test started."
          });
        }
        // S5: surface the current exam end time on every heartbeat.
        if (response.end_at) {
          options.onExamTimeChange?.({ endAt: response.end_at, serverNow: response.server_now ?? "" });
        }
        // F5.3/F5.5: surface enforcement config + exemptions on every heartbeat.
        if (response.enforcement || response.enforcement_exemptions) {
          options.onEnforcementChange?.({ enforcement: response.enforcement, exemptions: response.enforcement_exemptions });
        }
        // B1: an active heartbeat reports the live status; if a proctor
        // locked/ended/paused the session, self-stop the recorder.
        if (response.status && response.status !== "active") {
          handleFatalStatus(response.status);
        }
      }).catch((error) => {
        const fatal = fatalStatusFromError(error);
        if (fatal) {
          handleFatalStatus(fatal);
        } else {
          emit("heartbeat_error", { message: String(error) });
        }
      });
      void flushEvents();
    }, options.heartbeatSeconds * 1000);
  };

  const controls: RecorderControls = {
    async start() {
      // F5.1: claim the handed-over streams up front so stop() owns their
      // cleanup even when start() throws part-way (no orphaned camera/screen
      // capture indicators after a failed start).
      const acquired = options.acquired;
      if (acquired?.cameraMic) cameraStream = acquired.cameraMic;

      const preScreen = acquired?.screen ?? null;
      if (preScreen && preScreen.getVideoTracks()[0]?.readyState === "live") {
        // Reuse the stage-1 share — NO second prompt. The acquisition path
        // already enforced the entire-screen surface; the server's upload
        // config is authoritative, so re-align the track with it.
        screenStream = preScreen;
        await screenStream.getVideoTracks()[0].applyConstraints({
          width: { ideal: options.config.max_width },
          frameRate: { ideal: options.config.max_frame_rate, max: options.config.max_frame_rate }
        }).catch(() => undefined);
      } else {
        // No pre-acquired share, or the candidate killed it between setup and
        // start — re-prompt (the surface guard runs inside, and throws a typed
        // error BEFORE any recording starts so the host shows an inline retry).
        preScreen?.getTracks().forEach((track) => track.stop());
        screenStream = await acquireScreenShareStream(
          { maxWidth: options.config.max_width, maxFrameRate: options.config.max_frame_rate },
          emit
        );
      }

      const [screenTrack] = screenStream.getVideoTracks();
      const screenSettings = screenTrack?.getSettings() as MediaTrackSettings & { displaySurface?: string };

      // Valid full-screen share confirmed — now it is safe to wire up the
      // stop-detection and begin capture.
      screenTrack?.addEventListener("ended", () => {
        if (stopping) return;
        updateMediaState("screen", "stopped");
        emit("screen_share_stopped", { reason: "track_ended" });
        options.onFatalError("Screen sharing stopped. Return to the proctor app immediately.");
      });

      if (streamFullyLive(cameraStream)) {
        // Reuse the stage-1 camera/mic acquisition as-is.
        bindOptionalMediaTracks(acquired?.cameraMicMode ?? "preacquired");
      } else {
        // Nothing pre-acquired, or a track died in between: re-run the ladder
        // (permissions already granted in stage 1 mean no visible prompt).
        cameraStream?.getTracks().forEach((track) => track.stop());
        cameraStream = null;
        await startCameraAndMicrophone();
      }
      startDirectScreenRecordingStream();
      bindPageEvents();
      emit("combined_recording_started", {
        screen_label: screenTrack?.label,
        display_surface: screenSettings?.displaySurface || "unknown",
        chunk_seconds: options.config.chunk_seconds,
        recording_mode: "direct_screen_stream",
        screen_source: screenStream === preScreen ? "preacquired" : "prompted",
        camera_overlay: "disabled_for_reliable_background_recording",
        audio: mediaState.microphone === "recording" ? "microphone" : "none"
      });
      startHeartbeat();
      startSegmentRecorder();
      // F10.1: the separate camera stream starts LAST and behind its own
      // try/catch — by contract no camera failure may abort or degrade the
      // screen recording that is now running.
      try {
        startCameraRecording();
      } catch (error) {
        failCameraRecording("start_failed", error);
      }
    },
    async stop() {
      stopping = true;
      if (heartbeatTimer) window.clearInterval(heartbeatTimer);
      if (segmentTimer) window.clearTimeout(segmentTimer);
      if (cameraSegmentTimer) window.clearTimeout(cameraSegmentTimer);
      unbindPageEvents();
      emit("session_stop_requested");

      await stopRecorder();
      await stopCameraRecorder();

      screenStream?.getTracks().forEach((track) => track.stop());
      cameraStream?.getTracks().forEach((track) => track.stop());
      combinedStream?.getTracks().forEach((track) => track.stop());
      options.onCameraStream?.(null);
      updateMediaState("screen", "stopped");
      updateMediaState("camera", keepOptionalMediaFinalState(mediaState.camera));
      updateMediaState("microphone", keepOptionalMediaFinalState(mediaState.microphone));
      // RT-4: the screen chain is rejected ONLY by a fatal-status failure
      // (lock/pending/ended) — non-fatal chunk failures were already audited
      // per-chunk (upload_error) and swallowed, so they no longer surface a
      // stale "Upload queue failed" here.
      await uploadQueue.catch((error) => {
        options.onFatalError(`Upload queue failed: ${String(error)}`);
      });
      // The camera chain never rejects (errors are audited + swallowed), so
      // this only waits for the final camera chunk to land in the manifest.
      await cameraUploadQueue;
      await flushEvents();
      return manifest;
    },
    getManifest() {
      return manifest;
    },
    getQueueDepth() {
      return queueDepth;
    }
  };

  return controls;

  async function startCameraAndMicrophone() {
    // Shared F5.1 ladder — the same code path the PermissionsGate uses, so the
    // audit events (camera_microphone_unavailable / attempt_failed / optional_
    // capture_failed) stay identical wherever the acquisition happens.
    const result = await acquireCameraMicrophone(emit);
    cameraStream = result.stream;
    if (result.stream) {
      bindOptionalMediaTracks(result.captureMode ?? "unknown");
      return;
    }
    updateMediaState("camera", result.camera === "denied" ? "permission_denied" : "unavailable");
    updateMediaState("microphone", result.microphone === "denied" ? "permission_denied" : "unavailable");
    options.onCameraStream?.(null);
  }

  function bindOptionalMediaTracks(captureMode: string) {
    if (!cameraStream) return;

    const [cameraTrack] = cameraStream.getVideoTracks();
    const [audioTrack] = cameraStream.getAudioTracks();

    cameraTrack?.addEventListener("ended", () => {
      if (stopping) return;
      updateMediaState("camera", "stopped");
      emit("camera_stopped", { reason: "track_ended" });
    });
    audioTrack?.addEventListener("ended", () => {
      if (stopping) return;
      updateMediaState("microphone", "stopped");
      emit("microphone_stopped", { reason: "track_ended" });
    });

    options.onCameraStream?.(cameraTrack ? cameraStream : null);
    updateMediaState("camera", cameraTrack ? "recording" : "unavailable");
    updateMediaState("microphone", audioTrack ? "recording" : "unavailable");
    emit("camera_microphone_started", {
      capture_mode: captureMode,
      camera_label: cameraTrack?.label || "not available",
      microphone_label: audioTrack?.label || "not available"
    });
  }

  function keepOptionalMediaFinalState(state: MediaCaptureState["camera"] | MediaCaptureState["microphone"]) {
    return state === "permission_denied" || state === "unavailable" ? state : "stopped";
  }

  function startDirectScreenRecordingStream() {
    if (!screenStream) return;

    const tracks = [...screenStream.getVideoTracks()];
    const audioTrack = cameraStream?.getAudioTracks()[0];
    if (audioTrack) tracks.push(audioTrack);
    combinedStream = new MediaStream(tracks);
    updateMediaState("screen", "recording");
    emit("direct_screen_recording_stream_started", {
      video_tracks: screenStream.getVideoTracks().length,
      microphone_audio: Boolean(audioTrack),
      reason: "Direct display stream is used so recording continues when the proctor tab is hidden."
    });
  }

  function startSegmentRecorder() {
    if (!combinedStream || stopping) return;

    recorder = new MediaRecorder(combinedStream, {
      mimeType: getSupportedMimeType(),
      videoBitsPerSecond: options.config.video_bits_per_second + (options.config.media_bits_per_second ?? 180_000),
      audioBitsPerSecond: options.config.audio_bits_per_second ?? 32_000
    });

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        if (event.data.size < 10_000) {
          emit("small_video_chunk_detected", {
            index: chunkIndex + 1,
            bytes: event.data.size,
            message: "Recorded video chunk is unusually small and may indicate a capture problem."
          });
        }
        const index = ++chunkIndex;
        // F1: persist the high-water mark at ALLOCATION time (not upload
        // completion) so even an in-flight chunk's index is never reused by
        // the next stint after a refresh in this tab.
        writeChunkHwm(window.sessionStorage, options.sessionId, "screen", index);
        enqueueUpload(event.data, index);
      }
    });
    recorder.addEventListener("error", (event) => {
      updateMediaState("screen", "error");
      emit("recording_error", { kind: "screen", message: String(event) });
    });
    recorder.addEventListener("stop", () => {
      if (!stopping) startSegmentRecorder();
    }, { once: true });

    recorder.start();
    segmentTimer = window.setTimeout(() => {
      if (recorder?.state === "recording") recorder.stop();
    }, options.config.chunk_seconds * 1000);
  }

  function stopRecorder() {
    return new Promise<void>((resolve) => {
      if (!recorder || recorder.state === "inactive") {
        resolve();
        return;
      }
      recorder.addEventListener("stop", () => resolve(), { once: true });
      recorder.stop();
    });
  }

  // ---- F10.1: separate low-res camera recording ----------------------------

  // Flag the camera stream as failed: state + audit event ONLY. By contract a
  // camera failure never reaches onFatalError, never raises an anomaly, and
  // never retries (a broken camera/encoder would otherwise loop) — the screen
  // recording continues untouched.
  function failCameraRecording(reason: string, cause: unknown) {
    cameraRecordingFailed = true;
    if (cameraSegmentTimer) window.clearTimeout(cameraSegmentTimer);
    updateMediaState("camera", "error");
    emit("camera_recording_error", { reason, message: String(cause) });
  }

  function startCameraRecording() {
    const cameraConfig = options.config.camera;
    const cameraTrack = cameraStream?.getVideoTracks()[0] ?? null;
    const trackLive = Boolean(cameraTrack && cameraTrack.readyState === "live");
    // Setting disabled, older backend (no camera block), or no usable camera →
    // the camera stays whatever the acquisition ladder reported (live monitor /
    // denied / unavailable). Nothing to record, nothing to fail.
    if (!cameraConfig || !cameraTrack || !shouldRecordCamera(cameraConfig, trackLive)) return;

    // Re-align the track with the server's authoritative fps/width. Async and
    // non-fatal: the browser picks the nearest supported mode, and a constraint
    // rejection just keeps the acquisition-time mode.
    void cameraTrack.applyConstraints(cameraTrackConstraints(cameraConfig)).catch(() => undefined);

    // Video-only stream of the RAW camera track (no canvas, mic stays on the
    // screen recording) — keeps capturing while the proctor tab is hidden.
    cameraOnlyStream = new MediaStream([cameraTrack]);
    emit("camera_recording_started", {
      fps: cameraConfig.fps,
      width: cameraConfig.width,
      camera_label: cameraTrack.label || "unknown",
      chunk_seconds: options.config.chunk_seconds,
      reason: "Separate low-res camera stream (eye-movement evidence), independent of the screen recording."
    });
    startCameraSegmentRecorder();
  }

  // Same fresh-recorder-per-segment pattern as the screen loop, so every
  // camera chunk is independently playable. The loop ends quietly when the
  // camera track dies (the bindOptionalMediaTracks "ended" listener already
  // reported camera "stopped") and permanently on any recorder error.
  function startCameraSegmentRecorder() {
    if (!cameraOnlyStream || stopping || cameraRecordingFailed) return;
    const [track] = cameraOnlyStream.getVideoTracks();
    if (!track || track.readyState !== "live") return;

    try {
      cameraRecorder = new MediaRecorder(cameraOnlyStream, {
        mimeType: getSupportedCameraMimeType(),
        videoBitsPerSecond: CAMERA_VIDEO_BITS_PER_SECOND
      });
    } catch (error) {
      failCameraRecording("recorder_create_failed", error);
      return;
    }

    cameraRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        // Deliberately NO small-chunk anomaly here (screen-only signal): a
        // low-fps camera segment is legitimately tiny.
        const index = ++cameraChunkIndex;
        // F1: same allocation-time hwm persistence as the screen series.
        writeChunkHwm(window.sessionStorage, options.sessionId, "camera", index);
        enqueueCameraUpload(event.data, index);
      }
    });
    cameraRecorder.addEventListener("error", (event) => {
      failCameraRecording("recorder_error", event);
    });
    cameraRecorder.addEventListener("stop", () => {
      if (!stopping && !cameraRecordingFailed) startCameraSegmentRecorder();
    }, { once: true });

    try {
      cameraRecorder.start();
    } catch (error) {
      failCameraRecording("recorder_start_failed", error);
      return;
    }
    cameraSegmentTimer = window.setTimeout(() => {
      if (cameraRecorder?.state === "recording") cameraRecorder.stop();
    }, options.config.chunk_seconds * 1000);
  }

  function stopCameraRecorder() {
    return new Promise<void>((resolve) => {
      if (!cameraRecorder || cameraRecorder.state === "inactive") {
        resolve();
        return;
      }
      cameraRecorder.addEventListener("stop", () => resolve(), { once: true });
      cameraRecorder.stop();
    });
  }
}

function getSupportedMimeType() {
  const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || "";
}

// F10.1: the camera stream is VIDEO-ONLY (the mic already rides the screen
// recording), so its mime candidates carry no audio codec.
function getSupportedCameraMimeType() {
  const candidates = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || "";
}
