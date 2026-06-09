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
    { languageId: 71, source: "print('ok')", stdin: "", expectedOutput: "ok" }
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
