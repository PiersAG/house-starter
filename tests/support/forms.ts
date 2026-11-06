// Every form the app serves, ONE list, read by the awkward-input suite
// (tests/awkward/forms.spec.ts) and held complete by
// tests/unit/browser-suite-coverage.test.ts (app-business-core issue 721; Matt Murphy
// #296: "put an apostrophe in every single field"). A file under app/ that renders a
// <form> must be named by an entry's `source`, so a form an app adds is tested the next
// time the suite runs, or the coverage test fails until it is listed.

export type FormEntry = {
  /** The file that renders the form. */
  source: string;
  /** Where the form is. */
  path: string;
  /** The form needs a signed-in account. */
  signedIn: boolean;
  /** The submit button's accessible name (it identifies the form on the page). */
  submit: RegExp;
  /** A button to press first when the form only appears after it. */
  open?: RegExp;
  /** The form has fields a person types into (otherwise it is a button-only form). */
  typed: boolean;
};

const RESET_TOKEN = "browser-suite-sample-token-0000";

export const FORMS: Record<string, FormEntry> = {
  signup: {
    source: "app/signup/SignupForm.tsx",
    path: "/signup",
    signedIn: false,
    submit: /create account/i,
    typed: true,
  },
  login: {
    source: "app/login/LoginForm.tsx",
    path: "/login",
    signedIn: false,
    submit: /^sign in$/i,
    typed: true,
  },
  "reset-password": {
    source: "app/reset-password/ResetPasswordForm.tsx",
    path: `/reset-password?token=${RESET_TOKEN}`,
    signedIn: false,
    submit: /set new password/i,
    typed: true,
  },
  "change-password": {
    source: "app/account/security/ChangePasswordForm.tsx",
    path: "/account/security",
    signedIn: true,
    submit: /change password/i,
    typed: true,
  },
  "two-step-code": {
    source: "app/account/security/TwoStepSetup.tsx",
    path: "/account/security",
    signedIn: true,
    open: /set up two-step sign-in/i,
    submit: /turn on two-step sign-in/i,
    typed: true,
  },
  "delete-account": {
    source: "app/account/privacy/PrivacyActions.tsx",
    path: "/account/privacy",
    signedIn: true,
    submit: /delete my account and data/i,
    typed: true,
  },
  "sign-out": {
    source: "app/dashboard/page.tsx",
    path: "/dashboard",
    signedIn: true,
    submit: /^sign out$/i,
    typed: false,
  },
  "sign-out-everywhere": {
    source: "app/account/security/page.tsx",
    path: "/account/security",
    signedIn: true,
    submit: /sign out of all devices/i,
    typed: false,
  },
  "revoke-device-link": {
    source: "app/sessions/revoke/RevokeForm.tsx",
    path: `/sessions/revoke?t=${RESET_TOKEN}`,
    signedIn: false,
    submit: /sign that device out/i,
    typed: false,
  },
};

/**
 * Components that render a form but are mounted by no page in the template. The
 * coverage test fails if one of them is imported under app/, so an app that mounts it
 * adds it to FORMS above.
 */
export const UNMOUNTED_FORM_COMPONENTS: Record<string, string> = {
  "components/support/SupportWidget.tsx":
    "the support widget is shipped for apps to mount; no template page mounts it",
};
