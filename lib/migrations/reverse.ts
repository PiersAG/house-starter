// Checking the schema change log, drafting reverses, and running them
// (app-business-core issues 345 and 777). The rules are in
// lib/migrations/changes.ts.

import type { Client } from "@libsql/client";
import type { Plane, SchemaChange } from "@/lib/migrations/changes";

/** Everything the change log says the DDL should declare now, per plane. */
export function expectedNames(changes: SchemaChange[], plane: Plane): Set<string> {
  const out = new Set<string>();
  for (const c of changes.filter((x) => x.plane === plane)) {
    for (const n of c.adds) out.add(n);
    for (const n of c.removes ?? []) out.delete(n);
  }
  return out;
}

/** Plain-English problems with the change log against the DDL; empty = fine. */
export function changeLogProblems(
  changes: SchemaChange[],
  declared: Record<Plane, Set<string>>,
): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  changes.forEach((c, i) => {
    if (ids.has(c.id)) problems.push(`change ${c.id} is listed twice`);
    ids.add(c.id);
    if (!c.reverse && !c.irreversible) {
      problems.push(`change ${c.id} has no reverse SQL and no reason it cannot be reversed`);
    }
    if (c.kind === "contract") {
      if (!c.removes?.length) problems.push(`contract change ${c.id} removes nothing`);
      const earlier = changes.slice(0, i).map((x) => x.id);
      if (!c.unusedSince || !earlier.includes(c.unusedSince)) {
        problems.push(
          `contract change ${c.id} must name an EARLIER change after which no released code read what it removes (unusedSince)`,
        );
      }
    } else if (c.removes?.length) {
      problems.push(`change ${c.id} removes ${c.removes.join(", ")} but is not a contract change`);
    }
  });
  for (const plane of ["catalog", "tenant"] as const) {
    const expected = expectedNames(changes, plane);
    for (const n of declared[plane]) {
      if (!expected.has(n)) {
        problems.push(
          `the ${plane} DDL declares ${n}, but no change in lib/migrations/changes.ts adds it — add the change with its reverse (npx tsx scripts/schema-change-draft.ts)`,
        );
      }
    }
    for (const n of expected) {
      if (!declared[plane].has(n)) {
        problems.push(
          `${n} has gone from the ${plane} DDL without a contract change — a rollback to the previous version would meet a database without it`,
        );
      }
    }
  }
  return problems;
}

/** The reverse SQL for a set of added names: indexes, then columns, then tables. */
export function draftReverse(adds: string[]): string {
  const tables = new Set(adds.filter((n) => !n.includes(".") && !n.startsWith("index:")));
  const lines: string[] = [];
  for (const n of adds.filter((x) => x.startsWith("index:"))) {
    lines.push(`DROP INDEX IF EXISTS ${n.slice("index:".length)};`);
  }
  for (const n of adds.filter((x) => x.includes("."))) {
    const [table, column] = n.split(".");
    if (!tables.has(table)) lines.push(`ALTER TABLE ${table} DROP COLUMN ${column};`);
  }
  for (const t of tables) lines.push(`DROP TABLE IF EXISTS ${t};`);
  return lines.join("\n");
}

/** Changes whose additions the database does not hold yet: what migrating it will do. */
export function pendingChanges(
  changes: SchemaChange[],
  plane: Plane,
  live: Set<string>,
): SchemaChange[] {
  return changes.filter((c) => c.plane === plane && c.adds.some((n) => !live.has(n)));
}

/** Run one change's reverse. Refuses a change that has none. */
export async function applyReverse(client: Client, change: SchemaChange): Promise<void> {
  if (!change.reverse) {
    throw new Error(`change ${change.id} cannot be reversed: ${change.irreversible ?? "no reverse SQL"}`);
  }
  await client.executeMultiple(change.reverse);
}
