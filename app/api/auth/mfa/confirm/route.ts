// POST /api/auth/mfa/confirm — prove the authenticator works, turn two-step
// verification ON, and return the ten recovery codes (shown once, never stored
// in plain text). Catalog only, keyed on session.user.id.

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { AUTH_RATE_LIMITS } from "@/lib/auth-rate-limit";
import { catalogDb } from "@/lib/catalog";
import { loadSecretBoxKey } from "@/lib/crypto/secret-box";
import { confirmTotpEnrollment } from "@/lib/mfa/enrollment";
import { guardMfaRequest, NO_STORE } from "@/lib/mfa/route-guard";

export const runtime = "nodejs";

const CODE_MESSAGE = "Enter the 6-digit code from your authenticator app.";

const confirmSchema = z.object({
  code: z
    .string({ required_error: CODE_MESSAGE, invalid_type_error: CODE_MESSAGE })
    .transform((value) => value.replace(/\s+/g, ""))
    .pipe(z.string().regex(/^\d{6}$/, CODE_MESSAGE)),
});

export async function POST(request: Request): Promise<Response> {
  const guard = await guardMfaRequest({
    request,
    session: await auth(),
    limit: AUTH_RATE_LIMITS.mfaVerify,
    schema: confirmSchema,
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

  const result = await confirmTotpEnrollment(catalogDb, {
    userId: guard.userId,
    key,
    code: guard.data.code,
  });
  switch (result.status) {
    case "not_started":
      return NextResponse.json(
        { error: "Start set-up first." },
        { status: 409, headers: NO_STORE },
      );
    case "already_active":
      return NextResponse.json(
        { error: "Two-step verification is already on for this account." },
        { status: 409, headers: NO_STORE },
      );
    case "invalid_code":
      return NextResponse.json(
        { error: "That code didn't match. Enter the current code from your app." },
        { status: 400, headers: NO_STORE },
      );
    case "confirmed":
      return NextResponse.json(
        { recoveryCodes: result.recoveryCodes },
        { headers: NO_STORE },
      );
  }
}
