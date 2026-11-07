// Sign-in and security (app-business-core issues 506, 519, 377; Matt Murphy steps
// 133, 52 and 89): the devices signed in to this account, with a sign-out for
// each; two-step sign-in; change the password; sign out of every device. See
// lib/account-security.ts and lib/session/records.ts for what "every" means and
// how fast (config/sessions.ts SESSION_POLICY).

import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { catalogDb } from "@/lib/catalog";
import { SESSION_POLICY } from "@/config/sessions";
import { activeSessions } from "@/lib/session/records";
import { isMfaActive } from "@/lib/mfa/enrollment";
import { csrfTokenFor } from "@/lib/csrf";
import { ChangePasswordForm } from "./ChangePasswordForm";
import { TwoStepSetup } from "./TwoStepSetup";
import { endDeviceAction, signOutEverywhereAction } from "./actions";

export const metadata = { title: "Sign-in and security" };

const WHEN = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

export default async function AccountSecurityPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login?callbackUrl=%2Faccount%2Fsecurity");
  const userId = session.user.id;
  const [devices, twoStepActive] = await Promise.all([
    activeSessions(catalogDb, userId),
    isMfaActive(catalogDb, userId),
  ]);
  const twoStepRequired = session.user.mfa === "enroll_required";
  const csrfToken = csrfTokenFor(session) ?? "";
  const otherDevicesEnd = SESSION_POLICY === "strict" ? "at once" : "within 10 minutes";

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col p-4 sm:p-6">
      <header className="border-b border-border pb-4">
        <h1 className="text-xl font-semibold text-text-primary">Sign-in and security</h1>
        <p className="mt-1 text-sm text-text-secondary">
          See where you are signed in, turn on two-step sign-in, change your
          password, or sign out everywhere if you think someone else has used your
          account.
        </p>
      </header>

      <section className="mt-8" aria-labelledby="two-step-heading" id="two-step">
        <h2 id="two-step-heading" className="text-lg font-semibold text-text-primary">
          Two-step sign-in
        </h2>
        <div className="mt-4">
          <TwoStepSetup active={twoStepActive} required={twoStepRequired} csrfToken={csrfToken} />
        </div>
      </section>

      <section className="mt-10" aria-labelledby="devices">
        <h2 id="devices" className="text-lg font-semibold text-text-primary">
          Where you are signed in
        </h2>
        <p className="mt-1 text-sm text-text-secondary">
          A device you sign out here is signed out {otherDevicesEnd}.
        </p>
        <ul className="mt-4 divide-y divide-border rounded border border-border">
          {devices.map((d) => {
            const current = d.id === session.user.sessionId;
            return (
              <li key={d.id} className="flex items-center justify-between gap-4 p-3">
                <div className="text-sm">
                  <p className="font-medium text-text-primary">
                    {d.deviceLabel ?? "Unknown browser"}
                    {current ? " — this device" : ""}
                  </p>
                  <p className="text-text-secondary">
                    {d.country ? `${d.country} · ` : ""}last used {WHEN.format(d.lastSeenAt)} UTC
                  </p>
                </div>
                {current ? null : (
                  <form action={endDeviceAction}>
                    <input type="hidden" name="sessionId" value={d.id} />
                    <button
                      type="submit"
                      className="min-h-11 rounded border border-border px-3 py-2 text-sm font-medium text-text-primary hover:bg-surface"
                    >
                      Sign out
                    </button>
                  </form>
                )}
              </li>
            );
          })}
          {devices.length === 0 ? (
            <li className="p-3 text-sm text-text-secondary">No signed-in devices are recorded yet.</li>
          ) : null}
        </ul>
      </section>

      <section className="mt-10" aria-labelledby="change-password">
        <h2 id="change-password" className="text-lg font-semibold text-text-primary">
          Change password
        </h2>
        <div className="mt-4">
          <ChangePasswordForm />
        </div>
      </section>

      <section className="mt-10" aria-labelledby="sign-out-everywhere">
        <h2 id="sign-out-everywhere" className="text-lg font-semibold text-text-primary">
          Sign out of all devices
        </h2>
        <p className="mt-1 text-sm text-text-secondary">
          Ends your session on every phone, tablet and computer, this one
          included. Other devices are signed out {otherDevicesEnd}.
        </p>
        <form action={signOutEverywhereAction} className="mt-4">
          <button
            type="submit"
            className="min-h-11 rounded border border-border px-4 py-2 font-medium text-text-primary hover:bg-surface"
          >
            Sign out of all devices
          </button>
        </form>
      </section>
    </main>
  );
}
