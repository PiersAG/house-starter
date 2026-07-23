import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import { createMigrationDatabase, runMigrations } from "@/lib/migrate";
import { createUser, getUserByEmail, type AppDatabase } from "@/lib/users";
import { hashPassword, verifyPassword } from "@/lib/password";
import { seedOwnerAccount, NO_USABLE_PASSWORD } from "@/lib/owner-seed";
import { hasLiveGrant, getGrantByUserId } from "@/lib/billing/grants";

const EMAIL = "owner@factory.example";
let db: AppDatabase;

async function freshDb(): Promise<AppDatabase> {
  const c = createMigrationDatabase(":memory:");
  // runMigrations runs with OWNER_EMAIL unset here (afterEach clears it), so it
  // does not pre-seed — each test drives seedOwnerAccount explicitly.
  await runMigrations(c);
  return drizzle(c) as AppDatabase;
}

beforeEach(async () => {
  delete process.env.OWNER_EMAIL;
  db = await freshDb();
});

afterEach(() => {
  delete process.env.OWNER_EMAIL;
});

describe("v0 owner-account seed", () => {
  it("fresh DB: creates the owner account (no usable password) + never-expiring owner grant", async () => {
    const r = await seedOwnerAccount(db, EMAIL);
    expect(r.action).toBe("created");

    const u = await getUserByEmail(db, EMAIL);
    expect(u).toBeDefined();
    // No usable password — no input authenticates.
    expect(u!.passwordHash).toBe(NO_USABLE_PASSWORD);
    expect(await verifyPassword("anything", u!.passwordHash)).toBe(false);
    expect(await verifyPassword("", u!.passwordHash)).toBe(false);

    // Owner grant, never expires.
    const g = await getGrantByUserId(db, u!.id);
    expect(g!.type).toBe("owner");
    expect(g!.expiresAt).toBeNull();
    expect(await hasLiveGrant(db, u!.id)).toBe(true);
  });

  it("second boot is a no-op — no duplicate account, same grant", async () => {
    await seedOwnerAccount(db, EMAIL);
    const uid = (await getUserByEmail(db, EMAIL))!.id;
    const g1 = await getGrantByUserId(db, uid);

    const r2 = await seedOwnerAccount(db, EMAIL);
    expect(r2.action).toBe("noop-exists");
    expect(r2.userId).toBe(uid);
    const g2 = await getGrantByUserId(db, (await getUserByEmail(db, EMAIL))!.id);
    expect(g2!.id).toBe(g1!.id);
  });

  it("existing account is untouched — a password already set is not reset, and no grant is added", async () => {
    const realHash = await hashPassword("s3cret-real-pw");
    await createUser(db, { email: EMAIL, passwordHash: realHash });

    const r = await seedOwnerAccount(db, EMAIL);
    expect(r.action).toBe("noop-exists");

    const u = await getUserByEmail(db, EMAIL);
    expect(u!.passwordHash).toBe(realHash); // never reset
    expect(await verifyPassword("s3cret-real-pw", u!.passwordHash)).toBe(true);
    expect(await getGrantByUserId(db, u!.id)).toBeUndefined(); // pre-existing account gets no grant
  });

  it("no OWNER_EMAIL is a safe no-op", async () => {
    expect((await seedOwnerAccount(db, undefined)).action).toBe("noop-no-email");
    expect((await seedOwnerAccount(db, "   ")).action).toBe("noop-no-email");
  });

  it("runMigrations seeds when OWNER_EMAIL is set — the boot/migration hook fires", async () => {
    process.env.OWNER_EMAIL = "hooked@factory.example";
    const c = createMigrationDatabase(":memory:");
    await runMigrations(c);
    const hookedDb = drizzle(c) as AppDatabase;

    const u = await getUserByEmail(hookedDb, "hooked@factory.example");
    expect(u).toBeDefined();
    expect(u!.passwordHash).toBe(NO_USABLE_PASSWORD);
    expect(await hasLiveGrant(hookedDb, u!.id)).toBe(true);
  });
});
