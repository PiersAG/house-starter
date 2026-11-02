import Link from "next/link";
import { SignupForm } from "./SignupForm";

export const metadata = {
  title: "Create account",
};

export default function SignupPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-4 sm:p-6">
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-6 shadow-sm sm:p-8">
        <h1 className="mb-6 text-2xl font-semibold text-text-primary">
          Create your account
        </h1>
        <p className="mb-6 text-sm text-text-secondary">
          We use your email address and name only to run your account and to
          contact you about it. We never sell your data or use it for
          advertising, and you can download it or delete your account at any
          time. Creating an account means you agree to the{" "}
          <Link href="/terms" className="font-medium text-link underline">
            terms of service
          </Link>
          ; the{" "}
          <Link href="/privacy" className="font-medium text-link underline">
            privacy policy
          </Link>{" "}
          explains the rest.
        </p>
        <SignupForm />
        <p className="mt-6 text-sm text-text-secondary">
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-link underline">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
