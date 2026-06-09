// backend/src/judge0Adapter.mjs
// Swap-able Judge0 engine. mode: "rapidapi" (hosted now) | "selfhosted" (later, config flip).
// The rest of the app only knows runBatch(); base URL + auth come from config.

const b64 = (s) => Buffer.from(s ?? "", "utf8").toString("base64");
const unb64 = (s) => (s ? Buffer.from(s, "base64").toString("utf8") : "");

// The RapidAPI/Cloudflare edge 403s (error 1010) any request without a browser
// User-Agent — send one on EVERY request in BOTH modes (design §11 item 0).
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Judge0 caps POST /submissions/batch at 20 submissions per request (design
// §11) — chunk both submits and token fetches to stay under it.
const BATCH_CHUNK = 20;

// Judge0 wall_time_limit hard max (design §11 limits table).
const WALL_TIME_MAX_SEC = 20;

// Judge0 status.id -> our normalized status. 1/2 = In Queue/Processing — if we
// still see them after the poll budget, the submission never finished judging;
// surface that as "judging_timeout" (NOT "error") so callers can tell
// never-finished apart from crashed (design §11).
function normalizeStatus(id) {
  if (id === 1 || id === 2) return "judging_timeout";
  if (id === 3) return "accepted";
  if (id === 4) return "wrong_answer";
  if (id === 5) return "time_limit";
  if (id === 6) return "compile_error";
  if (id >= 7 && id <= 12) return "runtime_error";
  return "error";
}

const isDone = (s) => Boolean(s && s.status && s.status.id >= 3);

// Retry-After header -> milliseconds. Two RFC forms: delta-seconds ("2") or an
// HTTP-date ("Wed, 21 Oct 2026 07:28:00 GMT"). Past dates clamp to 0 (retry
// now); unparseable values return undefined (caller falls back to jitter).
function parseRetryAfterMs(header) {
  if (header == null || header === "") return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

// Failed HTTP exchange -> Error carrying .status (+ .retryAfterMs when the
// server sent Retry-After) so the exec queue layer (design §11 item 2) can
// classify retryability and honor server-requested delays.
function httpFailure(action, res) {
  const error = new Error(`judge0 ${action} failed: ${res.status}`);
  error.status = res.status;
  const retryAfterMs = parseRetryAfterMs(res.headers?.get?.("retry-after"));
  if (retryAfterMs !== undefined) error.retryAfterMs = retryAfterMs;
  return error;
}

// Transient engine pushback worth retrying INSIDE the adapter during the poll
// phase (same set the exec queue uses). Poll retries must never escape to the
// queue: once the submit POST succeeded the submissions exist (and are
// BILLED), and a queue-level retry re-runs the whole batch — re-submitting and
// re-billing it. So transient poll failures are retried here, against the GET
// only, and whatever still escapes after the submit phase carries
// retryable:false so the queue never retries it.
const POLL_RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

// Submit-POST statuses that are AMBIGUOUS about billing: a gateway can return
// 502/504 AFTER the upstream already accepted (and billed) the submissions, so
// a queue-level re-POST risks a double bill. Only 429/503 — pushback the
// engine sends BEFORE doing any work — stay queue-retryable for the submit
// phase. (Poll GETs are idempotent, so 502/504 remain retryable there.)
const SUBMIT_AMBIGUOUS_STATUSES = new Set([502, 504]);

// Mark an error as never-queue-retryable (see POLL_RETRYABLE_STATUSES above).
function markNonRetryable(err) {
  if (err && typeof err === "object") err.retryable = false;
  return err;
}

export function makeJudge0Adapter({
  baseUrl, mode, apiKey, authToken, fetchImpl = fetch, pollIntervalMs = 1000, maxPolls = 90,
  // Internal poll-phase retry budget (TOTAL extra GETs per runBatch, across
  // all poll rounds) + the same backoff shape the exec queue uses: server
  // Retry-After wins, else full jitter on an exponential base.
  maxPollRetries = 5, pollRetryBaseDelayMs = 1000,
  sleepImpl, randomImpl = Math.random
}) {
  const sleepFn = sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const headers = mode === "rapidapi"
    ? { "Content-Type": "application/json", "User-Agent": BROWSER_UA, "X-RapidAPI-Key": apiKey, "X-RapidAPI-Host": "judge0-ce.p.rapidapi.com" }
    : { "Content-Type": "application/json", "User-Agent": BROWSER_UA, "X-Auth-Token": authToken };

  async function submitChunk(items) {
    const submissions = items.map((it) => ({
      language_id: it.languageId,
      source_code: b64(it.source),
      stdin: b64(it.stdin),
      // Security: never let candidate code reach the network on the shared CE
      // instance (design §11 item 1) — explicit on EVERY submission.
      enable_network: false,
      // Full explicit limit set — never rely on server defaults (design §11).
      // Items normally carry limits from the problem config; if one is
      // missing, still send an explicit number (stock CE defaults: 5 s /
      // 128000 KB) rather than letting the server decide.
      cpu_time_limit: it.cpuTimeLimit ?? 5,
      wall_time_limit: Math.min(it.wallTimeLimit ?? (it.cpuTimeLimit ?? 5) * 2, WALL_TIME_MAX_SEC),
      memory_limit: it.memoryLimit ?? 128000,
      stack_limit: 64000,
      max_processes_and_or_threads: 60,
      max_file_size: 1024
    }));
    const res = await fetchImpl(`${baseUrl}/submissions/batch?base64_encoded=true&wait=false`, {
      method: "POST", headers, body: JSON.stringify({ submissions })
    });
    if (!res.ok) {
      const err = httpFailure("submit", res);
      // 502/504 may have billed upstream (see SUBMIT_AMBIGUOUS_STATUSES) —
      // never let the queue re-POST them.
      if (SUBMIT_AMBIGUOUS_STATUSES.has(err.status)) markNonRetryable(err);
      throw err;
    }
    // The POST returned 2xx: the submissions now EXIST (and are billed). Any
    // failure from here on (e.g. the body failing to parse) must carry an
    // EXPLICIT retryable:false set at this billing point — never rely on the
    // error merely lacking .status.
    try {
      const tokens = await res.json(); // [{token}, ...]
      return tokens.map((t) => t.token);
    } catch (err) {
      throw markNonRetryable(err);
    }
  }

  async function submitBatch(items) {
    const tokens = [];
    let anyChunkSucceeded = false;
    for (let i = 0; i < items.length; i += BATCH_CHUNK) {
      try {
        tokens.push(...await submitChunk(items.slice(i, i + BATCH_CHUNK)));
        anyChunkSucceeded = true;
      } catch (err) {
        // A failed POST created nothing, so retrying it is safe — but once ANY
        // earlier chunk POST succeeded, those submissions are already billed:
        // a queue-level retry would re-submit (and re-bill) them.
        if (anyChunkSucceeded) throw markNonRetryable(err);
        throw err;
      }
    }
    return tokens;
  }

  async function fetchChunk(tokens) {
    const q = tokens.join(",");
    const res = await fetchImpl(`${baseUrl}/submissions/batch?base64_encoded=true&tokens=${q}`, { headers });
    if (!res.ok) throw httpFailure("fetch", res);
    const data = await res.json();
    return data.submissions;
  }

  // Each chunked status GET runs inside the (optional) gate individually, so
  // a slot is held per round-trip — never across the chunk loop as a whole.
  async function fetchBatch(tokens, gate = (fn) => fn()) {
    const subs = [];
    for (let i = 0; i < tokens.length; i += BATCH_CHUNK) {
      const chunk = tokens.slice(i, i + BATCH_CHUNK);
      subs.push(...await gate(() => fetchChunk(chunk)));
    }
    return subs;
  }

  async function sleep(ms) { if (ms > 0) await sleepFn(ms); }

  return {
    // Optional async GATES (defect 3 — parked slots): submitGate wraps the
    // submit POSTs, pollGate wraps EACH status-GET round-trip, and all waiting
    // (inter-poll sleep, retry backoff) happens OUTSIDE any gate — so a queue
    // lane slot is held per HTTP call, never across the whole ~90 s poll
    // budget. With the lanes passed as gates, the queue's retry layer wraps
    // ONLY the submit phase (consistent with the poll-retries-live-here rule).
    async runBatch(items, { submitGate, pollGate } = {}) {
      const viaSubmit = submitGate ?? ((fn) => fn());
      const viaPoll = pollGate ?? ((fn) => fn());
      const tokens = await viaSubmit(() => submitBatch(items));
      // The submissions now EXIST (and are billed). From here on, NO error may
      // escape as queue-retryable: transient poll failures are retried right
      // here against the GET only (never re-submitting), and whatever still
      // fails is marked retryable:false before it propagates.
      let pollRetryBudget = maxPollRetries;
      const fetchBatchWithRetry = async (batchTokens) => {
        for (let attempt = 0; ; attempt++) {
          try {
            // The poll gate bounds each GET round-trip ONLY — the backoff
            // sleep below happens after the gate is released.
            return await fetchBatch(batchTokens, viaPoll);
          } catch (err) {
            if (!POLL_RETRYABLE_STATUSES.has(err?.status) || pollRetryBudget <= 0) {
              throw markNonRetryable(err);
            }
            pollRetryBudget--;
            const delayMs = typeof err.retryAfterMs === "number"
              ? err.retryAfterMs
              : randomImpl() * pollRetryBaseDelayMs * 2 ** attempt;
            await sleep(delayMs);
          }
        }
      };
      try {
        const subs = new Array(tokens.length).fill(null);
        // Poll only UNFINISHED tokens each round-trip (status id 1/2) to cut
        // request volume on the hosted tier (design §11).
        let pendingIdx = tokens.map((_, i) => i);
        for (let poll = 0; poll < maxPolls && pendingIdx.length > 0; poll++) {
          if (poll > 0) await sleep(pollIntervalMs);
          const fetched = await fetchBatchWithRetry(pendingIdx.map((i) => tokens[i]));
          const stillPending = [];
          fetched.forEach((s, j) => {
            const idx = pendingIdx[j];
            subs[idx] = s;
            if (!isDone(s)) stillPending.push(idx);
          });
          pendingIdx = stillPending;
        }
        return normalizeResults(subs, items);
      } catch (err) {
        // Belt-and-braces: anything unexpected in the poll/normalize phase
        // (not just HTTP failures) must also never trigger a queue re-submit.
        throw markNonRetryable(err);
      }
    }
  };

  function normalizeResults(subs, items) {
    return subs.map((s, idx) => {
      // Never fetched (poll budget 0) -> never finished judging.
      if (!s) {
        return { status: "judging_timeout", passed: false, stdout: "", stderr: "", compileOutput: "", timeSec: null, memoryKb: null };
      }
      const status = normalizeStatus(s.status?.id);
      const stdout = unb64(s.stdout);
      const expected = items[idx].expectedOutput ?? "";
      const passed = status === "accepted" && stdout.trim() === String(expected).trim();
      return {
        status: passed ? "accepted" : (status === "accepted" ? "wrong_answer" : status),
        passed,
        stdout,
        stderr: unb64(s.stderr),
        compileOutput: unb64(s.compile_output),
        timeSec: s.time ? Number(s.time) : null,
        memoryKb: s.memory ?? null
      };
    });
  }
}
