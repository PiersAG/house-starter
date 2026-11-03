// Checks that a delivery report really came from the email provider
// (app-business-core issue 757). Resend signs its webhooks with the Standard
// Webhooks scheme (standardwebhooks.com, the one Svix uses), as do several other
// providers, so this check is not tied to one provider:
//
//   headers   webhook-id / webhook-timestamp / webhook-signature
//             (or the same three with the `svix-` prefix, which Resend sends);
//   signed    `${id}.${timestamp}.${raw body}`, HMAC-SHA256;
//   key       the secret after its `whsec_` prefix, base64-decoded;
//   signature a space-separated list of `v1,<base64>`; any one matching passes.
//
// A timestamp more than five minutes from now is refused, so a captured report
// cannot be replayed later. Pure: no clock or secret is read here.

import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

export interface SignedHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

/** The three headers, under either name. */
export function signedHeaders(headers: Headers): SignedHeaders {
  const pick = (name: string) => headers.get(`webhook-${name}`) ?? headers.get(`svix-${name}`);
  return { id: pick("id"), timestamp: pick("timestamp"), signature: pick("signature") };
}

function keyOf(secret: string): Buffer | null {
  const raw = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const key = Buffer.from(raw, "base64");
  return key.length > 0 ? key : null;
}

/** The signature the provider would send for this body, as `v1,<base64>`. */
export function signPayload(secret: string, id: string, timestamp: string, body: string): string {
  const key = keyOf(secret);
  if (!key) throw new Error("webhook secret is empty");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

export type SignatureVerdict =
  | { ok: true }
  | { ok: false; reason: "missing-headers" | "stale" | "mismatch" | "bad-secret" };

/** Check a report's signature. `nowSeconds` is the current Unix time. */
export function verifySignature(
  secret: string,
  headers: SignedHeaders,
  body: string,
  nowSeconds: number,
): SignatureVerdict {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return { ok: false, reason: "missing-headers" };
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(nowSeconds - ts) > SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: "stale" };
  }
  if (!keyOf(secret)) return { ok: false, reason: "bad-secret" };
  const expected = Buffer.from(signPayload(secret, id, timestamp, body).slice(3), "base64");
  for (const part of signature.split(" ")) {
    const [version, value] = part.split(",", 2);
    if (version !== "v1" || !value) continue;
    const given = Buffer.from(value, "base64");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true };
  }
  return { ok: false, reason: "mismatch" };
}
