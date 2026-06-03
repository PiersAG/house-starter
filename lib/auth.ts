// NextAuth v5 stub — configure providers before use.
// NEXTAUTH_SECRET and NEXTAUTH_URL are set in .env.local (see .env.example).
//
// See: https://authjs.dev/getting-started

import NextAuth from "next-auth";

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [],
});
