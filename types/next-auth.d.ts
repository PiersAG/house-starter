import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      /** JWT session identifier — exposed so a signOut action can write a revocation record. */
      sessionId?: string;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    rememberMe?: boolean;
    maxAge?: number;
    /** Unique JWT session identifier (used as the revocation key). */
    sessionId?: string;
    /** Unix timestamp after which the next request must check revocation. */
    renewAfter?: number;
  }
}
