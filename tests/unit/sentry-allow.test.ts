// @vitest-environment node
//
// The only quoted values that reach Sentry are the app's own fixed words
// (Dispatch AT review 2, CEO ruling 2026-11-09). The setting names must be
// exactly the names .env.contract declares: a name added there and not here
// fails, so the generated list never drifts (rerun scripts/gen-sentry-allow.mjs).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENV_CONTRACT_NAMES } from "@/lib/observability/sentry-allow.generated";
import { SUBSCRIPTION_STATUSES } from "@/lib/observability/sentry-allow";

const ROOT = join(__dirname, "..", "..");

function declared(): string[] {
  const text = readFileSync(join(ROOT, ".env.contract"), "utf8");
  const names = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => l.slice(0, l.indexOf("=")).trim());
  return [...new Set(names)].sort();
}

describe("the quoted-value allow-list", () => {
  it("holds every name .env.contract declares, and nothing else", () => {
    const listed = [...ENV_CONTRACT_NAMES].sort();
    expect(declared().filter((n) => !listed.includes(n))).toEqual([]);
    expect(listed).toEqual(declared());
  });

  it("holds the subscription status words the app stores", () => {
    for (const s of ["active", "trialing", "past_due", "canceled", "unpaid", "incomplete"]) {
      expect(SUBSCRIPTION_STATUSES).toContain(s);
    }
  });

  it("holds only exact words, no patterns", () => {
    for (const v of [...ENV_CONTRACT_NAMES, ...SUBSCRIPTION_STATUSES]) {
      expect(v).toMatch(/^[A-Za-z0-9_]+$/);
    }
  });
});
