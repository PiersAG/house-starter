// Random ids and an ownership check on every endpoint that takes an id
// (app-business-core issue 770; Matt Murphy #53, #140).
//
//   * lib/ownership.ts: a record is returned or changed only for its owner (or
//     the workspace owner); a record someone else owns looks exactly like a
//     missing one.
//   * THE AUDIT: every endpoint that accepts a resource identifier — a dynamic
//     route segment, an id-named query key or form field — is listed from the
//     source, and each must load its record through the ownership check, or be
//     named below with the reason it takes no record id. A new endpoint that
//     takes an id without the check fails this test.
//   * Every table's id is random text (crypto.randomUUID): no integer or
//     auto-increment primary key anywhere in the schema or the migrations.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { NotFoundOrNotOwnedError, loadOwned, notOwnedResponse, owns } from "@/lib/ownership";

describe("the ownership check", () => {
  const record = { id: "r1", ownerId: "user-a" };

  it("lets the record's owner and the workspace owner through", () => {
    expect(owns({ user: { id: "user-a", role: "member" } }, record)).toBe(true);
    expect(owns({ user: { id: "user-z", role: "owner" } }, record)).toBe(true);
  });

  it("refuses another user, an anonymous caller and an unowned record", () => {
    expect(owns({ user: { id: "user-b", role: "member" } }, record)).toBe(false);
    expect(owns(null, record)).toBe(false);
    expect(owns({ user: { id: "user-b" } }, { ownerId: null })).toBe(false);
  });

  it("answers someone else's record exactly like a missing one", async () => {
    const other = loadOwned({ user: { id: "user-b", role: "member" } }, async () => record);
    const missing = loadOwned({ user: { id: "user-b", role: "member" } }, async () => null);
    await expect(other).rejects.toBeInstanceOf(NotFoundOrNotOwnedError);
    await expect(missing).rejects.toBeInstanceOf(NotFoundOrNotOwnedError);
    const a = notOwnedResponse(await other.catch((e) => e))!;
    const b = notOwnedResponse(await missing.catch((e) => e))!;
    expect([a.status, await a.text()]).toEqual([b.status, await b.text()]);
    expect(a.status).toBe(404);
    expect(notOwnedResponse(new Error("other"))).toBeNull();
  });

  it("returns the record to its owner", async () => {
    await expect(loadOwned({ user: { id: "user-a", role: "member" } }, async () => record)).resolves.toBe(record);
  });
});

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}

/**
 * Endpoints that take an identifier that is NOT a record id, each with its
 * reason. Anything else that takes an id must use the ownership check.
 */
const NOT_A_RECORD_ID: Record<string, string> = {
  "app/api/settings/[key]/route.ts":
    "[key] names a setting definition from the registry (validated against its shape and the registry), not a record; the value is read and written in the caller's own tenant database, and a client preference is keyed by the session's own user id, never one from the request.",
  "app/api/auth/[...nextauth]/route.ts": "[...nextauth] is the sign-in library's own action name (signin, callback, csrf), not a record.",
  "app/reset-password/page.tsx":
    "token is a single-use secret from a reset link, looked up by its hash and bound to its account (lib/password-reset.ts), not a record id chosen by the caller.",
};

const ID_INPUT = /searchParams\.get\(\s*["'](\w*[iI]d|id)["']|formData\.get\(\s*["'](\w*[iI]d|id)["']|\b(\w*Id|id)\s*:\s*(idField|z\.)/;

describe("audit: every endpoint that takes an id checks ownership (Matt Murphy #53)", () => {
  const endpoints = files("app").filter((f) => {
    const src = readFileSync(f, "utf8");
    const routeFile = /\/(route\.ts|page\.tsx)$/.test(f) || /["']use server["']/.test(src);
    if (!routeFile) return false;
    const dynamic = /\[[^\]]+\]/.test(relative("app", f));
    return dynamic || ID_INPUT.test(src);
  });

  it("finds the template's endpoints that take an identifier", () => {
    expect(endpoints).toEqual(expect.arrayContaining(Object.keys(NOT_A_RECORD_ID).filter((k) => k !== "app/reset-password/page.tsx")));
  });

  it("each loads its record through the ownership check, or is declared with a reason", () => {
    const unchecked = endpoints.filter((f) => {
      if (NOT_A_RECORD_ID[f]) return false;
      return !/\bloadOwned\(|\bowns\(/.test(readFileSync(f, "utf8"));
    });
    expect(unchecked, "endpoints that take an id with no ownership check (lib/ownership.ts)").toEqual([]);
  });

  it("every declared exemption still exists and still has its reason", () => {
    for (const [f, reason] of Object.entries(NOT_A_RECORD_ID)) {
      expect(statSync(f).isFile(), f).toBe(true);
      expect(reason.length).toBeGreaterThan(40);
    }
  });
});

describe("ids are random, never sequential (Matt Murphy #53, #140)", () => {
  it("no integer or auto-increment primary key in the schema", () => {
    const schema = readFileSync("lib/schema.ts", "utf8");
    expect(schema).not.toMatch(/integer\([^)]*\)[^,\n]*\.primaryKey\(/);
    expect(schema).not.toMatch(/autoIncrement/);
    expect(schema).not.toMatch(/\bserial\(/);
  });

  it("no integer or auto-increment primary key in any migration", () => {
    for (const f of [...files("lib"), ...files("scripts")]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/INTEGER\s+PRIMARY\s+KEY/);
      expect(src, f).not.toMatch(/AUTOINCREMENT/);
    }
  });

  it("no id is a counted number", () => {
    const offenders: string[] = [];
    for (const f of files("lib")) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/\bid:\s*([^,\n}]+)/g)) {
        if (/^(\d|\w+\s*\+\s*1\b|\+\+|\w+\+\+|Date\.now\(\))/.test(m[1].trim())) offenders.push(`${f}: id: ${m[1].trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
