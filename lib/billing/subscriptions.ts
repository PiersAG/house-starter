// Subscription repository for the house-starter template.
//
// Follows the dependency-injection pattern of lib/users.ts: every function
// takes the Drizzle database as an explicit argument, so the webhook handler
// and the paid-gate can be unit-tested against an in-memory database without
// importing the live singleton in lib/db.ts.

import { eq } from "drizzle-orm";
import { subscriptions, type NewSubscription, type Subscription } from "@/lib/schema";
import type { AppDatabase } from "@/lib/users";

/** Look up a user's subscription. Returns undefined when the user has none. */
export async function getSubscriptionByUserId(
  db: AppDatabase,
  userId: string,
): Promise<Subscription | undefined> {
  const rows = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .limit(1)
    .all();
  return rows[0];
}

/** Look up a subscription by its Stripe customer id. */
export async function getSubscriptionByStripeCustomerId(
  db: AppDatabase,
  stripeCustomerId: string,
): Promise<Subscription | undefined> {
  const rows = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.stripeCustomerId, stripeCustomerId))
    .limit(1)
    .all();
  return rows[0];
}

export interface UpsertSubscriptionInput {
  userId: string;
  status: string;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  priceId?: string | null;
  currentPeriodEnd?: Date | null;
  trialEndsAt?: Date | null;
  /** Grace-window anchor: when the subscription first went past_due. */
  pastDueAt?: Date | null;
}

/**
 * Create or update a user's subscription (userId is unique). On an existing
 * row only the fields explicitly provided are overwritten — an event that
 * doesn't carry, say, the price id leaves the stored one intact. `updatedAt`
 * is always refreshed. Returns the persisted row.
 */
export async function upsertSubscriptionByUserId(
  db: AppDatabase,
  input: UpsertSubscriptionInput,
): Promise<Subscription> {
  const set: Partial<NewSubscription> = { status: input.status, updatedAt: new Date() };
  if (input.stripeCustomerId !== undefined) set.stripeCustomerId = input.stripeCustomerId;
  if (input.stripeSubscriptionId !== undefined)
    set.stripeSubscriptionId = input.stripeSubscriptionId;
  if (input.priceId !== undefined) set.priceId = input.priceId;
  if (input.currentPeriodEnd !== undefined) set.currentPeriodEnd = input.currentPeriodEnd;
  if (input.trialEndsAt !== undefined) set.trialEndsAt = input.trialEndsAt;
  if (input.pastDueAt !== undefined) set.pastDueAt = input.pastDueAt;

  const rows = await db
    .insert(subscriptions)
    .values({
      id: crypto.randomUUID(),
      userId: input.userId,
      status: input.status,
      stripeCustomerId: input.stripeCustomerId ?? null,
      stripeSubscriptionId: input.stripeSubscriptionId ?? null,
      priceId: input.priceId ?? null,
      currentPeriodEnd: input.currentPeriodEnd ?? null,
      trialEndsAt: input.trialEndsAt ?? null,
      pastDueAt: input.pastDueAt ?? null,
    })
    .onConflictDoUpdate({ target: subscriptions.userId, set })
    .returning()
    .all();
  return rows[0];
}

export interface SubscriptionPatch {
  status?: string;
  stripeSubscriptionId?: string | null;
  priceId?: string | null;
  currentPeriodEnd?: Date | null;
  trialEndsAt?: Date | null;
  /** Grace-window anchor; set on entry to past_due, null on recovery. */
  pastDueAt?: Date | null;
}

/**
 * Patch the subscription addressed by Stripe customer id (the key the
 * subscription-lifecycle and invoice webhooks carry). No-op if no row matches.
 * Returns the number of rows updated.
 */
export async function updateSubscriptionByStripeCustomerId(
  db: AppDatabase,
  stripeCustomerId: string,
  patch: SubscriptionPatch,
): Promise<number> {
  const result = await db
    .update(subscriptions)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(subscriptions.stripeCustomerId, stripeCustomerId))
    .run();
  return result.rowsAffected;
}
