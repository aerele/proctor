// =============================================================================
// Deterministic build-time config baking — wired INTO the build.
//
// WHY THIS EXISTS (burned more than once): the production bundle needs several
// values baked at BUILD time, and a plain `vite build` / `npm run build` bakes
// NONE of them unless the caller remembers to pass them. When they are missing
// the app breaks in ways that only show up in prod:
//   * VITE_ADMIN_PASSWORD_HASH / VITE_INVIGILATOR_PASSWORD_HASH empty  →
//     every admin/invigilator login fails (the unlock gate hashes the typed
//     password and compares to "").
//   * VITE_API_BASE_URL empty  →  the app throws "VITE_API_BASE_URL is not
//     configured." after login (it has no backend to call).
//   * VITE_EVAL_API_URL empty  →  the admin Evaluation tab + "Run evaluation"
//     fall back to the candidate origin (apiBaseUrl): the eval iframe loads the
//     CANDIDATE screen instead of the proctor-eval /eval-ui, and the run-eval
//     call hits the wrong service (or throws "not configured" when apiBaseUrl is
//     also empty). The eval service is a SEPARATE Cloud Run deploy, so its URL
//     must be baked too.
//
// THE FIX: resolve + bake ALL of this here, inside `vite build` itself, so it
// can NEVER be skipped. Any production build:
//   1. resolves the values from process.env, then the repo-root .env.deploy.local,
//   2. exposes them as the VITE_* env vars Vite inlines into the bundle,
//   3. ABORTS the build if a REQUIRED value can't be resolved, and
//   4. ABORTS if a required value is somehow absent from the emitted bundle.
// Plain passwords are read only to hash them; they never reach the output.
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

/** Resolve a value from process.env (first key that is set & non-empty), then the file. */
export function resolveValue(envKeys: string[], fileKey: string, envFile: string): string | undefined {
  for (const k of envKeys) {
    const v = process.env[k];
    if (v != null && v !== "") return v;
  }
  return readEnvFileValue(envFile, fileKey);
}

function setIfUnset(key: string, value: string): void {
  if (value && !process.env[key]) process.env[key] = value;
}

export interface BuildConfig {
  adminHash: string;
  invigHash: string;
  apiBaseUrl: string;
  evalApiUrl: string;
}

/**
 * Resolve every build-time value and expose it to Vite as the VITE_* env vars it
 * inlines (the same mechanism the deploy script used, but in-code so a plain
 * build can't skip it). Only sets a var if not already set, so an explicit
 * override still wins. Returns the resolved values ("" when unresolved) for the
 * guard plugin. The raw passwords are hashed, never exposed.
 */
export function bakeBuildConfig(envFile: string): BuildConfig {
  const adminPw = resolveValue(["ADMIN_PASSWORD"], "ADMIN_PASSWORD", envFile);
  const invigPw = resolveValue(["INVIGILATOR_PASSWORD"], "INVIGILATOR_PASSWORD", envFile);
  const adminHash = adminPw ? sha256Hex(adminPw) : "";
  const invigHash = invigPw ? sha256Hex(invigPw) : "";
  setIfUnset("VITE_ADMIN_PASSWORD_HASH", adminHash);
  setIfUnset("VITE_INVIGILATOR_PASSWORD_HASH", invigHash);

  // Backend base URL: VITE_API_BASE_URL or API_URL from the environment, else
  // API_URL from .env.deploy.local. Strip any trailing slash (the app does too).
  const apiBaseUrl = (
    resolveValue(["VITE_API_BASE_URL", "API_URL"], "API_URL", envFile) ?? ""
  ).replace(/\/+$/, "");
  setIfUnset("VITE_API_BASE_URL", apiBaseUrl);

  // REQUIRED: the separate proctor-eval Cloud Run service URL. It backs the
  // admin Evaluation tab (embedded /eval-ui iframe) and the "Run evaluation"
  // call. If it is empty the frontend falls back to apiBaseUrl (the candidate
  // origin), so the eval iframe loads the CANDIDATE screen and the run-eval call
  // hits the wrong service — the guard below ABORTS a prod build when it is
  // missing. VITE_EVAL_API_URL or EVAL_API_URL from the environment, else
  // EVAL_API_URL from .env.deploy.local. Strip any trailing slash.
  const evalApiUrl = (
    resolveValue(["VITE_EVAL_API_URL", "EVAL_API_URL"], "EVAL_API_URL", envFile) ?? ""
  ).replace(/\/+$/, "");
  setIfUnset("VITE_EVAL_API_URL", evalApiUrl);

  return { adminHash, invigHash, apiBaseUrl, evalApiUrl };
}

