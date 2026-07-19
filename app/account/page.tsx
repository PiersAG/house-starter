// Client account view — GENERATED from the registry, filtered to client-scoped
// settings (settings-registry-spec §5). A client manages only their own
// preferences here (e.g. notification channels); the value is stored at client
// scope and wins over the owner value for this client. While no client-scoped
// capability is enabled (comms is flag-off by default) this view is empty by
// design, not broken.

import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { buildClientSettingsView } from "@/lib/settings/service";
import { EmptyState } from "@/components/ui/EmptyState";
import { SettingControl } from "@/app/dashboard/settings/SettingControl";

export const metadata = { title: "Your preferences" };

export default async function AccountPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const view = await buildClientSettingsView(db, session.user.id);
  const isEmpty = view.length === 0;

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col p-4 sm:p-6">
      <header className="border-b border-border pb-4">
        <h1 className="text-xl font-semibold text-text-primary">Your preferences</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Preferences that apply to your account.
        </p>
      </header>

      {isEmpty ? (
        <div className="mt-8">
          <EmptyState
            title="No preferences yet"
            description="Preference options will appear here as features that use them are switched on."
          />
        </div>
      ) : (
        view.map((cap) => (
          <section key={cap.capability} className="mt-8" aria-label={cap.capability}>
            {cap.groups.map((grp) => (
              <div key={grp.functionalGroup} className="mt-4">
                <h3 className="text-sm font-medium uppercase tracking-wide text-text-secondary">
                  {grp.functionalGroup}
                </h3>
                <div className="mt-1">
                  {grp.settings.map((setting) => (
                    <SettingControl key={setting.key} setting={setting} scope="client" />
                  ))}
                </div>
              </div>
            ))}
          </section>
        ))
      )}
    </main>
  );
}
