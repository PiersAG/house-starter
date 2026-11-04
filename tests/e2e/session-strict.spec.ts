// Strict sessions, against the running app (app-business-core issues 440, 506,
// 741; the CEO's ruling of 2026-11-02 on #559: "strict"). Request-level.
//
// Unlike session-devices.spec.ts, nothing here re-mints a token "due for renewal":
// each device keeps the exact cookie its sign-in gave it. Under the old 10-minute
// renewal a device signed out from elsewhere kept working with that cookie for up
// to 10 minutes; under "strict" it is refused on its very next request.

import { expect, test } from "@playwright/test";
import { client, ensureAccount, mintToken, readToken, signIn } from "./session-helpers";

const ADDRESS = "203.0.113.90";
const browserAddress = (i: number) => `203.0.113.${91 + i}`;

test.describe.configure({ mode: "serial" });

async function accountPageWith(cookie: string): Promise<string> {
  const ctx = await client(ADDRESS, cookie);
  const res = await ctx.get("/account");
  const path = new URL(res.url()).pathname;
  await ctx.dispose();
  return path;
}

test("a device signed out from another is refused at once, with its own unchanged cookie", async () => {
  const email = "strict-revoke-559@house-starter.test";
  const setup = await client(ADDRESS);
  await ensureAccount(setup, email);
  await setup.dispose();

  const phone = await client(browserAddress(0));
  const laptop = await client(browserAddress(1));
  const phoneToken = await signIn(phone, email);
  await signIn(laptop, email);
  const phoneSession = (await readToken(phoneToken)).sessionId as string;

  // the phone works with the cookie it was given
  expect(await accountPageWith(phoneToken)).toBe("/account");

  // the laptop signs the phone out from its device list (the row's own form, as a
  // browser without scripts would submit it)
  const page = await (await laptop.get("/account/security")).text();
  const at = page.indexOf(`value="${phoneSession}"`);
  expect(at, "the laptop's device list shows the phone").toBeGreaterThan(0);
  const actionField = [...page.slice(Math.max(0, at - 600), at).matchAll(/name="(\$ACTION_ID_[0-9a-f]+)"/g)].at(-1)?.[1];
  expect(actionField, "the device row's sign-out form").toBeTruthy();
  const res = await laptop.post("/account/security", {
    headers: { origin: "http://localhost:3000" },
    multipart: { [actionField as string]: "", sessionId: phoneSession },
    maxRedirects: 0,
  });
  expect(res.status()).toBeLessThan(400);

  // the very next request with the phone's SAME cookie is refused — no waiting
  expect(await accountPageWith(phoneToken), "the phone is signed out at once").toBe("/login");
  expect(new URL((await laptop.get("/account")).url()).pathname, "the laptop carries on").toBe("/account");
  await phone.dispose();
  await laptop.dispose();
});

test("a session lasts 8 hours from sign-in, or 7 days with remember me, however active", async () => {
  const email = "strict-life-559@house-starter.test";
  const setup = await client(ADDRESS);
  await ensureAccount(setup, email);
  await setup.dispose();

  const browser = await client(browserAddress(2));
  const token = await signIn(browser, email);
  await browser.dispose();
  const claims = await readToken(token);
  const now = Math.floor(Date.now() / 1000);

  // the same session, signed in just under / just over 8 hours ago
  const young = await mintToken({ ...claims, authTime: now - 8 * 3600 + 120, rememberMe: false });
  const old = await mintToken({ ...claims, authTime: now - 8 * 3600 - 120, rememberMe: false });
  expect(await accountPageWith(young), "7 h 58 min after sign-in: still signed in").toBe("/account");
  expect(await accountPageWith(old), "8 h 2 min after sign-in: signed out").toBe("/login");

  // with remember me: still in after 6 days 23 hours, out after 7 days. A second
  // sign-in (its own session record: the refusal above ended the first one's)
  const second = await client(browserAddress(3));
  const claims2 = await readToken(await signIn(second, email));
  await second.dispose();
  const week = 7 * 86_400;
  const remembered = await mintToken({ ...claims2, authTime: now - week + 3600, rememberMe: true }, { maxAge: week });
  const expired = await mintToken({ ...claims2, authTime: now - week - 120, rememberMe: true }, { maxAge: week });
  expect(await accountPageWith(remembered), "remember me, 6 days 23 h: still signed in").toBe("/account");
  expect(await accountPageWith(expired), "remember me, 7 days 2 min: signed out").toBe("/login");
});
