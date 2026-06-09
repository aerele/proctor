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

export function makeJudge0Adapter({ baseUrl, mode, apiKey, authToken, fetchImpl = fetch, pollIntervalMs = 1000, maxPolls = 90 }) {
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
    if (!res.ok) throw new Error(`judge0 submit failed: ${res.status}`);
    const tokens = await res.json(); // [{token}, ...]
    return tokens.map((t) => t.token);
  }

  async function submitBatch(items) {
    const tokens = [];
    for (let i = 0; i < items.length; i += BATCH_CHUNK) {
      tokens.push(...await submitChunk(items.slice(i, i + BATCH_CHUNK)));
    }
    return tokens;
  }

  async function fetchChunk(tokens) {
    const q = tokens.join(",");
    const res = await fetchImpl(`${baseUrl}/submissions/batch?base64_encoded=true&tokens=${q}`, { headers });
    if (!res.ok) throw new Error(`judge0 fetch failed: ${res.status}`);
    const data = await res.json();
    return data.submissions;
  }

  async function fetchBatch(tokens) {
    const subs = [];
    for (let i = 0; i < tokens.length; i += BATCH_CHUNK) {
      subs.push(...await fetchChunk(tokens.slice(i, i + BATCH_CHUNK)));
    }
    return subs;
  }

  async function sleep(ms) { if (ms > 0) await new Promise((r) => setTimeout(r, ms)); }

  return {
    async runBatch(items) {
      const tokens = await submitBatch(items);
      const subs = new Array(tokens.length).fill(null);
      // Poll only UNFINISHED tokens each round-trip (status id 1/2) to cut
      // request volume on the hosted tier (design §11).
      let pendingIdx = tokens.map((_, i) => i);
      for (let poll = 0; poll < maxPolls && pendingIdx.length > 0; poll++) {
        if (poll > 0) await sleep(pollIntervalMs);
        const fetched = await fetchBatch(pendingIdx.map((i) => tokens[i]));
        const stillPending = [];
        fetched.forEach((s, j) => {
          const idx = pendingIdx[j];
          subs[idx] = s;
          if (!isDone(s)) stillPending.push(idx);
        });
        pendingIdx = stillPending;
      }
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
  };
}
