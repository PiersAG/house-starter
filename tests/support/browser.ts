// Shared helpers for the browser suites (app-business-core issues 720, 721, 740).
//
// INDEPENDENT TEST DATA (issue 740; Matt Murphy #208: "tests that depend on other
// tests"). Every test makes its own account with `uniqueEmail` and sends its own client
// address with `addressFor`, so no test reads data another test wrote, no test spends
// another test's rate-limit budget, and the order the tests run in never matters. A
// retry gets a fresh account too (the retry number is part of the seed), so a retry
// never trips over what the first attempt left behind.
//
// The rule these helpers serve is written down in docs/test-independence.md and held by
// tests/unit/test-independence.test.ts.

import { createHash } from "node:crypto";
import { expect, type Page, type TestInfo } from "@playwright/test";

export const PASSWORD = "Browser suites passphrase 2026";

function seed(testInfo: TestInfo, label: string): string {
  return createHash("sha256")
    .update(
      [
        testInfo.project.name,
        ...testInfo.titlePath,
        String(testInfo.retry),
        String(testInfo.repeatEachIndex),
        label,
      ].join("\u0000"),
    )
    .digest("hex");
}

/**
 * A client address of this test's own, from the benchmarking range (RFC 2544,
 * 198.18.0.0/15), so it can never be a real client's. Sign-in and sign-up are limited
 * per address (lib/auth-rate-limit.ts).
 */
export function addressFor(testInfo: TestInfo, label = ""): string {
  const n = parseInt(seed(testInfo, `address:${label}`).slice(0, 8), 16);
  return `198.${18 + ((n >>> 16) & 1)}.${(n >>> 8) & 255}.${n & 255}`;
}

/** An email address no other test (and no earlier attempt of this one) uses. */
export function uniqueEmail(testInfo: TestInfo, label: string): string {
  const safe = label.toLowerCase().replace(/[^a-z0-9']+/g, "-").replace(/^-|-$/g, "");
  return `${safe}-${seed(testInfo, `email:${label}`).slice(0, 10)}-${Date.now().toString(36)}@house-starter.test`;
}

/** Give this page's context its own client address. Call before the first request. */
export async function ownAddress(page: Page, testInfo: TestInfo, label = ""): Promise<string> {
  const address = addressFor(testInfo, label);
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": address });
  return address;
}

/**
 * Safari's engine reports a background page prefetch that dies as the page changes
 * (Next.js's `?_rsc=` fetch, at the moment of a sign-out) as an uncaught script error.
 * The user sees nothing, and a server error on that fetch is still caught by the
 * response check below. Seen once in 141 tests on one run (Dispatch AV, 2026-11-06).
 */
export function isDroppedPrefetch(message: string): boolean {
  return /\?_rsc=[\w-]+ due to access control checks\.$/.test(message);
}

/**
 * Watch a page for the failures a user would meet as a broken screen: a server error
 * (5xx) from this app, or an uncaught script error. `check()` fails the test with what
 * was seen.
 */
export function watchForFailures(page: Page) {
  const failures: string[] = [];
  page.on("response", (res) => {
    if (res.status() >= 500 && res.url().startsWith(new URL(page.url() || "http://localhost:3000").origin)) {
      failures.push(`${res.status()} from ${res.request().method()} ${new URL(res.url()).pathname}`);
    }
  });
  page.on("pageerror", (err) => {
    if (!isDroppedPrefetch(err.message)) failures.push(`script error: ${err.message}`);
  });
  return {
    failures,
    check(context: string) {
      expect(failures, `${context}: the app failed while handling it`).toEqual([]);
    },
  };
}

/** The app's crash screen (components/SafetyNetMessage.tsx) is not showing. */
export async function expectNoCrashScreen(page: Page, context: string): Promise<void> {
  await expect(
    page.getByText(/Something went wrong/i),
    `${context}: the crash screen showed`,
  ).toHaveCount(0);
}

/** Sign up through the real form and land on the dashboard. */
export async function signUp(
  page: Page,
  account: { email: string; password?: string; name?: string },
): Promise<void> {
  await page.goto("/signup");
  if (account.name !== undefined) await page.getByLabel(/^Name/).fill(account.name);
  await page.getByLabel("Email", { exact: true }).fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password ?? PASSWORD);
  await page.getByRole("button", { name: /create account/i }).click();
  await page.waitForURL("**/dashboard", { timeout: 60_000 });
}

/** Sign in through the real form and land on the dashboard. */
export async function signIn(
  page: Page,
  account: { email: string; password?: string },
): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password ?? PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL("**/dashboard", { timeout: 60_000 });
}

/** Sign out through the dashboard's own button. */
export async function signOut(page: Page): Promise<void> {
  await page.goto("/dashboard");
  await page.getByRole("button", { name: /sign out/i }).first().click();
  await page.waitForURL((url) => !url.pathname.startsWith("/dashboard"), { timeout: 30_000 });
}
