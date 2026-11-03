// Context-aware access — the policy engine (app-business-core issue 741; Matt
// Murphy #89: "build a policy engine that evaluates these attributes on every
// single request a user accessing financial records at 3:00 AM from an
// unrecognised device gets stepped up authentication or denied entirely").
//
// Pure. The attributes, each named by the requirement or its review row R0500:
//   sensitivity   the data the request touches (config/data-sensitivity.ts):
//                 financial records, account security, a copy of personal data;
//   device        is the session on the device it signed in on, and has the
//                 account seen that device before;
//   time          the local hour at the connection (UNUSUAL_HOURS);
//   location      folded into the session risk score (new country, impossible
//                 travel — lib/session/risk.ts);
//   IP reputation the connection's standing with the escalation (throttled =
//                 suspect, banned = bad);
//   session risk  the continuous score.
//
// Decisions: "allow"; "step_up" = sign in again (with the second factor, when the
// account has one) — passed when the sign-in is fresh (STEP_UP_FRESH_SECONDS);
// "deny" = refused outright.

import {
  CONTEXT_AWARE_ACCESS,
  RISK_END_AT,
  RISK_STEP_UP_AT,
  STEP_UP_FRESH_SECONDS,
} from "@/config/sessions";

export type Sensitivity = "normal" | "high";

export type AccessAttributes = {
  sensitivity: Sensitivity;
  /** The account has signed in from this device before (or this session started on it). */
  deviceKnown: boolean;
  /** The connection's local hour is in the unusual window. */
  unusualHour: boolean;
  reputation: "good" | "suspect" | "bad";
  sessionRisk: number;
  /** Seconds since this session's sign-in; null when unknown (never fresh). */
  signInAgeSeconds: number | null;
};

export type AccessDecision = { decision: "allow" | "step_up" | "deny"; reasons: string[] };

/** The policy. With CONTEXT_AWARE_ACCESS off every request is allowed (both states tested). */
export function evaluateAccess(a: AccessAttributes, enabled: boolean = CONTEXT_AWARE_ACCESS): AccessDecision {
  if (!enabled) return { decision: "allow", reasons: ["policy_off"] };
  if (a.reputation === "bad") return { decision: "deny", reasons: ["banned_connection"] };
  if (a.sessionRisk >= RISK_END_AT) return { decision: "deny", reasons: ["session_risk"] };
  if (a.sensitivity !== "high") return { decision: "allow", reasons: [] };

  const reasons: string[] = [];
  if (!a.deviceKnown && a.unusualHour) reasons.push("unrecognised_device_unusual_hour");
  if (a.reputation === "suspect") reasons.push("suspect_connection");
  if (a.sessionRisk >= RISK_STEP_UP_AT) reasons.push("session_risk");
  if (reasons.length === 0) return { decision: "allow", reasons: [] };

  const fresh = a.signInAgeSeconds !== null && a.signInAgeSeconds <= STEP_UP_FRESH_SECONDS;
  // An unrecognised device at an unusual hour on a high-risk session is refused
  // outright; anything less is asked to sign in again.
  if (reasons.length >= 3) return { decision: "deny", reasons };
  return fresh ? { decision: "allow", reasons: [...reasons, "fresh_sign_in"] } : { decision: "step_up", reasons };
}
