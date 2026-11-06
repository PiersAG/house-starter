import type { Metadata } from "next";
import { headers } from "next/headers";
import { getAppName } from "@/lib/branding";
import { OfflineNotice } from "@/components/OfflineNotice";
import { ErrorReporter } from "@/components/ErrorReporter";
import { errorTrackingConfig } from "@/config/error-tracking";
import { errorTrackingTarget } from "@/lib/observability/sentry-dsn";
import "./globals.css";

// Title comes from the owner-set app name (settings registry), neutral
// fallback otherwise — never a hardcoded template brand. See lib/branding.ts.
export async function generateMetadata(): Promise<Metadata> {
  const appName = await getAppName();
  return { title: appName };
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Reading a request header forces this layout to render dynamically per
  // request, which in turn causes Next.js to inject the middleware-issued
  // nonce into its framework <script> tags. Without this read, pages are
  // statically prerendered, no nonce is attached, and the CSP set in
  // middleware.ts blocks every script.
  await headers();

  return (
    <html lang="en">
      <body className="bg-background text-text-primary">
        <OfflineNotice />
        {/* Browser errors to Sentry, through the app's own /api/error-report —
            mounted only while error tracking is on and connected (issue 761). */}
        {errorTrackingTarget() ? (
          <ErrorReporter maxReportsPerPage={errorTrackingConfig.browserMaxReportsPerPage} />
        ) : null}
        {children}
        <footer className="border-t border-border py-6 text-center text-sm text-text-secondary">
          <a href="/contact" className="underline underline-offset-4">Contact</a>
        </footer>
      </body>
    </html>
  );
}
