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
//   4. A password reset sets a per-user cutoff (`users.sessions_valid_from`).
//      At renewal, a session whose sign-in time (`authTime`) predates that
//      cutoff is rejected — so a reset ends every earlier session within one
//      renewal window, not instantly. "Sign out of all devices" and a
//      logged-in password change set the same cutoff (lib/account-security.ts).
//   5. At renewal the user's CURRENT role is re-read from the catalog
//      (#527, Matt Murphy #179) — a changed or removed role never outlives one
//      renewal window. When it changed, the session id is replaced and the old
//      one revoked (#798, Matt Murphy #25: a new identifier at every privilege
//      change, and the previous one stops working).
//
// `handleTokenRenewal` is extracted from the NextAuth jwt callback so it can
// be unit-tested directly, without mocking NextAuth internals.

import "server-only";

import { eq } from "drizzle-orm";
import type { JWT } from "next-auth/jwt";
import type { AppDatabase } from "@/lib/users";
import { revokedSessions, userSessions, users } from "@/lib/schema";
import { logSecurityEvent } from "@/lib/security-log";
import { renewAfterSeconds } from "@/lib/session/lifetime";

/**
 * How long (seconds) between revocation checks. After each check the window
 * resets; ordinary page loads within the window incur no DB hit. Set by the one
 * session setting (config/sessions.ts SESSION_POLICY, CEO decision #559): 10
 * minutes under today's ruling, 0 — every server request — under "strict".
 */
export const RENEW_AFTER_SECONDS = renewAfterSeconds();

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
 * Return true when a session that signed in at `authTime` (unix seconds) must
 * be rejected because the user's per-user cutoff (`sessionsValidFrom`, set by
 * a password reset) is later than it. Used at token renewal time only.
 *
 * - `authTime` missing → true (fail closed: an unstamped session cannot prove
 *   it post-dates a reset).
 * - No such user → true (fail closed: the account is gone).
 * - Cutoff NULL (never reset) → false.
 * - Otherwise → `authTime < cutoff`; a sign-in in the same second as the reset
 *   passes (the column stores whole seconds).
 */
export async function isSessionBeforeUserCutoff(
  db: AppDatabase,
  userId: string,
  authTime: number | undefined,
): Promise<boolean> {
  if (authTime === undefined) return true;
  const rows = await db
    .select({ sessionsValidFrom: users.sessionsValidFrom })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
    .all();
  const row = rows[0];
  if (!row) return true;
  if (!row.sessionsValidFrom) return false;
  return authTime < Math.floor(row.sessionsValidFrom.getTime() / 1000);
}

/**
 * The user's current role in the catalog, read at renewal (#527). `null` when
 * the account no longer exists — the caller fails closed on that.
 */
export async function readSessionRole(
  db: AppDatabase,
  userId: string,
): Promise<string | null> {
  const rows = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
    .all();
  return rows[0]?.role ?? null;
}

/**
 * What renewal needs to keep the role claim current (#527, #798): read the
 * role now held, and revoke a session id that is being replaced.
 */
