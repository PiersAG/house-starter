// How long a session lasts and how often it is re-checked, from the one setting
// (config/sessions.ts SESSION_POLICY, CEO decision #559). Edge-safe: no Node-only
// imports, so the edge sign-in config (auth.config.ts) uses it too.

import { SESSION_POLICIES, SESSION_POLICY, type SessionPolicy } from "@/config/sessions";

/** The session's life in seconds: 1 day / 30 days today; 8 hours / 7 days under "strict". */
export function sessionMaxAge(rememberMe: boolean, policy: SessionPolicy = SESSION_POLICY): number {
  const p = SESSION_POLICIES[policy];
  return rememberMe ? p.rememberMaxAgeSeconds : p.maxAgeSeconds;
}

/** Seconds between record checks: 600 today; 0 (every server request) under "strict". */
export function renewAfterSeconds(policy: SessionPolicy = SESSION_POLICY): number {
  return SESSION_POLICIES[policy].renewAfterSeconds;
}

/** True when the strict policy's fixed life (counted from sign-in, however active) is over. */
export function pastAbsoluteLife(
  authTime: number | undefined,
  rememberMe: boolean,
  nowSeconds: number,
  policy: SessionPolicy = SESSION_POLICY,
): boolean {
  if (policy !== "strict" || authTime === undefined) return false;
  return nowSeconds - authTime > sessionMaxAge(rememberMe, policy);
}
