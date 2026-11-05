// A too-large request gets a plain "too large" answer (Dispatch AR; found by
// Dispatch AQ's awkward-input suite, app-business-core issue 721: a 200 MB form
// submission was answered 500 by Next.js's own 1 MB limit on form submissions).
//
// The edge middleware calls requestTooLarge() before anything reads the body: a
// request whose declared Content-Length is over the limit is answered 413 at once,
// so no route, form handler or sign-in code ever starts reading it. The limit is
// Next.js's own default for form submissions (1 MB), so nothing the app accepts
// today is refused. An app route that takes uploads names its own, larger limit in
// REQUEST_SIZE_LIMITS (and tests/awkward/server.spec.ts UPLOAD_FIELDS gets its
// 200 MB test).
//
// A body sent with no Content-Length (chunked) cannot be measured here without
// reading it; it falls through to Next.js's own limits, as before. A deployed app
// on Vercel also has Vercel's own request limit in front (4.5 MB for a function),
// which Vercel answers 413 itself.

/** Next.js's default limit on a form submission (server action): 1 MB. */
export const MAX_REQUEST_BYTES = 1024 * 1024;

/** Larger limits for named path prefixes (an upload route). None in the template. */
export const REQUEST_SIZE_LIMITS: Readonly<Record<string, number>> = {};

export const TOO_LARGE_MESSAGE = "Request too large.";

const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** The byte limit for a request to `pathname`. */
export function requestLimitFor(
  pathname: string,
  limits: Readonly<Record<string, number>> = REQUEST_SIZE_LIMITS,
): number {
  for (const [prefix, bytes] of Object.entries(limits)) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return bytes;
  }
  return MAX_REQUEST_BYTES;
}

/**
 * The declared size and limit when this request is over its limit, else null.
 * Only the Content-Length header is read; the body is never touched.
 */
export function requestTooLarge(
  method: string,
  pathname: string,
  headers: Headers,
  limits: Readonly<Record<string, number>> = REQUEST_SIZE_LIMITS,
): { declared: number; limit: number } | null {
  if (!BODY_METHODS.has(method.toUpperCase())) return null;
  const raw = headers.get("content-length")?.trim() ?? "";
  if (!/^\d+$/.test(raw)) return null; // none (chunked) or malformed: not ours to judge
  const declared = Number(raw);
  const limit = requestLimitFor(pathname, limits);
  return declared > limit ? { declared, limit } : null;
}
