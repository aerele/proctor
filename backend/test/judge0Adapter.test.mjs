// backend/test/judge0Adapter.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeJudge0Adapter } from "../src/judge0Adapter.mjs";

// A fake fetch that records calls and returns scripted responses.
function fakeFetch(script) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const next = script.shift();
    return { ok: true, status: 200, json: async () => next };
  };
  fn.calls = calls;
  return fn;
}

// A fake fetch that always fails with the given HTTP status (+ optional
// headers, matched case-insensitively like the real Headers.get).
function failingFetch(status, headers = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return async () => ({
    ok: false, status,
    headers: { get: (name) => lower[String(name).toLowerCase()] ?? null },
    json: async () => ({})
  });
}

const ITEM = { languageId: 71, source: "x", stdin: "", expectedOutput: "ok", cpuTimeLimit: 5, memoryLimit: 128000 };

test("failed submit carries .status so the exec queue can decide retryability", async () => {
  const adapter = makeJudge0Adapter({ baseUrl: "u", mode: "rapidapi", apiKey: "K", fetchImpl: failingFetch(503), pollIntervalMs: 0 });
  await assert.rejects(adapter.runBatch([ITEM]), (err) => {
    assert.equal(err.status, 503);
    assert.equal(err.retryAfterMs, undefined); // no Retry-After header sent
    return true;
  });
});

test("failed submit parses a SECONDS Retry-After header into .retryAfterMs", async () => {
  const adapter = makeJudge0Adapter({ baseUrl: "u", mode: "rapidapi", apiKey: "K",
    fetchImpl: failingFetch(429, { "Retry-After": "2" }), pollIntervalMs: 0 });
  await assert.rejects(adapter.runBatch([ITEM]), (err) => {
    assert.equal(err.status, 429);
    assert.equal(err.retryAfterMs, 2000);
    return true;
  });
});

test("failed submit parses an HTTP-DATE Retry-After header into .retryAfterMs (clamped >= 0)", async () => {
  // A date ~5 s in the future -> a positive ms delay no larger than 5 s.
  const future = new Date(Date.now() + 5000).toUTCString();
  const adapter = makeJudge0Adapter({ baseUrl: "u", mode: "rapidapi", apiKey: "K",
    fetchImpl: failingFetch(429, { "Retry-After": future }), pollIntervalMs: 0 });
  await assert.rejects(adapter.runBatch([ITEM]), (err) => {
    assert.equal(err.status, 429);
    assert.equal(typeof err.retryAfterMs, "number");
    assert.ok(err.retryAfterMs > 0 && err.retryAfterMs <= 5000, `got ${err.retryAfterMs}`);
    return true;
  });
  // A date in the PAST clamps to 0 (retry immediately), never negative.
  const past = new Date(Date.now() - 5000).toUTCString();
  const adapter2 = makeJudge0Adapter({ baseUrl: "u", mode: "rapidapi", apiKey: "K",
    fetchImpl: failingFetch(429, { "Retry-After": past }), pollIntervalMs: 0 });
  await assert.rejects(adapter2.runBatch([ITEM]), (err) => {
    assert.equal(err.retryAfterMs, 0);
    return true;
  });
});

test("failed token POLL also carries .status + .retryAfterMs", async () => {
  // Submit succeeds, then the batch GET fails 502 with Retry-After.
  let call = 0;
  const fetchImpl = async () => {
    call++;
    if (call === 1) return { ok: true, status: 200, json: async () => [{ token: "t" }] };
    return { ok: false, status: 502,
      headers: { get: (n) => (String(n).toLowerCase() === "retry-after" ? "1" : null) },
      json: async () => ({}) };
  };
  const adapter = makeJudge0Adapter({ baseUrl: "u", mode: "rapidapi", apiKey: "K", fetchImpl, pollIntervalMs: 0 });
  await assert.rejects(adapter.runBatch([ITEM]), (err) => {
    assert.equal(err.status, 502);
    assert.equal(err.retryAfterMs, 1000);
    return true;
  });
});

test("an unparseable Retry-After header leaves .retryAfterMs undefined", async () => {
  const adapter = makeJudge0Adapter({ baseUrl: "u", mode: "rapidapi", apiKey: "K",
    fetchImpl: failingFetch(429, { "Retry-After": "soon-ish" }), pollIntervalMs: 0 });
  await assert.rejects(adapter.runBatch([ITEM]), (err) => {
    assert.equal(err.status, 429);
    assert.equal(err.retryAfterMs, undefined);
    return true;
  });
});

