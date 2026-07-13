// User repository + registration tests (spec C4b, Deliverable C).
//
// Runs lib/users.ts against a REAL in-memory libSQL database brought to the
// current schema by the one true migration path (lib/migrate.ts) — no mocked
// query builder, so what is asserted here is what production executes.
// Covers creation, lookup (normalised email), duplicate handling, fail-closed
// password policy at registration, and tenant scoping: the same email can
// exist independently in two tenants' databases because every function takes
// its database explicitly.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import type { Client } from "@libsql/client";
import { createMigrationDatabase, runMigrations } from "@/lib/migrate";
import { verifyPassword } from "@/lib/password";
import {
  RegistrationError,
  createUser,
  getUserByEmail,
  getUserById,
  normalizeEmail,
  registerUser,
  type AppDatabase,
} from "@/lib/users";

let client: Client;
let db: AppDatabase;

async function freshDb(): Promise<{ client: Client; db: AppDatabase }> {
  const c = createMigrationDatabase(":memory:");
  await runMigrations(c);
  return { client: c, db: drizzle(c) as AppDatabase };
}

beforeEach(async () => {
  ({ client, db } = await freshDb());
});

afterEach(() => {
  client.close();
});

describe("normalizeEmail", () => {
  it("trims and lower-cases", () => {
    expect(normalizeEmail("  Ada@Example.COM  ")).toBe("ada@example.com");
  });
});

describe("createUser / getUserByEmail / getUserById", () => {
  it("persists a user and finds it by normalised email", async () => {
    const created = await createUser(db, {
      email: "Ada@Example.com",
      passwordHash: "$2b$10$fakefakefakefakefakefakefakefakefakefakefakefakefake",
      name: "Ada",
    });
    expect(created.id).toBeTruthy();
    expect(created.email).toBe("ada@example.com"); // stored normalised

    const byEmail = await getUserByEmail(db, "  ADA@example.COM ");
    expect(byEmail?.id).toBe(created.id);

    const byId = await getUserById(db, created.id);
    expect(byId?.email).toBe("ada@example.com");
  });

  it("defaults name to null when omitted", async () => {
    const created = await createUser(db, {
      email: "no-name@example.com",
      passwordHash: "hash",
    });
    expect(created.name).toBeNull();
  });

  it("returns undefined for unknown email and id — no throw, no phantom row", async () => {
    await expect(getUserByEmail(db, "ghost@example.com")).resolves.toBeUndefined();
    await expect(getUserById(db, "no-such-id")).resolves.toBeUndefined();
  });

  it("generates a distinct id per user", async () => {
    const a = await createUser(db, { email: "a@example.com", passwordHash: "h" });
    const b = await createUser(db, { email: "b@example.com", passwordHash: "h" });
    expect(a.id).not.toBe(b.id);
  });
});

describe("registerUser — end-to-end account creation", () => {
  it("creates the account with a verifiable bcrypt hash, never the plaintext", async () => {
    const user = await registerUser(db, {
      email: "New@Example.com",
      password: "correct horse battery staple",
      name: "New User",
    });

    expect(user.email).toBe("new@example.com");
    expect(user.name).toBe("New User");
    expect(user.passwordHash).not.toContain("correct horse battery staple");
    await expect(
      verifyPassword("correct horse battery staple", user.passwordHash),
    ).resolves.toBe(true);

    // Persisted, not just returned.
    const persisted = await getUserByEmail(db, "new@example.com");
    expect(persisted?.id).toBe(user.id);
  });

  it("defaults name to null when omitted", async () => {
    const user = await registerUser(db, {
      email: "anon@example.com",
      password: "correct horse battery staple",
    });
    expect(user.name).toBeNull();
  });

  it("rejects a weak password fail-closed: typed error, nothing persisted", async () => {
    await expect(
      registerUser(db, { email: "weak@example.com", password: "short" }),
    ).rejects.toMatchObject({
      name: "RegistrationError",
      code: "weak_password",
    });
    await expect(getUserByEmail(db, "weak@example.com")).resolves.toBeUndefined();
  });

  it("rejects a breached password before hashing or persisting", async () => {
    await expect(
      registerUser(db, { email: "breached@example.com", password: "password123" }),
    ).rejects.toMatchObject({ code: "weak_password" });
    await expect(
      getUserByEmail(db, "breached@example.com"),
    ).resolves.toBeUndefined();
  });

  it("rejects non-string password input fail-closed (invalid input never reaches the db)", async () => {
    await expect(
      registerUser(db, {
        email: "bad-input@example.com",
        password: null as unknown as string,
      }),
    ).rejects.toBeInstanceOf(RegistrationError);
    await expect(
      getUserByEmail(db, "bad-input@example.com"),
    ).resolves.toBeUndefined();
  });

  it("rejects a duplicate email — including case/whitespace variants — leaving one row", async () => {
    await registerUser(db, {
      email: "taken@example.com",
      password: "correct horse battery staple",
    });

    await expect(
      registerUser(db, {
        email: "  TAKEN@Example.com ",
        password: "a different fine password",
      }),
    ).rejects.toMatchObject({ code: "email_taken" });

    const survivor = await getUserByEmail(db, "taken@example.com");
    expect(survivor).toBeDefined();
    await expect(
      verifyPassword("correct horse battery staple", survivor!.passwordHash),
    ).resolves.toBe(true); // original account untouched
  });
});

describe("tenant scoping — explicit database per call", () => {
  it("the same email lives independently in two tenants' databases", async () => {
    const tenantB = await freshDb();
    try {
      const inA = await registerUser(db, {
        email: "shared@example.com",
        password: "tenant A's password!",
      });
      // Registering the same email in tenant B succeeds — no cross-tenant
      // uniqueness, because there is no cross-tenant table.
      const inB = await registerUser(tenantB.db, {
        email: "shared@example.com",
        password: "tenant B's password!",
      });
      expect(inB.id).not.toBe(inA.id);

      // Each tenant sees only its own credentials.
      const fromA = await getUserByEmail(db, "shared@example.com");
      const fromB = await getUserByEmail(tenantB.db, "shared@example.com");
      await expect(
        verifyPassword("tenant A's password!", fromA!.passwordHash),
      ).resolves.toBe(true);
      await expect(
        verifyPassword("tenant A's password!", fromB!.passwordHash),
      ).resolves.toBe(false);

      // And a user created only in A is invisible to B.
      await registerUser(db, {
        email: "only-in-a@example.com",
        password: "another fine password",
      });
      await expect(
        getUserByEmail(tenantB.db, "only-in-a@example.com"),
      ).resolves.toBeUndefined();
    } finally {
      tenantB.client.close();
    }
  });
});
