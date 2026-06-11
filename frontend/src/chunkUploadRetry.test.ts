// RT-1 (e2e-live retest rev 00008, 2026-06-12) — bounded retry for recording-
// chunk uploads. Pure logic: TRANSIENT failures (network rejection / 5xx /
// 429) get up to 2 more attempts with a fresh signed URL for the SAME index
// and bytes; by-design 4xx rejections (401/403 lock-window, 409 ended) and
// exhaustion fall through to the existing honest-gap path unchanged.
import { describe, expect, it } from "vitest";
import {
  isTransientUploadError,
  runUploadWithRetry,
  UPLOAD_RETRY_BACKOFF_MS,
  uploadErrorStatus,
  type UploadRetryInfo
} from "./chunkUploadRetry";

/** ApiError shape thrown by api.ts request() (getUploadUrl rejections). */
function apiError(status: number, code: string): Error & { status: number; code: string } {
  const e = new Error(code) as Error & { status: number; code: string };
  e.status = status;
  e.code = code;
  return e;
}

/** The plain-Error shape uploadBlob throws on a non-OK GCS PUT. */
function putError(status: number): Error {
  return new Error(`Upload failed: ${status}`);
}

/** The fetch-level rejection seen in the rev-00008 retest (ERR_CONNECTION_CLOSED). */
function networkError(): Error {
  return new TypeError("Failed to fetch");
}

/** Instant injectable sleep that records every backoff delay. */
function recordingSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return { sleep: (ms) => (delays.push(ms), Promise.resolve()), delays };
}

describe("uploadErrorStatus", () => {
  it("reads the status field of an ApiError (upload-url rejection)", () => {
    expect(uploadErrorStatus(apiError(403, "session_locked"))).toBe(403);
    expect(uploadErrorStatus(apiError(503, "Request failed: 503"))).toBe(503);
  });

  it("parses the status out of uploadBlob's plain-Error message", () => {
    expect(uploadErrorStatus(putError(500))).toBe(500);
    expect(uploadErrorStatus(putError(403))).toBe(403);
  });

  it("returns undefined for fetch-level rejections and garbage", () => {
    expect(uploadErrorStatus(networkError())).toBeUndefined();
    expect(uploadErrorStatus(new Error("something else"))).toBeUndefined();
    expect(uploadErrorStatus(null)).toBeUndefined();
    expect(uploadErrorStatus("string error")).toBeUndefined();
  });
});

describe("isTransientUploadError", () => {
  it("treats network rejections, 5xx and 429 as transient", () => {
    expect(isTransientUploadError(networkError())).toBe(true);
    expect(isTransientUploadError(apiError(500, "x"))).toBe(true);
    expect(isTransientUploadError(apiError(503, "x"))).toBe(true);
    expect(isTransientUploadError(apiError(429, "x"))).toBe(true);
    expect(isTransientUploadError(putError(502))).toBe(true);
    expect(isTransientUploadError(putError(429))).toBe(true);
  });

  it("treats by-design 4xx rejections as NOT transient", () => {
    expect(isTransientUploadError(apiError(403, "session_locked"))).toBe(false);
    expect(isTransientUploadError(apiError(403, "waiting_for_approval"))).toBe(false);
    expect(isTransientUploadError(apiError(401, "unauthorized"))).toBe(false);
    expect(isTransientUploadError(apiError(409, "session_ended"))).toBe(false);
    expect(isTransientUploadError(apiError(400, "Invalid chunk_index"))).toBe(false);
    expect(isTransientUploadError(putError(403))).toBe(false);
  });
});