export interface RoleRefresh {
  readRole: (userId: string) => Promise<string | null>;
  revoke: (jti: string, userId: string) => Promise<void>;
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
 *     - If `checkUserCutoff` is supplied: a token with no `authTime` or no user
 *       id returns `null` (fail closed, no DB hit); otherwise
 *       `checkUserCutoff(userId, authTime)` returning true returns `null`.
 *     - Otherwise: update `renewAfter` and return the token.
 *
 * `checkUserCutoff` is optional so the cutoff is inert until the sign-in mint
 * stamps `authTime` — without it every session would be rejected at renewal.
 *
 * When `roleRefresh` is supplied, the role is re-read after the cutoff check:
 *     - account gone, or the read fails → `null` (fail closed);
 *     - role unchanged → renewed as above;
 *     - role changed → the new role is written to the token, the session id is
 *       REPLACED with a fresh one and the old id revoked, so a copy of the
 *       pre-change cookie is refused at its own next renewal. If the revocation
 *       cannot be written the session is invalidated instead (`null`): a
 *       privilege change never leaves an old identifier working.
 *
 * @param token      Decoded JWT (contains sessionId and renewAfter).
 * @param checkRevoked  Async function to check the revocation store.
 * @param nowSeconds Unix timestamp for "now" (injectable for testing).
 * @param checkUserCutoff  Async function: true when the session signed in
 *                   before the user's password-reset cutoff.
 * @param roleRefresh  Re-read the role and revoke a replaced session id.
 * @param sessionCheck  The session record check (lib/session/hooks.ts); "end"
 *                   refuses the session.
 */
export async function handleTokenRenewal(
  token: JWT,
  checkRevoked: (jti: string) => Promise<boolean>,
  nowSeconds: number,
  checkUserCutoff?: (userId: string, authTime: number | undefined) => Promise<boolean>,
  roleRefresh?: RoleRefresh,
  sessionCheck?: (token: JWT, nowSeconds: number) => Promise<"ok" | "end">,
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

  // Per-user cutoff (password reset). Unlike the missing-sessionId case above,
  // a missing authTime is rejected: an unstamped session cannot prove it signed
  // in after a reset. Same fail-closed rule for a store failure.
  if (checkUserCutoff) {
    const userId = token.id ?? token.sub;
    const authTime = token.authTime;
    if (!userId || authTime === undefined) {
      return null;
    }
    let beforeCutoff: boolean;
    try {
      beforeCutoff = await checkUserCutoff(userId, authTime);
    } catch (error) {
      console.error(
        "session renewal: user cutoff check failed — invalidating session " +
          "(user is sent to /login, never a 500)",
        error,
      );
      return null;
    }
    if (beforeCutoff) {
      return null; // Signed in before the user's last password reset.
    }
  }

  // The session record (lib/session/hooks.ts, #506 / #519 / #741): an ended
  // session (a removed device, the device cap, an email sign-out), impossible
  // travel or a risk score past the end mark is refused. Same fail-closed rule.
  if (sessionCheck) {
    let verdict: "ok" | "end";
    try {
      verdict = await sessionCheck(token, nowSeconds);
    } catch (error) {
      console.error(
        "session renewal: session record check failed — invalidating session " +
          "(user is sent to /login, never a 500)",
        error,
      );
      return null;
    }
    if (verdict !== "ok") return null;
  }

  if (roleRefresh) {
    const userId = token.id ?? token.sub;
    if (!userId) return null;
    let role: string | null;
    try {
      role = await roleRefresh.readRole(userId);
    } catch (error) {
      console.error(
        "session renewal: role read failed — invalidating session " +
          "(user is sent to /login, never a 500)",
        error,
      );
      return null;
    }
    if (role === null) return null; // The account is gone.
    if (role !== token.role) {
      try {
        await roleRefresh.revoke(sessionId, userId);
      } catch (error) {
        console.error(
          "session renewal: could not revoke the replaced session id — " +
            "invalidating session instead",
          error,
        );
        return null;
      }
      const rotated = crypto.randomUUID();
      const previousRole = token.role ?? null;
      logSecurityEvent("session_rotated", {
        userId,
        reason: "role_changed",
        from: previousRole,
        to: role,
      });
      return {
        ...token,
        role,
        sessionId: rotated,
        renewAfter: nowSeconds + RENEW_AFTER_SECONDS,
      };
    }
  }

  // Not revoked: extend the renewal window and return.
  return { ...token, renewAfter: nowSeconds + RENEW_AFTER_SECONDS };
}

/**
 * Record a revocation for the session being signed out.
 *
 * Called from the NextAuth `events.signOut` hook. With the JWT strategy
 * Auth.js emits `{ token }` (the decoded JWT, or null if it could not be
 * decoded); the database strategy emits `{ session }` instead, which carries
 * no `jti` and is ignored here.
 *
 * Never throws: it runs inside the sign-out event, and a throw there must not
 * break sign-out. A duplicate `jti` (signing out twice) is logged and ignored.
 *
 * @param db       Database to write the revocation record to.
 * @param message  The sign-out event payload.
 */
export async function recordSignOut(
  db: AppDatabase,
  message: { token?: JWT | null; session?: unknown },
): Promise<void> {
  const token = message.token;
  const jti = token?.sessionId;
  if (!token || !jti) {
    return;
  }

  const userId = token.id ?? token.sub ?? "";
  try {
    // the device list shows it ended (lib/session/records.ts)
    await db
      .update(userSessions)
      .set({ endedAt: new Date(), endReason: "signed_out" })
      .where(eq(userSessions.id, jti))
      .run();
  } catch (error) {
    console.warn("sign-out: could not mark the session record ended", error);
  }
  try {
    await revokeSession(db, jti, userId);
  } catch (error) {
    console.warn(
      "sign-out: could not record session revocation (already revoked, or store unavailable)",
      error,
    );
  }
}
