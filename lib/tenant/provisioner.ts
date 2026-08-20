// Tenant provisioning — creating a customer's OWN database, migrating it, and
// registering it in the catalog so login can route to it (ADR-023 per_tenant).
//
// TWO ADAPTERS, SELECTED BY ENVIRONMENT
// -------------------------------------
//   "file"  — one libSQL FILE per tenant on the local filesystem. Local dev, CI
//             and the SEC.24 isolation harness. No network, no account, no cost.
//   "turso" — one real hosted database per tenant, created through the Turso
//             platform API. Every deployed environment.
//
// The two produce URLs that differ only in scheme, and lib/db.ts treats a
// `file:` URL and a `libsql://` URL identically — so the adapter that runs in CI
// exercises the same routing the adapter that runs in production does.
//
// THE ONE RULE: PRODUCTION NEVER FALLS BACK
// -----------------------------------------
// A deployed app whose Turso credentials are missing FAILS, loudly, naming the
// variables it needs. It does not quietly write a file into a serverless
// container's ephemeral disk — that looks like a working sign-up and loses the
// customer's account at the next cold start, which is worse than an error page.
//
// WHEN PROVISIONING HAPPENS
// -------------------------
// At sign-up, and again (idempotently) at first sign-in for any account that
// predates its tenant — the factory owner account seeded by lib/owner-seed.ts
// during migration, for instance. It is deliberately NOT part of the migration
// path: a migration must not make calls to a database platform's control API.

import { randomUUID } from "node:crypto";
import { mkdirSync, closeSync, openSync, existsSync } from "node:fs";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { eq } from "drizzle-orm";
import { getCatalogDb } from "@/lib/catalog";
import { assertValidTenantId } from "@/lib/db";
import { migrateTenant } from "@/lib/migrate";
import { tenants, users } from "@/lib/schema";

export type ProvisionerName = "file" | "turso";

export interface ProvisionedDatabase {
  url: string;
  authToken?: string;
}

export interface TenantProvisioner {
  readonly name: ProvisionerName;
  /** Create (or return the existing) database for this tenant. Idempotent. */
  create(tenantId: string): Promise<ProvisionedDatabase>;
}

/**
 * A fresh tenant id: `t` + 32 hex characters.
 *
 * Deliberately opaque and NOT derived from the email or the display name — a
 * tenant id ends up in a database name and a URL, so a guessable one invites
 * exactly the enumeration the isolation attack tests for. It contains no
 * underscore, which keeps it round-trippable through the hosted naming rules
 * below (see tursoDatabaseName).
 */
export function newTenantId(): string {
  return `t${randomUUID().replace(/-/g, "")}`;
}

// ── file adapter ─────────────────────────────────────────────────────────────

/** Directory holding per-tenant database files. Override with TENANT_DB_DIR. */
export function tenantFileDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.TENANT_DB_DIR;
  if (configured && configured.length > 0) {
    return isAbsolute(configured) ? configured : resolvePath(process.cwd(), configured);
  }
  return resolvePath(process.cwd(), ".build/tenants");
}

/**
 * One libSQL file per tenant. The file is created empty; libSQL initialises a
 * zero-byte file as a fresh database on first connection, and provisionTenant
 * then applies the app's own tenant migrations to it.
 */
