// The privacy policy, the retention policy and the subprocessor list, built
// from what the app really holds (app-business-core issues 349, 350, 774, 745;
// Matt Murphy #155: "if your policy says one thing and your app does another
// you have a compliance violation"; #203; #288: "cover what data you collect
// how you store it how users can delete it").
//
// Nothing here is typed by hand per app except the business details in
// config/legal.ts: the categories, purposes, lawful bases, services and
// retention periods all come from config/personal-data.ts and
// config/subprocessors.ts, which tests/unit/personal-data-map.test.ts checks
// against lib/schema.ts. A new table or service changes the policy in the same
// change, or the tests fail.

import { legalDetails, type LegalDetails } from "@/config/legal";
import {
  DELETION_GRACE_DAYS,
  ERASURE_CONFIRM_HOURS,
  OUTSIDE_LOCATIONS,
  PERSONAL_DATA_MAP,
  lawfulBasisLabel,
  type DataMapEntry,
} from "@/config/personal-data";
import { SUBPROCESSORS, statusLabel, type Subprocessor } from "@/config/subprocessors";
import type { LegalDocument } from "@/lib/legal/types";

/** The map's entries grouped by their plain-language category, in map order. */
export function categories(
  map: Record<string, DataMapEntry> = PERSONAL_DATA_MAP,
): { category: string; entries: [string, DataMapEntry][] }[] {
  const out: { category: string; entries: [string, DataMapEntry][] }[] = [];
  for (const [name, entry] of Object.entries(map)) {
    if (entry.personal.length === 0) continue;
    let group = out.find((g) => g.category === entry.category);
    if (!group) out.push((group = { category: entry.category, entries: [] }));
    group.entries.push([name, entry]);
  }
  return out;
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function serviceNames(ids: string[], list: readonly Subprocessor[]): string {
  const names = ids.map((id) => list.find((s) => s.id === id)?.name ?? id);
  return names.length ? unique(names).join(", ") : "no outside service";
}

export function privacyPolicy(
  d: LegalDetails = legalDetails,
  map: Record<string, DataMapEntry> = PERSONAL_DATA_MAP,
  services: readonly Subprocessor[] = SUBPROCESSORS,
): LegalDocument {
  const groups = categories(map);
  return {
    path: "/privacy",
    file: "privacy-policy.md",
    title: "Privacy policy",
    summary: `What personal data ${d.appName} collects, why, who it goes to, how long it is kept, and how you can see it or delete it.`,
    sections: [
      {
        heading: "Data controller",
        paragraphs: [
          `${d.appName} is run by ${d.controllerName}, ${d.postalAddress}. ${d.controllerName} is the data controller for the personal data described here.`,
          d.icoRegistration
            ? `${d.controllerName} is registered with the UK Information Commissioner's Office, registration number ${d.icoRegistration}.`
            : "Registration with the UK Information Commissioner's Office: number to be added once registered.",
          `For anything about your personal data, write to ${d.contactEmail}.`,
        ],
      },
      {
        heading: "What personal data we collect",
        paragraphs: ["This list is produced from the app's own data map, so it names everything the app holds."],
        bullets: [
          ...groups.map((g) => `${g.category}: ${unique(g.entries.map(([, e]) => e.holds)).join("; ")}.`),
          ...OUTSIDE_LOCATIONS.filter((l) => l.processors.length > 0).map((l) => `${l.name}: ${l.what}`),
        ],
      },
      {
        heading: "What we use it for",
        bullets: groups.map((g) => `${g.category}: ${unique(g.entries.map(([, e]) => e.purpose)).join(" ")}`),
      },
      {
        heading: "Why we use it, and our lawful basis",
        bullets: groups.map(
          (g) =>
            `${g.category}: ${unique(g.entries.map(([, e]) => lawfulBasisLabel(e.lawfulBasis))).join("; ")}.`,
        ),
      },
      {
        heading: "Who we share it with",
        paragraphs: [
          "We do not sell your personal data and we do not share it for advertising. Under the California Consumer Privacy Act this means we neither sell nor share it, so there is nothing to opt out of.",
          "These services handle it on our behalf, under a data processing agreement with each:",
        ],
        bullets: services.map(
          (s) => `${s.name} (${statusLabel(s.status).toLowerCase()}): ${s.purpose} ${s.personalData}`,
        ),
      },
      {
        heading: "Where it is held",
        bullets: services
          .filter((s) => s.status === "in_use")
          .map((s) => `${s.name}: ${s.location} Transfers: ${s.transfer}`),
      },
      {
        heading: "How long we keep it",
        bullets: groups.map((g) => `${g.category}: ${unique(g.entries.map(([, e]) => e.retention)).join(" ")}`),
      },
      {
        heading: "How to see your data or ask for it to be deleted",
        paragraphs: [
          "Signed in, open Account, then Your data. There you can download everything the app holds about you, at once, and delete your account.",
          `When you delete your account it is closed at once: nobody can sign in to it and every signed-in session ends. We keep its data for ${DELETION_GRACE_DAYS} days in case the request was a mistake, then delete it automatically. We check that nothing remains and email you to confirm, within ${ERASURE_CONFIRM_HOURS} hours of the ${DELETION_GRACE_DAYS} days ending.`,
          "A few records the law requires us to keep (invoices, for tax) are kept without your name or email address until their period ends, then deleted. The deletion reaches every place your data goes:",
        ],
        bullets: OUTSIDE_LOCATIONS.map((l) => `${l.name}: ${l.deletion}`),
      },
      {
        heading: "Your rights",
        paragraphs: [
          "Under UK data protection law (and the EU GDPR if you are in the EU) you have the right to see your data, have it corrected, have it deleted, restrict or object to how it is used, and take it with you in a standard format. Most of these you can do yourself from Account, Your data.",
          `For anything else, write to ${d.contactEmail}. We reply within one month.`,
          "You can complain to the UK Information Commissioner's Office (ico.org.uk) or, in the EU, to your local data protection authority.",
        ],
      },
      {
        heading: "Cookies",
        paragraphs: [
          "The app sets one cookie of its own, to keep you signed in, and a security token for forms. It runs no analytics and no advertising, and loads no outside script. If that ever changes, the app asks you first, in plain words, before anything is sent.",
        ],
      },
      {
        heading: "Changes to this policy",
        paragraphs: [
          `We tell signed-in users by email at least ${d.changeNoticeDays} days before a material change. Last updated ${d.updated}.`,
        ],
      },
    ],
  };
}

export function retentionPolicy(
  d: LegalDetails = legalDetails,
  map: Record<string, DataMapEntry> = PERSONAL_DATA_MAP,
): LegalDocument {
  const rule = (e: DataMapEntry): string => {
    const r = e.onErasure;
    switch (r.rule) {
      case "delete":
        return "deleted";
      case "anonymise":
        return `kept without ${r.columns.join(", ")}`;
      case "retain":
        return `only ${r.keep.join(", ")} kept for ${r.years} years (${r.legalBasis}), then deleted`;
      case "tenant_database":
        return "the account's own database is wiped and removed";
      case "append_only":
        return `kept for ${r.years} years: ${r.why}`;
      case "none":
        return "nothing to erase";
    }
  };
  return {
    path: "/privacy",
    file: "retention-policy.md",
    title: "Retention policy",
    summary: `How long ${d.appName} keeps each kind of record, and what happens to it when an account is deleted.`,
    sections: [
      {
        heading: "Retention periods",
        paragraphs: [
          "Produced from config/personal-data.ts. The retention job (lib/privacy/retention-job.ts) runs every day: it deletes rows older than their age limit, erases accounts whose deletion is due and deletes retained records whose period has ended. Each step is written to the audit trail.",
        ],
        bullets: Object.entries(map).map(
          ([name, e]) =>
            `${name} (${e.category}): ${e.retention}${e.ageLimitDays ? ` Rows older than ${e.ageLimitDays} days are deleted.` : ""} On account deletion: ${rule(e)}.`,
        ),
      },
      {
        heading: "Account deletion",
        paragraphs: [
          `Deactivated at once; erased ${DELETION_GRACE_DAYS} days later, checked and confirmed by email within ${ERASURE_CONFIRM_HOURS} hours of the due time. /api/health reports any account still not erased ${ERASURE_CONFIRM_HOURS} hours after it was due.`,
        ],
      },
      {
        heading: "Backups",
        paragraphs: [
          "The account's own database is emptied when the account is erased. The app itself holds no right to delete a database, so the database is then deleted by the operator's daily erase job, which holds that right and nothing else. Whether the database platform keeps restore points of a deleted database has not been confirmed from its documentation; if it does, they are outside the operator's reach until they age out. A separate copy in the operator's off-site backup store is kept for 30 days, locked so that it cannot be changed or removed early, and is then removed automatically. The shared account database's restore points age out within its restore window. After any restore, run `npm run privacy:replay-erasures -- <ledger.json>` with the erasure ledger exported before the restore (`npm run privacy:export-ledger`), before the app reopens.",
        ],
      },
      {
        heading: "The audit trail",
        paragraphs: [
          "The audit trail (audit_events) cannot be changed or deleted by the app: it is the evidence that the policy was followed. Its rows are kept 6 years. Removing rows older than that needs a maintenance change that lifts the append-only rule for those rows; the first are due in 2032, and the operator schedules it then.",
        ],
      },
    ],
  };
}

export function subprocessorList(
  d: LegalDetails = legalDetails,
  services: readonly Subprocessor[] = SUBPROCESSORS,
): LegalDocument {
  return {
    path: "/subprocessors",
    file: "subprocessors.md",
    title: "Subprocessors",
    summary: `The outside services that handle data for ${d.appName}, what each receives, where it is held and its data processing agreement.`,
    sections: services.map((s) => ({
      heading: s.name,
      bullets: [
        `Status: ${statusLabel(s.status)}`,
        `What it does: ${s.purpose}`,
        `Personal data it receives: ${s.personalData}`,
        `Where: ${s.location}`,
        `Transfers out of the UK: ${s.transfer}`,
        `Data processing agreement: ${s.dpa}`,
        `On account deletion: ${s.deletion}`,
      ],
    })),
  };
}

export { serviceNames };
