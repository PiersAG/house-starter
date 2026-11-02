// Request IDs (PiersAG/app-business-core#503, Matt Murphy #207/#319, #189).
//
// One id per request, set by the edge middleware on the request it passes on
// and on the response it returns (header `x-request-id`), so the browser, the
// structured log line and any error row for that request all carry the same
// value and one search shows the whole request.
//
// The id is always made here, never taken from the caller: a client-chosen id
// could be reused to make two requests look like one, or carry text into the
// logs. `safeRequestId` is for code that reads the id the middleware set.
//
// Edge-safe: no Node imports (the middleware runs on the Edge).

export const REQUEST_ID_HEADER = "x-request-id";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

/** A fresh request id (a random UUID). */
export function newRequestId(): string {
  return globalThis.crypto.randomUUID();
}

/** The request id on these headers when it has the shape this module makes; null otherwise. */
export function safeRequestId(headers: Headers | null | undefined): string | null {
  const value = headers?.get(REQUEST_ID_HEADER) ?? null;
  return value && REQUEST_ID_PATTERN.test(value) ? value : null;
}
