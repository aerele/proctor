// evalBatchLoop.test.ts — the resilient "Run evaluation" batch loop (fix
// eval-batch-progress-idempotent, part B/frontend). The loop drives the
// cursor-batched evaluator until done:true, surfacing { processed, total } so
// the panel renders "Evaluating X / total…", and is RESILIENT: on a 504 /
// transient error it retries from the LAST SERVER CURSOR (a few retries, small
// backoff) instead of aborting and re-skipping done identities from key-zero.
import { describe, expect, it } from "vitest";
import {
  isTransientEvalError,
  runEvaluateLoop,
  EVAL_RETRY_BACKOFF_MS,
  type EvalBatchResult
} from "./evalBatchLoop";

/** ApiError shape thrown by api.ts request(). */
function apiError(status: number, code = "x"): Error & { status: number; code: string } {
  const e = new Error(code) as Error & { status: number; code: string };
  e.status = status;
  e.code = code;
  return e;
}
function networkError(): Error {
  return new TypeError("Failed to fetch");
}
function recordingSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return { sleep: (ms) => (delays.push(ms), Promise.resolve()), delays };
}

describe("isTransientEvalError", () => {
  it("treats 504 / 5xx / 429 / network rejections as transient (retryable)", () => {
    expect(isTransientEvalError(apiError(504))).toBe(true);
    expect(isTransientEvalError(apiError(502))).toBe(true);
    expect(isTransientEvalError(apiError(500))).toBe(true);
    expect(isTransientEvalError(apiError(429))).toBe(true);
    expect(isTransientEvalError(networkError())).toBe(true);
  });

  it("treats by-design 4xx (incl. 409 eval_in_progress) as NOT transient", () => {
    expect(isTransientEvalError(apiError(409, "eval_in_progress"))).toBe(false);
    expect(isTransientEvalError(apiError(400))).toBe(false);
    expect(isTransientEvalError(apiError(401))).toBe(false);
    expect(isTransientEvalError(apiError(403))).toBe(false);
  });
});

describe("runEvaluateLoop", () => {
  it("drives the cursor to done, reporting processed/total progress per chunk", async () => {
    const { sleep } = recordingSleep();
    const progress: Array<{ processed: number; total: number }> = [];
    const seen: Array<string | null | undefined> = [];
    const chunks: EvalBatchResult[] = [
      { evaluated: 1, skipped: 0, cursor: "k1", done: false, processed: 1, total: 3 },
      { evaluated: 1, skipped: 0, cursor: "k2", done: false, processed: 2, total: 3 },
      { evaluated: 1, skipped: 0, cursor: null, done: true, processed: 3, total: 3 }
    ];
    let i = 0;
    await runEvaluateLoop({
      runBatch: async (cursor) => { seen.push(cursor); return chunks[i++]; },
      onProgress: (p) => progress.push(p),
      sleep
    });

    // The cursor threads from each chunk's server cursor into the next call.
    expect(seen).toEqual([undefined, "k1", "k2"]);
    // Progress is driven by the SERVER total (not the local count) every chunk.
    expect(progress).toEqual([
      { processed: 1, total: 3 },
      { processed: 2, total: 3 },
      { processed: 3, total: 3 }
    ]);
  });

  it("on a transient 504 retries from the LAST SERVER CURSOR (not key-zero) then resumes", async () => {
    const { sleep, delays } = recordingSleep();
    const seen: Array<string | null | undefined> = [];
    let calls = 0;
    await runEvaluateLoop({
      runBatch: async (cursor) => {
        seen.push(cursor);
        calls += 1;
        if (calls === 1) return { evaluated: 1, skipped: 0, cursor: "k1", done: false, processed: 1, total: 2 };
        if (calls === 2) throw apiError(504); // the Cloud Run timeout the bug produced
        return { evaluated: 1, skipped: 0, cursor: null, done: true, processed: 2, total: 2 };
      },
      sleep
    });

    // After the 504 the loop retries with the SAME server cursor "k1" — it never
    // resets to undefined (key-zero), which is what caused the decaying re-skip.
    expect(seen).toEqual([undefined, "k1", "k1"]);
    expect(delays).toEqual([EVAL_RETRY_BACKOFF_MS[0]]);
    expect(calls).toBe(3);
  });

  it("gives up after exhausting retries on persistent transient failure, surfacing the last error", async () => {
    const { sleep, delays } = recordingSleep();
    const err = apiError(504);
    let calls = 0;
    await expect(
      runEvaluateLoop({
        runBatch: async () => { calls += 1; throw err; },
        sleep
      })
    ).rejects.toBe(err);
    // 1 attempt + the full backoff schedule of retries, then stop.
    expect(calls).toBe(1 + EVAL_RETRY_BACKOFF_MS.length);
    expect(delays).toEqual([...EVAL_RETRY_BACKOFF_MS]);
  });

  it("a 409 eval_in_progress is NOT retried — it rejects immediately for the caller to surface", async () => {
    const { sleep, delays } = recordingSleep();
    const busy = apiError(409, "eval_in_progress");
    let calls = 0;
    await expect(
      runEvaluateLoop({ runBatch: async () => { calls += 1; throw busy; }, sleep })
    ).rejects.toBe(busy);
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });
});
