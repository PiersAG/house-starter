// Drizzle ORM schema for the house-starter template.
//
// Pure table definitions only — importing this module has NO side effects
// (it never opens a database connection or runs a migration at load time).
// Application code and the migration logic both import these definitions.

import { sql } from "drizzle-orm";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * Passwords are never stored in plain text — only an Argon2id/bcrypt hash.
 */
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

/**
 * Server-side session revocation records (CEO ruling 2026-07-15).
 * Keyed by `jti` (JWT session ID). Checked ONLY at token renewal time —
 * never on every request — so the DB cost is bounded to one check per
 * RENEW_AFTER_SECONDS window, not per page load. See lib/revoked-sessions.ts.
 */
export const revokedSessions = sqliteTable("revoked_sessions", {
  id: text("id").primaryKey(),
  /** The JWT session identifier set at sign-in. */
  jti: text("jti").notNull().unique(),
  /** The user who owned this session. */
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  revokedAt: integer("revoked_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

/**
 * Billing subscription state, one row per user (userId is unique). Written by
 * the Stripe webhook (app/api/billing/webhook) and read by the paid-gate
 * (lib/billing/gate.ts). `status` mirrors the Stripe subscription status
 * ("active", "trialing", "past_due", "canceled", ...). `trialEndsAt` lets the
 * gate honour a trial independently of a live Stripe subscription. See
 * lib/billing/subscriptions.ts.
 */
export const subscriptions = sqliteTable("subscriptions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  /** Stripe subscription status, stored verbatim. */
  status: text("status").notNull(),
  priceId: text("price_id"),
  currentPeriodEnd: integer("current_period_end", { mode: "timestamp" }),
  trialEndsAt: integer("trial_ends_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

/**
 * Processed Stripe webhook event ids — the idempotency ledger. The webhook
 * inserts an id after handling an event and skips any event whose id is already
 * present, so Stripe's at-least-once delivery never double-applies. `id` is the
 * Stripe event id (evt_...).
 */
export const stripeEvents = sqliteTable("stripe_events", {
  id: text("id").primaryKey(),
  processedAt: integer("processed_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type RevokedSession = typeof revokedSessions.$inferSelect;
export type NewRevokedSession = typeof revokedSessions.$inferInsert;

export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;

export type StripeEvent = typeof stripeEvents.$inferSelect;
export type NewStripeEvent = typeof stripeEvents.$inferInsert;
