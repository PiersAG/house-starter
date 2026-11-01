// Server-side input validation (app-business-core issues 442, 517, 758).
//
// lib/validation/input.ts is the one set of field rules every write path uses —
// the server actions, the API routes and registerUser. These tests hold each
// requirement: type, format and length checked before business logic; strings
// cleaned; unexpected fields stripped; names refuse markup and links; and a
// caller that skips its own schema is still refused by registerUser.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import type { Client } from "@libsql/client";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createMigrationDatabase, runMigrations } from "@/lib/migrate";
import { RegistrationError, getUserByEmail, registerUser, type AppDatabase } from "@/lib/users";
import {
  MAX_EMAIL_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PASSWORD_LENGTH,
  cleanText,
  emailField,
  idField,
  nameField,
  nameProblem,
  newPasswordField,
  optionalNameField,
  parseForm,
  parseQuery,
  textField,
  tokenField,
} from "@/lib/validation/input";

/** Hostile values a name or text field must never carry into an email or page. */
export const HOSTILE_TEXT = [
  "<script>alert(1)</script>",
  "&lt;script&gt;alert(1)&lt;/script&gt;",
  "<a href=\"https://evil.example\">Log in</a>",
  "https://evil.example/login",
  "www.evil.example",
  "Click here: evil.com",
  "javascript:alert(1)",
  "<img src=x onerror=alert(1)>",
  "Bob\" onmouseover=\"alert(1)",
  "{{7*7}}",
  "${process.env.SECRET}",
  "Ann <b>Smith</b>",
  "admin@evil.example",
];

describe("cleanText — every string is cleaned before processing", () => {
  it("normalises, strips control and invisible characters, trims", () => {
    expect(cleanText("  Amélie\u0000​  ")).toBe("Amélie");
    expect(cleanText("a‮b")).toBe("ab");
    expect(cleanText("line one\nline two")).toBe("line one line two");
    expect(cleanText("line one\nline two", { multiline: true })).toBe("line one\nline two");
  });
});

