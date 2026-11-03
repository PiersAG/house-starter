// @vitest-environment node
//
// The delivery-report route (app-business-core issue 757) in both states.
// OFF — a log-mode app, a live app without EMAIL_EVENTS_SECRET, or the `auth`
// kernel switched off: the route is absent (404), so there is never an
// unsigned endpoint. ON: an unsigned or wrongly signed report is refused (401),
// a signed one is kept without its address, and a repeated one counts once.
// Plus /api/health's `email` check: absent in log mode, red when a live app's
// reports are not set up, red on a spam complaint.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const kernel = vi.hoisted(() => ({ on: true }));
vi.mock("@/config/kernel", async (orig) => {
  const real = await orig<typeof import("@/config/kernel")>();
  return { ...real, isKernelEnabled: (f: string) => (f === "auth" ? kernel.on : real.isKernelEnabled(f)) };
});

import { migrateCatalog } from "@/lib/migrate";
import { __resetCatalogCacheForTests, getCatalogDb } from "@/lib/catalog";
import { __resetSinkForTests } from "@/lib/observability/error-log";
import { __resetLogForTests } from "@/lib/observability/log";
import { signPayload } from "@/lib/email/webhook-signature";
import { emailHealth } from "@/lib/email/health";
import { POST } from "@/app/api/email/events/route";

const SECRET = `whsec_${Buffer.from("planted-route-signing-key-32-byte").toString("base64")}`;
const KEYS = ["EMAIL_SEND_MODE", "EMAIL_EVENTS_SECRET", "EMAIL_SENDING_DOMAIN", "EMAIL_FROM"];
let dir: string;
let url: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "hs-ag-email-"));
  url = `file:${join(dir, "catalog.db")}`;
  await migrateCatalog(url);
  process.env.CATALOG_DATABASE_URL = url;
  __resetCatalogCacheForTests();
  __resetSinkForTests();
});

afterAll(() => {
  delete process.env.CATALOG_DATABASE_URL;
  for (const k of KEYS) delete process.env[k];
  __resetCatalogCacheForTests();
  __resetSinkForTests();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  __resetLogForTests();
  kernel.on = true;
  for (const k of KEYS) delete process.env[k];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

function live() {
  process.env.EMAIL_SEND_MODE = "live";
  process.env.EMAIL_EVENTS_SECRET = SECRET;
  process.env.EMAIL_SENDING_DOMAIN = "mail.example.com";
  process.env.EMAIL_FROM = "App <hello@mail.example.com>";
}

function report(id: string, body: object, opts: { secret?: string; sign?: boolean } = {}) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = { "content-type": "application/json", "svix-id": id, "svix-timestamp": ts };
  if (opts.sign !== false) headers["svix-signature"] = signPayload(opts.secret ?? SECRET, id, ts, raw);
  return POST(new Request("https://app.test/api/email/events", { method: "POST", headers, body: raw }));
}

async function rows(): Promise<Array<Record<string, unknown>>> {
  const c = createClient({ url });
  try {
    return (await c.execute("SELECT * FROM email_events ORDER BY id")).rows as Array<Record<string, unknown>>;
  } finally {
    c.close();
  }
}

const delivered = { type: "email.delivered", data: { email_id: "m1", to: ["someone@example.com"], subject: "Reset" } };

describe("delivery reports OFF", () => {
  it("is absent in log mode, even with the secret set", async () => {
    process.env.EMAIL_EVENTS_SECRET = SECRET;
    expect((await report("off-1", delivered)).status).toBe(404);
  });
  it("is absent on a live app without EMAIL_EVENTS_SECRET", async () => {
    live();
    delete process.env.EMAIL_EVENTS_SECRET;
    expect((await report("off-2", delivered)).status).toBe(404);
  });
  it("is absent when the auth kernel is off", async () => {
    live();
    kernel.on = false;
    expect((await report("off-3", delivered)).status).toBe(404);
  });
  it("keeps nothing while off", async () => {
    expect(await rows()).toHaveLength(0);
  });
});

describe("delivery reports ON", () => {
  it("refuses an unsigned report and one signed with another secret", async () => {
    live();
    expect((await report("on-1", delivered, { sign: false })).status).toBe(401);
    const other = `whsec_${Buffer.from("someone-elses-key").toString("base64")}`;
    expect((await report("on-1", delivered, { secret: other })).status).toBe(401);
    expect(await rows()).toHaveLength(0);
  });
  it("keeps a signed report without its address, once however often it comes", async () => {
    live();
    expect((await report("on-2", delivered)).status).toBe(200);
    expect((await report("on-2", delivered)).status).toBe(200);
    const kept = await rows();
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ id: "on-2", type: "delivered", message_id: "m1" });
    expect(JSON.stringify(kept)).not.toContain("someone@example.com");
  });
  it("refuses a declared oversized body before reading it (64 KB)", async () => {
    live();
    const text = vi.fn(async () => "{}");
    const big = new Request("https://app.test/api/email/events", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(64 * 1024 + 1) },
      body: "{}",
    });
    Object.defineProperty(big, "text", { value: text });
    expect((await POST(big)).status).toBe(413);
    expect(text).not.toHaveBeenCalled();
  });
  it("still measures a body sent with no length", async () => {
    live();
    const r = await POST(
      new Request("https://app.test/api/email/events", { method: "POST", body: "x".repeat(64 * 1024 + 1) }),
    );
    expect(r.status).toBe(413);
  });
  it("refuses a body that is not a report", async () => {
    live();
    expect((await report("on-3", { hello: "world" })).status).toBe(400);
  });
});

describe("/api/health's email check", () => {
  it("is absent in log mode", async () => {
    expect(await emailHealth(getCatalogDb())).toBeNull();
  });
  it("is red when a live app's delivery reports are not set up", async () => {
    live();
    delete process.env.EMAIL_EVENTS_SECRET;
    expect(await emailHealth(getCatalogDb())).toEqual({
      ok: false,
      detail: "delivery reports are not set up (EMAIL_EVENTS_SECRET)",
    });
  });
  it("is green with the reports above, and red after a spam complaint", async () => {
    live();
    expect((await emailHealth(getCatalogDb()))?.ok).toBe(true);
    await report("on-4", { type: "email.complained", data: { email_id: "m1" } });
    expect(await emailHealth(getCatalogDb())).toEqual({
      ok: false,
      detail: "spam complaint rate at or over 0.1% in 30 days",
    });
  });
});
