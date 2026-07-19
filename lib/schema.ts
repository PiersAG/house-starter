// Drizzle ORM schema for the house-starter template.
//
// Pure table definitions only — importing this module has NO side effects
// (it never opens a database connection or runs a migration at load time).
// Application code and the migration logic both import these definitions.

import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  primaryKey,
} from "drizzle-orm/sqlite-core";

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
  /**
   * When the subscription FIRST entered past_due — the anchor the paid-gate's
   * grace window is measured from (billing-gap-fill-spec §WP1.1). Set by the
   * invoice.payment_failed webhook, cleared when the subscription recovers.
   */
  pastDueAt: integer("past_due_at", { mode: "timestamp" }),
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

/**
 * Password-reset tokens. Only a HASH of the token is stored (never the raw
 * value — a database read must not yield a usable reset link). Single-use
 * (`usedAt` set on consumption) and expiring (`expiresAt`). See
 * lib/password-reset.ts.
 */
export const passwordResetTokens = sqliteTable("password_reset_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  /** SHA-256 hash of the raw token; the raw token is emailed, never stored. */
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  usedAt: integer("used_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

/**
 * Settings registry — the catalogue of every configurable behaviour in the
 * factory (settings-registry-spec §3). Shipped with house-starter and seeded
 * from the per-capability `settings.ts` declarations (lib/settings/*). One row
 * per setting key. This is the "what exists / how it defaults" half; per-tenant
 * chosen values live in `settingValues`.
 *
 * SQLite adaptation of the spec's Postgres DDL (flagged): jsonb → TEXT (JSON
 * string), boolean → INTEGER (0/1). `enumValues`, `factoryDefault` and `bounds`
 * hold JSON text; `factoryDefault` is always present.
 */
export const settingDefinitions = sqliteTable("setting_definitions", {
  /** Dotted key, e.g. "booking.cancellation_cutoff_hours". */
  key: text("key").primaryKey(),
  /** 'core' | 'billing' | 'booking' | 'comms'. */
  capability: text("capability").notNull(),
  /** UI grouping within a capability, e.g. "Cancellations & refunds". */
  functionalGroup: text("functional_group").notNull(),
  label: text("label").notNull(),
  /** Plain-English effect of the setting. */
  description: text("description").notNull(),
  /** boolean | integer | decimal | text | enum | duration_hours | json. */
  valueType: text("value_type").notNull(),
  /** JSON array of allowed strings, when valueType = 'enum'. */
  enumValues: text("enum_values"),
  /** JSON-encoded factory default. Always present. */
  factoryDefault: text("factory_default").notNull(),
  /** JSON {"min":n,"max":n} for numeric types; null = free. */
  bounds: text("bounds"),
  /** 0/1 — false locks the setting to the factory default. */
  ownerEditable: integer("owner_editable", { mode: "boolean" })
    .notNull()
    .default(true),
  /** 0/1 — true means a per-client preference may override the owner value. */
  clientScoped: integer("client_scoped", { mode: "boolean" })
    .notNull()
    .default(false),
  /** Capability feature flag; the UI hides the row when the flag is off. */
  requiresFlag: text("requires_flag"),
});

/**
 * Per-tenant chosen values (settings-registry-spec §3). Absence at a level
 * falls through to the level above; the resolver never copies a value down.
 *
 * SQLite adaptation of the spec's `PRIMARY KEY (key, scope, COALESCE(client_id,
 * sentinel))` (flagged): SQLite treats NULLs in a composite primary key as
 * distinct, so the COALESCE sentinel is materialised as a NOT NULL column with
 * a '' default — owner rows carry client_id = '' and the plain composite PK
 * (key, scope, client_id) enforces one row per (key, scope, client).
 */
export const settingValues = sqliteTable(
  "setting_values",
  {
    key: text("key")
      .notNull()
      .references(() => settingDefinitions.key),
    /** 'owner' | 'client'. */
    scope: text("scope").notNull(),
    /** '' for owner scope; the client id for client scope (sentinel, not NULL). */
    clientId: text("client_id").notNull().default(""),
    /** JSON-encoded chosen value. */
    value: text("value").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [primaryKey({ columns: [table.key, table.scope, table.clientId] })],
);

export type SettingDefinitionRow = typeof settingDefinitions.$inferSelect;
export type NewSettingDefinitionRow = typeof settingDefinitions.$inferInsert;

export type SettingValueRow = typeof settingValues.$inferSelect;
export type NewSettingValueRow = typeof settingValues.$inferInsert;

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type RevokedSession = typeof revokedSessions.$inferSelect;
export type NewRevokedSession = typeof revokedSessions.$inferInsert;

export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;

export type StripeEvent = typeof stripeEvents.$inferSelect;
export type NewStripeEvent = typeof stripeEvents.$inferInsert;

export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type NewPasswordResetToken = typeof passwordResetTokens.$inferInsert;
