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
