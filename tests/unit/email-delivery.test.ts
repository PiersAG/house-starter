// @vitest-environment node
// Delivery monitoring (app-business-core issue 757): the provider's reports, the
// signature check, the 30-day rates and the verdict /api/health reports.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getCatalogDb, __resetCatalogCacheForTests } from "@/lib/catalog";
import { migrateCatalog } from "@/lib/migrate";
import {
  BOUNCE_MIN_SENT,
  deliveryStats,
  judgeDelivery,
  normaliseEvent,
  recordDeliveryEvent,
  type DeliveryStats,
} from "@/lib/email/delivery";
import { signPayload, signedHeaders, verifySignature } from "@/lib/email/webhook-signature";

const SECRET = `whsec_${Buffer.from("planted-test-signing-key-32-bytes!").toString("base64")}`;

describe("the provider's signature (Standard Webhooks)", () => {
  const body = JSON.stringify({ type: "email.delivered", data: { email_id: "m1" } });
  const now = 1_800_000_000;
  const good = { id: "evt_1", timestamp: String(now), signature: signPayload(SECRET, "evt_1", String(now), body) };

  it("passes a report signed with the secret", () => {
    expect(verifySignature(SECRET, good, body, now)).toEqual({ ok: true });
  });
  it("passes when one of several listed signatures matches (secret rotation)", () => {
    expect(verifySignature(SECRET, { ...good, signature: `v1,AAAA ${good.signature}` }, body, now).ok).toBe(true);
  });
  it("refuses a changed body, a wrong secret, missing headers and an old report", () => {
    expect(verifySignature(SECRET, good, body + " ", now)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySignature(`whsec_${Buffer.from("another").toString("base64")}`, good, body, now).ok).toBe(false);
    expect(verifySignature(SECRET, { ...good, signature: null }, body, now)).toEqual({ ok: false, reason: "missing-headers" });
    expect(verifySignature(SECRET, good, body, now + 301)).toEqual({ ok: false, reason: "stale" });
  });
  it("reads the headers under the webhook- and the svix- names", () => {
    const h = new Headers({ "svix-id": "a", "svix-timestamp": "1", "svix-signature": "v1,x" });
    expect(signedHeaders(h)).toEqual({ id: "a", timestamp: "1", signature: "v1,x" });
    const w = new Headers({ "webhook-id": "b", "webhook-timestamp": "2", "webhook-signature": "v1,y" });
    expect(signedHeaders(w)).toEqual({ id: "b", timestamp: "2", signature: "v1,y" });
  });
});

describe("a report, reduced to what is kept", () => {
  it("keeps the type, the message id and a bounce's kind — never the address or subject", () => {
    const e = normaliseEvent("evt_2", {
      type: "email.bounced",
      data: { email_id: "m2", to: ["someone@example.com"], subject: "Reset", bounce: { type: "Permanent" } },
    });
    expect(e).toEqual({ id: "evt_2", type: "bounced", messageId: "m2", bounceKind: "permanent" });
    expect(JSON.stringify(e)).not.toContain("someone@example.com");
  });
  it("files unknown types as other, and refuses what is not a report", () => {
    expect(normaliseEvent("e", { type: "email.opened", data: {} })?.type).toBe("other");
    expect(normaliseEvent("e", "nope")).toBeNull();
    expect(normaliseEvent("e", { data: {} })).toBeNull();
  });
});

describe("the 30-day counts", () => {
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "house-starter-email-delivery-"));
    process.env.CATALOG_DATABASE_URL = `file:${join(dir, "catalog.db")}`;
    __resetCatalogCacheForTests();
    await migrateCatalog(process.env.CATALOG_DATABASE_URL);
  });
  afterAll(() => {
    delete process.env.CATALOG_DATABASE_URL;
    __resetCatalogCacheForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it("counts each report once, however often the provider repeats it", async () => {
    const db = getCatalogDb();
    for (let i = 0; i < 10; i++) await recordDeliveryEvent(db, { id: `s${i}`, type: "sent", messageId: `m${i}`, bounceKind: null });
    for (let i = 0; i < 9; i++) await recordDeliveryEvent(db, { id: `d${i}`, type: "delivered", messageId: `m${i}`, bounceKind: null });
    const bounce = { id: "b1", type: "bounced" as const, messageId: "m9", bounceKind: "permanent" as const };
    await recordDeliveryEvent(db, bounce);
    await recordDeliveryEvent(db, bounce); // the provider's retry
    const stats = await deliveryStats(db, Date.now() - 86_400_000);
    expect(stats).toMatchObject({ sent: 10, delivered: 9, bounced: 1, complained: 0, bounceRate: 0.1, complaintRate: 0 });
  });
});

describe("the verdict /api/health reports", () => {
  const setup = { domainOk: true, domainDetail: "", monitoringOn: true };
  const stats = (o: Partial<DeliveryStats>): DeliveryStats => ({
    sent: 0, delivered: 0, bounced: 0, complained: 0, bounceRate: null, complaintRate: null, ...o,
  });

  it("is red when the sending domain is wrong or the reports are not set up", () => {
    expect(judgeDelivery({ ...setup, domainOk: false, domainDetail: "EMAIL_FROM is not set or has no address" }, stats({})))
      .toEqual({ ok: false, detail: "EMAIL_FROM is not set or has no address" });
    expect(judgeDelivery({ ...setup, monitoringOn: false }, stats({})).ok).toBe(false);
  });
  it("is red on one spam complaint at launch volumes (the 0.1% line)", () => {
    expect(judgeDelivery(setup, stats({ sent: 40, delivered: 40, complained: 1, complaintRate: 1 / 40 })).ok).toBe(false);
    expect(judgeDelivery(setup, stats({ sent: 2000, delivered: 2000, complained: 1, complaintRate: 1 / 2000 })).ok).toBe(true);
  });
  it("is red at a 4% bounce rate once enough mail has gone, not on one early bounce", () => {
    expect(judgeDelivery(setup, stats({ sent: 5, bounced: 1, bounceRate: 0.2 })).ok).toBe(true);
    expect(judgeDelivery(setup, stats({ sent: BOUNCE_MIN_SENT, bounced: 2, bounceRate: 2 / BOUNCE_MIN_SENT })).ok).toBe(false);
    expect(judgeDelivery(setup, stats({ sent: 100, bounced: 3, bounceRate: 0.03 })).ok).toBe(true);
  });
  it("is green when counts cannot be read — a failed read is not a finding", () => {
    expect(judgeDelivery(setup, null).ok).toBe(true);
  });
});
