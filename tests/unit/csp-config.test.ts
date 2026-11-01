// The rules for config/csp.ts (PiersAG/app-business-core#446, Matt Murphy
// #165): "enable reporting first, collect violations for a week, see what
// breaks before you block it, then you enforce".
//
// An outside source is enforced only after at least CSP_REPORT_ONLY_MIN_DAYS
// report-only; a source is one exact https origin — no wildcard, no http:, no
// 'unsafe-…' keyword, no scheme-only source.

import { describe, expect, it } from "vitest";
import { CSP_REPORT_ONLY_MIN_DAYS, CSP_SOURCES, type CspSourceEntry } from "@/config/csp";

const DAY = 24 * 60 * 60 * 1000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Every rule an entry breaks; [] when it is acceptable. */
export function cspEntryProblems(entry: CspSourceEntry, today: Date = new Date()): string[] {
  const problems: string[] = [];
  let origin: string | null = null;
  try {
    const url = new URL(entry.source);
    origin = url.protocol === "https:" ? url.origin : null;
  } catch {
    origin = null;
  }
  if (origin !== entry.source || entry.source.includes("*")) {
    problems.push(`${entry.source}: not one exact https origin`);
  }
  if (!entry.reason?.trim()) problems.push(`${entry.source}: no reason given`);
  if (!ISO_DATE.test(entry.reportOnlyFrom)) problems.push(`${entry.source}: reportOnlyFrom is not a date`);
  if (entry.enforcedOn !== undefined) {
    if (!ISO_DATE.test(entry.enforcedOn)) {
      problems.push(`${entry.source}: enforcedOn is not a date`);
    } else {
      const days = (Date.parse(entry.enforcedOn) - Date.parse(entry.reportOnlyFrom)) / DAY;
      if (!(days >= CSP_REPORT_ONLY_MIN_DAYS)) {
        problems.push(
          `${entry.source}: enforced after ${days} day(s) report-only; at least ${CSP_REPORT_ONLY_MIN_DAYS} needed`,
        );
      }
      if (Date.parse(entry.enforcedOn) > today.getTime()) {
        problems.push(`${entry.source}: enforcedOn is in the future`);
      }
    }
  }
  return problems;
}

const ok: CspSourceEntry = {
  directive: "img",
  source: "https://img.example.com",
  reason: "product photos",
  reportOnlyFrom: "2026-10-01",
  enforcedOn: "2026-10-08",
};
const today = new Date("2026-11-01T00:00:00Z");

describe("config/csp.ts entries in this app", () => {
  it("every entry follows the report-first rule", () => {
    expect(CSP_SOURCES.flatMap((e) => cspEntryProblems(e))).toEqual([]);
  });
});

describe("cspEntryProblems", () => {
  it("accepts an entry enforced after exactly a week report-only", () => {
    expect(cspEntryProblems(ok, today)).toEqual([]);
  });

  it("accepts an entry still report-only", () => {
    expect(cspEntryProblems({ ...ok, enforcedOn: undefined }, today)).toEqual([]);
  });

  it("refuses an entry enforced before its report-only week is over", () => {
    expect(cspEntryProblems({ ...ok, enforcedOn: "2026-10-05" }, today)[0]).toMatch(
      /enforced after 4 day\(s\) report-only/,
    );
  });

  it("refuses an entry enforced with no report-only phase", () => {
    expect(cspEntryProblems({ ...ok, enforcedOn: "2026-10-01" }, today)).toHaveLength(1);
  });

  it("refuses a wildcard, http:, a path, a keyword and a scheme-only source", () => {
    for (const source of [
      "https://*.example.com",
      "*",
      "http://img.example.com",
      "https://img.example.com/photos",
      "'unsafe-eval'",
      "https:",
    ]) {
      expect(cspEntryProblems({ ...ok, source }, today), source).not.toEqual([]);
    }
  });

  it("refuses a missing reason and malformed or future dates", () => {
    expect(cspEntryProblems({ ...ok, reason: " " }, today)).toEqual([
      "https://img.example.com: no reason given",
    ]);
    expect(cspEntryProblems({ ...ok, reportOnlyFrom: "soon", enforcedOn: undefined }, today)).toHaveLength(1);
    expect(cspEntryProblems({ ...ok, enforcedOn: "next week" }, today)).toEqual([
      "https://img.example.com: enforcedOn is not a date",
    ]);
    expect(
      cspEntryProblems({ ...ok, reportOnlyFrom: "2026-11-10", enforcedOn: "2026-11-20" }, today),
    ).toEqual(["https://img.example.com: enforcedOn is in the future"]);
  });
});
