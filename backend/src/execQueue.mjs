// backend/src/execQueue.mjs
// Engine-agnostic execution queue (design §11 item 2 — backpressure).
//
// Do NOT let 800 concurrent candidate clicks hit the engine in lockstep:
//   - THREE independent lanes: Run and Submit gate the submit POSTs (so a
//     submit storm never starves quick sample runs), and a wide Poll lane
//     bounds the per-GET status polling — each lane is a FIFO with its own
//     bounded concurrency. A slot is held only WHILE a gated call runs; the
//     adapter sleeps between polls outside every lane (defect 3).
//   - Lane saturation QUEUES (never drops) up to maxQueue (pollMaxQueue for
//     the poll lane); beyond that the enqueue rejects immediately with
//     QueueFullError so the endpoint can 429.
//   - Retry-with-backoff lives INSIDE the run/submit lanes: transient engine
//     pushback (429 / 502 / 503 / 504 on err.status) is retried up to
//     maxRetries with exponential backoff + FULL jitter (delay = random() *
//     base * 2^attempt), honoring err.retryAfterMs (parsed from Retry-After)
//     when present. An error carrying retryable === false is NEVER retried
//     (the adapter sets it once submissions exist — re-running would re-bill),
//     and any other error propagates immediately. The poll lane never retries
//     at all: poll-phase retries live inside the adapter.
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
  // The poll lane only bounds concurrent status GETs (defect 3: a slot is
  // held per GET, never across a batch's whole ~90 s poll budget), so it can
  // be much wider than the submit-POST lanes and gets its own generous queue
  // bound, independent of the tighter run/submit maxQueue.
  pollConcurrency = 16,
  maxQueue = 200,
  pollMaxQueue = 1000,
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
        // .retryable === false takes PRECEDENCE over the status rule: the
        // adapter marks every post-submit error non-retryable, because once a
        // submit POST succeeded the submissions exist (and are billed) — a
        // queue-level retry would re-submit and re-bill the whole batch.
        if (err?.retryable === false) throw err;
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

  // runner: how a lane executes a job. The run/submit lanes retry transient
  // engine pushback; the poll lane runs the job ONCE — transient poll-failure
  // retries live inside the judge0 adapter (defect 1), so a lane-level retry
  // here would multiply them.
  const runOnce = (fn) => Promise.resolve().then(fn);

  function makeLane(concurrency, label, { laneMaxQueue = maxQueue, runner = runWithRetry } = {}) {
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
      runner(job.fn).then(settle(job.resolve), settle(job.reject));
    }

    function pump() {
      while (active < concurrency && waiting.length > 0) start(waiting.shift());
    }

    function enqueue(fn) {
      return new Promise((resolve, reject) => {
        if (active < concurrency) {
          start({ fn, resolve, reject });
        } else if (waiting.length >= laneMaxQueue) {
          // Reject NOW — the caller maps this to an HTTP 429 instead of the
          // request silently parking forever (queue never drops, it refuses).
          reject(new QueueFullError(`${label} queue is full (max ${laneMaxQueue})`));
        } else {
          waiting.push({ fn, resolve, reject });
        }
      });
    }

    return { enqueue, stats: () => ({ active, queued: waiting.length }) };
  }

  const runLane = makeLane(runConcurrency, "run");
  const submitLane = makeLane(submitConcurrency, "submit");
  const pollLane = makeLane(pollConcurrency, "poll", { laneMaxQueue: pollMaxQueue, runner: runOnce });

  return {
    enqueueRun: (fn) => runLane.enqueue(fn),
    enqueueSubmit: (fn) => submitLane.enqueue(fn),
    enqueuePoll: (fn) => pollLane.enqueue(fn),
    stats: () => ({ run: runLane.stats(), submit: submitLane.stats(), poll: pollLane.stats() })
  };
}
