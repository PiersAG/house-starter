// Account security actions (PiersAG/app-business-core#506, Matt Murphy #133 and
// #52): "sign out of all devices" and a signed-in password change. Run against a
// real in-memory database brought to the current schema (lib/migrate.ts), and
// through the real renewal check, so what is asserted is what production runs:
// a session from before the action is refused at its next renewal; one from
// after it carries on.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import type { Client } from "@libsql/client";
import type { JWT } from "next-auth/jwt";
import { createMigrationDatabase, runMigrations } from "@/lib/migrate";
import { getUserById, registerUser, type AppDatabase } from "@/lib/users";
import { verifyPassword } from "@/lib/password";
import { createPasswordResetToken, verifyPasswordResetToken } from "@/lib/password-reset";
import {
  handleTokenRenewal,
  isSessionBeforeUserCutoff,
  isSessionRevoked,
} from "@/lib/revoked-sessions";
import {
  ChangePasswordError,
  changePassword,
  signOutEverywhere,
} from "@/lib/account-security";

const PASSWORD = "correct horse battery staple";
let client: Client;
let db: AppDatabase;
let userId: string;

beforeEach(async () => {
  client = createMigrationDatabase(":memory:");
  await runMigrations(client);
  db = drizzle(client) as AppDatabase;
  userId = (await registerUser(db, { email: "owner@example.com", password: PASSWORD })).id;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  client.close();
  vi.restoreAllMocks();
});

/** A session that signed in at `authTime` (seconds) and is due for renewal. */
function session(authTime: number): JWT {
  return { id: userId, sessionId: crypto.randomUUID(), renewAfter: 0, authTime } as JWT;
}
const renew = (token: JWT, now: number) =>
  handleTokenRenewal(
    token,
    (jti) => isSessionRevoked(db, jti),
    now,
    (id, authTime) => isSessionBeforeUserCutoff(db, id, authTime),
  );
const events = () =>
  vi
    .mocked(console.warn)
    .mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);

describe("signOutEverywhere", () => {
  it("every session that signed in before it is refused at its next renewal", async () => {
    const at = new Date("2026-11-01T10:00:00Z");
    const t = at.getTime() / 1000;
    const laptop = session(t - 3600);
    const phone = session(t - 60);

    await signOutEverywhere(db, userId, at);

    await expect(renew(laptop, t + 1)).resolves.toBeNull();
    await expect(renew(phone, t + 1)).resolves.toBeNull();
    // A sign-in after the action works normally.
    await expect(renew(session(t + 5), t + 6)).resolves.not.toBeNull();
  });

  it("cancels open reset links and logs the event", async () => {
    const at = new Date("2026-11-01T10:00:00Z");
    const { token } = await createPasswordResetToken(db, userId, at);
    await signOutEverywhere(db, userId, at);
    expect(await verifyPasswordResetToken(db, token, at)).toBeNull();
    expect(events()).toEqual([
      expect.objectContaining({ security_event: "signed_out_everywhere", userId, resetLinksCancelled: 1 }),
    ]);
  });
});

describe("changePassword", () => {
  const NEW = "a completely different passphrase";

  it("sets the new password and ends every earlier session", async () => {
    const at = new Date("2026-11-01T10:00:00Z");
    const t = at.getTime() / 1000;
    const other = session(t - 600);

    await changePassword(db, userId, PASSWORD, NEW, at);

    const user = await getUserById(db, userId);
    await expect(verifyPassword(NEW, user!.passwordHash)).resolves.toBe(true);
    await expect(verifyPassword(PASSWORD, user!.passwordHash)).resolves.toBe(false);
    expect(user!.sessionsValidFrom).toEqual(at);
    await expect(renew(other, t + 1)).resolves.toBeNull();
    expect(events()).toEqual([
      expect.objectContaining({ security_event: "password_changed", userId, resetLinksCancelled: 0 }),
    ]);
  });

  it("cancels open reset links", async () => {
    const at = new Date("2026-11-01T10:00:00Z");
    const { token } = await createPasswordResetToken(db, userId, at);
    await changePassword(db, userId, PASSWORD, NEW, at);
    expect(await verifyPasswordResetToken(db, token, at)).toBeNull();
  });

  it.each([
    ["wrong current password", "not my password", NEW, "wrong_password"],
    ["weak new password", PASSWORD, "short", "weak_password"],
    ["new password same as current", PASSWORD, PASSWORD, "same_password"],
  ])("refuses a %s and writes nothing", async (_label, current, next, code) => {
    await expect(changePassword(db, userId, current, next)).rejects.toMatchObject({ code });
    await expect(changePassword(db, userId, current, next)).rejects.toBeInstanceOf(
      ChangePasswordError,
    );
    const user = await getUserById(db, userId);
    await expect(verifyPassword(PASSWORD, user!.passwordHash)).resolves.toBe(true);
    expect(user!.sessionsValidFrom).toBeNull();
    expect(events()).toEqual([]);
  });

  it("refuses an unknown account as a wrong password", async () => {
    await expect(changePassword(db, "no-such-user", PASSWORD, NEW)).rejects.toMatchObject({
      code: "wrong_password",
    });
  });
});
