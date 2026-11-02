// Billing emails the webhook sends (bundle S13, PiersAG/app-business-core):
//
//   • paymentReceiptTemplate   — after every successful charge (#788, Matt Murphy #231:
//                                "send the receipt").
//   • paymentFailedTemplate    — the three-email failed-payment sequence (#753, Matt
//                                Murphy #136: "your payment failed here's how to
//                                update your card"), one per Stripe payment attempt.
//   • disputeOpenedTemplate    — to the app's owner when a customer disputes a charge
//                                (#370), with the evidence deadline.
//
// Built with the `html` tag (./html.ts, issue 758): every value from Stripe or the
// customer is escaped as text, and the only links are the template's own, through
// `safeUrl` (http(s) only).

import type { EmailTemplate } from "@/lib/email/send";
import { html, safeUrl, type SafeHtml } from "@/lib/email/templates/html";
import { renderLayout } from "@/lib/email/templates/layout";

/** Currencies Stripe counts in whole units (no minor unit), per Stripe's list. */
const ZERO_DECIMAL = new Set([
  "bif",
  "clp",
  "djf",
  "gnf",
  "jpy",
  "kmf",
  "krw",
  "mga",
  "pyg",
  "rwf",
  "ugx",
  "vnd",
  "vuv",
  "xaf",
  "xof",
  "xpf",
]);

/** Stripe amount (minor units) + currency → "£12.00". Falls back to "12.00 XYZ". */
export function formatMoney(amount: number, currency: string): string {
  const code = currency.toLowerCase();
  const value = ZERO_DECIMAL.has(code) ? amount : amount / 100;
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: code.toUpperCase(),
    }).format(value);
  } catch {
    return `${value.toFixed(ZERO_DECIMAL.has(code) ? 0 : 2)} ${code.toUpperCase()}`;
  }
}

