// @vitest-environment node
// A switched-off account cannot sign in, and signing in never switches it back
// on (app-business-core issue 358; Dispatch AG's fourth independent review,
// "not checked: lib/auth.ts authorize").
//
// This runs the REAL authorize() from lib/auth.ts — the one path the login form
// and the public credentials endpoint both come through — against a real
// catalog, with the CORRECT password. Only the NextAuth wrapper is replaced, to
// hand the test the authorize() that lib/auth.ts defines; next/headers gives a
// client address for the throttle. The lines of authorize() this relies on:
//
//     const user = await getUserByEmail(catalogDb, parsed.data.email);
//     if (!user) return null;
//     if (isDeactivated(user)) return null;      // lib/privacy/deactivation.ts
//     ...password, second factor...
//     ensureTenantForUser(...)                    // per_tenant: only after both
//
// isDeactivated refuses `deactivated_at` OR `signup_pending_since`, so either
// mark alone keeps the account shut, and the refusal comes before anything that
// could write to the account or give it a tenant.

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ config: null as null | { providers: { authorize: (c: unknown) => unknown }[] } }));
vi.mock("next/headers", () => ({
  headers: async () => ({ get: (name: string) => (name.toLowerCase() === "x-forwarded-for" ? "203.0.113.9" : null) }),
}));
vi.mock("next-auth/providers/credentials", () => ({ default: (options: unknown) => options }));
vi.mock("next-auth", () => ({
  default: (config: typeof captured.config) => {
    captured.config = config;
    return { handlers: {}, signIn: vi.fn(), signOut: vi.fn(), auth: vi.fn() };
  },
}));

import { migrateCatalog } from "@/lib/migrate";
import { __resetCatalogCacheForTests, getCatalogDb } from "@/lib/catalog";
import { __resetDbCacheForTests } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { resetRateLimiterForTests } from "@/lib/rate-limit";
import { createUser } from "@/lib/users";

const PASSWORD = "a-long-enough-passphrase-1";
let workDir: string;
let catalogUrl: string;
let n = 0;

async function query(sql: string, args: (string | null)[] = []) {
  const client = createClient({ url: catalogUrl });
  try {
    return (await client.execute({ sql, args })).rows;
  } finally {
    client.close();
  }
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "house-starter-signin-off-"));
  catalogUrl = `file:${join(workDir, "catalog.db")}`;
  process.env.CATALOG_DATABASE_URL = catalogUrl;
  process.env.TENANCY_MODE = "per_tenant";
  process.env.TENANT_PROVISIONER = "file";
  process.env.TENANT_DB_DIR = join(workDir, "tenants");
  process.env.RATE_LIMIT_ALLOW_IN_MEMORY = "true";
  process.env.AUTH_SECRET = "test-only-session-secret-for-the-sign-in-path-0123456789";
  __resetCatalogCacheForTests();
  __resetDbCacheForTests();
  await migrateCatalog(catalogUrl);
  await import("@/lib/auth");
});
afterAll(() => {
  for (const k of ["CATALOG_DATABASE_URL", "TENANCY_MODE", "TENANT_PROVISIONER", "TENANT_DB_DIR", "RATE_LIMIT_ALLOW_IN_MEMORY", "AUTH_SECRET"]) {
    delete process.env[k];
  }
  rmSync(workDir, { recursive: true, force: true });
});
beforeEach(() => {
  resetRateLimiterForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const authorize = (email: string) => captured.config!.providers[0].authorize({ email, password: PASSWORD });

/** An account with the right password, in the given state. */
async function accountIn(state: "on" | "closed" | "signup-as-created" | "signup-mark-only"): Promise<{ id: string; email: string }> {
  const email = `signin-${++n}@example.com`;
  const user = await createUser(getCatalogDb(), {
    email,
    passwordHash: await hashPassword(PASSWORD),
    pendingSignup: state === "signup-as-created" || state === "signup-mark-only",
  });
  if (state === "closed") {
    await query("UPDATE users SET deactivated_at = unixepoch(), deletion_due_at = unixepoch() + 86400 WHERE id = ?", [user.id]);
  }
  if (state === "signup-mark-only") {
    // Only the sign-up mark is left: deactivated_at alone being cleared must never open it.
    await query("UPDATE users SET deactivated_at = NULL WHERE id = ?", [user.id]);
  }
  return { id: user.id, email };
}

const stateOf = async (id: string) =>
  (await query("SELECT tenant_id, deactivated_at, signup_pending_since, deletion_due_at, sessions_valid_from FROM users WHERE id = ?", [id]))[0];
const tenantFiles = () => (existsSync(join(workDir, "tenants")) ? readdirSync(join(workDir, "tenants")).length : 0);

describe("the real sign-in path (lib/auth.ts authorize)", () => {
  it("signs in a switched-on account with the right password — so the refusals below are the rule, not a broken set-up", async () => {
    const { id, email } = await accountIn("on");
    const user = (await authorize(email)) as { id: string; tenantId: string } | null;
    expect(user?.id).toBe(id);
    expect(user?.tenantId).toMatch(/^t[0-9a-f]{32}$/); // per_tenant: its tenant resolved at sign-in
  });

  for (const state of ["closed", "signup-as-created", "signup-mark-only"] as const) {
    it(`refuses an account that is ${state === "closed" ? "closed (deactivated_at set)" : state === "signup-as-created" ? "a sign-up being set up (both marks set)" : "a sign-up being set up with only signup_pending_since set"}, and never switches it on`, async () => {
      const { id, email } = await accountIn(state);
      const before = await stateOf(id);
      const filesBefore = tenantFiles();
      for (let i = 0; i < 3; i++) {
        expect(await authorize(email)).toBeNull();
      }
      // Nothing about the account changed: still off, still linked to nothing, no tenant made for it.
      expect(await stateOf(id)).toEqual(before);
      expect(before.tenant_id).toBeNull();
      expect(tenantFiles()).toBe(filesBefore);
    });
  }
});
