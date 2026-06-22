// Migration logic for the house-starter template.
//
// This module is COVERED by unit tests. None of the code below runs at module
// load time — `runMigrations` / `migrate` must be called explicitly. The
// standalone CLI entry point (scripts/migrate.ts) is a thin, logic-free wrapper
// that simply imports and calls `migrate()`.

import Database from "better-sqlite3";

type SqliteDatabase = Database.Database;

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
 * Open a better-sqlite3 database. Defaults to an in-memory database when no URL
 * is supplied, which keeps the CLI runnable in any environment.
 */
export function createMigrationDatabase(url?: string): SqliteDatabase {
  const target = url && url.length > 0 ? url : ":memory:";
  const db = new Database(target);
  db.pragma("foreign_keys = ON");
  return db;
}

/**
 * Apply every migration to the given database. Safe to run repeatedly.
 */
export function runMigrations(db: SqliteDatabase): void {
  db.exec(MIGRATION_SQL);
}

/**
 * Open a database (from `url`, falling back to DATABASE_URL, then in-memory),
 * run the migrations, and close it. This is the single entry point the
 * standalone CLI wrapper calls.
 */
export function migrate(url: string | undefined = process.env.DATABASE_URL): void {
  const db = createMigrationDatabase(url);
  try {
    runMigrations(db);
  } finally {
    db.close();
  }
}
