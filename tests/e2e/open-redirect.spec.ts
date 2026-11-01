// Auth-flow open-redirect test (PiersAG/app-business-core#514, Matt Murphy #26:
// unvalidated post-login/logout redirects send users to phishing pages).
//
// Steps from the ticket: external, protocol-relative, backslash and encoded
// destinations through login and logout. Acceptance: every hostile value ends
// on the app's own origin.
//
// Through LOGIN: the public credentials endpoint (what the login form's server
// action reaches, and what an attacker can post at directly) with each hostile
// callbackUrl, and the sign-in page entry point. Through LOGOUT: the sign-out
// endpoint with each hostile callbackUrl. Every redirect is followed hop by hop
// (redirectChain), so a second redirect the app adds itself is checked too.
//
// A sign-in may also REFUSE a hostile value: the sign-in library answers a
// double-backslash callbackUrl with its own error page and no session. That
// still ends on the app's own origin, which is the acceptance test.

import { expect, test } from "@playwright/test";
import {
  client,
  csrfToken,
  ensureAccount,
  postSignIn,
  redirectChain,
  sameOrigin,
  sessionCookie,
} from "./session-helpers";

const HOSTILE = [
  ["external", "https://evil.example/phish"],
  ["protocol-relative", "//evil.example/phish"],
  ["backslash", "/\\evil.example/phish"],
  ["double backslash", "\\\\evil.example/phish"],
  ["encoded external", "https%3A%2F%2Fevil.example%2Fphish"],
  ["encoded protocol-relative", "%2F%2Fevil.example%2Fphish"],
  ["javascript", "javascript:alert(document.domain)"],
] as const;

const ADDRESS = "203.0.113.14";
const EMAIL = "open-redirect-514@house-starter.test";

test.beforeAll(async () => {
  const ctx = await client(ADDRESS);
  await ensureAccount(ctx, EMAIL);
  await ctx.dispose();
});

async function expectStaysOnApp(
  ctx: Awaited<ReturnType<typeof client>>,
  location: string | undefined,
  what: string,
): Promise<void> {
  const chain = await redirectChain(ctx, location);
  for (const hop of chain) {
    expect(sameOrigin(hop), `${what} redirected off the app: ${chain.join(" → ")}`).toBe(true);
  }
}

test.describe("#514 login", () => {
  test("positive control: a plain sign-in succeeds and lands on the app", async () => {
    const ctx = await client(ADDRESS);
    const res = await postSignIn(ctx, EMAIL, "/dashboard");
    expect(await sessionCookie(ctx)).toBeTruthy();
    expect(new URL(res.headers()["location"]).pathname).toBe("/dashboard");
    await ctx.dispose();
  });

  // Each sign-in spends the per-address sign-in budget (10 a minute), so the
  // four kinds the ticket names are posted, not all seven.
  for (const [kind, target] of HOSTILE.slice(0, 4)) {
    test(`a ${kind} callbackUrl at sign-in ends on the app`, async () => {
      const ctx = await client(ADDRESS);
      const res = await postSignIn(ctx, EMAIL, target);
      await expectStaysOnApp(ctx, res.headers()["location"], "sign-in");
      await ctx.dispose();
    });
  }

  for (const [kind, target] of HOSTILE) {
    test(`the sign-in entry point with a ${kind} callbackUrl ends on the app`, async () => {
      const ctx = await client(ADDRESS);
      const res = await ctx.get(`/api/auth/signin?callbackUrl=${encodeURIComponent(target)}`, {
        maxRedirects: 0,
      });
      await expectStaysOnApp(ctx, res.headers()["location"], "the sign-in entry point");
      await ctx.dispose();
    });
  }
});

test.describe("#514 logout", () => {
  for (const [kind, target] of HOSTILE) {
    test(`a ${kind} callbackUrl at sign-out ends on the app`, async () => {
      const ctx = await client(ADDRESS);
      const res = await ctx.post("/api/auth/signout", {
        form: { csrfToken: await csrfToken(ctx), callbackUrl: target },
        maxRedirects: 0,
      });
      await expectStaysOnApp(ctx, res.headers()["location"], "sign-out");
      await ctx.dispose();
    });
  }
});
