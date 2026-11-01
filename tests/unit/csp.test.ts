// The Content-Security-Policy lib/csp.ts builds (PiersAG/app-business-core#446):
// the required directives, violation reporting on every policy, and the
// report-only phase for a new outside source (Matt Murphy #165).

import { describe, expect, it } from "vitest";
import type { CspSourceEntry } from "@/config/csp";
import {
  CSP_REPORT_GROUP,
  CSP_REPORT_PATH,
  applyCsp,
  buildCsp,
  cspHeaders,
  generateNonce,
  isEnforced,
} from "@/lib/csp";

const directives = (policy: string) =>
  Object.fromEntries(
    policy.split(";").map((part) => {
      const [name, ...values] = part.trim().split(/\s+/);
      return [name, values];
    }),
  );

const font: CspSourceEntry = {
  directive: "font",
  source: "https://fonts.example.com",
  reason: "brand font",
  reportOnlyFrom: "2026-10-01",
  enforcedOn: "2026-10-09",
};
const tiles: CspSourceEntry = {
  directive: "connect",
  source: "https://tiles.example.com",
  reason: "map tiles",
  reportOnlyFrom: "2026-10-30",
};

describe("generateNonce", () => {
  it("returns a fresh 128-bit base64 value each call", () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).not.toBe(b);
    expect(atob(a)).toHaveLength(16);
  });
});

describe("buildCsp", () => {
  it("keeps every protection the template enforces", () => {
    const d = directives(buildCsp("abc"));
    expect(d["default-src"]).toEqual(["'self'"]);
    expect(d["script-src"]).toEqual(["'self'", "'nonce-abc'", "'strict-dynamic'"]);
    expect(d["script-src"]).not.toContain("'unsafe-inline'");
    expect(d["object-src"]).toEqual(["'none'"]);
    expect(d["frame-ancestors"]).toEqual(["'none'"]);
    expect(d["base-uri"]).toEqual(["'self'"]);
    expect(d["form-action"]).toEqual(["'self'"]);
    expect(d).toHaveProperty("upgrade-insecure-requests");
  });

  it("names the report endpoint both ways (#446, Matt Murphy #165)", () => {
    const d = directives(buildCsp("abc"));
    expect(d["report-uri"]).toEqual([CSP_REPORT_PATH]);
    expect(d["report-to"]).toEqual([CSP_REPORT_GROUP]);
  });

  it("adds an outside source to its directive, keeping 'self'", () => {
    const d = directives(buildCsp("abc", [font, tiles, { ...tiles, directive: "frame" }]));
    expect(d["font-src"]).toEqual(["'self'", "https://fonts.example.com"]);
    expect(d["connect-src"]).toEqual(["'self'", "https://tiles.example.com"]);
    expect(d["frame-src"]).toEqual(["'self'", "https://tiles.example.com"]);
    expect(d["frame-ancestors"]).toEqual(["'none'"]);
  });

  it("lists a source once however often it is named", () => {
    const d = directives(buildCsp("abc", [font, font]));
    expect(d["font-src"]).toEqual(["'self'", "https://fonts.example.com"]);
  });
});

describe("cspHeaders — the report-only phase", () => {
  it("sends no report-only policy while nothing is report-only", () => {
    const h = cspHeaders("n1", [font]);
    expect(h).not.toHaveProperty("Content-Security-Policy-Report-Only");
    expect(h["Content-Security-Policy"]).toContain("https://fonts.example.com");
    expect(h["Reporting-Endpoints"]).toBe(`${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`);
  });

  it("tries a report-only source in the second header only", () => {
    const h = cspHeaders("n1", [font, tiles]);
    expect(h["Content-Security-Policy"]).not.toContain("https://tiles.example.com");
    expect(h["Content-Security-Policy-Report-Only"]).toContain("https://tiles.example.com");
    expect(h["Content-Security-Policy-Report-Only"]).toContain("https://fonts.example.com");
    expect(h["Content-Security-Policy-Report-Only"]).toContain(`report-uri ${CSP_REPORT_PATH}`);
  });

  it("the template default has no outside source and no report-only header", () => {
    const h = cspHeaders("n1");
    expect(Object.keys(h).sort()).toEqual(["Content-Security-Policy", "Reporting-Endpoints"]);
  });

  it("isEnforced follows enforcedOn", () => {
    expect(isEnforced(font)).toBe(true);
    expect(isEnforced(tiles)).toBe(false);
  });

  it("applyCsp sets every header on a Headers object", () => {
    const headers = new Headers();
    applyCsp(headers, "n2", [tiles]);
    expect(headers.get("content-security-policy")).toContain("'nonce-n2'");
    expect(headers.get("content-security-policy-report-only")).toContain("https://tiles.example.com");
    expect(headers.get("reporting-endpoints")).toContain(CSP_REPORT_PATH);
  });

  it("applyCsp with the template default sets the enforced policy only", () => {
    const headers = new Headers();
    applyCsp(headers, "n3");
    expect(headers.get("content-security-policy")).toContain("'nonce-n3'");
    expect(headers.has("content-security-policy-report-only")).toBe(false);
  });
});
