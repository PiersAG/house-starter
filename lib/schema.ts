// Drizzle ORM schema for the house-starter template.
//
// Pure table definitions only — importing this module has NO side effects
// (it never opens a database connection or runs a migration at load time).
// Application code and the migration logic both import these definitions.
//
// TWO DATABASES, ONE SCHEMA MODULE (ADR-023 per_tenant)
// -----------------------------------------------------
// The tables below are split across two databases at MIGRATION time
// (lib/migrate.ts owns the split; this module only declares shapes):
//
//   CATALOG / control plane — one shared database per app, CATALOG_DATABASE_URL.
//     tenants, users, revoked_sessions, subscriptions, stripe_events,
//     password_reset_tokens, access_grants, setting_definitions,
//     setting_values, error_events.
//     Everything needed to IDENTIFY and BILL a caller, and to route them to
//     their tenant, BEFORE any tenant database is opened. Queried through
//     `catalogDb` / `getCatalogDb()` in lib/catalog.ts.
//
//   TENANT / data plane — one database per tenant, URL held in `tenants`.
//     tenant_meta, plus every app-data table the builder adds.
//     Queried through `getDb(tenantId)` in lib/db.ts, with the tenant taken
//     from the session (lib/tenant-context.ts) and never from the caller.
//
// In TENANCY_MODE=shared the two collapse onto DATABASE_URL and every table
// lives in one database — the split is a routing fact, not a schema fork.

import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  primaryKey,
} from "drizzle-orm/sqlite-core";

/**
 * CATALOG. The tenant registry — the routing table login resolves against.
 *
 * One row per tenant (in this factory's product model, one per customer-owner:
 * the trainer, the instructor, the clinic). `dbUrl` is that tenant's OWN data
 * database, written by the provisioner at sign-up (lib/tenant/provisioner.ts).
 *
 * `dbUrl` is stored as an opaque libSQL URL and is NEVER parsed or branched on:
 * `file:/var/data/t_ab12.db` and `libsql://app-t_ab12-org.turso.io` take the
 * identical code path through lib/db.ts::getDb. That property is what lets the
 * isolation harness prove production's routing using two local files.
 *
 * `dbAuthToken` is the per-database credential a remote libSQL URL needs and a
 * `file:` URL ignores. It is a CREDENTIAL AT REST in this table — the catalog
 * database is therefore as sensitive as the tenant databases it points at.
 */
