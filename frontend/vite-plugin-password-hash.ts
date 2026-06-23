// =============================================================================
// Deterministic admin/invigilator password-hash baking — wired INTO the build.
//
// WHY THIS EXISTS (twice-burned): the login gate hashes the typed password and
// compares it to a build-time-baked VITE_ADMIN_PASSWORD_HASH /
// VITE_INVIGILATOR_PASSWORD_HASH. If a production bundle ships with those hashes
// EMPTY, every admin/invigilator login fails (the gate compares against "").
// That happened twice — both times because someone ran a plain `vite build`
// (or `npm run build`) that bypassed the deploy script's manual hash bake.
//
// THE FIX: do the bake here, inside `vite build` itself, so it can NEVER be
// skipped. Any production build:
//   1. resolves ADMIN_PASSWORD + INVIGILATOR_PASSWORD (process.env, then the
//      repo-root .env.deploy.local) and exposes their sha256 as VITE_* env vars,
//   2. ABORTS the build if either can't be resolved, and
//   3. ABORTS if either hash is somehow absent from the emitted bundle.
// The plain passwords are read only to hash them; they never reach the output.
// =============================================================================

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Read a single KEY=value from a dotenv-style file; undefined if absent/unreadable. */
export function readEnvFileValue(file: string, key: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && m[1] === key) {
      let v = m[2];
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      return v;
    }
  }
  return undefined;
}

/** Resolve a password from process.env first, then the deploy env file. */
export function resolvePassword(key: string, envFile: string): string | undefined {
  const fromEnv = process.env[key];
  if (fromEnv != null && fromEnv !== "") return fromEnv;
  return readEnvFileValue(envFile, key);
}

export interface BakedHashes {
  adminHash: string;
  invigHash: string;
}

/**
 * Resolve the passwords, compute their sha256, and expose the hashes to the
 * build as VITE_* env vars (the same mechanism the deploy script used, but done
 * in-code so a plain build can't skip it). Only sets a var if not already set,
 * so an explicit VITE_*_HASH override still wins. Returns the resolved hashes
 * ("" when the password could not be resolved) for the guard plugin.
 */
export function bakePasswordHashes(envFile: string): BakedHashes {
  const adminPw = resolvePassword("ADMIN_PASSWORD", envFile);
  const invigPw = resolvePassword("INVIGILATOR_PASSWORD", envFile);
  const adminHash = adminPw ? sha256Hex(adminPw) : "";
  const invigHash = invigPw ? sha256Hex(invigPw) : "";
  if (adminHash && !process.env.VITE_ADMIN_PASSWORD_HASH) {
    process.env.VITE_ADMIN_PASSWORD_HASH = adminHash;
  }
  if (invigHash && !process.env.VITE_INVIGILATOR_PASSWORD_HASH) {
    process.env.VITE_INVIGILATOR_PASSWORD_HASH = invigHash;
  }
  return { adminHash, invigHash };
}

function listJsFiles(dir: string): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const full = resolve(dir, name);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      /* unreadable entry — skip */
    }
    if (isDir) out.push(...listJsFiles(full));
    else if (name.endsWith(".js")) out.push(full);
  }
  return out;
}

/**
 * Vite plugin: on a PRODUCTION build, fail fast if a password hash is missing,
 * and after writing the bundle, assert both hashes are actually present in the
 * emitted JS. On dev/serve it is a no-op (the :5173 dev fallback to a plain
 * password still works).
 */
export function passwordHashGuard(hashes: BakedHashes): Plugin {
  let isProd = false;
  let outDir = "dist";
  let root = process.cwd();
  return {
    name: "proctor-password-hash-guard",
    configResolved(config) {
      isProd = config.command === "build" && config.mode !== "development";
      outDir = config.build.outDir;
      root = config.root;
    },
    buildStart() {
      if (!isProd) return;
      const missing: string[] = [];
      if (!hashes.adminHash) missing.push("ADMIN_PASSWORD");
      if (!hashes.invigHash) missing.push("INVIGILATOR_PASSWORD");
      if (missing.length) {
        this.error(
          `[password-hash] production build ABORTED: could not resolve ${missing.join(
            " + "
          )} from process.env or .env.deploy.local. The login gate hashes the typed ` +
            `password and compares to the baked VITE_*_PASSWORD_HASH — shipping an empty ` +
            `hash breaks EVERY admin/invigilator login. Set the password(s) and rebuild.`
        );
      }
    },
    closeBundle() {
      if (!isProd) return;
      const dir = resolve(root, outDir);
      const blob = listJsFiles(dir)
        .map((f) => readFileSync(f, "utf8"))
        .join("\n");
      const missing: string[] = [];
      if (!blob.includes(hashes.adminHash)) missing.push("VITE_ADMIN_PASSWORD_HASH");
      if (!blob.includes(hashes.invigHash)) missing.push("VITE_INVIGILATOR_PASSWORD_HASH");
      if (missing.length) {
        this.error(
          `[password-hash] built bundle in ${dir} is MISSING ${missing.join(
            " + "
          )}. Deploying it would break every admin/invigilator login. Build aborted.`
        );
      }
    }
  };
}
