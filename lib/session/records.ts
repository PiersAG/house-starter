// Session records (app-business-core issues 506, 519, 741).
//
// One row per signed-in session (user_sessions, keyed by the JWT session id),
// written when the session starts (lib/session/hooks.ts, from the sign-in
// kernel) and read where it renews. It carries:
//
//   * the cap on devices per account (#506, Matt Murphy #133 "cap concurrent
//     sessions per user"): starting a session past MAX_SESSIONS_PER_USER ends the
//     least recently used one — its id is written to revoked_sessions, so the
//     renewal check refuses it (at once under the strict policy, else within one
//     renewal window);
//   * the device list on the security page and its per-device sign-out;
//   * what the sign-in risk checks compare with (#519): the devices and
//     countries the account has signed in from before;
//   * the last place and time the session was seen, for impossible travel, and
//     its risk score (#741).
//
// DI pattern of lib/users.ts: the database is an explicit argument.

import "server-only";

import { and, desc, eq, isNull } from "drizzle-orm";
import { userSessions, type UserSession } from "@/lib/schema";
import type { AppDatabase } from "@/lib/users";
import { revokeSession } from "@/lib/revoked-sessions";
import { MAX_SESSIONS_PER_USER } from "@/config/sessions";
import { assessSignIn, type SignInFamiliarity } from "@/lib/session/risk";
import type { RequestContext } from "@/lib/session/context";

export type EndReason =
  | "signed_out"
  | "device_limit"
  | "ended_by_user"
  | "ended_from_email"
  | "impossible_travel"
  | "risk"
  | "expired";

export type StartedSession = { familiarity: SignInFamiliarity; evicted: string[] };

/** Every session of the account still running, most recently used first. */
export async function activeSessions(db: AppDatabase, userId: string): Promise<UserSession[]> {
  return db
    .select()
    .from(userSessions)
    .where(and(eq(userSessions.userId, userId), isNull(userSessions.endedAt)))
    .orderBy(desc(userSessions.lastSeenAt), desc(userSessions.startedAt))
    .all();
}

export async function getSessionRecord(db: AppDatabase, sessionId: string): Promise<UserSession | undefined> {
  const rows = await db.select().from(userSessions).where(eq(userSessions.id, sessionId)).limit(1).all();
  return rows[0];
}

/**
 * Record a session that has just started, judge how familiar it looks, and end
 * the least recently used sessions beyond the cap. Idempotent on the session id.
 */
export async function startSessionRecord(
  db: AppDatabase,
  input: { sessionId: string; userId: string; context: RequestContext; now?: Date; maxSessions?: number },
): Promise<StartedSession> {
  const now = input.now ?? new Date();
  const earlier = await db.select().from(userSessions).where(eq(userSessions.userId, input.userId)).all();
  const others = earlier.filter((r) => r.id !== input.sessionId);
  const familiarity = assessSignIn({
    hasHistory: others.length > 0,
    knownDevice: input.context.deviceId !== null && others.some((r) => r.deviceId === input.context.deviceId),
    knownCountry: input.context.country !== null && others.some((r) => r.country === input.context.country),
    country: input.context.country,
  });

  await db
    .insert(userSessions)
    .values({
      id: input.sessionId,
      userId: input.userId,
      deviceId: input.context.deviceId,
      deviceLabel: input.context.deviceLabel,
      country: input.context.country,
      latitude: input.context.latitude,
      longitude: input.context.longitude,
      startedAt: now,
      lastSeenAt: now,
    })
    .onConflictDoNothing()
    .run();

  const cap = input.maxSessions ?? MAX_SESSIONS_PER_USER;
  const running = await activeSessions(db, input.userId);
  const evicted: string[] = [];
  // the new session counts as the most recent; the oldest beyond the cap go
  for (const r of running.filter((x) => x.id !== input.sessionId).slice(Math.max(cap - 1, 0))) {
    await endSessionRecord(db, { userId: input.userId, sessionId: r.id, reason: "device_limit", now });
    evicted.push(r.id);
  }
  return { familiarity, evicted };
}

/**
 * End one session of `userId`: the record is marked ended and the session id is
 * revoked, so the renewal check refuses it. Returns false when the session is
 * not this account's (or does not exist) — a user can end only their own.
 */
export async function endSessionRecord(
  db: AppDatabase,
  input: { userId: string; sessionId: string; reason: EndReason; now?: Date },
): Promise<boolean> {
  const record = await getSessionRecord(db, input.sessionId);
  if (!record || record.userId !== input.userId) return false;
  if (!record.endedAt) {
    await db
      .update(userSessions)
      .set({ endedAt: input.now ?? new Date(), endReason: input.reason })
      .where(eq(userSessions.id, input.sessionId))
      .run();
  }
  try {
    await revokeSession(db, input.sessionId, input.userId);
  } catch {
    // already revoked (the jti is unique) — the session is refused either way
  }
  return true;
}

/** Mark every running session of the account ended (sign out everywhere, password change). */
export async function endAllSessionRecords(
  db: AppDatabase,
  userId: string,
  reason: EndReason,
  now: Date = new Date(),
): Promise<number> {
  const running = await activeSessions(db, userId);
  if (running.length === 0) return 0;
  await db
    .update(userSessions)
    .set({ endedAt: now, endReason: reason })
    .where(and(eq(userSessions.userId, userId), isNull(userSessions.endedAt)))
    .run();
  return running.length;
}

/** Record where and when the session was last seen, and its current risk score. */
export async function touchSessionRecord(
  db: AppDatabase,
  sessionId: string,
  seen: { context: RequestContext; riskScore: number; now: Date },
): Promise<void> {
  await db
    .update(userSessions)
    .set({
      lastSeenAt: seen.now,
      riskScore: seen.riskScore,
      ...(seen.context.country ? { country: seen.context.country } : {}),
      ...(seen.context.latitude !== null && seen.context.longitude !== null
        ? { latitude: seen.context.latitude, longitude: seen.context.longitude }
        : {}),
    })
    .where(eq(userSessions.id, sessionId))
    .run();
}

/** True when the account has signed in from this device before. */
export async function isKnownDevice(db: AppDatabase, userId: string, deviceId: string | null): Promise<boolean> {
  if (!deviceId) return false;
  const rows = await db
    .select({ id: userSessions.id })
    .from(userSessions)
    .where(and(eq(userSessions.userId, userId), eq(userSessions.deviceId, deviceId)))
    .limit(1)
    .all();
  return rows.length > 0;
}
