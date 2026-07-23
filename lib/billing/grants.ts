// Access grants — the SINGLE audited path around the subscription paywall
// (owner-account-paywall-exemption).
//
// A grant is attached to an account and lets it reach gated routes EXACTLY as an
// active subscription does (lib/billing/gate.ts checks hasLiveGrant alongside the
// active/trial/grace states). There is deliberately ONE mechanism — no separate
// "owner bypass" — so "who has access without paying, and why" is a single query
// (listLiveGrants).
//
// Grants are set EXPLICITLY by the CEO only, via scripts/grant-access.ts. This
// module is never imported by signup, middleware, env parsing, or any
// email/pattern match — a grant cannot come into existence implicitly. An
// expired grant (expiresAt in the past) confers no access, the same as a lapsed
// subscription. One grant per account (users.id is unique on the row).
//
// DI pattern (like lib/billing/subscriptions.ts): every function takes the
// Drizzle db explicitly, so it unit-tests against an in-memory database.

import { eq } from "drizzle-orm";
import { accessGrants, type AccessGrant } from "@/lib/schema";
import type { AppDatabase } from "@/lib/users";

/** The only grant kinds. `owner` = the CEO/creator's own account; `tester` =
 *  focus-group / QA access; `comp` = a complimentary grant. */
export const GRANT_TYPES = ["owner", "tester", "comp"] as const;
export type GrantType = (typeof GRANT_TYPES)[number];

export function isGrantType(value: string): value is GrantType {
  return (GRANT_TYPES as readonly string[]).includes(value);
}

/** A grant is LIVE when it has no expiry, or its expiry is still in the future. */
export function isGrantLive(grant: AccessGrant | undefined, now: Date = new Date()): boolean {
  if (!grant) return false;
  return grant.expiresAt === null || grant.expiresAt.getTime() > now.getTime();
}

export async function getGrantByUserId(
  db: AppDatabase,
  userId: string,
): Promise<AccessGrant | undefined> {
  const rows = await db
    .select()
    .from(accessGrants)
    .where(eq(accessGrants.userId, userId))
    .limit(1)
    .all();
  return rows[0];
}

/** True when the account currently holds a live grant. The paywall calls this. */
export async function hasLiveGrant(
  db: AppDatabase,
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  return isGrantLive(await getGrantByUserId(db, userId), now);
}

export interface GrantInput {
  userId: string;
  type: GrantType;
  /** Reason/note — the "why" surfaced by listLiveGrants. */
  note?: string | null;
  /** Who granted it (audit); the CLI stamps the operator. */
  grantedBy?: string | null;
  /** null/omitted = never expires. */
  expiresAt?: Date | null;
}

/**
 * Create or replace an account's grant (upsert on userId). EXPLICIT ONLY — the
 * CEO calls this through scripts/grant-access.ts. Throws on an unknown type so a
 * typo can never silently mint access.
 */
export async function grantAccess(db: AppDatabase, input: GrantInput): Promise<AccessGrant> {
  if (!isGrantType(input.type)) {
    throw new Error(
      `grantAccess: unknown grant type ${JSON.stringify(input.type)} — must be one of ${GRANT_TYPES.join(", ")}.`,
    );
  }
  const row = {
    id: globalThis.crypto?.randomUUID?.() ?? `grant_${input.userId}`,
    userId: input.userId,
    type: input.type,
    note: input.note ?? null,
    grantedBy: input.grantedBy ?? null,
    grantedAt: new Date(),
    expiresAt: input.expiresAt ?? null,
  };
  await db
    .insert(accessGrants)
    .values(row)
    .onConflictDoUpdate({
      target: accessGrants.userId,
      set: {
        type: row.type,
        note: row.note,
        grantedBy: row.grantedBy,
        grantedAt: row.grantedAt,
        expiresAt: row.expiresAt,
      },
    });
  return (await getGrantByUserId(db, input.userId))!;
}

/** Remove an account's grant (revoke). No-op when the account has none. */
export async function revokeGrant(db: AppDatabase, userId: string): Promise<void> {
  await db.delete(accessGrants).where(eq(accessGrants.userId, userId));
}

/**
 * Every account that currently has access WITHOUT paying, and why — the
 * queryable answer the card requires. Expired grants are excluded.
 */
export async function listLiveGrants(
  db: AppDatabase,
  now: Date = new Date(),
): Promise<AccessGrant[]> {
  const all = await db.select().from(accessGrants).all();
  return all.filter((g) => isGrantLive(g, now));
}
