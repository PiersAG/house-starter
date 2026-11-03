// The "new sign-in" email and its sign-out link (app-business-core issue 519;
// Matt Murphy #89, scaled for small service businesses: "a 'new sign-in' email
// with revoke link").
//
// Sent when a sign-in comes from a device AND a country the account has never
// signed in from (lib/session/risk.ts assessSignIn). The link opens
// /sessions/revoke, which signs that one session out after the person confirms.
// The link is signed (HMAC-SHA256 with a key derived from AUTH_SECRET) over the
// session id, the account id and an expiry, so it cannot be forged or pointed at
// another session, and it lasts REVOKE_LINK_DAYS.
//
// Sending goes through the template's own email path (lib/email/send.ts), as it
// is; the template lives here, beside the session code that uses it.

import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { sendEmail, type EmailTemplate } from "@/lib/email/send";
import { html, safeUrl } from "@/lib/email/templates/html";
import { renderLayout } from "@/lib/email/templates/layout";

export const REVOKE_LINK_DAYS = 7;

function linkKey(secret: string | undefined = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET): Buffer {
  if (!secret) throw new Error("AUTH_SECRET is not set: the sign-out link cannot be signed.");
  return createHash("sha256").update(`session-revoke-link:${secret}`).digest();
}

function signature(sessionId: string, userId: string, expS: number, secret?: string): string {
  return createHmac("sha256", linkKey(secret)).update(`${sessionId}:${userId}:${expS}`).digest("base64url");
}

/** The token in a sign-out link: `<sessionId>.<expiry>.<signature>`. */
export function revokeToken(sessionId: string, userId: string, nowMs: number = Date.now(), secret?: string): string {
  const expS = Math.floor(nowMs / 1000) + REVOKE_LINK_DAYS * 24 * 60 * 60;
  return `${sessionId}.${expS}.${signature(sessionId, userId, expS, secret)}`;
}

/** The session id a token names, before its signature is checked (to look its account up). */
export function revokeTokenSessionId(token: unknown): string | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  return parts.length === 3 && /^[A-Za-z0-9-]{8,64}$/.test(parts[0]) ? parts[0] : null;
}

/** True when `token` is a live, untampered link for this session of this account. */
export function verifyRevokeToken(
  token: unknown,
  userId: string,
  nowMs: number = Date.now(),
  secret?: string,
): boolean {
  if (typeof token !== "string") return false;
  const [sessionId, exp, sig] = token.split(".");
  const expS = Number(exp);
  if (!sessionId || !sig || !Number.isInteger(expS) || expS * 1000 < nowMs) return false;
  const want = Buffer.from(signature(sessionId, userId, expS, secret));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

export interface NewSignInData {
  appName: string;
  device: string;
  country: string;
  whenUtc: string;
  revokeUrl: string;
  securityUrl: string;
}

export const newSignInTemplate: EmailTemplate<NewSignInData> = {
  name: "new-sign-in",
  render({ appName, device, country, whenUtc, revokeUrl, securityUrl }) {
    const link = safeUrl(revokeUrl);
    const security = safeUrl(securityUrl);
    const subject = `New sign-in to ${appName}`;
    const bodyHtml = html`
      <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3">New sign-in to your account</h1>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6">
        Your account was signed in to from a device and a country it has not been
        used from before: ${device}, in ${country}, at ${whenUtc} (UTC).
      </p>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6">If this was you, there is nothing to do.</p>
      <p style="margin:0 0 24px">
        <a href="${link}"
           style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px">
          This wasn't me — sign that device out
        </a>
      </p>
      <p style="margin:0;font-size:13px;line-height:1.6;color:#52525b">
        Then change your password on your <a href="${security}" style="color:#2563eb">sign-in and security page</a>.
        The link above lasts ${String(REVOKE_LINK_DAYS)} days.
      </p>`;
    const text = [
      "New sign-in to your account",
      "",
      `Your account was signed in to from a device and a country it has not been used from before: ${device}, in ${country}, at ${whenUtc} (UTC).`,
      "",
      "If this was you, there is nothing to do. If it was not, sign that device out:",
      revokeUrl,
      "",
      `Then change your password: ${securityUrl}`,
    ].join("\n");
    return { subject, html: renderLayout({ title: subject, bodyHtml, previewText: subject }), text };
  },
};

/** Send the new sign-in email. Never throws: a failed send must not fail the sign-in. */
export async function sendNewSignInEmail(to: string, data: NewSignInData): Promise<boolean> {
  try {
    await sendEmail(to, newSignInTemplate, data);
    return true;
  } catch (error) {
    console.error("sign-in alert: the new sign-in email could not be sent", error);
    return false;
  }
}
