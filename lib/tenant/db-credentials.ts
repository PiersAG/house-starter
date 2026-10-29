// Tenant database credentials that expire (PiersAG/app-business-core#746, Matt
// Murphy #251: "dynamic secrets are created per session and auto expire — they
// live for one hour, then they die; no permanent credentials to steal").
//
// TWO MODES, CHOSEN BY TENANT_DB_CREDENTIALS
// ------------------------------------------
//   stored (default) — the provisioner mints one token per tenant database at
//       sign-up and the catalog keeps it, sealed (lib/crypto/secret-box.ts).
//       It does not expire. This is the only mode that works with an
//       organisation-wide Turso token kept OUT of the app.
//   short-lived — nothing is stored. Each server instance mints a ONE-HOUR token
//       for a tenant's database the first time it needs it, keeps it in memory
//       only, and mints a new one five minutes before the hour is up. The
//       catalog then holds no tenant credential at all, so a catalog leak yields
//       none. This needs a Turso token that can mint database tokens in the
//       running app, so it is switched on only together with the app's own
//       group-scoped token (#439, TURSO_GROUP): never with an
//       organisation-wide token.
//
// "Per session" on serverless: the holder of a credential is one server
// instance, which lives minutes to hours. A token is never shared across
// instances, never written anywhere, and never outlives its hour.
//
// Every issue and every use is recorded by lib/credential-audit.ts.
//
// Node.js runtime only.

import { recordCredentialEvent } from "@/lib/credential-audit";
import {
  getProvisioner,
  TursoTenantProvisioner,
  type DbTokenAccess,
} from "@/lib/tenant/provisioner";

export type CredentialMode = "stored" | "short-lived";

/** Turso duration of a short-lived token. */
export const SHORT_LIVED_EXPIRATION = "1h";
const LIFETIME_MS = 60 * 60 * 1000;
/** Mint a fresh token this long before the old one expires. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Which mode this environment uses. Anything but the two names is an error. */
export function credentialMode(env: NodeJS.ProcessEnv = process.env): CredentialMode {
  const raw = (env.TENANT_DB_CREDENTIALS ?? "").trim().toLowerCase();
  if (raw === "" || raw === "stored") return "stored";
  if (raw === "short-lived") return "short-lived";
  throw new Error(
    `lib/tenant/db-credentials.ts: TENANT_DB_CREDENTIALS must be "stored" or ` +
      `"short-lived" (got ${JSON.stringify(raw)}).`,
  );
}

type Held = { token: string; expiresAt: number };
const g = globalThis as unknown as { __tenantDbTokens?: Map<string, Held> };
const held: Map<string, Held> = g.__tenantDbTokens ?? (g.__tenantDbTokens = new Map());

/**
 * A one-hour token for `tenantId`'s database: the one this instance already
 * holds, or a newly minted one. Records the issue (when minted) — the caller
 * records the use.
 */
export async function shortLivedTenantToken(
  tenantId: string,
  {
    access = "full-access",
    service,
    env = process.env,
    now = () => Date.now(),
  }: {
    access?: DbTokenAccess;
    service: string;
    env?: NodeJS.ProcessEnv;
    now?: () => number;
  },
): Promise<string> {
  const id = `${tenantId}\u0000${access}`;
  const have = held.get(id);
  if (have && have.expiresAt - REFRESH_MARGIN_MS > now()) return have.token;

  const provisioner = getProvisioner(env);
  if (!(provisioner instanceof TursoTenantProvisioner)) {
    throw new Error(
      "lib/tenant/db-credentials.ts: TENANT_DB_CREDENTIALS=short-lived needs the Turso " +
        "provisioner (a hosted database), but this environment uses the " +
        `${provisioner.name} provisioner, whose databases take no token.`,
    );
  }
  const issuedAt = now();
  const token = await provisioner.mintTenantToken(tenantId, {
    access,
    expiration: SHORT_LIVED_EXPIRATION,
  });
  const expiresAt = issuedAt + LIFETIME_MS;
  held.set(id, { token, expiresAt });
  await recordCredentialEvent({
    event: "issue",
    credential: "tenant-db",
    tenantId,
    service,
    access,
    expiresAt: new Date(expiresAt),
  });
  return token;
}

/** Test hook: forget every held token. */
export function __resetHeldTokensForTests(): void {
  held.clear();
}
