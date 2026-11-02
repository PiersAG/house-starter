// The two calls the sign-in kernel (lib/auth.ts) makes into the session record
// (app-business-core issues 506, 519, 741):
//
//   onSessionStart       at sign-in: record the session, end the oldest beyond the
//                        device cap, and email the owner when the sign-in comes
//                        from a new device in a new country (#519).
//   checkSessionRecord   where the session renews (every server request under the
//                        strict policy, at most every 10 minutes today): refuse an
//                        ended session (a removed device, the device cap, an email
//                        sign-out), the strict policy's fixed life, impossible
//                        travel (#519) and a risk score at RISK_END_AT (#741); and
//                        record where the session was seen.
//
// Both NEVER throw into the kernel. onSessionStart logs and carries on (a record
// that could not be written must not stop a sign-in; the session is then
// recorded at its first check). checkSessionRecord fails CLOSED: a check that
// cannot run ends the session (the user signs straight back in), the same rule
// lib/revoked-sessions.ts applies.

import "server-only";

import type { JWT } from "next-auth/jwt";
import { headers } from "next/headers";
import type { AppDatabase } from "@/lib/users";
import { CONTEXT_AWARE_ACCESS, SESSION_POLICY, SIGN_IN_RISK_CHECKS, type SessionPolicy } from "@/config/sessions";
import { currentRequestContext, type RequestContext } from "@/lib/session/context";
import { endSessionRecord, getSessionRecord, startSessionRecord, touchSessionRecord } from "@/lib/session/records";
import { isImpossibleTravel, scoreSession } from "@/lib/session/risk";
import { pastAbsoluteLife } from "@/lib/session/lifetime";
import { revokeToken, sendNewSignInEmail } from "@/lib/session/notify";
import { clientReputation } from "@/lib/abuse/route-limit";
import { logSecurityEvent } from "@/lib/security-log";
import { canonicalBaseUrl } from "@/lib/app-url";
import { getAppName } from "@/lib/branding";

/** How often an unchanged session's "last seen" is written. */
export const TOUCH_EVERY_MS = 60_000;

export type SessionHookDeps = {
  context?: () => Promise<RequestContext>;
  reputation?: () => Promise<"good" | "suspect" | "bad">;
  sendEmail?: typeof sendNewSignInEmail;
  baseUrl?: () => string;
  appName?: () => Promise<string>;
  riskChecks?: boolean;
  contextAccess?: boolean;
  /** The session setting (config/sessions.ts); tests pin both states. */
  policy?: SessionPolicy;
};

async function requestReputation(): Promise<"good" | "suspect" | "bad"> {
  try {
    return await clientReputation(await headers());
  } catch {
    return "suspect";
  }
}

/** At sign-in. Never throws. */
export async function onSessionStart(db: AppDatabase, token: JWT, deps: SessionHookDeps = {}): Promise<void> {
  const sessionId = token.sessionId as string | undefined;
  const userId = (token.id ?? token.sub) as string | undefined;
  if (!sessionId || !userId) return;
  try {
    const context = await (deps.context ?? currentRequestContext)();
    const started = await startSessionRecord(db, { sessionId, userId, context });
    logSecurityEvent("session_started", {
      userId,
      familiarity: started.familiarity,
      country: context.country,
      endedForDeviceLimit: started.evicted.length,
    });
    if ((deps.riskChecks ?? SIGN_IN_RISK_CHECKS) && started.familiarity === "unfamiliar") {
      logSecurityEvent("sign_in_unfamiliar", { userId, country: context.country, device: context.deviceLabel });
      const email = token.email;
      if (email) {
        const base = (deps.baseUrl ?? (() => canonicalBaseUrl()))();
        await (deps.sendEmail ?? sendNewSignInEmail)(email, {
          appName: await (deps.appName ?? getAppName)(),
          device: context.deviceLabel ?? "an unknown browser",
          // an unfamiliar sign-in always has a country (lib/session/risk.ts assessSignIn)
          country: String(context.country),
          whenUtc: new Date().toISOString().slice(0, 16).replace("T", " "),
          revokeUrl: `${base}/sessions/revoke?t=${encodeURIComponent(revokeToken(sessionId, userId))}`,
          securityUrl: `${base}/account/security`,
        });
      }
    }
  } catch (error) {
    console.error("session start: the session record could not be written (it is written at its first check)", error);
  }
}

/** Where the session renews. "end" = refuse the session. Fails closed. */
export async function checkSessionRecord(
  db: AppDatabase,
  token: JWT,
  nowSeconds: number,
  deps: SessionHookDeps = {},
): Promise<"ok" | "end"> {
  const sessionId = token.sessionId as string | undefined;
  const userId = (token.id ?? token.sub) as string | undefined;
  if (!sessionId || !userId) return "end";
  try {
    const now = new Date(nowSeconds * 1000);
    const context = await (deps.context ?? currentRequestContext)();
    const record = await getSessionRecord(db, sessionId);
    if (!record) {
      // a session from before records existed, or one whose start could not be written
      await startSessionRecord(db, { sessionId, userId, context, now });
      return "ok";
    }
    if (record.userId !== userId || record.endedAt) return "end";

    if (pastAbsoluteLife(token.authTime as number | undefined, token.rememberMe === true, nowSeconds, deps.policy ?? SESSION_POLICY)) {
      await endSessionRecord(db, { userId, sessionId, reason: "expired", now });
      logSecurityEvent("session_ended", { userId, reason: "expired" });
      return "end";
    }

    const riskChecks = deps.riskChecks ?? SIGN_IN_RISK_CHECKS;
    if (riskChecks) {
      const travelled = isImpossibleTravel(
        { latitude: record.latitude, longitude: record.longitude, atMs: record.lastSeenAt.getTime() },
        { latitude: context.latitude, longitude: context.longitude, atMs: now.getTime() },
      );
      if (travelled) {
        await endSessionRecord(db, { userId, sessionId, reason: "impossible_travel", now });
        logSecurityEvent("session_impossible_travel", {
          userId,
          from: record.country,
          to: context.country,
          minutes: Math.round((now.getTime() - record.lastSeenAt.getTime()) / 60000),
        });
        return "end";
      }
    }

    let riskScore = 0;
    if (deps.contextAccess ?? CONTEXT_AWARE_ACCESS) {
      const verdict = scoreSession({
        impossibleTravel: false,
        countryChanged: Boolean(context.country && record.country && context.country !== record.country),
        otherDevice: Boolean(context.deviceId && record.deviceId && context.deviceId !== record.deviceId),
        reputation: await (deps.reputation ?? requestReputation)(),
      });
      riskScore = verdict.score;
      if (verdict.score !== record.riskScore) {
        logSecurityEvent("session_risk_scored", { userId, score: verdict.score, reasons: verdict.reasons.join(",") });
      }
      if (verdict.action === "end") {
        await endSessionRecord(db, { userId, sessionId, reason: "risk", now });
        logSecurityEvent("session_ended", { userId, reason: "risk", score: verdict.score });
        return "end";
      }
    }

    // One write a minute at most while nothing changes: under the strict policy
    // this check runs on every server request, and writes are what the database's
    // free tier counts most tightly.
    const moved = Boolean(context.country && context.country !== record.country);
    if (moved || riskScore !== record.riskScore || now.getTime() - record.lastSeenAt.getTime() >= TOUCH_EVERY_MS) {
      await touchSessionRecord(db, sessionId, { context, riskScore, now });
    }
    return "ok";
  } catch (error) {
    console.error("session check: the session record could not be checked — ending the session", error);
    return "end";
  }
}
