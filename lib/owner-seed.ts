// Idempotent v0 owner-account seed (v0-owner-account-seed).
//
// On the single migration path (lib/migrate.ts · runMigrations, which every DB
// goes through — shared boot, deploy, and the per-tenant fan-out), if the
// factory owner account (OWNER_EMAIL, deploy-injected) does NOT exist, create it
// and attach a never-expiring owner-type access grant. Because it runs inside
// each tenant DB's migration, every app the factory builds inherits its owner
// account+grant — no per-app manual seeding.
//
// NO USABLE PASSWORD. The account is created with a sentinel passwordHash that
// is not a valid bcrypt hash, so lib/password.ts · verifyPassword returns false
// for EVERY input — the account cannot be logged into with a password. No secret
// is generated or stored anywhere. The CEO sets a real password per app through
// the normal password-reset flow (lib/password-reset.ts · resetPassword), which
// overwrites this sentinel. So there is no generated password to store and no
// shared credential across the portfolio.
//
// STRICTLY IDEMPOTENT. The seed fires only when the account is ABSENT. If the
// account already exists it is a FULL no-op: the existing account is never
// overwritten, a password already set is never reset, and no grant is
// (re)attached. Safe to run on every boot/migration forever.

import { createUser, getUserByEmail, type AppDatabase } from "@/lib/users";
import { grantAccess } from "@/lib/billing/grants";

/**
 * Sentinel passwordHash for the seeded owner. NOT a bcrypt hash, so
 * `verifyPassword(anyInput, NO_USABLE_PASSWORD)` is always false — no usable
 * password, and nothing secret is generated. Replaced by the CEO's real hash on
 * first password reset.
 */
export const NO_USABLE_PASSWORD = "!";

export type SeedOwnerAction = "created" | "noop-exists" | "noop-no-email";

export interface SeedOwnerResult {
  action: SeedOwnerAction;
  userId?: string;
}

/**
 * Seed the factory owner account + owner grant when absent; full no-op
 * otherwise. `email` is the deploy-injected factory owner address (process.env
 * .OWNER_EMAIL at the call site); an empty/unset value is a safe no-op so dev,
 * CI and any app without the config simply don't seed.
 */
export async function seedOwnerAccount(
  db: AppDatabase,
  email: string | undefined,
): Promise<SeedOwnerResult> {
  const target = (email ?? "").trim();
  if (!target) return { action: "noop-no-email" };

  const existing = await getUserByEmail(db, target);
  if (existing) {
    // Full no-op: never overwrite the account, never reset a set password,
    // never re-attach a grant.
    return { action: "noop-exists", userId: existing.id };
  }

  const user = await createUser(db, {
    email: target,
    passwordHash: NO_USABLE_PASSWORD,
    name: "Owner",
  });
  await grantAccess(db, {
    userId: user.id,
    type: "owner",
    note: "Factory owner account (v0 seed)",
    grantedBy: "v0-owner-account-seed",
    expiresAt: null,
  });
  return { action: "created", userId: user.id };
}
