// Authorization inside a tenant — the role check for owner-scope writes.
//
// SCOPE, STATED PLAINLY. This is the seam, not a permission system. Today one
// account = one tenant (lib/tenant/provisioner.ts::ensureTenantForUser), so
// every signed-in caller IS the owner of their tenant and this guards nothing
// yet. It exists so that when sub-users arrive — a trainer's assistant, a
// receptionist — the owner-only writes are already marked, rather than being
// found one at a time afterwards. There is no hierarchy, no permission matrix
// and no admin UI, and adding those is a separate decision.
//
// WHY AUTHENTICATION WAS NOT ENOUGH. The defect this closes was
// `if (!userId) 401` standing alone on a write route: "is anyone signed in" was
// the whole of the authorization. Answering that question is not the same as
// answering "may THIS caller do THIS", and the gap between them is where
// finding 1 lived.
//
// WHAT THIS DELIBERATELY DOES NOT GUARD: operator/CEO controls. Those are not
// role-gated, they are absent from the app's request paths entirely — see
// lib/settings/operator.ts. No value of `users.role` reaches them, so no bug in
// this file can expose them.

import { auth } from "@/lib/auth";
import { USER_ROLES, type UserRole } from "@/lib/schema";

/** Thrown when the caller's role does not permit the operation. */
export class NotAuthorizedError extends Error {
  constructor(message = "You do not have permission to do that.") {
    super(message);
    this.name = "NotAuthorizedError";
  }
}

/** The shape this module needs from a session — nothing more. */
export interface RoleBearingSession {
  user?: { role?: string | null } | null;
}

/**
 * The role carried by a session, or null.
 *
 * PURE, and separate from the auth() call on purpose: a handler that has already
 * resolved its session passes it in rather than fetching it a second time. Two
 * auth() calls in one request are not just wasteful — they are two chances to
 * read two different answers.
 *
 * A session minted before the claim existed has no role. It is treated as
 * ABSENT, not as owner, so the fail-closed direction is "re-authenticate" and
 * never "assume the most privileged value". An unrecognised role string (a
 * downgraded deploy, a hand-edited token) is absent for the same reason.
 */
export function roleFromSession(
  session: RoleBearingSession | null | undefined,
): UserRole | null {
  const role = session?.user?.role;
  return USER_ROLES.includes(role as UserRole) ? (role as UserRole) : null;
}

/** Assert an already-resolved session owns its tenant. Throws otherwise. */
export function assertTenantOwner(
  session: RoleBearingSession | null | undefined,
): UserRole {
  const role = roleFromSession(session);
  if (role !== "owner") {
    throw new NotAuthorizedError(
      "Only the workspace owner can change these settings.",
    );
  }
  return role;
}

/** The signed-in caller's role within their tenant, or null when anonymous. */
export async function currentRole(): Promise<UserRole | null> {
  return roleFromSession(await auth());
}

/**
 * Assert the caller owns this tenant, resolving the session itself. For call
 * sites that do not already hold one; those that do should call
 * {@link assertTenantOwner}.
 *
 * Callers that need an HTTP status rather than an exception catch
 * NotAuthorizedError — see app/api/settings/[key]/route.ts.
 */
export async function requireTenantOwner(): Promise<UserRole> {
  return assertTenantOwner(await auth());
}
