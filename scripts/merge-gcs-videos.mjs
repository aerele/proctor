#!/usr/bin/env node

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import os from "node:os";

function parseArgs(argv) {
  const args = {
    sourceBucket: process.env.SOURCE_BUCKET || "",
    destBucket: process.env.DEST_BUCKET || "",
    tmpRoot: path.join(os.tmpdir(), "aerele-proctor-merged-videos"),
    keepTmp: false,
    usernames: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--source-bucket") args.sourceBucket = argv[++i];
    else if (arg === "--dest-bucket") args.destBucket = argv[++i];
    else if (arg === "--tmp-root") args.tmpRoot = argv[++i];
    else if (arg === "--keep-tmp") args.keepTmp = true;
    else if (arg === "--usernames-file") {
      const contents = readFileSync(argv[++i], "utf8");
      args.usernames.push(...contents.split(/\r?\n/).map((v) => v.trim()).filter(Boolean));
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      args.usernames.push(arg.trim());
    }
  }

  return args;
}

async function sh(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
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
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed with ${code}\n${stderr || stdout}`));
      }
    });
  });
}

async function listObjects(bucket, prefix) {
  const { stdout } = await sh("gcloud", ["storage", "ls", `gs://${bucket}/${prefix}`]);
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function parseSessionAndChunk(objectUrl) {
  const match = objectUrl.match(/\/sessions\/([^/]+)\/([^/]+)\/screen\/chunk-(\d+)\.webm$/);
  if (!match) return null;
  return {
    username: match[1],
    sessionId: match[2],
    chunkIndex: Number(match[3]),
    objectUrl,
  };
}

async function downloadChunks(chunks, sessionDir) {
  const screenDir = path.join(sessionDir, "screen");
  await mkdir(screenDir, { recursive: true });
  for (const chunk of chunks) {
    const destination = path.join(screenDir, `chunk-${String(chunk.chunkIndex).padStart(5, "0")}.webm`);
    await sh("gcloud", ["storage", "cp", chunk.objectUrl, destination]);
  }
  return screenDir;
}

async function concatenateWebmFiles(screenDir, outputPath) {
  const files = (await readdir(screenDir))
    .filter((file) => /^chunk-\d+\.webm$/.test(file))
    .sort((a, b) => a.localeCompare(b));

  if (files.length === 0) {
    throw new Error(`No chunks found in ${screenDir}`);
  }

  const output = createWriteStream(outputPath);
  for (const file of files) {
    const input = createReadStream(path.join(screenDir, file));
    for await (const chunk of input) {
      if (!output.write(chunk)) await once(output, "drain");
    }
  }
  output.end();

  await new Promise((resolve, reject) => {
    output.on("finish", resolve);
    output.on("error", reject);
  });

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

async function uploadMergedVideo(destBucket, username, sessionId, outputPath, files, durationSeconds) {
  const destination = `gs://${destBucket}/sessions/${username}/${sessionId}/${username}-${sessionId}.webm`;
  await sh("gcloud", ["storage", "cp", outputPath, destination]);

  const manifestPath = `${outputPath}.manifest.json`;
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        username,
        session_id: sessionId,
        output: destination,
        generated_at: new Date().toISOString(),
        chunk_count: files.length,
        chunks: files,
        duration_seconds: durationSeconds,
        merge_method: "ordered_binary_concat_then_ffmpeg_remux",
      },
      null,
      2,
    )}\n`,
  );
  await sh("gcloud", ["storage", "cp", manifestPath, `${destination}.manifest.json`]);
  return destination;
}

async function mergeUsername(args, username) {
  const objects = await listObjects(args.sourceBucket, `sessions/${username}/**/screen/chunk-*.webm`);
  const chunks = objects.map(parseSessionAndChunk).filter(Boolean);
  const sessions = new Map();

  for (const chunk of chunks) {
    if (!sessions.has(chunk.sessionId)) sessions.set(chunk.sessionId, []);
    sessions.get(chunk.sessionId).push(chunk);
  }

  if (sessions.size === 0) {
    console.log(`${username}: no screen chunks found`);
    return [];
  }

  const uploaded = [];
  for (const [sessionId, sessionChunks] of sessions.entries()) {
    sessionChunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
    const sessionDir = path.join(args.tmpRoot, username, sessionId);
    const screenDir = await downloadChunks(sessionChunks, sessionDir);
    const rawOutputPath = path.join(sessionDir, `${username}-${sessionId}.raw-concat.webm`);
    const outputPath = path.join(sessionDir, `${username}-${sessionId}.webm`);
    const files = await concatenateWebmFiles(screenDir, rawOutputPath);
    await remuxWebm(rawOutputPath, outputPath);
    const durationSeconds = await probeDuration(outputPath);
    const destination = await uploadMergedVideo(args.destBucket, username, sessionId, outputPath, files, durationSeconds);
    uploaded.push(destination);
    const durationNote = durationSeconds ? `, ${durationSeconds.toFixed(1)}s` : "";
    console.log(`${username}/${sessionId}: merged ${files.length} chunks${durationNote} -> ${destination}`);

    if (!args.keepTmp) {
      await rm(sessionDir, { recursive: true, force: true });
    }
  }

  return uploaded;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  args.usernames = [...new Set(args.usernames)].filter(Boolean);

  if (args.usernames.length === 0) {
    throw new Error("Usage: node scripts/merge-gcs-videos.mjs USERNAME [USERNAME...] [--usernames-file shortlist.txt]");
  }
  if (!args.sourceBucket || !args.destBucket) {
    throw new Error("Set SOURCE_BUCKET and DEST_BUCKET, or pass --source-bucket and --dest-bucket.");
  }

  await mkdir(args.tmpRoot, { recursive: true });
  const allUploaded = [];
  for (const username of args.usernames) {
    allUploaded.push(...(await mergeUsername(args, username)));
  }

  console.log(`Done. Uploaded ${allUploaded.length} merged video(s).`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
