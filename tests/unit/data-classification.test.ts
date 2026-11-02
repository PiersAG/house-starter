// @vitest-environment node
//
// Data classification (app-business-core issue 445 SEC.28, ASVS V8.1/V8.3):
// every column of every table has a class, and every secret is kept at rest
// only hashed or sealed.
//
//   * every table exported by lib/schema.ts and each of its columns is in
//     config/data-classification.ts exactly once — a new column fails here
//     until it is classified, and a dropped one fails until it is removed;
//   * each secret column names the file that writes it, and that file uses the
//     primitive its storage claims: bcrypt (lib/password.ts hashPassword),
//     SHA-256 (createHash("sha256")) or the AES-256-GCM seal
//     (lib/crypto/secret-box.ts);
//   * the classification is what the boundary audit reserves
//     (tests/unit/data-boundary.test.ts) — so a secret column added here is
//     immediately barred from every response and client prop.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableColumns, is } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "@/lib/schema";
import { DATA_CLASSIFICATION } from "@/config/data-classification";
import { bannedFieldNames } from "./data-boundary-audit";

const ROOT = join(__dirname, "..", "..");

const TABLES = Object.fromEntries(
  Object.entries(schema).filter(([, v]) => is(v, SQLiteTable)).map(([name, t]) => [name, Object.keys(getTableColumns(t as SQLiteTable))]),
) as Record<string, string[]>;

describe("data classification (#445)", () => {
  it("covers every table and column in lib/schema.ts, and nothing else", () => {
    expect(Object.keys(TABLES).length).toBeGreaterThan(10);
    expect(Object.keys(DATA_CLASSIFICATION).sort()).toEqual(Object.keys(TABLES).sort());
    for (const [table, cols] of Object.entries(TABLES)) {
      expect(Object.keys(DATA_CLASSIFICATION[table]).sort(), table).toEqual([...cols].sort());
    }
  });

  const PRIMITIVE: Record<string, RegExp> = {
    bcrypt: /\bhashPassword\s*\(|\bbcrypt\.hash\s*\(/,
    sha256: /createHash\(\s*["']sha256["']\s*\)|\bhashToken\s*\(|\bhashRecoveryCode\s*\(/,
    sealed: /\bseal[A-Z]\w*\s*\(|\bsealSecret\s*\(/,
  };

  it("keeps every secret hashed or sealed, in the file that writes it", () => {
    const secrets = Object.entries(DATA_CLASSIFICATION).flatMap(([t, cols]) =>
      Object.entries(cols).flatMap(([c, k]) => (k.class === "secret" ? [{ at: `${t}.${c}`, ...k }] : [])),
    );
    expect(secrets.map((s) => s.at)).toEqual(
      expect.arrayContaining(["users.passwordHash", "tenants.dbAuthToken", "passwordResetTokens.tokenHash", "userMfaTotp.secretCiphertext", "userMfaRecoveryCodes.codeHash"]),
    );
    for (const s of secrets) {
      const src = readFileSync(join(ROOT, s.writer), "utf8");
      expect(src, `${s.at} is written by ${s.writer} and should be ${s.storedAs}`).toMatch(PRIMITIVE[s.storedAs]);
    }
  });

  it("bars every secret and internal-only name from the browser", () => {
    const banned = bannedFieldNames();
    for (const [table, cols] of Object.entries(DATA_CLASSIFICATION)) {
      for (const [col, c] of Object.entries(cols)) {
        if (c.class === "secret") expect(banned.has(col), `${table}.${col}`).toBe(true);
      }
    }
  });
});
