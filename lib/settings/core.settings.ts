// CORE capability settings (settings-registry-spec §6 · CORE, always on).
//
// Core has no feature flag — these are always visible. Branding defaults are
// left empty here (the archetype/build fills them); the resolver still returns
// a defined value so the app runs with zero configuration.
//
// WHICH PLANE EACH KEY BELONGS TO (finding 1). Five of these six are OPERATOR
// keys: the app's name, its logo, its brand colour and its outbound-mail
// identity belong to whoever RUNS the service, not to any customer of it. One
// app is one brand. `core.app_name` settles the argument on its own — it is read
// by lib/branding.ts in the root layout's generateMetadata, on ANONYMOUS
// requests, where there is no session and therefore no tenant, so it could not
// live in a tenant database even if per-trainer white-labelling were wanted.
// Nothing renders `core.logo` or `core.brand_colour` today and per-customer
// white-labelling is not built; when it is, THOSE keys move to the tenant plane
// and this comment is the record of why they were not there first.
//
// `core.client_self_registration` is the one genuinely per-tenant key here: it
// governs whether a given trainer's clients may self-register. It stays on the
// tenant plane — inert for now, because the client portal does not exist yet.

import type { SettingDefinition } from "@/lib/settings/types";

export const coreSettings: SettingDefinition[] = [
  {
    key: "core.app_name",
    // OPERATOR key — see the plane note at the top of this file. Absent from
    // every settings screen and refused by every app write path; set with
    // `npx tsx scripts/set-operator-setting.ts core.app_name <value>`.
    operatorOnly: true,
    ownerEditable: false,
    capability: "core",
    functionalGroup: "Identity & access",
    label: "App name",
    description: "The name shown across the app and in outbound email.",
    valueType: "text",
    factoryDefault: "",
  },
  {
    key: "core.logo",
    // OPERATOR key — see the plane note at the top of this file. Absent from
    // every settings screen and refused by every app write path; set with
    // `npx tsx scripts/set-operator-setting.ts core.logo <value>`.
    operatorOnly: true,
    ownerEditable: false,
    capability: "core",
    functionalGroup: "Identity & access",
    label: "Logo",
    description: "URL of the owner's logo used in the app header and emails.",
    valueType: "text",
    factoryDefault: "",
  },
  {
    key: "core.brand_colour",
    // OPERATOR key — see the plane note at the top of this file. Absent from
    // every settings screen and refused by every app write path; set with
    // `npx tsx scripts/set-operator-setting.ts core.brand_colour <value>`.
    operatorOnly: true,
    ownerEditable: false,
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
    // OPERATOR key — see the plane note at the top of this file. Absent from
    // every settings screen and refused by every app write path; set with
    // `npx tsx scripts/set-operator-setting.ts core.email_from_name <value>`.
    operatorOnly: true,
    ownerEditable: false,
    capability: "core",
    functionalGroup: "Email identity",
    label: "Email sender name",
    description: "The sender name shown on all outbound mail. Defaults to the app name.",
    valueType: "text",
    factoryDefault: "",
  },
  {
    key: "core.email_reply_to",
    // OPERATOR key — see the plane note at the top of this file. Absent from
    // every settings screen and refused by every app write path; set with
    // `npx tsx scripts/set-operator-setting.ts core.email_reply_to <value>`.
    operatorOnly: true,
    ownerEditable: false,
    capability: "core",
    functionalGroup: "Email identity",
    label: "Email reply-to address",
    description: "Where client replies to outbound mail are delivered.",
    valueType: "text",
    factoryDefault: "",
  },
];
