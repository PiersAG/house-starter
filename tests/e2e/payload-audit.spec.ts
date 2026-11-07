// What the browser really receives, signed in (app-business-core issues 794,
// 763 and 445; Matt Murphy #31: "inspect the structured RSC wire payload in
// browser network tools and verify that no sensitive field reaches the
// client"; #140: "audit every single one of your endpoints, strip everything
// the client does not need").
//
// THE TARGETS ARE DISCOVERED: every page and every API route that answers GET
// (tests/isolation/route-map.ts), so a page or route the builder adds is
// audited the next time this runs. Each page is fetched twice — as the HTML a
// browser loads, and as its React Server Components payload (the `RSC: 1`
// request the browser makes when it moves between pages), which is the
// structured wire format Matt Murphy describes.
//
// Every answer is searched for:
//   * a field named for internal or secret data in config/data-classification.ts
//     (camelCase and snake_case), as a JSON or RSC key;
//   * a bcrypt password hash, the account's own password, the session secret
//     and the session token itself;
// and every signed-in answer that carries the account's own data, and every
// API answer that needs a session (it is refused, or differs, signed out), must
// be marked not to be stored (no-store or private), so no browser or shared
// cache keeps it (issue 445).
//
// API-level (no browser), like the other request-level specs.

import { expect, test } from "@playwright/test";
import { addressFor } from "../support/browser";
import { appDir, discoverAllRoutes } from "../isolation/route-map";
import { bannedFieldNames } from "../unit/data-boundary-audit";
import { PASSWORD, SESSION_SECRET, client, ensureAccount, sessionCookie, signIn } from "./session-helpers";
import type { APIRequestContext } from "@playwright/test";

const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const NAMES = [...bannedFieldNames().keys()].flatMap((n) => [n, snake(n)]);
const KEY = new RegExp(`["'](${[...new Set(NAMES)].join("|")})["']\\s*:`);
const BCRYPT = /\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}/;

/** Everything in `body` that must never reach the browser. */
function leaks(body: string, secrets: string[]): string[] {
  const out: string[] = [];
  const key = KEY.exec(body);
  if (key) out.push(`the field "${key[1]}"`);
  if (BCRYPT.test(body)) out.push("a bcrypt password hash");
  for (const s of secrets) if (s && body.includes(s)) out.push(`a secret value (${s.slice(0, 4)}…)`);
  return out;
}

const concrete = (path: string) => path.replace("[key]", "core.app_name").replace(/\[\.\.\.[^\]]+\]/g, "probe").replace(/\[[^\]]+\]/g, "probe");

const ROUTES = discoverAllRoutes(appDir());
const PAGES = ROUTES.filter((r) => r.kind === "page");
const READS = ROUTES.filter((r) => r.kind === "api" && r.methods.includes("GET"));

test.describe("the browser payload audit (#794, #763, #445)", () => {
  test("the audit finds what it looks for (seeded payloads)", () => {
    const secrets = ["S8 sign-in tests passphrase"];
    expect(leaks('{"user":{"id":"u1","passwordHash":"x"}}', secrets)).toEqual(['the field "passwordHash"']);
    expect(leaks('3:["$","div",null,{"stripe_customer_id":"cus_1"}]', secrets)).toEqual(['the field "stripe_customer_id"']);
    expect(leaks(`{"h":"$2b$10$${"a".repeat(53)}"}`, secrets)).toEqual(["a bcrypt password hash"]);
    expect(leaks("you typed S8 sign-in tests passphrase", secrets)).toHaveLength(1);
    expect(leaks('{"user":{"id":"u1","email":"a@example.com"},"message":"ok"}', secrets)).toEqual([]);
  });

  test("pages and read routes were found", () => {
    expect(PAGES.map((r) => r.path)).toEqual(expect.arrayContaining(["/dashboard", "/dashboard/settings", "/account"]));
    expect(READS.map((r) => r.path)).toEqual(expect.arrayContaining(["/api/tenant", "/api/health"]));
  });

  test("no page payload and no API answer carries internal or secret data, and signed-in data is never stored", async () => {
    test.setTimeout(240_000);
    const a = await client(addressFor(test.info(), "95"));
    const email = `payload-${Date.now()}@example.com`;
    await ensureAccount(a, email);
    await signIn(a, email);
    const cookie = (await sessionCookie(a))!;
    const secrets = [PASSWORD, SESSION_SECRET, cookie];
    const anonymous: APIRequestContext = await client(addressFor(test.info(), "96"));

    const problems: string[] = [];
    let audited = 0;
    const check = async (what: string, url: string, headers: Record<string, string>, api: boolean) => {
      const res = await a.get(url, { headers, maxRedirects: 0, failOnStatusCode: false });
      const body = await res.text();
      audited += 1;
      for (const l of leaks(body, secrets)) problems.push(`${what} ${url} (${res.status()}) carries ${l}`);
      const cache = res.headers()["cache-control"] ?? "";
      const own = body.includes(email);
      let needsSession = false;
      if (api && res.status() === 200) {
        const signedOut = await anonymous.get(url, { maxRedirects: 0, failOnStatusCode: false });
        needsSession = signedOut.status() !== 200 || (await signedOut.text()) !== body;
      }
      if ((own || needsSession) && !/no-store|private/.test(cache)) {
        problems.push(`${what} ${url} carries signed-in data but may be stored (cache-control: "${cache || "none"}")`);
      }
    };

    for (const page of PAGES) {
      const url = concrete(page.path);
      await check("page HTML", url, {}, false);
      await check("page RSC payload", url, { RSC: "1" }, false);
    }
    for (const route of READS) await check("answer", concrete(route.path), {}, true);
    // The session endpoint the browser itself reads.
    await check("answer", "/api/auth/session", {}, true);

    expect(audited).toBeGreaterThan(PAGES.length * 2);
    expect(problems).toEqual([]);
  });
});
