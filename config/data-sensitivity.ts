// How sensitive the data behind each guarded action is — the "data sensitivity"
// attribute of the access policy (app-business-core issue 741, review row R0500;
// lib/session/policy.ts). A request to a HIGH action from an unrecognised device
// at an unusual hour, from a suspect connection, or on a risky session must sign
// in again first; a banned connection or an ended-risk session is refused.
//
// A builder adding an action that shows financial records, changes how an
// account signs in, or hands out a copy of personal data adds it here as "high".

import type { Sensitivity } from "@/lib/session/policy";

export const ACTION_SENSITIVITY = {
  // Financial records: the billing portal and checkout (Matt Murphy #89's example).
  "billing.portal": "high",
  "billing.checkout": "high",
  // How the account signs in.
  "account.change-password": "high",
  "account.sign-out-everywhere": "normal",
  "account.end-device": "normal",
  "account.two-step": "high",
  // A copy of everything held about the person, and closing the account.
  "privacy.data-report": "high",
  "privacy.delete-account": "high",
} as const satisfies Record<string, Sensitivity>;

export type GuardedAction = keyof typeof ACTION_SENSITIVITY;
