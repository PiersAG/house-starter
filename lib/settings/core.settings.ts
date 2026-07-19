// CORE capability settings (settings-registry-spec §6 · CORE, always on).
//
// Core has no feature flag — these are always visible. Branding defaults are
// left empty here (the archetype/build fills them); the resolver still returns
// a defined value so the app runs with zero configuration.

import type { SettingDefinition } from "@/lib/settings/types";

export const coreSettings: SettingDefinition[] = [
  {
    key: "core.app_name",
    capability: "core",
    functionalGroup: "Identity & access",
    label: "App name",
    description: "The name shown across the app and in outbound email.",
    valueType: "text",
    factoryDefault: "",
  },
  {
    key: "core.logo",
    capability: "core",
    functionalGroup: "Identity & access",
    label: "Logo",
    description: "URL of the owner's logo used in the app header and emails.",
    valueType: "text",
    factoryDefault: "",
  },
  {
    key: "core.brand_colour",
    capability: "core",
    functionalGroup: "Identity & access",
    label: "Brand colour",
    description: "Primary brand colour (hex) applied to the app theme.",
    valueType: "text",
    factoryDefault: "",
  },
  {
    key: "core.client_self_registration",
    capability: "core",
    functionalGroup: "Identity & access",
    label: "Client self-registration",
    description:
      "Whether clients can create their own accounts, or are invited by the owner only.",
    valueType: "boolean",
    factoryDefault: false,
  },
  {
    key: "core.email_from_name",
    capability: "core",
    functionalGroup: "Email identity",
    label: "Email sender name",
    description: "The sender name shown on all outbound mail. Defaults to the app name.",
    valueType: "text",
    factoryDefault: "",
  },
  {
    key: "core.email_reply_to",
    capability: "core",
    functionalGroup: "Email identity",
    label: "Email reply-to address",
    description: "Where client replies to outbound mail are delivered.",
    valueType: "text",
    factoryDefault: "",
  },
];
