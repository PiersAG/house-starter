// Owner settings — GENERATED from the registry (settings-registry-spec §5).
// Grouped capability → functional group, showing label, plain-English
// description, current effective value and whether it is factory-locked. There
// is no hand-built per-capability settings screen; adding a setting is a
// registry row, and it appears here automatically.

import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { buildOwnerSettingsView } from "@/lib/settings/service";
import { AppNav } from "@/components/AppNav";
import { SettingControl } from "./SettingControl";

export const metadata = { title: "Settings" };

const CAPABILITY_LABEL: Record<string, string> = {
  core: "Core",
  billing: "Billing & payments",
  booking: "Booking",
  comms: "Communications",
};

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const view = await buildOwnerSettingsView(db);

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col p-4 sm:p-6">
      <header className="border-b border-border pb-4">
        <h1 className="text-xl font-semibold text-text-primary">Settings</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Every configurable behaviour, in one place. Changes take effect
          immediately — no deploy.
        </p>
      </header>

      <AppNav />

      {view.map((cap) => (
        <section key={cap.capability} className="mt-8" aria-label={cap.capability}>
          <h2 className="text-lg font-semibold text-text-primary">
            {CAPABILITY_LABEL[cap.capability] ?? cap.capability}
          </h2>
          {cap.groups.map((grp) => (
            <div key={grp.functionalGroup} className="mt-4">
              <h3 className="text-sm font-medium uppercase tracking-wide text-text-secondary">
                {grp.functionalGroup}
              </h3>
              <div className="mt-1">
                {grp.settings.map((setting) => (
                  <SettingControl key={setting.key} setting={setting} scope="owner" />
                ))}
              </div>
            </div>
          ))}
        </section>
      ))}
    </main>
  );
}
