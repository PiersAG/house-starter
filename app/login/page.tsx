import { LoginForm } from "./LoginForm";
import { DEFAULT_RETURN_PATH, safeReturnPath } from "@/lib/session/return-path";

// `callbackUrl` is the page that sent the user here (the edge middleware sets it
// when a session has ended — issue 525). Only a path on this app is carried.
export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = (await searchParams) ?? {};
  const raw = Array.isArray(params.callbackUrl) ? params.callbackUrl[0] : params.callbackUrl;
  const returnTo = safeReturnPath(raw);
  const callbackUrl = returnTo === DEFAULT_RETURN_PATH ? "" : returnTo;
  return (
    <main className="flex min-h-screen items-center justify-center p-4 sm:p-6">
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-6 shadow-sm sm:p-8">
        <h1 className="mb-6 text-2xl font-semibold text-text-primary">
          Sign in
        </h1>
        {callbackUrl ? (
          <p className="mb-4 text-sm text-text-secondary">
            Your session ended. Sign in again to go back to where you were.
          </p>
        ) : null}
        <LoginForm callbackUrl={callbackUrl} />
      </div>
    </main>
  );
}
