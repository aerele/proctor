// frontend/tests/visual/invigilator.spec.ts
// Invigilator portal visual shots from the demo build (routed at /invigilator).
// Demo-covered end to end (fetchInvigilatorOverview/Room demo branches). The
// bare portal authenticates with the admin password (`dev`) per assertDemoInvigilator.
import { test, expect } from "@playwright/test";
import { ADMIN_PASSWORD, settle } from "./_helpers";

async function enterPortal(page: import("@playwright/test").Page) {
  await page.goto("/invigilator");
  await expect(page.getByRole("heading", { name: "Invigilator portal" })).toBeVisible();
  await page.getByRole("textbox", { name: "Your name" }).fill("Demo Invigilator");
  await page.getByRole("textbox", { name: "Invigilator password" }).fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Enter" }).click();
}

test("01 portal entry", async ({ page }) => {
  await page.goto("/invigilator");
  await expect(page.getByRole("heading", { name: "Invigilator portal" })).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("invigilator-01-portal-entry.png", { fullPage: true });
});

test("02 room picker", async ({ page }) => {
  await enterPortal(page);
  await expect(page.getByText("Pick your room")).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("invigilator-02-room-picker.png", { fullPage: true });
});

test("03 room console dashboard", async ({ page }) => {
  await enterPortal(page);
  await expect(page.getByText("Pick your room")).toBeVisible();
  // Pick a real room (by value — robust for React-controlled selects) then open.
  const roomSelect = page.locator("select").first();
  await roomSelect.selectOption("Lab A-1");
  await expect(roomSelect).toHaveValue("Lab A-1");
  await page.getByRole("button", { name: "Open room console" }).click();
  await expect(page.getByText("Students in this room")).toBeVisible();
  await settle(page, 600);
  await expect(page).toHaveScreenshot("invigilator-03-room-console-dashboard.png", { fullPage: true });
});
