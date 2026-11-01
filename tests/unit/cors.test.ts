// CORS decisions in lib/cors.ts (PiersAG/app-business-core#742; Matt Murphy
// #14, #68, #220): a hard-coded allowlist, credentials only for an exact
// match, never a wildcard, never the caller's Origin echoed back.

import { describe, expect, it } from "vitest";
import {
  CORS_ALLOWED_METHODS,
  allowedOrigins,
  applyCors,
  corsHeaders,
  corsPreflight,
  isPreflight,
  matchOrigin,
  originOf,
} from "@/lib/cors";

const APP = "https://app.example.com";
const LISTED = ["https://www.example.com"];
const ALLOWED = [APP, ...LISTED];

describe("allowedOrigins", () => {
  it("is the canonical origin plus the hard-coded list", () => {
    expect(allowedOrigins({ APP_CANONICAL_URL: `${APP}/` }, undefined, LISTED)).toEqual(ALLOWED);
  });

  it("uses the request's own origin only in local development", () => {
    expect(allowedOrigins({}, "http://localhost:3000", [])).toEqual(["http://localhost:3000"]);
    // Deployed (VERCEL_ENV set): the request origin is never read.
    expect(
      allowedOrigins({ VERCEL_ENV: "preview", VERCEL_URL: "app-git-x.vercel.app" }, "https://evil.example", []),
    ).toEqual(["https://app-git-x.vercel.app"]);
  });

  it("falls back to the list alone when no canonical URL is configured", () => {
    expect(allowedOrigins({ VERCEL_ENV: "production" }, "https://evil.example", LISTED)).toEqual(LISTED);
  });

  it("drops list entries that are not one exact origin, and duplicates", () => {
    expect(
      allowedOrigins({ APP_CANONICAL_URL: APP }, undefined, [
        "*",
        "https://*.example.com",
        "https://www.example.com/path",
        "ftp://files.example.com",
        APP,
        "https://www.example.com",
      ]),
    ).toEqual(ALLOWED);
  });
});

describe("originOf / matchOrigin", () => {
  it("reads an exact origin and refuses anything else", () => {
    expect(originOf("https://a.example.com:8443/x?y")).toBe("https://a.example.com:8443");
    expect(originOf("javascript:alert(1)")).toBeNull();
    expect(originOf("not a url")).toBeNull();
  });

  it("matches only an exact string — no prefix, suffix, case or null tricks", () => {
    expect(matchOrigin(APP, ALLOWED)).toBe(APP);
    for (const origin of [
      null,
      "",
      "null",
      "https://app.example.com.evil.example",
      "https://evilapp.example.com",
      "http://app.example.com",
      "HTTPS://APP.EXAMPLE.COM",
      "https://app.example.com/",
      "*",
    ]) {
      expect(matchOrigin(origin, ALLOWED), String(origin)).toBeNull();
    }
  });
});

describe("corsHeaders", () => {
  it("an approved origin gets that origin and credentials, never *", () => {
    const h = corsHeaders("https://www.example.com", ALLOWED);
    expect(h).toEqual({
      "Access-Control-Allow-Origin": "https://www.example.com",
      "Access-Control-Allow-Credentials": "true",
      Vary: "Origin",
    });
  });

  it("returns the allowlist's own string, not the request's", () => {
    const fromList = ALLOWED[1];
    const requested = `${"https://www."}${"example.com"}`;
    expect(corsHeaders(requested, ALLOWED)["Access-Control-Allow-Origin"]).toBe(fromList);
  });

  it("an unapproved origin, or none, gets no CORS header at all", () => {
    for (const origin of ["https://evil.example", null]) {
      expect(corsHeaders(origin, ALLOWED)).toEqual({ Vary: "Origin" });
    }
  });
});

describe("preflight", () => {
  it("recognises only OPTIONS with a requested method", () => {
    expect(isPreflight("OPTIONS", new Headers({ "access-control-request-method": "POST" }))).toBe(true);
    expect(isPreflight("OPTIONS", new Headers())).toBe(false);
    expect(isPreflight("POST", new Headers({ "access-control-request-method": "POST" }))).toBe(false);
  });

  it("answers an approved origin 204 with the allowed methods", () => {
    const pf = corsPreflight(APP, ALLOWED);
    expect(pf.status).toBe(204);
    expect(pf.headers["Access-Control-Allow-Origin"]).toBe(APP);
    expect(pf.headers["Access-Control-Allow-Credentials"]).toBe("true");
    expect(pf.headers["Access-Control-Allow-Methods"]).toBe(CORS_ALLOWED_METHODS);
    expect(pf.headers["Access-Control-Max-Age"]).toBe("600");
  });

  it("refuses an unapproved origin with 403 and no CORS header", () => {
    expect(corsPreflight("https://evil.example", ALLOWED)).toEqual({ status: 403, headers: { Vary: "Origin" } });
  });
});

describe("applyCors", () => {
  it("sets the headers for an approved origin", () => {
    const h = new Headers();
    applyCors(h, APP, ALLOWED);
    expect(h.get("access-control-allow-origin")).toBe(APP);
    expect(h.get("vary")).toBe("Origin");
  });

  it("adds Origin to an existing Vary instead of replacing it, once", () => {
    const h = new Headers({ Vary: "RSC, Next-Router-State-Tree" });
    applyCors(h, "https://evil.example", ALLOWED);
    expect(h.get("vary")).toBe("RSC, Next-Router-State-Tree, Origin");
    applyCors(h, APP, ALLOWED);
    expect(h.get("vary")).toBe("RSC, Next-Router-State-Tree, Origin");
    expect(h.get("access-control-allow-origin")).toBe(APP);
  });
});
