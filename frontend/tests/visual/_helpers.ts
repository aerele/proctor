// frontend/tests/visual/_helpers.ts
// Shared drive helpers for the visual specs. Everything here assumes the demo
// build (VITE_DEMO_MODE=true, VITE_ADMIN_PASSWORD=dev, frozen clock) served by
// playwright.config.ts's webServer.
import { expect, type Page } from "@playwright/test";

export const ADMIN_PASSWORD = "dev";
// The candidate-reachable OPEN demo contest (seedDemoContests). NOTE: the demo
// admin session population (DEMO_ALL_SESSIONS) lives under a *different* slug, so
// the admin Live views must use the "All contests" scope to show that population
// (setAdminScopeAll below) — a known demo-data quirk, not a harness bug.
export const DEMO_CONTEST_SLUG = "demo-drive-r1";
export const DEMO_ACCESS_CODE = "DEMO42";

// A consistent screenshot-stability gate: wait for fonts to load, then let any
// demo `await wait(...)` + layout settle. Demo data is in-process (no network).
export async function settle(page: Page, ms = 350): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(ms);
}

// Unlock the admin app. The lock screen shows "Admin locked" + a password field
// + an "Unlock admin" button (App.tsx). After unlock the nav header renders.
export async function unlockAdmin(page: Page): Promise<void> {
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Admin locked" })).toBeVisible();
  await page.locator('input[type="password"]').first().fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Unlock admin" }).click();
  // The unlock screen is gone once the nav (Live group) is present.
  await expect(page.getByRole("button", { name: "Live", exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

// Set the admin global contest scope to "All contests" so the demo session
// population (Live stats / Sessions / IPs) renders populated. The scope is the
// first <select> in the header.
//
// RACE: just after unlock the app auto-defaults the scope to the single OPEN
// demo contest (demo-drive-r1) via an effect. If we set "" before that effect
// fires, it gets overridden. So: wait for the auto-default to land, THEN force
// "All contests" and assert it stuck.
export async function setAdminScopeAll(page: Page): Promise<void> {
  const scope = page.locator("select").first();
  await expect(scope).toHaveValue("demo-drive-r1", { timeout: 5_000 });
  await scope.selectOption("");
  await expect(scope).toHaveValue("");
  await settle(page, 450);
}

// Navigate to an admin view by its group label + view label (both from
// ADMIN_NAV_GROUPS). Single-view groups skip the second row, so clicking the
// group is enough; multi-view groups need the view click too.
export async function gotoAdminView(page: Page, groupLabel: string, viewLabel: string): Promise<void> {
  await page.getByRole("button", { name: groupLabel, exact: true }).click();
  const viewTab = page.getByRole("button", { name: viewLabel, exact: true });
  if (await viewTab.count()) {
    await viewTab.first().click();
  }
  await settle(page, 500);
}
