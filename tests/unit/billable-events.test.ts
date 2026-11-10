// The billable-action event table (app-business-core issue 808). Matt Murphy #258:
// "every billable action gets an event user acts performed action Y at time stamp Z
// store these events in a dedicated table".

import { beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import { createMigrationDatabase, runMigrations } from "@/lib/migrate";
import { createUser, type AppDatabase } from "@/lib/users";
import { billableEvents } from "@/lib/schema";
import {
  countBillableUnits,
  recordBillableEvent,
  UnknownBillableAction,
} from "@/lib/usage/billable-events";
import { BILLABLE_ACTIONS } from "@/config/billable-actions";
import { PERSONAL_DATA_MAP } from "@/config/personal-data";

const ACTIONS = ["report.generated", "client.invited"] as const;
let db: AppDatabase;
let client: ReturnType<typeof createMigrationDatabase>;

beforeEach(async () => {
  client = createMigrationDatabase(":memory:");
  await runMigrations(client);
  db = drizzle(client) as AppDatabase;
});

async function user(email: string): Promise<string> {
  return (await createUser(db, { email, passwordHash: "hash" })).id;
}

describe("billable events", () => {
  it("records user X performed action Y at time Z, in a dedicated table", async () => {
    const uid = await user("a@example.com");
    const at = new Date("2026-11-07T09:00:00Z");
    expect(await recordBillableEvent(db, { userId: uid, action: "report.generated", at }, ACTIONS)).toBe(true);
    const rows = await db.select().from(billableEvents).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: uid, action: "report.generated", quantity: 1, occurredAt: at });
    const cols = await client.execute("PRAGMA table_info(billable_events);");
    expect(cols.rows.map((r) => String((r as Record<string, unknown>).name))).toEqual([
      "id",
      "user_id",
      "action",
      "quantity",
      "occurred_at",
    ]);
  });

  it("refuses an action that is not in the list, and a bad quantity", async () => {
    const uid = await user("b@example.com");
    await expect(recordBillableEvent(db, { userId: uid, action: "report.generatd" }, ACTIONS)).rejects.toThrow(
      UnknownBillableAction,
    );
    for (const quantity of [0, -1, 1.5]) {
      await expect(
        recordBillableEvent(db, { userId: uid, action: "report.generated", quantity }, ACTIONS),
      ).rejects.toThrow(RangeError);
    }
    expect(await db.select().from(billableEvents).all()).toHaveLength(0);
  });

  it("records a retried event once", async () => {
    const uid = await user("c@example.com");
    const input = { userId: uid, action: "client.invited", eventId: "req-42" };
    expect(await recordBillableEvent(db, input, ACTIONS)).toBe(true);
    expect(await recordBillableEvent(db, input, ACTIONS)).toBe(false);
    expect(await db.select().from(billableEvents).all()).toHaveLength(1);
  });

  it("counts an account's units of one action in a period", async () => {
    const a = await user("d@example.com");
    const b = await user("e@example.com");
    const day = (d: number) => new Date(Date.UTC(2026, 10, d));
    await recordBillableEvent(db, { userId: a, action: "report.generated", quantity: 3, at: day(1) }, ACTIONS);
    await recordBillableEvent(db, { userId: a, action: "report.generated", at: day(15) }, ACTIONS);
    await recordBillableEvent(db, { userId: a, action: "report.generated", at: day(30) }, ACTIONS);
    await recordBillableEvent(db, { userId: a, action: "client.invited", at: day(15) }, ACTIONS);
    await recordBillableEvent(db, { userId: b, action: "report.generated", at: day(15) }, ACTIONS);
    expect(await countBillableUnits(db, a, "report.generated", day(1), day(30))).toBe(4);
    expect(await countBillableUnits(db, b, "client.invited", day(1), day(30))).toBe(0);
  });

  it("the template counts nothing until a per-app build lists its actions", async () => {
    expect(BILLABLE_ACTIONS).toEqual([]);
    const uid = await user("f@example.com");
    await expect(recordBillableEvent(db, { userId: uid, action: "anything" })).rejects.toThrow(UnknownBillableAction);
  });

  it("is declared as personal data, kept 2 years and deleted with the account", () => {
    const entry = PERSONAL_DATA_MAP.billableEvents;
    expect(entry.plane).toBe("catalog");
    expect(entry.linkedBy).toBe("userId");
    expect(entry.ageLimitDays).toBe(730);
    expect(entry.onErasure).toEqual({ rule: "delete" });
  });
});
