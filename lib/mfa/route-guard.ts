// The shared front half of every /api/auth/mfa/* route (SEC.15, Slice 1).
//
// Three routes, one gate, in one order — so no route can skip a step:
//   1. a signed-in session (the account is ALWAYS session.user.id, never a
//      value from the request body, and never the tenant);
//   2. the request token and the origin check (lib/csrf.ts, app-business-core
//      issue 353): these routes change the account's second factor, so
//      another website must not be able to call them — checked before the rate
//      limit, so a forged request cannot spend the account's attempts either;
//   3. the rate limit, per client AND per account, before any work;
//   4. a JSON body, parsed defensively and validated with zod, first issue
//      reported in plain English (the app/api/auth/signup/route.ts pattern).
//
// Returns either the validated input or the Response to send. Catalog-only: it
// reads the session and the limiter, and opens no database at all.

import { NextResponse } from "next/server";
import type { z } from "zod";
import {
  checkAccountRateLimit,
  checkAuthRateLimit,
  type AuthRateLimit,
} from "@/lib/auth-rate-limit";
import { verifyCsrf } from "@/lib/csrf";

/** Session shape this guard needs — the subset of NextAuth's that it reads. */
export type MfaSession = {
  user?: { id?: string; email?: string | null; sessionId?: string | null };
} | null;

export type GuardResult<T> =
  | { ok: true; userId: string; email: string | null; data: T }
  | { ok: false; response: Response };

/** Responses carrying secrets or codes must never be cached anywhere. */
export const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function guardMfaRequest<T>(input: {
  request: Request;
  session: MfaSession;
  limit: AuthRateLimit;
  schema: z.ZodType<T, unknown>;
}): Promise<GuardResult<T>> {
  const user = input.session?.user;
  if (!user?.id) return fail(401, "You need to be signed in to do that.");
  const userId = user.id;

  const forged = verifyCsrf(input.request, input.session);
  if (forged) return { ok: false, response: forged };

  for (const rate of [
    await checkAuthRateLimit(input.limit, input.request.headers),
    await checkAccountRateLimit(input.limit, userId),
  ]) {
    if (!rate.allowed) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "Too many attempts. Please try again shortly." },
          {
            status: 429,
            headers: { ...NO_STORE, "Retry-After": String(rate.retryAfterSeconds) },
          },
        ),
      };
    }
  }

  let payload: unknown;
  try {
    payload = await input.request.json();
  } catch {
    return fail(400, "Request body must be valid JSON.");
  }

  const parsed = input.schema.safeParse(payload);
  if (!parsed.success) return fail(400, parsed.error.issues[0].message);

  return { ok: true, userId, email: user.email ?? null, data: parsed.data };
}

function fail(status: number, error: string): { ok: false; response: Response } {
  return {
    ok: false,
    response: NextResponse.json({ error }, { status, headers: NO_STORE }),
  };
}
