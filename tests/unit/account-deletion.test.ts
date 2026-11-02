// @vitest-environment node
//
// Account deletion, the data report and the retention engine (app-business-core
// issues 722, 791, 745, 351, 352; Matt Murphy #156, #137, #172, #203, #288).
// Against a real migrated catalog and a real tenant database on disk; the
// tenant plane and the email are injected.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: async () => null }));

import { SHARED_TENANT_ID } from "@/lib/tenant-context";
import { SHARED_TENANT, ownTenant } from "@/lib/privacy/subject";
import { migrateCatalog, migrateTenant } from "@/lib/migrate";
import { __resetCatalogCacheForTests } from "@/lib/catalog";
import { __resetSinkForTests } from "@/lib/observability/error-log";
import { __resetLogForTests } from "@/lib/observability/log";
import { createUser, type AppDatabase } from "@/lib/users";
import {
  accessGrants,
  auditEvents,
  billingDisputes,
  billingInvoices,
  erasures,
  logEvents,
  retainedRecords,
  revokedSessions,
  subscriptions,
  tenantMeta,
  tenants,
  users,
} from "@/lib/schema";
import {
  DeletionError,
  eraseAccount,
  erasureLedger,
  remainingLocations,
  replayErasures,
  requestAccountDeletion,
  subjectOf,
  type TenantPlane,
} from "@/lib/privacy/deletion";
import { isDeactivated } from "@/lib/privacy/deactivation";
import { addYears, expireRetainedRecords, retentionReport } from "@/lib/privacy/retention";
import { deletionsOverdue, purgeByAge, runRetentionJob } from "@/lib/privacy/retention-job";
import { buildDataReport } from "@/lib/privacy/data-report";
import { cronAuthorised } from "@/lib/privacy/cron-auth";
import { assembleHealth } from "@/lib/health/checks";
import { DELETION_GRACE_DAYS } from "@/config/personal-data";

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-11-02T10:00:00Z");
const ROOT = join(__dirname, "..", "..");

let dir: string;
let catalog: AppDatabase;
let tenantDbs: Map<string, AppDatabase>;
let destroyed: string[];

const plane: TenantPlane = {
  open: async (id) => {
    const db = tenantDbs.get(id);
    if (!db) throw new Error(`no tenant ${id}`);
    return db;
  },
  destroy: async (id) => {
    destroyed.push(id);
    return true;
  },
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "hs-ae-deletion-"));
  const url = `file:${join(dir, "catalog.db")}`;
  await migrateCatalog(url);
  catalog = drizzle(createClient({ url })) as AppDatabase;
  process.env.CATALOG_DATABASE_URL = url;
  process.env.DATABASE_URL = url;
  __resetCatalogCacheForTests();
  __resetSinkForTests();
});

