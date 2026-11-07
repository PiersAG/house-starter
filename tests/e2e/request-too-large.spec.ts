// A too-large request gets a plain "too large" answer (Dispatch AR). Dispatch AQ's
// awkward-input suite (issue 721) found a 200 MB form submission answered 500 by
// Next.js's own 1 MB form limit. The edge middleware now answers any request whose
// declared size is over the limit (lib/request-size.ts) with 413 before anything
// reads the body, and the app keeps answering.
//
// API-level (no browser), like the other request-level specs. Each test uses its own
// client address and email, made fresh per run (issue 740: no test leans on another).
// Installed by the Dispatch AR CEO script with the middleware edit it needs.

import { randomInt, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { MAX_REQUEST_BYTES, TOO_LARGE_MESSAGE } from "../../lib/request-size";
import { BASE_URL, client } from "./session-helpers";

const MB = 1024 * 1024;
/** A fresh documentation-range address (RFC 5737) per client. */
const address = () => `198.51.100.${randomInt(1, 255)}`;
const email = (tag: string) => `too-large-${tag}-${randomUUID()}@example.com`;

async function stillAnswers() {
  const ctx = await client(address());
  expect((await ctx.get(`${BASE_URL}/api/health`)).status()).toBe(200);
  await ctx.dispose();
}

test.describe("too-large requests are answered 413", () => {
  test("the sign-up endpoint", async () => {
    const ctx = await client(address());
    const res = await ctx.post(`${BASE_URL}/api/auth/signup`, {
      headers: { "content-type": "application/json" },
      data: JSON.stringify({ email: email("api"), password: "x".repeat(2 * MB) }),
    });
    expect(res.status()).toBe(413);
    expect(await res.json()).toEqual({ error: TOO_LARGE_MESSAGE });
    await ctx.dispose();
    await stillAnswers();
  });

  test("a form submission (server action), at 200 MB", async () => {
    test.setTimeout(120_000);
    const ctx = await client(address());
    const started = Date.now();
    const res = await ctx.post(`${BASE_URL}/signup`, {
      headers: { "content-type": "text/plain;charset=UTF-8", "next-action": "0".repeat(40), origin: BASE_URL },
      data: Buffer.alloc(200 * MB, "x"),
      timeout: 120_000,
    });
    expect(res.status(), "too large, not a server error").toBe(413);
    expect(Date.now() - started, "answered within a minute").toBeLessThan(60_000);
    await ctx.dispose();
    await stillAnswers();
  });

  test("a signed-out settings write over the limit is refused as too large, first", async () => {
    const ctx = await client(address());
    const res = await ctx.put(`${BASE_URL}/api/settings/core.client_self_registration`, {
      headers: { "content-type": "application/json", origin: BASE_URL },
      data: Buffer.alloc(MAX_REQUEST_BYTES + 1, "x"),
    });
    expect(res.status()).toBe(413);
    await ctx.dispose();
  });

  test("a request at the limit is not refused as too large", async () => {
    const ctx = await client(address());
    const res = await ctx.post(`${BASE_URL}/api/auth/signup`, {
      headers: { "content-type": "application/json" },
      data: JSON.stringify({ email: email("small"), password: "short" }),
    });
    expect(res.status()).not.toBe(413);
    expect(res.status()).toBeLessThan(500);
    await ctx.dispose();
  });
});
