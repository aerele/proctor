// evalBatchLoop.ts — the resilient "Run evaluation" batch loop (fix
// eval-batch-progress-idempotent, part B/frontend).
//
// The bug: evaluateContestBatch ran synchronously and a heavy batch blew past
// the Cloud Run 120s request timeout → 504 → the panel loop ABORTED → partial
// writes; and each fresh click reset the cursor to undefined, re-skipping every
// already-done identity (a Firestore get per skip) → decaying progress.
//
// This loop fixes the frontend half: it drives the cursor-batched evaluator
// until done:true, surfaces { processed, total } from the SERVER response so the
// panel renders "Evaluating X / total…", and is RESILIENT — on a 504 / transient
// error it retries from the LAST SERVER CURSOR (a few retries, small backoff)
// rather than aborting, and never resets the cursor to key-zero. A by-design 4xx
// (incl. 409 eval_in_progress) is NOT retried — it rejects for the caller to
// surface. Pure/injectable (mirrors chunkUploadRetry.ts) so it unit-tests
// cleanly without a real fetch.

/** One contest-evaluate batch response (the fields this loop reads). */
export type EvalBatchResult = {
  evaluated: number;
  skipped: number;
  cursor?: string | null;
  done: boolean;
  // Server-driven progress (the job doc): present on the resilient backend.
  processed?: number;
  total?: number;
};

/** The exponential-ish retry backoff schedule (ms) — 3 retries after the first
 *  attempt. Small + bounded: a transient 504 recovers without a user re-click. */
export const EVAL_RETRY_BACKOFF_MS = [2000, 5000, 10000] as const;

/** The status of an ApiError-shaped rejection (api.ts request()), if any. */
function errorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

/** A transient (retryable) failure: a 504 Cloud Run timeout, any other 5xx, a
 *  429, or a fetch-level network rejection (no status). By-design 4xx — 400 /
 *  401 / 403 / 409 eval_in_progress — are NOT transient: they reject at once. */
export function isTransientEvalError(error: unknown): boolean {
  const status = errorStatus(error);
  if (status === undefined) return true; // network-level rejection (TypeError: Failed to fetch)
  return status >= 500 || status === 429;
}

export type RunEvaluateLoopOptions = {
  /** Run ONE batch against the given resume cursor; resolves the batch result. */
  runBatch: (cursor: string | null | undefined) => Promise<EvalBatchResult>;
  /** Progress callback driven by the SERVER total each chunk (X / total). */
  onProgress?: (p: { processed: number; total: number }) => void;
  /** Injectable sleep so tests run instantly (defaults to real setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** Bounded outer guard against a pathological non-terminating cursor. */
  maxChunks?: number;
};

const realSleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/**
 * Drive the batch endpoint until done, resilient to transient 504/timeouts.
 * Resolves once a batch returns done:true; rejects with the offending error on a
 * by-design 4xx (e.g. 409 eval_in_progress) or after the retry schedule is
 * exhausted on a persistent transient failure.
 */
export async function runEvaluateLoop(opts: RunEvaluateLoopOptions): Promise<void> {
  const { runBatch, onProgress, sleep = realSleep, maxChunks = 100000 } = opts;
  let cursor: string | null | undefined;
  let retries = 0;
  for (let guard = 0; guard < maxChunks; guard += 1) {
    let res: EvalBatchResult;
    try {
      res = await runBatch(cursor);
    } catch (error) {
      // By-design 4xx (incl. 409): surface immediately, do not retry.
      if (!isTransientEvalError(error)) throw error;
      // Transient: retry from the SAME (last server) cursor — never key-zero.
      if (retries >= EVAL_RETRY_BACKOFF_MS.length) throw error;
      await sleep(EVAL_RETRY_BACKOFF_MS[retries]);
      retries += 1;
      continue;
    }
    // A successful chunk resets the transient-retry budget.
    retries = 0;
    if (onProgress && typeof res.total === "number" && typeof res.processed === "number") {
      onProgress({ processed: res.processed, total: res.total });
    }
    if (res.done) return;
    // Resume from the SERVER cursor (resilient against re-skipping done work).
    cursor = res.cursor;
  }
  throw new Error("evaluation loop did not terminate within the chunk guard");
}
