import type { NextAuthConfig } from "next-auth";
import { encode, decode } from "@auth/core/jwt";

const DAY_SECONDS = 24 * 60 * 60;
const THIRTY_DAY_SECONDS = 30 * DAY_SECONDS;

// Edge-safe config: no Node.js-only imports.
// Imported by both middleware.ts (Edge Runtime) and lib/auth.ts (Node.js).
// @auth/core/jwt uses only Web Crypto (jose + @panva/hkdf) — safe for Edge.
export const authConfig: NextAuthConfig = {
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [],
  jwt: {
    // Custom encode so token.maxAge (written at sign-in) controls the actual
    // JWT exp. Without this, NextAuth v5 beta's encode() always overwrites exp
    // with the global session.maxAge, making token.exp a no-op.
    encode: async (params) => {
      const maxAge =
        (params.token as { maxAge?: number } | undefined)?.maxAge ??
        THIRTY_DAY_SECONDS;
      return encode({ ...params, maxAge });
    },
    decode,
  },
  callbacks: {
    authorized({ auth, request }) {
      const { pathname } = request.nextUrl;
      // EXTENSION POINT: add protected routes for the app here.
      const isProtected = ["/dashboard"].some((p) => pathname.startsWith(p));
      if (isProtected) return !!auth?.user;
      return true;
    },
    jwt({ token, user }) {
      // Guard: only run at sign-in (when user object is present).
      // Running unconditionally re-encodes the cookie on every request
      // and crashes existing sessions — the FlightLog production incident.
      if (user?.id) {
        token.id = user.id;
        token.rememberMe = (user as { rememberMe?: boolean }).rememberMe ?? false;
        token.maxAge = token.rememberMe ? THIRTY_DAY_SECONDS : DAY_SECONDS;
      }
      return token;
    },
    session({ session, token }) {
      const id = (token.id ?? token.sub) as string | undefined;
      if (id) session.user.id = id;
      return session;
    },
  },
};