describe("field rules — type, format and length, rejected not repaired", () => {
  it("text fields reject over-long and wrong-typed values", () => {
    const f = textField({ max: 5 });
    expect(f.safeParse("abcde").success).toBe(true);
    expect(f.safeParse("abcdef").success).toBe(false);
    expect(f.safeParse(42).success).toBe(false);
    expect(f.safeParse(["a"]).success).toBe(false);
  });

  it("emails: valid format, lower-cased, at most 254 characters", () => {
    expect(emailField.parse("  Owner@Example.COM ")).toBe("owner@example.com");
    for (const bad of ["", "not-an-email", "a@", "@b.com", "a b@c.com", "<a@b.com>", "a@b.com\r\nBcc: x@y.com"]) {
      expect(emailField.safeParse(bad).success, bad).toBe(false);
    }
    const long = `${"a".repeat(MAX_EMAIL_LENGTH)}@example.com`;
    expect(emailField.safeParse(long).success).toBe(false);
  });

  it("new passwords: the policy minimum, and a maximum before hashing", () => {
    expect(newPasswordField.safeParse("short").success).toBe(false);
    expect(newPasswordField.safeParse("long enough").success).toBe(true);
    expect(newPasswordField.safeParse("x".repeat(MAX_PASSWORD_LENGTH + 1)).success).toBe(false);
    // never altered: surrounding spaces are part of the password
    expect(newPasswordField.parse("  spaced pass  ")).toBe("  spaced pass  ");
  });

  it("names accept real names in any script", () => {
    for (const ok of ["Ann Smith", "Siobhán O'Neill", "Jean-Luc Picard", "Dr. J. R. Smith", "李小龍", "Zoë Saldaña", "Ann’s Dog Training"]) {
      expect(nameProblem(cleanText(ok)), ok).toBeNull();
    }
  });

  it("names refuse HTML, encoded markup, script, links and email addresses", () => {
    for (const bad of HOSTILE_TEXT) {
      expect(nameField.safeParse(bad).success, bad).toBe(false);
    }
    expect(nameField.safeParse("a".repeat(MAX_NAME_LENGTH + 1)).success).toBe(false);
  });

  it("an empty optional name is absent, not an empty string", () => {
    expect(optionalNameField.parse("   ")).toBeNull();
    expect(optionalNameField.parse(undefined)).toBeNull();
    expect(optionalNameField.parse(" Ann ")).toBe("Ann");
  });

  it("ids are random UUIDs; sequential numbers are refused", () => {
    expect(idField.safeParse(crypto.randomUUID()).success).toBe(true);
    for (const bad of ["1", "42", "0001", "1 OR 1=1", "' OR '1'='1"]) {
      expect(idField.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("tokens are URL-safe and bounded", () => {
    expect(tokenField.safeParse("A".repeat(43)).success).toBe(true);
    for (const bad of ["short", "a".repeat(600), `${"a".repeat(30)}' OR 1=1--`, `${"a".repeat(30)}<x>`]) {
      expect(tokenField.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe("parseForm — the shape of every request before business logic", () => {
  const schema = z.object({ email: emailField, name: optionalNameField });

  function form(entries: Record<string, string | Blob>): FormData {
    const fd = new FormData();
    for (const [k, v] of Object.entries(entries)) fd.append(k, v);
    return fd;
  }

  it("strips unexpected fields: role, plan, permissions, account status, isAdmin, tenantId", () => {
    const r = parseForm(
      schema,
      form({
        email: "a@b.com",
        name: "Ann",
        role: "admin",
        plan: "enterprise",
        permissions: "*",
        accountStatus: "active",
        isAdmin: "true",
        tenantId: "someone-else",
        $ACTION_ID_abc: "",
      }),
    );
    expect(r).toEqual({ ok: true, data: { email: "a@b.com", name: "Ann" } });
  });

  it("rejects a missing field and a wrong type", () => {
    expect(parseForm(schema, form({ name: "Ann" })).ok).toBe(false);
    const r = parseForm(schema, form({ email: new Blob(["x"]) }));
    expect(r).toEqual({ ok: false, error: "Unexpected file in the form." });
  });

  it("takes the first value of a repeated field", () => {
    const fd = form({ email: "first@b.com" });
    fd.append("email", "second@b.com");
    expect(parseForm(schema, fd)).toEqual({ ok: true, data: { email: "first@b.com", name: null } });
  });
});

describe("parseQuery — query-string values are validated too (issue 517)", () => {
  const schema = z.object({ scope: z.enum(["owner", "client"]).default("owner") });

  it("accepts known values and strips unknown keys", () => {
    expect(parseQuery(schema, new URLSearchParams("scope=client&x=1"))).toEqual({ ok: true, data: { scope: "client" } });
    expect(parseQuery(schema, { scope: ["owner", "client"] })).toEqual({ ok: true, data: { scope: "owner" } });
  });

  it("rejects crafted and boundary-length values instead of sanitising them", () => {
    for (const bad of ["owner' OR '1'='1", "owner;--", "x".repeat(10_000), "owner\u0000", "%27"]) {
      expect(parseQuery(schema, new URLSearchParams({ scope: bad })).ok, bad).toBe(false);
    }
  });
});

describe("registerUser — the same rules even when a caller skipped its schema", () => {
  let client: Client;
  let db: AppDatabase;
  beforeEach(async () => {
    client = createMigrationDatabase(":memory:");
    await runMigrations(client);
    db = drizzle(client) as AppDatabase;
  });
  afterEach(() => client.close());

  it("refuses a name carrying markup or a link, and stores nothing", async () => {
    for (const name of HOSTILE_TEXT) {
      await expect(registerUser(db, { email: "x@example.com", password: "long enough pw", name })).rejects.toBeInstanceOf(
        RegistrationError,
      );
    }
    expect(await getUserByEmail(db, "x@example.com")).toBeUndefined();
  });

  it("refuses a malformed email and an over-long password", async () => {
    await expect(registerUser(db, { email: "nope", password: "long enough pw" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      registerUser(db, { email: "y@example.com", password: "x".repeat(MAX_PASSWORD_LENGTH + 1) }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("stores a valid account with its cleaned name", async () => {
    const user = await registerUser(db, { email: "Z@Example.com", password: "long enough pw", name: "  Zoë  " });
    expect(user.email).toBe("z@example.com");
    expect(user.name).toBe("Zoë");
  });
});

// The template's own server actions: each one that takes FormData parses it
// against a schema (parseForm) before reading any field. The factory's gate
// rule (factory.server-action-without-schema-validation) enforces the same on
// every generated feature; this keeps the template itself honest.
describe("every server action in the template parses its form", () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
    });
  }

  it("no action reads formData.get() directly", () => {
    const offenders: string[] = [];
    for (const f of files("app")) {
      const src = readFileSync(f, "utf8");
      if (!/["']use server["']/.test(src) || !/:\s*FormData/.test(src)) continue;
      if (/formData\.get\(/.test(src.replace(/submittedCode\(formData\.get\("code"\)\)/g, ""))) offenders.push(f);
      if (!/parseForm\(/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
