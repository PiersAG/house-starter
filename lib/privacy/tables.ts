// The schema's tables, by the export name the personal-data map
// (config/personal-data.ts) and the data classification use. Shared by the
// data report, the deletion pipeline and their tests, so all three walk the
// same tables in the same way.

import "server-only";

import { getTableColumns, type SQL } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { is } from "drizzle-orm";
import { SQLiteTable as SQLiteTableClass } from "drizzle-orm/sqlite-core";
import * as schema from "@/lib/schema";

/** Every table lib/schema.ts exports, keyed by its export name. */
export function schemaTables(): Record<string, SQLiteTable> {
  const out: Record<string, SQLiteTable> = {};
  for (const [name, value] of Object.entries(schema)) {
    if (is(value, SQLiteTableClass)) out[name] = value as SQLiteTable;
  }
  return out;
}

/** One table by its export name; throws for a name the schema does not have. */
export function tableNamed(name: string): SQLiteTable {
  const t = schemaTables()[name];
  if (!t) throw new Error(`lib/privacy/tables.ts: no table "${name}" in lib/schema.ts`);
  return t;
}

/** One column of a table by its property name; throws when absent. */
export function columnOf(table: SQLiteTable, property: string): SQLiteColumn {
  const col = (getTableColumns(table) as Record<string, SQLiteColumn>)[property];
  if (!col) throw new Error(`lib/privacy/tables.ts: no column "${property}"`);
  return col;
}

/** The property names of a table's columns. */
export function columnNames(table: SQLiteTable): string[] {
  return Object.keys(getTableColumns(table));
}

export type Where = SQL | undefined;
