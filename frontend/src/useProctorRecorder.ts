import { getUploadUrl, heartbeat, sendEvents, uploadBlob } from "./api";
import type { ApiError } from "./api";
import {
  browserChunkBufferDeps,
  drainBuffer,
  evictToCapacity,
  openBuffer,
  pendingKey,
  resolveBufferCaps,
  type ChunkBuffer,
  type ChunkBufferDeps,
  type PendingChunk
} from "./chunkBuffer";
import { cameraTrackConstraints, shouldRecordCamera } from "./cameraRecording";
import { writeChunkHwm } from "./chunkContinuity";
import { advanceUploadChain, runUploadWithRetry } from "./chunkUploadRetry";
import { shouldSurfaceExamTime } from "./examTime";
import { captureAndUploadAlertFrame, grabTrackFrame, type FrameCaptureDeps } from "./frameCapture";
import type { EnforcementConfigPayload, EnforcementExemptions, ProctorEvent, ServerSessionStatus, SessionStartResponse, UploadManifestItem } from "./types";

// Tier-1 buffer: the per-session circuit-breaker latch. Starts from the pre-
// flight self-test; ANY runtime buffer throw flips it to "fallback" FOREVER (no
// flap-back) and the recorder routes through the UNCHANGED direct-upload floor.
export type BufferMode = "buffering" | "fallback";

// Live pending-buffer counters surfaced to the host (HealthPanel amber state +
// the end-of-test wait gate). Zeroed in fallback mode.
export type BufferStatus = {
  mode: BufferMode;
  pendingCount: number;
  pendingBytes: number;
};

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
  // Tier-1 buffer: surfaced on every buffer change (write/drain/evict/mode flip)
  // so the host can render the amber "N uploaded · M pending" HealthPanel state
  // and drive the end-of-test wait gate. Always called at least once at start().
  onBufferChange?: (status: BufferStatus) => void;
  // Tier-1 buffer: injectable IndexedDB deps (browser passes window.indexedDB;
  // tests pass a fake). Absent → browserChunkBufferDeps() resolves the real one,
  // or null (→ the session starts in FALLBACK mode, never blocked).
  bufferDeps?: ChunkBufferDeps | null;
  // Tier-1 buffer: injectable buffer (tests). Absent → openBuffer(bufferDeps).
  buffer?: ChunkBuffer | null;
  // ALERT-2: injectable last-frame capture deps (tests pass a fake ImageCapture
  // + canvas; the browser passes real ImageCapture/OffscreenCanvas). Absent →
  // grabTrackFrame's real DOM-backed defaults.
  frameCaptureDeps?: FrameCaptureDeps;
  // ALERT-2: injectable frame grabber (tests stub the whole grab so they need no
  // DOM at all). Absent → the real grabTrackFrame(track, frameCaptureDeps).
  grabFrame?: (track: MediaStreamTrack) => Promise<Blob>;
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
  // #135 take-home: the same heartbeat also carries the official start (T0), the
  // remote-mode flag, and the proctor phone, so the waiting-room countdown +
  // phone stay skew-safe and current against the live session. Optional (absent
  // off take-home / older backend) — the host treats undefineds falsy.
  onExamTimeChange?: (info: { endAt: string; serverNow: string; startAt?: string; takeHome?: boolean; proctorPhone?: string }) => void;
  // F5.3/F5.5: every heartbeat echoes the enforcement config + this session's
  // exemptions, so an admin/invigilator exemption applies live (no reload).
  onEnforcementChange?: (info: { enforcement?: EnforcementConfigPayload; exemptions?: EnforcementExemptions }) => void;
};

