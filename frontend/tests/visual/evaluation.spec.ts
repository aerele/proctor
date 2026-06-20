// frontend/tests/visual/evaluation.spec.ts
// The Evaluation tab is a cross-origin iframe to the proctor-eval /eval-ui service
// (EvaluationPanel.tsx). VITE_DEMO_MODE cannot reach it — it is the one view the
// SPA demo layer does not cover (report 07 §2a). We use Playwright route
// interception (Option B): the iframe's same-origin GET /api/admin/contest-evaluations
// is fulfilled from the committed PII-free fixture, and the eval-ui app shell +
// its two static assets are fulfilled from the LIVE proctor-eval source (read at
// test time, NOT copied/committed → no backend edit, no drift). The eval-origin
// password key is pre-seeded so the iframe skips its own gate.
//
// We do NOT use Option A (a fixture branch in the deployed eval-server) — that
// touches backend/, which is off-limits here.
//
// If the live eval source can't be resolved (e.g. backend/ moved during a
// refactor), the test SKIPS with a clear reason rather than failing the suite —
// the iframe is a documented known-gap dependency, not a frontend regression.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// frontend/tests/visual → repo root → backend/src
const BACKEND_SRC = path.resolve(__dirname, "../../../backend/src");
const FIXTURE = path.resolve(__dirname, "../fixtures/eval-fixture.json");

// Pull the eval-ui assets from the live proctor-eval source. Returns null if any
// piece is missing (→ skip, documented gap), never throws.
function loadEvalAssets():
  | { html: string; appJs: string; recJs: string; fixture: string }
  | null {
  try {
    const pageSrc = readFileSync(path.join(BACKEND_SRC, "evalUiPage.mjs"), "utf8");
    const m = pageSrc.match(/export const EVAL_UI_HTML = `([\s\S]*?)`;/);
    if (!m) return null;
    const html = m[1];
    const appJs = readFileSync(path.join(BACKEND_SRC, "evalUiClient.js"), "utf8");
    const recJs = readFileSync(path.join(BACKEND_SRC, "evaluationRecommend.mjs"), "utf8");
    const fixture = readFileSync(FIXTURE, "utf8");
    return { html, appJs, recJs, fixture };
  } catch {
    return null;
  }
}

test("evaluation tab — iframe rendered from synthetic fixture", async ({ page, context }) => {
  const assets = loadEvalAssets();
  test.skip(
    !assets,
    "proctor-eval /eval-ui source not resolvable from backend/src — eval iframe is a documented known gap (report 07 §2a)."
  );
  if (!assets) return;

  // Pre-seed the eval-origin admin password so the iframe skips its gate.
  await context.addInitScript(() => {
    try {
      localStorage.setItem("proctorEvalAdminPw", "dev");
    } catch {
      /* ignore */
    }
  });

  // Serve the eval-ui shell + assets (same-origin in demo mode: evalApiBaseUrl="").
  await page.route("**/eval-ui**", async (route, req) => {
    const u = new URL(req.url());
    if (u.pathname === "/eval-ui/app.js")
      return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: assets.appJs });
    if (u.pathname === "/eval-ui/recommend.js")
      return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: assets.recJs });
    if (u.pathname === "/eval-ui")
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: assets.html });
    return route.continue();
  });
  // Fulfill the iframe's data fetch with the committed synthetic scorecard fixture.
  await page.route("**/api/admin/contest-evaluations**", (route) =>
    route.fulfill({ contentType: "application/json", body: assets.fixture })
  );

  // Unlock admin + open the Evaluation view.
  await page.goto("/admin");
  await page.locator('input[type="password"]').first().fill("dev");
  await page.getByRole("button", { name: "Unlock admin" }).click();
  await expect(page.getByRole("button", { name: "Live", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Contest", exact: true }).click();
  await page.getByRole("button", { name: "Evaluation", exact: true }).first().click();

  // Wait for the eval app to render inside the iframe (its <h1>Evaluation — …).
  const frame = page.frameLocator('iframe[title*="proctor-eval"]');
  await expect(frame.locator("h1")).toContainText("Evaluation —", { timeout: 15_000 });
  await expect(frame.locator(".chips button").first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);

  await expect(page).toHaveScreenshot("admin-evaluation-iframe.png", { fullPage: true });
});
