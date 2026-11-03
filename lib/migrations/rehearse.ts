// Rehearse a migration on a current copy of live data, before it touches a
// customer record (app-business-core issue 777; Matt Murphy #103: "current
// mirror of your live database where you test the exact migration with real
// data shapes before it touches a single customer record"; #230: "create a copy
// test your migration merge it back"; #281: "want to run a migration without
// risking production branch it").
//
// The copy is made from the live database itself, read-only, with the same
// dump the off-provider backup uses — so it works on any provider, and the
// live database is never written. Then, on the copy only:
//   1. the EXACT migration the release will run (lib/migrate.ts) is applied;
//   2. no row is lost and SQLite's own checks pass;
//   3. every change it applied is reversed with the change log's reverse SQL,
//      and the copy is back to the live schema with every row intact;
//   4. the migration is applied again, so the reverse is proven to leave a
//      database the release can migrate.
// The copy is a throwaway staging database: made for the rehearsal, deleted
// after it (the release path has no standing staging tier).

import "server-only";

import { rmSync } from "node:fs";
import { createClient, type Client } from "@libsql/client";
import { countRows, dumpDatabase, integrityProblems, loadDump } from "@/lib/backup/dump";
import { SCHEMA_CHANGES, type Plane, type SchemaChange } from "@/lib/migrations/changes";
import { applyReverse, pendingChanges } from "@/lib/migrations/reverse";
import { liveNames } from "@/lib/migrations/schema";

export interface RehearsalReport {
  label: string;
  plane: Plane;
  ok: boolean;
  pending: string[];
  steps: { name: string; seconds: number; ok: boolean; detail?: string }[];
  rows_before: Record<string, number>;
  problems: string[];
}

export interface RehearsalOptions {
  label: string;
  plane: Plane;
  /** The live database, opened read-only by the caller. */
  source: Client;
  /** A file path for the throwaway copy. Removed afterwards. */
  scratchFile: string;
  /** The release's own migration for this plane, given the copy's URL. */
  migrate: (url: string) => Promise<void>;
  changes?: SchemaChange[];
  now?: () => number;
}

function lostRows(before: Record<string, number>, after: Record<string, number>): string[] {
  return Object.entries(before)
    .filter(([t, n]) => (after[t] ?? 0) < n)
    .map(([t, n]) => `table ${t} had ${n} rows and now has ${after[t] ?? 0}`);
}

export async function rehearseMigration(opts: RehearsalOptions): Promise<RehearsalReport> {
  const now = opts.now ?? Date.now;
  const changes = opts.changes ?? SCHEMA_CHANGES;
  const steps: RehearsalReport["steps"] = [];
  const problems: string[] = [];
  const url = `file:${opts.scratchFile}`;
  let copy: Client | undefined;
  let rowsBefore: Record<string, number> = {};
  let pending: SchemaChange[] = [];

  async function step(name: string, fn: () => Promise<string[] | void>): Promise<boolean> {
    const s = now();
    let found: string[] = [];
    try {
      found = (await fn()) ?? [];
    } catch (err) {
      found = [err instanceof Error ? err.message : String(err)];
    }
    steps.push({
      name,
      seconds: Math.round((now() - s) / 100) / 10,
      ok: found.length === 0,
      ...(found.length ? { detail: found.join("; ") } : {}),
    });
    problems.push(...found.map((f) => `${name}: ${f}`));
    return found.length === 0;
  }

  rmSync(opts.scratchFile, { force: true });
  try {
    const liveSchema = await liveNames(opts.source);
    const copied = await step("copy the live data (read-only)", async () => {
      const dump = await dumpDatabase(opts.source);
      copy = createClient({ url });
      await loadDump(copy, dump.sql);
      rowsBefore = dump.rows;
    });
    pending = pendingChanges(changes, opts.plane, liveSchema);
    const irreversible = pending.filter((c) => !c.reverse);
    if (irreversible.length) {
      problems.push(
        ...irreversible.map((c) => `change ${c.id} cannot be reversed (${c.irreversible ?? "no reverse"}) — not ready to run`),
      );
    }
    if (copied && copy && !irreversible.length) {
      const c = copy;
      const ran = await step("run the release's migration on the copy", () => opts.migrate(url));
      const kept =
        ran &&
        (await step("check no row was lost and the copy is consistent", async () => [
          ...lostRows(rowsBefore, await countRows(c)),
          ...(await integrityProblems(c)),
        ]));
      const reversed =
        kept &&
        (await step("reverse every change the migration applied", async () => {
          for (const ch of [...pending].reverse()) await applyReverse(c, ch);
          const back = await liveNames(c);
          const out: string[] = [];
          for (const n of back) if (!liveSchema.has(n)) out.push(`${n} is still there after the reverse`);
          for (const n of liveSchema) if (!back.has(n)) out.push(`${n} was lost by the reverse`);
          return [...out, ...lostRows(rowsBefore, await countRows(c)), ...(await integrityProblems(c))];
        }));
      if (reversed) {
        await step("run the migration again after the reverse", async () => {
          await opts.migrate(url);
          return integrityProblems(c);
        });
      }
    }
  } finally {
    copy?.close();
    rmSync(opts.scratchFile, { force: true });
  }
  return {
    label: opts.label,
    plane: opts.plane,
    ok: problems.length === 0,
    pending: pending.map((c) => c.id),
    steps,
    rows_before: rowsBefore,
    problems,
  };
}
