// Tenant database credentials that expire, read-only credentials, the app's own
// Turso group, and the credential audit log (#746, #756, #439).
//
// The Turso platform API is stubbed at fetch: these tests check what the app
// ASKS Turso for (a one-hour token, a read-only token, a database in its own
// group) and what it records, not Turso itself.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createClient } from "@libsql/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetCatalogCacheForTests } from "@/lib/catalog";
import { MFA_KEY_ENV } from "@/lib/crypto/secret-box";
import { __resetDbCacheForTests, getDb, resolveTenant } from "@/lib/db";
import { migrateCatalog } from "@/lib/migrate";
import {
  FileTenantProvisioner,
  TursoTenantProvisioner,
  expiryOf,
  provisionTenant,
} from "@/lib/tenant/provisioner";
import {
  SHORT_LIVED_EXPIRATION,
  __resetHeldTokensForTests,
  credentialMode,
  shortLivedTenantToken,
} from "@/lib/tenant/db-credentials";
import { recordCredentialEvent } from "@/lib/credential-audit";

const KEYS = [
  "CATALOG_DATABASE_URL",
  "TENANT_PROVISIONER",
  "TENANT_DB_DIR",
  "TENANT_DB_CREDENTIALS",
  "TURSO_API_TOKEN",
  "TURSO_ORG",
  "TURSO_GROUP",
  "APP_SLUG",
  "VERCEL_ENV",
  "TENANCY_MODE",
  MFA_KEY_ENV,
];
const saved: Record<string, string | undefined> = {};

let dir: string;
let catalogUrl: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "hs-dbcred-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(async () => {
  for (const k of KEYS) saved[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
  catalogUrl = `file:${join(dir, `cat-${randomBytes(4).toString("hex")}.db`)}`;
  await migrateCatalog(catalogUrl);
  process.env.CATALOG_DATABASE_URL = catalogUrl;
  __resetCatalogCacheForTests();
  __resetDbCacheForTests();
  __resetHeldTokensForTests();
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function events() {
  const c = createClient({ url: catalogUrl });
  try {
    const r = await c.execute(
      "SELECT event, credential, tenant_id, service, access, ip, expires_at FROM credential_events ORDER BY occurred_at, rowid",
    );
    return r.rows.map((x) => ({ ...(x as Record<string, unknown>) }));
  } finally {
    c.close();
  }
}

/** A fetch stub standing in for the Turso platform API. Records every call. */
function stubTurso() {
  const calls: { method: string; url: URL; body?: unknown }[] = [];
  let n = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (b: unknown, status = 200) =>
        new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
      if (url.pathname.endsWith("/auth/tokens")) return json({ jwt: `jwt-not-real-${++n}` });
      if (url.pathname.endsWith("/groups")) return json({ groups: [{ name: "default" }] });
      if (method === "POST" && url.pathname.endsWith("/databases"))
        return json({ database: { Hostname: "db-host.turso.io" } });
      return json({ error: "not found" }, 404);
    }),
  );
  return calls;
}

function tursoEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    TURSO_API_TOKEN: "turso-not-real",
    TURSO_ORG: "myorg",
    APP_SLUG: "myapp",
    ...extra,
  } as NodeJS.ProcessEnv;
}

