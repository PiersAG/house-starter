// @vitest-environment node
//
// The server-to-browser data boundary (app-business-core issues 794, 763, 445;
// Matt Murphy #31: "never pass a full database row containing passwords,
// internal roles, billing tokens, or other hidden values"; "create a
// data-transfer object at each parent and child component boundary"; Matt
// Murphy #140: "audit every single one of your endpoints, strip everything the
// client does not need").
//
// Two halves, both run with the TypeScript checker (tests/unit/data-boundary-audit.ts):
//   1. THE TEMPLATE — every route answer, server-action return and client prop
//      in app/ and components/ is a DTO or written out field by field, carries
//      no internal or secret field and no whole row, and no page or route reads
//      every column.
//   2. SEEDED EXAMPLES — each way of leaking a row is written into a scratch app
//      and must be caught; the safe version of each must pass. So the audit is
//      known to find what it claims to find.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";
import { audit, bannedFieldNames, programFor, type Finding } from "./data-boundary-audit";

const ROOT = join(__dirname, "..", "..");
const SCRATCH = join(ROOT, "node_modules", ".cache", `data-boundary-${process.pid}`);

const show = (f: Finding[]) => f.map((x) => `${x.file}:${x.line} ${x.what}`).join("\n");

describe("the template's server-to-browser boundary", () => {
  it("sends the browser only DTOs and fields written out by name, with nothing internal or secret", () => {
    const crossings: string[] = [];
    const findings = audit(programFor(ROOT), ROOT, crossings);
    expect(show(findings)).toBe("");
    // The audit really read the template's crossings (a silent miss is not a pass).
    expect(crossings).toEqual(
      expect.arrayContaining([
        "app/api/tenant/route.ts answer",
        "app/api/health/route.ts answer",
        "app/api/settings/[key]/route.ts answer",
        "app/login/actions.ts action-return",
        "app/dashboard/settings/page.tsx prop SettingControl.setting",
        "app/account/page.tsx prop SettingControl.setting",
        "app/reset-password/page.tsx prop ResetPasswordForm.token",
      ]),
    );
  }, 180_000);

  it("reserves the names of every secret column", () => {
    const names = bannedFieldNames();
    for (const n of ["passwordHash", "tokenHash", "codeHash", "secretCiphertext", "dbAuthToken", "stripeCustomerId", "jti", "stack"]) {
      expect(names.has(n), n).toBe(true);
    }
  });
});

// One file per way of leaking, and its safe twin.
const SEEDED: Record<string, string> = {
  "app/api/leak-row/route.ts": `
    import { NextResponse } from "next/server";
    import { catalogDb } from "@/lib/catalog";
    import { users } from "@/lib/schema";
    export async function GET() {
      const [u] = await catalogDb.select().from(users).all();
      return NextResponse.json(u);
    }`,
  "app/api/leak-field/route.ts": `
    import { NextResponse } from "next/server";
    import { catalogDb } from "@/lib/catalog";
    import { users } from "@/lib/schema";
    export async function GET() {
      const [u] = await catalogDb.select({ id: users.id, passwordHash: users.passwordHash }).from(users).all();
      return NextResponse.json({ user: { id: u.id, passwordHash: u.passwordHash } });
    }`,
  "app/api/leak-spread/route.ts": `
    import { NextResponse } from "next/server";
    import { catalogDb } from "@/lib/catalog";
    import { subscriptions } from "@/lib/schema";
    export async function GET() {
      const [s] = await catalogDb.select({ status: subscriptions.status, stripeCustomerId: subscriptions.stripeCustomerId }).from(subscriptions).all();
      return NextResponse.json({ ...s });
    }`,
  "app/api/leak-nested/route.ts": `
    import { NextResponse } from "next/server";
    import type { Tenant } from "@/lib/schema";
    declare const tenant: Tenant;
    export async function GET() {
      return NextResponse.json({ workspace: tenant });
    }`,
  "app/api/leak-dto/route.ts": `
    import { z } from "zod";
    import { defineDto, dtoJson } from "@/lib/dto";
    const Reset = defineDto({ tokenHash: z.string() });
    export async function GET() {
      return dtoJson(Reset, { tokenHash: "x" });
    }`,
  "app/api/leak-query/route.ts": `
    import { NextResponse } from "next/server";
    declare const db: { query: { users: { findFirst(a?: object): Promise<{ email: string }> } } };
    export async function GET() {
      const u = await db.query.users.findFirst();
      return NextResponse.json({ email: u.email });
    }`,
  "app/leak-action/actions.ts": `"use server";
    import type { User } from "@/lib/schema";
    declare const row: User;
    export async function loadMe() {
      return row;
    }`,
  "components/LeakCard.tsx": `"use client";
    import type { User } from "@/lib/schema";
    export function LeakCard({ user }: { user: User }) {
      return <p>{user.email}</p>;
    }`,
  "app/leak-page/page.tsx": `
    import { LeakCard } from "@/components/LeakCard";
    import type { User } from "@/lib/schema";
    declare const row: User;
    export default function Page() {
      const props = { user: row };
      return <div><LeakCard user={row} /><LeakCard {...props} /></div>;
    }`,
};

