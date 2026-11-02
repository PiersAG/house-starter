// The person's answers to the consent questions (app-business-core issue 745).
// Kept in one cookie, `consent`: the names of the third-party services they
// agreed to, separated by "|". No answer means no: a personal-data script
// loads only once its name is here (components/ThirdPartyScripts.tsx).

export const CONSENT_COOKIE = "consent";

/** The service names the cookie agrees to. Unknown or empty -> none. */
export function parseConsent(value: string | undefined | null): Set<string> {
  if (!value) return new Set();
  return new Set(
    decodeURIComponent(value)
      .split("|")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s.length <= 100),
  );
}

/** The cookie value for a set of agreed names. */
export function consentValue(names: Iterable<string>): string {
  return encodeURIComponent([...new Set(names)].join("|"));
}