describe("runUploadWithRetry", () => {
  it("transient failure -> retry -> success (resolves with the fresh attempt's value)", async () => {
    const { sleep, delays } = recordingSleep();
    const retries: UploadRetryInfo[] = [];
    let calls = 0;
    const result = await runUploadWithRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw networkError();
        return { storage_key: "screen/chunk-00007.webm" };
      },
      { sleep, onRetry: (info) => retries.push(info) }
    );

    expect(result.storage_key).toBe("screen/chunk-00007.webm");
    expect(calls).toBe(2);
    expect(delays).toEqual([UPLOAD_RETRY_BACKOFF_MS[0]]);
    expect(retries).toHaveLength(1);
    expect(retries[0].attempt).toBe(1);
    expect(retries[0].delayMs).toBe(UPLOAD_RETRY_BACKOFF_MS[0]);
    expect(retries[0].error).toBeInstanceOf(TypeError);
  });

  it("403 lock-window -> NO retry, rejects immediately with the same error", async () => {
    const { sleep, delays } = recordingSleep();
    const locked = apiError(403, "session_locked");
    const retries: UploadRetryInfo[] = [];
    let calls = 0;

    await expect(
      runUploadWithRetry(
        async () => {
          calls += 1;
          throw locked;
        },
        { sleep, onRetry: (info) => retries.push(info) }
      )
    ).rejects.toBe(locked);

    expect(calls).toBe(1);
    expect(delays).toEqual([]);
    expect(retries).toEqual([]);
  });

  it("exhaustion -> gives up cleanly with the LAST error after the full schedule", async () => {
    const { sleep, delays } = recordingSleep();
    const retries: UploadRetryInfo[] = [];
    const errors = [networkError(), putError(503), networkError()];
    let calls = 0;

    await expect(
      runUploadWithRetry(
        async () => {
          throw errors[calls++];
        },
        { sleep, onRetry: (info) => retries.push(info) }
      )
    ).rejects.toBe(errors[2]);

    expect(calls).toBe(3); // 1 attempt + 2 retries, then stop
    expect(delays).toEqual([...UPLOAD_RETRY_BACKOFF_MS]);
    expect(retries.map((r) => r.attempt)).toEqual([1, 2]);
  });

  it("re-uses the SAME chunk index and bytes, with a FRESH url per attempt (recorder shape)", async () => {
    const { sleep } = recordingSleep();
    const blob = { size: 12345, type: "video/webm" }; // stable identity stands in for the Blob
    const index = 7;
    const urlRequests: Array<{ kind: string; chunk_index: number }> = [];
    const puts: Array<{ url: string; body: unknown }> = [];
    let urlCount = 0;
    let putCount = 0;

    // Mirror of the recorder's attempt closure: fresh signed URL + PUT of the
    // SAME blob at the SAME already-allocated index, every attempt.
    const fakeGetUploadUrl = async (params: { kind: string; chunk_index: number }) => {
      urlRequests.push(params);
      urlCount += 1;
      return { upload_url: `https://signed/upload-${urlCount}`, storage_key: `screen/chunk-0000${params.chunk_index}.webm` };
    };
    const fakeUploadBlob = async (url: string, body: unknown) => {
      puts.push({ url, body });
      putCount += 1;
      if (putCount < 3) throw networkError();
    };

    const result = await runUploadWithRetry(
      async () => {
        const fresh = await fakeGetUploadUrl({ kind: "screen", chunk_index: index });
        await fakeUploadBlob(fresh.upload_url, blob);
        return fresh;
      },
      { sleep }
    );

    // Same index on every URL request — never re-allocated.
    expect(urlRequests).toEqual([
      { kind: "screen", chunk_index: 7 },
      { kind: "screen", chunk_index: 7 },
      { kind: "screen", chunk_index: 7 }
    ]);
    // Same bytes on every PUT, each against a FRESH signed URL.
    expect(puts.map((p) => p.body)).toEqual([blob, blob, blob]);
    expect(puts.map((p) => p.url)).toEqual([
      "https://signed/upload-1",
      "https://signed/upload-2",
      "https://signed/upload-3"
    ]);
    // The manifest records the SUCCESSFUL attempt's storage_key.
    expect(result.storage_key).toBe("screen/chunk-00007.webm");
  });

  it("uses the real backoff schedule by default (2 retries max)", () => {
    expect(UPLOAD_RETRY_BACKOFF_MS).toEqual([2000, 5000]);
  });
});
