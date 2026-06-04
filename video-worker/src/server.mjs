import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { once } from "node:events";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { Storage } from "@google-cloud/storage";

const storage = new Storage();

const PORT = Number(process.env.PORT || "8080");
const SOURCE_BUCKET = process.env.SOURCE_BUCKET || "";
const DEST_BUCKET = process.env.DEST_BUCKET || "";
const WORKER_TOKEN = process.env.WORKER_TOKEN || "";
const MAX_USERNAMES_PER_REQUEST = Number(process.env.MAX_USERNAMES_PER_REQUEST || "25");

const server = http.createServer(async (req, res) => {
  try {
    setCors(req, res);
    if (req.method === "OPTIONS") return send(res, 204, "");

    const url = new URL(req.url || "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { ok: true, service: "proctor-video-worker" });
    }

    if (req.method === "POST" && url.pathname === "/merge") {
      requireAuth(req);
      const body = await readJson(req);
      const usernames = normalizeUsernames(body);
      const results = [];
      for (const username of usernames) {
        results.push(...(await mergeUsername(username)));
      }
      return sendJson(res, 200, { ok: true, results });
    }

    return sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    return sendJson(res, error.statusCode || 500, {
      error: error.statusCode ? error.message : "Internal server error",
      detail: String(error.message || error),
    });
  }
});

server.listen(PORT, () => {
  console.log(`video worker listening on ${PORT}`);
});

function requireAuth(req) {
  if (!WORKER_TOKEN) throw httpError(500, "WORKER_TOKEN is not configured");
  const header = req.headers.authorization || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const token = bearer || req.headers["x-worker-token"];
  if (token !== WORKER_TOKEN) throw httpError(401, "Unauthorized");
}

function normalizeUsernames(body) {
  const raw = Array.isArray(body.usernames) ? body.usernames : [body.username];
  const usernames = [...new Set(raw.map((item) => normalizeUsername(item)).filter(Boolean))];
  if (usernames.length === 0) throw httpError(400, "Provide username or usernames");
  if (usernames.length > MAX_USERNAMES_PER_REQUEST) {
    throw httpError(400, `At most ${MAX_USERNAMES_PER_REQUEST} usernames can be merged in one request`);
  }
  return usernames;
}

async function mergeUsername(username) {
  requireConfigured();
  // Phase 2 (2.1) contest-foldering: chunks may live under either the legacy
  // layout `sessions/<username>/<session_id>/screen/...` OR the new contest
  // layout `contests/<slug>/sessions/<username>/<session_id>/screen/...`. We scan
  // the legacy prefix directly and the `contests/` tree (filtered to this
  // username) so the worker keeps finding chunks regardless of layout.
  const [legacyFiles] = await storage.bucket(SOURCE_BUCKET).getFiles({
    prefix: `sessions/${username}/`,
  });
  const [contestFiles] = await storage.bucket(SOURCE_BUCKET).getFiles({
    prefix: `contests/`,
  });

  const chunks = [...legacyFiles, ...contestFiles]
    .map((file) => parseChunk(username, file.name))
    .filter(Boolean)
    // Key sessions by their full prefix so the same session_id under two
    // different contests never collides.
    .sort((a, b) => a.sessionKey.localeCompare(b.sessionKey) || a.chunkIndex - b.chunkIndex);

  const sessions = new Map();
  for (const chunk of chunks) {
    if (!sessions.has(chunk.sessionKey)) sessions.set(chunk.sessionKey, []);
    sessions.get(chunk.sessionKey).push(chunk);
  }

  if (sessions.size === 0) {
    return [{ username, status: "no_chunks_found" }];
  }

  const results = [];
  for (const sessionChunks of sessions.values()) {
    const result = await mergeSession(username, sessionChunks[0], sessionChunks);
    results.push(result);
  }
  return results;
}

