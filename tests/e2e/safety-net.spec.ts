// Safety-net screens (app-business-core issue 502; Matt Murphy #56, #108,
// #126, #297), served by the built app. The request-only tests run without a
// browser; the page tests need one (CI).

import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("an unknown address answers 404 with the branded page and no internal detail", async ({ request }) => {
  const res = await request.get("/no-such-page", { maxRedirects: 0 });
  expect(res.status()).toBe(404);
  const html = await res.text();
  expect(html).toContain("Page not found");
  expect(html).toContain("Go to the home page");
  expect(html).not.toMatch(/at \S+\.(js|ts):\d+|node_modules|\/srv\//);
});

test("a page that throws never sends its error text", async ({ request }) => {
  const res = await request.get("/crash-check", { maxRedirects: 0 });
  expect(res.status()).toBe(500);
  expect(await res.text()).not.toContain("secret-path");
});

test("every response carries a request id (#503)", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.headers()["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
});

test("the crash screen: plain message, a reference, a working Try again; axe passes", async ({ page }) => {
  await page.goto("/crash-check");
  await expect(page.getByRole("heading", { name: "Something went wrong" })).toBeVisible();
  await expect(page.getByTestId("error-reference")).toHaveText(/\S+/);
  await expect(page.locator("body")).not.toContainText("secret-path");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Something went wrong" })).toBeVisible();
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag22aa"]).analyze();
  expect(axe.violations).toEqual([]);
});

test("the not-found screen passes axe", async ({ page }) => {
  await page.goto("/no-such-page");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag22aa"]).analyze();
  expect(axe.violations).toEqual([]);
});

test("the offline notice appears without a connection and goes when it is back", async ({ page, context }) => {
  await page.goto("/login");
  await context.setOffline(true);
  await expect(page.getByText("You are offline.")).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText("You are offline.")).toBeHidden();
});
