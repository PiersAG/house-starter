// BOOKING capability settings (settings-registry-spec §6 · BOOKING, flag:
// `booking`). Registered now, HIDDEN behind the `booking` flag because the
// booking capability is not built yet (see wiki/specs/booking-requirement-spec).
// Defaults encode the CEO's decided policies 1–7 (18 Jul 2026).

import type { SettingDefinition } from "@/lib/settings/types";

export const bookingSettings: SettingDefinition[] = [
  {
    key: "booking.access",
    capability: "booking",
    functionalGroup: "Access",
    label: "Who can book",
    description:
      "Whether the booking page is gated to existing clients or open publicly. (Decided policy 1.)",
    valueType: "enum",
    enumValues: ["gated", "public"],
    factoryDefault: "gated",
    requiresFlag: "booking",
  },
  {
    key: "booking.default_buffer_before_min",
    capability: "booking",
    functionalGroup: "Availability & slots",
    label: "Default buffer before (minutes)",
    description: "App-level default gap before a booking, overridable per availability rule.",
    valueType: "integer",
    factoryDefault: 0,
    bounds: { min: 0, max: 240 },
    requiresFlag: "booking",
  },
  {
    key: "booking.default_buffer_after_min",
    capability: "booking",
    functionalGroup: "Availability & slots",
    label: "Default buffer after (minutes)",
    description: "App-level default gap after a booking, overridable per availability rule.",
    valueType: "integer",
    factoryDefault: 0,
    bounds: { min: 0, max: 240 },
    requiresFlag: "booking",
  },
  {
    key: "booking.min_notice_hours",
    capability: "booking",
    functionalGroup: "Availability & slots",
    label: "Minimum notice (hours)",
    description: "How close to now a slot may still be booked.",
    valueType: "integer",
    factoryDefault: 12,
    bounds: { min: 0, max: 720 },
    requiresFlag: "booking",
  },
  {
    key: "booking.max_advance_days",
    capability: "booking",
    functionalGroup: "Availability & slots",
    label: "Maximum advance (days)",
    description: "How far ahead clients can book.",
    valueType: "integer",
    factoryDefault: 60,
    bounds: { min: 1, max: 730 },
    requiresFlag: "booking",
  },
  {
    key: "booking.hold_minutes",
    capability: "booking",
    functionalGroup: "Holds & payment",
    label: "Unpaid-hold window (minutes)",
    description: "How long a picked slot is held while the client pays. (Decided.)",
    valueType: "integer",
    factoryDefault: 60,
    bounds: { min: 30, max: 1440 },
    requiresFlag: "booking",
  },
  {
    key: "booking.approval_hold_hours",
    capability: "booking",
    functionalGroup: "Holds & payment",
    label: "Approval payment window (hours)",
    description:
      "Payment window after a request-only booking is approved, before the slot is released. (Decided policy 4.)",
    valueType: "integer",
    factoryDefault: 24,
    bounds: { min: 1, max: 168 },
    requiresFlag: "booking",
  },
  {
    key: "booking.cancellation_cutoff_hours",
    capability: "booking",
    functionalGroup: "Cancellations & refunds",
    label: "Cancellation cutoff (hours)",
    description:
      "The full-refund boundary: cancel outside this window for a full refund, inside for none. (Decided policy 2.)",
    valueType: "integer",
    factoryDefault: 24,
    bounds: { min: 0, max: 336 },
    requiresFlag: "booking",
  },
  {
    key: "booking.reschedule_allowed",
    capability: "booking",
    functionalGroup: "Cancellations & refunds",
    label: "Client self-reschedule",
    description:
      "Whether clients may reschedule themselves outside the cancellation cutoff. (Decided policy 3.)",
    valueType: "boolean",
    factoryDefault: true,
    requiresFlag: "booking",
  },
  {
    key: "booking.class_cancel_bulk_refund",
    capability: "booking",
    functionalGroup: "Classes",
    label: "Class-cancel bulk refund",
    description:
      "When an owner cancels a class session, all paid seats are automatically refunded. Factory-locked. (Decided policy 7.)",
    valueType: "boolean",
    factoryDefault: true,
    ownerEditable: false,
    requiresFlag: "booking",
  },
];
