// Reading CSP violation reports (PiersAG/app-business-core#446, Matt Murphy
// #165): both browser formats, and nothing kept beyond the directive, the
// blocked origin, the page path and the disposition.

import { describe, expect, it } from "vitest";
import {
  CSP_REPORT_MAX_ITEMS,
  blockedSource,
  pagePath,
  parseCspReport,
} from "@/lib/csp-report";

describe("parseCspReport", () => {
  it("reads the report-uri format", () => {
    expect(
      parseCspReport({
        "csp-report": {
          "document-uri": "https://app.example.com/dashboard?token=secret#x",
          "violated-directive": "script-src-elem 'self'",
          "blocked-uri": "https://cdn.evil.example/x.js?user=a@b.com",
          disposition: "enforce",
          "script-sample": "alert(document.cookie)",
        },
      }),
    ).toEqual([
      { directive: "script-src-elem", blocked: "https://cdn.evil.example", page: "/dashboard", disposition: "enforce" },
    ]);
  });

  it("prefers effective-directive and reads report-only disposition", () => {
    expect(
      parseCspReport({
        "csp-report": {
          "document-uri": "https://app.example.com/",
          "effective-directive": "img-src",
          "violated-directive": "img-src 'self'",
          "blocked-uri": "data",
          disposition: "report",
        },
      }),
    ).toEqual([{ directive: "img-src", blocked: "data", page: "/", disposition: "report" }]);
  });

  it("reads the Reporting API format and skips other report types", () => {
    expect(
      parseCspReport([
        {
          type: "csp-violation",
          url: "https://app.example.com/login",
          body: { effectiveDirective: "connect-src", blockedURL: "wss://socket.example.com/a", disposition: "report" },
        },
        { type: "deprecation", body: {} },
        { type: "csp-violation", url: "https://app.example.com/no-body" },
        null,
        { type: "csp-violation", body: { effectiveDirective: "script-src", blockedURL: "inline", documentURL: "https://app.example.com/a" } },
      ]),
    ).toEqual([
      { directive: "connect-src", blocked: "wss://socket.example.com", page: "/login", disposition: "report" },
      { directive: "unknown", blocked: "unknown", page: "/no-body", disposition: "enforce" },
      { directive: "script-src", blocked: "inline", page: "/a", disposition: "enforce" },
    ]);
  });

  it(`reads at most ${CSP_REPORT_MAX_ITEMS} violations from one body`, () => {
    const one = { type: "csp-violation", body: { effectiveDirective: "img-src", blockedURL: "data", documentURL: "https://a.example/" } };
    expect(parseCspReport(Array.from({ length: 50 }, () => one))).toHaveLength(CSP_REPORT_MAX_ITEMS);
  });

  it("returns nothing for something that is not a report", () => {
    for (const body of [null, 42, "x", {}, { "csp-report": "x" }]) {
      expect(parseCspReport(body), JSON.stringify(body)).toEqual([]);
    }
  });

  it("fills unknown for missing fields", () => {
    expect(parseCspReport({ "csp-report": {} })).toEqual([
      { directive: "unknown", blocked: "unknown", page: "unknown", disposition: "enforce" },
    ]);
  });
});

describe("blockedSource / pagePath", () => {
  it("keeps a scheme for a non-web URL and a keyword for a bare word", () => {
    expect(blockedSource("blob:https://app.example.com/1")).toBe("blob");
    expect(blockedSource("EVAL")).toBe("eval");
    expect(blockedSource("<script>")).toBe("unknown");
    expect(blockedSource(7)).toBe("unknown");
  });

  it("keeps only the path of a page", () => {
    expect(pagePath("https://app.example.com/a/b?c=d")).toBe("/a/b");
    expect(pagePath("/relative")).toBe("unknown");
  });
});
