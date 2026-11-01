// The public security page and security.txt (PiersAG/app-business-core#524,
// Matt Murphy #151). Each claim the page makes for every app is checked
// against the code it describes, so the page cannot say something the
// template does not do; per-app facts are never invented; security.txt
// follows RFC 9116 and never takes its address from the request.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SECURITY_TXT_VALID_DAYS,
  TEMPLATE_SECTIONS,
  buildSecurityTxt,
  isolationSection,
  profileSections,
  securityContact,
} from "@/lib/security-page";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const text = (id: string) => TEMPLATE_SECTIONS.find((s) => s.id === id)!.paragraphs.join(" ");

describe("every claim is backed by the code", () => {
  it("HTTPS for two years: next.config.ts sends HSTS max-age 63072000", () => {
    expect(text("encryption")).toMatch(/two years/);
    expect(read("next.config.ts")).toMatch(/Strict-Transport-Security[\s\S]*max-age=63072000/);
  });

  it("bcrypt password hashing: lib/password.ts uses bcrypt", () => {
    expect(text("encryption")).toMatch(/bcrypt/);
    expect(read("lib/password.ts")).toMatch(/from "bcryptjs"/);
  });

  it("a database per business: lib/db.ts defaults to per_tenant", () => {
    expect(read("lib/db.ts")).toMatch(/TENANCY_MODE \?\? "per_tenant"/);
    expect(isolationSection({}).paragraphs[0]).toBe("Each customer business has its own database.");
    expect(isolationSection({ TENANCY_MODE: " Shared " }).paragraphs[0]).not.toMatch(/own database/);
  });

  it("the cross-business check exists", () => {
    expect(existsSync(join(ROOT, "tests/isolation/per-tenant.spec.ts"))).toBe(true);
  });

  it("a strict CSP that blocks framing: lib/csp.ts", () => {
    expect(text("scanning")).toMatch(/content security policy/);
    expect(read("lib/csp.ts")).toMatch(/frame-ancestors", \["'none'"\]/);
  });

  it("the 72-hour notice: docs/legal/breach-procedure.md", () => {
    expect(text("incidents")).toMatch(/72 hours/);
    expect(read("docs/legal/breach-procedure.md")).toMatch(/within 72 hours/);
  });
});

describe("securityContact", () => {
  it("prefers the profile, then SECURITY_CONTACT_EMAIL, then the support address", () => {
    const profile = { dataLocation: null, backups: null, contactEmail: null };
    expect(securityContact({ SECURITY_CONTACT_EMAIL: "sec@a.com", NEXT_PUBLIC_SUPPORT_EMAIL: "s@a.com" }, profile)).toBe("sec@a.com");
    expect(securityContact({ NEXT_PUBLIC_SUPPORT_EMAIL: " s@a.com " }, profile)).toBe("s@a.com");
    expect(securityContact({ SECURITY_CONTACT_EMAIL: "x@b.com" }, { ...profile, contactEmail: "p@a.com" })).toBe("p@a.com");
  });

  it("ignores values that are not one email address", () => {
    const profile = { dataLocation: null, backups: null, contactEmail: "not-an-email" };
    expect(securityContact({ SECURITY_CONTACT_EMAIL: "a@b.com\nInjected: x" }, profile)).toBeNull();
    expect(securityContact({}, profile)).toBeNull();
  });
});

describe("profileSections", () => {
  it("shows what the app set", () => {
    const s = profileSections({ dataLocation: "EU (Frankfurt)", backups: "Daily, kept 30 days", contactEmail: null }, null);
    expect(s.map((x) => x.paragraphs[0])).toEqual(["EU (Frankfurt)", "Daily, kept 30 days"]);
  });

  it("says plainly when the app has not set them, and where to ask", () => {
    const unset = { dataLocation: null, backups: null, contactEmail: null };
    expect(profileSections(unset, "sec@a.com")[0].paragraphs[0]).toMatch(/not published.*sec@a\.com/);
    expect(profileSections(unset, null)[1].paragraphs[0]).toMatch(/contact page/);
  });
});

describe("buildSecurityTxt (RFC 9116)", () => {
  const now = new Date("2026-11-01T12:00:00.000Z");

  it("has Contact, a future Expires under a year, Policy and Canonical", () => {
    const txt = buildSecurityTxt("https://app.example.com/", "sec@a.com", now);
    expect(txt).toBe(
      [
        "Contact: mailto:sec@a.com",
        "Expires: 2027-04-30T12:00:00Z",
        "Policy: https://app.example.com/security#report",
        "Canonical: https://app.example.com/.well-known/security.txt",
        "Preferred-Languages: en",
        "",
      ].join("\n"),
    );
    expect(SECURITY_TXT_VALID_DAYS).toBeLessThan(365);
  });

  it("falls back to the contact page when no address is set", () => {
    expect(buildSecurityTxt("https://app.example.com", null, now)).toMatch(/^Contact: https:\/\/app\.example\.com\/contact$/m);
  });

  it("the route uses the canonical URL, never the Host header alone", () => {
    expect(read("app/.well-known/security.txt/route.ts")).toMatch(/canonicalBaseUrl\(/);
  });
});

describe("every app serves the page and the file (#524)", () => {
  it("app/security/page.tsx and app/.well-known/security.txt/route.ts exist", () => {
    expect(existsSync(join(ROOT, "app/security/page.tsx"))).toBe(true);
    expect(existsSync(join(ROOT, "app/.well-known/security.txt/route.ts"))).toBe(true);
  });
});
