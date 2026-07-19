// COMMS capability settings (settings-registry-spec §6 · COMMS, flag: `comms`).
// Registered now, HIDDEN behind the `comms` flag — the comms spec is still to
// follow. Reserved here so booking/billing can register events against these
// keys, and so notification preferences (client-scoped) have a stable home.

import type { SettingDefinition } from "@/lib/settings/types";

export const commsSettings: SettingDefinition[] = [
  {
    key: "comms.direct_messaging_enabled",
    capability: "comms",
    functionalGroup: "Messaging",
    label: "Direct messaging",
    description: "Whether owner↔client in-app messaging is switched on.",
    valueType: "boolean",
    factoryDefault: true,
    requiresFlag: "comms",
  },
  {
    key: "comms.client_can_initiate",
    capability: "comms",
    functionalGroup: "Messaging",
    label: "Clients can start threads",
    description: "Whether clients may start a message thread, or only reply to the owner.",
    valueType: "boolean",
    factoryDefault: true,
    requiresFlag: "comms",
  },
  {
    key: "comms.notify_channels",
    capability: "comms",
    functionalGroup: "Notifications",
    label: "Notification channels",
    description: "Which channels (in-app, email) are used per event class. A client preference.",
    valueType: "json",
    factoryDefault: ["in_app", "email"],
    clientScoped: true,
    requiresFlag: "comms",
  },
  {
    key: "comms.booking_confirmations",
    capability: "comms",
    functionalGroup: "Notifications",
    label: "Booking confirmations",
    description:
      "Booking and cancellation confirmations always send. Factory-locked. (Decided policy 6.)",
    valueType: "boolean",
    factoryDefault: true,
    ownerEditable: false,
    requiresFlag: "comms",
  },
  {
    key: "comms.reminders_enabled",
    capability: "comms",
    functionalGroup: "Notifications",
    label: "Reminders",
    description: "Opt-in reminders. Off by default; a client preference. (Post-v0.)",
    valueType: "boolean",
    factoryDefault: false,
    clientScoped: true,
    requiresFlag: "comms",
  },
  {
    key: "comms.quiet_hours",
    capability: "comms",
    functionalGroup: "Notifications",
    label: "Quiet hours",
    description:
      "A window in which non-critical notifications are suppressed. A client preference; none by default.",
    valueType: "json",
    factoryDefault: null,
    clientScoped: true,
    requiresFlag: "comms",
  },
];
