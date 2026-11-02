// Return to where the user was after signing in again (app-business-core issues
// 525 and 440; Matt Murphy #153 and #168: "on session expiry, return the user to
// the exact page they were on after re-login").
//
// The edge middleware puts the page that asked for a sign-in in `callbackUrl`;
// the sign-in action sends the user back there. Only a path on THIS app is
// accepted — an off-site address, a protocol-relative `//host`, a backslash
// trick or anything that is not a plain path falls back to the dashboard
// (#514: open redirects through sign-in).

export const DEFAULT_RETURN_PATH = "/dashboard";

/** The path to return to, or DEFAULT_RETURN_PATH when `value` is not a safe local path. */
export function safeReturnPath(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_RETURN_PATH;
  const v = value.trim();
  if (v.length === 0 || v.length > 512) return DEFAULT_RETURN_PATH;
  // a plain absolute path: one leading slash, then not a slash or backslash
  if (!/^\/(?![/\\])/.test(v)) return DEFAULT_RETURN_PATH;
  // nothing a browser could read as a scheme, a host or a control character
  if (/[\\\x00-\x1f\x7f]/.test(v) || /^\/[^?#]*:/.test(v)) return DEFAULT_RETURN_PATH;
  let decoded: string;
  try {
    decoded = decodeURIComponent(v);
  } catch {
    return DEFAULT_RETURN_PATH;
  }
  if (/^\/[/\\]/.test(decoded) || /[\\\x00-\x1f\x7f]/.test(decoded)) return DEFAULT_RETURN_PATH;
  // never back to the sign-in pages themselves
  if (/^\/(login|signup|api\/auth)(\/|$|\?)/.test(v)) return DEFAULT_RETURN_PATH;
  return v;
}

/** `/login?callbackUrl=<path>` for a page that needs a sign-in. */
export function loginPathFor(path: string): string {
  return `/login?callbackUrl=${encodeURIComponent(safeReturnPath(path))}`;
}
