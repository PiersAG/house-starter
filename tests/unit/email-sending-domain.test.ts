// Transactional mail sends only from its own subdomain (app-business-core issue
// 757; Matt Murphy #131: "step 2A dedicated sending domain for transactional
// e-mail separate from your marketing").

import { describe, expect, it } from "vitest";
import {
  addressDomain,
  checkSendingDomain,
  isSubdomain,
  registrableDomain,
} from "@/lib/email/sending-domain";
import { dmarcNames, dmarcPolicy, judgeDomain } from "@/lib/email/domain-check";

const env = (o: Record<string, string>) => ({ NODE_ENV: "test", ...o }) as NodeJS.ProcessEnv;

describe("the sending domain", () => {
  it("reads the domain of a sender with or without a display name", () => {
    expect(addressDomain("K9Coach <hello@mail.getk9coach.com>")).toBe("mail.getk9coach.com");
    expect(addressDomain("hello@Mail.GetK9Coach.com")).toBe("mail.getk9coach.com");
    expect(addressDomain("not an address")).toBeNull();
  });

  it("tells a subdomain from a bare domain, including two-part endings", () => {
    expect(registrableDomain("mail.getk9coach.co.uk")).toBe("getk9coach.co.uk");
    expect(isSubdomain("mail.getk9coach.com")).toBe(true);
    expect(isSubdomain("getk9coach.com")).toBe(false);
    expect(isSubdomain("getk9coach.co.uk")).toBe(false);
    expect(isSubdomain("mail.getk9coach.co.uk")).toBe(true);
  });

  it("passes a sender on the transactional subdomain", () => {
    expect(
      checkSendingDomain(env({ EMAIL_SENDING_DOMAIN: "mail.getk9coach.com", EMAIL_FROM: "K9Coach <hello@mail.getk9coach.com>" })),
    ).toEqual({ ok: true, detail: "transactional mail sends from its own subdomain" });
  });

  it.each([
    [{}, "EMAIL_SENDING_DOMAIN is not set"],
    [{ EMAIL_SENDING_DOMAIN: "getk9coach.com", EMAIL_FROM: "a@getk9coach.com" }, "bare domain"],
    [{ EMAIL_SENDING_DOMAIN: "mail.getk9coach.com" }, "EMAIL_FROM is not set"],
    [{ EMAIL_SENDING_DOMAIN: "mail.getk9coach.com", EMAIL_FROM: "a@getk9coach.com" }, "does not send from"],
    [
      { EMAIL_SENDING_DOMAIN: "mail.getk9coach.com", EMAIL_FROM: "a@mail.getk9coach.com", EMAIL_MARKETING_DOMAIN: "mail.getk9coach.com" },
      "EMAIL_MARKETING_DOMAIN",
    ],
    [
      { EMAIL_SENDING_DOMAIN: "mail.getk9coach.com", EMAIL_FROM: "a@mail.getk9coach.com", EMAIL_MARKETING_DOMAIN: "news.mail.getk9coach.com" },
      "EMAIL_MARKETING_DOMAIN",
    ],
  ])("refuses %o", (o, reason) => {
    const r = checkSendingDomain(env(o as Record<string, string>));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain(reason);
  });

  it("accepts marketing on the bare domain while transactional mail has its subdomain", () => {
    expect(
      checkSendingDomain(
        env({ EMAIL_SENDING_DOMAIN: "mail.getk9coach.com", EMAIL_FROM: "a@mail.getk9coach.com", EMAIL_MARKETING_DOMAIN: "getk9coach.com" }),
      ).ok,
    ).toBe(true);
  });

  it("never puts a setting's value into its reason", () => {
    const r = checkSendingDomain(env({ EMAIL_SENDING_DOMAIN: "mail.secret-name.com", EMAIL_FROM: "a@other.com" }));
    expect(r.detail).not.toContain("secret-name");
  });
});

// ── is the domain ready? (issue 470: SPF, DKIM, DMARC) ──────────────────────

describe("the sending domain's records", () => {
  const verified = {
    found: true,
    verified: true,
    region: "eu-west-1",
    records: [
      { record: "SPF", type: "TXT", name: "send.mail", ok: true },
      { record: "DKIM", type: "TXT", name: "resend._domainkey.mail", ok: true },
    ],
  };

  it("reads DMARC at the sending domain, then the registrable domain", () => {
    expect(dmarcNames("mail.getk9coach.com")).toEqual(["_dmarc.mail.getk9coach.com", "_dmarc.getk9coach.com"]);
    expect(dmarcPolicy(["v=spf1 -all", "v=DMARC1; p=quarantine; rua=mailto:x@y.z"])).toBe("quarantine");
    expect(dmarcPolicy(["v=spf1 -all"])).toBeNull();
  });

  it("is ready only when the provider has verified SPF and DKIM and DMARC exists", () => {
    expect(judgeDomain("mail.x.com", verified, { name: "_dmarc.x.com", policy: "none" }).ready).toBe(true);
    expect(judgeDomain("mail.x.com", verified, null).ready).toBe(false);
    const pending = { ...verified, verified: false, records: [{ ...verified.records[0], ok: false }] };
    const r = judgeDomain("mail.x.com", pending, { name: "_dmarc.x.com", policy: "none" });
    expect(r.ready).toBe(false);
    expect(r.lines).toContain("SPF (TXT send.mail): not verified yet");
  });

  it("says plainly when the domain has not been added at the provider", () => {
    expect(judgeDomain("mail.x.com", { found: false, verified: false, records: [] }, null)).toEqual({
      ready: false,
      lines: ["mail.x.com: not added at the email provider yet"],
    });
  });
});
