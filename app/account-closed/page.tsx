// Where a deleted account lands after it is signed out (app-business-core issue
// 722). Public: the account no longer has a session.

import Link from "next/link";
import { DELETION_GRACE_DAYS } from "@/config/personal-data";

export const metadata = { title: "Account closed" };

export default function AccountClosedPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10 sm:px-6 sm:py-16">
      <h1 className="text-2xl font-semibold text-text-primary">Your account is closed</h1>
      <p className="mt-4 text-text-secondary">
        You have been signed out on every device and nobody can sign in to the account. Its data
        is deleted automatically in {DELETION_GRACE_DAYS} days, and we email you when that is done.
      </p>
      <p className="mt-4 text-text-secondary">
        If this was a mistake, contact us before then from the email address on the account.
      </p>
      <p className="mt-8">
        <Link href="/contact" className="font-medium text-primary hover:underline">
          Contact us
        </Link>
      </p>
    </main>
  );
}
