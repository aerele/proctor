// frontend/src/chunkUploadRetry.ts — RT-1 (e2e-live retest rev 00008,
// 2026-06-12): bounded retry for recording-chunk uploads. In the retest 9 of
// 57 chunk uploads died on transient net::ERR_CONNECTION_CLOSED (~4.5 min of
// honest video loss); on college-hall Wi-Fi transient drops WILL happen, so a
// TRANSIENT failure gets up to 2 more attempts (short backoff) before the
// existing honest-gap path (upload_error event + timeline marker) takes over.
//
// Contract (recorder side, useProctorRecorder.ts):
//   - Every attempt re-requests a FRESH signed URL for the SAME already-
//     allocated chunk index and the SAME bytes. The old URL may be expired/
//     consumed, and the backend's per-kind hwm guard (createUploadUrl) maps a
//     re-requested index safely to an unused object key — never an overwrite.
//   - Indexes are NEVER re-allocated by a retry (chunkContinuity hwm already
//     advanced at allocation time).
//   - By-design rejections (401/403 lock-window, 409 ended) are NOT retried —
//     they must keep flowing to handleFatalStatus immediately, unchanged.
//   - Retries run INSIDE the chunk's slot of the existing serial per-kind
//     upload chain, so they are naturally queued (max one retry sequence in
//     flight per kind) and exhaustion is bounded to ~7s of backoff.
//
// No React, no network — pure decision logic + an injectable-sleep runner so
// vitest covers it without timers or a DOM.

/** Backoff schedule: retry #1 after ~2s, retry #2 after ~5s. Length = max
 * number of RETRIES (attempts = length + 1). */
export const UPLOAD_RETRY_BACKOFF_MS: readonly number[] = [2000, 5000];

/** Extract the HTTP status of a failed upload step, if one exists.
 *  - getUploadUrl rejections are ApiError (api.ts request()) carrying .status.
 *  - uploadBlob rejections are plain Error("Upload failed: <status>") — the
 *    status only rides the message. Parsed here ON PURPOSE instead of adding
 *    a .status field to that error: fatalStatusFromError treats any .status
 *    403 as "locked" and would self-stop the recorder on a GCS-side 403
 *    (expired signature), which today is a logged gap, not a stop.
 *  - A fetch-level rejection (TypeError: Failed to fetch / connection closed)
 *    has no status at all -> undefined. */
export function uploadErrorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  if (typeof status === "number" && Number.isFinite(status)) return status;
  if (error instanceof Error) {
    const match = /Upload failed: (\d{3})/.exec(error.message);
    if (match) return Number(match[1]);
  }
  return undefined;
}

/** TRANSIENT = worth retrying with a fresh signed URL:
 *  - no HTTP status (network-level rejection — the rev-00008 failure mode),
 *  - 429 (throttled),
 *  - any 5xx.
 *  Everything else (401/403 lock-window, 409 ended, other 4xx) is a by-design
 *  rejection and must fail immediately, exactly as before this fix. */
export function isTransientUploadError(error: unknown): boolean {
  const status = uploadErrorStatus(error);
  if (status === undefined) return true;
  if (status === 429) return true;
  return status >= 500;
}

export type UploadRetryInfo = {
  /** 1-based retry number (1 = first retry / second attempt). */
  attempt: number;
  /** Backoff slept BEFORE this retry. */
  delayMs: number;
  /** The error that triggered this retry. */
  error: unknown;
};

export type UploadRetryOptions = {
  /** Override the backoff schedule (tests). Default UPLOAD_RETRY_BACKOFF_MS. */
  backoffMs?: readonly number[];
  /** Audit hook fired before each backoff sleep. */
  onRetry?: (info: UploadRetryInfo) => void;
  /** Injectable sleep (tests). Default: real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Run one chunk's full upload attempt (fresh signed URL + PUT) with bounded
 * retries on TRANSIENT failures. Resolves with the SUCCESSFUL attempt's value
 * (its fresh upload-url response — the storage_key the manifest must record).
 * Rejects with the LAST error when the failure is non-transient (immediately)
 * or the schedule is exhausted — the caller's existing catch path (upload_error
 * event + handleFatalStatus + per-kind chain semantics) is unchanged. */
export async function runUploadWithRetry<T>(
  attemptUpload: (attempt: number) => Promise<T>,
  options?: UploadRetryOptions
): Promise<T> {
  const backoff = options?.backoffMs ?? UPLOAD_RETRY_BACKOFF_MS;
  const sleep = options?.sleep ?? defaultSleep;
  let attempt = 0;
  for (;;) {
    try {
      return await attemptUpload(attempt);
    } catch (error) {
      const delayMs = backoff[attempt];
      if (delayMs === undefined || !isTransientUploadError(error)) throw error;
      attempt += 1;
      options?.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
}

// ---- RT-4: poison-proof serial chain advance --------------------------------
//
// RT-4 (e2e-live retest rev 00008, 2026-06-12): the screen chain used to
// re-throw EVERY slot failure, so one exhausted transient failure left
// `uploadQueue` rejected — every LATER chunk's .then was skipped, its .catch
// fired with the INHERITED error (an upload_error that never attempted its own
// upload) and re-threw again, until the next recorder restart reset the chain
// (the consecutive screen failures 5,6,7 and 9,10 in tonight's retest). This
// helper is the chain advance for the recorder's SCREEN chain: it still
// SEQUENCES (serial, ordered, one slot in flight per kind) but a rejection
// stays on the chain ONLY when `isFatal` says so (401/403/409 → lock/pending/
// ended — stop()'s `await uploadQueue.catch(...)` must keep surfacing those
// via onFatalError exactly as before). A NON-fatal exhausted failure is that
// one chunk's honest gap: onError audits it, the rejection is swallowed, and
// the NEXT chunk's slot attempts its own upload normally. The camera chain
// keeps its own swallow-everything inline form (unchanged).

export type UploadChainSlotHooks = {
  /** This chunk's own upload work (retry runner + manifest + chunk_uploaded). */
  run: () => Promise<void>;
  /** This chunk's failure path (upload_error audit + handleFatalStatus). When
   * a FATAL rejection was inherited from an earlier slot, `run` is skipped and
   * this receives the inherited error — same as before RT-4. */
  onError: (error: unknown) => void;
  /** True → keep the chain rejected after onError (fatal-status semantics). */
  isFatal: (error: unknown) => boolean;
  /** Always runs once the slot settles (queue-depth bookkeeping). */
  onSettled: () => void;
};

/** Append one chunk's slot to a serial per-kind upload chain; returns the new
 * chain tail the next chunk must sequence behind. */
export function advanceUploadChain(queue: Promise<void>, hooks: UploadChainSlotHooks): Promise<void> {
  return queue
    .then(hooks.run)
    .catch((error) => {
      hooks.onError(error);
      if (hooks.isFatal(error)) throw error;
    })
    .finally(hooks.onSettled);
}

