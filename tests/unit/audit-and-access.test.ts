// @vitest-environment node
//
// #796 — the audit trail of sensitive customer actions (Matt Murphy #126: "no
// audit trail on sensitive actions users upgrading plans changing e-mail
// addresses deleting data modifying permissions none of it is logged").
// #806 — runtime detection of cross-tenant exposure and an access log that can
// say "how long is this happening for, who else could have seen my data"
// (Matt Murphy #171), with the alert raised the same moment.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));

import { migrateCatalog, runMigrations } from "@/lib/migrate";
import { __resetCatalogCacheForTests } from "@/lib/catalog";
import { __resetSinkForTests, sinkClient } from "@/lib/observability/error-log";
import { __resetLogForTests, flushLogs } from "@/lib/observability/log";
import { noteRequestUser, runWithRequest } from "@/lib/observability/request-context";
import { auditHistory, recordAuditEvent, AUDIT_ACTIONS } from "@/lib/audit/trail";
import { changeUserEmail, EmailChangeError } from "@/lib/account/email";
import { setUserRole } from "@/lib/account/roles";
import { appendRecordEvent } from "@/lib/records/history";
import {
  crossTenantCountSince,
  noteTenantAccess,
  tenantAccessReport,
} from "@/lib/tenant/access-log";
import { assembleHealth } from "@/lib/health/checks";
import { createUser, type AppDatabase } from "@/lib/users";

let workDir: string;
let catalogUrl: string;
let catalog: AppDatabase;
let raw: ReturnType<typeof createClient>;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "hs-s12-audit-"));
  catalogUrl = `file:${join(workDir, "catalog.db")}`;
  await migrateCatalog(catalogUrl);
  raw = createClient({ url: catalogUrl });
  catalog = drizzle(raw) as AppDatabase;
  process.env.CATALOG_DATABASE_URL = catalogUrl;
  process.env.DATABASE_URL = catalogUrl;
  __resetCatalogCacheForTests();
  __resetSinkForTests();
});

