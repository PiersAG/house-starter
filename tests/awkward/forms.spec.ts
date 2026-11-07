/**
 * Awkward input in every form (app-business-core issue 721, under the correctness gate,
 * issue 413).
 *
 * Requirements met here, word for word:
 *
 *   R1275 "put an apostrophe in every single field or put 10,000 characters in a field
 *         built for 50 leave required fields empty and hit the submit button or paste
 *         emojis in the search bar" → the `apostrophes`, `10,000 characters`, `empty`
 *         and `emoji` payloads, in every field of every form; the search-bar test.
 *   R1297 "enter a blank form type 1000 characters type 10,000 characters hit submit
 *         47 times open it on a phone" → `empty`, `1,000 characters`, `10,000
 *         characters`, the 47-submit test on every form, and the phone projects.
 *   R1353 "they face weird characters they hit three times in the middle of a request"
 *         → the `weird characters` payload here; the three-clicks test is in
 *         journeys.spec.ts.
 *
 * Every payload must leave the app standing: no server error, no script error, no
 * crash screen, no injected script running. An empty form must say what is missing.
 * The forms come from tests/support/forms.ts, held complete by
 * tests/unit/browser-suite-coverage.test.ts.
 */

import type { Locator, Page, TestInfo } from "@playwright/test";
import { test, expect, settle } from "./fixture";
import { FORMS, type FormEntry } from "../support/forms";
import { visitedRoutes } from "../support/routes";
import { expectNoCrashScreen, signUp, uniqueEmail, watchForFailures } from "../support/browser";

type Payload = { name: string; value: (kind: string, testInfo: TestInfo) => string };

const WEIRD =
  "Robert'); DROP TABLE users;-- <script>window.__injected=1</script> <img src=x onerror=\"window.__injected=1\"> " +
  "‮evil‬ ​ Z̤͔ͧ̑̓ 𝕳 ${7*7} {{7*7}} ../../etc/passwd %00 \\ \t end";
const EMOJI = "🐶🔥👩‍👩‍👧‍👦🏳️‍🌈✨";

export const PAYLOADS: Payload[] = [
  {
    name: "apostrophes",
    value: (kind, t) => (kind === "email" ? uniqueEmail(t, "o'brien") : "O'Brien's 'quoted' value — it's here"),
  },
  { name: "1,000 characters", value: () => "x".repeat(1_000) },
  { name: "10,000 characters", value: () => "x".repeat(10_000) },
  { name: "empty", value: () => "" },
  { name: "emoji", value: (kind, t) => (kind === "email" ? `${EMOJI}${uniqueEmail(t, "emoji")}` : EMOJI) },
  { name: "weird characters", value: () => WEIRD },
];

async function reachForm(page: Page, entry: FormEntry, testInfo: TestInfo): Promise<Locator> {
  if (entry.signedIn) await signUp(page, { email: uniqueEmail(testInfo, "forms") });
  await page.goto(entry.path);
  if (entry.open) await page.getByRole("button", { name: entry.open }).click();
  const submit = page.getByRole("button", { name: entry.submit });
  await expect(submit).toBeVisible({ timeout: 30_000 });
  return submit;
}

function fieldsOf(form: Locator): Locator {
  return form.locator(
    "input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]), textarea",
  );
}

async function fill(form: Locator, payload: Payload, testInfo: TestInfo): Promise<number> {
  const fields = fieldsOf(form);
  const n = await fields.count();
  for (let i = 0; i < n; i++) {
    const field = fields.nth(i);
    const kind = (await field.getAttribute("type")) ?? "text";
    await field.fill(payload.value(kind, testInfo));
  }
  return n;
}

async function submitAndSettle(page: Page, submit: Locator) {
  const start = new URL(page.url());
  const sent = page
    .waitForResponse((r) => r.request().method() !== "GET", { timeout: 30_000 })
    .catch(() => null);
  await submit.click();
  await sent;
  return settle(page, start.pathname + start.search, submit);
}

async function expectStillStanding(page: Page, watch: ReturnType<typeof watchForFailures>, context: string) {
  watch.check(context);
  await expectNoCrashScreen(page, context);
  expect(await page.evaluate(() => (window as { __injected?: number }).__injected ?? 0), `${context}: injected script ran`).toBe(0);
}

for (const [id, entry] of Object.entries(FORMS).filter(([, e]) => e.typed)) {
  for (const payload of PAYLOADS) {
    test(`${id}: ${payload.name} in every field`, async ({ page }, testInfo) => {
      const watch = watchForFailures(page);
      page.on("dialog", (d) => {
        watch.failures.push(`a script opened a dialog: ${d.message()}`);
        void d.dismiss();
      });
      const submit = await reachForm(page, entry, testInfo);
      const form = page.locator("form").filter({ has: submit });
      const filled = await fill(form, payload, testInfo);
      expect(filled, `${id} has fields to type into`).toBeGreaterThan(0);

      const outcome = await submitAndSettle(page, submit);
      if (payload.name === "empty") {
        expect(["message", "invalid"], `${id}: an empty form says what is missing`).toContain(outcome);
      }
      await expectStillStanding(page, watch, `${id} with ${payload.name}`);
    });
  }
}

for (const [id, entry] of Object.entries(FORMS)) {
  test(`${id}: submit pressed 47 times`, async ({ page }, testInfo) => {
    const watch = watchForFailures(page);
    const submit = await reachForm(page, entry, testInfo);
    if (entry.typed) await fill(page.locator("form").filter({ has: submit }), PAYLOADS[0], testInfo);
    for (let i = 0; i < 47; i++) {
      // A person's clicks land whether or not the button is still there or enabled.
      await submit.click({ force: true, noWaitAfter: true, timeout: 2_000 }).catch(() => undefined);
    }
    await page.waitForLoadState("load");
    await expect
      .poll(async () => submit.isDisabled().catch(() => false), { timeout: 60_000 })
      .toBe(false);
    await expectStillStanding(page, watch, `${id} after 47 submits`);
  });
}

// "paste emojis in the search bar": every search box on every page. The template has
// none; a page that adds one is covered the next run.
test("emoji pasted into every search bar", async ({ page }, testInfo) => {
  await signUp(page, { email: uniqueEmail(testInfo, "search") });
  const watch = watchForFailures(page);
  let boxes = 0;
  for (const [, route] of visitedRoutes()) {
    await page.goto(route.visit);
    const search = page.locator("input[type=search], [role=searchbox]");
    for (let i = 0; i < (await search.count()); i++) {
      boxes++;
      await search.nth(i).fill(EMOJI);
      await search.nth(i).press("Enter");
      await page.waitForLoadState("load");
      await expectStillStanding(page, watch, `search on ${route.visit}`);
    }
  }
  testInfo.annotations.push({ type: "search bars", description: String(boxes) });
  watch.check("search bars");
});
