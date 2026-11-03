// @vitest-environment node
//
// A migration is rehearsed on a copy of live data, reversed and re-run, and the
// live database is never written (app-business-core issue 777).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { dumpDatabase } from "@/lib/backup/dump";
import type { SchemaChange } from "@/lib/migrations/changes";
import { rehearseMigration } from "@/lib/migrations/rehearse";

let dir: string;
let live: Client;

const BASE: SchemaChange = {
  id: "0001-base",
  date: "2026-11-02",
  plane: "tenant",
  kind: "baseline",
  summary: "base",
  adds: ["pets", "pets.id", "pets.name"],
  reverse: null,
  irreversible: "baseline",
};
const ADD_NOTES: SchemaChange = {
  id: "0002-notes",
  date: "2026-11-02",
  plane: "tenant",
  kind: "expand",
  summary: "notes on a pet",
  adds: ["pets.notes", "visits", "visits.id", "visits.pet", "index:visits_by_pet"],
  reverse: "DROP INDEX IF EXISTS visits_by_pet;\nALTER TABLE pets DROP COLUMN notes;\nDROP TABLE IF EXISTS visits;",
};

/** The "release": the migration that adds what 0002-notes declares. */
async function release(url: string): Promise<void> {
  const c = createClient({ url });
  const cols = await c.execute("SELECT name FROM pragma_table_info('pets')");
  if (!cols.rows.some((r) => r.name === "notes")) await c.execute("ALTER TABLE pets ADD COLUMN notes TEXT");
  await c.executeMultiple(
    "CREATE TABLE IF NOT EXISTS visits (id TEXT PRIMARY KEY, pet TEXT); CREATE INDEX IF NOT EXISTS visits_by_pet ON visits(pet);",
  );
  c.close();
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "rehearse-test-"));
  live = createClient({ url: `file:${join(dir, "live.db")}` });
  await live.execute("CREATE TABLE pets (id TEXT PRIMARY KEY, name TEXT)");
  for (let i = 0; i < 25; i++) await live.execute({ sql: "INSERT INTO pets VALUES (?, ?)", args: [`p${i}`, `Rex ${i}'s`] });
});
afterEach(() => {
  live.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("migration rehearsal", () => {
  it("migrates a copy, keeps every row, reverses it, re-runs it, and never writes the live database", async () => {
    const before = (await dumpDatabase(live)).sha256;
    const r = await rehearseMigration({
      label: "tenant t1",
      plane: "tenant",
      source: live,
      scratchFile: join(dir, "copy.db"),
      migrate: release,
      changes: [BASE, ADD_NOTES],
    });
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.pending).toEqual(["0002-notes"]);
    expect(r.rows_before).toEqual({ pets: 25 });
    expect(r.steps.map((s) => s.ok)).toEqual([true, true, true, true, true]);
    expect((await dumpDatabase(live)).sha256).toBe(before);
  });

  it("stops a migration that cannot be reversed: not ready to run", async () => {
    const r = await rehearseMigration({
      label: "tenant t1",
      plane: "tenant",
      source: live,
      scratchFile: join(dir, "copy.db"),
      migrate: release,
      changes: [BASE, { ...ADD_NOTES, reverse: null, irreversible: "rewrites every row" }],
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/0002-notes cannot be reversed \(rewrites every row\) — not ready to run/);
  });

  it("catches a migration that loses rows", async () => {
    const r = await rehearseMigration({
      label: "tenant t1",
      plane: "tenant",
      source: live,
      scratchFile: join(dir, "copy.db"),
      migrate: async (url) => {
        await release(url);
        const c = createClient({ url });
        await c.execute("DELETE FROM pets WHERE id = 'p3'");
        c.close();
      },
      changes: [BASE, ADD_NOTES],
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/table pets had 25 rows and now has 24/);
  });

  it("catches a reverse that leaves something behind, and a migration that throws", async () => {
    const leaky = { ...ADD_NOTES, reverse: "DROP INDEX IF EXISTS visits_by_pet;\nDROP TABLE IF EXISTS visits;" };
    const r = await rehearseMigration({
      label: "tenant t1",
      plane: "tenant",
      source: live,
      scratchFile: join(dir, "copy.db"),
      migrate: release,
      changes: [BASE, leaky],
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/pets\.notes is still there after the reverse/);

    const t = await rehearseMigration({
      label: "tenant t1",
      plane: "tenant",
      source: live,
      scratchFile: join(dir, "copy2.db"),
      migrate: async () => {
        throw new Error("syntax error near ALTER");
      },
      changes: [BASE, ADD_NOTES],
      now: (() => {
        let n = 0;
        return () => (n += 100);
      })(),
    });
    expect(t.ok).toBe(false);
    expect(t.steps[1]).toMatchObject({ ok: false, detail: "syntax error near ALTER" });
  });
});
