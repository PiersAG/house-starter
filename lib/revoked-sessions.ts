// Session revocation — CEO ruling 2026-07-15.
//
// Implements the short-lived-token + renewal-time revocation pattern required
// by Quality Baseline §2 at MVP/L2:
//
//   1. Tokens are short-lived (rolling renewal via the jwt callback).
//   2. At signOut a revocation record is written here, keyed by the JWT session
//      id (`jti`).
//   3. The revocation check (DB hit) occurs ONLY at renewal time — when the
//      token's `renewAfter` timestamp has passed — never on every page load.
//
// `handleTokenRenewal` is extracted from the NextAuth jwt callback so it can
// be unit-tested directly, without mocking NextAuth internals.

import { eq } from "drizzle-orm";
import type { JWT } from "next-auth/jwt";
import type { AppDatabase } from "@/lib/users";
import { revokedSessions } from "@/lib/schema";

/**
 * How long (seconds) between revocation checks. After each check the window
 * resets; ordinary page loads within the window incur no DB hit.
 */
export const RENEW_AFTER_SECONDS = 10 * 60; // 10 minutes

/**
 * Write a revocation record for the given JWT session id.
 * The UNIQUE constraint on `jti` means calling this twice is a no-op error
 * (the caller should catch and log, not re-throw).
 */
export async function revokeSession(
  db: AppDatabase,
  jti: string,
  userId: string,
): Promise<void> {
  const id = crypto.randomUUID();
  await db
    .insert(revokedSessions)
    .values({ id, jti, userId })
    .run();
}

/**
 * Return true when the given `jti` has a revocation record, false otherwise.
 * Used at token renewal time only — never on every request.
 */
export async function isSessionRevoked(
  db: AppDatabase,
  jti: string,
): Promise<boolean> {
  const rows = await db
    .select()
    .from(revokedSessions)
    .where(eq(revokedSessions.jti, jti))
    .limit(1)
    .all();
  return rows.length > 0;
}

/**
 * Apply rolling-renewal + revocation logic to a decoded JWT token.
 *
 * Called from the NextAuth `jwt` callback on every non-sign-in request.
 * Returns the (possibly updated) token, or `null` to invalidate the session.
 *
 * Behaviour:
 * - If `now < token.renewAfter`: return the token unchanged — NO DB call.
 * - If `now >= token.renewAfter`: check `checkRevoked(jti)`.
 *     - If revoked: return `null` (session invalidated).
 *     - If not revoked: update `renewAfter` and return the token.
 *
 * @param token      Decoded JWT (contains sessionId and renewAfter).
 * @param checkRevoked  Async function to check the revocation store.
 * @param nowSeconds Unix timestamp for "now" (injectable for testing).
 */
export async function handleTokenRenewal(
  token: JWT,
  checkRevoked: (jti: string) => Promise<boolean>,
  nowSeconds: number,
): Promise<JWT | null> {
  const sessionId = token.sessionId as string | undefined;
  const renewAfter = token.renewAfter as number | undefined;

  // No session id or renewal marker → token predates revocation tracking;
  // return unchanged so existing sessions are not broken mid-rollout.
  if (!sessionId || renewAfter === undefined) {
    return token;
  }

  // Not renewal time yet — return the token WITHOUT a DB hit.
  if (nowSeconds < renewAfter) {
    return token;
  }

  // Renewal time: check the revocation store (one DB hit per renewal window).
  //
  // Robustness rule: a throw from the revocation store must NEVER escape this
  // function — an escaped throw from the jwt callback surfaces to the user
  // as a server error instead of a login prompt. Fail CLOSED: if we cannot
  // verify the session against the store, invalidate it (return null). The
  // user is gracefully redirected to /login and can sign straight back in;
  // a session we could not verify is never silently extended.
  let revoked: boolean;
  try {
    revoked = await checkRevoked(sessionId);
  } catch (error) {
    console.error(
      "session renewal: revocation check failed — invalidating session " +
        "(user is sent to /login, never a 500)",
      error,
    );
    return null;
  }
  if (revoked) {
    return null; // Invalidate the session — the signOut revocation was recorded.
  }

  // Not revoked: extend the renewal window and return.
  return { ...token, renewAfter: nowSeconds + RENEW_AFTER_SECONDS };
}
