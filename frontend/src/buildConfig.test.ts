import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sha256Hex,
  readEnvFileValue,
  resolveValue,
  bakeBuildConfig,
  evalUrlHttpsError
} from "../vite-plugin-build-config";

const ENV_KEYS = [
  "ADMIN_PASSWORD",
  "INVIGILATOR_PASSWORD",
  "VITE_ADMIN_PASSWORD_HASH",
  "VITE_INVIGILATOR_PASSWORD_HASH",
  "VITE_API_BASE_URL",
  "API_URL",
  "VITE_EVAL_API_URL"
];

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

describe("build-config baking (vite-plugin-build-config)", () => {
  let dir: string;
  let envFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "buildcfg-"));
    envFile = join(dir, ".env.deploy.local");
    clearEnv();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    clearEnv();
  });

  it("sha256Hex matches the known NIST vector for 'abc'", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("readEnvFileValue parses KEY=value, ignores other lines and strips quotes", () => {
    writeFileSync(
      envFile,
      ["# comment", "OTHER=nope", 'ADMIN_PASSWORD="s3cret-pw"', "API_URL=https://api.example/"].join("\n")
    );
    expect(readEnvFileValue(envFile, "ADMIN_PASSWORD")).toBe("s3cret-pw");
    expect(readEnvFileValue(envFile, "API_URL")).toBe("https://api.example/");
    expect(readEnvFileValue(envFile, "MISSING")).toBeUndefined();
  });

  it("resolveValue prefers process.env over the file and tries keys in order", () => {
    writeFileSync(envFile, "API_URL=from-file");
    process.env.VITE_API_BASE_URL = "from-vite-env";
    expect(resolveValue(["VITE_API_BASE_URL", "API_URL"], "API_URL", envFile)).toBe("from-vite-env");
    delete process.env.VITE_API_BASE_URL;
    process.env.API_URL = "from-api-env";
    expect(resolveValue(["VITE_API_BASE_URL", "API_URL"], "API_URL", envFile)).toBe("from-api-env");
    delete process.env.API_URL;
    expect(resolveValue(["VITE_API_BASE_URL", "API_URL"], "API_URL", envFile)).toBe("from-file");
  });

  it("bakeBuildConfig hashes passwords AND bakes the API + eval URLs (trailing slash stripped)", () => {
    writeFileSync(
      envFile,
      [
        "ADMIN_PASSWORD=admin-pw",
        "INVIGILATOR_PASSWORD=invig-pw",
        "API_URL=https://proctor-api.example.run.app/",
        "EVAL_API_URL=https://proctor-eval.example.run.app/"
      ].join("\n")
    );
    const cfg = bakeBuildConfig(envFile);
    expect(cfg.adminHash).toBe(sha256Hex("admin-pw"));
    expect(cfg.invigHash).toBe(sha256Hex("invig-pw"));
    expect(cfg.apiBaseUrl).toBe("https://proctor-api.example.run.app");
    expect(cfg.evalApiUrl).toBe("https://proctor-eval.example.run.app");
    expect(process.env.VITE_ADMIN_PASSWORD_HASH).toBe(cfg.adminHash);
    expect(process.env.VITE_INVIGILATOR_PASSWORD_HASH).toBe(cfg.invigHash);
    expect(process.env.VITE_API_BASE_URL).toBe("https://proctor-api.example.run.app");
    expect(process.env.VITE_EVAL_API_URL).toBe("https://proctor-eval.example.run.app");
  });

  it("bakeBuildConfig returns empty values (no env set) when everything is absent", () => {
    const cfg = bakeBuildConfig(join(dir, "absent.env"));
    expect(cfg.adminHash).toBe("");
    expect(cfg.invigHash).toBe("");
    expect(cfg.apiBaseUrl).toBe("");
    expect(cfg.evalApiUrl).toBe("");
    expect(process.env.VITE_ADMIN_PASSWORD_HASH).toBeUndefined();
    expect(process.env.VITE_API_BASE_URL).toBeUndefined();
    expect(process.env.VITE_EVAL_API_URL).toBeUndefined();
  });

  it("evalUrlHttpsError rejects a plaintext eval URL, passes https, ignores empty", () => {
    expect(evalUrlHttpsError("https://proctor-eval.example.run.app")).toBeNull();
    expect(evalUrlHttpsError("")).toBeNull(); // empty is the required-value guard's job
    expect(evalUrlHttpsError("http://proctor-eval.example.run.app")).toContain("must be https://");
    expect(evalUrlHttpsError("ftp://x")).toContain("must be https://");
    expect(evalUrlHttpsError("HTTPS://upper.example")).toBeNull(); // scheme is case-insensitive
  });

  it("explicit VITE_* overrides are not clobbered", () => {
    writeFileSync(envFile, ["ADMIN_PASSWORD=admin-pw", "API_URL=https://from-file"].join("\n"));
    process.env.VITE_ADMIN_PASSWORD_HASH = "preset-hash";
    process.env.VITE_API_BASE_URL = "https://preset-url";
    bakeBuildConfig(envFile);
    expect(process.env.VITE_ADMIN_PASSWORD_HASH).toBe("preset-hash");
    expect(process.env.VITE_API_BASE_URL).toBe("https://preset-url");
  });
});
