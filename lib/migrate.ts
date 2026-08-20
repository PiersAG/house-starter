// Migration logic for the house-starter template.
//
// This module is COVERED by unit tests. None of the code below runs at module
// load time — `runMigrations` / `migrate` must be called explicitly. The
// standalone CLI entry point (scripts/migrate.ts) is a thin, logic-free wrapper
// that simply imports and calls `migrate()`.
//
// Driver: libSQL (@libsql/client). Same SQLite SQL dialect as before; the
// client is async and works identically against a local file (file:local.db)
// or a remote libSQL/Turso URL — the only difference between dev and prod is
// the DATABASE_URL value.
//
// TWO ROLES, ONE MIGRATION PATH (ADR-023 per_tenant)
// --------------------------------------------------
// The DDL is split by the database a table belongs to:
//
//   CATALOG_MIGRATION_SQL — the control plane. Identity, sessions, billing and
//     the tenant registry: everything needed to authenticate and bill a caller
//     BEFORE a tenant database is opened. Applied to CATALOG_DATABASE_URL.
//
//   TENANT_MIGRATION_SQL — the data plane. One tenant's own rows. Applied to
//     each tenant database by the provisioner at sign-up, and to every existing
//     tenant by scripts/migrate-all-tenants.ts.
//
//   MIGRATION_SQL — both, concatenated. This is what `migrate()` applies by
//     default, so shared-mode apps (one database holding everything) and the
//     preview single-database deploy keep working unchanged.
//
// There is still exactly ONE migration mechanism; `role` only selects which
// half of the same idempotent DDL runs.

import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { seedSettingDefinitions } from "@/lib/settings/seed";
import { seedOwnerAccount } from "@/lib/owner-seed";
import type { AppDatabase } from "@/lib/users";

/**
 * Idempotent DDL for the CATALOG (control-plane) database. Kept in sync with
 * lib/schema.ts. `IF NOT EXISTS` makes re-running a no-op.
 *
 * `tenants` comes first: it is the routing table every sign-in resolves against,
 * and `users.tenant_id` is the mapping from a credential to a database.
 */
export const CATALOG_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY NOT NULL,
  db_url TEXT NOT NULL,
  db_auth_token TEXT,
  provisioner TEXT,
  label TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT,
  tenant_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS revoked_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  jti TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id),
  revoked_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS revoked_sessions_jti_idx ON revoked_sessions(jti);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  status TEXT NOT NULL,
  price_id TEXT,
  current_period_end INTEGER,
  trial_ends_at INTEGER,
  past_due_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS subscriptions_customer_idx ON subscriptions(stripe_customer_id);

CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY NOT NULL,
  processed_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx ON password_reset_tokens(user_id);

CREATE TABLE IF NOT EXISTS setting_definitions (
  key TEXT PRIMARY KEY NOT NULL,
  capability TEXT NOT NULL,
  functional_group TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT NOT NULL,
  value_type TEXT NOT NULL CHECK (value_type IN ('boolean','integer','decimal','text','enum','duration_hours','json')),
  enum_values TEXT,
  factory_default TEXT NOT NULL,
  bounds TEXT,
  owner_editable INTEGER NOT NULL DEFAULT 1,
  client_scoped INTEGER NOT NULL DEFAULT 0,
  requires_flag TEXT
);

CREATE INDEX IF NOT EXISTS setting_definitions_capability_idx ON setting_definitions(capability);

CREATE TABLE IF NOT EXISTS setting_values (
  key TEXT NOT NULL REFERENCES setting_definitions(key),
  scope TEXT NOT NULL CHECK (scope IN ('owner','client')),
  client_id TEXT NOT NULL DEFAULT '',
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (key, scope, client_id)
);

CREATE TABLE IF NOT EXISTS error_events (
  id TEXT PRIMARY KEY NOT NULL,
  occurred_at INTEGER NOT NULL DEFAULT (unixepoch()),
  message TEXT NOT NULL,
  stack TEXT,
  route TEXT,
  method TEXT,
  digest TEXT,
  context TEXT
);

CREATE INDEX IF NOT EXISTS error_events_occurred_idx ON error_events(occurred_at);

