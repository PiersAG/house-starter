/**
 * Accessibility to WCAG 2.2 AA across every page, signed in and signed out
 * (app-business-core issue 720, under the correctness gate, issue 413).
 *
 * The four requirements, word for word (Matt Murphy #117 and #297), and the test
 * that meets each:
 *
 *   R0619 "audit every interactive element and ensure full keyboard accessibility"
 *         → `keyboard: every interactive element is reached by Tab alone, with a
 *           visible focus, and is not hidden behind anything`, per page; the menu
 *           test (Enter opens, arrows move, Escape closes and returns focus); and the
 *           modal test (Tab and Shift+Tab stay inside the session dialog).
 *   R0620 "audit every image every button every input every navigation element
 *         proper labelling"
 *         → axe's naming rules (image-alt, button-name, input labels, link-name,
 *           ARIA names) on every page, and an independent read of the browser's own
 *           accessibility tree: no image, button, link, field or menu item without a
 *           name.
 *   R0621 "run a contract audit on every text element and fix anything below 4.5 to
 *         one ratio"
 *         → axe's color-contrast rule (WCAG 1.4.3, 4.5:1 for body text) on every page,
 *           signed in and signed out, at desktop and phone widths.
 *   R1278 "responsive design that doesn't break on mobile accessibility for screen
 *         readers"
 *         → the same checks on every signed-in page at a phone width (project
 *           a11y-phone), plus the structure a screen reader navigates by: one main
 *           landmark, one top heading, no skipped heading levels, a page title and a
 *           page language.
 *
 * Every page comes from tests/support/routes.ts; tests/unit/browser-suite-coverage.test.ts
 * fails when a page under app/ is missing from it. Each test makes its own account
 * (issue 740), so the tests run in any order.
 */

import { test, expect, type Page } from "@playwright/test";
import { visitedRoutes } from "../support/routes";
import { ownAddress, signUp, uniqueEmail, watchForFailures } from "../support/browser";
import { axeViolations, keyboardWalk, structureProblems, unnamedInAccessibilityTree } from "./checks";

async function auditPage(page: Page, path: string, opts: { keyboard: boolean }) {
  const watch = watchForFailures(page);
  const res = await page.goto(path);
  expect(res?.status() ?? 0, `${path} answered`).toBeLessThan(500);
  await page.waitForLoadState("networkidle");

  expect(await axeViolations(page), `axe (WCAG 2.2 AA) on ${path}`).toEqual([]);
  expect(await unnamedInAccessibilityTree(page), `unnamed controls or images on ${path}`).toEqual([]);
  expect(await structureProblems(page), `screen-reader structure of ${path}`).toEqual([]);

  if (opts.keyboard) {
    const walk = await keyboardWalk(page);
    expect(walk.missed, `${path}: interactive elements Tab never reached`).toEqual([]);
    expect(walk.noVisibleFocus, `${path}: elements with no visible focus`).toEqual([]);
    expect(walk.obscured, `${path}: focused elements hidden behind something`).toEqual([]);
  }
  watch.check(path);
}

for (const [route, spec] of visitedRoutes()) {
  test(`signed in: ${route}`, async ({ page, isMobile }, testInfo) => {
    await ownAddress(page, testInfo);
    await signUp(page, { email: uniqueEmail(testInfo, "a11y"), name: "Accessibility Check" });
    await auditPage(page, spec.visit, { keyboard: !isMobile });
  });

  if (spec.signedOut) {
    test(`signed out: ${route}`, async ({ page, isMobile }, testInfo) => {
      await ownAddress(page, testInfo);
      await auditPage(page, spec.visit, { keyboard: !isMobile });
    });
  }
}
