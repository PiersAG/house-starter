// The business details every legal document is built from (app-business-core
// issues 349, 774, 348). A per-app build fills the bracketed values; the
// documents (lib/legal/) and their pages (/privacy, /terms, /subprocessors,
// /legal/dpa, /legal/service-agreement) read them from here, and
// `npm run legal:render` writes the same text to docs/legal/ for the launch
// gate and the CEO's review.
//
// THESE ARE TEMPLATES, NOT LEGAL ADVICE. Nothing here has been checked by a
// lawyer. The CEO has each document reviewed by a qualified person before the
// app takes its first customer, and records the review below; until then every
// page shows that the document is a draft awaiting review. Recording a review
// removes the draft notice; it never makes the page claim the text is
// "legally checked".

export interface LegalReview {
  /** Who reviewed the documents (a name or firm). */
  reviewedBy: string;
  /** When, as YYYY-MM-DD. */
  reviewedOn: string;
}

export interface LegalDetails {
  /** The app's public name. */
  appName: string;
  /** The legal entity that runs the app (the data controller). */
  controllerName: string;
  /** Its postal address. */
  postalAddress: string;
  /** The address for privacy requests and legal notices. */
  contactEmail: string;
  /** The ICO data-protection fee registration number (#348); null until registered. */
  icoRegistration: string | null;
  /** Whose law governs the terms, and whose courts hear a dispute. */
  governingLaw: string;
  /** The liability cap: the fees paid in this many months before the claim. */
  liabilityCapMonths: number;
  /** Days of notice before a change to the terms takes effect. */
  changeNoticeDays: number;
  /** Support: how to reach it and when it is staffed. */
  support: { email: string; hours: string };
  /** Response times by severity, in working hours (the service agreement). */
  responseHours: { urgent: number; normal: number };
  /** Monthly availability the business aims for, as a percentage. */
  uptimeTargetPercent: number;
  /** Days a customer has to export their data after their contract ends. */
  exitExportDays: number;
  /** When the documents last changed (shown on every page), YYYY-MM-DD. */
  updated: string;
  /** The CEO's record of the review; null until a qualified person reviews them. */
  review: LegalReview | null;
}

export const legalDetails: LegalDetails = {
  appName: "[app name]",
  controllerName: "[legal entity]",
  postalAddress: "[postal address]",
  contactEmail: "[privacy email]",
  icoRegistration: null,
  governingLaw: "England and Wales",
  liabilityCapMonths: 12,
  changeNoticeDays: 30,
  support: { email: "[support email]", hours: "Monday to Friday, 9:00 to 17:00 UK time, except UK public holidays" },
  responseHours: { urgent: 4, normal: 16 },
  uptimeTargetPercent: 99.5,
  exitExportDays: 30,
  updated: "2026-11-02",
  review: null,
};

/** The values a per-app build must fill before launch, by name. */
export function unfilledDetails(d: LegalDetails = legalDetails): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(d)) {
    if (typeof v === "string" && /^\[.*\]$/.test(v.trim())) out.push(k);
  }
  if (/^\[.*\]$/.test(d.support.email.trim())) out.push("support.email");
  if (!d.icoRegistration) out.push("icoRegistration");
  return out;
}

/** The plain note every document carries until the CEO records a review. */
export const REVIEW_NOTE =
  "This document is a template. It has not been reviewed by a lawyer and is not legal advice. Have it reviewed by a qualified person before the app takes its first customer.";
