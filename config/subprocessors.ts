// The outside services that handle this app's data — its subprocessors
// (app-business-core issue 350 LEGAL.04; Matt Murphy #203: "update the vendor
// list to the real stack"). Shown at /subprocessors, named in the privacy
// policy, and read by the personal-data map (config/personal-data.ts): every
// service the map sends personal data to must be on this list, and every
// service on this list that is in use must be one the map names.
//
// The list is the services the factory has chosen (decisions of 2026-10-26 to
// 2026-11-02 in app-business-core wiki/decisions.md). A service that is chosen
// but not connected yet is listed with that status, so the page never claims
// a service is in use before it is, and never hides one that is coming.
//
// Figures (locations, transfer terms) are what the factory knows of each
// service's standard terms; they are NOT legal advice and were not checked
// against each service's live terms. The CEO accepts each service's data
// processing agreement (DPA) once, at its link, and confirms the location at
// sign-up (wiki/policies/subprocessors.md in app-business-core).
//
// tests/unit/legal-documents.test.ts holds the rules above.

export type SubprocessorStatus =
  /** Connected and receiving data. */
  | "in_use"
  /** Chosen by the CEO, not connected yet: receives nothing today. */
  | "chosen_not_connected"
  /** No service chosen yet: the decision is open. */
  | "pending_decision";

export interface Subprocessor {
  /** The id the personal-data map uses. */
  id: SubprocessorId;
  /** The service's name, e.g. "Vercel". */
  name: string;
  /** What it does for the app, in plain words. */
  purpose: string;
  /** Which personal data reaches it, in plain words; "None" if none does. */
  personalData: string;
  /** Where the data is held. */
  location: string;
  /** For data that leaves the UK: the legal basis for the transfer. */
  transfer: string;
  /** Where the service's data processing agreement is accepted. */
  dpa: string;
  /** How data held there is deleted when an account is erased. */
  deletion: string;
  status: SubprocessorStatus;
  /** The board ticket or decision behind the status. */
  ref: string;
}

export type SubprocessorId =
  | "vercel"
  | "turso"
  | "upstash"
  | "stripe"
  | "aws"
  | "sentry"
  | "email";

export const SUBPROCESSORS: readonly Subprocessor[] = [
  {
    id: "vercel",
    name: "Vercel",
    purpose: "Hosts the app and runs it: every page and request passes through it.",
    personalData:
      "Everything you send to the app passes through it; its request logs hold your IP address and the pages you open for a short time.",
    location: "United States and EU edge locations (the app's functions run in the region set for the project).",
    transfer: "UK International Data Transfer Addendum to the EU Standard Contractual Clauses, in Vercel's DPA.",
    dpa: "https://vercel.com/legal/dpa",
    deletion: "Request logs expire on their own within the plan's log window; nothing else is stored there.",
    status: "in_use",
    ref: "Hosting (ADR-023); plan: wiki/decisions.md 2026-11-02",
  },
  {
    id: "turso",
    name: "Turso",
    purpose: "The app's databases: your account and your own data.",
    personalData: "Your account details and everything you keep in the app.",
    location: "The region chosen for the app's database group.",
    transfer: "UK Addendum to the EU Standard Contractual Clauses, in Turso's DPA.",
    dpa: "https://turso.tech/privacy-policy",
    deletion:
      "Your own database is deleted, with its restore history; your rows in the shared account database are deleted or anonymised.",
    status: "in_use",
    ref: "ADR-023 (per-tenant databases)",
  },
  {
    id: "upstash",
    name: "Upstash",
    purpose: "Counts requests so the app can limit abuse (rate limits).",
    personalData: "Your IP address and account id, as counters that expire within a day.",
    location: "The region chosen for the app's Redis database.",
    transfer: "UK Addendum to the EU Standard Contractual Clauses, in Upstash's DPA.",
    dpa: "https://upstash.com/trust/dpa.pdf",
    deletion: "Every counter expires on its own, within 24 hours.",
    status: "in_use",
    ref: "#703 (settled 2026-11-02)",
  },
  {
    id: "stripe",
    name: "Stripe",
    purpose: "Takes subscription payments.",
    personalData:
      "Your email address, name and payment details, which you give to Stripe directly on its payment page; the app never sees your card.",
    location: "United States, with EU and UK entities.",
    transfer: "UK Addendum to the EU Standard Contractual Clauses, in Stripe's DPA.",
    dpa: "https://stripe.com/legal/dpa",
    deletion:
      "Stripe keeps payment records under its own legal duties as a financial service; the app's own copy of invoices is kept only as long as tax law requires.",
    status: "in_use",
    ref: "Subscription billing (kernel)",
  },
  {
    id: "aws",
    name: "Amazon Web Services",
    purpose:
      "Holds the app's own keys in a locked store (the key vault), and the nightly copy of the app's databases kept outside the database provider, for recovery (backups).",
    personalData:
      "The backup copy holds everything the app's databases hold, encrypted at rest; the key vault holds no customer data.",
    location: "United Kingdom (London region).",
    transfer: "Not applicable: stored in the UK.",
    dpa: "https://aws.amazon.com/compliance/gdpr-center/",
    deletion:
      "Each backup copy is locked against change for 30 days, then deleted automatically; after any restore, every account in the erasure ledger is deleted again before the app reopens.",
    status: "in_use",
    ref: "#822 (the vault)",
  },
  {
    id: "sentry",
    name: "Sentry",
    purpose: "Records app errors so they can be fixed quickly (error tracking).",
    personalData:
      "When connected: the account id and the page involved in an error, never a password, a form's contents or an email address.",
    location: "EU data region.",
    transfer: "Not applicable while data stays in the EU region.",
    dpa: "https://sentry.io/legal/dpa/",
    deletion: "Error records expire within the plan's history window (about 30 days).",
    status: "chosen_not_connected",
    ref: "#700 (settled 2026-11-02)",
  },
  {
    id: "email",
    name: "Resend",
    purpose: "Sends the app's emails: password resets, receipts and account notices.",
    personalData: "Your email address and the message sent to you.",
    location: "Sent from the EU (Ireland); Resend is a US company.",
    transfer: "EU Standard Contractual Clauses with the UK Addendum, in Resend's DPA.",
    dpa: "https://resend.com/legal/dpa",
    deletion:
      "Resend keeps a record of each message for its plan's history window; the app keeps only whether it was delivered, never the address or the message.",
    status: "chosen_not_connected",
    ref: "#470 (CEO choice, Dispatch AG)",
  },
];

/** The services that hold or receive data today. */
export function subprocessorsInUse(list: readonly Subprocessor[] = SUBPROCESSORS): Subprocessor[] {
  return list.filter((s) => s.status === "in_use");
}

/** Plain words for a status, as the public page shows it. */
export function statusLabel(status: SubprocessorStatus): string {
  if (status === "in_use") return "In use";
  if (status === "chosen_not_connected") return "Chosen, not connected yet";
  return "Not chosen yet";
}