CREATE TABLE IF NOT EXISTS access_grants (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('owner','tester','comp')),
  note TEXT,
  granted_by TEXT,
  granted_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER
);
`;

/**
 * Idempotent DDL for a TENANT (data-plane) database — one customer's own rows.
 *
 * `tenant_meta` is the template's only app-data table. A builder adding a domain
 * model (dogs, clients, sessions) adds those CREATE TABLE statements here, and
 * they land in every tenant database through the same provisioner and the same
 * fan-out, with no second migration mechanism.
 *
 * Nothing in here references a catalog table: a tenant database must be
 * migratable and queryable knowing only its own URL.
 */
export const TENANT_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS tenant_meta (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL UNIQUE,
  label TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
`;

/**
 * Both halves. What `migrate()` applies by default, so a shared-mode app (one
 * database holding everything) and the single-database preview deploy are
 * unaffected by the split.
 */
export const MIGRATION_SQL = CATALOG_MIGRATION_SQL + TENANT_MIGRATION_SQL;

/**
 * Resolve a libSQL connection URL. Defaults to an in-memory database when no
 * URL is supplied, which keeps the CLI runnable in any environment. A bare
 * filesystem path is normalised to a `file:` URL (libSQL requires the scheme).
 */
function resolveUrl(url?: string): string {
  const value = url && url.length > 0 ? url : ":memory:";
  if (value === ":memory:") return value;
  // Already a scheme (file:, libsql:, http:, https:, ws:, wss:) — pass through.
  if (/^[a-z]+:/i.test(value)) return value;
  return `file:${value}`;
}

/**
 * Open a libSQL client. Defaults to in-memory when no URL is supplied. When
 * a Turso remote URL is given, `authToken` is required — libSQL will not
 * accept anonymous connections against a remote database. The token is
 * ignored for `:memory:` and `file:` URLs, so the existing local paths keep
 * working unchanged.
 */
export function createMigrationDatabase(url?: string, authToken?: string): Client {
  const client = createClient({ url: resolveUrl(url), authToken });
  return client;
}

/**
 * Split a CREATE TABLE body into its top-level entries (column definitions and
 * table-level constraints), respecting parentheses so `CHECK (a IN (...))` and
 * `PRIMARY KEY (a, b)` are not split on their inner commas.
 */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/**
 * The column definitions declared per table in `MIGRATION_SQL` — the single
 * source of truth. Parsed (not hand-listed) so the reconciler below can never
 * drift from the schema: a column added to a CREATE TABLE is picked up here
 * automatically. Table-level constraints (PRIMARY KEY(...), UNIQUE(...), etc.)
 * are skipped — only real columns are returned, as { name, def }.
 */
function declaredColumns(sql: string): Map<string, { name: string; def: string }[]> {
  const tables = new Map<string, { name: string; def: string }[]>();
  const re = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\)\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const [, table, body] = m;
    const cols: { name: string; def: string }[] = [];
    for (const raw of splitTopLevel(body)) {
      const line = raw.trim();
      if (!line) continue;
      if (/^(PRIMARY KEY|FOREIGN KEY|UNIQUE|CHECK|CONSTRAINT)\b/i.test(line)) continue;
      const name = line.split(/\s+/)[0].replace(/["'`]/g, "");
      const def = line.slice(name.length).trim();
      cols.push({ name, def });
    }
    tables.set(table, cols);
  }
  return tables;
}

/**
 * Additive schema reconciliation. `CREATE TABLE IF NOT EXISTS` builds a FRESH
 * database to the full current schema, but it does NOTHING to a table that
 * already exists — so a column added to the schema after a persistent DB was
 * first created (e.g. `subscriptions.past_due_at`, added in WP1) never reaches
 * that DB, and any query selecting it crashes at runtime. This closes that gap:
 * for every table that already exists, add any column the schema declares but
 * the table is missing, via `ALTER TABLE ... ADD COLUMN`.
 *
 * Scope + limits (SQLite `ADD COLUMN`): additive columns are the realistic case
 * and are nullable or carry a constant default — always addable. A column that
 * SQLite cannot add this way (NOT NULL without a constant default, PRIMARY KEY,
 * UNIQUE) can only ever be an INITIAL column and so is never missing from an
 * existing table; if one somehow is, the ALTER throws — a loud failure is
 * correct, and strictly better than the silent drift that caused digest 456544406.
 */
