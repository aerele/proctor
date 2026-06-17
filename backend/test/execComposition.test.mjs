// backend/test/execComposition.test.mjs
// COMPOSITION tests: makeExecQueue wired around a REAL makeJudge0Adapter with a
// scripted fake fetch. The unit suites prove each piece alone; these prove the
// review's point — the pieces composed must never double-bill: once a submit
// POST succeeded, submissions exist (and are billed), so NO later failure may
// cause the queue to re-run the submit phase.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeExecQueue } from "../src/execQueue.mjs";
import { makeJudge0Adapter } from "../src/judge0Adapter.mjs";

const ITEM = { languageId: 71, source: "x", stdin: "", expectedOutput: "ok", cpuTimeLimit: 5, memoryLimit: 128000 };

const okJson = (payload) => ({ ok: true, status: 200, json: async () => payload });
const failure = (status) => ({
  ok: false, status,
  headers: { get: () => null },
  json: async () => ({})
});
const DONE_SUB = {
  token: "t1", status: { id: 3, description: "Accepted" },
  stdout: Buffer.from("ok\n").toString("base64"),
  stderr: null, compile_output: null, time: "0.01", memory: 256
};

// A scripted fetch that distinguishes the submit POST from poll GETs and
// records every call so billing (POST count) is directly observable.
function scriptedFetch({ postResponses, getResponses }) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const method = opts.method || "GET";
    calls.push({ url, method });
    const queue = method === "POST" ? postResponses : getResponses;
    if (queue.length === 0) throw new Error(`unscripted ${method} call`);
    return queue.length > 1 ? queue.shift() : queue[0];
  };
  fn.calls = calls;
  fn.posts = () => calls.filter((c) => c.method === "POST").length;
  fn.gets = () => calls.filter((c) => c.method === "GET").length;
  return fn;
}

const noSleep = async () => {};

