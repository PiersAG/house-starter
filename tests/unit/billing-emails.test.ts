// Bundle S13 billing emails (PiersAG/app-business-core #788, #753, #370): what
// each says, and that customer- and Stripe-supplied text is escaped.

import { describe, expect, it } from "vitest";
import {
  DISPUTE_RATE_WARNING,
  DUNNING_EMAILS,
  disputeOpenedTemplate,
  formatDay,
  formatMoney,
  paymentFailedTemplate,
  paymentReceiptTemplate,
} from "@/lib/email/templates/billing";

describe("money and dates", () => {
  it("formats minor units, and zero-decimal currencies as whole units", () => {
    expect(formatMoney(1500, "gbp")).toBe("£15.00");
    expect(formatMoney(999, "usd")).toBe("US$9.99");
    expect(formatMoney(1500, "jpy")).toBe("JP¥1,500");
  });
  it("falls back for a code Intl does not know", () => {
    expect(formatMoney(1500, "zzzz")).toBe("15.00 ZZZZ");
  });
  it("writes the day in words, in UTC", () => {
    expect(formatDay(new Date("2026-11-01T23:30:00Z"))).toBe("1 November 2026");
  });
});

describe("#788 receipt", () => {
  const base = {
    appName: "Pawsome",
    amount: 2500,
    currency: "gbp",
    paidAt: new Date("2026-11-01T10:00:00Z"),
  };
  it("says what was paid, when, and links the invoice", () => {
    const r = paymentReceiptTemplate.render({
      ...base,
      invoiceUrl: "https://invoice.stripe.com/i/1",
    });
    expect(r.subject).toBe("Receipt: £25.00 paid to Pawsome");
    expect(r.text).toContain("1 November 2026");
    expect(r.html).toContain('href="https://invoice.stripe.com/i/1"');
  });
  it("leaves the invoice link out when Stripe gave none", () => {
    expect(
      paymentReceiptTemplate.render({ ...base, invoiceUrl: null }).html,
    ).not.toContain("View your invoice");
  });
});

describe("#753 failed-payment sequence", () => {
  const data = {
    appName: "Pawsome",
    amount: 1500,
    currency: "gbp",
    updateCardUrl: "https://app.example.com/reactivate",
    payNowUrl: "https://invoice.stripe.com/i/f",
    nextAttemptAt: new Date("2026-11-04T00:00:00Z"),
  };
  it("is three emails long", () => {
    expect(DUNNING_EMAILS).toBe(3);
  });
  it("each email says the payment failed and how to update the card", () => {
    for (const step of [1, 2, 3] as const) {
      const r = paymentFailedTemplate.render({ ...data, step });
      expect(r.text).toMatch(/update your card/i);
      expect(r.html).toContain('href="https://app.example.com/reactivate"');
      expect(r.text).toContain("https://invoice.stripe.com/i/f");
    }
    expect(paymentFailedTemplate.render({ ...data, step: 1 }).subject).toMatch(
      /^Your payment failed/,
    );
    expect(paymentFailedTemplate.render({ ...data, step: 3 }).subject).toMatch(
      /^Final notice/,
    );
  });
  it("says when the card is tried again, or that it will not be", () => {
    expect(paymentFailedTemplate.render({ ...data, step: 1 }).text).toContain(
      "4 November 2026",
    );
    expect(
      paymentFailedTemplate.render({ ...data, step: 1, nextAttemptAt: null })
        .text,
    ).toContain("We will not try your card again automatically.");
  });
});

describe("#370 dispute alert to the owner", () => {
  const data = {
    appName: "Pawsome",
    amount: 1500,
    currency: "gbp",
    reason: "fraudulent",
    evidenceDueBy: new Date("2026-11-08T00:00:00Z"),
    disputeId: "dp_1",
    disputes90d: 1,
    paidInvoices90d: 400,
  };
  it("leads with the deadline", () => {
    const r = disputeOpenedTemplate.render(data);
    expect(r.subject).toBe(
      "Action needed by 8 November 2026: a customer disputed £15.00 (Pawsome)",
    );
    expect(r.text).toContain("docs/billing-disputes.md");
  });
  it("warns at the 0.75% monitoring level, not below it", () => {
    expect(DISPUTE_RATE_WARNING).toBe(0.0075);
    expect(disputeOpenedTemplate.render(data).text).not.toContain(
      "start monitoring",
    );
    expect(
      disputeOpenedTemplate.render({ ...data, paidInvoices90d: 100 }).text,
    ).toContain("start monitoring");
  });
});

describe("escaping", () => {
  it("escapes text from Stripe or the customer in every billing email", () => {
    const evil = '<script>alert("x")</script>';
    const d = disputeOpenedTemplate.render({
      appName: evil,
      amount: 1,
      currency: "gbp",
      reason: evil,
      evidenceDueBy: null,
      disputeId: evil,
      disputes90d: 1,
      paidInvoices90d: 0,
    });
    const r = paymentReceiptTemplate.render({
      appName: evil,
      amount: 1,
      currency: "gbp",
      paidAt: new Date(),
      invoiceUrl: '"><img src=x>',
    });
    for (const html of [d.html, r.html]) {
      expect(html).not.toContain("<script>");
      expect(html).not.toContain('"><img');
    }
  });
});
