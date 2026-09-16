// lib/mfa/enrollment.ts — enrollment, verification and the sign-in decision,
// against a REAL migrated in-memory catalog (SEC.15, Slice 1).
//
// What is being proven, beyond "it works":
//   • the secret is stored sealed, never in plain text;
//   • recovery codes exist the moment the factor is active (anti-lockout);
//   • every code is single-use, including under concurrent submission;
//   • the failure ceiling stops authenticator guessing but never removes the
//     recovery path;
//   • only a LIVE OWNER grant makes MFA mandatory, and an owner who has not
//     enrolled is marked, not refused.
//
// A few branches only happen when another request changes the row between this
// module's read and its write. Those are forced deterministically with a
// catalog handle whose FIRST select returns a stale row (`staleOnce`).

import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { generate } from "otplib";
import { createMigrationDatabase, runMigrations } from "@/lib/migrate";
import { createUser, type AppDatabase } from "@/lib/users";
import { grantAccess } from "@/lib/billing/grants";
import { openSecret } from "@/lib/crypto/secret-box";
import { userMfaRecoveryCodes, userMfaTotp, type UserMfaTotp } from "@/lib/schema";
import {
  beginTotpEnrollment,
  claimTotpStep,
  confirmTotpEnrollment,
  getTotpFactor,
  isMfaActive,
  isMfaRequired,
  MFA_MAX_CONSECUTIVE_FAILURES,
  remainingRecoveryCodes,
  resolveSignInFactor,
  verifySecondFactor,
} from "@/lib/mfa/enrollment";
import { TOTP_PERIOD_SECONDS } from "@/lib/mfa/totp";

const key = randomBytes(32);
const T0 = new Date(1_900_000_020 * 1000);
const DAY_MS = 86_400_000;
let db: AppDatabase;

beforeEach(async () => {
  const c = createMigrationDatabase(":memory:");
  await runMigrations(c);
  db = drizzle(c) as AppDatabase;
});

async function user(email = "owner@example.com"): Promise<string> {
  return (await createUser(db, { email, passwordHash: "hash" })).id;
}

function at(steps: number): Date {
  return new Date(T0.getTime() + steps * TOTP_PERIOD_SECONDS * 1000);
}

async function codeFor(secret: string, when: Date): Promise<string> {
  return generate({ secret, epoch: Math.floor(when.getTime() / 1000) });
}

/** Enroll and confirm; returns the secret and the recovery codes. */
async function enrolled(userId: string): Promise<{ secret: string; recoveryCodes: string[] }> {
  const begun = await beginTotpEnrollment(db, {
    userId,
    key,
    issuer: "App",
    accountLabel: "owner@example.com",
  });
  if (begun.status !== "started") throw new Error("expected started");
  const confirmed = await confirmTotpEnrollment(db, {
    userId,
    key,
    code: await codeFor(begun.secret, T0),
    now: T0,
  });
  if (confirmed.status !== "confirmed") throw new Error("expected confirmed");
  return { secret: begun.secret, recoveryCodes: confirmed.recoveryCodes };
}