const SAFE: Record<string, string> = {
  "app/api/safe-row/route.ts": `
    import { NextResponse } from "next/server";
    import { catalogDb } from "@/lib/catalog";
    import { users } from "@/lib/schema";
    export async function GET() {
      const [u] = await catalogDb.select({ id: users.id, email: users.email }).from(users).all();
      return NextResponse.json({ user: { id: u.id, email: u.email }, codes: ["a", "b"], ok: true });
    }`,
  "app/api/safe-dto/route.ts": `
    import { z } from "zod";
    import { defineDto, dtoJson } from "@/lib/dto";
    import type { User } from "@/lib/schema";
    declare const row: User;
    const Me = defineDto({ id: z.string(), email: z.string() });
    export async function GET() {
      return dtoJson(Me, row);
    }`,
  "components/SafeCard.tsx": `"use client";
    export function SafeCard({ user, count }: { user: { email: string }; count: number }) {
      return <p>{user.email} {count}</p>;
    }`,
  "app/safe-page/page.tsx": `
    import { z } from "zod";
    import { SafeCard } from "@/components/SafeCard";
    import { defineDto } from "@/lib/dto";
    import type { User } from "@/lib/schema";
    declare const row: User;
    const Card = defineDto({ email: z.string() });
    export default function Page() {
      return <div><SafeCard user={Card.from(row)} count={1} /><SafeCard user={{ email: row.email }} count={2} /></div>;
    }`,
};

describe("the audit catches every seeded leak and passes the safe versions", () => {
  let findings: Finding[] = [];

  beforeAll(() => {
    rmSync(SCRATCH, { recursive: true, force: true });
    const files = { ...SEEDED, ...SAFE };
    for (const [rel, src] of Object.entries(files)) {
      const at = join(SCRATCH, rel);
      mkdirSync(dirname(at), { recursive: true });
      writeFileSync(at, src);
    }
    const base = programFor(ROOT, []).getCompilerOptions();
    const program = ts.createProgram({
      rootNames: Object.keys(files).map((r) => join(SCRATCH, r)),
      options: { ...base, baseUrl: ROOT, paths: { "@/*": [join(SCRATCH, "*"), join(ROOT, "*")] } },
    });
    findings = audit(program, SCRATCH);
  }, 180_000);

  afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

  const at = (file: string) => findings.filter((f) => f.file === file).map((f) => f.what).join("\n");

  it("a whole row returned from a route", () => {
    const f = at("app/api/leak-row/route.ts");
    expect(f).toMatch(/select\(\) with no field list/);
    expect(f).toMatch(/whole users row/);
    expect(f).toMatch(/passwordHash reaches the browser/);
    expect(f).toMatch(/neither a DTO/);
  });

  it("a secret field written out by name", () => {
    expect(at("app/api/leak-field/route.ts")).toMatch(/user\.passwordHash reaches the browser/);
  });

  it("a row spread into the answer", () => {
    const f = at("app/api/leak-spread/route.ts");
    expect(f).toMatch(/spreads another object/);
    expect(f).toMatch(/stripeCustomerId reaches the browser/);
  });

  it("a row one level down", () => {
    const f = at("app/api/leak-nested/route.ts");
    expect(f).toMatch(/workspace is a whole tenants row/);
    expect(f).toMatch(/workspace\.dbAuthToken reaches the browser/);
  });

  it("a DTO that names a secret field", () => {
    expect(at("app/api/leak-dto/route.ts")).toMatch(/tokenHash reaches the browser/);
  });

  it("a query that reads every column", () => {
    expect(at("app/api/leak-query/route.ts")).toMatch(/findFirst\(\) without `columns`/);
  });

  it("a server action that returns a row", () => {
    expect(at("app/leak-action/actions.ts")).toMatch(/whole users row/);
  });

  it("a client component typed by the schema, given a row, or given spread props", () => {
    expect(at("components/LeakCard.tsx")).toMatch(/imports the database schema/);
    const page = at("app/leak-page/page.tsx");
    expect(page).toMatch(/user is a whole users row/);
    expect(page).toMatch(/user\.passwordHash reaches the browser/);
    expect(page).toMatch(/props spread into a client component/);
  });

  it("finds nothing in the safe versions", () => {
    const safe = findings.filter((f) => Object.keys(SAFE).includes(f.file));
    expect(show(safe)).toBe("");
  });
});
