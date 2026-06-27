// Live Drizzle ORM client for the house-starter template.
//
// Wires the libSQL driver (@libsql/client) to Drizzle and exposes a single
// shared `db` instance for server-side code (route handlers, server actions,
// the credentials authorize callback). Excluded from unit-test coverage and
// verified indirectly via the Playwright E2E suite — the repository logic that
// runs against it lives in lib/users.ts, which IS unit-tested.
//
// Migrations are NOT run here. Creating the Drizzle client is synchronous;
// only queries are async. Schema is applied out-of-band by the migration
// entry point (lib/migrate.ts -> scripts/migrate.ts, run as a deploy/CI step
// via `npm run db:migrate`), keeping module load synchronous and side-effect
// free. The same code runs against a local file (file:local.db) in dev and a
// remote libSQL/Turso URL in prod — only DATABASE_URL differs.

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import type { AppDatabase } from "@/lib/users";

function resolveUrl(): string {
  // Dev default is a persistent local file so data survives restarts and
  // "sign up then log in" works locally. Tests pass ":memory:" explicitly via
  // the migration helpers; the running app never defaults to in-memory (an
  // empty, unmigrated, vanishing database is wrong for a real workflow).
  // Prod sets DATABASE_URL to the hosted libSQL/Turso URL (UK/EU or in-region
  // host per the app's target market — data residency is a per-app decision).
  const url = process.env.DATABASE_URL;
  const value = url && url.length > 0 ? url : "file:local.db";
  if (value === ":memory:") return value;
  if (/^[a-z]+:/i.test(value)) return value;
  return `file:${value}`;
}

function createDatabase(): AppDatabase {
  const client = createClient({
    url: resolveUrl(),
    authToken: process.env.DATABASE_AUTH_TOKEN,
  });
  return drizzle(client);
}

// Cache the instance on globalThis so every module that imports `db` shares one
// connection. In a production `next start` build each route handler is bundled
// separately, so lib/db.ts is evaluated once per route bundle; a process-wide
// cache means all bundles share one database/connection rather than each
// opening its own.
const globalForDb = globalThis as unknown as { __appDb?: AppDatabase };

export const db: AppDatabase = globalForDb.__appDb ?? createDatabase();

globalForDb.__appDb = db;
