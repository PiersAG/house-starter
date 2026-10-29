// Credential audit log (PiersAG/app-business-core#746, Matt Murphy #251: "enable
// audit logging on every secret access: requested credentials, when, from which
// IP address, for which service").
//
// One catalog row per ISSUE (a tenant database token minted — at sign-up, or a
// one-hour token in short-lived mode) and per USE (a tenant database credential
// handed to code that opens the database: lib/db.ts resolveTenant). Each row
// records which credential, when, the caller's IP address when there is a
// request, and which service asked. Never a token, never part of one.
//
// NEVER THROWS. A failed audit write is logged to stderr and the request goes on:
// an audit outage must not take sign-in down. (The write is awaited, so in normal
// running every use is recorded before the database is opened.)
//
// Node.js runtime only.

import { randomUUID } from "node:crypto";
import { getCatalogDb } from "@/lib/catalog";
import { clientKeyFromHeaders } from "@/lib/rate-limit";
import { credentialEvents } from "@/lib/schema";

export type CredentialEventKind = "issue" | "use";
export type CredentialAccess = "full-access" | "read-only";

export interface CredentialEventInput {
  event: CredentialEventKind;
  /** What kind of credential: "tenant-db" today. */
  credential: string;
  tenantId?: string | null;
  /** Which part of the system asked, e.g. "app", "sign-up", "backup-check". */
  service: string;
  access?: CredentialAccess | null;
  /** When an issued credential stops working. */
  expiresAt?: Date | null;
  /** Override the IP address (tests, scripts). Default: from the request, if any. */
  ip?: string | null;
}

/** The caller's IP address when this runs inside a request; null otherwise. */
async function requestIp(): Promise<string | null> {
  try {
    const { headers } = await import("next/headers");
    const ip = clientKeyFromHeaders(await headers());
    return ip === "unknown" ? null : ip;
  } catch {
    return null; // not inside a request (boot, a script, a test)
  }
}

/** The service name for code running in the deployed app. */
export function appService(): string {
  const env = (process.env.VERCEL_ENV ?? "").trim();
  return env ? `app (${env})` : "app";
}

/** Record one credential event. Never throws. */
export async function recordCredentialEvent(input: CredentialEventInput): Promise<void> {
  try {
    const ip = input.ip !== undefined ? input.ip : await requestIp();
    await getCatalogDb()
      .insert(credentialEvents)
      .values({
        id: `cred-${randomUUID()}`,
        event: input.event,
        credential: input.credential,
        tenantId: input.tenantId ?? null,
        service: input.service,
        access: input.access ?? null,
        ip,
        expiresAt: input.expiresAt ?? null,
      })
      .run();
  } catch (e) {
    console.error(
      `credential-audit: could not record a ${input.event} of ${input.credential}` +
        (input.tenantId ? ` for tenant ${input.tenantId}` : ""),
      e instanceof Error ? e.message : e,
    );
  }
}
