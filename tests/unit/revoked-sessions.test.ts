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
  isSessionRevoked,
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
