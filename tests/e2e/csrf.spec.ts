// Request-verification tokens, against the running app (app-business-core issue
// 353 SEC.12 leg b; Matt Murphy #68: "SameSite cookies + request-verification
// tokens on every state-changing endpoint").
//
//   1. EVERY WRITE ENDPOINT refuses another website: each discovered POST, PUT,
//      PATCH and DELETE endpoint (tests/isolation/route-map.ts), called signed
//      in WITH this session's valid token but from a foreign Origin, answers 403
//      — except the endpoints tests/unit/csrf-routes.ts names, with the reason.
//   2. THE TOKEN, on the settings write the app's own page makes: no token, a
//      token from another session, and a made-up token are refused 403 and change
//      nothing; this session's token from the app's own origin succeeds.
//
// API-level (no browser), like the other request-level specs.

import { expect, test } from "@playwright/test";
import { addressFor } from "../support/browser";
import { relative } from "node:path";
import { appDir, discoverAllRoutes, isWritable } from "../isolation/route-map";
import { EXEMPT, PENDING } from "../unit/csrf-routes";
import { BASE_URL, client, ensureAccount, signIn, writeHeaders } from "./session-helpers";

const ROOT = process.cwd(); // appDir() is <ROOT>/app
const concrete = (path: string) => path.replace("[key]", "core.client_self_registration").replace(/\[\.\.\.[^\]]+\]/g, "probe").replace(/\[[^\]]+\]/g, "probe");

const WRITES = discoverAllRoutes(appDir()).filter((r) => r.kind === "api" && isWritable(r));
const fileOf = (r: (typeof WRITES)[number]) => relative(ROOT, r.file ?? r.source).replace(/\\/g, "/");

test.describe("request-verification tokens (#353)", () => {
  test("write endpoints were found, and the lists name real ones", () => {
    const files = WRITES.map(fileOf);
    expect(files).toEqual(expect.arrayContaining(["app/api/settings/[key]/route.ts", "app/api/auth/mfa/enroll/route.ts"]));
    for (const f of [...Object.keys(EXEMPT), ...Object.keys(PENDING)]) expect(files, f).toContain(f);
  });

  test("every write endpoint refuses a request from another website, even with a valid token", async () => {
    test.setTimeout(120_000);
    const a = await client(addressFor(test.info(), "97"));
    const email = `csrf-foreign-${Date.now()}@example.com`;
    await ensureAccount(a, email);
    await signIn(a, email);
    const headers = { ...(await writeHeaders(a)), origin: "https://evil.example", "sec-fetch-site": "cross-site" };
    const checked: string[] = [];
    for (const route of WRITES) {
      const f = fileOf(route);
      if (EXEMPT[f] || PENDING[f]) continue;
      for (const method of route.methods.filter((m) => ["POST", "PUT", "PATCH", "DELETE"].includes(m))) {
        const res = await a.fetch(concrete(route.path), { method, headers, data: {}, maxRedirects: 0 });
        expect(res.status(), `${method} ${route.path}: ${(await res.text()).slice(0, 120)}`).toBe(403);
        checked.push(`${method} ${route.path}`);
      }
    }
    expect(checked).toEqual(expect.arrayContaining(["PUT /api/settings/[key]", "DELETE /api/settings/[key]", "POST /api/auth/mfa/enroll"]));
  });

  test("the settings write needs this session's token", async () => {
    const a = await client(addressFor(test.info(), "98"));
    const b = await client(addressFor(test.info(), "99"));
    const stamp = Date.now();
    await ensureAccount(a, `csrf-a-${stamp}@example.com`);
    await ensureAccount(b, `csrf-b-${stamp}@example.com`);
    await signIn(a, `csrf-a-${stamp}@example.com`);
    await signIn(b, `csrf-b-${stamp}@example.com`);
    const url = "/api/settings/core.client_self_registration";
    const own = await writeHeaders(a);
    const other = await writeHeaders(b);

    for (const [label, headers] of [
      ["no token", { origin: BASE_URL }],
      ["another session's token", { origin: BASE_URL, "x-csrf-token": other["x-csrf-token"] }],
      ["a made-up token", { origin: BASE_URL, "x-csrf-token": "A".repeat(43) }],
    ] as const) {
      const res = await a.put(url, { data: { value: true }, headers });
      expect(res.status(), label).toBe(403);
      expect(res.headers()["cache-control"], label).toBe("no-store");
    }
    // Nothing changed: the value is still the default, so this first real save is version 1.
    const ok = await a.put(url, { data: { value: true }, headers: own });
    expect(ok.status(), await ok.text()).toBe(200);
    expect((await ok.json()).version).toBe(1);
    const reset = await a.delete(`${url}?scope=owner`, { headers: own });
    expect(reset.status()).toBe(200);
  });
});
