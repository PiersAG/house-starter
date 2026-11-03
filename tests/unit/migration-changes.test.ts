// @vitest-environment node
//
// Every schema change has its way back, and releases only expand the schema
// (app-business-core issues 777 and 345; rules in lib/migrations/changes.ts).
// This is the CI check: a DDL change without its change-log entry and reverse
// fails here, in the same PR.

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClient } from "@libsql/client";
import { CATALOG_MIGRATION_SQL, TENANT_MIGRATION_SQL, migrateCatalog, migrateTenant } from "@/lib/migrate";
import { SCHEMA_CHANGES, type SchemaChange } from "@/lib/migrations/changes";
import { applyReverse, changeLogProblems, draftReverse, expectedNames, pendingChanges } from "@/lib/migrations/reverse";
import { declaredNames, liveNames } from "@/lib/migrations/schema";

const declared = {
  catalog: declaredNames(CATALOG_MIGRATION_SQL),
  tenant: declaredNames(TENANT_MIGRATION_SQL),
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "changes-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function files(root: string): string[] {
  return readdirSync(root).flatMap((n) => {
    const p = join(root, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}

describe("the change log covers the DDL", () => {
  it("lists every declared table, column and index, each with a reverse or a reason", () => {
    expect(changeLogProblems(SCHEMA_CHANGES, declared)).toEqual([]);
  });

  it("runs every reverse on a fresh database, then migrates it back", async () => {
    for (const change of SCHEMA_CHANGES.filter((c) => c.reverse)) {
      const url = `file:${join(dir, `${change.id}.db`)}`;
      const migrate = change.plane === "catalog" ? migrateCatalog : migrateTenant;
      await migrate(url);
      const c = createClient({ url });
      await applyReverse(c, change);
      const after = await liveNames(c);
      for (const n of change.adds) expect(after.has(n), `${change.id}: ${n} still there after its reverse`).toBe(false);
      c.close();
      await migrate(url);
      const c2 = createClient({ url });
      const back = await liveNames(c2);
      c2.close();
      for (const n of change.adds) expect(back.has(n), `${change.id}: ${n} not back after re-migrating`).toBe(true);
    }
  });

  it("refuses a contract change while the app's code still names what it removes", () => {
    const code = ["app", "lib", "components", "config"].flatMap((d) => files(d)).filter((f) => !f.endsWith("lib/migrations/changes.ts"));
    for (const c of SCHEMA_CHANGES.filter((x) => x.kind === "contract")) {
      for (const n of c.removes ?? []) {
        const column = n.includes(".") ? n.split(".")[1] : n.replace(/^index:/, "");
        const users = code.filter((f) => new RegExp(`\\b${column}\\b`).test(readFileSync(f, "utf8")));
        expect(users, `${c.id} removes ${n} but code still names it`).toEqual([]);
      }
    }
  });
});

describe("the checks catch what they exist for", () => {
  const base: SchemaChange = {
    id: "0001-base",
    date: "2026-11-02",
    plane: "tenant",
    kind: "baseline",
    summary: "base",
    adds: ["pets", "pets.id"],
    reverse: null,
    irreversible: "baseline",
  };
  const ddl = (names: string[]) => ({ catalog: new Set<string>(), tenant: new Set(names) });

  it("a DDL addition with no change entry", () => {
    expect(changeLogProblems([base], ddl(["pets", "pets.id", "pets.name"])).join("\n")).toMatch(
      /declares pets\.name, but no change .* adds it/,
    );
  });

  it("an entry with no reverse and no reason, and a duplicate id", () => {
    const bad = { ...base, id: "0002-x", kind: "expand" as const, adds: ["pets.name"], irreversible: undefined };
    const p = changeLogProblems([base, bad, bad], ddl(["pets", "pets.id", "pets.name"])).join("\n");
    expect(p).toMatch(/0002-x has no reverse SQL and no reason/);
    expect(p).toMatch(/0002-x is listed twice/);
  });

  it("a removal without a contract change, and contract changes without their earlier change", () => {
    expect(changeLogProblems([base], ddl(["pets"])).join("\n")).toMatch(/pets\.id has gone from the tenant DDL without a contract change/);
    const sneaky = { ...base, id: "0002-s", kind: "expand" as const, adds: [], removes: ["pets.id"], reverse: "SELECT 1;" };
    expect(changeLogProblems([base, sneaky], ddl(["pets"])).join("\n")).toMatch(/removes pets\.id but is not a contract change/);
    const early = { ...base, id: "0002-c", kind: "contract" as const, adds: [], removes: ["pets.id"], unusedSince: "0003-later", reverse: "SELECT 1;" };
    expect(changeLogProblems([base, early], ddl(["pets"])).join("\n")).toMatch(/must name an EARLIER change/);
    const empty = { ...early, removes: [], unusedSince: "0001-base" };
    expect(changeLogProblems([base, empty], ddl(["pets", "pets.id"])).join("\n")).toMatch(/removes nothing/);
    const good = { ...early, unusedSince: "0001-base" };
    expect(changeLogProblems([base, good], ddl(["pets"]))).toEqual([]);
    expect(expectedNames([base, good], "tenant")).toEqual(new Set(["pets"]));
  });

  it("drafts a reverse that really removes an index, a column and a table", async () => {
    const adds = ["visits", "visits.id", "index:visits_by_pet", "pets.owner_note"];
    const reverse = draftReverse(adds);
    expect(reverse).toBe(
      "DROP INDEX IF EXISTS visits_by_pet;\nALTER TABLE pets DROP COLUMN owner_note;\nDROP TABLE IF EXISTS visits;",
    );
    const c = createClient({ url: `file:${join(dir, "draft.db")}` });
    await c.executeMultiple(
      "CREATE TABLE pets (id TEXT PRIMARY KEY, owner_note TEXT); CREATE TABLE visits (id TEXT PRIMARY KEY, pet TEXT); CREATE INDEX visits_by_pet ON visits(pet);",
    );
    const change: SchemaChange = { ...base, id: "0002-v", kind: "expand", adds, reverse, irreversible: undefined };
    expect(pendingChanges([change], "tenant", await liveNames(c))).toEqual([]);
    await applyReverse(c, change);
    const left = await liveNames(c);
    expect([...left].sort()).toEqual(["pets", "pets.id"]);
    expect(pendingChanges([change], "tenant", left)).toEqual([change]);
    await expect(applyReverse(c, base)).rejects.toThrow(/cannot be reversed: baseline/);
    c.close();
  });
});