async function mergeSession(username, descriptor, chunks) {
  const sessionId = descriptor.sessionId;
  // sessionPrefix is the full path up to and including `<session_id>/` — legacy
  // or contest-foldered — so the merged output lands beside the chunks it came
  // from (the contests/<slug>/... path when present).
  const sessionPrefix = descriptor.sessionPrefix;
  const workDir = path.join(os.tmpdir(), "aerele-video-worker", randomUUID());
  const screenDir = path.join(workDir, "screen");
  await mkdir(screenDir, { recursive: true });

  try {
    for (const chunk of chunks) {
      const destination = path.join(screenDir, `chunk-${String(chunk.chunkIndex).padStart(5, "0")}.webm`);
      await storage.bucket(SOURCE_BUCKET).file(chunk.objectName).download({ destination });
    }

    const rawOutputPath = path.join(workDir, `${username}-${sessionId}.raw-concat.webm`);
    const outputPath = path.join(workDir, `${username}-${sessionId}.webm`);
    const chunkNames = await concatenateWebmFiles(screenDir, rawOutputPath);
    await remuxWebm(rawOutputPath, outputPath);
    const durationSeconds = await probeDuration(outputPath);

    const outputObject = `${sessionPrefix}${username}-${sessionId}.webm`;
    const manifestObject = `${outputObject}.manifest.json`;
    await storage.bucket(DEST_BUCKET).upload(outputPath, {
      destination: outputObject,
      metadata: { contentType: "video/webm" },
    });
    await storage.bucket(DEST_BUCKET).file(manifestObject).save(
      `${JSON.stringify(
        {
          username,
          session_id: sessionId,
          contest_slug: descriptor.contestSlug || "",
          output: `gs://${DEST_BUCKET}/${outputObject}`,
          generated_at: new Date().toISOString(),
          chunk_count: chunkNames.length,
          chunks: chunkNames,
          duration_seconds: durationSeconds,
          merge_method: "ordered_binary_concat_then_ffmpeg_remux",
        },
        null,
        2,
      )}\n`,
      { contentType: "application/json" },
    );

    return {
      username,
      session_id: sessionId,
      contest_slug: descriptor.contestSlug || "",
      status: "merged",
      chunk_count: chunkNames.length,
      duration_seconds: durationSeconds,
      output: `gs://${DEST_BUCKET}/${outputObject}`,
      manifest: `gs://${DEST_BUCKET}/${manifestObject}`,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function parseChunk(username, objectName) {
  const user = escapeRegExp(username);
  // Contest-foldered layout (Phase 2): contests/<slug>/sessions/<user>/<sid>/screen/chunk-N.webm
  const contestMatch = objectName.match(
    new RegExp(`^contests/([^/]+)/sessions/${user}/([^/]+)/screen/chunk-(\\d+)\\.webm$`),
  );
  if (contestMatch) {
    return {
      contestSlug: contestMatch[1],
      sessionId: contestMatch[2],
      sessionPrefix: `contests/${contestMatch[1]}/sessions/${username}/${contestMatch[2]}/`,
      sessionKey: `contests/${contestMatch[1]}/sessions/${username}/${contestMatch[2]}/`,
      chunkIndex: Number(contestMatch[3]),
      objectName,
    };
  }
  // Legacy layout: sessions/<user>/<sid>/screen/chunk-N.webm
  const legacyMatch = objectName.match(
    new RegExp(`^sessions/${user}/([^/]+)/screen/chunk-(\\d+)\\.webm$`),
  );
  if (legacyMatch) {
    return {
      contestSlug: "",
      sessionId: legacyMatch[1],
      sessionPrefix: `sessions/${username}/${legacyMatch[1]}/`,
      sessionKey: `sessions/${username}/${legacyMatch[1]}/`,
      chunkIndex: Number(legacyMatch[2]),
      objectName,
    };
  }
  return null;
}

async function concatenateWebmFiles(screenDir, outputPath) {
  const files = (await readdir(screenDir))
    .filter((file) => /^chunk-\d+\.webm$/.test(file))
    .sort((a, b) => a.localeCompare(b));

  if (files.length === 0) throw httpError(404, `No chunks found in ${screenDir}`);

  const output = createWriteStream(outputPath);
  for (const file of files) {
    const input = createReadStream(path.join(screenDir, file));
    for await (const chunk of input) {
      if (!output.write(chunk)) await once(output, "drain");
    }
  }
  output.end();
  await once(output, "finish");
  return files;
}

async function remuxWebm(inputPath, outputPath) {
  await sh("ffmpeg", [
    "-hide_banner",
    "-y",
    "-fflags",
    "+genpts",
    "-i",
    inputPath,
    "-c",
    "copy",
    outputPath,
  ]);
}

async function probeDuration(videoPath) {
  try {
    const { stdout } = await sh("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nw=1:nk=1",
      videoPath,
    ]);
    const duration = Number(stdout.trim());
    return Number.isFinite(duration) ? duration : null;
  } catch {
    return null;
  }
}

async function sh(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(httpError(500, `${command} failed with ${code}: ${stderr || stdout}`));
    });
  });
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, "Invalid JSON");
  }
}

function setCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Worker-Token");
}

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

function send(res, status, text) {
  res.statusCode = status;
  res.end(text);
}

function requireConfigured() {
  if (!SOURCE_BUCKET || !DEST_BUCKET) throw httpError(500, "SOURCE_BUCKET and DEST_BUCKET are required");
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "_").slice(0, 80);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
