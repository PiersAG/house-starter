// Revoked-sessions unit tests (CEO ruling 2026-07-15 — server-side session
// invalidation with short-lived tokens + renewal-time revocation).
//
// Three explicit test requirements from the CEO ruling:
//   (a) Logout then reuse of the old token fails at renewal.
//   (b) An active user is NOT logged out by rolling renewal.
//   (c) Renewal cost is renewal-time only — no per-request DB hit on ordinary
//       page loads.
//
// Tests run against a real in-memory libSQL database so what is asserted here
// is what production code executes (no mocked query builder).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import type { Client } from "@libsql/client";
import type { JWT } from "next-auth/jwt";
import { createMigrationDatabase, runMigrations } from "@/lib/migrate";
import { registerUser } from "@/lib/users";
import type { AppDatabase } from "@/lib/users";
import {
  RENEW_AFTER_SECONDS,
  handleTokenRenewal,
  isSessionBeforeUserCutoff,
  isSessionRevoked,
  recordSignOut,
  revokeSession,
} from "@/lib/revoked-sessions";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let client: Client;
let db: AppDatabase;

async function freshDb(): Promise<{ client: Client; db: AppDatabase }> {
  const c = createMigrationDatabase(":memory:");
  await runMigrations(c);
  return { client: c, db: drizzle(c) as AppDatabase };
}

beforeEach(async () => {
  ({ client, db } = await freshDb());
});

afterEach(() => {
  client.close();
});

/** Seed a minimal user and return its id. */
async function seedUser(): Promise<string> {
  const user = await registerUser(db, {
    email: `test-${crypto.randomUUID()}@example.com`,
    password: "correct horse battery staple",
  });
  return user.id;
}

// ---------------------------------------------------------------------------
// DB functions: revokeSession + isSessionRevoked
// ---------------------------------------------------------------------------

describe("revokeSession", () => {
  it("inserts a revocation record that isSessionRevoked detects", async () => {
    const userId = await seedUser();
    const jti = crypto.randomUUID();

    // Before revocation: not revoked
    await expect(isSessionRevoked(db, jti)).resolves.toBe(false);

    // After revocation: revoked
    await revokeSession(db, jti, userId);
    await expect(isSessionRevoked(db, jti)).resolves.toBe(true);
  });

  it("throws on duplicate jti (UNIQUE constraint — double-logout is idempotent at the caller level)", async () => {
    const userId = await seedUser();
    const jti = crypto.randomUUID();

    await revokeSession(db, jti, userId);
    await expect(revokeSession(db, jti, userId)).rejects.toThrow();
  });
});