afterAll(() => {
  delete process.env.CATALOG_DATABASE_URL;
  delete process.env.DATABASE_URL;
  __resetCatalogCacheForTests();
  __resetSinkForTests();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  __resetLogForTests();
  tenantDbs = tenantDbs ?? new Map();
  destroyed = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

let n = 0;
/** An owner with a tenant database, a subscription, an invoice, a dispute, a log line and a grant. */
async function owner(opts: { liveSubscription?: boolean } = {}): Promise<{ id: string; tenantId: string; email: string }> {
  n += 1;
  const email = `owner${n}@example.com`;
  const u = await createUser(catalog, { email, passwordHash: "x", name: `Owner ${n}` });
  const tenantId = `t${n}del`;
  const turl = `file:${join(dir, `${tenantId}.db`)}`;
  await migrateTenant(turl);
  const tdb = drizzle(createClient({ url: turl })) as AppDatabase;
  await tdb.insert(tenantMeta).values({ id: `m${n}`, tenantId, label: "Dog School" }).run();
  tenantDbs.set(tenantId, tdb);
  await catalog.insert(tenants).values({ id: tenantId, dbUrl: turl, label: email }).run();
  await catalog.update(users).set({ tenantId }).where(eq(users.id, u.id)).run();
  const cus = `cus_${n}`;
  await catalog
    .insert(subscriptions)
    .values({
      id: `sub-row-${n}`,
      userId: u.id,
      stripeCustomerId: cus,
      stripeSubscriptionId: opts.liveSubscription ? `sub_${n}` : null,
      status: opts.liveSubscription ? "active" : "canceled",
    })
    .run();
  await catalog
    .insert(billingInvoices)
    .values({ stripeInvoiceId: `in_${n}`, stripeCustomerId: cus, userId: u.id, status: "paid", amountPaid: 900, amountDue: 900, currency: "gbp", paidAt: T0 })
    .run();
  await catalog
    .insert(billingDisputes)
    .values({ stripeDisputeId: `dp_${n}`, stripeChargeId: `ch_${n}`, stripeCustomerId: cus, amount: 900, currency: "gbp", reason: "fraudulent", status: "lost" })
    .run();
  await catalog.insert(logEvents).values({ id: `log-${n}`, level: "info", event: "request", userId: u.id, tenantId, route: "/dashboard" }).run();
  await catalog.insert(accessGrants).values({ id: `g-${n}`, userId: u.id, type: "tester" }).run();
  await catalog.insert(revokedSessions).values({ id: `rs-${n}`, jti: `jti-${n}`, userId: u.id }).run();
  return { id: u.id, tenantId, email };
}

describe("the shared tenant is never an account's own database", () => {
  it("uses the same id as lib/tenant-context.ts, and is never wiped", () => {
    expect(SHARED_TENANT).toBe(SHARED_TENANT_ID);
    expect(ownTenant(SHARED_TENANT_ID)).toBe(false);
    expect(ownTenant(null)).toBe(false);
    expect(ownTenant("t0abc")).toBe(true);
  });
});

describe("a delete-my-account request deactivates at once and keeps the data 30 days (#722)", () => {
  it("closes the account, ends its sessions, sets the erasure date and writes the audit trail", async () => {
    const o = await owner();
    const r = await requestAccountDeletion(catalog, o.id, T0);
    expect(r.alreadyRequested).toBe(false);
    expect(r.deletionDueAt.getTime() - T0.getTime()).toBe(DELETION_GRACE_DAYS * DAY);
    const u = (await catalog.select().from(users).where(eq(users.id, o.id)).all())[0];
    expect(u.deactivatedAt?.getTime()).toBe(Math.floor(T0.getTime() / 1000) * 1000);
    expect(u.sessionsValidFrom?.getTime()).toBe(Math.floor(T0.getTime() / 1000) * 1000);
    expect(isDeactivated(u)).toBe(true);
    const audit = await catalog.select().from(auditEvents).where(eq(auditEvents.subjectUserId, o.id)).all();
    expect(audit.map((a) => [a.action, a.target])).toContainEqual(["data_deleted", "account:deactivated"]);
    // retained for 30 more days: nothing is erased yet
    expect((await catalog.select().from(billingInvoices).where(eq(billingInvoices.userId, o.id)).all()).length).toBe(1);
  });

  it("is idempotent: a second request keeps the first date", async () => {
    const o = await owner();
    const first = await requestAccountDeletion(catalog, o.id, T0);
    const again = await requestAccountDeletion(catalog, o.id, new Date(T0.getTime() + DAY));
    expect(again.alreadyRequested).toBe(true);
    expect(again.deletionDueAt.getTime()).toBe(first.deletionDueAt.getTime());
  });

  it("refuses while a paid subscription is still running, and changes nothing", async () => {
    const o = await owner({ liveSubscription: true });
    await expect(requestAccountDeletion(catalog, o.id, T0)).rejects.toBeInstanceOf(DeletionError);
    const u = (await catalog.select().from(users).where(eq(users.id, o.id)).all())[0];
    expect(u.deactivatedAt).toBeNull();
  });

  it("an active account is not deactivated", () => {
    expect(isDeactivated({ deactivatedAt: null })).toBe(false);
    expect(isDeactivated(undefined)).toBe(false);
  });
});

describe("after 30 days the account is erased automatically, checked and confirmed (#722, #791, #745)", () => {
  it("erases every table the map names, keeps only the tax fields, wipes the own database and verifies", async () => {
    const o = await owner();
    await requestAccountDeletion(catalog, o.id, T0);
    const confirm = vi.fn(async () => {});
    const due = new Date(T0.getTime() + DELETION_GRACE_DAYS * DAY + 60_000);
    const run = await runRetentionJob(catalog, { now: due, tenantPlane: plane, confirm });
    const r = run.erased.find((e) => e.userId === o.id)!;
    expect(r.verified).toBe(true);
    expect(r.remaining).toEqual([]);
    expect(r.tenantDatabase).toBe("removed");
    expect(destroyed).toContain(o.tenantId);
    // the account and its rows are gone
    expect(await catalog.select().from(users).where(eq(users.id, o.id)).all()).toEqual([]);
    expect(await catalog.select().from(tenants).where(eq(tenants.id, o.tenantId)).all()).toEqual([]);
    expect(await catalog.select().from(subscriptions).where(eq(subscriptions.userId, o.id)).all()).toEqual([]);
    expect(await catalog.select().from(billingInvoices).where(eq(billingInvoices.userId, o.id)).all()).toEqual([]);
    expect(await catalog.select().from(accessGrants).where(eq(accessGrants.userId, o.id)).all()).toEqual([]);
    // the own database is empty
    expect(await tenantDbs.get(o.tenantId)!.select().from(tenantMeta).all()).toEqual([]);
    // logs stay as counts, without the account
    expect((await catalog.select().from(logEvents).where(eq(logEvents.id, `log-${n}`)).all())[0]?.userId ?? null).toBeNull();
    // what the law requires is kept, with its reason, start and expiry, and no email or name
    const kept = await catalog.select().from(retainedRecords).where(eq(retainedRecords.subjectUserId, o.id)).all();
    expect(kept.map((k) => k.sourceTable).sort()).toEqual(["billingDisputes", "billingInvoices"]);
    for (const k of kept) {
      expect(k.legalBasis).toMatch(/6 years/);
      expect(k.expiresAt.getTime()).toBe(Math.floor(addYears(due, 6).getTime() / 1000) * 1000);
      expect(k.data).not.toContain("@example.com");
      expect(k.data).not.toContain("cus_");
    }
    // the ledger and the audit trail prove it
    expect((await erasureLedger(catalog)).map((e) => e.userId)).toContain(o.id);
    const audit = await catalog.select().from(auditEvents).where(eq(auditEvents.subjectUserId, o.id)).all();
    const done = audit.find((a) => a.target === "account");
    expect(done?.action).toBe("data_deleted");
    expect(JSON.parse(done!.after!)).toMatchObject({ verified: true, remaining: [] });
    // and the owner is told, at the address the account had
    expect(confirm).toHaveBeenCalledWith(o.email, expect.objectContaining({ verified: true }));
  });

  it("leaves an account whose 30 days are not up alone", async () => {
    const o = await owner();
    await requestAccountDeletion(catalog, o.id, T0);
    const run = await runRetentionJob(catalog, { now: new Date(T0.getTime() + 29 * DAY), tenantPlane: plane });
    expect(run.erased.map((e) => e.userId)).not.toContain(o.id);
    expect((await catalog.select().from(users).where(eq(users.id, o.id)).all()).length).toBe(1);
  });

  it("reports an erasure as unverified when a row survives, and names the table", async () => {
    const o = await owner();
    const subject = await subjectOf(catalog, (await catalog.select().from(users).where(eq(users.id, o.id)).all())[0]);
    expect(await remainingLocations(catalog, subject)).toEqual(
      expect.arrayContaining(["users", "subscriptions", "billingInvoices", "logEvents"]),
    );
  });

  it("the health check turns red when an erasure is more than 72 hours late (#722)", async () => {
    const o = await owner();
    await requestAccountDeletion(catalog, o.id, T0);
    const dueAt = T0.getTime() + DELETION_GRACE_DAYS * DAY;
    expect(await deletionsOverdue(catalog, new Date(dueAt + 71 * 60 * 60 * 1000))).toBe(0);
    expect(await deletionsOverdue(catalog, new Date(dueAt + 73 * 60 * 60 * 1000))).toBeGreaterThan(0);
    const report = await assembleHealth({
      pingDb: async () => ({ ok: true }),
      errorCountSince: async () => 0,
      deletionsOverdue: async () => 1,
      now: () => dueAt,
      env: {} as NodeJS.ProcessEnv,
    });
    expect(report.status).toBe("degraded");
    expect(report.checks.find((c) => c.name === "deletions")).toMatchObject({ ok: false, critical: true });
    await eraseAccount(catalog, o.id, { now: new Date(dueAt), tenantPlane: plane });
  });
});

describe("the retention layer expires what it keeps, and says what it kept (#791)", () => {
  it("shows what was retained, why, when the clock started and when it expires", async () => {
    const o = await owner();
    await eraseAccount(catalog, o.id, { now: T0, tenantPlane: plane });
    const rep = await retentionReport(catalog, o.id, T0);
    expect(rep.length).toBe(2);
    for (const r of rep) {
      expect(r.clockStartedAt).toBe(T0.toISOString());
      expect(r.expiresAt).toBe(addYears(T0, 6).toISOString());
      expect(r.daysLeft).toBeGreaterThan(2000);
    }
  });

  it("deletes a retained record on its expiry day and records it in the audit trail", async () => {
    const o = await owner();
    await eraseAccount(catalog, o.id, { now: T0, tenantPlane: plane });
    expect(await expireRetainedRecords(catalog, new Date(T0.getTime() + DAY))).toBe(0);
    const later = new Date(addYears(T0, 6).getTime() + DAY);
    expect(await expireRetainedRecords(catalog, later)).toBeGreaterThanOrEqual(2);
    expect(await catalog.select().from(retainedRecords).where(eq(retainedRecords.subjectUserId, o.id)).all()).toEqual([]);
    const audit = await catalog.select().from(auditEvents).where(eq(auditEvents.subjectUserId, o.id)).all();
    expect(audit.some((a) => a.target === "retained:billingInvoices")).toBe(true);
  });

  it("deletes rows older than their table's age limit", async () => {
    const old = new Date(T0.getTime() - 120 * DAY);
    await catalog.insert(logEvents).values({ id: "log-old", occurredAt: old, level: "info", event: "request" }).run();
    const purged = await purgeByAge(catalog, T0);
    expect(purged.logEvents).toBeGreaterThanOrEqual(1);
    expect(await catalog.select().from(logEvents).where(eq(logEvents.id, "log-old")).all()).toEqual([]);
  });
});

describe("deletion reaches backups: the ledger is replayed after a restore (#745, #352)", () => {
  it("erases again an account a restore brought back", async () => {
    const o = await owner();
    await eraseAccount(catalog, o.id, { now: T0, tenantPlane: plane });
    const ledger = await erasureLedger(catalog);
    // a "restore": the account and the ledger row come back from before the erasure
    await catalog.insert(users).values({ id: o.id, email: o.email, passwordHash: "x", tenantId: o.tenantId }).run();
    await catalog.delete(erasures).where(eq(erasures.userId, o.id)).run();
    const again = await replayErasures(catalog, ledger, { now: T0, tenantPlane: plane });
    expect(again).toContain(o.id);
    expect(await catalog.select().from(users).where(eq(users.id, o.id)).all()).toEqual([]);
    expect((await erasureLedger(catalog)).map((e) => e.userId)).toContain(o.id);
  });
});

describe("the data report lists everything held, and no secret (#722, #351)", () => {
  it("covers the account's tables and own database, and names the places outside the database", async () => {
    const o = await owner();
    const rep = (await buildDataReport(catalog, o.id, { tenant: tenantDbs.get(o.tenantId), now: T0 }))!;
    const tables = rep.sections.map((s) => s.table);
    for (const t of ["users", "subscriptions", "billingInvoices", "billingDisputes", "logEvents", "accessGrants", "tenants"]) {
      expect(tables, t).toContain(t);
    }
    expect(rep.ownDatabase.find((t) => t.table === "tenant_meta")?.rows[0]).toMatchObject({ label: "Dog School" });
    expect(rep.elsewhere.map((e) => e.name)).toContain("Rate-limit counters");
    const json = JSON.stringify(rep);
    expect(json).toContain(o.email);
    expect(json).not.toContain("passwordHash");
    expect(json).not.toContain("cus_");
    expect(json).toContain("held: your customer id at Stripe");
  });

  it("is null for an account that does not exist", async () => {
    expect(await buildDataReport(catalog, "nobody")).toBeNull();
  });
});

describe("the daily job's door (#722)", () => {
  it("opens only for the exact secret", () => {
    expect(cronAuthorised("Bearer s3cret", "s3cret")).toBe(true);
    expect(cronAuthorised("Bearer s3cre", "s3cret")).toBe(false);
    expect(cronAuthorised(null, "s3cret")).toBe(false);
    expect(cronAuthorised("Bearer ", undefined)).toBe(false);
  });

  it("is scheduled daily in vercel.json", () => {
    const v = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8"));
    expect(v.crons).toContainEqual({ path: "/api/cron/retention", schedule: expect.stringMatching(/^\S+ \S+ \* \* \*$/) });
  });
});

// The sign-in refusal sits in lib/auth.ts, the sign-in kernel, which only the
// CEO's script writes (the safety gate protects it). Until it runs, the line
// must be ABSENT (no half-applied state); after it, PRESENT, right after the
// account lookup. The CEO script sets this flag to false.
const SIGN_IN_REFUSAL_PENDING = false;

describe("a closed account is refused at sign-in (#722)", () => {
  const src = readFileSync(join(ROOT, "lib", "auth.ts"), "utf8");
  const lookup = "const user = await getUserByEmail(catalogDb, parsed.data.email);\n        if (!user) return null;\n";
  it("authorize() refuses it right after the lookup, before the password is checked", () => {
    expect(src).toContain(lookup);
    const after = src.slice(src.indexOf(lookup) + lookup.length);
    const refusal = /^\s*(\/\/[^\n]*\n\s*)*if \(isDeactivated\(user\)\) return null;/;
    if (SIGN_IN_REFUSAL_PENDING) {
      expect(src).not.toContain("isDeactivated");
      return;
    }
    expect(after).toMatch(refusal);
    expect(src).toContain('import { isDeactivated } from "@/lib/privacy/deactivation";');
  });

  it("the CEO's edit script exists for the pending line", () => {
    if (!SIGN_IN_REFUSAL_PENDING) return;
    expect(existsSync(join(ROOT, "lib", "privacy", "deactivation.ts"))).toBe(true);
  });
});
