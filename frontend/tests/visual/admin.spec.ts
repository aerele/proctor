// frontend/tests/visual/admin.spec.ts
// Admin SPA visual regression + doc screenshots, driven from the demo build.
//
// The per-view sweep iterates ADMIN_NAV_GROUPS straight from the app source, so a
// NEW admin view is auto-caught by this suite (it just won't have a baseline yet
// → the gate flags it). Targeted detail shots (session card, results row-select,
// people scorecard, IP drilldown) follow, mirroring docs/assets/e2e/admin-* names.
import { test, expect } from "@playwright/test";
import { ADMIN_NAV_GROUPS } from "../../src/admin/adminNav";
import { gotoAdminView, setAdminScopeAll, settle, unlockAdmin } from "./_helpers";

// Live-group views read the demo SESSION population, which only shows under the
// "All contests" scope (see _helpers DEMO_CONTEST_SLUG note).
const LIVE_VIEWS = new Set(["stats", "alerts", "sessions", "ips"]);

// Stable 2-digit ordering across the flattened nav, so filenames sort sanely.
const FLAT = ADMIN_NAV_GROUPS.flatMap((g) => g.views.map((v) => ({ group: g.label, ...v })));

test.describe("admin — per-view sweep (iterates ADMIN_NAV_GROUPS)", () => {
  for (let i = 0; i < FLAT.length; i++) {
    const { group, view, label } = FLAT[i];
    const nn = String(i + 1).padStart(2, "0");
    test(`${nn} ${view}`, async ({ page }) => {
      await unlockAdmin(page);
      if (LIVE_VIEWS.has(view)) await setAdminScopeAll(page);
      await gotoAdminView(page, group, label);
      await expect(page).toHaveScreenshot(`admin-${nn}-${view}.png`, { fullPage: true });
    });
  }
});

test.describe("admin — targeted detail views", () => {
  test("session-detail card", async ({ page }) => {
    await unlockAdmin(page);
    await setAdminScopeAll(page);
    await gotoAdminView(page, "Live", "Sessions");
    // Drill into a status to populate the table, then open the first row's card.
    const rows = page.locator("table tbody tr");
    await expect(rows.first()).toBeVisible();
    await rows.first().click();
    await expect(page.locator('[role="dialog"]')).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot("admin-session-detail-card.png");
  });

  test("results — row selected", async ({ page }) => {
    await unlockAdmin(page);
    await gotoAdminView(page, "Contest", "Results");
    const checks = page.locator('table tbody input[type="checkbox"]');
    await expect(checks.first()).toBeVisible();
    await checks.first().check();
    await settle(page);
    await expect(page).toHaveScreenshot("admin-results-row-selected.png", { fullPage: true });
  });

  test("people — scorecard", async ({ page }) => {
    await unlockAdmin(page);
    await gotoAdminView(page, "People", "People");
    const scorecardBtn = page.getByRole("button", { name: "Scorecard" }).first();
    await expect(scorecardBtn).toBeVisible();
    await scorecardBtn.click();
    await expect(page.getByText("Back to directory")).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot("admin-people-scorecard.png", { fullPage: true });
  });

  test("ips — drilldown", async ({ page }) => {
    await unlockAdmin(page);
    await setAdminScopeAll(page);
    await gotoAdminView(page, "Live", "IP report");
    const rows = page.locator("table tbody tr");
    await expect(rows.first()).toBeVisible();
    await rows.first().click();
    await settle(page);
    await expect(page).toHaveScreenshot("admin-ip-drilldown.png", { fullPage: true });
  });

  test("alerts — grouped by candidate", async ({ page }) => {
    await unlockAdmin(page);
    await setAdminScopeAll(page);
    await gotoAdminView(page, "Live", "Live alerts");
    await settle(page);
    await expect(page).toHaveScreenshot("admin-alerts-console.png", { fullPage: true });
  });

  test("health — populated pre-flight verdict", async ({ page }) => {
    await unlockAdmin(page);
    await gotoAdminView(page, "System Health", "Pre-flight");
    await page.getByRole("button", { name: "Run pre-flight check" }).click();
    // Wait for the synthetic green verdict to render (demoHealthCheck in api.ts).
    await expect(page.getByText("All systems go")).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot("admin-health-verdict.png", { fullPage: true });
  });
});
