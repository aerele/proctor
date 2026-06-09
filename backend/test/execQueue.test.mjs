// backend/test/execQueue.test.mjs
// Pure unit tests for the engine-agnostic execution queue (design §11 item 2).
// NO handler import (mirrors judge0Adapter.test.mjs): the queue is exercised
// directly with injected sleep/random for full determinism.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeExecQueue, QueueFullError } from "../src/execQueue.mjs";

// A manually-resolved promise so tests control exactly when a job finishes.
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Let queued microtasks + the lane pump run.
const tick = () => new Promise((r) => setImmediate(r));

// A fake sleep that records every requested delay and resolves immediately —
// retries become observable and instant.
function fakeSleep() {
  const delays = [];
  const fn = async (ms) => { delays.push(ms); };
  fn.delays = delays;
  return fn;
}

function errWithStatus(status, retryAfterMs) {
  const err = new Error(`upstream ${status}`);
  err.status = status;
  if (retryAfterMs !== undefined) err.retryAfterMs = retryAfterMs;
  return err;
}

test("lanes run jobs up to their concurrency; excess queues FIFO and drains in order", async () => {
  const q = makeExecQueue({ runConcurrency: 1, sleepImpl: fakeSleep() });
  const order = [];
  const gates = [deferred(), deferred(), deferred()];
  const jobs = [0, 1, 2].map((i) => q.enqueueRun(async () => {
    order.push(`start-${i}`);
    await gates[i].promise;
    order.push(`end-${i}`);
    return i;
  }));
  await tick();
  // Only job 0 started (concurrency 1); 1 and 2 are queued in FIFO order.
  assert.deepEqual(order, ["start-0"]);
  assert.deepEqual(q.stats().run, { active: 1, queued: 2 });
  gates[0].resolve();
  await tick();
  assert.deepEqual(order, ["start-0", "end-0", "start-1"]); // FIFO: 1 before 2
  gates[1].resolve();
  await tick();
  assert.deepEqual(order, ["start-0", "end-0", "start-1", "end-1", "start-2"]);
  gates[2].resolve();
  await tick();
  assert.deepEqual(await Promise.all(jobs), [0, 1, 2]); // results map to callers in order
  assert.deepEqual(q.stats(), { run: { active: 0, queued: 0 }, submit: { active: 0, queued: 0 } });
});

test("lane independence: a saturated run lane never blocks the submit lane (and vice versa)", async () => {
  const q = makeExecQueue({ runConcurrency: 1, submitConcurrency: 1, sleepImpl: fakeSleep() });
  const runGate = deferred();
  const runJob = q.enqueueRun(() => runGate.promise.then(() => "run-done"));
  const runQueued = q.enqueueRun(async () => "run-queued-done");
  await tick();
  // Run lane is saturated (1 active, 1 queued)…
  assert.deepEqual(q.stats().run, { active: 1, queued: 1 });
  // …but a submit goes straight through its OWN lane.
  assert.equal(await q.enqueueSubmit(async () => "submit-done"), "submit-done");
  assert.deepEqual(q.stats().submit, { active: 0, queued: 0 });
  runGate.resolve();
  assert.equal(await runJob, "run-done");
  assert.equal(await runQueued, "run-queued-done");
});

test("beyond maxQueue the lane rejects immediately with QueueFullError (name property) — never drops silently", async () => {
  const q = makeExecQueue({ runConcurrency: 1, maxQueue: 2, sleepImpl: fakeSleep() });
  const gate = deferred();
  const active = q.enqueueRun(() => gate.promise);
  const q1 = q.enqueueRun(async () => 1);
  const q2 = q.enqueueRun(async () => 2);
  await tick();
  assert.deepEqual(q.stats().run, { active: 1, queued: 2 });
  // Queue is full: the next enqueue rejects NOW (so the endpoint can 429)…
  await assert.rejects(q.enqueueRun(async () => 3), (err) => {
    assert.equal(err.name, "QueueFullError");
    assert.ok(err instanceof QueueFullError);
    return true;
  });
  // …and the queued jobs were NOT dropped.
  gate.resolve("active-done");
  assert.equal(await active, "active-done");
  assert.equal(await q1, 1);
  assert.equal(await q2, 2);
});

test("maxQueue bounds each lane independently (submit lane still accepts when run lane is full)", async () => {
  const q = makeExecQueue({ runConcurrency: 1, submitConcurrency: 1, maxQueue: 1, sleepImpl: fakeSleep() });
  const runGate = deferred();
  const submitGate = deferred();
  const runActive = q.enqueueRun(() => runGate.promise);
  const runQueued = q.enqueueRun(async () => "rq");
  await tick();
  await assert.rejects(q.enqueueRun(async () => "overflow"), { name: "QueueFullError" });
  // The submit lane has its own budget — untouched by the run lane being full.
  const submitActive = q.enqueueSubmit(() => submitGate.promise);
  const submitQueued = q.enqueueSubmit(async () => "sq");
  await tick();
  assert.deepEqual(q.stats(), { run: { active: 1, queued: 1 }, submit: { active: 1, queued: 1 } });
  runGate.resolve("ra"); submitGate.resolve("sa");
  assert.deepEqual(await Promise.all([runActive, runQueued, submitActive, submitQueued]), ["ra", "rq", "sa", "sq"]);
});

