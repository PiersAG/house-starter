// @vitest-environment node
//
// The personal-data map and the legal documents built from it (app-business-core
// issues 745, 349, 350, 774; Matt Murphy #203: "if you cannot list every piece
// of personal data in your application touches your privacy policy is
// fiction"; #155: "if your policy says one thing and your app does another you
// have a compliance violation"). The map is checked against lib/schema.ts, the
// services against config/subprocessors.ts, and the documents against both, so
// a new table, column or service cannot reach production without the policy
// saying so.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { DATA_CLASSIFICATION } from "@/config/data-classification";
import { OUTSIDE_LOCATIONS, PERSONAL_DATA_MAP } from "@/config/personal-data";
import { SUBPROCESSORS, subprocessorsInUse } from "@/config/subprocessors";
import { REVIEW_NOTE, legalDetails, unfilledDetails } from "@/config/legal";
import { schemaTables } from "@/lib/privacy/tables";
import { categories, privacyPolicy, retentionPolicy, subprocessorList } from "@/lib/legal/privacy-policy";
import { customerDpa, serviceAgreement, termsOfService } from "@/lib/legal/contracts";
import { STUB_MARKER, isDraft, legalDocuments, toMarkdown } from "@/lib/legal/render";
import type { LegalDocument } from "@/lib/legal/types";

const ROOT = join(__dirname, "..", "..");
const tables = schemaTables();
const text = (d: LegalDocument) => toMarkdown(d);

// A column whose name says it can identify a person: one of these words in its
// camelCase name, or one of these whole names.
const IDENTIFYING_WORDS = new Set(["email", "ip", "name", "label", "actor", "before", "after", "context", "fields", "note", "data", "value"]);
const IDENTIFYING_NAMES = /^(userId|subjectUserId|tenantId|sessionTenantId|stripeCustomerId|stripeSubscriptionId|hostedInvoiceUrl|clientId|grantedBy)$/;
function identifying(column: string): boolean {
  if (IDENTIFYING_NAMES.test(column)) return true;
  return column.split(/(?=[A-Z])/).some((w) => IDENTIFYING_WORDS.has(w.toLowerCase()));
}

describe("the personal-data map covers what the app really holds (#745)", () => {
  it("has an entry for every table in lib/schema.ts, and no other", () => {
    expect(Object.keys(PERSONAL_DATA_MAP).sort()).toEqual(Object.keys(tables).sort());
  });

  it.each(Object.keys(PERSONAL_DATA_MAP))("%s names only columns that exist", (name) => {
    const entry = PERSONAL_DATA_MAP[name];
    const cols = Object.keys(getTableColumns(tables[name]));
    for (const c of [...entry.personal, ...Object.keys(entry.notPersonal ?? {})]) expect(cols, c).toContain(c);
    if (entry.linkedBy) expect(cols).toContain(entry.linkedBy);
    if (entry.ageColumn) expect(cols).toContain(entry.ageColumn);
    const rule = entry.onErasure;
    if (rule.rule === "anonymise") for (const c of rule.columns) expect(entry.personal, c).toContain(c);
    if (rule.rule === "retain") for (const c of rule.keep) expect(cols, c).toContain(c);
  });

  it.each(Object.keys(PERSONAL_DATA_MAP))("%s lists every identifying column as personal, or says why not", (name) => {
    const entry = PERSONAL_DATA_MAP[name];
    for (const c of Object.keys(getTableColumns(tables[name]))) {
      const classified = DATA_CLASSIFICATION[name]?.[c]?.class;
      const looksPersonal = classified === "personal" || identifying(c);
      if (!looksPersonal || classified === "secret" || classified === "public") continue;
      const covered = entry.personal.includes(c) || Boolean(entry.notPersonal?.[c]);
      expect(covered, `${name}.${c}`).toBe(true);
    }
  });

  it("deletes or anonymises every account-linked table it does not keep for a legal reason", () => {
    for (const [name, e] of Object.entries(PERSONAL_DATA_MAP)) {
      if (e.plane !== "catalog" || !e.linkedBy || e.personal.length === 0) continue;
      expect(["delete", "anonymise", "retain", "append_only", "none"], name).toContain(e.onErasure.rule);
      if (e.onErasure.rule === "none") expect(["retainedRecords"], name).toContain(name);
    }
  });

  it("sends personal data only to services on the subprocessor list", () => {
    const ids = new Set(SUBPROCESSORS.map((s) => s.id));
    for (const e of Object.values(PERSONAL_DATA_MAP)) for (const p of e.processors) expect(ids.has(p), p).toBe(true);
    for (const l of OUTSIDE_LOCATIONS) for (const p of l.processors) expect(ids.has(p), p).toBe(true);
  });

  it("names every service in use somewhere in the map, so none is listed for show", () => {
    const used = new Set([
      ...Object.values(PERSONAL_DATA_MAP).flatMap((e) => e.processors),
      ...OUTSIDE_LOCATIONS.flatMap((l) => l.processors),
    ]);
    for (const s of subprocessorsInUse()) {
      if (s.personalData.startsWith("None")) continue;
      expect(used.has(s.id), s.id).toBe(true);
    }
  });

  it("names deletion's route for backups, analytics and logs (Matt Murphy #203)", () => {
    const ids = OUTSIDE_LOCATIONS.map((l) => l.id);
    for (const id of ["backups", "analytics", "host-logs", "rate-limit-store"]) expect(ids).toContain(id);
    for (const l of OUTSIDE_LOCATIONS) expect(l.deletion.length, l.id).toBeGreaterThan(20);
  });
});

