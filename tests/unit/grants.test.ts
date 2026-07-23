import { beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import { createMigrationDatabase, runMigrations } from "@/lib/migrate";
import { createUser, type AppDatabase } from "@/lib/users";
import {
  grantAccess,
  revokeGrant,
  getGrantByUserId,
  hasLiveGrant,
  listLiveGrants,
} from "@/lib/billing/grants";

const DAY_MS = 86_400_000;
let db: AppDatabase;

beforeEach(async () => {
  const c = createMigrationDatabase(":memory:");
  await runMigrations(c);
  db = drizzle(c) as AppDatabase;
});

async function user(email: string): Promise<string> {
  return (await createUser(db, { email, passwordHash: "hash" })).id;
}

describe("access grants", () => {
  it("a fresh account has no grant — grants are never implicit", async () => {
    const uid = await user("a@example.com");
    expect(await getGrantByUserId(db, uid)).toBeUndefined();
    expect(await hasLiveGrant(db, uid)).toBe(false);
  });

  it("grants and reads back a never-expiring owner grant", async () => {
    const uid = await user("owner@example.com");
    const g = await grantAccess(db, {
      userId: uid,
      type: "owner",
      note: "creator",
      grantedBy: "ceo",
      expiresAt: null,
    });
    expect(g.type).toBe("owner");
    expect(g.expiresAt).toBeNull();
    expect(g.note).toBe("creator");
    expect(await hasLiveGrant(db, uid)).toBe(true);
  });

  it("a future expiry is live; a past expiry is not (upsert replaces)", async () => {
    const uid = await user("tester@example.com");
    const now = new Date("2026-07-23T00:00:00Z");
    await grantAccess(db, { userId: uid, type: "tester", expiresAt: new Date(now.getTime() + DAY_MS) });
    expect(await hasLiveGrant(db, uid, now)).toBe(true);
    // Re-grant with a past expiry — one grant per account, so this replaces it.
    await grantAccess(db, { userId: uid, type: "tester", expiresAt: new Date(now.getTime() - DAY_MS) });
    expect(await hasLiveGrant(db, uid, now)).toBe(false);
  });

  it("rejects an unknown grant type so a typo cannot mint access", async () => {
    const uid = await user("b@example.com");
    await expect(
      // @ts-expect-error deliberately invalid type
      grantAccess(db, { userId: uid, type: "vip" }),
    ).rejects.toThrow(/unknown grant type/);
    expect(await getGrantByUserId(db, uid)).toBeUndefined();
  });

  it("listLiveGrants answers who has access without paying, excluding expired", async () => {
    const now = new Date("2026-07-23T00:00:00Z");
    const live = await user("live@example.com");
    const dead = await user("dead@example.com");
    await grantAccess(db, { userId: live, type: "comp", note: "press", expiresAt: null });
    await grantAccess(db, { userId: dead, type: "tester", expiresAt: new Date(now.getTime() - DAY_MS) });
    const rows = await listLiveGrants(db, now);
    expect(rows.map((g) => g.userId)).toEqual([live]);
    expect(rows[0].note).toBe("press");
  });

  it("revoke removes access", async () => {
    const uid = await user("c@example.com");
    await grantAccess(db, { userId: uid, type: "owner" });
    expect(await hasLiveGrant(db, uid)).toBe(true);
    await revokeGrant(db, uid);
    expect(await hasLiveGrant(db, uid)).toBe(false);
  });
});
