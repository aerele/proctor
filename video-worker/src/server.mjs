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
  const [files] = await storage.bucket(SOURCE_BUCKET).getFiles({
    prefix: `sessions/${username}/`,
  });

  const chunks = files
    .map((file) => parseChunk(username, file.name))
    .filter(Boolean)
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId) || a.chunkIndex - b.chunkIndex);

  const sessions = new Map();
  for (const chunk of chunks) {
    if (!sessions.has(chunk.sessionId)) sessions.set(chunk.sessionId, []);
    sessions.get(chunk.sessionId).push(chunk);
  }

  if (sessions.size === 0) {
    return [{ username, status: "no_chunks_found" }];
  }

  const results = [];
  for (const [sessionId, sessionChunks] of sessions.entries()) {
    const result = await mergeSession(username, sessionId, sessionChunks);
    results.push(result);
  }
  return results;
}

async function mergeSession(username, sessionId, chunks) {
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

    const outputObject = `sessions/${username}/${sessionId}/${username}-${sessionId}.webm`;
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
  const match = objectName.match(new RegExp(`^sessions/${escapeRegExp(username)}/([^/]+)/screen/chunk-(\\d+)\\.webm$`));
  if (!match) return null;
  return {
    sessionId: match[1],
    chunkIndex: Number(match[2]),
    objectName,
  };
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
