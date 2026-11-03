import type { NextAuthConfig } from "next-auth";
import type { JWT } from "next-auth/jwt";
import { encode, decode } from "@auth/core/jwt";
import { logAuthLibraryError } from "@/lib/session-token-log";
import { sessionMaxAge } from "@/lib/session/lifetime";

/**
 * Read the session-signing secret from the environment. Standing rule: no
 * hardcoded fallback secret, ever. If neither AUTH_SECRET nor NEXTAUTH_SECRET
 * is set, fail loudly at startup naming the missing variable rather than
 * running insecurely with a default.
 */
function requireAuthSecret(): string {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret || secret.length === 0) {
    throw new Error(
      "AUTH_SECRET (or NEXTAUTH_SECRET) is not set. Refusing to start: a " +
        "session secret must be provided via the environment — there is no " +
        "insecure default fallback.",
    );
  }
  return secret;
}

// Edge-safe config: no Node.js-only imports.
// Imported by both middleware.ts (Edge Runtime) and lib/auth.ts (Node.js).
// @auth/core/jwt uses only Web Crypto (jose + @panva/hkdf) — safe for Edge.
export const authConfig: NextAuthConfig = {
  // Trust the deployment host (localhost in dev/E2E, the platform host in prod)
  // so NextAuth resolves the callback URL without a hard-coded NEXTAUTH_URL.
  trustHost: true,
  secret: requireAuthSecret(),
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  // A modified, expired, wrongly signed or unsigned session token is rejected by
  // the decoder; this records each rejection as a security event (#798).
  // lib/auth.ts spreads this config, so the Node server logs the same way.
  logger: { error: logAuthLibraryError },
  providers: [],
  jwt: {
    // Custom encode so token.maxAge (written at sign-in) controls the actual
    // JWT exp. Without this, NextAuth v5 beta's encode() always overwrites exp
    // with the global session.maxAge, making token.exp a no-op.
    encode: async (params) => {
      const maxAge =
        (params.token as { maxAge?: number } | undefined)?.maxAge ??
        sessionMaxAge(true);
      return encode({ ...params, maxAge });
    },
    decode,
  },
  callbacks: {
    // Route protection is enforced explicitly in middleware.ts (which also sets
    // the per-request CSP nonce). Returning true here keeps NextAuth from
    // additionally short-circuiting the request before that runs.
    authorized() {
      return true;
    },
    jwt({ token, user }) {
      // Guard: only run at sign-in (when user object is present).
      // Running unconditionally re-encodes the cookie on every request
      // and crashes existing sessions — the FlightLog production incident.
      if (user?.id) {
        token.id = user.id;
        // Carried here too so the two jwt callbacks stay interchangeable: this
        // one is what the Edge middleware runs, and a token shape that differed
        // between the two would make the tenant claim appear and disappear
        // depending on which runtime last touched the cookie.
        token.tenantId = (user as { tenantId?: string }).tenantId;
        token.role = (user as { role?: string }).role;
        // The second-factor claim (SEC.15). Minted identically by lib/auth.ts's
        // Node callback — the two must agree or the claim flickers by runtime.
        token.mfa = (user as { mfa?: JWT["mfa"] }).mfa ?? "none";
        token.rememberMe = (user as { rememberMe?: boolean }).rememberMe ?? false;
        // The session's life comes from the one session setting (#559).
        token.maxAge = sessionMaxAge(token.rememberMe === true);
      }
      return token;
    },
    session({ session, token }) {
      const id = (token.id ?? token.sub) as string | undefined;
      if (id) session.user.id = id;
      if (token.tenantId) session.user.tenantId = token.tenantId as string;
      if (token.role) session.user.role = token.role as string;
      if (token.mfa) session.user.mfa = token.mfa;
      return session;
    },
  },
};
