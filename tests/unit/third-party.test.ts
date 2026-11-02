// @vitest-environment node
//
// Third-party resources (app-business-core issue 807; Matt Murphy #59 and #165).
//
//   * config/third-party.ts and config/csp.ts agree: every origin the policy
//     allows is explained by an inventory entry, and every entry's origins are
//     in the policy — so nothing can load from a domain that is not listed,
//     with what it can reach and where it loads;
//   * the source loads no script, style sheet, font, image or frame from an
//     origin not in the inventory, and loads scripts only through
//     components/ThirdPartyScripts.tsx;
//   * no entry lists a sensitive page, and the loader refuses sensitive pages
//     whatever an entry says.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CSP_SOURCES } from "@/config/csp";
import { SENSITIVE_PAGES, THIRD_PARTY, type ThirdPartyResource } from "@/config/third-party";
import { isSensitivePage, scriptsFor } from "@/components/ThirdPartyScripts";

const ROOT = join(__dirname, "..", "..");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
    else if (/\.(tsx?|css)$/.test(name) && !/\.test\./.test(name)) out.push(rel);
  }
  return out;
}

const SOURCE = ["app", "components"].flatMap(walk);
const INVENTORIED = new Set(THIRD_PARTY.flatMap((r) => r.origins));

describe("the third-party inventory (#807)", () => {
  it("explains every origin the content security policy allows, and only those", () => {
    const allowed = new Set(CSP_SOURCES.map((s) => s.source));
    expect([...allowed].filter((o) => !INVENTORIED.has(o))).toEqual([]);
    expect([...INVENTORIED].filter((o) => !allowed.has(o))).toEqual([]);
  });

  it("names, for each entry, what it can reach and where it loads — never a sensitive page", () => {
    for (const r of THIRD_PARTY) {
      expect(r.dataAccess.length, r.name).toBeGreaterThan(10);
      expect(r.pages.length, r.name).toBeGreaterThan(0);
      expect(r.pages.filter(isSensitivePage), r.name).toEqual([]);
    }
  });

  it("finds no resource in the source loaded from an origin it does not list", () => {
    const loads =
      /(?:<(?:script|link|img|iframe|source|video|audio)\b[^>]*?\b(?:src|href)\s*=\s*\{?\s*["'`]|@import\s+url\(\s*["']?|url\(\s*["']?|(?:src|href)\s*:\s*["'`])(https?:\/\/[^"'`)\s/]+)/gi;
    const hits: string[] = [];
    for (const f of SOURCE) {
      for (const m of readFileSync(join(ROOT, f), "utf8").matchAll(loads)) {
        const origin = new URL(m[1]).origin;
        if (!INVENTORIED.has(origin)) hits.push(`${f}: ${origin}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("loads scripts only through ThirdPartyScripts", () => {
    const others = SOURCE.filter(
      (f) => f !== "components/ThirdPartyScripts.tsx" && /from\s+["']next\/script["']|<script\b[^>]*\bsrc\s*=/.test(readFileSync(join(ROOT, f), "utf8")),
    );
    expect(others).toEqual([]);
  });
});

describe("page-level script loading (#807)", () => {
  const widget: ThirdPartyResource = {
    name: "Chat widget",
    origins: ["https://chat.example.com"],
    kinds: ["script", "connect"],
    dataAccess: "Everything on the page it runs on, and the visitor's typing.",
    pages: ["/", "/pricing", "/login", "/dashboard"],
    src: "https://chat.example.com/widget.js",
    reason: "seeded",
  };

  it("loads a listed script on a listed public page", () => {
    expect(scriptsFor("/pricing", [widget])).toEqual([widget]);
    expect(scriptsFor("/pricing/annual", [widget])).toEqual([widget]);
    expect(scriptsFor("/contact", [{ ...widget, pages: ["/pricing"] }])).toEqual([]);
  });

  it("never loads on a page that handles credentials, payment data or administration, even if listed", () => {
    for (const p of [...SENSITIVE_PAGES, "/login", "/dashboard/settings", "/account/security", "/api/billing/checkout", "/reset-password"]) {
      expect(scriptsFor(p, [{ ...widget, pages: ["/"] }]), p).toEqual([]);
      expect(isSensitivePage(p), p).toBe(true);
    }
    expect(isSensitivePage("/loginx")).toBe(false);
  });

  it("covers the template's sign-in, account, settings and billing pages", () => {
    for (const p of ["/login", "/signup", "/reset-password", "/account", "/dashboard", "/reactivate"]) {
      expect(SENSITIVE_PAGES, p).toContain(p);
    }
  });

  it("loads only entries that are scripts with an address", () => {
    expect(scriptsFor("/", [{ ...widget, kinds: ["font"] }])).toEqual([]);
    expect(scriptsFor("/", [{ ...widget, src: undefined }])).toEqual([]);
  });
});
