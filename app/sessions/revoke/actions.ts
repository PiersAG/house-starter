"use server";

// The "This wasn't me" link in the new sign-in email (app-business-core issue
// 519). Signs out the one session the signed link names, after the person
// confirms on the page. No sign-in is needed: the link itself is the proof, and
// it can only end that session (lib/session/notify.ts).

import { catalogDb } from "@/lib/catalog";
import { guardRouteAction, ROUTE_LIMIT_MESSAGE } from "@/lib/abuse/route-limit";
import { endSessionRecord, getSessionRecord } from "@/lib/session/records";
import { revokeTokenSessionId, verifyRevokeToken } from "@/lib/session/notify";
import { logSecurityEvent } from "@/lib/security-log";
import { z } from "zod";
import { parseForm } from "@/lib/validation/input";

export type RevokeState = { done?: boolean; error?: string } | null;

const revokeForm = z.object({ t: z.string().min(10).max(256) });

export async function revokeFromEmailAction(_prev: RevokeState, formData: FormData): Promise<RevokeState> {
  // a public, token-carrying form like a password reset: the same route budget
  if (await guardRouteAction("auth.password-reset")) return { error: ROUTE_LIMIT_MESSAGE };
  const form = parseForm(revokeForm, formData);
  const invalid = { error: "This link is not valid or has expired. Sign in and use your sign-in and security page instead." };
  if (!form.ok) return invalid;
  const sessionId = revokeTokenSessionId(form.data.t);
  const record = sessionId ? await getSessionRecord(catalogDb, sessionId) : undefined;
  if (!record || !verifyRevokeToken(form.data.t, record.userId)) return invalid;
  await endSessionRecord(catalogDb, { userId: record.userId, sessionId: record.id, reason: "ended_from_email" });
  logSecurityEvent("session_ended", { userId: record.userId, reason: "ended_from_email" });
  return { done: true };
}
