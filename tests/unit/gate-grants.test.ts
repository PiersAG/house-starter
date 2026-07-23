import { beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import { createMigrationDatabase, runMigrations } from "@/lib/migrate";
import { createUser, type AppDatabase } from "@/lib/users";
import { requireActiveSubscription } from "@/lib/billing/gate";
import { grantAccess } from "@/lib/billing/grants";

const DAY_MS = 86_400_000;
let db: AppDatabase;

beforeEach(async () => {
  const c = createMigrationDatabase(":memory:");
  await runMigrations(c);
  db = drizzle(c) as AppDatabase;
});

async function user(email = "u@example.com"): Promise<string> {
  return (await createUser(db, { email, passwordHash: "hash" })).id;
}

describe("paywall gate honours access grants (single audited path)", () => {
  it("a granted account with NO subscription reaches gated routes", async () => {
    const uid = await user();
    await grantAccess(db, { userId: uid, type: "owner", expiresAt: null });
    const r = await requireActiveSubscription(db, uid);
    expect(r.allowed).toBe(true);
  });

  it("an EXPIRED grant is blocked — same 402 as a lapsed subscription", async () => {
    const uid = await user();
    const now = new Date("2026-07-23T00:00:00Z");
    await grantAccess(db, { userId: uid, type: "tester", expiresAt: new Date(now.getTime() - DAY_MS) });
    const r = await requireActiveSubscription(db, uid, { now });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.status).toBe(402);
  });

  it("a non-granted account with no subscription is unchanged (402)", async () => {
    const uid = await user();
    const r = await requireActiveSubscription(db, uid);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.status).toBe(402);
  });

  it("a freshly created account has no grant — access is not implicitly minted", async () => {
    const uid = await user("fresh@example.com");
    const r = await requireActiveSubscription(db, uid);
    expect(r.allowed).toBe(false);
  });
});
