// POST /api/auth/mfa/verify — check an authenticator or recovery code for the
// ALREADY signed-in account (step-up; slice 4 builds on it). The login-time check
// is NOT here: it runs inside lib/auth.ts::authorize, the shared path the public
// credentials endpoint cannot bypass. Catalog only, keyed on session.user.id.

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { AUTH_RATE_LIMITS } from "@/lib/auth-rate-limit";
import { catalogDb } from "@/lib/catalog";
import { loadSecretBoxKey } from "@/lib/crypto/secret-box";
import { verifySecondFactor, type VerifyFactorResult } from "@/lib/mfa/enrollment";
import { guardMfaRequest, NO_STORE } from "@/lib/mfa/route-guard";

export const runtime = "nodejs";

const LENGTH_MESSAGE = "Enter the 6-digit code from your app, or a recovery code.";

const verifySchema = z.object({
  code: z
    .string({ required_error: "Enter a code.", invalid_type_error: "Enter a code." })
    .trim()
    .min(6, LENGTH_MESSAGE)
    .max(32, LENGTH_MESSAGE),
});

export async function POST(request: Request): Promise<Response> {
  const guard = await guardMfaRequest({
    request,
    session: await auth(),
    limit: AUTH_RATE_LIMITS.mfaVerify,
    schema: verifySchema,
  });
  if (!guard.ok) return guard.response;

  let result: VerifyFactorResult;
  try {
    result = await verifySecondFactor(catalogDb, {
      userId: guard.userId,
      getKey: () => loadSecretBoxKey(),
      code: guard.data.code,
    });
  } catch {
    // Only an authenticator code needs the key; recovery codes never reach here.
    return NextResponse.json(
      { error: "Two-step verification is not set up on this server yet." },
      { status: 503, headers: NO_STORE },
    );
  }

  switch (result.status) {
    case "not_enrolled":
      return NextResponse.json(
        { error: "Two-step verification is not on for this account." },
        { status: 409, headers: NO_STORE },
      );
    case "invalid":
      return NextResponse.json(
        { error: "That code didn't work." },
        { status: 400, headers: NO_STORE },
      );
    case "totp_locked":
      return NextResponse.json(
        { error: "Too many wrong codes. Use one of your recovery codes." },
        { status: 403, headers: NO_STORE },
      );
    case "verified":
      return NextResponse.json(
        { verified: true, method: result.method },
        { headers: NO_STORE },
      );
  }
}
