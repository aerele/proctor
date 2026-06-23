// frontend/src/frameCapture.test.ts — ALERT-2 last-frame capture helper.
// Runs in pure node (NO jsdom): every DOM dependency (ImageCapture, canvas,
// bitmap, Blob encode) is injected via FrameCaptureDeps, mirroring the
// dependency-injection style of chunkBuffer.test.ts.
import { describe, expect, it, vi } from "vitest";
import {
  ALERT_SCREENSHOT_CEILING_MS,
  captureAlertFrameWithCeiling,
  captureAndUploadAlertFrame,
  grabTrackFrame,
  type AlertScreenshotIO,
  type CanvasLike,
  type FrameCaptureDeps,
  type ImageCaptureLike
} from "./frameCapture";

// A live / ended track stub — only the fields grabTrackFrame reads.
function fakeTrack(readyState: MediaStreamTrack["readyState"] = "live"): MediaStreamTrack {
  return { readyState } as MediaStreamTrack;
}

// A fake ImageBitmap with a recorded close().
function fakeBitmap(width = 1920, height = 1080) {
  const close = vi.fn();
  return { bitmap: { width, height, close } as unknown as ImageBitmap, close };
}

// A fake canvas that records drawImage + encodes via convertToBlob
// (OffscreenCanvas path). drawn lets a test assert the bitmap was drawn.
function fakeCanvas(blob: Blob = new Blob(["jpeg-bytes"], { type: "image/jpeg" })) {
  const drawImage = vi.fn();
  const convertToBlob = vi.fn(async () => blob);
  const canvas: CanvasLike = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage }),
    convertToBlob
  };
  return { canvas, drawImage, convertToBlob };
}

describe("grabTrackFrame", () => {
  it("grabs a JPEG blob from a live track via ImageCapture + canvas (success path)", async () => {
    const { bitmap, close } = fakeBitmap();
    const grabFrame = vi.fn(async () => bitmap);
    const { canvas, drawImage, convertToBlob } = fakeCanvas();
    const createCanvas = vi.fn(() => canvas);
    const deps: FrameCaptureDeps = {
      createImageCapture: () => ({ grabFrame } as ImageCaptureLike),
      createCanvas
    };

    const out = await grabTrackFrame(fakeTrack("live"), deps);

    expect(grabFrame).toHaveBeenCalledOnce();
    expect(drawImage).toHaveBeenCalledOnce();
    expect(convertToBlob).toHaveBeenCalledWith({ type: "image/jpeg", quality: 0.6 });
    expect(out.type).toBe("image/jpeg");
    // 1920px source is downscaled to the 960px cap.
    expect(createCanvas).toHaveBeenCalledWith(960, 540);
    // The decoded bitmap is released.
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects on a non-live (ended) track — the recording-stopped case must use the cache", async () => {
    const deps: FrameCaptureDeps = {
      createImageCapture: () => ({ grabFrame: vi.fn() } as ImageCaptureLike),
      createCanvas: () => fakeCanvas().canvas
    };
    await expect(grabTrackFrame(fakeTrack("ended"), deps)).rejects.toThrow(/live video track/);
  });

  it("rejects on a null/undefined track", async () => {
    await expect(grabTrackFrame(null)).rejects.toThrow(/live video track/);
    await expect(grabTrackFrame(undefined)).rejects.toThrow(/live video track/);
  });

  it("rejects when no capture path is available (ImageCapture unsupported, no injected fallback)", async () => {
    // createImageCapture explicitly null => the environment lacks ImageCapture.
    const deps: FrameCaptureDeps = { createImageCapture: null };
    await expect(grabTrackFrame(fakeTrack("live"), deps)).rejects.toThrow(/no frame-capture path/);
  });

  it("rejects when grabFrame throws (capture failure bubbles to the caller's fallback)", async () => {
    const grabFrame = vi.fn(async () => {
      throw new Error("grab boom");
    });
    const deps: FrameCaptureDeps = {
      createImageCapture: () => ({ grabFrame } as ImageCaptureLike),
      createCanvas: () => fakeCanvas().canvas
    };
    await expect(grabTrackFrame(fakeTrack("live"), deps)).rejects.toThrow(/grab boom/);
  });

  it("uses the HTMLCanvasElement toBlob path when convertToBlob is absent", async () => {
    const { bitmap } = fakeBitmap(640, 480);
    const blob = new Blob(["j"], { type: "image/jpeg" });
    const drawImage = vi.fn();
    const toBlob = vi.fn((cb: (b: Blob | null) => void) => cb(blob));
    const canvas: CanvasLike = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }),
      toBlob
    };
    const deps: FrameCaptureDeps = {
      createImageCapture: () => ({ grabFrame: async () => bitmap } as ImageCaptureLike),
      createCanvas: () => canvas
    };

    const out = await grabTrackFrame(fakeTrack("live"), deps);
    expect(toBlob).toHaveBeenCalledOnce();
    expect(out.type).toBe("image/jpeg");
    // 640px is already under the 960 cap → no downscale.
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 640, 480);
  });

  it("rejects when toBlob yields null (encode failure)", async () => {
    const { bitmap } = fakeBitmap(640, 480);
    const canvas: CanvasLike = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: vi.fn() }),
      toBlob: (cb: (b: Blob | null) => void) => cb(null)
    };
    const deps: FrameCaptureDeps = {
      createImageCapture: () => ({ grabFrame: async () => bitmap } as ImageCaptureLike),
      createCanvas: () => canvas
    };
    await expect(grabTrackFrame(fakeTrack("live"), deps)).rejects.toThrow(/no blob/);
  });

  it("rejects when the 2d context cannot be acquired", async () => {
    const { bitmap } = fakeBitmap();
    const canvas: CanvasLike = {
      width: 0,
      height: 0,
      getContext: () => null,
      convertToBlob: async () => new Blob()
    };
    const deps: FrameCaptureDeps = {
      createImageCapture: () => ({ grabFrame: async () => bitmap } as ImageCaptureLike),
      createCanvas: () => canvas
    };
    await expect(grabTrackFrame(fakeTrack("live"), deps)).rejects.toThrow(/2d canvas context/);
  });
});

