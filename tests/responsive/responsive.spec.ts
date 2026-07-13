/**
 * Spec C4 — Responsive across all devices.
 *
 * This suite runs once per gated width (see playwright.config.ts projects
 * `responsive-320-small-phone` .. `responsive-1920-desktop`). Each project sets
 * a different viewport (or a real touch/mobile device profile for 390), and
 * this single spec file asserts, for every gated page:
 *
 *   1. No horizontal overflow — `document.documentElement.scrollWidth` must
 *      not exceed `window.innerWidth`. This is the check axe-core cannot do.
 *   2. Touch-target minimum — every interactive element must clear WCAG 2.5.8
 *      (24×24 CSS px absolute floor; 44×44 recommended). We enforce a soft
 *      floor of 24 CSS px to avoid false positives on inline text links, which
 *      are exempt per WCAG.
 *   3. axe-core WCAG 2.2 AA — the same check the desktop smoke suite runs,
 *      re-run at every gated width (colour/contrast and dynamic-label
 *      violations can materialise at narrow widths that don't exist at
 *      desktop).
 *
 * Advisory-first mode (Spec C4 hard constraint): failures are REPORTED but do
 * NOT fail the build unless the CEO flips the switch. The switch is a single
 * env var:
 *
 *   RESPONSIVE_GATE=blocking  → failures throw and fail the run
 *   (unset, or anything else) → failures print + annotate; the run stays green
 *
 * The CEO flips it after seeing the gate produce no false failures on a real
 * build.
 */

import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Pages present in the house-starter template. `/dashboard` and other
// auth-gated routes are excluded from this smoke because they require a signed-
// in session; per-app suites extend this list once auth fixtures are wired.
const PAGES = ["/", "/login", "/signup", "/contact"] as const;

const BLOCKING = process.env.RESPONSIVE_GATE === "blocking";
const MODE = BLOCKING ? "BLOCKING" : "ADVISORY";

// Absolute WCAG 2.5.8 floor. 44 is the comfort target; we gate on the 24 floor
// so we don't drown the advisory output in near-misses that WCAG itself allows.
const TOUCH_TARGET_MIN_CSS_PX = 24;

// Report a failure. In BLOCKING mode we throw so Playwright records the test as
// failed. In ADVISORY mode we annotate + console.warn — the CEO sees the same
// message in the run output and can flip the switch when confident.
function report(testInfo: import("@playwright/test").TestInfo, message: string) {
  const line = `[RESPONSIVE-GATE ${MODE}] ${testInfo.project.name} :: ${message}`;
  testInfo.annotations.push({ type: "responsive-gate", description: line });
  if (BLOCKING) {
    throw new Error(line);
  } else {
    console.warn(line);
  }
}

for (const path of PAGES) {
  test.describe(`page ${path}`, () => {
    test(`no horizontal overflow`, async ({ page }, testInfo) => {
      await page.goto(path);
      await expect(page.locator("body")).toBeVisible();
      const { scroll, inner } = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        inner: window.innerWidth,
      }));
      if (scroll > inner) {
        report(
          testInfo,
          `horizontal overflow on ${path}: scrollWidth=${scroll}, innerWidth=${inner}, overshoot=${scroll - inner}px`,
        );
      }
    });

    test(`touch targets meet WCAG 2.5.8 minimum`, async ({ page }, testInfo) => {
      await page.goto(path);
      await expect(page.locator("body")).toBeVisible();
      // Selector: interactive controls people will actually tap. Text links
      // inside prose are exempt per WCAG 2.5.8; we include buttons and form
      // controls only.
      const undersized = await page.$$eval(
        "button, input[type=submit], input[type=button], input[type=checkbox], input[type=radio], [role=button]",
        (nodes: Element[], min: number) =>
          nodes
            .map((el) => {
              const rect = el.getBoundingClientRect();
              return {
                tag: el.tagName.toLowerCase(),
                label:
                  el.getAttribute("aria-label") ||
                  (el.textContent || "").trim().slice(0, 40) ||
                  "(unlabeled)",
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              };
            })
            .filter((r) => r.width > 0 && r.height > 0)
            .filter((r) => r.width < min || r.height < min),
        TOUCH_TARGET_MIN_CSS_PX,
      );
      if (undersized.length > 0) {
        const preview = undersized
          .slice(0, 5)
          .map(
            (u) =>
              `${u.tag}[${u.label}] ${u.width}×${u.height}`,
          )
          .join("; ");
        report(
          testInfo,
          `${undersized.length} touch target(s) below ${TOUCH_TARGET_MIN_CSS_PX}×${TOUCH_TARGET_MIN_CSS_PX} on ${path}: ${preview}`,
        );
      }
    });

    test(`axe-core WCAG 2.2 AA`, async ({ page }, testInfo) => {
      await page.goto(path);
      await expect(page.locator("body")).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze();
      if (results.violations.length > 0) {
        const preview = results.violations
          .slice(0, 3)
          .map((v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s)`)
          .join("; ");
        report(
          testInfo,
          `${results.violations.length} axe violation(s) on ${path}: ${preview}`,
        );
      }
    });
  });
}
