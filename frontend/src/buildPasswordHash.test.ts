import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sha256Hex,
  readEnvFileValue,
  resolvePassword,
  bakePasswordHashes
} from "../vite-plugin-password-hash";

describe("build password-hash baking (vite-plugin-password-hash)", () => {
  let dir: string;
  let envFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pwhash-"));
    envFile = join(dir, ".env.deploy.local");
    delete process.env.ADMIN_PASSWORD;
    delete process.env.INVIGILATOR_PASSWORD;
    delete process.env.VITE_ADMIN_PASSWORD_HASH;
    delete process.env.VITE_INVIGILATOR_PASSWORD_HASH;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.ADMIN_PASSWORD;
    delete process.env.INVIGILATOR_PASSWORD;
    delete process.env.VITE_ADMIN_PASSWORD_HASH;
    delete process.env.VITE_INVIGILATOR_PASSWORD_HASH;
  });

  it("sha256Hex matches the known NIST vector for 'abc'", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("readEnvFileValue parses KEY=value, ignores other lines and strips quotes", () => {
    writeFileSync(
      envFile,
      ["# comment", "OTHER=nope", 'ADMIN_PASSWORD="s3cret-pw"', "INVIGILATOR_PASSWORD=plain"].join("\n")
    );
    expect(readEnvFileValue(envFile, "ADMIN_PASSWORD")).toBe("s3cret-pw");
    expect(readEnvFileValue(envFile, "INVIGILATOR_PASSWORD")).toBe("plain");
    expect(readEnvFileValue(envFile, "MISSING")).toBeUndefined();
  });

  it("readEnvFileValue returns undefined for an unreadable file", () => {
    expect(readEnvFileValue(join(dir, "nope.env"), "ADMIN_PASSWORD")).toBeUndefined();
  });

  it("resolvePassword prefers process.env over the file", () => {
    writeFileSync(envFile, "ADMIN_PASSWORD=from-file");
    process.env.ADMIN_PASSWORD = "from-env";
    expect(resolvePassword("ADMIN_PASSWORD", envFile)).toBe("from-env");
    delete process.env.ADMIN_PASSWORD;
    expect(resolvePassword("ADMIN_PASSWORD", envFile)).toBe("from-file");
  });

  it("bakePasswordHashes hashes the file passwords and exposes them as VITE_* env vars", () => {
    writeFileSync(envFile, ["ADMIN_PASSWORD=admin-pw", "INVIGILATOR_PASSWORD=invig-pw"].join("\n"));
    const { adminHash, invigHash } = bakePasswordHashes(envFile);
    expect(adminHash).toBe(sha256Hex("admin-pw"));
    expect(invigHash).toBe(sha256Hex("invig-pw"));
    expect(process.env.VITE_ADMIN_PASSWORD_HASH).toBe(adminHash);
    expect(process.env.VITE_INVIGILATOR_PASSWORD_HASH).toBe(invigHash);
  });

  it("bakePasswordHashes returns empty hashes (no env set) when passwords are absent", () => {
    const { adminHash, invigHash } = bakePasswordHashes(join(dir, "absent.env"));
    expect(adminHash).toBe("");
    expect(invigHash).toBe("");
    expect(process.env.VITE_ADMIN_PASSWORD_HASH).toBeUndefined();
    expect(process.env.VITE_INVIGILATOR_PASSWORD_HASH).toBeUndefined();
  });

  it("an explicit VITE_*_HASH override is not clobbered", () => {
    writeFileSync(envFile, "ADMIN_PASSWORD=admin-pw");
    process.env.VITE_ADMIN_PASSWORD_HASH = "preset";
    bakePasswordHashes(envFile);
    expect(process.env.VITE_ADMIN_PASSWORD_HASH).toBe("preset");
  });
});