// captureAndUploadAlertFrame — the recorder's frame-selection + upload decision,
// covering the three paths BU-4 calls out: live-track fresh grab, recording-
// stopped (ended track → cache), and never-block (no-frame / upload-failure).
describe("captureAndUploadAlertFrame", () => {
  const freshFrame = new Blob(["fresh"], { type: "image/jpeg" });
  const cachedFrame = new Blob(["cached"], { type: "image/jpeg" });
  const liveTrack = fakeTrack("live");

  function makeIO(over: Partial<AlertScreenshotIO> = {}): {
    io: AlertScreenshotIO;
    grab: ReturnType<typeof vi.fn>;
    upload: ReturnType<typeof vi.fn>;
    setCachedFrame: ReturnType<typeof vi.fn>;
    onUploadFailed: ReturnType<typeof vi.fn>;
  } {
    const grab = vi.fn(async () => freshFrame);
    const upload = vi.fn(async () => "contests/c/sessions/u/s/screenshot/chunk-00001.jpg");
    const setCachedFrame = vi.fn();
    const onUploadFailed = vi.fn();
    const io: AlertScreenshotIO = {
      liveTrack: () => liveTrack,
      cachedFrame: () => cachedFrame,
      setCachedFrame,
      grab,
      upload,
      onUploadFailed,
      ...over
    };
    return { io, grab, upload, setCachedFrame, onUploadFailed };
  }

  it("grabs a FRESH frame when the track is still live (recording_error case) and uploads it", async () => {
    const { io, grab, upload, setCachedFrame } = makeIO();
    const key = await captureAndUploadAlertFrame(io);
    expect(grab).toHaveBeenCalledWith(liveTrack);
    expect(setCachedFrame).toHaveBeenCalledWith(freshFrame);
    expect(upload).toHaveBeenCalledWith(freshFrame);
    expect(key).toMatch(/screenshot\/chunk-00001\.jpg$/);
  });

  it("uses the CACHED frame when the track has already ended (recording-stopped case)", async () => {
    const { io, grab, upload } = makeIO({ liveTrack: () => null });
    const key = await captureAndUploadAlertFrame(io);
    expect(grab).not.toHaveBeenCalled(); // no live track → no grab attempt
    expect(upload).toHaveBeenCalledWith(cachedFrame);
    expect(key).toBeTruthy();
  });

  it("falls back to the cached frame when a live grab fails", async () => {
    const grab = vi.fn(async () => {
      throw new Error("grab failed");
    });
    const { io, upload } = makeIO({ grab });
    await captureAndUploadAlertFrame(io);
    expect(upload).toHaveBeenCalledWith(cachedFrame);
  });

  it("returns null without uploading when there is NO frame at all (alert still fires)", async () => {
    const { io, upload } = makeIO({ liveTrack: () => null, cachedFrame: () => null });
    const key = await captureAndUploadAlertFrame(io);
    expect(upload).not.toHaveBeenCalled();
    expect(key).toBeNull();
  });

  it("returns null and emits on upload failure — never throws (never blocks the alert)", async () => {
    const upload = vi.fn(async () => {
      throw new Error("upload 500");
    });
    const { io, onUploadFailed } = makeIO({ upload });
    const key = await captureAndUploadAlertFrame(io);
    expect(key).toBeNull();
    expect(onUploadFailed).toHaveBeenCalledWith("Error: upload 500");
  });
});

