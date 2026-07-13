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
