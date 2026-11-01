// Security event log — one structured line per sign-in-relevant event
// (PiersAG/app-business-core#515 reset logging, #798 rejected session tokens).
//
// WHY A LINE, NOT A TABLE. These events are written from places that must not
// fail and some that run on the Edge (auth.config.ts's logger is used by the
// middleware), where no database driver is available. A single JSON line on
// the platform log is readable on every runtime and costs nothing. A durable,
// queryable audit trail of customer actions is bundle S12's work (#796), which
// can read these same event names.
//
// NEVER LOGS A SECRET. Callers pass ids and reasons only — never a token, a
// password, a reset link or an email address. `fields` values are limited to
// strings, numbers, booleans and null so an object cannot smuggle one in.
//
// NEVER THROWS. A logging failure must not turn a sign-in into an error.

export type SecurityEvent =
  | "password_reset_requested"
  | "password_reset_request_limited"
  | "password_reset_completed"
  | "password_changed"
  | "signed_out_everywhere"
  | "session_rotated"
  | "session_token_rejected";

export type SecurityFieldValue = string | number | boolean | null;

/** The line written for an event — exported so tests read the exact shape. */
export function securityLogLine(
  event: SecurityEvent,
  fields: Record<string, SecurityFieldValue> = {},
  now: Date = new Date(),
): string {
  const safe: Record<string, SecurityFieldValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      safe[key] = value;
    }
  }
  return JSON.stringify({ security_event: event, at: now.toISOString(), ...safe });
}

/** Write one security event to the platform log. Never throws. */
export function logSecurityEvent(
  event: SecurityEvent,
  fields: Record<string, SecurityFieldValue> = {},
  now: Date = new Date(),
): void {
  try {
    console.warn(securityLogLine(event, fields, now));
  } catch {
    // A console that throws is not worth failing a request over.
  }
}
