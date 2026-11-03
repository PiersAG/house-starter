// The sign-in rule for a closed account (app-business-core issue 722; Matt
// Murphy #156: "deactivate the user immediately"). An account whose owner asked
// to delete it is refused at sign-in exactly like an unknown account, so no
// password opens it again and the answer says nothing about whether it exists.
// Called by authorize() right after the account is looked up. No imports: the
// sign-in path loads it without pulling in the deletion pipeline.

/**
 * True when the account may not sign in: it has asked to be deleted, or it is a
 * sign-up still being set up (app-business-core issue 358 — it is switched on
 * only once its database is ready; lib/tenant/signup-provisioning.ts). Either
 * mark alone is enough, so clearing one never opens the account.
 */
export function isDeactivated(
  user: { deactivatedAt?: Date | null; signupPendingSince?: Date | null } | null | undefined,
): boolean {
  return Boolean(user?.deactivatedAt) || Boolean(user?.signupPendingSince);
}
