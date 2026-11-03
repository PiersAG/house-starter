// The access policy at a sensitive action (app-business-core issue 741): reads
// the attributes for the signed-in session and the request, and asks
// lib/session/policy.ts whether to allow it, ask for a fresh sign-in, or refuse.
//
// The caller passes the session it already read, so no second session read is
// made (tests that answer one session read keep working).

import "server-only";

import { headers } from "next/headers";
import type { AppDatabase } from "@/lib/users";
import { ACTION_SENSITIVITY, type GuardedAction } from "@/config/data-sensitivity";
import { currentRequestContext, type RequestContext } from "@/lib/session/context";
import { getSessionRecord, isKnownDevice } from "@/lib/session/records";
import { evaluateAccess, type AccessDecision } from "@/lib/session/policy";
import { isUnusualHour, localHour } from "@/lib/session/risk";
import { clientReputation } from "@/lib/abuse/route-limit";
import { logSecurityEvent } from "@/lib/security-log";
import { loginPathFor } from "@/lib/session/return-path";

export const STEP_UP_MESSAGE = "For your security, please sign in again to continue.";
export const DENIED_MESSAGE = "This can't be done from this connection right now. Please try again later.";

export type SensitiveAccess = AccessDecision & { loginPath: string };

export type GuardDeps = {
  context?: () => Promise<RequestContext>;
  reputation?: () => Promise<"good" | "suspect" | "bad">;
  now?: () => number;
  enabled?: boolean;
};

/** The policy's decision for `action` by this session, on this request. Never throws. */
export async function checkSensitiveAccess(
  db: AppDatabase,
  session: { user?: { id?: string; sessionId?: string } } | null,
  action: GuardedAction,
  returnTo: string,
  deps: GuardDeps = {},
): Promise<SensitiveAccess> {
  const loginPath = loginPathFor(returnTo);
  const userId = session?.user?.id;
  if (!userId) return { decision: "step_up", reasons: ["no_session"], loginPath };
  try {
    const nowMs = (deps.now ?? Date.now)();
    const context = await (deps.context ?? currentRequestContext)();
    const sessionId = session?.user?.sessionId;
    const record = sessionId ? await getSessionRecord(db, sessionId) : undefined;
    const reputation = await (deps.reputation ?? (async () => clientReputation(await headers())))();
    const deviceKnown =
      (record?.deviceId != null && record.deviceId === context.deviceId) ||
      (await isKnownDevice(db, userId, context.deviceId));
    const decision = evaluateAccess(
      {
        sensitivity: ACTION_SENSITIVITY[action],
        deviceKnown,
        unusualHour: isUnusualHour(localHour(context.timezone, nowMs)),
        reputation,
        sessionRisk: record?.riskScore ?? 0,
        signInAgeSeconds: record ? Math.floor((nowMs - record.startedAt.getTime()) / 1000) : null,
      },
      deps.enabled,
    );
    if (decision.decision !== "allow") {
      logSecurityEvent(decision.decision === "deny" ? "access_denied" : "access_stepped_up", {
        userId,
        action,
        reasons: decision.reasons.join(","),
      });
    }
    return { ...decision, loginPath };
  } catch (error) {
    console.error("access policy: could not evaluate — asking for a fresh sign-in", error);
    return { decision: "step_up", reasons: ["policy_error"], loginPath };
  }
}

/** The message for a refused or stepped-up decision, or null when allowed. */
export function accessMessage(d: SensitiveAccess): string | null {
  if (d.decision === "allow") return null;
  return d.decision === "deny" ? DENIED_MESSAGE : STEP_UP_MESSAGE;
}