export class FileTenantProvisioner implements TenantProvisioner {
  readonly name = "file" as const;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async create(tenantId: string): Promise<ProvisionedDatabase> {
    assertValidTenantId(tenantId);
    const dir = tenantFileDir(this.env);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${tenantId}.db`);
    if (!existsSync(path)) {
      // Create it here rather than on first connection so a read-only or
      // missing mount surfaces as an error WITH A PATH IN IT, not as an opaque
      // libSQL failure three frames later.
      closeSync(openSync(path, "w"));
    }
    return { url: `file:${path}` };
  }
}

// ── turso adapter ────────────────────────────────────────────────────────────

const TURSO_API = "https://api.turso.tech/v1";

/**
 * The hosted database name for a tenant: `<app-slug>-<tenant-id>`.
 *
 * Turso names allow only lowercase letters, digits and dashes, so the tenant id
 * is lower-cased and its underscores become dashes. Ids minted by newTenantId()
 * contain neither capital nor underscore, so the mapping is exactly reversible —
 * which is what scripts/verify-tenant-backups.ts's prefix enumeration relies on.
 * A hand-made id that would NOT round-trip is rejected rather than mangled.
 */
export function tursoDatabaseName(appSlug: string, tenantId: string): string {
  const name = `${appSlug}-${tenantId}`.toLowerCase().replace(/_/g, "-");
  if (!/^[a-z0-9-]{1,58}$/.test(name)) {
    throw new Error(
      `lib/tenant/provisioner.ts: ${JSON.stringify(name)} is not a valid Turso ` +
        `database name (lowercase letters, digits and dashes, up to 58 chars). ` +
        `Check APP_SLUG and the tenant id.`,
    );
  }
  return name;
}

async function tursoFetch(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${TURSO_API}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

/**
 * A real hosted database per tenant, created through the Turso platform API —
 * the production model: every customer gets their own database.
 *
 * Requires TURSO_API_TOKEN (org API token with database-create rights) and
 * TURSO_ORG. Both are read at construction and their absence is an immediate,
 * named error — never a silent downgrade to the file adapter.
 */
export class TursoTenantProvisioner implements TenantProvisioner {
  readonly name = "turso" as const;

  private readonly token: string;
  private readonly org: string;
  private readonly appSlug: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const missing: string[] = [];
    const token = (env.TURSO_API_TOKEN ?? "").trim();
    const org = (env.TURSO_ORG ?? "").trim();
    if (!token) missing.push("TURSO_API_TOKEN");
    if (!org) missing.push("TURSO_ORG");
    if (missing.length > 0) {
      throw new Error(
        `lib/tenant/provisioner.ts: the Turso tenant provisioner needs ` +
          `${missing.join(" and ")}, which ${missing.length === 1 ? "is" : "are"} not set. ` +
          `Refusing to provision: this environment cannot create a real per-tenant ` +
          `database, and falling back to a local file here would accept the sign-up ` +
          `and then lose the account. Set the variable(s), or set ` +
          `TENANT_PROVISIONER=file if this environment is genuinely local.`,
      );
    }
    this.token = token;
    this.org = org;
    this.appSlug =
      (env.APP_SLUG ?? env.NEXT_PUBLIC_APP_SLUG ?? "app").trim().toLowerCase() || "app";
  }

  /** New databases must land in an existing group; starter plans have one. */
  private async resolveGroup(): Promise<string> {
    const r = await tursoFetch(`/organizations/${encodeURIComponent(this.org)}/groups`, this.token);
    if (!r.ok) {
      throw new Error(
        `Turso: listing groups failed (${r.status} ${r.statusText}) — ${await r.text().catch(() => "")}`,
      );
    }
    const body = (await r.json()) as {
      groups?: Array<{ name?: string; Name?: string }>;
    };
    const first = (body.groups ?? [])[0];
    return first?.name ?? first?.Name ?? "default";
  }

  private async hostnameOf(dbName: string): Promise<string | null> {
    const r = await tursoFetch(
      `/organizations/${encodeURIComponent(this.org)}/databases/${encodeURIComponent(dbName)}`,
      this.token,
    );
    if (!r.ok) return null;
    const body = (await r.json()) as {
      database?: { Hostname?: string; hostname?: string };
    };
    const db = body.database ?? {};
    return db.Hostname ?? db.hostname ?? null;
  }

  /**
   * Mint a database-scoped auth token. Scoped to ONE database, so the token
   * stored against a tenant can only ever open that tenant's data — a leaked
   * catalog row compromises one customer, not the portfolio.
   */
  private async mintToken(dbName: string): Promise<string> {
    const r = await tursoFetch(
      `/organizations/${encodeURIComponent(this.org)}/databases/${encodeURIComponent(dbName)}/auth/tokens`,
      this.token,
      { method: "POST" },
    );
    if (!r.ok) {
      throw new Error(
        `Turso: minting an auth token for ${dbName} failed (${r.status} ${r.statusText}) — ` +
          `${await r.text().catch(() => "")}`,
      );
    }
    const body = (await r.json()) as { jwt?: string };
    if (!body.jwt) throw new Error(`Turso: empty jwt minting a token for ${dbName}`);
    return body.jwt;
  }

  async create(tenantId: string): Promise<ProvisionedDatabase> {
    assertValidTenantId(tenantId);
    const dbName = tursoDatabaseName(this.appSlug, tenantId);

    // Idempotent: a retried sign-up reuses the database it already created
    // rather than failing on a name collision.
    let hostname = await this.hostnameOf(dbName);
    if (!hostname) {
      const group = await this.resolveGroup();
      const r = await tursoFetch(
        `/organizations/${encodeURIComponent(this.org)}/databases`,
        this.token,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: dbName, group }),
        },
      );
      if (!r.ok) {
        throw new Error(
          `Turso: creating database ${dbName} failed (${r.status} ${r.statusText}) — ` +
            `${await r.text().catch(() => "")}`,
        );
      }
      const body = (await r.json()) as {
        database?: { Hostname?: string; hostname?: string };
      };
      hostname = body.database?.Hostname ?? body.database?.hostname ?? null;
    }
    if (!hostname) {
      throw new Error(`Turso: could not resolve a hostname for ${dbName}`);
    }

    return { url: `libsql://${hostname}`, authToken: await this.mintToken(dbName) };
  }
}

// ── adapter selection ────────────────────────────────────────────────────────