/**
 * The eval service is a separate Cloud Run deploy and MUST be served over https —
 * a plaintext baked URL would downgrade the Evaluation-tab iframe + "Run
 * evaluation" calls (and is the shape of a deploy-misconfig / origin-confusion).
 * Returns an error message when a NON-empty eval URL isn't https, else null.
 * (Defense-in-depth from the v1.1-r2 security review; the empty case is already
 * caught by the required-value guard.)
 */
export function evalUrlHttpsError(evalApiUrl: string): string | null {
  if (evalApiUrl && !/^https:\/\//i.test(evalApiUrl)) {
    return (
      `[build-config] production build ABORTED: VITE_EVAL_API_URL must be https:// ` +
      `(got "${evalApiUrl}"). The eval service is a Cloud Run deploy; a plaintext URL ` +
      `downgrades the Evaluation tab iframe + "Run evaluation" calls. Use the https URL.`
    );
  }
  return null;
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
 * Vite plugin: on a PRODUCTION build, fail fast if any REQUIRED build value is
 * missing, and after writing the bundle, assert the required values are actually
 * present in the emitted JS. On dev/serve it is a no-op (the :5173 dev fallback
 * to a plain password / same-origin API still works).
 */
export function buildConfigGuard(cfg: BuildConfig): Plugin {
  let isProd = false;
  let outDir = "dist";
  let root = process.cwd();
  return {
    name: "proctor-build-config-guard",
    configResolved(config) {
      isProd = config.command === "build" && config.mode !== "development";
      outDir = config.build.outDir;
      root = config.root;
    },
    buildStart() {
      if (!isProd) return;
      const missing: string[] = [];
      if (!cfg.adminHash) missing.push("ADMIN_PASSWORD (→ VITE_ADMIN_PASSWORD_HASH)");
      if (!cfg.invigHash) missing.push("INVIGILATOR_PASSWORD (→ VITE_INVIGILATOR_PASSWORD_HASH)");
      if (!cfg.apiBaseUrl) missing.push("API_URL (→ VITE_API_BASE_URL)");
      if (!cfg.evalApiUrl) missing.push("EVAL_API_URL (→ VITE_EVAL_API_URL)");
      if (missing.length) {
        this.error(
          `[build-config] production build ABORTED: could not resolve ${missing.join(
            ", "
          )} from process.env or .env.deploy.local. Shipping these empty breaks prod ` +
            `(empty password hash → every admin/invigilator login fails; empty API base ` +
            `URL → "VITE_API_BASE_URL is not configured" after login; empty eval base URL → ` +
            `the Evaluation tab loads the candidate screen and "Run evaluation" hits the wrong ` +
            `service). Set the value(s) and rebuild.`
        );
      }
      const httpsErr = evalUrlHttpsError(cfg.evalApiUrl);
      if (httpsErr) this.error(httpsErr);
    },
    closeBundle() {
      if (!isProd) return;
      const dir = resolve(root, outDir);
      const blob = listJsFiles(dir)
        .map((f) => readFileSync(f, "utf8"))
        .join("\n");
      const missing: string[] = [];
      if (!blob.includes(cfg.adminHash)) missing.push("VITE_ADMIN_PASSWORD_HASH");
      if (!blob.includes(cfg.invigHash)) missing.push("VITE_INVIGILATOR_PASSWORD_HASH");
      if (cfg.apiBaseUrl && !blob.includes(cfg.apiBaseUrl)) missing.push("VITE_API_BASE_URL");
      if (cfg.evalApiUrl && !blob.includes(cfg.evalApiUrl)) missing.push("VITE_EVAL_API_URL");
      if (missing.length) {
        this.error(
          `[build-config] built bundle in ${dir} is MISSING ${missing.join(
            " + "
          )}. Deploying it would break prod (login and/or backend calls). Build aborted.`
        );
      }
    }
  };
}
