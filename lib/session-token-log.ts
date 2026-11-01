// Sign-in library error logger (PiersAG/app-business-core#798, Matt Murphy #44:
// "test modified, expired, wrongly-issued and unsigned tokens against every
// protected route and confirm they are rejected AND logged").
//
// Auth.js already REJECTS such a token: decoding fails, the session is empty and
// the broken cookie is cleared. What it did not do was leave a usable record —
// its default logger prints a coloured free-text line. This logger, set as
// `logger.error` in auth.config.ts (so the Edge middleware and the Node server
// share it), turns a rejected session token into one `session_token_rejected`
// security event (lib/security-log.ts) with the reason the decoder gave, and
// passes every other sign-in library error through as a plain line.
//
// Never logs the token: only the error's class name is read from the cause.
// Edge-safe: no Node.js-only imports.

import { logSecurityEvent } from "@/lib/security-log";

interface AuthLibraryError extends Error {
  type?: string;
  cause?: unknown;
}

/** The decoder's own error name (e.g. JWTExpired, JWEDecryptionFailed), if any. */
export function rejectionReason(error: AuthLibraryError): string {
  const cause = error.cause;
  if (cause && typeof cause === "object" && "err" in cause) {
    const err = (cause as { err?: unknown }).err;
    if (err instanceof Error) {
      const code = (err as { code?: unknown }).code;
      return typeof code === "string" && code ? code : err.name;
    }
  }
  return "unknown";
}

/** `logger.error` for Auth.js. Never throws. */
export function logAuthLibraryError(error: Error): void {
  const e = error as AuthLibraryError;
  const type = e.type ?? e.name;
  if (type === "JWTSessionError") {
    logSecurityEvent("session_token_rejected", { reason: rejectionReason(e) });
    return;
  }
  try {
    console.error(`[auth][error] ${type}: ${e.message}`);
  } catch {
    // Logging must not turn a sign-in error into a second error.
  }
}