export const tenants = sqliteTable("tenants", {
  /** Tenant id — must match lib/db.ts's TENANT_ID_PATTERN, [A-Za-z0-9_]{1,64}. */
  id: text("id").primaryKey(),
  /** libSQL URL of this tenant's data database. Opaque; never parsed. */
  dbUrl: text("db_url").notNull(),
  /** Per-database auth token for remote URLs; null for `file:` URLs. */
  dbAuthToken: text("db_auth_token"),
  /** Which adapter created it — "file" | "turso". Diagnostics only. */
  provisioner: text("provisioner"),
  /** Human label (usually the owner's email) — for the CEO, not for routing. */
  label: text("label"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;

/**
 * CATALOG. Passwords are never stored in plain text — only an Argon2id/bcrypt hash.
 *
 * `tenantId` is the login→tenant mapping: authentication resolves it here and
 * puts it on the session, so no app-data query ever has to guess. Nullable in
 * DDL only because SQLite cannot ALTER TABLE ADD a NOT NULL column onto an
 * existing table; at runtime a per-tenant sign-in with a null tenantId fails
 * closed rather than falling back to any default database.
 */
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name"),
  /**
   * The tenant this account belongs to — FK to tenants.id. See above.
   *
   * Deliberately UNINDEXED: it is read from an already-fetched user row and is
   * never a query predicate. An index here would also have to be created in the
   * same DDL batch that adds the column, which SQLite cannot do on an existing
   * table — the schema-drift reconciler adds the column afterwards.
   */
  tenantId: text("tenant_id"),
  /**
   * The account's role WITHIN its tenant. Additive column with a constant
   * default, so lib/migrate.ts::reconcileColumns can add it to an existing
   * catalog (the mechanism built for subscriptions.past_due_at).
   *
   * Deliberately minimal. Today one account = one tenant, so this guards
   * nothing yet: it is the SEAM in place BEFORE sub-users exist, not a role
   * hierarchy. There is no permission matrix and no admin UI, and no value of
   * this column reaches operator/CEO controls — those live in
   * `operator_setting_values`, which no app route writes at all.
   */
  role: text("role").notNull().default("owner"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

/** The roles an account can hold inside its own tenant. */
export const USER_ROLES = ["owner"] as const;
export type UserRole = (typeof USER_ROLES)[number];

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
  /**
   * 0/1 — true means an OPERATOR/CEO control: absent from every settings screen
   * and refused by every app write path, settable only from the control plane
   * (see operatorSettingValues below).
   *
   * DESCRIPTIVE, NOT ENFORCING. Enforcement reads the code definition
   * (lib/settings/{resolver,validation,service}.ts), never this row — a
   * privilege boundary that could be lifted by an UPDATE on a table the app can
   * reach would not be one. This column exists so the catalogue table describes
   * the same world the code does.
   */
  operatorOnly: integer("operator_only", { mode: "boolean" })
    .notNull()
    .default(false),
});

/**
 * TENANT PLANE. Per-tenant chosen values (settings-registry-spec §3). Absence at
 * a level falls through to the level above; the resolver never copies a value
 * down.
 *
 * THIS TABLE LIVES IN THE TENANT DATABASE, not the catalog. That is what §3 of
 * the spec always said ("Schema (tenant DB + shared seed)", `-- Per-tenant
 * values`); the implementation put it in the catalog when the ADR-023 split
 * landed, presumably because `setting_definitions` had to be there for the
 * migration seed and the two tables travelled together. The consequence was a
 * table with no tenant column whose owner rows are `(key, 'owner', '')` — ONE
 * global row, written by whichever signed-in account asked last, read by every
 * tenant. Moving it here removes the class rather than patching it: there is no
 * tenant column to add and no `where tenant_id = ?` to forget, because another
 * customer's row is not filtered out, it is not in the database being queried.
 *
 * The `REFERENCES setting_definitions(key)` FK is GONE, and had to be: the
 * definitions catalogue stays in the catalog database, and a cross-database
 * foreign key fails on every insert under `PRAGMA foreign_keys = ON`. Unknown
 * keys are rejected by lib/settings/validation.ts before any write instead —
 * at the API layer, which is where the spec puts that check anyway.
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
    key: text("key").notNull(),
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

/**
 * CONTROL PLANE. Operator/CEO values — the settings that belong to whoever RUNS
 * the app, not to any customer of it: trial length, comp accounts, the app's own
 * name and outbound-mail identity.
 *
 * A SEPARATE TABLE rather than a third value of `setting_values.scope`, for two
 * reasons. The mechanical one: that column carries
 * `CHECK (scope IN ('owner','client'))`, and widening a CHECK in SQLite means a
 * full table rebuild, while a new table is a free `CREATE TABLE IF NOT EXISTS`.
 * The structural one matters more — `setting_values` now lives in the TENANT
 * database, and an operator value must not.
 *
 * Nothing in the app writes this table. It has no route, no server action and no
 * role that can reach it; the only writer is scripts/set-operator-setting.ts,
 * a standalone CLI modelled on scripts/grant-access.ts and never imported by the
 * app runtime. That is the point: the control is not EXPOSED to the app and then
 * guarded, it is absent from the app's request paths entirely, so there is no
 * privilege check standing between a customer and it that could be got wrong.
 */
export const operatorSettingValues = sqliteTable("operator_setting_values", {
  /** Dotted setting key. No FK: definitions are code, and this is one row per key. */
  key: text("key").primaryKey(),
  /** JSON-encoded chosen value, same encoding as setting_values. */
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type OperatorSettingValueRow = typeof operatorSettingValues.$inferSelect;
export type NewOperatorSettingValueRow = typeof operatorSettingValues.$inferInsert;

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

/**
 * Durable runtime error sink (la-a-uptime-monitoring §b). Written by
 * instrumentation.onRequestError and any handler that catches an error; read by
 * /api/health (error-rate signal) and the external prober. Persisted to the
 * app's own database so records survive past Vercel's ephemeral live-tail
 * window (the checkout-500 incident left no recoverable log after 16h).
 */
export const errorEvents = sqliteTable("error_events", {
  id: text("id").primaryKey(),
  occurredAt: integer("occurred_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  message: text("message").notNull(),
  stack: text("stack"),
  route: text("route"),
  method: text("method"),
  digest: text("digest"),
  context: text("context"),
});

export type ErrorEvent = typeof errorEvents.$inferSelect;
export type NewErrorEvent = typeof errorEvents.$inferInsert;

/**
 * Access grants (owner-account-paywall-exemption). The single audited path
 * around the subscription paywall: an account with a LIVE grant reaches gated
 * routes exactly as an active subscriber does (lib/billing/gate.ts). One grant
 * per account (userId unique). Set EXPLICITLY by the CEO only (never at signup,
 * never env/pattern-matched). `type` ∈ owner|tester|comp; `expiresAt` null =
 * never expires; an expired grant confers no access, same as a lapsed sub.
 */
export const accessGrants = sqliteTable("access_grants", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id),
  type: text("type").notNull(),
  note: text("note"),
  grantedBy: text("granted_by"),
  grantedAt: integer("granted_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  expiresAt: integer("expires_at", { mode: "timestamp" }),
});

export type AccessGrant = typeof accessGrants.$inferSelect;
export type NewAccessGrant = typeof accessGrants.$inferInsert;

/**
 * TENANT DATA PLANE. The one row a tenant database carries about itself.
 *
 * Written by the provisioner immediately after a tenant database is migrated,
 * so a database that exists but was never provisioned is distinguishable from
 * one that was. It is the template's only app-data table: house-starter ships
 * no domain model, and without a single real tenant-side table the per-tenant
 * isolation attack would have nothing to plant a sentinel in and nothing to
 * read back over HTTP. A builder adding `dogs`, `clients` or `sessions` adds
 * them alongside this one and they are attacked the same way.
 *
 * It deliberately lives in the TENANT database and not the catalog: `label` is
 * the workspace's own name, and reading it is the shortest honest path that
 * exercises getDb(tenantId) end to end.
 */
export const tenantMeta = sqliteTable("tenant_meta", {
  id: text("id").primaryKey(),
  /** The tenant this database belongs to. Matches tenants.id in the catalog. */
  tenantId: text("tenant_id").notNull().unique(),
  /** Workspace display name. */
  label: text("label"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type TenantMeta = typeof tenantMeta.$inferSelect;
export type NewTenantMeta = typeof tenantMeta.$inferInsert;
