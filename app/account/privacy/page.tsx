// Your data (app-business-core issues 722, 351, 745; Matt Murphy step 288: "add a
// delete my data button to the app"; step 156; step 203). Download everything the app
// holds about the account, and delete the account. What each does, and where
// deletion reaches, is read from the personal-data map, so the page says what
// the code does.
//
// Part of the account kernel (`auth`): absent (404) when it is off.

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isKernelEnabled } from "@/config/kernel";
import { auth } from "@/lib/auth";
import { DELETION_GRACE_DAYS, OUTSIDE_LOCATIONS } from "@/config/personal-data";
import { DeleteMyAccount, DownloadMyData } from "./PrivacyActions";

export const metadata = { title: "Your data" };

export default async function AccountPrivacyPage() {
  if (!isKernelEnabled("auth")) notFound();
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col p-4 sm:p-6">
      <header className="border-b border-border pb-4">
        <h1 className="text-xl font-semibold text-text-primary">Your data</h1>
        <p className="mt-1 text-sm text-text-secondary">
          See everything this app holds about you, or delete your account. The{" "}
          <Link href="/privacy" className="font-medium text-link underline">
            privacy policy
          </Link>{" "}
          explains what is collected and why.
        </p>
      </header>

      <section className="mt-8" aria-labelledby="download-data">
        <h2 id="download-data" className="text-lg font-semibold text-text-primary">
          Download your data
        </h2>
        <p className="mt-1 text-sm text-text-secondary">
          One file with everything the app holds about your account, including your own records.
          Passwords and security keys are never included.
        </p>
        <div className="mt-4">
          <DownloadMyData />
        </div>
      </section>

      <section className="mt-10" aria-labelledby="delete-account">
        <h2 id="delete-account" className="text-lg font-semibold text-text-primary">
          Delete your account
        </h2>
        <p className="mt-1 text-sm text-text-secondary">
          Your account closes straight away: you are signed out everywhere and nobody can sign in
          to it. We keep its data for {DELETION_GRACE_DAYS} days in case this was a mistake, then
          delete it automatically and email you to confirm. If you have a paid subscription, cancel
          it on the billing page first.
        </p>
        <p className="mt-2 text-sm text-text-secondary">Deletion reaches:</p>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-text-secondary">
          <li>your account and everything in your own database;</li>
          {OUTSIDE_LOCATIONS.map((l) => (
            <li key={l.id}>
              {l.name}: {l.deletion}
            </li>
          ))}
        </ul>
        <div className="mt-4">
          <DeleteMyAccount />
        </div>
      </section>
    </main>
  );
}
