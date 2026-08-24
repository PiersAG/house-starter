// Full NextAuth config (Node.js runtime — not edge-safe).
// Import { auth, signIn, signOut, handlers } from here in server components and actions.
// Never import from next-auth/react — use server actions for all auth operations.
//
// EXTENSION POINT: replace the stub authorize() with a real DB lookup using your schema.
//
// TENANT ROUTING (ADR-023). authorize() runs against the CATALOG — the shared
// control-plane database that holds identity, sessions and billing. That is what
// makes per-tenant login possible at all: the credential is what tells us which
// tenant to open, so the credential cannot live in the tenant's own database.
// On success the account's tenant is resolved (and provisioned if this account
// has never had one), and the tenant id is put on the JWT. Every later request
// reads it from the session, never from the caller — see lib/tenant-context.ts.
// A sign-in that cannot resolve a tenant FAILS: no session is issued, rather
// than one that would later fall back to some default database.
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
import { catalogDb } from "@/lib/catalog";
import { getTenancyMode } from "@/lib/db";
import { ensureTenantForUser } from "@/lib/tenant/provisioner";
import { SHARED_TENANT_ID } from "@/lib/tenant-context";
import { getUserByEmail } from "@/lib/users";
import { verifyPassword } from "@/lib/password";
import {
  AUTH_RATE_LIMITS,
  AuthRateLimitError,
  guardAuthAttempt,
} from "@/lib/auth-rate-limit";
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
        // THROTTLE FIRST, before the credential is even parsed — and HERE
        // rather than in app/login/actions.ts. The NextAuth credentials
        // endpoint (/api/auth/callback/credentials) is publicly reachable, so
        // a guard sitting only in the server action would be bypassed by
        // posting straight at it: a limit on the door nobody has to use.
        // authorize() is the one path both surfaces come through.
        //
        // Throwing (rather than returning null) is deliberate: null means
        // "wrong credentials", and telling a throttled user their password is
        // wrong sends them to the reset flow, which makes it worse. The login
        // action maps this back to a plain "too many attempts" message.
        const rate = await guardAuthAttempt(AUTH_RATE_LIMITS.login);
        if (!rate.allowed) throw new AuthRateLimitError(rate.retryAfterSeconds);

        const parsed = loginSchema.safeParse(credentials);
        if (!parsed.success) return null;

        const user = await getUserByEmail(catalogDb, parsed.data.email);
        if (!user) return null;

        const valid = await verifyPassword(
          parsed.data.password,
          user.passwordHash,
        );
        if (!valid) return null;

        // Resolve the tenant BEFORE the session exists. In per-tenant mode this
        // provisions one on first use (the seeded owner account has none), so an
        // account can always reach its own data. A failure here is a failed
        // sign-in — deliberately, since a session without a tenant could only
        // ever be served the wrong database or none.
        const tenantId =
          getTenancyMode() === "shared"
            ? SHARED_TENANT_ID
            : await ensureTenantForUser(user.id, { label: user.email });

        return {
          id: user.id,
          email: user.email,
          name: user.name ?? undefined,
          rememberMe: parsed.data.rememberMe === "on",
          tenantId,
          // The role claim, read from the catalog user row. Column default is
          // 'owner' and today one account = one tenant, so every caller is one;
          // the claim exists so the owner-only writes are already marked when
          // sub-users arrive. See lib/authz.ts.
          role: user.role,
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
        // The tenant claim — the whole point of the sign-in pass in per-tenant
        // mode. Everything downstream reads it from here.
        token.tenantId = (user as { tenantId?: string }).tenantId;
        // Carried alongside the tenant claim, and for the same reason: the two
        // jwt callbacks (here and in auth.config.ts, which the Edge middleware
        // runs) must mint the same token shape, or a claim would appear and
        // disappear depending on which runtime last touched the cookie.
        token.role = (user as { role?: string }).role;
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
        (jti) => isSessionRevoked(catalogDb, jti),
        now,
      );
    },

    session({ session, token }) {
      const id = (token.id ?? token.sub) as string | undefined;
      if (id) session.user.id = id;
      // The tenant claim, surfaced for lib/tenant-context.ts. Absent on a
      // session minted before this claim existed — requireTenantId() then
      // refuses the request rather than guessing a database.
      if (token.tenantId) {
        session.user.tenantId = token.tenantId as string;
      }
      // Absent on a pre-claim session — lib/authz.ts then refuses rather than
      // assuming ownership.
      if (token.role) {
        session.user.role = token.role as string;
      }
      // Expose sessionId so a signOut action can write the revocation record.
      if (token.sessionId) {
        session.user.sessionId = token.sessionId as string;
      }
      return session;
    },
  },
});
