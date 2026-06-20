import { defineConfig, devices } from "@playwright/test";

// Visual-regression + doc-screenshot harness for the proctor SPA. Drives the
// EXISTING VITE_DEMO_MODE synthetic-data layer (frontend/src/api.ts) — no MSW,
// no emulator — so a doc screenshot is byte-identical to what regression guards.
//
// Determinism (see report 07 §5): the demo clock is frozen via
// VITE_DEMO_FREEZE_NOW so wall-clock-relative "age" labels and demo session ids
// don't drift between runs. The browser is pinned (viewport, scale, locale,
// timezone, reduced motion) and launched with fake-media so the candidate
// capture gates pass headlessly.
//
// The server is the PRODUCTION demo bundle served by `vite preview` (not the dev
// HMR server) so the screenshots are the true shipped bundle.

const PORT = 5179; // off the default 5173/4173 to avoid colliding with a dev loop
const FROZEN_NOW = "2026-06-05T09:30:00.000Z";

// Single shared env for BOTH the build and the preview so the served bundle is
// the deterministic demo build.
const demoEnv = {
  VITE_DEMO_MODE: "true",
  VITE_ADMIN_PASSWORD: "dev",
  VITE_DEMO_FREEZE_NOW: FROZEN_NOW
};

export default defineConfig({
  testDir: "./tests/visual",
  // Screenshots are inherently order-independent; run them in parallel workers.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // One browser pin → one project. Baselines are platform-specific (font/AA), so
  // generate + check on the same OS (this Linux box / the CI container).
  reporter: process.env.CI ? "github" : "list",

  // Baselines live under tests/visual/__screenshots__/<spec>/<name>.png — flat,
  // platform-suffixed by Playwright so cross-OS baselines never collide.
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFilePath}/{arg}{ext}",

  expect: {
    toHaveScreenshot: {
      // Small tolerance for sub-pixel AA noise; a real layout/content change
      // moves far more than this and still fails the gate.
      maxDiffPixelRatio: 0.01,
      animations: "disabled"
    }
  },

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "Asia/Kolkata",
    // Pre-grant the permissions the candidate flow gates on so the fake-media
    // capture path is never blocked by a prompt.
    permissions: ["camera", "microphone"],
    launchOptions: {
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        // Pin a font-rendering path so AA is stable across machines.
        "--font-render-hinting=none",
        "--disable-lcd-text"
      ]
    }
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], channel: undefined }
    }
  ],

  // Build the deterministic demo bundle, then serve it with `vite preview`.
  // reuseExistingServer keeps a local re-run fast.
  webServer: {
    command:
      "npm run build && npx vite preview --port " + PORT + " --strictPort --host 127.0.0.1",
    url: `http://127.0.0.1:${PORT}/`,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    env: demoEnv
  }
});
