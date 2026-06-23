import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("home page loads and has no accessibility violations", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("body")).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations).toEqual([]);
});

test("login page loads and has no accessibility violations", async ({ page }) => {
  await page.goto("/login");
  await expect(page.locator("body")).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations).toEqual([]);
});