describe("isSessionRevoked", () => {
  it("returns false for an unknown jti — no phantom revocation", async () => {
    await expect(isSessionRevoked(db, "nonexistent-jti")).resolves.toBe(false);
  });

  it("returns true only for the specific jti that was revoked", async () => {
    const userId = await seedUser();
    const jtiA = crypto.randomUUID();
    const jtiB = crypto.randomUUID();

    await revokeSession(db, jtiA, userId);

    await expect(isSessionRevoked(db, jtiA)).resolves.toBe(true);
    await expect(isSessionRevoked(db, jtiB)).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleTokenRenewal — the pure renewal logic (no NextAuth internals needed)
// ---------------------------------------------------------------------------

/** Build a minimal JWT token with sessionId and renewAfter set. */
function makeToken(sessionId: string, renewAfter: number): JWT {
  return {
    sessionId,
    renewAfter,
    sub: "user-1",
    iat: Math.floor(Date.now() / 1000) - 60,
    exp: Math.floor(Date.now() / 1000) + 900,
  } as JWT;
}

describe("handleTokenRenewal", () => {
  // CEO ruling test (c): no DB hit on ordinary page loads
  it("(c) returns token UNCHANGED and does NOT call checkRevoked when now < renewAfter", async () => {
    const token = makeToken("jti-1", 9999999999); // renewAfter far in the future
    const checkRevoked = vi.fn<(jti: string) => Promise<boolean>>();

    const result = await handleTokenRenewal(token, checkRevoked, 100);

    expect(checkRevoked).not.toHaveBeenCalled();
    expect(result).toEqual(token); // token returned unchanged
  });

  // CEO ruling test (a): revoked token fails at renewal
  it("(a) returns null when the session jti is revoked at renewal time", async () => {
    const token = makeToken("jti-revoked", 0); // renewAfter = 0, so now >= renewAfter
    const checkRevoked = vi.fn<(jti: string) => Promise<boolean>>().mockResolvedValue(true);

    const result = await handleTokenRenewal(token, checkRevoked, 100);

    expect(checkRevoked).toHaveBeenCalledWith("jti-revoked");
    expect(result).toBeNull();
  });

  // CEO ruling test (b): active user is NOT logged out by rolling renewal
  it("(b) extends renewAfter and returns token when jti is NOT revoked at renewal time", async () => {
    const now = 5000;
    const token = makeToken("jti-active", 0); // renewAfter in the past → time to renew
    const checkRevoked = vi.fn<(jti: string) => Promise<boolean>>().mockResolvedValue(false);

    const result = await handleTokenRenewal(token, checkRevoked, now);

    expect(checkRevoked).toHaveBeenCalledWith("jti-active");
    expect(result).not.toBeNull();
    // renewAfter is extended by RENEW_AFTER_SECONDS from now
    expect((result as JWT).renewAfter).toBe(now + RENEW_AFTER_SECONDS);
    // Other token fields are preserved
    expect((result as JWT).sub).toBe("user-1");
  });

  it("returns token unchanged when sessionId is missing (pre-revocation-tracking sessions)", async () => {
    const token: JWT = { sub: "user-1" } as JWT; // no sessionId
    const checkRevoked = vi.fn();

    const result = await handleTokenRenewal(token, checkRevoked, 100);

    expect(checkRevoked).not.toHaveBeenCalled();
    expect(result).toEqual(token);
  });

  it("returns token unchanged when renewAfter is missing", async () => {
    const token: JWT = { sessionId: "jti-old", sub: "user-1" } as JWT;
    const checkRevoked = vi.fn();

    const result = await handleTokenRenewal(token, checkRevoked, 100);

    expect(checkRevoked).not.toHaveBeenCalled();
    expect(result).toEqual(token);
  });

  it("calls checkRevoked exactly once at the renewal threshold (boundary: now === renewAfter)", async () => {
    const now = 1000;
    const token = makeToken("jti-boundary", now); // renewAfter === now
    const checkRevoked = vi.fn<(jti: string) => Promise<boolean>>().mockResolvedValue(false);

    await handleTokenRenewal(token, checkRevoked, now);

    expect(checkRevoked).toHaveBeenCalledTimes(1);
  });

  it("RENEW_AFTER_SECONDS is the constant used to extend the renewal window", () => {
    expect(typeof RENEW_AFTER_SECONDS).toBe("number");
    expect(RENEW_AFTER_SECONDS).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: full revoke → renewal-check cycle using the real DB
// ---------------------------------------------------------------------------

describe("revoke then renewal-check integration", () => {
  it("a revoked jti is detected by handleTokenRenewal using the real DB", async () => {
    const userId = await seedUser();
    const jti = crypto.randomUUID();

    // Revoke the session (simulates logout)
    await revokeSession(db, jti, userId);

    // Build a token with renewAfter in the past (renewal time)
    const token = makeToken(jti, 0);
    const result = await handleTokenRenewal(
      token,
      (id) => isSessionRevoked(db, id),
      100,
    );

    // Token must be invalidated (CEO test (a): logout then reuse fails at renewal)
    expect(result).toBeNull();
  });

  it("an unrevoked session passes renewal and gets an extended renewAfter", async () => {
    const jti = crypto.randomUUID();
    const now = 5000;
    const token = makeToken(jti, 0); // renewal due

    const result = await handleTokenRenewal(
      token,
      (id) => isSessionRevoked(db, id),
      now,
    );

    // Token is valid — user stays logged in (CEO test (b))
    expect(result).not.toBeNull();
    expect((result as JWT).renewAfter).toBe(now + RENEW_AFTER_SECONDS);
  });

  it("a throwing revocation store invalidates the session instead of escaping (never a 500)", async () => {
    // Live incident class (k9coach preview 2026-07-16): a remote-DB error in
    // the renewal path must never escape the jwt callback as a raw throw.
    // Fail closed: return null so the user is redirected to /login.
    const token = makeToken(crypto.randomUUID(), 0); // renewal due

    const result = await handleTokenRenewal(
      token,
      () => Promise.reject(new Error("connect ETIMEDOUT 52.18.151.235:443")),
      100,
    );

    expect(result).toBeNull();
  });

  it("a store failure BEFORE renewal time never triggers a DB call at all", async () => {
    const token = makeToken(crypto.randomUUID(), 10_000); // renewal NOT due
    const checkRevoked = () => Promise.reject(new Error("must not be called"));

    const result = await handleTokenRenewal(token, checkRevoked, 100);

    expect(result).toBe(token); // unchanged, no DB hit
  });
});

// ---------------------------------------------------------------------------
// Per-user cutoff — a password reset ends every session that signed in before it
// ---------------------------------------------------------------------------

type CutoffCheck = (userId: string, authTime: number | undefined) => Promise<boolean>;

/** A renewal-due token for `userId` that signed in at `authTime`. */
function makeStampedToken(userId: string, authTime?: number): JWT {
  const token = { ...makeToken(crypto.randomUUID(), 0), id: userId } as JWT;
  if (authTime !== undefined) token.authTime = authTime;
  return token;
}

const notRevoked = () => Promise.resolve(false);

/** Set a user's cutoff directly (what resetPassword writes). */
async function setCutoff(userId: string, seconds: number | null): Promise<void> {
  await client.execute({
    sql: "UPDATE users SET sessions_valid_from = ? WHERE id = ?;",
    args: [seconds, userId],
  });
}

describe("handleTokenRenewal — per-user cutoff", () => {
  it("rejects a token whose authTime is earlier than the cutoff", async () => {
    const checkUserCutoff = vi.fn<CutoffCheck>().mockResolvedValue(true);
    const token = makeStampedToken("user-1", 1000);

    const result = await handleTokenRenewal(token, notRevoked, 5000, checkUserCutoff);

    expect(checkUserCutoff).toHaveBeenCalledWith("user-1", 1000);
    expect(result).toBeNull();
  });

  it("passes a token whose authTime is at/after the cutoff and extends renewAfter", async () => {
    const checkUserCutoff = vi.fn<CutoffCheck>().mockResolvedValue(false);
    const token = makeStampedToken("user-1", 3000);

    const result = await handleTokenRenewal(token, notRevoked, 5000, checkUserCutoff);

    expect(result).not.toBeNull();
    expect((result as JWT).renewAfter).toBe(5000 + RENEW_AFTER_SECONDS);
    expect((result as JWT).authTime).toBe(3000);
  });

  it("rejects a token with NO authTime without a DB hit (fail closed)", async () => {
    const checkUserCutoff = vi.fn<CutoffCheck>();
    const token = makeStampedToken("user-1"); // unstamped

    const result = await handleTokenRenewal(token, notRevoked, 5000, checkUserCutoff);

    expect(checkUserCutoff).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("does not consult the cutoff before renewal time", async () => {
    const checkUserCutoff = vi.fn<CutoffCheck>();
    const token = { ...makeToken("jti-x", 10_000), id: "user-1" } as JWT; // unstamped, not due

    const result = await handleTokenRenewal(token, notRevoked, 100, checkUserCutoff);

    expect(checkUserCutoff).not.toHaveBeenCalled();
    expect(result).toBe(token);
  });

  it("a revoked jti is still rejected before the cutoff is consulted", async () => {
    const checkUserCutoff = vi.fn<CutoffCheck>().mockResolvedValue(false);
    const token = makeStampedToken("user-1", 3000);

    const result = await handleTokenRenewal(
      token,
      () => Promise.resolve(true),
      5000,
      checkUserCutoff,
    );

    expect(result).toBeNull();
    expect(checkUserCutoff).not.toHaveBeenCalled();
  });

  it("a throwing cutoff store invalidates the session instead of escaping", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const token = makeStampedToken("user-1", 3000);

    const result = await handleTokenRenewal(token, notRevoked, 5000, () =>
      Promise.reject(new Error("connect ETIMEDOUT")),
    );

    expect(result).toBeNull();
    error.mockRestore();
  });

  it("without checkUserCutoff an unstamped token renews exactly as before", async () => {
    const token = makeToken("jti-legacy", 0);

    const result = await handleTokenRenewal(token, notRevoked, 5000);

    expect(result).not.toBeNull();
    expect((result as JWT).renewAfter).toBe(5000 + RENEW_AFTER_SECONDS);
  });
});

describe("isSessionBeforeUserCutoff + renewal against the real DB", () => {
  const renew = (token: JWT) =>
    handleTokenRenewal(
      token,
      (id) => isSessionRevoked(db, id),
      5000,
      (userId, authTime) => isSessionBeforeUserCutoff(db, userId, authTime),
    );

  it("a user with a NULL cutoff (never reset) passes", async () => {
    const userId = await seedUser();
    await expect(isSessionBeforeUserCutoff(db, userId, 1000)).resolves.toBe(false);
    await expect(renew(makeStampedToken(userId, 1000))).resolves.not.toBeNull();
  });

  it("a session that signed in before the cutoff is rejected", async () => {
    const userId = await seedUser();
    await setCutoff(userId, 2000);
    await expect(isSessionBeforeUserCutoff(db, userId, 1999)).resolves.toBe(true);
    await expect(renew(makeStampedToken(userId, 1999))).resolves.toBeNull();
  });

  it("a session that signed in at or after the cutoff passes", async () => {
    const userId = await seedUser();
    await setCutoff(userId, 2000);
    await expect(isSessionBeforeUserCutoff(db, userId, 2000)).resolves.toBe(false);
    await expect(renew(makeStampedToken(userId, 2000))).resolves.not.toBeNull();
    await expect(renew(makeStampedToken(userId, 2500))).resolves.not.toBeNull();
  });

  it("a missing authTime or an unknown user is treated as before the cutoff", async () => {
    const userId = await seedUser();
    await expect(isSessionBeforeUserCutoff(db, userId, undefined)).resolves.toBe(true);
    await expect(isSessionBeforeUserCutoff(db, "no-such-user", 1000)).resolves.toBe(true);
    await expect(renew(makeStampedToken(userId))).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// recordSignOut — the events.signOut helper (sign-out must record revocation)
// ---------------------------------------------------------------------------

describe("recordSignOut", () => {
  it("records a revocation that the renewal check then enforces", async () => {
    const userId = await seedUser();
    const jti = crypto.randomUUID();
    const token = { ...makeToken(jti, 0), id: userId } as JWT;

    await recordSignOut(db, { token });

    await expect(isSessionRevoked(db, jti)).resolves.toBe(true);
    const result = await handleTokenRenewal(
      token,
      (id) => isSessionRevoked(db, id),
      100,
    );
    expect(result).toBeNull();
  });

  it("is a no-op when there is no token or no sessionId", async () => {
    const countRows = async () =>
      Number(
        (await client.execute("SELECT COUNT(*) AS n FROM revoked_sessions"))
          .rows[0].n,
      );

    await expect(recordSignOut(db, { token: null })).resolves.toBeUndefined();
    await expect(recordSignOut(db, {})).resolves.toBeUndefined();
    await expect(
      recordSignOut(db, { token: { sub: "user-1" } as JWT }),
    ).resolves.toBeUndefined();

    expect(await countRows()).toBe(0);
  });

  it("swallows a duplicate sign-out for the same sessionId", async () => {
    const userId = await seedUser();
    const jti = crypto.randomUUID();
    const token = { ...makeToken(jti, 0), id: userId } as JWT;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(recordSignOut(db, { token })).resolves.toBeUndefined();
    await expect(recordSignOut(db, { token })).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    await expect(isSessionRevoked(db, jti)).resolves.toBe(true);
    warn.mockRestore();
  });
});
