// Bundle S13 pages on the served app, request-level (no browser):
//   • /refund-policy is public and says the policy (app-business-core issue 354);
//   • a new owner's settings page shows the trial's days left with Subscribe,
//     so they can pay before the trial ends (issue 375).
// The template's default posture sells a subscription (config/billing.ts), so
// both are served; the off state is held by tests/unit/billing-routes-s13.test.ts.

import { expect, test } from "@playwright/test";
import { addressFor, uniqueEmail } from "../support/browser";
import { client, ensureAccount, signIn } from "./session-helpers";

// Its own client address per test (issue 740): no test spends another's sign-in budget.
const address = () => addressFor(test.info());

test("/refund-policy is public and states the policy", async () => {
  const ctx = await client(address());
  const res = await ctx.get("/refund-policy", { maxRedirects: 0 });
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain("Refund policy");
  expect(html).toContain("within 14 days of your first payment");
  expect(res.headers()["content-security-policy"]).toBeTruthy();
  await ctx.dispose();
});

test("a new owner's settings page offers Subscribe during the trial", async () => {
  const EMAIL = uniqueEmail(test.info(), "plan-card-375");
  const setup = await client(address());
  await ensureAccount(setup, EMAIL);
  await setup.dispose();
  const ctx = await client(address());
  await signIn(ctx, EMAIL);
  const res = await ctx.get("/dashboard/settings");
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toMatch(/Free trial: \d+ days? left/);
  expect(html).toContain("Subscribe");
  expect(html).toContain('href="/refund-policy"');
  await ctx.dispose();
});
