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
      <body className="bg-background text-text-primary">{children}</body>
    </html>
  );
}
