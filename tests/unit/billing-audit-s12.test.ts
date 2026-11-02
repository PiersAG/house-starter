// @vitest-environment node
//
// #796: plan changes and permission (access-grant) changes are in the audit
// trail — Matt Murphy #126, "users upgrading plans … modifying permissions none
// of it is logged". Applied with the money-path edits by the dispatch AC CEO
// script (the safety gate keeps Claude Code out of lib/billing).

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "@/lib/migrate";
import {
  updateSubscriptionByStripeCustomerId,
  upsertSubscriptionByUserId,
} from "@/lib/billing/subscriptions";
import { grantAccess, revokeGrant } from "@/lib/billing/grants";
import { createUser, type AppDatabase } from "@/lib/users";

let raw: ReturnType<typeof createClient>;
let db: AppDatabase;

beforeEach(async () => {
  raw = createClient({ url: ":memory:" });
  await runMigrations(raw);
  db = drizzle(raw) as AppDatabase;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

async function audit(action: string): Promise<Record<string, unknown>[]> {
  const res = await raw.execute({
    sql: "SELECT * FROM audit_events WHERE action = ? ORDER BY occurred_at, rowid",
    args: [action],
  });
  return res.rows as unknown as Record<string, unknown>[];
}

describe("plan changes are audited (#796)", () => {
  it("a new subscription, an upgrade and a status change each write one row with before and after", async () => {
    const u = await createUser(db, { email: "plan@example.com", passwordHash: "x" } as never);
    await upsertSubscriptionByUserId(db, {
      userId: u.id,
      status: "trialing",
      stripeCustomerId: "cus_plan",
      priceId: "price_basic",
    });
    await upsertSubscriptionByUserId(db, { userId: u.id, status: "active", priceId: "price_pro" });
    await updateSubscriptionByStripeCustomerId(db, "cus_plan", { status: "past_due" });
    const rows = await audit("plan_changed");
    expect(rows.map((r) => [r.before && JSON.parse(String(r.before)), JSON.parse(String(r.after))])).toEqual([
      [null, { status: "trialing", priceId: "price_basic" }],
      [{ status: "trialing", priceId: "price_basic" }, { status: "active", priceId: "price_pro" }],
      [{ status: "active", priceId: "price_pro" }, { status: "past_due", priceId: "price_pro" }],
    ]);
    expect(rows.every((r) => r.subject_user_id === u.id && r.actor === "system" && r.target === "subscription")).toBe(true);
  });

  it("a write that changes neither plan nor status writes no row", async () => {
    const u = await createUser(db, { email: "same@example.com", passwordHash: "x" } as never);
    await upsertSubscriptionByUserId(db, { userId: u.id, status: "active", stripeCustomerId: "cus_same", priceId: "p" });
    await upsertSubscriptionByUserId(db, { userId: u.id, status: "active", currentPeriodEnd: new Date() });
    await updateSubscriptionByStripeCustomerId(db, "cus_same", { currentPeriodEnd: new Date() });
    await updateSubscriptionByStripeCustomerId(db, "cus_none", { status: "canceled" });
    expect(await audit("plan_changed")).toHaveLength(1);
  });
});

describe("access-grant changes are audited as permissions_changed (#796)", () => {
  it("grant, change and revoke each write a row naming who did it", async () => {
    const u = await createUser(db, { email: "grant@example.com", passwordHash: "x" } as never);
    await grantAccess(db, { userId: u.id, type: "tester", grantedBy: "ceo@example.com" });
    await grantAccess(db, { userId: u.id, type: "comp" });
    await revokeGrant(db, u.id);
    await revokeGrant(db, u.id); // nothing to revoke → no row
    const rows = await audit("permissions_changed");
    expect(rows.map((r) => [r.actor, r.before && JSON.parse(String(r.before)).type, r.after && JSON.parse(String(r.after)).type])).toEqual([
      ["ceo@example.com", null, "tester"],
      ["operator", "tester", "comp"],
      ["operator", "comp", null],
    ]);
    expect(rows.every((r) => r.subject_user_id === u.id && r.target === "grant")).toBe(true);
  });
});
