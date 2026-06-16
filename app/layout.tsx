import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "House Starter",
  description: "Replace this placeholder",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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