// M3 — the user-facing recovery (onFatalError) must never wait on a stalled
// screenshot upload. captureAlertFrameWithCeiling races the best-effort capture
// against a short ceiling and resolves the instant EITHER settles. The timer is
// injected so these tests are deterministic (no real 2.5s wait).
describe("captureAlertFrameWithCeiling", () => {
  // A controllable fake timer: tests fire the pending callback by calling tick().
  function fakeTimer() {
    let pending: (() => void) | null = null;
    const setTimeoutFn = vi.fn((cb: () => void, _ms: number) => {
      pending = cb;
      return 1 as unknown;
    });
    const clearTimeoutFn = vi.fn();
    return { setTimeoutFn, clearTimeoutFn, tick: () => pending?.() };
  }

  it("resolves with the key when the capture settles before the ceiling", async () => {
    const { setTimeoutFn, clearTimeoutFn } = fakeTimer();
    const capture = Promise.resolve("contests/c/sessions/u/s/screenshot/chunk-00001.jpg");
    const key = await captureAlertFrameWithCeiling(capture, 2500, setTimeoutFn, clearTimeoutFn);
    expect(key).toMatch(/screenshot\/chunk-00001\.jpg$/);
    // The pending ceiling timer is cleared once the race settles.
    expect(clearTimeoutFn).toHaveBeenCalledOnce();
  });

  it("resolves null (recovery proceeds) when a slow/never-resolving upload is still pending at the ceiling", async () => {
    const { setTimeoutFn, clearTimeoutFn, tick } = fakeTimer();
    // A capture that NEVER resolves — models a stalled getUploadUrl/uploadBlob
    // with no network timeout. Recovery must NOT hang on it.
    let captureResolved = false;
    const neverResolves = new Promise<string | null>(() => {
      /* intentionally never settles */
    }).then((k) => {
      captureResolved = true;
      return k;
    });
    const racePromise = captureAlertFrameWithCeiling(neverResolves, 2500, setTimeoutFn, clearTimeoutFn);
    // Fire the ceiling: the race must settle to null even though the upload is
    // still in flight (it settles in the background, never gating recovery).
    tick();
    const key = await racePromise;
    expect(key).toBeNull();
    expect(captureResolved).toBe(false);
    expect(setTimeoutFn).toHaveBeenCalledWith(expect.any(Function), 2500);
  });

  it("never throws even if the capture promise rejects (defensive — recovery still proceeds)", async () => {
    const { setTimeoutFn, clearTimeoutFn } = fakeTimer();
    const rejecting = Promise.reject(new Error("unexpected capture throw"));
    const key = await captureAlertFrameWithCeiling(rejecting, 2500, setTimeoutFn, clearTimeoutFn);
    expect(key).toBeNull();
  });

  it("threads the key through when the slow upload finishes JUST under the ceiling", async () => {
    const { setTimeoutFn, clearTimeoutFn } = fakeTimer();
    const capture = Promise.resolve<string | null>("key-123");
    // Ceiling never fires (timer left pending) → the capture wins the race.
    const key = await captureAlertFrameWithCeiling(capture, 2500, setTimeoutFn, clearTimeoutFn);
    expect(key).toBe("key-123");
    expect(clearTimeoutFn).toHaveBeenCalledOnce();
  });

  it("defaults to the exported 2500ms ceiling and the real timer when none injected", async () => {
    expect(ALERT_SCREENSHOT_CEILING_MS).toBe(2500);
    // With real timers, an already-resolved capture wins immediately (no wait).
    const key = await captureAlertFrameWithCeiling(Promise.resolve("immediate"));
    expect(key).toBe("immediate");
  });
});
