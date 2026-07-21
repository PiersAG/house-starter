// BILLING settings (settings-registry-spec §6 · BILLING). These definitions
// span TWO switches, by design (capability-model-spec §2):
//
//   • CLIENT PAYMENTS — flag `payments` (CAPABILITY, off until built): payment
//     methods, currency, invoice notes, the payments-due board and payment
//     requests. The client→owner money flow. Not built yet, so these stay
//     hidden from the Settings UI while `payments` is off.
//   • SUBSCRIPTION BILLING — flag `subscription_billing` (KERNEL, always on):
//     `billing.subscription_grace_days`, the owner→factory subscription's
//     failed-payment grace window. It is read live by the paid-gate
//     (lib/billing/gate.ts) via getSetting, so it must resolve regardless of
//     the client-payments capability. Kernel, not capability — see config/kernel.ts.
//
// Grouping both under the "billing" capability keeps the Settings UI section
// coherent; the per-definition `requiresFlag` is what actually governs
// visibility, not the capability label.

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
    // KERNEL, not `payments`: this is the owner→factory subscription's grace
    // window, read live by the paid-gate. It stays resolvable even when the
    // client-payments capability is off. See config/kernel.ts.
    requiresFlag: "subscription_billing",
  },
  {
    // Step 6: the auto-trial length. On signup a trial subscription is created
    // for this many days (lib/billing/trial.ts) so a new owner is not instantly
    // paywalled. Owner-configurable (unlike the grace window) — hence no
    // ownerEditable:false. Read via getSetting — no literal in the trial code.
    key: "billing.trial_period_days",
    capability: "billing",
    functionalGroup: "Subscription access",
    label: "Free trial length (days)",
    description:
      "How many days a newly registered owner can use the app before a subscription is required. Applied when their account is created.",
    valueType: "integer",
    factoryDefault: 14,
    bounds: { min: 0, max: 365 },
    // KERNEL (subscription_billing) so it always resolves, like the grace window.
    requiresFlag: "subscription_billing",
  },
];
