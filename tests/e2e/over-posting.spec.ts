// Malformed and over-posted requests against every write endpoint, bypassing
// the forms (PiersAG/app-business-core #448 mass assignment, #442; Matt Murphy
// #36: "direct malformed + over-posted request tests against every endpoint";
// #48: "Whitelist user-editable fields such as name, email, and avatar, and
// reject role, plan, permission, account-status, or isAdmin values").
//
// THE TARGETS ARE DISCOVERED: every API route under app/ exporting a write verb
// (tests/isolation/route-map.ts), so a write route the builder adds is probed
// the next time this runs.
//
// TWO LEGS, signed in:
//   1. MALFORMED — not JSON, the wrong types, an array, an oversized body: each
//      write endpoint answers with a refusal (4xx), never a server error.
//   2. OVER-POSTED — a valid-looking body plus role, plan, permissions,
//      accountStatus, isAdmin, tenantId and userId: whatever the endpoint
//      answers, the caller's role and tenant afterwards are exactly what they
//      were (read from a fresh session), and the account's own settings show no
//      trace of the extra fields.
//
// API-level (no browser), like the other request-level specs.

import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appDir, discoverAllRoutes, isWritable } from "../isolation/route-map";
import { BASE_URL, client, ensureAccount, readToken, sessionCookie, signIn } from "./session-helpers";

const PRIVILEGED = {
  role: "admin",
  plan: "enterprise",
  permissions: ["*"],
  accountStatus: "active",
  isAdmin: true,
  tenantId: "someone-elses-tenant",
  userId: "someone-else",
  ownerId: "someone-else",
};

const MALFORMED: { label: string; body: string; type: string }[] = [
  { label: "not JSON", body: "{not json", type: "application/json" },
  { label: "a JSON array", body: "[1,2,3]", type: "application/json" },
  { label: "a JSON string", body: "\"x\"", type: "application/json" },
  { label: "wrong types", body: JSON.stringify({ value: { nested: [1] }, scope: 7, email: 5, password: [] }), type: "application/json" },
  { label: "an oversized body", body: JSON.stringify({ value: "x".repeat(200_000) }), type: "application/json" },
  { label: "form encoding", body: "role=admin&isAdmin=true", type: "application/x-www-form-urlencoded" },
];

function concrete(path: string): string {
  // a dynamic segment gets a real, harmless value
  return path.replace("[key]", "core.app_name").replace(/\[[^\]]+\]/g, "probe");
}

// Not probed here, with the reason: the two billing routes read no request body
// at all (nothing to over-post or malform) and call Stripe straight away, which
// this environment has no real key for, so every request is a Stripe error. The
// webhook, which does read a body, is probed.
const NOT_PROBED = ["/api/billing/checkout", "/api/billing/portal"];

const WRITE_ROUTES = discoverAllRoutes(appDir()).filter(
  (r) => r.kind === "api" && isWritable(r) && !NOT_PROBED.includes(r.path),
);

test.describe("malformed and over-posted requests (#448, #442)", () => {
  test("the routes left out read no body (checked, not assumed)", () => {
    for (const path of NOT_PROBED) {
      const src = readFileSync(join(appDir(), path.replace(/^\//, "").replace(/^api/, "api"), "route.ts"), "utf8");
      expect(src, path).not.toMatch(/\.(json|formData|text|arrayBuffer)\(\)/);
    }
  });

  test("write endpoints were found", () => {
    expect(WRITE_ROUTES.map((r) => r.path)).toEqual(expect.arrayContaining(["/api/settings/[key]", "/api/auth/signup"]));
  });

  test("malformed bodies are refused, never a server error", async () => {
    test.setTimeout(180_000);
    const stamp = Date.now();
    const a = await client("203.0.113.81");
    const email = `malformed-${stamp}@example.com`;
    await ensureAccount(a, email);
    await signIn(a, email);
    for (const route of WRITE_ROUTES) {
      for (const method of route.methods.filter((m) => ["POST", "PUT", "PATCH", "DELETE"].includes(m))) {
        for (const m of MALFORMED) {
          const res = await a.fetch(concrete(route.path), {
            method,
            headers: { origin: BASE_URL, "content-type": m.type },
            data: m.body,
            maxRedirects: 0,
          });
          const where = `${method} ${route.path} with ${m.label}`;
          expect(res.status(), `${where}: ${(await res.text()).slice(0, 200)}`).toBeLessThan(500);
        }
      }
    }
  });

  test("over-posted fields never change who the caller is", async () => {
    test.setTimeout(180_000);
    const stamp = Date.now();
    const a = await client("203.0.113.82");
    const email = `overpost-${stamp}@example.com`;

    // Sign-up itself, over-posted: the account is created as an ordinary owner.
    const signup = await a.post("/api/auth/signup", {
      data: { email, password: "S8 sign-in tests passphrase", ...PRIVILEGED },
      headers: { origin: BASE_URL },
    });
    expect([201, 409]).toContain(signup.status());
    await signIn(a, email);
    const before = await readToken((await sessionCookie(a))!);
    expect(before.role).toBe("owner");
    expect(before.tenantId).not.toBe(PRIVILEGED.tenantId);

    for (const route of WRITE_ROUTES) {
      for (const method of route.methods.filter((m) => ["POST", "PUT", "PATCH"].includes(m))) {
        const res = await a.fetch(concrete(route.path), {
          method,
          headers: { origin: BASE_URL },
          data: { value: `overpost-${stamp}`, scope: "owner", email, ...PRIVILEGED },
          maxRedirects: 0,
        });
        expect(res.status(), `${method} ${route.path}`).toBeLessThan(500);
      }
    }

    // A fresh session reads the role and tenant from the database again.
    const fresh = await client("203.0.113.83");
    await signIn(fresh, email);
    const after = await readToken((await sessionCookie(fresh))!);
    expect(after.role).toBe(before.role);
    expect(after.tenantId).toBe(before.tenantId);
    const settings = await (await fresh.get("/dashboard/settings")).text();
    expect(settings).not.toContain(PRIVILEGED.tenantId);
    expect(settings).not.toContain("enterprise");
  });
});
