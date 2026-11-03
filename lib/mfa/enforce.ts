// Two-step sign-in is REQUIRED for an account holding an owner-type grant
// (app-business-core issue 377, SEC.15: "MANDATORY for accounts holding an
// owner-type grant ... OFFERED to customer/app-owner accounts").
//
// The sign-in kernel never refuses such an account before it has enrolled
// (enrolment needs a session — the anti-lockout rule in lib/auth.ts); it marks the
// session `enroll_required`. This is where the mark is enforced: a marked session
// reaches only the sign-in and security page (to set two-step up) and sign-out.
// Every product page (app/dashboard/layout.tsx) and every owner-only write
// (lib/authz.ts requireTenantOwner) sends it there instead.

import "server-only";

import { redirect } from "next/navigation";

export const TWO_STEP_SETUP_PATH = "/account/security?twoStep=required#two-step";

/** True when this session must set up two-step sign-in before anything else. */
export function mustEnrollTwoStep(session: { user?: { mfa?: string } } | null): boolean {
  return session?.user?.mfa === "enroll_required";
}

/** Send a session that must set up two-step sign-in to the set-up page. */
export function enforceTwoStep(session: { user?: { mfa?: string } } | null): void {
  if (mustEnrollTwoStep(session)) redirect(TWO_STEP_SETUP_PATH);
}
