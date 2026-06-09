// backend/src/execQueue.mjs
// Engine-agnostic execution queue (design §11 item 2 — backpressure).
//
// Do NOT let 800 concurrent candidate clicks hit the engine in lockstep:
//   - TWO independent lanes (Run vs Submit) so a submit storm never starves
//     quick sample runs — each lane is a FIFO with its own bounded concurrency.
//   - Lane saturation QUEUES (never drops) up to maxQueue; beyond that the
//     enqueue rejects immediately with QueueFullError so the endpoint can 429.
//   - Retry-with-backoff lives INSIDE the queue: transient engine pushback
//     (429 / 502 / 503 / 504 on err.status) is retried up to maxRetries with
//     exponential backoff + FULL jitter (delay = random() * base * 2^attempt),
//     honoring err.retryAfterMs (parsed from Retry-After) when present. Any
//     other error propagates immediately.
//
// The queue knows nothing about Judge0 — it runs whatever async fn it is
// handed, so a self-host swap (design §11 item 5) needs zero changes here.

export class QueueFullError extends Error {
  constructor(message = "execution queue is full") {
    super(message);
    this.name = "QueueFullError";
  }
}

// Engine statuses worth retrying: rate limit + transient gateway failures.
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function makeExecQueue({
  runConcurrency = 2,
  submitConcurrency = 4,
  maxQueue = 200,
  maxRetries = 3,
  baseDelayMs = 1000,
  sleepImpl = defaultSleep,
  randomImpl = Math.random
} = {}) {
  async function runWithRetry(fn) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (!RETRYABLE_STATUSES.has(err?.status) || attempt >= maxRetries) throw err;
        // Server-provided Retry-After wins; otherwise full jitter on an
        // exponential base so retry waves from many lanes don't synchronize.
        const delayMs = typeof err.retryAfterMs === "number"
          ? err.retryAfterMs
          : randomImpl() * baseDelayMs * 2 ** attempt;
        await sleepImpl(delayMs);
      }
    }
  }

  function makeLane(concurrency, label) {
    let active = 0;
    const waiting = []; // FIFO of { fn, resolve, reject }

    function start(job) {
      active++;
      // Free the slot (and pump the next waiter) BEFORE settling the caller's
      // promise, so an awaiter observing stats() right after its job finishes
      // sees consistent counts. job.reject HANDLES the rejection (it is the
      // onRejected callback), so this chain never leaves an unhandled rejection.
      const settle = (deliver) => (outcome) => {
        active--;
        pump();
        deliver(outcome);
      };
      runWithRetry(job.fn).then(settle(job.resolve), settle(job.reject));
    }

    function pump() {
      while (active < concurrency && waiting.length > 0) start(waiting.shift());
    }

    function enqueue(fn) {
      return new Promise((resolve, reject) => {
        if (active < concurrency) {
          start({ fn, resolve, reject });
        } else if (waiting.length >= maxQueue) {
          // Reject NOW — the caller maps this to an HTTP 429 instead of the
          // request silently parking forever (queue never drops, it refuses).
          reject(new QueueFullError(`${label} queue is full (max ${maxQueue})`));
        } else {
          waiting.push({ fn, resolve, reject });
        }
      });
    }

    return { enqueue, stats: () => ({ active, queued: waiting.length }) };
  }

  const runLane = makeLane(runConcurrency, "run");
  const submitLane = makeLane(submitConcurrency, "submit");

  return {
    enqueueRun: (fn) => runLane.enqueue(fn),
    enqueueSubmit: (fn) => submitLane.enqueue(fn),
    stats: () => ({ run: runLane.stats(), submit: submitLane.stats() })
  };
}
