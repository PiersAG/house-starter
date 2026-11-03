// What the migration DDL declares, and what a live database actually holds, as
// one flat set of names (app-business-core issues 345 and 777).
//
// A name is "table", "table.column" or "index:name". The change log
// (lib/migrations/changes.ts) is checked against the declared set, and the
// migration rehearsal compares a database before and after against it.

import type { Client } from "@libsql/client";

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

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
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** Every table, column and index the DDL declares. */
export function declaredNames(ddl: string): Set<string> {
  const sql = stripSqlComments(ddl);
  const out = new Set<string>();
  const table = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\)\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = table.exec(sql)) !== null) {
    out.add(m[1]);
    for (const raw of splitTopLevel(m[2])) {
      const line = raw.trim();
      if (!line || /^(PRIMARY KEY|FOREIGN KEY|UNIQUE|CHECK|CONSTRAINT)\b/i.test(line)) continue;
      out.add(`${m[1]}.${line.split(/\s+/)[0].replace(/["'`]/g, "")}`);
    }
  }
  const index = /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS\s+(\w+)/gi;
  while ((m = index.exec(sql)) !== null) out.add(`index:${m[1]}`);
  return out;
}

/** The same set of names, read from a database. */
export async function liveNames(client: Client): Promise<Set<string>> {
  const out = new Set<string>();
  const master = await client.execute(
    "SELECT type, name FROM sqlite_master WHERE type IN ('table','index') AND sql IS NOT NULL",
  );
  for (const row of master.rows) {
    const r = row as unknown as { type: string; name: string };
    if (/^(sqlite_|libsql_|_litestream)/.test(r.name)) continue;
    if (r.type === "index") {
      out.add(`index:${r.name}`);
      continue;
    }
    out.add(r.name);
    const cols = await client.execute({ sql: "SELECT name FROM pragma_table_info(?)", args: [r.name] });
    for (const c of cols.rows) out.add(`${r.name}.${String((c as Record<string, unknown>).name)}`);
  }
  return out;
}
