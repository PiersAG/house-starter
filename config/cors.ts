// Cross-origin allowlist — the ONLY place another website may be allowed to
// call this app with the signed-in user's cookies
// (PiersAG/app-business-core#742, Matt Murphy #14, #68, #220).
//
// The app's own origin is always allowed (lib/cors.ts reads it from the
// server-side canonical URL, never from the request). Add an entry here only
// for another domain the app itself runs — for example a marketing site on a
// separate domain that calls the app's API. Each entry is one exact origin:
// scheme, host and port, no path, no wildcard. Every origin not on the list
// gets nothing: no CORS header, and a refused preflight.
//
// tests/unit/cors-guard.test.ts fails a wildcard, an http: origin (other than
// localhost), a path, or any file other than lib/cors.ts that sets a CORS
// header itself.

export const CORS_ALLOWED_ORIGINS: readonly string[] = [];
