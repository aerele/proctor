// backend/src/judge0Adapter.mjs
// Swap-able Judge0 engine. mode: "rapidapi" (hosted now) | "selfhosted" (later, config flip).
// The rest of the app only knows runBatch(); base URL + auth come from config.

const b64 = (s) => Buffer.from(s ?? "", "utf8").toString("base64");
const unb64 = (s) => (s ? Buffer.from(s, "base64").toString("utf8") : "");

// The RapidAPI/Cloudflare edge 403s (error 1010) any request without a browser
// User-Agent — send one on EVERY request in BOTH modes (design §11 item 0).
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Judge0 status.id -> our normalized status. 1/2 = In Queue/Processing (not done).
function normalizeStatus(id) {
  if (id === 3) return "accepted";
  if (id === 4) return "wrong_answer";
  if (id === 5) return "time_limit";
  if (id === 6) return "compile_error";
  if (id >= 7 && id <= 12) return "runtime_error";
  return "error";
}

export function makeJudge0Adapter({ baseUrl, mode, apiKey, authToken, fetchImpl = fetch, pollIntervalMs = 400, maxPolls = 40 }) {
  const headers = mode === "rapidapi"
    ? { "Content-Type": "application/json", "User-Agent": BROWSER_UA, "X-RapidAPI-Key": apiKey, "X-RapidAPI-Host": "judge0-ce.p.rapidapi.com" }
    : { "Content-Type": "application/json", "User-Agent": BROWSER_UA, "X-Auth-Token": authToken };

  async function submitBatch(items) {
    const submissions = items.map((it) => ({
      language_id: it.languageId,
      source_code: b64(it.source),
      stdin: b64(it.stdin),
      cpu_time_limit: it.cpuTimeLimit, memory_limit: it.memoryLimit
    }));
    const res = await fetchImpl(`${baseUrl}/submissions/batch?base64_encoded=true&wait=false`, {
      method: "POST", headers, body: JSON.stringify({ submissions })
    });
    if (!res.ok) throw new Error(`judge0 submit failed: ${res.status}`);
    const tokens = await res.json(); // [{token}, ...]
    return tokens.map((t) => t.token);
  }

  async function fetchBatch(tokens) {
    const q = tokens.join(",");
    const res = await fetchImpl(`${baseUrl}/submissions/batch?base64_encoded=true&tokens=${q}`, { headers });
    if (!res.ok) throw new Error(`judge0 fetch failed: ${res.status}`);
    const data = await res.json();
    return data.submissions;
  }

  async function sleep(ms) { if (ms > 0) await new Promise((r) => setTimeout(r, ms)); }

  return {
    async runBatch(items) {
      const tokens = await submitBatch(items);
      let subs = [];
      for (let i = 0; i < maxPolls; i++) {
        subs = await fetchBatch(tokens);
        if (subs.every((s) => s.status && s.status.id >= 3)) break; // all done
        await sleep(pollIntervalMs);
      }
      return subs.map((s, idx) => {
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