test("429 retries with exponential backoff + full jitter (delay = random() * base * 2^attempt), then succeeds", async () => {
  const sleep = fakeSleep();
  // Deterministic "random": 0.5 then 0.25 — exposes the 2^attempt factor.
  const randoms = [0.5, 0.25];
  const q = makeExecQueue({ baseDelayMs: 1000, maxRetries: 3, sleepImpl: sleep, randomImpl: () => randoms.shift() });
  let calls = 0;
  const result = await q.enqueueRun(async () => {
    calls++;
    if (calls <= 2) throw errWithStatus(429);
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(calls, 3); // 2 failures + 1 success
  // attempt 0: 0.5  * 1000 * 2^0 = 500
  // attempt 1: 0.25 * 1000 * 2^1 = 500
  assert.deepEqual(sleep.delays, [500, 500]);
});

test("502/503/504 are retryable; retries exhausted -> the last error propagates", async () => {
  for (const status of [502, 503, 504]) {
    const sleep = fakeSleep();
    const q = makeExecQueue({ baseDelayMs: 100, maxRetries: 2, sleepImpl: sleep, randomImpl: () => 1 });
    let calls = 0;
    await assert.rejects(
      q.enqueueRun(async () => { calls++; throw errWithStatus(status); }),
      (err) => err.status === status
    );
    assert.equal(calls, 3); // initial + maxRetries(2)
    assert.deepEqual(sleep.delays, [100, 200]); // 100*2^0, 100*2^1 (random=1)
  }
});

test("non-retryable errors propagate immediately — no retry, no sleep", async () => {
  for (const makeErr of [
    () => errWithStatus(500),               // 5xx but not 502/503/504
    () => errWithStatus(400),
    () => new Error("no status at all")     // plain error
  ]) {
    const sleep = fakeSleep();
    const q = makeExecQueue({ sleepImpl: sleep, randomImpl: () => 1 });
    let calls = 0;
    await assert.rejects(q.enqueueRun(async () => { calls++; throw makeErr(); }));
    assert.equal(calls, 1);
    assert.deepEqual(sleep.delays, []);
  }
});

test("err.retryable === false is NEVER retried, even with a retryable status (precedence over the 429/5xx rule)", async () => {
  // The adapter marks every post-submit error non-retryable: the submissions
  // already exist (and are billed), so a queue retry would re-submit them.
  for (const status of [429, 502, 503, 504]) {
    const sleep = fakeSleep();
    const q = makeExecQueue({ sleepImpl: sleep, randomImpl: () => 1 });
    let calls = 0;
    await assert.rejects(
      q.enqueueRun(async () => {
        calls++;
        const err = errWithStatus(status, 100); // even with a Retry-After hint
        err.retryable = false;
        throw err;
      }),
      (err) => err.status === status && err.retryable === false
    );
    assert.equal(calls, 1); // no retry
    assert.deepEqual(sleep.delays, []); // no sleep
  }
});

test("err.retryAfterMs is honored over the jittered backoff when present", async () => {
  const sleep = fakeSleep();
  const q = makeExecQueue({ baseDelayMs: 1000, maxRetries: 3, sleepImpl: sleep, randomImpl: () => 0.5 });
  let calls = 0;
  const result = await q.enqueueRun(async () => {
    calls++;
    if (calls === 1) throw errWithStatus(429, 2500); // server said: wait 2.5 s
    if (calls === 2) throw errWithStatus(503);       // no Retry-After -> jitter
    return "ok";
  });
  assert.equal(result, "ok");
  // First delay is exactly retryAfterMs; second falls back to jitter
  // (0.5 * 1000 * 2^1 = 1000).
  assert.deepEqual(sleep.delays, [2500, 1000]);
});

test("a failing job frees its slot: the lane keeps draining after a rejection", async () => {
  const q = makeExecQueue({ runConcurrency: 1, sleepImpl: fakeSleep() });
  const failing = q.enqueueRun(async () => { throw errWithStatus(400); });
  const next = q.enqueueRun(async () => "still-runs");
  await assert.rejects(failing, (err) => err.status === 400);
  assert.equal(await next, "still-runs");
  assert.deepEqual(q.stats().run, { active: 0, queued: 0 });
});

test("stats() reports both lanes' live active/queued counts", async () => {
  const q = makeExecQueue({ runConcurrency: 2, submitConcurrency: 1, sleepImpl: fakeSleep() });
  assert.deepEqual(q.stats(), { run: { active: 0, queued: 0 }, submit: { active: 0, queued: 0 } });
  const g = deferred();
  const jobs = [
    q.enqueueRun(() => g.promise), q.enqueueRun(() => g.promise), q.enqueueRun(() => g.promise),
    q.enqueueSubmit(() => g.promise), q.enqueueSubmit(() => g.promise)
  ];
  await tick();
  assert.deepEqual(q.stats(), { run: { active: 2, queued: 1 }, submit: { active: 1, queued: 1 } });
  g.resolve("x");
  assert.deepEqual(await Promise.all(jobs), ["x", "x", "x", "x", "x"]);
  assert.deepEqual(q.stats(), { run: { active: 0, queued: 0 }, submit: { active: 0, queued: 0 } });
});

test("defaults: runConcurrency 2, submitConcurrency 4, maxQueue 200", async () => {
  const q = makeExecQueue({ sleepImpl: fakeSleep() });
  const g = deferred();
  const jobs = [];
  for (let i = 0; i < 10; i++) jobs.push(q.enqueueRun(() => g.promise));
  for (let i = 0; i < 10; i++) jobs.push(q.enqueueSubmit(() => g.promise));
  await tick();
  assert.deepEqual(q.stats(), { run: { active: 2, queued: 8 }, submit: { active: 4, queued: 6 } });
  g.resolve("d");
  await Promise.all(jobs);
});
