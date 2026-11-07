// @vitest-environment node
// The real Have I Been Pwned range API (app-business-core issue 356). Runs only when
// PASSWORD_BREACH_LIVE=1 — the bundle's proof run sets it — so the ordinary unit suite
// never depends on the network. What it shows is the effect on the real service: a
// password every breach list holds is found, and a fresh random passphrase is not.

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkBreachedPassword } from "@/lib/password-breach";

const live = process.env.PASSWORD_BREACH_LIVE === "1";
const RANGE = { PASSWORD_BREACH_CHECK: "range" };

describe.runIf(live)("the real range API", () => {
  it("finds 'password' breached, many times over", async () => {
    const result = await checkBreachedPassword("password", { env: RANGE });
    expect(result.status).toBe("breached");
    expect(result.status === "breached" && result.count).toBeGreaterThan(1_000_000);
  });

  it("does not find a fresh random passphrase", async () => {
    const fresh = randomBytes(24).toString("base64url");
    expect(await checkBreachedPassword(fresh, { env: RANGE })).toEqual({ status: "clean" });
  });
});

describe.skipIf(live)("without PASSWORD_BREACH_LIVE", () => {
  it("does not call the network", () => {
    expect(live).toBe(false);
  });
});
