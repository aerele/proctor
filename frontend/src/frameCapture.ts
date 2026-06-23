// frontend/src/frameCapture.ts — ALERT-2 last-frame capture helper (pure,
// unit-testable). Grabs a single JPEG still from a LIVE screen-capture video
// track so a proctoring alert can carry an image of the screen at the alert
// moment.
//
// Why this exists / the hard case it does NOT solve here: once a screen track
// fires "ended" (the candidate clicked the browser "Stop sharing" chrome) its
// readyState becomes "ended" and the pixels are gone — grabFrame() then rejects
// and NO capture path can recover the frame. This helper therefore REJECTS on a
// non-live track by design; the recording-stopped case is handled UPSTREAM in
// useProctorRecorder.ts by serving a periodically-refreshed "last good frame"
// cache (captured moments before the stop). This module only knows how to turn
// a live track into a JPEG blob.
//
// Dependency injection mirrors the recorder's existing seam style
// (ChunkBufferDeps / bufferDeps): tests inject a fake ImageCapture + fake canvas
// so the success / fallback / failure paths run in pure node with NO real DOM.

// Minimal structural type for the experimental ImageCapture API — it is NOT in
// the TS DOM lib, so we declare exactly the surface we use rather than reach for
// `any`.
export interface ImageCaptureLike {
  grabFrame(): Promise<ImageBitmap>;
}

export type ImageCaptureCtor = (track: MediaStreamTrack) => ImageCaptureLike;

// A drawable + encodable 2D canvas surface (covers both OffscreenCanvas and a
// detached HTMLCanvasElement). Only the members the helper touches are typed.
export interface CanvasLike {
  width: number;
  height: number;
  getContext(contextId: "2d"): CanvasDrawLike | null;
  // OffscreenCanvas
  convertToBlob?: (options?: { type?: string; quality?: number }) => Promise<Blob>;
  // HTMLCanvasElement
  toBlob?: (callback: (blob: Blob | null) => void, type?: string, quality?: number) => void;
}

export interface CanvasDrawLike {
  drawImage(image: CanvasImageSource, dx: number, dy: number, dw?: number, dh?: number): void;
}

export interface FrameCaptureDeps {
  // Construct an ImageCapture for a track. `null` (or omitted) => the primary
  // path is unavailable in this environment and the helper rejects (the caller
  // falls back to its cached frame). Real wiring passes a thin
  // `(t) => new ImageCapture(t)` when `"ImageCapture" in window`.
  createImageCapture?: ImageCaptureCtor | null;
  // Allocate a canvas of the given size. Real wiring prefers OffscreenCanvas,
  // falling back to a detached <canvas>.
  createCanvas?: (width: number, height: number) => CanvasLike;
}

// Evidence, not fidelity: cap width and use a low JPEG quality so the upload is
// small (the screen stream is already ~4 fps / ≤960 px wide — see
// SETUP_SCREEN_CONSTRAINTS / uploadConfig.max_width).
export const FRAME_MAX_WIDTH = 960;
export const FRAME_JPEG_QUALITY = 0.6;
const FRAME_MIME = "image/jpeg";

function defaultCreateImageCapture(): ImageCaptureCtor | null {
  if (typeof globalThis !== "undefined" && "ImageCapture" in globalThis) {
    // The real global ImageCapture constructor (now in the DOM lib); cast through
    // unknown to the minimal structural ctor we use (grabFrame only).
    const Ctor = (globalThis as unknown as {
      ImageCapture: new (t: MediaStreamTrack) => ImageCaptureLike;
    }).ImageCapture;
    return (track) => new Ctor(track);
  }
  return null;
}

function defaultCreateCanvas(width: number, height: number): CanvasLike {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height) as unknown as CanvasLike;
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas as unknown as CanvasLike;
}

// Encode a drawn canvas to a JPEG blob, supporting both OffscreenCanvas
// (convertToBlob) and HTMLCanvasElement (toBlob).
async function canvasToJpeg(canvas: CanvasLike): Promise<Blob> {
  if (typeof canvas.convertToBlob === "function") {
    return canvas.convertToBlob({ type: FRAME_MIME, quality: FRAME_JPEG_QUALITY });
  }
  if (typeof canvas.toBlob === "function") {
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob!(
        (blob) => (blob ? resolve(blob) : reject(new Error("canvas toBlob produced no blob"))),
        FRAME_MIME,
        FRAME_JPEG_QUALITY
      );
    });
  }
  throw new Error("canvas has no blob-encode method");
}

// Draw a captured bitmap into a (possibly down-scaled) canvas and encode it as a
// JPEG blob.
async function bitmapToJpeg(
  bitmap: ImageBitmap,
  createCanvas: (width: number, height: number) => CanvasLike
): Promise<Blob> {
  const srcWidth = bitmap.width || FRAME_MAX_WIDTH;
  const srcHeight = bitmap.height || Math.round(FRAME_MAX_WIDTH * 9 / 16);
  const scale = srcWidth > FRAME_MAX_WIDTH ? FRAME_MAX_WIDTH / srcWidth : 1;
  const width = Math.max(1, Math.round(srcWidth * scale));
  const height = Math.max(1, Math.round(srcHeight * scale));

  const canvas = createCanvas(width, height);
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("could not acquire 2d canvas context");
  ctx.drawImage(bitmap as unknown as CanvasImageSource, 0, 0, width, height);
  try {
    return await canvasToJpeg(canvas);
  } finally {
    // Release the decoded bitmap promptly (best-effort — fake bitmaps in tests
    // may omit close()).
    (bitmap as Partial<ImageBitmap>).close?.();
  }
}

