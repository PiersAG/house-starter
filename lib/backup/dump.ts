// A whole database as one plain SQL text, and back (app-business-core issue 528).
//
// The off-provider copy must not depend on the provider it protects against, so
// it is not the provider's own export: it is SQL any SQLite or libSQL database can
// load (`sqlite3 new.db < dump.sql`, `turso db create --from-dump`, or
// loadDump below).
//
// DETERMINISTIC ON PURPOSE. The same data always gives the same text, byte for
// byte: tables in name order, rows sorted by every column, no timestamp in the
// text. So a restore is verified by dumping the restored database again and
// comparing its SHA-256 with the one recorded at export — the effect itself
// ("the data is intact"), not something next to it.

import "server-only";

import { createHash } from "node:crypto";
import type { Client, InValue } from "@libsql/client";
import { sqlIdent } from "@/lib/sql-ident";

export interface DatabaseDump {
  sql: string;
  sha256: string;
  /** Rows per table. */
  rows: Record<string, number>;
}

type MasterRow = { type: string; name: string; tbl_name: string; sql: string | null };

/** Tables the database engine or the provider keeps for itself. */
function isInternal(name: string): boolean {
  return /^(sqlite_|libsql_|_litestream|_cf_)/.test(name);
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** One value as an SQL literal that reads back as the same value. */
export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("a stored number is not finite");
    // String() is the shortest text that reads back as exactly the same number.
    return String(v);
  }
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "string") return `'${v.replace(/'/g, "''")}'`;
  if (v instanceof ArrayBuffer) return `X'${hex(new Uint8Array(v))}'`;
  if (ArrayBuffer.isView(v)) return `X'${hex(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))}'`;
  throw new Error(`a stored value has an unsupported type (${typeof v})`);
}

async function schemaObjects(client: Client): Promise<MasterRow[]> {
  const r = await client.execute(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name",
  );
  return (r.rows as unknown as MasterRow[]).filter((o) => !isInternal(o.name) && !isInternal(o.tbl_name));
}

export async function dumpDatabase(client: Client): Promise<DatabaseDump> {
  const objects = await schemaObjects(client);
  const tables = objects.filter((o) => o.type === "table").sort((a, b) => a.name.localeCompare(b.name));
  const rest = objects.filter((o) => o.type !== "table");
  const lines: string[] = ["PRAGMA foreign_keys=OFF;", "BEGIN;"];
  const rows: Record<string, number> = {};

  for (const t of tables) {
    lines.push(`${t.sql};`);
    const cols = await client.execute(`PRAGMA table_info(${sqlIdent(t.name)})`);
    const names = cols.rows.map((c) => String((c as Record<string, unknown>).name));
    const data = await client.execute(
      `SELECT * FROM ${sqlIdent(t.name)} ORDER BY ${names.map((n) => sqlIdent(n)).join(", ")}`,
    );
    rows[t.name] = data.rows.length;
    const target = `${sqlIdent(t.name)} (${names.map((n) => sqlIdent(n)).join(", ")})`;
    for (const row of data.rows) {
      const values = names.map((n) => sqlLiteral((row as Record<string, unknown>)[n]));
      lines.push(`INSERT INTO ${target} VALUES (${values.join(", ")});`);
    }
  }
  // Indexes, triggers and views after the data, as sqlite3's own .dump does.
  for (const o of rest.sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`))) {
    lines.push(`${o.sql};`);
  }
  lines.push("COMMIT;", "");
  const sql = lines.join("\n");
  return { sql, sha256: sha256(sql), rows };
}

export function sha256(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Load a dump into an EMPTY database. Refuses one that already holds tables:
 *  a restore goes into a clean environment, never on top of live data. */
export async function loadDump(client: Client, sql: string): Promise<void> {
  const existing = await schemaObjects(client);
  if (existing.some((o) => o.type === "table")) {
    throw new Error("the target database is not empty — restore only into a new, empty database");
  }
  await client.executeMultiple(sql);
}

/** Row counts per table, read from the database itself. */
export async function countRows(client: Client): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of (await schemaObjects(client)).filter((o) => o.type === "table")) {
    const r = await client.execute(`SELECT COUNT(*) AS n FROM ${sqlIdent(t.name)}`);
    out[t.name] = Number((r.rows[0] as Record<string, unknown>).n);
  }
  return out;
}

/** SQLite's own consistency checks: page structure and foreign keys. */
export async function integrityProblems(client: Client): Promise<string[]> {
  const problems: string[] = [];
  const ic = await client.execute("PRAGMA integrity_check");
  for (const row of ic.rows) {
    const v = String(Object.values(row as Record<string, unknown>)[0]);
    if (v !== "ok") problems.push(`integrity: ${v}`);
  }
  const fk = await client.execute("PRAGMA foreign_key_check");
  for (const row of fk.rows) {
    const r = row as Record<string, unknown>;
    problems.push(`foreign key: ${String(r.table)} row ${String(r.rowid)} → ${String(r.parent)}`);
  }
  return problems;
}

export type { InValue };