describe("the subprocessor list (#350)", () => {
  it("names the services chosen: Vercel, Upstash, Turso, Stripe, AWS (vault), Sentry and Resend for email", () => {
    const by = Object.fromEntries(SUBPROCESSORS.map((s) => [s.id, s]));
    for (const id of ["vercel", "upstash", "turso", "stripe", "aws"]) expect(by[id]?.status, id).toBe("in_use");
    expect(by.sentry?.status).toBe("chosen_not_connected");
    expect(by.email?.name).toBe("Resend");
    expect(by.email?.status).toBe("chosen_not_connected");
    expect(by.email?.ref).toContain("#470");
  });

  it("gives every service its purpose, data, location, transfer basis, agreement and deletion", () => {
    for (const s of SUBPROCESSORS) {
      for (const k of ["purpose", "personalData", "location", "transfer", "dpa", "deletion"] as const) {
        expect(s[k].length, `${s.id}.${k}`).toBeGreaterThan(3);
      }
    }
  });

  it("is the page's content", () => {
    const md = text(subprocessorList());
    for (const s of SUBPROCESSORS) expect(md).toContain(`## ${s.name}`);
  });
});

describe("the privacy policy matches what the app collects (#349, #774)", () => {
  const md = text(privacyPolicy());

  it("lists every category of personal data in the map, with what it holds", () => {
    for (const g of categories()) {
      expect(md).toContain(g.category);
      for (const [, e] of g.entries) expect(md).toContain(e.holds);
    }
  });

  it("names every outside service and every place data goes, IP addresses included", () => {
    for (const s of SUBPROCESSORS) expect(md).toContain(s.name);
    expect(md).toMatch(/IP address/);
  });

  it("says how a user requests deletion, and how deletion works", () => {
    expect(md).toContain("## How to see your data or ask for it to be deleted");
    expect(md).toMatch(/delete your account/);
    expect(md).toMatch(/30 days/);
  });

  it("keeps the launch gate's required heading and covers rights, cookies and the no-sale statement", () => {
    for (const h of ["## Data controller", "## Your rights", "## Cookies", "## Who we share it with"]) expect(md).toContain(h);
    expect(md).toMatch(/neither sell nor share/);
  });
});

