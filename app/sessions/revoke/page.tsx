// Opened from the new sign-in email (app-business-core issue 519). Nothing is
// signed out until the person presses the button: a mail scanner that opens the
// link changes nothing.

import { RevokeForm } from "./RevokeForm";

export const metadata = { title: "Sign a device out" };

export default async function RevokeSessionPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = (await searchParams) ?? {};
  const token = typeof params.t === "string" ? params.t.slice(0, 256) : "";
  return (
    <main className="flex min-h-screen items-center justify-center p-4 sm:p-6">
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-6 shadow-sm sm:p-8">
        <h1 className="mb-4 text-2xl font-semibold text-text-primary">Sign a device out</h1>
        <p className="mb-6 text-sm text-text-secondary">
          If you did not sign in from the device in the email, sign it out here.
        </p>
        <RevokeForm token={token} />
      </div>
    </main>
  );
}
