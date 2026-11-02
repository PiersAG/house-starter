// The branded page-not-found screen (app-business-core issue 502; Matt Murphy
// videos 56, 126, 297). Next.js answers an unknown address with this page and a 404
// status. It shows a plain message and a way on — never a path, a stack or a
// framework default screen.

import Link from "next/link";

export const metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="text-text-secondary">
        The page you were looking for does not exist or has moved.
      </p>
      <Link
        href="/"
        className="rounded-md bg-primary px-4 py-2 text-primary-foreground underline-offset-4 hover:underline"
      >
        Go to the home page
      </Link>
    </main>
  );
}