/**
 * Which adapter this environment uses.
 *
 *   TENANT_PROVISIONER=file|turso   — explicit, always wins.
 *   VERCEL_ENV set (any value)      — a deployed environment: "turso".
 *   otherwise                       — local dev / CI / the isolation harness: "file".
 *
 * A deployed environment is identified by VERCEL_ENV rather than
 * NODE_ENV=production, because `next build` sets NODE_ENV=production in CI too —
 * and CI has no Turso credentials and should not need them.
 */
export function selectProvisionerName(
  env: NodeJS.ProcessEnv = process.env,
): ProvisionerName {
  const explicit = (env.TENANT_PROVISIONER ?? "").trim().toLowerCase();
  if (explicit === "file" || explicit === "turso") return explicit;
  if (explicit.length > 0) {
    throw new Error(
      `lib/tenant/provisioner.ts: TENANT_PROVISIONER must be "file" or "turso" ` +
        `(got ${JSON.stringify(explicit)}).`,
    );
  }
  return env.VERCEL_ENV ? "turso" : "file";
}

/** Build the adapter this environment selects. Never falls back on failure. */
export function getProvisioner(
  env: NodeJS.ProcessEnv = process.env,
): TenantProvisioner {
  return selectProvisionerName(env) === "turso"
    ? new TursoTenantProvisioner(env)
    : new FileTenantProvisioner(env);
}

// ── the provisioning transaction ─────────────────────────────────────────────

export interface ProvisionOptions {
  label?: string | null;
  env?: NodeJS.ProcessEnv;
}

/**
 * Create this tenant's database, migrate it, stamp it, and register it in the
 * catalog. Idempotent: re-running for a tenant that already has a row re-applies
 * the (idempotent) migration and leaves the registration alone.
 *
 * ORDER MATTERS. The catalog row is written LAST, after the database exists and
 * has its schema — so a crash midway leaves a tenant that cannot be routed to
 * (recoverable: the next sign-in re-provisions) rather than a registered tenant
 * pointing at an empty database (a 500 on every page, for one customer, forever).
 */
export async function provisionTenant(
  tenantId: string,
  { label = null, env = process.env }: ProvisionOptions = {},
): Promise<ProvisionedDatabase> {
  assertValidTenantId(tenantId);
  const provisioner = getProvisioner(env);
  const created = await provisioner.create(tenantId);

  await migrateTenant(created.url, created.authToken);

  const { createClient } = await import("@libsql/client");
  const client = createClient({ url: created.url, authToken: created.authToken });
  try {
    await client.execute({
      sql:
        "INSERT INTO tenant_meta (id, tenant_id, label) VALUES (?, ?, ?) " +
        "ON CONFLICT(tenant_id) DO UPDATE SET label = COALESCE(excluded.label, tenant_meta.label)",
      args: [`meta-${tenantId}`, tenantId, label],
    });
  } finally {
    client.close();
  }

  await getCatalogDb()
    .insert(tenants)
    .values({
      id: tenantId,
      dbUrl: created.url,
      dbAuthToken: created.authToken ?? null,
      provisioner: provisioner.name,
      label,
    })
    .onConflictDoUpdate({
      target: tenants.id,
      set: {
        dbUrl: created.url,
        dbAuthToken: created.authToken ?? null,
        provisioner: provisioner.name,
      },
    })
    .run();

  return created;
}

/**
 * The tenant for an account, provisioning one if it has none.
 *
 * Called on the sign-up path and, as a safety net, at sign-in — so an account
 * that predates its tenant (the seeded factory owner) gets a database the first
 * time it is used, and every later sign-in is a single catalog read.
 *
 * Throws rather than returning null: a per-tenant session without a tenant is
 * not a degraded session, it is a session that must not exist.
 */
export async function ensureTenantForUser(
  userId: string,
  { label = null, env = process.env }: ProvisionOptions = {},
): Promise<string> {
  const catalog = getCatalogDb();
  const userRows = await catalog
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
    .all();
  const user = userRows[0];
  if (!user) {
    throw new Error(
      `lib/tenant/provisioner.ts: no catalog account ${JSON.stringify(userId)} — ` +
        `cannot resolve or provision a tenant for an account that does not exist.`,
    );
  }

  if (user.tenantId) {
    const registered = await catalog
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, user.tenantId))
      .limit(1)
      .all();
    if (registered.length > 0) return user.tenantId;
    // Mapped to a tenant the registry does not know: re-provision under the
    // SAME id rather than minting a second one, so a half-finished sign-up
    // converges instead of leaving the account orphaned.
    await provisionTenant(user.tenantId, { label: label ?? user.email, env });
    return user.tenantId;
  }

  const tenantId = newTenantId();
  await provisionTenant(tenantId, { label: label ?? user.email, env });
  await catalog
    .update(users)
    .set({ tenantId })
    .where(eq(users.id, userId))
    .run();
  return tenantId;
}
