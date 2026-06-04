import { getUploadUrl, heartbeat, sendEvents, uploadBlob } from "./api";
import type { ProctorEvent, SessionStartResponse, UploadManifestItem } from "./types";

type RecorderOptions = {
  sessionId: string;
  config: SessionStartResponse["upload_config"];
  heartbeatSeconds: number;
  onEvent: (event: ProctorEvent) => void;
  onUploadChange: (depth: number, uploaded: number) => void;
  onFatalError: (message: string) => void;
  onMediaStateChange?: (state: MediaCaptureState) => void;
  onCameraStream?: (stream: MediaStream | null) => void;
  onIpStatusChange?: (status: { startIp: string; currentIp: string; ipChanged: boolean; newlyChanged: boolean }) => void;
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
  let drawFrameId: number | undefined;
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

  const screenVideo = document.createElement("video");
  const cameraVideo = document.createElement("video");
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { alpha: false });

  screenVideo.muted = true;
  screenVideo.playsInline = true;
  cameraVideo.muted = true;
  cameraVideo.playsInline = true;

  const emit = (type: string, detail?: Record<string, unknown>) => {
    const event = createEvent(type, detail);
    eventBuffer.push(event);
    options.onEvent(event);
  };

  const flushEvents = async () => {
    const batch = eventBuffer;
    eventBuffer = [];
    try {
      await sendEvents(options.sessionId, batch);
    } catch (error) {
      eventBuffer = [...batch, ...eventBuffer].slice(-200);
      options.onEvent(createEvent("event_upload_error", { message: String(error) }));
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
      }).catch((error) => emit("heartbeat_error", { message: String(error) }));
      void flushEvents();
    }, options.heartbeatSeconds * 1000);
  };

  return {
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
      screenTrack?.addEventListener("ended", () => {
        if (stopping) return;
        updateMediaState("screen", "stopped");
        emit("screen_share_stopped", { reason: "track_ended" });
        options.onFatalError("Screen sharing stopped. Return to the proctor app immediately.");
      });
      if (screenSettings?.displaySurface && screenSettings.displaySurface !== "monitor") {
        emit("invalid_screen_share_surface", {
          display_surface: screenSettings.displaySurface,
          required_surface: "monitor"
        });
        options.onFatalError("You selected a tab or window. Restart and select Entire Screen for valid proctoring.");
        screenStream.getTracks().forEach((track) => track.stop());
        return;
      }

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
      if (drawFrameId) window.cancelAnimationFrame(drawFrameId);
      unbindPageEvents();
      emit("session_stop_requested");

      await stopRecorder();

      screenStream?.getTracks().forEach((track) => track.stop());
      cameraStream?.getTracks().forEach((track) => track.stop());
      combinedStream?.getTracks().forEach((track) => track.stop());
      screenVideo.srcObject = null;
      cameraVideo.srcObject = null;
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

  async function ensureVideoReady(video: HTMLVideoElement, kind: string) {
    if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, 1500);
        video.addEventListener("loadedmetadata", () => {
          window.clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }

    try {
      await video.play();
    } catch (error) {
      emit("media_preview_play_error", { kind, message: String(error) });
    }
  }

  function drawCompositeFrame() {
    if (!context || stopping) return;

    context.fillStyle = "#0a1a3f";
    context.fillRect(0, 0, canvas.width, canvas.height);
    drawContain(screenVideo, 0, 0, canvas.width, canvas.height);

    if (cameraStream?.getVideoTracks()[0]?.readyState === "live") {
      const margin = Math.max(12, Math.round(canvas.width * 0.015));
      const overlayWidth = Math.round(canvas.width * 0.2);
      const overlayHeight = Math.round(overlayWidth * 3 / 4);
      const x = canvas.width - overlayWidth - margin;
      const y = canvas.height - overlayHeight - margin;
      context.fillStyle = "rgba(10, 26, 63, 0.78)";
      roundRect(x - 4, y - 4, overlayWidth + 8, overlayHeight + 8, 8);
      context.fill();
      drawCover(cameraVideo, x, y, overlayWidth, overlayHeight);
      context.strokeStyle = "rgba(255, 255, 255, 0.85)";
      context.lineWidth = 2;
      roundRect(x, y, overlayWidth, overlayHeight, 6);
      context.stroke();
    }

    drawFrameId = window.requestAnimationFrame(drawCompositeFrame);
  }

  function drawContain(video: HTMLVideoElement, x: number, y: number, width: number, height: number) {
    const sourceWidth = video.videoWidth || width;
    const sourceHeight = video.videoHeight || height;
    const scale = Math.min(width / sourceWidth, height / sourceHeight);
    const drawWidth = sourceWidth * scale;
    const drawHeight = sourceHeight * scale;
    context?.drawImage(video, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
  }

  function drawCover(video: HTMLVideoElement, x: number, y: number, width: number, height: number) {
    const sourceWidth = video.videoWidth || width;
    const sourceHeight = video.videoHeight || height;
    const scale = Math.max(width / sourceWidth, height / sourceHeight);
    const cropWidth = width / scale;
    const cropHeight = height / scale;
    const cropX = (sourceWidth - cropWidth) / 2;
    const cropY = (sourceHeight - cropHeight) / 2;
    context?.drawImage(video, cropX, cropY, cropWidth, cropHeight, x, y, width, height);
  }

  function roundRect(x: number, y: number, width: number, height: number, radius: number) {
    if (!context) return;
    context.beginPath();
    context.moveTo(x + radius, y);
    context.arcTo(x + width, y, x + width, y + height, radius);
    context.arcTo(x + width, y + height, x, y + height, radius);
    context.arcTo(x, y + height, x, y, radius);
    context.arcTo(x, y, x + width, y, radius);
    context.closePath();
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
