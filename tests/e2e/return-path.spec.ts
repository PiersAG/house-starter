// Return to where you were after signing in again (app-business-core issues 525
// and 440; Matt Murphy step 153: "return to the original page after re-login",
// acceptance: "Playwright return-path test passes and off-site callback is
// rejected"). Request-level, against the running app.

import { expect, test } from "@playwright/test";
import { client, ensureAccount, postSignIn } from "./session-helpers";

const ADDRESS = "203.0.113.31";
const EMAIL = "return-path-525@house-starter.test";

test.describe.configure({ mode: "serial" });

test("a page that needs a sign-in sends the user to sign in WITH the page to come back to", async () => {
  const ctx = await client(ADDRESS);
  const res = await ctx.get("/dashboard/settings?tab=billing", { maxRedirects: 0 });
  expect([302, 303, 307, 308]).toContain(res.status());
  const location = new URL(res.headers()["location"], "http://localhost:3000");
  expect(location.pathname).toBe("/login");
  expect(location.searchParams.get("callbackUrl")).toBe("/dashboard/settings?tab=billing");
  await ctx.dispose();
});

test("the sign-in page carries a local return path, and drops an off-site one", async () => {
  const ctx = await client(ADDRESS);
  const local = await (await ctx.get("/login?callbackUrl=%2Fdashboard%2Fsettings")).text();
  expect(local).toContain('name="callbackUrl" value="/dashboard/settings"');
  for (const hostile of ["https://evil.example/", "//evil.example", "/\\evil.example", "/%2F%2Fevil.example"]) {
    const page = await (await ctx.get(`/login?callbackUrl=${encodeURIComponent(hostile)}`)).text();
    expect(page, hostile).not.toContain('name="callbackUrl"');
    // Next.js echoes the request address in its own page data; what matters is
    // that no form field carries the hostile value back into a sign-in
    expect(page, hostile).not.toMatch(/<input[^>]*value="[^"]*evil\.example/);
  }
  await ctx.dispose();
});

test("signing in with the return path ends on that page; an off-site one ends on the app", async () => {
  const setup = await client(ADDRESS);
  await ensureAccount(setup, EMAIL);
  await setup.dispose();

  const back = await client(ADDRESS);
  const res = await postSignIn(back, EMAIL, "/dashboard/settings");
  expect(new URL(res.headers()["location"], "http://localhost:3000").pathname).toBe("/dashboard/settings");
  await back.dispose();

  const away = await client(ADDRESS);
  const off = await postSignIn(away, EMAIL, "https://evil.example/");
  expect(new URL(off.headers()["location"], "http://localhost:3000").origin).toBe("http://localhost:3000");
  await away.dispose();
});
