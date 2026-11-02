// @vitest-environment node
//
// The account-deletion surface rides the `auth` kernel switch (capability model:
// every switch tested in both states; OFF is a 404 at the route, never hidden
// UI alone). ON: the daily retention route answers only to its secret, the
// "Your data" page renders for a signed-in owner. OFF: the route is 404, the
// page is not found and both actions refuse. Plus the consent rule for outside
// scripts that read personal data (issue 745).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const kernel = vi.hoisted(() => ({ on: true }));
vi.mock("@/config/kernel", async (orig) => {
  const real = await orig<typeof import("@/config/kernel")>();
  return { ...real, isKernelEnabled: (f: string) => (f === "auth" ? kernel.on : real.isKernelEnabled(f)) };
});
const session = vi.hoisted(() => ({ value: null as null | { user: { id: string } } }));
vi.mock("@/lib/auth", () => ({ auth: async () => session.value, signOut: async () => undefined }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
}));

import { migrateCatalog } from "@/lib/migrate";
import { __resetCatalogCacheForTests } from "@/lib/catalog";
import { __resetSinkForTests } from "@/lib/observability/error-log";
import { __resetLogForTests } from "@/lib/observability/log";
import { GET as retentionGET } from "@/app/api/cron/retention/route";
import AccountPrivacyPage from "@/app/account/privacy/page";
import { deleteMyAccountAction, downloadMyDataAction } from "@/app/account/privacy/actions";
import { consentPendingFor, scriptsFor } from "@/components/ThirdPartyScripts";
import { consentValue, parseConsent } from "@/lib/privacy/consent";
import type { ThirdPartyResource } from "@/config/third-party";

let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "hs-ae-both-"));
  const url = `file:${join(dir, "catalog.db")}`;
  await migrateCatalog(url);
  process.env.CATALOG_DATABASE_URL = url;
  process.env.DATABASE_URL = url;
  __resetCatalogCacheForTests();
  __resetSinkForTests();
});

afterAll(() => {
  delete process.env.CATALOG_DATABASE_URL;
  delete process.env.DATABASE_URL;
  delete process.env.CRON_SECRET;
  __resetCatalogCacheForTests();
  __resetSinkForTests();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  __resetLogForTests();
  kernel.on = true;
  session.value = null;
  delete process.env.CRON_SECRET;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const call = (auth?: string) =>
  retentionGET(new Request("https://app.test/api/cron/retention", { headers: auth ? { authorization: auth } : {} }));

describe("auth kernel ON", () => {
  it("the retention route refuses without CRON_SECRET (503), with the wrong one (401), runs with the right one", async () => {
    expect((await call("Bearer x")).status).toBe(503);
    process.env.CRON_SECRET = "right-secret";
    expect((await call("Bearer wrong")).status).toBe(401);
    expect((await call()).status).toBe(401);
    const ok = await call("Bearer right-secret");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ erased: 0, unverified: 0 });
  });

  it("the Your data page sends a signed-out visitor to sign in, and renders for an owner", async () => {
    await expect(AccountPrivacyPage()).rejects.toThrow("NEXT_REDIRECT /login");
    session.value = { user: { id: "u1" } };
    expect(await AccountPrivacyPage()).toBeTruthy();
  });

  it("the actions need a session", async () => {
    expect(await downloadMyDataAction()).toEqual({ error: "Your session has ended. Sign in again." });
    expect(await deleteMyAccountAction(null, new FormData())).toEqual({ error: "Your session has ended. Sign in again." });
  });
});

describe("auth kernel OFF", () => {
  beforeEach(() => {
    kernel.on = false;
    process.env.CRON_SECRET = "right-secret";
    session.value = { user: { id: "u1" } };
  });

  it("the retention route is 404, even with the right secret", async () => {
    expect((await call("Bearer right-secret")).status).toBe(404);
  });

  it("the Your data page is not found", async () => {
    await expect(AccountPrivacyPage()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("both actions refuse", async () => {
    expect(await downloadMyDataAction()).toEqual({ error: "This is not available in this app." });
    expect(await deleteMyAccountAction(null, new FormData())).toEqual({ error: "This is not available in this app." });
  });
});

describe("an outside script that reads personal data waits for consent (#745)", () => {
  const analytics: ThirdPartyResource = {
    name: "Example analytics",
    origins: ["https://analytics.example.com"],
    kinds: ["script"],
    dataAccess: "page addresses and your IP address",
    pages: ["/pricing"],
    src: "https://analytics.example.com/a.js",
    reason: "usage counts",
    personalData: true,
    consent: "Can we count your visit? Example analytics sees the page address and your IP address.",
  };
  const font: ThirdPartyResource = { ...analytics, name: "Font", personalData: false, consent: undefined, src: "https://analytics.example.com/f.js" };

  it("does not load before the person agrees, and asks in plain words", () => {
    expect(scriptsFor("/pricing", [analytics])).toEqual([]);
    expect(consentPendingFor("/pricing", [analytics])).toEqual([analytics]);
  });

  it("loads once agreed, and stops asking", () => {
    const agreed = parseConsent(consentValue(["Example analytics"]));
    expect(scriptsFor("/pricing", [analytics], agreed)).toEqual([analytics]);
    expect(consentPendingFor("/pricing", [analytics], agreed)).toEqual([]);
  });

  it("a script that reads no personal data needs no question; nothing loads on a sensitive page", () => {
    expect(scriptsFor("/pricing", [font])).toEqual([font]);
    expect(consentPendingFor("/account", [analytics])).toEqual([]);
    expect(scriptsFor("/account", [analytics], new Set(["Example analytics"]))).toEqual([]);
  });

  it("reads an empty or missing answer as no", () => {
    expect(parseConsent(undefined).size).toBe(0);
    expect(parseConsent("").size).toBe(0);
  });
});
