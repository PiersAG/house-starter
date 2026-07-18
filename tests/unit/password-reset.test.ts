// Password-reset lifecycle tests (v0 graduation — Candidate 2).
//
// Runs lib/password-reset.ts against a REAL in-memory libSQL database brought to
// the current schema by the one true migration path (lib/migrate.ts), same
// pattern as tests/unit/users.test.ts. Asserts the security properties: tokens
// stored HASHED (never raw), single-use, expiring, and no account enumeration.
// Runs in log mode so requestPasswordReset's email send is captured, not sent.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import type { Client } from "@libsql/client";
import { createMigrationDatabase, runMigrations } from "@/lib/migrate";
import { createUser, type AppDatabase } from "@/lib/users";
import { verifyPassword } from "@/lib/password";
import { passwordResetTokens } from "@/lib/schema";
import { clearCapturedEmails, getCapturedEmails } from "@/lib/email/send";
import {
  PasswordResetError,
  RESET_TOKEN_TTL_SECONDS,
  consumePasswordResetToken,
  createPasswordResetToken,
  hashResetToken,
  requestPasswordReset,
  resetPassword,
  verifyPasswordResetToken,
} from "@/lib/password-reset";

let client: Client;
let db: AppDatabase;

async function freshDb(): Promise<{ client: Client; db: AppDatabase }> {
  const c = createMigrationDatabase(":memory:");
  await runMigrations(c);
  return { client: c, db: drizzle(c) as AppDatabase };
}

async function seedUser(email = "user@example.com"): Promise<string> {
  const u = await createUser(db, { email, passwordHash: "placeholder-hash" });
  return u.id;
}

beforeEach(async () => {
  ({ client, db } = await freshDb());
  clearCapturedEmails();
  process.env.EMAIL_SEND_MODE = "log";
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  client.close();
  delete process.env.EMAIL_SEND_MODE;
  vi.restoreAllMocks();
});

describe("token storage — hashed, never raw", () => {
  it("persists only the SHA-256 hash of the token", async () => {
    const userId = await seedUser();
    const { token } = await createPasswordResetToken(db, userId);

    const rows = await db.select().from(passwordResetTokens).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(hashResetToken(token));
    expect(rows[0].tokenHash).not.toBe(token); // the raw token is not stored
    expect(rows[0].usedAt).toBeNull();
  });
});

describe("token lifecycle — verify then consume, single-use", () => {
  it("verifies a fresh token, consumes it once, and rejects reuse", async () => {
    const userId = await seedUser();
    const { token } = await createPasswordResetToken(db, userId);

    const verified = await verifyPasswordResetToken(db, token);
    expect(verified?.userId).toBe(userId);

    const consumedUserId = await consumePasswordResetToken(db, token);
    expect(consumedUserId).toBe(userId);

    // Single-use: verify and consume both fail the second time.
    expect(await verifyPasswordResetToken(db, token)).toBeNull();
    expect(await consumePasswordResetToken(db, token)).toBeNull();
  });

  it("returns null for an unknown token", async () => {
    expect(await verifyPasswordResetToken(db, "not-a-real-token")).toBeNull();
    expect(await consumePasswordResetToken(db, "not-a-real-token")).toBeNull();
  });

  it("rejects an expired token", async () => {
    const userId = await seedUser();
    const issuedAt = new Date("2026-01-01T00:00:00Z");
    const { token } = await createPasswordResetToken(db, userId, issuedAt);

    const afterExpiry = new Date(issuedAt.getTime() + (RESET_TOKEN_TTL_SECONDS + 1) * 1000);
    expect(await verifyPasswordResetToken(db, token, afterExpiry)).toBeNull();
    expect(await consumePasswordResetToken(db, token, afterExpiry)).toBeNull();
  });
});

describe("resetPassword — the full completion step", () => {
  it("sets a new password on a valid token and blocks token reuse", async () => {
    const userId = await seedUser();
    const { token } = await createPasswordResetToken(db, userId);

    const result = await resetPassword(db, token, "a brand new strong password");
    expect(result.userId).toBe(userId);

    // Password actually changed and is verifiable.
    const { getUserById } = await import("@/lib/users");
    const user = await getUserById(db, userId);
    await expect(
      verifyPassword("a brand new strong password", user!.passwordHash),
    ).resolves.toBe(true);

    // Token is now consumed — a second reset with it fails.
    await expect(resetPassword(db, token, "yet another good password")).rejects.toMatchObject({
      code: "invalid_token",
    });
  });

  it("rejects a weak password before touching the token", async () => {
    const userId = await seedUser();
    const { token } = await createPasswordResetToken(db, userId);

    await expect(resetPassword(db, token, "short")).rejects.toBeInstanceOf(PasswordResetError);
    await expect(resetPassword(db, token, "short")).rejects.toMatchObject({
      code: "weak_password",
    });
    // The token was NOT consumed by the failed weak-password attempts.
    expect(await verifyPasswordResetToken(db, token)).not.toBeNull();
  });

  it("rejects an invalid token", async () => {
    await expect(resetPassword(db, "bogus", "a perfectly fine password")).rejects.toMatchObject({
      code: "invalid_token",
    });
  });
});

describe("requestPasswordReset — send + no account enumeration", () => {
  it("issues a token and captures a reset email for a known user", async () => {
    const userId = await seedUser("known@example.com");

    await requestPasswordReset(db, "known@example.com", {
      baseUrl: "https://app.example.com",
    });

    // A row was issued...
    const rows = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, userId))
      .all();
    expect(rows).toHaveLength(1);

    // ...and an email was sent via the send path (captured in log mode).
    const captured = getCapturedEmails();
    expect(captured).toHaveLength(1);
    expect(captured[0].to).toBe("known@example.com");
    expect(captured[0].template).toBe("reset-password");
    expect(captured[0].html).toContain("https://app.example.com/reset-password?token=");
  });

  it("does nothing and reveals nothing for an unknown email", async () => {
    await requestPasswordReset(db, "ghost@example.com", {
      baseUrl: "https://app.example.com",
    });
    expect(await db.select().from(passwordResetTokens).all()).toHaveLength(0);
    expect(getCapturedEmails()).toHaveLength(0);
  });
});
