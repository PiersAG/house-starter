import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export const metadata: Metadata = {
  title: "House Starter",
  description: "Replace this placeholder",
};

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
        {children}
        <footer className="border-t border-border py-6 text-center text-sm text-text-secondary">
          <a href="/contact" className="underline underline-offset-4">Contact</a>
        </footer>
      </body>
    </html>
  );
}
