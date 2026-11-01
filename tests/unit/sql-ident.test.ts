// Only checked names and column definitions are spliced into SQL (issue 517).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MIGRATION_SQL } from "@/lib/migrate";
import { sqlColumnDef, sqlIdent } from "@/lib/sql-ident";

describe("sqlIdent", () => {
  it("passes plain names and refuses anything that could change the statement", () => {
    expect(sqlIdent("setting_values")).toBe("setting_values");
    for (const bad of ["users; DROP TABLE users", "a b", "a-b", "\"x\"", "1abc", "", "x".repeat(64), "t)--"]) {
      expect(() => sqlIdent(bad), bad).toThrow();
    }
  });
});

describe("sqlColumnDef", () => {
  it("passes every column definition the template's migrations write", () => {
    const defs = new Set<string>();
    for (const m of MIGRATION_SQL.matchAll(/CREATE TABLE IF NOT EXISTS \w+ \(([\s\S]*?)\n\);/g)) {
      for (const raw of m[1].split("\n")) {
        const line = raw.replace(/--.*/, "").trim().replace(/,$/, "");
        if (!line || /^(PRIMARY KEY|FOREIGN KEY|UNIQUE|CHECK|CONSTRAINT)\b/.test(line)) continue;
        defs.add(line.split(/\s+/).slice(1).join(" "));
      }
    }
    expect(defs.size).toBeGreaterThan(10);
    for (const d of defs) expect(() => sqlColumnDef(d), d).not.toThrow();
  });

  it("refuses a definition carrying a second statement or an expression", () => {
    for (const bad of ["TEXT; DROP TABLE users", "TEXT DEFAULT (select 1)", "TEXT NOT NULL --", "BLOB", "TEXT DEFAULT 'a'; x"]) {
      expect(() => sqlColumnDef(bad), bad).toThrow();
    }
  });

  it("lib/migrate.ts splices only through these helpers", () => {
    const src = readFileSync("lib/migrate.ts", "utf8");
    for (const m of src.matchAll(/execute\(\s*`([^`]*)`/g)) {
      for (const v of m[1].matchAll(/\$\{([^}]*)\}/g)) expect(v[1]).toMatch(/^sql(Ident|ColumnDef)\(/);
    }
  });
});
