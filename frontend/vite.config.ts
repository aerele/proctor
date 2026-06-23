/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { bakeBuildConfig, buildConfigGuard } from "./vite-plugin-build-config";

// Deterministically bake all required build-time config (sha256 of the admin /
// invigilator passwords AND the backend API base URL) BEFORE Vite reads env
// (top-level runs first), resolving from process.env or the repo-root
// .env.deploy.local. The guard plugin then fails a production build if any
// required value is missing or absent from the bundle — so a plain `vite build`
// can no longer ship an empty hash (breaks login) or empty API URL (breaks every
// backend call after login).
const ENV_DEPLOY_LOCAL = fileURLToPath(new URL("../.env.deploy.local", import.meta.url));
const buildConfig = bakeBuildConfig(ENV_DEPLOY_LOCAL);

export default defineConfig({
  plugins: [react(), buildConfigGuard(buildConfig)],
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
