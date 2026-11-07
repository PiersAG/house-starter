// Keyboard journeys and the checks' own self-test (app-business-core issue 720,
// requirement R0619: "audit every interactive element and ensure full keyboard
// accessibility"). Desktop only: the a11y-phone project ignores this file
// (playwright.config.ts), because a phone has no Tab key.

import { test, expect } from "@playwright/test";
import { ownAddress, signUp, uniqueEmail } from "../support/browser";
import { axeViolations, keyboardWalk, structureProblems, unnamedInAccessibilityTree } from "./checks";

// The checks above pass only if they can fail. This plants each fault they look for on
// a scratch page and requires each to be reported, so a broken walk cannot pass green.
test("self-test: the checks catch planted faults", async ({ page }) => {
  await page.setContent(`<!doctype html><html><head><title>planted</title>
    <style>#bare:focus{outline:none;box-shadow:none} #bar{position:fixed;left:0;right:0;bottom:0;height:80px;background:#fff}</style>
    </head><body><main><h1>Planted faults</h1><h3>skipped level</h3>
    <button id="good">Good</button>
    <button id="bare">No focus ring</button>
    <input aria-label="Steals focus away" onfocus="this.blur()">
    <button></button>
    <div style="height:2000px"></div>
    <button id="under" style="position:fixed;bottom:20px;left:10px">Under the bar</button>
    <div id="bar"></div>
    </main></body></html>`);
  const walk = await keyboardWalk(page);
  expect(walk.missed.join(" "), "an element Tab cannot reach is reported").toContain("Steals focus away");
  expect(walk.noVisibleFocus.join(" "), "a missing focus ring is reported").toContain("No focus ring");
  expect(walk.obscured.join(" "), "a focused element under a fixed bar is reported").toContain("Under the bar");
  expect(await unnamedInAccessibilityTree(page), "a button with no name is reported").toHaveLength(1);
  expect((await structureProblems(page)).join(" "), "a skipped heading level is reported").toContain("h1 to h3");
  expect(await axeViolations(page), "axe reports the unnamed button").not.toEqual([]);
});

test("keyboard: the navigation menu opens, moves and closes from the keyboard", async ({ page }, testInfo) => {
  await ownAddress(page, testInfo);
  await signUp(page, { email: uniqueEmail(testInfo, "menu"), name: "Menu Check" });
  await page.goto("/dashboard");
  const triggers = page.locator("[aria-haspopup=menu]");
  const count = await triggers.count();
  for (let i = 0; i < count; i++) {
    const trigger = triggers.nth(i);
    if (!(await trigger.isVisible())) continue;
    await trigger.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await page.keyboard.press("ArrowDown");
    const focusedInMenu = await menu.evaluate((m) => m.contains(document.activeElement));
    expect(focusedInMenu, "arrow keys move inside the open menu").toBe(true);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(trigger, "Escape returns focus to the menu's button").toBeFocused();
  }
});

test("keyboard: the session dialog keeps focus inside it until answered", async ({ page }, testInfo) => {
  await ownAddress(page, testInfo);
  await signUp(page, { email: uniqueEmail(testInfo, "modal"), name: "Modal Check" });
  // Move the page's clock to 50 seconds before the session ends (config/sessions.ts:
  // strict, 8 hours; the warning shows 60 seconds before). The server's clock is real,
  // so "Stay signed in" still reaches a live session.
  await page.clock.install({ time: Date.now() + 8 * 60 * 60 * 1000 - 50_000 });
  await page.goto("/dashboard");
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  const stay = dialog.getByRole("button", { name: /stay signed in/i });
  await expect(stay, "the dialog takes focus when it opens").toBeFocused();
  for (const key of ["Tab", "Tab", "Shift+Tab", "Shift+Tab", "Tab"]) {
    await page.keyboard.press(key);
    const inside = await dialog.evaluate((d) => d.contains(document.activeElement));
    expect(inside, `${key} keeps focus inside the dialog`).toBe(true);
  }
  expect(await axeViolations(page), "axe with the dialog open").toEqual([]);
  await page.keyboard.press("Enter");
  await expect(dialog, "Enter on Stay signed in answers the dialog").toBeHidden();
});
