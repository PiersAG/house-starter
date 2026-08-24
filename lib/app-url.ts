// The app's canonical base URL — never the request's Host header.
//
// THE DEFECT THIS CLOSES
// ----------------------
// app/api/auth/forgot-password/route.ts built its reset link from
// `new URL(request.url).origin`, i.e. from the Host header the CALLER supplied.
// A request carrying `Host: attacker.example` therefore mints a genuine,
// valid reset token inside a link pointing at the attacker — the victim clicks
// a link that looks like it came from us and hands over the token. The token is
// real; only the domain is the attacker's. That is host-header injection, and
// the only durable fix is to stop deriving identity-bearing URLs from anything
// the client can set.
//
// PRECEDENCE — every source here is server-side, none is client-supplied:
//
//   1. APP_CANONICAL_URL             explicit, and therefore always right
//   2. AUTH_URL                      NextAuth's own canonical, if the app sets it
//   3. VERCEL_PROJECT_PRODUCTION_URL the project's stable production hostname
//   4. VERCEL_URL                    this deployment's hostname (previews)
//   5. the request origin            ONLY when VERCEL_ENV is unset — i.e. local
//                                    dev, where the Host is the developer's own
//
// A deployed environment always has VERCEL_URL, so step 5 is unreachable there;
// if it somehow were, this throws rather than falling back to the caller's Host.
// No new required variable is introduced: nothing has to be configured for a
// Vercel deploy to be correct, which is what keeps this out of .env.contract's
// boot-required set (a boot-required addition would stop dev, CI and the
// isolation harness from starting — the same trap the rate-limit store fix has).

export type AppUrlEnv = {
  APP_CANONICAL_URL?: string;
  AUTH_URL?: string;
  VERCEL_PROJECT_PRODUCTION_URL?: string;
  VERCEL_URL?: string;
  VERCEL_ENV?: string;
};

/** Add a scheme to a bare hostname and drop any trailing slash. */
function normalise(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * The base URL to build links the app sends OUT (emails, webhooks, redirects).
 *
 * `requestOrigin` is used only in local development; pass it or not, a deployed
 * environment never reaches it.
 */
export function canonicalBaseUrl(
  env: AppUrlEnv = process.env as AppUrlEnv,
  requestOrigin?: string,
): string {
  for (const configured of [env.APP_CANONICAL_URL, env.AUTH_URL]) {
    if (configured?.trim()) return normalise(configured);
  }
  for (const host of [env.VERCEL_PROJECT_PRODUCTION_URL, env.VERCEL_URL]) {
    if (host?.trim()) return normalise(host);
  }
  if (!env.VERCEL_ENV && requestOrigin?.trim()) {
    return requestOrigin.replace(/\/+$/, "");
  }
  throw new Error(
    "No canonical app URL is configured. Set APP_CANONICAL_URL (or AUTH_URL) " +
      "so links the app sends out cannot be pointed at another domain by a " +
      "forged Host header.",
  );
}
