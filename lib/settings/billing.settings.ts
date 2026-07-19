// BILLING capability settings (settings-registry-spec §6 · BILLING, flag:
// `payments`). Registered here now; the billing code is wired to the resolver
// in a later dispatch (WP1 of the billing gap-fill spec) — this dispatch only
// seeds the definitions and generates their UI. Do not read these keys from
// billing code yet.

import type { SettingDefinition } from "@/lib/settings/types";

export const billingSettings: SettingDefinition[] = [
  {
    key: "billing.payment_methods",
    capability: "billing",
    functionalGroup: "Payment collection",
    label: "Payment methods",
    description:
      "Which Checkout methods are offered to clients: card, Apple Pay, Google Pay, Bacs Direct Debit.",
    valueType: "json",
    factoryDefault: ["card", "apple_pay", "google_pay"],
    requiresFlag: "payments",
  },
  {
    key: "billing.currency",
    capability: "billing",
    functionalGroup: "Payment collection",
    label: "Currency",
    description: "The currency clients are charged in.",
    valueType: "enum",
    enumValues: ["GBP", "USD", "EUR"],
    factoryDefault: "GBP",
    requiresFlag: "payments",
  },
  {
    key: "billing.invoice_notes",
    capability: "billing",
    functionalGroup: "Payment collection",
    label: "Invoice footer notes",
    description: "Footer text shown on receipts and invoices.",
    valueType: "text",
    factoryDefault: "",
    requiresFlag: "payments",
  },
  {
    key: "billing.overdue_display_days",
    capability: "billing",
    functionalGroup: "Payments-due behaviour",
    label: "Overdue threshold (days)",
    description:
      "Days after which an unpaid item is flagged overdue in the payments-due view.",
    valueType: "integer",
    factoryDefault: 7,
    bounds: { min: 0, max: 365 },
    requiresFlag: "payments",
  },
  {
    key: "billing.payment_requests_enabled",
    capability: "billing",
    functionalGroup: "Payments-due behaviour",
    label: "Payment requests",
    description:
      "Whether the owner can send a payment link for an existing due item. Sending is always a manual owner act.",
    valueType: "boolean",
    factoryDefault: true,
    requiresFlag: "payments",
  },
  {
    // WP1 (billing-gap-fill-spec §WP1.1): the failed-payment grace window. Read
    // by the paid-gate (lib/billing/gate.ts) via getSetting — no literal in the
    // gate. Factory policy, so owner_editable is false.
    key: "billing.subscription_grace_days",
    capability: "billing",
    functionalGroup: "Subscription access",
    label: "Failed-payment grace period (days)",
    description:
      "How many days a subscription keeps access after a payment fails (status past_due) before the paid gate blocks it. Factory policy — not owner-editable.",
    valueType: "integer",
    factoryDefault: 7,
    bounds: { min: 0, max: 90 },
    ownerEditable: false,
    requiresFlag: "payments",
  },
];
