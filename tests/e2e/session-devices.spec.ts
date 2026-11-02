// Session control through the real sign-in (app-business-core issue 506; Matt
// Murphy #133, acceptance: "two-browser revoke test and oldest-session eviction
// test pass in house-starter CI"). Request-level, against the running app.
//
// As in session-lifecycle.spec.ts, a token is re-minted with its renewal time
// already passed, so the renewal check runs on the next request — the state a
// copied cookie is in once the 10-minute window ends. Under the strict session
// policy (config/sessions.ts, CEO decision #559) it runs on every request anyway.

import { expect, test } from "@playwright/test";
import { client, ensureAccount, mintToken, readToken, signIn } from "./session-helpers";
import { MAX_SESSIONS_PER_USER } from "../../config/sessions";

const ADDRESS = "203.0.113.32";

test.describe.configure({ mode: "serial" });

async function dueForRenewal(token: string): Promise<string> {
  const claims = await readToken(token);
  return mintToken({ ...claims, renewAfter: Math.floor(Date.now() / 1000) - 1 });
}

async function accountPageWith(cookie: string): Promise<string> {
  const ctx = await client(ADDRESS, cookie);
  const res = await ctx.get("/account");
  const path = new URL(res.url()).pathname;
  await ctx.dispose();
  return path;
}

test("oldest-session eviction: one sign-in past the cap signs the oldest device out", async () => {
  const email = "devices-cap-506@house-starter.test";
  const setup = await client(ADDRESS);
  await ensureAccount(setup, email);
  await setup.dispose();

  const tokens: string[] = [];
  for (let i = 0; i < MAX_SESSIONS_PER_USER; i += 1) {
    const browser = await client(ADDRESS);
    tokens.push(await signIn(browser, email));
    await browser.dispose();
  }
  // every device works while the account is at the cap
  expect(await accountPageWith(await dueForRenewal(tokens[0]))).toBe("/account");

  const extra = await client(ADDRESS);
  const newest = await signIn(extra, email);
  await extra.dispose();

  expect(await accountPageWith(await dueForRenewal(tokens[0])), "the oldest device is signed out").toBe("/login");
  expect(await accountPageWith(await dueForRenewal(tokens[1])), "the others carry on").toBe("/account");
  expect(await accountPageWith(await dueForRenewal(newest))).toBe("/account");
});

test("two-browser revoke: signing one device out from the other ends it; the user carries on", async () => {
  const email = "devices-revoke-506@house-starter.test";
  const setup = await client(ADDRESS);
  await ensureAccount(setup, email);
  await setup.dispose();

  const phone = await client(ADDRESS);
  const laptop = await client(ADDRESS);
  const phoneToken = await signIn(phone, email);
  await signIn(laptop, email);
  const phoneSession = (await readToken(phoneToken)).sessionId as string;

  // the laptop's security page lists the phone with its own sign-out
  const page = await (await laptop.get("/account/security")).text();
  expect(page).toContain(`name="sessionId" value="${phoneSession}"`);

  // sign the phone out FROM THE LAPTOP: submit the phone's row of the device list
  // as a browser without scripts would (the form's server-action field and the
  // session id it carries)
  const row = page.slice(Math.max(0, page.indexOf(`value="${phoneSession}"`) - 600), page.indexOf(`value="${phoneSession}"`));
  const actionField = [...row.matchAll(/name="(\$ACTION_ID_[0-9a-f]+)"/g)].at(-1)?.[1];
  expect(actionField, "the device row's sign-out form").toBeTruthy();
  const res = await laptop.post("/account/security", {
    headers: { origin: "http://localhost:3000" },
    multipart: { [actionField as string]: "", sessionId: phoneSession },
    maxRedirects: 0,
  });
  expect(res.status()).toBeLessThan(400);
  expect(await accountPageWith(await dueForRenewal(phoneToken)), "the phone is signed out").toBe("/login");
  // the laptop carries on
  expect(new URL((await laptop.get("/account")).url()).pathname).toBe("/account");
  await phone.dispose();
  await laptop.dispose();
});
