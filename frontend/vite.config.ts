/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
