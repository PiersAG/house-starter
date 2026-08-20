import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      /** The tenant this session may read. Resolved at sign-in from the catalog. */
      tenantId?: string;
      /** JWT session identifier — exposed so a signOut action can write a revocation record. */
      sessionId?: string;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    /** The tenant claim — see lib/tenant-context.ts. */
    tenantId?: string;
    rememberMe?: boolean;
    maxAge?: number;
    /** Unique JWT session identifier (used as the revocation key). */
    sessionId?: string;
    /** Unix timestamp after which the next request must check revocation. */
    renewAfter?: number;
  }
}

declare module "next-auth" {
  interface User {
    /** Set by authorize(); copied onto the JWT at sign-in. */
    tenantId?: string;
    rememberMe?: boolean;
  }
}
