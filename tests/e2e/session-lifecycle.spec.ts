// Session fixation (PiersAG/app-business-core#798 and #440; Matt Murphy #25):
// "Test that the session identifier changes after authentication and every
// privilege escalation, and that the previous identifier can no longer access
// the account."
//
// Against the running app: every sign-in mints a new session identifier; after
// sign-out the old identifier is refused, and the real user's other session
// carries on. The privilege-change half (a role change replaces the identifier
// and revokes the old one) is proven at the renewal function against a real
// database in tests/unit/revoked-sessions.test.ts — no route in the template can
// change a role yet.
//
// THE RENEWAL WINDOW. The template checks revocation at renewal — every 10
// minutes (CEO ruling 2026-07-15) — not on every page load. To see the old
// identifier refused without waiting 10 minutes, the spec re-mints the old token
// with its renewal time already passed: exactly the state a copied cookie is in
// once the window ends. Refusal on the very next request, inside the window, is
// the open CEO decision #559.

import { expect, test } from "@playwright/test";
import { addressFor, uniqueEmail } from "../support/browser";
import {
  client,
  csrfToken,
  ensureAccount,
  mintToken,
  readToken,
  signIn,
} from "./session-helpers";

const address = () => addressFor(test.info());

// Each test makes its own account and uses its own client addresses (issue 740,
// docs/test-independence.md), so the tests run in any order and a retry starts clean.

/** The old token as it will look once its renewal time has passed. */
async function dueForRenewal(token: string): Promise<string> {
  const claims = await readToken(token);
  return mintToken({ ...claims, renewAfter: Math.floor(Date.now() / 1000) - 1 });
}

/** Where a GET of the account page ends, following redirects. */
async function accountPageWith(cookie: string): Promise<string> {
  const ctx = await client(address(), cookie);
  const res = await ctx.get("/account");
  const path = new URL(res.url()).pathname;
  await ctx.dispose();
  return path;
}

test("a new session identifier at every sign-in; the old one stops working after sign-out", async () => {
  const EMAIL = uniqueEmail(test.info(), "session-lifecycle-798");
  const setup = await client(address());
  await ensureAccount(setup, EMAIL);
  await setup.dispose();

  const first = await client(address());
  const second = await client(address());
  const tokenA = await signIn(first, EMAIL);
  const tokenB = await signIn(second, EMAIL);

  const a = await readToken(tokenA);
  const b = await readToken(tokenB);
  expect(a.sessionId, "sign-in must mint a session identifier").toBeTruthy();
  expect(b.sessionId).toBeTruthy();
  expect(b.sessionId, "the identifier changes at every authentication").not.toBe(a.sessionId);

  // Positive control first: both sessions reach the account page.
  expect(await accountPageWith(await dueForRenewal(tokenA))).toBe("/account");

  // Sign the first session out.
  const out = await first.post("/api/auth/signout", {
    form: { csrfToken: await csrfToken(first), callbackUrl: "/login" },
    maxRedirects: 0,
  });
  expect(out.status()).toBeLessThan(400);

  // The previous identifier can no longer access the account...
  expect(await accountPageWith(await dueForRenewal(tokenA))).toBe("/login");
  // ...and the real user's other session is unaffected.
  expect(await accountPageWith(await dueForRenewal(tokenB))).toBe("/account");

  await first.dispose();
  await second.dispose();
});
