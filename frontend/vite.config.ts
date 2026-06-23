/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { bakePasswordHashes, passwordHashGuard } from "./vite-plugin-password-hash";

// Deterministically bake sha256(ADMIN_PASSWORD)/sha256(INVIGILATOR_PASSWORD) into
// the build BEFORE Vite reads env (top-level runs first), resolving the passwords
// from process.env or the repo-root .env.deploy.local. The guard plugin then
// fails a production build if either hash is missing or absent from the bundle —
// so a plain `vite build` can no longer ship an empty hash and break login.
const ENV_DEPLOY_LOCAL = fileURLToPath(new URL("../.env.deploy.local", import.meta.url));
const passwordHashes = bakePasswordHashes(ENV_DEPLOY_LOCAL);

export default defineConfig({
  plugins: [react(), passwordHashGuard(passwordHashes)],
  server: {
    port: 5173
  },
  test: {
    // Vitest's default `include` (**/*.spec.ts) would otherwise pick up the
    // Playwright visual specs under tests/visual/ and crash ("did not expect
    // test.describe()") — those run under `playwright test`, not vitest. Keep the
    // unit-test suite scoped to src/.
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["node_modules", "dist", "tests/visual/**"]
  }
});