/**
 * Grab a single JPEG still from a LIVE screen-capture video track.
 *
 * Rejects when:
 *  - the track is not live (`readyState !== "live"`) — an ended track has no
 *    pixels; the caller must use its cached last-frame instead;
 *  - no ImageCapture path is available in this environment;
 *  - the underlying grab / draw / encode fails.
 *
 * The recording-stopped requirement is met by the CALLER keeping a refreshed
 * cache of the most recent successful grab — see useProctorRecorder.ts.
 */
export async function grabTrackFrame(
  track: MediaStreamTrack | null | undefined,
  deps: FrameCaptureDeps = {}
): Promise<Blob> {
  if (!track || track.readyState !== "live") {
    throw new Error("frame capture requires a live video track");
  }
  const createImageCapture = deps.createImageCapture === undefined
    ? defaultCreateImageCapture()
    : deps.createImageCapture;
  if (!createImageCapture) {
    // No capture path (e.g. a browser without ImageCapture and no injected
    // fallback). The caller treats this like any other grab failure.
    throw new Error("no frame-capture path available (ImageCapture unsupported)");
  }
  const createCanvas = deps.createCanvas ?? defaultCreateCanvas;

  const capture = createImageCapture(track);
  const bitmap = await capture.grabFrame();
  return bitmapToJpeg(bitmap, createCanvas);
}

// ---- Alert-screenshot orchestration (pure, DOM-free) ----------------------
// The decision logic the recorder runs when an alert fires: pick the frame
// (fresh grab if the track is still live, else the cached last-good frame),
// upload it via the signed-PUT seam, and return the stored key — or null when
// there is no frame or the upload fails. NEVER throws: a screenshot must never
// block or perturb the alert that triggered it. Extracted here so it is unit-
// testable without a DOM (the recorder injects the real grab/upload/emit).

export interface AlertScreenshotIO {
  // The current LIVE screen track, or null once it has ended/stopped.
  liveTrack: () => MediaStreamTrack | null;
  // The cached last-good frame (captured moments before a stop), or null.
  cachedFrame: () => Blob | null;
  // Persist a freshly-grabbed frame back into the cache.
  setCachedFrame: (frame: Blob) => void;
  // Grab a fresh frame from a live track (rejects on failure).
  grab: (track: MediaStreamTrack) => Promise<Blob>;
  // Upload the frame and resolve the stored object key (rejects on failure).
  upload: (frame: Blob) => Promise<string>;
  // Emit a diagnostic event on upload failure (never throws).
  onUploadFailed: (message: string) => void;
}

export async function captureAndUploadAlertFrame(io: AlertScreenshotIO): Promise<string | null> {
  // Prefer a fresh grab while the track is still live (e.g. recording_error);
  // on a share/recording STOP the track is already ended, so the cache — the
  // frame captured moments before — is the only possible source.
  const track = io.liveTrack();
  let frame: Blob | null = io.cachedFrame();
  if (track) {
    try {
      frame = await io.grab(track);
      io.setCachedFrame(frame);
    } catch {
      frame = io.cachedFrame();
    }
  }
  if (!frame) return null;
  try {
    return await io.upload(frame);
  } catch (error) {
    io.onUploadFailed(String(error));
    return null;
  }
}

// M3: ceiling on how long a user-facing recovery (onFatalError "Screen sharing
// stopped…") may wait on the best-effort screenshot. captureAndUploadAlertFrame
// awaits getUploadUrl + uploadBlob, and NEITHER has a network timeout, so a
// stalled/slow upload would otherwise strand the candidate on a chrome-less
// fullscreen idle screen with no way to re-share until the fetch finally errors
// — directly contradicting ALERT-2's "capture never blocks recovery" claim.
export const ALERT_SCREENSHOT_CEILING_MS = 2500;

// Race a (best-effort, never-throwing) screenshot capture against a short
// ceiling. Resolves the stored object key if the capture settles within the
// ceiling, else null when the ceiling wins first. The capture promise is NOT
// aborted when the ceiling wins — it settles in the background (so a slow upload
// still lands its object eventually), it just stops gating the recovery
// decision. NEVER throws: captureAndUploadAlertFrame already swallows its own
// failures into null, and a stray rejection (defensive) is treated as "no key".
export function captureAlertFrameWithCeiling(
  capture: Promise<string | null>,
  ceilingMs: number = ALERT_SCREENSHOT_CEILING_MS,
  setTimeoutFn: (cb: () => void, ms: number) => unknown = (cb, ms) => setTimeout(cb, ms),
  clearTimeoutFn: (handle: unknown) => void = (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0])
): Promise<string | null> {
  let timer: unknown;
  const ceiling = new Promise<null>((resolve) => {
    timer = setTimeoutFn(() => resolve(null), ceilingMs);
  });
  // Defensive `.catch` — the production capture never rejects, but this keeps
  // the race itself from ever surfacing a rejection into the recovery path.
  const settled = capture.catch(() => null);
  return Promise.race([settled, ceiling]).then((key) => {
    clearTimeoutFn(timer);
    return key;
  });
}
