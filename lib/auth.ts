// Full NextAuth config (Node.js runtime — not edge-safe).
// Import { auth, signIn, signOut, handlers } from here in server components and actions.
// Never import from next-auth/react — use server actions for all auth operations.
//
// EXTENSION POINT: replace the stub authorize() with a real DB lookup using your schema.

import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";
import { authConfig } from "@/auth.config";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  rememberMe: z.enum(["on"]).optional(),
});

export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      async authorize(credentials) {
        const parsed = loginSchema.safeParse(credentials);
        if (!parsed.success) return null;

        // EXTENSION POINT: replace with real DB lookup and bcrypt comparison.
        // Example:
        //   const user = await db.query.users.findFirst({
        //     where: eq(users.email, parsed.data.email),
        //   });
        //   if (!user) return null;
        //   const valid = await bcrypt.compare(parsed.data.password, user.passwordHash);
        //   if (!valid) return null;
        //   return { id: user.id, email: user.email, name: user.name ?? undefined,
        //            rememberMe: parsed.data.rememberMe === "on" };
        return null; // replace this stub
      },
    }),
  ],
});
