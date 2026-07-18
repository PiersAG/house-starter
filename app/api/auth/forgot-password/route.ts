// POST /api/auth/forgot-password — request a password-reset email.
//
// Always responds with the SAME generic message whether or not the email is
// registered, so the endpoint cannot be used to enumerate accounts. The actual
// work (issue token + send email) happens in requestPasswordReset, which is
// silent for unknown emails. Rate-limited like the other auth endpoints.
//
// Verified via E2E, not unit tests (excluded from unit coverage like every
// app/api/** route); requestPasswordReset is unit-tested directly.

import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requestPasswordReset } from "@/lib/password-reset";
import { clientKeyFromHeaders, getRateLimiter } from "@/lib/rate-limit";

export const runtime = "nodejs";

const forgotPasswordSchema = z.object({
  email: z.string().email("Enter a valid email address."),
});

const FORGOT_RATE_LIMIT = { limit: 5, windowSeconds: 60 };

// The one response users see whether or not the address is registered.
const GENERIC_RESPONSE = {
  message: "If an account exists for that email, a password-reset link is on its way.",
};

export async function POST(request: Request): Promise<Response> {
  const rate = await getRateLimiter().hit(
    `forgot-password:${clientKeyFromHeaders(request.headers)}`,
    FORGOT_RATE_LIMIT,
  );
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please try again shortly." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } },
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const parsed = forgotPasswordSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request." },
      { status: 400 },
    );
  }

  const origin = new URL(request.url).origin;
  await requestPasswordReset(db, parsed.data.email, { baseUrl: origin });

  return NextResponse.json(GENERIC_RESPONSE);
}