/** A catalog handle whose first select resolves to `row` (a stale read). */
function staleOnce(row: UserMfaTotp | undefined): AppDatabase {
  let used = false;
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "select" && !used) {
        used = true;
        const chain = {
          from: () => chain,
          where: () => chain,
          limit: () => chain,
          all: async () => (row ? [row] : []),
        };
        return () => chain;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

describe("policy: who must use MFA", () => {
  it("nobody without a grant; not testers or comps; a live owner grant yes; an expired one no", async () => {
    const plain = await user("plain@example.com");
    expect(await isMfaRequired(db, plain)).toBe(false);

    const tester = await user("tester@example.com");
    await grantAccess(db, { userId: tester, type: "tester" });
    expect(await isMfaRequired(db, tester)).toBe(false);

    const owner = await user("owner@example.com");
    await grantAccess(db, { userId: owner, type: "owner" });
    expect(await isMfaRequired(db, owner, T0)).toBe(true);

    await grantAccess(db, {
      userId: owner,
      type: "owner",
      expiresAt: new Date(T0.getTime() - DAY_MS),
    });
    expect(await isMfaRequired(db, owner, T0)).toBe(false);
  });
});

describe("enrollment", () => {
  it("starts unconfirmed, stores the secret sealed, and returns a scannable URI", async () => {
    const uid = await user();
    expect(await getTotpFactor(db, uid)).toBeUndefined();

    const begun = await beginTotpEnrollment(db, {
      userId: uid,
      key,
      issuer: "App",
      accountLabel: "owner@example.com",
    });
    expect(begun.status).toBe("started");
    if (begun.status !== "started") return;
    expect(begun.otpauthUri).toContain(`secret=${begun.secret}`);

    const row = (await getTotpFactor(db, uid))!;
    expect(row.confirmedAt).toBeNull();
    expect(JSON.stringify(row)).not.toContain(begun.secret);
    expect(
      openSecret({ ciphertext: row.secretCiphertext, iv: row.secretIv, tag: row.secretTag }, key, uid),
    ).toBe(begun.secret);
    expect(await isMfaActive(db, uid)).toBe(false);
  });

  it("restarting replaces an unconfirmed secret; a code for the old one no longer confirms", async () => {
    const uid = await user();
    const first = await beginTotpEnrollment(db, { userId: uid, key, issuer: "App", accountLabel: "a" });
    const second = await beginTotpEnrollment(db, { userId: uid, key, issuer: "App", accountLabel: "a" });
    if (first.status !== "started" || second.status !== "started") throw new Error("expected started");
    expect(second.secret).not.toBe(first.secret);

    const stale = await confirmTotpEnrollment(db, {
      userId: uid,
      key,
      code: await codeFor(first.secret, T0),
      now: T0,
    });
    expect(stale).toEqual({ status: "invalid_code" });
  });

  it("confirm: not started, then a wrong code, then the right code activates AND issues ten recovery codes", async () => {
    const uid = await user();
    expect(await confirmTotpEnrollment(db, { userId: uid, key, code: "123456", now: T0 })).toEqual({
      status: "not_started",
    });

    const begun = await beginTotpEnrollment(db, { userId: uid, key, issuer: "App", accountLabel: "a" });
    if (begun.status !== "started") throw new Error("expected started");
    const good = await codeFor(begun.secret, T0);
    const wrong = String((Number(good) + 1) % 1_000_000).padStart(6, "0");
    expect(await confirmTotpEnrollment(db, { userId: uid, key, code: wrong, now: T0 })).toEqual({
      status: "invalid_code",
    });
    expect(await isMfaActive(db, uid)).toBe(false);

    const confirmed = await confirmTotpEnrollment(db, { userId: uid, key, code: good, now: T0 });
    expect(confirmed.status).toBe("confirmed");
    if (confirmed.status !== "confirmed") return;
    expect(confirmed.recoveryCodes).toHaveLength(10);
    expect(await isMfaActive(db, uid)).toBe(true);
    expect(await remainingRecoveryCodes(db, uid)).toBe(10);

    // Only hashes are stored.
    const stored = await db.select().from(userMfaRecoveryCodes).where(eq(userMfaRecoveryCodes.userId, uid)).all();
    for (const code of confirmed.recoveryCodes) {
      expect(JSON.stringify(stored)).not.toContain(code);
    }

    // The confirming code is itself used up.
    const row = (await getTotpFactor(db, uid))!;
    expect(row.lastUsedStep).toBe(Math.floor(T0.getTime() / 1000 / TOTP_PERIOD_SECONDS));
    expect(await verifySecondFactor(db, { userId: uid, getKey: () => key, code: good, now: T0 })).toEqual({
      status: "invalid",
    });
  });

  it("an active factor is never overwritten or re-confirmed", async () => {
    const uid = await user();
    const { secret } = await enrolled(uid);
    expect(await beginTotpEnrollment(db, { userId: uid, key, issuer: "App", accountLabel: "a" })).toEqual({
      status: "already_active",
    });
    expect(
      await confirmTotpEnrollment(db, { userId: uid, key, code: await codeFor(secret, at(1)), now: at(1) }),
    ).toEqual({ status: "already_active" });
  });

  it("begin: a factor confirmed between the read and the write is left alone", async () => {
    const uid = await user();
    const { secret } = await enrolled(uid);
    const before = (await getTotpFactor(db, uid))!;
    const result = await beginTotpEnrollment(staleOnce(undefined), {
      userId: uid,
      key,
      issuer: "App",
      accountLabel: "a",
    });
    expect(result).toEqual({ status: "already_active" });
    const after = (await getTotpFactor(db, uid))!;
    expect(after.secretCiphertext).toBe(before.secretCiphertext);
    expect(
      await verifySecondFactor(db, { userId: uid, getKey: () => key, code: await codeFor(secret, at(1)), now: at(1) }),
    ).toEqual({ status: "verified", method: "totp" });
  });

  it("confirm: losing the race to a concurrent confirm does not issue a second set of codes", async () => {
    const uid = await user();
    const { secret } = await enrolled(uid);
    const row = (await getTotpFactor(db, uid))!;
    const staleRow = { ...row, confirmedAt: null, lastUsedStep: null };
    const result = await confirmTotpEnrollment(staleOnce(staleRow), {
      userId: uid,
      key,
      code: await codeFor(secret, at(1)),
      now: at(1),
    });
    expect(result).toEqual({ status: "invalid_code" });
    expect(await remainingRecoveryCodes(db, uid)).toBe(10);
  });
});

describe("real clock", () => {
  it("confirm and recovery use the current time when none is given", async () => {
    const uid = await user();
    const begun = await beginTotpEnrollment(db, { userId: uid, key, issuer: "App", accountLabel: "a" });
    if (begun.status !== "started") throw new Error("expected started");
    const confirmed = await confirmTotpEnrollment(db, {
      userId: uid,
      key,
      code: await generate({ secret: begun.secret }),
    });
    expect(confirmed.status).toBe("confirmed");
    if (confirmed.status !== "confirmed") return;
    expect((await getTotpFactor(db, uid))!.confirmedAt).toBeInstanceOf(Date);
    expect(
      await verifySecondFactor(db, { userId: uid, getKey: () => key, code: confirmed.recoveryCodes[0] }),
    ).toEqual({ status: "verified", method: "recovery_code" });
  });
});

describe("verifySecondFactor", () => {
  it("not enrolled, or enrolled but unconfirmed, is never a pass", async () => {
    const uid = await user();
    expect(await verifySecondFactor(db, { userId: uid, getKey: () => key, code: "123456", now: T0 })).toEqual({
      status: "not_enrolled",
    });
    await beginTotpEnrollment(db, { userId: uid, key, issuer: "App", accountLabel: "a" });
    expect(await verifySecondFactor(db, { userId: uid, getKey: () => key, code: "123456", now: T0 })).toEqual({
      status: "not_enrolled",
    });
  });

  it("accepts a fresh authenticator code once; the replay is refused", async () => {
    const uid = await user();
    const { secret } = await enrolled(uid);
    const code = await codeFor(secret, at(2));
    expect(await verifySecondFactor(db, { userId: uid, getKey: () => key, code, now: at(2) })).toEqual({
      status: "verified",
      method: "totp",
    });
    expect(await verifySecondFactor(db, { userId: uid, getKey: () => key, code, now: at(2) })).toEqual({
      status: "invalid",
    });
  });

  it("two concurrent submissions of the same code: exactly one succeeds", async () => {
    const uid = await user();
    const { secret } = await enrolled(uid);
    const code = await codeFor(secret, at(3));
    const results = await Promise.all([
      verifySecondFactor(db, { userId: uid, getKey: () => key, code, now: at(3) }),
      verifySecondFactor(db, { userId: uid, getKey: () => key, code, now: at(3) }),
    ]);
    expect(results.filter((r) => r.status === "verified")).toHaveLength(1);
  });

  it("a recovery code works exactly once, in any typing, and is counted down", async () => {
    const uid = await user();
    const { recoveryCodes } = await enrolled(uid);
    const typed = recoveryCodes[0].toLowerCase().replace(/-/g, " ");
    expect(await verifySecondFactor(db, { userId: uid, getKey: () => key, code: typed, now: T0 })).toEqual({
      status: "verified",
      method: "recovery_code",
    });
    expect(await remainingRecoveryCodes(db, uid)).toBe(9);
    expect(await verifySecondFactor(db, { userId: uid, getKey: () => key, code: recoveryCodes[0], now: T0 })).toEqual({
      status: "invalid",
    });
  });

  it("a recovery code belongs to its own account only", async () => {
    const a = await user("a@example.com");
    const b = await user("b@example.com");
    const { recoveryCodes } = await enrolled(a);
    await enrolled(b);
    expect(await verifySecondFactor(db, { userId: b, getKey: () => key, code: recoveryCodes[0], now: T0 })).toEqual({
      status: "invalid",
    });
  });

  it("wrong or malformed input fails and is counted", async () => {
    const uid = await user();
    const { secret } = await enrolled(uid);
    const good = await codeFor(secret, at(4));
    const wrong = String((Number(good) + 1) % 1_000_000).padStart(6, "0");
    expect(await verifySecondFactor(db, { userId: uid, getKey: () => key, code: wrong, now: at(4) })).toEqual({
      status: "invalid",
    });
    expect(await verifySecondFactor(db, { userId: uid, getKey: () => key, code: "not a code", now: at(4) })).toEqual({
      status: "invalid",
    });
    expect((await getTotpFactor(db, uid))!.failedAttempts).toBe(2);
    // Success resets the count.
    await verifySecondFactor(db, { userId: uid, getKey: () => key, code: good, now: at(4) });
    expect((await getTotpFactor(db, uid))!.failedAttempts).toBe(0);
  });

  it("at the failure ceiling authenticator codes are refused, but a recovery code still gets in and unlocks", async () => {
    const uid = await user();
    const { secret, recoveryCodes } = await enrolled(uid);
    await db
      .update(userMfaTotp)
      .set({ failedAttempts: MFA_MAX_CONSECUTIVE_FAILURES })
      .where(eq(userMfaTotp.userId, uid))
      .run();

    const valid = await codeFor(secret, at(5));
    expect(await verifySecondFactor(db, { userId: uid, getKey: () => key, code: valid, now: at(5) })).toEqual({
      status: "totp_locked",
    });

    expect(await verifySecondFactor(db, { userId: uid, getKey: () => key, code: recoveryCodes[1], now: at(5) })).toEqual({
      status: "verified",
      method: "recovery_code",
    });
    expect(await verifySecondFactor(db, { userId: uid, getKey: () => key, code: valid, now: at(5) })).toEqual({
      status: "verified",
      method: "totp",
    });
  });

  it("ANTI-LOCKOUT: a missing encryption key breaks authenticator codes loudly but never recovery codes", async () => {
    const uid = await user();
    const { secret, recoveryCodes } = await enrolled(uid);
    const noKey = () => {
      throw new Error("MFA_ENCRYPTION_KEY is not set.");
    };
    await expect(
      verifySecondFactor(db, { userId: uid, getKey: noKey, code: await codeFor(secret, at(9)), now: at(9) }),
    ).rejects.toThrow(/MFA_ENCRYPTION_KEY/);
    expect(
      await verifySecondFactor(db, { userId: uid, getKey: noKey, code: recoveryCodes[3], now: at(9) }),
    ).toEqual({ status: "verified", method: "recovery_code" });
  });

  it("claimTotpStep only moves forward, and only for an active factor", async () => {
    const uid = await user();
    expect(await claimTotpStep(db, uid, 10)).toBe(false);
    await enrolled(uid);
    const used = (await getTotpFactor(db, uid))!.lastUsedStep!;
    expect(await claimTotpStep(db, uid, used)).toBe(false);
    expect(await claimTotpStep(db, uid, used - 1)).toBe(false);
    expect(await claimTotpStep(db, uid, used + 1)).toBe(true);
  });
});

describe("resolveSignInFactor — the decision authorize() makes after the password", () => {
  it("an ordinary account with no factor signs in as before, without touching the key", async () => {
    const uid = await user("plain@example.com");
    const getKey = vi.fn(() => key);
    expect(await resolveSignInFactor(db, { userId: uid, getKey, now: T0 })).toEqual({
      status: "not_required",
    });
    expect(getKey).not.toHaveBeenCalled();
  });

  it("ANTI-LOCKOUT: an owner who has not enrolled is marked enroll_required, not refused", async () => {
    const uid = await user();
    await grantAccess(db, { userId: uid, type: "owner" });
    const getKey = vi.fn(() => key);
    expect(await resolveSignInFactor(db, { userId: uid, getKey, now: T0 })).toEqual({
      status: "enroll_required",
    });
    expect(getKey).not.toHaveBeenCalled();
  });

  it("an active factor with no code asks for one", async () => {
    const uid = await user();
    await enrolled(uid);
    for (const code of [undefined, null, "", "   "]) {
      expect(await resolveSignInFactor(db, { userId: uid, code, getKey: () => key, now: at(6) })).toEqual({
        status: "code_required",
      });
    }
  });

  it("an active factor with a good code verifies; a bad one is invalid", async () => {
    const uid = await user();
    await grantAccess(db, { userId: uid, type: "owner" });
    const { secret, recoveryCodes } = await enrolled(uid);
    expect(
      await resolveSignInFactor(db, {
        userId: uid,
        code: await codeFor(secret, at(7)),
        getKey: () => key,
        now: at(7),
      }),
    ).toEqual({ status: "verified", method: "totp" });
    expect(
      await resolveSignInFactor(db, { userId: uid, code: "000000x", getKey: () => key, now: at(7) }),
    ).toEqual({ status: "invalid" });
    expect(
      await resolveSignInFactor(db, { userId: uid, code: recoveryCodes[2], getKey: () => key, now: at(7) }),
    ).toEqual({ status: "verified", method: "recovery_code" });
  });

  it("a factor removed mid-sign-in is a failure, never a pass", async () => {
    const uid = await user();
    await enrolled(uid);
    const confirmedRow = (await getTotpFactor(db, uid))!;
    await db.delete(userMfaRecoveryCodes).where(eq(userMfaRecoveryCodes.userId, uid)).run();
    await db.delete(userMfaTotp).where(eq(userMfaTotp.userId, uid)).run();
    expect(
      await resolveSignInFactor(staleOnce(confirmedRow), {
        userId: uid,
        code: "123456",
        getKey: () => key,
        now: at(8),
      }),
    ).toEqual({ status: "invalid" });
  });
});
