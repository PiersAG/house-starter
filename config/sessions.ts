// Sign-in sessions: the one setting that waits on a CEO decision, and the sign-in
// risk switches (app-business-core issues 440, 506, 519, 525, 741, 559).
//
// SESSION_POLICY is the ONE place the CEO's ruling on #559 ("shorter sign-in
// sessions with a refreshing cookie", which changes the 2026-07-15 session ruling)
// is applied. Applying it is this one edit plus its tests' expectations:
//
//   "renewal" — the 2026-07-15 ruling, as today. A session lasts 1 day (30 with
//               "remember me"); its record is checked at most every 10 minutes,
//               so "sign out everywhere", a removed device and a reset end other
//               devices within 10 minutes.
//   "strict"  — the #559 proposal. The record is checked on EVERY server request,
//               so those end other devices at once (#440, #506 "revocation that
//               takes effect immediately"), and a session lasts 8 hours (7 days
//               with "remember me") from sign-in, however active.
//
// The rotating short-lived cookie with reuse detection (#506, Matt Murphy #214)
// is NOT behind this switch yet: it needs the edge middleware to rotate the
// cookie against the shared store on every request, which is the rest of the
// #559 decision (see the recommendation on #559).
//
// The risk switches are sub-switches of the sign-in KERNEL (capability-model-spec:
// kernel switches are hidden and permanently on in every automated build). Both
// states are tested (tests/unit/session-risk.test.ts, session-policy.test.ts).

export type SessionPolicy = "renewal" | "strict";

/** #559 — the CEO's ruling of 2026-11-02: "strict" (app-business-core wiki/decisions.md). */
export const SESSION_POLICY: SessionPolicy = "strict";

export const SESSION_POLICIES: Record<
  SessionPolicy,
  { renewAfterSeconds: number; maxAgeSeconds: number; rememberMaxAgeSeconds: number }
> = {
  renewal: { renewAfterSeconds: 10 * 60, maxAgeSeconds: 24 * 60 * 60, rememberMaxAgeSeconds: 30 * 24 * 60 * 60 },
  strict: { renewAfterSeconds: 0, maxAgeSeconds: 8 * 60 * 60, rememberMaxAgeSeconds: 7 * 24 * 60 * 60 },
};

/** #506 (Matt Murphy #133): at most this many signed-in devices per account; the oldest is signed out. */
export const MAX_SESSIONS_PER_USER = 5;

/** #519: new-device + new-country alert at sign-in, and impossible-travel session end. */
export const SIGN_IN_RISK_CHECKS = true;

/** #741: the access policy on every checked request, and continuous session risk scoring. */
export const CONTEXT_AWARE_ACCESS = true;

/** #519: faster than this between two places is not a journey a person made. */
export const IMPOSSIBLE_TRAVEL_KMH = 900;
/** #519: two readings closer than this are the same place (geolocation by address is coarse). */
export const TRAVEL_MIN_KM = 300;

/** #741: the risk score at which a session must sign in again before a sensitive action. */
export const RISK_STEP_UP_AT = 50;
/** #741: the risk score at which a session is ended. */
export const RISK_END_AT = 100;

/** #741: a sensitive action needs a sign-in no older than this when step-up applies. */
export const STEP_UP_FRESH_SECONDS = 15 * 60;

/** #741: the local hours (0–23) counted as unusual for a sign-in or a sensitive request. */
export const UNUSUAL_HOURS = { from: 0, to: 5 } as const;

/** #525: warn this many seconds before a session ends. */
export const EXPIRY_WARNING_SECONDS = 60;