async function reconcileColumns(client: Client, sql: string): Promise<void> {
  for (const [table, cols] of declaredColumns(sql)) {
    const info = await client.execute(`PRAGMA table_info(${table});`);
    if (info.rows.length === 0) continue; // fresh — CREATE TABLE already built it in full
    const existing = new Set(info.rows.map((r) => String((r as Record<string, unknown>).name)));
    for (const { name, def } of cols) {
      if (existing.has(name)) continue;
      await client.execute(`ALTER TABLE ${table} ADD COLUMN ${name} ${def};`);
    }
  }
}

/**
 * Which half of the schema a migration run applies.
 *
 *   "catalog" — control plane only (identity, billing, tenant registry).
 *   "tenant"  — one tenant's data plane only.
 *   "all"     — both. The default, so every existing caller is unchanged.
 */
export type MigrationRole = "catalog" | "tenant" | "all";

/** The DDL for a role. */
function sqlForRole(role: MigrationRole): string {
  if (role === "catalog") return CATALOG_MIGRATION_SQL;
  if (role === "tenant") return TENANT_MIGRATION_SQL;
  return MIGRATION_SQL;
}

/**
 * Apply every migration to the given client. Safe to run repeatedly.
 * Uses executeMultiple so the whole DDL script runs as one batch.
 *
 * `role` selects catalog / tenant / both (default both). The seeds below are
 * CATALOG seeds — the settings catalogue and the factory owner account are both
 * control-plane rows — so a `role: "tenant"` run applies DDL and seeds nothing.
 * A tenant database must never be handed an owner account: identity lives in
 * exactly one place.
 */
export async function runMigrations(
  client: Client,
  { role = "all" }: { role?: MigrationRole } = {},
): Promise<void> {
  await client.execute("PRAGMA foreign_keys = ON;");
  await client.executeMultiple(sqlForRole(role));
  // Retrofit any column the schema gained after a persistent DB was created —
  // CREATE TABLE IF NOT EXISTS cannot do this, and a missing column is a runtime
  // crash (digest 456544406: subscriptions.past_due_at). Derived from
  // MIGRATION_SQL, so it can never drift from the schema.
  await reconcileColumns(client, sqlForRole(role));
  if (role === "tenant") return;
  // Seed the settings catalogue from the merged registry — part of the one
  // true migration path so every migrated DB carries the current definitions
  // (settings-registry-spec §4). Idempotent upsert; safe to run repeatedly.
  await seedSettingDefinitions(client);
  // Seed the factory owner account + owner grant when OWNER_EMAIL is configured
  // (v0-owner-account-seed). On the same migration path so the app's catalog
  // carries its owner account. Strictly idempotent (account absent -> create +
  // grant; present -> no-op); a no-op when OWNER_EMAIL is unset (dev/CI). The
  // owner's own tenant database is provisioned lazily at their first sign-in
  // (lib/tenant/provisioner.ts), not here — a migration must not make network
  // calls to a database platform.
  await seedOwnerAccount(drizzle(client) as AppDatabase, process.env.OWNER_EMAIL);
}

/**
 * Open a database (from `url`, falling back to DATABASE_URL, then in-memory),
 * run the migrations, and close it. This is the single entry point the
 * standalone CLI wrapper AND the multi-tenant fan-out (scripts/
 * migrate-all-tenants.ts) call — no second migration mechanism exists.
 *
 * `authToken` is required when `url` is a remote Turso libsql:// URL. For
 * `:memory:` and `file:` URLs it is ignored. Backward-compatible: existing
 * single-tenant callers pass no token.
 */
export async function migrate(
  url: string | undefined = process.env.DATABASE_URL,
  authToken?: string,
  { role = "all" }: { role?: MigrationRole } = {},
): Promise<void> {
  const client = createMigrationDatabase(url, authToken);
  try {
    await runMigrations(client, { role });
  } finally {
    client.close();
  }
}

/** Bring the CATALOG (control-plane) database up to schema. */
export async function migrateCatalog(
  url: string | undefined,
  authToken?: string,
): Promise<void> {
  await migrate(url, authToken, { role: "catalog" });
}

/**
 * Bring ONE TENANT's data database up to schema. Called by the provisioner the
 * moment a tenant database is created, and by the fan-out for existing tenants.
 */
export async function migrateTenant(
  url: string | undefined,
  authToken?: string,
): Promise<void> {
  await migrate(url, authToken, { role: "tenant" });
}