test("runBatch: base64-encodes source/stdin, submits async, polls token, normalizes result", async () => {
  const fetch = fakeFetch([
    [{ token: "tok-1" }],                                   // POST /submissions/batch -> tokens
    { submissions: [{ token: "tok-1", status: { id: 3, description: "Accepted" },
                      stdout: Buffer.from("ok\n").toString("base64"),
                      stderr: null, compile_output: null, time: "0.01", memory: 256 }] } // GET batch -> done
  ]);
  const adapter = makeJudge0Adapter({
    baseUrl: "https://judge0-ce.p.rapidapi.com",
    mode: "rapidapi", apiKey: "K", fetchImpl: fetch, pollIntervalMs: 0
  });
  const results = await adapter.runBatch([
    { languageId: 71, source: "print('ok')", stdin: "", expectedOutput: "ok", cpuTimeLimit: 5, memoryLimit: 128000 }
  ]);
  // submit call was base64 + async
  const submit = fetch.calls[0];
  assert.match(submit.url, /\/submissions\/batch\?base64_encoded=true/);
  assert.equal(submit.opts.headers["X-RapidAPI-Key"], "K");
  // The RapidAPI/Cloudflare edge 403s (error 1010) requests without a browser
  // User-Agent — every request must carry one (design §11 item 0).
  assert.equal(typeof submit.opts.headers["User-Agent"], "string");
  assert.ok(submit.opts.headers["User-Agent"].length > 0);
  const body = JSON.parse(submit.opts.body);
  assert.equal(body.submissions[0].source_code, Buffer.from("print('ok')").toString("base64"));
  // Security: candidate code must NEVER get network on the shared CE instance
  // (design §11 item 1) — sent explicitly on every submission.
  assert.equal(body.submissions[0].enable_network, false);
  // Full explicit limit set on every submission — never rely on server
  // defaults (design §11, determinism under concurrent load).
  assert.equal(body.submissions[0].cpu_time_limit, 5);
  assert.equal(body.submissions[0].wall_time_limit, 10); // default 2x cpu
  assert.equal(body.submissions[0].memory_limit, 128000);
  assert.equal(body.submissions[0].stack_limit, 64000);
  assert.equal(body.submissions[0].max_processes_and_or_threads, 60);
  assert.equal(body.submissions[0].max_file_size, 1024);
  // normalized result
  assert.equal(results[0].status, "accepted");
  assert.equal(results[0].stdout, "ok\n");
  assert.equal(results[0].passed, true); // stdout trimmed === expectedOutput trimmed
});

test("runBatch: wrong output -> passed:false, status wrong_answer", async () => {
  const fetch = fakeFetch([
    [{ token: "t" }],
    { submissions: [{ token: "t", status: { id: 4, description: "Wrong Answer" },
                      stdout: Buffer.from("nope\n").toString("base64"), stderr: null,
                      compile_output: null, time: "0.01", memory: 256 }] }
  ]);
  const adapter = makeJudge0Adapter({ baseUrl: "u", mode: "rapidapi", apiKey: "K", fetchImpl: fetch, pollIntervalMs: 0 });
  const r = await adapter.runBatch([{ languageId: 71, source: "x", stdin: "", expectedOutput: "ok" }]);
  assert.equal(r[0].passed, false);
  assert.equal(r[0].status, "wrong_answer");
  // Even when the item omits limits, the adapter must still send explicit
  // numeric limits (stock CE defaults) — never fall through to server defaults.
  const sub = JSON.parse(fetch.calls[0].opts.body).submissions[0];
  assert.equal(sub.cpu_time_limit, 5);
  assert.equal(sub.wall_time_limit, 10);
  assert.equal(sub.memory_limit, 128000);
});

test("runBatch: compile error surfaces compile_output and status compile_error", async () => {
  const fetch = fakeFetch([
    [{ token: "t" }],
    { submissions: [{ token: "t", status: { id: 6, description: "Compilation Error" },
                      stdout: null, stderr: null,
                      compile_output: Buffer.from("err: bad").toString("base64"), time: null, memory: null }] }
  ]);
  const adapter = makeJudge0Adapter({ baseUrl: "u", mode: "rapidapi", apiKey: "K", fetchImpl: fetch, pollIntervalMs: 0 });
  const r = await adapter.runBatch([{ languageId: 54, source: "bad", stdin: "", expectedOutput: "x" }]);
  assert.equal(r[0].status, "compile_error");
  assert.equal(r[0].compileOutput, "err: bad");
  assert.equal(r[0].passed, false);
});

test("runBatch: explicit wallTimeLimit is used; default 2x cpu is capped at 20", async () => {
  const done = (token) => ({ token, status: { id: 3, description: "Accepted" },
    stdout: Buffer.from("ok\n").toString("base64"), stderr: null, compile_output: null, time: "0.01", memory: 256 });
  const fetch = fakeFetch([
    [{ token: "a" }, { token: "b" }],
    { submissions: [done("a"), done("b")] }
  ]);
  const adapter = makeJudge0Adapter({ baseUrl: "u", mode: "rapidapi", apiKey: "K", fetchImpl: fetch, pollIntervalMs: 0 });
  await adapter.runBatch([
    { languageId: 71, source: "x", stdin: "", expectedOutput: "ok", cpuTimeLimit: 5, memoryLimit: 128000, wallTimeLimit: 8 },
    { languageId: 71, source: "y", stdin: "", expectedOutput: "ok", cpuTimeLimit: 15, memoryLimit: 128000 } // 2x15=30 -> cap 20
  ]);
  const body = JSON.parse(fetch.calls[0].opts.body);
  assert.equal(body.submissions[0].wall_time_limit, 8);
  assert.equal(body.submissions[1].wall_time_limit, 20);
});

