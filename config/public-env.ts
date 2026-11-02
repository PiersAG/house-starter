// Every environment variable the browser is allowed to see (app-business-core
// issues 797 and 353; Matt Murphy #242: "environment variables prefixed with
// NEXT_PUBLIC or VITE shipped to the browser — know which ones").
//
// Next.js copies the VALUE of every `NEXT_PUBLIC_*` variable the code names
// into the JavaScript sent to the browser. So a name belongs here only if its
// value is fine for any visitor to read — an address, a public label — and
// never a key, a token, a password or a database address.
//
// tests/unit/public-env.test.ts fails when the code or the environment
// contract names a NEXT_PUBLIC_ variable that is not listed here, and when a
// listed name looks like a secret. The factory's planted gate scans the BUILT
// browser files for every non-public value (dast job, "Scan the built browser
// output").

export const PUBLIC_ENV: Record<string, string> = {
  NEXT_PUBLIC_SUPPORT_EMAIL: "The support address shown on the contact page — public by design.",
  NEXT_PUBLIC_SUPPORT_ENDPOINT: "The address the support widget posts a question to — public by design.",
  NEXT_PUBLIC_APP_URL: "The app's own public address.",
  NEXT_PUBLIC_APP_SLUG: "The app's short public name.",
};

/** Parts of a name that mark a secret; none may appear in a public variable. */
export const SECRET_NAME_PARTS = /(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_?KEY|_KEY\b|KEY_|DATABASE|DB_|DSN|CONNECTION|WEBHOOK|SIGNING|AUTH)/;