afterAll(() => {
  delete process.env.CATALOG_DATABASE_URL;
  delete process.env.DATABASE_URL;
  __resetCatalogCacheForTests();
  __resetSinkForTests();
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  __resetLogForTests();
  authMock.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

async function rows(table: string, where = "1=1"): Promise<Record<string, unknown>[]> {
  const res = await raw.execute(`SELECT * FROM ${table} WHERE ${where} ORDER BY occurred_at, rowid`);
  return res.rows as unknown as Record<string, unknown>[];
}

describe("#796 audit trail", () => {
  it("names the four sensitive actions of Matt Murphy #126", () => {
    expect([...AUDIT_ACTIONS]).toEqual([
      "plan_changed",
      "email_changed",
      "data_deleted",
      "permissions_changed",
    ]);
  });

  it("records who, whose account, what changed from and to, when, and the request id", async () => {
    await runWithRequest({ requestId: "req-audit-0001" }, () =>
      recordAuditEvent(
        {
          action: "plan_changed",
          actor: "system",
          subjectUserId: "u-plan",
          target: "subscription",
          before: { status: "trialing", priceId: "price_basic" },
          after: { status: "active", priceId: "price_pro" },
        },
        catalog,
      ),
    );
    const [row] = await rows("audit_events", "subject_user_id = 'u-plan'");
    expect(row).toMatchObject({
      action: "plan_changed",
      actor: "system",
      target: "subscription",
      request_id: "req-audit-0001",
    });
    expect(JSON.parse(String(row.after))).toEqual({ status: "active", priceId: "price_pro" });
    expect(Number(row.occurred_at)).toBeGreaterThan(0);
    const history = await auditHistory("u-plan", { db: catalog });
    expect(history).toHaveLength(1);
  });

  it("is append-only: the database refuses UPDATE and DELETE", async () => {
    await expect(raw.execute("UPDATE audit_events SET actor = 'someone-else'")).rejects.toThrow(
      /append-only/,
    );
    await expect(raw.execute("DELETE FROM audit_events")).rejects.toThrow(/append-only/);
  });

  it("an email change is audited with the old and new address", async () => {
    const u = await createUser(catalog, { email: "old@example.com", passwordHash: "x" } as never);
    await changeUserEmail(catalog, u.id, "New@Example.com", u.id);
    const [row] = await rows("audit_events", `subject_user_id = '${u.id}' AND action = 'email_changed'`);
    expect(row).toMatchObject({ actor: u.id, target: "email", before: "old@example.com", after: "new@example.com" });
    await expect(changeUserEmail(catalog, u.id, "not-an-email", u.id)).rejects.toBeInstanceOf(EmailChangeError);
    const other = await createUser(catalog, { email: "taken@example.com", passwordHash: "x" } as never);
    await expect(changeUserEmail(catalog, other.id, "new@example.com", "operator")).rejects.toThrow(
      /already in use/,
    );
    await expect(changeUserEmail(catalog, "missing", "a@example.com", "operator")).rejects.toThrow(
      /No such account/,
    );
    await changeUserEmail(catalog, u.id, "new@example.com", u.id); // no change → no row
    expect(await rows("audit_events", `subject_user_id = '${u.id}'`)).toHaveLength(1);
  });

  it("a role change is audited as permissions_changed; an unchanged role writes nothing", async () => {
    const u = await createUser(catalog, { email: "role@example.com", passwordHash: "x" } as never);
    expect(await setUserRole(catalog, u.id, "owner", "operator")).toBe(true);
    expect(await setUserRole(catalog, "missing", "owner", "operator")).toBe(false);
    await expect(setUserRole(catalog, u.id, "admin" as never, "operator")).rejects.toThrow(/unknown role/);
    expect(await rows("audit_events", `subject_user_id = '${u.id}'`)).toHaveLength(0);
  });

  it("deleting customer data through the record history writes data_deleted", async () => {
    const tenantClient = createClient({ url: `file:${join(workDir, "tenant-a.db")}` });
    await runMigrations(tenantClient, { role: "tenant" });
    const tenantDb = drizzle(tenantClient) as AppDatabase;
    await runWithRequest({ requestId: "req-delete-001" }, async () => {
      noteRequestUser("u-del", "tenant-a");
      await appendRecordEvent(tenantDb, {
        entity: "setting",
        entityKey: "theme:owner:",
        version: 0,
        action: "deleted",
        data: null,
        actor: "u-del",
      });
    });
    const [row] = await rows("audit_events", "action = 'data_deleted'");
    expect(row).toMatchObject({
      actor: "u-del",
      subject_user_id: "u-del",
      tenant_id: "tenant-a",
      target: "setting:theme:owner:",
      request_id: "req-delete-001",
    });
  });

  it("a failed audit write never throws into the action", async () => {
    const broken = drizzle(createClient({ url: ":memory:" })) as AppDatabase;
    expect(
      await recordAuditEvent({ action: "data_deleted", actor: "system", target: "x" }, broken),
    ).toBe(false);
  });
});

describe("#806 tenant access log and cross-tenant detection", () => {
  it("records each tenant opened once per request, with who and from which tenant", async () => {
    await runWithRequest({ requestId: "req-access-01", route: "/api/tenant" }, async () => {
      noteRequestUser("u-a", "tenant-a");
      await noteTenantAccess("tenant-a", { db: catalog });
      await noteTenantAccess("tenant-a", { db: catalog });
    });
    const got = await rows("tenant_access_events", "request_id = 'req-access-01'");
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      tenant_id: "tenant-a",
      session_tenant_id: "tenant-a",
      user_id: "u-a",
      route: "/api/tenant",
      cross_tenant: 0,
    });
  });

  it("reads the session when the request has not said who the caller is", async () => {
    authMock.mockResolvedValue({ user: { id: "u-s", tenantId: "tenant-s" } });
    await runWithRequest({ requestId: "req-access-02" }, () => noteTenantAccess("tenant-s", { db: catalog }));
    const [row] = await rows("tenant_access_events", "request_id = 'req-access-02'");
    expect(row).toMatchObject({ user_id: "u-s", session_tenant_id: "tenant-s", cross_tenant: 0 });
  });

  it("outside a request (a script) nothing is recorded", async () => {
    const before = (await rows("tenant_access_events")).length;
    await noteTenantAccess("tenant-a", { db: catalog });
    expect(await rows("tenant_access_events")).toHaveLength(before);
  });

  it("a caller from tenant B opening tenant A's data is detected and alerted at once", async () => {
    expect(await crossTenantCountSince(Date.now() - 60_000, catalog)).toBe(0);
    await runWithRequest({ requestId: "req-cross-001", route: "/api/leaky", method: "GET" }, async () => {
      noteRequestUser("u-b", "tenant-b");
      await noteTenantAccess("tenant-a", { db: catalog });
    });
    await flushLogs();
    const [row] = await rows("tenant_access_events", "request_id = 'req-cross-001'");
    expect(row).toMatchObject({ tenant_id: "tenant-a", session_tenant_id: "tenant-b", user_id: "u-b", cross_tenant: 1 });
    // the alert: an error-level structured line, and an error row the health check counts
    const line = vi.mocked(console.error).mock.calls.map((c) => String(c[0])).find((l) => l.includes("cross_tenant_access"));
    expect(line && JSON.parse(line)).toMatchObject({ level: "error", event: "cross_tenant_access", tenant_id: "tenant-b" });
    const err = await sinkClient()!.execute("SELECT message, request_id FROM error_events WHERE request_id = 'req-cross-001'");
    expect(String(err.rows[0].message)).toContain("cross-tenant access");
    expect(await crossTenantCountSince(Date.now() - 60_000, catalog)).toBe(1);
    // and /api/health fails its tenant_isolation check, so the prober raises it
    const report = await assembleHealth({
      pingDb: async () => ({ ok: true }),
      errorCountSince: async () => 1,
      crossTenantCountSince: (ms) => crossTenantCountSince(ms, catalog),
      now: () => Date.now(),
      env: {} as NodeJS.ProcessEnv,
    });
    expect(report.status).toBe("degraded");
    expect(report.checks.find((c) => c.name === "tenant_isolation")).toEqual({
      name: "tenant_isolation",
      ok: false,
      critical: true,
      detail: "cross-tenant access detected",
    });
  });

  it("answers how long it was happening and who else could have seen the data", async () => {
    const report = await tenantAccessReport("tenant-a", { db: catalog, since: new Date(0), until: new Date(Date.now() + 60_000) });
    expect(report.exposure?.requests).toBe(1);
    expect(report.exposure!.first.getTime()).toBeLessThanOrEqual(report.exposure!.last.getTime());
    const outsiders = report.accessors.filter((a) => a.crossTenant);
    expect(outsiders).toEqual([
      expect.objectContaining({ userId: "u-b", sessionTenantId: "tenant-b", requests: 1 }),
    ]);
    expect(report.accessors.find((a) => a.userId === "u-a")).toMatchObject({ crossTenant: false, requests: 1 });
    const clean = await tenantAccessReport("tenant-s", { db: catalog });
    expect(clean.exposure).toBeNull();
  });

  it("a failed write never throws into the request", async () => {
    const broken = drizzle(createClient({ url: ":memory:" })) as AppDatabase;
    await runWithRequest({ requestId: "req-broken-01" }, () =>
      noteTenantAccess("tenant-a", { db: broken, caller: { userId: null, tenantId: null } }),
    );
    expect(console.error).toHaveBeenCalled();
  });
});
