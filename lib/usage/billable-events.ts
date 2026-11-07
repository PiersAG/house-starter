// The billable-action event table (app-business-core issue 808; Matt Murphy #258:
// "every billable action gets an event user acts performed action Y at time stamp Z
// store these events in a dedicated table").
//
// One row per action a customer performed: who, which action, how many, when. It is
// the one record that billing (credits or metered pricing, if an app ever charges per
// action) and analytics (what customers actually use) both read, so the two never
// disagree. It is written from the first day because past usage cannot be
// reconstructed later.
//
// Only the actions listed in config/billable-actions.ts are recorded; anything else
// is refused, so a typo cannot start a new count. A caller that may retry passes its
// own `eventId`: the same id is recorded once, so a retried request is not counted
// twice.
//
// The table is in the catalog, beside `users` and `subscriptions` (lib/catalog.ts):
// it is about the account, not the account's own data. Its retention and erasure are
// declared in config/personal-data.ts (billableEvents).
//
// DI pattern (like lib/billing/subscriptions.ts): every function takes the Drizzle db
// explicitly, so it unit-tests against an in-memory database.

import "server-only";

import { randomUUID } from "node:crypto";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { billableEvents } from "@/lib/schema";
import type { AppDatabase } from "@/lib/users";
import { BILLABLE_ACTIONS } from "@/config/billable-actions";

export interface BillableEventInput {
  userId: string;
  /** One of config/billable-actions.ts BILLABLE_ACTIONS. */
  action: string;
  /** How many units this one action counts for; a whole number from 1. Default 1. */
  quantity?: number;
  /** When it happened; default now. */
  at?: Date;
  /** The caller's own id for this event, so a retry is recorded once. Default random. */
  eventId?: string;
}

export class UnknownBillableAction extends Error {
  constructor(action: string) {
    super(`"${action}" is not a billable action (config/billable-actions.ts)`);
    this.name = "UnknownBillableAction";
  }
}

/**
 * Record one billable action. Returns true when it was recorded, false when an event
 * with the same `eventId` was already there (a retry). Throws on an action not in the
 * list, or a quantity that is not a whole number from 1.
 */
export async function recordBillableEvent(
  db: AppDatabase,
  input: BillableEventInput,
  actions: readonly string[] = BILLABLE_ACTIONS,
): Promise<boolean> {
  if (!actions.includes(input.action)) throw new UnknownBillableAction(input.action);
  const quantity = input.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new RangeError(`quantity must be a whole number from 1, got ${quantity}`);
  }
  const result = await db
    .insert(billableEvents)
    .values({
      id: input.eventId ?? randomUUID(),
      userId: input.userId,
      action: input.action,
      quantity,
      occurredAt: input.at ?? new Date(),
    })
    .onConflictDoNothing({ target: billableEvents.id })
    .run();
  return result.rowsAffected === 1;
}

/** The units of `action` an account used from `since` (inclusive) to `until` (exclusive). */
export async function countBillableUnits(
  db: AppDatabase,
  userId: string,
  action: string,
  since: Date,
  until: Date,
): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`coalesce(sum(${billableEvents.quantity}), 0)` })
    .from(billableEvents)
    .where(
      and(
        eq(billableEvents.userId, userId),
        eq(billableEvents.action, action),
        gte(billableEvents.occurredAt, since),
        lt(billableEvents.occurredAt, until),
      ),
    )
    .all();
  return Number(rows[0]?.total ?? 0);
}
