// POST /api/auth/mfa/enroll — start two-step set-up for the signed-in account.
// Returns the secret, the otpauth URI and a QR code; the factor stays INACTIVE
// until /api/auth/mfa/confirm proves a code. Catalog only, keyed on
// session.user.id; no tenant database is opened.

import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { AUTH_RATE_LIMITS } from "@/lib/auth-rate-limit";
import { getAppName } from "@/lib/branding";
import { catalogDb } from "@/lib/catalog";
import { loadSecretBoxKey } from "@/lib/crypto/secret-box";
import { beginTotpEnrollment } from "@/lib/mfa/enrollment";
import { guardMfaRequest, NO_STORE } from "@/lib/mfa/route-guard";

export const runtime = "nodejs";

const enrollSchema = z.object({}).strict();

export async function POST(request: Request): Promise<Response> {
  const guard = await guardMfaRequest({
    request,
    session: await auth(),
    limit: AUTH_RATE_LIMITS.mfaEnroll,
    schema: enrollSchema,
  });
  if (!guard.ok) return guard.response;

  let key: Buffer;
  try {
    key = loadSecretBoxKey();
  } catch {
    return NextResponse.json(
      { error: "Two-step verification is not set up on this server yet." },
      { status: 503, headers: NO_STORE },
    );
  }

  const result = await beginTotpEnrollment(catalogDb, {
    userId: guard.userId,
    key,
    issuer: await getAppName(),
    accountLabel: guard.email ?? guard.userId,
  });
  if (result.status === "already_active") {
    return NextResponse.json(
      { error: "Two-step verification is already on for this account." },
      { status: 409, headers: NO_STORE },
    );
  }

  return NextResponse.json(
    {
      secret: result.secret,
      otpauthUri: result.otpauthUri,
      qrCodeDataUrl: await QRCode.toDataURL(result.otpauthUri),
    },
    { headers: NO_STORE },
  );
}