/** A date as "1 November 2026" (UTC, so the email reads the same everywhere). */
export function formatDay(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function button(url: string, label: string): SafeHtml {
  return html`<p style="margin:0 0 24px"><a href="${safeUrl(url)}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px">${label}</a></p>`;
}

// ── Receipt ──────────────────────────────────────────────────────────────────

export interface PaymentReceiptData {
  appName: string;
  amount: number;
  currency: string;
  paidAt: Date;
  /** Stripe's hosted invoice page (the formal invoice and receipt), when known. */
  invoiceUrl: string | null;
}

export const paymentReceiptTemplate: EmailTemplate<PaymentReceiptData> = {
  name: "payment-receipt",
  render({ appName, amount, currency, paidAt, invoiceUrl }) {
    const money = formatMoney(amount, currency);
    const day = formatDay(paidAt);
    const subject = `Receipt: ${money} paid to ${appName}`;
    const bodyHtml = html`
      <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3">Thank you — payment received</h1>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6">We received your payment of <strong>${money}</strong> for
        ${appName} on ${day}. Your subscription is active.</p>
      ${invoiceUrl ? button(invoiceUrl, "View your invoice") : null}
      <p style="margin:0;font-size:13px;line-height:1.6;color:#52525b">Keep this email for your records.</p>`;
    const text = [
      "Thank you — payment received",
      "",
      `We received your payment of ${money} for ${appName} on ${day}. Your subscription is active.`,
      ...(invoiceUrl ? ["", `Your invoice: ${invoiceUrl}`] : []),
      "",
      "Keep this email for your records.",
    ].join("\n");
    return {
      subject,
      html: renderLayout({ title: subject, bodyHtml, previewText: subject }),
      text,
    };
  },
};

// ── Failed payment: a sequence of three ──────────────────────────────────────

/** The sequence is three emails long (Matt Murphy #136); a fourth attempt sends nothing. */
export const DUNNING_EMAILS = 3;

export interface PaymentFailedData {
  appName: string;
  /** Which email of the sequence this is: 1, 2 or 3. */
  step: 1 | 2 | 3;
  amount: number;
  currency: string;
  /** Where the customer updates their card (the app's billing page). */
  updateCardUrl: string;
  /** Stripe's hosted page where this invoice can be paid now with any card. */
  payNowUrl: string | null;
  /** When Stripe will try the card again, if it will. */
  nextAttemptAt: Date | null;
}

const FAILED_SUBJECT: Record<1 | 2 | 3, string> = {
  1: "Your payment failed — please update your card",
  2: "Reminder: your payment is still outstanding",
  3: "Final notice: update your card to keep your account",
};

export const paymentFailedTemplate: EmailTemplate<PaymentFailedData> = {
  name: "payment-failed",
  render({
    appName,
    step,
    amount,
    currency,
    updateCardUrl,
    payNowUrl,
    nextAttemptAt,
  }) {
    const money = formatMoney(amount, currency);
    const subject = `${FAILED_SUBJECT[step]} (${appName})`;
    const retry = nextAttemptAt
      ? `We will try your card again on ${formatDay(nextAttemptAt)}.`
      : "We will not try your card again automatically.";
    const lead =
      step === 1
        ? `We couldn't take your payment of ${money} for ${appName}. This usually means the card has expired, been replaced, or the bank declined it.`
        : step === 2
          ? `Your payment of ${money} for ${appName} still hasn't gone through.`
          : `This is our last reminder: your payment of ${money} for ${appName} has failed again, and your access will be paused if it isn't paid.`;
    const bodyHtml = html`
      <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3">${FAILED_SUBJECT[step]}</h1>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6">${lead}</p>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6">Here's how to fix it: open your billing page and update your card. It takes a minute. ${retry}</p>
      ${button(updateCardUrl, "Update your card")}
      ${payNowUrl ? html`<p style="margin:0 0 16px;font-size:15px;line-height:1.6">Or <a href="${safeUrl(payNowUrl)}" style="color:#2563eb">pay this invoice now</a> with any card.</p>` : null}
      <p style="margin:0;font-size:13px;line-height:1.6;color:#52525b">If you've already updated your card, you can ignore this email.</p>`;
    const text = [
      FAILED_SUBJECT[step],
      "",
      lead,
      "",
      `Here's how to fix it: open your billing page and update your card. ${retry}`,
      updateCardUrl,
      ...(payNowUrl
        ? ["", `Or pay this invoice now with any card: ${payNowUrl}`]
        : []),
      "",
      "If you've already updated your card, you can ignore this email.",
    ].join("\n");
    return {
      subject,
      html: renderLayout({ title: subject, bodyHtml, previewText: lead }),
      text,
    };
  },
};

// ── Dispute opened (to the owner) ────────────────────────────────────────────

export interface DisputeOpenedData {
  appName: string;
  amount: number;
  currency: string;
  /** Stripe's reason code, e.g. "fraudulent", "product_not_received". */
  reason: string;
  /** Last day to send evidence; after it the dispute is lost by default. */
  evidenceDueBy: Date | null;
  disputeId: string;
  /** Disputes opened in the last 90 days, this one included. */
  disputes90d: number;
  /** Paid invoices in the same 90 days. */
  paidInvoices90d: number;
}

/** Card networks start monitoring a merchant near 0.75% disputes; warn at it. */
export const DISPUTE_RATE_WARNING = 0.0075;

export const disputeOpenedTemplate: EmailTemplate<DisputeOpenedData> = {
  name: "dispute-opened",
  render({
    appName,
    amount,
    currency,
    reason,
    evidenceDueBy,
    disputeId,
    disputes90d,
    paidInvoices90d,
  }) {
    const money = formatMoney(amount, currency);
    const due = evidenceDueBy
      ? formatDay(evidenceDueBy)
      : "the date shown in Stripe";
    const rate = paidInvoices90d > 0 ? disputes90d / paidInvoices90d : 1;
    const ratePct = `${(rate * 100).toFixed(2)}%`;
    const warn = rate >= DISPUTE_RATE_WARNING;
    const subject = `Action needed by ${due}: a customer disputed ${money} (${appName})`;
    const rateLine = `Disputes in the last 90 days: ${disputes90d} of ${paidInvoices90d} paid invoices (${ratePct}).${
      warn
        ? " That is at or above 0.75%, the level at which card networks start monitoring an account."
        : ""
    }`;
    const bodyHtml = html`
      <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3">A customer disputed a payment</h1>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6">A charge of <strong>${money}</strong> to ${appName} was disputed
        with the customer's bank (reason: ${reason}). The money has been held back
        until the dispute is decided.</p>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6"><strong>Send evidence or accept it by ${due}.</strong> After that the
        dispute is lost automatically. The steps are in the app's dispute runbook
        (docs/billing-disputes.md).</p>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6">${rateLine}</p>
      <p style="margin:0;font-size:13px;line-height:1.6;color:#52525b">Stripe dispute: ${disputeId}</p>`;
    const text = [
      "A customer disputed a payment",
      "",
      `A charge of ${money} to ${appName} was disputed with the customer's bank (reason: ${reason}). The money has been held back until the dispute is decided.`,
      "",
      `Send evidence or accept it by ${due}. After that the dispute is lost automatically. The steps are in the app's dispute runbook (docs/billing-disputes.md).`,
      "",
      rateLine,
      "",
      `Stripe dispute: ${disputeId}`,
    ].join("\n");
    return {
      subject,
      html: renderLayout({ title: subject, bodyHtml, previewText: subject }),
      text,
    };
  },
};
