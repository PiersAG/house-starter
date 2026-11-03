// What a person is told when a sign-up fails (app-business-core issue 358).
//
// CEO ruling 2026-11-03 (Dispatch AG-fix5): a normal sign-up takes seconds, and
// no customer is ever told to wait an hour. Every failed sign-up — on the form
// and on POST /api/auth/signup, whatever was left behind — gets this one fixed
// message, never the error's own details, and a retry with the same email works
// at once: registerUser (lib/users.ts) removes an unfinished sign-up holding the
// address and signs up afresh. The hour in PENDING_SIGNUP_EXPIRY_MS is only the
// background clean-up's timing, never something a person is told.
//
// No imports: the route, the form and lib/users.ts all read it, and the tests
// that mock lib/users.ts still get the real text.

export const SIGNUP_FAILED_MESSAGE = "Something went wrong creating your account. Please try again.";

/** The JSON route's Retry-After on a failed sign-up: a retry may come at once. */
export const SIGNUP_FAILED_RETRY_SECONDS = 1;
