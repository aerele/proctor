import { getUploadUrl, heartbeat, sendEvents, uploadBlob } from "./api";
import type { ApiError } from "./api";
import type { ProctorEvent, ServerSessionStatus, SessionStartResponse, UploadManifestItem } from "./types";

type RecorderOptions = {
  sessionId: string;
  config: SessionStartResponse["upload_config"];
  heartbeatSeconds: number;
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

function createEvent(type: string, detail?: Record<string, unknown>): ProctorEvent {
  return {
    type,
    timestamp: new Date().toISOString(),
    visibility_state: document.visibilityState,
    detail
  };
}

export function createProctorRecorder(options: RecorderOptions): RecorderControls {
  let screenStream: MediaStream | null = null;
  let cameraStream: MediaStream | null = null;
  let combinedStream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let segmentTimer: number | undefined;
  let stopping = false;
  let chunkIndex = 0;
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
  // recording path is startDirectScreenRecordingStream (direct display stream +
  // mixed mic audio), chosen so capture survives a hidden proctor tab. The
  // camera is still ACQUIRED (startCameraAndMicrophone) for the live self-view
  // and state tracking, but its frames are never drawn into the recording.

  let fatalStatusHandled = false;

  const emit = (type: string, detail?: Record<string, unknown>) => {
    const event = createEvent(type, detail);
    eventBuffer.push(event);
    options.onEvent(event);
  };

  // B1: map a backend write rejection (403 session_locked / waiting_for_approval,
  // 409 session_ended) to the lifecycle status the host should flip to. Returns
  // null for ordinary network/transient errors (no self-stop).
  const fatalStatusFromError = (error: unknown): ServerSessionStatus | null => {
    const err = error as ApiError;
    if (err?.code === "session_ended") return "ended";
    if (err?.code === "session_locked") return "locked";
    if (err?.code === "waiting_for_approval") return "pending_approval";
    if (err?.status === 409) return "ended";
    if (err?.status === 403) return "locked";
    return null;
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

  const enqueueUpload = (blob: Blob, index: number) => {
    const startedAt = new Date().toISOString();
    queueDepth += 1;
    updateUploadState();

    uploadQueue = uploadQueue
      .then(async () => {
        const upload = await getUploadUrl({
          session_id: options.sessionId,
          kind: "screen",
          chunk_index: index,
          content_type: blob.type || "video/webm"
        });
        await uploadBlob(upload.upload_url, blob);
        manifest.push({
          kind: "screen",
          index,
          storage_key: upload.storage_key,
          bytes: blob.size,
          started_at: startedAt,
          completed_at: new Date().toISOString()
        });
        uploadedCount += 1;
        emit("chunk_uploaded", { kind: "screen", index, bytes: blob.size, storage_key: upload.storage_key });
      })
      .catch((error) => {
        emit("upload_error", { kind: "screen", index, bytes: blob.size, message: String(error) });
        // B1: a 403/409 on upload means the session is no longer writable.
        handleFatalStatus(fatalStatusFromError(error));
        throw error;
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
        network_online: navigator.onLine
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
      if (!navigator.mediaDevices?.getDisplayMedia) {
        throw new Error("Screen recording is not supported. Use latest Chrome or Edge.");
      }

      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: options.config.max_width },
          frameRate: { ideal: options.config.max_frame_rate, max: options.config.max_frame_rate }
        },
        audio: false
      });

      const [screenTrack] = screenStream.getVideoTracks();
      const screenSettings = screenTrack?.getSettings() as MediaTrackSettings & { displaySurface?: string };

      // INVALID-SURFACE GUARD — runs BEFORE we attach the ended-listener, start
      // the camera/mic, build the combined stream, or create the MediaRecorder.
      // If the student shared a tab/window/browser instead of the whole monitor,
      // we stop the obtained stream and throw a typed error so the host keeps the
      // UI in a clear NOT-RECORDING state and offers an inline retry. No recording
      // is ever started for an invalid surface.
      if (screenSettings?.displaySurface && screenSettings.displaySurface !== "monitor") {
        emit("invalid_share_surface", {
          display_surface: screenSettings.displaySurface,
          required_surface: "monitor"
        });
        screenStream.getTracks().forEach((track) => track.stop());
        screenStream = null;
        throw new InvalidShareSurfaceError(screenSettings.displaySurface);
      }

      // Valid full-screen share confirmed — now it is safe to wire up the
      // stop-detection and begin capture.
      screenTrack?.addEventListener("ended", () => {
        if (stopping) return;
        updateMediaState("screen", "stopped");
        emit("screen_share_stopped", { reason: "track_ended" });
        options.onFatalError("Screen sharing stopped. Return to the proctor app immediately.");
      });

      await startCameraAndMicrophone();
      startDirectScreenRecordingStream();
      bindPageEvents();
      emit("combined_recording_started", {
        screen_label: screenTrack?.label,
        display_surface: screenSettings?.displaySurface || "unknown",
        chunk_seconds: options.config.chunk_seconds,
        recording_mode: "direct_screen_stream",
        camera_overlay: "disabled_for_reliable_background_recording",
        audio: mediaState.microphone === "recording" ? "microphone" : "none"
      });
      startHeartbeat();
      startSegmentRecorder();
    },
    async stop() {
      stopping = true;
      if (heartbeatTimer) window.clearInterval(heartbeatTimer);
      if (segmentTimer) window.clearTimeout(segmentTimer);
      unbindPageEvents();
      emit("session_stop_requested");

      await stopRecorder();

      screenStream?.getTracks().forEach((track) => track.stop());
      cameraStream?.getTracks().forEach((track) => track.stop());
      combinedStream?.getTracks().forEach((track) => track.stop());
      options.onCameraStream?.(null);
      updateMediaState("screen", "stopped");
      updateMediaState("camera", keepOptionalMediaFinalState(mediaState.camera));
      updateMediaState("microphone", keepOptionalMediaFinalState(mediaState.microphone));
      await uploadQueue.catch((error) => {
        options.onFatalError(`Upload queue failed: ${String(error)}`);
      });
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
    if (!navigator.mediaDevices?.getUserMedia) {
      updateMediaState("camera", "unavailable");
      updateMediaState("microphone", "unavailable");
      emit("camera_microphone_unavailable", { reason: "getUserMedia not supported" });
      return;
    }

    const devices = await navigator.mediaDevices.enumerateDevices?.().catch(() => []);
    const hasCamera = !devices?.length || devices.some((device) => device.kind === "videoinput");
    const hasMicrophone = !devices?.length || devices.some((device) => device.kind === "audioinput");

    if (!hasCamera && !hasMicrophone) {
      updateMediaState("camera", "unavailable");
      updateMediaState("microphone", "unavailable");
      emit("camera_microphone_unavailable", { reason: "No camera or microphone devices detected" });
      return;
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
        cameraStream = await navigator.mediaDevices.getUserMedia(attempt.constraints);
        bindOptionalMediaTracks(attempt.label);
        return;
      } catch (error) {
        lastError = error;
        emit("optional_media_capture_attempt_failed", { attempt: attempt.label, message: String(error) });
      }
    }

    updateMediaState("camera", hasCamera ? "permission_denied" : "unavailable");
    updateMediaState("microphone", hasMicrophone ? "permission_denied" : "unavailable");
    emit("camera_microphone_optional_capture_failed", {
      message: String(lastError),
      camera_available: hasCamera,
      microphone_available: hasMicrophone
    });
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
        enqueueUpload(event.data, ++chunkIndex);
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
}

function getSupportedMimeType() {
  const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || "";
}
