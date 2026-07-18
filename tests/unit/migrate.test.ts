// Migration-logic unit tests (phase: db-schema).
//
// These tests import the migration logic as exported functions, open an
// in-memory libSQL database, run the migration EXPLICITLY (never at module
// load), and assert every expected table, column, and index exists. No
// Next.js build, no Playwright browser — the libSQL client loads cleanly
// under jsdom (the project's default test environment).

import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import {
  MIGRATION_SQL,
  createMigrationDatabase,
  migrate,
  runMigrations,
} from "@/lib/migrate";

let client: Client;

beforeEach(() => {
  client = createMigrationDatabase(":memory:");
});

afterEach(() => {
  client.close();
});

/** Column names present on a table, via PRAGMA table_info. */
async function columnsOf(c: Client, table: string): Promise<string[]> {
  const res = await c.execute(`PRAGMA table_info(${table});`);
  return res.rows.map((row) => String((row as Record<string, unknown>).name));
}

/** All user table names in the database (excluding SQLite internals). */
async function tableNames(c: Client): Promise<string[]> {
  const res = await c.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';",
  );
  return res.rows.map((row) => String((row as Record<string, unknown>).name));
}

/** All index names in the database (excluding auto-generated ones). */
async function indexNames(c: Client): Promise<string[]> {
  const res = await c.execute(
    "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%';",
  );
  return res.rows.map((row) => String((row as Record<string, unknown>).name));
}

describe("MIGRATION_SQL", () => {
  it("has no side effect at import time — DDL is a plain string constant", () => {
    expect(typeof MIGRATION_SQL).toBe("string");
    expect(MIGRATION_SQL).toContain("CREATE TABLE IF NOT EXISTS users");
  });
});

describe("runMigrations", () => {
  it("creates every expected table", async () => {
    await runMigrations(client);
    const tables = await tableNames(client);
    for (const expected of ["users", "revoked_sessions"]) {
      expect(tables).toContain(expected);
    }
  });

  it("creates the users table with the expected columns", async () => {
    await runMigrations(client);
    const cols = await columnsOf(client, "users");
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "email",
        "password_hash",
        "name",
        "created_at",
      ]),
    );
  });

  it("creates the revoked_sessions table with all expected columns", async () => {
    await runMigrations(client);
    const cols = await columnsOf(client, "revoked_sessions");
    expect(cols).toEqual(
      expect.arrayContaining(["id", "jti", "user_id", "revoked_at"]),
    );
  });

  it("creates the revocation lookup index", async () => {
    await runMigrations(client);
    const indexes = await indexNames(client);
    expect(indexes).toContain("revoked_sessions_jti_idx");
  });

  it("enables foreign key enforcement", async () => {
    await runMigrations(client);
    const res = await client.execute("PRAGMA foreign_keys;");
    expect(String((res.rows[0] as Record<string, unknown>).foreign_keys)).toBe(
      "1",
    );
  });

  it("is idempotent — running twice does not error and keeps one set of tables", async () => {
    await runMigrations(client);
    await runMigrations(client);
    const tables = await tableNames(client);
    expect(tables.filter((t) => t === "users")).toHaveLength(1);
    expect(tables.filter((t) => t === "revoked_sessions")).toHaveLength(1);
  });

  it("enforces the revoked_sessions → users foreign key", async () => {
    await runMigrations(client);
    await expect(
      client.execute({
        sql: "INSERT INTO revoked_sessions (id, jti, user_id) VALUES (?, ?, ?);",
        args: ["orphan", "jti-1", "no-such-user"],
      }),
    ).rejects.toThrow();
  });

  it("enforces the jti UNIQUE constraint on revoked_sessions", async () => {
    await runMigrations(client);
    await client.execute({
      sql: "INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?);",
      args: ["u1", "user@example.com", "hash"],
    });
    await client.execute({
      sql: "INSERT INTO revoked_sessions (id, jti, user_id) VALUES (?, ?, ?);",
      args: ["r1", "dup-jti", "u1"],
    });
    await expect(
      client.execute({
        sql: "INSERT INTO revoked_sessions (id, jti, user_id) VALUES (?, ?, ?);",
        args: ["r2", "dup-jti", "u1"],
      }),
    ).rejects.toThrow();
  });
});

describe("createMigrationDatabase", () => {
  it("defaults to an in-memory database when no URL is given", async () => {
    const c = createMigrationDatabase();
    try {
      await runMigrations(c);
      expect(await tableNames(c)).toContain("users");
    } finally {
      c.close();
    }
  });

  it("normalises a bare filesystem path to a file: URL (client constructs)", async () => {
    const path = join(tmpdir(), `house-migrate-test-${process.pid}.db`);
    const c = createMigrationDatabase(path);
    try {
      await runMigrations(c);
      expect(await tableNames(c)).toContain("users");
      expect(existsSync(path)).toBe(true);
    } finally {
      c.close();
      rmSync(path, { force: true });
    }
  });

  it("passes a scheme URL through unchanged (client constructs)", () => {
    const c = createMigrationDatabase("file::memory:?cache=shared");
    expect(c).toBeTruthy();
    c.close();
  });
});

describe("migrate", () => {
  it("opens, migrates, and closes an in-memory database end to end", async () => {
    // Explicit undefined URL → falls back to in-memory; proves the whole
    // entry point the CLI wrapper calls works without a DATABASE_URL.
    await expect(migrate(":memory:")).resolves.toBeUndefined();
  });

  it("reads DATABASE_URL when no URL argument is passed", async () => {
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = ":memory:";
    try {
      await expect(migrate()).resolves.toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });
});
