// The public security page and security.txt (PiersAG/app-business-core#524,
// Matt Murphy #151): what every app built from the template states about its
// security, and how an outsider reports a flaw.
//
// Every statement in TEMPLATE_SECTIONS is true of the template itself and is
// checked by a test that reads the code it describes
// (tests/unit/security-page.test.ts): HTTPS with HSTS (next.config.ts),
// bcrypt password hashing (lib/password.ts), a database per customer business
// (lib/db.ts, unless the app chose shared tenancy), the scans every change passes, and the written breach
// procedure (docs/legal/breach-procedure.md). Per-app facts come from
// config/security-profile.ts and are never invented here.

import { SECURITY_PROFILE, type SecurityProfile } from "@/config/security-profile";

export interface SecuritySection {
  id: string;
  heading: string;
  paragraphs: string[];
}

/** How long a served security.txt stays valid (RFC 9116 asks for under a year). */
export const SECURITY_TXT_VALID_DAYS = 180;

export const TEMPLATE_SECTIONS: readonly SecuritySection[] = [
  {
    id: "encryption",
    heading: "Encryption",
    paragraphs: [
      "Every connection to this app is encrypted with HTTPS. Browsers are told to refuse an unencrypted connection to it for two years (HTTP Strict Transport Security).",
      "Passwords are never stored. Only a one-way bcrypt hash is kept, so nobody, including us, can read a password back. Two-step sign-in secrets are stored encrypted.",
    ],
  },
  {
    id: "scanning",
    heading: "Security checks on every change",
    paragraphs: [
      "Before any change reaches this app it must pass automatic checks: every software package it uses is audited for known flaws and suspicious changes, the code is scanned for security mistakes and leaked keys, and the running app is scanned for common weaknesses.",
      "Every page is sent with a strict content security policy, so the browser runs only the app's own scripts. Pages cannot be framed by other websites, and no other website can read a signed-in user's data from this app.",
    ],
  },
  {
    id: "incidents",
    heading: "If something goes wrong",
    paragraphs: [
      "We follow a written breach procedure: we contain the problem, work out whose data was affected, and tell affected customers without undue delay. Where the law requires it, we notify the data protection regulator within 72 hours of becoming aware.",
    ],
  },
];

export interface SecurityEnv {
  SECURITY_CONTACT_EMAIL?: string;
  NEXT_PUBLIC_SUPPORT_EMAIL?: string;
  TENANCY_MODE?: string;
}

/**
 * How customer businesses are kept apart, read from the same setting lib/db.ts
 * reads (TENANCY_MODE, per_tenant by default), so the page cannot claim a
 * database per business for an app that shares one.
 */
export function isolationSection(env: SecurityEnv = process.env as SecurityEnv): SecuritySection {
  const shared = (env.TENANCY_MODE ?? "per_tenant").trim().toLowerCase() === "shared";
  return {
    id: "isolation",
    heading: "Your data is kept apart",
    paragraphs: [
      shared
        ? "Every record belongs to one customer business, and every query the app makes is limited to the signed-in business's records."
        : "Each customer business has its own database.",
      "Every change to the app is tested by a check that signs in as one business and tries to read and change another's data; a change that lets it through cannot ship.",
    ],
  };
}

/** The address security reports go to, or null when the app has none set. */
export function securityContact(
  env: SecurityEnv = process.env as SecurityEnv,
  profile: SecurityProfile = SECURITY_PROFILE,
): string | null {
  for (const value of [profile.contactEmail, env.SECURITY_CONTACT_EMAIL, env.NEXT_PUBLIC_SUPPORT_EMAIL]) {
    const trimmed = value?.trim();
    if (trimmed && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(trimmed)) return trimmed;
  }
  return null;
}

/** The per-app sections: where data lives and how it is backed up. */
export function profileSections(
  profile: SecurityProfile = SECURITY_PROFILE,
  contact: string | null = securityContact(),
): SecuritySection[] {
  const ask = contact
    ? `Ask us for the details at ${contact}.`
    : "Ask us for the details through the contact page.";
  return [
    {
      id: "data-location",
      heading: "Where your data is stored",
      paragraphs: [profile.dataLocation ?? `This app has not published its data location yet. ${ask}`],
    },
    {
      id: "backups",
      heading: "Backups",
      paragraphs: [profile.backups ?? `This app has not published its backup arrangements yet. ${ask}`],
    },
  ];
}

/** The text of /.well-known/security.txt (RFC 9116). */
export function buildSecurityTxt(
  baseUrl: string,
  contact: string | null,
  now: Date = new Date(),
): string {
  const base = baseUrl.replace(/\/+$/, "");
  const expires = new Date(now.getTime() + SECURITY_TXT_VALID_DAYS * 24 * 60 * 60 * 1000);
  return [
    `Contact: ${contact ? `mailto:${contact}` : `${base}/contact`}`,
    `Expires: ${expires.toISOString().replace(/\.\d{3}Z$/, "Z")}`,
    `Policy: ${base}/security#report`,
    `Canonical: ${base}/.well-known/security.txt`,
    "Preferred-Languages: en",
    "",
  ].join("\n");
}
