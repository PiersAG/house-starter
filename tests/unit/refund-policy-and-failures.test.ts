// #354: the refund policy says what the factory policy says, and checkout links
// it before payment. #373: a failed Stripe call answers a plain message and a
// support reference, never the raw error, and logs the error.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { refundPolicy, refundPolicyParagraphs } from "@/config/refund-policy";

const recorded: unknown[] = [];
vi.mock("@/lib/observability/error-log", () => ({
  recordError: async (input: unknown) => {
    recorded.push(input);
    return true;
  },
}));

describe("#354 refund policy", () => {
  const text = refundPolicyParagraphs().join("\n");
  it("covers cancelling, the trial, the 14-day first-payment refund and mistaken charges", () => {
    expect(refundPolicy.firstPaymentRefundDays).toBe(14);
    expect(text).toMatch(/cancel your subscription at any time/);
    expect(text).toMatch(
      /free trial, you are not charged until the trial ends/,
    );
    expect(text).toMatch(
      /within 14 days of your first payment, we refund that payment in full/,
    );
    expect(text).toMatch(/charged you by mistake/);
    expect(text).toMatch(/contact us before disputing it with your bank/);
  });
  it("the checkout route puts the policy link on the payment page", () => {
    const src = readFileSync(
      join(process.cwd(), "app/api/billing/checkout/route.ts"),
      "utf8",
    );
    expect(src).toMatch(
      /custom_text:\s*{\s*submit:\s*{\s*message:\s*`[^`]*\$\{origin\}\/refund-policy`/,
    );
  });
  it("the Supporter's refund reply matches the policy's numbers", () => {
    const macro = readFileSync(
      join(process.cwd(), "docs/support/refund-macro.md"),
      "utf8",
    );
    expect(macro.toLowerCase()).toContain(
      `within ${refundPolicy.firstPaymentRefundDays} days of their first payment`,
    );
    expect(macro).toContain("5 to 10 working days");
  });
});

describe("#373 an outside service failing", () => {
  it("answers a plain message and a reference, and logs the error under it", async () => {
    const { serviceFailure } =
      await import("@/lib/observability/service-failure");
    const res = await serviceFailure(
      new Error("Invalid API Key provided: sk_test_****abcd"),
      {
        route: "/api/billing/checkout",
        message: "We couldn't start checkout. Please try again in a minute.",
      },
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; reference: string };
    expect(body.error).toBe(
      "We couldn't start checkout. Please try again in a minute.",
    );
    expect(body.reference).toMatch(/^ref-[0-9a-f]{8}$/);
    expect(JSON.stringify(body)).not.toMatch(/Invalid API Key|sk_test/);
    expect(recorded.at(-1)).toMatchObject({
      route: "/api/billing/checkout",
      digest: body.reference,
    });
  });
  it("checkout and portal both answer through it", () => {
    for (const f of [
      "app/api/billing/checkout/route.ts",
      "app/api/billing/portal/route.ts",
    ]) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      expect(src).toContain("catch (err)");
      expect(src).toContain("serviceFailure(err");
    }
  });
});
