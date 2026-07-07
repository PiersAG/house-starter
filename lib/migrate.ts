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

import { createClient, type Client } from "@libsql/client";

/**
 * Idempotent DDL that brings an empty SQLite database up to the current schema.
 * Kept in sync with lib/schema.ts. `IF NOT EXISTS` makes re-running a no-op.
 */
export const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
`;

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
 * Apply every migration to the given client. Safe to run repeatedly.
 * Uses executeMultiple so the whole DDL script runs as one batch.
 */
export async function runMigrations(client: Client): Promise<void> {
  await client.execute("PRAGMA foreign_keys = ON;");
  await client.executeMultiple(MIGRATION_SQL);
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
): Promise<void> {
  const client = createMigrationDatabase(url, authToken);
  try {
    await runMigrations(client);
  } finally {
    client.close();
  }
}
