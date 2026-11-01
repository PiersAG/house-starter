import Link from "next/link";
import { z } from "zod";
import { parseQuery, tokenField } from "@/lib/validation/input";
import { ResetPasswordForm } from "./ResetPasswordForm";

// The link's token is checked for shape before it is used (issue 517); a
// malformed one is treated as missing.
const querySchema = z.object({ token: tokenField.optional() });

export const metadata = {
  title: "Reset password",
};

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = parseQuery(querySchema, await searchParams);
  const token = query.ok ? query.data.token : undefined;

  return (
    <main className="flex min-h-screen items-center justify-center p-4 sm:p-6">
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-6 shadow-sm sm:p-8">
        <h1 className="mb-6 text-2xl font-semibold text-text-primary">
          Choose a new password
        </h1>
        {token ? (
          <ResetPasswordForm token={token} />
        ) : (
          <p className="text-sm text-text-secondary">
            This reset link is missing its token.{" "}
            <Link href="/login" className="font-medium text-link underline">
              Return to sign in
            </Link>{" "}
            and request a new one.
          </p>
        )}
      </div>
    </main>
  );
}
