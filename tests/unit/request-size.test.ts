// A too-large request gets a plain 413 (Dispatch AR; Dispatch AQ found a 200 MB form
// submission answered 500 by Next.js's own 1 MB limit). The rule reads only the
// declared Content-Length, before anything reads the body.

import { describe, expect, it } from "vitest";
import {
  MAX_REQUEST_BYTES,
  REQUEST_SIZE_LIMITS,
  requestLimitFor,
  requestTooLarge,
} from "@/lib/request-size";

const h = (length?: string, extra: Record<string, string> = {}) => {
  const headers = new Headers(extra);
  if (length !== undefined) headers.set("content-length", length);
  return headers;
};

describe("requestTooLarge", () => {
  it("is Next.js's own 1 MB form limit, and the template names no larger route", () => {
    expect(MAX_REQUEST_BYTES).toBe(1024 * 1024);
    expect(REQUEST_SIZE_LIMITS).toEqual({});
  });

  it("refuses a body declared over the limit, on every method that carries one", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "post"]) {
      expect(requestTooLarge(method, "/signup", h(String(200 * 1024 * 1024)))).toEqual({
        declared: 200 * 1024 * 1024,
        limit: MAX_REQUEST_BYTES,
      });
    }
    expect(requestTooLarge("POST", "/api/auth/signup", h(String(MAX_REQUEST_BYTES + 1)))).not.toBeNull();
  });

  it("lets through a body at or under the limit", () => {
    expect(requestTooLarge("POST", "/signup", h(String(MAX_REQUEST_BYTES)))).toBeNull();
    expect(requestTooLarge("POST", "/signup", h("512"))).toBeNull();
    expect(requestTooLarge("POST", "/signup", h(" 12 "))).toBeNull();
  });

  it("never judges a request without a body, or one it cannot measure", () => {
    expect(requestTooLarge("GET", "/", h(String(10 * MAX_REQUEST_BYTES)))).toBeNull();
    expect(requestTooLarge("HEAD", "/", h(String(10 * MAX_REQUEST_BYTES)))).toBeNull();
    expect(requestTooLarge("POST", "/signup", h(undefined, { "transfer-encoding": "chunked" }))).toBeNull();
    expect(requestTooLarge("POST", "/signup", h("-5"))).toBeNull();
    expect(requestTooLarge("POST", "/signup", h("1e9"))).toBeNull();
  });

  it("gives a named upload prefix its own limit, and only that prefix", () => {
    const limits = { "/api/uploads": 50 * 1024 * 1024 };
    expect(requestLimitFor("/api/uploads", limits)).toBe(50 * 1024 * 1024);
    expect(requestLimitFor("/api/uploads/photo", limits)).toBe(50 * 1024 * 1024);
    expect(requestLimitFor("/api/uploadsx", limits)).toBe(MAX_REQUEST_BYTES);
    expect(requestLimitFor("/signup")).toBe(MAX_REQUEST_BYTES);
    expect(requestTooLarge("POST", "/api/uploads/photo", h(String(10 * 1024 * 1024)), limits)).toBeNull();
    expect(requestTooLarge("POST", "/api/uploads/photo", h(String(60 * 1024 * 1024)), limits)).not.toBeNull();
  });
});
