// The awkward-input suite's test function: every test gets its own client address
// (issue 740) and, in a slow project, the slow connection and old processor (issue 721).

import { test as base, expect } from "@playwright/test";
import { ownAddress } from "../support/browser";
import { applySlowDevice, isSlowProject } from "../support/slow-device";

export const test = base.extend<{ device: void }>({
  device: [
    async ({ page }, use, testInfo) => {
      // A slow connection makes every page load take seconds; the limits grow with it.
      if (isSlowProject(testInfo)) testInfo.setTimeout(testInfo.timeout * 6);
      await ownAddress(page, testInfo);
      await applySlowDevice(page, testInfo);
      await use();
    },
    { auto: true },
  ],
});

export { expect };

/** What the page shows after a submit, once it has settled. */
export type Outcome = "message" | "invalid" | "moved" | "pending" | "nothing";

export async function settle(
  page: import("@playwright/test").Page,
  startUrl: string,
  submit: import("@playwright/test").Locator,
): Promise<Outcome> {
  let last: Outcome = "pending";
  await expect
    .poll(
      async () => {
        const seen: Outcome | "settled" = await page
          .evaluate(
            ({ start }) => {
              if (location.pathname + location.search !== start) return "moved";
              const alert = Array.from(document.querySelectorAll("[role=alert]")).some(
                (a) => (a.textContent ?? "").trim().length > 0,
              );
              if (alert) return "message";
              if (document.querySelector("form :invalid")) return "invalid";
              return "settled";
            },
            { start: startUrl },
          )
          .catch(() => "moved" as const);
        if (seen === "settled") {
          const busy = await submit.isDisabled().catch(() => false);
          last = busy ? "pending" : "nothing";
        } else {
          last = seen;
        }
        return last;
      },
      { timeout: 60_000, intervals: [250, 500, 1000] },
    )
    .not.toBe("pending");
  return last;
}
