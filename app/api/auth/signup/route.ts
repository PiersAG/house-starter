// POST /api/auth/signup — create a new account.
//
// Sits alongside the NextAuth catch-all (app/api/auth/[...nextauth]) — an
// explicit route segment takes precedence over the catch-all in the App Router.
// Verified via the Playwright E2E suite (excluded from unit coverage).

import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { registerUser, RegistrationError } from "@/lib/users";
import { clientKeyFromHeaders, getRateLimiter } from "@/lib/rate-limit";

export const runtime = "nodejs";

const signupSchema = z.object({
  email: z.string().email("Enter a valid email address."),
  password: z.string().min(8, "Password must be at least 8 characters long."),
  name: z.string().trim().min(1).max(120).optional(),
});

// Auth endpoints are rate-limited (quality baseline items 4 and 11). The store
// is the shared-store adapter by default; see lib/rate-limit.ts.
// Default signup rate limit. The VALUE is the lever each app tunes — the EXISTENCE of
// rate-limiting is required by the quality baseline. 5/60s defeats trivial automation
// while remaining permissive for legitimate retries; apps with genuine high-volume signup
// (e.g. enterprise bulk-onboarding) raise this value in their build.
const SIGNUP_RATE_LIMIT = { limit: 5, windowSeconds: 60 };

export async function POST(request: Request): Promise<Response> {
  const rate = await getRateLimiter().hit(
    `signup:${clientKeyFromHeaders(request.headers)}`,
    SIGNUP_RATE_LIMIT,
  );
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many signup attempts. Please try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": String(rate.retryAfterSeconds) },
      },
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

  const parsed = signupSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid signup details." },
      { status: 400 },
    );
  }

  try {
    const user = await registerUser(db, parsed.data);
    return NextResponse.json(
      { id: user.id, email: user.email, name: user.name },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof RegistrationError) {
      const status = error.code === "email_taken" ? 409 : 422;
      return NextResponse.json({ error: error.message }, { status });
    }
    throw error;
  }
}