describe("credentialMode", () => {
  it("defaults to stored, takes short-lived, and rejects anything else", () => {
    expect(credentialMode({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toBe("stored");
    expect(credentialMode({ NODE_ENV: "test", TENANT_DB_CREDENTIALS: "short-lived" } as NodeJS.ProcessEnv)).toBe("short-lived");
    expect(() => credentialMode({ NODE_ENV: "test", TENANT_DB_CREDENTIALS: "forever" } as NodeJS.ProcessEnv)).toThrow(
      /TENANT_DB_CREDENTIALS/,
    );
  });
});

describe("expiryOf", () => {
  it("reads Turso durations", () => {
    const t = new Date("2026-10-29T12:00:00Z");
    expect(expiryOf("1h", t).toISOString()).toBe("2026-10-29T13:00:00.000Z");
    expect(expiryOf("2w1d30m", t).getTime() - t.getTime()).toBe((15 * 86400 + 1800) * 1000);
    expect(() => expiryOf("1hour", t)).toThrow();
    expect(() => expiryOf("", t)).toThrow();
  });
});

describe("Turso tokens the app asks for", () => {
  it("a one-hour token: expiration=1h on the mint call", async () => {
    const calls = stubTurso();
    await new TursoTenantProvisioner(tursoEnv()).mintTenantToken("t0abc", { expiration: "1h" });
    const mint = calls.find((c) => c.url.pathname.endsWith("/auth/tokens"))!;
    expect(mint.method).toBe("POST");
    expect(mint.url.pathname).toBe("/v1/organizations/myorg/databases/myapp-t0abc/auth/tokens");
    expect(mint.url.searchParams.get("expiration")).toBe("1h");
    expect(mint.url.searchParams.get("authorization")).toBe("full-access");
  });

  it("a read-only token for a caller that only reads (#756)", async () => {
    const calls = stubTurso();
    await new TursoTenantProvisioner(tursoEnv()).mintTenantToken("t0abc", { access: "read-only" });
    const mint = calls.find((c) => c.url.pathname.endsWith("/auth/tokens"))!;
    expect(mint.url.searchParams.get("authorization")).toBe("read-only");
    expect(mint.url.searchParams.has("expiration")).toBe(false);
  });

  it("creates databases in the app's own group when TURSO_GROUP is set, without listing groups (#439)", async () => {
    const calls = stubTurso();
    await new TursoTenantProvisioner(tursoEnv({ TURSO_GROUP: "myapp" })).create("t0abc");
    expect(calls.some((c) => c.url.pathname.endsWith("/groups"))).toBe(false);
    const create = calls.find((c) => c.method === "POST" && c.url.pathname.endsWith("/databases"))!;
    expect(create.body).toEqual({ name: "myapp-t0abc", group: "myapp" });
  });

  it("falls back to the organisation's first group without TURSO_GROUP (one-group plan)", async () => {
    const calls = stubTurso();
    await new TursoTenantProvisioner(tursoEnv()).create("t0abc");
    const create = calls.find((c) => c.method === "POST" && c.url.pathname.endsWith("/databases"))!;
    expect(create.body).toEqual({ name: "myapp-t0abc", group: "default" });
  });
});

describe("short-lived mode (#746)", () => {
  it("mints a one-hour token, holds it for the hour, then mints a new one", async () => {
    const calls = stubTurso();
    let clock = Date.parse("2026-10-29T12:00:00Z");
    const env = tursoEnv({ TENANT_PROVISIONER: "turso" });
    const opts = { service: "app (test)", env, now: () => clock };
    const first = await shortLivedTenantToken("t0abc", opts);
    clock += 50 * 60 * 1000; // 50 minutes: still held
    expect(await shortLivedTenantToken("t0abc", opts)).toBe(first);
    clock += 6 * 60 * 1000; // 56 minutes: within five minutes of expiry
    const second = await shortLivedTenantToken("t0abc", opts);
    expect(second).not.toBe(first);
    const mints = calls.filter((c) => c.url.pathname.endsWith("/auth/tokens"));
    expect(mints).toHaveLength(2);
    expect(mints.every((m) => m.url.searchParams.get("expiration") === SHORT_LIVED_EXPIRATION)).toBe(true);
    const issued = (await events()).filter((e) => e.event === "issue");
    expect(issued).toHaveLength(2);
    expect(issued[0]).toMatchObject({ credential: "tenant-db", tenant_id: "t0abc", service: "app (test)", access: "full-access" });
    expect(Number(issued[0].expires_at)).toBe(Date.parse("2026-10-29T13:00:00Z") / 1000);
  });

  it("refuses with the file provisioner (a local database takes no token)", async () => {
    await expect(
      shortLivedTenantToken("t0abc", { service: "x", env: { NODE_ENV: "test", TENANT_PROVISIONER: "file" } as NodeJS.ProcessEnv }),
    ).rejects.toThrow(/needs the Turso provisioner/);
  });

  it("sign-up stores no token at all, and resolveTenant hands out a held one-hour token", async () => {
    const calls = stubTurso();
    process.env.TENANT_DB_CREDENTIALS = "short-lived";
    process.env.TENANT_DB_DIR = join(dir, "tenants");
    process.env.TENANT_PROVISIONER = "file";
    // the file adapter has no tokens: stand in for a hosted database
    const realCreate = FileTenantProvisioner.prototype.create;
    const seen: unknown[] = [];
    vi.spyOn(FileTenantProvisioner.prototype, "create").mockImplementation(async function (
      this: FileTenantProvisioner,
      id: string,
      opts?: unknown,
    ) {
      seen.push(opts);
      return { ...(await realCreate.call(this, id)), authToken: "jwt-migrate-only", authTokenExpiresAt: new Date(Date.now() + 3600_000) };
    });
    await provisionTenant("t0abc");
    expect(seen[0]).toEqual({ expiration: "1h" });

    const c = createClient({ url: catalogUrl });
    const row = (await c.execute("SELECT db_auth_token FROM tenants WHERE id = 't0abc'")).rows[0];
    expect(row.db_auth_token).toBeNull(); // nothing to steal from the catalog
    // point the tenant at a hosted address so resolveTenant needs a token
    await c.execute("UPDATE tenants SET db_url = 'libsql://myapp-t0abc-myorg.turso.io' WHERE id = 't0abc'");
    c.close();

    process.env.TENANT_PROVISIONER = "turso";
    process.env.TURSO_API_TOKEN = "turso-not-real";
    process.env.TURSO_ORG = "myorg";
    process.env.APP_SLUG = "myapp";
    const a = await resolveTenant("t0abc");
    const b = await resolveTenant("t0abc");
    expect(a.authToken).toMatch(/^jwt-not-real-/);
    expect(b.authToken).toBe(a.authToken);
    expect(calls.filter((x) => x.url.pathname.endsWith("/auth/tokens"))).toHaveLength(1);

    const ev = await events();
    expect(ev.map((e) => `${e.event}:${e.service}`)).toEqual([
      "issue:sign-up",
      "issue:app",
      "use:app",
      "use:app",
    ]);
  });
});

describe("stored mode (the default) — unchanged, and audited", () => {
  it("records the issue at sign-up and each use; the token is never in the log", async () => {
    process.env.TENANT_DB_DIR = join(dir, "tenants2");
    process.env.TENANT_PROVISIONER = "file";
    process.env[MFA_KEY_ENV] = randomBytes(32).toString("base64");
    const realCreate = FileTenantProvisioner.prototype.create;
    vi.spyOn(FileTenantProvisioner.prototype, "create").mockImplementation(async function (
      this: FileTenantProvisioner,
      id: string,
    ) {
      return { ...(await realCreate.call(this, id)), authToken: "stored-token-not-real" };
    });
    await provisionTenant("t0def");
    await getDb("t0def");
    await getDb("t0def");
    const ev = await events();
    expect(ev.map((e) => `${e.event}:${e.service}:${e.expires_at}`)).toEqual([
      "issue:sign-up:null",
      "use:app:null",
      "use:app:null",
    ]);
    expect(JSON.stringify(ev)).not.toContain("stored-token-not-real");
  });
});

describe("recordCredentialEvent", () => {
  it("records which credential, when, from which IP, for which service", async () => {
    await recordCredentialEvent({
      event: "use",
      credential: "tenant-db",
      tenantId: "t0abc",
      service: "backup-check",
      access: "read-only",
      ip: "203.0.113.7",
    });
    expect((await events())[0]).toMatchObject({
      event: "use",
      credential: "tenant-db",
      tenant_id: "t0abc",
      service: "backup-check",
      access: "read-only",
      ip: "203.0.113.7",
    });
  });

  it("never throws when the catalog cannot be written", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.CATALOG_DATABASE_URL = "file:/nonexistent-dir-for-test/x.db";
    __resetCatalogCacheForTests();
    await expect(
      recordCredentialEvent({ event: "use", credential: "tenant-db", service: "app", ip: null }),
    ).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });
});

describe("recordCredentialEvent — inside a request", () => {
  it("takes the caller's IP address from the request, and records nothing it was not given", async () => {
    vi.doMock("next/headers", () => ({
      headers: async () => new Headers({ "x-real-ip": "198.51.100.4" }),
    }));
    await recordCredentialEvent({ event: "use", credential: "tenant-db", service: "app" });
    vi.doMock("next/headers", () => ({ headers: async () => new Headers() }));
    await recordCredentialEvent({ event: "use", credential: "tenant-db", service: "app" });
    vi.doUnmock("next/headers");
    const ev = await events();
    expect(ev[0]).toMatchObject({ ip: "198.51.100.4", tenant_id: null, access: null, expires_at: null });
    expect(ev[1].ip).toBeNull(); // no address known
  });

  it("names the service after the deployment", async () => {
    const { appService } = await import("@/lib/credential-audit");
    expect(appService()).toBe("app");
    process.env.VERCEL_ENV = "preview";
    expect(appService()).toBe("app (preview)");
  });

  it("logs the tenant when a write fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.CATALOG_DATABASE_URL = "file:/nonexistent-dir-for-test/y.db";
    __resetCatalogCacheForTests();
    await recordCredentialEvent({ event: "issue", credential: "tenant-db", tenantId: "t0x", service: "app", ip: null });
    expect(String(err.mock.calls[0][0])).toMatch(/issue of tenant-db for tenant t0x/);
    err.mockClear();
    vi.spyOn(await import("@/lib/catalog"), "getCatalogDb").mockImplementation(() => {
      throw "not an Error";
    });
    await recordCredentialEvent({ event: "use", credential: "tenant-db", service: "app", ip: null });
    expect(err.mock.calls[0][1]).toBe("not an Error");
  });
});