test("runBatch: chunks submissions to <=20 per batch POST, results concatenated in order", async () => {
  const N = 25;
  const items = Array.from({ length: N }, (_, i) => ({
    languageId: 71, source: `print(${i})`, stdin: "", expectedOutput: String(i),
    cpuTimeLimit: 5, memoryLimit: 128000
  }));
  const doneSub = (i) => ({ token: `tok-${i}`, status: { id: 3, description: "Accepted" },
    stdout: Buffer.from(`${i}\n`).toString("base64"), stderr: null, compile_output: null, time: "0.01", memory: 256 });
  const fetch = fakeFetch([
    Array.from({ length: 20 }, (_, i) => ({ token: `tok-${i}` })),            // POST chunk 1 -> 20 tokens
    Array.from({ length: 5 }, (_, i) => ({ token: `tok-${20 + i}` })),        // POST chunk 2 -> 5 tokens
    { submissions: Array.from({ length: 20 }, (_, i) => doneSub(i)) },        // GET chunk 1
    { submissions: Array.from({ length: 5 }, (_, i) => doneSub(20 + i)) }     // GET chunk 2
  ]);
  const adapter = makeJudge0Adapter({ baseUrl: "u", mode: "rapidapi", apiKey: "K", fetchImpl: fetch, pollIntervalMs: 0 });
  const results = await adapter.runBatch(items);
  // two submit POSTs of 20 + 5
  const posts = fetch.calls.filter((c) => c.opts && c.opts.method === "POST");
  assert.equal(posts.length, 2);
  assert.equal(JSON.parse(posts[0].opts.body).submissions.length, 20);
  assert.equal(JSON.parse(posts[1].opts.body).submissions.length, 5);
  // results concatenated in original item order
  assert.equal(results.length, N);
  for (let i = 0; i < N; i++) {
    assert.equal(results[i].stdout, `${i}\n`);
    assert.equal(results[i].passed, true);
  }
});

test("runBatch: polls exhausted with submissions still queued/processing -> judging_timeout, not error", async () => {
  const queued = { token: "t", status: { id: 2, description: "Processing" },
    stdout: null, stderr: null, compile_output: null, time: null, memory: null };
  const fetch = fakeFetch([
    [{ token: "t" }],
    { submissions: [queued] },
    { submissions: [queued] }
  ]);
  const adapter = makeJudge0Adapter({ baseUrl: "u", mode: "rapidapi", apiKey: "K", fetchImpl: fetch, pollIntervalMs: 0, maxPolls: 2 });
  const r = await adapter.runBatch([{ languageId: 71, source: "x", stdin: "", expectedOutput: "ok", cpuTimeLimit: 5, memoryLimit: 128000 }]);
  assert.equal(r[0].status, "judging_timeout"); // distinguishable from "error"
  assert.equal(r[0].passed, false);
});

test("runBatch: re-polls only unfinished tokens; finished results keep original order", async () => {
  const doneA = { token: "tok-a", status: { id: 3, description: "Accepted" },
    stdout: Buffer.from("A\n").toString("base64"), stderr: null, compile_output: null, time: "0.01", memory: 256 };
  const pendingB = { token: "tok-b", status: { id: 1, description: "In Queue" },
    stdout: null, stderr: null, compile_output: null, time: null, memory: null };
  const doneB = { token: "tok-b", status: { id: 3, description: "Accepted" },
    stdout: Buffer.from("B\n").toString("base64"), stderr: null, compile_output: null, time: "0.02", memory: 300 };
  const fetch = fakeFetch([
    [{ token: "tok-a" }, { token: "tok-b" }],
    { submissions: [doneA, pendingB] },   // poll 1: a done, b queued
    { submissions: [doneB] }              // poll 2: must ask ONLY for tok-b
  ]);
  const adapter = makeJudge0Adapter({ baseUrl: "u", mode: "rapidapi", apiKey: "K", fetchImpl: fetch, pollIntervalMs: 0 });
  const results = await adapter.runBatch([
    { languageId: 71, source: "a", stdin: "", expectedOutput: "A", cpuTimeLimit: 5, memoryLimit: 128000 },
    { languageId: 71, source: "b", stdin: "", expectedOutput: "B", cpuTimeLimit: 5, memoryLimit: 128000 }
  ]);
  // second poll fetched only the unfinished token
  const polls = fetch.calls.filter((c) => /tokens=/.test(c.url));
  assert.equal(polls.length, 2);
  assert.match(polls[0].url, /tokens=tok-a%2Ctok-b|tokens=tok-a,tok-b/);
  assert.match(polls[1].url, /tokens=tok-b(&|$)/);
  assert.ok(!/tok-a/.test(polls[1].url.split("tokens=")[1]));
  // original order preserved
  assert.equal(results[0].stdout, "A\n");
  assert.equal(results[1].stdout, "B\n");
  assert.equal(results[0].passed, true);
  assert.equal(results[1].passed, true);
});
