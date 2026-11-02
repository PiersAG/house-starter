// Every external resource the app loads, what it can reach, and where it loads
// (app-business-core issue 807; Matt Murphy #59: "inventory every third-party
// script, identify what data each can access and then document which pages
// each script loads on"; "implement page-level script loading that excludes
// third-party scripts from any page that handles credentials, payment data or
// administrative functions"; Matt Murphy #165: "list every external resource
// your application is loading — scripts, style sheets, fonts, images,
// iframes").
//
// The template loads nothing from another domain, so the list is empty. An app
// that adds an analytics, chat or font service adds one entry here and the
// matching origin in config/csp.ts (report-only first); a script is then
// loaded only through components/ThirdPartyScripts.tsx, on the pages listed,
// and never on a sensitive page.
//
// tests/unit/third-party.test.ts fails when config/csp.ts allows an origin
// this list does not explain (or the reverse), when the source loads a script,
// style sheet, font, image or frame from an origin not listed here, when a
// script is loaded any other way, or when an entry lists a sensitive page.

export type ResourceKind = "script" | "style" | "font" | "img" | "frame" | "connect";

export interface ThirdPartyResource {
  /** The service, e.g. "Plausible analytics". */
  name: string;
  /** Exact https origins it is loaded from or talks to. */
  origins: string[];
  kinds: ResourceKind[];
  /** What it can read or send: page addresses, form fields, cookies, the screen. */
  dataAccess: string;
  /** The pages it loads on (path prefixes); never a sensitive page. */
  pages: string[];
  /** For a script: the address of the file loaded. */
  src?: string;
  reason: string;
  /**
   * True when it reads or sends personal data (an IP address, cookies, what the
   * person types or does). Such a resource loads ONLY after the person agrees
   * (issue 745; Matt Murphy #203: "users should understand what they're
   * agreeing to in plain language before the data moves anywhere"), and must
   * also be on config/subprocessors.ts and in config/personal-data.ts.
   */
  personalData?: boolean;
  /** The plain-language question asked before it loads; required with personalData. */
  consent?: string;
}

export const THIRD_PARTY: readonly ThirdPartyResource[] = [];

/**
 * Pages that handle credentials, payment data or administrative functions:
 * no third-party script ever loads on them (or below them).
 */
export const SENSITIVE_PAGES: readonly string[] = [
  "/login",
  "/signup",
  "/reset-password",
  "/account",
  "/dashboard",
  "/reactivate",
  "/api",
];
