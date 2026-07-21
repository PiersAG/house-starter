// Schema-drift guard (incident digest 456544406). CREATE TABLE IF NOT EXISTS
// builds a fresh DB fully but never alters an existing table, so a column added
// to the schema after a persistent DB was created (subscriptions.past_due_at,
// WP1) never reached that DB and every query selecting it crashed at runtime.
// runMigrations now reconciles missing columns; these tests fail if that
// reconciliation and the schema ever diverge.

import { describe, it, expect, afterEach } from "vitest";
import type { Client } from "@libsql/client";
import { createMigrationDatabase, runMigrations } from "@/lib/migrate";

let client: Client;
let client2: Client;
afterEach(() => {
  client?.close();
  client2?.close();
});

/** The columns a table currently has, sorted, via PRAGMA. */
async function columnsOf(c: Client, table: string): Promise<string[]> {
  const r = await c.execute(`PRAGMA table_info(${table});`);
  return r.rows.map((x) => String((x as Record<string, unknown>).name)).sort();
}

// A pre-WP1 subscriptions table: exactly today's schema minus past_due_at (and
// with the other later-added columns absent too, to prove the reconciler adds
// ALL missing columns, not a hard-coded one).
const LEGACY_SCHEMA = `
CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  stripe_customer_id TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
`;

describe("schema-drift reconciliation (digest 456544406)", () => {
  it("adds past_due_at to a legacy subscriptions table, and the crashing query then runs", async () => {
    client = createMigrationDatabase(":memory:");
    await client.executeMultiple(LEGACY_SCHEMA);
    expect(await columnsOf(client, "subscriptions")).not.toContain("past_due_at");

    await runMigrations(client);

    expect(await columnsOf(client, "subscriptions")).toContain("past_due_at");
    // The columns getSubscriptionByUserId selects (incl. past_due_at) are now
    // selectable — this is the query that produced digest 456544406.
    await client.execute(
      "SELECT id, user_id, status, trial_ends_at, past_due_at FROM subscriptions LIMIT 1;",
    );
  });

  it("a stale table converges to EXACTLY the fresh schema (migration cannot diverge)", async () => {
    // Fresh DB → the authoritative current column set.
    client = createMigrationDatabase(":memory:");
    await runMigrations(client);
    const fresh = await columnsOf(client, "subscriptions");

    // Stale DB missing several later-added columns → must end up identical.
    client2 = createMigrationDatabase(":memory:");
    await client2.executeMultiple(LEGACY_SCHEMA);
    await runMigrations(client2);
    const reconciled = await columnsOf(client2, "subscriptions");

    expect(reconciled).toEqual(fresh);
    // And it actually GAINED columns (guards against the test passing silently
    // because LEGACY_SCHEMA was accidentally already complete): the legacy table
    // had 6 columns, the current schema has more.
    expect(reconciled).toContain("past_due_at");
    expect(reconciled.length).toBeGreaterThan(6);
  });

  it("is a no-op on a fresh DB and idempotent across repeated runs", async () => {
    client = createMigrationDatabase(":memory:");
    await runMigrations(client);
    const before = await columnsOf(client, "subscriptions");
    await runMigrations(client); // again — must not error or change the schema
    expect(await columnsOf(client, "subscriptions")).toEqual(before);
  });
});