describe("the terms, the customer DPA and the service agreement (#349, #774)", () => {
  it("the terms carry a liability limit, conduct rules, termination and dispute resolution (Matt Murphy #288)", () => {
    const md = text(termsOfService());
    for (const h of ["## Acceptable use", "## Liability", "## Ending the agreement", "## Dispute resolution", "## Governing law"]) {
      expect(md).toContain(h);
    }
    expect(md).toContain(`${legalDetails.liabilityCapMonths} months`);
  });

  it("the DPA says who is responsible for what, with the Article 28 duties", () => {
    const md = text(customerDpa());
    expect(md).toContain("## Who is responsible for what");
    expect(md).toMatch(/controller/);
    expect(md).toMatch(/processor/);
    for (const duty of [/documented instructions/, /confidential/, /secure/, /subprocessors/, /breach/, /delete it/, /audit/]) {
      expect(md).toMatch(duty);
    }
  });

  it("the service agreement covers support, uptime and response times (Matt Murphy #155 doc 5)", () => {
    const md = text(serviceAgreement());
    for (const h of ["## Support", "## Response times", "## Availability"]) expect(md).toContain(h);
    expect(md).toContain(`${legalDetails.uptimeTargetPercent}%`);
  });
});

describe("the documents are templates until the CEO records a review", () => {
  it("each carries the plain review note and the launch gate's stub marker while unreviewed", () => {
    expect(isDraft()).toBe(true);
    for (const d of legalDocuments()) {
      const md = text(d);
      expect(md.startsWith(STUB_MARKER), d.file).toBe(true);
      expect(md).toContain(REVIEW_NOTE);
    }
  });

  it("never calls a document legally checked, reviewed or not", () => {
    const reviewed = { ...legalDetails, review: { reviewedBy: "A Solicitor", reviewedOn: "2026-12-01" } };
    for (const d of [...legalDocuments(), ...legalDocuments(reviewed)]) {
      expect(toMarkdown(d, reviewed)).not.toMatch(/legally (checked|approved|verified)/i);
    }
  });

  it("drops the stub marker only when every detail is filled and the review recorded", () => {
    const filled = {
      ...legalDetails,
      appName: "K9Coach",
      controllerName: "Example Ltd",
      postalAddress: "1 High Street, London",
      contactEmail: "privacy@example.com",
      support: { ...legalDetails.support, email: "help@example.com" },
      icoRegistration: "ZA000000",
    };
    expect(unfilledDetails(filled)).toEqual([]);
    expect(isDraft(filled)).toBe(true);
    const reviewed = { ...filled, review: { reviewedBy: "A Solicitor", reviewedOn: "2026-12-01" } };
    expect(isDraft(reviewed)).toBe(false);
    expect(toMarkdown(privacyPolicy(reviewed), reviewed)).not.toContain(STUB_MARKER);
    expect(toMarkdown(privacyPolicy(reviewed), reviewed)).toContain("Reviewed by A Solicitor on 2026-12-01.");
  });

  it("the committed docs/legal files are exactly what `npm run legal:render` writes", () => {
    for (const d of legalDocuments()) {
      expect(readFileSync(join(ROOT, "docs", "legal", d.file), "utf8"), d.file).toBe(toMarkdown(d));
    }
  });

  it("the retention policy keeps the launch gate's heading and lists every table", () => {
    const md = text(retentionPolicy());
    expect(md).toContain("## Retention periods");
    for (const name of Object.keys(PERSONAL_DATA_MAP)) expect(md).toContain(`${name} (`);
  });
});

describe("an outside service that reads personal data is asked about, listed and mapped (#745)", () => {
  it("every such entry in config/third-party.ts carries a plain question and is a listed service", async () => {
    const { THIRD_PARTY } = await import("@/config/third-party");
    const names = new Set(SUBPROCESSORS.map((s) => s.name));
    for (const r of THIRD_PARTY) {
      if (!r.personalData) continue;
      expect(r.consent?.length ?? 0, r.name).toBeGreaterThan(20);
      expect(names.has(r.name), r.name).toBe(true);
    }
  });
});