function gatesFor(q) {
  return {
    submitGate: (fn) => q.enqueueSubmit(fn),
    pollGate: (fn) => q.enqueuePoll(fn)
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((r) => setImmediate(r));

// ---- DEFECT 1: double billing ----------------------------------------------

test("composition: submit POST succeeds, first poll GET 503s then succeeds -> submit POST happens EXACTLY ONCE, result correct (whole-batch wrap)", async () => {
  const fetchImpl = scriptedFetch({
    postResponses: [okJson([{ token: "t1" }])],
    getResponses: [failure(503), okJson({ submissions: [DONE_SUB] })]
  });
  const adapter = makeJudge0Adapter({
    baseUrl: "u", mode: "rapidapi", apiKey: "K",
    fetchImpl, pollIntervalMs: 0, sleepImpl: noSleep, randomImpl: () => 1
  });
  const q = makeExecQueue({ sleepImpl: noSleep, randomImpl: () => 1 });
  // The OLD handler wiring (queue around the whole runBatch): even here a
  // transient poll failure must NEVER re-run the submit phase.
  const results = await q.enqueueRun(() => adapter.runBatch([ITEM]));
  assert.equal(fetchImpl.posts(), 1, "submissions were billed more than once");
  assert.equal(fetchImpl.gets(), 2); // failed poll + adapter-internal retry
  assert.equal(results[0].passed, true);
  assert.equal(results[0].status, "accepted");
  assert.equal(results[0].stdout, "ok\n");
});

test("composition: poll GETs fail past the adapter's retry budget -> the queue still NEVER re-submits (error escapes non-retryable)", async () => {
  const fetchImpl = scriptedFetch({
    postResponses: [okJson([{ token: "t1" }])],
    getResponses: [failure(503)] // every poll GET 503s, forever
  });
  const adapter = makeJudge0Adapter({
    baseUrl: "u", mode: "rapidapi", apiKey: "K",
    fetchImpl, pollIntervalMs: 0, sleepImpl: noSleep, randomImpl: () => 1
  });
  const q = makeExecQueue({ sleepImpl: noSleep, randomImpl: () => 1 });
  await assert.rejects(
    q.enqueueRun(() => adapter.runBatch([ITEM])),
    (err) => {
      assert.equal(err.status, 503);
      assert.equal(err.retryable, false);
      return true;
    }
  );
  // 503 would normally be queue-retryable — but the submit already succeeded,
  // so the queue must not have re-run the batch: ONE submit POST, ever.
  assert.equal(fetchImpl.posts(), 1, "queue retried a batch whose submissions were already billed");
  assert.equal(fetchImpl.gets(), 6); // initial GET + 5 adapter-internal retries
});

test("composition: submit POST 503s twice then succeeds -> queue retries are fine (3 submit attempts, none billed before success), result correct", async () => {
  const fetchImpl = scriptedFetch({
    postResponses: [failure(503), failure(503), okJson([{ token: "t1" }])],
    getResponses: [okJson({ submissions: [DONE_SUB] })]
  });
  const adapter = makeJudge0Adapter({
    baseUrl: "u", mode: "rapidapi", apiKey: "K",
    fetchImpl, pollIntervalMs: 0, sleepImpl: noSleep, randomImpl: () => 1
  });
  const q = makeExecQueue({ sleepImpl: noSleep, randomImpl: () => 1, maxRetries: 3 });
  const results = await q.enqueueRun(() => adapter.runBatch([ITEM]));
  // A FAILED submit POST never created tokens, so re-POSTing is safe — the
  // queue's retry semantics stay exactly as before for the submit phase.
  assert.equal(fetchImpl.posts(), 3);
  assert.equal(results[0].passed, true);
  assert.equal(results[0].status, "accepted");
});

test("composition: submit POST 502 is AMBIGUOUS (gateway may answer after the upstream billed) -> the queue does NOT retry; error surfaces", async () => {
  const fetchImpl = scriptedFetch({
    postResponses: [failure(502)],
    getResponses: []
  });
  const adapter = makeJudge0Adapter({
    baseUrl: "u", mode: "rapidapi", apiKey: "K",
    fetchImpl, pollIntervalMs: 0, sleepImpl: noSleep, randomImpl: () => 1
  });
  const q = makeExecQueue({ sleepImpl: noSleep, randomImpl: () => 1, maxRetries: 3 });
  await assert.rejects(
    adapter.runBatch([ITEM], gatesFor(q)),
    (err) => {
      assert.equal(err.status, 502);
      assert.equal(err.retryable, false);
      return true;
    }
  );
  // A 502 from the submit POST may mean the upstream already accepted (and
  // billed) the submissions before the gateway failed — re-POSTing risks a
  // double bill, so exactly ONE POST may ever happen.
  assert.equal(fetchImpl.posts(), 1, "ambiguous 502 submit POST must never be re-POSTed");
});

// ---- DEFECT 3: parked slots (gated wiring — the handler's shape) ------------
// The handler now passes the lanes as GATES: the run/submit lane wraps only
// the submit POSTs (so queue retries wrap only the submit phase), the poll
// lane only bounds concurrent GETs, and nothing holds a slot while a batch
// sleeps between polls.

const PENDING_SUB = { token: "t1", status: { id: 2, description: "Processing" },
  stdout: null, stderr: null, compile_output: null, time: null, memory: null };

test("composition (gated): submit POST 503s twice then succeeds -> the lane's queue retries wrap the submit phase, result correct", async () => {
  const fetchImpl = scriptedFetch({
    postResponses: [failure(503), failure(503), okJson([{ token: "t1" }])],
    getResponses: [okJson({ submissions: [DONE_SUB] })]
  });
  const adapter = makeJudge0Adapter({
    baseUrl: "u", mode: "rapidapi", apiKey: "K",
    fetchImpl, pollIntervalMs: 0, sleepImpl: noSleep, randomImpl: () => 1
  });
  const q = makeExecQueue({ sleepImpl: noSleep, randomImpl: () => 1, maxRetries: 3 });
  const results = await adapter.runBatch([ITEM], gatesFor(q));
  assert.equal(fetchImpl.posts(), 3); // failed POSTs created nothing -> retried by the lane
  assert.equal(fetchImpl.gets(), 1);
  assert.equal(results[0].passed, true);
});

test("composition (gated): a transient poll 503 is retried by the ADAPTER only — the poll lane adds no retries of its own", async () => {
  const fetchImpl = scriptedFetch({
    postResponses: [okJson([{ token: "t1" }])],
    getResponses: [failure(503), okJson({ submissions: [DONE_SUB] })]
  });
  const adapter = makeJudge0Adapter({
    baseUrl: "u", mode: "rapidapi", apiKey: "K",
    fetchImpl, pollIntervalMs: 0, sleepImpl: noSleep, randomImpl: () => 1
  });
  const q = makeExecQueue({ sleepImpl: noSleep, randomImpl: () => 1 });
  const results = await adapter.runBatch([ITEM], gatesFor(q));
  assert.equal(fetchImpl.posts(), 1);
  assert.equal(fetchImpl.gets(), 2); // ONE failure + ONE adapter retry — not lane-multiplied
  assert.equal(results[0].passed, true);
});

test("composition (gated): a lane slot is NOT held during the inter-poll sleep — a second job's submit POST proceeds while the first sleeps", async () => {
  // ONE-wide submit lane shared by both jobs (mirrors execRun's run lane).
  const q = makeExecQueue({ submitConcurrency: 1, sleepImpl: noSleep, randomImpl: () => 1 });
  const gates = gatesFor(q);

  // Job 1: first poll says "still processing", then the batch sleeps between
  // polls — the test HOLDS that sleep to freeze job 1 mid-poll-budget.
  const sleepHold = deferred();
  let job1Sleeping = false;
  const fetch1 = scriptedFetch({
    postResponses: [okJson([{ token: "t1" }])],
    getResponses: [okJson({ submissions: [PENDING_SUB] }), okJson({ submissions: [DONE_SUB] })]
  });
  const adapter1 = makeJudge0Adapter({
    baseUrl: "u", mode: "rapidapi", apiKey: "K",
    fetchImpl: fetch1, pollIntervalMs: 5,
    sleepImpl: async () => { job1Sleeping = true; await sleepHold.promise; }
  });
  const p1 = adapter1.runBatch([ITEM], gates);
  while (!job1Sleeping) await tick();
  assert.equal(fetch1.posts(), 1);

  // Job 2 through the SAME 1-wide submit lane: its submit POST must proceed
  // NOW — job 1 must not be parked on the lane while it sleeps between polls.
  const fetch2 = scriptedFetch({
    postResponses: [okJson([{ token: "t2" }])],
    getResponses: [okJson({ submissions: [{ ...DONE_SUB, token: "t2" }] })]
  });
  const adapter2 = makeJudge0Adapter({
    baseUrl: "u", mode: "rapidapi", apiKey: "K",
    fetchImpl: fetch2, pollIntervalMs: 0, sleepImpl: noSleep
  });
  const results2 = await adapter2.runBatch([ITEM], gates); // completes fully while job 1 still sleeps
  assert.equal(fetch2.posts(), 1, "second job's submit POST must not wait for the sleeping first job");
  assert.equal(results2[0].passed, true);

  // Release job 1's inter-poll sleep: it finishes normally.
  sleepHold.resolve();
  const results1 = await p1;
  assert.equal(results1[0].passed, true);
  assert.equal(fetch1.posts(), 1); // and was never re-submitted
});
