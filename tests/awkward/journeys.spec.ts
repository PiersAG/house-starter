/**
 * A real person's first visit, on every browser and device the correctness gate runs
 * (app-business-core issue 721). This file runs in every awkward-* project
 * (playwright.config.ts): Chromium, Firefox, Safari's engine (WebKit), a 2019 iPhone, a
 * 2019 Android phone on a slow connection with a slowed processor, and a 320 px screen
 * on the same slow connection.
 *
 * Requirements met here, word for word:
 *
 *   R1274 "test on the this device you can find with the slowest connection the
 *         smallest screen the oldest browser" → every test below, in every project;
 *         the oldest browser the app supports is checked by
 *         tests/unit/browser-floor.test.ts.
 *   R1297 "open it on a phone" → the phone projects.
 *   R1304 "someone else signs up with a name that has an apostrophe in it your
 *         database throws an error their account doesn't even exist anymore for a
 *         third person opens it on safari" → `an apostrophe in the name and the email
 *         keeps the account`, in the WebKit and iPhone projects as well.
 *   R1353 "they hit three times in the middle of a request … they use it on a phone
 *         from 2019" → `three clicks in the middle of the sign-up make one account`,
 *         and the 2019 projects.
 */

import { test, expect } from "./fixture";
import { SLOW_3G, isSlowProject } from "../support/slow-device";
import { PASSWORD, expectNoCrashScreen, signIn, signOut, signUp, uniqueEmail, watchForFailures } from "../support/browser";

const PAGES = ["/", "/dashboard", "/account", "/account/security", "/account/privacy", "/dashboard/settings"];

test("first visit: sign up and every main page works, with nothing wider than the screen", async ({ page }, testInfo) => {
  const watch = watchForFailures(page);
  await signUp(page, { email: uniqueEmail(testInfo, "journey"), name: "First Visit" });
  if (isSlowProject(testInfo)) {
    // The slow connection is really on: one round trip takes at least its latency.
    const ms = await page.evaluate(async () => {
      const t = performance.now();
      await fetch("/api/health", { cache: "no-store" });
      return performance.now() - t;
    });
    expect(ms, "a round trip on the slow connection").toBeGreaterThanOrEqual(SLOW_3G.latency * 0.9);
  }
  for (const path of PAGES) {
    const res = await page.goto(path);
    expect(res?.status() ?? 0, `${path} answered`).toBeLessThan(400);
    await expect(page.locator("h1").first(), `${path} shows its heading`).toBeVisible();
    const wide = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(wide, `${path} scrolls sideways by ${wide}px`).toBeLessThanOrEqual(0);
    await expectNoCrashScreen(page, path);
  }
  watch.check("first visit");
});

test("an apostrophe in the name and the email keeps the account", async ({ page }, testInfo) => {
  const watch = watchForFailures(page);
  const name = "Siobhán O'Connor-D'Arcy";
  const email = uniqueEmail(testInfo, "o'connor-d'arcy");
  await signUp(page, { email, name });
  await expect(page.getByText(name, { exact: false }), "the name is shown as typed").toBeVisible();
  await signOut(page);
  // The account still exists: it signs in again and still carries the name.
  await signIn(page, { email, password: PASSWORD });
  await expect(page.getByText(name, { exact: false }), "the account and its name survive").toBeVisible();
  watch.check("apostrophe account");
});

test("three clicks in the middle of the sign-up make one account", async ({ page }, testInfo) => {
  const watch = watchForFailures(page);
  const email = uniqueEmail(testInfo, "three-clicks");
  let posts = 0;
  let release: () => void = () => undefined;
  const held = new Promise<void>((r) => (release = r));
  // Hold the sign-up request in flight until the three clicks have landed.
  await page.route("**/signup", async (route) => {
    if (route.request().method() === "POST") {
      posts++;
      await held;
    }
    await route.continue();
  });
  await page.goto("/signup");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  const submit = page.getByRole("button", { name: /create account|creating account/i });
  for (let i = 0; i < 3; i++) {
    await submit.click({ force: true, noWaitAfter: true, timeout: 2_000 }).catch(() => undefined);
  }
  await expect.poll(() => posts, { timeout: 30_000 }).toBeGreaterThan(0);
  release();
  await page.waitForURL("**/dashboard", { timeout: 120_000 });
  await page.unroute("**/signup");
  testInfo.annotations.push({ type: "sign-up requests sent", description: String(posts) });

  // One account: signing up again with the same address is refused as taken, and the
  // first account signs in.
  await signOut(page);
  await page.goto("/signup");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /create account/i }).click();
  await expect(page.getByRole("alert")).toBeVisible({ timeout: 60_000 });
  await signIn(page, { email, password: PASSWORD });
  watch.check("three clicks");
});
