// Live Drizzle ORM client for the house-starter template.
//
// This module wires the better-sqlite3 driver to Drizzle and exposes a single
// shared `db` instance for server-side code (route handlers, server actions,
// the credentials authorize callback). It is excluded from unit-test coverage
// and verified indirectly via the Playwright E2E suite — the repository logic
// that runs against it lives in lib/users.ts, which IS unit-tested.
//
// The schema is brought up to date when the connection is opened so the app is
// runnable in a fresh environment. The migration logic itself lives in
// lib/migrate.ts and never runs at that module's load time.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { runMigrations } from "@/lib/migrate";
import type { AppDatabase } from "@/lib/users";

function resolveDatabaseTarget(): string {
  const url = process.env.DATABASE_URL;
  return url && url.length > 0 ? url : ":memory:";
}

function createDatabase(): AppDatabase {
  const target = resolveDatabaseTarget();
  // better-sqlite3 will not create the parent directory of a file database.
  if (target !== ":memory:") {
    mkdirSync(dirname(target), { recursive: true });
  }
  const sqlite = new Database(target);
  sqlite.pragma("foreign_keys = ON");
  runMigrations(sqlite);
  // The repository layer (lib/users.ts) uses explicit table references rather
  // than the relational query API, so no schema generic is needed here.
  return drizzle(sqlite);
}

// Cache the instance on globalThis so every module that imports `db` shares one
// connection. This matters in two ways:
//   1. Dev hot-reload does not open a new connection (or re-run migrations) on
//      every module re-evaluation.
//   2. In a production `next start` build each route handler is bundled
//      separately, so lib/db.ts is evaluated once *per route bundle*. Without a
//      process-wide cache, every route would open its own `:memory:` database —
//      a user created by the signup route would then be invisible to the login
//      route, breaking authentication. Caching on globalThis (which is shared
//      across the whole Node process) makes all bundles share one database.
const globalForDb = globalThis as unknown as { __appDb?: AppDatabase };

export const db: AppDatabase = globalForDb.__appDb ?? createDatabase();

globalForDb.__appDb = db;
