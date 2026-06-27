// Full NextAuth config (Node.js runtime — not edge-safe).
// Import { auth, signIn, signOut, handlers } from here in server components and actions.
// Never import from next-auth/react — use server actions for all auth operations.
//
// EXTENSION POINT: replace the stub authorize() with a real DB lookup using your schema.

import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";
import { authConfig } from "@/auth.config";
import { db } from "@/lib/db";
import { getUserByEmail } from "@/lib/users";
import { verifyPassword } from "@/lib/password";

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
});
