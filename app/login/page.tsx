import { LoginForm } from "./LoginForm";

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-4 sm:p-6">
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-6 shadow-sm sm:p-8">
        <h1 className="mb-6 text-2xl font-semibold text-text-primary">
          Sign in
        </h1>
        <LoginForm />
      </div>
    </main>
  );
}