type RecorderControls = {
  start: () => Promise<void>;
  stop: () => Promise<UploadManifestItem[]>;
  getManifest: () => UploadManifestItem[];
  getQueueDepth: () => number;
  /** OMR P1: the live screen track's getSettings() (null before start/after
   * stop) — the marker_layout event reports the ACTUAL captured dims so the
   * P2 detector never guesses geometry. Read-only; no recorder behavior. */
  getScreenTrackSettings: () => MediaTrackSettings | null;
  // ---- Tier-1 persistent chunk buffer -------------------------------------
  /** The circuit-breaker latch: "buffering" while the buffer is healthy,
   *  "fallback" once any self-test/runtime failure degraded to the floor. */
  getBufferMode: () => BufferMode;
  /** Live pending count/bytes for THIS session (0/0 in fallback mode). Re-reads
   *  IndexedDB; the host polls this to decide the end-of-test wait gate. Never
   *  throws — a read failure degrades to fallback and returns {0,0}. */
  getBufferStatus: () => Promise<BufferStatus>;
  /** Wake the background drainer NOW (End-of-test kick). No-op in fallback. */
  kickDrain: () => void;
  /** Delete this session's buffer — ONLY after a confirmed-empty drain +
   *  successful endSession (App.tsx end sites). Best-effort, never throws. */
  clearBuffer: () => Promise<void>;
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

// Tier-1 buffer: thrown by recorder.start() ONLY when upload_config.require_buffer
// is true AND the pre-flight buffer self-test fails (IndexedDB unavailable,
// private/incognito, storage blocked, quota). The host must treat this as
// "recording did NOT start" and show the remediation message. Default
// require_buffer=false NEVER throws this — a failed self-test silently starts
// the session in FALLBACK mode (the proven floor records fine).
export class BufferRequiredError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(
      "This browser/profile can't save your recording locally as a safeguard. " +
        "Use Chrome or Edge, exit private/incognito mode, and allow this site to store data — then try again."
    );
    this.name = "BufferRequiredError";
    this.reason = reason;
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
  // ALERT-2: a rolling cache of the most-recent successfully-grabbed screen
  // frame (a single JPEG blob), refreshed on each screen chunk boundary while
  // the track is live. It is the ONLY frame source once the track has ended (the
  // share-stopped / recording-stopped alert moment), where grabFrame() can no
  // longer recover pixels. A monotonic per-session screenshot index keeps each
  // upload on a distinct key (never overwritten, never collides with the screen
  // series — server enforces its own hwm too).
  let lastScreenFrame: Blob | null = null;
  let screenshotChunkIndex = 0;
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

  // ---- Tier-1 persistent chunk buffer (strictly additive over the floor) ----
  //
  // bufferMode is the circuit-breaker latch. It starts "fallback" and is only
  // promoted to "buffering" if the pre-flight self-test passes at start(); ANY
  // runtime buffer throw demotes it back to "fallback" PERMANENTLY. While
  // "fallback" the recorder uses the EXACT pre-buffer path (enqueueUpload /
  // enqueueCameraUpload) — today's guaranteed floor, untouched.
  let bufferMode: BufferMode = "fallback";
  let buffer: ChunkBuffer | null = null;
  const caps = resolveBufferCaps(options.config);
  let drainTimer: number | undefined;
  let draining = false;
  let onlineListenerBound = false;
  // The drainer keeps running AFTER recorder.stop() so the App.tsx end-of-test
  // wait gate can empty the buffer (it polls getBufferStatus and only then calls
  // endSession). `drainDisposed` (set by clearBuffer / final teardown), NOT the
  // segment-loop `stopping` flag, is what halts draining.
  let drainDisposed = false;
  // Cached pending counters (kept in sync on every buffer op) so the host's
  // frequent HealthPanel reads don't hammer IndexedDB; getBufferStatus() does a
  // fresh authoritative read for the end-gate decision.
  let pendingCountCache = 0;
  let pendingBytesCache = 0;

  const emitBufferChange = () => {
    options.onBufferChange?.({ mode: bufferMode, pendingCount: pendingCountCache, pendingBytes: pendingBytesCache });
  };

  // Refresh the cached pending counters from IndexedDB. Never throws (a read
  // failure degrades to fallback). Safe to call frequently.
  const refreshBufferCounters = async () => {
    if (bufferMode !== "buffering" || !buffer) {
      pendingCountCache = 0;
      pendingBytesCache = 0;
      emitBufferChange();
      return;
    }
    try {
      const [count, bytes] = await Promise.all([
        buffer.count(options.sessionId),
        buffer.bytes(options.sessionId)
      ]);
      pendingCountCache = count;
      pendingBytesCache = bytes;
      emitBufferChange();
    } catch (error) {
      degradeToFallback("counter_read_failed", error);
    }
  };

  // THE CIRCUIT BREAKER. Any buffer op that throws funnels here: audit the
  // reason, LATCH fallback for the rest of the session (never flip back), zero
  // the counters, and let the caller fall through to the floor path. Recording
  // is never interrupted — this only changes which upload path future chunks
  // take. Idempotent (a second call after the latch is a cheap no-op).
  const degradeToFallback = (reason: string, error?: unknown) => {
    if (bufferMode === "fallback") return;
    bufferMode = "fallback";
    if (drainTimer) {
      window.clearTimeout(drainTimer);
      drainTimer = undefined;
    }
    pendingCountCache = 0;
    pendingBytesCache = 0;
    emit("buffer_fallback_engaged", { reason, ...(error !== undefined ? { message: String(error) } : {}) });
    emitBufferChange();
  };

  const emit = (type: string, detail?: Record<string, unknown>) => {
    const event = createEvent(type, detail);
    eventBuffer.push(event);
    options.onEvent(event);
  };

  // ---- ALERT-2: per-alert last-frame screenshot ----------------------------
  // The current LIVE screen video track, or null once it has ended/stopped.
  const liveScreenTrack = (): MediaStreamTrack | null => {
    const track = screenStream?.getVideoTracks()[0] ?? null;
    return track && track.readyState === "live" ? track : null;
  };

  // grabFrame seam: injected fake in tests, real grabTrackFrame otherwise.
  const grabFrame = (track: MediaStreamTrack): Promise<Blob> =>
    options.grabFrame
      ? options.grabFrame(track)
      : grabTrackFrame(track, options.frameCaptureDeps);

  // Refresh the rolling last-good-frame cache from the live track (best-effort:
  // any failure is swallowed and simply leaves the prior cached frame in place).
  // Called on each screen chunk boundary so the cache is at most one chunk-period
  // (~30s) stale when the share is stopped — no extra timer to manage.
  const refreshScreenFrameCache = async (): Promise<void> => {
    const track = liveScreenTrack();
    if (!track) return;
    try {
      lastScreenFrame = await grabFrame(track);
    } catch {
      // Keep the previous cached frame; a single failed grab is non-fatal.
    }
  };

  // Upload one screenshot frame via the SAME signed-PUT discipline as recording
  // chunks (a "screenshot" kind under a distinct GCS prefix, size-capped +
  // CORS-bound write URL), returning the stored object key.
  const uploadScreenshotFrame = async (frame: Blob): Promise<string> => {
    const index = ++screenshotChunkIndex;
    const upload = await getUploadUrl({
      session_id: options.sessionId,
      kind: "screenshot",
      chunk_index: index,
      content_type: frame.type || "image/jpeg"
    });
    await uploadBlob(upload.upload_url, frame, upload.max_bytes);
    return upload.storage_key;
  };

  // Capture a still for an alert moment and upload it. Returns the stored object
  // key, or null when there is no frame to send or the upload fails — it NEVER
  // throws and NEVER blocks the alert that triggered it. The frame-selection +
  // never-throw logic lives in the pure captureAndUploadAlertFrame orchestrator.
  const captureAlertScreenshot = (reason: string): Promise<string | null> =>
    captureAndUploadAlertFrame({
      liveTrack: liveScreenTrack,
      cachedFrame: () => lastScreenFrame,
      setCachedFrame: (frame) => { lastScreenFrame = frame; },
      grab: grabFrame,
      upload: uploadScreenshotFrame,
      onUploadFailed: (message) => emit("screenshot_upload_failed", { reason, message })
    });

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
  // sequence is in flight per kind and exhaustion (~67s of backoff) falls
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
        // v1.1 G3 (#7): echo the size cap the backend signed into the URL —
        // without this header the signed PUT 403s and the chunk never stores.
        await uploadBlob(fresh.upload_url, blob, fresh.max_bytes);
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

  // ---- Tier-1 buffering enqueue + drainer -----------------------------------
  //
  // In "buffering" mode every chunk is written to the durable `pending` store
  // BEFORE the live upload, deleted ONLY on a confirmed 2xx, and on a non-fatal
  // live-upload exhaustion is LEFT in `pending` (no drop) for the background
  // drainer. The live upload still rides the SAME serial per-kind chain as the
  // floor, so ordering and the one-in-flight-per-kind invariant are unchanged.
  //
  // The dispatcher each segment loop calls. Any buffer throw degrades to
  // fallback and re-routes THIS chunk through the floor — never a drop, never a
  // recording interruption.
  const routeChunk = (kind: "screen" | "camera", blob: Blob, index: number) => {
    if (bufferMode !== "buffering" || !buffer) {
      if (kind === "screen") enqueueUpload(blob, index);
      else enqueueCameraUpload(blob, index);
      return;
    }
    const startedAt = new Date().toISOString();
    const record: PendingChunk = {
      key: pendingKey(options.sessionId, kind, index),
      sessionId: options.sessionId,
      kind,
      index,
      blob,
      bytes: blob.size,
      contentType: blob.type || "video/webm",
      startedAt,
      enqueuedAt: Date.now(),
      attempts: 0
    };
    // Write-before-upload: persist durably FIRST. A write failure here is the
    // circuit-breaker's job — degrade and fall through to the floor so the
    // chunk is still attempted via the proven direct path (worst case = today).
    buffer
      .put(record)
      .then(() => {
        void refreshBufferCounters();
        enqueueBufferedLiveUpload(kind, record);
      })
      .catch((error) => {
        degradeToFallback(`buffer_put_failed:${kind}`, error);
        if (kind === "screen") enqueueUpload(blob, index);
        else enqueueCameraUpload(blob, index);
      });
  };

  // The live (fast-path) upload of a freshly-buffered chunk, sequenced on the
  // existing per-kind serial chain. On 2xx: record manifest, DELETE from
  // pending, kick the drainer (the path is proven healthy → flush the backlog).
  // On non-fatal exhaustion: LEAVE it in pending (the drainer owns it). A fatal
  // status routes through handleFatalStatus exactly like the floor.
  const enqueueBufferedLiveUpload = (kind: "screen" | "camera", record: PendingChunk) => {
    queueDepth += 1;
    updateUploadState();
    const onSettled = () => {
      queueDepth = Math.max(0, queueDepth - 1);
      updateUploadState();
    };
    const run = async () => {
      const { upload, retried } = await uploadChunkWithRetry(kind, record.blob, record.index);
      manifest.push({
        kind,
        index: record.index,
        storage_key: upload.storage_key,
        bytes: record.bytes,
        started_at: record.startedAt,
        completed_at: new Date().toISOString()
      });
      uploadedCount += 1;
      emit("chunk_uploaded", { kind, index: record.index, bytes: record.bytes, storage_key: upload.storage_key, ...(retried ? { retried } : {}) });
      // Durability invariant: only delete once provably in GCS.
      try {
        await buffer!.delete(record.key);
        void refreshBufferCounters();
      } catch (error) {
        degradeToFallback("buffer_delete_failed", error);
      }
      // A healthy live upload proves the path — flush anything the buffer holds.
      kickDrain();
    };
    const onError = (error: unknown) => {
      const fatal = fatalStatusFromError(error);
      if (fatal) {
        // Session no longer writable — surface exactly like the floor.
        emit("upload_error", { kind, index: record.index, bytes: record.bytes, message: String(error) });
        handleFatalStatus(fatal);
        return;
      }
      // Non-fatal exhaustion: NOT a drop. The chunk stays in `pending`; the
      // drainer keeps retrying. Emit chunk_buffered (the "saved, will retry"
      // semantic that replaces the lossy upload_error on the buffering path).
      emit("chunk_buffered", { kind, index: record.index, bytes: record.bytes, reason: "live_upload_failed", message: String(error) });
      void refreshBufferCounters();
      void enforceCap();
      scheduleDrain();
    };
    if (kind === "screen") {
      uploadQueue = advanceUploadChain(uploadQueue, {
        run,
        onError,
        isFatal: (error) => fatalStatusFromError(error) !== null,
        onSettled
      });
    } else {
      // Camera chain keeps its swallow-everything inline form (a fatal status
      // still self-stops via handleFatalStatus inside onError).
      cameraUploadQueue = cameraUploadQueue.then(run).catch(onError).finally(onSettled);
    }
  };

  // Cap + evict: when the session's buffer is over EITHER cap, evict the OLDEST
  // pending chunk (sliding window of the most-recent footage) and emit the loud
  // chunk_buffer_evicted audit. This is the ONLY remaining bounded loss, only
  // after a long sustained outage. Never throws (degrades to fallback).
  const enforceCap = async () => {
    if (bufferMode !== "buffering" || !buffer) return;
    try {
      await evictToCapacity(buffer, options.sessionId, caps, (evicted, reason) => {
        emit("chunk_buffer_evicted", { kind: evicted.kind, index: evicted.index, bytes: evicted.bytes, reason });
      });
      await refreshBufferCounters();
    } catch (error) {
      degradeToFallback("buffer_evict_failed", error);
    }
  };

  // Background drainer: oldest-first, serialized so a drain PUT never races a
  // live PUT on the same key. MVP re-mints a fresh signed URL via getUploadUrl
  // for each drain (the backend hwm guard maps it to an unused key — never an
  // overwrite) and records the RETURNED storage_key in the manifest; playback
  // orders by the manifest (real time / started_at), NOT the numeric key, so a
  // re-keyed chunk still plays in the right place (recordingPlaylist.buildPlaylist
  // sorts by last_modified-anchored offset). Reusing a stored unexpired signed
  // URL is a deferred optimization, not needed for correctness. A fatal status
  // (401/403/409) stops draining; non-fatal failures leave the chunk in
  // `pending` (attempts bumped) for the next wake.
  const drainOnce = async () => {
    if (bufferMode !== "buffering" || !buffer || drainDisposed || draining || fatalStatusHandled) return;
    draining = true;
    try {
      // Oldest-first, fatal-stop drain (pure orchestration in chunkBuffer.ts).
      // drainRecord serializes each PUT behind the live per-kind chain so a drain
      // never races a live upload on the same key.
      await drainBuffer(
        buffer,
        options.sessionId,
        (record) => drainRecord(record),
        () => bufferMode === "buffering" && !fatalStatusHandled && !drainDisposed
      );
      await refreshBufferCounters();
    } catch (error) {
      degradeToFallback("buffer_drain_failed", error);
    } finally {
      draining = false;
    }
  };

  // Upload one buffered record (drain path). Returns "ok" (uploaded+deleted),
  // "retry" (non-fatal failure, left in pending), or "fatal" (stop draining).
  const drainRecord = async (record: PendingChunk): Promise<"ok" | "retry" | "fatal"> => {
    const chainKey = record.kind === "screen" ? "screen" : "camera";
    const doUpload = async (): Promise<"ok" | "retry" | "fatal"> => {
      try {
        // Re-check the buffer right before re-minting a URL. The drainer's
        // listOldest is a standalone read; if it picked up a record whose LIVE
        // upload was still in-flight, that live run deletes the key on its 2xx
        // BEFORE this chained drain doUpload runs (both share the per-kind serial
        // chain). If the key is already GONE, the live upload finished the job —
        // re-minting here would upload a DUPLICATE segment (the backend hwm guard
        // re-keys to hwm+1) and inflate chunk_count + duration. So no-op: don't
        // re-mint, don't upload, don't push a manifest entry, don't bump attempts
        // or emit chunk_drained. Just let the drain chain advance.
        const stillPending = await buffer!.get(record.key);
        if (!stillPending) return "ok";
        const fresh = await getUploadUrl({
          session_id: options.sessionId,
          kind: chainKey,
          chunk_index: record.index,
          content_type: record.contentType || "video/webm"
        });
        // v1.1 G3 (#7): echo the signed size cap on the drain path too — same
        // 403-on-missing-header rule as the live upload above.
        await uploadBlob(fresh.upload_url, record.blob, fresh.max_bytes);
        manifest.push({
          kind: record.kind,
          index: record.index,
          storage_key: fresh.storage_key,
          bytes: record.bytes,
          started_at: record.startedAt,
          completed_at: new Date().toISOString()
        });
        uploadedCount += 1;
        updateUploadState();
        emit("chunk_drained", { kind: record.kind, index: record.index, attempts: record.attempts + 1, buffered_ms: Date.now() - record.enqueuedAt });
        await buffer!.delete(record.key);
        return "ok";
      } catch (error) {
        const fatal = fatalStatusFromError(error);
        if (fatal) {
          emit("upload_error", { kind: record.kind, index: record.index, bytes: record.bytes, message: String(error) });
          handleFatalStatus(fatal);
          return "fatal";
        }
        // Non-fatal: bump attempts + lastError, leave it in pending.
        try {
          await buffer!.put({ ...record, attempts: record.attempts + 1, lastError: String(error) });
        } catch (putError) {
          degradeToFallback("buffer_reput_failed", putError);
          return "fatal";
        }
        return "retry";
      }
    };
    // Sequence the drain PUT onto the same per-kind serial tail as live uploads
    // (so a drain PUT never races a live PUT on the same key). doUpload swallows
    // its own errors and returns the outcome; the chained promise resolves to it.
    let result: Promise<"ok" | "retry" | "fatal">;
    if (chainKey === "screen") {
      result = uploadQueue.then(doUpload, doUpload);
      uploadQueue = result.then(() => undefined, () => undefined);
    } else {
      result = cameraUploadQueue.then(doUpload, doUpload);
      cameraUploadQueue = result.then(() => undefined, () => undefined);
    }
    const outcome = await result;
    if (outcome === "ok") await refreshBufferCounters();
    return outcome;
  };

  const kickDrain = () => {
    if (bufferMode !== "buffering" || drainDisposed) return;
    void drainOnce();
  };

  // ~12s timer backstop ('online' lies on captive-portal/lab-NAT recovery).
  // Keeps running across recorder.stop() so the end-of-test wait gate drains.
  const scheduleDrain = () => {
    if (bufferMode !== "buffering" || drainDisposed) return;
    if (drainTimer) return;
    drainTimer = window.setTimeout(() => {
      drainTimer = undefined;
      void drainOnce().finally(() => {
        // Reschedule only while there is still a backlog and we're healthy.
        if (bufferMode === "buffering" && !drainDisposed && pendingCountCache > 0) scheduleDrain();
      });
    }, 12_000);
  };

  const onOnline = () => kickDrain();

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
        fullscreen: Boolean(document.fullscreenElement),
        // Tier-1: persisted on the session doc next to upload_queue_depth so a
        // post-exam audit can see how much footage was buffered (no admin UI
        // tonight; Tier-2 renders the per-candidate indicator). 0 in fallback.
        buffer_pending_chunks: pendingCountCache,
        buffer_pending_bytes: pendingBytesCache
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
        // S5: surface the current exam end time on every heartbeat. #135: also
        // surface the start (T0) + remote-mode flag + proctor phone, so a take-
        // home session refreshes them even when no end_at is set. The start_at-
        // only arm is gated on take_home so a normal (non-remote) session — for
        // which the backend now ALSO always emits start_at — stays byte-identical
        // to its pre-#135 behavior (fires only on end_at, no extra state write).
        if (shouldSurfaceExamTime({ endAt: response.end_at, startAt: response.start_at, takeHome: response.take_home })) {
          options.onExamTimeChange?.({
            endAt: response.end_at ?? "",
            serverNow: response.server_now ?? "",
            startAt: response.start_at,
            takeHome: response.take_home,
            proctorPhone: response.proctor_contact_phone
          });
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

  // Tier-1 pre-flight capability gate. Open the buffer + run a write→read→delete
  // self-test. Pass → bufferMode "buffering" (durability on). Fail → stay
  // "fallback" (the floor records fine) and emit buffer_fallback_engaged; only
  // when require_buffer is set does a failure THROW (the host blocks start with
  // remediation). Never throws otherwise — a candidate is never blocked by a
  // missing buffer. Resume-across-reload: a healthy buffer that already holds
  // pending chunks for this session immediately wakes the drainer.
  const initBuffer = async () => {
    const requireBuffer = options.config.require_buffer === true;
    let ok = false;
    let reason = "unknown";
    try {
      const deps = options.bufferDeps !== undefined ? options.bufferDeps : browserChunkBufferDeps();
      if (options.buffer) {
        buffer = options.buffer;
      } else if (deps) {
        buffer = await openBuffer(deps);
      } else {
        buffer = null;
        reason = "indexeddb_unavailable";
      }
      if (buffer) {
        ok = await buffer.selfTest();
        if (!ok) reason = "selftest_failed";
      }
    } catch (error) {
      ok = false;
      reason = "buffer_open_failed";
      emit("buffer_fallback_engaged", { reason, message: String(error) });
    }
    if (ok && buffer) {
      bufferMode = "buffering";
      if (!onlineListenerBound) {
        window.addEventListener("online", onOnline);
        onlineListenerBound = true;
      }
      await refreshBufferCounters();
      // Resume-across-reload: flush any chunks left from a prior stint/reload.
      kickDrain();
      scheduleDrain();
    } else {
      bufferMode = "fallback";
      if (buffer) {
        // We opened it but the self-test failed — close the handle.
        try {
          buffer.close();
        } catch {
          /* best-effort */
        }
      }
      buffer = null;
      if (reason !== "buffer_open_failed") {
        emit("buffer_fallback_engaged", { reason });
      }
      emitBufferChange();
      if (requireBuffer) {
        throw new BufferRequiredError(reason);
      }
    }
  };

  const controls: RecorderControls = {
    async start() {
      // Tier-1: run the buffer capability gate FIRST. A require_buffer block
      // throws here (before any screen-share prompt). A normal failed self-test
      // silently degrades to fallback and recording proceeds.
      await initBuffer();
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
        // ALERT-2: the track is ALREADY ended here, so the capture relies on the
        // cached last-good frame (a live grab is impossible). Attach the stored
        // key to the SAME event that becomes the server-side alert. Capture is
        // awaited only to thread the key in; the user-facing onFatalError still
        // fires (after, unchanged) regardless of capture outcome, so the alert /
        // recovery path is never blocked by a missing or failed screenshot.
        void captureAlertScreenshot("track_ended").then((screenshotKey) => {
          emit("screen_share_stopped", {
            reason: "track_ended",
            ...(screenshotKey ? { screenshot_key: screenshotKey } : {})
          });
          options.onFatalError("Screen sharing stopped. Return to the proctor app immediately.");
        });
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
    },
    getScreenTrackSettings() {
      return screenStream?.getVideoTracks()[0]?.getSettings() ?? null;
    },
    getBufferMode() {
      return bufferMode;
    },
    async getBufferStatus() {
      if (bufferMode !== "buffering" || !buffer) {
        return { mode: bufferMode, pendingCount: 0, pendingBytes: 0 };
      }
      try {
        const [count, bytes] = await Promise.all([
          buffer.count(options.sessionId),
          buffer.bytes(options.sessionId)
        ]);
        pendingCountCache = count;
        pendingBytesCache = bytes;
        emitBufferChange();
        return { mode: bufferMode, pendingCount: count, pendingBytes: bytes };
      } catch (error) {
        degradeToFallback("buffer_status_read_failed", error);
        return { mode: "fallback", pendingCount: 0, pendingBytes: 0 };
      }
    },
    kickDrain() {
      kickDrain();
    },
    async clearBuffer() {
      // Called by App.tsx ONLY after a confirmed-empty drain + successful
      // endSession. Dispose the drainer, then best-effort delete + close.
      drainDisposed = true;
      if (drainTimer) {
        window.clearTimeout(drainTimer);
        drainTimer = undefined;
      }
      if (onlineListenerBound) {
        window.removeEventListener("online", onOnline);
        onlineListenerBound = false;
      }
      if (!buffer) return;
      try {
        await buffer.clear(options.sessionId);
      } catch {
        /* best-effort — a residual record is harmless (cleared next session) */
      }
      try {
        buffer.close();
      } catch {
        /* best-effort */
      }
      buffer = null;
      pendingCountCache = 0;
      pendingBytesCache = 0;
      emitBufferChange();
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
        // Tier-1: buffering mode writes-to-pending first then live-uploads;
        // fallback mode routes through the UNCHANGED enqueueUpload floor.
        routeChunk("screen", event.data, index);
        // ALERT-2: piggyback the chunk cadence to refresh the last-good-frame
        // cache (best-effort, off the hot path — fire-and-forget so it never
        // delays the chunk upload). This is the frame served if the share is
        // later stopped, where a live grab is no longer possible.
        void refreshScreenFrameCache();
      }
    });
    recorder.addEventListener("error", (event) => {
      updateMediaState("screen", "error");
      // ALERT-2: on a recorder error the screen track is usually STILL LIVE, so
      // captureAlertScreenshot grabs a fresh frame (falling back to the cache).
      // Attach the stored key to the recording_error event that becomes the
      // server-side alert. Capture never blocks the alert (key omitted on
      // no-frame/upload-failure).
      void captureAlertScreenshot("recording_error").then((screenshotKey) => {
        emit("recording_error", {
          kind: "screen",
          message: String(event),
          ...(screenshotKey ? { screenshot_key: screenshotKey } : {})
        });
      });
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
        // Tier-1: buffering writes-to-pending first; fallback uses the
        // UNCHANGED enqueueCameraUpload floor.
        routeChunk("camera", event.data, index);
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
