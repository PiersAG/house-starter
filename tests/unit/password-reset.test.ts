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
  RESET_REQUEST_WINDOW_SECONDS,
  RESET_REQUESTS_PER_EMAIL,
  RESET_TOKEN_TTL_SECONDS,
  cancelOpenResetTokens,
  consumePasswordResetToken,
  countRecentResetRequests,
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
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

/** The security events written so far (lib/security-log.ts lines on console.warn). */
function securityEvents(): Array<Record<string, unknown>> {
  return vi
    .mocked(console.warn)
    .mock.calls.map((c) => String(c[0]))
    .filter((line) => line.startsWith('{"security_event"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

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

  it("sets the per-user session cutoff (sessionsValidFrom) to the reset time", async () => {
    const userId = await seedUser();
    const { getUserById } = await import("@/lib/users");
    expect((await getUserById(db, userId))!.sessionsValidFrom).toBeNull();

    const now = new Date("2026-09-17T12:00:00Z");
    const { token } = await createPasswordResetToken(db, userId, now);
    await resetPassword(db, token, "a brand new strong password", now);

    const user = await getUserById(db, userId);
    expect(user!.sessionsValidFrom).toEqual(now);
  });

  it("leaves the cutoff unset when the reset fails", async () => {
    const userId = await seedUser();
    const { token } = await createPasswordResetToken(db, userId);
    await expect(resetPassword(db, token, "short")).rejects.toBeInstanceOf(PasswordResetError);

    const { getUserById } = await import("@/lib/users");
    expect((await getUserById(db, userId))!.sessionsValidFrom).toBeNull();
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

// ── #515 (Matt Murphy #27): old or extra reset links must not become standing
// account keys. 15-minute expiry; 3 requests per email per hour plus the IP
// throttle; every other open link cancelled on reset; requests and completions
// logged. The generic response is unchanged throughout.
describe("#515 password-reset hardening", () => {
  const BASE = { baseUrl: "https://app.example.com" };

  it("a link lives 15 minutes: valid just before, refused just after", async () => {
    expect(RESET_TOKEN_TTL_SECONDS).toBe(15 * 60);
    const userId = await seedUser();
    const issuedAt = new Date("2026-11-01T09:00:00Z");
    const { token, expiresAt } = await createPasswordResetToken(db, userId, issuedAt);
    expect(expiresAt.getTime() - issuedAt.getTime()).toBe(15 * 60 * 1000);

    const justBefore = new Date(issuedAt.getTime() + (15 * 60 - 1) * 1000);
    const atExpiry = new Date(issuedAt.getTime() + 15 * 60 * 1000);
    expect(await verifyPasswordResetToken(db, token, justBefore)).not.toBeNull();
    expect(await verifyPasswordResetToken(db, token, atExpiry)).toBeNull();
  });

  it("the reset email states the 15-minute expiry", async () => {
    await seedUser("known@example.com");
    await requestPasswordReset(db, "known@example.com", BASE);
    const [mail] = getCapturedEmails();
    expect(mail.html).toContain("expires in 15 minutes");
    expect(mail.html).not.toContain("one hour");
  });

  it("at most 3 links per email per hour; the 4th is silently not sent", async () => {
    expect(RESET_REQUESTS_PER_EMAIL).toBe(3);
    expect(RESET_REQUEST_WINDOW_SECONDS).toBe(60 * 60);
    const userId = await seedUser("known@example.com");
    const t0 = new Date("2026-11-01T09:00:00Z");
    for (let i = 0; i < 4; i++) {
      // Generic response: resolves with nothing, every time.
      await expect(
        requestPasswordReset(db, "known@example.com", BASE, new Date(t0.getTime() + i * 60_000)),
      ).resolves.toBeUndefined();
    }
    expect(getCapturedEmails()).toHaveLength(3);
    expect(await countRecentResetRequests(db, userId, new Date(t0.getTime() + 4 * 60_000))).toBe(3);
    const limited = securityEvents().filter((e) => e.security_event === "password_reset_request_limited");
    expect(limited).toHaveLength(1);
    expect(limited[0]).toMatchObject({ userId, requestsThisHour: 3 });
  });

  it("spending a link does not buy another inside the hour", async () => {
    const userId = await seedUser("known@example.com");
    const t0 = new Date("2026-11-01T09:00:00Z");
    for (let i = 0; i < 3; i++) {
      const { token } = await createPasswordResetToken(db, userId, new Date(t0.getTime() + i * 1000));
      await consumePasswordResetToken(db, token, new Date(t0.getTime() + i * 1000));
    }
    await requestPasswordReset(db, "known@example.com", BASE, new Date(t0.getTime() + 10_000));
    expect(getCapturedEmails()).toHaveLength(0);
  });

  it("the per-email budget comes back once the hour has passed", async () => {
    await seedUser("known@example.com");
    const t0 = new Date("2026-11-01T09:00:00Z");
    for (let i = 0; i < 3; i++) await requestPasswordReset(db, "known@example.com", BASE, t0);
    await requestPasswordReset(db, "known@example.com", BASE, new Date(t0.getTime() + 30 * 60_000));
    expect(getCapturedEmails()).toHaveLength(3);
    await requestPasswordReset(
      db,
      "known@example.com",
      BASE,
      new Date(t0.getTime() + (RESET_REQUEST_WINDOW_SECONDS + 1) * 1000),
    );
    expect(getCapturedEmails()).toHaveLength(4);
  });

  it("the per-email limit is per account: another account is unaffected", async () => {
    await seedUser("a@example.com");
    await seedUser("b@example.com");
    const t0 = new Date("2026-11-01T09:00:00Z");
    for (let i = 0; i < 4; i++) await requestPasswordReset(db, "a@example.com", BASE, t0);
    await requestPasswordReset(db, "b@example.com", BASE, t0);
    expect(getCapturedEmails().map((m) => m.to)).toEqual([
      "a@example.com",
      "a@example.com",
      "a@example.com",
      "b@example.com",
    ]);
  });

  it("a completed reset cancels every other open link for the account", async () => {
    const userId = await seedUser();
    const otherId = await seedUser("other@example.com");
    const now = new Date("2026-11-01T09:00:00Z");
    const first = await createPasswordResetToken(db, userId, now);
    const second = await createPasswordResetToken(db, userId, now);
    const third = await createPasswordResetToken(db, userId, now);
    const othersLink = await createPasswordResetToken(db, otherId, now);

    await resetPassword(db, second.token, "a brand new strong password", now);

    expect(await verifyPasswordResetToken(db, first.token, now)).toBeNull();
    expect(await verifyPasswordResetToken(db, third.token, now)).toBeNull();
    await expect(
      resetPassword(db, first.token, "another strong password", now),
    ).rejects.toMatchObject({ code: "invalid_token" });
    // Another account's open link is untouched.
    expect(await verifyPasswordResetToken(db, othersLink.token, now)).not.toBeNull();
  });

  it("cancelOpenResetTokens reports how many it cancelled and leaves used ones alone", async () => {
    const userId = await seedUser();
    const now = new Date("2026-11-01T09:00:00Z");
    const used = await createPasswordResetToken(db, userId, now);
    await consumePasswordResetToken(db, used.token, now);
    await createPasswordResetToken(db, userId, now);
    await createPasswordResetToken(db, userId, now);
    expect(await cancelOpenResetTokens(db, userId, now)).toBe(2);
    expect(await cancelOpenResetTokens(db, userId, now)).toBe(0);
  });

  it("logs requests and completions — ids only, never the token, link or email", async () => {
    const userId = await seedUser("known@example.com");
    const now = new Date("2026-11-01T09:00:00Z");
    await requestPasswordReset(db, "known@example.com", BASE, now);
    await requestPasswordReset(db, "ghost@example.com", BASE, now);
    const [mail] = getCapturedEmails();
    const token = new URL(mail.html.match(/https:\/\/app\.example\.com\/reset-password\?token=[^"\s<]+/)![0])
      .searchParams.get("token")!;
    await resetPassword(db, token, "a brand new strong password", now);

    const events = securityEvents();
    expect(events.map((e) => e.security_event)).toEqual([
      "password_reset_requested",
      "password_reset_requested",
      "password_reset_completed",
    ]);
    expect(events[0]).toMatchObject({ knownAccount: true, userId });
    expect(events[1]).toMatchObject({ knownAccount: false });
    expect(events[1]).not.toHaveProperty("userId");
    expect(events[2]).toMatchObject({ userId, otherLinksCancelled: 0 });
    const all = vi.mocked(console.warn).mock.calls.map((c) => String(c[0])).join("\n");
    expect(all).not.toContain(token);
    expect(all).not.toContain("known@example.com");
    expect(all).not.toContain("ghost@example.com");
    expect(all).not.toContain("reset-password?token");
  });
});

describe("consumePasswordResetToken — two consumers at once", () => {
  it("only one of two concurrent consumers of the same link succeeds", async () => {
    const userId = await seedUser();
    const { token } = await createPasswordResetToken(db, userId);
    const results = await Promise.all([
      consumePasswordResetToken(db, token),
      consumePasswordResetToken(db, token),
    ]);
    expect(results.filter((r) => r === userId)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(1);
  });
});
