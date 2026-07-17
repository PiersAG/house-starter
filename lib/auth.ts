// Full NextAuth config (Node.js runtime — not edge-safe).
// Import { auth, signIn, signOut, handlers } from here in server components and actions.
// Never import from next-auth/react — use server actions for all auth operations.
//
// EXTENSION POINT: replace the stub authorize() with a real DB lookup using your schema.
//
// The `callbacks` block below FULLY REPLACES authConfig.callbacks in the
// NextAuth spread (a `callbacks` key overwrites, it does not merge). It must
// therefore reproduce authConfig's remember-me session-length logic AND add
// the renewal-time revocation check — see lib/revoked-sessions.ts. The
// revocation DB read runs at most once per RENEW_AFTER_SECONDS window (never
// per page load) and only in this Node.js instance; the edge middleware keeps
// using authConfig's minimal, DB-free jwt callback.

import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";
import { authConfig } from "@/auth.config";
import { db } from "@/lib/db";
import { getUserByEmail } from "@/lib/users";
import { verifyPassword } from "@/lib/password";
import {
  handleTokenRenewal,
  isSessionRevoked,
  RENEW_AFTER_SECONDS,
} from "@/lib/revoked-sessions";

const DAY_SECONDS = 24 * 60 * 60;
const THIRTY_DAY_SECONDS = 30 * DAY_SECONDS;

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  // Auth.js serialises every credential to a string before it reaches
  // authorize(), so an omitted/unchecked "remember me" arrives as the string
  // "undefined" or "null" rather than a real boolean. Accept any string and
  // treat only the literal "on" as opt-in — never reject the login over it.
  rememberMe: z.string().optional(),
});

export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      async authorize(credentials) {
        const parsed = loginSchema.safeParse(credentials);
        if (!parsed.success) return null;

        const user = await getUserByEmail(db, parsed.data.email);
        if (!user) return null;

        const valid = await verifyPassword(
          parsed.data.password,
          user.passwordHash,
        );
        if (!valid) return null;

        return {
          id: user.id,
          email: user.email,
          name: user.name ?? undefined,
          rememberMe: parsed.data.rememberMe === "on",
        };
      },
    }),
  ],
  callbacks: {
    // Route protection is enforced explicitly in middleware.ts; returning true
    // here keeps NextAuth from additionally short-circuiting the request.
    authorized() {
      return true;
    },

    async jwt({ token, user }) {
      // Sign-in pass (user present): this callbacks object replaces
      // authConfig.callbacks, so we must set BOTH the remember-me session
      // length AND the revocation identifiers here.
      if (user?.id) {
        token.id = user.id;
        const rememberMe = (user as { rememberMe?: boolean }).rememberMe ?? false;
        token.rememberMe = rememberMe;
        token.maxAge = rememberMe ? THIRTY_DAY_SECONDS : DAY_SECONDS;
        token.sessionId = crypto.randomUUID();
        token.renewAfter = Math.floor(Date.now() / 1000) + RENEW_AFTER_SECONDS;
        return token;
      }

      // Subsequent requests: renewal + optional revocation check. One DB hit
      // per RENEW_AFTER_SECONDS window, not per page load.
      const now = Math.floor(Date.now() / 1000);
      return handleTokenRenewal(
        token,
        (jti) => isSessionRevoked(db, jti),
        now,
      );
    },

    session({ session, token }) {
      const id = (token.id ?? token.sub) as string | undefined;
      if (id) session.user.id = id;
      // Expose sessionId so a signOut action can write the revocation record.
      if (token.sessionId) {
        session.user.sessionId = token.sessionId as string;
      }
      return session;
    },
  },
});
